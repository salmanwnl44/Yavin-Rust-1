//! A crash at every durable boundary of "store a commit, then move a ref to it": after each,
//! the store reopens valid, with the ref at exactly its old or its new value, nothing
//! half-published, nothing silently reset, and an interrupted ref update reported and never
//! completed.

mod common;

use common::*;
use ide_localgit::fault::{self, FaultPoint};
use ide_localgit::*;
use std::panic::{catch_unwind, AssertUnwindSafe};

/// Runs `step` with a crash armed at `point`; returns whether the crash happened.
fn crash_at(point: FaultPoint, step: impl FnOnce()) -> bool {
    fault::arm(point);
    let crashed = catch_unwind(AssertUnwindSafe(step)).is_err();
    fault::disarm();
    crashed
}

/// Sets up a store with one commit on main, then crashes while adding a second on top.
/// Returns the fixture, the first commit and the second commit's id (computed ahead, so the
/// test knows it even when the crash came before it was stored).
fn crashed_commit(point: FaultPoint) -> (Fixture, ObjectId) {
    let f = Fixture::new(&format!("crash-{point:?}"));
    let mut repo = f.open().unwrap();
    let first = write_commit(&mut repo, "first", None);
    advance(&mut repo, first);
    let crashed = crash_at(point, || {
        let second = write_commit(&mut repo, "second", Some(first));
        advance(&mut repo, second);
    });
    assert!(crashed, "{point:?} was never reached");
    // The process is gone: its handle and lock with it.
    drop(repo);
    (f, first)
}

fn only_main(repo: &Repository) -> ObjectId {
    *repo.refs().refs.get(&main_ref()).expect("main exists")
}

#[test]
fn a_crash_before_the_segment_is_published_leaves_no_trace_but_a_swept_temp() {
    for point in [
        FaultPoint::SegmentTempCreated,
        FaultPoint::SegmentPartlyWritten,
        FaultPoint::SegmentWritten,
        FaultPoint::SegmentSynced,
    ] {
        let (f, first) = crashed_commit(point);
        let objects_before = {
            let repo = f.open_read_only().unwrap();
            repo.object_count()
        };
        let mut repo = f.open().unwrap();
        assert_eq!(only_main(&repo), first, "{point:?}: the ref never moved");
        assert!(
            repo.findings()
                .iter()
                .any(|finding| matches!(finding, Finding::StaleTempsRemoved { .. })),
            "{point:?}: {:?}",
            repo.findings()
        );
        assert_eq!(
            repo.object_count(),
            objects_before,
            "{point:?}: nothing half-published"
        );
        assert!(listing(&f.store().join("tmp")).is_empty(), "{point:?}");
        assert!(
            repo.verify(true).is_empty(),
            "{point:?}: {:?}",
            repo.verify(true)
        );
        // The store carries on: the same commit can be made again.
        let second = write_commit(&mut repo, "second", Some(first));
        advance(&mut repo, second);
        assert_eq!(only_main(&repo), second);
    }
}

#[test]
fn a_crash_after_the_segment_is_published_leaves_its_objects_unreferenced_and_the_ref_old() {
    let (f, first) = crashed_commit(FaultPoint::SegmentRenamed);
    let repo = f.open().unwrap();
    assert_eq!(only_main(&repo), first);
    assert_eq!(repo.segment_count(), 2, "the second segment is durable");
    assert!(repo.findings().is_empty(), "{:?}", repo.findings());
    assert!(repo.verify(true).is_empty());
}

#[test]
fn half_a_reflog_line_is_set_aside_and_the_ref_stays_old() {
    let (f, first) = crashed_commit(FaultPoint::ReflogPartlyAppended);
    let mut repo = f.open().unwrap();
    assert_eq!(only_main(&repo), first);
    assert!(repo.findings().iter().any(|finding| matches!(
        finding,
        Finding::TornReflog {
            quarantined: Some(_)
        }
    )));
    assert!(!repo
        .findings()
        .iter()
        .any(|finding| matches!(finding, Finding::InterruptedRefUpdate { .. })));
    let again = write_commit(&mut repo, "again", Some(first));
    advance(&mut repo, again);
    drop(repo);
    assert!(f.open().unwrap().findings().is_empty());
}

#[test]
fn an_update_in_the_reflog_but_not_in_refs_is_reported_and_never_completed() {
    let (f, first) = crashed_commit(FaultPoint::ReflogAppended);
    let repo = f.open().unwrap();
    // The ref keeps its old value: which one the user meant is not guessed.
    assert_eq!(only_main(&repo), first);
    let interrupted: Vec<_> = repo
        .findings()
        .iter()
        .filter_map(|finding| match finding {
            Finding::InterruptedRefUpdate { revision, updates } => {
                Some((*revision, updates.clone()))
            }
            _ => None,
        })
        .collect();
    assert_eq!(interrupted.len(), 1, "{:?}", repo.findings());
    let (revision, updates) = &interrupted[0];
    assert_eq!(*revision, 2);
    assert_eq!(updates[0].name, "refs/heads/main");
    assert_eq!(updates[0].old.as_deref(), Some(first.to_hex().as_str()));
    // Its target is kept, so recovery can offer it.
    let target = ObjectId::from_hex(updates[0].new.as_deref().unwrap()).unwrap();
    assert!(repo.contains(&target));
    assert_eq!(repo.read_commit(&target).unwrap().parents, [first]);
    // Marked aborted in the reflog, once.
    let aborted = |repo: &Repository| {
        repo.reflog()
            .unwrap()
            .iter()
            .filter(|record| matches!(record, ReflogRecord::Aborted { revision: 2, .. }))
            .count()
    };
    assert_eq!(aborted(&repo), 1);
    drop(repo);
    let mut repo = f.open().unwrap();
    assert_eq!(aborted(&repo), 1, "reopening does not mark it again");
    assert_eq!(only_main(&repo), first);
    // The next update never reuses the aborted revision.
    let rev = advance(&mut repo, target);
    assert_eq!(rev, 3);
    assert_eq!(only_main(&repo), target);
}

#[test]
fn a_crash_after_refs_json_is_written_keeps_the_new_value() {
    let (f, first) = crashed_commit(FaultPoint::RefsWritten);
    let repo = f.open().unwrap();
    let head = only_main(&repo);
    assert_ne!(head, first);
    assert_eq!(repo.read_commit(&head).unwrap().parents, [first]);
    assert!(repo.findings().is_empty(), "{:?}", repo.findings());
    assert!(repo.verify(true).is_empty());
}

#[test]
fn a_leftover_refs_temp_file_is_swept_and_refs_json_is_untouched() {
    let f = Fixture::new("refs-temp");
    let mut repo = f.open().unwrap();
    let first = write_commit(&mut repo, "first", None);
    advance(&mut repo, first);
    drop(repo);
    // What a crash inside `write_durably` leaves: a temp next to refs.json, never renamed.
    let temp = f.store().join(".refs.json.999-1.yavin-tmp");
    std::fs::write(&temp, b"{ half").unwrap();
    let repo = f.open().unwrap();
    assert!(!temp.exists());
    assert_eq!(only_main(&repo), first);
}
