//! Simulated crashes at every durable boundary, for tests.
//!
//! A crash is a panic at the armed point: everything after it -- including the clean-up an
//! ordinary error would run -- does not happen, exactly as when the process dies there. Tests
//! catch the panic, drop what they held (which releases the writer lock, as a dead process
//! would) and reopen the store. Without the `fault-injection` feature (or `cfg(test)`) every
//! point compiles to nothing.

/// Where a crash can be simulated, in the order a commit passes them.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FaultPoint {
    /// The temporary segment exists, with its header only.
    SegmentTempCreated,
    /// Some objects are in the temporary segment, no index yet.
    SegmentPartlyWritten,
    /// The whole temporary segment is written, not yet synced.
    SegmentWritten,
    /// Synced, not yet renamed into `objects/`.
    SegmentSynced,
    /// Published in `objects/`; nothing refers to it yet.
    SegmentRenamed,
    /// Half a reflog line is on disk.
    ReflogPartlyAppended,
    /// The reflog records the update; `refs.json` does not yet.
    ReflogAppended,
    /// `refs.json` holds the update; the in-memory state does not yet.
    RefsWritten,
}

#[cfg(any(test, feature = "fault-injection"))]
mod armed {
    use super::FaultPoint;
    use std::cell::Cell;

    thread_local! {
        pub static POINT: Cell<Option<FaultPoint>> = const { Cell::new(None) };
    }
}

/// Makes the next pass through `point` on this thread crash.
#[cfg(any(test, feature = "fault-injection"))]
pub fn arm(point: FaultPoint) {
    armed::POINT.with(|armed| armed.set(Some(point)));
}

/// Clears any armed point on this thread.
#[cfg(any(test, feature = "fault-injection"))]
pub fn disarm() {
    armed::POINT.with(|armed| armed.set(None));
}

#[cfg(any(test, feature = "fault-injection"))]
pub(crate) fn hit(point: FaultPoint) {
    let fire = armed::POINT.with(|armed| {
        if armed.get() == Some(point) {
            armed.set(None);
            true
        } else {
            false
        }
    });
    if fire {
        panic!("simulated crash at {point:?}");
    }
}

#[cfg(not(any(test, feature = "fault-injection")))]
#[inline(always)]
pub(crate) fn hit(_point: FaultPoint) {}
