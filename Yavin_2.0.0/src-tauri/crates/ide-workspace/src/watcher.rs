use notify::{RecursiveMode, Watcher};
use std::path::{Component, Path};
use std::sync::mpsc::{channel, RecvTimeoutError};
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
        let relevant = |result: &notify::Result<notify::Event>| {
            result
                .as_ref()
                .is_ok_and(|event| event.paths.iter().any(|path| !is_noise(path)))
        };

        // Block for the first event, then drain the rest of the burst before reporting.
        while let Ok(first) = receiver.recv() {
            let mut changed = relevant(&first);
            loop {
                match receiver.recv_timeout(SETTLE) {
                    Ok(next) => changed |= relevant(&next),
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
            if changed {
                on_change();
            }
        }
    });

    Ok(watcher)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};

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
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("yavin-watch-{nanos}"));
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
}
