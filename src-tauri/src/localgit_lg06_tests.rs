//! Merge and cherry-pick end to end: planned by the crate, recorded, carried out on a real disk
//! by the restore executor (Module 03, recorded by Module 04), verified, and only then the refs
//! moved -- as the `localgit_*` commands do -- with crashes at every boundary.

use super::tests::{listing, put, setup, Setup};
use super::*;
use ide_localgit::branches::{create_branch, get_branch, index_state, resolve_head};
use ide_localgit::history::{commit_index, CommitRequest};
use ide_localgit::index::stage_all;
use ide_localgit::merge::{
    self, begin, finish_abort, finish_apply, finish_continue, finish_resolve, record_resolve,
    OperationPlan, OperationRequest, Outcome as Merged, ResolveChoice,
};
use ide_localgit::operation::{current, OperationKind, Phase};
use ide_localgit::reset::{ResetPolicy, ResetTarget};
use ide_localgit::switch::{finish as finish_switch, SwitchTarget};
use ide_localgit::{Author, Control, SnapshotRequest};
use ide_workspace::recovery::{recover, IntentKind, Outcome as Settled};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::process::Command;
use std::sync::atomic::AtomicBool;

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

impl Setup {
    fn commit_all(&self, message: &str) -> ObjectId {
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
        assert!(plan.restore.conflicts.is_empty());
        if !plan.restore.operations.is_empty() {
            assert!(matches!(self.run(&plan.restore), Outcome::Done { .. }));
        }
        finish_switch(&mut self.repo.lock().unwrap(), &plan).unwrap();
    }

    fn plan_op(&self, request: OperationRequest) -> OperationPlan {
        let cancel = AtomicBool::new(false);
        let (_, plan) = self
            .engine
            .plan_operation(
                &self.repo,
                &SnapshotRequest::default(),
                &quiet(&cancel),
                &request,
                &by(""),
            )
            .unwrap();
        assert!(
            plan.restore.as_ref().unwrap().conflicts.is_empty(),
            "{:?}",
            plan.restore.as_ref().unwrap().conflicts
        );
        plan
    }

    fn plan_merge(&self) -> OperationPlan {
        self.plan_op(OperationRequest::Merge {
            target: ResetTarget::Branch("feature".into()),
            message: None,
        })
    }

    /// Carries a restore plan out and verifies it.
    fn carry(&self, plan: &RestorePlan) {
        if !plan.operations.is_empty() {
            assert!(matches!(self.run(plan), Outcome::Done { .. }));
            assert!(self.verify(plan).matches);
        }
    }

    /// What `localgit_merge` / `localgit_cherry_pick` do when nothing is in the way.
    fn operate(&self, plan: &OperationPlan) -> merge::Finished {
        begin(&mut self.repo.lock().unwrap(), plan).unwrap();
        self.carry(plan.restore.as_ref().unwrap());
        finish_apply(&mut self.repo.lock().unwrap()).unwrap()
    }

    fn resolve(&self, path: &str, choice: ResolveChoice) {
        let cancel = AtomicBool::new(false);
        let (_, plan) = self
            .engine
            .plan_resolve(
                &self.repo,
                &SnapshotRequest::default(),
                &quiet(&cancel),
                None,
                path,
                choice,
                ResetPolicy::RefuseIfDirty,
            )
            .unwrap();
        record_resolve(&mut self.repo.lock().unwrap(), &plan).unwrap();
        if let Some(restore) = &plan.restore {
            assert!(restore.conflicts.is_empty(), "{:?}", restore.conflicts);
            self.carry(restore);
        }
        finish_resolve(&mut self.repo.lock().unwrap(), &plan).unwrap();
    }

    fn abort_plan(&self) -> RestorePlan {
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
        assert!(plan.conflicts.is_empty(), "{:?}", plan.conflicts);
        plan
    }

    fn abort(&self) {
        let plan = self.abort_plan();
        self.carry(&plan);
        finish_abort(&mut self.repo.lock().unwrap()).unwrap();
    }

    fn resume(&self) -> merge::Finished {
        let cancel = AtomicBool::new(false);
        let (_, plan) = self
            .engine
            .plan_resume(&self.repo, &SnapshotRequest::default(), &quiet(&cancel))
            .unwrap();
        assert!(plan.conflicts.is_empty(), "{:?}", plan.conflicts);
        self.carry(&plan);
        finish_apply(&mut self.repo.lock().unwrap()).unwrap()
    }

    fn phase(&self) -> Option<Phase> {
        current(&self.repo.lock().unwrap())
            .unwrap()
            .map(|(_, state)| state.phase)
    }

    fn head(&self) -> Option<ObjectId> {
        resolve_head(&self.repo.lock().unwrap()).commit()
    }

    fn open_records(&self) -> usize {
        std::fs::read_dir(self.recovery.join("instances"))
            .into_iter()
            .flatten()
            .flatten()
            .flat_map(|i| std::fs::read_dir(i.path()).into_iter().flatten().flatten())
            .filter(|f| f.file_name().to_string_lossy().starts_with("op-"))
            .count()
    }
}

/// `feature` and `main` both changed from a base; left on main. Four files change on disk
/// in the merge (so a crash can land between them), and `a.txt` conflicts when `conflict`.
fn diverged(label: &str, conflict: bool) -> Setup {
    let s = setup(label);
    put(&s.p("a.txt"), "base\n");
    for i in 0..4 {
        put(&s.p(&format!("f{i}.txt")), format!("base {i}"));
    }
    s.commit_all("base");
    create_branch(&mut s.repo.lock().unwrap(), "feature", None).unwrap();
    s.switch("feature");
    put(&s.p("a.txt"), "theirs\n");
    for i in 0..4 {
        put(&s.p(&format!("f{i}.txt")), format!("theirs {i}"));
    }
    s.commit_all("theirs");
    s.switch("main");
    if conflict {
        put(&s.p("a.txt"), "ours\n");
    }
    put(&s.p("ours.txt"), "ours");
    s.commit_all("ours");
    s
}

#[test]
fn a_merge_with_conflicts_is_resolved_and_continued_through_the_executor() {
    let s = diverged("lg06-e2e", true);
    let head = s.head().unwrap();
    let plan = s.plan_merge();
    assert_eq!(plan.outcome, Merged::Conflicted);
    let done = s.operate(&plan);
    assert!(done.commit.is_none());
    assert_eq!(s.phase(), Some(Phase::Conflicts));
    assert_eq!(std::fs::read(s.p("f0.txt")).unwrap(), b"theirs 0");
    assert!(String::from_utf8(std::fs::read(s.p("a.txt")).unwrap())
        .unwrap()
        .contains("<<<<<<< HEAD (main)"));
    s.resolve("a.txt", ResolveChoice::TakeTheirs);
    assert_eq!(std::fs::read(s.p("a.txt")).unwrap(), b"theirs\n");
    let created = finish_continue(&mut s.repo.lock().unwrap(), None, &by("")).unwrap();
    assert_eq!(created.commit.parents[0].0, head);
    assert_eq!(s.phase(), None);
    assert_eq!(s.head(), Some(created.commit.id.0));
    assert_eq!(s.open_records(), 0, "every file operation closed");
    assert!(s.repo.lock().unwrap().verify(true).is_empty());
}

#[test]
fn a_fast_forward_and_a_clean_merge_complete_in_one_go() {
    let s = setup("lg06-ff");
    put(&s.p("a.txt"), "1");
    s.commit_all("one");
    create_branch(&mut s.repo.lock().unwrap(), "feature", None).unwrap();
    s.switch("feature");
    put(&s.p("a.txt"), "2");
    let two = s.commit_all("two");
    s.switch("main");
    let plan = s.plan_merge();
    assert_eq!(plan.outcome, Merged::FastForward);
    let done = s.operate(&plan);
    assert_eq!(done.commit.unwrap().id.0, two);
    assert_eq!(std::fs::read(s.p("a.txt")).unwrap(), b"2");
    assert_eq!(s.phase(), None);

    let s = diverged("lg06-clean", false);
    let plan = s.plan_merge();
    assert_eq!(plan.outcome, Merged::Merged);
    let done = s.operate(&plan);
    assert_eq!(done.commit.unwrap().parents.len(), 2);
    assert_eq!(std::fs::read(s.p("a.txt")).unwrap(), b"theirs\n");
    assert_eq!(std::fs::read(s.p("ours.txt")).unwrap(), b"ours");
}

/// Where a merge (or cherry-pick) can stop: before the disk changes, partway through it, after
/// it but before the refs move, and after the refs moved. Each leaves an explicit state that
/// continuing or aborting settles -- never completed by itself.
#[test]
fn a_crash_at_every_boundary_of_a_merge_or_cherry_pick_can_be_continued_or_aborted() {
    for kind in [OperationKind::Merge, OperationKind::CherryPick] {
        for stop in ["before disk", "during disk", "after disk", "after refs"] {
            for then_abort in [false, true] {
                let label = format!(
                    "lg06-crash-{}-{}-{}",
                    kind.op(),
                    stop.replace(' ', "-"),
                    if then_abort { "abort" } else { "continue" }
                );
                let s = diverged(&label, false);
                let head = s.head();
                let before = listing(&s.project);
                let plan = match kind {
                    OperationKind::Merge => s.plan_merge(),
                    OperationKind::CherryPick => {
                        let picked = get_branch(&s.repo.lock().unwrap(), "feature")
                            .unwrap()
                            .commit
                            .0;
                        s.plan_op(OperationRequest::CherryPick { commit: picked })
                    }
                };
                begin(&mut s.repo.lock().unwrap(), &plan).unwrap();
                let restore = plan.restore.clone().unwrap();
                match stop {
                    "before disk" => {}
                    "during disk" => {
                        crash::arm(2);
                        assert!(catch_unwind(AssertUnwindSafe(|| s.run(&restore))).is_err());
                    }
                    _ => {
                        assert!(matches!(s.run(&restore), Outcome::Done { .. }));
                    }
                }
                if stop == "after refs" {
                    finish_apply(&mut s.repo.lock().unwrap()).unwrap();
                    assert_eq!(s.phase(), None, "{label}: completed in one step");
                    assert_ne!(s.head(), head);
                    continue;
                }
                // The process died here: the state is explicit, HEAD has not moved.
                assert_eq!(s.phase(), Some(Phase::Applying), "{label}");
                assert_eq!(s.head(), head, "{label}: never completed by itself");
                if then_abort {
                    s.abort();
                    assert_eq!(listing(&s.project), before, "{label}");
                    assert_eq!(s.head(), head);
                } else {
                    let done = s.resume();
                    assert!(done.commit.is_some(), "{label}");
                    assert_eq!(
                        std::fs::read(s.p("f3.txt")).unwrap(),
                        b"theirs 3",
                        "{label}"
                    );
                }
                assert_eq!(s.phase(), None, "{label}");
                let head_now = s.head();
                let index_now = index_state(&s.repo.lock().unwrap()).unwrap().commit;
                assert_eq!(index_now, head_now, "{label}: the index follows HEAD");
                if stop == "during disk" {
                    // Module 04 settles the crashed file operation on the next start.
                    let Setup {
                        watch, recovery, ..
                    } = s;
                    drop(watch);
                    let report = recover(&recovery, "the-next-start");
                    assert!(
                        report
                            .unresolved
                            .iter()
                            .chain(report.actions.iter())
                            .any(|i| i.kind == Some(IntentKind::Restore)),
                        "{label}"
                    );
                }
            }
        }
    }
}

#[test]
fn a_crash_while_aborting_is_aborted_again() {
    let s = diverged("lg06-abort-crash", true);
    let before = listing(&s.project);
    s.operate(&s.plan_merge());
    assert_eq!(s.phase(), Some(Phase::Conflicts));
    // During the abort's disk change.
    let plan = s.abort_plan();
    crash::arm(2);
    assert!(catch_unwind(AssertUnwindSafe(|| s.run(&plan))).is_err());
    assert_eq!(
        s.phase(),
        Some(Phase::Conflicts),
        "the state stays until the end"
    );
    // Before the state is cleared (the disk is back, the refs not yet).
    let plan = s.abort_plan();
    s.carry(&plan);
    assert_eq!(s.phase(), Some(Phase::Conflicts));
    let again = s.abort_plan();
    assert!(again.operations.is_empty(), "nothing left to take back");
    finish_abort(&mut s.repo.lock().unwrap()).unwrap();
    assert_eq!(listing(&s.project), before);
    assert_eq!(s.phase(), None);
    let Setup {
        watch, recovery, ..
    } = s;
    drop(watch);
    // The crashed abort's file operation is settled on the next start, from what the disk
    // holds -- here everything it meant to do, since the second abort finished it.
    let report = recover(&recovery, "the-next-start");
    let settled: Vec<Settled> = report
        .unresolved
        .iter()
        .chain(report.actions.iter())
        .filter(|i| i.kind == Some(IntentKind::Restore))
        .map(|i| i.outcome)
        .collect();
    assert_eq!(settled.len(), 1, "{settled:?}");
    assert!(matches!(settled[0], Settled::Completed | Settled::Partial));
}

#[test]
fn a_crash_while_a_cherry_pick_is_aborted_leaves_it_abortable() {
    let s = diverged("lg06-pick-abort-crash", true);
    let before = listing(&s.project);
    let picked = get_branch(&s.repo.lock().unwrap(), "feature")
        .unwrap()
        .commit
        .0;
    s.operate(&s.plan_op(OperationRequest::CherryPick { commit: picked }));
    let plan = s.abort_plan();
    crash::arm(1);
    assert!(catch_unwind(AssertUnwindSafe(|| s.run(&plan))).is_err());
    s.abort();
    assert_eq!(listing(&s.project), before);
    assert_eq!(s.phase(), None);
}

#[test]
fn a_merge_in_one_workspace_never_touches_another() {
    let a = diverged("lg06-iso-a", true);
    let b = setup("lg06-iso-b");
    put(&b.p("a.txt"), "b's own");
    let b_disk = listing(&b.project);
    let b_head = resolve_head(&b.repo.lock().unwrap());
    a.operate(&a.plan_merge());
    a.resolve("a.txt", ResolveChoice::TakeOurs);
    a.abort();
    assert_eq!(listing(&b.project), b_disk);
    assert_eq!(resolve_head(&b.repo.lock().unwrap()), b_head);
    assert!(current(&b.repo.lock().unwrap()).unwrap().is_none());
}

fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .ok()?;
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn fingerprint(git_dir: &Path) -> Vec<(String, Vec<u8>, std::time::SystemTime)> {
    listing(git_dir)
        .into_iter()
        .filter(|(name, _)| !name.ends_with('/'))
        .map(|(name, bytes)| {
            let modified = std::fs::metadata(git_dir.join(&name))
                .unwrap()
                .modified()
                .unwrap();
            (name, bytes, modified)
        })
        .collect()
}

#[test]
fn merge_and_cherry_pick_never_touch_real_git() {
    let s = setup("lg06-realgit");
    if git(&s.project, &["--version"]).is_none() {
        eprintln!("git is not installed: skipping");
        return;
    }
    git(&s.project, &["init", "-q", "-b", "main"]).unwrap();
    git(&s.project, &["config", "user.email", "t@yavin"]).unwrap();
    git(&s.project, &["config", "user.name", "T"]).unwrap();
    git(&s.project, &["config", "core.autocrlf", "false"]).unwrap();
    put(&s.p("a.txt"), "base\n");
    git(&s.project, &["add", "."]).unwrap();
    git(&s.project, &["commit", "-q", "-m", "first"]).unwrap();
    let status_before = git(&s.project, &["status", "--porcelain"]).unwrap();
    let head_before = git(&s.project, &["rev-parse", "HEAD"]).unwrap();
    let branch_before = git(&s.project, &["branch", "--list"]).unwrap();
    let git_before = fingerprint(&s.p(".git"));
    let index_before = std::fs::read(s.p(".git/index")).unwrap();

    // Local Git: a conflicted merge, resolved and continued; a cherry-pick; one aborted.
    s.commit_all("local base");
    create_branch(&mut s.repo.lock().unwrap(), "feature", None).unwrap();
    s.switch("feature");
    put(&s.p("a.txt"), "theirs\n");
    put(&s.p("b.txt"), "b\n");
    let theirs = s.commit_all("theirs");
    s.switch("main");
    put(&s.p("a.txt"), "ours\n");
    s.commit_all("ours");
    s.operate(&s.plan_merge());
    s.resolve("a.txt", ResolveChoice::TakeOurs);
    finish_continue(&mut s.repo.lock().unwrap(), None, &by("")).unwrap();
    put(&s.p("c.txt"), "c\n");
    s.commit_all("c");
    create_branch(&mut s.repo.lock().unwrap(), "side", None).unwrap();
    s.switch("side");
    put(&s.p("a.txt"), "side\n");
    let side = s.commit_all("side");
    s.switch("main");
    put(&s.p("a.txt"), "main again\n");
    s.commit_all("main again");
    s.operate(&s.plan_op(OperationRequest::CherryPick { commit: side }));
    s.abort();
    let _ = theirs;
    // Back where Git's working tree was.
    std::fs::remove_file(s.p("b.txt")).unwrap();
    std::fs::remove_file(s.p("c.txt")).unwrap();
    put(&s.p("a.txt"), "base\n");

    assert_eq!(fingerprint(&s.p(".git")), git_before, ".git changed");
    assert_eq!(
        git(&s.project, &["rev-parse", "HEAD"]).unwrap(),
        head_before
    );
    assert_eq!(
        git(&s.project, &["branch", "--list"]).unwrap(),
        branch_before
    );
    assert_eq!(std::fs::read(s.p(".git/index")).unwrap(), index_before);
    assert_eq!(
        git(&s.project, &["status", "--porcelain"]).unwrap(),
        status_before
    );
}
