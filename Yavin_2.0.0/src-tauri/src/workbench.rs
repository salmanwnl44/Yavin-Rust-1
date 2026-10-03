use crate::{expecting_operation, made_folders, with_workspace, Planned, Watch, Workspace};
use ide_workspace::file_tree::{temp_nonce, temp_path_for};
use ide_workspace::process::{capture, ToolOutput};
use ide_workspace::recovery::{DiskState, Role};
use ide_workspace::resource_events::{Expectation, OperationKind};
use serde::Deserialize;
use std::{
    collections::HashMap,
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{Manager, State};

#[derive(Default)]
pub struct Jobs(pub Mutex<HashMap<String, Arc<AtomicBool>>>);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    query: String,
    case_sensitive: bool,
    whole_word: bool,
    regex: bool,
    hidden: bool,
    ignored: bool,
    include: Vec<String>,
    exclude: Vec<String>,
    folder: String,
    buffer: Option<String>,
    files_only: bool,
}

#[tauri::command]
pub fn cancel_search(jobs: State<'_, Jobs>, id: String) -> Result<(), String> {
    if let Some(job) = jobs.0.lock().map_err(|e| e.to_string())?.get(&id) {
        job.store(true, Ordering::Relaxed);
    }
    Ok(())
}

/// The folder a search runs in, once the request is known to be about the workspace that is
/// open now (a search started for another one is refused) and within the supported sizes.
fn search_scope(
    manager: &ide_workspace::file_tree::WorkspaceManager,
    workspace: &str,
    options: &SearchOptions,
) -> Result<std::path::PathBuf, String> {
    if manager.validate_path(workspace)? != manager.root() {
        return Err("Workspace changed; search again".into());
    }
    let folder = manager.validate_path(&options.folder)?;
    if !folder.is_dir() {
        return Err("Search scope must be a directory".into());
    }
    if options.query.len() > MAX_QUERY
        || options
            .buffer
            .as_ref()
            .is_some_and(|b| b.len() > MAX_BUFFER)
    {
        return Err("Search input exceeds supported size".into());
    }
    Ok(folder)
}

/// The longest query, and the largest unsaved buffer, a search accepts.
const MAX_QUERY: usize = 16384;
const MAX_BUFFER: usize = 10 * 1024 * 1024;
/// How many searches may run at once (each a ripgrep process).
const MAX_JOBS: usize = 16;

/// Registers a search under its caller-chosen `id`, for `cancel_search` to reach it.
fn register_job(jobs: &Jobs, id: &str) -> Result<Arc<AtomicBool>, String> {
    let cancelled = Arc::new(AtomicBool::new(false));
    let mut entries = jobs.0.lock().map_err(|e| e.to_string())?;
    if entries.len() >= MAX_JOBS {
        return Err("Too many searches; wait for cancellation".into());
    }
    if entries.contains_key(id) {
        return Err("Duplicate search request".into());
    }
    entries.insert(id.to_string(), cancelled.clone());
    Ok(cancelled)
}

/// ripgrep's arguments for a request. Nothing in the request becomes part of a command line
/// except as one argument: the query follows `--regexp`, globs follow `--glob`.
fn search_args(options: &SearchOptions) -> Vec<String> {
    let mut args: Vec<String> = [
        "--no-config",
        "--no-follow",
        "--max-filesize",
        "10M",
        "--glob",
        "!.git/**",
        "--glob",
        "!**/.git/**",
    ]
    .map(String::from)
    .to_vec();
    if options.files_only {
        args.extend(["--files", "--null"].map(String::from));
    } else {
        args.extend(["--json", "--encoding", "utf-8", "--color", "never"].map(String::from));
        if !options.regex {
            args.push("--fixed-strings".into());
        }
        if !options.case_sensitive {
            args.push("--ignore-case".into());
        }
        if options.whole_word {
            args.push("--word-regexp".into());
        }
    }
    if options.hidden {
        args.push("--hidden".into());
    }
    if options.ignored {
        args.push("--no-ignore".into());
    }
    for glob in &options.include {
        args.extend(["--glob".to_string(), glob.clone()]);
    }
    for glob in &options.exclude {
        args.extend(["--glob".to_string(), format!("!{glob}")]);
    }
    // Hard exclusions come last so user globs cannot reinclude repository metadata.
    args.extend(["--glob", "!.git/**", "--glob", "!**/.git/**"].map(String::from));
    if !options.files_only {
        args.extend(["--regexp".to_string(), options.query.clone()]);
    }
    args.push("--".into());
    args.push(if options.buffer.is_some() { "-" } else { "." }.into());
    args
}

/// Runs ripgrep (`binary`) in `folder` for `options`, until it ends or `cancelled` is set.
fn run_search(
    binary: &std::path::Path,
    folder: &std::path::Path,
    options: SearchOptions,
    cancelled: Arc<AtomicBool>,
) -> Result<ToolOutput, String> {
    let mut cmd = Command::new(binary);
    cmd.current_dir(folder).args(search_args(&options));
    capture(cmd, options.buffer, cancelled)
}

#[tauri::command]
pub async fn search_project(
    app: tauri::AppHandle,
    state: State<'_, Workspace>,
    jobs: State<'_, Jobs>,
    workspace: String,
    id: String,
    options: SearchOptions,
) -> Result<ToolOutput, String> {
    let folder = with_workspace(&state, |m| search_scope(m, &workspace, &options))?;
    let binary = if cfg!(debug_assertions) {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/search/rg.exe")
    } else {
        app.path()
            .resource_dir()
            .map_err(|e| e.to_string())?
            .join("resources/search/rg.exe")
    };
    if !binary.is_file() {
        return Err("Search tool is missing. Run scripts/setup-search.ps1 and rebuild.".into());
    }
    let cancelled = register_job(&jobs, &id)?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_search(&binary, &folder, options, cancelled)
    })
    .await
    .map_err(|e| e.to_string());
    jobs.0.lock().map_err(|e| e.to_string())?.remove(&id);
    result?
}

#[tauri::command(async)]
pub fn write_file_guarded(
    state: State<'_, Workspace>,
    watch: State<'_, Watch>,
    path: String,
    expected: String,
    content: String,
) -> Result<u64, String> {
    with_workspace(&state, |manager| {
        if manager.read_file(&path)? != expected {
            return Err(
                "File changed on disk. Reopen or review its current contents before saving.".into(),
            );
        }
        // One operation: the temporary file the bytes are written to first (gone again, or
        // holding exactly them), the rename onto the target, and the target's final bytes.
        let target = manager.validate_path(&path)?;
        let nonce = temp_nonce();
        let new = content.as_bytes();
        // Recovery's record of the file before the save: its exact bytes on disk (just shown
        // to be what the editor opened), so an interrupted save can be finished only if the
        // file is still exactly that.
        let before = std::fs::read(&target)
            .map(|bytes| DiskState::file(&bytes))
            .unwrap_or(DiskState::Absent);
        let mut plan = made_folders(&target);
        plan.push(
            Planned::new(
                temp_path_for(&target, nonce),
                Expectation::transient(new),
                DiskState::file(new),
            )
            .pre(DiskState::Absent)
            .role(Role::Temporary),
        );
        plan.push(
            Planned::new(target, Expectation::content(new), DiskState::file(new)).pre(before),
        );
        // The operation's id goes back to the document that saved, which recognises the
        // watcher's report of this write by it.
        expecting_operation(&watch, OperationKind::Save, plan, || {
            manager.write_file_with(&path, &content, nonce)
        })
        .map(|(id, ())| id)
    })
}

#[cfg(test)]
mod search_tests {
    use super::*;
    use ide_workspace::file_tree::WorkspaceManager;
    use std::path::{Path, PathBuf};

    fn options(query: &str) -> SearchOptions {
        SearchOptions {
            query: query.into(),
            case_sensitive: false,
            whole_word: false,
            regex: false,
            hidden: false,
            ignored: false,
            include: vec![],
            exclude: vec![],
            folder: String::new(),
            buffer: None,
            files_only: false,
        }
    }

    /// The packaged ripgrep (`scripts/setup-search.ps1`), which CI installs before the tests.
    fn ripgrep() -> PathBuf {
        let binary = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/search/rg.exe");
        assert!(
            binary.is_file(),
            "run scripts/setup-search.ps1: the search tool is part of the product"
        );
        binary
    }

    /// A test's workspace folder, removed when the test ends -- passed or failed. Removal is
    /// retried briefly: on Windows a file ripgrep just read can stay locked for a moment.
    struct TempRoot(PathBuf);

    impl std::ops::Deref for TempRoot {
        type Target = Path;
        fn deref(&self) -> &Path {
            &self.0
        }
    }

    impl AsRef<Path> for TempRoot {
        fn as_ref(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            for _ in 0..40 {
                if std::fs::remove_dir_all(&self.0).is_ok() || !self.0.exists() {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }
    }

    /// A small workspace: ordinary, hidden, ignored, binary and repository-metadata files.
    fn workspace(name: &str) -> TempRoot {
        let root = std::env::temp_dir().join(format!("yavin-search-{name}-{}", std::process::id()));
        for dir in ["src", ".hidden", "build", ".git", "nested/.git"] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
        }
        let write = |path: &str, text: &[u8]| std::fs::write(root.join(path), text).unwrap();
        write(
            "src/a.ts",
            b"const Needle = 1;\nneedle();\nneedles everywhere\n",
        );
        write("src/b.rs", b"fn needle() {}\r\n");
        write(".hidden/c.txt", b"needle in hiding\n");
        write(".gitignore", b"build/\n");
        write("build/out.js", b"needle built\n");
        write("blob.bin", b"needle\x00\x01\x02 binary");
        write(".git/config", b"needle in the repository\n");
        write("nested/.git/HEAD", b"needle nested\n");
        TempRoot(root)
    }

    fn run(root: &Path, request: SearchOptions) -> ToolOutput {
        run_search(&ripgrep(), root, request, Arc::new(AtomicBool::new(false))).unwrap()
    }

    /// The files with a match, relative and sorted.
    fn matched(output: &ToolOutput) -> Vec<String> {
        let mut files: Vec<String> = output
            .stdout
            .lines()
            .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
            .filter(|event| event["type"] == "match")
            .filter_map(|event| event["data"]["path"]["text"].as_str().map(String::from))
            .map(|path| path.replace('\\', "/").trim_start_matches("./").to_string())
            .collect();
        files.sort();
        files.dedup();
        files
    }

    fn count(output: &ToolOutput) -> usize {
        output
            .stdout
            .lines()
            .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
            .filter(|event| event["type"] == "match")
            .map(|event| event["data"]["submatches"].as_array().map_or(0, Vec::len))
            .sum()
    }

    #[test]
    fn arguments_follow_the_request_and_keep_repository_metadata_out_last() {
        let mut request = options("a.b");
        let args = search_args(&request);
        assert!(args.contains(&"--fixed-strings".into()));
        assert!(args.contains(&"--ignore-case".into()));
        assert!(!args.contains(&"--word-regexp".into()));
        // The query is one argument, after --regexp; never part of anything else.
        let at = args.iter().position(|a| a == "--regexp").unwrap();
        assert_eq!(args[at + 1], "a.b");
        assert_eq!(&args[args.len() - 2..], ["--", "."]);

        request.regex = true;
        request.case_sensitive = true;
        request.whole_word = true;
        request.hidden = true;
        request.ignored = true;
        request.include = vec!["*.ts".into()];
        request.exclude = vec!["src/**".into()];
        request.buffer = Some("text".into());
        let args = search_args(&request);
        for absent in ["--fixed-strings", "--ignore-case"] {
            assert!(!args.contains(&absent.into()), "{absent}");
        }
        for present in ["--word-regexp", "--hidden", "--no-ignore"] {
            assert!(args.contains(&present.into()), "{present}");
        }
        // User globs first, then the hard exclusions, so `.git` cannot be re-included.
        let include = args.iter().position(|a| a == "*.ts").unwrap();
        let exclude = args.iter().position(|a| a == "!src/**").unwrap();
        let hard = args.iter().rposition(|a| a == "!**/.git/**").unwrap();
        assert!(include < hard && exclude < hard);
        assert_eq!(&args[args.len() - 2..], ["--", "-"]); // the buffer, on stdin

        request.files_only = true;
        let args = search_args(&request);
        assert!(args.contains(&"--files".into()) && !args.contains(&"--regexp".into()));
    }

    #[test]
    fn a_request_for_another_workspace_or_outside_it_is_refused() {
        let root = workspace("scope");
        let manager = WorkspaceManager::new(&root).unwrap();
        let workspace = root.to_string_lossy().into_owned();
        let mut request = options("x");
        request.folder = root.join("src").to_string_lossy().into_owned();
        assert_eq!(
            search_scope(&manager, &workspace, &request).unwrap(),
            manager.validate_path(root.join("src")).unwrap()
        );
        // Another workspace (it changed while the search was on its way).
        let other = root.join("src").to_string_lossy().into_owned();
        assert_eq!(
            search_scope(&manager, &other, &request).unwrap_err(),
            "Workspace changed; search again"
        );
        // A scope outside the workspace, or not a folder.
        request.folder = root
            .join("..")
            .join("elsewhere")
            .to_string_lossy()
            .into_owned();
        assert!(search_scope(&manager, &workspace, &request).is_err());
        request.folder = root.join("src/a.ts").to_string_lossy().into_owned();
        assert_eq!(
            search_scope(&manager, &workspace, &request).unwrap_err(),
            "Search scope must be a directory"
        );
        // Too large to search.
        request.folder = workspace.clone();
        request.query = "q".repeat(MAX_QUERY + 1);
        assert!(search_scope(&manager, &workspace, &request).is_err());
        request.query = "q".into();
        request.buffer = Some("b".repeat(MAX_BUFFER + 1));
        assert!(search_scope(&manager, &workspace, &request).is_err());
    }

    #[test]
    fn searches_are_registered_once_each_and_bounded() {
        let jobs = Jobs::default();
        let first = register_job(&jobs, "one").unwrap();
        assert_eq!(
            register_job(&jobs, "one").unwrap_err(),
            "Duplicate search request"
        );
        for i in 1..MAX_JOBS {
            register_job(&jobs, &format!("job-{i}")).unwrap();
        }
        assert!(register_job(&jobs, "one-too-many").is_err());
        // Cancelling reaches the search by its id.
        jobs.0.lock().unwrap()["one"].store(true, Ordering::Relaxed);
        assert!(first.load(Ordering::Relaxed));
    }

    #[test]
    fn literal_regex_case_and_whole_word_search_as_asked() {
        let root = workspace("match");
        // Literal and case-insensitive by default: `Needle`, `needle`, `needles` all count.
        assert_eq!(count(&run(&root, options("needle"))), 4);
        let mut request = options("needle");
        request.case_sensitive = true;
        assert_eq!(count(&run(&root, request)), 3);
        let mut request = options("needle");
        request.whole_word = true;
        assert_eq!(count(&run(&root, request)), 3); // not `needles`
                                                    // A regex only when asked: as a literal, `need.e` matches nothing.
        assert_eq!(count(&run(&root, options("need.e"))), 0);
        let mut request = options("need.e");
        request.regex = true;
        assert_eq!(count(&run(&root, request)), 4);
    }

    #[test]
    fn globs_hidden_and_ignored_files_and_repository_metadata() {
        let root = workspace("files");
        assert_eq!(
            matched(&run(&root, options("needle"))),
            ["src/a.ts", "src/b.rs"]
        );
        let mut request = options("needle");
        request.include = vec!["*.rs".into()];
        assert_eq!(matched(&run(&root, request)), ["src/b.rs"]);
        let mut request = options("needle");
        request.exclude = vec!["*.rs".into()];
        assert_eq!(matched(&run(&root, request)), ["src/a.ts"]);
        // Hidden and ignored files on request -- and `.git` never, even asked for by a glob.
        let mut request = options("needle");
        request.hidden = true;
        request.ignored = true;
        request.include = vec![".git/**".into(), "**".into()];
        let everything = matched(&run(&root, request));
        assert!(everything.contains(&".hidden/c.txt".to_string()));
        assert!(everything.contains(&"build/out.js".to_string()));
        assert!(
            !everything.iter().any(|path| path.contains(".git/")),
            "{everything:?}"
        );
        // A binary file is not reported as a text match.
        assert!(!everything.contains(&"blob.bin".to_string()));
    }

    #[test]
    fn an_unsaved_buffer_is_searched_from_stdin_and_a_listing_names_files() {
        let root = workspace("buffer");
        let mut request = options("unsaved");
        request.buffer = Some("first line\nan unsaved edit\n".into());
        let output = run(&root, request);
        assert_eq!(count(&output), 1);
        assert!(output.stdout.contains("\"line_number\":2"));
        let mut request = options("");
        request.files_only = true;
        let output = run(&root, request);
        let mut names: Vec<String> = output
            .stdout
            .split('\0')
            .filter(|name| !name.is_empty())
            .map(|name| name.replace('\\', "/").trim_start_matches("./").to_string())
            .collect();
        names.sort();
        assert_eq!(names, ["blob.bin", "src/a.ts", "src/b.rs"]);
    }

    #[test]
    fn a_cancelled_search_ends_without_results() {
        let root = workspace("cancel");
        let error = run_search(
            &ripgrep(),
            &root,
            options("needle"),
            Arc::new(AtomicBool::new(true)),
        )
        .unwrap_err();
        assert_eq!(error, "Cancelled");
    }
}
