//! LG-02: incremental snapshots are an optimisation, never a different answer.

mod common;

use common::*;
use ide_localgit::*;
use ide_workspace::file_tree::clean_path_str;
use std::path::Path;
use std::sync::Mutex;

const GEN: u64 = 7;

struct World {
    f: Fixture,
    repo: Mutex<Repository>,
    engine: SnapshotEngine,
}

impl World {
    fn new(label: &str) -> World {
        let f = Fixture::new(label);
        let repo = Mutex::new(f.open().unwrap());
        let engine = engine_for(&repo, &f.project);
        engine.watcher_status(GEN, true);
        World { f, repo, engine }
    }

    fn root(&self) -> String {
        clean_path_str(&self.f.project)
    }

    fn event(&self, path: &Path) {
        self.events(&[WatchedChange {
            path: clean_path_str(path),
            from: None,
        }]);
    }

    fn events(&self, changes: &[WatchedChange]) {
        self.engine.watcher_changes(GEN, &self.root(), changes, &[]);
    }

    fn snap(&self) -> Snapshot {
        snapshot(&self.engine, &self.repo)
    }

    /// What a Full scan by an engine with no history and no cache says.
    fn truth(&self) -> ObjectIdTextLike {
        let fresh = engine_for(&self.repo, &self.f.project);
        snapshot_mode(&fresh, &self.repo, RequestedMode::Verify).disk_root
    }
}

type ObjectIdTextLike = ObjectIdText;

#[test]
fn one_changed_file_is_all_an_incremental_scan_reads() {
    let w = World::new("inc-one");
    let p = &w.f.project;
    for d in 0..10 {
        for i in 0..10 {
            write(&p.join(format!("dir{d}/f{i}.txt")), format!("{d}-{i}"));
        }
    }
    let first = w.snap();
    assert_eq!(first.mode, ScanMode::Full);
    assert_eq!(first.full_reason, Some(FullReason::FirstScan));

    write(&p.join("dir3/f4.txt"), "changed");
    w.event(&p.join("dir3/f4.txt"));
    let second = w.snap();
    assert_eq!(second.mode, ScanMode::Incremental);
    assert_eq!(second.watcher_generation, Some(GEN));
    assert_eq!(second.disk_root, w.truth());
    assert_ne!(second.disk_root, first.disk_root);
    // Only the root and dir3 were visited: the nine other directories were never opened.
    assert_eq!(second.stats.directories, 2, "{:?}", second.stats);
    assert_eq!(second.stats.files, 10, "{:?}", second.stats);

    // Nothing reported: nothing read at all.
    let third = w.snap();
    assert_eq!(third.mode, ScanMode::Incremental);
    assert_eq!(third.stats.files, 0);
    assert_eq!(third.disk_root, second.disk_root);
}

#[test]
fn duplicate_rename_and_directory_events_give_the_full_answer() {
    let w = World::new("inc-events");
    let p = &w.f.project;
    write(&p.join("a/one.txt"), "1");
    write(&p.join("b/two.txt"), "2");
    w.snap();

    // Duplicated events change nothing.
    write(&p.join("a/one.txt"), "1 again");
    w.event(&p.join("a/one.txt"));
    w.event(&p.join("a/one.txt"));
    let snap = w.snap();
    assert_eq!(snap.mode, ScanMode::Incremental);
    assert_eq!(snap.disk_root, w.truth());

    // A rename between directories.
    std::fs::rename(p.join("a/one.txt"), p.join("b/moved.txt")).unwrap();
    w.events(&[WatchedChange {
        path: clean_path_str(p.join("b/moved.txt")),
        from: Some(clean_path_str(p.join("a/one.txt"))),
    }]);
    let snap = w.snap();
    assert_eq!(snap.mode, ScanMode::Incremental);
    assert_eq!(snap.disk_root, w.truth());

    // A directory renamed, with everything in it: reported once, for the directory.
    std::fs::rename(p.join("b"), p.join("c")).unwrap();
    w.events(&[WatchedChange {
        path: clean_path_str(p.join("c")),
        from: Some(clean_path_str(p.join("b"))),
    }]);
    let snap = w.snap();
    assert_eq!(snap.disk_root, w.truth());

    // A new directory with files, reported only as the directory.
    write(&p.join("new/deep/x.txt"), "x");
    std::fs::create_dir_all(p.join("new/empty")).unwrap();
    w.event(&p.join("new"));
    let snap = w.snap();
    assert_eq!(snap.disk_root, w.truth());

    // A deleted directory.
    std::fs::remove_dir_all(p.join("c")).unwrap();
    w.event(&p.join("c"));
    let snap = w.snap();
    assert_eq!(snap.mode, ScanMode::Incremental);
    assert_eq!(snap.disk_root, w.truth());
}

#[test]
fn an_overflow_is_a_rescan_of_the_scope_and_a_failed_watcher_means_full() {
    let w = World::new("inc-overflow");
    let p = &w.f.project;
    write(&p.join("a/one.txt"), "1");
    write(&p.join("b/two.txt"), "2");
    w.snap();

    // Changes the watcher could not follow in `a`: it names the scope to read again.
    write(&p.join("a/one.txt"), "changed silently");
    write(&p.join("a/sub/new.txt"), "new silently");
    w.engine
        .watcher_changes(GEN, &w.root(), &[], &[clean_path_str(p.join("a"))]);
    let snap = w.snap();
    assert_eq!(snap.mode, ScanMode::Incremental);
    assert_eq!(snap.disk_root, w.truth());

    // An overflow at the root: everything.
    write(&p.join("b/two.txt"), "changed silently too");
    w.engine.watcher_changes(GEN, &w.root(), &[], &[w.root()]);
    let snap = w.snap();
    assert_eq!(snap.disk_root, w.truth());

    // The watcher fails: Full until it is healthy again.
    w.engine.watcher_status(GEN, false);
    write(&p.join("b/two.txt"), "changed while unwatched");
    let snap = w.snap();
    assert_eq!(snap.mode, ScanMode::Full);
    assert_eq!(snap.full_reason, Some(FullReason::WatcherUnavailable));
    assert_eq!(snap.disk_root, w.truth());
    assert_eq!(w.snap().mode, ScanMode::Full);
}

#[test]
fn another_watcher_generation_means_full() {
    let w = World::new("inc-generation");
    write(&w.f.project.join("a.txt"), "a");
    w.snap();
    assert_eq!(w.snap().mode, ScanMode::Incremental);
    // The workspace was entered again: a new watch, whose first events may be anything.
    w.engine.watcher_status(GEN + 1, true);
    write(&w.f.project.join("a.txt"), "changed in between");
    let snap = w.snap();
    assert_eq!(snap.mode, ScanMode::Full);
    assert_eq!(snap.full_reason, Some(FullReason::WatcherUnavailable));
    assert_eq!(snap.disk_root, w.truth());
    // Events of a generation that is not the current one are not trusted either.
    w.engine.watcher_changes(GEN, &w.root(), &[], &[]);
    assert_eq!(w.snap().mode, ScanMode::Full);
    assert_eq!(w.snap().mode, ScanMode::Incremental);
}

#[test]
fn a_changed_yavinignore_means_full() {
    let w = World::new("inc-ignore");
    let p = &w.f.project;
    write(&p.join("keep.log"), "log");
    w.snap();
    write(&p.join(".yavinignore"), "*.log\n");
    w.event(&p.join(".yavinignore"));
    let snap = w.snap();
    assert_eq!(snap.mode, ScanMode::Full);
    assert_eq!(snap.full_reason, Some(FullReason::IgnoreRulesChanged));
    assert_eq!(snap.disk_root, w.truth());
}

#[test]
fn a_change_the_watcher_missed_is_found_by_the_periodic_full_scan() {
    let w = World::new("inc-periodic");
    let p = &w.f.project;
    write(&p.join("a.txt"), "a");
    w.snap();
    write(&p.join("a.txt"), "changed with no event");
    let mut modes = Vec::new();
    let mut found_at = None;
    for i in 1..=FULL_EVERY_SNAPSHOTS {
        let snap = w.snap();
        modes.push(snap.mode);
        if found_at.is_none() && snap.disk_root == w.truth() {
            found_at = Some(i);
        }
    }
    // Incremental scans trust the watcher, so they cannot see it...
    assert!(modes[..(FULL_EVERY_SNAPSHOTS as usize - 2)]
        .iter()
        .all(|mode| *mode == ScanMode::Incremental));
    // ...and within FULL_EVERY_SNAPSHOTS a Full scan finds it.
    assert!(modes.contains(&ScanMode::Full));
    assert!(found_at.is_some());
}

/// A small deterministic generator (xorshift), so a failure can be replayed.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

fn files_under(dir: &Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path.clone());
            }
            out.push(path);
        }
    }
    out.sort();
    out
}

#[test]
fn a_random_sequence_of_changes_always_matches_a_full_scan() {
    for seed in [0x9e37_79b9_7f4a_7c15_u64, 42, 2026] {
        let w = World::new("inc-random");
        let p = w.f.project.clone();
        let mut rng = Rng(seed);
        for i in 0..12 {
            write(&p.join(format!("d{}/f{i}.txt", i % 4)), format!("{i}"));
        }
        w.snap();
        let dirs = ["d0", "d1", "d2", "d3", "d0/sub", "d2/sub/deeper", "fresh"];
        let mut incremental = 0;
        for step in 0..60 {
            let entries = files_under(&p);
            let files: Vec<_> = entries.iter().filter(|e| e.is_file()).cloned().collect();
            let folders: Vec<_> = entries.iter().filter(|e| e.is_dir()).cloned().collect();
            let mut changed = Vec::new();
            match rng.below(7) {
                0 => {
                    let path = p
                        .join(dirs[rng.below(dirs.len())])
                        .join(format!("n{step}.txt"));
                    // New directories are reported as the first directory created.
                    let mut first_new = path.clone();
                    while let Some(parent) = first_new.parent() {
                        if parent.exists() {
                            break;
                        }
                        first_new = parent.to_path_buf();
                    }
                    write(&path, format!("new {step}"));
                    changed.push(WatchedChange {
                        path: clean_path_str(&first_new),
                        from: None,
                    });
                }
                1 if !files.is_empty() => {
                    let path = &files[rng.below(files.len())];
                    std::fs::write(path, format!("modified {step} {}", rng.next())).unwrap();
                    changed.push(WatchedChange {
                        path: clean_path_str(path),
                        from: None,
                    });
                }
                2 if !files.is_empty() => {
                    let path = &files[rng.below(files.len())];
                    std::fs::remove_file(path).unwrap();
                    changed.push(WatchedChange {
                        path: clean_path_str(path),
                        from: None,
                    });
                }
                3 if !files.is_empty() => {
                    let from = &files[rng.below(files.len())];
                    let dir = p.join(dirs[rng.below(4)]);
                    std::fs::create_dir_all(&dir).unwrap();
                    let to = dir.join(format!("r{step}.txt"));
                    std::fs::rename(from, &to).unwrap();
                    changed.push(WatchedChange {
                        path: clean_path_str(&to),
                        from: Some(clean_path_str(from)),
                    });
                }
                4 => {
                    let path = p.join(format!("empty{step}"));
                    std::fs::create_dir_all(&path).unwrap();
                    changed.push(WatchedChange {
                        path: clean_path_str(&path),
                        from: None,
                    });
                }
                5 if !folders.is_empty() => {
                    let path = &folders[rng.below(folders.len())];
                    std::fs::remove_dir_all(path).unwrap();
                    changed.push(WatchedChange {
                        path: clean_path_str(path),
                        from: None,
                    });
                }
                6 if !folders.is_empty() => {
                    let from = &folders[rng.below(folders.len())];
                    let to = p.join(format!("moved{step}"));
                    std::fs::rename(from, &to).unwrap();
                    changed.push(WatchedChange {
                        path: clean_path_str(&to),
                        from: Some(clean_path_str(from)),
                    });
                }
                _ => {}
            }
            // Watchers repeat themselves: sometimes the same batch arrives twice.
            if rng.below(4) == 0 {
                w.events(&changed);
            }
            w.events(&changed);
            let snap = w.snap();
            if snap.mode == ScanMode::Incremental {
                incremental += 1;
            }
            assert_eq!(
                snap.disk_root,
                w.truth(),
                "seed {seed:#x}, step {step}: incremental and full disagree"
            );
        }
        assert!(
            incremental >= 50,
            "only {incremental} of 60 were incremental"
        );
    }
}
