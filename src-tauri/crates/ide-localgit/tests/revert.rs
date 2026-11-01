//! LG-05: revert -- a new commit that undoes an earlier one, made from the index.

mod common;

use common::*;
use ide_localgit::branches::*;
use ide_localgit::fault::{self, FaultPoint};
use ide_localgit::history::*;
use ide_localgit::index::*;
use ide_localgit::revert::*;
use ide_localgit::*;
use ide_workspace::file_tree::clean_path_str;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

struct World {
    f: Fixture,
    repo: Mutex<Repository>,
    engine: SnapshotEngine,
}

fn quiet(cancel: &AtomicBool) -> Control<'_> {
    Control {
        cancel,
        progress: &|_| {},
    }
}

fn by() -> CommitRequest {
    CommitRequest {
        message: "unused".into(),
        author: Author {
            name: "T".into(),
            id: "t".into(),
        },
        time_ms: 5,
        tz_offset_min: 0,
    }
}

impl World {
    fn new(label: &str) -> World {
        World::with_limit(label, DEFAULT_MAX_BLOB_BYTES)
    }

    fn with_limit(label: &str, max: u64) -> World {
        let f = Fixture::new(label);
        let repo = Mutex::new(f.open().unwrap());
        let engine = engine_with(&repo.lock().unwrap(), &f.project, max);
        World { f, repo, engine }
    }

    fn p(&self, rel: &str) -> std::path::PathBuf {
        self.f.project.join(rel)
    }

    fn commit(&self, message: &str) -> ObjectId {
        let cancel = AtomicBool::new(false);
        stage_all(
            &self.engine,
            &self.repo,
            &SnapshotRequest::default(),
            &quiet(&cancel),
        )
        .unwrap();
        let mut request = by();
        request.message = message.into();
        commit_index(&mut self.repo.lock().unwrap(), &request)
            .unwrap()
            .commit
            .id
            .0
    }

    fn revert_with(
        &self,
        target: ObjectId,
        message: Option<&str>,
        overlays: Vec<OverlayInput>,
    ) -> Result<RevertResult> {
        let cancel = AtomicBool::new(false);
        self.engine
            .revert(
                &self.repo,
                &SnapshotRequest {
                    overlays,
                    ..Default::default()
                },
                &quiet(&cancel),
                target,
                message.map(str::to_string),
                &by(),
            )
            .map(|(_, r)| r)
    }

    fn revert(&self, target: ObjectId) -> RevertResult {
        self.revert_with(target, None, vec![]).unwrap()
    }

    /// The HEAD commit's tree, as a listing.
    fn head_tree(&self) -> std::collections::BTreeMap<String, String> {
        let repo = self.repo.lock().unwrap();
        let head = resolve_head(&repo).commit().unwrap();
        let root = repo.read_commit(&head).unwrap().root;
        let tree = folder_tree(&repo, root);
        tree_listing(&repo, tree)
    }

    /// Makes the working tree what HEAD has (what a restore would do), so later steps start clean.
    fn sync_disk(&self, files: &[(&str, Option<&str>)]) {
        for (path, content) in files {
            match content {
                Some(text) => write(&self.p(path), text),
                None => {
                    let _ = std::fs::remove_file(self.p(path));
                }
            }
        }
    }
}

fn kinds(result: &RevertResult) -> Vec<String> {
    let mut out: Vec<String> = result
        .conflicts
        .iter()
        .map(|c| {
            format!("{c:?}")
                .split_whitespace()
                .next()
                .unwrap()
                .to_string()
        })
        .collect();
    out.sort();
    out
}

#[test]
fn reverting_the_latest_commit_adds_a_commit_with_the_parents_content() {
    let w = World::new("revert-latest");
    write(&w.p("foo.txt"), "A");
    let c1 = w.commit("one");
    write(&w.p("foo.txt"), "B");
    write(&w.p("added.txt"), "new in two");
    let c2 = w.commit("two: edit and add");
    let result = w.revert(c2);
    let created = result.commit.expect("a commit");
    assert_eq!(
        created.parents,
        vec![ObjectIdText(c2)],
        "on top of HEAD; nothing rewritten"
    );
    assert_eq!(
        created.message,
        format!("Revert \"two: edit and add\"\n\nThis reverts Local Git commit {c2}.")
    );
    let tree = w.head_tree();
    assert_eq!(tree["foo.txt"], format!("file {}", blob_id(b"A")));
    assert!(!tree.contains_key("added.txt"));
    // The old commits are untouched and still in history.
    let repo = w.repo.lock().unwrap();
    let page = history(&repo, None, 10);
    let ids: Vec<ObjectId> = page.items.iter().map(|c| c.id.0).collect();
    assert_eq!(ids, vec![created.id.0, c2, c1]);
    assert!(index_info(&repo).unwrap().equals_head);
    drop(repo);
    // The working tree was not touched: it still has two's content, now unstaged.
    assert_eq!(std::fs::read(w.p("foo.txt")).unwrap(), b"B");
}

#[test]
fn an_older_commit_is_reverted_when_later_history_left_its_paths_alone() {
    let w = World::new("revert-older");
    write(&w.p("a.txt"), "a1");
    write(&w.p("gone.txt"), "will be deleted");
    w.commit("one");
    std::fs::remove_file(w.p("gone.txt")).unwrap();
    let c2 = w.commit("two deletes gone.txt");
    write(&w.p("a.txt"), "a3");
    w.commit("three edits a.txt");
    let result = w.revert(c2);
    assert!(result.conflicts.is_empty(), "{:?}", result.conflicts);
    let tree = w.head_tree();
    assert_eq!(
        tree["gone.txt"],
        format!("file {}", blob_id(b"will be deleted")),
        "the deletion undone"
    );
    assert_eq!(
        tree["a.txt"],
        format!("file {}", blob_id(b"a3")),
        "later work kept"
    );
    assert_eq!(
        result.paths,
        vec![format!(
            "{}:gone.txt",
            w.engine.folders()[0].folder_id.as_str()
        )]
    );
}

#[test]
fn a_path_changed_since_is_a_conflict_never_overwritten() {
    let w = World::new("revert-changed-since");
    write(&w.p("foo.txt"), "A");
    write(&w.p("img.bin"), [0u8, 1, 2]);
    w.commit("one");
    write(&w.p("foo.txt"), "B");
    write(&w.p("img.bin"), [0u8, 9, 9]);
    let c2 = w.commit("two");
    write(&w.p("foo.txt"), "C");
    write(&w.p("img.bin"), [0u8, 7, 7]);
    let c3 = w.commit("three");
    let result = w.revert(c2);
    assert!(result.commit.is_none());
    assert_eq!(kinds(&result), vec!["ChangedSince", "ChangedSince"]);
    assert!(result.conflicts.iter().any(|c| matches!(c, RevertConflict::ChangedSince { path, binary: true, .. } if path == "img.bin")));
    assert!(result.conflicts.iter().any(|c| matches!(c, RevertConflict::ChangedSince { path, binary: false, .. } if path == "foo.txt")));
    assert_eq!(
        resolve_head(&w.repo.lock().unwrap()).commit(),
        Some(c3),
        "nothing moved"
    );
}

#[test]
fn local_work_on_a_reverted_path_stops_it() {
    let w = World::new("revert-local-work");
    write(&w.p("foo.txt"), "A");
    write(&w.p("bar.txt"), "x");
    write(&w.p("doc.txt"), "d1");
    w.commit("one");
    write(&w.p("foo.txt"), "B");
    write(&w.p("bar.txt"), "y");
    write(&w.p("doc.txt"), "d2");
    let c2 = w.commit("two");
    // foo.txt edited on disk, bar.txt staged, doc.txt dirty in the editor.
    write(&w.p("foo.txt"), "local");
    write(&w.p("bar.txt"), "staged");
    let cancel = AtomicBool::new(false);
    stage(
        &w.engine,
        &w.repo,
        &SnapshotRequest::default(),
        &quiet(&cancel),
        &[StagePath {
            folder: None,
            path: "bar.txt".into(),
        }],
    )
    .unwrap();
    let dirty = OverlayInput {
        path: clean_path_str(w.p("doc.txt")),
        bytes: Arc::new(b"unsaved".to_vec()),
        encoding: "utf8".into(),
        line_ending: "lf".into(),
        version: 3,
    };
    let result = w.revert_with(c2, None, vec![dirty]).unwrap();
    assert_eq!(
        kinds(&result),
        vec![
            "DirtyDocument",
            "StagedChangesPresent",
            "WorkingTreeChanged",
            "WorkingTreeChanged"
        ]
    );
    assert!(result.commit.is_none());
}

#[test]
fn content_that_was_never_stored_is_never_invented() {
    let w = World::with_limit("revert-large", 1024);
    write(&w.p("big.bin"), vec![1u8; 5000]);
    w.commit("one");
    write(&w.p("big.bin"), vec![2u8; 5000]);
    let c2 = w.commit("two");
    let result = w.revert(c2);
    assert!(
        matches!(result.conflicts.as_slice(), [RevertConflict::HistoricalContentUnavailable { path, .. }] if path == "big.bin")
    );
    assert!(result.commit.is_none());
}

#[test]
fn a_custom_message_a_detached_head_and_nothing_left_to_revert() {
    let w = World::new("revert-detached");
    write(&w.p("a.txt"), "1");
    w.commit("one");
    write(&w.p("a.txt"), "2");
    let c2 = w.commit("two");
    let cancel = AtomicBool::new(false);
    let (_, plan) = w
        .engine
        .plan_switch(
            &w.repo,
            &SnapshotRequest::default(),
            &quiet(&cancel),
            &ide_localgit::switch::SwitchTarget::Commit(c2),
        )
        .unwrap();
    ide_localgit::switch::finish(&mut w.repo.lock().unwrap(), &plan).unwrap();
    let result = w
        .revert_with(c2, Some("Undo two, by hand"), vec![])
        .unwrap();
    let created = result.commit.unwrap();
    assert_eq!(created.message, "Undo two, by hand");
    let repo = w.repo.lock().unwrap();
    assert_eq!(
        resolve_head(&repo),
        HeadState::Detached { commit: created.id }
    );
    assert_eq!(
        get_branch(&repo, "main").unwrap().commit.0,
        c2,
        "no branch moved"
    );
    drop(repo);
    // Reverting the revert's target again: HEAD no longer has what two left there.
    w.sync_disk(&[("a.txt", Some("1"))]);
    let again = w.revert(c2);
    assert_eq!(kinds(&again), vec!["ChangedSince"]);
    // An invalid message is refused before anything happens.
    assert!(w.revert_with(c2, Some("   "), vec![]).is_err());
}

#[test]
fn a_crash_while_head_moves_leaves_the_old_or_the_new_history() {
    for point in [
        FaultPoint::SegmentWritten,
        FaultPoint::SegmentRenamed,
        FaultPoint::ReflogAppended,
        FaultPoint::RefsWritten,
    ] {
        let w = World::new("revert-crash");
        write(&w.p("a.txt"), "1");
        w.commit("one");
        write(&w.p("a.txt"), "2");
        let c2 = w.commit("two");
        let crashed = catch_unwind(AssertUnwindSafe(|| {
            fault::arm(point);
            let result = w.revert_with(c2, None, vec![]);
            fault::disarm();
            result
        }));
        fault::disarm();
        assert!(crashed.is_err(), "{point:?}");
        let World { f, repo, .. } = w;
        drop(repo);
        let reopened = f.open().unwrap();
        let head = resolve_head(&reopened).commit().unwrap();
        if point == FaultPoint::RefsWritten {
            assert_ne!(head, c2, "{point:?}: the revert is HEAD");
            assert_eq!(reopened.read_commit(&head).unwrap().parents, vec![c2]);
        } else {
            assert_eq!(head, c2, "{point:?}");
        }
        assert!(reopened.verify(true).is_empty(), "{point:?}");
    }
}
