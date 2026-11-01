//! Reset, revert and stash end to end: planned by the crate, carried out on a real disk by the
//! restore executor (Module 03, recorded by Module 04), verified, and only then the refs moved
//! -- as the `localgit_*` commands do.

use super::tests::{listing, put, setup, Setup};
use super::*;
use ide_localgit::branches::{create_branch, index_state, resolve_head};
use ide_localgit::history::{commit_index, CommitRequest};
use ide_localgit::index::{index_info, stage, stage_all, StagePath};
use ide_localgit::reset::{finish_hard, reset_mixed, reset_soft, ResetPolicy, ResetTarget};
use ide_localgit::stash::{self, StashInfo};
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

fn commit_all(s: &Setup, message: &str) -> ObjectId {
    let cancel = AtomicBool::new(false);
    stage_all(
        &s.engine,
        &s.repo,
        &SnapshotRequest::default(),
        &quiet(&cancel),
    )
    .unwrap();
    commit_index(&mut s.repo.lock().unwrap(), &by(message))
        .unwrap()
        .commit
        .id
        .0
}

fn stage_path(s: &Setup, path: &str) {
    let cancel = AtomicBool::new(false);
    stage(
        &s.engine,
        &s.repo,
        &SnapshotRequest::default(),
        &quiet(&cancel),
        &[StagePath {
            folder: None,
            path: path.into(),
        }],
    )
    .unwrap();
}

/// What `localgit_reset` does for a hard reset with no conflicts.
fn hard_reset(s: &Setup, to: ObjectId, policy: ResetPolicy) {
    let cancel = AtomicBool::new(false);
    let (_, plan) = s
        .engine
        .plan_reset_hard(
            &s.repo,
            &SnapshotRequest::default(),
            &quiet(&cancel),
            &ResetTarget::Commit(to),
            policy,
        )
        .unwrap();
    assert!(
        plan.restore.conflicts.is_empty(),
        "{:?}",
        plan.restore.conflicts
    );
    if !plan.restore.operations.is_empty() {
        assert!(matches!(s.run(&plan.restore), Outcome::Done { .. }));
        assert!(s.verify(&plan.restore).matches);
    }
    finish_hard(&mut s.repo.lock().unwrap(), &plan).unwrap();
}

/// What `localgit_stash_push` does: plan, record durably, clean, verify, index to HEAD.
fn stash_push(s: &Setup, include_untracked: bool) -> StashInfo {
    let cancel = AtomicBool::new(false);
    let (_, plan) = s
        .engine
        .plan_stash_push(
            &s.repo,
            &SnapshotRequest::default(),
            &quiet(&cancel),
            None,
            include_untracked,
        )
        .unwrap();
    assert!(
        plan.restore.conflicts.is_empty(),
        "{:?}",
        plan.restore.conflicts
    );
    let info = stash::record(&mut s.repo.lock().unwrap(), &plan, &by("")).unwrap();
    if !plan.restore.operations.is_empty() {
        assert!(matches!(s.run(&plan.restore), Outcome::Done { .. }));
        assert!(s.verify(&plan.restore).matches);
    }
    stash::finish_push(&mut s.repo.lock().unwrap()).unwrap();
    info
}

/// What `localgit_stash_apply` does when there are no conflicts.
fn stash_apply(s: &Setup, id: &str, pop: bool) {
    let cancel = AtomicBool::new(false);
    let (_, plan) = s
        .engine
        .plan_stash_apply(
            &s.repo,
            &SnapshotRequest::default(),
            &quiet(&cancel),
            id,
            pop,
        )
        .unwrap();
    assert!(
        plan.restore.conflicts.is_empty(),
        "{:?}",
        plan.restore.conflicts
    );
    if !plan.restore.operations.is_empty() {
        assert!(matches!(s.run(&plan.restore), Outcome::Done { .. }));
        assert!(s.verify(&plan.restore).matches);
    }
    stash::finish_apply(&mut s.repo.lock().unwrap(), &plan).unwrap();
}

fn index_root(s: &Setup) -> Option<ObjectId> {
    index_state(&s.repo.lock().unwrap()).unwrap().root
}

#[test]
fn a_hard_reset_takes_the_disk_head_and_index_to_the_target() {
    let s = setup("lg05-hard");
    put(&s.p("a.txt"), "1");
    put(&s.p("dir/b.txt"), "b");
    let c1 = commit_all(&s, "one");
    let at_c1 = listing(&s.project);
    put(&s.p("a.txt"), "2");
    std::fs::remove_dir_all(s.p("dir")).unwrap();
    put(&s.p("c.txt"), "c");
    commit_all(&s, "two");
    hard_reset(&s, c1, ResetPolicy::RefuseIfDirty);
    assert_eq!(listing(&s.project), at_c1);
    assert_eq!(resolve_head(&s.repo.lock().unwrap()).commit(), Some(c1));
    assert!(index_info(&s.repo.lock().unwrap()).unwrap().equals_head);
}

#[test]
fn an_explicitly_destructive_hard_reset_loses_what_was_asked_and_nothing_else() {
    let s = setup("lg05-hard-destructive");
    put(&s.p("a.txt"), "1");
    let c1 = commit_all(&s, "one");
    put(&s.p("a.txt"), "2");
    commit_all(&s, "two");
    put(&s.p("a.txt"), "local, to be discarded");
    put(&s.p("untracked.txt"), "never touched");
    // Refused by default...
    let cancel = AtomicBool::new(false);
    let (_, refused) = s
        .engine
        .plan_reset_hard(
            &s.repo,
            &SnapshotRequest::default(),
            &quiet(&cancel),
            &ResetTarget::Commit(c1),
            ResetPolicy::RefuseIfDirty,
        )
        .unwrap();
    assert!(!refused.restore.conflicts.is_empty());
    // ...and done when asked.
    hard_reset(&s, c1, ResetPolicy::AllowDestructive);
    assert_eq!(std::fs::read(s.p("a.txt")).unwrap(), b"1");
    assert_eq!(
        std::fs::read(s.p("untracked.txt")).unwrap(),
        b"never touched"
    );
}

#[test]
fn soft_and_mixed_never_touch_the_disk() {
    let s = setup("lg05-soft-mixed");
    put(&s.p("a.txt"), "1");
    let c1 = commit_all(&s, "one");
    put(&s.p("a.txt"), "2");
    commit_all(&s, "two");
    let disk = listing(&s.project);
    reset_soft(
        &mut s.repo.lock().unwrap(),
        s.engine.folders(),
        &ResetTarget::Commit(c1),
    )
    .unwrap();
    assert_eq!(listing(&s.project), disk);
    reset_mixed(&mut s.repo.lock().unwrap(), &ResetTarget::Commit(c1)).unwrap();
    assert_eq!(listing(&s.project), disk);
    assert_eq!(s.records_left(), 0, "no file operation at all");
}

impl Setup {
    fn records_left(&self) -> usize {
        std::fs::read_dir(self.recovery.join("instances"))
            .into_iter()
            .flatten()
            .flatten()
            .flat_map(|i| std::fs::read_dir(i.path()).into_iter().flatten().flatten())
            .filter(|f| f.file_name().to_string_lossy().starts_with("op-"))
            .count()
    }
}

#[test]
fn stash_push_then_pop_brings_back_staged_unstaged_and_untracked_exactly() {
    let s = setup("lg05-stash-roundtrip");
    put(&s.p("foo.txt"), "A");
    put(&s.p("keep.txt"), "k");
    commit_all(&s, "one");
    // HEAD=A, index=B, working=C, and an untracked file.
    put(&s.p("foo.txt"), "B");
    stage_path(&s, "foo.txt");
    put(&s.p("foo.txt"), "C");
    put(&s.p("untracked/new.txt"), "u");
    let before_disk = listing(&s.project);
    let before_index = index_root(&s);
    let info = stash_push(&s, true);
    assert_eq!(info.counts.staged, 1);
    assert_eq!(info.counts.unstaged, 1);
    assert_eq!(info.counts.untracked, 1);
    // Clean: HEAD = index = working (the untracked file taken too).
    assert_eq!(std::fs::read(s.p("foo.txt")).unwrap(), b"A");
    assert!(!s.p("untracked").exists());
    assert!(index_info(&s.repo.lock().unwrap()).unwrap().equals_head);
    stash_apply(&s, &info.id, true);
    assert_eq!(
        listing(&s.project),
        before_disk,
        "working tree back exactly"
    );
    assert_eq!(
        index_root(&s),
        before_index,
        "the index back exactly: staged B, not C"
    );
    assert_eq!(
        stash::list(&s.repo.lock().unwrap(), 10).unwrap().total,
        0,
        "popped"
    );
}

#[test]
fn untracked_files_stay_put_unless_asked_for() {
    let s = setup("lg05-stash-untracked");
    put(&s.p("a.txt"), "a");
    commit_all(&s, "one");
    put(&s.p("a.txt"), "changed");
    put(&s.p("scratch.txt"), "mine");
    let info = stash_push(&s, false);
    assert!(!info.has_untracked);
    assert_eq!(std::fs::read(s.p("scratch.txt")).unwrap(), b"mine");
    assert_eq!(std::fs::read(s.p("a.txt")).unwrap(), b"a");
}

#[test]
fn a_refused_pop_changes_nothing_and_keeps_the_stash() {
    let s = setup("lg05-pop-refused");
    put(&s.p("a.txt"), "a");
    commit_all(&s, "one");
    put(&s.p("a.txt"), "stashed");
    let info = stash_push(&s, false);
    put(&s.p("a.txt"), "in the way");
    let before = listing(&s.project);
    let cancel = AtomicBool::new(false);
    let (_, plan) = s
        .engine
        .plan_stash_apply(
            &s.repo,
            &SnapshotRequest::default(),
            &quiet(&cancel),
            &info.id,
            true,
        )
        .unwrap();
    assert!(!plan.restore.conflicts.is_empty());
    assert_eq!(listing(&s.project), before);
    assert!(stash::get(&s.repo.lock().unwrap(), &info.id).is_ok());
}

#[test]
fn a_crash_while_popping_keeps_the_stash_and_the_index() {
    let s = setup("lg05-pop-crash");
    for i in 0..4 {
        put(&s.p(&format!("f{i}.txt")), format!("base {i}"));
    }
    commit_all(&s, "one");
    for i in 0..4 {
        put(&s.p(&format!("f{i}.txt")), format!("stashed {i}"));
    }
    let info = stash_push(&s, false);
    let cancel = AtomicBool::new(false);
    let (_, plan) = s
        .engine
        .plan_stash_apply(
            &s.repo,
            &SnapshotRequest::default(),
            &quiet(&cancel),
            &info.id,
            true,
        )
        .unwrap();
    crash::arm(2);
    assert!(catch_unwind(AssertUnwindSafe(|| s.run(&plan.restore))).is_err());
    // finish_apply never ran: the stash is there, the index unchanged.
    assert!(stash::get(&s.repo.lock().unwrap(), &info.id).is_ok());
    assert!(index_info(&s.repo.lock().unwrap()).unwrap().equals_head);
    let Setup {
        watch, recovery, ..
    } = s;
    drop(watch);
    let report = recover(&recovery, "the-next-start");
    assert!(report
        .unresolved
        .iter()
        .any(|i| i.kind == Some(IntentKind::Restore) && i.outcome == Settled::Partial));
}

#[test]
fn a_crash_while_cleaning_after_a_push_keeps_the_stash() {
    let s = setup("lg05-push-crash");
    for i in 0..4 {
        put(&s.p(&format!("f{i}.txt")), format!("base {i}"));
    }
    commit_all(&s, "one");
    for i in 0..4 {
        put(&s.p(&format!("f{i}.txt")), format!("work {i}"));
    }
    let cancel = AtomicBool::new(false);
    let (_, plan) = s
        .engine
        .plan_stash_push(
            &s.repo,
            &SnapshotRequest::default(),
            &quiet(&cancel),
            None,
            false,
        )
        .unwrap();
    let info = stash::record(&mut s.repo.lock().unwrap(), &plan, &by("")).unwrap();
    crash::arm(2);
    assert!(catch_unwind(AssertUnwindSafe(|| s.run(&plan.restore))).is_err());
    // The only copy of the work is never lost: the stash holds all of it.
    let repo = s.repo.lock().unwrap();
    let stashed = repo.read_commit(&info.commit.0).unwrap();
    let tree = repo
        .read_root(&stashed.root)
        .unwrap()
        .folders
        .values()
        .next()
        .copied()
        .unwrap();
    let names: Vec<String> = repo
        .read_tree(&tree)
        .unwrap()
        .entries()
        .iter()
        .map(|e| e.name.as_str().to_string())
        .collect();
    assert_eq!(names, vec!["f0.txt", "f1.txt", "f2.txt", "f3.txt"]);
    for (i, entry) in repo.read_tree(&tree).unwrap().entries().iter().enumerate() {
        assert_eq!(
            repo.read_blob(&entry.id, 1 << 20).unwrap(),
            format!("work {i}").into_bytes()
        );
    }
}

#[test]
fn stash_switch_work_switch_back_pop() {
    let s = setup("lg05-workflow");
    put(&s.p("a.txt"), "main");
    commit_all(&s, "main");
    create_branch(&mut s.repo.lock().unwrap(), "feature", None).unwrap();
    put(&s.p("a.txt"), "half-done work on main");
    let info = stash_push(&s, false);
    let switch = |target: SwitchTarget| {
        let cancel = AtomicBool::new(false);
        let (_, plan) = s
            .engine
            .plan_switch(
                &s.repo,
                &SnapshotRequest::default(),
                &quiet(&cancel),
                &target,
            )
            .unwrap();
        assert!(
            plan.restore.conflicts.is_empty(),
            "{:?}",
            plan.restore.conflicts
        );
        if !plan.restore.operations.is_empty() {
            assert!(matches!(s.run(&plan.restore), Outcome::Done { .. }));
        }
        finish_switch(&mut s.repo.lock().unwrap(), &plan).unwrap();
    };
    switch(SwitchTarget::Branch("feature".into()));
    put(&s.p("b.txt"), "feature work");
    commit_all(&s, "feature");
    switch(SwitchTarget::Branch("main".into()));
    stash_apply(&s, &info.id, true);
    assert_eq!(
        std::fs::read(s.p("a.txt")).unwrap(),
        b"half-done work on main"
    );
    assert!(!s.p("b.txt").exists());
}

#[test]
fn stash_revert_and_reset_never_touch_another_workspace() {
    let a = setup("lg05-iso-a");
    let b = setup("lg05-iso-b");
    put(&a.p("f.txt"), "a1");
    let a1 = commit_all(&a, "a1");
    put(&a.p("f.txt"), "a2");
    commit_all(&a, "a2");
    put(&b.p("f.txt"), "b's");
    let b_disk = listing(&b.project);
    let b_head = resolve_head(&b.repo.lock().unwrap());
    put(&a.p("f.txt"), "a local");
    stash_push(&a, false);
    hard_reset(&a, a1, ResetPolicy::RefuseIfDirty);
    assert_eq!(listing(&b.project), b_disk);
    assert_eq!(resolve_head(&b.repo.lock().unwrap()), b_head);
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
fn reset_revert_and_stash_never_touch_real_git() {
    let s = setup("lg05-realgit");
    if git(&s.project, &["--version"]).is_none() {
        eprintln!("git is not installed: skipping");
        return;
    }
    git(&s.project, &["init", "-q", "-b", "main"]).unwrap();
    git(&s.project, &["config", "user.email", "t@yavin"]).unwrap();
    git(&s.project, &["config", "user.name", "T"]).unwrap();
    git(&s.project, &["config", "core.autocrlf", "false"]).unwrap();
    put(&s.p("a.txt"), "one\n");
    git(&s.project, &["add", "."]).unwrap();
    git(&s.project, &["commit", "-q", "-m", "first"]).unwrap();
    let status_before = git(&s.project, &["status", "--porcelain"]).unwrap();
    let head_before = git(&s.project, &["rev-parse", "HEAD"]).unwrap();
    let git_before = fingerprint(&s.p(".git"));
    let index_before = std::fs::read(s.p(".git/index")).unwrap();

    let base = commit_all(&s, "local base");
    put(&s.p("a.txt"), "local two\n");
    let two = commit_all(&s, "local two");
    reset_soft(
        &mut s.repo.lock().unwrap(),
        s.engine.folders(),
        &ResetTarget::Commit(base),
    )
    .unwrap();
    reset_mixed(&mut s.repo.lock().unwrap(), &ResetTarget::Commit(two)).unwrap();
    // Revert two (the working tree keeps two's text; the revert is in history).
    let cancel = AtomicBool::new(false);
    let (_, reverted) = s
        .engine
        .revert(
            &s.repo,
            &SnapshotRequest::default(),
            &quiet(&cancel),
            two,
            None,
            &by(""),
        )
        .unwrap();
    assert!(reverted.commit.is_some(), "{:?}", reverted.conflicts);
    // Stash the working tree's difference, apply it, pop it, and drop another.
    let first = stash_push(&s, false);
    stash_apply(&s, &first.id, false);
    let head = resolve_head(&s.repo.lock().unwrap()).commit().unwrap();
    hard_reset(&s, head, ResetPolicy::AllowDestructive);
    stash_apply(&s, &first.id, true);
    let second = stash_push(&s, false);
    stash::drop_stash(&mut s.repo.lock().unwrap(), &second.id).unwrap();
    // Back where Git's working tree was.
    hard_reset(&s, base, ResetPolicy::AllowDestructive);
    assert_eq!(std::fs::read(s.p("a.txt")).unwrap(), b"one\n");

    assert_eq!(fingerprint(&s.p(".git")), git_before, ".git changed");
    assert_eq!(
        git(&s.project, &["rev-parse", "HEAD"]).unwrap(),
        head_before
    );
    assert_eq!(std::fs::read(s.p(".git/index")).unwrap(), index_before);
    assert_eq!(
        git(&s.project, &["status", "--porcelain"]).unwrap(),
        status_before
    );
}
