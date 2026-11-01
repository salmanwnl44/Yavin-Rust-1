//! LG-04: the Local Index -- staging, unstaging, partial staging, and commits made from it.

mod common;

use common::*;
use ide_localgit::branches::{index_state, resolve_head, HeadState, INDEX_REF};
use ide_localgit::diff::DiffOptions;
use ide_localgit::fault::{self, FaultPoint};
use ide_localgit::history::*;
use ide_localgit::index::*;
use ide_localgit::*;
use ide_workspace::file_tree::clean_path_str;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

pub struct World {
    pub f: Fixture,
    pub repo: Mutex<Repository>,
    pub engine: SnapshotEngine,
}

fn quiet(cancel: &AtomicBool) -> Control<'_> {
    Control {
        cancel,
        progress: &|_| {},
    }
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

    fn stage_with(&self, paths: &[&str], overlays: Vec<OverlayInput>) -> StageResult {
        let cancel = AtomicBool::new(false);
        let paths: Vec<StagePath> = paths
            .iter()
            .map(|p| StagePath {
                folder: None,
                path: p.to_string(),
            })
            .collect();
        stage(
            &self.engine,
            &self.repo,
            &SnapshotRequest {
                overlays,
                ..Default::default()
            },
            &quiet(&cancel),
            &paths,
        )
        .unwrap()
    }

    fn stage(&self, paths: &[&str]) -> StageResult {
        self.stage_with(paths, vec![])
    }

    fn stage_all(&self) -> StageResult {
        let cancel = AtomicBool::new(false);
        stage_all(
            &self.engine,
            &self.repo,
            &SnapshotRequest::default(),
            &quiet(&cancel),
        )
        .unwrap()
    }

    fn unstage(&self, paths: &[&str]) -> StageResult {
        let paths: Vec<StagePath> = paths
            .iter()
            .map(|p| StagePath {
                folder: None,
                path: p.to_string(),
            })
            .collect();
        unstage(
            &mut self.repo.lock().unwrap(),
            self.engine.folders(),
            &paths,
        )
        .unwrap()
    }

    fn commit(&self, message: &str) -> Result<Created> {
        commit_index(&mut self.repo.lock().unwrap(), &by(message))
    }

    fn status_with(&self, overlays: Vec<OverlayInput>) -> Status {
        status_with(
            &self.engine,
            &self.repo,
            &SnapshotRequest {
                overlays,
                ..Default::default()
            },
        )
        .1
    }

    fn status(&self) -> Status {
        self.status_with(vec![])
    }

    /// The index's tree listing (its only folder).
    fn index(&self) -> std::collections::BTreeMap<String, String> {
        let repo = self.repo.lock().unwrap();
        let state = index_state(&repo).unwrap();
        match state.folders.values().next() {
            Some(tree) => tree_listing(&repo, *tree),
            None => Default::default(),
        }
    }

    fn overlay(&self, rel: &str, text: &str) -> OverlayInput {
        OverlayInput {
            path: clean_path_str(self.p(rel)),
            bytes: Arc::new(text.as_bytes().to_vec()),
            encoding: "utf8".into(),
            line_ending: "lf".into(),
            version: 5,
        }
    }
}

/// `path -> "staged:<kind> unstaged:<kind>"` for every entry with either.
fn layers(status: &Status) -> Vec<String> {
    status
        .entries
        .iter()
        .filter(|e| e.staged.is_some() || e.unstaged.is_some())
        .map(|e| {
            format!(
                "{} staged:{} unstaged:{}",
                e.path,
                e.staged
                    .as_ref()
                    .map_or("-".into(), |c| format!("{:?}", c.kind)),
                e.unstaged
                    .as_ref()
                    .map_or("-".into(), |c| format!("{:?}", c.kind))
            )
        })
        .collect()
}

#[test]
fn a_new_repository_starts_with_an_empty_index_and_every_file_unstaged() {
    let w = World::new("idx-initial");
    write(&w.p("a.txt"), "a");
    write(&w.p("dir/b.txt"), "b");
    assert!(w.index().is_empty());
    let status = w.status();
    assert_eq!(status.index, "head");
    assert_eq!(
        layers(&status),
        vec![
            "a.txt staged:- unstaged:Added",
            "dir/b.txt staged:- unstaged:Added"
        ]
    );
    // Nothing is committed or staged by itself.
    assert!(matches!(w.commit("nothing"), Err(LgError::NothingToCommit)));
    assert!(matches!(
        resolve_head(&w.repo.lock().unwrap()),
        HeadState::Unborn { .. }
    ));
}

#[test]
fn stage_modified_added_and_deleted_then_commit_exactly_the_index() {
    let w = World::new("idx-stage");
    write(&w.p("foo.txt"), "A");
    write(&w.p("gone.txt"), "going");
    w.stage_all();
    w.commit("base").unwrap();
    assert!(
        w.status().entries.is_empty(),
        "clean after the first commit"
    );

    write(&w.p("foo.txt"), "B");
    write(&w.p("new.txt"), "new");
    std::fs::remove_file(w.p("gone.txt")).unwrap();
    let before = listing(&w.f.project);
    let staged = w.stage(&["foo.txt", "new.txt", "gone.txt"]);
    assert_eq!(staged.changed.len(), 3);
    // Staging never touches the working tree.
    assert_eq!(listing(&w.f.project), before);
    assert_eq!(
        layers(&w.status()),
        vec![
            "foo.txt staged:Modified unstaged:-",
            "gone.txt staged:Deleted unstaged:-",
            "new.txt staged:Added unstaged:-",
        ]
    );
    // The deletion is an absent entry, never an empty file.
    assert!(!w.index().contains_key("gone.txt"));

    // HEAD=A, index=B, working=C: the commit takes B, C stays unstaged.
    write(&w.p("foo.txt"), "C");
    let commit = w.commit("B").unwrap();
    let repo = w.repo.lock().unwrap();
    let tree = folder_tree(&repo, commit.commit.root.0);
    assert_eq!(
        tree_listing(&repo, tree)["foo.txt"],
        format!("file {}", blob_id(b"B"))
    );
    drop(repo);
    assert_eq!(std::fs::read(w.p("foo.txt")).unwrap(), b"C");
    let status = w.status();
    assert_eq!(status.index, "head", "after a commit the index is HEAD");
    assert_eq!(layers(&status), vec!["foo.txt staged:- unstaged:Modified"]);
    // Nothing staged: nothing to commit.
    assert!(matches!(w.commit("again"), Err(LgError::NothingToCommit)));
}

#[test]
fn unstage_returns_paths_to_head_and_leaves_the_working_tree_alone() {
    let w = World::new("idx-unstage");
    write(&w.p("foo.txt"), "A");
    w.stage_all();
    w.commit("base").unwrap();
    write(&w.p("foo.txt"), "B");
    write(&w.p("new.txt"), "new");
    w.stage(&["foo.txt", "new.txt"]);
    let head_index = w.unstage(&["foo.txt"]);
    assert_eq!(head_index.changed.len(), 1);
    assert_eq!(
        layers(&w.status()),
        vec![
            "foo.txt staged:- unstaged:Modified",
            "new.txt staged:Added unstaged:-"
        ]
    );
    w.unstage(&["new.txt"]);
    assert_eq!(
        layers(&w.status()),
        vec![
            "foo.txt staged:- unstaged:Modified",
            "new.txt staged:- unstaged:Added"
        ]
    );
    assert!(w.index_equals_head());
    assert_eq!(std::fs::read(w.p("new.txt")).unwrap(), b"new");
}

impl World {
    fn index_equals_head(&self) -> bool {
        index_info(&self.repo.lock().unwrap()).unwrap().equals_head
    }
}

#[test]
fn without_a_head_unstaging_empties_the_index_and_touches_nothing_else() {
    let w = World::new("idx-unborn");
    write(&w.p("a.txt"), "a");
    w.stage(&["a.txt"]);
    assert_eq!(layers(&w.status()), vec!["a.txt staged:Added unstaged:-"]);
    w.unstage(&["a.txt"]);
    assert!(w.index().is_empty());
    assert!(w.p("a.txt").exists());
    assert!(matches!(
        resolve_head(&w.repo.lock().unwrap()),
        HeadState::Unborn { .. }
    ));
    // Stage all, unstage all: back to empty, and still no ref for an empty index.
    w.stage_all();
    unstage_all(&mut w.repo.lock().unwrap(), w.engine.folders()).unwrap();
    assert!(w.index().is_empty());
    let name = RefName::new(INDEX_REF).unwrap();
    assert!(!w.repo.lock().unwrap().refs().refs.contains_key(&name));
}

#[test]
fn a_directory_is_staged_whole_with_the_same_exclusions_as_snapshots() {
    let w = World::new("idx-dir");
    write(&w.p("keep.txt"), "k");
    w.stage_all();
    w.commit("base").unwrap();
    write(&w.p("src/a.rs"), "a");
    write(&w.p("src/deep/b.rs"), "b");
    write(&w.p("src/node_modules/x.js"), "left out");
    write(&w.p("src/.env"), "secret");
    std::fs::create_dir_all(w.p("src/empty")).unwrap();
    write(&w.p("other.txt"), "not staged");
    w.stage(&["src"]);
    let index = w.index();
    assert!(index.contains_key("src/a.rs"));
    assert!(index.contains_key("src/deep/b.rs"));
    assert_eq!(index["src/empty"], "dir");
    assert!(!index
        .keys()
        .any(|k| k.contains("node_modules") || k.ends_with(".env")));
    assert!(!index.contains_key("other.txt"));
}

#[test]
fn a_dirty_document_is_staged_without_being_saved() {
    let w = World::new("idx-dirty");
    write(&w.p("foo.txt"), "A");
    w.stage_all();
    w.commit("A").unwrap();
    let unsaved = vec![w.overlay("foo.txt", "B")];
    assert_eq!(
        layers(&w.status_with(unsaved.clone())),
        vec!["foo.txt staged:- unstaged:Modified"]
    );
    w.stage_with(&["foo.txt"], unsaved.clone());
    assert_eq!(std::fs::read(w.p("foo.txt")).unwrap(), b"A", "not saved");
    assert_eq!(
        layers(&w.status_with(unsaved.clone())),
        vec!["foo.txt staged:Modified unstaged:-"]
    );
    w.commit("B").unwrap();
    let status = w.status_with(unsaved);
    assert!(layers(&status).is_empty(), "{:?}", layers(&status));
    // Still unsaved on disk: the disk comparison says so.
    assert!(status.entries.iter().any(|e| e.disk.is_some()));
}

#[test]
fn a_file_over_the_limit_is_staged_as_recorded_everywhere_hashed_not_stored() {
    let w = World::with_limit("idx-large", 1024);
    write(&w.p("big.bin"), vec![1u8; 4000]);
    let staged = w.stage(&["big.bin"]);
    assert_eq!(staged.unstored, vec!["big.bin"]);
    assert_eq!(
        w.index()["big.bin"],
        format!("unstored 4000 {}", blob_id(&[1u8; 4000]))
    );
}

#[test]
fn staging_is_deterministic_and_stage_then_unstage_is_head_again() {
    let w = World::new("idx-determinism");
    write(&w.p("a.txt"), "a");
    w.stage_all();
    w.commit("base").unwrap();
    write(&w.p("a.txt"), "changed");
    let first = w.stage(&["a.txt"]).index.commit;
    w.unstage(&["a.txt"]);
    assert!(w.index_equals_head());
    let again = w.stage(&["a.txt"]).index.commit;
    assert_eq!(
        first, again,
        "the same staged tree is the same index commit"
    );
    // Staging what is already staged changes nothing.
    let same = w.stage(&["a.txt"]);
    assert!(same.changed.is_empty());
    assert_eq!(same.unchanged.len(), 1);
}

#[test]
fn chosen_hunks_are_staged_and_the_rest_stays_unstaged() {
    let w = World::new("idx-hunks");
    let old: String = (1..=30).map(|i| format!("line {i}\n")).collect();
    write(&w.p("f.txt"), &old);
    w.stage_all();
    w.commit("base").unwrap();
    let new = old
        .replace("line 3\n", "line three\n")
        .replace("line 27\n", "line twenty-seven\n");
    write(&w.p("f.txt"), &new);
    // The diff the user sees: index (HEAD) to the workspace.
    let cancel = AtomicBool::new(false);
    let (_, diff) = w
        .engine
        .diff_workspace(
            &w.repo,
            &SnapshotRequest::default(),
            &quiet(&cancel),
            None,
            &DiffOptions::default(),
        )
        .unwrap();
    let entry = &diff.entries[0];
    assert_eq!(entry.line_diff.as_ref().unwrap().hunks.len(), 2);
    let expected = (
        entry.old.as_ref().map(|s| s.id.0),
        entry.new.as_ref().map(|s| s.id.0),
    );
    let hunk = |hunks: &[usize], expected| {
        stage_hunks(
            &w.engine,
            &w.repo,
            &SnapshotRequest::default(),
            &quiet(&cancel),
            None,
            "f.txt",
            hunks,
            expected,
        )
    };
    hunk(&[0], expected).unwrap();
    let staged_text = {
        let repo = w.repo.lock().unwrap();
        let index = index_state(&repo).unwrap();
        let tree = *index.folders.values().next().unwrap();
        let entry = repo.read_tree(&tree).unwrap().entries()[0].clone();
        String::from_utf8(repo.read_blob(&entry.id, u64::MAX).unwrap()).unwrap()
    };
    assert!(staged_text.contains("line three") && staged_text.contains("line 27\n"));
    assert_eq!(
        layers(&w.status()),
        vec!["f.txt staged:Modified unstaged:Modified"]
    );
    // The workspace file was not touched.
    assert_eq!(std::fs::read_to_string(w.p("f.txt")).unwrap(), new);
    // The same selection again, from a diff that is no longer current: refused.
    assert!(matches!(
        hunk(&[0], expected),
        Err(LgError::StaleSelection(_))
    ));
    // Binary files are never staged in parts.
    write(&w.p("bin.dat"), [0u8, 1, 2]);
    let binary = hunk_for(&w, "bin.dat", &[0]);
    assert!(
        matches!(binary, Err(LgError::PartialStagingUnsupported(_))),
        "{binary:?}"
    );
}

fn hunk_for(w: &World, path: &str, hunks: &[usize]) -> Result<StageResult> {
    let cancel = AtomicBool::new(false);
    let request = SnapshotRequest::default();
    // Persisted, so its trees can be read from the store.
    let snap = persist(&w.engine, &w.repo);
    let repo = w.repo.lock().unwrap();
    let index = index_state(&repo).unwrap();
    let empty = Tree::default().id();
    let find_in = |tree: ObjectId| {
        if tree == empty {
            return None;
        }
        repo.read_tree(&tree)
            .unwrap()
            .entries()
            .iter()
            .find(|e| e.name.as_str() == path)
            .map(|e| e.id)
    };
    let old = index.folders.values().next().and_then(|t| find_in(*t));
    let new = find_in(snap.folders[0].effective_tree.0);
    drop(repo);
    stage_hunks(
        &w.engine,
        &w.repo,
        &request,
        &quiet(&cancel),
        None,
        path,
        hunks,
        (old, new),
    )
}

#[test]
fn content_that_was_not_stored_cannot_be_staged_in_parts() {
    let w = World::with_limit("idx-hunks-large", 1024);
    write(&w.p("big.txt"), "x\n".repeat(1000));
    let result = hunk_for(&w, "big.txt", &[0]);
    assert!(
        matches!(result, Err(LgError::ContentUnavailableForStaging(_))),
        "{result:?}"
    );
}

#[test]
fn the_index_survives_reopening_and_a_crash_while_it_moves_leaves_it_old_or_new() {
    let w = World::new("idx-persist");
    write(&w.p("a.txt"), "a");
    w.stage_all();
    w.commit("base").unwrap();
    write(&w.p("a.txt"), "staged");
    let staged = w.stage(&["a.txt"]).index;
    let World { f, repo, .. } = w;
    drop(repo);
    let reopened = f.open().unwrap();
    assert_eq!(index_info(&reopened).unwrap().commit, staged.commit);
    assert!(reopened.verify(true).is_empty());
    drop(reopened);

    for point in [
        FaultPoint::SegmentWritten,
        FaultPoint::SegmentRenamed,
        FaultPoint::ReflogAppended,
        FaultPoint::RefsWritten,
    ] {
        let repo = Mutex::new(f.open().unwrap());
        let engine = engine_for(&repo, &f.project);
        let before = index_info(&repo.lock().unwrap()).unwrap().commit;
        write(&f.project.join("a.txt"), format!("crash at {point:?}"));
        let crashed = catch_unwind(AssertUnwindSafe(|| {
            let cancel = AtomicBool::new(false);
            fault::arm(point);
            let result = stage(
                &engine,
                &repo,
                &SnapshotRequest::default(),
                &quiet(&cancel),
                &[StagePath {
                    folder: None,
                    path: "a.txt".into(),
                }],
            );
            fault::disarm();
            result
        }));
        fault::disarm();
        assert!(crashed.is_err(), "{point:?}");
        drop(repo);
        let reopened = f.open().unwrap();
        let after = index_info(&reopened).unwrap().commit;
        if point == FaultPoint::RefsWritten {
            assert_ne!(after, before, "{point:?}: the new index");
        } else {
            assert_eq!(after, before, "{point:?}: the old index");
        }
        assert!(reopened.verify(true).is_empty(), "{point:?}");
    }
}
