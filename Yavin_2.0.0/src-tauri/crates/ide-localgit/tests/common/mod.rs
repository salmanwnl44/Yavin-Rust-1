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
