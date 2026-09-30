//! LG-04: branches, tags, detached HEAD, and switch plans.

mod common;

use common::*;
use ide_localgit::branches::*;
use ide_localgit::fault::{self, FaultPoint};
use ide_localgit::history::*;
use ide_localgit::index::*;
use ide_localgit::restore::{OpKind, RestoreConflict};
use ide_localgit::switch::{finish, SwitchPlan, SwitchTarget};
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

    /// Stages everything and commits it.
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

    fn head(&self) -> HeadState {
        resolve_head(&self.repo.lock().unwrap())
    }

    fn plan_with(&self, target: SwitchTarget, overlays: Vec<OverlayInput>) -> SwitchPlan {
        let cancel = AtomicBool::new(false);
        self.engine
            .plan_switch(
                &self.repo,
                &SnapshotRequest {
                    overlays,
                    ..Default::default()
                },
                &quiet(&cancel),
                &target,
            )
            .unwrap()
            .1
    }

    fn plan(&self, target: SwitchTarget) -> SwitchPlan {
        self.plan_with(target, vec![])
    }
}

fn branch(name: &str) -> SwitchTarget {
    SwitchTarget::Branch(name.into())
}

fn kinds(plan: &SwitchPlan) -> Vec<String> {
    let mut out: Vec<String> = plan
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
    out.sort();
    out
}

#[test]
fn branches_are_made_listed_and_never_move_head() {
    let w = World::new("br-basics");
    // Nothing to start a branch from yet.
    assert!(matches!(
        create_branch(&mut w.repo.lock().unwrap(), "early", None),
        Err(LgError::Unborn)
    ));
    write(&w.p("a.txt"), "a");
    let c1 = w.commit("one");
    let head_before = w.head();
    let feature = create_branch(&mut w.repo.lock().unwrap(), "feature/login", None).unwrap();
    assert_eq!(feature.commit.0, c1);
    assert!(!feature.current);
    assert_eq!(w.head(), head_before, "HEAD did not move");
    write(&w.p("a.txt"), "b");
    let c2 = w.commit("two");
    let repo = w.repo.lock().unwrap();
    let branches = list_branches(&repo);
    let summary: Vec<(String, bool, Option<bool>)> = branches
        .iter()
        .map(|b| (b.name.clone(), b.current, b.merged))
        .collect();
    assert_eq!(
        summary,
        vec![
            ("feature/login".into(), false, Some(true)),
            ("main".into(), true, Some(true)),
        ]
    );
    assert_eq!(get_branch(&repo, "main").unwrap().commit.0, c2);
    assert_eq!(get_branch(&repo, "feature/login").unwrap().commit.0, c1);
    assert!(branches.iter().all(|b| b.upstream.is_none()));
    assert!(matches!(
        get_branch(&repo, "nope"),
        Err(LgError::NotFound(_))
    ));
}

#[test]
fn branch_names_are_validated_and_never_collide() {
    let w = World::new("br-names");
    write(&w.p("a.txt"), "a");
    w.commit("one");
    let mut repo = w.repo.lock().unwrap();
    for bad in [
        "",
        "  ",
        "../escape",
        "a b",
        "HEAD",
        "x.lock",
        "back\\slash",
        "ctl\u{7}",
    ] {
        assert!(
            matches!(
                create_branch(&mut repo, bad, None),
                Err(LgError::InvalidName(_))
            ),
            "{bad:?}"
        );
    }
    create_branch(&mut repo, "topic", None).unwrap();
    assert!(matches!(
        create_branch(&mut repo, "topic", None),
        Err(LgError::AlreadyExists(_))
    ));
    // A branch cannot also be a folder of branches, either way round, in any case.
    assert!(matches!(
        create_branch(&mut repo, "topic/sub", None),
        Err(LgError::InvalidName(_))
    ));
    create_branch(&mut repo, "group/one", None).unwrap();
    assert!(matches!(
        create_branch(&mut repo, "group", None),
        Err(LgError::InvalidName(_))
    ));
    assert!(create_branch(&mut repo, "TOPIC", None).is_err());
    // A start point that is not a commit.
    let root = repo
        .read_commit(&repo.refs().head_commit().unwrap())
        .unwrap()
        .root;
    assert!(matches!(
        create_branch(&mut repo, "bad-start", Some(root)),
        Err(LgError::WrongKind { .. })
    ));
}

#[test]
fn deleting_a_branch_is_refused_when_current_or_unmerged() {
    let w = World::new("br-delete");
    write(&w.p("a.txt"), "a");
    let c1 = w.commit("one");
    {
        let mut repo = w.repo.lock().unwrap();
        assert!(matches!(
            delete_branch(&mut repo, "main"),
            Err(LgError::CurrentBranch(_))
        ));
        assert!(matches!(
            delete_branch(&mut repo, "missing"),
            Err(LgError::NotFound(_))
        ));
        create_branch(&mut repo, "merged", None).unwrap();
        delete_branch(&mut repo, "merged").unwrap();
        assert!(get_branch(&repo, "merged").is_err());
        // A branch with a commit nothing else reaches: kept.
        create_branch(&mut repo, "side", Some(c1)).unwrap();
    }
    // Detach at c1, commit there, and point `side` at it.
    let plan = w.plan(SwitchTarget::Commit(c1));
    finish(&mut w.repo.lock().unwrap(), &plan).unwrap();
    write(&w.p("a.txt"), "side work");
    let lonely = w.commit("side work");
    {
        let mut repo = w.repo.lock().unwrap();
        let revision = repo.refs().revision;
        repo.update_refs(
            revision,
            &[RefUpdate {
                name: RefName::new("refs/heads/side").unwrap(),
                expected: Some(c1),
                new: Some(lonely),
            }],
            Some(Head::Symbolic(RefName::new("refs/heads/main").unwrap())),
            "test",
            "move side",
        )
        .unwrap();
        assert!(matches!(
            delete_branch(&mut repo, "side"),
            Err(LgError::NotMerged(_))
        ));
        // Tagged, it is reached: now it can go.
        create_tag(&mut repo, "keep-side", Some(lonely)).unwrap();
        delete_branch(&mut repo, "side").unwrap();
    }
}

#[test]
fn tags_are_fixed_and_never_replaced() {
    let w = World::new("br-tags");
    write(&w.p("a.txt"), "a");
    let c1 = w.commit("one");
    let head = w.head();
    let tag = create_tag(&mut w.repo.lock().unwrap(), "v1.0", None).unwrap();
    assert_eq!(tag.commit.0, c1);
    assert_eq!(w.head(), head, "a tag does not move HEAD");
    write(&w.p("a.txt"), "b");
    w.commit("two");
    let mut repo = w.repo.lock().unwrap();
    assert_eq!(
        get_tag(&repo, "v1.0").unwrap().commit.0,
        c1,
        "it stays where it was"
    );
    assert!(matches!(
        create_tag(&mut repo, "v1.0", None),
        Err(LgError::AlreadyExists(_))
    ));
    assert!(matches!(
        create_tag(&mut repo, "../v2", None),
        Err(LgError::InvalidName(_))
    ));
    assert_eq!(list_tags(&repo).len(), 1);
    delete_tag(&mut repo, "v1.0").unwrap();
    assert!(matches!(
        delete_tag(&mut repo, "v1.0"),
        Err(LgError::NotFound(_))
    ));
    assert!(list_tags(&repo).is_empty());
    // A branch and a tag may share a name: different namespaces.
    create_tag(&mut repo, "main", None).unwrap();
}

#[test]
fn a_clean_switch_changes_only_what_differs_and_moves_head_and_the_index_together() {
    let w = World::new("br-switch-plan");
    write(&w.p("shared.txt"), "same on both");
    write(&w.p("foo.txt"), "A");
    let c1 = w.commit("main");
    create_branch(&mut w.repo.lock().unwrap(), "feature", None).unwrap();
    write(&w.p("foo.txt"), "B");
    write(&w.p("only-on-main.txt"), "m");
    let c2 = w.commit("main moves on");
    // An untracked file and an unrelated local change are carried over.
    write(&w.p("untracked.txt"), "mine");
    let plan = w.plan(branch("feature"));
    assert!(
        plan.restore.conflicts.is_empty(),
        "{:?}",
        plan.restore.conflicts
    );
    let ops: Vec<String> = plan
        .restore
        .operations
        .iter()
        .map(|op| format!("{:?} {}", op.kind, op.path))
        .collect();
    assert_eq!(
        ops,
        vec!["RemoveFile only-on-main.txt", "WriteFile foo.txt"]
    );
    assert_eq!(plan.from.unwrap().0, c2);
    assert_eq!(plan.commit.0, c1);
    // (The disk is changed by the app's executor; here only the refs.)
    finish(&mut w.repo.lock().unwrap(), &plan).unwrap();
    match w.head() {
        HeadState::Branch { name, commit, .. } => {
            assert_eq!(name, "feature");
            assert_eq!(commit.0, c1);
        }
        other => panic!("{other:?}"),
    }
    let repo = w.repo.lock().unwrap();
    let index = index_info(&repo).unwrap();
    assert!(index.equals_head, "the index is the target's tree");
    // A plan whose refs moved since is refused, never applied over them.
    drop(repo);
    let stale = w.plan(branch("main"));
    create_tag(&mut w.repo.lock().unwrap(), "moved-the-refs", None).unwrap();
    assert!(matches!(
        finish(&mut w.repo.lock().unwrap(), &stale),
        Err(LgError::StaleRevision { .. })
    ));
}

#[test]
fn a_switch_that_would_lose_work_is_refused_with_every_reason() {
    let w = World::new("br-switch-conflicts");
    write(&w.p("foo.txt"), "A");
    write(&w.p("doc.txt"), "doc A");
    write(&w.p("keep.txt"), "k");
    w.commit("main");
    create_branch(&mut w.repo.lock().unwrap(), "feature", None).unwrap();
    write(&w.p("foo.txt"), "B");
    write(&w.p("doc.txt"), "doc B");
    write(&w.p("added-on-main.txt"), "m");
    w.commit("main moves on");
    // feature lacks added-on-main.txt; switching would remove it.
    // Local work: foo.txt edited (C), doc.txt dirty in the editor, an untracked file where
    // the target has one, and something staged.
    write(&w.p("foo.txt"), "C");
    let overlay = OverlayInput {
        path: clean_path_str(w.p("doc.txt")),
        bytes: Arc::new(b"unsaved".to_vec()),
        encoding: "utf8".into(),
        line_ending: "lf".into(),
        version: 2,
    };
    write(&w.p("keep.txt"), "staged change");
    let cancel = AtomicBool::new(false);
    stage(
        &w.engine,
        &w.repo,
        &SnapshotRequest::default(),
        &quiet(&cancel),
        &[StagePath {
            folder: None,
            path: "keep.txt".into(),
        }],
    )
    .unwrap();
    let plan = w.plan_with(branch("feature"), vec![overlay]);
    assert_eq!(
        kinds(&plan),
        vec![
            "DirtyDocumentWouldBeOverwritten",
            "StagedChangeConflict",
            "UnstagedChangeWouldBeOverwritten",
        ]
    );
    let lost: Vec<&str> = plan
        .restore
        .conflicts
        .iter()
        .filter_map(|c| match c {
            RestoreConflict::UnstagedChangeWouldBeOverwritten { path, .. } => Some(path.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(lost, vec!["foo.txt"]);
    // A plan is only a plan: nothing moved.
    assert_eq!(std::fs::read(w.p("foo.txt")).unwrap(), b"C");
    match w.head() {
        HeadState::Branch { name, .. } => assert_eq!(name, "main"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn an_untracked_file_where_the_target_has_one_is_a_conflict_unless_identical() {
    let w = World::new("br-switch-untracked");
    write(&w.p("a.txt"), "a");
    w.commit("main");
    create_branch(&mut w.repo.lock().unwrap(), "feature", None).unwrap();
    // feature gets new.txt; main does not have it.
    let plan = w.plan(branch("feature"));
    finish(&mut w.repo.lock().unwrap(), &plan).unwrap();
    write(&w.p("new.txt"), "feature's");
    w.commit("feature adds new.txt");
    let back = w.plan(branch("main"));
    assert_eq!(
        back.restore
            .operations
            .iter()
            .map(|o| o.kind)
            .collect::<Vec<_>>(),
        vec![OpKind::RemoveFile]
    );
    finish(&mut w.repo.lock().unwrap(), &back).unwrap();
    std::fs::remove_file(w.p("new.txt")).unwrap();
    // On main, an untracked new.txt with other content: in the way.
    write(&w.p("new.txt"), "mine, untracked");
    assert_eq!(
        kinds(&w.plan(branch("feature"))),
        vec!["UnstagedChangeWouldBeOverwritten"]
    );
    // With exactly the target's content: nothing to do for it.
    write(&w.p("new.txt"), "feature's");
    let plan = w.plan(branch("feature"));
    assert!(plan.restore.conflicts.is_empty());
    assert!(plan.restore.operations.is_empty());
}

#[test]
fn detached_head_commits_move_head_and_no_branch() {
    let w = World::new("br-detached");
    write(&w.p("a.txt"), "1");
    let c1 = w.commit("one");
    write(&w.p("a.txt"), "2");
    let c2 = w.commit("two");
    let plan = w.plan(SwitchTarget::Commit(c1));
    assert!(plan.branch.is_none());
    finish(&mut w.repo.lock().unwrap(), &plan).unwrap();
    assert_eq!(
        w.head(),
        HeadState::Detached {
            commit: ObjectIdText(c1)
        }
    );
    // (What the executor would have done.)
    write(&w.p("a.txt"), "1");
    write(&w.p("a.txt"), "detached work");
    let c3 = w.commit("detached");
    assert_eq!(
        w.head(),
        HeadState::Detached {
            commit: ObjectIdText(c3)
        }
    );
    let repo = w.repo.lock().unwrap();
    assert_eq!(
        get_branch(&repo, "main").unwrap().commit.0,
        c2,
        "main did not move"
    );
    let page = history(&repo, None, 10);
    assert_eq!(
        page.items.iter().map(|c| c.id.0).collect::<Vec<_>>(),
        vec![c3, c1]
    );
    // The reflog recorded HEAD's moves.
    let head_moves = repo
        .reflog()
        .unwrap()
        .into_iter()
        .filter(|r| matches!(r, ReflogRecord::Update { name, .. } if name == "HEAD"))
        .count();
    assert!(head_moves >= 2);
}

#[test]
fn branches_tags_head_and_the_index_survive_reopening() {
    let w = World::new("br-reopen");
    write(&w.p("a.txt"), "a");
    let c1 = w.commit("one");
    {
        let mut repo = w.repo.lock().unwrap();
        create_branch(&mut repo, "feature", None).unwrap();
        create_tag(&mut repo, "v1", None).unwrap();
    }
    let plan = w.plan(branch("feature"));
    finish(&mut w.repo.lock().unwrap(), &plan).unwrap();
    write(&w.p("a.txt"), "staged");
    let cancel = AtomicBool::new(false);
    let staged = stage_all(
        &w.engine,
        &w.repo,
        &SnapshotRequest::default(),
        &quiet(&cancel),
    )
    .unwrap()
    .index;
    let World { f, repo, .. } = w;
    drop(repo);
    let reopened = f.open().unwrap();
    assert!(matches!(
        resolve_head(&reopened),
        HeadState::Branch { ref name, .. } if name == "feature"
    ));
    assert_eq!(list_branches(&reopened).len(), 2);
    assert_eq!(get_tag(&reopened, "v1").unwrap().commit.0, c1);
    assert_eq!(index_info(&reopened).unwrap().commit, staged.commit);
    assert!(reopened.verify(true).is_empty());
}

#[test]
fn a_crash_while_a_branch_or_tag_moves_leaves_it_old_or_new() {
    for point in [
        FaultPoint::ReflogPartlyAppended,
        FaultPoint::ReflogAppended,
        FaultPoint::RefsWritten,
    ] {
        let w = World::new("br-crash");
        write(&w.p("a.txt"), "a");
        w.commit("one");
        let crashed = catch_unwind(AssertUnwindSafe(|| {
            let mut repo = w.repo.lock().unwrap_or_else(|p| p.into_inner());
            fault::arm(point);
            let made = create_branch(&mut repo, "feature", None);
            fault::disarm();
            made
        }));
        fault::disarm();
        assert!(crashed.is_err());
        let World { f, repo, .. } = w;
        drop(repo);
        let reopened = f.open().unwrap();
        let exists = get_branch(&reopened, "feature").is_ok();
        assert_eq!(exists, point == FaultPoint::RefsWritten, "{point:?}");
        assert!(reopened.verify(true).is_empty(), "{point:?}");
    }
}
