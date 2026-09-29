//! LG-02 at realistic scale (run on purpose, in release):
//! `cargo test -p ide-localgit --release --test snapshot_scale -- --ignored --nocapture --test-threads=1`
//!
//! A workspace of N small files in nested directories: the first persisted snapshot, a Full
//! walk that changes nothing (warm cache), an incremental snapshot with 10 changed files, and
//! status -- each timed, with the store's size and the process's peak memory (the whole test
//! process's: run one test at a time to attribute it). The numbers printed are what the report
//! records; the plan's budgets are 10k first persist < 3 s, 100k < 30 s, a no-change Full walk
//! over 100k < 2.5 s, incremental with 10 dirty of 100k < 150 ms, warm status < 3 s, peak
//! memory < 250 MB.

mod common;

use common::*;
use ide_localgit::*;
use ide_workspace::file_tree::clean_path_str;
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[cfg(windows)]
fn peak_memory_mb() -> f64 {
    use windows_sys::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    let mut counters: PROCESS_MEMORY_COUNTERS = unsafe { std::mem::zeroed() };
    counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
    // SAFETY: a valid, sized PROCESS_MEMORY_COUNTERS for the current process's pseudo-handle.
    unsafe { GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, counters.cb) };
    counters.PeakWorkingSetSize as f64 / 1_048_576.0
}

#[cfg(not(windows))]
fn peak_memory_mb() -> f64 {
    f64::NAN
}

fn ms(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

fn measure(files: usize) {
    let f = Fixture::new(&format!("snapscale-{files}"));
    let p = &f.project;
    let started = Instant::now();
    // 10,000 directories three levels deep (pkgN/modN/subN), the files spread across them.
    for i in 0..files {
        let dir = p.join(format!(
            "pkg{}/mod{}/sub{}",
            i % 10,
            (i / 10) % 10,
            (i / 100) % 100
        ));
        if i < 10_000 || i % 100 == 0 {
            std::fs::create_dir_all(&dir).unwrap();
        }
        std::fs::write(
            dir.join(format!("file{i}.ts")),
            format!("export const value{i} = {i};\n// {}\n", "x".repeat(i % 400)),
        )
        .unwrap();
    }
    let created = started.elapsed();
    // Past the racy window, so the cache may trust what the first scan records.
    std::thread::sleep(Duration::from_millis(3500));

    let repo = Mutex::new(f.open().unwrap());
    let engine = engine_for(&repo, p);
    engine.watcher_status(1, true);

    let started = Instant::now();
    let first = persist(&engine, &repo);
    let initial = started.elapsed();
    assert_eq!(first.stats.files as usize, files);
    commit_root(&repo, first.disk_root.0);
    let (objects, stored) = {
        let repo = repo.lock().unwrap();
        (repo.object_count(), repo.storage_bytes())
    };

    let started = Instant::now();
    let walk = snapshot_mode(&engine, &repo, RequestedMode::Full);
    let full_walk = started.elapsed();
    assert_eq!(walk.disk_root, first.disk_root);
    assert_eq!(walk.stats.cache_hits as usize, files);

    // Ten files change, and the watcher says so.
    let mut changes = Vec::new();
    for i in (0..files).step_by(files / 10).take(10) {
        let dir = p.join(format!(
            "pkg{}/mod{}/sub{}",
            i % 10,
            (i / 10) % 10,
            (i / 100) % 100
        ));
        let path = dir.join(format!("file{i}.ts"));
        std::fs::write(&path, format!("changed {i}\n")).unwrap();
        changes.push(WatchedChange {
            path: clean_path_str(&path),
            from: None,
        });
    }
    engine.watcher_changes(1, &clean_path_str(p), &changes, &[]);
    let started = Instant::now();
    let incremental = snapshot(&engine, &repo);
    let incremental_time = started.elapsed();
    assert_eq!(incremental.mode, ScanMode::Incremental);

    // Status: warm, incremental (nothing new reported) and a Full one.
    let started = Instant::now();
    let warm = status(&engine, &repo);
    let status_incremental = started.elapsed();
    assert_eq!(warm.disk.modified, 10);
    let cancel = std::sync::atomic::AtomicBool::new(false);
    let started = Instant::now();
    let (_, full_status) = engine
        .status(
            &repo,
            &SnapshotRequest {
                mode: RequestedMode::Full,
                ..Default::default()
            },
            &Control {
                cancel: &cancel,
                progress: &|_| {},
            },
            usize::MAX,
        )
        .unwrap();
    let status_full = started.elapsed();
    assert_eq!(full_status.disk.modified, 10);

    println!(
        "{files} files (created in {:.1} s): first persisted snapshot {:.0} ms ({:.0} files/s), \
         {objects} objects, {:.1} MB stored; no-change Full walk {:.0} ms; incremental \
         (10 changed) {:.1} ms; status incremental {:.1} ms, status Full {:.0} ms; peak memory \
         {:.0} MB",
        created.as_secs_f64(),
        ms(initial),
        files as f64 / initial.as_secs_f64(),
        stored as f64 / 1e6,
        ms(full_walk),
        ms(incremental_time),
        ms(status_incremental),
        ms(status_full),
        peak_memory_mb(),
    );
}

#[test]
#[ignore]
fn snapshot_scale_10k_files() {
    measure(10_000);
}

#[test]
#[ignore]
fn snapshot_scale_100k_files() {
    measure(100_000);
}
