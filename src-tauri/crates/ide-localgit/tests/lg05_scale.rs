//! LG-05 at scale (run on purpose, in release):
//! `cargo test -p ide-localgit --release --test lg05_scale -- --ignored --nocapture --test-threads=1`
//!
//! Targets from the LG-05 plan: soft reset < 50 ms, mixed reset < 100 ms warm, stash push
//! proportional to the changed paths, stash list < 50 ms with 10k stashes, stash drop < 50 ms,
//! revert planning proportional to the diff, the revert's commit < 100 ms.

mod common;

use common::*;
use ide_localgit::history::*;
use ide_localgit::index::*;
use ide_localgit::reset::*;
use ide_localgit::stash;
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

fn by(message: &str) -> CommitRequest {
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

#[test]
#[ignore]
fn lg05_scale_10k_files() {
    let files = 10_000;
    let f = Fixture::new("lg05scale");
    let p = &f.project;
    for i in 0..files {
        let path = p.join(path_of(i));
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, format!("export const v{i} = {i};\n")).unwrap();
    }
    std::thread::sleep(Duration::from_millis(3500));
    let repo = Mutex::new(f.open().unwrap());
    let engine = engine_for(&repo, p);
    let cancel = AtomicBool::new(false);
    let control = Control {
        cancel: &cancel,
        progress: &|_| {},
    };
    let request = SnapshotRequest::default();
    stage_all(&engine, &repo, &request, &control).unwrap();
    let c1 = commit_index(&mut repo.lock().unwrap(), &by("one"))
        .unwrap()
        .commit
        .id
        .0;
    let ten: Vec<usize> = (0..files).step_by(files / 10).take(10).collect();
    for &i in &ten {
        std::fs::write(p.join(path_of(i)), format!("changed {i}\n")).unwrap();
    }
    stage_all(&engine, &repo, &request, &control).unwrap();
    let c2 = commit_index(&mut repo.lock().unwrap(), &by("two"))
        .unwrap()
        .commit
        .id
        .0;

    let started = Instant::now();
    reset_soft(
        &mut repo.lock().unwrap(),
        engine.folders(),
        &ResetTarget::Commit(c1),
    )
    .unwrap();
    let soft = started.elapsed();
    let started = Instant::now();
    reset_mixed(&mut repo.lock().unwrap(), &ResetTarget::Commit(c2)).unwrap();
    let mixed = started.elapsed();

    // Revert two (10 paths): planning (a Full snapshot) and the commit.
    let started = Instant::now();
    let (_, reverted) = engine
        .revert(&repo, &request, &control, c2, None, &by(""))
        .unwrap();
    let revert_time = started.elapsed();
    assert!(
        reverted.commit.is_some(),
        "{:?}",
        &reverted.conflicts[..reverted.conflicts.len().min(2)]
    );

    // The working tree still has two's text: stash those 10 changes.
    let started = Instant::now();
    let (_, plan) = engine
        .plan_stash_push(&repo, &request, &control, None, false)
        .unwrap();
    let push_plan = started.elapsed();
    assert_eq!(plan.restore.operations.len(), 10);
    let started = Instant::now();
    let info = stash::record(&mut repo.lock().unwrap(), &plan, &by("")).unwrap();
    let record_time = started.elapsed();

    // 10,000 stashes (refs to the same stash commit), then list, and drop one.
    {
        let mut repo = repo.lock().unwrap();
        let updates: Vec<RefUpdate> = (0..9_999)
            .map(|i| RefUpdate {
                name: RefName::new(&format!("refs/yavin/stash/s0000000000000-{i:05}")).unwrap(),
                expected: None,
                new: Some(info.commit.0),
            })
            .collect();
        let revision = repo.refs().revision;
        repo.update_refs(revision, &updates, None, "test", "10k stashes")
            .unwrap();
    }
    let mut repo = repo.lock().unwrap();
    let started = Instant::now();
    let listed = stash::list(&repo, 100).unwrap();
    let list_time = started.elapsed();
    assert_eq!(listed.total, 10_000);
    let started = Instant::now();
    stash::drop_stash(&mut repo, &info.id).unwrap();
    let drop_time = started.elapsed();
    println!(
        "10k files: soft reset {:.1} ms; mixed reset {:.1} ms; revert of 10 paths (Full snapshot \
         included) {:.0} ms; stash push plan, 10 paths (Full snapshot included) {:.0} ms; stash \
         record {:.1} ms; list 100 of 10,000 stashes {:.1} ms; drop one of 10,000 {:.1} ms",
        ms(soft),
        ms(mixed),
        ms(revert_time),
        ms(push_plan),
        ms(record_time),
        ms(list_time),
        ms(drop_time),
    );
}
