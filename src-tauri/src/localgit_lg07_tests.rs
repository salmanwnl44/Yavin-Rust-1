//! AI runs end to end: checkpointed and attributed by the crate, undone on a real disk by the
//! restore executor (Module 03, recorded by Module 04), verified -- as the `localgit_ai_*`
//! commands do -- with crashes during the undo, restarts, and real Git beside it.

use super::tests::{listing, put, setup, Setup};
use super::*;
use ide_localgit::ai::{
    self, begin_undo, finish_undo, AiRunRecord, AiRunStatus, AiUndoPlan, CheckpointRequest,
    ReportedPath, RunEvent,
};
use ide_localgit::branches::resolve_head;
use ide_localgit::history::{commit_index, CommitRequest};
use ide_localgit::index::stage_all;
use ide_localgit::{Author, Control, OpenOptions, SnapshotRequest, WorkspaceSpec};
use ide_workspace::recovery::{recover, IntentKind};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::process::Command;
use std::sync::atomic::AtomicBool;

fn quiet(cancel: &AtomicBool) -> Control<'_> {
    Control {
        cancel,
        progress: &|_| {},
    }
}

fn by() -> CommitRequest {
    CommitRequest {
        message: "human".into(),
        author: Author {
            name: "T".into(),
            id: "t".into(),
        },
        time_ms: 0,
        tz_offset_min: 0,
    }
}

impl Setup {
    fn commit_everything(&self) -> ObjectId {
        let cancel = AtomicBool::new(false);
        stage_all(
            &self.engine,
            &self.repo,
            &SnapshotRequest::default(),
            &quiet(&cancel),
        )
        .unwrap();
        commit_index(&mut self.repo.lock().unwrap(), &by())
            .unwrap()
            .commit
            .id
            .0
    }

    fn ai_checkpoint(&self, id: &str) -> AiRunRecord {
        let cancel = AtomicBool::new(false);
        let (_, record) = self
            .engine
            .ai_checkpoint(
                &self.repo,
                &SnapshotRequest::default(),
                &quiet(&cancel),
                &CheckpointRequest {
                    agent_run_id: id.into(),
                    reason: "edit".into(),
                    ..Default::default()
                },
                &by(),
            )
            .unwrap();
        ai::report(&mut self.repo.lock().unwrap(), id, RunEvent::Started).unwrap();
        record
    }

    fn ai_record(&self, id: &str, paths: &[&str]) -> AiRunRecord {
        let cancel = AtomicBool::new(false);
        let paths: Vec<ReportedPath> = paths
            .iter()
            .map(|p| ReportedPath {
                folder: None,
                path: (*p).into(),
                expected: None,
            })
            .collect();
        self.engine
            .ai_record_changes(
                &self.repo,
                &SnapshotRequest::default(),
                &quiet(&cancel),
                id,
                &paths,
            )
            .unwrap()
            .1
    }

    fn undo_plan(&self, id: &str) -> AiUndoPlan {
        let cancel = AtomicBool::new(false);
        let (_, plan) = self
            .engine
            .ai_plan_undo(&self.repo, &SnapshotRequest::default(), &quiet(&cancel), id)
            .unwrap();
        assert!(plan.refusals.is_empty(), "{:?}", plan.refusals);
        assert!(
            plan.restore.conflicts.is_empty(),
            "{:?}",
            plan.restore.conflicts
        );
        plan
    }

    /// What `localgit_ai_undo` does when nothing is in the way.
    fn ai_undo(&self, id: &str) -> AiRunRecord {
        let plan = self.undo_plan(id);
        begin_undo(&mut self.repo.lock().unwrap(), &plan).unwrap();
        if !plan.restore.operations.is_empty() {
            assert!(matches!(self.run(&plan.restore), Outcome::Done { .. }));
            assert!(self.verify(&plan.restore).matches);
        }
        finish_undo(&mut self.repo.lock().unwrap(), &plan).unwrap()
    }

    fn ai_status(&self, id: &str) -> AiRunStatus {
        ai::get_run(&self.repo.lock().unwrap(), id).unwrap().status
    }
}

/// A committed base of four files; the AI rewrites all four and adds one, a human keeps work of
/// their own beside it.
fn ai_ran(label: &str) -> Setup {
    let s = setup(label);
    for i in 0..4 {
        put(&s.p(&format!("f{i}.txt")), format!("base {i}"));
    }
    put(&s.p("human.txt"), "base");
    s.commit_everything();
    put(&s.p("human.txt"), "a human's unsaved-to-history work");
    s.ai_checkpoint("run-1");
    for i in 0..4 {
        put(&s.p(&format!("f{i}.txt")), format!("ai {i}"));
    }
    put(&s.p("ai-new.txt"), "made by the AI");
    s.ai_record(
        "run-1",
        &["f0.txt", "f1.txt", "f2.txt", "f3.txt", "ai-new.txt"],
    );
    s
}

#[test]
fn undo_through_the_executor_takes_out_only_the_ais_changes() {
    let s = ai_ran("lg07-undo");
    put(&s.p("during.txt"), "a human, after the AI");
    let record = s.ai_undo("run-1");
    assert_eq!(record.status, AiRunStatus::Undone);
    for i in 0..4 {
        assert_eq!(
            std::fs::read(s.p(&format!("f{i}.txt"))).unwrap(),
            format!("base {i}").into_bytes()
        );
    }
    assert!(!s.p("ai-new.txt").exists());
    assert_eq!(
        std::fs::read(s.p("human.txt")).unwrap(),
        b"a human's unsaved-to-history work"
    );
    assert_eq!(
        std::fs::read(s.p("during.txt")).unwrap(),
        b"a human, after the AI"
    );
}

#[test]
fn an_undo_interrupted_partway_is_finished_by_undoing_again_after_a_restart() {
    let s = ai_ran("lg07-undo-crash");
    let plan = s.undo_plan("run-1");
    begin_undo(&mut s.repo.lock().unwrap(), &plan).unwrap();
    crash::arm(2);
    assert!(catch_unwind(AssertUnwindSafe(|| s.run(&plan.restore))).is_err());
    // The process died here: the run is not undone, and says an undo was under way.
    let record = ai::get_run(&s.repo.lock().unwrap(), "run-1").unwrap();
    assert_ne!(record.status, AiRunStatus::Undone);
    assert!(record.undo.is_some());
    // Module 04 settles the interrupted file operation on the next start...
    let Setup {
        dir,
        project,
        recovery,
        repo,
        engine,
        watch,
    } = s;
    drop(watch);
    let report = recover(&recovery, "the-next-start");
    assert!(report
        .unresolved
        .iter()
        .chain(report.actions.iter())
        .any(|i| i.kind == Some(IntentKind::Restore)));
    // ...and undoing again takes the rest of the way: whatever mix of before and after the
    // paths hold, nothing else.
    let watch = crate::Watch::default();
    watch
        .intents
        .set(Ok(
            ide_workspace::recovery::IntentLog::open(&recovery).unwrap()
        ))
        .unwrap();
    let s = Setup {
        dir,
        project,
        recovery,
        repo,
        engine,
        watch,
    };
    s.ai_undo("run-1");
    for i in 0..4 {
        assert_eq!(
            std::fs::read(s.p(&format!("f{i}.txt"))).unwrap(),
            format!("base {i}").into_bytes()
        );
    }
    assert!(!s.p("ai-new.txt").exists());
    assert_eq!(s.ai_status("run-1"), AiRunStatus::Undone);
}

#[test]
fn a_crash_after_the_checkpoint_or_during_the_ais_changes_loses_nothing() {
    let s = setup("lg07-crash-run");
    put(&s.p("a.txt"), "base");
    s.commit_everything();
    s.ai_checkpoint("run-1");
    // The AI wrote one file, then the process died before anything was reported.
    put(&s.p("a.txt"), "ai, partway");
    let before = listing(&s.project);
    let Setup { dir, project, .. } = s;
    let spec = WorkspaceSpec::from_paths(&[&project]).unwrap();
    let reopened = Repository::open(&dir.join("local-git"), &spec, OpenOptions::default());
    // (The setup's own store still holds the lock in this process: read what is durable.)
    let repo = reopened.unwrap();
    let record = ai::get_run(&repo, "run-1").unwrap();
    assert_eq!(
        record.status,
        AiRunStatus::Running,
        "never assumed to have succeeded"
    );
    assert!(repo
        .read_commit(&ObjectId::from_hex(&record.checkpoint).unwrap())
        .is_ok());
    assert_eq!(
        listing(&project),
        before,
        "the partial change is still there"
    );
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
fn checkpoints_ai_commits_and_undo_never_touch_real_git() {
    let s = setup("lg07-realgit");
    if git(&s.project, &["--version"]).is_none() {
        eprintln!("git is not installed: skipping");
        return;
    }
    git(&s.project, &["init", "-q", "-b", "main"]).unwrap();
    git(&s.project, &["config", "user.email", "t@yavin"]).unwrap();
    git(&s.project, &["config", "user.name", "T"]).unwrap();
    git(&s.project, &["config", "core.autocrlf", "false"]).unwrap();
    put(&s.p("a.txt"), "one\n");
    put(&s.p("b.txt"), "two\n");
    git(&s.project, &["add", "."]).unwrap();
    git(&s.project, &["commit", "-q", "-m", "first"]).unwrap();
    let status_before = git(&s.project, &["status", "--porcelain"]).unwrap();
    let head_before = git(&s.project, &["rev-parse", "HEAD"]).unwrap();
    let branches_before = git(&s.project, &["branch", "--list"]).unwrap();
    let git_before = fingerprint(&s.p(".git"));
    let index_before = std::fs::read(s.p(".git/index")).unwrap();
    let check = |stage: &str| {
        assert_eq!(
            fingerprint(&s.p(".git")),
            git_before,
            "{stage}: .git changed"
        );
        assert_eq!(
            std::fs::read(s.p(".git/index")).unwrap(),
            index_before,
            "{stage}"
        );
        assert_eq!(
            git(&s.project, &["rev-parse", "HEAD"]).unwrap(),
            head_before,
            "{stage}"
        );
        assert_eq!(
            git(&s.project, &["branch", "--list"]).unwrap(),
            branches_before,
            "{stage}"
        );
    };

    s.commit_everything();
    s.ai_checkpoint("run-1");
    check("checkpoint");
    put(&s.p("a.txt"), "one, by the AI\n");
    s.ai_record("run-1", &["a.txt"]);
    let cancel = AtomicBool::new(false);
    let (_, made) = s
        .engine
        .ai_commit(
            &s.repo,
            &SnapshotRequest::default(),
            &quiet(&cancel),
            "run-1",
            None,
            None,
            &by(),
        )
        .unwrap();
    assert!(made.commit.is_some(), "{:?}", made.refusals);
    check("AI commit");
    s.ai_undo("run-1");
    assert_eq!(std::fs::read(s.p("a.txt")).unwrap(), b"one\n");
    check("undo");
    assert_eq!(
        git(&s.project, &["status", "--porcelain"]).unwrap(),
        status_before
    );
    assert!(resolve_head(&s.repo.lock().unwrap()).commit().is_some());
}
