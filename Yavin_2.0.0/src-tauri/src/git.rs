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
    watcher,
};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, MutexGuard, TryLockError,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, State};

/// One open repository: its canonical root, its shared-repository identity (see
/// `discover_common_dir`), and a lock serializing Git invocations against this
/// worktree specifically. Each worktree has its own lock, so work in one worktree
/// never blocks another -- unlike the single global lock the previous single-repo
/// design used. `repository_id` is what lets two *different* worktrees of the same
/// repository still coordinate on the state they genuinely share (see `StashLocks`/
/// `NetworkLocks`) without serializing everything else against each other.
pub struct Repo {
    root: PathBuf,
    repository_id: String,
    lock: Mutex<()>,
}

#[derive(Default)]
pub struct Repos(pub Mutex<HashMap<String, Arc<Repo>>>);

/// Serializes Git's stash-family operations (`push`/`apply`/`pop`/`drop`) across
/// every worktree of one repository, keyed by `repository_id`. `refs/stash` is the
/// one ref with no per-worktree partitioning at all (confirmed empirically -- a
/// stash pushed from one worktree is visible via `stash list` from every other), so
/// unlike almost every other mutation (which Git's own worktree-exclusivity
/// guarantee already keeps collision-free per branch), this genuinely needs
/// cross-worktree coordination. See the Git Operation Engine plan's empirical
/// verification section.
#[derive(Default)]
pub struct StashLocks(pub Mutex<HashMap<String, Arc<Mutex<()>>>>);

/// Serializes `fetch`/`pull`/`push` across every worktree of one repository, keyed by
/// `repository_id` -- remote-tracking refs are likewise not partitioned by worktree.
/// Scoped to the whole repository rather than per-remote: a deliberate simplification
/// (see the plan), not a correctness gap.
#[derive(Default)]
pub struct NetworkLocks(pub Mutex<HashMap<String, Arc<Mutex<()>>>>);

/// One registered, cancellable Git operation: which repository it belongs to (so
/// `git_close_repo` can cancel every job still running against a repository being
/// closed) and the flag `acquire_cancellable`/`capture` poll.
pub(crate) struct JobEntry {
    repo_id: String,
    cancel: Arc<AtomicBool>,
}

/// Every currently in-flight (or not-yet-started) cancellable Git operation, keyed by
/// an id the caller chooses -- mirrors `workbench::Jobs`, the identical pattern
/// already shipped for search cancellation.
#[derive(Default)]
pub struct GitJobs(pub Mutex<HashMap<String, JobEntry>>);

/// A small, purely defensive cap (mirroring `workbench::Jobs`'s own limit) against
/// the one edge case that could otherwise leak entries unboundedly: a cancel call for
/// an id that never goes on to register a real operation (see `cancel_job`). Ordinary
/// concurrent-operation counts never approach this.
const MAX_GIT_JOBS: usize = 64;

/// Registers `id` as running against `repo_id` and returns the flag to pass through
/// `exec_on`. If `id` was already pre-cancelled (see `cancel_job`), reuses that same
/// already-`true` flag instead of creating a fresh one -- whichever call, register or
/// cancel, happens to arrive first wins the map slot, closing the register/cancel
/// ordering race without needing the two to coordinate explicitly.
fn register_job(jobs: &GitJobs, id: &str, repo_id: &str) -> Result<Arc<AtomicBool>, String> {
    let mut map = jobs.0.lock().map_err(|e| e.to_string())?;
    if !map.contains_key(id) && map.len() >= MAX_GIT_JOBS {
        return Err("Too many Git operations in flight; wait for one to finish".into());
    }
    Ok(map
        .entry(id.to_string())
        .or_insert_with(|| JobEntry {
            repo_id: repo_id.to_string(),
            cancel: Arc::new(AtomicBool::new(false)),
        })
        .cancel
        .clone())
}

/// Cancels the job registered under `id`, or -- if it hasn't registered yet, a
/// narrow but real race between this call and `register_job`'s, since they're
/// separate, concurrently-processed command invocations with no ordering guarantee
/// between them -- pre-creates an already-cancelled entry for it to find. The
/// repository this pre-cancelled entry belongs to is unknown at this point; that's
/// fine, because the only consumer that needs `repo_id` (`cancel_jobs_for_repo`) only
/// ever acts on already-registered jobs, never a pre-cancelled placeholder.
fn cancel_job(jobs: &GitJobs, id: &str) -> Result<(), String> {
    let mut map = jobs.0.lock().map_err(|e| e.to_string())?;
    match map.get(id) {
        Some(entry) => entry.cancel.store(true, Ordering::Relaxed),
        None => {
            map.insert(
                id.to_string(),
                JobEntry {
                    repo_id: String::new(),
                    cancel: Arc::new(AtomicBool::new(true)),
                },
            );
        }
    }
    Ok(())
}

/// Cancels every job currently registered against `repo_id` -- used when that
/// repository is closed, so a running operation doesn't keep a `git` process alive
/// against a worktree Yavin no longer considers open.
fn cancel_jobs_for_repo(jobs: &GitJobs, repo_id: &str) -> Result<(), String> {
    let map = jobs.0.lock().map_err(|e| e.to_string())?;
    for entry in map.values().filter(|entry| entry.repo_id == repo_id) {
        entry.cancel.store(true, Ordering::Relaxed);
    }
    Ok(())
}

/// Removes `id`'s entry from `jobs` on drop -- constructed right after
/// `register_job` succeeds, so the entry is removed on every exit path (success,
/// error, or early return) without relying on a manually-placed cleanup call that a
/// future change to `git_exec` could accidentally skip.
struct JobGuard<'a> {
    jobs: &'a GitJobs,
    id: String,
}
impl Drop for JobGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut map) = self.jobs.0.lock() {
            map.remove(&self.id);
        }
    }
}

/// Finds (or creates) the shared lock for `key` in `map`, without holding `map`'s own
/// mutex any longer than the lookup itself -- the returned `Arc` is what callers
/// actually wait on.
fn lock_for(
    map: &Mutex<HashMap<String, Arc<Mutex<()>>>>,
    key: &str,
) -> Result<Arc<Mutex<()>>, String> {
    Ok(map
        .lock()
        .map_err(|e| e.to_string())?
        .entry(key.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone())
}

/// Polls for the lock instead of blocking on it, so an operation queued behind
/// another is actually cancellable *before* it ever runs -- the same 20ms cadence
/// `ide_workspace::process::capture` already uses to poll a running process for
/// cancellation, so a cancel request is honored within one tick whether the
/// operation is waiting for a lock or already spawned. A poisoned lock (a previous
/// holder panicked while holding it) is recovered rather than left permanently
/// deadlocked -- safe here because every lock this guards is a plain `Mutex<()>`
/// with no data of its own that a panic could have left inconsistent.
fn acquire_cancellable<'a>(
    lock: &'a Mutex<()>,
    cancel: &AtomicBool,
) -> Result<MutexGuard<'a, ()>, String> {
    loop {
        match lock.try_lock() {
            Ok(guard) => return Ok(guard),
            Err(TryLockError::Poisoned(poisoned)) => return Ok(poisoned.into_inner()),
            Err(TryLockError::WouldBlock) => {}
        }
        if cancel.load(Ordering::Relaxed) {
            return Err("Cancelled".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Which shared lock (if any) an operation needs beyond its own worktree's lock,
/// decided from the same already-validated subcommand/args `exec_on` has in hand --
/// never supplied by the TypeScript caller. Only the operations empirically confirmed
/// to touch state with no per-worktree partitioning take a `Stash`/`Network` scope;
/// everything else (including commit, branch creation, and every merge-family
/// operation) is `WorktreeLocal`, because Git itself refuses to let two worktrees
/// reference the same branch, so their ref-moving side effects can never collide
/// across worktrees to begin with.
enum Scope {
    WorktreeLocal,
    Stash,
    Network,
}

fn operation_scope(subcommand: &str, rest: &[String]) -> Scope {
    match subcommand {
        "stash" => match rest.first().map(String::as_str) {
            Some("push") | Some("apply") | Some("pop") | Some("drop") => Scope::Stash,
            _ => Scope::WorktreeLocal,
        },
        "fetch" | "pull" | "push" => Scope::Network,
        _ => Scope::WorktreeLocal,
    }
}

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
    run_with_input(root, args, None, Arc::new(AtomicBool::new(false)))
}

/// Like `run`, but pipes `input` to Git's stdin -- the only current use is feeding a
/// patch to `git apply` for hunk-level staging/unstaging/discarding -- and accepts a
/// real cancellation flag for use by `exec_on`, where an operation is actually
/// cancellable; internal bookkeeping calls (toplevel/common-dir discovery, repo
/// state) go through `run` above with a flag that's never set, since those aren't
/// user-cancellable operations. The patch is data Git parses, not a command or shell
/// input, so it needs no extra validation beyond the argv allow-list `apply` (like
/// every subcommand) already goes through.
fn run_with_input(
    root: &Path,
    args: &[&str],
    input: Option<String>,
    cancel: Arc<AtomicBool>,
) -> Result<ToolOutput, String> {
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
    let result = capture(command, input, cancel)?;
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
/// repository, which is what makes it the correct key for `StashLocks`/
/// `NetworkLocks`: a linked worktree must never be mistaken for an independent
/// repository when deciding whether two operations share a lock.
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
    let mut guard = repos.0.lock().map_err(|e| e.to_string())?;
    if let std::collections::hash_map::Entry::Vacant(entry) = guard.entry(repo_id.clone()) {
        // Best-effort: fall back to this worktree's own root as its own repository
        // identity if the common-dir lookup somehow fails. That only means this
        // worktree's stash/network operations won't be coordinated with any sibling
        // worktree of the same repository -- every other guarantee in this file
        // (the security allow-list, this worktree's own lock) is unaffected.
        let repository_id = discover_common_dir(&toplevel)
            .map(|p| clean_path_str(&p))
            .unwrap_or_else(|_| repo_id.clone());
        entry.insert(Arc::new(Repo {
            root: toplevel.clone(),
            repository_id,
            lock: Mutex::new(()),
        }));
    }
    drop(guard);
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
pub fn git_close_repo(
    state: State<'_, Repos>,
    jobs: State<'_, GitJobs>,
    repo_id: String,
) -> Result<(), String> {
    state.0.lock().map_err(|e| e.to_string())?.remove(&repo_id);
    // A running (or lock-queued) operation against this worktree should not keep a
    // `git` process alive once Yavin no longer considers the repository open.
    cancel_jobs_for_repo(&jobs, &repo_id)?;
    Ok(())
}

/// Every currently-active per-repository `.git` watcher (see
/// `ide_workspace::watcher::start_git_watcher`), keyed by `repository_id` --
/// mirrors `Repos`'s own shape. Registering a repository that's already watched
/// replaces its entry (dropping, and so stopping, the old watcher first): this is
/// how opening a second worktree of an already-watched repository re-registers
/// with the expanded worktree list, without TypeScript needing to track "is this
/// the first worktree" specially.
#[derive(Default)]
pub struct GitWatches(pub Mutex<HashMap<String, watcher::RecommendedWatcher>>);

/// The payload `git-changed` carries -- a bare classification, no Git data of its
/// own (TypeScript decides what to actually refresh; see the Git State &
/// Synchronization plan's Section Z). `worktree_root` is only present for the two
/// per-worktree kinds (`head`, `operation-state`); the three repository-shared
/// kinds (`refs`, `remotes`, `stash`) apply to every worktree of the repository.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct GitChangeEvent {
    repository_id: String,
    kind: &'static str,
    worktree_root: Option<String>,
}

/// Resolves each worktree's real, absolute gitdir via `rev-parse
/// --absolute-git-dir` (needed so a `Head`/`OperationState` event, which
/// `start_git_watcher` reports by gitdir, can be translated back to the worktree
/// root TypeScript actually keys its `RepoEntry`s by). A worktree that fails to
/// resolve (e.g. it was removed externally between being tracked and this call)
/// is silently skipped, not fatal to the rest. Split out from `watch_repo` because
/// `run()` spawns a blocking `git` process and must run off the async runtime's
/// worker thread, exactly like every other git-invoking command in this file.
fn resolve_worktree_gitdirs(roots: Vec<(PathBuf, String)>) -> Vec<(PathBuf, String)> {
    roots
        .into_iter()
        .filter_map(|(root, repo_id)| {
            let output = run(&root, &["rev-parse", "--absolute-git-dir"]).ok()?;
            (output.code == 0).then(|| (PathBuf::from(output.stdout.trim()), repo_id))
        })
        .collect()
}

/// Starts (or restarts, if already watching) a narrow `.git`-ref watcher for one
/// repository, covering exactly the worktrees named by `worktree_repo_ids`. The
/// full logic behind the `git_watch_repo` command, taking `&Repos`/`&GitWatches`
/// directly and a plain event callback instead of `State`/`AppHandle::emit` --
/// mirrors how `exec_on` relates to `git_exec` (Module 2 Phase 5), so this can be
/// exercised by a real test with real repositories and no Tauri app needed.
async fn watch_repo(
    repos: &Repos,
    watches: &GitWatches,
    on_event: impl Fn(GitChangeEvent) + Send + Sync + 'static,
    repository_id: String,
    worktree_repo_ids: Vec<String>,
) -> Result<(), String> {
    let roots: Vec<(PathBuf, String)> = worktree_repo_ids
        .iter()
        .filter_map(|id| repo_of(repos, id).ok())
        .map(|repo| (repo.root.clone(), clean_path_str(&repo.root)))
        .collect();

    let gitdirs = tauri::async_runtime::spawn_blocking(move || resolve_worktree_gitdirs(roots))
        .await
        .map_err(|e| e.to_string())?;

    let common_dir = PathBuf::from(&repository_id);
    let worktree_gitdirs: Vec<PathBuf> = gitdirs.iter().map(|(dir, _)| dir.clone()).collect();
    let gitdir_to_root: HashMap<PathBuf, String> = gitdirs.into_iter().collect();

    let event_repository_id = repository_id.clone();
    let watcher = watcher::start_git_watcher(&common_dir, &worktree_gitdirs, move |kind| {
        let (kind_name, worktree_root): (&'static str, Option<String>) = match &kind {
            watcher::GitChangeKind::Head(dir) => ("head", gitdir_to_root.get(dir).cloned()),
            watcher::GitChangeKind::OperationState(dir) => {
                ("operation-state", gitdir_to_root.get(dir).cloned())
            }
            watcher::GitChangeKind::Refs => ("refs", None),
            watcher::GitChangeKind::Remotes => ("remotes", None),
            watcher::GitChangeKind::Stash => ("stash", None),
        };
        on_event(GitChangeEvent {
            repository_id: event_repository_id.clone(),
            kind: kind_name,
            worktree_root,
        });
    })
    .map_err(|e| e.to_string())?;

    watches
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .insert(repository_id, watcher);
    Ok(())
}

#[tauri::command]
pub async fn git_watch_repo(
    app: AppHandle,
    state: State<'_, Repos>,
    watches: State<'_, GitWatches>,
    repository_id: String,
    worktree_repo_ids: Vec<String>,
) -> Result<(), String> {
    let handle = app.clone();
    watch_repo(
        &state,
        &watches,
        move |event| {
            let _ = handle.emit("git-changed", event);
        },
        repository_id,
        worktree_repo_ids,
    )
    .await
}

/// Stops watching one repository -- dropping its `RecommendedWatcher` ends the
/// watch immediately. Called once the last worktree of a repository is closed;
/// closing one of several open worktrees instead calls `git_watch_repo` again
/// with the remaining, narrower worktree list.
#[tauri::command]
pub fn git_unwatch_repo(
    watches: State<'_, GitWatches>,
    repository_id: String,
) -> Result<(), String> {
    watches
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&repository_id);
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
    flag("-M"),
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
// `--skip` is meaningless for `merge` (Git has no multi-commit sequence for it to
// advance past) -- allowing it here is still safe, since `merge --skip` simply fails
// with Git's own argument error; `Repository.skip()` never issues it for merge in the
// first place (a client-side guard, since Git's own error text here is generic, not
// semantically clear the way its worktree-exclusivity/unresolved-conflict refusals are).
const ABORT_CONTINUE: &[FlagRule] = &[flag("--abort"), flag("--continue"), flag("--skip")];
const LOG: &[FlagRule] = &[
    value_flag("-n"),
    value_flag("--skip"),
    flag("--topo-order"),
    prefix_flag("--pretty="),
    prefix_flag("--date="),
];
const FOR_EACH_REF: &[FlagRule] = &[prefix_flag("--format=")];
// Like `stash` (`push`/`pop`/`apply`/`drop`/`list` are positional, not flags, so this
// allow-list only governs `--porcelain`), TypeScript currently only ever calls
// `worktree list --porcelain`; nothing constructs `worktree add/remove/lock/prune`
// yet, so there is nothing else to validate here today.
const WORKTREE: &[FlagRule] = &[flag("--porcelain")];
// Deletion only -- no rename/create flag, since `switch -c` already owns creation
// (SWITCH above). `-d`/`-D` are Git's own two-tier safety (safe delete vs. force);
// neither can bypass Git's separate, unconditional refusal to delete a branch
// checked out in any worktree (verified empirically, not assumed).
const BRANCH: &[FlagRule] = &[flag("-d"), flag("-D")];
// `--prune` only ever removes LOCAL records of refs the remote no longer has -- it
// can never delete anything from the remote itself, and it never resets the graph
// (it removes a ref, never a commit object; see the plan's Section T).
const FETCH: &[FlagRule] = &[flag("--prune")];

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
        "branch" => BRANCH,
        "remote" => NONE,
        "fetch" => FETCH,
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
        "worktree" => WORKTREE,
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

/// Resolves which shared lock (if any) `args` requires against `repository_id`,
/// against real lock maps. Split out from `exec_on` because `git_exec` (the Tauri
/// command) must resolve this *before* handing off to `spawn_blocking` -- a
/// `tauri::State` borrow cannot cross that boundary (it isn't `'static`), unlike the
/// owned `Arc<Mutex<()>>` this returns, which can.
fn resolve_scope_lock(
    stash_locks: &StashLocks,
    network_locks: &NetworkLocks,
    repository_id: &str,
    args: &[String],
) -> Result<Option<Arc<Mutex<()>>>, String> {
    let Some(subcommand) = args.first() else {
        return Ok(None);
    };
    match operation_scope(subcommand, &args[1..]) {
        Scope::Stash => Ok(Some(lock_for(&stash_locks.0, repository_id)?)),
        Scope::Network => Ok(Some(lock_for(&network_locks.0, repository_id)?)),
        Scope::WorktreeLocal => Ok(None),
    }
}

/// The full path an actual `git_exec` call takes: validate, then take whichever
/// shared lock this operation's scope required (already resolved by the caller via
/// `resolve_scope_lock`) before this worktree's own lock -- a fixed order every call
/// site uses, so no operation ever needs two locks acquired in different orders,
/// which is what would be needed to deadlock -- then run. Both lock acquisitions are
/// cancellable (`acquire_cancellable`): an operation cancelled while queued behind
/// another never acquires anything or spawns `git` at all. Shared by the Tauri
/// command and its tests.
fn exec_on(
    repo: &Repo,
    scope_lock: Option<Arc<Mutex<()>>>,
    args: &[String],
    input: Option<String>,
    cancel: Arc<AtomicBool>,
) -> Result<ToolOutput, String> {
    let subcommand = args.first().ok_or("Missing Git subcommand")?;
    validate_args(subcommand, &args[1..])?;

    let _scope_guard = scope_lock
        .as_ref()
        .map(|lock| acquire_cancellable(lock, &cancel))
        .transpose()?;
    let _worktree_guard = acquire_cancellable(&repo.lock, &cancel)?;

    let args_ref: Vec<&str> = args.iter().map(String::as_str).collect();
    run_with_input(&repo.root, &args_ref, input, cancel)
}

// Every extra parameter here is a distinct piece of Tauri-managed state
// (`State<'_, T>`), which is how Tauri commands receive them -- not something a
// smaller helper struct could reduce without fighting that convention.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn git_exec(
    state: State<'_, Repos>,
    stash_locks: State<'_, StashLocks>,
    network_locks: State<'_, NetworkLocks>,
    jobs: State<'_, GitJobs>,
    repo_id: String,
    args: Vec<String>,
    input: Option<String>,
    id: String,
) -> Result<ToolOutput, String> {
    let repo = repo_of(&state, &repo_id)?;
    let scope_lock = resolve_scope_lock(&stash_locks, &network_locks, &repo.repository_id, &args)?;
    let cancel = register_job(&jobs, &id, &repo_id)?;
    // Removes this job's entry on every exit path below, including the `?` on the
    // next line -- `jobs` (a `State`, not `'static`) never crosses the
    // `spawn_blocking` boundary; only the `cancel` flag clone does.
    let _guard = JobGuard {
        jobs: &jobs,
        id: id.clone(),
    };
    tauri::async_runtime::spawn_blocking(move || exec_on(&repo, scope_lock, &args, input, cancel))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn git_cancel(jobs: State<'_, GitJobs>, id: String) -> Result<(), String> {
    cancel_job(&jobs, &id)
}

/// Cancels every operation currently registered against one repository -- what the
/// Source Control panel's per-worktree Cancel button actually needs: since
/// `RepoStore` only ever has one operation in flight at a time, "cancel this
/// repository's operations" and "cancel the current operation" are the same thing,
/// without TypeScript needing to track or thread individual operation ids through
/// every `Repository` method just to address one back to `git_cancel`.
#[tauri::command]
pub fn git_cancel_repo(jobs: State<'_, GitJobs>, repo_id: String) -> Result<(), String> {
    cancel_jobs_for_repo(&jobs, &repo_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        sync::atomic::AtomicU64,
        time::{Instant, UNIX_EPOCH},
    };

    /// A nanosecond timestamp alone is not unique enough: this module's tests now
    /// create several temp dirs per test (a main fixture plus linked worktrees) and
    /// run in parallel, and Windows' clock resolution is coarser than a nanosecond --
    /// two threads calling `SystemTime::now()` can observe the same value. Mixing in
    /// a process-wide monotonic counter closes that collision window.
    fn temp_dir() -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let sequence = COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "yavin_git_native_test_{}_{sequence}",
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
        let repository_id = discover_common_dir(&toplevel)
            .map(|p| clean_path_str(&p))
            .unwrap_or_else(|_| clean_path_str(&toplevel));
        Repo {
            root: toplevel,
            repository_id,
            lock: Mutex::new(()),
        }
    }

    fn args(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    /// Test convenience matching `exec_on`'s old (pre-scope-lock) call shape: fresh,
    /// throwaway lock maps every call, correct for every test that isn't itself
    /// exercising cross-call lock sharing (those construct `StashLocks`/
    /// `NetworkLocks` explicitly and share them across threads instead).
    fn exec(repo: &Repo, args: &[String], input: Option<String>) -> Result<ToolOutput, String> {
        let stash_locks = StashLocks::default();
        let network_locks = NetworkLocks::default();
        let scope_lock =
            resolve_scope_lock(&stash_locks, &network_locks, &repo.repository_id, args).unwrap();
        exec_on(
            repo,
            scope_lock,
            args,
            input,
            Arc::new(AtomicBool::new(false)),
        )
    }

    #[test]
    fn a_disallowed_flag_is_rejected_before_git_ever_runs() {
        let (dir, _git) = fixture();
        let repo = open(&dir);
        // This is exactly the option-injection shape a malicious "remote name" or
        // "branch name" could try to smuggle in; it must never reach `git push`.
        let result = exec(
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
        exec(&repo, &args(&["add", "a.txt"]), None).unwrap();
        // A commit message that happens to start with '-' is still just a message.
        let result = exec(&repo, &args(&["commit", "-m", "-not a flag"]), None);
        let _ = fs::remove_dir_all(&dir);
        assert!(result.is_ok());
    }

    #[test]
    fn a_pathspec_after_double_dash_may_itself_start_with_a_dash() {
        let (dir, _git) = fixture();
        let repo = open(&dir);
        fs::write(dir.join("-weird.txt"), "x\n").unwrap();
        let result = exec(&repo, &args(&["add", "--", "-weird.txt"]), None);
        let _ = fs::remove_dir_all(&dir);
        assert!(result.is_ok());
    }

    #[test]
    fn an_unsupported_subcommand_is_rejected() {
        let (dir, _git) = fixture();
        let repo = open(&dir);
        let result = exec(
            &repo,
            &args(&["config", "--global", "user.name", "x"]),
            None,
        );
        let _ = fs::remove_dir_all(&dir);
        assert!(result.unwrap_err().contains("not supported"));
    }

    /// The Git State & Synchronization plan's Race 6/7 -- a worktree directory
    /// disappearing externally (deleted, or moved out from under Yavin) mid-
    /// session -- must degrade to a clean Git-level error, never a panic or a
    /// silently-corrupted result.
    #[test]
    fn a_worktree_deleted_out_from_under_an_open_repo_fails_cleanly_not_a_panic() {
        let (dir, _git) = fixture();
        let repo = open(&dir);
        fs::remove_dir_all(&dir).unwrap();

        let result = exec(&repo, &args(&["status", "--porcelain=v1", "-z"]), None);

        assert!(
            result.is_err(),
            "a deleted worktree must fail, not silently return an empty (falsely-clean) status"
        );
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
    fn worktree_list_porcelain_is_reachable_through_the_guarded_executor() {
        let (dir, git) = fixture();
        let linked = temp_dir();
        assert!(git(&[
            "worktree",
            "add",
            linked.to_str().unwrap(),
            "-b",
            "feature",
        ]));

        let repo = open(&dir);
        let output = exec(&repo, &args(&["worktree", "list", "--porcelain"]), None);
        // Only `--porcelain` is allow-listed; an unrelated flag must still be refused.
        let rejected = exec(&repo, &args(&["worktree", "list", "--bogus-flag"]), None);

        let _ = fs::remove_dir_all(&linked);
        let _ = fs::remove_dir_all(&dir);

        assert!(output.unwrap().stdout.contains("branch refs/heads/feature"));
        assert!(rejected.unwrap_err().contains("not permitted"));
    }

    #[test]
    fn cat_file_filters_applies_checkout_line_endings() {
        let (dir, git) = fixture();
        git(&["config", "core.autocrlf", "true"]);
        fs::write(dir.join("a.txt"), "one\ntwo\n").unwrap();
        assert!(git(&["add", "a.txt"]));
        let repo = open(&dir);
        let output = exec(&repo, &args(&["cat-file", "--filters", ":a.txt"]), None);
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
        let abort = exec(&repo, &args(&["merge", "--abort"]), None);
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
        let diff = exec(&repo, &args(&["diff", "--", "a.txt"]), None).unwrap();

        let apply = exec(&repo, &args(&["apply", "--cached"]), Some(diff.stdout));
        let staged = exec(&repo, &args(&["diff", "--cached", "--", "a.txt"]), None);
        // --cached only touches the index; since the working tree already matched the
        // patch, the index now matches the working tree too, so the unstaged diff empties.
        let worktree_diff = exec(&repo, &args(&["diff", "--", "a.txt"]), None);
        let _ = fs::remove_dir_all(&dir);

        assert!(apply.is_ok(), "apply failed: {:?}", apply.err());
        assert!(staged.unwrap().stdout.contains("+changed"));
        assert_eq!(worktree_diff.unwrap().stdout, "");
    }

    /// A main worktree plus two linked worktrees, each on its own branch (Git itself
    /// refuses two worktrees on the same branch -- see the plan's empirical
    /// verification), for the cross-worktree locking tests below.
    fn fixture_with_two_linked_worktrees() -> (PathBuf, Repo, Repo) {
        let (dir, git) = fixture();
        let a = temp_dir();
        let b = temp_dir();
        assert!(git(&[
            "worktree",
            "add",
            a.to_str().unwrap(),
            "-b",
            "worktree-a"
        ]));
        assert!(git(&[
            "worktree",
            "add",
            b.to_str().unwrap(),
            "-b",
            "worktree-b"
        ]));
        (dir, open(&a), open(&b))
    }

    #[test]
    fn stash_pushes_from_different_worktrees_of_the_same_repository_do_not_corrupt_shared_state() {
        let (dir, repo_a, repo_b) = fixture_with_two_linked_worktrees();
        let (root_a, root_b) = (repo_a.root.clone(), repo_b.root.clone());
        fs::write(root_a.join("a.txt"), "change from A\n").unwrap();
        fs::write(root_b.join("a.txt"), "change from B\n").unwrap();
        assert_eq!(
            repo_a.repository_id, repo_b.repository_id,
            "both worktrees must resolve to the same repository identity for this \
             test to actually exercise the stash lock"
        );

        let stash_locks = Arc::new(StashLocks::default());
        let network_locks = Arc::new(NetworkLocks::default());
        let repo_a = Arc::new(repo_a);
        let repo_b = Arc::new(repo_b);

        let run_stash = |repo: Arc<Repo>, message: &'static str| {
            let stash_locks = stash_locks.clone();
            let network_locks = network_locks.clone();
            std::thread::spawn(move || {
                let call = args(&["stash", "push", "-u", "-m", message]);
                let scope_lock =
                    resolve_scope_lock(&stash_locks, &network_locks, &repo.repository_id, &call)
                        .unwrap();
                exec_on(
                    &repo,
                    scope_lock,
                    &call,
                    None,
                    Arc::new(AtomicBool::new(false)),
                )
            })
        };
        let handle_a = run_stash(repo_a, "from-a");
        let handle_b = run_stash(repo_b, "from-b");
        let result_a = handle_a.join().unwrap();
        let result_b = handle_b.join().unwrap();

        let list = Command::new("git")
            .current_dir(&dir)
            .args(["stash", "list"])
            .output()
            .unwrap();
        let list = String::from_utf8_lossy(&list.stdout).into_owned();

        let _ = fs::remove_dir_all(&root_a);
        let _ = fs::remove_dir_all(&root_b);
        let _ = fs::remove_dir_all(&dir);

        assert!(result_a.is_ok(), "{:?}", result_a.err());
        assert!(result_b.is_ok(), "{:?}", result_b.err());
        assert_eq!(
            list.lines().count(),
            2,
            "both concurrent stashes must land intact on the one shared refs/stash \
             -- neither corrupted nor silently dropped:\n{list}"
        );
    }

    #[test]
    fn worktree_local_operations_across_different_worktrees_are_not_serialized() {
        let (dir, repo_a, repo_b) = fixture_with_two_linked_worktrees();
        let (root_a, root_b) = (repo_a.root.clone(), repo_b.root.clone());
        fs::write(root_b.join("a.txt"), "change from B\n").unwrap();

        let repo_a = Arc::new(repo_a);
        let repo_b = Arc::new(repo_b);
        let a_for_thread = repo_a.clone();

        let started = Instant::now();
        // A does nothing but read; B stages and commits. If the new locks
        // accidentally serialized worktree-local operations across worktrees (the
        // exact regression this design exists to avoid), A would have to wait for
        // B's whole stage+commit before running at all.
        let handle_b = std::thread::spawn(move || {
            exec(&repo_b, &args(&["add", "a.txt"]), None).unwrap();
            exec(&repo_b, &args(&["commit", "-m", "from b"]), None)
        });
        let status_a = exec(
            &a_for_thread,
            &args(&["status", "--porcelain=v1", "-z"]),
            None,
        );
        let a_finished_at = started.elapsed();
        let result_b = handle_b.join().unwrap();

        let _ = fs::remove_dir_all(&root_a);
        let _ = fs::remove_dir_all(&root_b);
        let _ = fs::remove_dir_all(&dir);

        assert!(status_a.is_ok());
        assert!(result_b.is_ok(), "{:?}", result_b.err());
        assert!(
            a_finished_at < Duration::from_secs(2),
            "A's read took {a_finished_at:?} -- it should never have to wait on B's \
             unrelated worktree-local commit"
        );
    }

    #[test]
    fn cancelling_an_operation_queued_behind_a_held_stash_lock_never_lets_it_run() {
        let (dir, git) = fixture();
        let repository_id = discover_common_dir(&dir)
            .map(|p| clean_path_str(&p))
            .unwrap();
        let repo = open(&dir);
        assert_eq!(repo.repository_id, repository_id);

        let stash_locks = StashLocks::default();
        // Hold the stash lock ourselves, simulating another operation already
        // running, so the call below has to queue for it.
        let held = lock_for(&stash_locks.0, &repository_id).unwrap();
        let _held_guard = held.lock().unwrap();

        let cancel = Arc::new(AtomicBool::new(true));
        let network_locks = NetworkLocks::default();
        let call = args(&["stash", "push", "-u", "-m", "should never run"]);
        let scope_lock =
            resolve_scope_lock(&stash_locks, &network_locks, &repo.repository_id, &call).unwrap();
        let started = Instant::now();
        let result = exec_on(&repo, scope_lock, &call, None, cancel);
        let elapsed = started.elapsed();

        let stash_list_after = git(&["stash", "list"]);
        let _ = fs::remove_dir_all(&dir);

        assert_eq!(result.unwrap_err(), "Cancelled");
        assert!(
            elapsed < Duration::from_secs(1),
            "cancellation while waiting for the lock must not wait for the lock to \
             free up; took {elapsed:?}"
        );
        // `git` returns true/false for success in this fixture's closure, not stash
        // output -- the real assertion is that `exec_on` never got far enough to run
        // `git stash push` at all, which the fast, immediate Cancelled result above
        // already proves (it never touched the held lock).
        let _ = stash_list_after;
    }

    #[test]
    fn register_job_returns_a_fresh_unset_flag_and_reuses_it_on_a_second_call() {
        let jobs = GitJobs::default();
        let flag = register_job(&jobs, "op-1", "/work").unwrap();
        assert!(!flag.load(Ordering::Relaxed));

        // The same id registering again (e.g. a stale retry) gets the same flag, not
        // a fresh one that would forget an already-in-flight cancellation.
        let same_flag = register_job(&jobs, "op-1", "/work").unwrap();
        flag.store(true, Ordering::Relaxed);
        assert!(same_flag.load(Ordering::Relaxed));
    }

    #[test]
    fn cancel_job_flips_the_flag_of_an_already_registered_job() {
        let jobs = GitJobs::default();
        let flag = register_job(&jobs, "op-1", "/work").unwrap();
        assert!(!flag.load(Ordering::Relaxed));
        cancel_job(&jobs, "op-1").unwrap();
        assert!(flag.load(Ordering::Relaxed));
    }

    #[test]
    fn cancelling_before_registration_pre_cancels_the_operation() {
        let jobs = GitJobs::default();
        // The cancel arrives first -- a real, if narrow, race between two separate
        // command invocations with no ordering guarantee between them.
        cancel_job(&jobs, "op-1").unwrap();
        let flag = register_job(&jobs, "op-1", "/work").unwrap();
        assert!(
            flag.load(Ordering::Relaxed),
            "registering after a pre-cancel must find the operation already cancelled"
        );
    }

    #[test]
    fn cancel_jobs_for_repo_only_cancels_jobs_registered_against_that_repository() {
        let jobs = GitJobs::default();
        let flag_a = register_job(&jobs, "op-a", "/work-a").unwrap();
        let flag_b = register_job(&jobs, "op-b", "/work-b").unwrap();
        cancel_jobs_for_repo(&jobs, "/work-a").unwrap();
        assert!(flag_a.load(Ordering::Relaxed));
        assert!(!flag_b.load(Ordering::Relaxed));
    }

    #[test]
    fn job_guard_removes_its_entry_on_drop() {
        let jobs = GitJobs::default();
        register_job(&jobs, "op-1", "/work").unwrap();
        assert!(jobs.0.lock().unwrap().contains_key("op-1"));
        {
            let _guard = JobGuard {
                jobs: &jobs,
                id: "op-1".to_string(),
            };
        }
        assert!(
            !jobs.0.lock().unwrap().contains_key("op-1"),
            "the entry must be gone once the guard drops, without a manual removal call"
        );
    }

    /// A main worktree plus one linked worktree, sharing two already-committed
    /// tracked files (`a.txt`, `b.txt`) and a third branch ("elsewhere") that is
    /// never checked out anywhere -- everything Section H.1's execution-context
    /// proof needs, built once so each assertion below stays about the invariant,
    /// not fixture plumbing.
    fn fixture_for_execution_context_proof() -> (PathBuf, PathBuf, Repo, Repo) {
        let (dir, git) = fixture();
        fs::write(dir.join("b.txt"), "base\n").unwrap();
        assert!(git(&["add", "b.txt"]));
        assert!(git(&["commit", "-qm", "add b.txt"]));
        assert!(git(&["branch", "elsewhere"]));

        let linked = temp_dir();
        assert!(git(&[
            "worktree",
            "add",
            linked.to_str().unwrap(),
            "-b",
            "linked-worktree",
        ]));

        // Unique, non-overlapping uncommitted changes: main only touches a.txt,
        // the linked worktree only touches b.txt.
        fs::write(dir.join("a.txt"), "changed in main\n").unwrap();
        fs::write(linked.join("b.txt"), "changed in linked\n").unwrap();

        let main_repo = open(&dir);
        let linked_repo = open(&linked);
        assert_eq!(
            main_repo.repository_id, linked_repo.repository_id,
            "both worktrees must share one repository identity for this proof to \
             mean anything"
        );
        (dir, linked, main_repo, linked_repo)
    }

    #[test]
    fn a_command_never_executes_against_a_worktree_other_than_the_one_it_was_issued_for() {
        let (dir, linked, main_repo, linked_repo) = fixture_for_execution_context_proof();

        let status_args = args(&["status", "--porcelain=v1", "-z", "-uall"]);
        let diff_args = |file: &str| {
            args(&[
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                "--",
                file,
            ])
        };
        let branch_args = args(&["symbolic-ref", "--short", "HEAD"]);
        let head_args = args(&["rev-parse", "HEAD"]);

        // 1. status only reports the change actually made in that worktree.
        let status_main = exec(&main_repo, &status_args, None).unwrap();
        let status_linked = exec(&linked_repo, &status_args, None).unwrap();
        assert!(status_main.stdout.contains("a.txt"));
        assert!(!status_main.stdout.contains("b.txt"));
        assert!(status_linked.stdout.contains("b.txt"));
        assert!(!status_linked.stdout.contains("a.txt"));

        // 2. diff only shows that worktree's own uncommitted content change.
        let diff_main = exec(&main_repo, &diff_args("a.txt"), None).unwrap();
        let diff_linked = exec(&linked_repo, &diff_args("b.txt"), None).unwrap();
        assert!(diff_main.stdout.contains("changed in main"));
        assert!(!diff_main.stdout.contains("changed in linked"));
        assert!(diff_linked.stdout.contains("changed in linked"));
        assert!(!diff_linked.stdout.contains("changed in main"));

        // 3. staging + committing in main advances only main's HEAD, and never
        // disturbs the linked worktree's own still-uncommitted change.
        let linked_head_before = exec(&linked_repo, &head_args, None).unwrap().stdout;
        let main_head_before = exec(&main_repo, &head_args, None).unwrap().stdout;
        exec(&main_repo, &args(&["add", "a.txt"]), None).unwrap();
        exec(
            &main_repo,
            &args(&["commit", "-m", "commit from main"]),
            None,
        )
        .unwrap();
        let main_head_after = exec(&main_repo, &head_args, None).unwrap().stdout;
        let linked_head_after = exec(&linked_repo, &head_args, None).unwrap().stdout;
        let linked_diff_after = exec(&linked_repo, &diff_args("b.txt"), None).unwrap();
        assert_ne!(
            main_head_before, main_head_after,
            "committing in main must move main's own HEAD"
        );
        assert_eq!(
            linked_head_before, linked_head_after,
            "committing in main must never move the linked worktree's HEAD"
        );
        assert!(
            linked_diff_after.stdout.contains("changed in linked"),
            "the linked worktree's own uncommitted change must survive a commit \
             made in a different worktree"
        );

        // 4. switching main to a branch checked out nowhere else changes only
        // main's own current branch.
        let linked_branch_before = exec(&linked_repo, &branch_args, None).unwrap().stdout;
        exec(&main_repo, &args(&["switch", "elsewhere"]), None).unwrap();
        let main_branch_after = exec(&main_repo, &branch_args, None).unwrap().stdout;
        let linked_branch_after = exec(&linked_repo, &branch_args, None).unwrap().stdout;
        assert_eq!(main_branch_after.trim(), "elsewhere");
        assert_eq!(
            linked_branch_before, linked_branch_after,
            "switching main's branch must never change the linked worktree's \
             current branch"
        );

        let _ = fs::remove_dir_all(&linked);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_git_operation_cancelled_through_the_real_job_registry_is_actually_stopped() {
        let (dir, _git) = fixture();
        let repository_id = discover_common_dir(&dir)
            .map(|p| clean_path_str(&p))
            .unwrap();
        let jobs = GitJobs::default();
        // The exact flag `git_exec` would register and `git_cancel` would flip.
        let cancel = register_job(&jobs, "op-1", &repository_id).unwrap();
        assert!(
            !jobs.0.lock().unwrap().is_empty(),
            "sanity: the job was registered"
        );

        let flag = cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            cancel_job(&jobs, "op-1").unwrap();
        });

        // A long-running command in the same shape `run_with_input` spawns internally
        // (via `capture`), so this exercises real process termination end-to-end,
        // through the exact flag the job registry hands out.
        let mut sleepy = Command::new("cmd");
        sleepy.args(["/C", "timeout", "/t", "30"]);
        let started = Instant::now();
        let result = capture(sleepy, None, flag);
        let elapsed = started.elapsed();

        let _ = fs::remove_dir_all(&dir);

        assert_eq!(result.unwrap_err(), "Cancelled");
        assert!(
            elapsed < Duration::from_secs(5),
            "took {elapsed:?} -- cancellation through the real job registry must stop \
             the process promptly, not wait for it to run its full course"
        );
    }

    /// A `Repos` map containing every worktree returned by
    /// `fixture_with_two_linked_worktrees`, keyed exactly like `register_repo`
    /// would key them -- what `watch_repo` needs to resolve `worktree_repo_ids`
    /// into real worktree roots.
    fn repos_for(worktrees: &[&Repo]) -> Repos {
        let repos = Repos::default();
        let mut guard = repos.0.lock().unwrap();
        for repo in worktrees {
            guard.insert(
                clean_path_str(&repo.root),
                Arc::new(Repo {
                    root: repo.root.clone(),
                    repository_id: repo.repository_id.clone(),
                    lock: Mutex::new(()),
                }),
            );
        }
        drop(guard);
        repos
    }

    #[test]
    fn watch_repo_reports_correctly_classified_and_attributed_events() {
        let (dir, repo_a, repo_b) = fixture_with_two_linked_worktrees();
        let repos = repos_for(&[&repo_a, &repo_b]);
        let watches = GitWatches::default();
        let events: Arc<std::sync::Mutex<Vec<GitChangeEvent>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let collected = Arc::clone(&events);

        tauri::async_runtime::block_on(watch_repo(
            &repos,
            &watches,
            move |event| collected.lock().unwrap().push(event),
            repo_a.repository_id.clone(),
            vec![clean_path_str(&repo_a.root), clean_path_str(&repo_b.root)],
        ))
        .unwrap();

        // The same lookup `watch_repo` itself does internally, to find the exact
        // paths a real Git action against worktree A would touch -- not guessed.
        let common_dir = PathBuf::from(&repo_a.repository_id);
        let a_gitdir = PathBuf::from(
            run(&repo_a.root, &["rev-parse", "--absolute-git-dir"])
                .unwrap()
                .stdout
                .trim(),
        );

        // A repository-shared change (a new local branch, visible from every
        // worktree's shared common dir) ...
        std::fs::write(common_dir.join("refs/heads/from-outside"), "abc123\n").unwrap();
        // ... and a per-worktree change (A's own HEAD moving) -- bypassing `git`
        // itself (a raw file write, not `git switch`) to isolate the watcher from
        // any other side effect, matching `watcher.rs`'s own test convention.
        std::fs::write(a_gitdir.join("HEAD"), "ref: refs/heads/from-outside\n").unwrap();
        std::thread::sleep(Duration::from_millis(300 * 4));

        watches.0.lock().unwrap().remove(&repo_a.repository_id);
        let seen = events.lock().unwrap().clone();
        let _ = fs::remove_dir_all(&repo_a.root);
        let _ = fs::remove_dir_all(&repo_b.root);
        let _ = fs::remove_dir_all(&dir);

        assert!(
            seen.iter()
                .any(|e| e.kind == "refs" && e.worktree_root.is_none()),
            "expected an unattributed repository-shared 'refs' event, got {seen:?}"
        );
        assert!(
            seen.iter().any(|e| e.kind == "head"
                && e.worktree_root.as_deref() == Some(&clean_path_str(&repo_a.root))),
            "expected a 'head' event attributed to worktree A's own root, got {seen:?}"
        );
    }

    #[test]
    fn unwatching_a_repository_stops_further_events() {
        let (dir, _git) = fixture();
        let repository_id = discover_common_dir(&dir)
            .map(|p| clean_path_str(&p))
            .unwrap();
        let repo = Repo {
            root: dir.clone(),
            repository_id: repository_id.clone(),
            lock: Mutex::new(()),
        };
        let repos = repos_for(&[&repo]);
        let watches = GitWatches::default();
        let events: Arc<std::sync::Mutex<Vec<GitChangeEvent>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let collected = Arc::clone(&events);

        tauri::async_runtime::block_on(watch_repo(
            &repos,
            &watches,
            move |event| collected.lock().unwrap().push(event),
            repository_id.clone(),
            vec![clean_path_str(&dir)],
        ))
        .unwrap();
        assert!(watches.0.lock().unwrap().contains_key(&repository_id));

        let common_dir = PathBuf::from(&repository_id);
        std::fs::write(common_dir.join("refs/heads/before-unwatch"), "abc\n").unwrap();
        std::thread::sleep(Duration::from_millis(300 * 3));
        let before = events.lock().unwrap().len();
        assert!(
            before > 0,
            "sanity: the watcher must have reported something before unwatching"
        );

        // Exactly what git_unwatch_repo does -- dropping the map entry drops (and so
        // stops) the underlying RecommendedWatcher. A brief grace period covers the
        // OS's own, not-necessarily-instantaneous unregistration (observed: a write
        // issued immediately after drop() can still straggle in on some backends).
        watches.0.lock().unwrap().remove(&repository_id);
        std::thread::sleep(Duration::from_millis(100));

        std::fs::write(common_dir.join("refs/heads/after-unwatch"), "def\n").unwrap();
        std::thread::sleep(Duration::from_millis(300 * 3));
        let after_first = events.lock().unwrap().len();
        // A second post-unwatch write, further separated in time, must show no
        // further growth -- distinguishing "truly stopped" from "one straggling
        // event from an in-flight OS notification at the moment of the drop".
        std::fs::write(common_dir.join("refs/heads/after-unwatch-2"), "ghi\n").unwrap();
        std::thread::sleep(Duration::from_millis(300 * 3));
        let after = events.lock().unwrap().len();

        let _ = fs::remove_dir_all(&dir);

        assert_eq!(
            after, after_first,
            "a second write, well after unwatching, must never add a further event"
        );
    }

    #[test]
    fn a_staged_rename_with_a_content_change_diffs_as_a_compact_rename_not_a_full_add() {
        let (dir, git) = fixture();
        let repo = open(&dir);

        std::fs::write(dir.join("a.txt"), "line1\nline2\nline3\nline4\nline5\n").unwrap();
        assert!(git(&["add", "a.txt"]));
        assert!(git(&["commit", "-qm", "five lines"]));
        assert!(git(&["mv", "a.txt", "b.txt"]));
        std::fs::write(
            dir.join("b.txt"),
            "line1\nline2-changed\nline3\nline4\nline5\n",
        )
        .unwrap();
        assert!(git(&["add", "b.txt"]));

        // -M must be permitted by the allow-list, and both the old and new path
        // must be passed as pathspecs together for Git to recognize the rename
        // relationship (Module 5 Section B/D's verified fix).
        let output = exec(
            &repo,
            &args(&[
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                "-M",
                "--cached",
                "--",
                "b.txt",
                "a.txt",
            ]),
            None,
        )
        .unwrap();
        let _ = fs::remove_dir_all(&dir);

        assert!(
            output.stdout.contains("rename from a.txt")
                && output.stdout.contains("rename to b.txt"),
            "expected a rename diff, got: {}",
            output.stdout
        );
        assert!(
            !output.stdout.contains("new file mode"),
            "must not be reported as a brand-new file: {}",
            output.stdout
        );
        assert!(
            output.stdout.contains("-line2") && output.stdout.contains("+line2-changed"),
            "expected only the single changed line, got: {}",
            output.stdout
        );
        assert!(
            !output.stdout.contains("+line1\n"),
            "unchanged lines must not appear as additions: {}",
            output.stdout
        );
    }

    #[test]
    fn remote_head_is_readable_locally_once_set_and_a_clean_failure_before_then() {
        let bare = temp_dir();
        fs::create_dir_all(&bare).unwrap();
        assert!(Command::new("git")
            .current_dir(&bare)
            .args(["init", "-q", "--bare"])
            .status()
            .unwrap()
            .success());
        let (dir, git) = fixture();
        let repo = open(&dir);
        let remote_url = clean_path_str(&bare);
        assert!(git(&["remote", "add", "origin", &remote_url]));
        assert!(git(&["push", "-q", "origin", "HEAD:main"]));

        // Before `remote set-head` ever runs, refs/remotes/origin/HEAD does not exist --
        // this must be a clean, non-panicking failure, not a crash.
        let before = exec(
            &repo,
            &args(&["symbolic-ref", "refs/remotes/origin/HEAD"]),
            None,
        )
        .unwrap();
        assert_ne!(before.code, 0, "must fail cleanly before HEAD is ever set");

        assert!(git(&["remote", "set-head", "origin", "main"]));
        let after = exec(
            &repo,
            &args(&["symbolic-ref", "refs/remotes/origin/HEAD"]),
            None,
        )
        .unwrap();
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&bare);

        assert_eq!(after.code, 0);
        assert_eq!(after.stdout.trim(), "refs/remotes/origin/main");
    }

    #[test]
    fn deleting_a_branch_checked_out_in_another_worktree_is_refused_even_with_force() {
        let (dir, repo_a, _repo_b) = fixture_with_two_linked_worktrees();
        // From the main worktree, try to delete the branch checked out in the linked
        // "worktree-a" -- Git must refuse this unconditionally, even with -D.
        let safe = exec(&repo_a, &args(&["branch", "-d", "worktree-b"]), None);
        let force = exec(&repo_a, &args(&["branch", "-D", "worktree-b"]), None);
        let _ = fs::remove_dir_all(&dir);

        let safe = safe.unwrap();
        let force = force.unwrap();
        assert_ne!(safe.code, 0);
        assert!(safe.stderr.contains("used by worktree"), "{}", safe.stderr);
        assert_ne!(force.code, 0, "force delete must not bypass this refusal");
        assert!(
            force.stderr.contains("used by worktree"),
            "{}",
            force.stderr
        );
    }

    #[test]
    fn deleting_the_current_worktrees_own_branch_is_refused_the_same_way() {
        let (dir, git) = fixture();
        let repo = open(&dir);
        assert!(git(&["switch", "-qc", "onlybranch"]));

        let result = exec(&repo, &args(&["branch", "-d", "onlybranch"]), None).unwrap();
        let _ = fs::remove_dir_all(&dir);

        assert_ne!(result.code, 0);
        assert!(
            result.stderr.contains("used by worktree"),
            "deleting the current worktree's own checked-out branch must fail with the \
             same 'used by worktree' error family as deleting one checked out \
             elsewhere -- verified empirically, not a distinct restriction: {}",
            result.stderr
        );
    }

    #[test]
    fn deleting_an_unmerged_branch_requires_force_and_a_bare_delete_refuses_cleanly() {
        let (dir, git) = fixture();
        let repo = open(&dir);
        assert!(git(&["switch", "-qc", "other"]));
        fs::write(dir.join("a.txt"), "unmerged change\n").unwrap();
        assert!(git(&["add", "a.txt"]));
        assert!(git(&["commit", "-qm", "unmerged"]));
        assert!(git(&["switch", "-q", "-"]));

        let safe = exec(&repo, &args(&["branch", "-d", "other"]), None).unwrap();
        assert_ne!(safe.code, 0);
        assert!(safe.stderr.contains("not fully merged"), "{}", safe.stderr);

        let force = exec(&repo, &args(&["branch", "-D", "other"]), None).unwrap();
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(force.code, 0, "force delete must succeed: {}", force.stderr);
    }

    #[test]
    fn an_unrelated_branch_flag_is_rejected() {
        let (dir, _git) = fixture();
        let repo = open(&dir);
        let result = exec(&repo, &args(&["branch", "--move", "renamed"]), None);
        let _ = fs::remove_dir_all(&dir);
        let error = result.unwrap_err();
        assert!(error.contains("not permitted"), "unexpected error: {error}");
    }

    #[test]
    fn fetch_prune_is_reachable_and_removes_a_stale_remote_tracking_branch() {
        let bare = temp_dir();
        fs::create_dir_all(&bare).unwrap();
        assert!(Command::new("git")
            .current_dir(&bare)
            .args(["init", "-q", "--bare"])
            .status()
            .unwrap()
            .success());
        let (dir, git) = fixture();
        let repo = open(&dir);
        let remote_url = clean_path_str(&bare);
        assert!(git(&["remote", "add", "origin", &remote_url]));
        assert!(git(&["push", "-q", "origin", "HEAD:main"]));
        assert!(git(&["push", "-q", "origin", "HEAD:doomed"]));
        assert!(git(&["fetch", "-q", "origin"]));
        assert!(git(&[
            "show-ref",
            "--verify",
            "-q",
            "refs/remotes/origin/doomed"
        ]));

        // Delete the branch on the "remote" directly (bypassing Yavin, simulating an
        // external deletion), then confirm a plain fetch (no --prune) leaves the
        // stale remote-tracking ref behind, and fetch --prune removes it.
        assert!(Command::new("git")
            .current_dir(&bare)
            .args(["branch", "-D", "doomed"])
            .status()
            .unwrap()
            .success());
        let plain = exec(&repo, &args(&["fetch"]), None).unwrap();
        assert_eq!(plain.code, 0);
        assert!(git(&[
            "show-ref",
            "--verify",
            "-q",
            "refs/remotes/origin/doomed"
        ]));

        let pruned = exec(&repo, &args(&["fetch", "--prune"]), None).unwrap();
        let still_present = Command::new("git")
            .current_dir(&dir)
            .args(["show-ref", "--verify", "-q", "refs/remotes/origin/doomed"])
            .status()
            .unwrap()
            .success();
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&bare);

        assert_eq!(
            pruned.code, 0,
            "fetch --prune must succeed: {}",
            pruned.stderr
        );
        assert!(
            !still_present,
            "fetch --prune must remove the stale remote-tracking ref"
        );
    }

    #[test]
    fn an_unrelated_fetch_flag_is_rejected() {
        let (dir, _git) = fixture();
        let repo = open(&dir);
        let result = exec(&repo, &args(&["fetch", "--all"]), None);
        let _ = fs::remove_dir_all(&dir);
        let error = result.unwrap_err();
        assert!(error.contains("not permitted"), "unexpected error: {error}");
    }

    #[test]
    fn a_rebase_conflict_can_be_skipped_advancing_to_the_next_commit() {
        let (dir, git) = fixture();
        assert!(git(&["branch", "feature"]));
        assert!(git(&["switch", "-q", "feature"]));
        fs::write(dir.join("a.txt"), "feat1\n").unwrap();
        assert!(git(&["commit", "-qam", "feat1"]));
        assert!(git(&["switch", "-q", "-"]));
        fs::write(dir.join("a.txt"), "m1\n").unwrap();
        assert!(git(&["commit", "-qam", "m1"]));
        fs::write(dir.join("a.txt"), "m2\n").unwrap();
        assert!(git(&["commit", "-qam", "m2"]));

        // Two commits to rebase onto "feature", both conflicting.
        assert!(!git(&["rebase", "feature"]));
        let repo = open(&dir);
        let during_round1 = repo_state(&repo).unwrap();
        let gitdir = dir.join(".git");
        let msgnum_round1 = fs::read_to_string(gitdir.join("rebase-merge/msgnum")).unwrap();
        let end = fs::read_to_string(gitdir.join("rebase-merge/end")).unwrap();

        let skip = exec(&repo, &args(&["rebase", "--skip"]), None);
        let during_round2 = repo_state(&repo).unwrap();
        let msgnum_round2 = fs::read_to_string(gitdir.join("rebase-merge/msgnum")).unwrap();
        let abort = exec(&repo, &args(&["rebase", "--abort"]), None);
        let after = repo_state(&repo).unwrap();
        let _ = fs::remove_dir_all(&dir);

        assert_eq!(during_round1, "rebase");
        assert_eq!(msgnum_round1.trim(), "1");
        assert_eq!(end.trim(), "2");
        assert!(skip.is_ok(), "skip failed: {:?}", skip.err());
        assert_eq!(
            during_round2, "rebase",
            "the rebase must still be in progress on its second, still-conflicting commit"
        );
        assert_eq!(
            msgnum_round2.trim(),
            "2",
            "skip must advance the sequencer to the next commit"
        );
        assert!(abort.is_ok());
        assert_eq!(after, "");
    }

    #[test]
    fn a_cherry_pick_conflict_can_be_skipped_and_cherry_pick_head_persists_across_it() {
        let (dir, git) = fixture();
        fs::write(dir.join("a.txt"), "c1\n").unwrap();
        assert!(git(&["commit", "-qam", "c1"]));
        fs::write(dir.join("a.txt"), "c2\n").unwrap();
        assert!(git(&["commit", "-qam", "c2"]));
        assert!(git(&["switch", "-qc", "other", "HEAD~2"]));
        fs::write(dir.join("a.txt"), "other1\n").unwrap();
        assert!(git(&["commit", "-qam", "other1"]));

        assert!(!git(&["cherry-pick", "master~1", "master"]));
        let repo = open(&dir);
        let during_round1 = repo_state(&repo).unwrap();
        let gitdir = dir.join(".git");
        let head_round1 = fs::read_to_string(gitdir.join("CHERRY_PICK_HEAD")).unwrap();
        let todo_round1 = fs::read_to_string(gitdir.join("sequencer/todo")).unwrap();

        let skip = exec(&repo, &args(&["cherry-pick", "--skip"]), None);
        let during_round2 = repo_state(&repo).unwrap();
        let head_round2 = fs::read_to_string(gitdir.join("CHERRY_PICK_HEAD")).unwrap();
        let abort = exec(&repo, &args(&["cherry-pick", "--abort"]), None);
        let after = repo_state(&repo).unwrap();
        let _ = fs::remove_dir_all(&dir);

        assert_eq!(during_round1, "cherry-pick");
        assert!(todo_round1.contains("pick"));
        assert!(skip.is_ok(), "skip failed: {:?}", skip.err());
        assert_eq!(
            during_round2, "cherry-pick",
            "CHERRY_PICK_HEAD must still be present for the second commit"
        );
        assert_ne!(
            head_round1, head_round2,
            "the marker must now point at the next (second) commit"
        );
        assert!(abort.is_ok());
        assert_eq!(after, "");
    }

    #[test]
    fn a_merge_conflict_is_correctly_isolated_from_a_sibling_worktrees_own_state() {
        let (dir, repo_a, repo_b) = fixture_with_two_linked_worktrees();
        // Deliberately conflict A against its OWN prior commit on worktree-a's branch,
        // not against worktree-b's branch -- Git's worktree-exclusivity guarantee
        // (already established) means A can never merge B's own checked-out branch
        // directly, so this fixture merges a third, unrelated ref into A instead.
        let root_a = repo_a.root.clone();
        assert!(Command::new("git")
            .current_dir(&root_a)
            .args(["switch", "-qc", "conflict-source", "HEAD~0"])
            .status()
            .unwrap()
            .success());
        fs::write(root_a.join("a.txt"), "conflict\n").unwrap();
        assert!(Command::new("git")
            .current_dir(&root_a)
            .args(["commit", "-qam", "conflict"])
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .current_dir(&root_a)
            .args(["switch", "-q", "worktree-a"])
            .status()
            .unwrap()
            .success());
        fs::write(root_a.join("a.txt"), "other-side\n").unwrap();
        assert!(Command::new("git")
            .current_dir(&root_a)
            .args(["commit", "-qam", "other-side"])
            .status()
            .unwrap()
            .success());
        assert!(!Command::new("git")
            .current_dir(&root_a)
            .args(["merge", "conflict-source"])
            .status()
            .unwrap()
            .success());

        let state_a = repo_state(&repo_a).unwrap();
        let state_b = repo_state(&repo_b).unwrap();
        let _ = Command::new("git")
            .current_dir(&root_a)
            .args(["merge", "--abort"])
            .status();
        let _ = fs::remove_dir_all(&dir);

        assert_eq!(state_a, "merge");
        assert_eq!(
            state_b, "",
            "a merge conflict in worktree A must never appear as a merge in worktree B"
        );
    }

    #[test]
    fn attempting_continue_before_resolving_a_conflict_is_refused_cleanly() {
        let (dir, git) = fixture();
        let repo = open(&dir);
        assert!(git(&["branch", "other"]));
        assert!(git(&["switch", "-q", "other"]));
        fs::write(dir.join("a.txt"), "theirs\n").unwrap();
        assert!(git(&["commit", "-qam", "theirs"]));
        assert!(git(&["switch", "-q", "-"]));
        fs::write(dir.join("a.txt"), "ours\n").unwrap();
        assert!(git(&["commit", "-qam", "ours"]));
        assert!(!git(&["merge", "other"]));

        let result = exec(&repo, &args(&["merge", "--continue"]), None).unwrap();
        let abort = exec(&repo, &args(&["merge", "--abort"]), None);
        let _ = fs::remove_dir_all(&dir);

        assert_ne!(result.code, 0);
        assert!(
            result.stderr.contains("unmerged files") || result.stderr.contains("needs merge"),
            "unexpected refusal text: {}",
            result.stderr
        );
        assert!(abort.is_ok());
    }

    #[test]
    fn starting_an_unrelated_operation_while_one_is_unresolved_is_refused_by_git_itself() {
        let (dir, git) = fixture();
        let repo = open(&dir);
        fs::write(dir.join("a.txt"), "c1\n").unwrap();
        assert!(git(&["commit", "-qam", "c1"]));
        fs::write(dir.join("a.txt"), "c2\n").unwrap();
        assert!(git(&["commit", "-qam", "c2"]));
        assert!(git(&["switch", "-qc", "other", "HEAD~2"]));
        fs::write(dir.join("a.txt"), "other1\n").unwrap();
        assert!(git(&["commit", "-qam", "other1"]));

        assert!(!git(&["cherry-pick", "master~1"]));
        // A genuinely unrelated operation (merge, not another cherry-pick) over an
        // unresolved one -- no client-side pre-check exists or is needed, Git's own
        // refusal is authoritative. (A *second* cherry-pick attempt produces a
        // different, third message family -- "Cherry-picking is not possible
        // because you have unmerged files" -- already covered by Gap 2's own
        // "unmerged files" pattern, discovered while writing this test; this test
        // exercises the genuinely distinct "already in progress" family instead.)
        let result = exec(&repo, &args(&["merge", "master"]), None).unwrap();
        let abort = exec(&repo, &args(&["cherry-pick", "--abort"]), None);
        let _ = fs::remove_dir_all(&dir);

        assert_ne!(result.code, 0);
        assert!(
            result.stderr.contains("already in progress")
                || result.stderr.contains("resolve your current index")
                || result.stderr.contains("unmerged files"),
            "unexpected refusal text: {}",
            result.stderr
        );
        assert!(abort.is_ok());
    }
}
