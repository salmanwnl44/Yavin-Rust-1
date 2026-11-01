//! LG-09 against a real Git repository: comparison and promotion read real Git with read-only
//! commands, promotion writes the working tree only (Module 03, Module 04), and nothing --
//! comparison, promotion planning, refusals, GC, integrity -- changes `.git`.

use super::*;
use crate::localgit_restore::tests::{listing, put, setup, Setup};
use crate::localgit_restore::{crash, Outcome};
use ide_localgit::compare::PathState;
use ide_localgit::history::commit_index;
use ide_localgit::index::stage_all;
use ide_localgit::Author;
use ide_workspace::recovery::{recover, IntentKind};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::process::Command;
use std::sync::atomic::AtomicBool;

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

/// Every file under `.git` with its bytes and modification time.
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

/// What real Git is: `.git` itself, HEAD, branches, the log and status.
/// `.git`'s files (bytes and times), and HEAD, branches, the log and status.
type RealGitState = (Vec<(String, Vec<u8>, std::time::SystemTime)>, [String; 4]);

fn real_git_state(s: &Setup) -> RealGitState {
    (
        fingerprint(&s.p(".git")),
        [
            git(&s.project, &["rev-parse", "HEAD"]).unwrap(),
            git(&s.project, &["branch", "--list"]).unwrap(),
            git(&s.project, &["log", "--format=%H"]).unwrap(),
            git(&s.project, &["status", "--porcelain"]).unwrap(),
        ],
    )
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

impl Setup {
    fn local_commit(&self, message: &str) -> ObjectId {
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

    fn sides(&self) -> BTreeMap<FolderId, ide_localgit::compare::GitSide> {
        let mut sides = BTreeMap::new();
        for folder in self.engine.folders() {
            if let Some(side) = git_side(&folder.path).unwrap() {
                sides.insert(folder.folder_id.clone(), side);
            }
        }
        sides
    }
}

/// A real repository with `a.txt` and `b.txt` committed; None when Git is not installed.
fn repository(label: &str) -> Option<Setup> {
    let s = setup(label);
    git(&s.project, &["--version"])?;
    git(&s.project, &["init", "-q", "-b", "main"]).unwrap();
    git(&s.project, &["config", "user.email", "t@yavin"]).unwrap();
    git(&s.project, &["config", "user.name", "T"]).unwrap();
    git(&s.project, &["config", "core.autocrlf", "false"]).unwrap();
    put(&s.p("a.txt"), "one\n");
    put(&s.p("b.txt"), "bee\n");
    git(&s.project, &["add", "."]).unwrap();
    git(&s.project, &["commit", "-q", "-m", "first"]).unwrap();
    Some(s)
}

#[test]
fn comparison_reads_real_git_and_changes_nothing() {
    let Some(s) = repository("lg09-compare") else {
        eprintln!("git is not installed: skipping");
        return;
    };
    let before = real_git_state(&s);
    let same = s.local_commit("the same content");
    let sides = s.sides();
    let side = sides.values().next().unwrap();
    assert_eq!(side.branch.as_deref(), Some("main"));
    assert_eq!(side.files.len(), 2);
    let cancel = AtomicBool::new(false);
    let (_, comparison) = s
        .engine
        .compare_with_git(&s.repo, &quiet(&cancel), Some(same), &sides, 100)
        .unwrap();
    assert!(comparison.identical, "{comparison:?}");
    assert_eq!(comparison.git_head.as_deref(), Some(before.1[0].trim()));
    // A Local commit with other content.
    put(&s.p("a.txt"), "one, changed locally\n");
    put(&s.p("c.txt"), "local only\n");
    let changed = s.local_commit("changed");
    let sides = s.sides();
    let (_, comparison) = s
        .engine
        .compare_with_git(&s.repo, &quiet(&cancel), Some(changed), &sides, 100)
        .unwrap();
    let state = |path: &str| {
        comparison
            .entries
            .iter()
            .find(|e| e.path == path)
            .map(|e| e.state)
    };
    assert_eq!(state("a.txt"), Some(PathState::Different));
    assert_eq!(state("c.txt"), Some(PathState::LocalOnly));
    // Reading real Git changed nothing of it but the working tree this test wrote.
    put(&s.p("a.txt"), "one\n");
    std::fs::remove_file(s.p("c.txt")).unwrap();
    assert_eq!(real_git_state(&s), before);
}

#[test]
fn promotion_writes_the_working_tree_only_and_never_stages_or_commits() {
    let Some(s) = repository("lg09-promote") else {
        eprintln!("git is not installed: skipping");
        return;
    };
    // A Local commit, then the working tree back to real Git's HEAD.
    put(&s.p("a.txt"), "one, from Local Git\n");
    put(&s.p("new.txt"), "created in Local Git\n");
    std::fs::remove_file(s.p("b.txt")).unwrap();
    let local = s.local_commit("local work");
    put(&s.p("a.txt"), "one\n");
    put(&s.p("b.txt"), "bee\n");
    std::fs::remove_file(s.p("new.txt")).unwrap();
    let head = git(&s.project, &["rev-parse", "HEAD"]).unwrap();
    let index = std::fs::read(s.p(".git/index")).unwrap();
    let log = git(&s.project, &["log", "--format=%H"]).unwrap();
    let cancel = AtomicBool::new(false);
    let sides = s.sides();
    let (snapshot, plan) = s
        .engine
        .plan_promotion(
            &s.repo,
            &SnapshotRequest::default(),
            &quiet(&cancel),
            local,
            &sides,
        )
        .unwrap();
    assert!(plan.refusals.is_empty(), "{:?}", plan.refusals);
    assert_eq!(plan.paths.len(), 3, "{:?}", plan.paths);
    // Planning changed nothing.
    assert_eq!(std::fs::read(s.p(".git/index")).unwrap(), index);
    // What `localgit_promote` does: the same real Git as planned, a recovery checkpoint, the
    // working tree changed as one recorded operation, verified.
    assert_eq!(
        s.sides().values().next().unwrap().fingerprint,
        plan.git_fingerprints.values().next().unwrap().clone()
    );
    ide_localgit::history::checkpoint_snapshot(
        &mut s.repo.lock().unwrap(),
        &snapshot,
        ide_localgit::Source::Recovery,
        &by("Before promoting"),
    )
    .unwrap();
    assert!(matches!(s.run(&plan.restore), Outcome::Done { .. }));
    assert!(s.verify(&plan.restore).matches);
    assert_eq!(
        std::fs::read(s.p("a.txt")).unwrap(),
        b"one, from Local Git\n"
    );
    assert_eq!(
        std::fs::read(s.p("new.txt")).unwrap(),
        b"created in Local Git\n"
    );
    assert!(!s.p("b.txt").exists());
    // Real Git: the same HEAD, index and history; the changes are there for the user to stage.
    assert_eq!(git(&s.project, &["rev-parse", "HEAD"]).unwrap(), head);
    assert_eq!(
        std::fs::read(s.p(".git/index")).unwrap(),
        index,
        "nothing staged"
    );
    assert_eq!(
        git(&s.project, &["log", "--format=%H"]).unwrap(),
        log,
        "no commit"
    );
    let status = git(&s.project, &["status", "--porcelain"]).unwrap();
    assert!(status.contains(" M a.txt"), "{status}");
    assert!(status.contains(" D b.txt"), "{status}");
    assert!(status.contains("?? new.txt"), "{status}");
}

#[test]
fn promotion_is_refused_over_real_git_work_and_a_stale_plan_is_detected() {
    let Some(s) = repository("lg09-promote-refused") else {
        eprintln!("git is not installed: skipping");
        return;
    };
    put(&s.p("a.txt"), "local\n");
    put(&s.p("b.txt"), "local bee\n");
    let local = s.local_commit("local");
    put(&s.p("a.txt"), "the user's unstaged edit\n");
    put(&s.p("b.txt"), "the user's staged edit\n");
    git(&s.project, &["add", "b.txt"]).unwrap();
    let before = real_git_state(&s);
    let disk = listing(&s.project);
    let cancel = AtomicBool::new(false);
    let sides = s.sides();
    let (_, plan) = s
        .engine
        .plan_promotion(
            &s.repo,
            &SnapshotRequest::default(),
            &quiet(&cancel),
            local,
            &sides,
        )
        .unwrap();
    assert!(plan.refusals.iter().any(|c| matches!(c, RestoreConflict::RealGitChanged { path, staged: false, .. } if path == "a.txt")), "{:?}", plan.refusals);
    assert!(plan.refusals.iter().any(|c| matches!(c, RestoreConflict::RealGitChanged { path, staged: true, .. } if path == "b.txt")));
    assert_eq!(listing(&s.project), disk);
    assert_eq!(real_git_state(&s), before, "a refusal touches nothing");
    // Real Git changing after a plan changes its fingerprint: the promotion would be refused.
    let fingerprint = s.sides().values().next().unwrap().fingerprint.clone();
    git(&s.project, &["reset", "-q", "b.txt"]).unwrap();
    assert_ne!(s.sides().values().next().unwrap().fingerprint, fingerprint);
}

#[test]
fn an_interrupted_promotion_is_left_to_module_04_and_real_git_is_untouched() {
    let Some(s) = repository("lg09-promote-crash") else {
        eprintln!("git is not installed: skipping");
        return;
    };
    for i in 0..4 {
        put(&s.p(&format!("f{i}.txt")), format!("local {i}\n"));
    }
    let local = s.local_commit("local");
    for i in 0..4 {
        std::fs::remove_file(s.p(&format!("f{i}.txt"))).unwrap();
    }
    let head = git(&s.project, &["rev-parse", "HEAD"]).unwrap();
    let index = std::fs::read(s.p(".git/index")).unwrap();
    let cancel = AtomicBool::new(false);
    let sides = s.sides();
    let (_, plan) = s
        .engine
        .plan_promotion(
            &s.repo,
            &SnapshotRequest::default(),
            &quiet(&cancel),
            local,
            &sides,
        )
        .unwrap();
    assert!(plan.refusals.is_empty(), "{:?}", plan.refusals);
    crash::arm(2);
    assert!(catch_unwind(AssertUnwindSafe(|| s.run(&plan.restore))).is_err());
    assert_eq!(git(&s.project, &["rev-parse", "HEAD"]).unwrap(), head);
    assert_eq!(std::fs::read(s.p(".git/index")).unwrap(), index);
    let Setup {
        watch, recovery, ..
    } = s;
    drop(watch);
    let report = recover(&recovery, "the-next-start");
    assert!(report
        .unresolved
        .iter()
        .chain(report.actions.iter())
        .any(|i| i.kind == Some(IntentKind::Restore)));
}

#[test]
fn gc_integrity_and_storage_never_touch_real_git() {
    let Some(s) = repository("lg09-gc-realgit") else {
        eprintln!("git is not installed: skipping");
        return;
    };
    s.local_commit("one");
    put(&s.p("a.txt"), "two\n");
    s.local_commit("two");
    put(&s.p("a.txt"), "one\n");
    let before = real_git_state(&s);
    let mut repo = s.repo.lock().unwrap();
    let at = ide_workspace::durable::now_millis() as u64;
    let plan = gc::plan(&repo, &RetentionPolicy::default(), at).unwrap();
    gc::run(&mut repo, &plan, at).unwrap();
    gc::purge(&mut repo).unwrap();
    assert!(gc::integrity(&repo, true).ok);
    gc::stats(&repo).unwrap();
    drop(repo);
    assert_eq!(real_git_state(&s), before);
}
