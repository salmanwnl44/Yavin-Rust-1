//! LG-04 at realistic scale (run on purpose, in release):
//! `cargo test -p ide-localgit --release --test staging_scale -- --ignored --nocapture --test-threads=1`
//!
//! Targets from the LG-04 plan: stage one changed file < 150 ms warm, stage 100 files
//! proportional, unstage < 100 ms, branch and tag creation < 50 ms, listing 10k branches
//! < 100 ms, switch planning proportional to the changed paths.

mod common;

use common::*;
use ide_localgit::branches::*;
use ide_localgit::history::*;
use ide_localgit::index::*;
use ide_localgit::switch::{finish, SwitchTarget};
use ide_localgit::*;
use ide_workspace::file_tree::clean_path_str;
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

fn measure(files: usize) {
    let f = Fixture::new(&format!("stagescale-{files}"));
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
    let request = SnapshotRequest::default();
    let started = Instant::now();
    stage_all(&engine, &repo, &request, &control).unwrap();
    let first_stage = started.elapsed();
    commit_index(&mut repo.lock().unwrap(), &by("base")).unwrap();

    let touch = |indices: &[usize], text: &str| {
        let mut changes = Vec::new();
        for &i in indices {
            let path = p.join(path_of(i));
            std::fs::write(&path, format!("{text} {i}\n")).unwrap();
            changes.push(WatchedChange {
                path: clean_path_str(&path),
                from: None,
            });
        }
        engine.watcher_changes(1, &clean_path_str(p), &changes, &[]);
    };
    // Warm the engine's incremental state.
    let _ = stage(&engine, &repo, &request, &control, &[]);

    touch(&[7], "one change");
    let started = Instant::now();
    stage(
        &engine,
        &repo,
        &request,
        &control,
        &[StagePath {
            folder: None,
            path: path_of(7),
        }],
    )
    .unwrap();
    let stage_one = started.elapsed();

    let hundred: Vec<usize> = (0..files).step_by(files / 100).take(100).collect();
    touch(&hundred, "hundred");
    let paths: Vec<StagePath> = hundred
        .iter()
        .map(|&i| StagePath {
            folder: None,
            path: path_of(i),
        })
        .collect();
    let started = Instant::now();
    stage(&engine, &repo, &request, &control, &paths).unwrap();
    let stage_hundred = started.elapsed();

    let started = Instant::now();
    unstage(
        &mut repo.lock().unwrap(),
        engine.folders(),
        &[StagePath {
            folder: None,
            path: path_of(7),
        }],
    )
    .unwrap();
    let unstage_one = started.elapsed();

    let started = Instant::now();
    create_branch(&mut repo.lock().unwrap(), "feature", None).unwrap();
    let branch_time = started.elapsed();
    let started = Instant::now();
    create_tag(&mut repo.lock().unwrap(), "v1", None).unwrap();
    let tag_time = started.elapsed();

    // A commit on main 10 files away from feature, then plan switching to feature.
    unstage_all(&mut repo.lock().unwrap(), engine.folders()).unwrap();
    let ten: Vec<usize> = (0..files).step_by(files / 10).take(10).collect();
    touch(&ten, "ten");
    let ten_paths: Vec<StagePath> = ten
        .iter()
        .map(|&i| StagePath {
            folder: None,
            path: path_of(i),
        })
        .collect();
    stage(&engine, &repo, &request, &control, &ten_paths).unwrap();
    commit_index(&mut repo.lock().unwrap(), &by("ten")).unwrap();
    // Put the other working changes back, so nothing is in the way.
    for i in hundred.iter().chain([7usize].iter()) {
        if !ten.contains(i) {
            std::fs::write(p.join(path_of(*i)), format!("export const v{i} = {i};\n")).unwrap();
        }
    }
    let started = Instant::now();
    let (_, plan) = engine
        .plan_switch(
            &repo,
            &request,
            &control,
            &SwitchTarget::Branch("feature".into()),
        )
        .unwrap();
    let plan_time = started.elapsed();
    assert!(
        plan.restore.conflicts.is_empty(),
        "{:?}",
        &plan.restore.conflicts[..plan.restore.conflicts.len().min(3)]
    );
    assert_eq!(plan.restore.operations.len(), 10);
    let started = Instant::now();
    finish(&mut repo.lock().unwrap(), &plan).unwrap();
    let finish_time = started.elapsed();

    println!(
        "{files} files: stage all (first) {:.0} ms; stage 1 changed file {:.1} ms; stage 100 files \
         {:.1} ms; unstage 1 {:.1} ms; branch create {:.1} ms; tag create {:.1} ms; switch plan \
         (10 paths, Full snapshot included) {:.0} ms; HEAD+index move {:.1} ms",
        ms(first_stage),
        ms(stage_one),
        ms(stage_hundred),
        ms(unstage_one),
        ms(branch_time),
        ms(tag_time),
        ms(plan_time),
        ms(finish_time),
    );
}

#[test]
#[ignore]
fn staging_scale_10k_files() {
    measure(10_000);
}

#[test]
#[ignore]
fn staging_scale_100k_files() {
    measure(100_000);
}

#[test]
#[ignore]
fn listing_10k_branches() {
    let f = Fixture::new("stagescale-refs");
    write(&f.project.join("a.txt"), "a");
    let repo = Mutex::new(f.open().unwrap());
    let engine = engine_for(&repo, &f.project);
    let cancel = AtomicBool::new(false);
    stage_all(
        &engine,
        &repo,
        &SnapshotRequest::default(),
        &Control {
            cancel: &cancel,
            progress: &|_| {},
        },
    )
    .unwrap();
    let head = commit_index(&mut repo.lock().unwrap(), &by("base"))
        .unwrap()
        .commit
        .id
        .0;
    let mut repo = repo.lock().unwrap();
    let updates: Vec<RefUpdate> = (0..10_000)
        .map(|i| RefUpdate {
            name: RefName::new(&format!("refs/heads/b{i:05}")).unwrap(),
            expected: None,
            new: Some(head),
        })
        .collect();
    let revision = repo.refs().revision;
    let started = Instant::now();
    repo.update_refs(revision, &updates, None, "test", "10k branches")
        .unwrap();
    let write_time = started.elapsed();
    let started = Instant::now();
    let branches = list_branches(&repo);
    let list_time = started.elapsed();
    assert_eq!(branches.len(), 10_001);
    let started = Instant::now();
    create_branch(&mut repo, "one-more", None).unwrap();
    let create_time = started.elapsed();
    println!(
        "10,001 branches: listed in {:.1} ms; one more created in {:.1} ms (10k written in one \
         update in {:.0} ms)",
        ms(list_time),
        ms(create_time),
        ms(write_time)
    );
}
