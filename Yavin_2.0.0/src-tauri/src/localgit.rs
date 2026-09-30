//! Local Git for the window (the store itself is `crates/ide-localgit`).
//!
//! The renderer never names a path here. It asks to open Local Git for the workspace it shows;
//! the store is opened for the native side's own workspace root (the renderer's folders must be
//! the same workspace, or the request is refused), and what comes back is a handle -- a random
//! token -- through which everything else is asked, by object id. Opening another workspace
//! revokes every handle of the one left, so late requests from it are refused. Handles of one
//! workspace share its one store (and its one writer lock); the store closes, releasing the
//! lock, when its last handle does.
//!
//! Snapshots and status (LG-02) run as jobs of a handle: a newer status supersedes the one in
//! flight, `localgit_cancel` stops one, and a handle that is closed or revoked cancels all of
//! its jobs -- whose results are then refused (`HandleClosed`), never delivered. Unsaved
//! documents reach a snapshot through the handle's overlay pool (`localgit_put_overlays`):
//! the renderer sends each document version once, and a snapshot names the versions it uses.
//! The workspace watcher's batches are passed to every open store natively (`observe`), so
//! incremental snapshots need no round trip through the renderer.
//!
//! Errors are `"<Code>: <message>"`, the code being `LgError::code()` or `NotInWorkspace`,
//! `HandleClosed`, `Unavailable`, `OverlayMissing`.

use crate::{with_workspace, Workspace};
use ide_localgit::{
    resource_id_of, Control, EntryKind, Finding, FolderId, FolderRoot, Head, LgError, LinkKind,
    Mode, ObjectId, OpenOptions, OverlayInput, Progress, ReadOnlyReason, ReflogRecord, Repository,
    RequestedMode, Snapshot, SnapshotEngine, SnapshotRequest, Status, Stored, UntitledInput,
    WatchedChange, WorkspaceSpec,
};
use ide_workspace::resource_events::{WatchOutput, WatcherState};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct LocalGit {
    base: OnceLock<PathBuf>,
    inner: Mutex<Inner>,
    /// The workspace watcher's last status (generation, healthy, root), for stores opened later.
    watcher: Mutex<Option<(u64, bool, String)>>,
}

#[derive(Default)]
struct Inner {
    stores: HashMap<String, Store>,
    handles: HashMap<String, Handle>,
}

/// One workspace's open store and its snapshot state.
#[derive(Clone)]
struct Store {
    repo: Arc<Mutex<Repository>>,
    engine: Arc<SnapshotEngine>,
    /// Held by whatever changes Local Git state or the workspace (a checkpoint, a commit, a
    /// restore): one at a time, and a second is refused (`Busy`), never queued behind.
    mutating: Arc<Mutex<()>>,
}

/// An unsaved document's bytes as the renderer sent them, kept until a snapshot no longer
/// names it.
#[derive(Clone)]
struct Pooled {
    path: String,
    bytes: Arc<Vec<u8>>,
    encoding: String,
    line_ending: String,
    version: u64,
}

struct Handle {
    key: String,
    workspace_id: String,
    /// Named documents by the renderer's document key; untitled ones by document id.
    overlays: HashMap<String, Pooled>,
    untitled: HashMap<String, Pooled>,
    /// Running jobs' cancellation flags, by job id.
    jobs: HashMap<String, Arc<AtomicBool>>,
    /// The status job in flight: a newer one cancels it.
    status_job: Option<String>,
}

impl Handle {
    fn cancel_all(&self) {
        for flag in self.jobs.values() {
            flag.store(true, Ordering::SeqCst);
        }
    }
}

fn fail(error: LgError) -> String {
    format!("{}: {error}", error.code())
}

impl LocalGit {
    /// Where every workspace's store lives: `<app local data>/local-git`.
    pub fn set_base(&self, base: PathBuf) {
        let _ = self.base.set(base);
    }

    /// The window now shows another workspace: every handle of any other is revoked, and a
    /// store left without handles is closed (its writer lock released).
    pub fn revoke_except(&self, workspace_id: Option<&str>) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.handles.retain(|_, handle| {
                let keep = Some(handle.workspace_id.as_str()) == workspace_id;
                if !keep {
                    // Its snapshots stop, and what they would have answered is refused.
                    handle.cancel_all();
                }
                keep
            });
            let live: Vec<String> = inner.handles.values().map(|h| h.key.clone()).collect();
            inner.stores.retain(|key, _| live.contains(key));
        }
    }

    /// The workspace watcher's output, for every open store's snapshot engine. Runs on the
    /// watcher's thread: it only records what changed, and never waits for a snapshot.
    pub fn observe(&self, output: &WatchOutput) {
        let engines: Vec<Arc<SnapshotEngine>> = match self.inner.lock() {
            Ok(inner) => inner.stores.values().map(|s| s.engine.clone()).collect(),
            Err(_) => return,
        };
        match output {
            WatchOutput::Status(status) => {
                let healthy = status.state == WatcherState::Watching;
                if let Ok(mut last) = self.watcher.lock() {
                    *last = Some((status.generation, healthy, status.root.clone()));
                }
                for engine in engines {
                    if watches(&engine, &status.root) {
                        engine.watcher_status(status.generation, healthy);
                    }
                }
            }
            WatchOutput::Changes(batch) => {
                let changes: Vec<WatchedChange> = batch
                    .changes
                    .iter()
                    .map(|change| WatchedChange {
                        path: change.path.clone(),
                        from: change.from.clone(),
                    })
                    .collect();
                for engine in engines {
                    engine.watcher_changes(batch.generation, &batch.root, &changes, &batch.rescan);
                }
            }
        }
    }

    fn handle_store(&self, handle: &str) -> Result<Store, String> {
        let inner = self.inner.lock().map_err(|e| e.to_string())?;
        let key = &inner
            .handles
            .get(handle)
            .ok_or("HandleClosed: this Local Git handle is closed (its workspace was left)")?
            .key;
        inner
            .stores
            .get(key)
            .cloned()
            .ok_or_else(|| "HandleClosed: the store is closed".to_string())
    }

    fn with<T>(
        &self,
        handle: &str,
        action: impl FnOnce(&mut Repository) -> Result<T, LgError>,
    ) -> Result<T, String> {
        let store = self.handle_store(handle)?;
        let mut repo = store.repo.lock().map_err(|e| e.to_string())?;
        action(&mut repo).map_err(fail)
    }

    /// Registers a job of `handle` and returns its cancellation flag. A status job cancels
    /// the status job it replaces.
    fn start_job(&self, handle: &str, job: &str, status: bool) -> Result<Arc<AtomicBool>, String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        let entry = inner.handles.get_mut(handle).ok_or(CLOSED)?;
        let flag = Arc::new(AtomicBool::new(false));
        if status {
            if let Some(previous) = entry.status_job.replace(job.to_string()) {
                if let Some(flag) = entry.jobs.get(&previous) {
                    flag.store(true, Ordering::SeqCst);
                }
            }
        }
        entry.jobs.insert(job.to_string(), flag.clone());
        Ok(flag)
    }

    /// Ends a job: its result is delivered only if its handle is still open and it was not
    /// cancelled (a revoked handle's late result never reaches the next workspace).
    fn finish_job<T>(
        &self,
        handle: &str,
        job: &str,
        result: Result<T, LgError>,
    ) -> Result<T, String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        let Some(entry) = inner.handles.get_mut(handle) else {
            return Err(CLOSED.into());
        };
        let cancelled = entry
            .jobs
            .remove(job)
            .is_some_and(|flag| flag.load(Ordering::SeqCst));
        if entry.status_job.as_deref() == Some(job) {
            entry.status_job = None;
        }
        if cancelled {
            return Err(fail(LgError::Cancelled));
        }
        result.map_err(fail)
    }
}

const CLOSED: &str = "HandleClosed: this Local Git handle is closed (its workspace was left)";

impl LocalGit {
    /// Ends a job whose work may have changed the disk: a cancellation that came too late does
    /// not turn its result into "cancelled" -- only a closed handle stops the answer.
    fn finish_changed<T>(
        &self,
        handle: &str,
        job: &str,
        result: Result<T, String>,
    ) -> Result<T, String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        let Some(entry) = inner.handles.get_mut(handle) else {
            return Err(CLOSED.into());
        };
        entry.jobs.remove(job);
        result
    }
}

/// Whether the window's workspace (the native side's) is still `workspace_id`.
pub(crate) fn workspace_is_open(workspace: &Workspace, workspace_id: &str) -> bool {
    with_workspace(workspace, |manager| Ok(manager.root().to_path_buf()))
        .ok()
        .and_then(|root| WorkspaceSpec::from_paths(&[root]).ok())
        .is_some_and(|now| now.workspace_id == workspace_id)
}

/// Takes the store's mutation lock, or says another change is under way.
fn exclusive(store: &Store) -> Result<std::sync::MutexGuard<'_, ()>, String> {
    store.mutating.try_lock().map_err(|_| {
        "Busy: another Local Git operation is changing this workspace; try again when it ends"
            .to_string()
    })
}

/// Whether `engine` belongs to the folder the watcher reports on.
fn watches(engine: &SnapshotEngine, root: &str) -> bool {
    resource_id_of(root).is_ok_and(|id| engine.folders().iter().any(|f| f.resource_id == id))
}

static HANDLES: AtomicU64 = AtomicU64::new(0);

fn new_handle() -> String {
    // Unguessable enough for a token that is only ever valid inside this process.
    let seed = format!(
        "{}\0{}\0{}\0{:?}",
        std::process::id(),
        HANDLES.fetch_add(1, Ordering::Relaxed),
        ide_workspace::durable::now_millis(),
        std::time::Instant::now()
    );
    let id = ide_localgit::hash_object(ide_localgit::ObjectKind::Blob, seed.as_bytes());
    format!("lg-{}", &id.to_hex()[..32])
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderInfo {
    folder_id: String,
    path: String,
}

/// What the renderer may know about a store: never its location on disk.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    handle: String,
    workspace: String,
    /// `writer`, or `readOnly` (another window writes this workspace's history).
    mode: &'static str,
    read_only_reason: Option<&'static str>,
    format: u64,
    revision: u64,
    head: RefsHead,
    head_commit: Option<String>,
    ref_count: usize,
    object_count: usize,
    segment_count: usize,
    storage_bytes: u64,
    folders: Vec<FolderInfo>,
    findings: Vec<Finding>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefsHead {
    symbolic: Option<String>,
    detached: Option<String>,
}

fn head_of(head: &Head) -> RefsHead {
    match head {
        Head::Symbolic(name) => RefsHead {
            symbolic: Some(name.as_str().into()),
            detached: None,
        },
        Head::Detached(id) => RefsHead {
            symbolic: None,
            detached: Some(id.to_hex()),
        },
    }
}

fn info(handle: &str, repo: &Repository) -> RepoInfo {
    let (mode, reason) = match repo.mode() {
        Mode::Writer => ("writer", None),
        Mode::ReadOnly(ReadOnlyReason::HeldByOtherProcess) => {
            ("readOnly", Some("heldByOtherProcess"))
        }
        Mode::ReadOnly(ReadOnlyReason::Requested) => ("readOnly", Some("requested")),
    };
    RepoInfo {
        handle: handle.into(),
        workspace: repo.meta().workspace.clone(),
        mode,
        read_only_reason: reason,
        format: repo.meta().format,
        revision: repo.refs().revision,
        head: head_of(&repo.refs().head),
        head_commit: repo.refs().head_commit().map(|id| id.to_hex()),
        ref_count: repo.refs().refs.len(),
        object_count: repo.object_count(),
        segment_count: repo.segment_count(),
        storage_bytes: repo.storage_bytes(),
        folders: repo
            .meta()
            .folders
            .iter()
            .map(|f| FolderInfo {
                folder_id: f.folder_id.clone(),
                path: f.path.clone(),
            })
            .collect(),
        findings: repo.findings().to_vec(),
    }
}

fn parse_id(id: &str) -> Result<ObjectId, String> {
    ObjectId::from_hex(id).map_err(fail)
}

/// Opens Local Git for the workspace the window shows. `folders` are the renderer's view of it
/// and must be the same workspace as the native root; the store is opened for the native root.
/// (Late answers are dropped by the renderer, which checks its own workspace generation.)
#[tauri::command(async)]
pub fn localgit_open(
    workspace: State<'_, Workspace>,
    local_git: State<'_, LocalGit>,
    folders: Vec<String>,
) -> Result<RepoInfo, String> {
    let root = with_workspace(&workspace, |manager| Ok(manager.root().to_path_buf()))?;
    let native = WorkspaceSpec::from_paths(&[root]).map_err(fail)?;
    let asked = WorkspaceSpec::from_paths(&folders).map_err(fail)?;
    if asked.workspace_id != native.workspace_id {
        return Err(format!(
            "NotInWorkspace: {} is not the open workspace",
            asked.workspace_id
        ));
    }
    let base = local_git
        .base
        .get()
        .ok_or("Unavailable: Local Git has no storage location")?
        .clone();
    let key = native.key();
    let existing = local_git
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .stores
        .get(&key)
        .cloned();
    let store = match existing {
        Some(store) => store,
        None => {
            let repo = Repository::open(&base, &native, OpenOptions::default()).map_err(fail)?;
            let folders = repo
                .meta()
                .folders
                .iter()
                .map(|record| {
                    Ok(FolderRoot {
                        folder_id: FolderId::new(&record.folder_id)?,
                        path: PathBuf::from(&record.path),
                        resource_id: record.resource_id.clone(),
                    })
                })
                .collect::<Result<Vec<_>, LgError>>()
                .map_err(fail)?;
            let engine = SnapshotEngine::new(folders, repo.meta().max_blob_bytes);
            // The watcher was running before this store opened: tell it what it said last.
            let last = local_git.watcher.lock().ok().and_then(|last| last.clone());
            if let Some((generation, healthy, root)) = last {
                if watches(&engine, &root) {
                    engine.watcher_status(generation, healthy);
                }
            }
            Store {
                repo: Arc::new(Mutex::new(repo)),
                engine: Arc::new(engine),
                mutating: Arc::new(Mutex::new(())),
            }
        }
    };
    let handle = new_handle();
    {
        let mut inner = local_git.inner.lock().map_err(|e| e.to_string())?;
        // The workspace may have been left while the store was opening: then it is not kept.
        let still_open = with_workspace(&workspace, |manager| Ok(manager.root().to_path_buf()))
            .ok()
            .and_then(|root| WorkspaceSpec::from_paths(&[root]).ok())
            .is_some_and(|now| now.workspace_id == native.workspace_id);
        if !still_open {
            return Err("NotInWorkspace: the workspace was left while Local Git opened".into());
        }
        let store = inner.stores.entry(key.clone()).or_insert(store).clone();
        inner.handles.insert(
            handle.clone(),
            Handle {
                key,
                workspace_id: native.workspace_id.clone(),
                overlays: HashMap::new(),
                untitled: HashMap::new(),
                jobs: HashMap::new(),
                status_job: None,
            },
        );
        drop(inner);
        let repo = store.repo.lock().map_err(|e| e.to_string())?;
        Ok(info(&handle, &repo))
    }
}

/// Closes a handle; the store closes (releasing its writer lock) with its last one.
#[tauri::command]
pub fn localgit_close(local_git: State<'_, LocalGit>, handle: String) -> Result<(), String> {
    let mut inner = local_git.inner.lock().map_err(|e| e.to_string())?;
    if let Some(closed) = inner.handles.remove(&handle) {
        closed.cancel_all();
        if !inner.handles.values().any(|h| h.key == closed.key) {
            inner.stores.remove(&closed.key);
        }
    }
    Ok(())
}

#[tauri::command(async)]
pub fn localgit_info(local_git: State<'_, LocalGit>, handle: String) -> Result<RepoInfo, String> {
    local_git.with(&handle, |repo| {
        if !matches!(repo.mode(), Mode::Writer) {
            // A reader sees what the writer has published since.
            repo.reload()?;
        }
        Ok(info(&handle, repo))
    })
}

#[tauri::command(async)]
pub fn localgit_verify(
    local_git: State<'_, LocalGit>,
    handle: String,
    full: bool,
) -> Result<Vec<Finding>, String> {
    local_git.with(&handle, |repo| Ok(repo.verify(full)))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefsView {
    revision: u64,
    head: RefsHead,
    refs: HashMap<String, String>,
}

#[tauri::command(async)]
pub fn localgit_refs(local_git: State<'_, LocalGit>, handle: String) -> Result<RefsView, String> {
    local_git.with(&handle, |repo| {
        let refs = repo.refs();
        Ok(RefsView {
            revision: refs.revision,
            head: head_of(&refs.head),
            refs: refs
                .refs
                .iter()
                .map(|(name, id)| (name.as_str().to_string(), id.to_hex()))
                .collect(),
        })
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ReflogView {
    #[serde(rename_all = "camelCase")]
    Update {
        revision: u64,
        name: String,
        old: Option<String>,
        new: Option<String>,
        ms: u64,
        op: String,
        reason: String,
    },
    #[serde(rename_all = "camelCase")]
    Aborted { revision: u64, ms: u64 },
}

/// The newest `limit` reflog records, newest last.
#[tauri::command(async)]
pub fn localgit_reflog(
    local_git: State<'_, LocalGit>,
    handle: String,
    limit: usize,
) -> Result<Vec<ReflogView>, String> {
    local_git.with(&handle, |repo| {
        let records = repo.reflog()?;
        let skip = records.len().saturating_sub(limit);
        Ok(records
            .into_iter()
            .skip(skip)
            .map(|record| match record {
                ReflogRecord::Update {
                    revision,
                    name,
                    old,
                    new,
                    ms,
                    op,
                    reason,
                } => ReflogView::Update {
                    revision,
                    name,
                    old,
                    new,
                    ms,
                    op,
                    reason,
                },
                ReflogRecord::Aborted { revision, ms } => ReflogView::Aborted { revision, ms },
            })
            .collect())
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitView {
    id: String,
    root: String,
    disk_root: Option<String>,
    parents: Vec<String>,
    workspace: String,
    author_name: String,
    author_id: String,
    time_ms: i64,
    tz_offset_min: i16,
    source: &'static str,
    meta: HashMap<String, String>,
    meta_objects: HashMap<String, String>,
    message: String,
}

#[tauri::command(async)]
pub fn localgit_read_commit(
    local_git: State<'_, LocalGit>,
    handle: String,
    id: String,
) -> Result<CommitView, String> {
    let id = parse_id(&id)?;
    local_git.with(&handle, |repo| {
        let commit = repo.read_commit(&id)?;
        Ok(CommitView {
            id: id.to_hex(),
            root: commit.root.to_hex(),
            disk_root: commit.disk_root.map(|id| id.to_hex()),
            parents: commit.parents.iter().map(ObjectId::to_hex).collect(),
            workspace: commit.workspace,
            author_name: commit.author.name,
            author_id: commit.author.id,
            time_ms: commit.time_ms,
            tz_offset_min: commit.tz_offset_min,
            source: commit.source.as_str(),
            meta: commit.meta.into_iter().collect(),
            meta_objects: commit
                .meta_objects
                .into_iter()
                .map(|(key, id)| (key, id.to_hex()))
                .collect(),
            message: commit.message,
        })
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeEntryView {
    name: String,
    /// `file`, `directory` or `symlink`.
    kind: &'static str,
    executable: bool,
    /// For a symlink: `file`, `directory` or `junction`.
    link: Option<&'static str>,
    id: String,
    /// False for a file that was hashed but not stored (over the size limit).
    stored: bool,
    size: Option<u64>,
}

#[tauri::command(async)]
pub fn localgit_read_tree(
    local_git: State<'_, LocalGit>,
    handle: String,
    id: String,
) -> Result<Vec<TreeEntryView>, String> {
    let id = parse_id(&id)?;
    local_git.with(&handle, |repo| {
        Ok(repo
            .read_tree(&id)?
            .entries()
            .iter()
            .map(|entry| {
                let (kind, executable, link, stored, size) = match entry.kind {
                    EntryKind::File { executable, stored } => match stored {
                        Stored::Yes => ("file", executable, None, true, None),
                        Stored::No { size } => ("file", executable, None, false, Some(size)),
                    },
                    EntryKind::Directory => ("directory", false, None, true, None),
                    EntryKind::Symlink(link) => (
                        "symlink",
                        false,
                        Some(match link {
                            LinkKind::File => "file",
                            LinkKind::Directory => "directory",
                            LinkKind::Junction => "junction",
                        }),
                        true,
                        None,
                    ),
                };
                TreeEntryView {
                    name: entry.name.as_str().into(),
                    kind,
                    executable,
                    link,
                    id: entry.id.to_hex(),
                    stored,
                    size,
                }
            })
            .collect())
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobInfo {
    size: u64,
    binary: bool,
}

#[tauri::command(async)]
pub fn localgit_blob_info(
    local_git: State<'_, LocalGit>,
    handle: String,
    id: String,
) -> Result<BlobInfo, String> {
    let id = parse_id(&id)?;
    local_git.with(&handle, |repo| {
        let (size, binary) = repo.blob_info(&id)?;
        Ok(BlobInfo { size, binary })
    })
}

/// A blob's raw bytes (refused over `max_bytes`), for the renderer to decode or show as binary.
#[tauri::command(async)]
pub fn localgit_read_blob(
    local_git: State<'_, LocalGit>,
    handle: String,
    id: String,
    max_bytes: u64,
) -> Result<tauri::ipc::Response, String> {
    let id = parse_id(&id)?;
    local_git
        .with(&handle, |repo| repo.read_blob(&id, max_bytes))
        .map(tauri::ipc::Response::new)
}

// --- Snapshots and status (LG-02) -------------------------------------------------------------

/// An unsaved named document, as the renderer sends it: `text` is exactly what saving it would
/// write (DocumentService's `encode`: its line endings and byte order mark), sent once per
/// version.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayArg {
    key: String,
    path: String,
    text: String,
    encoding: String,
    line_ending: String,
    version: u64,
}

/// An untitled document, for recovery snapshots only.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UntitledArg {
    id: String,
    text: String,
    encoding: String,
    line_ending: String,
    version: u64,
}

/// A document version a snapshot uses, already in the pool.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayRef {
    key: String,
    version: u64,
}

/// Adds document versions to the handle's pool.
#[tauri::command]
pub fn localgit_put_overlays(
    local_git: State<'_, LocalGit>,
    handle: String,
    overlays: Vec<OverlayArg>,
    untitled: Vec<UntitledArg>,
) -> Result<(), String> {
    let mut inner = local_git.inner.lock().map_err(|e| e.to_string())?;
    let entry = inner.handles.get_mut(&handle).ok_or(CLOSED)?;
    for overlay in overlays {
        entry.overlays.insert(
            overlay.key,
            Pooled {
                path: overlay.path,
                bytes: Arc::new(overlay.text.into_bytes()),
                encoding: overlay.encoding,
                line_ending: overlay.line_ending,
                version: overlay.version,
            },
        );
    }
    for document in untitled {
        entry.untitled.insert(
            document.id,
            Pooled {
                path: String::new(),
                bytes: Arc::new(document.text.into_bytes()),
                encoding: document.encoding,
                line_ending: document.line_ending,
                version: document.version,
            },
        );
    }
    Ok(())
}

fn requested_mode(mode: &str) -> Result<RequestedMode, String> {
    match mode {
        "auto" => Ok(RequestedMode::Auto),
        "full" => Ok(RequestedMode::Full),
        "verify" => Ok(RequestedMode::Verify),
        other => Err(format!("InvalidFormat: unknown snapshot mode {other:?}")),
    }
}

/// The request for a snapshot of `handle`'s store: the named versions, from its pool (which
/// forgets every document the snapshot no longer names).
fn prepare(
    local_git: &LocalGit,
    handle: &str,
    mode: &str,
    persist: bool,
    overlays: &[OverlayRef],
    untitled: &[OverlayRef],
) -> Result<(Store, SnapshotRequest), String> {
    let mode = requested_mode(mode)?;
    let store = local_git.handle_store(handle)?;
    let mut inner = local_git.inner.lock().map_err(|e| e.to_string())?;
    let entry = inner.handles.get_mut(handle).ok_or(CLOSED)?;
    let pick = |pool: &HashMap<String, Pooled>, wanted: &OverlayRef| {
        pool.get(&wanted.key)
            .filter(|pooled| pooled.version == wanted.version)
            .cloned()
            .ok_or_else(|| {
                format!(
                    "OverlayMissing: version {} of {} was not sent",
                    wanted.version, wanted.key
                )
            })
    };
    let mut request = SnapshotRequest {
        mode,
        persist,
        ..Default::default()
    };
    for wanted in overlays {
        let pooled = pick(&entry.overlays, wanted)?;
        request.overlays.push(OverlayInput {
            path: pooled.path,
            bytes: pooled.bytes,
            encoding: pooled.encoding,
            line_ending: pooled.line_ending,
            version: pooled.version,
        });
    }
    for wanted in untitled {
        let pooled = pick(&entry.untitled, wanted)?;
        request.untitled.push(UntitledInput {
            id: wanted.key.clone(),
            bytes: pooled.bytes,
            encoding: pooled.encoding,
            line_ending: pooled.line_ending,
            version: pooled.version,
        });
    }
    entry
        .overlays
        .retain(|key, _| overlays.iter().any(|wanted| wanted.key == *key));
    if !untitled.is_empty() {
        entry
            .untitled
            .retain(|key, _| untitled.iter().any(|wanted| wanted.key == *key));
    }
    Ok((store, request))
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent<'a> {
    handle: &'a str,
    job_id: &'a str,
    #[serde(flatten)]
    progress: &'a Progress,
}

fn progress_to<'a>(
    app: &'a AppHandle,
    handle: &'a str,
    job: &'a str,
) -> impl Fn(&Progress) + Sync + 'a {
    move |progress| {
        let _ = app.emit(
            "localgit-progress",
            ProgressEvent {
                handle,
                job_id: job,
                progress,
            },
        );
    }
}

/// Takes a snapshot of the workspace (ephemeral, or persisted into the store), with the named
/// unsaved documents applied to its effective root. Progress: `localgit-progress`, 10 Hz.
#[allow(clippy::too_many_arguments)]
#[tauri::command(async)]
pub fn localgit_snapshot(
    app: AppHandle,
    local_git: State<'_, LocalGit>,
    handle: String,
    job_id: String,
    mode: String,
    persist: bool,
    overlays: Vec<OverlayRef>,
    untitled: Vec<OverlayRef>,
) -> Result<Snapshot, String> {
    let (store, request) = prepare(&local_git, &handle, &mode, persist, &overlays, &untitled)?;
    let cancel = local_git.start_job(&handle, &job_id, false)?;
    let progress = progress_to(&app, &handle, &job_id);
    let result = store.engine.snapshot(
        &store.repo,
        &request,
        &Control {
            cancel: &cancel,
            progress: &progress,
        },
    );
    local_git.finish_job(&handle, &job_id, result)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusView {
    snapshot: Snapshot,
    status: Status,
}

/// Status against Local HEAD: an ephemeral snapshot (disk, and disk with the named unsaved
/// documents) and how it differs. A newer status of the same handle cancels this one.
#[allow(clippy::too_many_arguments)]
#[tauri::command(async)]
pub fn localgit_status(
    app: AppHandle,
    local_git: State<'_, LocalGit>,
    handle: String,
    job_id: String,
    mode: String,
    overlays: Vec<OverlayRef>,
    limit: usize,
) -> Result<StatusView, String> {
    let (store, request) = prepare(&local_git, &handle, &mode, false, &overlays, &[])?;
    let cancel = local_git.start_job(&handle, &job_id, true)?;
    let progress = progress_to(&app, &handle, &job_id);
    let result = store.engine.status(
        &store.repo,
        &request,
        &Control {
            cancel: &cancel,
            progress: &progress,
        },
        limit,
    );
    local_git
        .finish_job(&handle, &job_id, result)
        .map(|(snapshot, status)| StatusView { snapshot, status })
}

/// Cancels a job of the handle (it answers `Cancelled`).
#[tauri::command]
pub fn localgit_cancel(
    local_git: State<'_, LocalGit>,
    handle: String,
    job_id: String,
) -> Result<(), String> {
    let inner = local_git.inner.lock().map_err(|e| e.to_string())?;
    if let Some(flag) = inner.handles.get(&handle).and_then(|h| h.jobs.get(&job_id)) {
        flag.store(true, Ordering::SeqCst);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(label: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("yavin-localgit-app-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("project")).unwrap();
        dir
    }

    /// A `LocalGit` with one open store and one handle on it, as `localgit_open` leaves it.
    fn opened(label: &str) -> (LocalGit, String, PathBuf) {
        let dir = temp(label);
        let project = dir.join("project");
        let spec = WorkspaceSpec::from_paths(&[&project]).unwrap();
        let repo = Repository::open(&dir.join("base"), &spec, OpenOptions::default()).unwrap();
        let record = repo.meta().folders[0].clone();
        let engine = SnapshotEngine::new(
            vec![FolderRoot {
                folder_id: FolderId::new(&record.folder_id).unwrap(),
                path: project.clone(),
                resource_id: record.resource_id,
            }],
            repo.meta().max_blob_bytes,
        );
        let local_git = LocalGit::default();
        let handle = new_handle();
        {
            let mut inner = local_git.inner.lock().unwrap();
            inner.stores.insert(
                spec.key(),
                Store {
                    repo: Arc::new(Mutex::new(repo)),
                    engine: Arc::new(engine),
                    mutating: Arc::new(Mutex::new(())),
                },
            );
            inner.handles.insert(
                handle.clone(),
                Handle {
                    key: spec.key(),
                    workspace_id: spec.workspace_id.clone(),
                    overlays: HashMap::new(),
                    untitled: HashMap::new(),
                    jobs: HashMap::new(),
                    status_job: None,
                },
            );
        }
        (local_git, handle, project)
    }

    #[test]
    fn leaving_the_workspace_cancels_its_jobs_and_refuses_their_results() {
        let (local_git, handle, _) = opened("revoke");
        let flag = local_git.start_job(&handle, "job-1", false).unwrap();
        local_git.revoke_except(Some("some other workspace"));
        assert!(flag.load(Ordering::SeqCst));
        let late = local_git.finish_job(&handle, "job-1", Ok(42));
        assert!(late.unwrap_err().starts_with("HandleClosed:"));
        // And the store closed with its last handle.
        assert!(local_git.inner.lock().unwrap().stores.is_empty());
    }

    #[test]
    fn a_newer_status_cancels_the_one_in_flight() {
        let (local_git, handle, _) = opened("supersede");
        let first = local_git.start_job(&handle, "status-1", true).unwrap();
        let snapshot = local_git.start_job(&handle, "snap-1", false).unwrap();
        let second = local_git.start_job(&handle, "status-2", true).unwrap();
        assert!(first.load(Ordering::SeqCst));
        assert!(
            !snapshot.load(Ordering::SeqCst),
            "snapshots are not superseded"
        );
        assert!(!second.load(Ordering::SeqCst));
        let old = local_git.finish_job(&handle, "status-1", Ok(1));
        assert!(old.unwrap_err().starts_with("Cancelled:"));
        assert_eq!(local_git.finish_job(&handle, "status-2", Ok(2)), Ok(2));
        assert_eq!(local_git.finish_job(&handle, "snap-1", Ok(3)), Ok(3));
    }

    #[test]
    fn a_snapshot_names_pooled_versions_and_the_pool_forgets_the_rest() {
        let (local_git, handle, project) = opened("pool");
        let path = |name: &str| ide_workspace::file_tree::clean_path_str(project.join(name));
        {
            let mut inner = local_git.inner.lock().unwrap();
            let entry = inner.handles.get_mut(&handle).unwrap();
            for (key, version) in [("a", 3), ("b", 1)] {
                entry.overlays.insert(
                    key.into(),
                    Pooled {
                        path: path(key),
                        bytes: Arc::new(key.as_bytes().to_vec()),
                        encoding: "utf8".into(),
                        line_ending: "lf".into(),
                        version,
                    },
                );
            }
        }
        let wanted = |key: &str, version| OverlayRef {
            key: key.into(),
            version,
        };
        // A version that was never sent: refused, so the renderer sends it again.
        let missing = prepare(&local_git, &handle, "auto", false, &[wanted("a", 4)], &[]);
        assert!(missing.err().unwrap().starts_with("OverlayMissing:"));
        let (_, request) =
            prepare(&local_git, &handle, "full", false, &[wanted("a", 3)], &[]).unwrap();
        assert_eq!(request.mode, RequestedMode::Full);
        assert_eq!(request.overlays.len(), 1);
        assert_eq!(request.overlays[0].path, path("a"));
        let inner = local_git.inner.lock().unwrap();
        let pool: Vec<&String> = inner.handles[&handle].overlays.keys().collect();
        assert_eq!(pool, vec!["a"]);
    }

    #[test]
    fn watcher_output_reaches_the_store_of_the_folder_it_watches() {
        let (local_git, handle, project) = opened("observe");
        let root = ide_workspace::file_tree::clean_path_str(&project);
        std::fs::write(project.join("a.txt"), "a").unwrap();
        local_git.observe(&WatchOutput::Status(
            ide_workspace::resource_events::WatcherStatus {
                generation: 5,
                root: root.clone(),
                state: WatcherState::Watching,
                message: None,
            },
        ));
        let store = local_git.handle_store(&handle).unwrap();
        let cancel = AtomicBool::new(false);
        let control = Control {
            cancel: &cancel,
            progress: &|_| {},
        };
        let request = SnapshotRequest::default();
        let first = store
            .engine
            .snapshot(&store.repo, &request, &control)
            .unwrap();
        assert_eq!(first.stats.files, 1);
        // Healthy watcher, nothing reported: incremental, nothing read.
        let quiet = store
            .engine
            .snapshot(&store.repo, &request, &control)
            .unwrap();
        assert_eq!(quiet.watcher_generation, Some(5));
        assert_eq!(quiet.stats.files, 0);
        // A failure reported by the watcher: the next one reads everything.
        local_git.observe(&WatchOutput::Status(
            ide_workspace::resource_events::WatcherStatus {
                generation: 5,
                root,
                state: WatcherState::Failed,
                message: Some("gone".into()),
            },
        ));
        let full = store
            .engine
            .snapshot(&store.repo, &request, &control)
            .unwrap();
        assert_eq!(full.watcher_generation, None);
        assert_eq!(full.stats.files, 1);
    }
}

// --- Checkpoints, commits, history, diff and restore (LG-03) ----------------------------------

use ide_localgit::diff::{DiffOptions, DiffResult};
use ide_localgit::history::{
    self, CheckpointEntry, CommitRequest, Created, HeadInfo, HistoryPage, TreeItem,
};
use ide_localgit::restore::{RestoreConflict, RestorePlan, RestorePolicy, Verification};
use ide_localgit::{Author, Source};

/// Who makes a commit, and when, as the window knows it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Signature {
    name: String,
    id: String,
    time_ms: i64,
    /// Minutes east of UTC.
    tz_offset_min: i16,
}

fn commit_request(message: String, by: Signature) -> CommitRequest {
    CommitRequest {
        message,
        author: Author {
            name: by.name,
            id: by.id,
        },
        time_ms: by.time_ms,
        tz_offset_min: by.tz_offset_min,
    }
}

fn parse_opt(id: Option<String>) -> Result<Option<ObjectId>, String> {
    id.as_deref().map(parse_id).transpose()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recorded {
    snapshot: Snapshot,
    #[serde(flatten)]
    created: Created,
}

/// Captures the workspace (unsaved documents included) as a checkpoint: durable, and in the
/// checkpoint list, but HEAD does not move. Incremental from a warm engine.
#[allow(clippy::too_many_arguments)]
#[tauri::command(async)]
pub fn localgit_checkpoint(
    app: AppHandle,
    local_git: State<'_, LocalGit>,
    handle: String,
    job_id: String,
    message: Option<String>,
    overlays: Vec<OverlayRef>,
    untitled: Vec<OverlayRef>,
    by: Signature,
) -> Result<Recorded, String> {
    let (store, mut request) = prepare(&local_git, &handle, "auto", true, &overlays, &untitled)?;
    request.allow_incremental_persist = true;
    let _only = exclusive(&store)?;
    let cancel = local_git.start_job(&handle, &job_id, false)?;
    let progress = progress_to(&app, &handle, &job_id);
    let control = Control {
        cancel: &cancel,
        progress: &progress,
    };
    let message = message.unwrap_or_else(|| "Checkpoint".into());
    let result = store
        .engine
        .snapshot(&store.repo, &request, &control)
        .and_then(|snapshot| {
            let mut repo = store.repo.lock().map_err(|e| LgError::Io(e.to_string()))?;
            let created = history::checkpoint_snapshot(
                &mut repo,
                &snapshot,
                Source::Checkpoint,
                &commit_request(message, by),
            )?;
            Ok(Recorded { snapshot, created })
        });
    local_git.finish_job(&handle, &job_id, result)
}

/// Makes a commit on top of HEAD of exactly what is staged (the Local Index), and moves HEAD
/// -- and the index, which now equals it -- to it; `NothingToCommit` when nothing is staged.
/// With `fromCheckpoint`, of a checkpoint's roots as they are instead (nothing scanned; the
/// index follows only if nothing was staged).
#[tauri::command(async)]
pub fn localgit_commit(
    local_git: State<'_, LocalGit>,
    handle: String,
    message: String,
    from_checkpoint: Option<String>,
    by: Signature,
) -> Result<Created, String> {
    history::validate_message(&message).map_err(fail)?;
    let from_checkpoint = parse_opt(from_checkpoint)?;
    let store = local_git.handle_store(&handle)?;
    let _only = exclusive(&store)?;
    let request_by = commit_request(message, by);
    let mut repo = store.repo.lock().map_err(|e| e.to_string())?;
    match from_checkpoint {
        Some(checkpoint) => history::commit_checkpoint(&mut repo, checkpoint, &request_by),
        None => history::commit_index(&mut repo, &request_by),
    }
    .map_err(fail)
}

#[tauri::command(async)]
pub fn localgit_head(local_git: State<'_, LocalGit>, handle: String) -> Result<HeadInfo, String> {
    local_git.with(&handle, |repo| history::head_info(repo))
}

/// Up to `limit` commits along first parents from `cursor` (or HEAD), newest first.
#[tauri::command(async)]
pub fn localgit_history(
    local_git: State<'_, LocalGit>,
    handle: String,
    cursor: Option<String>,
    limit: usize,
) -> Result<HistoryPage, String> {
    let cursor = parse_opt(cursor)?;
    local_git.with(&handle, |repo| Ok(history::history(repo, cursor, limit)))
}

#[tauri::command(async)]
pub fn localgit_checkpoints(
    local_git: State<'_, LocalGit>,
    handle: String,
    limit: usize,
) -> Result<Vec<CheckpointEntry>, String> {
    local_git.with(&handle, |repo| history::checkpoints(repo, limit))
}

/// The entries of a directory (`path`, `""` for the folder) in a commit.
#[tauri::command(async)]
pub fn localgit_tree(
    local_git: State<'_, LocalGit>,
    handle: String,
    commit: String,
    folder_id: Option<String>,
    path: String,
) -> Result<Vec<TreeItem>, String> {
    let commit = parse_id(&commit)?;
    local_git.with(&handle, |repo| {
        let root = repo.read_commit(&commit)?.root;
        let folder = folder_id.as_deref().map(FolderId::new).transpose()?;
        history::list_tree(repo, root, folder.as_ref(), &path)
    })
}

fn diff_options(line_diffs: bool) -> DiffOptions {
    DiffOptions {
        line_diffs,
        ..Default::default()
    }
}

/// Commit `from` (none: before the first commit) to commit `to`.
#[tauri::command(async)]
pub fn localgit_diff_commits(
    local_git: State<'_, LocalGit>,
    handle: String,
    from: Option<String>,
    to: String,
    line_diffs: bool,
) -> Result<DiffResult, String> {
    let (from, to) = (parse_opt(from)?, parse_id(&to)?);
    local_git.with(&handle, |repo| {
        ide_localgit::diff::diff_commits(repo, from, to, &diff_options(line_diffs))
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDiff {
    snapshot: Snapshot,
    diff: DiffResult,
}

/// A commit (`from`, or HEAD) to the workspace as the user has it, unsaved documents
/// included. Nothing is saved.
#[allow(clippy::too_many_arguments)]
#[tauri::command(async)]
pub fn localgit_diff_workspace(
    app: AppHandle,
    local_git: State<'_, LocalGit>,
    handle: String,
    job_id: String,
    from: Option<String>,
    overlays: Vec<OverlayRef>,
    line_diffs: bool,
) -> Result<WorkspaceDiff, String> {
    let from = parse_opt(from)?;
    let (store, request) = prepare(&local_git, &handle, "auto", false, &overlays, &[])?;
    let cancel = local_git.start_job(&handle, &job_id, false)?;
    let progress = progress_to(&app, &handle, &job_id);
    let result = store.engine.diff_workspace(
        &store.repo,
        &request,
        &Control {
            cancel: &cancel,
            progress: &progress,
        },
        from,
        &diff_options(line_diffs),
    );
    local_git
        .finish_job(&handle, &job_id, result)
        .map(|(snapshot, diff)| WorkspaceDiff { snapshot, diff })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    /// `planned` (dry run), `unchanged`, `refused`, `completed`, `failed`, `verificationFailed`.
    status: &'static str,
    plan: RestorePlan,
    /// Everything that stopped it (the plan's, and what the last check before changing
    /// anything found).
    conflicts: Vec<RestoreConflict>,
    /// The checkpoint of the workspace taken just before anything changed (source `recovery`).
    checkpoint: Option<history::CommitInfo>,
    /// The file operation's id (Module 03), which the watcher credits the changes to.
    operation: Option<u64>,
    applied: usize,
    error: Option<String>,
    verification: Option<Verification>,
}

fn policy_of(policy: &str) -> Result<RestorePolicy, String> {
    match policy {
        "refuseIfDirty" => Ok(RestorePolicy::RefuseIfDirty),
        "replaceDocument" => Ok(RestorePolicy::ReplaceDocument),
        other => Err(format!("InvalidFormat: unknown restore policy {other:?}")),
    }
}

/// Makes the workspace match a commit -- all of it, or one path (`path`) -- or, with `dryRun`,
/// only plans it. The plan is complete and every conflict found before anything changes; a
/// checkpoint of the workspace is taken; the disk is changed as one recorded file operation;
/// and a Full snapshot verifies the result. Documents are the window's to reconcile after.
#[allow(clippy::too_many_arguments)]
#[tauri::command(async)]
pub fn localgit_restore(
    app: AppHandle,
    workspace: State<'_, Workspace>,
    watch: State<'_, crate::Watch>,
    local_git: State<'_, LocalGit>,
    handle: String,
    job_id: String,
    commit: String,
    folder_id: Option<String>,
    path: Option<String>,
    policy: String,
    dry_run: bool,
    overlays: Vec<OverlayRef>,
    by: Signature,
) -> Result<RestoreResult, String> {
    let commit = parse_id(&commit)?;
    let policy = policy_of(&policy)?;
    let folder = folder_id
        .as_deref()
        .map(FolderId::new)
        .transpose()
        .map_err(fail)?;
    let (store, mut request) = prepare(&local_git, &handle, "full", !dry_run, &overlays, &[])?;
    request.mode = RequestedMode::Full;
    let guard = if dry_run {
        None
    } else {
        Some(exclusive(&store)?)
    };
    let cancel = local_git.start_job(&handle, &job_id, false)?;
    let progress = progress_to(&app, &handle, &job_id);
    let control = Control {
        cancel: &cancel,
        progress: &progress,
    };
    let planned = store.engine.plan_restore(
        &store.repo,
        &request,
        &control,
        commit,
        path.map(|path| (folder, path)),
        policy,
    );
    let (snapshot, plan) = match planned {
        Ok(planned) => planned,
        Err(error) => return local_git.finish_job(&handle, &job_id, Err(error)),
    };
    let answer = |status, conflicts: Vec<RestoreConflict>, plan: RestorePlan| RestoreResult {
        status,
        plan,
        conflicts,
        checkpoint: None,
        operation: None,
        applied: 0,
        error: None,
        verification: None,
    };
    if !plan.conflicts.is_empty() {
        let conflicts = plan.conflicts.clone();
        return local_git.finish_job(&handle, &job_id, Ok(answer("refused", conflicts, plan)));
    }
    if dry_run {
        return local_git.finish_job(&handle, &job_id, Ok(answer("planned", vec![], plan)));
    }
    if plan.unchanged {
        return local_git.finish_job(&handle, &job_id, Ok(answer("unchanged", vec![], plan)));
    }
    // The last point a restore can be cancelled, and the last check that this is still the
    // window's workspace: past here the disk changes.
    if cancel.load(Ordering::SeqCst) {
        return local_git.finish_job(&handle, &job_id, Err(LgError::Cancelled));
    }
    let workspace_id = {
        let inner = local_git.inner.lock().map_err(|e| e.to_string())?;
        inner
            .handles
            .get(&handle)
            .ok_or(CLOSED)?
            .workspace_id
            .clone()
    };
    if !workspace_is_open(&workspace, &workspace_id) {
        return Err("NotInWorkspace: the workspace was left before the restore began".into());
    }
    // A checkpoint of what is about to be replaced, so the restore itself can be undone.
    let checkpoint = {
        let mut repo = store.repo.lock().map_err(|e| e.to_string())?;
        let short = &commit.to_hex()[..history::SHORT_ID_LEN];
        history::checkpoint_snapshot(
            &mut repo,
            &snapshot,
            Source::Recovery,
            &commit_request(format!("Before restoring {short}"), by),
        )
        .map_err(fail)?
    };
    let scratch = std::env::temp_dir().join("yavin-localgit-link-probe");
    let outcome =
        crate::localgit_restore::execute(&watch, &store.repo, &store.engine, &plan, &scratch);
    let mut result = answer("completed", vec![], plan);
    result.checkpoint = Some(checkpoint.commit);
    match outcome {
        crate::localgit_restore::Outcome::Refused(conflicts) => {
            result.status = "refused";
            result.conflicts = conflicts;
        }
        crate::localgit_restore::Outcome::Failed {
            operation,
            applied,
            error,
        } => {
            result.status = "failed";
            result.operation = operation;
            result.applied = applied;
            result.error = Some(error);
        }
        crate::localgit_restore::Outcome::Done { operation, applied } => {
            result.operation = Some(operation);
            result.applied = applied;
            // Verified by a Full snapshot, never assumed. (Not cancellable: the disk changed.)
            let settled = AtomicBool::new(false);
            match store.engine.verify_restore(
                &store.repo,
                &Control {
                    cancel: &settled,
                    progress: &progress,
                },
                &result.plan,
            ) {
                Ok((_, verification)) => {
                    if !verification.matches {
                        result.status = "verificationFailed";
                    }
                    result.verification = Some(verification);
                }
                Err(error) => {
                    result.status = "verificationFailed";
                    result.error = Some(fail(error));
                }
            }
        }
    }
    drop(guard);
    local_git.finish_changed(&handle, &job_id, Ok(result))
}

#[cfg(test)]
mod lg03_tests {
    use super::*;

    fn store_for(label: &str) -> Store {
        let dir = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "yavin-localgit-lg03-{label}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("project")).unwrap();
        let spec = WorkspaceSpec::from_paths(&[dir.join("project")]).unwrap();
        let repo = Repository::open(&dir.join("base"), &spec, OpenOptions::default()).unwrap();
        let engine = SnapshotEngine::new(Vec::new(), repo.meta().max_blob_bytes);
        Store {
            repo: Arc::new(Mutex::new(repo)),
            engine: Arc::new(engine),
            mutating: Arc::new(Mutex::new(())),
        }
    }

    #[test]
    fn a_second_change_while_one_runs_is_refused_not_queued() {
        let store = store_for("busy");
        let first = exclusive(&store).unwrap();
        // Commit + restore, restore + restore, commit + commit: all the same lock.
        let second = exclusive(&store);
        assert!(second.unwrap_err().starts_with("Busy:"));
        drop(first);
        assert!(exclusive(&store).is_ok());
    }

    #[test]
    fn a_restore_result_is_refused_after_its_workspace_was_left_but_never_relabelled_cancelled() {
        let local_git = LocalGit::default();
        {
            let mut inner = local_git.inner.lock().unwrap();
            inner.handles.insert(
                "lg-a".into(),
                Handle {
                    key: "k".into(),
                    workspace_id: "a".into(),
                    overlays: HashMap::new(),
                    untitled: HashMap::new(),
                    jobs: HashMap::new(),
                    status_job: None,
                },
            );
        }
        let flag = local_git.start_job("lg-a", "restore-1", false).unwrap();
        // Cancelled after the disk changed: the answer is still what happened.
        flag.store(true, Ordering::SeqCst);
        assert_eq!(
            local_git.finish_changed("lg-a", "restore-1", Ok("completed")),
            Ok("completed")
        );
        // The workspace was left meanwhile: nothing is delivered.
        local_git.start_job("lg-a", "restore-2", false).unwrap();
        local_git.revoke_except(Some("b"));
        let late = local_git.finish_changed("lg-a", "restore-2", Ok("completed"));
        assert!(late.unwrap_err().starts_with("HandleClosed:"));
    }
}

// --- The Local Index, branches, tags and switching (LG-04) ------------------------------------

use ide_localgit::branches::{self, BranchInfo, HeadState, TagInfo};
use ide_localgit::index::{self as local_index, IndexInfo, StagePath, StageResult};
use ide_localgit::switch::{SwitchPlan, SwitchTarget};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathArg {
    folder_id: Option<String>,
    path: String,
}

fn stage_paths(paths: Vec<PathArg>) -> Result<Vec<StagePath>, String> {
    paths
        .into_iter()
        .map(|p| {
            Ok(StagePath {
                folder: p
                    .folder_id
                    .as_deref()
                    .map(FolderId::new)
                    .transpose()
                    .map_err(fail)?,
                path: p.path,
            })
        })
        .collect()
}

#[tauri::command(async)]
pub fn localgit_index(local_git: State<'_, LocalGit>, handle: String) -> Result<IndexInfo, String> {
    local_git.with(&handle, |repo| local_index::index_info(repo))
}

/// Stages paths as the workspace has them (unsaved documents included; nothing is saved).
#[allow(clippy::too_many_arguments)]
#[tauri::command(async)]
pub fn localgit_stage(
    app: AppHandle,
    local_git: State<'_, LocalGit>,
    handle: String,
    job_id: String,
    paths: Vec<PathArg>,
    all: bool,
    overlays: Vec<OverlayRef>,
) -> Result<StageResult, String> {
    let paths = stage_paths(paths)?;
    let (store, request) = prepare(&local_git, &handle, "auto", true, &overlays, &[])?;
    let _only = exclusive(&store)?;
    let cancel = local_git.start_job(&handle, &job_id, false)?;
    let progress = progress_to(&app, &handle, &job_id);
    let control = Control {
        cancel: &cancel,
        progress: &progress,
    };
    let result = if all {
        local_index::stage_all(&store.engine, &store.repo, &request, &control)
    } else {
        local_index::stage(&store.engine, &store.repo, &request, &control, &paths)
    };
    local_git.finish_job(&handle, &job_id, result)
}

/// Unstages paths (their index entries become HEAD's), or everything. Nothing on disk and no
/// document changes.
#[tauri::command(async)]
pub fn localgit_unstage(
    local_git: State<'_, LocalGit>,
    handle: String,
    paths: Vec<PathArg>,
    all: bool,
) -> Result<StageResult, String> {
    let paths = stage_paths(paths)?;
    let store = local_git.handle_store(&handle)?;
    let _only = exclusive(&store)?;
    let mut repo = store.repo.lock().map_err(|e| e.to_string())?;
    let folders = store.engine.folders();
    if all {
        local_index::unstage_all(&mut repo, folders)
    } else {
        local_index::unstage(&mut repo, folders, &paths)
    }
    .map_err(fail)
}

/// Stages chosen hunks of one file's index-to-workspace diff. `expectedIndex` and
/// `expectedWorking` are the blob ids that diff was made from.
#[allow(clippy::too_many_arguments)]
#[tauri::command(async)]
pub fn localgit_stage_hunks(
    app: AppHandle,
    local_git: State<'_, LocalGit>,
    handle: String,
    job_id: String,
    folder_id: Option<String>,
    path: String,
    hunks: Vec<usize>,
    expected_index: Option<String>,
    expected_working: Option<String>,
    overlays: Vec<OverlayRef>,
) -> Result<StageResult, String> {
    let folder = folder_id
        .as_deref()
        .map(FolderId::new)
        .transpose()
        .map_err(fail)?;
    let expected = (parse_opt(expected_index)?, parse_opt(expected_working)?);
    let (store, request) = prepare(&local_git, &handle, "auto", true, &overlays, &[])?;
    let _only = exclusive(&store)?;
    let cancel = local_git.start_job(&handle, &job_id, false)?;
    let progress = progress_to(&app, &handle, &job_id);
    let result = local_index::stage_hunks(
        &store.engine,
        &store.repo,
        &request,
        &Control {
            cancel: &cancel,
            progress: &progress,
        },
        folder,
        &path,
        &hunks,
        expected,
    );
    local_git.finish_job(&handle, &job_id, result)
}

#[tauri::command(async)]
pub fn localgit_branches(
    local_git: State<'_, LocalGit>,
    handle: String,
) -> Result<Vec<BranchInfo>, String> {
    local_git.with(&handle, |repo| Ok(branches::list_branches(repo)))
}

/// A new branch at `start` (HEAD's commit by default). HEAD does not move.
#[tauri::command(async)]
pub fn localgit_create_branch(
    local_git: State<'_, LocalGit>,
    handle: String,
    name: String,
    start: Option<String>,
) -> Result<BranchInfo, String> {
    let start = parse_opt(start)?;
    let store = local_git.handle_store(&handle)?;
    let _only = exclusive(&store)?;
    let mut repo = store.repo.lock().map_err(|e| e.to_string())?;
    branches::create_branch(&mut repo, &name, start).map_err(fail)
}

/// Deletes a branch: never the current one, never one whose commits nothing else reaches.
#[tauri::command(async)]
pub fn localgit_delete_branch(
    local_git: State<'_, LocalGit>,
    handle: String,
    name: String,
) -> Result<(), String> {
    let store = local_git.handle_store(&handle)?;
    let _only = exclusive(&store)?;
    let mut repo = store.repo.lock().map_err(|e| e.to_string())?;
    branches::delete_branch(&mut repo, &name).map_err(fail)
}

#[tauri::command(async)]
pub fn localgit_tags(
    local_git: State<'_, LocalGit>,
    handle: String,
) -> Result<Vec<TagInfo>, String> {
    local_git.with(&handle, |repo| Ok(branches::list_tags(repo)))
}

#[tauri::command(async)]
pub fn localgit_get_tag(
    local_git: State<'_, LocalGit>,
    handle: String,
    name: String,
) -> Result<TagInfo, String> {
    local_git.with(&handle, |repo| branches::get_tag(repo, &name))
}

/// A lightweight tag at `target` (HEAD's commit by default); never replaces one.
#[tauri::command(async)]
pub fn localgit_create_tag(
    local_git: State<'_, LocalGit>,
    handle: String,
    name: String,
    target: Option<String>,
) -> Result<TagInfo, String> {
    let target = parse_opt(target)?;
    let store = local_git.handle_store(&handle)?;
    let _only = exclusive(&store)?;
    let mut repo = store.repo.lock().map_err(|e| e.to_string())?;
    branches::create_tag(&mut repo, &name, target).map_err(fail)
}

#[tauri::command(async)]
pub fn localgit_delete_tag(
    local_git: State<'_, LocalGit>,
    handle: String,
    name: String,
) -> Result<(), String> {
    let store = local_git.handle_store(&handle)?;
    let _only = exclusive(&store)?;
    let mut repo = store.repo.lock().map_err(|e| e.to_string())?;
    branches::delete_tag(&mut repo, &name).map_err(fail)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchResult {
    /// `planned` (dry run), `refused`, `completed`, `failed`, `verificationFailed`.
    status: &'static str,
    plan: SwitchPlan,
    conflicts: Vec<RestoreConflict>,
    operation: Option<u64>,
    applied: usize,
    error: Option<String>,
    verification: Option<Verification>,
    /// Where HEAD is afterwards.
    head: HeadState,
}

/// Switches to a branch (`branch`), or detaches HEAD at a commit (`commit`). Refused -- with
/// every conflict, before anything changes -- when staged work, local changes or unsaved
/// documents would be lost. The disk changes as one recorded file operation, is verified,
/// and only then do HEAD and the index move, together. Documents are the window's to
/// reconcile after. There is no forced switch.
#[allow(clippy::too_many_arguments)]
#[tauri::command(async)]
pub fn localgit_switch(
    app: AppHandle,
    workspace: State<'_, Workspace>,
    watch: State<'_, crate::Watch>,
    local_git: State<'_, LocalGit>,
    handle: String,
    job_id: String,
    branch: Option<String>,
    commit: Option<String>,
    dry_run: bool,
    overlays: Vec<OverlayRef>,
) -> Result<SwitchResult, String> {
    let target = match (branch, parse_opt(commit)?) {
        (Some(name), None) => SwitchTarget::Branch(name),
        (None, Some(id)) => SwitchTarget::Commit(id),
        _ => return Err("InvalidFormat: name a branch or a commit, not both".into()),
    };
    let (store, request) = prepare(&local_git, &handle, "full", true, &overlays, &[])?;
    let guard = if dry_run {
        None
    } else {
        Some(exclusive(&store)?)
    };
    let cancel = local_git.start_job(&handle, &job_id, false)?;
    let progress = progress_to(&app, &handle, &job_id);
    let control = Control {
        cancel: &cancel,
        progress: &progress,
    };
    let plan = match store
        .engine
        .plan_switch(&store.repo, &request, &control, &target)
    {
        Ok((_, plan)) => plan,
        Err(error) => return local_git.finish_job(&handle, &job_id, Err(error)),
    };
    let head_now = |store: &Store| -> Result<HeadState, String> {
        let repo = store.repo.lock().map_err(|e| e.to_string())?;
        Ok(branches::resolve_head(&repo))
    };
    let mut result = SwitchResult {
        status: "completed",
        conflicts: plan.restore.conflicts.clone(),
        plan,
        operation: None,
        applied: 0,
        error: None,
        verification: None,
        head: head_now(&store)?,
    };
    if !result.conflicts.is_empty() {
        result.status = "refused";
        return local_git.finish_job(&handle, &job_id, Ok(result));
    }
    if dry_run {
        result.status = "planned";
        return local_git.finish_job(&handle, &job_id, Ok(result));
    }
    // The last point to cancel, and the last check this is still the window's workspace.
    if cancel.load(Ordering::SeqCst) {
        return local_git.finish_job(&handle, &job_id, Err(LgError::Cancelled));
    }
    let workspace_id = {
        let inner = local_git.inner.lock().map_err(|e| e.to_string())?;
        inner
            .handles
            .get(&handle)
            .ok_or(CLOSED)?
            .workspace_id
            .clone()
    };
    if !workspace_is_open(&workspace, &workspace_id) {
        return Err("NotInWorkspace: the workspace was left before the switch began".into());
    }
    let carried = carry_out(&watch, &store, &result.plan.restore, &progress);
    result.status = carried.status;
    result.operation = carried.operation;
    result.applied = carried.applied;
    result.error = carried.error;
    result.verification = carried.verification;
    if !carried.conflicts.is_empty() {
        result.conflicts = carried.conflicts;
    }
    // HEAD and the index move only once the disk is verified where it should be.
    if result.status == "completed" {
        let mut repo = store.repo.lock().map_err(|e| e.to_string())?;
        if let Err(error) = ide_localgit::switch::finish(&mut repo, &result.plan) {
            result.status = "failed";
            result.error = Some(fail(error));
        }
    }
    result.head = head_now(&store)?;
    drop(guard);
    local_git.finish_changed(&handle, &job_id, Ok(result))
}

// --- Reset, revert and stash (LG-05) ----------------------------------------------------------

use ide_localgit::reset::{self, HardResetPlan, ResetDone, ResetMode, ResetPolicy, ResetTarget};
use ide_localgit::revert::RevertResult;
use ide_localgit::stash::{self, StashApplyPlan, StashInfo, StashList, StashPushPlan};

/// How a planned change of the disk went.
struct Carried {
    /// `completed`, `refused`, `failed` or `verificationFailed`.
    status: &'static str,
    conflicts: Vec<RestoreConflict>,
    operation: Option<u64>,
    applied: usize,
    error: Option<String>,
    verification: Option<Verification>,
}

/// Carries out a restore plan (switch, hard reset, stash): the last checks, one Module 03
/// operation recorded by Module 04, then a Full snapshot to verify it. A plan with nothing to
/// do on disk is simply complete.
fn carry_out(
    watch: &crate::Watch,
    store: &Store,
    plan: &RestorePlan,
    progress: &(dyn Fn(&Progress) + Sync),
) -> Carried {
    let mut carried = Carried {
        status: "completed",
        conflicts: Vec::new(),
        operation: None,
        applied: 0,
        error: None,
        verification: None,
    };
    if plan.operations.is_empty() {
        return carried;
    }
    let scratch = std::env::temp_dir().join("yavin-localgit-link-probe");
    match crate::localgit_restore::execute(watch, &store.repo, &store.engine, plan, &scratch) {
        crate::localgit_restore::Outcome::Refused(conflicts) => {
            carried.status = "refused";
            carried.conflicts = conflicts;
        }
        crate::localgit_restore::Outcome::Failed {
            operation,
            applied,
            error,
        } => {
            carried.status = "failed";
            carried.operation = operation;
            carried.applied = applied;
            carried.error = Some(error);
        }
        crate::localgit_restore::Outcome::Done { operation, applied } => {
            carried.operation = Some(operation);
            carried.applied = applied;
            let settled = AtomicBool::new(false);
            match store.engine.verify_restore(
                &store.repo,
                &Control {
                    cancel: &settled,
                    progress,
                },
                plan,
            ) {
                Ok((_, verification)) => {
                    if !verification.matches {
                        carried.status = "verificationFailed";
                    }
                    carried.verification = Some(verification);
                }
                Err(error) => {
                    carried.status = "verificationFailed";
                    carried.error = Some(fail(error));
                }
            }
        }
    }
    carried
}

/// The last point an operation that changes the disk can stop: cancelled, or its workspace no
/// longer the window's.
fn before_changing(
    local_git: &LocalGit,
    workspace: &Workspace,
    handle: &str,
    cancel: &AtomicBool,
) -> Result<(), String> {
    if cancel.load(Ordering::SeqCst) {
        return Err(fail(LgError::Cancelled));
    }
    let workspace_id = {
        let inner = local_git.inner.lock().map_err(|e| e.to_string())?;
        inner
            .handles
            .get(handle)
            .ok_or(CLOSED)?
            .workspace_id
            .clone()
    };
    if !workspace_is_open(workspace, &workspace_id) {
        return Err("NotInWorkspace: the workspace was left before the change began".into());
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetArg {
    /// `commit`, `branch` or `tag`.
    kind: String,
    value: String,
}

fn reset_target(target: TargetArg) -> Result<ResetTarget, String> {
    match target.kind.as_str() {
        "commit" => Ok(ResetTarget::Commit(parse_id(&target.value)?)),
        "branch" => Ok(ResetTarget::Branch(target.value)),
        "tag" => Ok(ResetTarget::Tag(target.value)),
        other => Err(format!("InvalidFormat: unknown target kind {other:?}")),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetResult {
    /// `planned` (a hard reset's dry run), `refused`, `completed`, `failed`, `verificationFailed`.
    status: &'static str,
    mode: ResetMode,
    done: Option<ResetDone>,
    /// A hard reset's plan.
    plan: Option<HardResetPlan>,
    conflicts: Vec<RestoreConflict>,
    operation: Option<u64>,
    applied: usize,
    error: Option<String>,
    verification: Option<Verification>,
    head: HeadState,
}

/// Resets HEAD (its branch, or HEAD itself) to a target: `soft` (the index and working tree
/// kept), `mixed` (the index too), or `hard` (the working tree too -- refused, with every
/// conflict, when local work would be lost, unless `policy` is `allowDestructive`).
#[allow(clippy::too_many_arguments)]
#[tauri::command(async)]
pub fn localgit_reset(
    app: AppHandle,
    workspace: State<'_, Workspace>,
    watch: State<'_, crate::Watch>,
    local_git: State<'_, LocalGit>,
    handle: String,
    job_id: String,
    target: TargetArg,
    mode: String,
    policy: String,
    dry_run: bool,
    overlays: Vec<OverlayRef>,
) -> Result<ResetResult, String> {
    let target = reset_target(target)?;
    let policy = match policy.as_str() {
        "refuseIfDirty" => ResetPolicy::RefuseIfDirty,
        "allowDestructive" => ResetPolicy::AllowDestructive,
        other => return Err(format!("InvalidFormat: unknown reset policy {other:?}")),
    };
    let (store, request) = prepare(&local_git, &handle, "full", true, &overlays, &[])?;
    let _only = if dry_run {
        None
    } else {
        Some(exclusive(&store)?)
    };
    let head_now = |store: &Store| -> Result<HeadState, String> {
        Ok(branches::resolve_head(
            &*store.repo.lock().map_err(|e| e.to_string())?,
        ))
    };
    let simple =
        |mode: ResetMode, done: Result<ResetDone, LgError>| -> Result<ResetResult, String> {
            let done = done.map_err(fail)?;
            Ok(ResetResult {
                status: "completed",
                mode,
                head: done.head.clone(),
                done: Some(done),
                plan: None,
                conflicts: Vec::new(),
                operation: None,
                applied: 0,
                error: None,
                verification: None,
            })
        };
    match mode.as_str() {
        "soft" if !dry_run => {
            let mut repo = store.repo.lock().map_err(|e| e.to_string())?;
            return simple(
                ResetMode::Soft,
                reset::reset_soft(&mut repo, store.engine.folders(), &target),
            );
        }
        "mixed" if !dry_run => {
            let mut repo = store.repo.lock().map_err(|e| e.to_string())?;
            return simple(ResetMode::Mixed, reset::reset_mixed(&mut repo, &target));
        }
        "hard" => {}
        _ => {
            return Err(format!(
                "InvalidFormat: unknown reset mode {mode:?} (dry runs are for hard resets)"
            ))
        }
    }
    let cancel = local_git.start_job(&handle, &job_id, false)?;
    let progress = progress_to(&app, &handle, &job_id);
    let control = Control {
        cancel: &cancel,
        progress: &progress,
    };
    let plan = match store
        .engine
        .plan_reset_hard(&store.repo, &request, &control, &target, policy)
    {
        Ok((_, plan)) => plan,
        Err(error) => return local_git.finish_job(&handle, &job_id, Err(error)),
    };
    let mut result = ResetResult {
        status: "completed",
        mode: ResetMode::Hard,
        done: None,
        conflicts: plan.restore.conflicts.clone(),
        plan: Some(plan),
        operation: None,
        applied: 0,
        error: None,
        verification: None,
        head: head_now(&store)?,
    };
    if !result.conflicts.is_empty() || dry_run {
        result.status = if result.conflicts.is_empty() {
            "planned"
        } else {
            "refused"
        };
        return local_git.finish_job(&handle, &job_id, Ok(result));
    }
    before_changing(&local_git, &workspace, &handle, &cancel)?;
    let plan = result.plan.clone().expect("a hard reset has a plan");
    let carried = carry_out(&watch, &store, &plan.restore, &progress);
    result.status = carried.status;
    result.conflicts = carried.conflicts;
    result.operation = carried.operation;
    result.applied = carried.applied;
    result.error = carried.error;
    result.verification = carried.verification;
    if result.status == "completed" {
        let mut repo = store.repo.lock().map_err(|e| e.to_string())?;
        match reset::finish_hard(&mut repo, &plan) {
            Ok(done) => result.done = Some(done),
            Err(error) => {
                result.status = "failed";
                result.error = Some(fail(error));
            }
        }
    }
    result.head = head_now(&store)?;
    local_git.finish_changed(&handle, &job_id, Ok(result))
}

/// Reverts a commit: a new commit, made from the index, that undoes it (refused, with every
/// conflict, when it would take a merge or lose local work). The working tree is not touched.
#[allow(clippy::too_many_arguments)]
#[tauri::command(async)]
pub fn localgit_revert(
    app: AppHandle,
    local_git: State<'_, LocalGit>,
    handle: String,
    job_id: String,
    commit: String,
    message: Option<String>,
    overlays: Vec<OverlayRef>,
    by: Signature,
) -> Result<RevertResult, String> {
    let commit = parse_id(&commit)?;
    let (store, request) = prepare(&local_git, &handle, "full", false, &overlays, &[])?;
    let _only = exclusive(&store)?;
    let cancel = local_git.start_job(&handle, &job_id, false)?;
    let progress = progress_to(&app, &handle, &job_id);
    let request_by = commit_request(String::new(), by);
    let result = store
        .engine
        .revert(
            &store.repo,
            &request,
            &Control {
                cancel: &cancel,
                progress: &progress,
            },
            commit,
            message,
            &request_by,
        )
        .map(|(_, result)| result);
    local_git.finish_job(&handle, &job_id, result)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashPushResult {
    /// `refused`, `completed` (stashed and cleaned), `failed` (stashed; cleaning stopped
    /// partway), `verificationFailed` (stashed; the disk did not verify).
    status: &'static str,
    /// The stash, once it is durable.
    stash: Option<StashInfo>,
    plan: StashPushPlan,
    conflicts: Vec<RestoreConflict>,
    operation: Option<u64>,
    applied: usize,
    error: Option<String>,
    verification: Option<Verification>,
}

/// Stashes the workspace's changes (staged and unstaged apart, unsaved documents included,
/// untracked files when asked): the stash is made durable first, and only then is the
/// workspace cleaned back to HEAD.
#[allow(clippy::too_many_arguments)]
#[tauri::command(async)]
pub fn localgit_stash_push(
    app: AppHandle,
    workspace: State<'_, Workspace>,
    watch: State<'_, crate::Watch>,
    local_git: State<'_, LocalGit>,
    handle: String,
    job_id: String,
    message: Option<String>,
    include_untracked: bool,
    overlays: Vec<OverlayRef>,
    by: Signature,
) -> Result<StashPushResult, String> {
    let (store, request) = prepare(&local_git, &handle, "full", true, &overlays, &[])?;
    let _only = exclusive(&store)?;
    let cancel = local_git.start_job(&handle, &job_id, false)?;
    let progress = progress_to(&app, &handle, &job_id);
    let control = Control {
        cancel: &cancel,
        progress: &progress,
    };
    let plan = match store.engine.plan_stash_push(
        &store.repo,
        &request,
        &control,
        message,
        include_untracked,
    ) {
        Ok((_, plan)) => plan,
        Err(error) => return local_git.finish_job(&handle, &job_id, Err(error)),
    };
    let mut result = StashPushResult {
        status: "completed",
        stash: None,
        conflicts: plan.restore.conflicts.clone(),
        plan,
        operation: None,
        applied: 0,
        error: None,
        verification: None,
    };
    if !result.conflicts.is_empty() {
        result.status = "refused";
        return local_git.finish_job(&handle, &job_id, Ok(result));
    }
    before_changing(&local_git, &workspace, &handle, &cancel)?;
    let result = finish_stash_push(
        &watch,
        &store,
        result,
        &commit_request(String::new(), by),
        &progress,
    )?;
    local_git.finish_changed(&handle, &job_id, Ok(result))
}

/// A stash push once planned without conflicts: the stash made durable first, then the
/// workspace cleaned. If the executor's last checks refuse the cleaning -- nothing was touched --
/// the just-made stash is dropped again, so the workspace (which still has every change) and the
/// stash list are exactly as before. If cleaning fails partway, or the disk does not verify, the
/// stash stays: it holds everything that was there.
fn finish_stash_push(
    watch: &crate::Watch,
    store: &Store,
    mut result: StashPushResult,
    by: &CommitRequest,
    progress: &(dyn Fn(&Progress) + Sync),
) -> Result<StashPushResult, String> {
    // Durable first: if this fails, nothing in the workspace has changed.
    let stash = {
        let mut repo = store.repo.lock().map_err(|e| e.to_string())?;
        stash::record(&mut repo, &result.plan, by).map_err(fail)?
    };
    let carried = carry_out(watch, store, &result.plan.restore, progress);
    result.status = carried.status;
    result.conflicts = carried.conflicts;
    result.operation = carried.operation;
    result.applied = carried.applied;
    result.error = carried.error;
    result.verification = carried.verification;
    let mut repo = store.repo.lock().map_err(|e| e.to_string())?;
    match result.status {
        "completed" => {
            if let Err(error) = stash::finish_push(&mut repo) {
                result.status = "failed";
                result.error = Some(fail(error));
            }
            result.stash = Some(stash);
        }
        // The last checks refused before anything changed: the workspace still has every
        // change, so the stash is taken back rather than left as a duplicate.
        "refused" => {
            stash::drop_stash(&mut repo, &stash.id).map_err(fail)?;
        }
        // Partly cleaned, or not verified: the stash stays -- it holds what was there.
        _ => result.stash = Some(stash),
    }
    Ok(result)
}

#[tauri::command(async)]
pub fn localgit_stash_list(
    local_git: State<'_, LocalGit>,
    handle: String,
    limit: usize,
) -> Result<StashList, String> {
    local_git.with(&handle, |repo| stash::list(repo, limit))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashApplyResult {
    /// `refused`, `completed`, `failed`, `verificationFailed`.
    status: &'static str,
    plan: StashApplyPlan,
    conflicts: Vec<RestoreConflict>,
    operation: Option<u64>,
    applied: usize,
    error: Option<String>,
    verification: Option<Verification>,
    /// Whether the stash is still there (always, unless a pop completed).
    kept: bool,
}

/// Applies a stash (`pop`: and removes it, only once everything succeeded). Refused, with every
/// conflict, before anything changes.
#[allow(clippy::too_many_arguments)]
#[tauri::command(async)]
pub fn localgit_stash_apply(
    app: AppHandle,
    workspace: State<'_, Workspace>,
    watch: State<'_, crate::Watch>,
    local_git: State<'_, LocalGit>,
    handle: String,
    job_id: String,
    id: String,
    pop: bool,
    overlays: Vec<OverlayRef>,
) -> Result<StashApplyResult, String> {
    let (store, request) = prepare(&local_git, &handle, "full", true, &overlays, &[])?;
    let _only = exclusive(&store)?;
    let cancel = local_git.start_job(&handle, &job_id, false)?;
    let progress = progress_to(&app, &handle, &job_id);
    let control = Control {
        cancel: &cancel,
        progress: &progress,
    };
    let plan = match store
        .engine
        .plan_stash_apply(&store.repo, &request, &control, &id, pop)
    {
        Ok((_, plan)) => plan,
        Err(error) => return local_git.finish_job(&handle, &job_id, Err(error)),
    };
    let mut result = StashApplyResult {
        status: "completed",
        conflicts: plan.restore.conflicts.clone(),
        plan,
        operation: None,
        applied: 0,
        error: None,
        verification: None,
        kept: true,
    };
    if !result.conflicts.is_empty() {
        result.status = "refused";
        return local_git.finish_job(&handle, &job_id, Ok(result));
    }
    before_changing(&local_git, &workspace, &handle, &cancel)?;
    let carried = carry_out(&watch, &store, &result.plan.restore, &progress);
    result.status = carried.status;
    result.conflicts = carried.conflicts;
    result.operation = carried.operation;
    result.applied = carried.applied;
    result.error = carried.error;
    result.verification = carried.verification;
    if result.status == "completed" {
        let mut repo = store.repo.lock().map_err(|e| e.to_string())?;
        match stash::finish_apply(&mut repo, &result.plan) {
            Ok(()) => result.kept = !result.plan.pop,
            Err(error) => {
                result.status = "failed";
                result.error = Some(fail(error));
            }
        }
    }
    local_git.finish_changed(&handle, &job_id, Ok(result))
}

/// Removes a stash (its ref; the objects stay until GC).
#[tauri::command(async)]
pub fn localgit_stash_drop(
    local_git: State<'_, LocalGit>,
    handle: String,
    id: String,
) -> Result<(), String> {
    let store = local_git.handle_store(&handle)?;
    let _only = exclusive(&store)?;
    let mut repo = store.repo.lock().map_err(|e| e.to_string())?;
    stash::drop_stash(&mut repo, &id).map_err(fail)
}

#[cfg(test)]
mod lg05_push_tests {
    use super::*;
    use ide_localgit::branches::index_state;
    use ide_localgit::index::{stage, stage_all, StagePath};
    use ide_workspace::recovery::IntentLog;

    fn put(path: &std::path::Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn listing(dir: &std::path::Path) -> Vec<(String, Vec<u8>)> {
        let mut out = Vec::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(at) = stack.pop() {
            for entry in std::fs::read_dir(&at).unwrap().flatten() {
                let path = entry.path();
                let rel = path
                    .strip_prefix(dir)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                if path.is_dir() {
                    out.push((format!("{rel}/"), Vec::new()));
                    stack.push(path);
                } else {
                    out.push((rel, std::fs::read(&path).unwrap()));
                }
            }
        }
        out.sort();
        out
    }

    fn by() -> CommitRequest {
        CommitRequest {
            message: "base".into(),
            author: Author {
                name: "T".into(),
                id: "t".into(),
            },
            time_ms: 0,
            tz_offset_min: 0,
        }
    }

    /// The exact path `localgit_stash_push` takes when the executor's final checks refuse the
    /// cleaning: the stash was made durable, nothing in the workspace was touched, and the stash
    /// is dropped again -- HEAD, the index, the working tree and every document's text exactly as
    /// before, nothing lost, nothing left behind.
    #[test]
    fn a_stash_whose_final_cleanup_is_refused_is_dropped_and_the_workspace_is_untouched() {
        let dir = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "yavin-localgit-lg05-push-refused-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let project = dir.join("project");
        std::fs::create_dir_all(&project).unwrap();
        let spec = WorkspaceSpec::from_paths(&[&project]).unwrap();
        let repo = Repository::open(&dir.join("base"), &spec, OpenOptions::default()).unwrap();
        let record = repo.meta().folders[0].clone();
        let engine = SnapshotEngine::new(
            vec![FolderRoot {
                folder_id: FolderId::new(&record.folder_id).unwrap(),
                path: project.clone(),
                resource_id: record.resource_id,
            }],
            repo.meta().max_blob_bytes,
        );
        let store = Store {
            repo: Arc::new(Mutex::new(repo)),
            engine: Arc::new(engine),
            mutating: Arc::new(Mutex::new(())),
        };
        let watch = crate::Watch::default();
        watch
            .intents
            .set(Ok(IntentLog::open(&dir.join("recovery")).unwrap()))
            .unwrap();
        let cancel = AtomicBool::new(false);
        let control = Control {
            cancel: &cancel,
            progress: &|_| {},
        };

        // (a) A committed base, then staged and unstaged work, an untracked file, and an
        // unsaved document.
        put(&project.join("foo.txt"), "A");
        put(&project.join("bar.txt"), "bar");
        put(&project.join("doc.txt"), "doc on disk");
        stage_all(
            &store.engine,
            &store.repo,
            &SnapshotRequest::default(),
            &control,
        )
        .unwrap();
        history::commit_index(&mut store.repo.lock().unwrap(), &by()).unwrap();
        put(&project.join("foo.txt"), "B (staged)");
        stage(
            &store.engine,
            &store.repo,
            &SnapshotRequest::default(),
            &control,
            &[StagePath {
                folder: None,
                path: "foo.txt".into(),
            }],
        )
        .unwrap();
        put(&project.join("foo.txt"), "C (unstaged)");
        put(&project.join("bar.txt"), "bar, changed");
        put(&project.join("untracked.txt"), "mine");
        let unsaved = OverlayInput {
            path: ide_workspace::file_tree::clean_path_str(project.join("doc.txt")),
            bytes: Arc::new(b"unsaved text".to_vec()),
            encoding: "utf8".into(),
            line_ending: "lf".into(),
            version: 7,
        };
        let request = SnapshotRequest {
            overlays: vec![unsaved],
            ..Default::default()
        };
        let (plan, stashes_before) = {
            let (_, plan) = store
                .engine
                .plan_stash_push(&store.repo, &request, &control, None, true)
                .unwrap();
            let repo = store.repo.lock().unwrap();
            (plan, stash::list(&repo, 100).unwrap().total)
        };
        assert!(
            plan.restore.conflicts.is_empty(),
            "{:?}",
            plan.restore.conflicts
        );
        assert_eq!(plan.counts.staged, 1);
        assert!(
            plan.restore.operations.len() >= 3,
            "foo, bar and the untracked file to clean"
        );
        assert_eq!(
            plan.restore.documents.len(),
            1,
            "the unsaved document was to be replaced"
        );

        // (b) Between the plan and the cleaning, another program writes a file the cleaning
        // would change: the executor's final checks must refuse, before touching anything.
        put(
            &project.join("bar.txt"),
            "bar, changed again by someone else",
        );
        let head_before = branches::resolve_head(&store.repo.lock().unwrap());
        let index_before = index_state(&store.repo.lock().unwrap()).unwrap().root;
        let disk_before = listing(&project);

        let result = StashPushResult {
            status: "completed",
            stash: None,
            conflicts: Vec::new(),
            plan,
            operation: None,
            applied: 0,
            error: None,
            verification: None,
        };
        let result = finish_stash_push(&watch, &store, result, &by(), &|_| {}).unwrap();

        // (c) The push failed, and says why.
        assert_eq!(result.status, "refused");
        assert!(result.stash.is_none());
        assert!(result
            .conflicts
            .iter()
            .any(|c| matches!(c, RestoreConflict::DiskChangedSinceSnapshot { path, .. } if path == "bar.txt")));
        assert_eq!(result.applied, 0, "(h) no operation was carried out");
        let repo = store.repo.lock().unwrap();
        // (d) No stash remains -- it was made durable, and then dropped.
        assert_eq!(stash::list(&repo, 100).unwrap().total, stashes_before);
        let reflog: Vec<String> = repo
            .reflog()
            .unwrap()
            .into_iter()
            .filter_map(|r| match r {
                ReflogRecord::Update { op, reason, .. } if op == "stash" => Some(reason),
                _ => None,
            })
            .collect();
        assert_eq!(reflog.len(), 2, "pushed, then dropped: {reflog:?}");
        assert!(reflog[0].starts_with("push ") && reflog[1].starts_with("drop "));
        // (e) HEAD and (f) the index are unchanged.
        assert_eq!(branches::resolve_head(&repo), head_before);
        assert_eq!(index_state(&repo).unwrap().root, index_before);
        assert!(repo.verify(true).is_empty());
        drop(repo);
        // (g, h, i) The working tree is exactly as it was -- the staged, the unstaged and the
        // untracked work all there, nothing half cleaned -- and the unsaved document was never
        // written (its text lives only in the editor, untouched).
        assert_eq!(listing(&project), disk_before);
        assert_eq!(
            std::fs::read(project.join("foo.txt")).unwrap(),
            b"C (unstaged)"
        );
        assert_eq!(
            std::fs::read(project.join("untracked.txt")).unwrap(),
            b"mine"
        );
        assert_eq!(
            std::fs::read(project.join("doc.txt")).unwrap(),
            b"doc on disk"
        );
        // No file operation was even recorded for recovery.
        let records = std::fs::read_dir(dir.join("recovery").join("instances"))
            .into_iter()
            .flatten()
            .flatten()
            .flat_map(|i| std::fs::read_dir(i.path()).into_iter().flatten().flatten())
            .filter(|f| f.file_name().to_string_lossy().starts_with("op-"))
            .count();
        assert_eq!(records, 0);
        drop(watch);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
