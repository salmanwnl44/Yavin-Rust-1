//! LG-09 at scale (run on purpose, in release):
//! `cargo test -p ide-localgit --release --test lg09_scale -- --ignored --nocapture --test-threads=1`
//!
//! GC planning and running, the full integrity scan, storage statistics, comparison with real
//! Git and promotion planning over 10,000 and 100,000 files; reachability and GC over 1,000,000
//! objects (written as objects: a million files is not practical on this disk).

mod common;

use common::*;
use ide_localgit::compare::{GitFile, GitSide};
use ide_localgit::gc::{self, RetentionPolicy};
use ide_localgit::gitblob::git_blob_id;
use ide_localgit::history::*;
use ide_localgit::index::*;
use ide_localgit::*;
use std::collections::BTreeMap;
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

fn content(i: usize, version: usize) -> String {
    format!("export const v{i} = {version};\n")
}

fn by() -> CommitRequest {
    CommitRequest {
        message: "c".into(),
        author: Author {
            name: "T".into(),
            id: "t".into(),
        },
        time_ms: 0,
        tz_offset_min: 0,
    }
}

fn now() -> u64 {
    ide_workspace::durable::now_millis() as u64
}

fn files(n: usize) {
    let f = Fixture::new(&format!("lg09scale{n}"));
    for i in 0..n {
        let path = f.project.join(path_of(i));
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, content(i, 0)).unwrap();
    }
    std::thread::sleep(Duration::from_millis(3500));
    let repo = Mutex::new(f.open().unwrap());
    let engine = engine_for(&repo, &f.project);
    let cancel = AtomicBool::new(false);
    let control = Control {
        cancel: &cancel,
        progress: &|_| {},
    };
    let commit = || {
        stage_all(&engine, &repo, &SnapshotRequest::default(), &control).unwrap();
        commit_index(&mut repo.lock().unwrap(), &by())
            .unwrap()
            .commit
            .id
            .0
    };
    let first = commit();
    // Ten versions of 100 files, then a branch deleted and its history expired: garbage.
    for version in 1..=10 {
        for i in (0..n).step_by(n / 100) {
            std::fs::write(f.project.join(path_of(i)), content(i, version)).unwrap();
        }
        commit();
    }
    let head = resolve_head_commit(&repo);
    {
        let mut repo = repo.lock().unwrap();
        ide_localgit::reset::reset_mixed(
            &mut repo,
            &ide_localgit::reset::ResetTarget::Commit(first),
        )
        .unwrap();
    }
    let mut repo = repo.into_inner().unwrap();
    let at = now() + 365 * 24 * 60 * 60 * 1000;
    let policy = RetentionPolicy {
        reflog_max_age_days: Some(30),
        reflog_keep_recent: 0,
        ai_finished_max_age_days: None,
    };
    let started = Instant::now();
    let plan = gc::plan(&repo, &policy, at).unwrap();
    let plan_time = started.elapsed();
    let started = Instant::now();
    let outcome = gc::run(&mut repo, &plan, at).unwrap();
    let run_time = started.elapsed();
    let started = Instant::now();
    let report = gc::integrity(&repo, true);
    let integrity_time = started.elapsed();
    assert!(report.ok, "{report:?}");
    let started = Instant::now();
    let stats = gc::stats(&repo).unwrap();
    let stats_time = started.elapsed();
    let started = Instant::now();
    let purged = gc::purge(&mut repo).unwrap();
    let purge_time = started.elapsed();
    let _ = head;

    // Comparison with a real Git HEAD holding the first version but 10 files.
    let mut side = GitSide {
        head: Some("ab".repeat(20)),
        branch: Some("main".into()),
        fingerprint: "fp".into(),
        ..Default::default()
    };
    for i in 0..n {
        let version = if i % (n / 10) == 0 { 99 } else { 0 };
        side.files.insert(
            path_of(i),
            GitFile {
                mode: "100644".into(),
                id: git_blob_id(content(i, version).as_bytes()),
            },
        );
        if version == 99 {
            side.modified.insert(path_of(i));
        }
    }
    let repo = Mutex::new(repo);
    let engine = engine_for(&repo, &f.project);
    let mut sides = BTreeMap::new();
    sides.insert(engine.folders()[0].folder_id.clone(), side);
    let started = Instant::now();
    let (_, comparison) = engine
        .compare_with_git(&repo, &control, Some(first), &sides, 1000)
        .unwrap();
    let compare_time = started.elapsed();
    assert_eq!(
        comparison.counts.get("different"),
        Some(&10),
        "{:?}",
        comparison.counts
    );
    for side in sides.values_mut() {
        side.modified.clear();
    }
    let started = Instant::now();
    let (_, promotion) = engine
        .plan_promotion(&repo, &SnapshotRequest::default(), &control, first, &sides)
        .unwrap();
    let promote_time = started.elapsed();
    let _ = promotion;
    println!(
        "{n} files: GC plan {:.0} ms ({} objects, {} unreachable, {} segments to rewrite); GC run \
         {:.0} ms ({} -> {} bytes); full integrity scan {:.0} ms; stats {:.1} ms ({} objects); \
         purge {:.1} ms ({} bytes); comparison with real Git {:.0} ms; promotion plan {:.0} ms",
        ms(plan_time),
        plan.objects,
        plan.unreachable,
        plan.segments_to_rewrite,
        ms(run_time),
        outcome.bytes_before,
        outcome.bytes_after,
        ms(integrity_time),
        ms(stats_time),
        stats.objects,
        ms(purge_time),
        purged.bytes,
        ms(compare_time),
        ms(promote_time),
    );
}

fn resolve_head_commit(repo: &Mutex<Repository>) -> ObjectId {
    ide_localgit::branches::resolve_head(&repo.lock().unwrap())
        .commit()
        .unwrap()
}

#[test]
#[ignore]
fn lg09_scale_10k_files() {
    files(10_000);
}

#[test]
#[ignore]
fn lg09_scale_100k_files() {
    files(100_000);
}

/// A million objects: 1,000 trees of 1,000 blobs under one commit, and as many unreachable.
#[test]
#[ignore]
fn lg09_scale_1m_objects() {
    let f = Fixture::new("lg09scale1m");
    let mut repo = f.open().unwrap();
    let folder = FolderId::new(&repo.meta().folders[0].folder_id).unwrap();
    let workspace = repo.meta().workspace.clone();
    let started = Instant::now();
    let mut dirs = Vec::new();
    for t in 0..1000 {
        let mut txn = repo.begin_write().unwrap();
        let mut entries = Vec::new();
        for b in 0..500 {
            let blob = txn.put_blob(format!("kept {t} {b}").as_bytes()).unwrap();
            entries.push(TreeEntry {
                name: EntryName::new(&format!("f{b}")).unwrap(),
                kind: EntryKind::File {
                    executable: false,
                    stored: Stored::Yes,
                },
                id: blob,
            });
            txn.put_blob(format!("garbage {t} {b}").as_bytes()).unwrap();
        }
        let tree = txn.put_tree(&Tree::new(entries).unwrap()).unwrap();
        txn.commit().unwrap();
        dirs.push(TreeEntry {
            name: EntryName::new(&format!("d{t}")).unwrap(),
            kind: EntryKind::Directory,
            id: tree,
        });
    }
    let mut txn = repo.begin_write().unwrap();
    let top = txn.put_tree(&Tree::new(dirs).unwrap()).unwrap();
    let root = txn
        .put_root(&Root {
            folders: [(folder, top)].into_iter().collect(),
        })
        .unwrap();
    let commit = txn
        .put_commit(&Commit {
            root,
            disk_root: None,
            parents: vec![],
            workspace,
            author: Author {
                name: "T".into(),
                id: "t".into(),
            },
            time_ms: 0,
            tz_offset_min: 0,
            source: Source::Human,
            meta: BTreeMap::new(),
            meta_objects: BTreeMap::new(),
            message: "a million".into(),
        })
        .unwrap();
    txn.commit().unwrap();
    advance(&mut repo, commit);
    let build = started.elapsed();
    drop(repo);
    let started = Instant::now();
    let mut repo = f.open().unwrap();
    let reopen = started.elapsed();
    let started = Instant::now();
    let plan = gc::plan(&repo, &RetentionPolicy::default(), now()).unwrap();
    let plan_time = started.elapsed();
    assert_eq!(plan.unreachable, 500_000);
    let started = Instant::now();
    gc::run(&mut repo, &plan, now()).unwrap();
    let run_time = started.elapsed();
    let started = Instant::now();
    let quick = gc::integrity(&repo, false);
    let quick_time = started.elapsed();
    assert!(quick.ok);
    let started = Instant::now();
    let stats = gc::stats(&repo).unwrap();
    let stats_time = started.elapsed();
    println!(
        "1M objects ({} after GC): build {:.0} ms; reopen {:.0} ms; GC plan (reachability) {:.0} ms; \
         GC run {:.0} ms; quick integrity {:.0} ms; stats {:.1} ms",
        stats.objects,
        ms(build),
        ms(reopen),
        ms(plan_time),
        ms(run_time),
        ms(quick_time),
        ms(stats_time),
    );
}
