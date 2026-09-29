//! LG-03: checkpoints, commits, HEAD and history.

mod common;

use common::*;
use ide_localgit::fault::{self, FaultPoint};
use ide_localgit::history::*;
use ide_localgit::*;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Arc, Mutex};

fn request(message: &str) -> CommitRequest {
    CommitRequest {
        message: message.into(),
        author: Author {
            name: "Ada".into(),
            id: "ada@yavin".into(),
        },
        time_ms: 1_800_000_000_000,
        tz_offset_min: 60,
    }
}

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
        World { f, repo, engine }
    }

    fn commit(&self, message: &str) -> Created {
        let snap = persist(&self.engine, &self.repo);
        commit_snapshot(&mut self.repo.lock().unwrap(), &snap, &request(message)).unwrap()
    }

    fn checkpoint_with(&self, overlays: Vec<OverlayInput>) -> (Snapshot, Created) {
        let snap = try_snapshot(
            &self.engine,
            &self.repo,
            &SnapshotRequest {
                persist: true,
                allow_incremental_persist: true,
                overlays,
                ..Default::default()
            },
        )
        .unwrap();
        let created = checkpoint_snapshot(
            &mut self.repo.lock().unwrap(),
            &snap,
            Source::Checkpoint,
            &request("checkpoint"),
        )
        .unwrap();
        (snap, created)
    }
}

#[test]
fn the_first_commit_starts_history_and_each_next_one_builds_on_head() {
    let w = World::new("hist-chain");
    let head = head_info(&w.repo.lock().unwrap()).unwrap();
    assert!(head.unborn);
    assert_eq!(head.symbolic.as_deref(), Some("refs/heads/main"));

    write(&w.f.project.join("a.txt"), "one");
    let first = w.commit("first\n\nwith a body");
    assert!(first.commit.parents.is_empty());
    assert_eq!(first.commit.summary, "first");
    assert_eq!(first.commit.source, "human");
    write(&w.f.project.join("a.txt"), "two");
    let second = w.commit("second");
    assert_eq!(second.commit.parents, vec![first.commit.id]);
    assert!(second.revision > first.revision);

    let repo = w.repo.lock().unwrap();
    let head = head_info(&repo).unwrap();
    assert!(!head.unborn);
    assert_eq!(head.commit.unwrap().id, second.commit.id);
    // The reflog says how HEAD got there.
    let moves: Vec<String> = repo
        .reflog()
        .unwrap()
        .into_iter()
        .filter_map(|record| match record {
            ReflogRecord::Update {
                name, op, reason, ..
            } => Some(format!("{name} {op} {reason}")),
            _ => None,
        })
        .collect();
    assert_eq!(
        moves,
        vec![
            "refs/heads/main commit first",
            "refs/heads/main commit second"
        ]
    );
    assert!(repo.verify(true).is_empty());
}

#[test]
fn history_is_newest_first_along_parents_and_pages_with_a_cursor() {
    let w = World::new("hist-pages");
    let mut ids = Vec::new();
    for i in 0..7 {
        write(&w.f.project.join("a.txt"), format!("{i}"));
        ids.push(w.commit(&format!("commit {i}")).commit.id);
    }
    let repo = w.repo.lock().unwrap();
    let page = history(&repo, None, 3);
    let got: Vec<_> = page.items.iter().map(|c| c.id).collect();
    assert_eq!(got, vec![ids[6], ids[5], ids[4]]);
    assert_eq!(page.next, Some(ids[3]));
    let rest = history(&repo, page.next.map(|n| n.0), 100);
    assert_eq!(rest.items.len(), 4);
    assert_eq!(rest.items.last().unwrap().id, ids[0]);
    assert_eq!(rest.next, None);
    assert!(rest.broken.is_none());
    // Deterministic: the same walk twice is the same.
    assert_eq!(
        history(&repo, None, 100).items,
        history(&repo, None, 100).items
    );
    assert_eq!(page.items[0].short_id.len(), 12);
}

#[test]
fn a_missing_or_corrupt_commit_ends_history_with_the_reason() {
    let w = World::new("hist-broken");
    write(&w.f.project.join("a.txt"), "1");
    w.commit("one");
    // A commit whose parent does not exist cannot be written...
    let mut repo = w.repo.lock().unwrap();
    let ghost = blob_id(b"no such commit");
    let bogus = Commit {
        root: repo
            .read_commit(&repo.refs().head_commit().unwrap())
            .unwrap()
            .root,
        disk_root: None,
        parents: vec![ghost],
        workspace: repo.meta().workspace.clone(),
        author: Author {
            name: "x".into(),
            id: "x".into(),
        },
        time_ms: 0,
        tz_offset_min: 0,
        source: Source::Human,
        meta: Default::default(),
        meta_objects: Default::default(),
        message: "orphan".into(),
    };
    let mut txn = repo.begin_write().unwrap();
    assert!(matches!(
        txn.put_commit(&bogus),
        Err(LgError::MissingObject(_))
    ));
    txn.abandon();
    // ...and a history that reaches one (here: asked to start there) says so.
    let page = history(&repo, Some(ghost), 10);
    assert!(page.items.is_empty());
    let broken = page.broken.unwrap();
    assert_eq!(broken.id.0, ghost);
    assert_eq!(broken.code, "MissingObject");
    // Asking for a commit that is a blob is refused as such.
    let blob = repo
        .read_commit(&repo.refs().head_commit().unwrap())
        .unwrap()
        .root;
    assert!(matches!(
        require_commit(&repo, &blob),
        Err(LgError::WrongKind { .. })
    ));
    drop(repo);

    // A corrupted commit object: history stops at it with CorruptObject.
    let store = w.f.store();
    let id = head_info(&w.repo.lock().unwrap())
        .unwrap()
        .commit
        .unwrap()
        .id
        .0;
    drop(w.repo);
    let segments: Vec<_> = std::fs::read_dir(store.join("objects"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    let message = b"one";
    let mut hit = false;
    for segment in segments {
        let mut bytes = std::fs::read(&segment).unwrap();
        if let Some(at) = bytes
            .windows(message.len() + 2)
            .position(|w| w == b"\n\none")
        {
            bytes[at + 2] = b'O';
            std::fs::write(&segment, bytes).unwrap();
            hit = true;
        }
    }
    assert!(hit, "the commit's message was found in a segment");
    let repo = w.f.open().unwrap();
    let page = history(&repo, None, 10);
    assert!(page.items.is_empty());
    assert_eq!(page.broken.unwrap().code, "CorruptObject");
    assert!(matches!(
        repo.read_commit(&id),
        Err(LgError::CorruptObject { .. })
    ));
}

#[test]
fn messages_are_validated() {
    assert!(validate_message("fine").is_ok());
    assert!(validate_message("  \n\t ").is_err());
    assert!(validate_message("nul\0inside").is_err());
    assert!(validate_message(&"x".repeat(MAX_MESSAGE_BYTES + 1)).is_err());
    let w = World::new("hist-message");
    write(&w.f.project.join("a.txt"), "a");
    let snap = persist(&w.engine, &w.repo);
    let before = w.repo.lock().unwrap().object_count();
    assert!(commit_snapshot(&mut w.repo.lock().unwrap(), &snap, &request("   ")).is_err());
    // Refused before anything was written.
    assert_eq!(w.repo.lock().unwrap().object_count(), before);
    assert!(head_info(&w.repo.lock().unwrap()).unwrap().unborn);
}

#[test]
fn identical_commits_are_one_object_and_the_same_tree_is_never_stored_twice() {
    let w = World::new("hist-dedup");
    write(&w.f.project.join("a.txt"), "same");
    let snap = persist(&w.engine, &w.repo);
    let objects = w.repo.lock().unwrap().object_count();
    let again = persist(&w.engine, &w.repo);
    assert_eq!(again.effective_root, snap.effective_root);
    assert_eq!(w.repo.lock().unwrap().object_count(), objects);
    // Two checkpoints of the same state with the same metadata: one commit object.
    let mut repo = w.repo.lock().unwrap();
    let a = checkpoint_snapshot(&mut repo, &snap, Source::Checkpoint, &request("cp")).unwrap();
    let count = repo.object_count();
    let b = checkpoint_snapshot(&mut repo, &again, Source::Checkpoint, &request("cp")).unwrap();
    assert_eq!(a.commit.id, b.commit.id);
    assert_eq!(repo.object_count(), count);
}

#[test]
fn a_checkpoint_keeps_unsaved_work_without_moving_head_and_becomes_a_commit_without_a_scan() {
    let w = World::new("hist-checkpoint");
    write(&w.f.project.join("saved.txt"), "on disk");
    write(&w.f.project.join("edited.txt"), "on disk");
    let base = w.commit("base");
    // A dirty document, a deleted-but-open one, a new file, an empty directory.
    write(&w.f.project.join("new.txt"), "brand new");
    std::fs::create_dir_all(w.f.project.join("empty")).unwrap();
    std::fs::remove_file(w.f.project.join("saved.txt")).unwrap();
    let overlay = |name: &str, text: &str| OverlayInput {
        path: ide_workspace::file_tree::clean_path_str(w.f.project.join(name)),
        bytes: Arc::new(text.as_bytes().to_vec()),
        encoding: "utf8".into(),
        line_ending: "lf".into(),
        version: 3,
    };
    let (snap, cp) = w.checkpoint_with(vec![
        overlay("edited.txt", "unsaved edit"),
        overlay("saved.txt", "deleted on disk, open and dirty"),
    ]);
    assert_eq!(cp.commit.source, "checkpoint");
    assert_eq!(cp.commit.parents, vec![base.commit.id]);
    assert_eq!(cp.commit.root, snap.effective_root);
    assert_eq!(cp.commit.disk_root, Some(snap.disk_root));
    assert!(cp.commit.overlays.is_some());
    let repo_guard = w.repo.lock().unwrap();
    // HEAD did not move; the checkpoint is listed.
    assert_eq!(
        head_info(&repo_guard).unwrap().commit.unwrap().id,
        base.commit.id
    );
    let listed = checkpoints(&repo_guard, 10).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, cp.commit.id);
    // What it recorded: the unsaved text, the deleted-but-open file, the new file, the folder.
    let tree = folder_tree(&repo_guard, cp.commit.root.0);
    let listing = tree_listing(&repo_guard, tree);
    assert_eq!(
        listing["edited.txt"],
        format!("file {}", blob_id(b"unsaved edit"))
    );
    assert_eq!(
        listing["saved.txt"],
        format!("file {}", blob_id(b"deleted on disk, open and dirty"))
    );
    assert_eq!(
        listing["new.txt"],
        format!("file {}", blob_id(b"brand new"))
    );
    assert_eq!(listing["empty"], "dir");
    let objects = repo_guard.object_count();
    drop(repo_guard);

    // Promoted to a commit: the same roots, nothing scanned, only the commit object added.
    let mut repo = w.repo.lock().unwrap();
    let commit = commit_checkpoint(&mut repo, cp.commit.id.0, &request("from checkpoint")).unwrap();
    assert_eq!(commit.commit.root, cp.commit.root);
    assert_eq!(commit.commit.disk_root, cp.commit.disk_root);
    assert_eq!(commit.commit.parents, vec![base.commit.id]);
    assert_eq!(commit.commit.source, "human");
    assert_eq!(repo.object_count(), objects + 1);
    assert_eq!(
        head_info(&repo).unwrap().commit.unwrap().id,
        commit.commit.id
    );
    // A human commit is not a checkpoint, and cannot be promoted as one.
    assert!(commit_checkpoint(&mut repo, commit.commit.id.0, &request("x")).is_err());
}

#[test]
fn a_checkpoint_from_a_warm_engine_is_incremental() {
    let w = World::new("hist-incremental-cp");
    for i in 0..50 {
        write(
            &w.f.project.join(format!("d{}/f{i}.txt", i % 5)),
            format!("{i}"),
        );
    }
    w.engine.watcher_status(1, true);
    let (first, _) = w.checkpoint_with(vec![]);
    assert_eq!(first.mode, ScanMode::Full);
    write(&w.f.project.join("d2/f2.txt"), "changed");
    w.engine.watcher_changes(
        1,
        &ide_workspace::file_tree::clean_path_str(&w.f.project),
        &[WatchedChange {
            path: ide_workspace::file_tree::clean_path_str(w.f.project.join("d2/f2.txt")),
            from: None,
        }],
        &[],
    );
    let (second, _) = w.checkpoint_with(vec![]);
    assert_eq!(second.mode, ScanMode::Incremental);
    assert_eq!(second.stats.directories, 2);
    // It is complete: every object it needs is stored, and it equals a full scan.
    let truth = snapshot_mode(
        &engine_for(&w.repo, &w.f.project),
        &w.repo,
        RequestedMode::Verify,
    );
    assert_eq!(second.disk_root, truth.disk_root);
    assert!(w.repo.lock().unwrap().verify(true).is_empty());
}

#[test]
fn a_crash_anywhere_in_a_commit_leaves_head_old_or_new_and_complete() {
    for (point, expect_new) in [
        (FaultPoint::SegmentTempCreated, false),
        (FaultPoint::SegmentWritten, false),
        (FaultPoint::SegmentRenamed, false),
        (FaultPoint::ReflogPartlyAppended, false),
        (FaultPoint::ReflogAppended, false),
        (FaultPoint::RefsWritten, true),
    ] {
        let w = World::new("hist-crash");
        write(&w.f.project.join("a.txt"), "old");
        let old = w.commit("old");
        write(&w.f.project.join("a.txt"), "new");
        let snap = persist(&w.engine, &w.repo);
        let crashed = catch_unwind(AssertUnwindSafe(|| {
            let mut repo = w.repo.lock().unwrap_or_else(|p| p.into_inner());
            fault::arm(point);
            let result = commit_snapshot(&mut repo, &snap, &request("new"));
            fault::disarm();
            result
        }));
        fault::disarm();
        assert!(crashed.is_err(), "{point:?} crashed");
        drop(w.repo);
        let repo = w.f.open().unwrap();
        let head = head_info(&repo).unwrap().commit.unwrap();
        if expect_new {
            assert_ne!(head.id, old.commit.id, "{point:?}");
            assert_eq!(head.message, "new");
        } else {
            assert_eq!(head.id, old.commit.id, "{point:?}");
        }
        // Whatever HEAD is, it is complete; an interrupted move was reported, not finished.
        assert!(repo.verify(true).is_empty(), "{point:?}");
        if point == FaultPoint::ReflogAppended {
            assert!(repo
                .findings()
                .iter()
                .any(|f| matches!(f, Finding::InterruptedRefUpdate { .. })));
        }
    }
}
