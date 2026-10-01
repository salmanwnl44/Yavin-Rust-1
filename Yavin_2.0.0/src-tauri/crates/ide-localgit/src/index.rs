//! The Local Index (LG-04): the exact tree the next commit will have.
//!
//! It is Local Git's own staging area and has nothing to do with the real Git index: it is a
//! ref, `refs/yavin/index`, naming a commit whose root is the staged tree (see
//! `branches::index_update`). Staging never writes the working tree and never saves a
//! document; unstaging never touches either.
//!
//! - **Stage** takes paths from the workspace as the user has it -- an LG-02 snapshot, unsaved
//!   documents included, LG-02's exclusions applied, persisted so every object the index names
//!   is stored -- and grafts them into the index's tree: a file's new content, a deletion (the
//!   entry removed, never a zero-byte file), a whole directory. A file over the storage limit
//!   is staged as it is recorded everywhere else, hashed but not stored, and reported.
//! - **Unstage** grafts the same paths back from HEAD (nothing when HEAD is unborn), with no
//!   scan at all.
//! - **Stage all / unstage all**: the index becomes the workspace's tree, or HEAD's.
//! - **Partial staging** (`stage_hunks`) applies chosen hunks of the index-to-workspace line
//!   diff (the LG-03 diff, `diff::apply_hunks`) to the index's text. Refused for binary files,
//!   for content that is not stored, and when the diff changed since the caller saw it.
//!
//! Every change is one published transaction and one compare-and-swap of the index ref: the
//! index is the old tree or the new one, never partly written.

use crate::branches::{index_state, index_update, resolve_head};
use crate::error::{LgError, Result};
use crate::id::ObjectId;
use crate::object::{EntryKind, EntryName, FolderId, Root, Stored, Tree, TreeEntry};
use crate::repository::{Repository, WriteTxn};
use crate::scan::TreeLookup;
use crate::snapshot::{
    Control, FolderRoot, ObjectIdText, Snapshot, SnapshotEngine, SnapshotRequest,
};
use crate::status::{find, tree_of};
use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::Mutex;

/// Reads trees from the store (everything an index is made of is stored).
struct StoreTrees<'a>(&'a Repository);

impl TreeLookup for StoreTrees<'_> {
    fn tree(&self, id: &ObjectId) -> Option<Tree> {
        if *id == Tree::default().id() {
            return Some(Tree::default());
        }
        self.0.read_tree(id).ok()
    }
}

/// `dir` with the entry at `names` set to `entry` (removed when `None`), writing the new trees
/// through `txn`. Folders on the way are made as needed; a folder a removal leaves empty is
/// removed too unless `keep` says it should stay (it is an empty folder where the content comes
/// from).
pub(crate) fn graft(
    txn: &mut WriteTxn<'_>,
    pending: &mut Pending,
    dir: Option<&Tree>,
    prefix: &str,
    names: &[&str],
    entry: Option<&TreeEntry>,
    keep: &dyn Fn(&str) -> bool,
) -> Result<Tree> {
    let (first, rest) = names
        .split_first()
        .ok_or_else(|| LgError::InvalidName("an empty path".into()))?;
    let here = if prefix.is_empty() {
        first.to_string()
    } else {
        format!("{prefix}/{first}")
    };
    let mut entries: Vec<TreeEntry> = dir.map(|d| d.entries().to_vec()).unwrap_or_default();
    let at = entries.iter().position(|e| e.name.as_str() == *first);
    if rest.is_empty() {
        if let Some(at) = at {
            entries.remove(at);
        }
        if let Some(entry) = entry {
            entries.push(TreeEntry {
                name: EntryName::new(first)?,
                ..entry.clone()
            });
        }
    } else {
        let child = match at.map(|at| &entries[at]) {
            Some(existing) if existing.kind == EntryKind::Directory => {
                Some(pending.read(txn.repository(), &existing.id)?)
            }
            _ => None,
        };
        if entry.is_none() && child.is_none() {
            // Nothing there to remove.
            return Tree::new(entries);
        }
        let grafted = graft(txn, pending, child.as_ref(), &here, rest, entry, keep)?;
        if let Some(at) = at {
            entries.remove(at);
        }
        if !grafted.entries().is_empty() || keep(&here) {
            let id = pending.put(txn, grafted)?;
            entries.push(TreeEntry {
                name: EntryName::new(first)?,
                kind: EntryKind::Directory,
                id,
            });
        }
    }
    Tree::new(entries)
}

/// Trees written in a transaction that is not yet published: readable from here until it is.
#[derive(Default)]
pub(crate) struct Pending {
    trees: std::collections::HashMap<ObjectId, Tree>,
}

impl Pending {
    /// Starts with trees already known in memory (an engine's last snapshot), so reading
    /// them costs no store read.
    pub(crate) fn with(trees: std::collections::HashMap<ObjectId, Tree>) -> Pending {
        Pending { trees }
    }

    pub(crate) fn put(&mut self, txn: &mut WriteTxn<'_>, tree: Tree) -> Result<ObjectId> {
        let id = txn.put_tree(&tree)?;
        self.trees.insert(id, tree);
        Ok(id)
    }

    pub(crate) fn read(&self, repo: &Repository, id: &ObjectId) -> Result<Tree> {
        if *id == Tree::default().id() {
            return Ok(Tree::default());
        }
        match self.trees.get(id) {
            Some(tree) => Ok(tree.clone()),
            None => repo.read_tree(id),
        }
    }
}

/// A lookup through `Pending`, then the store.
pub(crate) struct PendingTrees<'a> {
    pub(crate) pending: &'a Pending,
    pub(crate) repo: &'a Repository,
}

impl TreeLookup for PendingTrees<'_> {
    fn tree(&self, id: &ObjectId) -> Option<Tree> {
        self.pending.read(self.repo, id).ok()
    }
}

/// A path in one of the workspace's folders.
#[derive(Clone, Debug)]
pub struct StagePath {
    /// None: the workspace's only folder.
    pub folder: Option<FolderId>,
    /// Folder-relative, `/`-separated; `""` is the whole folder.
    pub path: String,
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

fn names_of(path: &str) -> Result<Vec<&str>> {
    let names: Vec<&str> = path.split('/').filter(|n| !n.is_empty()).collect();
    for name in &names {
        EntryName::new(name)?;
    }
    Ok(names)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexInfo {
    /// The commit the index ref names (HEAD's own when nothing is staged); none when empty.
    pub commit: Option<ObjectIdText>,
    pub root: Option<ObjectIdText>,
    /// Nothing is staged: the index is HEAD's tree.
    pub equals_head: bool,
    pub revision: u64,
}

pub fn index_info(repo: &Repository) -> Result<IndexInfo> {
    let state = index_state(repo)?;
    let head = resolve_head(repo).commit();
    let head_root = match head {
        Some(id) => Some(repo.read_commit(&id)?.root),
        None => None,
    };
    Ok(IndexInfo {
        commit: state.commit.map(ObjectIdText),
        root: state.root.map(ObjectIdText),
        equals_head: state.root == head_root || (head_root.is_none() && state.root.is_none()),
        revision: repo.refs().revision,
    })
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageResult {
    pub index: IndexInfo,
    /// Paths whose index entry changed.
    pub changed: Vec<String>,
    /// Paths asked for that were already as the source has them.
    pub unchanged: Vec<String>,
    /// Files staged hashed but not stored (over the storage limit).
    pub unstored: Vec<String>,
    /// The snapshot staging read (none for unstaging).
    pub snapshot: Option<Snapshot>,
}

/// Collects the unstored files under `entry` (itself included).
fn unstored_under(lookup: &dyn TreeLookup, path: &str, entry: &TreeEntry, out: &mut Vec<String>) {
    match entry.kind {
        EntryKind::File {
            stored: Stored::No { .. },
            ..
        } => out.push(path.into()),
        EntryKind::Directory => {
            if let Some(tree) = lookup.tree(&entry.id) {
                for child in tree.entries() {
                    unstored_under(
                        lookup,
                        &format!("{path}/{}", child.name.as_str()),
                        child,
                        out,
                    );
                }
            }
        }
        _ => {}
    }
}

/// Grafts `paths` from `source` (folder -> tree; a missing folder is empty) into the index,
/// and moves the index ref. `keep_from` is the tree whose empty folders are kept.
fn set_paths(
    repo: &mut Repository,
    folders: &[FolderRoot],
    source: &BTreeMap<FolderId, ObjectId>,
    paths: &[StagePath],
    op: &str,
    memory: std::collections::HashMap<ObjectId, Tree>,
) -> Result<(Vec<String>, Vec<String>, Vec<String>)> {
    let index = index_state(repo)?;
    let mut trees = index.folders.clone();
    let (mut changed, mut unchanged, mut unstored) = (Vec::new(), Vec::new(), Vec::new());
    let empty = Tree::default().id();
    let mut txn = repo.begin_write()?;
    let mut pending = Pending::with(memory);
    for asked in paths {
        let folder = folder_of(folders, &asked.folder)?;
        let names = names_of(&asked.path)?;
        let label = format!("{}:{}", folder.as_str(), names.join("/"));
        let from = source.get(&folder).copied().unwrap_or(empty);
        let current = trees.get(&folder).copied().unwrap_or(empty);
        let lookup = PendingTrees {
            pending: &pending,
            repo: txn.repository(),
        };
        if names.is_empty() {
            // The whole folder.
            if from == current {
                unchanged.push(label);
            } else {
                if let Some(tree) = lookup.tree(&from) {
                    for child in tree.entries() {
                        unstored_under(&lookup, child.name.as_str(), child, &mut unstored);
                    }
                }
                trees.insert(folder, from);
                changed.push(label);
            }
            continue;
        }
        let path = names.join("/");
        let wanted = find(&lookup, Some(from), &path)?;
        let now = find(&lookup, Some(current), &path)?;
        let same = match (&wanted, &now) {
            (None, None) => true,
            (Some(a), Some(b)) => a.id == b.id && a.kind == b.kind,
            _ => false,
        };
        if same {
            unchanged.push(label);
            continue;
        }
        if let Some(entry) = &wanted {
            unstored_under(&lookup, &path, entry, &mut unstored);
        }
        let base = tree_of(&lookup, &current)?;
        let keep = |dir: &str| {
            find(&lookup, Some(from), dir)
                .ok()
                .flatten()
                .is_some_and(|e| e.kind == EntryKind::Directory)
        };
        let keep_owned: Vec<String> = (1..names.len())
            .map(|n| names[..n].join("/"))
            .filter(|dir| keep(dir))
            .collect();
        let tree = graft(
            &mut txn,
            &mut pending,
            Some(&base),
            "",
            &names,
            wanted.as_ref(),
            &|dir: &str| keep_owned.iter().any(|k| k == dir),
        )?;
        let id = pending.put(&mut txn, tree)?;
        trees.insert(folder, id);
        changed.push(label);
    }
    for folder in folders {
        let id = *trees.entry(folder.folder_id.clone()).or_insert(empty);
        if id == empty {
            txn.put_tree(&Tree::default())?;
        }
    }
    txn.commit()?;
    if !changed.is_empty() {
        let root = Root {
            folders: folders
                .iter()
                .map(|f| (f.folder_id.clone(), trees[&f.folder_id]))
                .collect(),
        };
        if let Some(update) = index_update(repo, root)? {
            let revision = repo.refs().revision;
            repo.update_refs(revision, &[update], None, op, &changed.join(", "))?;
        }
    }
    Ok((changed, unchanged, unstored))
}

/// The snapshot staging reads: persisted (so every object the index will name is stored),
/// incremental from a warm engine, with the unsaved documents.
fn staging_snapshot(
    engine: &SnapshotEngine,
    repo: &Mutex<Repository>,
    request: &SnapshotRequest,
    control: &Control,
) -> Result<Snapshot> {
    let mut request = request.clone();
    request.persist = true;
    request.allow_incremental_persist = true;
    engine.snapshot(repo, &request, control)
}

fn effective_folders(snapshot: &Snapshot) -> Result<BTreeMap<FolderId, ObjectId>> {
    snapshot
        .folders
        .iter()
        .map(|f| Ok((FolderId::new(&f.folder_id)?, f.effective_tree.0)))
        .collect()
}

/// Stages `paths` as the workspace has them now (unsaved documents included).
pub fn stage(
    engine: &SnapshotEngine,
    repo: &Mutex<Repository>,
    request: &SnapshotRequest,
    control: &Control,
    paths: &[StagePath],
) -> Result<StageResult> {
    crate::operation::ensure_idle(&repo.lock().unwrap())?;
    let snapshot = staging_snapshot(engine, repo, request, control)?;
    let source = effective_folders(&snapshot)?;
    let mut repo = repo.lock().unwrap();
    let (changed, unchanged, unstored) = set_paths(
        &mut repo,
        engine.folders(),
        &source,
        paths,
        "stage",
        engine.memory_trees(),
    )?;
    Ok(StageResult {
        index: index_info(&repo)?,
        changed,
        unchanged,
        unstored,
        snapshot: Some(snapshot),
    })
}

/// Stages everything: the index becomes the workspace's tree.
pub fn stage_all(
    engine: &SnapshotEngine,
    repo: &Mutex<Repository>,
    request: &SnapshotRequest,
    control: &Control,
) -> Result<StageResult> {
    let paths: Vec<StagePath> = engine
        .folders()
        .iter()
        .map(|f| StagePath {
            folder: Some(f.folder_id.clone()),
            path: String::new(),
        })
        .collect();
    stage(engine, repo, request, control, &paths)
}

fn head_folders(repo: &Repository) -> Result<BTreeMap<FolderId, ObjectId>> {
    match resolve_head(repo).commit() {
        Some(id) => {
            let root = repo.read_commit(&id)?.root;
            Ok(repo.read_root(&root)?.folders)
        }
        None => Ok(BTreeMap::new()),
    }
}

/// Unstages `paths`: their index entries become HEAD's again (nothing, when HEAD is unborn).
/// The working tree and the documents are not touched.
pub fn unstage(
    repo: &mut Repository,
    folders: &[FolderRoot],
    paths: &[StagePath],
) -> Result<StageResult> {
    crate::operation::ensure_idle(repo)?;
    let source = head_folders(repo)?;
    let (changed, unchanged, unstored) =
        set_paths(repo, folders, &source, paths, "unstage", Default::default())?;
    Ok(StageResult {
        index: index_info(repo)?,
        changed,
        unchanged,
        unstored,
        snapshot: None,
    })
}

/// Unstages everything: the index becomes HEAD's tree (empty when HEAD is unborn).
pub fn unstage_all(repo: &mut Repository, folders: &[FolderRoot]) -> Result<StageResult> {
    let paths: Vec<StagePath> = folders
        .iter()
        .map(|f| StagePath {
            folder: Some(f.folder_id.clone()),
            path: String::new(),
        })
        .collect();
    unstage(repo, folders, &paths)
}

/// Stages chosen hunks of one file's index-to-workspace diff. `expected` are the index's and
/// the workspace's blob ids the caller's diff was made from (`None` for a side without the
/// file); hunks are numbered as that diff numbers them.
#[allow(clippy::too_many_arguments)]
pub fn stage_hunks(
    engine: &SnapshotEngine,
    repo: &Mutex<Repository>,
    request: &SnapshotRequest,
    control: &Control,
    folder: Option<FolderId>,
    path: &str,
    hunks: &[usize],
    expected: (Option<ObjectId>, Option<ObjectId>),
) -> Result<StageResult> {
    crate::operation::ensure_idle(&repo.lock().unwrap())?;
    let snapshot = staging_snapshot(engine, repo, request, control)?;
    let source = effective_folders(&snapshot)?;
    let mut repo = repo.lock().unwrap();
    let folder = folder_of(engine.folders(), &folder)?;
    let names = names_of(path)?;
    let path = names.join("/");
    let empty = Tree::default().id();
    let index = index_state(&repo)?;
    let lookup = StoreTrees(&repo);
    let old = find(
        &lookup,
        Some(index.folders.get(&folder).copied().unwrap_or(empty)),
        &path,
    )?;
    let new = find(
        &lookup,
        Some(source.get(&folder).copied().unwrap_or(empty)),
        &path,
    )?;
    if (old.as_ref().map(|e| e.id), new.as_ref().map(|e| e.id)) != expected {
        return Err(LgError::StaleSelection(path));
    }
    let file = |entry: &Option<TreeEntry>| -> Result<Option<(Vec<u8>, bool)>> {
        match entry {
            None => Ok(None),
            Some(TreeEntry {
                kind:
                    EntryKind::File {
                        stored: Stored::No { .. },
                        ..
                    },
                ..
            }) => Err(LgError::ContentUnavailableForStaging(path.clone())),
            Some(TreeEntry {
                kind: EntryKind::File { executable, .. },
                id,
                ..
            }) => Ok(Some((repo.read_blob(id, u64::MAX)?, *executable))),
            Some(_) => Err(LgError::PartialStagingUnsupported(path.clone())),
        }
    };
    let old_bytes = file(&old)?;
    let Some((new_bytes, executable)) = file(&new)? else {
        // A deletion is staged whole, never in parts.
        return Err(LgError::PartialStagingUnsupported(path));
    };
    let old_bytes = old_bytes.map(|(bytes, _)| bytes).unwrap_or_default();
    if crate::diff::is_binary(&old_bytes) || crate::diff::is_binary(&new_bytes) {
        return Err(LgError::PartialStagingUnsupported(path));
    }
    let merged = crate::diff::apply_hunks(&old_bytes, &new_bytes, hunks, 3)
        .map_err(|why| LgError::StaleSelection(format!("{path}: {why}")))?;
    let mut txn = repo.begin_write()?;
    let blob = txn.put_blob(&merged)?;
    txn.commit()?;
    // Staged as a file with the chosen content; the workspace's file keeps the rest.
    let entry = TreeEntry {
        name: EntryName::new(names.last().expect("a file has a name"))?,
        kind: EntryKind::File {
            executable,
            stored: Stored::Yes,
        },
        id: blob,
    };
    let mut staged = index.folders.clone();
    let mut txn = repo.begin_write()?;
    let base = match index.folders.get(&folder) {
        Some(id) => Some(txn.repository().read_tree(id)?),
        None => None,
    };
    let mut pending = Pending::default();
    let tree = graft(
        &mut txn,
        &mut pending,
        base.as_ref(),
        "",
        &names,
        Some(&entry),
        &|_| false,
    )?;
    let id = pending.put(&mut txn, tree)?;
    staged.insert(folder.clone(), id);
    txn.commit()?;
    let root = Root {
        folders: engine
            .folders()
            .iter()
            .map(|f| {
                (
                    f.folder_id.clone(),
                    staged.get(&f.folder_id).copied().unwrap_or(empty),
                )
            })
            .collect(),
    };
    let mut changed = Vec::new();
    if let Some(update) = index_update(&mut repo, root)? {
        let revision = repo.refs().revision;
        repo.update_refs(
            revision,
            &[update],
            None,
            "stage",
            &format!("part of {path}"),
        )?;
        changed.push(format!("{}:{path}", folder.as_str()));
    }
    Ok(StageResult {
        index: index_info(&repo)?,
        unchanged: if changed.is_empty() {
            vec![format!("{}:{path}", folder.as_str())]
        } else {
            Vec::new()
        },
        changed,
        unstored: Vec::new(),
        snapshot: Some(snapshot),
    })
}
