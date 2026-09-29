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
//! Errors are `"<Code>: <message>"`, the code being `LgError::code()` or `NotInWorkspace`,
//! `HandleClosed`, `Unavailable`.

use crate::{with_workspace, Workspace};
use ide_localgit::{
    EntryKind, Finding, Head, LgError, LinkKind, Mode, ObjectId, OpenOptions, ReadOnlyReason,
    ReflogRecord, Repository, Stored, WorkspaceSpec,
};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::State;

#[derive(Default)]
pub struct LocalGit {
    base: OnceLock<PathBuf>,
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    stores: HashMap<String, Arc<Mutex<Repository>>>,
    handles: HashMap<String, Handle>,
}

struct Handle {
    key: String,
    workspace_id: String,
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
            inner
                .handles
                .retain(|_, handle| Some(handle.workspace_id.as_str()) == workspace_id);
            let live: Vec<String> = inner.handles.values().map(|h| h.key.clone()).collect();
            inner.stores.retain(|key, _| live.contains(key));
        }
    }

    fn store(&self, handle: &str) -> Result<Arc<Mutex<Repository>>, String> {
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
        let store = self.store(handle)?;
        let mut repo = store.lock().map_err(|e| e.to_string())?;
        action(&mut repo).map_err(fail)
    }
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
        None => Arc::new(Mutex::new(
            Repository::open(&base, &native, OpenOptions::default()).map_err(fail)?,
        )),
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
        inner.stores.entry(key.clone()).or_insert(store.clone());
        inner.handles.insert(
            handle.clone(),
            Handle {
                key,
                workspace_id: native.workspace_id.clone(),
            },
        );
    }
    let repo = store.lock().map_err(|e| e.to_string())?;
    Ok(info(&handle, &repo))
}

/// Closes a handle; the store closes (releasing its writer lock) with its last one.
#[tauri::command]
pub fn localgit_close(local_git: State<'_, LocalGit>, handle: String) -> Result<(), String> {
    let mut inner = local_git.inner.lock().map_err(|e| e.to_string())?;
    if let Some(closed) = inner.handles.remove(&handle) {
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
