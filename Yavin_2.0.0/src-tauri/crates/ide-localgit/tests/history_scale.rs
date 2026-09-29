//! LG-03 at realistic scale (run on purpose, in release):
//! `cargo test -p ide-localgit --release --test history_scale -- --ignored --nocapture --test-threads=1`
//!
//! A workspace of N small files: an incremental checkpoint after a few changes, a commit made
//! from it (the commit object and the HEAD move alone), a diff of unchanged commits and of
//! commits 10 files apart, a restore plan for 10 changed files, and history over 10k commits.
//! Targets from the LG-03 plan: checkpoint < 150 ms for small incremental changes, commit and
//! ref update < 100 ms, history practical, unchanged diff near zero, planning proportional to
//! the changes.

mod common;

use common::*;
use ide_localgit::diff::{diff_commits, DiffOptions};
use ide_localgit::history::*;
use ide_localgit::restore::RestorePolicy;
use ide_localgit::*;
use ide_workspace::file_tree::clean_path_str;
use std::collections::BTreeMap;
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;
use std::time::{Duration, Instant};

fn ms(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

fn request(message: &str) -> CommitRequest {
    CommitRequest {
        message: message.into(),
        author: Author {
            name: "T".into(),
            id: "t".into(),
        },
        time_ms: 0,
        tz_offset_min: 0,
    }
}

fn path_of(i: usize) -> String {
    format!(
        "pkg{}/mod{}/sub{}/file{i}.ts",
        i % 10,
        (i / 10) % 10,
        (i / 100) % 100
    )
}

fn measure(files: usize) {
    let f = Fixture::new(&format!("histscale-{files}"));
    let p = &f.project;
    for i in 0..files {
        let path = p.join(path_of(i));
        if i < 10_000 {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        }
        std::fs::write(&path, format!("export const v{i} = {i};\n")).unwrap();
    }
    std::thread::sleep(Duration::from_millis(3500));
    let repo = Mutex::new(f.open().unwrap());
    let engine = engine_for(&repo, p);
    engine.watcher_status(1, true);
    let cancel = AtomicBool::new(false);
    let control = Control {
        cancel: &cancel,
        progress: &|_| {},
    };
    let checkpoint_request = SnapshotRequest {
        persist: true,
        allow_incremental_persist: true,
        ..Default::default()
    };

    // The first checkpoint: everything stored.
    let started = Instant::now();
    let first = engine
        .snapshot(&repo, &checkpoint_request, &control)
        .unwrap();
    let first_cp = checkpoint_snapshot(
        &mut repo.lock().unwrap(),
        &first,
        Source::Checkpoint,
        &request("cp0"),
    )
    .unwrap();
    let first_time = started.elapsed();
    let base = commit_checkpoint(
        &mut repo.lock().unwrap(),
        first_cp.commit.id.0,
        &request("base"),
    )
    .unwrap();

    // Three files change and the watcher says so: an incremental checkpoint.
    let mut changes = Vec::new();
    for i in [1usize, files / 2, files - 1] {
        let path = p.join(path_of(i));
        std::fs::write(&path, format!("changed {i}\n")).unwrap();
        changes.push(WatchedChange {
            path: clean_path_str(&path),
            from: None,
        });
    }
    engine.watcher_changes(1, &clean_path_str(p), &changes, &[]);
    let started = Instant::now();
    let snap = engine
        .snapshot(&repo, &checkpoint_request, &control)
        .unwrap();
    let cp = checkpoint_snapshot(
        &mut repo.lock().unwrap(),
        &snap,
        Source::Checkpoint,
        &request("cp1"),
    )
    .unwrap();
    let checkpoint_time = started.elapsed();
    assert_eq!(snap.mode, ScanMode::Incremental);

    // The commit alone: object + HEAD move, nothing scanned.
    let started = Instant::now();
    let head = commit_checkpoint(
        &mut repo.lock().unwrap(),
        cp.commit.id.0,
        &request("from cp"),
    )
    .unwrap();
    let commit_time = started.elapsed();

    // Diffs: identical commits, and three files apart (with line diffs).
    let started = Instant::now();
    let same = diff_commits(
        &repo.lock().unwrap(),
        Some(head.commit.id.0),
        head.commit.id.0,
        &DiffOptions::default(),
    )
    .unwrap();
    let same_time = started.elapsed();
    assert!(same.identical);
    let started = Instant::now();
    let apart = diff_commits(
        &repo.lock().unwrap(),
        Some(base.commit.id.0),
        head.commit.id.0,
        &DiffOptions::default(),
    )
    .unwrap();
    let apart_time = started.elapsed();
    assert_eq!(apart.counts.modified, 3);

    // Ten files differ from HEAD: plan restoring it.
    for i in (0..files).step_by(files / 10).take(10) {
        std::fs::write(p.join(path_of(i)), "drifted\n").unwrap();
    }
    let started = Instant::now();
    let (_, plan) = engine
        .plan_restore(
            &repo,
            &SnapshotRequest {
                mode: RequestedMode::Full,
                ..Default::default()
            },
            &control,
            head.commit.id.0,
            None,
            RestorePolicy::RefuseIfDirty,
        )
        .unwrap();
    let plan_time = started.elapsed();
    assert_eq!(plan.operations.len(), 10);
    assert!(plan.conflicts.is_empty());

    println!(
        "{files} files: first checkpoint {:.0} ms; incremental checkpoint (3 changed) {:.1} ms; \
         commit from it {:.1} ms; diff identical {:.3} ms; diff 3 apart {:.1} ms; restore plan \
         (10 changed, Full scan included) {:.0} ms",
        ms(first_time),
        ms(checkpoint_time),
        ms(commit_time),
        ms(same_time),
        ms(apart_time),
        ms(plan_time),
    );
}

#[test]
#[ignore]
fn history_scale_10k_files() {
    measure(10_000);
}

#[test]
#[ignore]
fn history_scale_100k_files() {
    measure(100_000);
}

#[test]
#[ignore]
fn history_of_10k_commits() {
    let f = Fixture::new("histscale-commits");
    write(&f.project.join("a.txt"), "a");
    let repo = Mutex::new(f.open().unwrap());
    let engine = engine_for(&repo, &f.project);
    let snap = persist(&engine, &repo);
    let first = commit_snapshot(&mut repo.lock().unwrap(), &snap, &request("0")).unwrap();
    // 9,999 more, written in one transaction, then one HEAD move.
    let started = Instant::now();
    let mut repo_guard = repo.lock().unwrap();
    let workspace = repo_guard.meta().workspace.clone();
    let mut txn = repo_guard.begin_write().unwrap();
    let mut parent = first.commit.id.0;
    for i in 1..10_000 {
        parent = txn
            .put_commit(&Commit {
                root: snap.effective_root.0,
                disk_root: None,
                parents: vec![parent],
                workspace: workspace.clone(),
                author: Author {
                    name: "T".into(),
                    id: "t".into(),
                },
                time_ms: i,
                tz_offset_min: 0,
                source: Source::Human,
                meta: BTreeMap::new(),
                meta_objects: BTreeMap::new(),
                message: format!("commit {i}"),
            })
            .unwrap();
    }
    txn.commit().unwrap();
    let revision = repo_guard.refs().revision;
    repo_guard
        .update_refs(
            revision,
            &[RefUpdate {
                name: RefName::new("refs/heads/main").unwrap(),
                expected: Some(first.commit.id.0),
                new: Some(parent),
            }],
            None,
            "test",
            "10k",
        )
        .unwrap();
    let build = started.elapsed();
    let started = Instant::now();
    let page = history(&repo_guard, None, 100);
    let page_time = started.elapsed();
    let started = Instant::now();
    let mut cursor = None;
    let mut seen = 0;
    loop {
        let page = history(&repo_guard, cursor, 500);
        seen += page.items.len();
        match page.next {
            Some(next) => cursor = Some(next.0),
            None => break,
        }
    }
    let all_time = started.elapsed();
    assert_eq!(seen, 10_000);
    assert_eq!(page.items.len(), 100);
    println!(
        "10k commits (written in {:.0} ms): first page of 100 {:.1} ms; all 10,000 in pages of \
         500 {:.0} ms ({:.1} µs per commit)",
        ms(build),
        ms(page_time),
        ms(all_time),
        all_time.as_secs_f64() * 1e6 / 10_000.0
    );
}
