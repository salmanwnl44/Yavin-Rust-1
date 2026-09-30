//! Switching branches end to end: planned by the crate, carried out on a real disk by the
//! restore executor (Module 03, recorded by Module 04), verified, and only then HEAD and the
//! index moved.

use super::tests::{listing, put, setup, Setup};
use super::*;
use ide_localgit::branches::{create_branch, create_tag, delete_tag, resolve_head, HeadState};
use ide_localgit::history::{commit_index, CommitRequest};
use ide_localgit::index::{index_info, stage, stage_all, StagePath};
use ide_localgit::switch::{finish, SwitchPlan, SwitchTarget};
use ide_localgit::{Author, Control, RequestedMode, SnapshotRequest};
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

fn commit_all(s: &Setup, message: &str) -> ObjectId {
    let cancel = AtomicBool::new(false);
    stage_all(
        &s.engine,
        &s.repo,
        &SnapshotRequest::default(),
        &quiet(&cancel),
    )
    .unwrap();
    commit_index(
        &mut s.repo.lock().unwrap(),
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

fn plan(s: &Setup, target: SwitchTarget) -> SwitchPlan {
    let cancel = AtomicBool::new(false);
    s.engine
        .plan_switch(
            &s.repo,
            &SnapshotRequest {
                mode: RequestedMode::Full,
                ..Default::default()
            },
            &quiet(&cancel),
            &target,
        )
        .unwrap()
        .1
}

/// What `localgit_switch` does once the plan has no conflicts.
fn switch(s: &Setup, target: SwitchTarget) -> SwitchPlan {
    let plan = plan(s, target);
    assert!(
        plan.restore.conflicts.is_empty(),
        "{:?}",
        plan.restore.conflicts
    );
    if !plan.restore.operations.is_empty() {
        assert!(matches!(s.run(&plan.restore), Outcome::Done { .. }));
        let verification = s.verify(&plan.restore);
        assert!(verification.matches, "{:?}", verification.mismatches);
    }
    finish(&mut s.repo.lock().unwrap(), &plan).unwrap();
    plan
}

fn head_branch(s: &Setup) -> Option<String> {
    match resolve_head(&s.repo.lock().unwrap()) {
        HeadState::Branch { name, .. } => Some(name),
        _ => None,
    }
}

#[test]
fn a_clean_switch_changes_the_disk_then_moves_head_and_the_index() {
    let s = setup("switch-clean");
    put(&s.p("shared.txt"), "same");
    put(&s.p("foo.txt"), "main A");
    put(&s.p("dir/only-main.txt"), "m");
    let main_1 = commit_all(&s, "main");
    create_branch(&mut s.repo.lock().unwrap(), "feature", None).unwrap();
    switch(&s, SwitchTarget::Branch("feature".into()));
    put(&s.p("foo.txt"), "feature B");
    fs::remove_dir_all(s.p("dir")).unwrap();
    put(&s.p("feature-only/new.txt"), "f");
    commit_all(&s, "feature");
    let feature_disk = listing(&s.project);

    switch(&s, SwitchTarget::Branch("main".into()));
    assert_eq!(head_branch(&s).as_deref(), Some("main"));
    assert_eq!(fs::read(s.p("foo.txt")).unwrap(), b"main A");
    assert!(s.p("dir/only-main.txt").exists());
    assert!(!s.p("feature-only").exists());
    assert!(index_info(&s.repo.lock().unwrap()).unwrap().equals_head);

    // An untracked file rides along; the switch back restores feature exactly.
    put(&s.p("scratch.txt"), "untracked");
    switch(&s, SwitchTarget::Branch("feature".into()));
    let mut expected = feature_disk.clone();
    expected.push(("scratch.txt".into(), b"untracked".to_vec()));
    expected.sort();
    assert_eq!(listing(&s.project), expected);
    // Detached at main's first commit, then back.
    switch(&s, SwitchTarget::Commit(main_1));
    assert!(matches!(
        resolve_head(&s.repo.lock().unwrap()),
        HeadState::Detached { .. }
    ));
    assert_eq!(fs::read(s.p("foo.txt")).unwrap(), b"main A");
    switch(&s, SwitchTarget::Branch("feature".into()));
    assert_eq!(fs::read(s.p("foo.txt")).unwrap(), b"feature B");
}

#[test]
fn a_refused_switch_changes_nothing() {
    let s = setup("switch-refused");
    put(&s.p("foo.txt"), "A");
    commit_all(&s, "main");
    create_branch(&mut s.repo.lock().unwrap(), "feature", None).unwrap();
    put(&s.p("foo.txt"), "B");
    commit_all(&s, "main B");
    put(&s.p("foo.txt"), "local change");
    let before = listing(&s.project);
    let plan = plan(&s, SwitchTarget::Branch("feature".into()));
    assert!(matches!(
        plan.restore.conflicts.as_slice(),
        [ide_localgit::restore::RestoreConflict::UnstagedChangeWouldBeOverwritten { .. }]
    ));
    assert_eq!(listing(&s.project), before);
    assert_eq!(head_branch(&s).as_deref(), Some("main"));
}

#[test]
fn a_crash_while_switching_leaves_head_where_it_was_and_recovery_reports_the_disk() {
    let s = setup("switch-crash");
    for i in 0..5 {
        put(&s.p(&format!("f{i}.txt")), format!("main {i}"));
    }
    commit_all(&s, "main");
    create_branch(&mut s.repo.lock().unwrap(), "feature", None).unwrap();
    for i in 0..5 {
        put(&s.p(&format!("f{i}.txt")), format!("main moved {i}"));
    }
    commit_all(&s, "main moves");
    let plan = plan(&s, SwitchTarget::Branch("feature".into()));
    crash::arm(2);
    assert!(catch_unwind(AssertUnwindSafe(|| s.run(&plan.restore))).is_err());
    // HEAD and the index never moved: finish did not run.
    assert_eq!(head_branch(&s).as_deref(), Some("main"));
    let Setup {
        watch,
        recovery,
        repo,
        ..
    } = s;
    assert!(index_info(&repo.lock().unwrap()).unwrap().equals_head);
    drop(watch);
    let report = recover(&recovery, "the-next-start");
    let item = report
        .unresolved
        .iter()
        .find(|i| i.kind == Some(IntentKind::Restore))
        .expect("reported");
    assert_eq!(item.outcome, Settled::Partial);
}

#[test]
fn a_switch_planned_in_one_workspace_never_touches_another() {
    let a = setup("switch-iso-a");
    let b = setup("switch-iso-b");
    put(&a.p("f.txt"), "a1");
    commit_all(&a, "a1");
    create_branch(&mut a.repo.lock().unwrap(), "old", None).unwrap();
    put(&a.p("f.txt"), "a2");
    commit_all(&a, "a2");
    put(&b.p("f.txt"), "b's");
    let b_before = listing(&b.project);
    let b_head = resolve_head(&b.repo.lock().unwrap());
    switch(&a, SwitchTarget::Branch("old".into()));
    assert_eq!(listing(&b.project), b_before);
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
            let modified = fs::metadata(git_dir.join(&name))
                .unwrap()
                .modified()
                .unwrap();
            (name, bytes, modified)
        })
        .collect()
}

#[test]
fn staging_branches_tags_and_switching_never_touch_real_git() {
    let s = setup("switch-realgit");
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
    let index_before = fs::read(s.p(".git/index")).unwrap();

    // Local Git: stage, commit, branch, switch, detach, tag -- and back where it started.
    let base = commit_all(&s, "local base");
    create_branch(&mut s.repo.lock().unwrap(), "local-feature", None).unwrap();
    switch(&s, SwitchTarget::Branch("local-feature".into()));
    put(&s.p("a.txt"), "local only\n");
    let cancel = AtomicBool::new(false);
    stage(
        &s.engine,
        &s.repo,
        &SnapshotRequest::default(),
        &quiet(&cancel),
        &[StagePath {
            folder: None,
            path: "a.txt".into(),
        }],
    )
    .unwrap();
    commit_all(&s, "local feature");
    create_tag(&mut s.repo.lock().unwrap(), "local-tag", None).unwrap();
    switch(&s, SwitchTarget::Commit(base));
    switch(&s, SwitchTarget::Branch("main".into()));
    delete_tag(&mut s.repo.lock().unwrap(), "local-tag").unwrap();
    assert_eq!(fs::read(s.p("a.txt")).unwrap(), b"one\n");

    assert_eq!(fingerprint(&s.p(".git")), git_before, ".git changed");
    assert_eq!(
        git(&s.project, &["rev-parse", "HEAD"]).unwrap(),
        head_before
    );
    assert_eq!(fs::read(s.p(".git/index")).unwrap(), index_before);
    assert_eq!(
        git(&s.project, &["status", "--porcelain"]).unwrap(),
        status_before
    );
}
