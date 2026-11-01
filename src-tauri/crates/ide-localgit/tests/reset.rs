//! LG-05: reset -- soft, mixed, and hard plans.

mod common;

use common::*;
use ide_localgit::branches::*;
use ide_localgit::fault::{self, FaultPoint};
use ide_localgit::history::*;
use ide_localgit::index::*;
use ide_localgit::reset::*;
use ide_localgit::restore::RestoreConflict;
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

    fn commit(&self, message: &str) -> ObjectId {
        let cancel = AtomicBool::new(false);
        stage_all(
            &self.engine,
            &self.repo,
            &SnapshotRequest::default(),
            &quiet(&cancel),
        )
        .unwrap();
        commit_index(
            &mut self.repo.lock().unwrap(),
            &CommitRequest {
                message: message.into(),
                author: Author {
                    name: "T".into(),
                    id: "t".into(),
                },
                time_ms: 0,
                tz_offset_min: 0,
            },
        )
        .unwrap()
        .commit
        .id
        .0
    }

    fn layers(&self) -> Vec<String> {
        let status = status(&self.engine, &self.repo);
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

    fn head(&self) -> HeadState {
        resolve_head(&self.repo.lock().unwrap())
    }

    fn plan_hard(
        &self,
        target: ResetTarget,
        policy: ResetPolicy,
        overlays: Vec<OverlayInput>,
    ) -> HardResetPlan {
        let cancel = AtomicBool::new(false);
        self.engine
            .plan_reset_hard(
                &self.repo,
                &SnapshotRequest {
                    overlays,
                    ..Default::default()
                },
                &quiet(&cancel),
                &target,
                policy,
            )
            .unwrap()
            .1
    }
}

fn head_commit(state: &HeadState) -> Option<ObjectId> {
    state.commit()
}

#[test]
fn soft_moves_head_and_keeps_the_index_and_the_working_tree() {
    let w = World::new("reset-soft");
    write(&w.p("a.txt"), "1");
    let c1 = w.commit("one");
    write(&w.p("a.txt"), "2");
    let c2 = w.commit("two");
    let before = listing(&w.f.project);
    let done = reset_soft(
        &mut w.repo.lock().unwrap(),
        w.engine.folders(),
        &ResetTarget::Commit(c1),
    )
    .unwrap();
    assert_eq!(done.from.unwrap().0, c2);
    assert_eq!(head_commit(&w.head()), Some(c1));
    assert!(matches!(w.head(), HeadState::Branch { ref name, .. } if name == "main"));
    // The index still holds c2's tree: the difference is staged.
    assert_eq!(w.layers(), vec!["a.txt staged:Modified unstaged:-"]);
    assert_eq!(
        listing(&w.f.project),
        before,
        "the working tree was not touched"
    );
    // Committing it gives c2's tree again.
    let again = w.commit("two again");
    let repo = w.repo.lock().unwrap();
    assert_eq!(
        repo.read_commit(&again).unwrap().root,
        repo.read_commit(&c2).unwrap().root
    );
}

#[test]
fn mixed_moves_head_and_the_index_and_leaves_the_working_tree() {
    let w = World::new("reset-mixed");
    write(&w.p("a.txt"), "1");
    let c1 = w.commit("one");
    write(&w.p("a.txt"), "2");
    write(&w.p("b.txt"), "added in two");
    w.commit("two");
    write(&w.p("a.txt"), "3 (local)");
    reset_mixed(&mut w.repo.lock().unwrap(), &ResetTarget::Commit(c1)).unwrap();
    assert_eq!(head_commit(&w.head()), Some(c1));
    assert!(index_info(&w.repo.lock().unwrap()).unwrap().equals_head);
    assert_eq!(
        w.layers(),
        vec![
            "a.txt staged:- unstaged:Modified",
            "b.txt staged:- unstaged:Added"
        ]
    );
    assert_eq!(std::fs::read(w.p("a.txt")).unwrap(), b"3 (local)");
}

#[test]
fn targets_are_commits_branches_or_tags_and_bad_ones_are_refused() {
    let w = World::new("reset-targets");
    write(&w.p("a.txt"), "1");
    let c1 = w.commit("one");
    {
        let mut repo = w.repo.lock().unwrap();
        create_tag(&mut repo, "v1", None).unwrap();
        create_branch(&mut repo, "old", None).unwrap();
    }
    write(&w.p("a.txt"), "2");
    let c2 = w.commit("two");
    let mut repo = w.repo.lock().unwrap();
    reset_mixed(&mut repo, &ResetTarget::Tag("v1".into())).unwrap();
    assert_eq!(resolve_head(&repo).commit(), Some(c1));
    // The tag did not move; the other branch did not move.
    assert_eq!(get_tag(&repo, "v1").unwrap().commit.0, c1);
    reset_mixed(&mut repo, &ResetTarget::Commit(c2)).unwrap();
    reset_mixed(&mut repo, &ResetTarget::Branch("old".into())).unwrap();
    assert_eq!(resolve_head(&repo).commit(), Some(c1));
    assert!(matches!(
        reset_mixed(&mut repo, &ResetTarget::Branch("missing".into())),
        Err(LgError::NotFound(_))
    ));
    assert!(matches!(
        reset_mixed(&mut repo, &ResetTarget::Tag("nope".into())),
        Err(LgError::NotFound(_))
    ));
    let root = repo.read_commit(&c1).unwrap().root;
    assert!(matches!(
        reset_mixed(&mut repo, &ResetTarget::Commit(root)),
        Err(LgError::WrongKind { .. })
    ));
    // Every move is in the reflog, as a reset.
    let resets = repo
        .reflog()
        .unwrap()
        .into_iter()
        .filter(|r| matches!(r, ReflogRecord::Update { op, .. } if op == "reset"))
        .count();
    assert!(resets >= 3);
}

#[test]
fn a_detached_reset_moves_head_and_no_branch() {
    let w = World::new("reset-detached");
    write(&w.p("a.txt"), "1");
    let c1 = w.commit("one");
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
    reset_soft(
        &mut w.repo.lock().unwrap(),
        w.engine.folders(),
        &ResetTarget::Commit(c1),
    )
    .unwrap();
    assert_eq!(
        w.head(),
        HeadState::Detached {
            commit: ObjectIdText(c1)
        }
    );
    assert_eq!(
        get_branch(&w.repo.lock().unwrap(), "main")
            .unwrap()
            .commit
            .0,
        c2
    );
}

#[test]
fn a_hard_reset_plan_refuses_to_lose_any_kind_of_work() {
    let w = World::new("reset-hard-refuse");
    write(&w.p("a.txt"), "1");
    write(&w.p("doc.txt"), "doc 1");
    write(&w.p("staged.txt"), "s1");
    let c1 = w.commit("one");
    write(&w.p("a.txt"), "2");
    write(&w.p("new-in-two.txt"), "n");
    w.commit("two");
    // Local work of every kind.
    write(&w.p("a.txt"), "local");
    write(&w.p("staged.txt"), "staged change");
    let cancel = AtomicBool::new(false);
    stage(
        &w.engine,
        &w.repo,
        &SnapshotRequest::default(),
        &quiet(&cancel),
        &[StagePath {
            folder: None,
            path: "staged.txt".into(),
        }],
    )
    .unwrap();
    write(&w.p("untracked.txt"), "never touched");
    let dirty = OverlayInput {
        path: clean_path_str(w.p("doc.txt")),
        bytes: Arc::new(b"unsaved".to_vec()),
        encoding: "utf8".into(),
        line_ending: "lf".into(),
        version: 2,
    };
    let plan = w.plan_hard(
        ResetTarget::Commit(c1),
        ResetPolicy::RefuseIfDirty,
        vec![dirty.clone()],
    );
    let mut kinds: Vec<String> = plan
        .restore
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
    kinds.sort();
    kinds.dedup();
    assert_eq!(
        kinds,
        vec![
            "DirtyDocumentWouldBeOverwritten",
            "StagedChangeConflict",
            "UnstagedChangeWouldBeOverwritten",
        ]
    );
    // The untracked file the target does not have is never part of it.
    assert!(!plan
        .restore
        .operations
        .iter()
        .any(|op| op.path == "untracked.txt"));
    assert!(!plan
        .restore
        .conflicts
        .iter()
        .any(|c| format!("{c:?}").contains("untracked.txt")));

    // Explicitly destructive: no conflicts, and the dirty document is to be replaced.
    let plan = w.plan_hard(
        ResetTarget::Commit(c1),
        ResetPolicy::AllowDestructive,
        vec![dirty],
    );
    assert!(
        plan.restore.conflicts.is_empty(),
        "{:?}",
        plan.restore.conflicts
    );
    let ops: Vec<String> = plan
        .restore
        .operations
        .iter()
        .map(|o| format!("{:?} {}", o.kind, o.path))
        .collect();
    assert_eq!(
        ops,
        vec![
            "RemoveFile new-in-two.txt",
            "WriteFile a.txt",
            "WriteFile staged.txt"
        ]
    );
    assert_eq!(plan.restore.documents.len(), 1);
    assert_eq!(plan.restore.documents[0].path, "doc.txt");
    // A plan is only a plan.
    assert_eq!(std::fs::read(w.p("a.txt")).unwrap(), b"local");
}

#[test]
fn an_untracked_file_where_the_target_has_one_is_a_conflict() {
    let w = World::new("reset-hard-collision");
    write(&w.p("keep.txt"), "k");
    write(&w.p("later.txt"), "tracked in c1");
    let c1 = w.commit("one");
    std::fs::remove_file(w.p("later.txt")).unwrap();
    w.commit("two drops it");
    write(&w.p("later.txt"), "untracked, different");
    let plan = w.plan_hard(ResetTarget::Commit(c1), ResetPolicy::RefuseIfDirty, vec![]);
    assert!(matches!(
        plan.restore.conflicts.as_slice(),
        [RestoreConflict::UnstagedChangeWouldBeOverwritten { path, .. }] if path == "later.txt"
    ));
}

#[test]
fn a_clean_hard_reset_plan_changes_what_differs_and_finish_moves_head_and_index() {
    let w = World::new("reset-hard-clean");
    write(&w.p("a.txt"), "1");
    let c1 = w.commit("one");
    write(&w.p("a.txt"), "2");
    write(&w.p("b.txt"), "b");
    let c2 = w.commit("two");
    let plan = w.plan_hard(ResetTarget::Commit(c1), ResetPolicy::RefuseIfDirty, vec![]);
    assert!(plan.restore.conflicts.is_empty());
    assert_eq!(plan.restore.operations.len(), 2);
    // (The app's executor changes the disk; here the refs.)
    let done = finish_hard(&mut w.repo.lock().unwrap(), &plan).unwrap();
    assert_eq!(done.from.unwrap().0, c2);
    assert_eq!(head_commit(&w.head()), Some(c1));
    // A plan made before the refs moved is refused.
    let stale = w.plan_hard(ResetTarget::Commit(c2), ResetPolicy::RefuseIfDirty, vec![]);
    create_tag(&mut w.repo.lock().unwrap(), "moved", None).unwrap();
    assert!(matches!(
        finish_hard(&mut w.repo.lock().unwrap(), &stale),
        Err(LgError::StaleRevision { .. })
    ));
}

#[test]
fn a_crash_while_a_reset_moves_the_refs_leaves_the_old_or_the_new_state() {
    for point in [
        FaultPoint::ReflogPartlyAppended,
        FaultPoint::ReflogAppended,
        FaultPoint::RefsWritten,
    ] {
        let w = World::new("reset-crash");
        write(&w.p("a.txt"), "1");
        let c1 = w.commit("one");
        write(&w.p("a.txt"), "2");
        let c2 = w.commit("two");
        let crashed = catch_unwind(AssertUnwindSafe(|| {
            let mut repo = w.repo.lock().unwrap_or_else(|p| p.into_inner());
            fault::arm(point);
            let done = reset_soft(&mut repo, w.engine.folders(), &ResetTarget::Commit(c1));
            fault::disarm();
            done
        }));
        fault::disarm();
        assert!(crashed.is_err());
        let World { f, repo, .. } = w;
        drop(repo);
        let reopened = f.open().unwrap();
        let head = resolve_head(&reopened).commit();
        let index = index_info(&reopened).unwrap();
        if point == FaultPoint::RefsWritten {
            assert_eq!(head, Some(c1), "{point:?}");
            assert!(!index.equals_head, "the index kept c2's tree");
        } else {
            assert_eq!(head, Some(c2), "{point:?}");
            assert!(index.equals_head);
        }
        assert!(reopened.verify(true).is_empty(), "{point:?}");
    }
}
