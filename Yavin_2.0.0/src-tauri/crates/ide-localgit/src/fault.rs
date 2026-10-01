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
    /// GC: the live objects are copied into a new segment; no old segment is retired yet.
    GcCopied,
    /// GC: the old segments are in quarantine; the journal does not say done yet.
    GcRetired,
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

/// A test's hook into a file read: called after a file's bytes were read and before its
/// metadata is checked again, with the path and the attempt (0, then 1 on the retry). Tests
/// change, delete or lock the file here to exercise the snapshot's race detection. Hooks are
/// keyed by path, so tests running in parallel (in other temp directories) never see each
/// other's.
#[cfg(any(test, feature = "fault-injection"))]
pub mod read_hook {
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex, OnceLock};

    type Hook = Arc<dyn Fn(&Path, u32) + Send + Sync>;

    fn hooks() -> &'static Mutex<HashMap<PathBuf, Hook>> {
        static HOOKS: OnceLock<Mutex<HashMap<PathBuf, Hook>>> = OnceLock::new();
        HOOKS.get_or_init(Default::default)
    }

    /// Calls `hook` whenever the file at `path` has just been read.
    pub fn set(path: &Path, hook: impl Fn(&Path, u32) + Send + Sync + 'static) {
        hooks()
            .lock()
            .unwrap()
            .insert(path.to_path_buf(), Arc::new(hook));
    }

    pub fn clear(path: &Path) {
        hooks().lock().unwrap().remove(path);
    }

    pub(crate) fn run(path: &Path, attempt: u32) {
        let hook = hooks().lock().unwrap().get(path).cloned();
        if let Some(hook) = hook {
            hook(path, attempt);
        }
    }
}

#[cfg(not(any(test, feature = "fault-injection")))]
pub(crate) mod read_hook {
    #[inline(always)]
    pub(crate) fn run(_path: &std::path::Path, _attempt: u32) {}
}
