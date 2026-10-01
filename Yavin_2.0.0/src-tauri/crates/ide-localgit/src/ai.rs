//! AI runs in Local Git (LG-07): checkpoints before an AI changes anything, provenance, an AI
//! commit of exactly the AI's own changes, and Undo AI Run.
//!
//! Local Git does not run AIs, and does not hold ChangeSets: it records references to them.
//! An agent run, its task and its ChangeSet are named by the caller's ids (opaque here); the
//! caller -- the layer that runs the AI -- reports what happens (the run started, the AI
//! changed these paths, validation passed, the run failed or was cancelled). Local Git records
//! it durably, and owns what only it can: the checkpoint, the attribution of changes, the AI
//! commit and the undo.
//!
//! **Records.** One per run, under `refs/yavin/ai/r<hash of the run id>`: a small commit
//! (source `automatic`, on no branch) whose `metaobj run` blob is the `AiRunRecord` as JSON
//! (versioned), and whose other `metaobj`s keep the checkpoint and the AI commit reachable.
//! Every change of a record is one compare-and-swap of the refs -- with HEAD and the index,
//! for an AI commit or an undo of one.
//!
//! **Checkpoint.** Before the AI's first change: a Full, persisted snapshot of the workspace as
//! the user has it (unsaved documents included), recorded as a commit with source `ai` -- its
//! root the effective workspace, its disk root the disk, `metaobj overlays` the unsaved
//! documents, `metaobj index` the index's root, HEAD its parent -- and the run's record, in one
//! ref step. HEAD, branches and the index never move. If it cannot be made durable the caller
//! gets an error and must not let the AI begin.
//!
//! **Attribution.** The AI owns exactly the paths the caller reports it changed, with what they
//! held at the checkpoint (`before`) and after the AI's change (`after`, from a snapshot taken
//! when it is reported, optionally checked against the content the caller says the AI wrote).
//! Every other change since the checkpoint is not the AI's (`unattributed`). Nothing is ever
//! attributed by guessing.
//!
//! **AI commit.** A commit on HEAD of HEAD's tree with only the AI's paths set to `after` --
//! never the working tree, never the index. Refused, with every reason (`AiRefusal`), when HEAD
//! moved since the checkpoint, the ChangeSet's revision is not the one recorded, a human
//! changed an AI path since (the workspace no longer holds `after`), a path held a human change
//! at the checkpoint (`before` is not HEAD's: committing would take the human's change too), or
//! something is staged at an AI path. Staged work elsewhere stays staged: the index keeps every
//! other entry. The working tree is not touched.
//!
//! **Undo AI Run** removes the AI's changes and nothing else -- never a reset to the
//! checkpoint. Per AI path: still the AI's content -> back to `before`; already `before` ->
//! nothing; changed by a human since -> the three-way inverse (`merge3`: the human's edit kept,
//! the AI's undone) when both are text and it is clean, refused otherwise. A document with
//! unsaved changes on an AI path is refused, unless its text is exactly the AI's (then it is
//! replaced). The disk changes through the restore machinery (one Module 03 operation recorded
//! by Module 04, verified), recorded first so an interrupted undo can be finished. Undoing a
//! committed run also moves HEAD back to the commit's parent -- only while HEAD is still that
//! commit -- and its paths in the index with it; the commit stays in the record.

use crate::branches::{index_state, resolve_head, HeadState, INDEX_REF};
use crate::diff::is_binary;
use crate::error::{LgError, Result};
use crate::history::{commit_info, validate_message, CommitInfo, CommitRequest};
use crate::id::{hash_object, ObjectId, ObjectKind};
use crate::index::{graft, Pending};
use crate::merge3;
use crate::object::{Author, Commit, EntryKind, FolderId, Root, Source, Stored, Tree, TreeEntry};
use crate::operation::{ensure_idle, entry_at, opt_id, EntryState};
use crate::refs::{Head, RefName, RefUpdate};
use crate::repository::Repository;
use crate::restore::{RestorePlan, RestorePolicy};
use crate::scan::TreeLookup;
use crate::snapshot::{FolderRoot, Snapshot};
use crate::status::find;
use crate::switch::{differing, same, MemoryAndStore, Trees};
use crate::transition::{commit_folders, plan_transition, tree_or_empty, Sets};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const AI_PREFIX: &str = "refs/yavin/ai/";

/// The record's format version: a newer one is never read as something it is not.
pub const AI_RECORD_VERSION: u32 = 1;

/// No three-way inverse for a file larger than this.
const UNDO_MERGE_MAX_BYTES: u64 = 8 * 1024 * 1024;

/// How many unattributed paths a record lists.
const UNATTRIBUTED_LIMIT: usize = 1000;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AiRunStatus {
    /// The checkpoint is durable; the AI may begin.
    Checkpointed,
    Running,
    /// The AI's changes are recorded.
    ChangesDetected,
    /// Validation of the changes was recorded.
    Validated,
    /// The AI commit was made.
    Committed,
    Cancelled,
    Failed,
    Undone,
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Validation {
    pub passed: bool,
    /// The caller's reference to the validation (a run, a report); opaque here.
    pub reference: Option<String>,
}

/// A path the AI changed: what it held at the checkpoint, and after the AI's change.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChange {
    pub folder_id: String,
    pub path: String,
    pub before: Option<EntryState>,
    pub after: Option<EntryState>,
}

/// An undo under way: what each path is being set to (so a restarted undo knows its own work).
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoTarget {
    pub folder_id: String,
    pub path: String,
    pub entry: Option<EntryState>,
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRunRecord {
    pub version: u32,
    pub agent_run_id: String,
    pub task_id: Option<String>,
    pub change_set_id: Option<String>,
    /// The ChangeSet's revision when it was associated (opaque; compared on commit).
    pub change_set_revision: Option<String>,
    /// The workspace the run belongs to (never a path).
    pub workspace: String,
    /// The checkpoint commit.
    pub checkpoint: String,
    /// HEAD at the checkpoint (none: no commit yet), and its branch (none: detached).
    pub head: Option<String>,
    pub branch: Option<String>,
    /// The index's root at the checkpoint.
    pub index: Option<String>,
    pub reason: String,
    /// The model or provider, only as the caller gave it.
    pub model: Option<String>,
    pub started_ms: u64,
    pub finished_ms: Option<u64>,
    pub status: AiRunStatus,
    pub validation: Option<Validation>,
    /// Why it failed or was cancelled, as the caller said.
    pub note: Option<String>,
    pub changes: Vec<AiChange>,
    /// Paths changed since the checkpoint that are not the AI's (`folderId:path`), as of the
    /// last report.
    pub unattributed: Vec<String>,
    /// The AI commit.
    pub commit: Option<String>,
    pub undo: Option<Vec<UndoTarget>>,
    pub undone_ms: Option<u64>,
}

/// Why an AI commit or undo cannot be done (nothing was changed).
#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AiRefusal {
    /// HEAD is not where it was at the checkpoint.
    #[serde(rename_all = "camelCase")]
    HeadMoved {
        expected: Option<String>,
        found: Option<String>,
    },
    /// The ChangeSet's revision is not the one recorded.
    #[serde(rename_all = "camelCase")]
    StaleChangeSet {
        expected: String,
        found: String,
    },
    /// A merge or cherry-pick is in progress.
    OperationInProgress,
    NothingToCommit,
    NothingToUndo,
    /// The path no longer holds the AI's content.
    #[serde(rename_all = "camelCase")]
    HumanChangedAiPath {
        folder_id: String,
        path: String,
    },
    /// At the checkpoint the path already held a human change: committing the AI's content
    /// would commit the human's too.
    #[serde(rename_all = "camelCase")]
    PreexistingHumanChange {
        folder_id: String,
        path: String,
    },
    /// Something is staged at an AI path.
    #[serde(rename_all = "camelCase")]
    StagedOnAiPath {
        folder_id: String,
        path: String,
    },
    /// A human changed the path since, and the AI's change cannot be taken out of it cleanly.
    #[serde(rename_all = "camelCase")]
    UndoConflict {
        folder_id: String,
        path: String,
    },
    /// A document with unsaved changes (not the AI's) is on an AI path.
    #[serde(rename_all = "camelCase")]
    DirtyDocument {
        folder_id: String,
        path: String,
    },
    /// The run's commit is no longer HEAD: history moved on (a revert undoes it there).
    #[serde(rename_all = "camelCase")]
    HistoryMovedOn {
        commit: String,
    },
}

fn run_ref(agent_run_id: &str) -> Result<RefName> {
    let mut payload = b"ylg-ai-run\0".to_vec();
    payload.extend_from_slice(agent_run_id.as_bytes());
    let hash = hash_object(ObjectKind::Blob, &payload).to_hex();
    RefName::new(&format!("{AI_PREFIX}r{}", &hash[..24]))
}

fn check_id(what: &str, id: &str) -> Result<()> {
    if id.trim().is_empty() || id.len() > 256 || id.chars().any(char::is_control) {
        return Err(LgError::InvalidName(format!("{what} {id:?}")));
    }
    Ok(())
}

fn now_ms() -> u64 {
    ide_workspace::durable::now_millis() as u64
}

fn read_record(repo: &Repository, commit_id: ObjectId) -> Result<AiRunRecord> {
    let commit = repo.read_commit(&commit_id)?;
    let blob =
        commit.meta_objects.get("run").copied().ok_or_else(|| {
            LgError::InvalidFormat(format!("AI run record {commit_id} has no run"))
        })?;
    let bytes = repo.read_blob(&blob, 64 * 1024 * 1024)?;
    #[derive(Deserialize)]
    struct Version {
        version: u32,
    }
    let version: Version = serde_json::from_slice(&bytes)
        .map_err(|e| LgError::InvalidFormat(format!("AI run record: {e}")))?;
    if version.version > AI_RECORD_VERSION {
        return Err(LgError::UnsupportedVersion {
            what: "Local Git AI run record".into(),
            found: version.version as u64,
            supported: AI_RECORD_VERSION as u64,
        });
    }
    serde_json::from_slice(&bytes)
        .map_err(|e| LgError::InvalidFormat(format!("AI run record: {e}")))
}

/// The run's record, if Local Git has one.
pub fn find_run(repo: &Repository, agent_run_id: &str) -> Result<Option<AiRunRecord>> {
    match repo.refs().refs.get(&run_ref(agent_run_id)?).copied() {
        Some(id) => Ok(Some(read_record(repo, id)?)),
        None => Ok(None),
    }
}

pub fn get_run(repo: &Repository, agent_run_id: &str) -> Result<AiRunRecord> {
    find_run(repo, agent_run_id)?.ok_or_else(|| LgError::NotFound(format!("AI run {agent_run_id}")))
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRunList {
    /// Newest first.
    pub items: Vec<AiRunRecord>,
    pub total: usize,
}

/// The newest `limit` runs (by when they started), and how many there are. Reads the refs and
/// the records only -- never the workspace.
pub fn list_runs(repo: &Repository, limit: usize) -> Result<AiRunList> {
    let mut items = repo
        .refs()
        .refs
        .iter()
        .filter(|(name, _)| name.as_str().starts_with(AI_PREFIX))
        .map(|(_, id)| read_record(repo, *id))
        .collect::<Result<Vec<_>>>()?;
    items.sort_by(|a, b| {
        b.started_ms
            .cmp(&a.started_ms)
            .then_with(|| b.agent_run_id.cmp(&a.agent_run_id))
    });
    let total = items.len();
    items.truncate(limit);
    Ok(AiRunList { items, total })
}

/// Writes a record as an object (published; nothing names it yet).
fn write_record(repo: &mut Repository, record: &AiRunRecord) -> Result<ObjectId> {
    let json = serde_json::to_vec(record)
        .map_err(|e| LgError::InvalidFormat(format!("AI run record: {e}")))?;
    let checkpoint = ObjectId::from_hex(&record.checkpoint)?;
    let root = repo.read_commit(&checkpoint)?.root;
    let mut txn = repo.begin_write()?;
    let mut objects: BTreeMap<String, ObjectId> = BTreeMap::new();
    objects.insert("run".into(), txn.put_blob(&json)?);
    objects.insert("checkpoint".into(), checkpoint);
    if let Some(commit) = opt_id(&record.commit)? {
        objects.insert("commit".into(), commit);
    }
    let commit = Commit {
        root,
        disk_root: None,
        parents: Vec::new(),
        workspace: txn.repository().meta().workspace.clone(),
        author: Author {
            name: "Local Git".into(),
            id: "ai-run".into(),
        },
        time_ms: 0,
        tz_offset_min: 0,
        source: Source::Automatic,
        meta: [
            ("ai.run".to_string(), record.agent_run_id.clone()),
            ("ai.status".to_string(), format!("{:?}", record.status)),
        ]
        .into_iter()
        .collect(),
        meta_objects: objects,
        message: "Local Git AI run record".into(),
    };
    let id = txn.put_commit(&commit)?;
    txn.commit()?;
    Ok(id)
}

fn record_update(repo: &Repository, agent_run_id: &str, new: ObjectId) -> Result<RefUpdate> {
    let name = run_ref(agent_run_id)?;
    let expected = repo.refs().refs.get(&name).copied();
    Ok(RefUpdate {
        name,
        expected,
        new: Some(new),
    })
}

/// Saves a changed record (one ref step).
fn save(repo: &mut Repository, record: &AiRunRecord, reason: &str) -> Result<u64> {
    let id = write_record(repo, record)?;
    let update = record_update(repo, &record.agent_run_id, id)?;
    let revision = repo.refs().revision;
    repo.update_refs(revision, &[update], None, "ai", reason)
}

// --- Checkpoint ---------------------------------------------------------------------------------

#[derive(Clone, Debug, Default)]
pub struct CheckpointRequest {
    pub agent_run_id: String,
    pub task_id: Option<String>,
    pub change_set_id: Option<String>,
    pub change_set_revision: Option<String>,
    pub reason: String,
    pub model: Option<String>,
}

/// Records the AI checkpoint for a run that has not changed anything yet, from `snapshot`
/// (Full, persisted, with the unsaved documents), and the run's record -- durably, in one
/// step. HEAD and the index do not move. An error means the AI must not begin.
pub fn checkpoint(
    repo: &mut Repository,
    snapshot: &Snapshot,
    request: &CheckpointRequest,
    by: &CommitRequest,
) -> Result<AiRunRecord> {
    check_id("agent run id", &request.agent_run_id)?;
    for (what, id) in [
        ("task id", &request.task_id),
        ("ChangeSet id", &request.change_set_id),
        ("ChangeSet revision", &request.change_set_revision),
        ("model", &request.model),
    ] {
        if let Some(id) = id {
            check_id(what, id)?;
        }
    }
    if !snapshot.persisted {
        return Err(LgError::InvalidFormat(
            "an AI checkpoint needs a persisted snapshot".into(),
        ));
    }
    let name = run_ref(&request.agent_run_id)?;
    if repo.refs().refs.contains_key(&name) {
        return Err(LgError::AlreadyExists(format!(
            "AI run {}",
            request.agent_run_id
        )));
    }
    let reason = if request.reason.trim().is_empty() {
        "before an AI run".to_string()
    } else {
        request.reason.trim().to_string()
    };
    let message = format!("AI checkpoint: {reason}");
    validate_message(&message)?;
    let head_state = resolve_head(repo);
    let head = head_state.commit();
    let branch = match &head_state {
        HeadState::Branch { name, .. } | HeadState::Unborn { name, .. } => Some(name.clone()),
        HeadState::Detached { .. } => None,
    };
    let index = index_state(repo)?.root;
    let mut meta: BTreeMap<String, String> = BTreeMap::new();
    meta.insert("ai.run".into(), request.agent_run_id.clone());
    meta.insert("ai.reason".into(), reason.clone());
    for (key, value) in [
        ("ai.task", &request.task_id),
        ("ai.changeset", &request.change_set_id),
        ("ai.model", &request.model),
    ] {
        if let Some(value) = value {
            meta.insert(key.into(), value.clone());
        }
    }
    let mut objects: BTreeMap<String, ObjectId> = BTreeMap::new();
    if let Some(set) = snapshot.overlay_set {
        objects.insert("overlays".into(), set.0);
    }
    if let Some(root) = index {
        objects.insert("index".into(), root);
    }
    let commit = Commit {
        root: snapshot.effective_root.0,
        disk_root: Some(snapshot.disk_root.0).filter(|d| *d != snapshot.effective_root.0),
        parents: head.into_iter().collect(),
        workspace: repo.meta().workspace.clone(),
        author: by.author.clone(),
        time_ms: by.time_ms,
        tz_offset_min: by.tz_offset_min,
        source: Source::Ai,
        meta,
        meta_objects: objects,
        message,
    };
    let mut txn = repo.begin_write()?;
    let checkpoint = txn.put_commit(&commit)?;
    txn.commit()?;
    let record = AiRunRecord {
        version: AI_RECORD_VERSION,
        agent_run_id: request.agent_run_id.clone(),
        task_id: request.task_id.clone(),
        change_set_id: request.change_set_id.clone(),
        change_set_revision: request.change_set_revision.clone(),
        workspace: repo.meta().workspace.clone(),
        checkpoint: checkpoint.to_hex(),
        head: head.map(|h| h.to_hex()),
        branch,
        index: index.map(|i| i.to_hex()),
        reason,
        model: request.model.clone(),
        started_ms: now_ms(),
        finished_ms: None,
        status: AiRunStatus::Checkpointed,
        validation: None,
        note: None,
        changes: Vec::new(),
        unattributed: Vec::new(),
        commit: None,
        undo: None,
        undone_ms: None,
    };
    let recorded = write_record(repo, &record)?;
    let revision = repo.refs().revision;
    repo.update_refs(
        revision,
        &[RefUpdate {
            name,
            expected: None,
            new: Some(recorded),
        }],
        None,
        "ai",
        &format!("checkpoint {}", record.agent_run_id),
    )?;
    Ok(record)
}

// --- Lifecycle ----------------------------------------------------------------------------------

/// What the caller reports about a run.
#[derive(Clone, Debug)]
pub enum RunEvent {
    Started,
    Validated(Validation),
    Failed(Option<String>),
    Cancelled(Option<String>),
}

fn invalid(record: &AiRunRecord, what: &str) -> LgError {
    LgError::AiRunState(format!(
        "AI run {} is {:?}: it cannot be {what}",
        record.agent_run_id, record.status
    ))
}

/// Records a step of the run's lifecycle. Local Git never decides one on its own: a run whose
/// process ended without saying so stays as it was.
pub fn report(repo: &mut Repository, agent_run_id: &str, event: RunEvent) -> Result<AiRunRecord> {
    use AiRunStatus::*;
    let mut record = get_run(repo, agent_run_id)?;
    let (status, what) = match &event {
        RunEvent::Started => (Running, "started"),
        RunEvent::Validated(_) => (Validated, "validated"),
        RunEvent::Failed(_) => (Failed, "failed"),
        RunEvent::Cancelled(_) => (Cancelled, "cancelled"),
    };
    let allowed = match &event {
        RunEvent::Started => record.status == Checkpointed,
        RunEvent::Validated(_) => matches!(record.status, ChangesDetected | Validated),
        RunEvent::Failed(_) | RunEvent::Cancelled(_) => {
            matches!(
                record.status,
                Checkpointed | Running | ChangesDetected | Validated
            )
        }
    };
    if !allowed {
        return Err(invalid(&record, what));
    }
    record.status = status;
    match event {
        RunEvent::Validated(validation) => record.validation = Some(validation),
        RunEvent::Failed(note) | RunEvent::Cancelled(note) => {
            record.note = note;
            record.finished_ms = Some(now_ms());
        }
        RunEvent::Started => {}
    }
    save(repo, &record, &format!("{} {what}", record.agent_run_id))?;
    Ok(record)
}

/// Associates the run's ChangeSet (made before or after the checkpoint). A run has one: a
/// different id is refused; the same id updates the recorded revision.
pub fn associate(
    repo: &mut Repository,
    agent_run_id: &str,
    change_set_id: &str,
    revision: Option<String>,
) -> Result<AiRunRecord> {
    check_id("ChangeSet id", change_set_id)?;
    if let Some(revision) = &revision {
        check_id("ChangeSet revision", revision)?;
    }
    let mut record = get_run(repo, agent_run_id)?;
    if record.status == AiRunStatus::Undone {
        return Err(invalid(&record, "associated with a ChangeSet"));
    }
    if let Some(existing) = &record.change_set_id {
        if existing != change_set_id {
            return Err(LgError::ChangeSetMismatch(format!(
                "AI run {agent_run_id} belongs to ChangeSet {existing}, not {change_set_id}"
            )));
        }
    }
    record.change_set_id = Some(change_set_id.to_string());
    if revision.is_some() {
        record.change_set_revision = revision;
    }
    save(
        repo,
        &record,
        &format!("{agent_run_id} ChangeSet {change_set_id}"),
    )?;
    Ok(record)
}

// --- Changes ------------------------------------------------------------------------------------

/// A path the caller says the AI changed.
#[derive(Clone, Debug)]
pub struct ReportedPath {
    /// None: the workspace's only folder.
    pub folder: Option<FolderId>,
    pub path: String,
    /// The content the AI wrote (`Some(None)`: it deleted the path), when the caller knows it:
    /// a workspace that no longer holds it is ambiguous, and refused.
    pub expected: Option<Option<ObjectId>>,
}

fn folder_of(folders: &[FolderRoot], asked: &Option<FolderId>) -> Result<FolderId> {
    match asked {
        Some(folder) if folders.iter().any(|f| f.folder_id == *folder) => Ok(folder.clone()),
        Some(folder) => Err(LgError::NotFound(format!("folder {}", folder.as_str()))),
        None if folders.len() == 1 => Ok(folders[0].folder_id.clone()),
        None => Err(LgError::InvalidName(
            "name the folder of a multi-folder workspace".into(),
        )),
    }
}

fn effective_folders(snapshot: &Snapshot) -> Result<BTreeMap<FolderId, ObjectId>> {
    snapshot
        .folders
        .iter()
        .map(|f| Ok((FolderId::new(&f.folder_id)?, f.effective_tree.0)))
        .collect()
}

fn checkpoint_folders(
    repo: &Repository,
    record: &AiRunRecord,
) -> Result<BTreeMap<FolderId, ObjectId>> {
    commit_folders(repo, Some(ObjectId::from_hex(&record.checkpoint)?))
}

fn is_dir(entry: &Option<TreeEntry>) -> bool {
    entry
        .as_ref()
        .is_some_and(|e| e.kind == EntryKind::Directory)
}

/// Records the paths the AI changed, as `snapshot` (Full, persisted, with the unsaved
/// documents) sees them now -- and everything else that changed since the checkpoint, as not
/// the AI's. A path reported again keeps its checkpoint content as `before`.
pub fn record_changes(
    lookup: &dyn TreeLookup,
    repo: &mut Repository,
    folders: &[FolderRoot],
    snapshot: &Snapshot,
    agent_run_id: &str,
    reported: &[ReportedPath],
) -> Result<AiRunRecord> {
    use AiRunStatus::*;
    let mut record = get_run(repo, agent_run_id)?;
    if matches!(record.status, Committed | Undone) {
        return Err(invalid(&record, "given more changes"));
    }
    if !snapshot.persisted {
        return Err(LgError::InvalidFormat(
            "AI changes need a persisted snapshot".into(),
        ));
    }
    let at_checkpoint = checkpoint_folders(repo, &record)?;
    let now = effective_folders(snapshot)?;
    {
        let reads = Trees(&MemoryAndStore { repo, lookup });
        for asked in reported {
            let fid = folder_of(folders, &asked.folder)?;
            let folder_id = fid.as_str().to_string();
            let path = asked
                .path
                .split('/')
                .filter(|n| !n.is_empty())
                .collect::<Vec<_>>()
                .join("/");
            if path.is_empty() {
                return Err(LgError::InvalidName("an empty path".into()));
            }
            let at = record
                .changes
                .iter()
                .position(|c| c.folder_id == folder_id && c.path == path);
            let before = match at {
                Some(at) => entry_at(&record.changes[at].before, &path)?,
                None => find(&reads, Some(tree_or_empty(&at_checkpoint, &fid)), &path)?,
            };
            let after = find(&reads, Some(tree_or_empty(&now, &fid)), &path)?;
            if is_dir(&before) || is_dir(&after) {
                return Err(LgError::InvalidName(format!(
                    "{path} is a folder: report the files the AI changed"
                )));
            }
            if let Some(expected) = asked.expected {
                let holds = match (&after, expected) {
                    (None, None) => true,
                    (Some(entry), Some(id)) => entry.id == id,
                    _ => false,
                };
                if !holds {
                    return Err(LgError::AttributionAmbiguous(format!(
                        "{path} does not hold what the AI wrote"
                    )));
                }
            }
            let change = AiChange {
                folder_id: folder_id.clone(),
                path: path.clone(),
                before: EntryState::of_opt(&before),
                after: EntryState::of_opt(&after),
            };
            match (at, same(&before, &after)) {
                (Some(at), true) => {
                    record.changes.remove(at);
                }
                (Some(at), false) => record.changes[at] = change,
                (None, false) => record.changes.push(change),
                (None, true) => {}
            }
        }
        record
            .changes
            .sort_by(|a, b| (&a.folder_id, &a.path).cmp(&(&b.folder_id, &b.path)));
        let mut unattributed = Vec::new();
        for folder in folders {
            let fid = &folder.folder_id;
            for (path, _, _) in differing(
                &reads,
                tree_or_empty(&at_checkpoint, fid),
                tree_or_empty(&now, fid),
            )? {
                let ours = record
                    .changes
                    .iter()
                    .any(|c| c.folder_id == fid.as_str() && c.path == path);
                if !ours && unattributed.len() < UNATTRIBUTED_LIMIT {
                    unattributed.push(format!("{}:{path}", fid.as_str()));
                }
            }
        }
        record.unattributed = unattributed;
    }
    if matches!(
        record.status,
        Checkpointed | Running | ChangesDetected | Validated
    ) {
        if record.status == Validated {
            // The changes are not the ones validated any more.
            record.validation = None;
        }
        record.status = if record.changes.is_empty() {
            Running
        } else {
            ChangesDetected
        };
    }
    save(
        repo,
        &record,
        &format!("{agent_run_id} {} AI change(s)", record.changes.len()),
    )?;
    Ok(record)
}

// --- The AI commit ------------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCommitResult {
    /// Every reason it was not made (none: it was).
    pub refusals: Vec<AiRefusal>,
    pub commit: Option<CommitInfo>,
    pub record: AiRunRecord,
    pub revision: Option<u64>,
}

/// The ref updates (and HEAD) that move HEAD -- its branch, or HEAD itself when detached -- from
/// `from` to `to`.
fn head_move(
    repo: &Repository,
    from: Option<ObjectId>,
    to: ObjectId,
) -> (Vec<RefUpdate>, Option<Head>) {
    match repo.refs().head.clone() {
        Head::Symbolic(name) => (
            vec![RefUpdate {
                name,
                expected: from,
                new: Some(to),
            }],
            None,
        ),
        Head::Detached(_) => (Vec::new(), Some(Head::Detached(to))),
    }
}

/// The index ref update that makes the index `root` once HEAD is `head` (a commit whose root is
/// `head_root`): no ref when they are equal, an index commit on `head` otherwise.
fn index_after(
    repo: &mut Repository,
    root: Root,
    head: ObjectId,
    head_root: ObjectId,
) -> Result<Option<RefUpdate>> {
    let name = RefName::new(INDEX_REF)?;
    let current = repo.refs().refs.get(&name).copied();
    let root_id = root.id();
    let target = if root_id == head_root {
        None
    } else {
        let mut txn = repo.begin_write()?;
        txn.put_tree(&Tree::default())?;
        txn.put_root(&root)?;
        let commit = Commit {
            root: root_id,
            disk_root: None,
            parents: vec![head],
            workspace: txn.repository().meta().workspace.clone(),
            author: Author {
                name: "Local Git".into(),
                id: "index".into(),
            },
            time_ms: 0,
            tz_offset_min: 0,
            source: Source::Automatic,
            meta: [("index".to_string(), "1".to_string())]
                .into_iter()
                .collect(),
            meta_objects: BTreeMap::new(),
            message: "Local Git index".into(),
        };
        let id = txn.put_commit(&commit)?;
        txn.commit()?;
        Some(id)
    };
    if target == current {
        return Ok(None);
    }
    Ok(Some(RefUpdate {
        name,
        expected: current,
        new: target,
    }))
}

/// `trees` with each `(folder, path, entry)` grafted in.
fn graft_all(
    repo: &mut Repository,
    lookup: &dyn TreeLookup,
    trees: &mut BTreeMap<FolderId, ObjectId>,
    keep_from: &BTreeMap<FolderId, ObjectId>,
    sets: &[(FolderId, String, Option<TreeEntry>)],
) -> Result<()> {
    /// A folder, the path's names, the entry, and the folders on the way to keep.
    type Job = (FolderId, Vec<String>, Option<TreeEntry>, Vec<String>);
    let mut jobs: Vec<Job> = Vec::new();
    {
        let reads = Trees(&MemoryAndStore { repo, lookup });
        for (fid, path, entry) in sets {
            let names: Vec<String> = path.split('/').map(str::to_string).collect();
            let keep = (1..names.len())
                .map(|n| names[..n].join("/"))
                .filter(|dir| {
                    find(&reads, Some(tree_or_empty(keep_from, fid)), dir)
                        .ok()
                        .flatten()
                        .is_some_and(|e| e.kind == EntryKind::Directory)
                })
                .collect();
            jobs.push((fid.clone(), names, entry.clone(), keep));
        }
    }
    let mut txn = repo.begin_write()?;
    txn.put_tree(&Tree::default())?;
    let mut pending = Pending::default();
    for (fid, names, entry, keep) in jobs {
        let current = pending.read(txn.repository(), &tree_or_empty(trees, &fid))?;
        let names: Vec<&str> = names.iter().map(String::as_str).collect();
        let tree = graft(
            &mut txn,
            &mut pending,
            Some(&current),
            "",
            &names,
            entry.as_ref(),
            &|dir: &str| keep.iter().any(|k| k == dir),
        )?;
        trees.insert(fid, pending.put(&mut txn, tree)?);
    }
    txn.commit()?;
    Ok(())
}

/// Makes the AI commit: HEAD's tree with exactly the AI's paths set to what the AI left there,
/// from the workspace as `snapshot` (Full, with the unsaved documents) sees it -- or, with
/// nothing changed, every reason it cannot be made.
#[allow(clippy::too_many_arguments)]
pub fn commit(
    lookup: &dyn TreeLookup,
    repo: &mut Repository,
    folders: &[FolderRoot],
    snapshot: &Snapshot,
    agent_run_id: &str,
    message: Option<String>,
    change_set_revision: Option<String>,
    by: &CommitRequest,
) -> Result<AiCommitResult> {
    use AiRunStatus::*;
    let mut record = get_run(repo, agent_run_id)?;
    if !matches!(record.status, ChangesDetected | Validated) {
        return Err(invalid(&record, "committed"));
    }
    let message = message.unwrap_or_else(|| format!("AI: {}", record.reason));
    validate_message(&message)?;
    let mut refusals = Vec::new();
    if ensure_idle(repo).is_err() {
        refusals.push(AiRefusal::OperationInProgress);
    }
    let head = resolve_head(repo).commit();
    let began = opt_id(&record.head)?;
    if head != began {
        refusals.push(AiRefusal::HeadMoved {
            expected: record.head.clone(),
            found: head.map(|h| h.to_hex()),
        });
    }
    if let (Some(expected), Some(found)) = (&record.change_set_revision, &change_set_revision) {
        if expected != found {
            refusals.push(AiRefusal::StaleChangeSet {
                expected: expected.clone(),
                found: found.clone(),
            });
        }
    }
    if record.changes.is_empty() {
        refusals.push(AiRefusal::NothingToCommit);
    }
    let head_folders = commit_folders(repo, head)?;
    let index = index_state(repo)?;
    let now = effective_folders(snapshot)?;
    let mut sets = Vec::new();
    {
        let reads = Trees(&MemoryAndStore { repo, lookup });
        for change in &record.changes {
            let fid = FolderId::new(&change.folder_id)?;
            let (folder_id, path) = (change.folder_id.clone(), change.path.clone());
            let after = entry_at(&change.after, &path)?;
            let before = entry_at(&change.before, &path)?;
            let current = find(&reads, Some(tree_or_empty(&now, &fid)), &path)?;
            let at_head = find(&reads, Some(tree_or_empty(&head_folders, &fid)), &path)?;
            let in_index = if index.root.is_none() {
                at_head.clone()
            } else {
                find(&reads, Some(tree_or_empty(&index.folders, &fid)), &path)?
            };
            if !same(&current, &after) {
                refusals.push(AiRefusal::HumanChangedAiPath {
                    folder_id: folder_id.clone(),
                    path: path.clone(),
                });
            }
            if !same(&before, &at_head) {
                refusals.push(AiRefusal::PreexistingHumanChange {
                    folder_id: folder_id.clone(),
                    path: path.clone(),
                });
            }
            if !same(&in_index, &at_head) {
                refusals.push(AiRefusal::StagedOnAiPath {
                    folder_id: folder_id.clone(),
                    path: path.clone(),
                });
            }
            sets.push((fid, path, after));
        }
    }
    if !refusals.is_empty() {
        return Ok(AiCommitResult {
            refusals,
            commit: None,
            record,
            revision: None,
        });
    }
    // The commit: HEAD's tree with the AI's paths set.
    let mut tree_folders: BTreeMap<FolderId, ObjectId> = folders
        .iter()
        .map(|f| {
            (
                f.folder_id.clone(),
                tree_or_empty(&head_folders, &f.folder_id),
            )
        })
        .collect();
    graft_all(repo, lookup, &mut tree_folders, &now, &sets)?;
    let root = Root {
        folders: tree_folders,
    };
    let head_root = head
        .map(|h| repo.read_commit(&h).map(|c| c.root))
        .transpose()?;
    if Some(root.id()) == head_root {
        return Ok(AiCommitResult {
            refusals: vec![AiRefusal::NothingToCommit],
            commit: None,
            record,
            revision: None,
        });
    }
    // The index: everything staged stays staged; the AI's paths take the commit's entries.
    let mut index_folders: BTreeMap<FolderId, ObjectId> = folders
        .iter()
        .map(|f| {
            let tree = if index.root.is_none() {
                tree_or_empty(&head_folders, &f.folder_id)
            } else {
                tree_or_empty(&index.folders, &f.folder_id)
            };
            (f.folder_id.clone(), tree)
        })
        .collect();
    graft_all(repo, lookup, &mut index_folders, &now, &sets)?;
    let mut meta: BTreeMap<String, String> = BTreeMap::new();
    meta.insert("ai.run".into(), record.agent_run_id.clone());
    meta.insert("ai.checkpoint".into(), record.checkpoint.clone());
    for (key, value) in [
        ("ai.task", &record.task_id),
        ("ai.changeset", &record.change_set_id),
        ("ai.changeset-revision", &record.change_set_revision),
        ("ai.model", &record.model),
    ] {
        if let Some(value) = value {
            meta.insert(key.into(), value.clone());
        }
    }
    if let Some(validation) = &record.validation {
        meta.insert(
            "ai.validation".into(),
            if validation.passed {
                "passed"
            } else {
                "failed"
            }
            .into(),
        );
        if let Some(reference) = &validation.reference {
            meta.insert("ai.validation-ref".into(), reference.clone());
        }
    }
    let checkpoint = ObjectId::from_hex(&record.checkpoint)?;
    let made = Commit {
        root: root.id(),
        disk_root: None,
        parents: head.into_iter().collect(),
        workspace: repo.meta().workspace.clone(),
        author: by.author.clone(),
        time_ms: by.time_ms,
        tz_offset_min: by.tz_offset_min,
        source: Source::Ai,
        meta,
        meta_objects: [("checkpoint".to_string(), checkpoint)]
            .into_iter()
            .collect(),
        message,
    };
    let mut txn = repo.begin_write()?;
    txn.put_root(&root)?;
    let commit_id = txn.put_commit(&made)?;
    txn.commit()?;
    let (mut updates, head_update) = head_move(repo, head, commit_id);
    if let Some(update) = index_after(
        repo,
        Root {
            folders: index_folders,
        },
        commit_id,
        root.id(),
    )? {
        updates.push(update);
    }
    record.status = Committed;
    record.commit = Some(commit_id.to_hex());
    record.finished_ms = Some(now_ms());
    let recorded = write_record(repo, &record)?;
    updates.push(record_update(repo, agent_run_id, recorded)?);
    let revision = repo.refs().revision;
    let revision = repo.update_refs(
        revision,
        &updates,
        head_update,
        "ai-commit",
        &format!("{agent_run_id} -> {}", &commit_id.to_hex()[..12]),
    )?;
    Ok(AiCommitResult {
        refusals: Vec::new(),
        commit: Some(commit_info(commit_id, &made)),
        record,
        revision: Some(revision),
    })
}

// --- Undo AI Run --------------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUndoPlan {
    pub agent_run_id: String,
    /// Every reason it cannot be done (none: it can).
    pub refusals: Vec<AiRefusal>,
    /// Paths whose human edits are kept by a three-way inverse (`folderId:path`).
    pub merged: Vec<String>,
    /// The disk's side (with the restore planner's own refusals).
    pub restore: RestorePlan,
    /// Whether HEAD moves back off the run's commit.
    pub moves_head: bool,
    #[serde(skip)]
    pub record: Option<AiRunRecord>,
    #[serde(skip)]
    pub index: Option<Root>,
}

fn stored_text(repo: &Repository, entry: &Option<TreeEntry>) -> Option<Vec<u8>> {
    match entry {
        Some(TreeEntry {
            kind:
                EntryKind::File {
                    stored: Stored::Yes,
                    ..
                },
            id,
            ..
        }) => {
            let (_, size) = repo.object_info(id).ok()?;
            if size > UNDO_MERGE_MAX_BYTES {
                return None;
            }
            let bytes = repo.read_blob(id, UNDO_MERGE_MAX_BYTES).ok()?;
            (!is_binary(&bytes)).then_some(bytes)
        }
        _ => None,
    }
}

/// Plans undoing the run from the workspace as `snapshot` (Full, persisted, with the unsaved
/// documents) sees it. Writes the inverse's objects (unreferenced until `begin_undo`).
pub fn plan_undo(
    lookup: &dyn TreeLookup,
    repo: &mut Repository,
    folders: &[FolderRoot],
    snapshot: &Snapshot,
    agent_run_id: &str,
) -> Result<AiUndoPlan> {
    let record = get_run(repo, agent_run_id)?;
    if record.status == AiRunStatus::Undone {
        return Err(invalid(&record, "undone again"));
    }
    let mut refusals = Vec::new();
    let committed = opt_id(&record.commit)?;
    let head = resolve_head(repo).commit();
    if let Some(made) = committed {
        if head != Some(made) {
            refusals.push(AiRefusal::HistoryMovedOn {
                commit: made.to_hex(),
            });
        }
        if ensure_idle(repo).is_err() {
            refusals.push(AiRefusal::OperationInProgress);
        }
    }
    if record.changes.is_empty() {
        refusals.push(AiRefusal::NothingToUndo);
    }
    let now = effective_folders(snapshot)?;
    let undoing: Vec<UndoTarget> = record.undo.clone().unwrap_or_default();
    let mut sets: Sets = BTreeMap::new();
    let mut targets = Vec::new();
    let mut merged = Vec::new();
    let mut documents = snapshot.clone();
    documents.overlays.clear();
    let mut merges: Vec<(FolderId, String, Vec<u8>, bool)> = Vec::new();
    {
        let reads = Trees(&MemoryAndStore { repo, lookup });
        for change in &record.changes {
            let fid = FolderId::new(&change.folder_id)?;
            let (folder_id, path) = (change.folder_id.clone(), change.path.clone());
            let before = entry_at(&change.before, &path)?;
            let after = entry_at(&change.after, &path)?;
            let current = find(&reads, Some(tree_or_empty(&now, &fid)), &path)?;
            let mid_undo = undoing
                .iter()
                .find(|t| t.folder_id == folder_id && t.path == path)
                .map(|t| entry_at(&t.entry, &path))
                .transpose()?;
            let overlay = snapshot
                .overlays
                .iter()
                .find(|o| o.folder_id == folder_id && o.path == path);
            if same(&current, &before) || mid_undo.as_ref().is_some_and(|t| same(&current, t)) {
                continue;
            }
            if let Some(overlay) = overlay {
                // Unsaved text on an AI path: replaced only when it is the AI's own.
                let ai_text = matches!(&after, Some(TreeEntry { kind: EntryKind::File { .. }, id, .. }) if *id == overlay.blob.0);
                if !ai_text {
                    refusals.push(AiRefusal::DirtyDocument {
                        folder_id: folder_id.clone(),
                        path: path.clone(),
                    });
                    continue;
                }
                documents.overlays.push(overlay.clone());
            }
            if same(&current, &after) {
                targets.push(UndoTarget {
                    folder_id: folder_id.clone(),
                    path: path.clone(),
                    entry: EntryState::of_opt(&before),
                });
                sets.entry(fid).or_default().push((path, before));
                continue;
            }
            // A human changed it since: take only the AI's change out, if that is clean.
            match (
                stored_text(repo, &after),
                stored_text(repo, &current),
                stored_text(repo, &before),
            ) {
                (Some(a), Some(c), Some(b)) => {
                    let inverse = merge3::merge(&a, &c, &b, ("current", "before the AI"));
                    if inverse.conflicts > 0 {
                        refusals.push(AiRefusal::UndoConflict { folder_id, path });
                    } else {
                        let executable = matches!(
                            current,
                            Some(TreeEntry {
                                kind: EntryKind::File {
                                    executable: true,
                                    ..
                                },
                                ..
                            })
                        );
                        merges.push((fid, path, inverse.bytes, executable));
                    }
                }
                _ => refusals.push(AiRefusal::HumanChangedAiPath { folder_id, path }),
            }
        }
    }
    if !merges.is_empty() {
        let mut txn = repo.begin_write()?;
        for (fid, path, bytes, executable) in merges {
            let id = txn.put_blob(&bytes)?;
            let entry = TreeEntry {
                name: crate::object::EntryName::new(path.rsplit('/').next().unwrap_or(&path))?,
                kind: EntryKind::File {
                    executable,
                    stored: Stored::Yes,
                },
                id,
            };
            merged.push(format!("{}:{path}", fid.as_str()));
            targets.push(UndoTarget {
                folder_id: fid.as_str().to_string(),
                path: path.clone(),
                entry: Some(EntryState::of(&entry)),
            });
            sets.entry(fid).or_default().push((path, Some(entry)));
        }
        txn.commit()?;
    }
    let at_checkpoint = checkpoint_folders(repo, &record)?;
    let mut restore = plan_transition(
        lookup,
        repo,
        folders,
        &documents,
        ObjectId::from_hex(&record.checkpoint)?,
        &sets,
        &at_checkpoint,
        RestorePolicy::ReplaceDocument,
    )?;
    restore.unchanged = restore.operations.is_empty()
        && restore.conflicts.is_empty()
        && restore.documents.is_empty();
    // A committed run: HEAD back to the commit's parent, the AI's paths in the index with it.
    let mut index = None;
    if let (Some(_), true) = (committed, refusals.is_empty()) {
        let parent = opt_id(&record.head)?;
        let parent_folders = commit_folders(repo, parent)?;
        let state = index_state(repo)?;
        let mut trees: BTreeMap<FolderId, ObjectId> = folders
            .iter()
            .map(|f| {
                (
                    f.folder_id.clone(),
                    tree_or_empty(&state.folders, &f.folder_id),
                )
            })
            .collect();
        let back: Vec<(FolderId, String, Option<TreeEntry>)> = record
            .changes
            .iter()
            .map(|c| {
                Ok((
                    FolderId::new(&c.folder_id)?,
                    c.path.clone(),
                    entry_at(&c.before, &c.path)?,
                ))
            })
            .collect::<Result<_>>()?;
        graft_all(repo, lookup, &mut trees, &parent_folders, &back)?;
        index = Some(Root { folders: trees });
    }
    let mut progress = record.clone();
    let mut all_targets = undoing;
    for target in targets {
        all_targets.retain(|t| !(t.folder_id == target.folder_id && t.path == target.path));
        all_targets.push(target);
    }
    progress.undo = Some(all_targets);
    Ok(AiUndoPlan {
        agent_run_id: agent_run_id.to_string(),
        refusals,
        merged,
        restore,
        moves_head: committed.is_some(),
        record: Some(progress),
        index,
    })
}

/// Before the undo's disk change: the record says what is about to be written (so an
/// interrupted undo is recognised and finished), durably.
pub fn begin_undo(repo: &mut Repository, plan: &AiUndoPlan) -> Result<()> {
    let record = plan.record.as_ref().ok_or(LgError::NoOperation)?;
    save(
        repo,
        record,
        &format!("{} undo begins", record.agent_run_id),
    )?;
    Ok(())
}

/// After the disk was changed and verified: the run is undone -- and, for a committed run, HEAD
/// is back on the commit's parent with the index -- in one step.
pub fn finish_undo(repo: &mut Repository, plan: &AiUndoPlan) -> Result<AiRunRecord> {
    let mut record = get_run(repo, &plan.agent_run_id)?;
    let mut updates = Vec::new();
    let mut head_update = None;
    if let Some(made) = opt_id(&record.commit)? {
        let parent = opt_id(&record.head)?.ok_or(LgError::Unborn)?;
        let (moves, head) = head_move(repo, Some(made), parent);
        updates.extend(moves);
        head_update = head;
        let parent_root = repo.read_commit(&parent)?.root;
        if let Some(root) = plan.index.clone() {
            if let Some(update) = index_after(repo, root, parent, parent_root)? {
                updates.push(update);
            }
        }
    }
    record.status = AiRunStatus::Undone;
    record.undone_ms = Some(now_ms());
    record.undo = None;
    let recorded = write_record(repo, &record)?;
    updates.push(record_update(repo, &record.agent_run_id, recorded)?);
    let revision = repo.refs().revision;
    repo.update_refs(
        revision,
        &updates,
        head_update,
        "ai-undo",
        &format!("{} undone", record.agent_run_id),
    )?;
    Ok(record)
}
