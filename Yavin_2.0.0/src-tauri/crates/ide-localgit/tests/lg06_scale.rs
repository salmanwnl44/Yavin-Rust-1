//! LG-06 at scale (run on purpose, in release):
//! `cargo test -p ide-localgit --release --test lg06_scale -- --ignored --nocapture --test-threads=1`
//!
//! Fast-forward, a clean three-way merge, a merge with conflicts, recording its state,
//! resolving, continuing, aborting, and a cherry-pick, over 10,000 files (and 100,000 with
//! the second test). Planning includes the Full snapshot every one of them needs.

mod common;

use common::*;
use ide_localgit::branches::*;
use ide_localgit::history::*;
use ide_localgit::index::*;
use ide_localgit::merge::*;
use ide_localgit::reset::{reset_mixed, ResetPolicy, ResetTarget};
use ide_localgit::restore::{OpKind, RestorePlan};
use ide_localgit::*;
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;
use std::time::{Duration, Instant};

fn ms(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

fn path_of(i: usize) -> String {
    format!(
        "pkg{}/mod{}/sub{}/file{i}.ts",
        i % 10,
        (i / 10) % 10,
        (i / 100) % 100
    )
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

struct Scale {
    f: Fixture,
    repo: Mutex<Repository>,
    engine: SnapshotEngine,
    files: usize,
}

impl Scale {
    fn quiet<'a>(&self, cancel: &'a AtomicBool) -> Control<'a> {
        Control {
            cancel,
            progress: &|_| {},
        }
    }

    fn write(&self, set: &[usize], text: &str) {
        for &i in set {
            std::fs::write(self.f.project.join(path_of(i)), format!("{text} {i}\n")).unwrap();
        }
    }

    fn commit(&self, message: &str) -> ObjectId {
        let cancel = AtomicBool::new(false);
        stage_all(
            &self.engine,
            &self.repo,
            &SnapshotRequest::default(),
            &self.quiet(&cancel),
        )
        .unwrap();
        commit_index(&mut self.repo.lock().unwrap(), &by(message))
            .unwrap()
            .commit
            .id
            .0
    }

    fn apply(&self, plan: &RestorePlan) {
        assert!(plan.conflicts.is_empty(), "{:?}", &plan.conflicts[..1]);
        let repo = self.repo.lock().unwrap();
        for op in &plan.operations {
            let path = self.f.project.join(&op.path);
            match op.kind {
                OpKind::WriteFile => {
                    let bytes = repo.read_blob(&op.blob.unwrap().0, u64::MAX).unwrap();
                    std::fs::write(path, bytes).unwrap();
                }
                OpKind::RemoveFile => std::fs::remove_file(path).unwrap(),
                other => panic!("{other:?} not expected here"),
            }
        }
    }

    fn plan(&self, request: OperationRequest) -> (OperationPlan, Duration) {
        let cancel = AtomicBool::new(false);
        let started = Instant::now();
        let (_, plan) = self
            .engine
            .plan_operation(
                &self.repo,
                &SnapshotRequest::default(),
                &self.quiet(&cancel),
                &request,
                &by(""),
            )
            .unwrap();
        (plan, started.elapsed())
    }

    fn merge(&self, branch: &str) -> (OperationPlan, Duration) {
        self.plan(OperationRequest::Merge {
            target: ResetTarget::Branch(branch.into()),
            message: None,
        })
    }

    /// Records, changes the disk, finishes: the time of the store's part (not the disk's).
    fn run(&self, plan: &OperationPlan) -> Duration {
        let started = Instant::now();
        begin(&mut self.repo.lock().unwrap(), plan).unwrap();
        let recorded = started.elapsed();
        self.apply(plan.restore.as_ref().unwrap());
        let started = Instant::now();
        finish_apply(&mut self.repo.lock().unwrap()).unwrap();
        recorded + started.elapsed()
    }

    /// Moves main to `to` (index too) and puts `set` back to `text` on disk.
    fn main_to(&self, to: ObjectId, set: &[usize], text: &str) {
        reset_mixed(&mut self.repo.lock().unwrap(), &ResetTarget::Commit(to)).unwrap();
        self.write(set, text);
    }
}

fn scale(files: usize) {
    let f = Fixture::new(&format!("lg06scale{files}"));
    for i in 0..files {
        let path = f.project.join(path_of(i));
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, format!("base {i}\n")).unwrap();
    }
    std::thread::sleep(Duration::from_millis(3500));
    let repo = Mutex::new(f.open().unwrap());
    let engine = engine_for(&repo, &f.project);
    let s = Scale {
        f,
        repo,
        engine,
        files,
    };
    let step = s.files / 10;
    let theirs: Vec<usize> = (0..10).map(|n| n * step).collect();
    let ours: Vec<usize> = (0..10).map(|n| n * step + 1).collect();
    let base = s.commit("base");

    // Fast-forward: main at base, feature 10 files ahead.
    s.write(&theirs, "theirs");
    let ahead = s.commit("theirs");
    create_branch(&mut s.repo.lock().unwrap(), "feature", Some(ahead)).unwrap();
    s.main_to(base, &theirs, "base");
    let (ff, ff_plan) = s.merge("feature");
    assert_eq!(ff.outcome, Outcome::FastForward);
    assert_eq!(ff.restore.as_ref().unwrap().operations.len(), 10);

    // A clean three-way merge: 10 files each side.
    s.write(&ours, "ours");
    let ours_tip = s.commit("ours");
    let (clean, clean_plan) = s.merge("feature");
    assert_eq!(clean.outcome, Outcome::Merged);
    let clean_run = s.run(&clean);
    let merged = resolve_head(&s.repo.lock().unwrap()).commit().unwrap();

    // Conflicts: the same 10 files changed on both sides of the merge commit.
    s.write(&ours, "ours again");
    let ours_again = s.commit("ours again");
    s.main_to(merged, &ours, "ours");
    s.write(&ours, "theirs again");
    let theirs_again = s.commit("theirs again");
    create_branch(&mut s.repo.lock().unwrap(), "other", Some(theirs_again)).unwrap();
    s.main_to(ours_again, &ours, "ours again");
    let before_conflicts = listing(&s.f.project).len();
    let (conflicted, conflict_plan) = s.merge("other");
    assert_eq!(conflicted.conflicts.len(), 10);
    let conflict_run = s.run(&conflicted);

    // Abort it (plan with its Full snapshot, then the refs).
    let cancel = AtomicBool::new(false);
    let started = Instant::now();
    let (_, abort) = s
        .engine
        .plan_abort(
            &s.repo,
            &SnapshotRequest::default(),
            &s.quiet(&cancel),
            ResetPolicy::RefuseIfDirty,
        )
        .unwrap();
    let abort_plan = started.elapsed();
    s.apply(&abort);
    let started = Instant::now();
    finish_abort(&mut s.repo.lock().unwrap()).unwrap();
    let abort_finish = started.elapsed();
    assert_eq!(listing(&s.f.project).len(), before_conflicts);

    // Again, then resolve every conflict and continue.
    let (conflicted, _) = s.merge("other");
    s.run(&conflicted);
    let mut resolve_times = Vec::new();
    for conflict in &conflicted.conflicts {
        let started = Instant::now();
        let (_, plan) = s
            .engine
            .plan_resolve(
                &s.repo,
                &SnapshotRequest::default(),
                &s.quiet(&cancel),
                None,
                &conflict.path,
                ResolveChoice::TakeTheirs,
                ResetPolicy::RefuseIfDirty,
            )
            .unwrap();
        record_resolve(&mut s.repo.lock().unwrap(), &plan).unwrap();
        s.apply(plan.restore.as_ref().unwrap());
        finish_resolve(&mut s.repo.lock().unwrap(), &plan).unwrap();
        resolve_times.push(started.elapsed());
    }
    let started = Instant::now();
    finish_continue(&mut s.repo.lock().unwrap(), None, &by("")).unwrap();
    let continue_time = started.elapsed();

    // A cherry-pick of a 10-file commit from elsewhere.
    let head = resolve_head(&s.repo.lock().unwrap()).commit().unwrap();
    let pick_set: Vec<usize> = (0..10).map(|n| n * step + 2).collect();
    s.write(&pick_set, "picked");
    let picked = s.commit("to pick");
    create_branch(&mut s.repo.lock().unwrap(), "pick", Some(picked)).unwrap();
    s.main_to(head, &pick_set, "base");
    let (pick, pick_plan) = s.plan(OperationRequest::CherryPick { commit: picked });
    assert_eq!(pick.outcome, Outcome::Merged);
    let pick_run = s.run(&pick);
    let _ = ours_tip;
    assert!(s.repo.lock().unwrap().verify(false).is_empty());
    let resolve_avg =
        resolve_times.iter().map(|d| ms(*d)).sum::<f64>() / resolve_times.len() as f64;
    println!(
        "{files} files (plans include their Full snapshot): fast-forward plan {:.0} ms; clean \
         merge plan {:.0} ms, record+finish {:.1} ms; 10-conflict merge plan {:.0} ms, \
         record+finish {:.1} ms; abort plan {:.0} ms, finish {:.1} ms; resolve (plan with \
         snapshot, record, finish) {:.0} ms each; continue {:.1} ms; cherry-pick plan {:.0} ms, \
         record+finish {:.1} ms",
        ms(ff_plan),
        ms(clean_plan),
        ms(clean_run),
        ms(conflict_plan),
        ms(conflict_run),
        ms(abort_plan),
        ms(abort_finish),
        resolve_avg,
        ms(continue_time),
        ms(pick_plan),
        ms(pick_run),
    );
}

#[test]
#[ignore]
fn lg06_scale_10k_files() {
    scale(10_000);
}

#[test]
#[ignore]
fn lg06_scale_100k_files() {
    scale(100_000);
}
