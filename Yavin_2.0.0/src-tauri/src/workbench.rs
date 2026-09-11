use crate::{with_workspace, Workspace};
use ide_workspace::{
    file_tree::{clean_path_str, WorkspaceManager},
    process::{capture, ToolOutput},
};
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
#[derive(Default)]
pub struct GitLock(pub Mutex<()>);

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

#[tauri::command]
pub async fn search_project(
    app: tauri::AppHandle,
    state: State<'_, Workspace>,
    jobs: State<'_, Jobs>,
    workspace: String,
    id: String,
    options: SearchOptions,
) -> Result<ToolOutput, String> {
    let manager = with_workspace(&state, |m| {
        if m.validate_path(&workspace)? != m.root() {
            return Err("Workspace changed; search again".into());
        }
        Ok(m.clone())
    })?;
    let folder = manager.validate_path(&options.folder)?;
    if !folder.is_dir() {
        return Err("Search scope must be a directory".into());
    }
    if options.query.len() > 16384
        || options
            .buffer
            .as_ref()
            .is_some_and(|b| b.len() > 10 * 1024 * 1024)
    {
        return Err("Search input exceeds supported size".into());
    }
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
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut entries = jobs.0.lock().map_err(|e| e.to_string())?;
        if entries.len() >= 16 {
            return Err("Too many searches; wait for cancellation".into());
        }
        if entries.contains_key(&id) {
            return Err("Duplicate search request".into());
        }
        entries.insert(id.clone(), cancelled.clone());
    }
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new(binary);
        cmd.current_dir(folder).args([
            "--no-config",
            "--no-follow",
            "--max-filesize",
            "10M",
            "--glob",
            "!.git/**",
            "--glob",
            "!**/.git/**",
        ]);
        if options.files_only {
            cmd.args(["--files", "--null"]);
        } else {
            cmd.args(["--json", "--encoding", "utf-8", "--color", "never"]);
            if !options.regex {
                cmd.arg("--fixed-strings");
            }
            if !options.case_sensitive {
                cmd.arg("--ignore-case");
            }
            if options.whole_word {
                cmd.arg("--word-regexp");
            }
        }
        if options.hidden {
            cmd.arg("--hidden");
        }
        if options.ignored {
            cmd.arg("--no-ignore");
        }
        for glob in &options.include {
            cmd.arg("--glob").arg(glob);
        }
        for glob in &options.exclude {
            cmd.arg("--glob").arg(format!("!{glob}"));
        }
        // Hard exclusions come last so user globs cannot reinclude repository metadata.
        cmd.args(["--glob", "!.git/**", "--glob", "!**/.git/**"]);
        if !options.files_only {
            cmd.arg("--regexp").arg(&options.query);
        }
        cmd.arg("--")
            .arg(if options.buffer.is_some() { "-" } else { "." });
        capture(cmd, options.buffer, cancelled)
    })
    .await
    .map_err(|e| e.to_string());
    jobs.0.lock().map_err(|e| e.to_string())?.remove(&id);
    result?
}

#[tauri::command]
pub fn write_file_guarded(
    state: State<'_, Workspace>,
    path: String,
    expected: String,
    content: String,
) -> Result<(), String> {
    with_workspace(&state, |manager| {
        if manager.read_file(&path)? != expected {
            return Err(
                "File changed on disk. Reopen or review its current contents before saving.".into(),
            );
        }
        manager.write_file(&path, &content)
    })
}

fn git_command(manager: &WorkspaceManager, args: &[&str]) -> Result<ToolOutput, String> {
    let mut command = Command::new("git");
    command
        .current_dir(manager.root())
        .args(["--no-pager", "--literal-pathspecs"])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0");
    let result = capture(command, None, Arc::new(AtomicBool::new(false)))?;
    if result.truncated {
        return Err("Git output exceeded 16 MB; narrow the operation".into());
    }
    Ok(result)
}
fn git_ok(manager: &WorkspaceManager, args: &[&str]) -> Result<String, String> {
    let output = git_command(manager, args)?;
    if output.code != 0 {
        return Err(format!("Git: {}", output.stderr.trim()));
    }
    Ok(output.stdout)
}

#[tauri::command]
pub async fn git_workbench(
    app: tauri::AppHandle,
    state: State<'_, Workspace>,
    workspace: String,
    action: String,
    path: Option<String>,
    value: Option<String>,
) -> Result<String, String> {
    let manager = with_workspace(&state, |manager| {
        if manager.validate_path(&workspace)? != manager.root() {
            return Err("Workspace changed; refresh source control".into());
        }
        Ok(manager.clone())
    })?;
    tauri::async_runtime::spawn_blocking(move || {
        let lock = app.state::<GitLock>();
        let _guard = lock.0.lock().map_err(|e| e.to_string())?;
        perform_git(&manager, &action, path.as_deref(), value.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub fn perform_git(
    manager: &WorkspaceManager,
    action: &str,
    path: Option<&str>,
    value: Option<&str>,
) -> Result<String, String> {
    if action == "discover" {
        let output = git_command(manager, &["rev-parse", "--show-toplevel"])?;
        if output.code != 0 {
            if output.stderr.contains("not a git repository") {
                return Ok(String::new());
            }
            return Err(output.stderr);
        }
        return Ok(clean_path_str(output.stdout.trim()));
    }
    let root = git_ok(manager, &["rev-parse", "--show-toplevel"])?;
    let root = std::path::PathBuf::from(root.trim())
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let scoped_path = path
        .map(|path| {
            let absolute = manager.validate_path(path)?;
            let relative = absolute
                .strip_prefix(manager.root())
                .map_err(|e| e.to_string())?;
            if relative.as_os_str().is_empty() {
                return Err("Select a file".to_string());
            }
            Ok(clean_path_str(relative))
        })
        .transpose()?;
    let file = scoped_path.as_deref().unwrap_or("");
    if matches!(
        action,
        "commit" | "switch" | "branch" | "fetch" | "pull" | "push"
    ) && root != manager.root()
    {
        return Err(
            "Open the repository root before committing, switching branches, or using remotes."
                .into(),
        );
    }
    match action {
        "status" => git_ok(
            manager,
            &["status", "--porcelain=v1", "-z", "-uall", "--", "."],
        ),
        "branchInfo" => git_ok(
            manager,
            &[
                "status",
                "--porcelain=v2",
                "--branch",
                "--untracked-files=no",
                "--",
                ".",
            ],
        ),
        "branches" => git_ok(
            manager,
            &["for-each-ref", "--format=%(refname:short)", "refs/heads/"],
        ),
        "indexContent" if !file.is_empty() => {
            let absolute = manager.validate_path(path.unwrap_or(""))?;
            let relative = clean_path_str(absolute.strip_prefix(&root).map_err(|e| e.to_string())?);
            // --filters applies checkout conversions (line endings, LFS smudge) like `git restore`.
            git_ok(manager, &["cat-file", "--filters", &format!(":{relative}")])
        }
        "diff" | "stagedDiff" if !file.is_empty() => {
            let mut args = vec!["diff", "--no-ext-diff", "--no-textconv", "--no-color"];
            if action == "stagedDiff" {
                args.push("--cached");
            }
            args.extend(["--", file]);
            git_ok(manager, &args)
        }
        "stage" if !file.is_empty() => git_ok(manager, &["add", "--", file]),
        "unstage" if !file.is_empty() => {
            if git_command(manager, &["rev-parse", "--verify", "HEAD"])?.code == 0 {
                git_ok(manager, &["restore", "--staged", "--", file])
            } else {
                git_ok(manager, &["rm", "--cached", "--", file])
            }
        }
        "commit" => {
            let message = value.unwrap_or("");
            if message.trim().is_empty() {
                return Err("Enter a commit message".into());
            }
            if !git_ok(manager, &["diff", "--name-only", "--diff-filter=U"])?.is_empty() {
                return Err("Resolve and stage conflicts before committing".into());
            }
            git_ok(manager, &["commit", "-m", message])
        }
        "switch" | "branch" => {
            let branch = value.unwrap_or("");
            git_ok(manager, &["check-ref-format", "--branch", branch])?;
            if action == "branch" {
                git_ok(manager, &["switch", "-c", branch])
            } else {
                git_ok(manager, &["switch", "--", branch])
            }
        }
        "fetch" => git_ok(manager, &["fetch"]),
        "pull" => git_ok(manager, &["pull", "--ff-only"]),
        "push" => git_ok(manager, &["push"]),
        _ => Err("Unsupported Git operation".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, time::UNIX_EPOCH};

    #[test]
    fn index_content_uses_checkout_line_endings() {
        let dir = std::env::temp_dir().join(format!(
            "yavin_git_test_{}",
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let git = |args: &[&str]| {
            let status = Command::new("git")
                .current_dir(&dir)
                .args(args)
                .status()
                .unwrap();
            assert!(status.success(), "git {args:?} failed");
        };
        git(&["init", "-q"]);
        git(&["config", "core.autocrlf", "true"]);
        fs::write(dir.join("a.txt"), "one\ntwo\n").unwrap();
        git(&["add", "a.txt"]);
        let manager = WorkspaceManager::new(&dir).unwrap();
        let content = perform_git(&manager, "indexContent", Some("a.txt"), None);
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(content.unwrap(), "one\r\ntwo\r\n");
    }
}
