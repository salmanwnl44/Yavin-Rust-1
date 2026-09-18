//! Generic, guarded Git executor with a multi-repository registry.
//!
//! Rust's job is small and declarative: track which repositories are open, and run
//! whatever `git` invocation TypeScript asks for, rejecting anything that could smuggle
//! an unauthorized flag past the intended subcommand. All git *business logic* --
//! argument construction, output parsing, state machines, sequencing -- lives in
//! `src/services/git/` on the TypeScript side. This mirrors how `terminal.rs` keeps PTY
//! mechanics in Rust and leaves everything else to xterm.js.
use ide_workspace::{
    file_tree::clean_path_str,
    process::{capture, ToolOutput},
};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Command,
    sync::{atomic::AtomicBool, Arc, Mutex},
};
use tauri::State;

/// One open repository: its canonical root and a lock serializing Git invocations
/// against it. Each repository has its own lock, so work in one repo never blocks
/// another -- unlike the single global lock the previous single-repo design used.
pub struct Repo {
    root: PathBuf,
    lock: Mutex<()>,
}

#[derive(Default)]
pub struct Repos(pub Mutex<HashMap<String, Arc<Repo>>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub repo_id: String,
    pub root: String,
}

fn repo_of(state: &Repos, repo_id: &str) -> Result<Arc<Repo>, String> {
    state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .get(repo_id)
        .cloned()
        .ok_or_else(|| "This repository is no longer open. Reopen it and try again.".to_string())
}

/// Runs `git` with the hardening this app has always applied: no pager, no shell,
/// literal pathspecs, no interactive credential/editor prompts, and the same 16 MB
/// output cap the previous single-repo design enforced.
fn run(root: &Path, args: &[&str]) -> Result<ToolOutput, String> {
    run_with_input(root, args, None)
}

/// Like `run`, but pipes `input` to Git's stdin -- the only current use is feeding a
/// patch to `git apply` for hunk-level staging/unstaging/discarding. The patch is
/// data Git parses, not a command or shell input, so it needs no extra validation
/// beyond the argv allow-list `apply` (like every subcommand) already goes through.
fn run_with_input(root: &Path, args: &[&str], input: Option<String>) -> Result<ToolOutput, String> {
    let mut command = Command::new("git");
    command
        .current_dir(root)
        .args(["--no-pager", "--literal-pathspecs"])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_EDITOR", "true")
        // Pin Git's own diagnostic text to English, independent of the user's OS
        // locale: `discover_toplevel` below and TypeScript's `describeGitError` both
        // match specific English phrases in stderr, which a localized Git would never
        // produce, silently defeating both matchers.
        .env("LC_ALL", "C")
        .env("LANGUAGE", "C");
    let result = capture(command, input, Arc::new(AtomicBool::new(false)))?;
    if result.truncated {
        return Err("Git output exceeded 16 MB; narrow the operation".into());
    }
    Ok(result)
}

/// Resolves any path inside a repository to that repository's true, canonical
/// top-level -- so a repo opened from a nested subfolder is always tracked and
/// operated on by its real root, never a partial view of it.
fn discover_toplevel(path: &Path) -> Result<PathBuf, String> {
    if !path.is_dir() {
        return Err("Not a directory".into());
    }
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("Invalid path: {e}"))?;
    let discover = run(&canonical, &["rev-parse", "--show-toplevel"])?;
    if discover.code != 0 {
        return Err(if discover.stderr.contains("not a git repository") {
            "This folder is not a Git repository.".to_string()
        } else {
            discover.stderr.trim().to_string()
        });
    }
    PathBuf::from(discover.stdout.trim())
        .canonicalize()
        .map_err(|e| e.to_string())
}

/// Resolves any path inside a repository -- main worktree or linked worktree alike --
/// to that repository's *shared* Git directory (`--git-common-dir`). Unlike
/// `discover_toplevel`, which returns a different, worktree-specific root for each
/// linked worktree, this value is identical from every worktree of the same
/// repository, which is what makes it the correct repository-identity key (a linked
/// worktree must never be mistaken for an independent repository). Not yet used by
/// any production code path -- see the Repository & Worktree Architecture plan.
#[allow(dead_code)]
fn discover_common_dir(path: &Path) -> Result<PathBuf, String> {
    if !path.is_dir() {
        return Err("Not a directory".into());
    }
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("Invalid path: {e}"))?;
    let discover = run(&canonical, &["rev-parse", "--git-common-dir"])?;
    if discover.code != 0 {
        return Err(if discover.stderr.contains("not a git repository") {
            "This folder is not a Git repository.".to_string()
        } else {
            discover.stderr.trim().to_string()
        });
    }
    let reported = PathBuf::from(discover.stdout.trim());
    // Git reports a path relative to the queried directory when the common dir lies
    // under it (the common case); resolve against that directory, not the process's
    // own working directory, before canonicalizing.
    let absolute = if reported.is_absolute() {
        reported
    } else {
        canonical.join(reported)
    };
    absolute.canonicalize().map_err(|e| e.to_string())
}

/// Registers (or reuses) a repository whose top-level has already been resolved.
fn register_repo(repos: &Repos, toplevel: PathBuf) -> Result<RepoInfo, String> {
    let repo_id = clean_path_str(&toplevel);
    repos
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .entry(repo_id.clone())
        .or_insert_with(|| {
            Arc::new(Repo {
                root: toplevel.clone(),
                lock: Mutex::new(()),
            })
        });
    Ok(RepoInfo {
        repo_id,
        root: clean_path_str(&toplevel),
    })
}

#[tauri::command]
pub async fn git_open_repo(state: State<'_, Repos>, path: String) -> Result<RepoInfo, String> {
    let candidate = PathBuf::from(path);
    let toplevel = tauri::async_runtime::spawn_blocking(move || discover_toplevel(&candidate))
        .await
        .map_err(|e| e.to_string())??;
    register_repo(&state, toplevel)
}

#[tauri::command]
pub fn git_close_repo(state: State<'_, Repos>, repo_id: String) -> Result<(), String> {
    state.0.lock().map_err(|e| e.to_string())?.remove(&repo_id);
    Ok(())
}

/// The interrupted operation the repository is sitting in, or "" when it is idle.
fn repo_state(repo: &Repo) -> Result<String, String> {
    let dir = run(&repo.root, &["rev-parse", "--absolute-git-dir"])?;
    if dir.code != 0 {
        return Err(dir.stderr.trim().to_string());
    }
    let dir = PathBuf::from(dir.stdout.trim());
    let has = |name: &str| dir.join(name).exists();
    Ok(if has("rebase-merge") || has("rebase-apply") {
        "rebase"
    } else if has("MERGE_HEAD") {
        "merge"
    } else if has("CHERRY_PICK_HEAD") {
        "cherry-pick"
    } else if has("REVERT_HEAD") {
        "revert"
    } else {
        ""
    }
    .to_string())
}

#[tauri::command]
pub async fn git_repo_state(state: State<'_, Repos>, repo_id: String) -> Result<String, String> {
    let repo = repo_of(&state, &repo_id)?;
    tauri::async_runtime::spawn_blocking(move || repo_state(&repo))
        .await
        .map_err(|e| e.to_string())?
}

/// One flag a subcommand is allowed to receive before a literal `--`. `prefix` matches
/// e.g. `--porcelain=` against `--porcelain=v2`; `takes_value` means the *next* argv
/// token is this flag's opaque value (a commit message, a branch name...) and is never
/// itself checked -- exactly like Git's own option parser treats `-m <value>`.
struct FlagRule {
    name: &'static str,
    prefix: bool,
    takes_value: bool,
}
const fn flag(name: &'static str) -> FlagRule {
    FlagRule {
        name,
        prefix: false,
        takes_value: false,
    }
}
const fn value_flag(name: &'static str) -> FlagRule {
    FlagRule {
        name,
        prefix: false,
        takes_value: true,
    }
}
const fn prefix_flag(name: &'static str) -> FlagRule {
    FlagRule {
        name,
        prefix: true,
        takes_value: false,
    }
}

// One `const` array per subcommand: `const` initializers are fully evaluated at
// compile time regardless of Rust's (narrower) rvalue-static-promotion rules, so the
// helper functions above can be used freely here.
const STATUS: &[FlagRule] = &[
    prefix_flag("--porcelain="),
    flag("--branch"),
    flag("-z"),
    flag("-uall"),
    flag("--untracked-files=no"),
];
const REV_PARSE: &[FlagRule] = &[
    flag("--show-toplevel"),
    flag("--verify"),
    flag("--absolute-git-dir"),
    flag("--git-common-dir"),
];
const CAT_FILE: &[FlagRule] = &[flag("--filters")];
const DIFF: &[FlagRule] = &[
    flag("--no-ext-diff"),
    flag("--no-textconv"),
    flag("--no-color"),
    flag("--cached"),
    flag("--name-only"),
    prefix_flag("--diff-filter="),
];
const NONE: &[FlagRule] = &[];
const RESTORE: &[FlagRule] = &[flag("--staged")];
const RM: &[FlagRule] = &[flag("--cached")];
const COMMIT: &[FlagRule] = &[value_flag("-m")];
const SWITCH: &[FlagRule] = &[value_flag("-c")];
const PULL: &[FlagRule] = &[
    flag("--ff-only"),
    flag("--rebase"),
    flag("--no-autostash"),
    flag("--no-rebase"),
    flag("--no-edit"),
];
const PUSH: &[FlagRule] = &[flag("--set-upstream")];
const SHOW: &[FlagRule] = &[
    flag("--stat"),
    flag("--oneline"),
    prefix_flag("--pretty="),
    flag("--numstat"),
];
const STASH: &[FlagRule] = &[flag("-u"), value_flag("-m")];
const TAG: &[FlagRule] = &[flag("-l")];
// The patch content itself travels over stdin, not argv -- see `git_exec`'s `input`.
const APPLY: &[FlagRule] = &[flag("--cached"), flag("-R")];
// The branch name being validated is the whole point of this call, so it must pass
// through untouched (even if it starts with '-') for Git's own check to accept/reject.
const CHECK_REF_FORMAT: &[FlagRule] = &[value_flag("--branch")];
const SYMBOLIC_REF: &[FlagRule] = &[flag("--short")];
const ABORT_CONTINUE: &[FlagRule] = &[flag("--abort"), flag("--continue")];
const LOG: &[FlagRule] = &[
    value_flag("-n"),
    value_flag("--skip"),
    flag("--topo-order"),
    prefix_flag("--pretty="),
    prefix_flag("--date="),
];
const FOR_EACH_REF: &[FlagRule] = &[prefix_flag("--format=")];

/// The declarative allow-list this whole design leans on: every subcommand
/// TypeScript may run, and every flag it may pass before a literal `--`. Anything not
/// listed here -- including a whole subcommand -- is refused. This is the single place
/// that needs updating when TypeScript needs a new Git capability.
fn rules_for(subcommand: &str) -> Option<&'static [FlagRule]> {
    Some(match subcommand {
        "status" => STATUS,
        "rev-parse" => REV_PARSE,
        "cat-file" => CAT_FILE,
        "diff" => DIFF,
        "add" => NONE,
        "restore" => RESTORE,
        "rm" => RM,
        "commit" => COMMIT,
        "switch" => SWITCH,
        "remote" => NONE,
        "fetch" => NONE,
        "pull" => PULL,
        "push" => PUSH,
        "show" => SHOW,
        "stash" => STASH,
        "tag" => TAG,
        "apply" => APPLY,
        "check-ref-format" => CHECK_REF_FORMAT,
        "symbolic-ref" => SYMBOLIC_REF,
        "rebase" => ABORT_CONTINUE,
        "merge" => ABORT_CONTINUE,
        "cherry-pick" => ABORT_CONTINUE,
        "revert" => ABORT_CONTINUE,
        "log" => LOG,
        "for-each-ref" => FOR_EACH_REF,
        _ => return None,
    })
}

fn validate_args(subcommand: &str, rest: &[String]) -> Result<(), String> {
    let rules = rules_for(subcommand)
        .ok_or_else(|| format!("Git operation '{subcommand}' is not supported"))?;
    let mut i = 0;
    let mut positional_only = false;
    while i < rest.len() {
        let arg = rest[i].as_str();
        if positional_only {
            i += 1;
            continue;
        }
        if arg == "--" {
            positional_only = true;
            i += 1;
            continue;
        }
        if !arg.starts_with('-') {
            i += 1;
            continue;
        }
        let rule = rules.iter().find(|r| {
            if r.prefix {
                arg.starts_with(r.name)
            } else {
                arg == r.name
            }
        });
        match rule {
            None => {
                return Err(format!(
                    "Argument '{arg}' is not permitted for 'git {subcommand}'"
                ))
            }
            Some(r) => {
                i += 1;
                if r.takes_value {
                    // The next token is this flag's value, whatever it looks like --
                    // it can never be reinterpreted as an option of its own.
                    i += 1;
                }
            }
        }
    }
    Ok(())
}

/// The full path an actual `git_exec` call takes: validate, then run under the
/// repository's own lock. Shared by the Tauri command and its tests.
fn exec_on(repo: &Repo, args: &[String], input: Option<String>) -> Result<ToolOutput, String> {
    let subcommand = args.first().ok_or("Missing Git subcommand")?;
    validate_args(subcommand, &args[1..])?;
    let _guard = repo.lock.lock().map_err(|e| e.to_string())?;
    let args_ref: Vec<&str> = args.iter().map(String::as_str).collect();
    run_with_input(&repo.root, &args_ref, input)
}

#[tauri::command]
pub async fn git_exec(
    state: State<'_, Repos>,
    repo_id: String,
    args: Vec<String>,
    input: Option<String>,
) -> Result<ToolOutput, String> {
    let repo = repo_of(&state, &repo_id)?;
    tauri::async_runtime::spawn_blocking(move || exec_on(&repo, &args, input))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, time::UNIX_EPOCH};

    fn temp_dir() -> PathBuf {
        std::env::temp_dir().join(format!(
            "yavin_git_native_test_{}",
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    /// A throwaway repository with one commit, returning its directory and a git runner.
    fn fixture() -> (PathBuf, impl Fn(&[&str]) -> bool) {
        let dir = temp_dir();
        fs::create_dir_all(&dir).unwrap();
        let at = dir.clone();
        let git = move |args: &[&str]| {
            Command::new("git")
                .current_dir(&at)
                .args(args)
                .status()
                .unwrap()
                .success()
        };
        assert!(git(&["init", "-q"]));
        assert!(git(&["config", "user.email", "test@example.invalid"]));
        assert!(git(&["config", "user.name", "Yavin Test"]));
        assert!(git(&["config", "commit.gpgsign", "false"]));
        assert!(git(&["config", "core.autocrlf", "false"]));
        fs::write(dir.join("a.txt"), "base\n").unwrap();
        assert!(git(&["add", "a.txt"]));
        assert!(git(&["commit", "-qm", "base"]));
        (dir, git)
    }

    fn open(dir: &Path) -> Repo {
        let toplevel = discover_toplevel(dir).unwrap();
        Repo {
            root: toplevel,
            lock: Mutex::new(()),
        }
    }

    fn args(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_disallowed_flag_is_rejected_before_git_ever_runs() {
        let (dir, _git) = fixture();
        let repo = open(&dir);
        // This is exactly the option-injection shape a malicious "remote name" or
        // "branch name" could try to smuggle in; it must never reach `git push`.
        let result = exec_on(
            &repo,
            &args(&["push", "--upload-pack=touch pwned", "origin", "main"]),
            None,
        );
        let _ = fs::remove_dir_all(&dir);
        let error = result.unwrap_err();
        assert!(error.contains("not permitted"), "unexpected error: {error}");
    }

    #[test]
    fn a_value_flag_accepts_a_dash_prefixed_value_without_reinterpreting_it() {
        let (dir, _git) = fixture();
        let repo = open(&dir);
        fs::write(dir.join("a.txt"), "changed\n").unwrap();
        exec_on(&repo, &args(&["add", "a.txt"]), None).unwrap();
        // A commit message that happens to start with '-' is still just a message.
        let result = exec_on(&repo, &args(&["commit", "-m", "-not a flag"]), None);
        let _ = fs::remove_dir_all(&dir);
        assert!(result.is_ok());
    }

    #[test]
    fn a_pathspec_after_double_dash_may_itself_start_with_a_dash() {
        let (dir, _git) = fixture();
        let repo = open(&dir);
        fs::write(dir.join("-weird.txt"), "x\n").unwrap();
        let result = exec_on(&repo, &args(&["add", "--", "-weird.txt"]), None);
        let _ = fs::remove_dir_all(&dir);
        assert!(result.is_ok());
    }

    #[test]
    fn an_unsupported_subcommand_is_rejected() {
        let (dir, _git) = fixture();
        let repo = open(&dir);
        let result = exec_on(
            &repo,
            &args(&["config", "--global", "user.name", "x"]),
            None,
        );
        let _ = fs::remove_dir_all(&dir);
        assert!(result.unwrap_err().contains("not supported"));
    }

    #[test]
    fn opening_a_nested_subfolder_resolves_to_the_true_toplevel() {
        let (dir, git) = fixture();
        fs::create_dir_all(dir.join("nested/sub")).unwrap();
        fs::write(dir.join("nested/sub/b.txt"), "x\n").unwrap();
        assert!(git(&["add", "nested/sub/b.txt"]));
        assert!(git(&["commit", "-qm", "nested file"]));

        let toplevel = discover_toplevel(&dir.join("nested/sub")).unwrap();
        let root = dir.canonicalize().unwrap();
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(
            toplevel, root,
            "a nested folder resolves to the real repo root"
        );
    }

    #[test]
    fn a_linked_worktree_shares_its_main_worktrees_common_directory() {
        let (dir, git) = fixture();
        let linked = temp_dir();
        assert!(git(&[
            "worktree",
            "add",
            linked.to_str().unwrap(),
            "-b",
            "feature",
        ]));

        let main_common = discover_common_dir(&dir);
        let linked_common = discover_common_dir(&linked);
        // discover_toplevel, by contrast, is expected to differ between them --
        // that's exactly why identity must key on the common dir, not the toplevel.
        let main_toplevel = discover_toplevel(&dir);
        let linked_toplevel = discover_toplevel(&linked);

        let _ = fs::remove_dir_all(&linked);
        let _ = fs::remove_dir_all(&dir);

        assert_eq!(
            main_common.unwrap(),
            linked_common.unwrap(),
            "a linked worktree's common Git directory must match its main worktree's"
        );
        assert_ne!(
            main_toplevel.unwrap(),
            linked_toplevel.unwrap(),
            "a linked worktree's own toplevel must differ from the main worktree's"
        );
    }

    #[test]
    fn cat_file_filters_applies_checkout_line_endings() {
        let (dir, git) = fixture();
        git(&["config", "core.autocrlf", "true"]);
        fs::write(dir.join("a.txt"), "one\ntwo\n").unwrap();
        assert!(git(&["add", "a.txt"]));
        let repo = open(&dir);
        let output = exec_on(&repo, &args(&["cat-file", "--filters", ":a.txt"]), None);
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(output.unwrap().stdout, "one\r\ntwo\r\n");
    }

    #[test]
    fn an_interrupted_merge_is_reported_and_can_be_abandoned() {
        let (dir, git) = fixture();
        let main = String::from_utf8(
            Command::new("git")
                .current_dir(&dir)
                .args(["branch", "--show-current"])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap();
        let main = main.trim().to_string();

        assert!(git(&["switch", "-qc", "other"]));
        fs::write(dir.join("a.txt"), "theirs\n").unwrap();
        assert!(git(&["commit", "-qam", "theirs"]));
        assert!(git(&["switch", "-q", &main]));
        fs::write(dir.join("a.txt"), "ours\n").unwrap();
        assert!(git(&["commit", "-qam", "ours"]));
        assert!(!git(&["merge", "other"]));

        let repo = open(&dir);
        let during = repo_state(&repo);
        let abort = exec_on(&repo, &args(&["merge", "--abort"]), None);
        let after = repo_state(&repo);
        let content = fs::read_to_string(dir.join("a.txt")).unwrap();
        let _ = fs::remove_dir_all(&dir);

        assert_eq!(during.unwrap(), "merge");
        assert!(abort.is_ok());
        assert_eq!(after.unwrap(), "");
        assert_eq!(
            content, "ours\n",
            "abort restores the pre-merge working tree"
        );
    }

    #[test]
    fn apply_cached_stages_a_patch_supplied_over_stdin() {
        let (dir, _git) = fixture();
        let repo = open(&dir);
        fs::write(dir.join("a.txt"), "base\nchanged\n").unwrap();
        let diff = exec_on(&repo, &args(&["diff", "--", "a.txt"]), None).unwrap();

        let apply = exec_on(&repo, &args(&["apply", "--cached"]), Some(diff.stdout));
        let staged = exec_on(&repo, &args(&["diff", "--cached", "--", "a.txt"]), None);
        // --cached only touches the index; since the working tree already matched the
        // patch, the index now matches the working tree too, so the unstaged diff empties.
        let worktree_diff = exec_on(&repo, &args(&["diff", "--", "a.txt"]), None);
        let _ = fs::remove_dir_all(&dir);

        assert!(apply.is_ok(), "apply failed: {:?}", apply.err());
        assert!(staged.unwrap().stdout.contains("+changed"));
        assert_eq!(worktree_diff.unwrap().stdout, "");
    }
}
