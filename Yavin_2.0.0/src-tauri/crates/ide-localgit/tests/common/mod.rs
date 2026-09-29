#![allow(dead_code)]

use ide_localgit::*;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// A fresh directory for one test, canonicalised (the temp dir can be an 8.3 short name on CI).
pub fn temp(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().canonicalize().unwrap().join(format!(
        "yavin-localgit-{label}-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A store base directory and a workspace folder (which Local Git never writes into).
pub struct Fixture {
    pub base: PathBuf,
    pub project: PathBuf,
    pub spec: WorkspaceSpec,
}

impl Fixture {
    pub fn new(label: &str) -> Fixture {
        let root = temp(label);
        let base = root.join("appdata").join("local-git");
        let project = root.join("Project Folder");
        std::fs::create_dir_all(&project).unwrap();
        let spec = WorkspaceSpec::from_paths(&[&project]).unwrap();
        Fixture {
            base,
            project,
            spec,
        }
    }

    pub fn open(&self) -> Result<Repository> {
        Repository::open(&self.base, &self.spec, OpenOptions::default())
    }

    pub fn open_read_only(&self) -> Result<Repository> {
        Repository::open(&self.base, &self.spec, OpenOptions { read_only: true })
    }

    pub fn store(&self) -> PathBuf {
        self.base.join(self.spec.key())
    }
}

pub fn main_ref() -> RefName {
    RefName::new("refs/heads/main").unwrap()
}

/// Writes a small commit (a blob in a tree in a root) on top of `parent`; returns its id.
pub fn write_commit(repo: &mut Repository, content: &str, parent: Option<ObjectId>) -> ObjectId {
    let folder = FolderId::new(&repo.meta().folders[0].folder_id).unwrap();
    let workspace = repo.meta().workspace.clone();
    let mut txn = repo.begin_write().unwrap();
    let blob = txn.put_blob(content.as_bytes()).unwrap();
    let tree = Tree::new(vec![TreeEntry {
        name: EntryName::new("file.txt").unwrap(),
        kind: EntryKind::File {
            executable: false,
            stored: Stored::Yes,
        },
        id: blob,
    }])
    .unwrap();
    let tree = txn.put_tree(&tree).unwrap();
    let mut folders = BTreeMap::new();
    folders.insert(folder, tree);
    let root = txn.put_root(&Root { folders }).unwrap();
    let commit = txn
        .put_commit(&Commit {
            root,
            disk_root: None,
            parents: parent.into_iter().collect(),
            workspace,
            author: Author {
                name: "Test".into(),
                id: "test@yavin".into(),
            },
            time_ms: 1_790_000_000_000,
            tz_offset_min: 0,
            source: Source::Checkpoint,
            meta: BTreeMap::new(),
            meta_objects: BTreeMap::new(),
            message: format!("commit {content}"),
        })
        .unwrap();
    txn.commit().unwrap();
    commit
}

/// Moves `refs/heads/main` from what it is to `new`.
pub fn advance(repo: &mut Repository, new: ObjectId) -> u64 {
    let revision = repo.refs().revision;
    let current = repo.refs().refs.get(&main_ref()).copied();
    repo.update_refs(
        revision,
        &[RefUpdate {
            name: main_ref(),
            expected: current,
            new: Some(new),
        }],
        None,
        "test",
        "advance main",
    )
    .unwrap()
}

/// Every file under `dir`, relative, sorted: what a test compares before and after.
pub fn listing(dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let rel = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            if path.is_dir() {
                out.push(format!("{rel}/"));
                walk(root, &path, out);
            } else {
                out.push(rel);
            }
        }
    }
    walk(dir, dir, &mut out);
    out.sort();
    out
}

// --- Snapshots (LG-02) --------------------------------------------------------------------------

use std::sync::atomic::AtomicBool;
use std::sync::Mutex;

/// The snapshot engine for a fixture's store, with the store's own settings.
pub fn engine_for(repo: &Mutex<Repository>, project: &Path) -> SnapshotEngine {
    let repo = repo.lock().unwrap();
    engine_with(&repo, project, repo.meta().max_blob_bytes)
}

pub fn engine_with(repo: &Repository, project: &Path, max_blob: u64) -> SnapshotEngine {
    let folder = &repo.meta().folders[0];
    SnapshotEngine::new(
        vec![FolderRoot {
            folder_id: FolderId::new(&folder.folder_id).unwrap(),
            path: project.to_path_buf(),
            resource_id: folder.resource_id.clone(),
        }],
        max_blob,
    )
}

pub fn try_snapshot(
    engine: &SnapshotEngine,
    repo: &Mutex<Repository>,
    request: &SnapshotRequest,
) -> Result<Snapshot> {
    let cancel = AtomicBool::new(false);
    engine.snapshot(
        repo,
        request,
        &Control {
            cancel: &cancel,
            progress: &|_| {},
        },
    )
}

pub fn snapshot(engine: &SnapshotEngine, repo: &Mutex<Repository>) -> Snapshot {
    try_snapshot(engine, repo, &SnapshotRequest::default()).unwrap()
}

pub fn snapshot_mode(
    engine: &SnapshotEngine,
    repo: &Mutex<Repository>,
    mode: RequestedMode,
) -> Snapshot {
    try_snapshot(
        engine,
        repo,
        &SnapshotRequest {
            mode,
            ..Default::default()
        },
    )
    .unwrap()
}

pub fn persist(engine: &SnapshotEngine, repo: &Mutex<Repository>) -> Snapshot {
    try_snapshot(
        engine,
        repo,
        &SnapshotRequest {
            persist: true,
            ..Default::default()
        },
    )
    .unwrap()
}

pub fn status_with(
    engine: &SnapshotEngine,
    repo: &Mutex<Repository>,
    request: &SnapshotRequest,
) -> (Snapshot, Status) {
    let cancel = AtomicBool::new(false);
    engine
        .status(
            repo,
            request,
            &Control {
                cancel: &cancel,
                progress: &|_| {},
            },
            usize::MAX,
        )
        .unwrap()
}

pub fn status(engine: &SnapshotEngine, repo: &Mutex<Repository>) -> Status {
    status_with(engine, repo, &SnapshotRequest::default()).1
}

/// The id of a folder's tree in a root.
pub fn folder_tree(repo: &Repository, root: ObjectId) -> ObjectId {
    *repo
        .read_root(&root)
        .unwrap()
        .folders
        .values()
        .next()
        .unwrap()
}

/// Every entry under a stored tree: `path -> description`, e.g. `file <id>`, `file! <id>`
/// (executable), `unstored <size> <id>`, `dir`, `link:<kind> <target>`.
pub fn tree_listing(repo: &Repository, tree: ObjectId) -> BTreeMap<String, String> {
    fn walk(repo: &Repository, tree: ObjectId, prefix: &str, out: &mut BTreeMap<String, String>) {
        for entry in repo.read_tree(&tree).unwrap().entries() {
            let path = if prefix.is_empty() {
                entry.name.as_str().to_string()
            } else {
                format!("{prefix}/{}", entry.name.as_str())
            };
            let what = match entry.kind {
                EntryKind::File {
                    executable,
                    stored: Stored::Yes,
                } => format!("file{} {}", if executable { "!" } else { "" }, entry.id),
                EntryKind::File {
                    stored: Stored::No { size },
                    ..
                } => format!("unstored {size} {}", entry.id),
                EntryKind::Directory => {
                    walk(repo, entry.id, &path, out);
                    "dir".into()
                }
                EntryKind::Symlink(kind) => format!(
                    "link:{kind:?} {}",
                    String::from_utf8(repo.read_blob(&entry.id, 1 << 20).unwrap()).unwrap()
                ),
            };
            out.insert(path, what);
        }
    }
    let mut out = BTreeMap::new();
    walk(repo, tree, "", &mut out);
    out
}

/// A persisted snapshot's listing of its (only) folder's disk tree.
pub fn disk_listing(repo: &Mutex<Repository>, snapshot: &Snapshot) -> BTreeMap<String, String> {
    let repo = repo.lock().unwrap();
    let tree = folder_tree(&repo, snapshot.disk_root.0);
    tree_listing(&repo, tree)
}

/// Makes a persisted snapshot's disk root HEAD (a commit on `refs/heads/main`).
pub fn commit_root(repo: &Mutex<Repository>, root: ObjectId) -> ObjectId {
    let mut repo = repo.lock().unwrap();
    let workspace = repo.meta().workspace.clone();
    let parent = repo.refs().head_commit();
    let mut txn = repo.begin_write().unwrap();
    let commit = txn
        .put_commit(&Commit {
            root,
            disk_root: None,
            parents: parent.into_iter().collect(),
            workspace,
            author: Author {
                name: "Test".into(),
                id: "test@yavin".into(),
            },
            time_ms: 1_790_000_000_000,
            tz_offset_min: 0,
            source: Source::Checkpoint,
            meta: BTreeMap::new(),
            meta_objects: BTreeMap::new(),
            message: "head".into(),
        })
        .unwrap();
    txn.commit().unwrap();
    advance(&mut repo, commit);
    commit
}

pub fn write(path: &Path, bytes: impl AsRef<[u8]>) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(path, bytes).unwrap();
}

/// Sets a file's modification time well in the past, so the scan cache may trust it (a file
/// modified within `RACY_WINDOW_NS` of a scan is always hashed again).
pub fn age(path: &Path) {
    let file = std::fs::File::options().write(true).open(path).unwrap();
    file.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(3600))
        .unwrap();
}

/// A blob id computed independently of the snapshot code.
pub fn blob_id(bytes: &[u8]) -> ObjectId {
    hash_object(ObjectKind::Blob, bytes)
}
