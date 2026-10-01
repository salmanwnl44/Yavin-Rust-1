//! LG-09: garbage collection, retention, storage statistics and integrity.

mod common;

use common::*;
use ide_localgit::ai;
use ide_localgit::fault::{self, FaultPoint};
use ide_localgit::gc::{self, GcStage, RetentionPolicy};
use ide_localgit::*;
use std::collections::BTreeMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;

const DAY: u64 = 24 * 60 * 60 * 1000;

fn now() -> u64 {
    ide_workspace::durable::now_millis() as u64
}

/// Nothing from the reflog keeps anything: only live refs do.
fn refs_only() -> RetentionPolicy {
    RetentionPolicy {
        reflog_max_age_days: Some(0),
        reflog_keep_recent: 0,
        ai_finished_max_age_days: None,
    }
}

/// An object nothing refers to: a blob, the tree holding it, a root and a commit.
fn orphan(repo: &mut Repository, text: &str) -> [ObjectId; 4] {
    let folder = FolderId::new(&repo.meta().folders[0].folder_id).unwrap();
    let workspace = repo.meta().workspace.clone();
    let mut txn = repo.begin_write().unwrap();
    let blob = txn.put_blob(text.as_bytes()).unwrap();
    let tree = txn
        .put_tree(
            &Tree::new(vec![TreeEntry {
                name: EntryName::new("orphan.txt").unwrap(),
                kind: EntryKind::File {
                    executable: false,
                    stored: Stored::Yes,
                },
                id: blob,
            }])
            .unwrap(),
        )
        .unwrap();
    let root = txn
        .put_root(&Root {
            folders: [(folder, tree)].into_iter().collect(),
        })
        .unwrap();
    let commit = txn
        .put_commit(&Commit {
            root,
            disk_root: None,
            parents: vec![],
            workspace,
            author: Author {
                name: "T".into(),
                id: "t".into(),
            },
            time_ms: 0,
            tz_offset_min: 0,
            source: Source::Automatic,
            meta: BTreeMap::new(),
            meta_objects: BTreeMap::new(),
            message: format!("orphan {text}"),
        })
        .unwrap();
    txn.commit().unwrap();
    [blob, tree, root, commit]
}

fn set_ref(repo: &mut Repository, name: &str, id: Option<ObjectId>) {
    let name = RefName::new(name).unwrap();
    let expected = repo.refs().refs.get(&name).copied();
    let revision = repo.refs().revision;
    repo.update_refs(
        revision,
        &[RefUpdate {
            name,
            expected,
            new: id,
        }],
        None,
        "test",
        "set",
    )
    .unwrap();
}

fn collect(repo: &mut Repository, policy: &RetentionPolicy, at: u64) -> gc::GcOutcome {
    let plan = gc::plan(repo, policy, at).unwrap();
    gc::run(repo, &plan, at).unwrap()
}

#[test]
fn unreachable_objects_go_to_quarantine_and_everything_reachable_stays() {
    let f = Fixture::new("gc-basic");
    let mut repo = f.open().unwrap();
    let one = write_commit(&mut repo, "one", None);
    advance(&mut repo, one);
    let two = write_commit(&mut repo, "two", Some(one));
    advance(&mut repo, two);
    let garbage = orphan(&mut repo, "nobody wants me");
    let plan = gc::plan(&repo, &RetentionPolicy::default(), now()).unwrap();
    assert_eq!(plan.unreachable, 4, "blob, tree, root, commit");
    assert!(plan.unreachable_bytes > 0);
    assert!(plan.missing.is_empty());
    assert_eq!(plan.protected["branch"], 1);
    let outcome = gc::run(&mut repo, &plan, now()).unwrap();
    assert!(outcome.objects_after < outcome.objects_before);
    for id in garbage {
        assert!(!repo.contains(&id), "{id} collected");
    }
    for id in [one, two] {
        assert!(repo.read_commit(&id).is_ok());
    }
    assert!(repo.verify(true).is_empty());
    // Nothing was deleted yet: the old segments wait in quarantine.
    let quarantine = f.store().join(outcome.quarantine.unwrap());
    assert!(std::fs::read_dir(&quarantine).unwrap().count() > 0);
    let stats = gc::stats(&repo).unwrap();
    assert!(stats.quarantine_gc_bytes > 0);
    assert_eq!(stats.last_gc.unwrap().stage, GcStage::Done);
    // Reopening sees the same store; purging removes the quarantine, and only it.
    drop(repo);
    let mut repo = f.open().unwrap();
    assert!(repo.findings().is_empty(), "{:?}", repo.findings());
    assert!(repo.verify(true).is_empty());
    let purged = gc::purge(&mut repo).unwrap();
    assert_eq!(purged.folders.len(), 1);
    assert!(!quarantine.exists());
    assert!(repo.verify(true).is_empty());
    // A second GC finds nothing to do.
    let again = gc::plan(&repo, &RetentionPolicy::default(), now()).unwrap();
    assert_eq!(again.unreachable, 0);
}

#[test]
fn every_kind_of_ref_is_a_root() {
    let f = Fixture::new("gc-roots");
    let mut repo = f.open().unwrap();
    let mut kept = Vec::new();
    for name in [
        "refs/heads/main",
        "refs/heads/feature",
        "refs/tags/v1",
        "refs/yavin/index",
        "refs/yavin/checkpoint",
        "refs/yavin/operation",
        "refs/yavin/stash/s0000000000001-000",
        "refs/yavin/ai/r000000000000000000000001",
        "refs/yavin/something-new",
    ] {
        let id = write_commit(&mut repo, name, None);
        set_ref(&mut repo, name, Some(id));
        kept.push(id);
    }
    let plan = gc::plan(&repo, &refs_only(), now()).unwrap();
    for kind in [
        "branch",
        "tag",
        "index",
        "checkpoint",
        "operation",
        "stash",
        "aiRun",
        "other",
    ] {
        assert!(
            plan.protected.contains_key(kind),
            "{kind}: {:?}",
            plan.protected
        );
    }
    // Only live refs protect anything here, and every one of them does.
    gc::run(&mut repo, &plan, now()).unwrap();
    for id in kept {
        assert!(repo.read_commit(&id).is_ok());
    }
    assert!(repo.verify(true).is_empty());
}

#[test]
fn deleted_branches_and_dropped_stashes_stay_while_their_reflog_does() {
    let f = Fixture::new("gc-reflog");
    let mut repo = f.open().unwrap();
    let main = write_commit(&mut repo, "main", None);
    set_ref(&mut repo, "refs/heads/main", Some(main));
    let branch = write_commit(&mut repo, "feature", Some(main));
    set_ref(&mut repo, "refs/heads/feature", Some(branch));
    let stash = write_commit(&mut repo, "stash", Some(main));
    set_ref(
        &mut repo,
        "refs/yavin/stash/s0000000000001-000",
        Some(stash),
    );
    set_ref(&mut repo, "refs/heads/feature", None);
    set_ref(&mut repo, "refs/yavin/stash/s0000000000001-000", None);
    // By default history keeps them.
    collect(&mut repo, &RetentionPolicy::default(), now());
    assert!(repo.contains(&branch) && repo.contains(&stash));
    // Once retention lets that history go, they are collectible -- the live branch never.
    let later = now() + 10 * DAY;
    let policy = RetentionPolicy {
        reflog_max_age_days: Some(7),
        reflog_keep_recent: 0,
        ai_finished_max_age_days: None,
    };
    let plan = gc::plan(&repo, &policy, later).unwrap();
    assert!(plan.expired_reflog_entries > 0);
    gc::run(&mut repo, &plan, later).unwrap();
    assert!(!repo.contains(&branch));
    assert!(!repo.contains(&stash));
    assert!(repo.read_commit(&main).is_ok());
    // The reflog still names them: expired history, not corruption.
    assert!(repo.verify(true).is_empty());
    let again = gc::plan(&repo, &policy, later).unwrap();
    assert!(again.missing.is_empty());
}

#[test]
fn retention_keeps_each_refs_newest_entries_and_lets_old_checkpoints_go() {
    let f = Fixture::new("gc-retention");
    let mut repo = f.open().unwrap();
    let main = write_commit(&mut repo, "main", None);
    set_ref(&mut repo, "refs/heads/main", Some(main));
    let mut checkpoints = Vec::new();
    for i in 0..5 {
        let id = write_commit(&mut repo, &format!("checkpoint {i}"), Some(main));
        set_ref(&mut repo, "refs/yavin/checkpoint", Some(id));
        checkpoints.push(id);
    }
    let later = now() + 30 * DAY;
    let policy = RetentionPolicy {
        reflog_max_age_days: Some(7),
        reflog_keep_recent: 2,
        ai_finished_max_age_days: None,
    };
    collect(&mut repo, &policy, later);
    // The ref's own (newest) and the newest two reflog entries' checkpoints remain.
    assert!(repo.contains(&checkpoints[4]));
    assert!(repo.contains(&checkpoints[3]));
    assert!(
        !repo.contains(&checkpoints[0]),
        "an old automatic checkpoint expired"
    );
    assert!(repo.contains(&main), "the branch is never subject to age");
    // The checkpoint list shows only what is still there.
    let listed = ide_localgit::history::checkpoints(&repo, 100).unwrap();
    assert!(listed.iter().all(|c| repo.contains(&c.id.0)));
}

fn engine(repo: &Mutex<Repository>, f: &Fixture) -> SnapshotEngine {
    engine_for(repo, &f.project)
}

#[test]
fn ai_runs_that_may_still_be_undone_are_kept_and_finished_ones_can_expire() {
    let f = Fixture::new("gc-ai");
    write(&f.project.join("a.txt"), "a");
    let repo = Mutex::new(f.open().unwrap());
    let engine = engine(&repo, &f);
    let cancel = AtomicBool::new(false);
    let control = Control {
        cancel: &cancel,
        progress: &|_| {},
    };
    let by = ide_localgit::history::CommitRequest {
        message: String::new(),
        author: Author {
            name: "AI".into(),
            id: "ai".into(),
        },
        time_ms: 0,
        tz_offset_min: 0,
    };
    let checkpoint = |id: &str| {
        engine
            .ai_checkpoint(
                &repo,
                &SnapshotRequest::default(),
                &control,
                &ai::CheckpointRequest {
                    agent_run_id: id.into(),
                    reason: "x".into(),
                    ..Default::default()
                },
                &by,
            )
            .unwrap()
            .1
    };
    let active = checkpoint("active");
    let interrupted = checkpoint("interrupted");
    ai::report(
        &mut repo.lock().unwrap(),
        "interrupted",
        ai::RunEvent::Started,
    )
    .unwrap();
    let finished = checkpoint("finished");
    ai::report(
        &mut repo.lock().unwrap(),
        "finished",
        ai::RunEvent::Cancelled(None),
    )
    .unwrap();
    let mut repo = repo.into_inner().unwrap();
    let later = now() + 60 * DAY;
    let policy = RetentionPolicy {
        reflog_max_age_days: Some(7),
        reflog_keep_recent: 0,
        ai_finished_max_age_days: Some(30),
    };
    let plan = gc::plan(&repo, &policy, later).unwrap();
    assert_eq!(plan.expired_ai_runs, vec!["finished".to_string()]);
    let outcome = gc::run(&mut repo, &plan, later).unwrap();
    assert_eq!(outcome.expired_ai_runs, vec!["finished".to_string()]);
    assert!(ai::find_run(&repo, "finished").unwrap().is_none());
    for record in [active, interrupted] {
        let kept = ai::get_run(&repo, &record.agent_run_id).unwrap();
        assert!(repo.contains(&ObjectId::from_hex(&kept.checkpoint).unwrap()));
    }
    assert!(repo.verify(true).is_empty());
    let _ = finished;
}

#[test]
fn an_interrupted_gc_is_reported_and_rolled_back_never_finished_by_itself() {
    for point in [FaultPoint::GcCopied, FaultPoint::GcRetired] {
        let f = Fixture::new("gc-crash");
        let mut repo = f.open().unwrap();
        let one = write_commit(&mut repo, "one", None);
        advance(&mut repo, one);
        let garbage = orphan(&mut repo, "garbage");
        let plan = gc::plan(&repo, &RetentionPolicy::default(), now()).unwrap();
        let crashed = catch_unwind(AssertUnwindSafe(|| {
            fault::arm(point);
            let result = gc::run(&mut repo, &plan, now());
            fault::disarm();
            result
        }));
        fault::disarm();
        assert!(crashed.is_err(), "{point:?}");
        drop(repo);
        let mut repo = f.open().unwrap();
        assert!(
            repo.findings()
                .iter()
                .any(|finding| matches!(finding, Finding::InterruptedGc { .. })),
            "{point:?}: {:?}",
            repo.findings()
        );
        // Consistent either way: everything reachable is readable.
        assert!(repo.read_commit(&one).is_ok(), "{point:?}");
        // No new GC, and no purge, until it is rolled back.
        let plan = gc::plan(&repo, &RetentionPolicy::default(), now()).unwrap();
        assert!(matches!(
            gc::run(&mut repo, &plan, now()),
            Err(LgError::RecoveryRequired(_))
        ));
        assert!(matches!(
            gc::purge(&mut repo),
            Err(LgError::RecoveryRequired(_))
        ));
        let rolled = gc::roll_back(&mut repo).unwrap().unwrap();
        assert_eq!(rolled.stage, GcStage::RolledBack);
        assert!(repo.verify(true).is_empty(), "{point:?}");
        // Then a GC runs normally.
        collect(&mut repo, &RetentionPolicy::default(), now());
        assert!(!repo.contains(&garbage[0]), "{point:?}");
        assert!(repo.verify(true).is_empty(), "{point:?}");
    }
}

#[test]
fn a_store_that_changed_since_the_plan_or_is_damaged_is_not_collected() {
    let f = Fixture::new("gc-stale");
    let mut repo = f.open().unwrap();
    let one = write_commit(&mut repo, "one", None);
    advance(&mut repo, one);
    orphan(&mut repo, "x");
    let plan = gc::plan(&repo, &RetentionPolicy::default(), now()).unwrap();
    let two = write_commit(&mut repo, "two", Some(one));
    advance(&mut repo, two);
    assert!(matches!(
        gc::run(&mut repo, &plan, now()),
        Err(LgError::StaleRevision { .. })
    ));
    // A ref naming a missing object: refused, nothing moved.
    let missing = ObjectId::from_hex(&"ab".repeat(32)).unwrap();
    let mut refs = std::fs::read_to_string(f.store().join("refs.json")).unwrap();
    refs = refs.replace(&two.to_hex(), &missing.to_hex());
    std::fs::write(f.store().join("refs.json"), refs).unwrap();
    drop(repo);
    let mut repo = f.open().unwrap();
    let plan = gc::plan(&repo, &RetentionPolicy::default(), now()).unwrap();
    assert!(!plan.missing.is_empty());
    let segments = repo.segment_count();
    assert!(matches!(
        gc::run(&mut repo, &plan, now()),
        Err(LgError::RecoveryRequired(_))
    ));
    assert_eq!(repo.segment_count(), segments);
}

#[test]
fn a_second_process_cannot_collect() {
    let f = Fixture::new("gc-readonly");
    let mut writer = f.open().unwrap();
    let one = write_commit(&mut writer, "one", None);
    advance(&mut writer, one);
    orphan(&mut writer, "x");
    let mut reader = f.open().unwrap();
    assert!(matches!(reader.mode(), Mode::ReadOnly(_)));
    let plan = gc::plan(&reader, &RetentionPolicy::default(), now()).unwrap();
    assert!(plan.unreachable > 0, "a reader may look");
    assert!(matches!(
        gc::run(&mut reader, &plan, now()),
        Err(LgError::ReadOnly)
    ));
    assert!(matches!(gc::purge(&mut reader), Err(LgError::ReadOnly)));
    drop(writer);
}

#[test]
fn gc_in_one_workspace_never_touches_another() {
    let a = Fixture::new("gc-iso-a");
    let b = Fixture::new("gc-iso-b");
    let mut repo_a = a.open().unwrap();
    let mut repo_b = b.open().unwrap();
    let one = write_commit(&mut repo_a, "a", None);
    advance(&mut repo_a, one);
    orphan(&mut repo_a, "a garbage");
    let b_orphan = orphan(&mut repo_b, "b garbage");
    let b_before = listing(&b.store());
    collect(&mut repo_a, &RetentionPolicy::default(), now());
    assert_eq!(listing(&b.store()), b_before);
    assert!(repo_b.contains(&b_orphan[0]));
}

#[test]
fn integrity_reports_problems_with_steps_and_repairs_nothing() {
    let f = Fixture::new("gc-integrity");
    let mut repo = f.open().unwrap();
    let one = write_commit(&mut repo, "integrity-marker-content", None);
    advance(&mut repo, one);
    let report = gc::integrity(&repo, true);
    assert!(report.ok, "{report:?}");
    // A flipped byte inside a stored blob.
    drop(repo);
    let objects = f.store().join("objects");
    let segment = std::fs::read_dir(&objects)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let mut bytes = std::fs::read(&segment).unwrap();
    let marker = b"integrity-marker-content";
    let at = bytes
        .windows(marker.len())
        .position(|w| w == marker)
        .expect("the blob is in the segment");
    bytes[at] ^= 0x20;
    std::fs::write(&segment, &bytes).unwrap();
    // An operation ref naming a commit with no state.
    let repo = f.open().unwrap();
    let report = gc::integrity(&repo, true);
    assert!(!report.ok);
    assert!(report
        .findings
        .iter()
        .any(|finding| matches!(finding, Finding::CorruptObject { .. })));
    assert!(!report.repair.is_empty());
    let before = std::fs::read(&segment).unwrap();
    drop(repo);
    let mut repo = f.open().unwrap();
    let plain = write_commit(&mut repo, "not an operation", None);
    set_ref(&mut repo, "refs/yavin/operation", Some(plain));
    let report = gc::integrity(&repo, false);
    assert!(
        report
            .records
            .iter()
            .any(|r| r.starts_with("operation state")),
        "{report:?}"
    );
    assert_eq!(
        std::fs::read(&segment).unwrap(),
        before,
        "nothing was repaired"
    );
}

/// Everything reachable from the live refs, walked independently through the public API.
fn expected_reachable(repo: &Repository) -> std::collections::HashSet<ObjectId> {
    let mut seen = std::collections::HashSet::new();
    let mut stack: Vec<ObjectId> = repo.refs().refs.values().copied().collect();
    while let Some(id) = stack.pop() {
        if !seen.insert(id) {
            continue;
        }
        if let Ok(commit) = repo.read_commit(&id) {
            stack.push(commit.root);
            stack.extend(commit.disk_root);
            stack.extend(commit.parents.iter().copied());
            stack.extend(commit.meta_objects.values().copied());
        } else if let Ok(root) = repo.read_root(&id) {
            stack.extend(root.folders.values().copied());
        } else if let Ok(tree) = repo.read_tree(&id) {
            for entry in tree.entries() {
                if !matches!(
                    entry.kind,
                    EntryKind::File {
                        stored: Stored::No { .. },
                        ..
                    }
                ) {
                    stack.push(entry.id);
                }
            }
        }
    }
    seen
}

#[test]
fn a_randomized_history_keeps_exactly_what_its_refs_reach_through_gc_and_reopening() {
    let f = Fixture::new("gc-random");
    let mut repo = f.open().unwrap();
    let mut seed: u64 = 0x5eed_1234_abcd_0001;
    let mut next = move |n: u64| {
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (seed >> 33) % n
    };
    let names = [
        "refs/heads/main",
        "refs/heads/feature",
        "refs/heads/experiment",
        "refs/tags/v1",
        "refs/tags/v2",
        "refs/yavin/checkpoint",
        "refs/yavin/stash/s0000000000001-000",
        "refs/yavin/stash/s0000000000002-000",
        // (AI run refs name AI records, which have their own test.)
        "refs/yavin/index",
    ];
    let mut commits: Vec<ObjectId> = Vec::new();
    for step in 0..400 {
        match next(5) {
            // A commit on top of a random earlier one (or a root).
            0 | 1 => {
                let parent = (!commits.is_empty() && next(4) > 0)
                    .then(|| commits[next(commits.len() as u64) as usize]);
                commits.push(write_commit(&mut repo, &format!("step {step}"), parent));
            }
            // A ref moved to a commit, or deleted.
            2 | 3 if !commits.is_empty() => {
                let name = names[next(names.len() as u64) as usize];
                let target = if next(5) == 0 {
                    None
                } else {
                    Some(commits[next(commits.len() as u64) as usize])
                };
                set_ref(&mut repo, name, target);
            }
            // Garbage nothing refers to.
            _ => {
                orphan(&mut repo, &format!("orphan {step}"));
            }
        }
    }
    let expected = expected_reachable(&repo);
    let at = now() + 365 * DAY;
    collect(&mut repo, &refs_only(), at);
    for id in &expected {
        assert!(repo.contains(id), "{id} was reachable and is gone");
    }
    assert_eq!(
        repo.object_count(),
        expected.len(),
        "nothing unreachable is left"
    );
    drop(repo);
    let mut repo = f.open().unwrap();
    assert!(repo.findings().is_empty(), "{:?}", repo.findings());
    assert!(repo.verify(true).is_empty());
    assert_eq!(expected_reachable(&repo), expected);
    gc::purge(&mut repo).unwrap();
    assert!(gc::integrity(&repo, true).ok);
}
