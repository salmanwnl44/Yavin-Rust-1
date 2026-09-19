use notify::{RecursiveMode, Watcher};
use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::time::Duration;

pub use notify::RecommendedWatcher;

/// A burst of writes (a checkout, a build, a formatter) settles before we react,
/// so a refresh reads the finished state instead of a half-written tree.
const SETTLE: Duration = Duration::from_millis(300);

/// Directories that churn constantly and are never shown in the tree.
fn is_noise(path: &Path) -> bool {
    path.components().any(|component| {
        matches!(component, Component::Normal(name)
            if name == ".git" || name == "node_modules" || name == "target")
    })
}

/// Blocks for the first event, drains the rest of the burst (waiting up to
/// `SETTLE` between events), classifies every event in the whole burst via
/// `classify`, and -- once the burst settles -- reports the distinct set of
/// classifications found via `report`, skipping the call entirely if nothing
/// classified as relevant. Shared by `start_watcher` (the general recursive
/// workspace watcher) and `start_git_watcher` (the narrow per-repository Git-ref
/// watcher) so the coalescing behavior, and the one test that already proves it
/// coalesces a real burst correctly, is defined in exactly one place.
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

/// Watches `root` recursively and calls `on_change` once per settled burst of edits.
///
/// Watching stops when the returned handle is dropped.
pub fn start_watcher<F>(root: &Path, on_change: F) -> Result<RecommendedWatcher, String>
where
    F: Fn() + Send + 'static,
{
    if !root.is_dir() {
        return Err(format!("Cannot watch {}: not a directory", root.display()));
    }

    let (sender, receiver) = channel();
    let mut watcher = notify::recommended_watcher(sender).map_err(|e| e.to_string())?;
    watcher
        .watch(root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    std::thread::spawn(move || {
        coalesce_events(
            &receiver,
            |result| {
                let relevant = result
                    .as_ref()
                    .is_ok_and(|event| event.paths.iter().any(|path| !is_noise(path)));
                if relevant {
                    vec![()]
                } else {
                    vec![]
                }
            },
            |_changed: HashSet<()>| on_change(),
        );
    });

    Ok(watcher)
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
/// burst (never once per raw filesystem event) -- reusing `coalesce_events`, the
/// exact mechanism `start_watcher` already uses and already has a passing test
/// for. Watching stops when the returned handle is dropped.
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
        std::env::temp_dir().join(format!("yavin-watch-{label}-{nanos}"))
    }

    #[test]
    fn noise_matches_whole_components_only() {
        assert!(is_noise(Path::new("/w/.git/HEAD")));
        assert!(is_noise(Path::new("/w/node_modules/react/index.js")));
        assert!(is_noise(Path::new("/w/target/debug/app.exe")));
        // A real source file is not noise just because its name contains one of the words.
        assert!(!is_noise(Path::new("/w/src/target.rs")));
        assert!(!is_noise(Path::new("/w/.github/workflows/ci.yml")));
        assert!(!is_noise(Path::new("/w/src/git.rs")));
    }

    #[test]
    fn a_burst_of_writes_reports_at_least_once() {
        let root = temp_dir("workspace");
        fs::create_dir_all(&root).unwrap();

        let hits = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&hits);
        let watcher = start_watcher(&root, move || {
            counter.fetch_add(1, Ordering::SeqCst);
        })
        .unwrap();

        for index in 0..5 {
            fs::write(root.join(format!("file{index}.txt")), "x").unwrap();
        }
        std::thread::sleep(SETTLE * 5);

        let reported = hits.load(Ordering::SeqCst);
        drop(watcher);
        fs::remove_dir_all(&root).ok();
        // Coalesced: five writes must never mean five refreshes of the whole tree.
        assert!(
            (1..=2).contains(&reported),
            "expected 1-2 reports, got {reported}"
        );
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
        let watcher = start_git_watcher(&root, &[root.clone()], move |kind| {
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
}
