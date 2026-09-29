//! Checkpoints, commits and history (LG-03).
//!
//! **A checkpoint** captures the workspace -- a persisted LG-02 snapshot, unsaved documents
//! included (its effective root) -- as a commit object of source `checkpoint` (or `recovery`,
//! for the one a restore takes first) whose parent is HEAD. It moves `refs/yavin/checkpoint`,
//! never HEAD: it is durable, and in the reflog, but not history. Every checkpoint ever taken
//! stays reachable through that reflog.
//!
//! **A commit** is history: a commit object whose parent is HEAD, after which HEAD moves to it.
//! A commit is made from a fresh persisted snapshot, or from a checkpoint -- taking the
//! checkpoint's roots as they are, with no scan and no hashing.
//!
//! Until branches exist (LG-04) history is one line: HEAD is `refs/heads/main` (unborn until
//! the first commit), and every commit's first parent is the HEAD it was made on.
//!
//! Crash safety is LG-01's: objects are published (synced, renamed into place) before any ref
//! names them, and a ref moves by compare-and-swap with the reflog written first -- so after a
//! crash HEAD is the old commit or the new one, both complete, and an interrupted move is
//! reported, never finished on its own.

use crate::error::{LgError, Result};
use crate::id::{ObjectId, ObjectKind};
use crate::object::{Author, Commit, EntryKind, FolderId, LinkKind, Source, Stored};
use crate::reflog::ReflogRecord;
use crate::refs::{Head, RefName, RefUpdate};
use crate::repository::Repository;
use crate::snapshot::{ObjectIdText, Snapshot};
use serde::Serialize;
use std::collections::BTreeMap;

/// Where checkpoints go: one ref, whose reflog is the list of every checkpoint.
pub const CHECKPOINT_REF: &str = "refs/yavin/checkpoint";

/// The longest message a commit may have (bytes).
pub const MAX_MESSAGE_BYTES: usize = 64 * 1024;

/// How long an abbreviated id is.
pub const SHORT_ID_LEN: usize = 12;

/// Who and when, for a commit or checkpoint being made.
#[derive(Clone, Debug)]
pub struct CommitRequest {
    pub message: String,
    pub author: Author,
    pub time_ms: i64,
    pub tz_offset_min: i16,
}

/// A commit message: not empty (once spaces are trimmed), no NUL, at most `MAX_MESSAGE_BYTES`.
pub fn validate_message(message: &str) -> Result<()> {
    if message.trim().is_empty() {
        return Err(LgError::InvalidName(
            "a commit message cannot be empty".into(),
        ));
    }
    if message.contains('\0') {
        return Err(LgError::InvalidName(
            "a commit message cannot contain NUL".into(),
        ));
    }
    if message.len() > MAX_MESSAGE_BYTES {
        return Err(LgError::InvalidName(format!(
            "a commit message cannot be longer than {MAX_MESSAGE_BYTES} bytes"
        )));
    }
    Ok(())
}

/// The first line of a message, for lists.
fn summary(message: &str) -> String {
    message.lines().next().unwrap_or("").trim_end().to_string()
}

/// What a history list shows of a commit.
#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub id: ObjectIdText,
    pub short_id: String,
    pub message: String,
    pub summary: String,
    pub time_ms: i64,
    pub tz_offset_min: i16,
    pub author_name: String,
    pub author_id: String,
    pub parents: Vec<ObjectIdText>,
    /// `human`, `checkpoint` or `recovery` (later phases add more).
    pub source: &'static str,
    /// The workspace as recorded (unsaved documents included).
    pub root: ObjectIdText,
    /// The workspace as it was on disk, when it differed.
    pub disk_root: Option<ObjectIdText>,
    /// The overlay set, when unsaved documents were recorded.
    pub overlays: Option<ObjectIdText>,
}

pub fn commit_info(id: ObjectId, commit: &Commit) -> CommitInfo {
    CommitInfo {
        id: ObjectIdText(id),
        short_id: id.to_hex()[..SHORT_ID_LEN].to_string(),
        message: commit.message.clone(),
        summary: summary(&commit.message),
        time_ms: commit.time_ms,
        tz_offset_min: commit.tz_offset_min,
        author_name: commit.author.name.clone(),
        author_id: commit.author.id.clone(),
        parents: commit.parents.iter().copied().map(ObjectIdText).collect(),
        source: commit.source.as_str(),
        root: ObjectIdText(commit.root),
        disk_root: commit.disk_root.map(ObjectIdText),
        overlays: commit
            .meta_objects
            .get("overlays")
            .copied()
            .map(ObjectIdText),
    }
}

/// The new commit, and the refs revision that names it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Created {
    pub commit: CommitInfo,
    pub revision: u64,
}

/// Writes the commit object for `snapshot` (on top of HEAD) and publishes it. Nothing refers
/// to it yet.
fn write_commit(
    repo: &mut Repository,
    root: ObjectId,
    disk_root: Option<ObjectId>,
    overlays: Option<ObjectId>,
    source: Source,
    request: &CommitRequest,
) -> Result<(ObjectId, Commit)> {
    validate_message(&request.message)?;
    let parents = repo.refs().head_commit().into_iter().collect();
    let mut meta = BTreeMap::new();
    meta.insert("snapshot".to_string(), "1".to_string());
    let commit = Commit {
        root,
        disk_root: disk_root.filter(|disk| *disk != root),
        parents,
        workspace: repo.meta().workspace.clone(),
        author: request.author.clone(),
        time_ms: request.time_ms,
        tz_offset_min: request.tz_offset_min,
        source,
        meta,
        meta_objects: overlays
            .map(|id| [("overlays".to_string(), id)].into_iter().collect())
            .unwrap_or_default(),
        message: request.message.clone(),
    };
    let mut txn = repo.begin_write()?;
    let id = txn.put_commit(&commit)?;
    txn.commit()?;
    Ok((id, commit))
}

/// Moves `name` (compare-and-swap against what it is now) to `new`.
fn move_ref(
    repo: &mut Repository,
    name: &RefName,
    new: ObjectId,
    op: &str,
    reason: &str,
) -> Result<u64> {
    let revision = repo.refs().revision;
    let expected = repo.refs().refs.get(name).copied();
    repo.update_refs(
        revision,
        &[RefUpdate {
            name: name.clone(),
            expected,
            new: Some(new),
        }],
        None,
        op,
        reason,
    )
}

/// Moves HEAD -- the ref it names, or HEAD itself when detached -- to `new`.
fn move_head(repo: &mut Repository, new: ObjectId, reason: &str) -> Result<u64> {
    match repo.refs().head.clone() {
        Head::Symbolic(name) => move_ref(repo, &name, new, "commit", reason),
        Head::Detached(_) => {
            let revision = repo.refs().revision;
            repo.update_refs(revision, &[], Some(Head::Detached(new)), "commit", reason)
        }
    }
}

/// Records a persisted snapshot as a checkpoint (`source` is `Checkpoint`, or `Recovery` for
/// the checkpoint a restore takes first). HEAD does not move.
pub fn checkpoint_snapshot(
    repo: &mut Repository,
    snapshot: &Snapshot,
    source: Source,
    request: &CommitRequest,
) -> Result<Created> {
    if !snapshot.persisted {
        return Err(LgError::InvalidFormat(
            "a checkpoint needs a persisted snapshot".into(),
        ));
    }
    if !matches!(source, Source::Checkpoint | Source::Recovery) {
        return Err(LgError::InvalidFormat(format!(
            "a checkpoint cannot have source {}",
            source.as_str()
        )));
    }
    let (id, commit) = write_commit(
        repo,
        snapshot.effective_root.0,
        Some(snapshot.disk_root.0),
        snapshot.overlay_set.map(|set| set.0),
        source,
        request,
    )?;
    let name = RefName::new(CHECKPOINT_REF)?;
    let revision = move_ref(repo, &name, id, "checkpoint", &summary(&request.message))?;
    Ok(Created {
        commit: commit_info(id, &commit),
        revision,
    })
}

/// Makes a commit of a persisted snapshot on top of HEAD, and moves HEAD to it.
pub fn commit_snapshot(
    repo: &mut Repository,
    snapshot: &Snapshot,
    request: &CommitRequest,
) -> Result<Created> {
    if !snapshot.persisted {
        return Err(LgError::InvalidFormat(
            "a commit needs a persisted snapshot".into(),
        ));
    }
    let (id, commit) = write_commit(
        repo,
        snapshot.effective_root.0,
        Some(snapshot.disk_root.0),
        snapshot.overlay_set.map(|set| set.0),
        Source::Human,
        request,
    )?;
    let revision = move_head(repo, id, &summary(&request.message))?;
    Ok(Created {
        commit: commit_info(id, &commit),
        revision,
    })
}

/// Makes a commit of what a checkpoint captured -- its roots as they are, nothing scanned --
/// on top of HEAD, and moves HEAD to it.
pub fn commit_checkpoint(
    repo: &mut Repository,
    checkpoint: ObjectId,
    request: &CommitRequest,
) -> Result<Created> {
    let from = repo.read_commit(&checkpoint)?;
    if !matches!(from.source, Source::Checkpoint | Source::Recovery) {
        return Err(LgError::InvalidFormat(format!(
            "{checkpoint} is not a checkpoint"
        )));
    }
    let (id, commit) = write_commit(
        repo,
        from.root,
        from.disk_root,
        from.meta_objects.get("overlays").copied(),
        Source::Human,
        request,
    )?;
    let revision = move_head(repo, id, &summary(&request.message))?;
    Ok(Created {
        commit: commit_info(id, &commit),
        revision,
    })
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadInfo {
    /// The ref HEAD names (`refs/heads/main`), or none when detached.
    pub symbolic: Option<String>,
    /// No commit yet.
    pub unborn: bool,
    pub commit: Option<CommitInfo>,
    pub revision: u64,
}

pub fn head_info(repo: &Repository) -> Result<HeadInfo> {
    let refs = repo.refs();
    let commit = match refs.head_commit() {
        Some(id) => Some(commit_info(id, &repo.read_commit(&id)?)),
        None => None,
    };
    Ok(HeadInfo {
        symbolic: match &refs.head {
            Head::Symbolic(name) => Some(name.as_str().into()),
            Head::Detached(_) => None,
        },
        unborn: commit.is_none(),
        commit,
        revision: refs.revision,
    })
}

/// Where a history walk stopped because a commit could not be read.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryBreak {
    pub id: ObjectIdText,
    /// `MissingObject`, `CorruptObject`, ...
    pub code: &'static str,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    /// Newest first.
    pub items: Vec<CommitInfo>,
    /// Where the next page starts (pass it as the cursor), or none at the first commit.
    pub next: Option<ObjectIdText>,
    /// Set when a commit on the way could not be read: the page ends before it.
    pub broken: Option<HistoryBreak>,
}

/// Up to `limit` commits along first parents, from `cursor` (or HEAD), newest first.
/// Deterministic: history order comes from parents, never from times.
pub fn history(repo: &Repository, cursor: Option<ObjectId>, limit: usize) -> HistoryPage {
    let mut items = Vec::new();
    let mut next = cursor.or_else(|| repo.refs().head_commit());
    let mut broken = None;
    while let Some(id) = next {
        if items.len() >= limit {
            break;
        }
        match repo.read_commit(&id) {
            Ok(commit) => {
                next = commit.parents.first().copied();
                items.push(commit_info(id, &commit));
            }
            Err(error) => {
                broken = Some(HistoryBreak {
                    id: ObjectIdText(id),
                    code: error.code(),
                    message: error.to_string(),
                });
                next = None;
            }
        }
    }
    HistoryPage {
        items,
        next: if broken.is_some() {
            None
        } else {
            next.map(ObjectIdText)
        },
        broken,
    }
}

/// A checkpoint, as the checkpoint ref's reflog records it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointEntry {
    pub id: ObjectIdText,
    pub revision: u64,
    pub ms: u64,
    pub reason: String,
}

/// The newest `limit` checkpoints, newest first (updates that were interrupted are left out).
pub fn checkpoints(repo: &Repository, limit: usize) -> Result<Vec<CheckpointEntry>> {
    let records = repo.reflog()?;
    let aborted: std::collections::HashSet<u64> = records
        .iter()
        .filter_map(|record| match record {
            ReflogRecord::Aborted { revision, .. } => Some(*revision),
            _ => None,
        })
        .collect();
    let mut out: Vec<CheckpointEntry> = records
        .iter()
        .filter_map(|record| match record {
            ReflogRecord::Update {
                revision,
                name,
                new: Some(new),
                ms,
                reason,
                ..
            } if name == CHECKPOINT_REF && !aborted.contains(revision) => {
                ObjectId::from_hex(new).ok().map(|id| CheckpointEntry {
                    id: ObjectIdText(id),
                    revision: *revision,
                    ms: *ms,
                    reason: reason.clone(),
                })
            }
            _ => None,
        })
        .collect();
    out.reverse();
    out.truncate(limit);
    Ok(out)
}

/// One entry of a directory in a commit, with what a later UI shows.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeItem {
    pub name: String,
    /// `file`, `directory` or `symlink`.
    pub kind: &'static str,
    pub id: ObjectIdText,
    pub executable: bool,
    /// For a link: `file`, `directory` or `junction`.
    pub link: Option<&'static str>,
    /// False for a file over the storage limit: hashed, content not stored.
    pub stored: bool,
    /// Bytes, for files (and link targets); none for directories.
    pub size: Option<u64>,
    /// For a directory: how many entries it has (an empty one has 0).
    pub entries: Option<usize>,
}

/// The entries of the directory at `path` (`""` for the folder itself) in `root`'s folder
/// `folder` (or its only folder).
pub fn list_tree(
    repo: &Repository,
    root: ObjectId,
    folder: Option<&FolderId>,
    path: &str,
) -> Result<Vec<TreeItem>> {
    let folders = repo.read_root(&root)?.folders;
    let tree = match folder {
        Some(folder) => folders.get(folder).copied(),
        None if folders.len() == 1 => folders.values().next().copied(),
        None => None,
    }
    .ok_or_else(|| LgError::InvalidName("name the folder of a multi-folder root".into()))?;
    let mut dir = tree;
    for name in path.split('/').filter(|name| !name.is_empty()) {
        let entry = repo
            .read_tree(&dir)?
            .entries()
            .iter()
            .find(|entry| entry.name.as_str() == name)
            .cloned()
            .ok_or_else(|| LgError::InvalidName(format!("{path} is not in this commit")))?;
        if entry.kind != EntryKind::Directory {
            return Err(LgError::InvalidName(format!("{path} is not a directory")));
        }
        dir = entry.id;
    }
    repo.read_tree(&dir)?
        .entries()
        .iter()
        .map(|entry| {
            let (kind, executable, link, stored, size, entries) = match entry.kind {
                EntryKind::File { executable, stored } => match stored {
                    Stored::Yes => (
                        "file",
                        executable,
                        None,
                        true,
                        Some(repo.object_info(&entry.id)?.1),
                        None,
                    ),
                    Stored::No { size } => ("file", executable, None, false, Some(size), None),
                },
                EntryKind::Directory => (
                    "directory",
                    false,
                    None,
                    true,
                    None,
                    Some(repo.read_tree(&entry.id)?.entries().len()),
                ),
                EntryKind::Symlink(kind) => (
                    "symlink",
                    false,
                    Some(match kind {
                        LinkKind::File => "file",
                        LinkKind::Directory => "directory",
                        LinkKind::Junction => "junction",
                    }),
                    true,
                    Some(repo.object_info(&entry.id)?.1),
                    None,
                ),
            };
            Ok(TreeItem {
                name: entry.name.as_str().into(),
                kind,
                id: ObjectIdText(entry.id),
                executable,
                link,
                stored,
                size,
                entries,
            })
        })
        .collect()
}

/// Checks `id` is a commit before callers treat it as one.
pub fn require_commit(repo: &Repository, id: &ObjectId) -> Result<()> {
    match repo.object_info(id)? {
        (ObjectKind::Commit, _) => Ok(()),
        (other, _) => Err(LgError::WrongKind {
            id: *id,
            expected: "commit",
            found: other.name(),
        }),
    }
}
