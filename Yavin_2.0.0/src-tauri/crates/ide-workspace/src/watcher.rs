use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::path::Path;
use std::sync::mpsc::channel;
use std::time::Duration;

/// Starts a cross-platform file watcher on `dir_path` that calls `callback` when changes are detected.
pub fn start_watcher<F>(dir_path: &str, on_change: F) -> Result<RecommendedWatcher, String>
where
    F: Fn() + Send + 'static,
{
    let path = Path::new(dir_path);
    if !path.exists() {
        return Err(format!("Cannot watch non-existent path: {}", dir_path));
    }

    let (tx, rx) = channel();
    let mut watcher = notify::recommended_watcher(tx).map_err(|e| e.to_string())?;

    watcher
        .watch(path, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    std::thread::spawn(move || {
        let mut last_event = std::time::Instant::now();
        while let Ok(res) = rx.recv() {
            if let Ok(event) = res {
                // Debounce events: ignore noise if triggered within 250ms
                if last_event.elapsed() > Duration::from_millis(250) {
                    last_event = std::time::Instant::now();
                    // Don't trigger on internal git/node_modules churn
                    let is_noise = event.paths.iter().any(|p| {
                        let s = p.to_string_lossy();
                        s.contains(".git") || s.contains("node_modules") || s.contains("target")
                    });
                    if !is_noise {
                        on_change();
                    }
                }
            }
        }
    });

    Ok(watcher)
}
