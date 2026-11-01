use notify::{RecursiveMode, Watcher};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::time::Duration;

pub use notify::RecommendedWatcher;

/// A burst of writes (a checkout, a build, a formatter) settles before we react,
/// so a refresh reads the finished state instead of a half-written tree.
const SETTLE: Duration = Duration::from_millis(300);

/// Blocks for the first event, drains the rest of the burst (waiting up to
/// `SETTLE` between events), classifies every event in the whole burst via
/// `classify`, and -- once the burst settles -- reports the distinct set of
/// classifications found via `report`, skipping the call entirely if nothing
/// classified as relevant. Used by `start_git_watcher`, the narrow per-repository
/// Git-ref watcher. The workspace watcher is `resource_events::start_resource_watcher`,
/// which keeps each change rather than only its category.
fn coalesce_events<T, C, R>(
    receiver: &Receiver<notify::Result<notify::Event>>,
    classify: C,
    report: R,
) where
    T: Eq + std::hash::Hash,
    C: Fn(&notify::Result<notify::Event>) -> Vec<T>,
    R: Fn(HashSet<T>),
{
    while let Ok(first) = receiver.recv() {
        let mut changed: HashSet<T> = classify(&first).into_iter().collect();
        loop {
            match receiver.recv_timeout(SETTLE) {
                Ok(next) => changed.extend(classify(&next)),
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
        if !changed.is_empty() {
            report(changed);
        }
    }
}

/// Which category of Git-relevant path changed, matching the Git State &
/// Synchronization plan's Section H watcher-path classification. `Head`/
/// `OperationState` are per-worktree (carry that worktree's own gitdir --
/// `<worktree>/.git` for the main worktree, `<common-dir>/worktrees/<name>/` for a
/// linked one); `Refs`/`Remotes`/`Stash` are repository-shared and carry no
/// worktree of their own.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum GitChangeKind {
    /// A worktree's own `HEAD` file changed (a switch, checkout, or a commit/
    /// merge/rebase/cherry-pick/revert moving it).
    Head(PathBuf),
    /// A worktree's own `MERGE_HEAD`/`CHERRY_PICK_HEAD`/`REVERT_HEAD`/
    /// `rebase-merge`/`rebase-apply` appeared or disappeared.
    OperationState(PathBuf),
    /// `refs/heads/**` or `packed-refs` -- a local branch was created, deleted, or
    /// (via `packed-refs`) had its loose ref packed.
    Refs,
    /// `refs/remotes/**` -- a fetch (from anywhere) updated a remote-tracking ref.
    Remotes,
    /// `refs/stash` or its reflog -- a stash was pushed, applied, popped, or dropped.
    Stash,
}

fn is_operation_state_path(path: &Path, gitdir: &Path) -> bool {
    ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]
        .iter()
        .any(|name| path == gitdir.join(name))
        || path.starts_with(gitdir.join("rebase-merge"))
        || path.starts_with(gitdir.join("rebase-apply"))
}

fn classify_git_path(
    path: &Path,
    common_dir: &Path,
    worktree_gitdirs: &[PathBuf],
) -> Option<GitChangeKind> {
    for gitdir in worktree_gitdirs {
        if path == gitdir.join("HEAD") {
            return Some(GitChangeKind::Head(gitdir.clone()));
        }
        if is_operation_state_path(path, gitdir) {
            return Some(GitChangeKind::OperationState(gitdir.clone()));
        }
    }
    if path == common_dir.join("packed-refs") || path.starts_with(common_dir.join("refs/heads")) {
        return Some(GitChangeKind::Refs);
    }
    if path.starts_with(common_dir.join("refs/remotes")) {
        return Some(GitChangeKind::Remotes);
    }
    if path == common_dir.join("refs/stash") || path == common_dir.join("logs/refs/stash") {
        return Some(GitChangeKind::Stash);
    }
    None
}

/// Watches only the small, fixed set of Git ref-relevant paths for one repository
/// -- never `<common_dir>/objects/**`, never a whole-`.git` recursive watch (see
/// the Git State & Synchronization plan's Section G for why: the object database
/// churns on every single Git operation, including Yavin's own, for zero
/// additional detection benefit, and would be the single most expensive thing to
/// watch in a repository with any real history). Missing directories (e.g. no
/// remotes yet, so `refs/remotes` doesn't exist) are silently skipped rather than
/// failing the whole watcher -- they simply aren't watched until they exist, with
/// the caller's own periodic/focus-triggered poll as the permanent fallback for
/// whatever a missing directory means this watcher can't see yet.
///
/// `on_change` is called once per distinct `GitChangeKind` found in a settled
/// burst (never once per raw filesystem event), via `coalesce_events`. Watching
/// stops when the returned handle is dropped.
pub fn start_git_watcher<F>(
    common_dir: &Path,
    worktree_gitdirs: &[PathBuf],
    on_change: F,
) -> Result<RecommendedWatcher, String>
where
    F: Fn(GitChangeKind) + Send + 'static,
{
    let (sender, receiver) = channel();
    let mut watcher = notify::recommended_watcher(sender).map_err(|e| e.to_string())?;

    for (path, mode) in [
        (common_dir.to_path_buf(), RecursiveMode::NonRecursive),
        (common_dir.join("refs"), RecursiveMode::NonRecursive),
        (common_dir.join("refs/heads"), RecursiveMode::Recursive),
        (common_dir.join("refs/remotes"), RecursiveMode::Recursive),
        (common_dir.join("logs/refs"), RecursiveMode::NonRecursive),
    ] {
        if path.is_dir() {
            let _ = watcher.watch(&path, mode);
        }
    }
    for gitdir in worktree_gitdirs {
        if gitdir.is_dir() {
            let _ = watcher.watch(gitdir, RecursiveMode::NonRecursive);
        }
    }

    let common_dir = common_dir.to_path_buf();
    let worktree_gitdirs = worktree_gitdirs.to_vec();
    std::thread::spawn(move || {
        coalesce_events(
            &receiver,
            |result| match result {
                Ok(event) => event
                    .paths
                    .iter()
                    .filter_map(|path| classify_git_path(path, &common_dir, &worktree_gitdirs))
                    .collect(),
                Err(_) => vec![],
            },
            |changed: HashSet<GitChangeKind>| {
                for kind in changed {
                    on_change(kind);
                }
            },
        );
    });

    Ok(watcher)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        // Canonical, as every folder the app watches is (the workspace root, a repository's
        // root and common dir). The temp directory can be spelled with an 8.3 short name
        // (`C:\Users\RUNNER~1\...` on the CI runner), and a watch through that spelling reports
        // some changes twice -- a spelling the app never watches, so not what is under test.
        let base = std::env::temp_dir();
        base.canonicalize()
            .unwrap_or(base)
            .join(format!("yavin-watch-{label}-{nanos}"))
    }

    #[test]
    fn classify_git_path_recognizes_every_watched_pattern() {
        let common = Path::new("/repo/.git");
        let main = Path::new("/repo/.git");
        let linked = Path::new("/repo/.git/worktrees/feature");
        let worktrees = [main.to_path_buf(), linked.to_path_buf()];

        assert_eq!(
            classify_git_path(&main.join("HEAD"), common, &worktrees),
            Some(GitChangeKind::Head(main.to_path_buf()))
        );
        assert_eq!(
            classify_git_path(&linked.join("HEAD"), common, &worktrees),
            Some(GitChangeKind::Head(linked.to_path_buf()))
        );
        assert_eq!(
            classify_git_path(&linked.join("MERGE_HEAD"), common, &worktrees),
            Some(GitChangeKind::OperationState(linked.to_path_buf()))
        );
        assert_eq!(
            classify_git_path(&main.join("rebase-merge/msgnum"), common, &worktrees),
            Some(GitChangeKind::OperationState(main.to_path_buf()))
        );
        assert_eq!(
            classify_git_path(&common.join("refs/heads/feature"), common, &worktrees),
            Some(GitChangeKind::Refs)
        );
        assert_eq!(
            classify_git_path(&common.join("packed-refs"), common, &worktrees),
            Some(GitChangeKind::Refs)
        );
        assert_eq!(
            classify_git_path(&common.join("refs/remotes/origin/main"), common, &worktrees),
            Some(GitChangeKind::Remotes)
        );
        assert_eq!(
            classify_git_path(&common.join("refs/stash"), common, &worktrees),
            Some(GitChangeKind::Stash)
        );
        assert_eq!(
            classify_git_path(&common.join("logs/refs/stash"), common, &worktrees),
            Some(GitChangeKind::Stash)
        );
        // An unrelated path -- and, critically, anything under objects/ -- is not
        // classified at all, since it's never watched in the first place.
        assert_eq!(
            classify_git_path(&common.join("objects/ab/cdef"), common, &worktrees),
            None
        );
        assert_eq!(
            classify_git_path(&common.join("config"), common, &worktrees),
            None
        );
    }

    /// A real linked-worktree fixture (matching Module 1/2's own convention of
    /// testing against real repositories, not synthetic paths) -- writes to the
    /// actual watched files directly (bypassing `git` itself, to isolate the
    /// watcher from any other side effect it might also produce) and asserts each
    /// produces the correctly-classified event.
    #[test]
    fn a_real_repository_reports_correctly_classified_ref_changes() {
        let root = temp_dir("git");
        fs::create_dir_all(root.join("refs/heads")).unwrap();
        fs::create_dir_all(root.join("refs/remotes/origin")).unwrap();
        fs::create_dir_all(root.join("logs/refs")).unwrap();
        fs::write(root.join("HEAD"), "ref: refs/heads/main\n").unwrap();

        let events: Arc<Mutex<Vec<GitChangeKind>>> = Arc::new(Mutex::new(Vec::new()));
        let collected = Arc::clone(&events);
        let watcher = start_git_watcher(&root, std::slice::from_ref(&root), move |kind| {
            collected.lock().unwrap().push(kind);
        })
        .unwrap();

        fs::write(root.join("refs/heads/feature"), "abc123\n").unwrap();
        std::thread::sleep(SETTLE * 3);
        fs::write(root.join("refs/remotes/origin/main"), "def456\n").unwrap();
        std::thread::sleep(SETTLE * 3);
        fs::write(root.join("refs/stash"), "ghi789\n").unwrap();
        std::thread::sleep(SETTLE * 3);
        fs::write(root.join("HEAD"), "ref: refs/heads/feature\n").unwrap();
        std::thread::sleep(SETTLE * 3);

        drop(watcher);
        let seen = events.lock().unwrap().clone();
        fs::remove_dir_all(&root).ok();

        assert!(seen.contains(&GitChangeKind::Refs), "{seen:?}");
        assert!(seen.contains(&GitChangeKind::Remotes), "{seen:?}");
        assert!(seen.contains(&GitChangeKind::Stash), "{seen:?}");
        assert!(
            seen.contains(&GitChangeKind::Head(root.clone())),
            "{seen:?}"
        );
    }

    /// Performance verification (the Git State & Synchronization plan's Section
    /// W): `objects/` is never watched at all, not merely unclassified-if-seen --
    /// a real repository with any history has thousands of object files, and this
    /// is the one path category that would scale with repository size if watched.
    #[test]
    fn objects_directory_changes_produce_no_events_at_all() {
        let root = temp_dir("git-objects");
        fs::create_dir_all(root.join("refs/heads")).unwrap();
        fs::create_dir_all(root.join("objects/ab")).unwrap();
        fs::write(root.join("HEAD"), "ref: refs/heads/main\n").unwrap();

        let hits = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&hits);
        let watcher = start_git_watcher(&root, std::slice::from_ref(&root), move |_kind| {
            counter.fetch_add(1, Ordering::SeqCst);
        })
        .unwrap();

        for i in 0..10 {
            fs::write(root.join(format!("objects/ab/{i:040x}")), "object data").unwrap();
        }
        std::thread::sleep(SETTLE * 4);

        let reported = hits.load(Ordering::SeqCst);
        drop(watcher);
        fs::remove_dir_all(&root).ok();
        assert_eq!(
            reported, 0,
            "writes under objects/ must never be watched, let alone reported"
        );
    }

    /// A rapid burst of ref changes (e.g. several quick commits, or an external
    /// tool rewriting refs in a loop) must coalesce into a bounded number of
    /// events, never one per individual write -- the same guarantee
    /// `a_burst_of_writes_reports_at_least_once` already proves for the general
    /// workspace watcher, verified here for the narrower Git-ref watcher too.
    #[test]
    fn a_rapid_burst_of_ref_changes_coalesces_instead_of_reporting_once_per_write() {
        let root = temp_dir("git-burst");
        fs::create_dir_all(root.join("refs/heads")).unwrap();
        fs::write(root.join("HEAD"), "ref: refs/heads/main\n").unwrap();

        let hits = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&hits);
        let watcher = start_git_watcher(&root, std::slice::from_ref(&root), move |kind| {
            if kind == GitChangeKind::Refs {
                counter.fetch_add(1, Ordering::SeqCst);
            }
        })
        .unwrap();

        for i in 0..10 {
            fs::write(root.join(format!("refs/heads/branch-{i}")), "abc123\n").unwrap();
        }
        std::thread::sleep(SETTLE * 5);

        let reported = hits.load(Ordering::SeqCst);
        drop(watcher);
        fs::remove_dir_all(&root).ok();
        assert!(
            (1..=3).contains(&reported),
            "expected a small, bounded number of coalesced 'refs' reports for 10 rapid \
             writes, got {reported}"
        );
    }

    /// Race H (the Filesystem Watcher & Invalidation Architecture plan's
    /// Section R): a watcher restarted while a prior burst is still in flight
    /// must never leak that burst into the new watcher's own count -- the two
    /// don't share a channel or thread, so this verifies that structural
    /// independence empirically rather than only reasoning about it.
    #[test]
    fn a_watcher_restart_never_leaks_a_prior_bursts_pending_events() {
        let root = temp_dir("git-restart");
        fs::create_dir_all(root.join("refs/heads")).unwrap();
        fs::write(root.join("HEAD"), "ref: refs/heads/main\n").unwrap();

        let first_hits = Arc::new(AtomicUsize::new(0));
        let first_counter = Arc::clone(&first_hits);
        let first_watcher = start_git_watcher(&root, std::slice::from_ref(&root), move |_kind| {
            first_counter.fetch_add(1, Ordering::SeqCst);
        })
        .unwrap();

        // Trigger a burst, then drop the watcher well before its own SETTLE
        // window would close -- an in-flight, not-yet-reported burst.
        fs::write(root.join("refs/heads/from-first"), "abc\n").unwrap();
        std::thread::sleep(Duration::from_millis(50));
        drop(first_watcher);

        // A fresh watcher on the exact same paths -- its own channel/thread
        // pair, sharing nothing with the dropped one.
        let second_hits = Arc::new(AtomicUsize::new(0));
        let second_counter = Arc::clone(&second_hits);
        let second_watcher = start_git_watcher(&root, std::slice::from_ref(&root), move |kind| {
            if kind == GitChangeKind::Refs {
                second_counter.fetch_add(1, Ordering::SeqCst);
            }
        })
        .unwrap();

        fs::write(root.join("refs/heads/from-second"), "def\n").unwrap();
        std::thread::sleep(SETTLE * 4);

        let second_reported = second_hits.load(Ordering::SeqCst);
        drop(second_watcher);
        fs::remove_dir_all(&root).ok();

        assert_eq!(
            second_reported, 1,
            "the fresh watcher must report exactly the one change made after its \
             own creation, never anything leaked from the previous, dropped watcher"
        );
    }
}
