//! LG-05: stash -- what a stash holds, its list, drop, and apply plans. (A push and a pop on a
//! real disk, through the executor, are the app's tests.)

mod common;

use common::*;
use ide_localgit::fault::{self, FaultPoint};
use ide_localgit::history::*;
use ide_localgit::index::*;
use ide_localgit::stash::*;
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

fn by(time_ms: i64) -> CommitRequest {
    CommitRequest {
        message: "unused".into(),
        author: Author {
            name: "T".into(),
            id: "t".into(),
        },
        time_ms,
        tz_offset_min: 0,
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
        let mut request = by(0);
        request.message = message.into();
        commit_index(&mut self.repo.lock().unwrap(), &request)
            .unwrap()
            .commit
            .id
            .0
    }

    fn stage(&self, path: &str) {
        let cancel = AtomicBool::new(false);
        stage(
            &self.engine,
            &self.repo,
            &SnapshotRequest::default(),
            &quiet(&cancel),
            &[StagePath {
                folder: None,
                path: path.into(),
            }],
        )
        .unwrap();
    }

    fn push_plan(&self, untracked: bool, overlays: Vec<OverlayInput>) -> Result<StashPushPlan> {
        let cancel = AtomicBool::new(false);
        self.engine
            .plan_stash_push(
                &self.repo,
                &SnapshotRequest {
                    overlays,
                    ..Default::default()
                },
                &quiet(&cancel),
                None,
                untracked,
            )
            .map(|(_, plan)| plan)
    }

    fn apply_plan(&self, id: &str, pop: bool) -> StashApplyPlan {
        let cancel = AtomicBool::new(false);
        self.engine
            .plan_stash_apply(
                &self.repo,
                &SnapshotRequest::default(),
                &quiet(&cancel),
                id,
                pop,
            )
            .unwrap()
            .1
    }

    /// A tree's listing, by root id (its only folder).
    fn listing_of(&self, root: ObjectId) -> std::collections::BTreeMap<String, String> {
        let repo = self.repo.lock().unwrap();
        let tree = folder_tree(&repo, root);
        tree_listing(&repo, tree)
    }
}

#[test]
fn nothing_to_stash_is_said_so() {
    let w = World::new("stash-nothing");
    write(&w.p("a.txt"), "a");
    w.commit("one");
    assert!(matches!(
        w.push_plan(false, vec![]),
        Err(LgError::NothingToStash)
    ));
    // An untracked file alone, not asked for: still nothing.
    write(&w.p("new.txt"), "untracked");
    assert!(matches!(
        w.push_plan(false, vec![]),
        Err(LgError::NothingToStash)
    ));
    assert_eq!(w.push_plan(true, vec![]).unwrap().counts.untracked, 1);
}

#[test]
fn a_stash_keeps_staged_and_unstaged_apart_and_untracked_only_when_asked() {
    let w = World::new("stash-contents");
    write(&w.p("foo.txt"), "A");
    write(&w.p("doc.txt"), "d");
    w.commit("one");
    // HEAD=A, index=B, working=C; a dirty document; an untracked file.
    write(&w.p("foo.txt"), "B");
    w.stage("foo.txt");
    write(&w.p("foo.txt"), "C");
    write(&w.p("untracked.txt"), "u");
    let dirty = OverlayInput {
        path: clean_path_str(w.p("doc.txt")),
        bytes: Arc::new(b"unsaved".to_vec()),
        encoding: "utf8".into(),
        line_ending: "lf".into(),
        version: 4,
    };
    let plan = w.push_plan(false, vec![dirty.clone()]).unwrap();
    assert_eq!(
        plan.counts,
        StashCounts {
            staged: 1,
            unstaged: 2,
            untracked: 0
        }
    );
    assert_eq!(
        w.listing_of(plan.index_root.0)["foo.txt"],
        format!("file {}", blob_id(b"B"))
    );
    let work = w.listing_of(plan.work_root.0);
    assert_eq!(work["foo.txt"], format!("file {}", blob_id(b"C")));
    assert_eq!(
        work["doc.txt"],
        format!("file {}", blob_id(b"unsaved")),
        "the unsaved text, not saved"
    );
    assert!(!work.contains_key("untracked.txt"));
    // Cleaning goes back to HEAD for the stashed paths only; the untracked file stays.
    let ops: Vec<String> = plan
        .restore
        .operations
        .iter()
        .map(|o| format!("{:?} {}", o.kind, o.path))
        .collect();
    assert_eq!(ops, vec!["WriteFile foo.txt"]);
    assert_eq!(
        plan.restore.documents.len(),
        1,
        "the dirty document is replaced (it is in the stash)"
    );
    assert_eq!(
        std::fs::read(w.p("doc.txt")).unwrap(),
        b"d",
        "nothing saved"
    );
    // With untracked files.
    let with = w.push_plan(true, vec![dirty]).unwrap();
    assert_eq!(with.counts.untracked, 1);
    assert!(w.listing_of(with.work_root.0).contains_key("untracked.txt"));
    assert!(with
        .restore
        .operations
        .iter()
        .any(|o| o.path == "untracked.txt"));
}

#[test]
fn stashes_are_listed_newest_first_dropped_by_id_and_survive_reopening() {
    let w = World::new("stash-list");
    write(&w.p("a.txt"), "a");
    let base = w.commit("one");
    let mut ids = Vec::new();
    for i in 0..3 {
        write(&w.p("a.txt"), format!("change {i}"));
        let plan = w.push_plan(false, vec![]).unwrap();
        let info = record(&mut w.repo.lock().unwrap(), &plan, &by(1000 + i)).unwrap();
        assert_eq!(info.base.unwrap().0, base);
        assert_eq!(info.branch.as_deref(), Some("main"));
        ids.push(info.id);
        // (The executor would clean the disk; here the file stays, and each stash differs.)
    }
    let repo = w.repo.lock().unwrap();
    let listed = list(&repo, 10).unwrap();
    assert_eq!(listed.total, 3);
    let got: Vec<&str> = listed.items.iter().map(|s| s.id.as_str()).collect();
    let mut expected: Vec<&str> = ids.iter().map(String::as_str).collect();
    expected.reverse();
    assert_eq!(got, expected, "newest first");
    assert_eq!(list(&repo, 1).unwrap().items.len(), 1);
    assert!(listed.items[0].message.starts_with("WIP on main: "));
    drop(repo);
    let objects = w.repo.lock().unwrap().object_count();
    drop_stash(&mut w.repo.lock().unwrap(), &ids[1]).unwrap();
    assert_eq!(
        w.repo.lock().unwrap().object_count(),
        objects,
        "nothing deleted"
    );
    assert!(matches!(
        drop_stash(&mut w.repo.lock().unwrap(), &ids[1]),
        Err(LgError::NotFound(_))
    ));
    assert!(matches!(
        drop_stash(&mut w.repo.lock().unwrap(), "../x"),
        Err(LgError::InvalidName(_))
    ));
    let World { f, repo, .. } = w;
    drop(repo);
    let reopened = f.open().unwrap();
    assert_eq!(list(&reopened, 10).unwrap().total, 2);
    assert!(reopened.verify(true).is_empty());
}

#[test]
fn an_apply_is_refused_when_it_would_merge_or_overwrite() {
    let w = World::new("stash-apply-conflicts");
    write(&w.p("foo.txt"), "A");
    write(&w.p("other.txt"), "o");
    w.commit("one");
    write(&w.p("foo.txt"), "stashed");
    write(&w.p("new.txt"), "untracked, stashed");
    let plan = w.push_plan(true, vec![]).unwrap();
    let stash = record(&mut w.repo.lock().unwrap(), &plan, &by(1)).unwrap();
    // (What cleaning would have left:)
    write(&w.p("foo.txt"), "A");
    std::fs::remove_file(w.p("new.txt")).unwrap();

    // HEAD moves on at foo.txt: applying would take a merge.
    write(&w.p("foo.txt"), "moved on");
    w.commit("two");
    // Something staged; an untracked file where the stash has one.
    write(&w.p("other.txt"), "staged");
    w.stage("other.txt");
    write(&w.p("new.txt"), "in the way");
    let apply = w.apply_plan(&stash.id, true);
    let mut kinds: Vec<String> = apply
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
    // foo.txt also holds, on disk, neither the stash's base nor its content: overwriting it
    // would lose that too.
    assert_eq!(
        kinds,
        vec![
            "StagedChangeConflict",
            "StashBaseChanged",
            "UnstagedChangeWouldBeOverwritten",
            "UntrackedFileCollision"
        ]
    );
    // Refused: the stash is still there.
    assert!(get(&w.repo.lock().unwrap(), &stash.id).is_ok());
}

#[test]
fn a_pop_removes_the_stash_only_with_the_index_in_one_step() {
    let w = World::new("stash-pop-refs");
    write(&w.p("foo.txt"), "A");
    w.commit("one");
    write(&w.p("foo.txt"), "B");
    w.stage("foo.txt");
    let plan = w.push_plan(false, vec![]).unwrap();
    let stash = record(&mut w.repo.lock().unwrap(), &plan, &by(1)).unwrap();
    finish_push(&mut w.repo.lock().unwrap()).unwrap();
    write(&w.p("foo.txt"), "A");
    assert!(index_info(&w.repo.lock().unwrap()).unwrap().equals_head);
    let apply = w.apply_plan(&stash.id, true);
    assert!(
        apply.restore.conflicts.is_empty(),
        "{:?}",
        apply.restore.conflicts
    );
    // A crash while the refs move: the stash and the old index, or neither.
    let crashed = catch_unwind(AssertUnwindSafe(|| {
        let mut repo = w.repo.lock().unwrap_or_else(|p| p.into_inner());
        fault::arm(FaultPoint::ReflogAppended);
        let done = finish_apply(&mut repo, &apply);
        fault::disarm();
        done
    }));
    fault::disarm();
    assert!(crashed.is_err());
    let World { f, repo, .. } = w;
    drop(repo);
    let repo = Mutex::new(f.open().unwrap());
    assert!(
        get(&repo.lock().unwrap(), &stash.id).is_ok(),
        "a failed pop leaves the stash"
    );
    assert!(index_info(&repo.lock().unwrap()).unwrap().equals_head);
    // Done properly: both at once.
    let engine = engine_for(&repo, &f.project);
    let cancel = AtomicBool::new(false);
    let (_, apply) = engine
        .plan_stash_apply(
            &repo,
            &SnapshotRequest::default(),
            &quiet(&cancel),
            &stash.id,
            true,
        )
        .unwrap();
    finish_apply(&mut repo.lock().unwrap(), &apply).unwrap();
    let repo = repo.lock().unwrap();
    assert!(matches!(get(&repo, &stash.id), Err(LgError::NotFound(_))));
    assert!(
        !index_info(&repo).unwrap().equals_head,
        "the staged change is back in the index"
    );
}

#[test]
fn a_crash_before_the_stash_is_durable_leaves_nothing_referenced() {
    for point in [FaultPoint::SegmentWritten, FaultPoint::ReflogAppended] {
        let w = World::new("stash-crash-record");
        write(&w.p("a.txt"), "a");
        w.commit("one");
        write(&w.p("a.txt"), "changed");
        let plan = w.push_plan(false, vec![]).unwrap();
        let crashed = catch_unwind(AssertUnwindSafe(|| {
            let mut repo = w.repo.lock().unwrap_or_else(|p| p.into_inner());
            fault::arm(point);
            let done = record(&mut repo, &plan, &by(1));
            fault::disarm();
            done
        }));
        fault::disarm();
        assert!(crashed.is_err());
        let World { f, repo, .. } = w;
        drop(repo);
        let reopened = f.open().unwrap();
        assert_eq!(list(&reopened, 10).unwrap().total, 0, "{point:?}");
        // The workspace was never touched: its change is still there.
        assert_eq!(std::fs::read(f.project.join("a.txt")).unwrap(), b"changed");
    }
}
