use crate::id::ObjectId;
use serde::Serialize;

/// Something found while opening or verifying a store that needs to be known -- and, for
/// some, decided by the user -- but that Local Git never resolves by guessing. The store stays
/// usable and inspectable; nothing it held is deleted.
#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Finding {
    /// A ref update reached the reflog but not `refs.json` (a crash in between). The refs keep
    /// their old values; the update is marked aborted in the reflog, and its target objects stay
    /// in the store, so recovery can offer it. Never completed automatically.
    #[serde(rename_all = "camelCase")]
    InterruptedRefUpdate {
        revision: u64,
        updates: Vec<InterruptedUpdate>,
    },
    /// The reflog ended in half a record (a crash while appending). The whole log was copied to
    /// `quarantine/` and the half record removed, so later appends start on a clean line.
    #[serde(rename_all = "camelCase")]
    TornReflog { quarantined: Option<String> },
    /// `refs.json` is at a newer revision than the reflog records (reflog records were lost).
    #[serde(rename_all = "camelCase")]
    ReflogBehind { refs: u64, reflog: u64 },
    /// A segment that could not be read, moved to `quarantine/` (writer) or left in place
    /// (read-only). The objects in it are unavailable.
    #[serde(rename_all = "camelCase")]
    UnreadableSegment {
        segment: String,
        reason: String,
        quarantined: Option<String>,
    },
    /// A ref names an object the store does not have. The ref is not rewritten.
    #[serde(rename_all = "camelCase")]
    DanglingRef { name: String, id: String },
    /// An object that fails its hash check (from a full verify).
    #[serde(rename_all = "camelCase")]
    CorruptObject { id: String, detail: String },
    /// An object reachable from a ref that is not in the store (from a full verify).
    #[serde(rename_all = "camelCase")]
    MissingObject { id: String, from: String },
    /// Temporary files of an interrupted write were removed (they were never published).
    #[serde(rename_all = "camelCase")]
    StaleTempsRemoved { count: usize },
    /// A garbage collection stopped partway (LG-09). The store is consistent -- every live
    /// object is in an old or the new segment -- and nothing was deleted; it is rolled back
    /// explicitly before another GC, never finished on its own.
    #[serde(rename_all = "camelCase")]
    InterruptedGc { id: u64, stage: String },
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InterruptedUpdate {
    pub name: String,
    pub old: Option<String>,
    pub new: Option<String>,
}

pub(crate) fn hex(id: &Option<ObjectId>) -> Option<String> {
    id.map(|id| id.to_hex())
}
