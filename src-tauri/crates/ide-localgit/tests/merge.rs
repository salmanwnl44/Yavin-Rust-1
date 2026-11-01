//! LG-06: merge and cherry-pick -- planning, conflicts, resolution, continue and abort, at the
//! store's level. The disk's side is carried out here by a small stand-in for the app's
//! executor (the app's own tests run the real one, with Module 03 and Module 04).

mod common;

use common::*;
use ide_localgit::branches::*;
use ide_localgit::fault::{self, FaultPoint};
use ide_localgit::history::*;
use ide_localgit::index::*;
use ide_localgit::merge::*;
use ide_localgit::operation::*;
use ide_localgit::reset::{ResetPolicy, ResetTarget};
use ide_localgit::restore::{OpKind, RestoreConflict, RestorePlan};
use ide_localgit::switch::{finish as finish_switch, SwitchTarget};
use ide_localgit::*;
use ide_workspace::file_tree::clean_path_str;
use std::collections::BTreeMap;
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

fn by(message: &str) -> CommitRequest {
    CommitRequest {
        message: message.into(),
        author: Author {
            name: "Merger".into(),
            id: "merger".into(),
        },
        time_ms: 7,
        tz_offset_min: 0,
    }
}

type Files<'a> = &'a [(&'a str, Option<&'a str>)];

impl World {
    fn new(label: &str) -> World {
        let f = Fixture::new(label);
        let repo = Mutex::new(f.open().unwrap());
        let engine = engine_for(&repo, &f.project);
        World { f, repo, engine }
    }

    fn p(&self, rel: &str) -> std::path::PathBuf {
        self.f.project.join(rel)
    }

    fn set(&self, files: Files) {
        for (path, content) in files {
            match content {
                Some(text) => write(&self.p(path), text),
                None => {
                    let _ = std::fs::remove_file(self.p(path));
                }
            }
        }
    }

    fn read(&self, rel: &str) -> String {
        String::from_utf8(std::fs::read(self.p(rel)).unwrap()).unwrap()
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
        commit_index(&mut self.repo.lock().unwrap(), &by(message))
            .unwrap()
            .commit
            .id
            .0
    }

    fn head(&self) -> Option<ObjectId> {
        resolve_head(&self.repo.lock().unwrap()).commit()
    }

    /// Carries a restore plan out, as the app's executor would (files and folders only).
    fn apply(&self, plan: &RestorePlan) {
        assert!(plan.conflicts.is_empty(), "{:?}", plan.conflicts);
        let repo = self.repo.lock().unwrap();
        for op in &plan.operations {
            let path = self.p(&op.path);
            match op.kind {
                OpKind::RemoveFile | OpKind::RemoveLink => std::fs::remove_file(&path).unwrap(),
                OpKind::RemoveDirectory => std::fs::remove_dir(&path).unwrap(),
                OpKind::CreateDirectory => std::fs::create_dir_all(&path).unwrap(),
                OpKind::WriteFile => {
                    let bytes = repo.read_blob(&op.blob.unwrap().0, u64::MAX).unwrap();
                    write(&path, bytes);
                }
                OpKind::CreateLink => panic!("no links in these tests"),
            }
        }
    }

    fn switch(&self, branch: &str) {
        let cancel = AtomicBool::new(false);
        let (_, plan) = self
            .engine
            .plan_switch(
                &self.repo,
                &SnapshotRequest::default(),
                &quiet(&cancel),
                &SwitchTarget::Branch(branch.into()),
            )
            .unwrap();
        self.apply(&plan.restore);
        finish_switch(&mut self.repo.lock().unwrap(), &plan).unwrap();
    }

    fn plan_with(
        &self,
        request: OperationRequest,
        overlays: Vec<OverlayInput>,
    ) -> Result<OperationPlan> {
        let cancel = AtomicBool::new(false);
        self.engine
            .plan_operation(
                &self.repo,
                &SnapshotRequest {
                    overlays,
                    ..Default::default()
                },
                &quiet(&cancel),
                &request,
                &by("unused"),
            )
            .map(|(_, plan)| plan)
    }

    fn plan_merge(&self, branch: &str) -> OperationPlan {
        self.plan_with(
            OperationRequest::Merge {
                target: ResetTarget::Branch(branch.into()),
                message: None,
            },
            vec![],
        )
        .unwrap()
    }

    fn plan_pick(&self, commit: ObjectId) -> Result<OperationPlan> {
        self.plan_with(OperationRequest::CherryPick { commit }, vec![])
    }

    /// Begin, change the disk, finish: what the app does.
    fn run(&self, plan: &OperationPlan) -> Finished {
        begin(&mut self.repo.lock().unwrap(), plan).unwrap();
        self.apply(plan.restore.as_ref().unwrap());
        finish_apply(&mut self.repo.lock().unwrap()).unwrap()
    }

    fn try_resolve(
        &self,
        path: &str,
        choice: ResolveChoice,
        overlays: Vec<OverlayInput>,
    ) -> Result<ResolvePlan> {
        let cancel = AtomicBool::new(false);
        self.engine
            .plan_resolve(
                &self.repo,
                &SnapshotRequest {
                    overlays,
                    ..Default::default()
                },
                &quiet(&cancel),
                None,
                path,
                choice,
                ResetPolicy::RefuseIfDirty,
            )
            .map(|(_, plan)| plan)
    }

    fn resolve(&self, path: &str, choice: ResolveChoice) -> OperationState {
        let plan = self.try_resolve(path, choice, vec![]).unwrap();
        record_resolve(&mut self.repo.lock().unwrap(), &plan).unwrap();
        if let Some(restore) = &plan.restore {
            self.apply(restore);
        }
        finish_resolve(&mut self.repo.lock().unwrap(), &plan).unwrap()
    }

    fn abort(&self) {
        let cancel = AtomicBool::new(false);
        let (_, plan) = self
            .engine
            .plan_abort(
                &self.repo,
                &SnapshotRequest::default(),
                &quiet(&cancel),
                ResetPolicy::RefuseIfDirty,
            )
            .unwrap();
        self.apply(&plan);
        finish_abort(&mut self.repo.lock().unwrap()).unwrap();
    }

    fn state(&self) -> Option<OperationState> {
        current(&self.repo.lock().unwrap())
            .unwrap()
            .map(|(_, state)| state)
    }

    fn head_tree(&self) -> BTreeMap<String, String> {
        let repo = self.repo.lock().unwrap();
        let head = resolve_head(&repo).commit().unwrap();
        let root = repo.read_commit(&head).unwrap().root;
        tree_listing(&repo, folder_tree(&repo, root))
    }

    fn index_is_head(&self) -> bool {
        index_info(&self.repo.lock().unwrap()).unwrap().equals_head
    }
}

/// A base commit on main with `base`; `feature` then gets `theirs`, main `ours`; left on main.
fn diverge(label: &str, base: Files, ours: Files, theirs: Files) -> World {
    let w = World::new(label);
    w.set(base);
    w.commit("base");
    create_branch(&mut w.repo.lock().unwrap(), "feature", None).unwrap();
    w.switch("feature");
    w.set(theirs);
    w.commit("theirs");
    w.switch("main");
    w.set(ours);
    w.commit("ours");
    w
}

fn file(text: &str) -> String {
    format!("file {}", blob_id(text.as_bytes()))
}

fn kinds(conflicts: &[Conflict]) -> Vec<(String, ConflictKind)> {
    conflicts.iter().map(|c| (c.path.clone(), c.kind)).collect()
}

#[test]
fn the_merge_base_is_the_nearest_common_ancestor() {
    let w = diverge(
        "mg-base",
        &[("a.txt", Some("0"))],
        &[("a.txt", Some("ours"))],
        &[("b.txt", Some("theirs"))],
    );
    let repo = w.repo.lock().unwrap();
    let main = get_branch(&repo, "main").unwrap().commit.0;
    let feature = get_branch(&repo, "feature").unwrap().commit.0;
    let base = repo.read_commit(&main).unwrap().parents[0];
    assert_eq!(merge_base(&repo, main, feature).unwrap(), Some(base));
    assert_eq!(merge_base(&repo, feature, main).unwrap(), Some(base));
    assert_eq!(merge_base(&repo, main, base).unwrap(), Some(base));
}

#[test]
fn an_ancestor_is_already_merged_and_nothing_changes() {
    let w = World::new("mg-uptodate");
    w.set(&[("a.txt", Some("1"))]);
    w.commit("one");
    create_branch(&mut w.repo.lock().unwrap(), "old", None).unwrap();
    w.set(&[("a.txt", Some("2"))]);
    w.commit("two");
    let revision = w.repo.lock().unwrap().refs().revision;
    let disk = listing(&w.f.project);
    let plan = w.plan_merge("old");
    assert_eq!(plan.outcome, Outcome::UpToDate);
    assert!(plan.restore.is_none() && plan.state.is_none());
    assert_eq!(w.repo.lock().unwrap().refs().revision, revision);
    assert_eq!(listing(&w.f.project), disk);
}

#[test]
fn a_fast_forward_moves_the_branch_with_no_merge_commit() {
    let w = World::new("mg-ff");
    w.set(&[("a.txt", Some("1")), ("keep.txt", Some("k"))]);
    let c1 = w.commit("one");
    create_branch(&mut w.repo.lock().unwrap(), "feature", None).unwrap();
    w.switch("feature");
    w.set(&[("a.txt", Some("2")), ("new/b.txt", Some("b"))]);
    let c2 = w.commit("two");
    w.switch("main");
    assert_eq!(w.head(), Some(c1));
    // Unrelated local work is carried over.
    w.set(&[("scratch.txt", Some("mine"))]);
    let plan = w.plan_merge("feature");
    assert_eq!(plan.outcome, Outcome::FastForward);
    let done = w.run(&plan);
    assert_eq!(done.commit.unwrap().id.0, c2);
    assert_eq!(w.head(), Some(c2));
    assert_eq!(
        get_branch(&w.repo.lock().unwrap(), "main")
            .unwrap()
            .commit
            .0,
        c2
    );
    assert_eq!(w.read("a.txt"), "2");
    assert_eq!(w.read("new/b.txt"), "b");
    assert_eq!(w.read("scratch.txt"), "mine");
    assert!(w.index_is_head());
    assert!(w.state().is_none());
    let reflog = w.repo.lock().unwrap().reflog().unwrap();
    assert!(reflog.iter().any(
        |r| matches!(r, ReflogRecord::Update { op, reason, .. } if op == "merge" && reason.starts_with("fast-forward"))
    ));
}

#[test]
fn a_clean_three_way_merge_makes_a_commit_with_two_parents() {
    let w = diverge(
        "mg-clean",
        &[
            ("shared.txt", Some("1\n2\n3\n4\n5\n6\n7\n")),
            ("gone.txt", Some("x")),
        ],
        &[
            ("shared.txt", Some("1 ours\n2\n3\n4\n5\n6\n7\n")),
            ("ours.txt", Some("o")),
        ],
        &[
            ("shared.txt", Some("1\n2\n3\n4\n5\n6\n7 theirs\n")),
            ("theirs.txt", Some("t")),
            ("gone.txt", None),
        ],
    );
    let ours = w.head().unwrap();
    let theirs = get_branch(&w.repo.lock().unwrap(), "feature")
        .unwrap()
        .commit
        .0;
    let plan = w.plan_merge("feature");
    assert_eq!(plan.outcome, Outcome::Merged);
    assert!(plan.conflicts.is_empty());
    let done = w.run(&plan);
    let merged = done.commit.unwrap();
    assert_eq!(
        merged.parents,
        vec![ObjectIdText(ours), ObjectIdText(theirs)]
    );
    assert_eq!(merged.message, "Merge branch 'feature'");
    let tree = w.head_tree();
    assert_eq!(
        tree["shared.txt"],
        file("1 ours\n2\n3\n4\n5\n6\n7 theirs\n")
    );
    assert_eq!(tree["ours.txt"], file("o"));
    assert_eq!(tree["theirs.txt"], file("t"));
    assert!(!tree.contains_key("gone.txt"));
    assert_eq!(w.read("shared.txt"), "1 ours\n2\n3\n4\n5\n6\n7 theirs\n");
    assert!(!w.p("gone.txt").exists());
    assert!(w.index_is_head());
    assert!(w.state().is_none());
    // Neither parent was rewritten.
    let repo = w.repo.lock().unwrap();
    assert_eq!(get_branch(&repo, "feature").unwrap().commit.0, theirs);
    assert!(repo.read_commit(&ours).is_ok());
    assert!(repo.verify(true).is_empty());
}

#[test]
fn every_kind_of_conflict_is_recorded_and_nothing_is_committed() {
    let w = diverge(
        "mg-kinds",
        &[
            ("mm.txt", Some("a\nb\nc\n")),
            ("dm.txt", Some("dm")),
            ("md.txt", Some("md")),
            ("both-gone.txt", Some("x")),
        ],
        &[
            ("mm.txt", Some("a\nours\nc\n")),
            ("aa.txt", Some("ours added\n")),
            ("dm.txt", None),
            ("md.txt", Some("md, ours")),
            ("both-gone.txt", None),
            ("df", Some("a file in ours")),
        ],
        &[
            ("mm.txt", Some("a\ntheirs\nc\n")),
            ("aa.txt", Some("theirs added\n")),
            ("dm.txt", Some("dm, theirs")),
            ("md.txt", None),
            ("both-gone.txt", None),
            ("df/inside.txt", Some("a folder in theirs")),
        ],
    );
    let head = w.head();
    let plan = w.plan_merge("feature");
    assert_eq!(plan.outcome, Outcome::Conflicted);
    assert_eq!(
        kinds(&plan.conflicts),
        vec![
            ("aa.txt".to_string(), ConflictKind::AddAdd),
            ("df".to_string(), ConflictKind::DirectoryFile),
            ("dm.txt".to_string(), ConflictKind::DeleteModify),
            ("md.txt".to_string(), ConflictKind::ModifyDelete),
            ("mm.txt".to_string(), ConflictKind::ModifyModify),
        ]
    );
    let done = w.run(&plan);
    assert!(done.commit.is_none());
    assert_eq!(w.head(), head, "HEAD did not move");
    // The working tree: markers for text, theirs to look at for deleted/modified, ours kept.
    assert_eq!(
        w.read("mm.txt"),
        "a\n<<<<<<< HEAD (main)\nours\n=======\ntheirs\n>>>>>>> branch 'feature'\nc\n"
    );
    assert!(w.read("aa.txt").contains("=======\ntheirs added\n"));
    assert_eq!(w.read("dm.txt"), "dm, theirs");
    assert_eq!(w.read("md.txt"), "md, ours");
    assert_eq!(w.read("df"), "a file in ours");
    let state = w.state().unwrap();
    assert_eq!(state.phase, Phase::Conflicts);
    assert_eq!(state.unresolved(), 5);
    assert!(state
        .conflicts
        .iter()
        .all(|c| c.resolution == Resolution::Unresolved));
    let mm = state.conflicts.iter().find(|c| c.path == "mm.txt").unwrap();
    assert!(mm.markers && !mm.binary);
    assert!(mm.base.is_some() && mm.ours.is_some() && mm.theirs.is_some());
    // The index: conflicted paths hold ours -- nothing about them is staged.
    let status = status(&w.engine, &w.repo);
    for path in ["mm.txt", "aa.txt", "md.txt", "df"] {
        let entry = status.entries.iter().find(|e| e.path == path);
        assert!(entry.is_none_or(|e| e.staged.is_none()), "{path} staged");
    }
}

#[test]
fn a_file_against_a_link_is_a_type_conflict() {
    let w = World::new("mg-type");
    w.set(&[("f", Some("a"))]);
    let base = w.commit("base");
    // Theirs: `f` became a link (made as objects: creating links needs privileges on Windows).
    let theirs = {
        let mut repo = w.repo.lock().unwrap();
        let root = repo.read_commit(&base).unwrap().root;
        let folders = repo.read_root(&root).unwrap().folders;
        let (folder, tree) = folders.iter().next().map(|(k, v)| (k.clone(), *v)).unwrap();
        let workspace = repo.meta().workspace.clone();
        let mut txn = repo.begin_write().unwrap();
        let target = txn.put_blob(b"elsewhere").unwrap();
        let _ = tree;
        let tree = Tree::new(vec![TreeEntry {
            name: EntryName::new("f").unwrap(),
            kind: EntryKind::Symlink(LinkKind::File),
            id: target,
        }])
        .unwrap();
        let tree = txn.put_tree(&tree).unwrap();
        let root = txn
            .put_root(&Root {
                folders: [(folder, tree)].into_iter().collect(),
            })
            .unwrap();
        let commit = txn
            .put_commit(&Commit {
                root,
                disk_root: None,
                parents: vec![base],
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
                message: "a link".into(),
            })
            .unwrap();
        txn.commit().unwrap();
        commit
    };
    w.set(&[("f", Some("b"))]);
    w.commit("ours");
    let plan = w
        .plan_with(
            OperationRequest::Merge {
                target: ResetTarget::Commit(theirs),
                message: None,
            },
            vec![],
        )
        .unwrap();
    assert_eq!(
        kinds(&plan.conflicts),
        vec![("f".into(), ConflictKind::TypeChange)]
    );
    // Ours is kept on disk: nothing to write.
    assert!(plan.restore.unwrap().operations.is_empty());
}

#[test]
fn binary_and_unstored_files_conflict_without_markers() {
    let w = World::new("mg-binary");
    let engine = engine_with(&w.repo.lock().unwrap(), &w.f.project, 1024);
    let w = World { engine, ..w };
    write(&w.p("img.bin"), [0u8, 1, 2]);
    write(&w.p("big.bin"), vec![b'a'; 4000]);
    w.commit("base");
    create_branch(&mut w.repo.lock().unwrap(), "feature", None).unwrap();
    w.switch("feature");
    write(&w.p("img.bin"), [0u8, 9, 9]);
    write(&w.p("big.bin"), vec![b'b'; 4000]);
    w.commit("theirs");
    // Back to main by hand: the big file's old content was never stored, so no switch can
    // bring it back -- which is exactly what this test is about.
    {
        let mut repo = w.repo.lock().unwrap();
        let revision = repo.refs().revision;
        repo.update_refs(
            revision,
            &[],
            Some(Head::Symbolic(RefName::new("refs/heads/main").unwrap())),
            "test",
            "to main",
        )
        .unwrap();
    }
    write(&w.p("img.bin"), [0u8, 7, 7]);
    write(&w.p("big.bin"), vec![b'c'; 4000]);
    w.commit("ours");
    let plan = w.plan_merge("feature");
    let img = plan.conflicts.iter().find(|c| c.path == "img.bin").unwrap();
    assert!(img.binary && !img.markers);
    let big = plan.conflicts.iter().find(|c| c.path == "big.bin").unwrap();
    assert_eq!(big.unavailable.as_deref(), Some("notStored"));
    assert!(!big.markers);
    assert!(
        plan.restore.unwrap().operations.is_empty(),
        "ours stays on disk"
    );
}

#[test]
fn a_rename_on_one_side_carries_the_other_sides_change() {
    let w = diverge(
        "mg-rename",
        &[("old.txt", Some("line 1\nline 2\n"))],
        &[("old.txt", None), ("new.txt", Some("line 1\nline 2\n"))],
        &[("old.txt", Some("line 1\nline 2 changed\n"))],
    );
    let plan = w.plan_merge("feature");
    assert!(plan.conflicts.is_empty(), "{:?}", plan.conflicts);
    w.run(&plan);
    let tree = w.head_tree();
    assert!(!tree.contains_key("old.txt"));
    assert_eq!(tree["new.txt"], file("line 1\nline 2 changed\n"));
    assert_eq!(w.read("new.txt"), "line 1\nline 2 changed\n");
    assert!(!w.p("old.txt").exists());
}

#[test]
fn conflicts_survive_a_restart_and_block_everything_else() {
    let w = diverge(
        "mg-persist",
        &[("a.txt", Some("base\n"))],
        &[("a.txt", Some("ours\n"))],
        &[("a.txt", Some("theirs\n"))],
    );
    let plan = w.plan_merge("feature");
    w.run(&plan);
    let before = w.state().unwrap();
    let World { f, repo, .. } = w;
    drop(repo);
    let repo = Mutex::new(f.open().unwrap());
    let engine = engine_for(&repo, &f.project);
    let w = World { f, repo, engine };
    assert_eq!(w.state().unwrap(), before, "the same state after reopening");
    let blocked = |result: Result<()>| {
        assert!(
            matches!(result, Err(LgError::OperationInProgress(ref k)) if k == "merge"),
            "{result:?}"
        );
    };
    let cancel = AtomicBool::new(false);
    blocked(commit_index(&mut w.repo.lock().unwrap(), &by("no")).map(|_| ()));
    blocked(
        stage_all(
            &w.engine,
            &w.repo,
            &SnapshotRequest::default(),
            &quiet(&cancel),
        )
        .map(|_| ()),
    );
    blocked(unstage_all(&mut w.repo.lock().unwrap(), w.engine.folders()).map(|_| ()));
    blocked(
        ide_localgit::reset::reset_mixed(
            &mut w.repo.lock().unwrap(),
            &ResetTarget::Branch("feature".into()),
        )
        .map(|_| ()),
    );
    blocked(
        w.engine
            .plan_switch(
                &w.repo,
                &SnapshotRequest::default(),
                &quiet(&cancel),
                &SwitchTarget::Branch("feature".into()),
            )
            .map(|_| ()),
    );
    blocked(w.plan_pick(w.head().unwrap()).map(|_| ()));
    blocked(
        w.engine
            .plan_stash_push(
                &w.repo,
                &SnapshotRequest::default(),
                &quiet(&cancel),
                None,
                false,
            )
            .map(|_| ()),
    );
    // A checkpoint moves neither HEAD nor the index: allowed.
    let snap = persist(&w.engine, &w.repo);
    assert!(checkpoint_snapshot(
        &mut w.repo.lock().unwrap(),
        &snap,
        Source::Checkpoint,
        &by("during a merge")
    )
    .is_ok());
}

#[test]
fn take_ours_take_theirs_delete_manual_and_mark_resolved_then_continue() {
    let w = diverge(
        "mg-resolve",
        &[
            ("o.txt", Some("base\n")),
            ("t.txt", Some("base\n")),
            ("d.txt", Some("base\n")),
            ("m.txt", Some("base\n")),
            ("r.txt", Some("base\n")),
        ],
        &[
            ("o.txt", Some("ours\n")),
            ("t.txt", Some("ours\n")),
            ("d.txt", Some("ours\n")),
            ("m.txt", Some("ours\n")),
            ("r.txt", Some("ours\n")),
        ],
        &[
            ("o.txt", Some("theirs\n")),
            ("t.txt", Some("theirs\n")),
            ("d.txt", Some("theirs\n")),
            ("m.txt", Some("theirs\n")),
            ("r.txt", Some("theirs\n")),
        ],
    );
    let ours = w.head().unwrap();
    w.run(&w.plan_merge("feature"));
    // Continue is refused while anything is unresolved.
    assert!(matches!(
        finish_continue(&mut w.repo.lock().unwrap(), None, &by("")),
        Err(LgError::UnresolvedConflicts(5))
    ));
    w.resolve("o.txt", ResolveChoice::TakeOurs);
    assert_eq!(w.read("o.txt"), "ours\n");
    w.resolve("t.txt", ResolveChoice::TakeTheirs);
    assert_eq!(w.read("t.txt"), "theirs\n");
    w.resolve("d.txt", ResolveChoice::Delete);
    assert!(!w.p("d.txt").exists());
    // Manual: the document's text, unsaved -- the disk still has the markers.
    let edited = OverlayInput {
        path: clean_path_str(w.p("m.txt")),
        bytes: Arc::new(b"hand merged\n".to_vec()),
        encoding: "utf8".into(),
        line_ending: "lf".into(),
        version: 4,
    };
    let manual = w
        .try_resolve("m.txt", ResolveChoice::Manual, vec![edited])
        .unwrap();
    assert!(manual.restore.is_none(), "manual resolution writes nothing");
    finish_resolve(&mut w.repo.lock().unwrap(), &manual).unwrap();
    assert!(
        w.read("m.txt").contains("<<<<<<<"),
        "the disk was not written"
    );
    // Mark resolved: the file as it is -- refused while it still holds markers.
    assert!(matches!(
        w.try_resolve("r.txt", ResolveChoice::MarkResolved, vec![]),
        Err(LgError::ConflictMarkers(_))
    ));
    w.set(&[("r.txt", Some("edited and saved\n"))]);
    let state = w.resolve("r.txt", ResolveChoice::MarkResolved);
    assert_eq!(state.unresolved(), 0);
    let resolutions: Vec<Resolution> = state.conflicts.iter().map(|c| c.resolution).collect();
    assert_eq!(
        resolutions,
        vec![
            Resolution::Deleted,
            Resolution::Manual,
            Resolution::TakeOurs,
            Resolution::Resolved,
            Resolution::TakeTheirs
        ]
    );
    let created = finish_continue(&mut w.repo.lock().unwrap(), None, &by("")).unwrap();
    assert_eq!(created.commit.parents.len(), 2);
    assert_eq!(created.commit.parents[0], ObjectIdText(ours));
    let tree = w.head_tree();
    assert_eq!(tree["o.txt"], file("ours\n"));
    assert_eq!(tree["t.txt"], file("theirs\n"));
    assert!(!tree.contains_key("d.txt"));
    assert_eq!(tree["m.txt"], file("hand merged\n"));
    assert_eq!(tree["r.txt"], file("edited and saved\n"));
    assert!(w.state().is_none());
    assert!(w.index_is_head());
    let ops: Vec<String> = w
        .repo
        .lock()
        .unwrap()
        .reflog()
        .unwrap()
        .into_iter()
        .filter_map(|r| match r {
            ReflogRecord::Update { op, .. } => Some(op),
            _ => None,
        })
        .collect();
    assert!(ops.contains(&"merge-resolve".to_string()));
    assert!(ops.contains(&"merge-continue".to_string()));
}

#[test]
fn a_resolution_never_overwrites_the_users_edits_or_unsaved_text() {
    let w = diverge(
        "mg-resolve-safe",
        &[("a.txt", Some("base\n"))],
        &[("a.txt", Some("ours\n"))],
        &[("a.txt", Some("theirs\n"))],
    );
    w.run(&w.plan_merge("feature"));
    w.set(&[("a.txt", Some("my edits\n"))]);
    let plan = w
        .try_resolve("a.txt", ResolveChoice::TakeTheirs, vec![])
        .unwrap();
    assert!(plan.restore.unwrap().conflicts.iter().any(
        |c| matches!(c, RestoreConflict::UnstagedChangeWouldBeOverwritten { path, .. } if path == "a.txt")
    ));
    w.set(&[("a.txt", Some("ours\n"))]);
    let unsaved = OverlayInput {
        path: clean_path_str(w.p("a.txt")),
        bytes: Arc::new(b"typing...\n".to_vec()),
        encoding: "utf8".into(),
        line_ending: "lf".into(),
        version: 2,
    };
    let plan = w
        .try_resolve("a.txt", ResolveChoice::TakeTheirs, vec![unsaved.clone()])
        .unwrap();
    assert!(plan.restore.unwrap().conflicts.iter().any(
        |c| matches!(c, RestoreConflict::DirtyDocumentWouldBeOverwritten { path, .. } if path == "a.txt")
    ));
    assert!(matches!(
        w.try_resolve("a.txt", ResolveChoice::MarkResolved, vec![unsaved]),
        Err(LgError::UnsavedDocument(_))
    ));
    assert_eq!(w.state().unwrap().unresolved(), 1, "nothing was resolved");
}

#[test]
fn abort_puts_the_disk_and_index_back_and_head_never_moved() {
    let w = diverge(
        "mg-abort",
        &[("a.txt", Some("base\n")), ("b.txt", Some("b"))],
        &[("a.txt", Some("ours\n"))],
        &[
            ("a.txt", Some("theirs\n")),
            ("b.txt", Some("b theirs")),
            ("new/c.txt", Some("c")),
        ],
    );
    w.set(&[("unrelated.txt", Some("local work"))]);
    let head = w.head();
    let disk = listing(&w.f.project);
    let texts: Vec<String> = ["a.txt", "b.txt", "unrelated.txt"]
        .iter()
        .map(|p| w.read(p))
        .collect();
    w.run(&w.plan_merge("feature"));
    assert_eq!(w.read("b.txt"), "b theirs");
    w.resolve("a.txt", ResolveChoice::TakeTheirs);
    w.abort();
    assert_eq!(listing(&w.f.project), disk);
    let after: Vec<String> = ["a.txt", "b.txt", "unrelated.txt"]
        .iter()
        .map(|p| w.read(p))
        .collect();
    assert_eq!(after, texts);
    assert_eq!(w.head(), head);
    assert!(w.index_is_head());
    assert!(w.state().is_none());
    let reflog = w.repo.lock().unwrap().reflog().unwrap();
    assert!(reflog
        .iter()
        .any(|r| matches!(r, ReflogRecord::Update { op, .. } if op == "merge-abort")));
}

#[test]
fn abort_refuses_to_destroy_edits_made_since() {
    let w = diverge(
        "mg-abort-safe",
        &[("a.txt", Some("base\n"))],
        &[("a.txt", Some("ours\n"))],
        &[("a.txt", Some("theirs\n")), ("b.txt", Some("b"))],
    );
    w.run(&w.plan_merge("feature"));
    w.set(&[("b.txt", Some("edited after the merge"))]);
    let cancel = AtomicBool::new(false);
    let (_, plan) = w
        .engine
        .plan_abort(
            &w.repo,
            &SnapshotRequest::default(),
            &quiet(&cancel),
            ResetPolicy::RefuseIfDirty,
        )
        .unwrap();
    assert!(plan.conflicts.iter().any(
        |c| matches!(c, RestoreConflict::UntrackedFileCollision { path, .. } if path == "b.txt")
    ));
    // Only by explicit choice.
    let (_, plan) = w
        .engine
        .plan_abort(
            &w.repo,
            &SnapshotRequest::default(),
            &quiet(&cancel),
            ResetPolicy::AllowDestructive,
        )
        .unwrap();
    assert!(plan.conflicts.is_empty());
}

#[test]
fn staged_dirty_untracked_and_unsaved_work_refuse_a_merge_untouched() {
    let w = diverge(
        "mg-refuse",
        &[
            ("a.txt", Some("a")),
            ("b.txt", Some("b")),
            ("s.txt", Some("s")),
        ],
        &[("x.txt", Some("x"))],
        &[
            ("a.txt", Some("a theirs")),
            ("b.txt", Some("b theirs")),
            ("new.txt", Some("theirs")),
        ],
    );
    w.set(&[
        ("a.txt", Some("local change")),
        ("new.txt", Some("my untracked file")),
        ("s.txt", Some("staged")),
    ]);
    let cancel = AtomicBool::new(false);
    stage(
        &w.engine,
        &w.repo,
        &SnapshotRequest::default(),
        &quiet(&cancel),
        &[StagePath {
            folder: None,
            path: "s.txt".into(),
        }],
    )
    .unwrap();
    let unsaved = OverlayInput {
        path: clean_path_str(w.p("b.txt")),
        bytes: Arc::new(b"unsaved".to_vec()),
        encoding: "utf8".into(),
        line_ending: "lf".into(),
        version: 1,
    };
    let revision = w.repo.lock().unwrap().refs().revision;
    let disk = listing(&w.f.project);
    let plan = w
        .plan_with(
            OperationRequest::Merge {
                target: ResetTarget::Branch("feature".into()),
                message: None,
            },
            vec![unsaved],
        )
        .unwrap();
    let conflicts = plan.restore.unwrap().conflicts;
    let has = |want: &str, at: &str| {
        conflicts
            .iter()
            .any(|c| format!("{c:?}").starts_with(want) && format!("{c:?}").contains(at))
    };
    assert!(has("StagedChangeConflict", "s.txt"), "{conflicts:?}");
    assert!(
        has("UnstagedChangeWouldBeOverwritten", "a.txt"),
        "{conflicts:?}"
    );
    assert!(has("UntrackedFileCollision", "new.txt"), "{conflicts:?}");
    assert!(
        has("DirtyDocumentWouldBeOverwritten", "b.txt"),
        "{conflicts:?}"
    );
    assert_eq!(w.repo.lock().unwrap().refs().revision, revision);
    assert_eq!(listing(&w.f.project), disk);
    assert!(w.state().is_none());
}

#[test]
fn unrelated_histories_are_refused() {
    let w = World::new("mg-unrelated");
    w.set(&[("a.txt", Some("a"))]);
    w.commit("one");
    let other = write_commit(&mut w.repo.lock().unwrap(), "other", None);
    let result = w.plan_with(
        OperationRequest::Merge {
            target: ResetTarget::Commit(other),
            message: None,
        },
        vec![],
    );
    assert!(matches!(result, Err(LgError::UnrelatedHistories)));
}

#[test]
fn a_detached_head_merge_moves_only_head() {
    let w = diverge(
        "mg-detached",
        &[("a.txt", Some("a"))],
        &[("b.txt", Some("ours"))],
        &[("c.txt", Some("theirs"))],
    );
    let main = w.head().unwrap();
    let cancel = AtomicBool::new(false);
    let (_, plan) = w
        .engine
        .plan_switch(
            &w.repo,
            &SnapshotRequest::default(),
            &quiet(&cancel),
            &SwitchTarget::Commit(main),
        )
        .unwrap();
    finish_switch(&mut w.repo.lock().unwrap(), &plan).unwrap();
    let done = w.run(&w.plan_merge("feature"));
    let merged = done.commit.unwrap().id.0;
    let repo = w.repo.lock().unwrap();
    assert_eq!(
        resolve_head(&repo),
        HeadState::Detached {
            commit: ObjectIdText(merged)
        }
    );
    assert_eq!(
        get_branch(&repo, "main").unwrap().commit.0,
        main,
        "no branch moved"
    );
}

#[test]
fn cherry_pick_copies_a_change_as_a_new_commit_and_leaves_the_original() {
    let w = diverge(
        "cp-clean",
        &[("a.txt", Some("1\n2\n3\n4\n5\n")), ("b.txt", Some("b"))],
        &[("a.txt", Some("1 main\n2\n3\n4\n5\n"))],
        &[
            ("a.txt", Some("1\n2\n3\n4\n5 picked\n")),
            ("c.txt", Some("c")),
        ],
    );
    let head = w.head().unwrap();
    let picked = get_branch(&w.repo.lock().unwrap(), "feature")
        .unwrap()
        .commit
        .0;
    let original = w.repo.lock().unwrap().read_commit(&picked).unwrap();
    let plan = w.plan_pick(picked).unwrap();
    assert_eq!(plan.kind, OperationKind::CherryPick);
    assert_eq!(plan.outcome, Outcome::Merged);
    let done = w.run(&plan);
    let copy = done.commit.unwrap();
    assert_ne!(copy.id.0, picked, "a new identity");
    assert_eq!(copy.parents, vec![ObjectIdText(head)]);
    assert_eq!(
        copy.message,
        format!("theirs\n\n(cherry picked from Local Git commit {picked})")
    );
    let repo = w.repo.lock().unwrap();
    let made = repo.read_commit(&copy.id.0).unwrap();
    assert_eq!(made.meta["cherry-pick"], picked.to_hex());
    assert_eq!(made.author, original.author);
    assert_eq!(repo.read_commit(&picked).unwrap(), original, "untouched");
    assert_eq!(get_branch(&repo, "feature").unwrap().commit.0, picked);
    drop(repo);
    let tree = w.head_tree();
    assert_eq!(tree["a.txt"], file("1 main\n2\n3\n4\n5 picked\n"));
    assert_eq!(tree["c.txt"], file("c"));
    assert_eq!(w.read("c.txt"), "c");
}

#[test]
fn a_cherry_pick_with_conflicts_resolves_and_continues_or_aborts() {
    for abort in [false, true] {
        let w = diverge(
            if abort {
                "cp-conflict-abort"
            } else {
                "cp-conflict"
            },
            &[("a.txt", Some("base\n"))],
            &[("a.txt", Some("main\n"))],
            &[("a.txt", Some("picked\n"))],
        );
        let head = w.head().unwrap();
        let disk = listing(&w.f.project);
        let picked = get_branch(&w.repo.lock().unwrap(), "feature")
            .unwrap()
            .commit
            .0;
        let plan = w.plan_pick(picked).unwrap();
        assert_eq!(plan.outcome, Outcome::Conflicted);
        w.run(&plan);
        assert_eq!(w.state().unwrap().kind, OperationKind::CherryPick);
        if abort {
            w.abort();
            assert_eq!(w.read("a.txt"), "main\n");
            assert_eq!(listing(&w.f.project), disk);
            assert_eq!(w.head(), Some(head));
        } else {
            w.resolve("a.txt", ResolveChoice::TakeTheirs);
            let created = finish_continue(&mut w.repo.lock().unwrap(), None, &by("")).unwrap();
            assert_eq!(created.commit.parents, vec![ObjectIdText(head)]);
            assert_eq!(w.head_tree()["a.txt"], file("picked\n"));
        }
        assert!(w.state().is_none());
    }
}

#[test]
fn cherry_pick_refuses_merge_commits_and_empty_results() {
    let w = diverge(
        "cp-refuse",
        &[("a.txt", Some("a"))],
        &[("b.txt", Some("b"))],
        &[("c.txt", Some("c"))],
    );
    let done = w.run(&w.plan_merge("feature"));
    let merge = done.commit.unwrap().id.0;
    assert!(matches!(
        w.plan_pick(merge),
        Err(LgError::CherryPickMerge(_))
    ));
    // feature's change is already in HEAD: nothing to pick.
    let theirs = get_branch(&w.repo.lock().unwrap(), "feature")
        .unwrap()
        .commit
        .0;
    assert!(matches!(w.plan_pick(theirs), Err(LgError::NothingToCommit)));
}

#[test]
fn content_that_was_never_stored_is_never_written() {
    let w = World::new("cp-unavailable");
    let engine = engine_with(&w.repo.lock().unwrap(), &w.f.project, 1024);
    let w = World { engine, ..w };
    w.set(&[("a.txt", Some("a"))]);
    w.commit("base");
    write(&w.p("big.bin"), vec![1u8; 5000]);
    let picked = w.commit("adds a file over the limit");
    // Back to the base without it (by hand: the store never had its content).
    std::fs::remove_file(w.p("big.bin")).unwrap();
    let base = w.repo.lock().unwrap().read_commit(&picked).unwrap().parents[0];
    let cancel = AtomicBool::new(false);
    let _ = cancel;
    ide_localgit::reset::reset_mixed(&mut w.repo.lock().unwrap(), &ResetTarget::Commit(base))
        .unwrap();
    let plan = w.plan_pick(picked).unwrap();
    let restore = plan.restore.unwrap();
    assert!(restore.conflicts.iter().any(|c| matches!(
        c,
        RestoreConflict::HistoricalContentUnavailable { path, .. } if path == "big.bin"
    )));
    assert!(!w.p("big.bin").exists());
    assert!(w.state().is_none());
}

#[test]
fn a_crash_at_any_ref_step_leaves_the_old_or_the_new_state() {
    for point in [
        FaultPoint::SegmentWritten,
        FaultPoint::ReflogAppended,
        FaultPoint::RefsWritten,
    ] {
        // Recording the operation (before the disk changes).
        let w = diverge(
            "mg-crash-begin",
            &[("a.txt", Some("base\n"))],
            &[("a.txt", Some("ours\n"))],
            &[("a.txt", Some("theirs\n"))],
        );
        let plan = w.plan_merge("feature");
        let crashed = catch_unwind(AssertUnwindSafe(|| {
            fault::arm(point);
            let result = begin(&mut w.repo.lock().unwrap(), &plan);
            fault::disarm();
            result
        }));
        fault::disarm();
        assert!(crashed.is_err(), "{point:?}");
        let World { f, repo, .. } = w;
        drop(repo);
        let reopened = f.open().unwrap();
        let recorded = current(&reopened).unwrap();
        if point == FaultPoint::RefsWritten {
            assert_eq!(recorded.unwrap().1.phase, Phase::Applying, "{point:?}");
        } else {
            assert!(recorded.is_none(), "{point:?}");
        }
        assert!(reopened.verify(true).is_empty(), "{point:?}");
        drop(reopened);
        if point == FaultPoint::SegmentWritten {
            // Completing a clean merge writes no object: only the refs move.
            continue;
        }

        // Completing it: HEAD, index and state move together, or not at all.
        let w = diverge(
            "mg-crash-finish",
            &[("a.txt", Some("a"))],
            &[("b.txt", Some("ours"))],
            &[("c.txt", Some("theirs"))],
        );
        let head = w.head();
        let plan = w.plan_merge("feature");
        begin(&mut w.repo.lock().unwrap(), &plan).unwrap();
        w.apply(plan.restore.as_ref().unwrap());
        let crashed = catch_unwind(AssertUnwindSafe(|| {
            fault::arm(point);
            let result = finish_apply(&mut w.repo.lock().unwrap());
            fault::disarm();
            result
        }));
        fault::disarm();
        assert!(crashed.is_err(), "{point:?}");
        let World { f, repo, .. } = w;
        drop(repo);
        let reopened = f.open().unwrap();
        let state = current(&reopened).unwrap();
        let now = resolve_head(&reopened).commit();
        if point == FaultPoint::RefsWritten {
            assert!(state.is_none(), "{point:?}");
            assert_ne!(now, head);
            assert_eq!(
                reopened.read_commit(&now.unwrap()).unwrap().parents.len(),
                2
            );
        } else {
            assert_eq!(
                state.unwrap().1.phase,
                Phase::Applying,
                "{point:?}: still to finish"
            );
            assert_eq!(now, head, "{point:?}: never completed by itself");
        }
        assert!(reopened.verify(true).is_empty(), "{point:?}");
    }
}

#[test]
fn a_read_only_store_cannot_merge() {
    let w = diverge(
        "mg-readonly",
        &[("a.txt", Some("a"))],
        &[("b.txt", Some("ours"))],
        &[("c.txt", Some("theirs"))],
    );
    let World { f, repo, .. } = w;
    let _writer = repo;
    // A second opener while the writer holds the store: read-only.
    let reader = Mutex::new(f.open().unwrap());
    assert!(matches!(reader.lock().unwrap().mode(), Mode::ReadOnly(_)));
    let engine = engine_for(&reader, &f.project);
    let disk = listing(&f.project);
    let cancel = AtomicBool::new(false);
    let result = engine.plan_operation(
        &reader,
        &SnapshotRequest::default(),
        &quiet(&cancel),
        &OperationRequest::Merge {
            target: ResetTarget::Branch("feature".into()),
            message: None,
        },
        &by(""),
    );
    assert!(
        matches!(result, Err(LgError::ReadOnly)),
        "{:?}",
        result.err()
    );
    assert_eq!(listing(&f.project), disk);
}
