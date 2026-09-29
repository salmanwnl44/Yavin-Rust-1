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
