//! Garbage collection, retention, storage statistics and integrity (LG-09).
//!
//! **Roots.** An object is kept when anything durable can still reach it: every ref (branches,
//! tags, the index, the checkpoint ref, the operation in progress, stashes, AI run records --
//! whatever `refs.json` names, so a ref kind added later is a root without changing this), a
//! detached HEAD, and the objects the reflog names -- all of them unless a retention policy
//! lets old reflog entries expire. From the roots the walk follows commits to their roots,
//! disk roots, parents and every `metaobj` (index roots, overlay sets, AI checkpoints and
//! commits, operation states), roots to trees, trees to trees and blobs (files over the storage
//! limit were never stored, and are not looked for).
//!
//! **Retention** (`RetentionPolicy`, nothing expires by default): reflog entries older than a
//! maximum age stop keeping their objects -- except each ref's newest few -- which is how old
//! automatic checkpoints and abandoned states go; and records of AI runs that are finished
//! with nothing left to undo (undone, or cancelled or failed with no changes) can expire after
//! a maximum age. Branches, tags, stashes, the index, an operation in progress and every AI run
//! that may still be undone are refs: never expired.
//!
//! **Collection** never deletes. The live objects of every segment holding something
//! unreachable are copied into one new segment (published, synced, beside the old ones), the
//! old segments are moved to `quarantine/gc-<id>/`, the store is re-indexed, and every
//! reachable object is checked present -- else the segments go back and the store needs
//! recovery. A journal (`gc/journal.json`, written durably before each step) records where it
//! got to: a GC interrupted at any point leaves a consistent store (each live object is in an
//! old or the new segment, or both), reported on the next open and never finished on its own;
//! it is rolled back (the quarantined segments moved back) before another GC. Deleting what is
//! in the quarantine is a separate, explicit purge.
//!
//! **Missing objects** reachable from a ref are corruption: GC refuses to run on such a store.
//! Objects reachable only from the reflog may be gone (expired history): not corruption.

use crate::ai::{list_runs, AiRunStatus, AI_PREFIX};
use crate::error::{LgError, Result};
use crate::fault::{self, FaultPoint};
use crate::finding::Finding;
use crate::id::{ObjectId, ObjectKind};
use crate::object::{EntryKind, Stored};
use crate::reflog::ReflogRecord;
use crate::refs::{Head, RefUpdate};
use crate::repository::{Object, Repository};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

pub const GC_JOURNAL: &str = "gc/journal.json";
const JOURNAL_VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionPolicy {
    /// Reflog entries older than this stop keeping their objects (none: they always do).
    pub reflog_max_age_days: Option<u32>,
    /// Each ref's newest this many reflog entries keep their objects whatever their age.
    pub reflog_keep_recent: usize,
    /// Records of AI runs with nothing left to undo, older than this, expire (none: never).
    pub ai_finished_max_age_days: Option<u32>,
}

impl Default for RetentionPolicy {
    /// Nothing expires.
    fn default() -> Self {
        RetentionPolicy {
            reflog_max_age_days: None,
            reflog_keep_recent: 20,
            ai_finished_max_age_days: None,
        }
    }
}

const DAY_MS: u64 = 24 * 60 * 60 * 1000;

/// What keeps an object: the kind of root (`branch`, `tag`, `index`, `checkpoint`, `stash`,
/// `aiRun`, `operation`, `head`, `reflog`, `other`).
fn root_kind(name: &str) -> &'static str {
    if name.starts_with("refs/heads/") {
        "branch"
    } else if name.starts_with("refs/tags/") {
        "tag"
    } else if name == crate::branches::INDEX_REF {
        "index"
    } else if name == crate::history::CHECKPOINT_REF {
        "checkpoint"
    } else if name.starts_with(crate::stash::STASH_PREFIX) {
        "stash"
    } else if name.starts_with(AI_PREFIX) {
        "aiRun"
    } else if name == crate::operation::OPERATION_REF {
        "operation"
    } else {
        "other"
    }
}

/// AI run records retention lets go: finished with nothing left to undo, and old enough.
fn expired_ai_runs(
    repo: &Repository,
    policy: &RetentionPolicy,
    now_ms: u64,
) -> Result<Vec<String>> {
    let Some(days) = policy.ai_finished_max_age_days else {
        return Ok(Vec::new());
    };
    let cutoff = now_ms.saturating_sub(days as u64 * DAY_MS);
    Ok(list_runs(repo, usize::MAX)?
        .items
        .into_iter()
        .filter(|run| {
            let finished = run.status == AiRunStatus::Undone
                || (matches!(run.status, AiRunStatus::Cancelled | AiRunStatus::Failed)
                    && run.changes.is_empty());
            let at = run.undone_ms.or(run.finished_ms).unwrap_or(run.started_ms);
            finished && at < cutoff
        })
        .map(|run| run.agent_run_id)
        .collect())
}

/// The roots: live (refs and HEAD) and history (reflog entries retention keeps).
struct Roots {
    live: Vec<(ObjectId, &'static str)>,
    history: Vec<ObjectId>,
    expired_reflog: usize,
}

fn roots(
    repo: &Repository,
    policy: &RetentionPolicy,
    now_ms: u64,
    dropped_refs: &HashSet<String>,
) -> Result<Roots> {
    let mut live = Vec::new();
    for (name, id) in &repo.refs().refs {
        if !dropped_refs.contains(name.as_str()) {
            live.push((*id, root_kind(name.as_str())));
        }
    }
    if let Head::Detached(id) = &repo.refs().head {
        live.push((*id, "head"));
    }
    let records = repo.reflog()?;
    let cutoff = policy
        .reflog_max_age_days
        .map(|days| now_ms.saturating_sub(days as u64 * DAY_MS));
    // Each ref's newest entries are kept whatever their age.
    let mut seen_per_ref: HashMap<&str, usize> = HashMap::new();
    let mut history = Vec::new();
    let mut expired = 0;
    for record in records.iter().rev() {
        let ReflogRecord::Update {
            name, old, new, ms, ..
        } = record
        else {
            continue;
        };
        let rank = seen_per_ref.entry(name.as_str()).or_insert(0);
        *rank += 1;
        let keep = match cutoff {
            None => true,
            Some(cutoff) => *ms >= cutoff || *rank <= policy.reflog_keep_recent,
        };
        if !keep {
            expired += 1;
            continue;
        }
        for value in [old, new].into_iter().flatten() {
            if let Ok(id) = ObjectId::from_hex(value) {
                history.push(id);
            }
        }
    }
    Ok(Roots {
        live,
        history,
        expired_reflog: expired,
    })
}

/// Everything reachable from `starts`; what is reachable but absent goes to `missing`.
fn walk(
    repo: &Repository,
    starts: impl IntoIterator<Item = (ObjectId, String)>,
    seen: &mut HashSet<ObjectId>,
    missing: &mut Vec<Finding>,
) {
    let mut stack: Vec<(ObjectId, String)> = starts.into_iter().collect();
    while let Some((id, from)) = stack.pop() {
        if !seen.insert(id) {
            continue;
        }
        if !repo.contains(&id) {
            missing.push(Finding::MissingObject {
                id: id.to_hex(),
                from,
            });
            continue;
        }
        let here = id.to_hex();
        let Ok(object) = (match repo.odb().kind_of(&id) {
            Some(ObjectKind::Blob) | None => continue,
            Some(_) => repo.object(&id),
        }) else {
            continue;
        };
        match object {
            Object::Commit(commit) => {
                stack.push((commit.root, here.clone()));
                if let Some(disk) = commit.disk_root {
                    stack.push((disk, here.clone()));
                }
                for parent in commit.parents {
                    stack.push((parent, here.clone()));
                }
                for (_, meta) in commit.meta_objects {
                    stack.push((meta, here.clone()));
                }
            }
            Object::Root(root) => {
                for tree in root.folders.values() {
                    stack.push((*tree, here.clone()));
                }
            }
            Object::Tree(tree) => {
                for entry in tree.entries() {
                    if let EntryKind::File {
                        stored: Stored::No { .. },
                        ..
                    } = entry.kind
                    {
                        continue;
                    }
                    stack.push((entry.id, here.clone()));
                }
            }
            Object::Blob(_) => {}
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GcPlan {
    /// The refs revision and reflog length the plan was made at: a GC runs only if unchanged.
    pub revision: u64,
    pub reflog_records: usize,
    pub policy: RetentionPolicy,
    pub objects: usize,
    pub reachable: usize,
    pub unreachable: usize,
    /// The unreachable objects' payload sizes.
    pub unreachable_bytes: u64,
    pub segments: usize,
    pub segments_to_rewrite: usize,
    pub live_objects_to_copy: usize,
    /// Live roots by kind (`branch`, `tag`, `stash`, `aiRun`, ...), and how many reflog
    /// objects history keeps.
    pub protected: BTreeMap<String, usize>,
    pub expired_reflog_entries: usize,
    /// AI run records retention removes first.
    pub expired_ai_runs: Vec<String>,
    /// Reachable from a ref and absent: corruption -- GC refuses to run.
    pub missing: Vec<Finding>,
    #[serde(skip)]
    rewrite: Vec<String>,
    #[serde(skip)]
    copy: Vec<ObjectId>,
    #[serde(skip)]
    keep: HashSet<ObjectId>,
}

/// Plans a GC under `policy` (`now_ms`: the time ages are measured from). Reads only.
pub fn plan(repo: &Repository, policy: &RetentionPolicy, now_ms: u64) -> Result<GcPlan> {
    let expired_ai = expired_ai_runs(repo, policy, now_ms)?;
    let dropped: HashSet<String> = expired_ai
        .iter()
        .map(|id| crate::ai::run_ref_name(id).map(|r| r.as_str().to_string()))
        .collect::<Result<_>>()?;
    plan_with(repo, policy, now_ms, expired_ai, &dropped)
}

fn plan_with(
    repo: &Repository,
    policy: &RetentionPolicy,
    now_ms: u64,
    expired_ai: Vec<String>,
    dropped: &HashSet<String>,
) -> Result<GcPlan> {
    let roots = roots(repo, policy, now_ms, dropped)?;
    let mut protected: BTreeMap<String, usize> = BTreeMap::new();
    for (_, kind) in &roots.live {
        *protected.entry((*kind).to_string()).or_default() += 1;
    }
    let mut keep = HashSet::new();
    let mut missing = Vec::new();
    walk(
        repo,
        roots
            .live
            .iter()
            .map(|(id, kind)| (*id, (*kind).to_string())),
        &mut keep,
        &mut missing,
    );
    // History: whatever of it is still there is kept; what is gone is expired history.
    let before = keep.len();
    let mut gone = Vec::new();
    walk(
        repo,
        roots.history.iter().map(|id| (*id, "reflog".to_string())),
        &mut keep,
        &mut gone,
    );
    protected.insert("reflog".into(), keep.len() - before);
    keep.retain(|id| repo.contains(id));
    let mut rewrite = Vec::new();
    let mut copy = Vec::new();
    let mut unreachable = 0;
    let mut unreachable_bytes = 0u64;
    let segments = repo.odb().segments_with_objects();
    for (name, objects) in &segments {
        let dead: Vec<&ObjectId> = objects.iter().filter(|id| !keep.contains(id)).collect();
        if dead.is_empty() && !objects.is_empty() {
            continue;
        }
        unreachable += dead.len();
        let dead: Vec<ObjectId> = dead.into_iter().copied().collect();
        unreachable_bytes += repo.odb().sizes(&dead).unwrap_or(0);
        rewrite.push(name.clone());
        copy.extend(objects.iter().filter(|id| keep.contains(id)).copied());
    }
    Ok(GcPlan {
        revision: repo.refs().revision,
        reflog_records: repo.reflog()?.len(),
        policy: policy.clone(),
        objects: repo.object_count(),
        reachable: keep.len(),
        unreachable,
        unreachable_bytes,
        segments: segments.len(),
        segments_to_rewrite: rewrite.len(),
        live_objects_to_copy: copy.len(),
        protected,
        expired_reflog_entries: roots.expired_reflog,
        expired_ai_runs: expired_ai,
        missing,
        rewrite,
        copy,
        keep,
    })
}

/// Where a GC got to (the journal).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GcStage {
    /// Live objects are being copied into the new segment.
    Copying,
    /// The old segments are being moved to quarantine.
    Retiring,
    /// Finished: the quarantine holds the old segments until purged.
    Done,
    /// An interrupted GC was undone: its segments are back in `objects/`.
    RolledBack,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcJournal {
    pub version: u32,
    pub id: u64,
    pub stage: GcStage,
    /// The segments retired (moved to quarantine) by this GC.
    pub segments: Vec<String>,
    /// The new segment holding their live objects.
    pub new_segment: Option<String>,
    /// `quarantine/gc-<id>`.
    pub quarantine: String,
}

fn journal_path(repo: &Repository) -> PathBuf {
    repo.store_dir().join(GC_JOURNAL)
}

/// The last GC's journal, if there was one.
pub fn journal(store_dir: &Path) -> Result<Option<GcJournal>> {
    let path = store_dir.join(GC_JOURNAL);
    match fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|e| LgError::InvalidFormat(format!("GC journal: {e}"))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn write_journal(repo: &Repository, journal: &GcJournal) -> Result<()> {
    let bytes = serde_json::to_vec(journal)
        .map_err(|e| LgError::InvalidFormat(format!("GC journal: {e}")))?;
    ide_workspace::durable::write_durably(&journal_path(repo), &bytes).map_err(LgError::Io)
}

/// An interrupted GC (a journal that is neither done nor rolled back).
pub fn interrupted(store_dir: &Path) -> Option<GcJournal> {
    journal(store_dir)
        .ok()
        .flatten()
        .filter(|j| matches!(j.stage, GcStage::Copying | GcStage::Retiring))
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GcOutcome {
    pub objects_before: usize,
    pub objects_after: usize,
    pub bytes_before: u64,
    pub bytes_after: u64,
    pub segments_retired: usize,
    /// Where the retired segments wait to be purged (`quarantine/gc-<id>`).
    pub quarantine: Option<String>,
    pub expired_ai_runs: Vec<String>,
}

/// Runs a GC planned by `plan` -- only if the store is as the plan saw it, nothing is missing,
/// and no earlier GC is unresolved. Never deletes: retired segments go to quarantine.
pub fn run(repo: &mut Repository, plan: &GcPlan, now_ms: u64) -> Result<GcOutcome> {
    if !repo.is_writer() {
        return Err(LgError::ReadOnly);
    }
    if let Some(journal) = interrupted(repo.store_dir()) {
        return Err(LgError::RecoveryRequired(format!(
            "GC {} was interrupted ({:?}): roll it back first",
            journal.id, journal.stage
        )));
    }
    if !plan.missing.is_empty() {
        return Err(LgError::RecoveryRequired(format!(
            "{} object(s) reachable from refs are missing: GC does not run on a damaged store",
            plan.missing.len()
        )));
    }
    if repo.refs().revision != plan.revision || repo.reflog()?.len() != plan.reflog_records {
        return Err(LgError::StaleRevision {
            expected: plan.revision,
            found: repo.refs().revision,
        });
    }
    let objects_before = repo.object_count();
    let bytes_before = repo.storage_bytes();
    // Retention's ref removals first (one step), then a plan of the store as it is now.
    let mut plan = plan.clone();
    if !plan.expired_ai_runs.is_empty() {
        let mut updates = Vec::new();
        for id in &plan.expired_ai_runs {
            let name = crate::ai::run_ref_name(id)?;
            let current = repo.refs().refs.get(&name).copied();
            updates.push(RefUpdate {
                name,
                expected: current,
                new: None,
            });
        }
        let revision = repo.refs().revision;
        repo.update_refs(
            revision,
            &updates,
            None,
            "gc",
            &format!("retention: {} finished AI run(s)", updates.len()),
        )?;
        plan = plan_with(
            repo,
            &plan.policy,
            now_ms,
            plan.expired_ai_runs.clone(),
            &HashSet::new(),
        )?;
    }
    if plan.rewrite.is_empty() {
        return Ok(GcOutcome {
            objects_before,
            objects_after: repo.object_count(),
            bytes_before,
            bytes_after: repo.storage_bytes(),
            segments_retired: 0,
            quarantine: None,
            expired_ai_runs: plan.expired_ai_runs,
        });
    }
    let id = now_ms;
    let quarantine = format!("quarantine/gc-{id}");
    let mut journal = GcJournal {
        version: JOURNAL_VERSION,
        id,
        stage: GcStage::Copying,
        segments: plan.rewrite.clone(),
        new_segment: None,
        quarantine: quarantine.clone(),
    };
    write_journal(repo, &journal)?;
    let new_segment = repo.copy_objects(&plan.copy)?;
    fault::hit(FaultPoint::GcCopied);
    journal.stage = GcStage::Retiring;
    journal.new_segment = new_segment.clone();
    write_journal(repo, &journal)?;
    let objects_dir = repo.store_dir().join("objects");
    let into = repo.store_dir().join(&quarantine);
    // The new segment is never retired, even if a plan listed a name it reuses.
    let retiring: Vec<String> = plan
        .rewrite
        .iter()
        .filter(|name| Some(*name) != new_segment.as_ref())
        .cloned()
        .collect();
    repo.move_segments(&retiring, &objects_dir, &into)?;
    fault::hit(FaultPoint::GcRetired);
    // Everything reachable must still be there; if not, the segments go back.
    if let Some(lost) = plan.keep.iter().find(|id| !repo.contains(id)) {
        let lost = *lost;
        repo.move_segments(&retiring, &into, &objects_dir)?;
        journal.stage = GcStage::RolledBack;
        write_journal(repo, &journal)?;
        return Err(LgError::RecoveryRequired(format!(
            "GC would have lost {lost}; its segments were put back"
        )));
    }
    journal.stage = GcStage::Done;
    write_journal(repo, &journal)?;
    Ok(GcOutcome {
        objects_before,
        objects_after: repo.object_count(),
        bytes_before,
        bytes_after: repo.storage_bytes(),
        segments_retired: retiring.len(),
        quarantine: Some(quarantine),
        expired_ai_runs: plan.expired_ai_runs,
    })
}

/// Undoes an interrupted GC: its quarantined segments go back to `objects/` (an object then
/// in two segments is the same bytes; the store reads the first). Nothing is deleted.
pub fn roll_back(repo: &mut Repository) -> Result<Option<GcJournal>> {
    if !repo.is_writer() {
        return Err(LgError::ReadOnly);
    }
    let Some(mut journal) = interrupted(repo.store_dir()) else {
        return Ok(None);
    };
    let from = repo.store_dir().join(&journal.quarantine);
    let objects_dir = repo.store_dir().join("objects");
    let segments = journal.segments.clone();
    repo.move_segments(&segments, &from, &objects_dir)?;
    journal.stage = GcStage::RolledBack;
    write_journal(repo, &journal)?;
    Ok(Some(journal))
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeOutcome {
    pub folders: Vec<String>,
    pub bytes: u64,
}

fn dir_bytes(dir: &Path) -> u64 {
    fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| {
            let path = entry.path();
            if path.is_dir() {
                dir_bytes(&path)
            } else {
                entry.metadata().map(|m| m.len()).unwrap_or(0)
            }
        })
        .sum()
}

/// Deletes what finished GCs retired (`quarantine/gc-*`) -- the one step that removes data,
/// and only when asked. Refused while a GC is unresolved. Damaged files quarantined on open
/// (`*.corrupt`, `*.torn`) are evidence and are never touched.
pub fn purge(repo: &mut Repository) -> Result<PurgeOutcome> {
    if !repo.is_writer() {
        return Err(LgError::ReadOnly);
    }
    if let Some(journal) = interrupted(repo.store_dir()) {
        return Err(LgError::RecoveryRequired(format!(
            "GC {} was interrupted: roll it back before purging",
            journal.id
        )));
    }
    let quarantine = repo.store_dir().join("quarantine");
    let mut folders = Vec::new();
    let mut bytes = 0;
    for entry in fs::read_dir(&quarantine).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        if name.starts_with("gc-") && path.is_dir() {
            bytes += dir_bytes(&path);
            fs::remove_dir_all(&path)?;
            folders.push(name);
        }
    }
    folders.sort();
    Ok(PurgeOutcome { folders, bytes })
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageStats {
    pub objects: usize,
    pub blobs: usize,
    pub trees: usize,
    pub roots: usize,
    pub commits: usize,
    pub segments: usize,
    pub storage_bytes: u64,
    pub refs: usize,
    pub reflog_records: usize,
    pub ai_runs: usize,
    pub stashes: usize,
    /// Retired by GC, waiting to be purged.
    pub quarantine_gc_bytes: u64,
    /// Damaged files set aside on open (evidence; never purged).
    pub quarantine_other_bytes: u64,
    pub last_gc: Option<GcJournal>,
}

/// What the store holds. Reads the in-memory index, the refs and the reflog -- no object.
pub fn stats(repo: &Repository) -> Result<StorageStats> {
    let [blobs, trees, roots, commits] = repo.odb().kind_counts();
    let quarantine = repo.store_dir().join("quarantine");
    let (mut gc_bytes, mut other_bytes) = (0, 0);
    for entry in fs::read_dir(&quarantine).into_iter().flatten().flatten() {
        let path = entry.path();
        let size = if path.is_dir() {
            dir_bytes(&path)
        } else {
            entry.metadata().map(|m| m.len()).unwrap_or(0)
        };
        if entry.file_name().to_string_lossy().starts_with("gc-") {
            gc_bytes += size;
        } else {
            other_bytes += size;
        }
    }
    let refs = &repo.refs().refs;
    Ok(StorageStats {
        objects: repo.object_count(),
        blobs,
        trees,
        roots,
        commits,
        segments: repo.segment_count(),
        storage_bytes: repo.storage_bytes(),
        refs: refs.len(),
        reflog_records: repo.reflog()?.len(),
        ai_runs: refs
            .keys()
            .filter(|n| n.as_str().starts_with(AI_PREFIX))
            .count(),
        stashes: refs
            .keys()
            .filter(|n| n.as_str().starts_with(crate::stash::STASH_PREFIX))
            .count(),
        quarantine_gc_bytes: gc_bytes,
        quarantine_other_bytes: other_bytes,
        last_gc: journal(repo.store_dir())?,
    })
}

/// A step that would fix what the integrity check found -- never taken automatically.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairStep {
    pub problem: String,
    pub suggestion: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrityReport {
    /// Nothing wrong was found.
    pub ok: bool,
    /// The store's own checks (`verify`): dangling refs, corrupt and missing objects.
    pub findings: Vec<Finding>,
    /// Problems reading the store's records (reflog, operation state, AI runs, GC journal).
    pub records: Vec<String>,
    pub interrupted_gc: Option<GcJournal>,
    /// What could be done about each problem, for the user to decide.
    pub repair: Vec<RepairStep>,
}

/// Checks the store (`full`: every object re-hashed and everything reachable walked) and every
/// record it keeps. Reports; never repairs.
pub fn integrity(repo: &Repository, full: bool) -> IntegrityReport {
    let findings = repo.verify(full);
    let mut records = Vec::new();
    if let Err(error) = repo.reflog() {
        records.push(format!("reflog: {error}"));
    }
    if let Err(error) = crate::operation::current(repo) {
        records.push(format!("operation state: {error}"));
    }
    if let Err(error) = list_runs(repo, usize::MAX) {
        records.push(format!("AI run records: {error}"));
    }
    if let Err(error) = journal(repo.store_dir()) {
        records.push(format!("GC journal: {error}"));
    }
    let interrupted_gc = interrupted(repo.store_dir());
    let mut repair = Vec::new();
    for finding in &findings {
        let (problem, suggestion) = match finding {
            Finding::DanglingRef { name, id } => (
                format!("{name} points to {id}, which is missing"),
                format!("Delete or re-point {name} explicitly; Local Git does not rewrite refs on its own."),
            ),
            Finding::CorruptObject { id, detail } => (
                format!("object {id} is damaged ({detail})"),
                "Restore the store from a copy, or remove what refers to it explicitly; the damaged data is kept as evidence.".into(),
            ),
            Finding::MissingObject { id, from } => (
                format!("object {id} (from {from}) is missing"),
                "History that needs it cannot be shown or restored; remove the ref that reaches it explicitly, or restore the store from a copy.".into(),
            ),
            other => (format!("{other:?}"), "See the finding.".into()),
        };
        repair.push(RepairStep {
            problem,
            suggestion,
        });
    }
    if let Some(journal) = &interrupted_gc {
        repair.push(RepairStep {
            problem: format!("GC {} was interrupted ({:?})", journal.id, journal.stage),
            suggestion: "Roll it back (its segments go back; nothing is lost), then run GC again."
                .into(),
        });
    }
    for record in &records {
        repair.push(RepairStep {
            problem: record.clone(),
            suggestion:
                "The record is kept as it is; restore it from a copy or remove it explicitly."
                    .into(),
        });
    }
    IntegrityReport {
        ok: findings.is_empty() && records.is_empty() && interrupted_gc.is_none(),
        findings,
        records,
        interrupted_gc,
        repair,
    }
}
