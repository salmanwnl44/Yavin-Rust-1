//! LG-03: restore plans -- complete, ordered, and refused before anything is touched.

mod common;

use common::*;
use ide_localgit::history::*;
use ide_localgit::restore::*;
use ide_localgit::*;
use ide_workspace::file_tree::clean_path_str;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

struct World {
    f: Fixture,
    repo: Mutex<Repository>,
    engine: SnapshotEngine,
}

impl World {
    fn new(label: &str) -> World {
        World::with_limit(label, DEFAULT_MAX_BLOB_BYTES)
    }

    fn with_limit(label: &str, max_blob: u64) -> World {
        let f = Fixture::new(label);
        let repo = Mutex::new(f.open().unwrap());
        let engine = engine_with(&repo.lock().unwrap(), &f.project, max_blob);
        World { f, repo, engine }
    }

    fn p(&self, rel: &str) -> std::path::PathBuf {
        self.f.project.join(rel)
    }

    fn commit(&self) -> ObjectId {
        let snap = persist(&self.engine, &self.repo);
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

    fn plan_with(
        &self,
        commit: ObjectId,
        path: Option<&str>,
        policy: RestorePolicy,
        overlays: Vec<OverlayInput>,
    ) -> RestorePlan {
        let cancel = AtomicBool::new(false);
        self.engine
            .plan_restore(
                &self.repo,
                &SnapshotRequest {
                    overlays,
                    ..Default::default()
                },
                &Control {
                    cancel: &cancel,
                    progress: &|_| {},
                },
                commit,
                path.map(|p| (None, p.to_string())),
                policy,
            )
            .unwrap()
            .1
    }

    fn plan(&self, commit: ObjectId, path: Option<&str>) -> RestorePlan {
        self.plan_with(commit, path, RestorePolicy::RefuseIfDirty, vec![])
    }

    fn overlay(&self, rel: &str, text: &str) -> OverlayInput {
        OverlayInput {
            path: clean_path_str(self.p(rel)),
            bytes: Arc::new(text.as_bytes().to_vec()),
            encoding: "utf8".into(),
            line_ending: "lf".into(),
            version: 7,
        }
    }
}

fn ops(plan: &RestorePlan) -> Vec<String> {
    plan.operations
        .iter()
        .map(|op| format!("{:?} {}", op.kind, op.path))
        .collect()
}

#[test]
fn a_full_restore_plan_removes_then_creates_then_writes() {
    let w = World::new("plan-full");
    write(&w.p("keep.txt"), "keep");
    write(&w.p("edit.txt"), "old");
    write(&w.p("gone.txt"), "deleted later");
    write(&w.p("dir/inner.txt"), "inner");
    std::fs::create_dir_all(w.p("empty")).unwrap();
    write(&w.p("was-dir/x.txt"), "x");
    write(&w.p("was-file"), "file");
    let target = w.commit();

    write(&w.p("edit.txt"), "new");
    std::fs::remove_file(w.p("gone.txt")).unwrap();
    std::fs::remove_dir_all(w.p("dir")).unwrap();
    std::fs::remove_dir(w.p("empty")).unwrap();
    write(&w.p("added.txt"), "added since");
    write(&w.p("new-dir/deep/y.txt"), "y");
    std::fs::remove_dir_all(w.p("was-dir")).unwrap();
    write(&w.p("was-dir"), "now a file");
    std::fs::remove_file(w.p("was-file")).unwrap();
    write(&w.p("was-file/z.txt"), "now a dir");

    let plan = w.plan(target, None);
    assert!(plan.conflicts.is_empty(), "{:?}", plan.conflicts);
    assert!(!plan.unchanged);
    assert_eq!(
        ops(&plan),
        vec![
            // Removals, deepest first.
            "RemoveFile new-dir/deep/y.txt",
            "RemoveDirectory new-dir/deep",
            "RemoveFile was-file/z.txt",
            "RemoveFile added.txt",
            "RemoveDirectory new-dir",
            "RemoveFile was-dir",
            "RemoveDirectory was-file",
            // Folders, shallowest first.
            "CreateDirectory dir",
            "CreateDirectory empty",
            "CreateDirectory was-dir",
            // Files.
            "WriteFile dir/inner.txt",
            "WriteFile edit.txt",
            "WriteFile gone.txt",
            "WriteFile was-dir/x.txt",
            "WriteFile was-file",
        ]
    );
    // Each operation names what it expects to find, for the executor's check.
    let edit = plan
        .operations
        .iter()
        .find(|op| op.path == "edit.txt")
        .unwrap();
    assert_eq!(
        edit.expected,
        Expected::File {
            id: ObjectIdText(blob_id(b"new")),
            stored: true
        }
    );
    assert_eq!(edit.blob, Some(ObjectIdText(blob_id(b"old"))));
    assert_eq!(edit.size, Some(3));
    let gone = plan
        .operations
        .iter()
        .find(|op| op.path == "gone.txt")
        .unwrap();
    assert_eq!(gone.expected, Expected::Absent);
    // A plan is a plan: nothing on disk changed.
    assert_eq!(std::fs::read(w.p("edit.txt")).unwrap(), b"new");
}

#[test]
fn a_workspace_that_already_matches_needs_nothing() {
    let w = World::new("plan-unchanged");
    write(&w.p("a.txt"), "a");
    let target = w.commit();
    let plan = w.plan(target, None);
    assert!(plan.unchanged);
    assert!(plan.operations.is_empty());
}

#[test]
fn a_single_file_restore_touches_only_that_file_and_its_missing_folders() {
    let w = World::new("plan-single");
    write(&w.p("a/b/file.txt"), "historical");
    write(&w.p("other.txt"), "other");
    let target = w.commit();
    write(&w.p("other.txt"), "changed, not restored");
    std::fs::remove_dir_all(w.p("a")).unwrap();
    let plan = w.plan(target, Some("a/b/file.txt"));
    assert_eq!(
        ops(&plan),
        vec![
            "CreateDirectory a",
            "CreateDirectory a/b",
            "WriteFile a/b/file.txt"
        ]
    );
    // Removing a file the commit did not have.
    write(&w.p("extra.txt"), "not in the commit");
    let plan = w.plan(target, Some("extra.txt"));
    assert_eq!(ops(&plan), vec!["RemoveFile extra.txt"]);
    // A path neither has.
    let plan = w.plan(target, Some("nowhere.txt"));
    assert!(matches!(
        plan.conflicts.as_slice(),
        [RestoreConflict::TargetUnavailable { .. }]
    ));
    // A folder on the way that is a file on disk now.
    write(&w.p("a"), "a file where the commit has a folder");
    let plan = w.plan(target, Some("a/b/file.txt"));
    assert!(matches!(
        plan.conflicts.as_slice(),
        [RestoreConflict::PathBlocked { path, .. }] if path == "a"
    ));
}

#[test]
fn unsaved_documents_are_never_overwritten_or_deleted_by_default() {
    let w = World::new("plan-dirty");
    write(&w.p("doc.txt"), "historical");
    let target = w.commit();
    write(&w.p("doc.txt"), "saved later");
    write(&w.p("new.txt"), "not in the commit");
    let overlays = vec![
        w.overlay("doc.txt", "unsaved"),
        w.overlay("new.txt", "unsaved too"),
    ];
    let refused = w.plan_with(target, None, RestorePolicy::RefuseIfDirty, overlays.clone());
    let mut found: Vec<String> = refused.conflicts.iter().map(|c| format!("{c:?}")).collect();
    found.sort();
    assert_eq!(found.len(), 2);
    assert!(found[0].starts_with("DirtyDocumentWouldBeDeleted") && found[0].contains("new.txt"));
    assert!(
        found[1].starts_with("DirtyDocumentWouldBeOverwritten") && found[1].contains("doc.txt")
    );
    assert!(refused.documents.is_empty());

    // By explicit choice: no conflicts, and the documents the window must reconcile.
    let replaced = w.plan_with(target, None, RestorePolicy::ReplaceDocument, overlays);
    assert!(replaced.conflicts.is_empty());
    let actions: Vec<(&str, &str)> = replaced
        .documents
        .iter()
        .map(|d| (d.path.as_str(), d.action))
        .collect();
    assert_eq!(
        actions,
        vec![("doc.txt", "overwrite"), ("new.txt", "delete")]
    );

    // An unsaved document outside a single-file restore's scope is not in the way.
    let scoped = w.plan_with(
        target,
        Some("other.txt"),
        RestorePolicy::RefuseIfDirty,
        vec![w.overlay("doc.txt", "unsaved")],
    );
    assert!(!scoped
        .conflicts
        .iter()
        .any(|c| matches!(c, RestoreConflict::DirtyDocumentWouldBeOverwritten { .. })));
    // An unsaved document already holding exactly the commit's text is not a conflict.
    let same = w.plan_with(
        target,
        None,
        RestorePolicy::RefuseIfDirty,
        vec![w.overlay("doc.txt", "historical")],
    );
    assert!(!same
        .conflicts
        .iter()
        .any(|c| matches!(c, RestoreConflict::DirtyDocumentWouldBeOverwritten { .. })));
}

#[test]
fn content_that_was_never_stored_or_would_be_lost_stops_the_plan() {
    let w = World::with_limit("plan-large", 1024);
    write(&w.p("big.bin"), vec![7u8; 5000]);
    write(&w.p("small.txt"), "small");
    let target = w.commit();
    write(&w.p("big.bin"), vec![8u8; 5000]);
    let plan = w.plan(target, None);
    let mut kinds: Vec<String> = plan
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
    // The commit's big.bin was never stored; today's big.bin could not be checkpointed.
    assert_eq!(
        kinds,
        vec!["CurrentContentNotStored", "HistoricalContentUnavailable"]
    );
    assert!(matches!(
        plan.conflicts
            .iter()
            .find(|c| matches!(c, RestoreConflict::HistoricalContentUnavailable { .. })),
        Some(RestoreConflict::HistoricalContentUnavailable {
            reason: "notStored",
            ..
        })
    ));
    // A restore of just the small file is fine.
    assert!(w.plan(target, Some("small.txt")).conflicts.is_empty());
}

#[cfg(windows)]
#[test]
fn a_file_that_cannot_be_read_now_makes_its_state_unknown() {
    use std::os::windows::fs::OpenOptionsExt;
    let w = World::new("plan-unknown");
    write(&w.p("locked.txt"), "a");
    let target = w.commit();
    write(&w.p("locked.txt"), "b");
    let _lock = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(w.p("locked.txt"))
        .unwrap();
    let plan = w.plan_with(target, None, RestorePolicy::RefuseIfDirty, vec![]);
    // The snapshot's cache still trusted it, or it could not be read: either way, never
    // a silent guess. If it was read from the cache, the plan wants to rewrite it.
    assert!(
        plan.conflicts
            .iter()
            .any(|c| matches!(c, RestoreConflict::CurrentStateUnknown { .. }))
            || plan.operations.iter().any(|op| op.path == "locked.txt"),
        "{plan:?}"
    );
}

#[cfg(windows)]
#[test]
fn a_case_only_difference_is_reported_not_guessed() {
    let w = World::new("plan-case");
    write(&w.p("Readme.md"), "readme");
    let target = w.commit();
    std::fs::rename(w.p("Readme.md"), w.p("README.md")).unwrap();
    let plan = w.plan(target, None);
    assert!(matches!(
        plan.conflicts.as_slice(),
        [RestoreConflict::CaseOnlyRename { path, on_disk, .. }]
            if path == "Readme.md" && on_disk == "README.md"
    ));
}

#[test]
fn a_commit_that_is_not_one_is_refused() {
    let w = World::new("plan-bad-commit");
    write(&w.p("a.txt"), "a");
    w.commit();
    let cancel = AtomicBool::new(false);
    let result = w.engine.plan_restore(
        &w.repo,
        &SnapshotRequest::default(),
        &Control {
            cancel: &cancel,
            progress: &|_| {},
        },
        blob_id(b"a"),
        None,
        RestorePolicy::RefuseIfDirty,
    );
    assert!(matches!(result, Err(LgError::WrongKind { .. })));
}
