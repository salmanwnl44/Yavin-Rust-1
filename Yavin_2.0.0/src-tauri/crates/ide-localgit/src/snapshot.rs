//! Snapshots: the workspace as it is on disk, and as the user has it with unsaved edits.
//!
//! A snapshot has two roots:
//!
//! - the **disk root**: exactly what is on disk (`scan.rs`), and
//! - the **effective root**: the disk root with the unsaved documents applied -- a dirty
//!   document's text replaces its file, and a dirty document whose file was deleted puts it
//!   back. Nothing is written to the project to get it; the documents stay the DocumentService's.
//!
//! They are the same object when no document is unsaved. The overlays used are listed in the
//! snapshot (and, as a canonical text blob -- the overlay set -- when there are any), so the
//! effective root can be explained and rebuilt.
//!
//! **Ephemeral and persisted.** A snapshot for status is ephemeral: files are hashed, trees
//! computed in memory, nothing is written. A persisted snapshot writes every blob, tree, both
//! roots and the overlay set into the store in one transaction (published atomically, or not
//! at all); what refers to them -- a checkpoint, a commit -- is a later phase's.
//!
//! **Modes.** `Full` lists every directory and stats every file (hashing only what the scan
//! cache cannot vouch for); `Verify` hashes everything; `Incremental` opens only what the
//! watcher reported and takes every other directory from the previous scan. The watcher is an
//! optimisation, never the source of truth, so a scan is Full when:
//!
//! 1. it is the first since the store was opened (or since a scan failed or was cancelled),
//! 2. the watcher is not known to be healthy: never reported, failed, reported a generation
//!    other than the one watching when the previous scan started, or sent events of another,
//! 3. it is the 20th snapshot since the last Full, or 10 minutes have passed since it,
//! 4. a `.yavinignore` changed (the rules for everything below it may have),
//! 5. it is persisted (a persisted snapshot never builds on an ephemeral one), or
//! 6. the caller asked for Full or Verify.
//!
//! Otherwise it is Incremental. A rescan scope from the watcher (dropped or overflowing
//! events) is scanned in full inside an incremental scan; one at a folder's root is a Full scan.
//! Events that arrive during a scan are kept for the next one. The watcher reports a change up
//! to about a second after it happens, so an incremental snapshot can miss a change made in
//! that last second -- one reason a persisted snapshot is always Full.

use crate::error::{LgError, Result};
use crate::exclude::{is_git, IgnoreFile, Rules, YAVINIGNORE};
use crate::id::{hash_object, ObjectId, ObjectKind};
use crate::object::{EntryKind, EntryName, FolderId, Root, Stored, Tree, TreeEntry};
use crate::repository::{Mode, Repository, WriteTxn};
use crate::scan::{
    name_key, CacheEntry, Counters, DirtyNode, FileIdentity, FolderCache, Problem, TreeLookup, Walk,
};
use crate::workspace::resource_id_of;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Full after this many snapshots since the last Full...
pub const FULL_EVERY_SNAPSHOTS: u32 = 20;
/// ...or after this long.
pub const FULL_EVERY: Duration = Duration::from_secs(10 * 60);
/// How often progress is reported, at most (10 Hz).
pub const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// A folder of the workspace, as the native side has it open.
#[derive(Clone, Debug)]
pub struct FolderRoot {
    pub folder_id: FolderId,
    pub path: PathBuf,
    pub resource_id: String,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum RequestedMode {
    /// Incremental when that is safe (see the module documentation), else Full.
    #[default]
    Auto,
    Full,
    /// Hash every file, trusting no cache.
    Verify,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ScanMode {
    Full,
    Incremental,
    Verify,
}

/// Why a scan was not incremental.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FullReason {
    FirstScan,
    WatcherUnavailable,
    WatcherChanged,
    Periodic,
    IgnoreRulesChanged,
    Persisted,
    Requested,
}

/// An unsaved named document: its path and the exact bytes it would be saved as.
#[derive(Clone, Debug)]
pub struct OverlayInput {
    /// The document's file, absolute, as the native side spells paths.
    pub path: String,
    pub bytes: Arc<Vec<u8>>,
    pub encoding: String,
    pub line_ending: String,
    pub version: u64,
}

/// An untitled document, for recovery snapshots only: it has no path, so it is in no tree.
#[derive(Clone, Debug)]
pub struct UntitledInput {
    pub id: String,
    pub bytes: Arc<Vec<u8>>,
    pub encoding: String,
    pub line_ending: String,
    pub version: u64,
}

#[derive(Clone, Debug, Default)]
pub struct SnapshotRequest {
    pub mode: RequestedMode,
    pub persist: bool,
    /// Lets a persisted snapshot be incremental (a checkpoint from a warm engine): directories
    /// the watcher did not report are reused only when their trees are already in the store,
    /// and a change made within the watcher's latency (about a second) can be missed. Off, a
    /// persisted snapshot is always Full.
    pub allow_incremental_persist: bool,
    pub overlays: Vec<OverlayInput>,
    pub untitled: Vec<UntitledInput>,
}

/// An overlay that was applied to the effective root.
#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayRecord {
    pub folder_id: String,
    pub path: String,
    pub blob: ObjectIdText,
    pub size: u64,
    pub encoding: String,
    pub line_ending: String,
    pub version: u64,
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UntitledRecord {
    pub id: String,
    pub blob: ObjectIdText,
    pub size: u64,
    pub encoding: String,
    pub line_ending: String,
    pub version: u64,
}

/// An object id as its 64 hex digits (what the renderer is given).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct ObjectIdText(pub ObjectId);

impl Serialize for ObjectIdText {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.0.to_hex())
    }
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderSnapshot {
    pub folder_id: String,
    pub disk_tree: ObjectIdText,
    pub effective_tree: ObjectIdText,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanStats {
    pub files: u64,
    pub directories: u64,
    pub reused_directories: u64,
    pub files_hashed: u64,
    pub bytes_hashed: u64,
    pub cache_hits: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    /// Increases with every snapshot of this store while it is open.
    pub sequence: u64,
    pub mode: ScanMode,
    pub full_reason: Option<FullReason>,
    pub taken_ms: u64,
    pub duration_ms: u64,
    /// `ws-…`: the workspace, never a path.
    pub workspace: String,
    /// The watcher generation the scan relied on (incremental only).
    pub watcher_generation: Option<u64>,
    pub disk_root: ObjectIdText,
    pub effective_root: ObjectIdText,
    pub folders: Vec<FolderSnapshot>,
    pub overlays: Vec<OverlayRecord>,
    pub untitled: Vec<UntitledRecord>,
    /// The canonical overlay set blob, when there were overlays or untitled documents.
    pub overlay_set: Option<ObjectIdText>,
    pub problems: Vec<Problem>,
    pub stats: ScanStats,
    /// Whether every object is now in the store.
    pub persisted: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    /// `scanning`, `overlays` or `writing`.
    pub phase: &'static str,
    pub files: u64,
    pub directories: u64,
    pub bytes_hashed: u64,
    /// How many files the previous scan saw, if there was one.
    pub total_estimate: Option<u64>,
}

/// How a caller cancels a snapshot and hears its progress.
pub struct Control<'a> {
    pub cancel: &'a AtomicBool,
    pub progress: &'a (dyn Fn(&Progress) + Sync),
}

/// A change the watcher reported, as it reports them: absolute paths.
#[derive(Clone, Debug)]
pub struct WatchedChange {
    pub path: String,
    pub from: Option<String>,
}

#[derive(Default)]
struct WatchState {
    generation: Option<u64>,
    healthy: bool,
    /// Something was missed: the next scan must be Full.
    uncertain: bool,
    dirty: HashMap<String, DirtyNode>,
}

struct EngineState {
    cache: HashMap<String, FolderCache>,
    cache_loaded: bool,
    /// Each folder's disk tree in the last snapshot.
    last_disk: HashMap<String, ObjectId>,
    last_file_count: Option<u64>,
    /// Every tree of the last snapshot (disk and effective), for the next incremental scan
    /// and for status.
    trees: HashMap<ObjectId, Tree>,
    since_full: u32,
    last_full: Option<Instant>,
    /// The watcher generation that was healthy when the last scan started.
    scan_generation: Option<u64>,
    sequence: u64,
}

/// One store's snapshot state: one snapshot at a time. Watcher notifications (`watcher_*`)
/// never wait for a scan.
pub struct SnapshotEngine {
    folders: Vec<FolderRoot>,
    max_blob: u64,
    state: Mutex<EngineState>,
    watch: Mutex<WatchState>,
}

fn now_ns() -> i128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as i128)
        .unwrap_or(0)
}

/// The trees an engine holds in memory (its last snapshot's).
struct MemoryTrees<'a>(&'a HashMap<ObjectId, Tree>);

impl TreeLookup for MemoryTrees<'_> {
    fn tree(&self, id: &ObjectId) -> Option<Tree> {
        self.0.get(id).cloned()
    }
}

/// Where a scan reads trees it did not compute itself.
enum Source<'a, 'r> {
    Shared(&'a Mutex<Repository>),
    Txn(&'a Mutex<WriteTxn<'r>>),
}

struct Lookup<'a, 'r> {
    trees: &'a HashMap<ObjectId, Tree>,
    source: Source<'a, 'r>,
}

impl TreeLookup for Lookup<'_, '_> {
    fn tree(&self, id: &ObjectId) -> Option<Tree> {
        if let Some(tree) = self.trees.get(id) {
            return Some(tree.clone());
        }
        match &self.source {
            Source::Shared(repo) => repo.lock().ok()?.read_tree(id).ok(),
            Source::Txn(txn) => txn.lock().ok()?.repository().read_tree(id).ok(),
        }
    }
}

/// Folder-relative names of `path`, spelled as the path spells them. `None` when the path is
/// not strictly inside `folder`, or names anything a tree cannot hold.
pub fn relative_to(folder: &FolderRoot, path: &str) -> Option<Vec<String>> {
    let resource = resource_id_of(path).ok()?;
    let rest = resource
        .strip_prefix(&folder.resource_id)?
        .strip_prefix('/')?;
    if rest.is_empty() {
        return None;
    }
    let depth = rest.split('/').count();
    let clean = ide_workspace::file_tree::clean_path_str(path);
    let parts: Vec<&str> = clean.trim_end_matches('/').split('/').collect();
    if parts.len() < depth {
        return None;
    }
    let names: Vec<String> = parts[parts.len() - depth..]
        .iter()
        .map(|part| part.to_string())
        .collect();
    if names.iter().any(|name| EntryName::new(name).is_err()) {
        return None;
    }
    // The spelled path must name exactly what the resource id does.
    let spelled = names.join("/");
    let same = if cfg!(windows) {
        spelled.to_lowercase() == rest.to_lowercase()
    } else {
        spelled == rest
    };
    same.then_some(names)
}

/// The trees HEAD's commit has for each folder; none when HEAD is unborn or unreadable.
pub fn head_trees(repo: &Repository) -> BTreeMap<FolderId, ObjectId> {
    repo.refs()
        .head_commit()
        .and_then(|id| repo.read_commit(&id).ok())
        .and_then(|commit| repo.read_root(&commit.root).ok())
        .map(|root| root.folders)
        .unwrap_or_default()
}

impl SnapshotEngine {
    pub fn new(folders: Vec<FolderRoot>, max_blob: u64) -> SnapshotEngine {
        SnapshotEngine {
            folders,
            max_blob,
            state: Mutex::new(EngineState {
                cache: HashMap::new(),
                cache_loaded: false,
                last_disk: HashMap::new(),
                last_file_count: None,
                trees: HashMap::new(),
                since_full: 0,
                last_full: None,
                scan_generation: None,
                sequence: 0,
            }),
            watch: Mutex::new(WatchState::default()),
        }
    }

    pub fn folders(&self) -> &[FolderRoot] {
        &self.folders
    }

    /// The watcher of `generation` is watching (`healthy`) or has failed.
    pub fn watcher_status(&self, generation: u64, healthy: bool) {
        let mut watch = self.watch.lock().unwrap();
        if watch.generation != Some(generation) {
            // Another watch: what the old one reported, or missed, says nothing now.
            watch.generation = Some(generation);
            watch.dirty.clear();
            watch.uncertain = true;
        }
        watch.healthy = healthy;
        if !healthy {
            watch.uncertain = true;
        }
    }

    /// A batch of the watcher's changes under `root` (absolute paths, as it reports them).
    pub fn watcher_changes(
        &self,
        generation: u64,
        root: &str,
        changes: &[WatchedChange],
        rescan: &[String],
    ) {
        let mut watch = self.watch.lock().unwrap();
        if watch.generation != Some(generation) {
            watch.uncertain = true;
            return;
        }
        let Ok(root_id) = resource_id_of(root) else {
            return;
        };
        let Some(folder) = self
            .folders
            .iter()
            .find(|folder| folder.resource_id == root_id)
        else {
            return;
        };
        let dirty = watch
            .dirty
            .entry(folder.folder_id.as_str().to_string())
            .or_default();
        let mut mark = |path: &str, rescan: bool| {
            if resource_id_of(path).is_ok_and(|id| id == folder.resource_id) {
                dirty.deep = true;
                return;
            }
            if let Some(names) = relative_to(folder, path) {
                let names: Vec<&str> = names.iter().map(String::as_str).collect();
                if rescan {
                    dirty.rescan(&names);
                } else {
                    dirty.changed(&names);
                }
            }
        };
        for change in changes {
            mark(&change.path, false);
            if let Some(from) = &change.from {
                mark(from, false);
            }
        }
        for scope in rescan {
            mark(scope, true);
        }
    }

    /// Takes a snapshot (see the module documentation). Persisting needs the writer.
    pub fn snapshot(
        &self,
        repo: &Mutex<Repository>,
        request: &SnapshotRequest,
        control: &Control,
    ) -> Result<Snapshot> {
        let mut state = self.state.lock().unwrap();
        self.snapshot_in(&mut state, repo, request, control)
    }

    /// Takes an ephemeral snapshot and its status together, so the status is of exactly that
    /// snapshot (no other can run between them).
    pub fn status(
        &self,
        repo: &Mutex<Repository>,
        request: &SnapshotRequest,
        control: &Control,
        limit: usize,
    ) -> Result<(Snapshot, crate::status::Status)> {
        if request.persist {
            return Err(LgError::InvalidFormat(
                "status is computed from an ephemeral snapshot".into(),
            ));
        }
        let mut state = self.state.lock().unwrap();
        let snapshot = self.snapshot_in(&mut state, repo, request, control)?;
        let lookup = Lookup {
            trees: &state.trees,
            source: Source::Shared(repo),
        };
        let head = {
            let repo = repo.lock().unwrap();
            let commit = repo.refs().head_commit();
            let root = match commit {
                Some(id) => Some(repo.read_commit(&id)?.root),
                None => None,
            };
            let trees = match root {
                Some(root) => repo.read_root(&root)?.folders,
                None => BTreeMap::new(),
            };
            let index = crate::branches::index_state(&repo)?;
            crate::status::Head {
                commit,
                root,
                trees,
                index_root: index.root,
                index_trees: index.folders,
            }
        };
        let status = crate::status::compute(&self.folders, &lookup, &head, &snapshot, limit)?;
        Ok((snapshot, status))
    }

    /// Diffs a commit (`from`, or HEAD; none before the first commit) against the workspace
    /// as the user has it: an ephemeral snapshot, unsaved documents included. Nothing is saved
    /// and no document is touched.
    pub fn diff_workspace(
        &self,
        repo: &Mutex<Repository>,
        request: &SnapshotRequest,
        control: &Control,
        from: Option<ObjectId>,
        options: &crate::diff::DiffOptions,
    ) -> Result<(Snapshot, crate::diff::DiffResult)> {
        use crate::diff::{diff_trees, DiffEnd, DiffResult, StoreContent, Trees, WorkspaceContent};
        if request.persist {
            return Err(LgError::InvalidFormat(
                "a diff is taken from an ephemeral snapshot".into(),
            ));
        }
        let mut state = self.state.lock().unwrap();
        let snapshot = self.snapshot_in(&mut state, repo, request, control)?;
        let repo = repo.lock().unwrap();
        let base = crate::diff::base_commit(&repo, from)?;
        let effective: BTreeMap<FolderId, ObjectId> = self
            .folders
            .iter()
            .filter_map(|folder| {
                snapshot
                    .folders
                    .iter()
                    .find(|f| f.folder_id == folder.folder_id.as_str())
                    .map(|f| (folder.folder_id.clone(), f.effective_tree.0))
            })
            .collect();
        let to = DiffEnd {
            kind: "workspace",
            commit: None,
            root: Some(snapshot.effective_root),
        };
        let from_end = DiffEnd {
            kind: if base.is_some() { "commit" } else { "empty" },
            commit: base.as_ref().map(|(id, _, _)| ObjectIdText(*id)),
            root: base.as_ref().map(|(_, root, _)| ObjectIdText(*root)),
        };
        if base.as_ref().map(|(_, root, _)| *root) == Some(snapshot.effective_root.0) {
            return Ok((
                snapshot,
                DiffResult {
                    from: from_end,
                    to,
                    identical: true,
                    entries: Vec::new(),
                    counts: Default::default(),
                },
            ));
        }
        let memory = MemoryTrees(&state.trees);
        let trees = Trees {
            repo: Some(&repo),
            extra: Some(&memory),
        };
        let overlays = request
            .overlays
            .iter()
            .map(|o| (hash_object(ObjectKind::Blob, &o.bytes), o.bytes.clone()))
            .collect();
        let workspace = WorkspaceContent {
            repo: &repo,
            overlays,
            folders: self
                .folders
                .iter()
                .map(|f| (f.folder_id.clone(), f.path.clone()))
                .collect(),
        };
        let history = StoreContent { repo: &repo };
        let old = base.map(|(_, _, folders)| folders).unwrap_or_default();
        let (entries, counts) =
            diff_trees(&trees, &old, &effective, &history, &workspace, options)?;
        Ok((
            snapshot,
            DiffResult {
                from: from_end,
                to,
                identical: false,
                entries,
                counts,
            },
        ))
    }

    /// Plans restoring `commit` (all of it, or `scope`: a path, in a folder or the only one)
    /// over the workspace as a fresh snapshot sees it. With `request.persist` the snapshot is
    /// kept in the store (what a restore checkpoints before it changes anything).
    pub fn plan_restore(
        &self,
        repo: &Mutex<Repository>,
        request: &SnapshotRequest,
        control: &Control,
        commit: ObjectId,
        scope: Option<(Option<FolderId>, String)>,
        policy: crate::restore::RestorePolicy,
    ) -> Result<(Snapshot, crate::restore::RestorePlan)> {
        let mut state = self.state.lock().unwrap();
        {
            let repo = repo.lock().unwrap();
            crate::history::require_commit(&repo, &commit)?;
        }
        let snapshot = self.snapshot_in(&mut state, repo, request, control)?;
        let repo = repo.lock().unwrap();
        let target_root = repo.read_commit(&commit)?.root;
        let target_folders = repo.read_root(&target_root)?.folders;
        let scope = match scope {
            Some((folder, path)) => {
                let folder = match folder {
                    Some(folder) => folder,
                    None if self.folders.len() == 1 => self.folders[0].folder_id.clone(),
                    None => {
                        return Err(LgError::InvalidName(
                            "name the folder of a multi-folder workspace".into(),
                        ))
                    }
                };
                for name in path.split('/').filter(|n| !n.is_empty()) {
                    EntryName::new(name)?;
                }
                Some((folder, path.trim_matches('/').to_string()))
            }
            None => None,
        };
        let memory = MemoryTrees(&state.trees);
        let trees = crate::diff::Trees {
            repo: Some(&repo),
            extra: Some(&memory),
        };
        let plan = crate::restore::plan(
            &trees,
            &repo,
            &self.folders,
            &snapshot,
            commit,
            target_root,
            &target_folders,
            scope.as_ref().map(|(folder, path)| (folder, path.as_str())),
            policy,
        )?;
        Ok((snapshot, plan))
    }

    /// After a restore: a Full snapshot of the disk (authoritative; unsaved documents are not
    /// part of what a restore writes) compared with what `plan` aimed for.
    pub fn verify_restore(
        &self,
        repo: &Mutex<Repository>,
        control: &Control,
        plan: &crate::restore::RestorePlan,
    ) -> Result<(Snapshot, crate::restore::Verification)> {
        let mut state = self.state.lock().unwrap();
        let request = SnapshotRequest {
            mode: RequestedMode::Full,
            ..Default::default()
        };
        let snapshot = self.snapshot_in(&mut state, repo, &request, control)?;
        let repo = repo.lock().unwrap();
        let target_folders = repo.read_root(&plan.target_root.0)?.folders;
        let memory = MemoryTrees(&state.trees);
        let trees = crate::diff::Trees {
            repo: Some(&repo),
            extra: Some(&memory),
        };
        let folder = plan.scope_folder.clone();
        let folder = folder.map(|f| FolderId::new(&f)).transpose()?;
        let scope = match (&folder, &plan.scope) {
            (Some(folder), Some(path)) => Some((folder, path.as_str())),
            _ => None,
        };
        let verification = crate::restore::verify(&trees, &snapshot, &target_folders, scope)?;
        Ok((snapshot, verification))
    }

    /// Plans switching branches (or detaching HEAD) from the workspace as a fresh Full,
    /// persisted snapshot (with the unsaved documents) sees it. See `switch.rs`.
    pub fn plan_switch(
        &self,
        repo: &Mutex<Repository>,
        request: &SnapshotRequest,
        control: &Control,
        target: &crate::switch::SwitchTarget,
    ) -> Result<(Snapshot, crate::switch::SwitchPlan)> {
        let mut state = self.state.lock().unwrap();
        let mut request = request.clone();
        request.mode = RequestedMode::Full;
        request.persist = true;
        request.allow_incremental_persist = false;
        let snapshot = self.snapshot_in(&mut state, repo, &request, control)?;
        let mut repo = repo.lock().unwrap();
        let memory = MemoryTrees(&state.trees);
        let plan = crate::switch::plan(&memory, &mut repo, &self.folders, &snapshot, target)?;
        Ok((snapshot, plan))
    }

    /// A copy of the trees the last snapshot produced (staging reads them without the store).
    pub(crate) fn memory_trees(&self) -> HashMap<ObjectId, Tree> {
        self.state.lock().unwrap().trees.clone()
    }

    /// Where the workspace's folders are, for the layer that carries out a restore.
    pub fn folder_root(&self, folder: &str) -> Option<&Path> {
        self.folders
            .iter()
            .find(|f| f.folder_id.as_str() == folder)
            .map(|f| f.path.as_path())
    }

    fn snapshot_in(
        &self,
        state: &mut EngineState,
        repo: &Mutex<Repository>,
        request: &SnapshotRequest,
        control: &Control,
    ) -> Result<Snapshot> {
        let started = Instant::now();
        if control.cancel.load(Ordering::Relaxed) {
            return Err(LgError::Cancelled);
        }
        let (writer, cache_dir, workspace, head) = {
            let repo = repo.lock().unwrap();
            (
                matches!(repo.mode(), Mode::Writer),
                repo.cache_dir(),
                repo.meta().workspace.clone(),
                head_trees(&repo),
            )
        };
        if request.persist && !writer {
            return Err(LgError::ReadOnly);
        }
        if !state.cache_loaded {
            for folder in &self.folders {
                let key = folder.folder_id.as_str();
                state
                    .cache
                    .insert(key.to_string(), load_cache(&cache_dir, key));
            }
            state.cache_loaded = true;
        }
        let (mode, reason, dirty, generation) = self.decide(state, request);
        let plan = Plan {
            mode,
            reason,
            dirty,
            generation,
            head,
            workspace,
            started,
        };
        let result = if request.persist {
            let mut guard = repo.lock().unwrap();
            let txn = Mutex::new(guard.begin_write()?);
            let outcome = self.run(state, Source::Txn(&txn), Some(&txn), request, control, plan);
            let txn = txn.into_inner().unwrap();
            match outcome {
                Ok(snapshot) => txn.commit().map(|()| snapshot),
                Err(error) => {
                    txn.abandon();
                    Err(error)
                }
            }
        } else {
            self.run(state, Source::Shared(repo), None, request, control, plan)
        };
        match result {
            Ok(snapshot) => {
                if writer && snapshot.mode != ScanMode::Incremental {
                    for folder in &self.folders {
                        let key = folder.folder_id.as_str();
                        if let Some(cache) = state.cache.get(key) {
                            // Disposable: failing to keep it only makes the next open slower.
                            let _ = save_cache(&cache_dir, key, cache);
                        }
                    }
                }
                Ok(snapshot)
            }
            Err(error) => {
                // The changes this scan took from the watcher are lost with it: start again.
                self.watch.lock().unwrap().uncertain = true;
                Err(error)
            }
        }
    }

    fn decide(
        &self,
        state: &mut EngineState,
        request: &SnapshotRequest,
    ) -> (
        ScanMode,
        Option<FullReason>,
        HashMap<String, DirtyNode>,
        Option<u64>,
    ) {
        let mut watch = self.watch.lock().unwrap();
        let dirty = std::mem::take(&mut watch.dirty);
        let healthy = if watch.healthy {
            watch.generation
        } else {
            None
        };
        let reason = match request.mode {
            RequestedMode::Full | RequestedMode::Verify => Some(FullReason::Requested),
            RequestedMode::Auto if request.persist && !request.allow_incremental_persist => {
                Some(FullReason::Persisted)
            }
            RequestedMode::Auto => {
                if self
                    .folders
                    .iter()
                    .any(|f| !state.last_disk.contains_key(f.folder_id.as_str()))
                {
                    Some(FullReason::FirstScan)
                } else if watch.uncertain || healthy.is_none() {
                    Some(FullReason::WatcherUnavailable)
                } else if healthy != state.scan_generation {
                    Some(FullReason::WatcherChanged)
                } else if state.since_full + 1 >= FULL_EVERY_SNAPSHOTS
                    || state.last_full.is_none_or(|at| at.elapsed() >= FULL_EVERY)
                {
                    Some(FullReason::Periodic)
                } else if dirty.values().any(|node| node.touches_name(YAVINIGNORE)) {
                    Some(FullReason::IgnoreRulesChanged)
                } else {
                    None
                }
            }
        };
        // A scan covers everything up to its start; what was missed before no longer is.
        if reason.is_some() {
            watch.uncertain = false;
        }
        state.scan_generation = healthy;
        let mode = match (reason, request.mode) {
            (None, _) => ScanMode::Incremental,
            (Some(_), RequestedMode::Verify) => ScanMode::Verify,
            (Some(_), _) => ScanMode::Full,
        };
        (mode, reason, dirty, healthy)
    }

    fn run<'r>(
        &self,
        state: &mut EngineState,
        source: Source<'_, 'r>,
        sink: Option<&Mutex<WriteTxn<'r>>>,
        request: &SnapshotRequest,
        control: &Control,
        plan: Plan,
    ) -> Result<Snapshot> {
        let counters = Counters::default();
        let total_estimate = state.last_file_count;
        let report = |phase: &'static str| {
            (control.progress)(&Progress {
                phase,
                files: counters.files.load(Ordering::Relaxed),
                directories: counters.directories.load(Ordering::Relaxed),
                bytes_hashed: counters.bytes_hashed.load(Ordering::Relaxed),
                total_estimate,
            })
        };
        let last_report = Mutex::new(Instant::now() - PROGRESS_INTERVAL);
        let tick = || {
            if let Ok(mut last) = last_report.try_lock() {
                if last.elapsed() >= PROGRESS_INTERVAL {
                    *last = Instant::now();
                    report("scanning");
                }
            }
        };
        report("scanning");
        let started_ns = now_ns();
        let incremental = plan.mode == ScanMode::Incremental;

        let mut new_trees: HashMap<ObjectId, Tree> = HashMap::new();
        let mut disk: BTreeMap<FolderId, ObjectId> = BTreeMap::new();
        let mut problems = Vec::new();
        let mut caches: Vec<(String, FolderCache)> = Vec::new();
        {
            let lookup = Lookup {
                trees: &state.trees,
                source,
            };
            let no_cache = FolderCache::new();
            let clean = DirtyNode::default();
            for folder in &self.folders {
                let key = folder.folder_id.as_str();
                let node = plan.dirty.get(key);
                if incremental && node.is_none_or(DirtyNode::is_empty) {
                    if let Some(id) = state.last_disk.get(key) {
                        // Persisting, it is reused only if it is already stored.
                        let stored = sink.is_none_or(|sink| sink.lock().unwrap().has(id));
                        if stored {
                            disk.insert(folder.folder_id.clone(), *id);
                            continue;
                        }
                    }
                }
                let base = state
                    .last_disk
                    .get(key)
                    .copied()
                    .or_else(|| plan.head.get(&folder.folder_id).copied());
                let walk = Walk {
                    folder_id: key,
                    max_blob: self.max_blob,
                    verify: plan.mode == ScanMode::Verify,
                    cancel: control.cancel,
                    counters: &counters,
                    tick: &tick,
                    cache: state.cache.get(key).unwrap_or(&no_cache),
                    started_ns,
                    lookup: &lookup,
                    sink,
                    cache_out: Mutex::default(),
                    trees: Mutex::default(),
                    problems: Mutex::default(),
                };
                let tree = walk.scan_root(
                    &folder.path,
                    base,
                    incremental.then(|| node.unwrap_or(&clean)),
                )?;
                new_trees.extend(walk.trees.into_inner().unwrap());
                problems.extend(walk.problems.into_inner().unwrap());
                caches.push((key.to_string(), walk.cache_out.into_inner().unwrap()));
                disk.insert(folder.folder_id.clone(), tree);
            }

            // The unsaved documents, on top of the disk trees.
            report("overlays");
            let mut placed: BTreeMap<(usize, Vec<String>), &OverlayInput> = BTreeMap::new();
            for overlay in &request.overlays {
                match self.place(overlay) {
                    Ok((folder, names)) => {
                        let slot = placed.entry((folder, names)).or_insert(overlay);
                        if overlay.version > slot.version {
                            *slot = overlay;
                        }
                    }
                    Err(reason) => problems.push(Problem::OverlayRefused {
                        path: overlay.path.clone(),
                        reason,
                    }),
                }
            }
            let mut overlays = Vec::new();
            let mut per_folder: BTreeMap<usize, Vec<(Vec<String>, ObjectId, u64)>> =
                BTreeMap::new();
            for ((folder, names), overlay) in &placed {
                let id = hash_object(ObjectKind::Blob, &overlay.bytes);
                let size = overlay.bytes.len() as u64;
                if let Some(sink) = sink {
                    if size <= self.max_blob {
                        sink.lock().unwrap().put_blob(&overlay.bytes)?;
                    }
                }
                overlays.push(OverlayRecord {
                    folder_id: self.folders[*folder].folder_id.as_str().into(),
                    path: names.join("/"),
                    blob: ObjectIdText(id),
                    size,
                    encoding: overlay.encoding.clone(),
                    line_ending: overlay.line_ending.clone(),
                    version: overlay.version,
                });
                per_folder
                    .entry(*folder)
                    .or_default()
                    .push((names.clone(), id, size));
            }
            let mut effective = disk.clone();
            let mut overlay_trees = HashMap::new();
            for (folder, items) in per_folder {
                let folder_id = &self.folders[folder].folder_id;
                let base_id = disk[folder_id];
                let base = new_trees
                    .get(&base_id)
                    .cloned()
                    .or_else(|| lookup.tree(&base_id));
                let refs: Vec<(&[String], ObjectId, u64)> = items
                    .iter()
                    .map(|(names, id, size)| (names.as_slice(), *id, *size))
                    .collect();
                let tree = self.overlay_dir(
                    base,
                    &refs,
                    &|id| new_trees.get(id).cloned().or_else(|| lookup.tree(id)),
                    sink,
                    &mut overlay_trees,
                )?;
                effective.insert(folder_id.clone(), tree);
            }
            new_trees.extend(overlay_trees);

            let mut untitled = Vec::new();
            for document in &request.untitled {
                let id = hash_object(ObjectKind::Blob, &document.bytes);
                if let Some(sink) = sink {
                    sink.lock().unwrap().put_blob(&document.bytes)?;
                }
                untitled.push(UntitledRecord {
                    id: document.id.clone(),
                    blob: ObjectIdText(id),
                    size: document.bytes.len() as u64,
                    encoding: document.encoding.clone(),
                    line_ending: document.line_ending.clone(),
                    version: document.version,
                });
            }
            untitled.sort_by(|a, b| a.id.cmp(&b.id));
            let overlay_set = if overlays.is_empty() && untitled.is_empty() {
                None
            } else {
                let bytes = overlay_set_bytes(&overlays, &untitled);
                if let Some(sink) = sink {
                    sink.lock().unwrap().put_blob(&bytes)?;
                }
                Some(ObjectIdText(hash_object(ObjectKind::Blob, &bytes)))
            };

            let disk_root = Root {
                folders: disk.clone(),
            };
            let effective_root = Root {
                folders: effective.clone(),
            };
            if let Some(sink) = sink {
                report("writing");
                let mut txn = sink.lock().unwrap();
                txn.put_root(&disk_root)?;
                txn.put_root(&effective_root)?;
            }
            if control.cancel.load(Ordering::Relaxed) {
                return Err(LgError::Cancelled);
            }

            state.sequence += 1;
            let snapshot = Snapshot {
                sequence: state.sequence,
                mode: plan.mode,
                full_reason: plan.reason,
                taken_ms: ide_workspace::durable::now_millis() as u64,
                duration_ms: plan.started.elapsed().as_millis() as u64,
                workspace: plan.workspace,
                watcher_generation: if incremental { plan.generation } else { None },
                disk_root: ObjectIdText(disk_root.id()),
                effective_root: ObjectIdText(effective_root.id()),
                folders: self
                    .folders
                    .iter()
                    .map(|folder| FolderSnapshot {
                        folder_id: folder.folder_id.as_str().into(),
                        disk_tree: ObjectIdText(disk[&folder.folder_id]),
                        effective_tree: ObjectIdText(effective[&folder.folder_id]),
                    })
                    .collect(),
                overlays,
                untitled,
                overlay_set,
                problems,
                stats: ScanStats {
                    files: counters.files.load(Ordering::Relaxed),
                    directories: counters.directories.load(Ordering::Relaxed),
                    reused_directories: counters.reused_directories.load(Ordering::Relaxed),
                    files_hashed: counters.files_hashed.load(Ordering::Relaxed),
                    bytes_hashed: counters.bytes_hashed.load(Ordering::Relaxed),
                    cache_hits: counters.cache_hits.load(Ordering::Relaxed),
                },
                persisted: sink.is_some(),
            };

            // Keep exactly the trees the next scan and status can need.
            let mut all = std::mem::take(&mut state.trees);
            all.extend(new_trees);
            let mut kept = HashMap::new();
            let mut stack: Vec<ObjectId> =
                disk.values().chain(effective.values()).copied().collect();
            while let Some(id) = stack.pop() {
                if kept.contains_key(&id) {
                    continue;
                }
                if let Some(tree) = all.remove(&id) {
                    for entry in tree.entries() {
                        if entry.kind == EntryKind::Directory {
                            stack.push(entry.id);
                        }
                    }
                    kept.insert(id, tree);
                }
            }
            state.trees = kept;
            if !incremental {
                state.last_file_count = Some(snapshot.stats.files);
            }
            for (key, cache) in caches {
                if incremental {
                    state.cache.entry(key).or_default().extend(cache);
                } else {
                    state.cache.insert(key, cache);
                }
            }
            state.last_disk = disk
                .into_iter()
                .map(|(folder, id)| (folder.as_str().to_string(), id))
                .collect();
            if incremental {
                state.since_full += 1;
            } else {
                state.since_full = 0;
                state.last_full = Some(Instant::now());
            }
            Ok(snapshot)
        }
    }

    /// Which folder an unsaved document belongs to, and its path there -- refused when it is
    /// outside the workspace or somewhere a snapshot leaves out.
    fn place(&self, overlay: &OverlayInput) -> std::result::Result<(usize, Vec<String>), String> {
        let (folder, names) = self
            .folders
            .iter()
            .enumerate()
            .find_map(|(at, folder)| relative_to(folder, &overlay.path).map(|names| (at, names)))
            .ok_or("outside the workspace")?;
        let root = &self.folders[folder].path;
        let mut rules = Rules::for_folder(root);
        let mut dir = root.clone();
        for (at, name) in names.iter().enumerate() {
            if is_git(name) {
                return Err("inside .git".into());
            }
            if let Ok(text) = std::fs::read(dir.join(YAVINIGNORE)) {
                let (file, _) = IgnoreFile::parse(&dir, &String::from_utf8_lossy(&text));
                rules = rules.with(file);
            }
            let path = dir.join(name);
            if rules.excludes(&path, name, at + 1 < names.len()) {
                return Err("left out by the exclusion rules".into());
            }
            dir = path;
        }
        Ok((folder, names))
    }

    /// `base` with the files at `items` (paths relative to it) set to the given blobs.
    #[allow(clippy::type_complexity)]
    fn overlay_dir(
        &self,
        base: Option<Tree>,
        items: &[(&[String], ObjectId, u64)],
        lookup: &dyn Fn(&ObjectId) -> Option<Tree>,
        sink: Option<&Mutex<WriteTxn<'_>>>,
        out: &mut HashMap<ObjectId, Tree>,
    ) -> Result<ObjectId> {
        let mut entries: Vec<TreeEntry> =
            base.map(|tree| tree.entries().to_vec()).unwrap_or_default();
        let mut groups: BTreeMap<String, (String, Vec<(&[String], ObjectId, u64)>)> =
            BTreeMap::new();
        for (names, id, size) in items {
            let (first, rest) = names.split_first().expect("a path has a name");
            groups
                .entry(name_key(first))
                .or_insert_with(|| (first.clone(), Vec::new()))
                .1
                .push((rest, *id, *size));
        }
        for (key, (spelled, group)) in groups {
            let existing = entries
                .iter()
                .position(|entry| name_key(entry.name.as_str()) == key);
            let name = match existing {
                Some(at) => entries[at].name.clone(),
                None => EntryName::new(&spelled)?,
            };
            let deeper: Vec<(&[String], ObjectId, u64)> = group
                .iter()
                .filter(|(rest, _, _)| !rest.is_empty())
                .copied()
                .collect();
            let entry = if deeper.is_empty() {
                let (_, id, size) = group[0];
                let executable = existing.is_some_and(|at| {
                    matches!(
                        entries[at].kind,
                        EntryKind::File {
                            executable: true,
                            ..
                        }
                    )
                });
                TreeEntry {
                    name,
                    kind: EntryKind::File {
                        executable,
                        stored: if size > self.max_blob {
                            Stored::No { size }
                        } else {
                            Stored::Yes
                        },
                    },
                    id,
                }
            } else {
                let child_base = existing
                    .filter(|at| entries[*at].kind == EntryKind::Directory)
                    .and_then(|at| lookup(&entries[at].id));
                let id = self.overlay_dir(child_base, &deeper, lookup, sink, out)?;
                TreeEntry {
                    name,
                    kind: EntryKind::Directory,
                    id,
                }
            };
            match existing {
                Some(at) => entries[at] = entry,
                None => entries.push(entry),
            }
        }
        let tree = Tree::new(entries)?;
        let id = tree.id();
        if let Some(sink) = sink {
            sink.lock().unwrap().put_tree(&tree)?;
        }
        out.insert(id, tree);
        Ok(id)
    }
}

struct Plan {
    mode: ScanMode,
    reason: Option<FullReason>,
    dirty: HashMap<String, DirtyNode>,
    generation: Option<u64>,
    head: BTreeMap<FolderId, ObjectId>,
    workspace: String,
    started: Instant,
}

/// The overlay set as one canonical text: a header, then one line per document, sorted.
///
/// ```text
/// ylg-overlays 1
/// doc <folderId> <path> <blob> <encoding> <lineEnding> <version>
/// untitled <id> <blob> <encoding> <lineEnding> <version>
/// ```
///
/// Fields are `%XX`-escaped as commit headers are, so the same overlays always give the same id.
pub fn overlay_set_bytes(overlays: &[OverlayRecord], untitled: &[UntitledRecord]) -> Vec<u8> {
    use crate::object::escape;
    let mut docs: Vec<String> = overlays
        .iter()
        .map(|o| {
            format!(
                "doc {} {} {} {} {} {}",
                escape(&o.folder_id),
                escape(&o.path),
                o.blob.0,
                escape(&o.encoding),
                escape(&o.line_ending),
                o.version
            )
        })
        .collect();
    docs.sort();
    let mut others: Vec<String> = untitled
        .iter()
        .map(|u| {
            format!(
                "untitled {} {} {} {} {}",
                escape(&u.id),
                u.blob.0,
                escape(&u.encoding),
                escape(&u.line_ending),
                u.version
            )
        })
        .collect();
    others.sort();
    let mut text = String::from("ylg-overlays 1\n");
    for line in docs.into_iter().chain(others) {
        text.push_str(&line);
        text.push('\n');
    }
    text.into_bytes()
}

// --- The scan cache on disk -------------------------------------------------------------------
//
// `cache/scan-<folderId>.bin`: `YLSCAN01`, the folder id, the entries, and the SHA-256 of all
// of it. Disposable: anything wrong with it and it is ignored (and replaced by the next Full).

const CACHE_MAGIC: &[u8; 8] = b"YLSCAN01";

fn cache_file(dir: &Path, folder: &str) -> PathBuf {
    dir.join(format!("scan-{folder}.bin"))
}

pub(crate) fn save_cache(dir: &Path, folder: &str, cache: &FolderCache) -> Result<()> {
    let mut bytes = Vec::with_capacity(64 + cache.len() * 96);
    bytes.extend_from_slice(CACHE_MAGIC);
    bytes.extend_from_slice(&(folder.len() as u32).to_le_bytes());
    bytes.extend_from_slice(folder.as_bytes());
    bytes.extend_from_slice(&(cache.len() as u64).to_le_bytes());
    for (path, entry) in cache {
        bytes.extend_from_slice(&(path.len() as u32).to_le_bytes());
        bytes.extend_from_slice(path.as_bytes());
        bytes.extend_from_slice(&entry.identity.len.to_le_bytes());
        bytes.extend_from_slice(&entry.identity.modified_ns.to_le_bytes());
        bytes.extend_from_slice(&entry.identity.extra.to_le_bytes());
        bytes.extend_from_slice(entry.id.as_bytes());
        bytes.extend_from_slice(&entry.recorded_ns.to_le_bytes());
    }
    let digest = Sha256::digest(&bytes);
    bytes.extend_from_slice(&digest);
    std::fs::create_dir_all(dir)?;
    ide_workspace::durable::write_durably(&cache_file(dir, folder), &bytes).map_err(LgError::Io)
}

pub(crate) fn load_cache(dir: &Path, folder: &str) -> FolderCache {
    std::fs::read(cache_file(dir, folder))
        .ok()
        .and_then(|bytes| parse_cache(&bytes, folder))
        .unwrap_or_default()
}

fn parse_cache(bytes: &[u8], folder: &str) -> Option<FolderCache> {
    let (body, digest) = bytes.split_at(bytes.len().checked_sub(32)?);
    if Sha256::digest(body).as_slice() != digest {
        return None;
    }
    let mut at = 0usize;
    let mut take = |n: usize| -> Option<&[u8]> {
        let slice = body.get(at..at + n)?;
        at += n;
        Some(slice)
    };
    if take(8)? != CACHE_MAGIC {
        return None;
    }
    let len = u32::from_le_bytes(take(4)?.try_into().ok()?) as usize;
    if take(len)? != folder.as_bytes() {
        return None;
    }
    let count = u64::from_le_bytes(take(8)?.try_into().ok()?);
    let mut cache = FolderCache::with_capacity(count.min(1 << 24) as usize);
    for _ in 0..count {
        let len = u32::from_le_bytes(take(4)?.try_into().ok()?) as usize;
        let path = std::str::from_utf8(take(len)?).ok()?.to_string();
        let file_len = u64::from_le_bytes(take(8)?.try_into().ok()?);
        let modified_ns = i128::from_le_bytes(take(16)?.try_into().ok()?);
        let extra = u64::from_le_bytes(take(8)?.try_into().ok()?);
        let id = ObjectId::from_bytes(take(32)?).ok()?;
        let recorded_ns = i128::from_le_bytes(take(16)?.try_into().ok()?);
        cache.insert(
            path,
            CacheEntry {
                identity: FileIdentity {
                    len: file_len,
                    modified_ns,
                    extra,
                },
                id,
                recorded_ns,
            },
        );
    }
    Some(cache)
}
