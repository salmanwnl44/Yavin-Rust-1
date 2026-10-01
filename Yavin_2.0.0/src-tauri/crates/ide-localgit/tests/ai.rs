//! LG-07: AI runs -- checkpoints, provenance, attribution, the AI commit and Undo AI Run, at the
//! store's level. The disk's side is carried out here by a small stand-in for the app's
//! executor (the app's tests run the real one, with Module 03 and Module 04).

mod common;

use common::*;
use ide_localgit::ai::*;
use ide_localgit::branches::*;
use ide_localgit::fault::{self, FaultPoint};
use ide_localgit::history::*;
use ide_localgit::index::*;
use ide_localgit::restore::{OpKind, RestorePlan};
use ide_localgit::*;
use ide_workspace::file_tree::clean_path_str;
use std::collections::BTreeMap;
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

fn by() -> CommitRequest {
    CommitRequest {
        message: String::new(),
        author: Author {
            name: "Yavin AI".into(),
            id: "ai".into(),
        },
        time_ms: 9,
        tz_offset_min: 0,
    }
}

fn overlay(w: &World, path: &str, text: &str) -> OverlayInput {
    OverlayInput {
        path: clean_path_str(w.p(path)),
        bytes: Arc::new(text.as_bytes().to_vec()),
        encoding: "utf8".into(),
        line_ending: "lf".into(),
        version: 3,
    }
}

fn reported(path: &str) -> ReportedPath {
    ReportedPath {
        folder: None,
        path: path.into(),
        expected: None,
    }
}

impl World {
    fn new(label: &str) -> World {
        let f = Fixture::new(label);
        let repo = Mutex::new(f.open().unwrap());
        let engine = engine_for(&repo, &f.project);
        World { f, repo, engine }
    }

    fn reopen(self) -> World {
        let World { f, repo, .. } = self;
        drop(repo);
        let repo = Mutex::new(f.open().unwrap());
        let engine = engine_for(&repo, &f.project);
        World { f, repo, engine }
    }

    fn p(&self, rel: &str) -> std::path::PathBuf {
        self.f.project.join(rel)
    }

    fn put(&self, rel: &str, text: &str) {
        write(&self.p(rel), text);
    }

    fn read(&self, rel: &str) -> Option<String> {
        std::fs::read(self.p(rel))
            .ok()
            .map(|b| String::from_utf8(b).unwrap())
    }

    fn commit_all(&self) -> ObjectId {
        let cancel = AtomicBool::new(false);
        stage_all(
            &self.engine,
            &self.repo,
            &SnapshotRequest::default(),
            &quiet(&cancel),
        )
        .unwrap();
        let mut request = by();
        request.message = "human".into();
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

    fn head(&self) -> Option<ObjectId> {
        resolve_head(&self.repo.lock().unwrap()).commit()
    }

    fn index_root(&self) -> Option<ObjectId> {
        index_state(&self.repo.lock().unwrap()).unwrap().root
    }

    fn checkpoint_with(&self, id: &str, overlays: Vec<OverlayInput>) -> Result<AiRunRecord> {
        let cancel = AtomicBool::new(false);
        self.engine
            .ai_checkpoint(
                &self.repo,
                &SnapshotRequest {
                    overlays,
                    ..Default::default()
                },
                &quiet(&cancel),
                &CheckpointRequest {
                    agent_run_id: id.into(),
                    task_id: Some("task-7".into()),
                    change_set_id: None,
                    change_set_revision: None,
                    reason: "refactor".into(),
                    model: None,
                },
                &by(),
            )
            .map(|(_, r)| r)
    }

    fn checkpoint(&self, id: &str) -> AiRunRecord {
        let record = self.checkpoint_with(id, vec![]).unwrap();
        report(&mut self.repo.lock().unwrap(), id, RunEvent::Started).unwrap();
        record
    }

    fn record_with(
        &self,
        id: &str,
        paths: &[ReportedPath],
        overlays: Vec<OverlayInput>,
    ) -> Result<AiRunRecord> {
        let cancel = AtomicBool::new(false);
        self.engine
            .ai_record_changes(
                &self.repo,
                &SnapshotRequest {
                    overlays,
                    ..Default::default()
                },
                &quiet(&cancel),
                id,
                paths,
            )
            .map(|(_, r)| r)
    }

    fn record(&self, id: &str, paths: &[&str]) -> AiRunRecord {
        let paths: Vec<ReportedPath> = paths.iter().map(|p| reported(p)).collect();
        self.record_with(id, &paths, vec![]).unwrap()
    }

    fn ai_commit_with(
        &self,
        id: &str,
        revision: Option<&str>,
        overlays: Vec<OverlayInput>,
    ) -> AiCommitResult {
        let cancel = AtomicBool::new(false);
        self.engine
            .ai_commit(
                &self.repo,
                &SnapshotRequest {
                    overlays,
                    ..Default::default()
                },
                &quiet(&cancel),
                id,
                None,
                revision.map(str::to_string),
                &by(),
            )
            .unwrap()
            .1
    }

    fn ai_commit(&self, id: &str) -> AiCommitResult {
        self.ai_commit_with(id, None, vec![])
    }

    fn plan_undo_with(&self, id: &str, overlays: Vec<OverlayInput>) -> AiUndoPlan {
        let cancel = AtomicBool::new(false);
        self.engine
            .ai_plan_undo(
                &self.repo,
                &SnapshotRequest {
                    overlays,
                    ..Default::default()
                },
                &quiet(&cancel),
                id,
            )
            .unwrap()
            .1
    }

    /// Carries a restore plan out, as the app's executor would (files and folders only).
    fn apply(&self, plan: &RestorePlan) {
        assert!(plan.conflicts.is_empty(), "{:?}", plan.conflicts);
        let repo = self.repo.lock().unwrap();
        for op in &plan.operations {
            let path = self.p(&op.path);
            match op.kind {
                OpKind::RemoveFile | OpKind::RemoveLink => std::fs::remove_file(&path).unwrap(),
                OpKind::RemoveDirectory => std::fs::remove_dir(&path).unwrap(),
                OpKind::CreateDirectory => std::fs::create_dir_all(&path).unwrap(),
                OpKind::WriteFile => {
                    let bytes = repo.read_blob(&op.blob.unwrap().0, u64::MAX).unwrap();
                    write(&path, bytes);
                }
                OpKind::CreateLink => panic!("no links in these tests"),
            }
        }
    }

    fn undo_with(&self, id: &str, overlays: Vec<OverlayInput>) -> AiRunRecord {
        let plan = self.plan_undo_with(id, overlays);
        assert!(plan.refusals.is_empty(), "{:?}", plan.refusals);
        begin_undo(&mut self.repo.lock().unwrap(), &plan).unwrap();
        self.apply(&plan.restore);
        finish_undo(&mut self.repo.lock().unwrap(), &plan).unwrap()
    }

    fn undo(&self, id: &str) -> AiRunRecord {
        self.undo_with(id, vec![])
    }

    fn get(&self, id: &str) -> AiRunRecord {
        get_run(&self.repo.lock().unwrap(), id).unwrap()
    }

    fn head_tree(&self) -> BTreeMap<String, String> {
        let repo = self.repo.lock().unwrap();
        let head = resolve_head(&repo).commit().unwrap();
        let root = repo.read_commit(&head).unwrap().root;
        tree_listing(&repo, folder_tree(&repo, root))
    }
}

fn file(text: &str) -> String {
    format!("file {}", blob_id(text.as_bytes()))
}

fn kinds(refusals: &[AiRefusal]) -> Vec<String> {
    refusals
        .iter()
        .map(|r| {
            format!("{r:?}")
                .split([' ', '{'])
                .next()
                .unwrap()
                .to_string()
        })
        .collect()
}

/// A committed base with `foo.txt`, `bar.txt` and `baz.txt`.
fn based(label: &str) -> World {
    let w = World::new(label);
    w.put("foo.txt", "foo\n");
    w.put("bar.txt", "bar\n");
    w.put("baz.txt", "baz\n");
    w.commit_all();
    w
}

#[test]
fn a_checkpoint_records_the_workspace_as_the_user_has_it_and_moves_nothing() {
    let w = based("ai-checkpoint");
    w.put("foo.txt", "human, unsaved to Local Git\n");
    w.put("untracked.txt", "mine");
    w.stage("foo.txt");
    w.put("bar.txt", "bar, unstaged\n");
    let head = w.head();
    let index = w.index_root();
    let revision_refs: Vec<String> = w
        .repo
        .lock()
        .unwrap()
        .refs()
        .refs
        .keys()
        .map(|k| k.as_str().to_string())
        .collect();
    let record = w
        .checkpoint_with("run-1", vec![overlay(&w, "baz.txt", "typed, not saved\n")])
        .unwrap();
    assert_eq!(record.status, AiRunStatus::Checkpointed);
    assert_eq!(record.task_id.as_deref(), Some("task-7"));
    assert_eq!(w.head(), head, "HEAD did not move");
    assert_eq!(w.index_root(), index, "the index did not move");
    assert_eq!(record.head, head.map(|h| h.to_hex()));
    assert_eq!(record.index, index.map(|i| i.to_hex()));
    let repo = w.repo.lock().unwrap();
    let checkpoint = ObjectId::from_hex(&record.checkpoint).unwrap();
    let commit = repo.read_commit(&checkpoint).unwrap();
    assert_eq!(commit.source, Source::Ai);
    assert_eq!(commit.parents, head.into_iter().collect::<Vec<_>>());
    assert_eq!(commit.meta["ai.run"], "run-1");
    assert!(commit.meta_objects.contains_key("overlays"));
    assert!(
        commit.disk_root.is_some(),
        "an unsaved document was applied"
    );
    let tree = tree_listing(&repo, folder_tree(&repo, commit.root));
    assert_eq!(tree["foo.txt"], file("human, unsaved to Local Git\n"));
    assert_eq!(tree["bar.txt"], file("bar, unstaged\n"));
    assert_eq!(tree["baz.txt"], file("typed, not saved\n"));
    assert_eq!(tree["untracked.txt"], file("mine"));
    // Only the run's own ref was added: no branch, no checkpoint ref, no HEAD change.
    let added: Vec<String> = repo
        .refs()
        .refs
        .keys()
        .map(|k| k.as_str().to_string())
        .filter(|k| !revision_refs.contains(k))
        .collect();
    assert_eq!(added.len(), 1);
    assert!(added[0].starts_with(AI_PREFIX));
    drop(repo);
    // The same run id twice is refused.
    assert!(matches!(
        w.checkpoint_with("run-1", vec![]),
        Err(LgError::AlreadyExists(_))
    ));
    // And it survives a restart.
    let w = w.reopen();
    assert_eq!(w.get("run-1"), record);
}

#[test]
fn a_read_only_store_cannot_checkpoint_so_the_ai_must_not_begin() {
    let w = based("ai-readonly");
    let World {
        f, repo: writer, ..
    } = w;
    let reader = Mutex::new(f.open().unwrap());
    assert!(matches!(reader.lock().unwrap().mode(), Mode::ReadOnly(_)));
    let engine = engine_for(&reader, &f.project);
    let cancel = AtomicBool::new(false);
    let result = engine.ai_checkpoint(
        &reader,
        &SnapshotRequest::default(),
        &quiet(&cancel),
        &CheckpointRequest {
            agent_run_id: "run-ro".into(),
            reason: "x".into(),
            ..Default::default()
        },
        &by(),
    );
    assert!(
        matches!(result, Err(LgError::ReadOnly)),
        "{:?}",
        result.err()
    );
    drop(writer);
}

#[test]
fn runs_are_associated_with_tasks_and_changesets_before_or_after_and_across_restarts() {
    let w = based("ai-assoc");
    w.checkpoint("run-1");
    let record = associate(
        &mut w.repo.lock().unwrap(),
        "run-1",
        "cs-1",
        Some("r1".into()),
    )
    .unwrap();
    assert_eq!(record.change_set_id.as_deref(), Some("cs-1"));
    assert!(matches!(
        associate(&mut w.repo.lock().unwrap(), "run-1", "cs-2", None),
        Err(LgError::ChangeSetMismatch(_))
    ));
    assert!(matches!(
        associate(&mut w.repo.lock().unwrap(), "no-such-run", "cs-1", None),
        Err(LgError::NotFound(_))
    ));
    let w = w.reopen();
    let again = associate(
        &mut w.repo.lock().unwrap(),
        "run-1",
        "cs-1",
        Some("r2".into()),
    )
    .unwrap();
    assert_eq!(again.change_set_revision.as_deref(), Some("r2"));
    assert_eq!(again.task_id.as_deref(), Some("task-7"));
    // Another workspace's store does not know the run.
    let other = based("ai-assoc-other");
    assert!(matches!(
        associate(&mut other.repo.lock().unwrap(), "run-1", "cs-1", None),
        Err(LgError::NotFound(_))
    ));
}

#[test]
fn the_lifecycle_is_reported_never_assumed() {
    let w = based("ai-lifecycle");
    w.checkpoint_with("run-1", vec![]).unwrap();
    let report_as = |event| report(&mut w.repo.lock().unwrap(), "run-1", event);
    assert!(matches!(
        report_as(RunEvent::Validated(Validation {
            passed: true,
            reference: None
        })),
        Err(LgError::AiRunState(_))
    ));
    report_as(RunEvent::Started).unwrap();
    w.put("bar.txt", "ai\n");
    assert_eq!(
        w.record("run-1", &["bar.txt"]).status,
        AiRunStatus::ChangesDetected
    );
    let validated = report_as(RunEvent::Validated(Validation {
        passed: true,
        reference: Some("check-42".into()),
    }))
    .unwrap();
    assert_eq!(validated.status, AiRunStatus::Validated);
    // More changes after validation: no longer the validated ones.
    w.put("baz.txt", "ai too\n");
    let changed = w.record("run-1", &["baz.txt"]);
    assert_eq!(changed.status, AiRunStatus::ChangesDetected);
    assert!(changed.validation.is_none());
    // A run whose process ended without saying so stays as it was after a restart.
    let w = w.reopen();
    assert_eq!(w.get("run-1").status, AiRunStatus::ChangesDetected);
}

#[test]
fn only_the_ais_own_changes_are_attributed_and_ambiguity_is_refused() {
    let w = based("ai-attr");
    w.put("foo.txt", "human before\n");
    w.checkpoint("run-1");
    w.put("bar.txt", "ai\n");
    w.put("baz.txt", "a human, while the AI ran\n");
    w.put("new-by-human.txt", "h");
    let record = w.record("run-1", &["bar.txt"]);
    assert_eq!(record.changes.len(), 1);
    assert_eq!(record.changes[0].path, "bar.txt");
    assert_eq!(
        record.unattributed,
        vec![
            format!("{}:baz.txt", record.changes[0].folder_id),
            format!("{}:new-by-human.txt", record.changes[0].folder_id)
        ]
    );
    // The caller says what the AI wrote; the workspace holds something else.
    w.put("bar.txt", "someone else\n");
    let result = w.record_with(
        "run-1",
        &[ReportedPath {
            folder: None,
            path: "bar.txt".into(),
            expected: Some(Some(blob_id(b"ai\n"))),
        }],
        vec![],
    );
    assert!(matches!(result, Err(LgError::AttributionAmbiguous(_))));
}

#[test]
fn the_ai_commit_holds_only_the_ais_changes_and_keeps_human_work_where_it_was() {
    let w = based("ai-commit");
    // Human work before the run: an unstaged change, a staged change, an untracked file, and
    // an unsaved document.
    w.put("foo.txt", "human unstaged\n");
    w.put("baz.txt", "human staged\n");
    w.stage("baz.txt");
    w.put("notes.txt", "untracked");
    let unsaved = overlay(&w, "foo.txt", "human typing\n");
    w.checkpoint_with("run-1", vec![unsaved.clone()]).unwrap();
    report(&mut w.repo.lock().unwrap(), "run-1", RunEvent::Started).unwrap();
    associate(
        &mut w.repo.lock().unwrap(),
        "run-1",
        "cs-9",
        Some("rev-1".into()),
    )
    .unwrap();
    // The AI changes bar.txt and adds a file; a human changes notes.txt meanwhile.
    w.put("bar.txt", "bar by the AI\n");
    w.put("gen/new.rs", "fn main() {}\n");
    w.put("notes.txt", "untracked, edited during the run");
    w.record_with(
        "run-1",
        &[reported("bar.txt"), reported("gen/new.rs")],
        vec![unsaved.clone()],
    )
    .unwrap();
    report(
        &mut w.repo.lock().unwrap(),
        "run-1",
        RunEvent::Validated(Validation {
            passed: true,
            reference: Some("ci-1".into()),
        }),
    )
    .unwrap();
    let head = w.head().unwrap();
    let staged_before = status(&w.engine, &w.repo)
        .entries
        .into_iter()
        .filter(|e| e.staged.is_some())
        .map(|e| e.path)
        .collect::<Vec<_>>();
    assert_eq!(staged_before, vec!["baz.txt"]);
    let result = w.ai_commit_with("run-1", Some("rev-1"), vec![unsaved]);
    assert!(result.refusals.is_empty(), "{:?}", result.refusals);
    let made = result.commit.unwrap();
    assert_eq!(made.parents, vec![ObjectIdText(head)]);
    let tree = w.head_tree();
    assert_eq!(tree["bar.txt"], file("bar by the AI\n"));
    assert_eq!(tree["gen/new.rs"], file("fn main() {}\n"));
    assert_eq!(
        tree["foo.txt"],
        file("foo\n"),
        "the human's change is not in it"
    );
    assert_eq!(
        tree["baz.txt"],
        file("baz\n"),
        "nor the human's staged change"
    );
    assert!(!tree.contains_key("notes.txt"));
    let repo = w.repo.lock().unwrap();
    let commit = repo.read_commit(&made.id.0).unwrap();
    assert_eq!(commit.source, Source::Ai);
    assert_eq!(commit.meta["ai.run"], "run-1");
    assert_eq!(commit.meta["ai.task"], "task-7");
    assert_eq!(commit.meta["ai.changeset"], "cs-9");
    assert_eq!(commit.meta["ai.validation"], "passed");
    assert_eq!(commit.meta["ai.validation-ref"], "ci-1");
    assert!(!commit.meta.contains_key("ai.model"), "never invented");
    assert_eq!(commit.message, "AI: refactor");
    drop(repo);
    // Staged work stays staged; the working tree was not touched.
    let staged_after = status(&w.engine, &w.repo)
        .entries
        .into_iter()
        .filter(|e| e.staged.is_some())
        .map(|e| e.path)
        .collect::<Vec<_>>();
    assert_eq!(staged_after, vec!["baz.txt"]);
    assert_eq!(w.read("foo.txt").unwrap(), "human unstaged\n");
    assert_eq!(w.get("run-1").status, AiRunStatus::Committed);
    // No second commit for the same run.
    let cancel = AtomicBool::new(false);
    assert!(matches!(
        w.engine.ai_commit(
            &w.repo,
            &SnapshotRequest::default(),
            &quiet(&cancel),
            "run-1",
            None,
            None,
            &by()
        ),
        Err(LgError::AiRunState(_))
    ));
}

#[test]
fn an_ai_commit_is_refused_whenever_ownership_is_not_certain() {
    // A human changed an AI path after the AI; a path already held a human change at the
    // checkpoint; something is staged on an AI path; HEAD moved; the ChangeSet moved on.
    let w = based("ai-commit-refused");
    w.put("baz.txt", "human, before the run\n");
    w.checkpoint("run-1");
    associate(
        &mut w.repo.lock().unwrap(),
        "run-1",
        "cs",
        Some("r1".into()),
    )
    .unwrap();
    w.put("foo.txt", "ai foo\n");
    w.put("bar.txt", "ai bar\n");
    w.put("baz.txt", "ai baz\n");
    w.record("run-1", &["foo.txt", "bar.txt", "baz.txt"]);
    w.put("foo.txt", "a human edited the AI's file\n");
    w.stage("bar.txt");
    let head = w.head();
    let result = w.ai_commit_with("run-1", Some("r2"), vec![]);
    assert!(result.commit.is_none());
    assert_eq!(
        kinds(&result.refusals),
        vec![
            "StaleChangeSet",
            "StagedOnAiPath",
            "PreexistingHumanChange",
            "HumanChangedAiPath"
        ]
    );
    assert_eq!(w.head(), head, "nothing moved");
    w.put("foo.txt", "ai foo\n");
    // HEAD moving under the run is refused too.
    let w2 = based("ai-commit-head-moved");
    w2.checkpoint("run-2");
    w2.put("bar.txt", "ai\n");
    w2.record("run-2", &["bar.txt"]);
    w2.put("foo.txt", "a human commit meanwhile\n");
    w2.stage("foo.txt");
    commit_index(
        &mut w2.repo.lock().unwrap(),
        &CommitRequest {
            message: "human".into(),
            ..by()
        },
    )
    .unwrap();
    let result = w2.ai_commit("run-2");
    assert_eq!(kinds(&result.refusals), vec!["HeadMoved"]);
}

#[test]
fn undo_takes_out_exactly_the_ais_changes() {
    // A: created, B: modified, deleted -- with unrelated human work kept, staged and unstaged.
    let w = based("ai-undo-basic");
    w.put("foo.txt", "human unstaged\n");
    w.put("staged.txt", "human staged\n");
    w.stage("staged.txt");
    let index = w.index_root();
    w.checkpoint("run-1");
    w.put("created.txt", "by the AI\n");
    w.put("bar.txt", "bar by the AI\n");
    std::fs::remove_file(w.p("baz.txt")).unwrap();
    w.record("run-1", &["created.txt", "bar.txt", "baz.txt"]);
    w.put("human-after.txt", "kept");
    let record = w.undo("run-1");
    assert_eq!(record.status, AiRunStatus::Undone);
    assert_eq!(w.read("created.txt"), None);
    assert_eq!(w.read("bar.txt").unwrap(), "bar\n");
    assert_eq!(w.read("baz.txt").unwrap(), "baz\n");
    assert_eq!(w.read("foo.txt").unwrap(), "human unstaged\n");
    assert_eq!(w.read("staged.txt").unwrap(), "human staged\n");
    assert_eq!(w.read("human-after.txt").unwrap(), "kept");
    assert_eq!(w.index_root(), index, "the index is untouched");
    assert!(matches!(
        w.engine.ai_plan_undo(
            &w.repo,
            &SnapshotRequest::default(),
            &quiet(&AtomicBool::new(false)),
            "run-1"
        ),
        Err(LgError::AiRunState(_))
    ));
}

#[test]
fn undo_keeps_a_humans_later_edit_when_the_inverse_is_clean_and_refuses_otherwise() {
    let w = World::new("ai-undo-merge");
    w.put("a.txt", "1\n2\n3\n4\n5\n6\n7\n8\n");
    w.put("b.txt", "x\n");
    w.put("c.txt", "c\n");
    w.commit_all();
    w.checkpoint("run-1");
    w.put("a.txt", "1 AI\n2\n3\n4\n5\n6\n7\n8\n");
    w.put("b.txt", "x AI\n");
    w.put("created.txt", "by the AI\n");
    std::fs::remove_file(w.p("c.txt")).unwrap();
    w.record("run-1", &["a.txt", "b.txt", "created.txt", "c.txt"]);
    // C: a human edits elsewhere in the AI's file -> kept; the same line -> conflict.
    w.put("a.txt", "1 AI\n2\n3\n4\n5\n6\n7\n8 human\n");
    w.put("b.txt", "x AI and human\n");
    // D: the human edits the file the AI created. E: the human recreates what the AI deleted.
    w.put("created.txt", "by the AI, edited by a human\n");
    w.put("c.txt", "recreated by a human\n");
    let plan = w.plan_undo_with("run-1", vec![]);
    let mut got = kinds(&plan.refusals);
    got.sort();
    assert_eq!(
        got,
        vec!["HumanChangedAiPath", "HumanChangedAiPath", "UndoConflict"]
    );
    assert!(plan.merged.iter().any(|p| p.ends_with(":a.txt")));
    // Nothing was touched.
    assert_eq!(
        w.read("created.txt").unwrap(),
        "by the AI, edited by a human\n"
    );
    // With the conflicting edits out of the way, the clean inverse keeps the human's line.
    w.put("b.txt", "x AI\n");
    w.put("created.txt", "by the AI\n");
    std::fs::remove_file(w.p("c.txt")).unwrap();
    w.undo("run-1");
    assert_eq!(w.read("a.txt").unwrap(), "1\n2\n3\n4\n5\n6\n7\n8 human\n");
    assert_eq!(w.read("b.txt").unwrap(), "x\n");
    assert_eq!(w.read("created.txt"), None);
    assert_eq!(w.read("c.txt").unwrap(), "c\n");
}

#[test]
fn undo_never_overwrites_unsaved_human_text_but_replaces_the_ais_own() {
    let w = based("ai-undo-docs");
    w.checkpoint("run-1");
    w.put("bar.txt", "ai\n");
    w.record("run-1", &["bar.txt"]);
    // The user typed in bar.txt without saving.
    let plan = w.plan_undo_with("run-1", vec![overlay(&w, "bar.txt", "user typing\n")]);
    assert_eq!(kinds(&plan.refusals), vec!["DirtyDocument"]);
    // An unsaved document holding exactly the AI's text is the AI's: replaced.
    let ai_text = overlay(&w, "bar.txt", "ai\n");
    let plan = w.plan_undo_with("run-1", vec![ai_text.clone()]);
    assert!(plan.refusals.is_empty());
    assert_eq!(plan.restore.documents.len(), 1);
    assert_eq!(plan.restore.documents[0].action, "overwrite");
    w.undo_with("run-1", vec![ai_text]);
    assert_eq!(w.read("bar.txt").unwrap(), "bar\n");
}

#[test]
fn partial_cancelled_and_failed_runs_keep_everything_and_can_be_undone() {
    for event in ["cancelled", "failed", "interrupted"] {
        let w = based(&format!("ai-partial-{event}"));
        w.checkpoint("run-1");
        w.put("bar.txt", "half done\n");
        w.record("run-1", &["bar.txt"]);
        match event {
            "cancelled" => {
                report(
                    &mut w.repo.lock().unwrap(),
                    "run-1",
                    RunEvent::Cancelled(Some("user".into())),
                )
                .unwrap();
            }
            "failed" => {
                report(
                    &mut w.repo.lock().unwrap(),
                    "run-1",
                    RunEvent::Failed(Some("tool error".into())),
                )
                .unwrap();
            }
            _ => {}
        }
        // Nothing was rolled back on its own.
        assert_eq!(w.read("bar.txt").unwrap(), "half done\n");
        let w = w.reopen();
        let record = w.get("run-1");
        assert_eq!(record.changes.len(), 1, "{event}");
        assert!(record.checkpoint.len() == 64);
        if event == "interrupted" {
            assert_eq!(
                record.status,
                AiRunStatus::ChangesDetected,
                "never 'succeeded'"
            );
        }
        w.undo("run-1");
        assert_eq!(w.read("bar.txt").unwrap(), "bar\n", "{event}");
    }
}

#[test]
fn undoing_a_committed_run_moves_head_back_only_while_it_is_still_the_runs_commit() {
    let w = based("ai-undo-committed");
    w.put("staged.txt", "human staged\n");
    w.stage("staged.txt");
    let head = w.head();
    w.checkpoint("run-1");
    w.put("bar.txt", "ai\n");
    w.record("run-1", &["bar.txt"]);
    let made = w.ai_commit("run-1").commit.unwrap().id.0;
    assert_eq!(w.head(), Some(made));
    w.undo("run-1");
    assert_eq!(w.head(), head, "back on the commit's parent");
    assert_eq!(w.read("bar.txt").unwrap(), "bar\n");
    let staged: Vec<String> = status(&w.engine, &w.repo)
        .entries
        .into_iter()
        .filter(|e| e.staged.is_some())
        .map(|e| e.path)
        .collect();
    assert_eq!(staged, vec!["staged.txt"], "the human's staging survives");
    // The commit itself is not lost: the record still names it.
    let repo = w.repo.lock().unwrap();
    assert!(repo.read_commit(&made).is_ok());
    assert!(repo.verify(true).is_empty());
    drop(repo);

    // Once history moved on, undo refuses (a revert is the way then).
    let w = based("ai-undo-moved-on");
    w.checkpoint("run-2");
    w.put("bar.txt", "ai\n");
    w.record("run-2", &["bar.txt"]);
    w.ai_commit("run-2");
    w.put("foo.txt", "later human work\n");
    w.commit_all();
    let plan = w.plan_undo_with("run-2", vec![]);
    assert_eq!(kinds(&plan.refusals), vec!["HistoryMovedOn"]);
}

#[test]
fn a_crash_at_any_ref_step_leaves_the_old_or_the_new_record() {
    for point in [
        FaultPoint::SegmentWritten,
        FaultPoint::ReflogAppended,
        FaultPoint::RefsWritten,
    ] {
        // The checkpoint: there, durable, or not at all -- never half.
        let w = based("ai-crash-checkpoint");
        let crashed = catch_unwind(AssertUnwindSafe(|| {
            fault::arm(point);
            let result = w.checkpoint_with("run-1", vec![]);
            fault::disarm();
            result
        }));
        fault::disarm();
        assert!(crashed.is_err(), "{point:?}");
        let w = w.reopen();
        let found = find_run(&w.repo.lock().unwrap(), "run-1").unwrap();
        assert_eq!(
            found.is_some(),
            point == FaultPoint::RefsWritten,
            "{point:?}"
        );
        assert!(w.repo.lock().unwrap().verify(true).is_empty());

        // The AI commit: HEAD, index and record together, or none of them.
        let w = based("ai-crash-commit");
        let head = w.head();
        w.checkpoint("run-2");
        w.put("bar.txt", "ai\n");
        w.record("run-2", &["bar.txt"]);
        let crashed = catch_unwind(AssertUnwindSafe(|| {
            fault::arm(point);
            let result = w.ai_commit("run-2");
            fault::disarm();
            result
        }));
        fault::disarm();
        assert!(crashed.is_err(), "{point:?}");
        let w = w.reopen();
        let record = w.get("run-2");
        if point == FaultPoint::RefsWritten {
            assert_eq!(record.status, AiRunStatus::Committed);
            assert_eq!(w.head().map(|h| h.to_hex()), record.commit);
        } else {
            assert_eq!(record.status, AiRunStatus::ChangesDetected, "{point:?}");
            assert_eq!(
                w.head(),
                head,
                "{point:?}: no commit, never completed by itself"
            );
            // And committing again makes exactly one.
            let result = w.ai_commit("run-2");
            assert!(result.commit.is_some());
        }
        // Exactly one AI commit on the branch, right on top of where HEAD was.
        let repo = w.repo.lock().unwrap();
        let tip = resolve_head(&repo).commit().unwrap();
        let made = repo.read_commit(&tip).unwrap();
        assert_eq!(made.source, Source::Ai, "{point:?}");
        assert_eq!(
            made.parents,
            head.into_iter().collect::<Vec<_>>(),
            "{point:?}: no duplicate commit"
        );
        drop(repo);

        // The end of an undo: the run undone (and HEAD back), or still to finish.
        let w = based("ai-crash-undo");
        w.checkpoint("run-3");
        w.put("bar.txt", "ai\n");
        w.record("run-3", &["bar.txt"]);
        let plan = w.plan_undo_with("run-3", vec![]);
        begin_undo(&mut w.repo.lock().unwrap(), &plan).unwrap();
        w.apply(&plan.restore);
        let crashed = catch_unwind(AssertUnwindSafe(|| {
            fault::arm(point);
            let result = finish_undo(&mut w.repo.lock().unwrap(), &plan);
            fault::disarm();
            result
        }));
        fault::disarm();
        assert!(crashed.is_err(), "{point:?}");
        let w = w.reopen();
        let record = w.get("run-3");
        if point == FaultPoint::RefsWritten {
            assert_eq!(record.status, AiRunStatus::Undone);
        } else {
            assert_ne!(record.status, AiRunStatus::Undone);
            assert!(record.undo.is_some(), "the undo under way is recorded");
            // Undoing again finishes it: the disk already holds the targets.
            let plan = w.plan_undo_with("run-3", vec![]);
            assert!(plan.restore.operations.is_empty());
            finish_undo(&mut w.repo.lock().unwrap(), &plan).unwrap();
        }
        assert_eq!(w.read("bar.txt").unwrap(), "bar\n");
    }
}

#[test]
fn ai_history_lists_runs_newest_first_with_what_became_of_them() {
    let w = based("ai-history");
    for (i, id) in ["run-a", "run-b", "run-c"].iter().enumerate() {
        w.checkpoint(id);
        std::thread::sleep(std::time::Duration::from_millis(5));
        if i == 1 {
            w.put("bar.txt", "ai b\n");
            w.record(id, &["bar.txt"]);
            w.ai_commit(id);
        }
    }
    let list = list_runs(&w.repo.lock().unwrap(), 2).unwrap();
    assert_eq!(list.total, 3);
    let ids: Vec<&str> = list.items.iter().map(|r| r.agent_run_id.as_str()).collect();
    assert_eq!(ids, vec!["run-c", "run-b"]);
    assert_eq!(list.items[1].status, AiRunStatus::Committed);
    assert!(list.items[1].commit.is_some());
}
