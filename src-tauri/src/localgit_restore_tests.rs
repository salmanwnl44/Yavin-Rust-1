//! Tests of `localgit_restore`: a restore carried out on a real disk, recorded by a real
//! Module 04 intent log, and settled by real recovery after a simulated crash.

use super::*;
use crate::Workspace;
use ide_localgit::history::{commit_snapshot, CommitRequest};
use ide_localgit::restore::{RestorePolicy, Verification};
use ide_localgit::{
    Author, Control, FolderId, FolderRoot, OpenOptions, RequestedMode, SnapshotRequest,
    WorkspaceSpec,
};
use ide_workspace::recovery::{recover, IntentKind, IntentLog, Outcome as Settled};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::AtomicBool;

pub(crate) struct Setup {
    pub(crate) dir: PathBuf,
    pub(crate) project: PathBuf,
    pub(crate) recovery: PathBuf,
    pub(crate) repo: Mutex<Repository>,
    pub(crate) engine: SnapshotEngine,
    pub(crate) watch: Watch,
}

pub(crate) fn setup(label: &str) -> Setup {
    let dir = std::env::temp_dir()
        .canonicalize()
        .unwrap()
        .join(format!("yavin-lg-restore-{label}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let project = dir.join("project");
    fs::create_dir_all(&project).unwrap();
    let recovery = dir.join("recovery");
    let spec = WorkspaceSpec::from_paths(&[&project]).unwrap();
    let repo = Repository::open(&dir.join("local-git"), &spec, OpenOptions::default()).unwrap();
    let record = repo.meta().folders[0].clone();
    let engine = SnapshotEngine::new(
        vec![FolderRoot {
            folder_id: FolderId::new(&record.folder_id).unwrap(),
            path: project.clone(),
            resource_id: record.resource_id,
        }],
        repo.meta().max_blob_bytes,
    );
    let watch = Watch::default();
    watch
        .intents
        .set(Ok(IntentLog::open(&recovery).unwrap()))
        .unwrap();
    Setup {
        dir,
        project,
        recovery,
        repo: Mutex::new(repo),
        engine,
        watch,
    }
}

pub(crate) fn put(path: &Path, bytes: impl AsRef<[u8]>) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

fn control(cancel: &AtomicBool) -> Control<'_> {
    Control {
        cancel,
        progress: &|_| {},
    }
}

impl Setup {
    pub(crate) fn p(&self, rel: &str) -> PathBuf {
        self.project.join(rel)
    }

    pub(crate) fn commit(&self) -> ObjectId {
        let cancel = AtomicBool::new(false);
        let snap = self
            .engine
            .snapshot(
                &self.repo,
                &SnapshotRequest {
                    persist: true,
                    ..Default::default()
                },
                &control(&cancel),
            )
            .unwrap();
        commit_snapshot(
            &mut self.repo.lock().unwrap(),
            &snap,
            &CommitRequest {
                message: "c".into(),
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

    pub(crate) fn plan(&self, commit: ObjectId, path: Option<&str>) -> RestorePlan {
        let cancel = AtomicBool::new(false);
        let (_, plan) = self
            .engine
            .plan_restore(
                &self.repo,
                &SnapshotRequest {
                    mode: RequestedMode::Full,
                    persist: true,
                    ..Default::default()
                },
                &control(&cancel),
                commit,
                path.map(|p| (None, p.to_string())),
                RestorePolicy::RefuseIfDirty,
            )
            .unwrap();
        assert!(plan.conflicts.is_empty(), "{:?}", plan.conflicts);
        plan
    }

    pub(crate) fn run(&self, plan: &RestorePlan) -> Outcome {
        execute(
            &self.watch,
            &self.repo,
            &self.engine,
            plan,
            &self.dir.join("scratch"),
        )
    }

    pub(crate) fn verify(&self, plan: &RestorePlan) -> Verification {
        let cancel = AtomicBool::new(false);
        self.engine
            .verify_restore(&self.repo, &control(&cancel), plan)
            .unwrap()
            .1
    }

    /// Recovery records still open (a crashed operation leaves one).
    fn records(&self) -> usize {
        fs::read_dir(self.recovery.join("instances"))
            .into_iter()
            .flatten()
            .flatten()
            .flat_map(|instance| {
                fs::read_dir(instance.path())
                    .into_iter()
                    .flatten()
                    .flatten()
            })
            .filter(|f| f.file_name().to_string_lossy().starts_with("op-"))
            .count()
    }
}

/// Every entry under `dir`: files with their bytes, links with their targets, folders.
pub(crate) fn listing(dir: &Path) -> Vec<(String, Vec<u8>)> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(at) = stack.pop() {
        for entry in fs::read_dir(&at).unwrap().flatten() {
            let path = entry.path();
            let rel = path
                .strip_prefix(dir)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            let meta = fs::symlink_metadata(&path).unwrap();
            if meta.file_type().is_symlink() {
                let target = fs::read_link(&path).unwrap();
                out.push((rel, target.to_string_lossy().as_bytes().to_vec()));
            } else if meta.is_dir() {
                out.push((format!("{rel}/"), Vec::new()));
                stack.push(path);
            } else {
                out.push((rel, fs::read(&path).unwrap()));
            }
        }
    }
    out.sort();
    out
}

#[test]
fn a_whole_commit_is_restored_as_one_recorded_operation_and_verified() {
    let s = setup("full");
    put(&s.p("keep.txt"), "keep");
    put(&s.p("edit.txt"), "historical\r\n");
    put(&s.p("gone.txt"), "deleted later");
    put(&s.p("dir/inner.txt"), "inner");
    put(&s.p("bin.dat"), [0u8, 159, 146, 150, 0, 1]);
    fs::create_dir_all(s.p("empty/nested-empty")).unwrap();
    put(&s.p("was-dir/x.txt"), "x");
    put(&s.p("was-file"), "file");
    let target = s.commit();
    let wanted = listing(&s.project);

    put(&s.p("edit.txt"), "changed");
    fs::remove_file(s.p("gone.txt")).unwrap();
    fs::remove_dir_all(s.p("dir")).unwrap();
    fs::remove_dir_all(s.p("empty")).unwrap();
    put(&s.p("added.txt"), "added since");
    put(&s.p("new-dir/deep/y.txt"), "y");
    fs::remove_dir_all(s.p("was-dir")).unwrap();
    put(&s.p("was-dir"), "now a file");
    fs::remove_file(s.p("was-file")).unwrap();
    put(&s.p("was-file/z.txt"), "now a dir");

    let plan = s.plan(target, None);
    let Outcome::Done { applied, .. } = s.run(&plan) else {
        panic!("not done");
    };
    assert_eq!(applied, plan.operations.len());
    assert_eq!(
        listing(&s.project),
        wanted,
        "byte for byte, folders included"
    );
    let verification = s.verify(&plan);
    assert!(verification.matches, "{:?}", verification.mismatches);
    assert_eq!(s.records(), 0, "the operation's record was closed");
    // Restoring again: nothing to do.
    assert!(s.plan(target, None).unchanged);
}

#[test]
fn a_single_file_is_restored_and_nothing_else_moves() {
    let s = setup("single");
    put(&s.p("a/b/file.txt"), "historical");
    put(&s.p("other.txt"), "other");
    let target = s.commit();
    fs::remove_dir_all(s.p("a")).unwrap();
    put(&s.p("other.txt"), "changed, and stays changed");
    let plan = s.plan(target, Some("a/b/file.txt"));
    assert!(matches!(s.run(&plan), Outcome::Done { .. }));
    assert_eq!(fs::read(s.p("a/b/file.txt")).unwrap(), b"historical");
    assert_eq!(
        fs::read(s.p("other.txt")).unwrap(),
        b"changed, and stays changed"
    );
    assert!(s.verify(&plan).matches);
}

#[cfg(windows)]
fn junction(link: &Path, target: &Path) {
    let made = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .output()
        .unwrap();
    assert!(made.status.success(), "{made:?}");
}

#[cfg(windows)]
#[test]
fn a_junction_is_recreated_as_a_junction_and_never_followed() {
    let s = setup("junction");
    let outside = s.dir.join("outside");
    put(&outside.join("secret.txt"), "outside the workspace");
    put(&s.p("a.txt"), "a");
    junction(&s.p("link"), &outside);
    let target_text = fs::read_link(s.p("link")).unwrap();
    let target = s.commit();
    fs::remove_dir(s.p("link")).unwrap();
    let plan = s.plan(target, None);
    assert_eq!(plan.operations.len(), 1);
    assert!(
        matches!(s.run(&plan), Outcome::Done { .. }),
        "junction made"
    );
    let meta = fs::symlink_metadata(s.p("link")).unwrap();
    assert!(meta.file_type().is_symlink());
    assert_eq!(fs::read_link(s.p("link")).unwrap(), target_text);
    assert_eq!(
        fs::read(s.p("link").join("secret.txt")).unwrap(),
        b"outside the workspace"
    );
    assert!(s.verify(&plan).matches);

    // Restoring a commit without it removes the link -- never what it points at.
    fs::remove_dir(s.p("link")).unwrap();
    let without = s.commit();
    junction(&s.p("link"), &outside);
    let plan = s.plan(without, None);
    assert!(matches!(s.run(&plan), Outcome::Done { .. }));
    assert!(fs::symlink_metadata(s.p("link")).is_err());
    assert_eq!(
        fs::read(outside.join("secret.txt")).unwrap(),
        b"outside the workspace"
    );
}

#[test]
fn a_path_that_changed_after_planning_refuses_everything() {
    let s = setup("changed");
    put(&s.p("a.txt"), "old");
    put(&s.p("b.txt"), "old");
    let target = s.commit();
    put(&s.p("a.txt"), "new");
    put(&s.p("b.txt"), "new");
    let plan = s.plan(target, None);
    put(&s.p("b.txt"), "changed again, after the plan");
    let Outcome::Refused(conflicts) = s.run(&plan) else {
        panic!("not refused");
    };
    assert!(matches!(
        conflicts.as_slice(),
        [RestoreConflict::DiskChangedSinceSnapshot { path, .. }] if path == "b.txt"
    ));
    // Nothing was touched, a.txt included.
    assert_eq!(fs::read(s.p("a.txt")).unwrap(), b"new");
    assert_eq!(s.records(), 0);
}

#[cfg(windows)]
#[test]
fn nothing_is_written_through_a_link_that_appeared_on_the_way() {
    let s = setup("through-link");
    put(&s.p("dir/file.txt"), "historical");
    let target = s.commit();
    put(&s.p("dir/file.txt"), "current");
    let plan = s.plan(target, None);
    // After planning, `dir` becomes a junction to somewhere outside the workspace.
    let outside = s.dir.join("elsewhere");
    put(&outside.join("file.txt"), "current");
    fs::remove_dir_all(s.p("dir")).unwrap();
    junction(&s.p("dir"), &outside);
    let Outcome::Refused(conflicts) = s.run(&plan) else {
        panic!("not refused");
    };
    assert!(conflicts
        .iter()
        .any(|c| matches!(c, RestoreConflict::PathBlocked { .. })));
    assert_eq!(fs::read(outside.join("file.txt")).unwrap(), b"current");
}

#[test]
fn a_folder_holding_what_snapshots_leave_out_is_never_removed() {
    let s = setup("untracked");
    put(&s.p("keep.txt"), "k");
    let target = s.commit();
    // A folder the commit does not have, holding a nested repository and packages.
    put(&s.p("vendor/lib.rs"), "tracked");
    put(&s.p("vendor/.git/HEAD"), "ref: refs/heads/main\n");
    put(&s.p("vendor/node_modules/x/index.js"), "x");
    let plan = s.plan(target, None);
    let Outcome::Refused(conflicts) = s.run(&plan) else {
        panic!("not refused");
    };
    let entries: Vec<String> = conflicts
        .iter()
        .filter_map(|c| match c {
            RestoreConflict::WouldRemoveUntracked { entry, .. } => Some(entry.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(entries.len(), 2, "{conflicts:?}");
    assert!(s.p("vendor/.git/HEAD").exists());
    assert!(s.p("vendor/lib.rs").exists(), "nothing was removed");
}

#[test]
fn a_restore_that_fails_partway_says_how_far_it_got_and_never_claims_success() {
    let s = setup("fails");
    for i in 0..5 {
        put(&s.p(&format!("f{i}.txt")), format!("historical {i}"));
    }
    let target = s.commit();
    for i in 0..5 {
        put(&s.p(&format!("f{i}.txt")), format!("current {i}"));
    }
    let plan = s.plan(target, None);
    crash::fail(2);
    let Outcome::Failed { applied, error, .. } = s.run(&plan) else {
        panic!("not failed");
    };
    assert_eq!(applied, 2);
    assert!(error.contains("2 of 5 operations were done"), "{error}");
    assert!(!s.verify(&plan).matches);
    // The live process knows the outcome: the record is closed, as for any operation.
    assert_eq!(s.records(), 0);
}

#[test]
fn a_crash_partway_is_settled_by_recovery_as_partial_and_never_replayed() {
    let s = setup("crash");
    for i in 0..6 {
        put(&s.p(&format!("f{i}.txt")), format!("historical {i}"));
    }
    let target = s.commit();
    for i in 0..6 {
        put(&s.p(&format!("f{i}.txt")), format!("current {i}"));
    }
    let plan = s.plan(target, None);
    crash::arm(3);
    let crashed = catch_unwind(AssertUnwindSafe(|| s.run(&plan)));
    assert!(crashed.is_err(), "it crashed");
    assert_eq!(s.records(), 1, "the record survives the crash");
    let before = listing(&s.project);
    // The process is gone: its instance lock goes with it, and the next start settles it.
    let Setup {
        watch,
        recovery,
        project,
        ..
    } = s;
    drop(watch);
    let report = recover(&recovery, "the-next-start");
    let item = report
        .unresolved
        .iter()
        .find(|item| item.kind == Some(IntentKind::Restore))
        .expect("the restore is left for the user");
    assert_eq!(item.outcome, Settled::Partial, "{}", item.message);
    assert!(
        item.message.contains("Local Git restore"),
        "{}",
        item.message
    );
    // Recovery touched nothing.
    assert_eq!(listing(&project), before);
}

#[test]
fn a_crash_after_every_change_is_settled_as_completed() {
    let s = setup("crash-done");
    put(&s.p("a.txt"), "old a");
    put(&s.p("b.txt"), "old b");
    let target = s.commit();
    put(&s.p("a.txt"), "new a");
    put(&s.p("b.txt"), "new b");
    let plan = s.plan(target, None);
    crash::arm(plan.operations.len());
    assert!(catch_unwind(AssertUnwindSafe(|| s.run(&plan))).is_err());
    let Setup {
        watch, recovery, ..
    } = s;
    drop(watch);
    let report = recover(&recovery, "the-next-start");
    let item = report
        .actions
        .iter()
        .find(|item| item.kind == Some(IntentKind::Restore))
        .expect("settled");
    assert_eq!(item.outcome, Settled::Completed);
}

#[test]
fn a_restore_planned_for_one_workspace_only_ever_touches_that_workspace() {
    let a = setup("iso-a");
    let b = setup("iso-b");
    put(&a.p("f.txt"), "historical");
    put(&b.p("f.txt"), "the other workspace");
    let target = a.commit();
    put(&a.p("f.txt"), "current");
    let plan = a.plan(target, None);
    let b_before = listing(&b.project);
    // Workspace B is the window's now; A's plan still runs (as a late job would), against
    // A's folders only.
    assert!(matches!(a.run(&plan), Outcome::Done { .. }));
    assert_eq!(listing(&b.project), b_before);
    assert_eq!(fs::read(a.p("f.txt")).unwrap(), b"historical");
    // And the check the restore command makes right before changing anything: is this
    // handle's workspace still the one open?
    let open_b = Workspace(Mutex::new(Some(
        ide_workspace::file_tree::WorkspaceManager::new(&b.project).unwrap(),
    )));
    let a_id = WorkspaceSpec::from_paths(&[&a.project])
        .unwrap()
        .workspace_id;
    assert!(!crate::localgit::workspace_is_open(&open_b, &a_id));
    let b_id = WorkspaceSpec::from_paths(&[&b.project])
        .unwrap()
        .workspace_id;
    assert!(crate::localgit::workspace_is_open(&open_b, &b_id));
}
