//! LG-07 at scale (run on purpose, in release):
//! `cargo test -p ide-localgit --release --test lg07_scale -- --ignored --nocapture --test-threads=1`
//!
//! An AI checkpoint, a ChangeSet association, recording 10 AI-changed paths, the AI commit,
//! Undo AI Run, and the AI history with 1,000 runs, over 10,000 files (and 100,000 with the
//! second test).

mod common;

use common::*;
use ide_localgit::ai::*;
use ide_localgit::history::*;
use ide_localgit::index::*;
use ide_localgit::restore::OpKind;
use ide_localgit::*;
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;
use std::time::{Duration, Instant};

fn ms(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

fn path_of(i: usize) -> String {
    format!(
        "pkg{}/mod{}/sub{}/file{i}.ts",
        i % 10,
        (i / 10) % 10,
        (i / 100) % 100
    )
}

fn by() -> CommitRequest {
    CommitRequest {
        message: "base".into(),
        author: Author {
            name: "T".into(),
            id: "t".into(),
        },
        time_ms: 0,
        tz_offset_min: 0,
    }
}

fn scale(files: usize) {
    let f = Fixture::new(&format!("lg07scale{files}"));
    for i in 0..files {
        let path = f.project.join(path_of(i));
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, format!("base {i}\n")).unwrap();
    }
    std::thread::sleep(Duration::from_millis(3500));
    let repo = Mutex::new(f.open().unwrap());
    let engine = engine_for(&repo, &f.project);
    let cancel = AtomicBool::new(false);
    let control = Control {
        cancel: &cancel,
        progress: &|_| {},
    };
    let request = SnapshotRequest::default();
    stage_all(&engine, &repo, &request, &control).unwrap();
    commit_index(&mut repo.lock().unwrap(), &by()).unwrap();
    let store_before = repo.lock().unwrap().storage_bytes();

    let started = Instant::now();
    engine
        .ai_checkpoint(
            &repo,
            &request,
            &control,
            &CheckpointRequest {
                agent_run_id: "run-1".into(),
                task_id: Some("task".into()),
                reason: "scale".into(),
                ..Default::default()
            },
            &by(),
        )
        .unwrap();
    let checkpoint_time = started.elapsed();
    let checkpoint_bytes = repo.lock().unwrap().storage_bytes() - store_before;
    report(&mut repo.lock().unwrap(), "run-1", RunEvent::Started).unwrap();
    let started = Instant::now();
    associate(
        &mut repo.lock().unwrap(),
        "run-1",
        "cs-1",
        Some("r1".into()),
    )
    .unwrap();
    let association = started.elapsed();

    let step = files / 10;
    let changed: Vec<usize> = (0..10).map(|n| n * step).collect();
    for &i in &changed {
        std::fs::write(f.project.join(path_of(i)), format!("ai {i}\n")).unwrap();
    }
    let reported: Vec<ReportedPath> = changed
        .iter()
        .map(|&i| ReportedPath {
            folder: None,
            path: path_of(i),
            expected: None,
        })
        .collect();
    let started = Instant::now();
    let (_, record) = engine
        .ai_record_changes(&repo, &request, &control, "run-1", &reported)
        .unwrap();
    let detection = started.elapsed();
    assert_eq!(record.changes.len(), 10);

    let started = Instant::now();
    let (_, made) = engine
        .ai_commit(
            &repo,
            &request,
            &control,
            "run-1",
            None,
            Some("r1".into()),
            &by(),
        )
        .unwrap();
    let commit_time = started.elapsed();
    assert!(made.commit.is_some(), "{:?}", made.refusals);

    let started = Instant::now();
    let (_, plan) = engine
        .ai_plan_undo(&repo, &request, &control, "run-1")
        .unwrap();
    let undo_plan = started.elapsed();
    assert!(plan.refusals.is_empty(), "{:?}", plan.refusals);
    begin_undo(&mut repo.lock().unwrap(), &plan).unwrap();
    {
        let repo = repo.lock().unwrap();
        for op in &plan.restore.operations {
            assert_eq!(op.kind, OpKind::WriteFile);
            let bytes = repo.read_blob(&op.blob.unwrap().0, u64::MAX).unwrap();
            std::fs::write(f.project.join(&op.path), bytes).unwrap();
        }
    }
    let started = Instant::now();
    finish_undo(&mut repo.lock().unwrap(), &plan).unwrap();
    let undo_finish = started.elapsed();

    // 1,000 runs (checkpoints of one snapshot), then the history.
    let snapshot = persist(&engine, &repo);
    {
        let mut repo = repo.lock().unwrap();
        for n in 0..999 {
            checkpoint(
                &mut repo,
                &snapshot,
                &CheckpointRequest {
                    agent_run_id: format!("bulk-{n:04}"),
                    reason: "bulk".into(),
                    ..Default::default()
                },
                &by(),
            )
            .unwrap();
        }
    }
    let started = Instant::now();
    let list = list_runs(&repo.lock().unwrap(), 50).unwrap();
    let history_time = started.elapsed();
    assert_eq!(list.total, 1000);
    let started = Instant::now();
    get_run(&repo.lock().unwrap(), "run-1").unwrap();
    let one = started.elapsed();
    println!(
        "{files} files: AI checkpoint (Full snapshot) {:.0} ms, +{:.1} KiB stored; ChangeSet \
         association {:.1} ms; recording 10 AI paths (Full snapshot) {:.0} ms; AI commit {:.0} \
         ms; undo plan {:.0} ms, finish {:.1} ms; history of 1,000 runs (50 listed) {:.0} ms; \
         one run {:.2} ms",
        ms(checkpoint_time),
        checkpoint_bytes as f64 / 1024.0,
        ms(association),
        ms(detection),
        ms(commit_time),
        ms(undo_plan),
        ms(undo_finish),
        ms(history_time),
        ms(one),
    );
}

#[test]
#[ignore]
fn lg07_scale_10k_files() {
    scale(10_000);
}

#[test]
#[ignore]
fn lg07_scale_100k_files() {
    scale(100_000);
}
