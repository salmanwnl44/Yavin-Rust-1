//! The merge or cherry-pick in progress (LG-06), as durable state.
//!
//! An operation that cannot finish in one step -- its disk change is under way, or conflicts
//! wait for the user -- is recorded as an object: a small commit (source `automatic`, never on
//! any branch's history) whose `metaobj state` blob is the `OperationState` below, as JSON, and
//! whose other `metaobj`s name every commit and root the state refers to (so they stay
//! reachable). The ref `refs/yavin/operation` names it. Every change of the state moves that ref
//! in the same compare-and-swap of the refs (LG-01) as whatever else changes with it -- the
//! index for a resolution, HEAD and the index when the operation completes -- so after a crash
//! the state is the old one or the new one, never half of each, and a new state is never
//! completed by anyone but the user.
//!
//! While an operation is in progress, HEAD and the index change only through it (resolve,
//! continue, abort): commits, staging, switching, resets, reverts, stashes and another merge or
//! cherry-pick are refused (`OperationInProgress`). Checkpoints and restores of files, which
//! move neither, are not.

use crate::error::{LgError, Result};
use crate::id::ObjectId;
use crate::object::{Author, Commit, EntryKind, EntryName, LinkKind, Source, Stored, TreeEntry};
use crate::refs::{RefName, RefUpdate};
use crate::repository::Repository;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const OPERATION_REF: &str = "refs/yavin/operation";

/// The state's format version: a newer one is never read as something it is not.
pub const STATE_VERSION: u32 = 1;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OperationKind {
    Merge,
    CherryPick,
}

impl OperationKind {
    /// The reflog's operation name.
    pub fn op(self) -> &'static str {
        match self {
            OperationKind::Merge => "merge",
            OperationKind::CherryPick => "cherry-pick",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    /// Recorded; the disk is being changed -- or was, when the process stopped partway. Continue
    /// takes the disk the rest of the way; abort takes it back.
    Applying,
    /// The disk holds the result; conflicts wait to be resolved.
    Conflicts,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictKind {
    /// Both sides added different things at the path.
    AddAdd,
    /// Both sides changed the path, differently.
    ModifyModify,
    /// Ours deleted what theirs changed.
    DeleteModify,
    /// Ours changed what theirs deleted.
    ModifyDelete,
    /// A file on one side, a link on the other.
    TypeChange,
    /// A folder on one side, a file or link on the other.
    DirectoryFile,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Resolution {
    Unresolved,
    /// Marked resolved as the file on disk is.
    Resolved,
    /// Resolved by deleting the path.
    Deleted,
    TakeOurs,
    TakeTheirs,
    /// Resolved with the document's current text (unsaved changes included).
    Manual,
}

/// A tree entry, as text: for the persisted state and the renderer.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryState {
    /// `file`, `directory` or `link`.
    pub kind: String,
    pub id: String,
    pub executable: bool,
    /// False for a file over the storage limit: hashed, not stored.
    pub stored: bool,
    pub size: Option<u64>,
    /// For a link: `file`, `directory` or `junction`.
    pub link: Option<String>,
}

impl EntryState {
    pub fn of(entry: &TreeEntry) -> EntryState {
        let (kind, executable, stored, size, link) = match entry.kind {
            EntryKind::File { executable, stored } => match stored {
                Stored::Yes => ("file", executable, true, None, None),
                Stored::No { size } => ("file", executable, false, Some(size), None),
            },
            EntryKind::Directory => ("directory", false, true, None, None),
            EntryKind::Symlink(kind) => (
                "link",
                false,
                true,
                None,
                Some(match kind {
                    LinkKind::File => "file",
                    LinkKind::Directory => "directory",
                    LinkKind::Junction => "junction",
                }),
            ),
        };
        EntryState {
            kind: kind.into(),
            id: entry.id.to_hex(),
            executable,
            stored,
            size,
            link: link.map(str::to_string),
        }
    }

    pub fn of_opt(entry: &Option<TreeEntry>) -> Option<EntryState> {
        entry.as_ref().map(EntryState::of)
    }

    /// The tree entry again, named `name`.
    pub fn entry(&self, name: &str) -> Result<TreeEntry> {
        let bad = || LgError::InvalidFormat(format!("operation state: entry {self:?}"));
        let kind = match (self.kind.as_str(), self.link.as_deref()) {
            ("file", _) => EntryKind::File {
                executable: self.executable,
                stored: if self.stored {
                    Stored::Yes
                } else {
                    Stored::No {
                        size: self.size.ok_or_else(bad)?,
                    }
                },
            },
            ("directory", _) => EntryKind::Directory,
            ("link", Some("file")) => EntryKind::Symlink(LinkKind::File),
            ("link", Some("directory")) => EntryKind::Symlink(LinkKind::Directory),
            ("link", Some("junction")) => EntryKind::Symlink(LinkKind::Junction),
            _ => return Err(bad()),
        };
        Ok(TreeEntry {
            name: EntryName::new(name)?,
            kind,
            id: ObjectId::from_hex(&self.id)?,
        })
    }
}

/// An entry that may be absent, back as a tree entry (named after the path's last name).
pub(crate) fn entry_at(state: &Option<EntryState>, path: &str) -> Result<Option<TreeEntry>> {
    let name = path.rsplit('/').next().unwrap_or(path);
    state.as_ref().map(|s| s.entry(name)).transpose()
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub folder_id: String,
    pub path: String,
    pub kind: ConflictKind,
    pub base: Option<EntryState>,
    pub ours: Option<EntryState>,
    pub theirs: Option<EntryState>,
    /// Text on both sides: the working tree got the file with conflict markers.
    pub markers: bool,
    /// Either side is binary: no line merge was tried.
    pub binary: bool,
    /// Why a side's content could not be merged: `notStored`, `missing`, `tooLarge`.
    pub unavailable: Option<String>,
    pub resolution: Resolution,
    /// What the index holds for the path once it is resolved (none: deleted).
    pub resolved: Option<EntryState>,
}

/// A path the operation changed on disk: what it held before, and everything the operation
/// has written there (the merge's result, then each resolution's), latest last.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Touched {
    pub folder_id: String,
    pub path: String,
    pub before: Option<EntryState>,
    pub written: Vec<Option<EntryState>>,
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationState {
    pub version: u32,
    pub kind: OperationKind,
    pub phase: Phase,
    /// The branch HEAD was on (none: detached).
    pub branch: Option<String>,
    /// HEAD's commit when it began (none: no commit yet). HEAD stays there until it completes.
    pub head: Option<String>,
    /// The commit merged, or cherry-picked.
    pub theirs: String,
    /// The merge base (for a cherry-pick: the picked commit's parent; none: the empty state).
    pub base: Option<String>,
    /// What was asked for, as shown: a branch, a tag, or a short id and summary.
    pub label: String,
    pub fast_forward: bool,
    /// The index ref before it began (none: the index followed HEAD).
    pub index_before: Option<String>,
    /// The disk before it began (a root).
    pub disk_before: String,
    /// The index after the merge: clean results staged, conflicted paths at ours (a root).
    pub result_index: String,
    /// What the merge writes to the disk: the index plus each conflict's working file (a root).
    pub result_work: String,
    /// When conflict-free: the commit HEAD moves to (a merge commit, the picked commit's copy,
    /// or the target itself for a fast-forward).
    pub commit: Option<String>,
    /// The message the commit made on continue gets.
    pub message: String,
    pub touched: Vec<Touched>,
    pub conflicts: Vec<Conflict>,
}

pub(crate) fn id(text: &str) -> Result<ObjectId> {
    ObjectId::from_hex(text)
}

pub(crate) fn opt_id(text: &Option<String>) -> Result<Option<ObjectId>> {
    text.as_deref().map(id).transpose()
}

impl OperationState {
    pub fn unresolved(&self) -> usize {
        self.conflicts
            .iter()
            .filter(|c| c.resolution == Resolution::Unresolved)
            .count()
    }
}

fn operation_ref() -> RefName {
    RefName::new(OPERATION_REF).expect("a valid ref name")
}

/// The operation in progress (the commit recording it, and its state), if any.
pub fn current(repo: &Repository) -> Result<Option<(ObjectId, OperationState)>> {
    let Some(commit_id) = repo.refs().refs.get(&operation_ref()).copied() else {
        return Ok(None);
    };
    let commit = repo.read_commit(&commit_id)?;
    let blob = commit
        .meta_objects
        .get("state")
        .copied()
        .ok_or_else(|| LgError::InvalidFormat(format!("operation {commit_id} has no state")))?;
    let bytes = repo.read_blob(&blob, 256 * 1024 * 1024)?;
    #[derive(Deserialize)]
    struct Version {
        version: u32,
    }
    let version: Version = serde_json::from_slice(&bytes)
        .map_err(|e| LgError::InvalidFormat(format!("operation state: {e}")))?;
    if version.version > STATE_VERSION {
        return Err(LgError::UnsupportedVersion {
            what: "Local Git operation state".into(),
            found: version.version as u64,
            supported: STATE_VERSION as u64,
        });
    }
    let state: OperationState = serde_json::from_slice(&bytes)
        .map_err(|e| LgError::InvalidFormat(format!("operation state: {e}")))?;
    Ok(Some((commit_id, state)))
}

/// Refuses while a merge or cherry-pick is in progress.
pub fn ensure_idle(repo: &Repository) -> Result<()> {
    if !repo.refs().refs.contains_key(&operation_ref()) {
        return Ok(());
    }
    let kind = match current(repo) {
        Ok(Some((_, state))) => match state.kind {
            OperationKind::Merge => "merge",
            OperationKind::CherryPick => "cherry-pick",
        },
        _ => "merge or cherry-pick",
    };
    Err(LgError::OperationInProgress(kind.into()))
}

/// Writes `state` as an object (published; nothing names it yet).
pub(crate) fn write_state(repo: &mut Repository, state: &OperationState) -> Result<ObjectId> {
    let json = serde_json::to_vec(state)
        .map_err(|e| LgError::InvalidFormat(format!("operation state: {e}")))?;
    let mut objects: BTreeMap<String, ObjectId> = BTreeMap::new();
    let mut name = |key: &str, text: &Option<String>| -> Result<()> {
        if let Some(found) = opt_id(text)? {
            objects.insert(key.into(), found);
        }
        Ok(())
    };
    name("head", &state.head)?;
    name("theirs", &Some(state.theirs.clone()))?;
    name("base", &state.base)?;
    name("index-before", &state.index_before)?;
    name("disk-before", &Some(state.disk_before.clone()))?;
    name("work", &Some(state.result_work.clone()))?;
    name("commit", &state.commit)?;
    let mut txn = repo.begin_write()?;
    objects.insert("state".into(), txn.put_blob(&json)?);
    let commit = Commit {
        root: id(&state.result_index)?,
        disk_root: None,
        parents: Vec::new(),
        workspace: txn.repository().meta().workspace.clone(),
        author: Author {
            name: "Local Git".into(),
            id: "operation".into(),
        },
        time_ms: 0,
        tz_offset_min: 0,
        source: Source::Automatic,
        meta: [
            ("operation".to_string(), state.kind.op().to_string()),
            (
                "phase".to_string(),
                match state.phase {
                    Phase::Applying => "applying",
                    Phase::Conflicts => "conflicts",
                }
                .to_string(),
            ),
        ]
        .into_iter()
        .collect(),
        meta_objects: objects,
        message: format!("Local Git {} in progress", state.kind.op()),
    };
    let commit_id = txn.put_commit(&commit)?;
    txn.commit()?;
    Ok(commit_id)
}

/// The ref update that makes the recorded state `new` (none: the operation ends).
pub(crate) fn state_update(repo: &Repository, new: Option<ObjectId>) -> RefUpdate {
    let name = operation_ref();
    let expected = repo.refs().refs.get(&name).copied();
    RefUpdate {
        name,
        expected,
        new,
    }
}
