//! Status: how the workspace differs from Local HEAD, on disk and in memory.
//!
//! Three comparisons, per path:
//!
//! - **disk**: HEAD against the disk root -- what is saved;
//! - **effective**: HEAD against the effective root -- what the user has, saved or not;
//! - **memory**: for each unsaved document, its text against the disk (`differsFromDisk`,
//!   `equalsDisk`, or `openDeletedOnDisk` when the file is gone but the document is open and
//!   dirty), and whether it equals HEAD.
//!
//! Since LG-04 there are also the Local Index's two comparisons, per path:
//!
//! - **staged**: HEAD against the index -- what the next commit would change;
//! - **unstaged**: the index against the workspace as the user has it (unsaved documents
//!   included) -- what is not staged.
//!
//! (With nothing staged the index is HEAD's tree, and `unstaged` equals `effective`.)
//!
//! A change is `added`, `modified` (content, executable bit or link kind), `deleted`,
//! `typeChanged` (file, directory and link turned into one another; a directory's own files
//! are then listed as added or deleted beneath it), or `renamed` -- exactly the same content
//! (or link target) gone from one path and present at another, paired deterministically in
//! path order. Files over the storage limit take part like any other: their id is the hash of
//! their content. There is no similarity-based rename detection. An empty directory is listed
//! when it is itself added or deleted.
//!
//! This is Yavin's own model, not `git status` output.

use crate::error::{LgError, Result};
use crate::id::ObjectId;
use crate::object::{EntryKind, FolderId, LinkKind, Stored, Tree, TreeEntry};
use crate::scan::{name_key, TreeLookup};
use crate::snapshot::{FolderRoot, ObjectIdText, Snapshot};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, VecDeque};

/// HEAD (and the index) as status reads them.
pub struct Head {
    pub commit: Option<ObjectId>,
    pub root: Option<ObjectId>,
    pub trees: BTreeMap<FolderId, ObjectId>,
    /// The index's root and folders (see `branches::index_state`).
    pub index_root: Option<ObjectId>,
    pub index_trees: BTreeMap<FolderId, ObjectId>,
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EntryClass {
    File,
    Directory,
    Symlink,
}

pub(crate) fn class(kind: &EntryKind) -> EntryClass {
    match kind {
        EntryKind::File { .. } => EntryClass::File,
        EntryKind::Directory => EntryClass::Directory,
        EntryKind::Symlink(_) => EntryClass::Symlink,
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    Added,
    Modified,
    Deleted,
    TypeChanged,
    Renamed,
}

/// One side of a change.
#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Side {
    pub class: EntryClass,
    pub id: ObjectIdText,
    pub executable: bool,
    /// False for a file over the storage limit: hashed, content not stored.
    pub stored: bool,
    pub size: Option<u64>,
    /// For a link: `file`, `directory` or `junction`.
    pub link: Option<&'static str>,
}

pub(crate) fn side(entry: &TreeEntry) -> Side {
    let (executable, stored, size, link) = match entry.kind {
        EntryKind::File { executable, stored } => match stored {
            Stored::Yes => (executable, true, None, None),
            Stored::No { size } => (executable, false, Some(size), None),
        },
        EntryKind::Directory => (false, true, None, None),
        EntryKind::Symlink(kind) => (
            false,
            true,
            None,
            Some(match kind {
                LinkKind::File => "file",
                LinkKind::Directory => "directory",
                LinkKind::Junction => "junction",
            }),
        ),
    };
    Side {
        class: class(&entry.kind),
        id: ObjectIdText(entry.id),
        executable,
        stored,
        size,
        link,
    }
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub kind: ChangeKind,
    /// For a rename: where the content was.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    pub old: Option<Side>,
    pub new: Option<Side>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MemoryState {
    /// Unsaved text that is not what the file on disk holds.
    DiffersFromDisk,
    /// Unsaved (the document says so) but byte-for-byte what is on disk.
    EqualsDisk,
    /// The file is gone from disk; the document is open with unsaved text.
    OpenDeletedOnDisk,
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub state: MemoryState,
    /// Whether the unsaved text is exactly HEAD's.
    pub equals_head: bool,
    pub version: u64,
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusEntry {
    pub folder_id: String,
    /// Folder-relative, `/`-separated.
    pub path: String,
    /// HEAD against the disk.
    pub disk: Option<Change>,
    /// HEAD against what the user has (disk plus unsaved documents).
    pub effective: Option<Change>,
    /// Set when the path has an unsaved document.
    pub memory: Option<Memory>,
    /// HEAD against the index: staged.
    pub staged: Option<Change>,
    /// The index against the workspace (unsaved documents included): not staged.
    pub unstaged: Option<Change>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub added: usize,
    pub modified: usize,
    pub deleted: usize,
    pub type_changed: usize,
    pub renamed: usize,
}

impl Counts {
    fn add(&mut self, kind: ChangeKind) {
        match kind {
            ChangeKind::Added => self.added += 1,
            ChangeKind::Modified => self.modified += 1,
            ChangeKind::Deleted => self.deleted += 1,
            ChangeKind::TypeChanged => self.type_changed += 1,
            ChangeKind::Renamed => self.renamed += 1,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub head_commit: Option<ObjectIdText>,
    pub head_root: Option<ObjectIdText>,
    /// `head` when nothing is staged (the index is HEAD's tree), `staged` otherwise.
    pub index: &'static str,
    pub index_root: Option<ObjectIdText>,
    pub disk_root: ObjectIdText,
    pub effective_root: ObjectIdText,
    /// Sorted by folder, then path; at most the limit asked for.
    pub entries: Vec<StatusEntry>,
    /// How many entries there are in all.
    pub total: usize,
    pub truncated: bool,
    pub disk: Counts,
    pub effective: Counts,
    pub staged: Counts,
    pub unstaged: Counts,
    /// Unsaved documents taking part.
    pub unsaved: usize,
}

/// One change between two trees (`diff.rs` and `restore.rs` share it).
pub(crate) struct Leaf {
    pub(crate) path: String,
    pub(crate) kind: ChangeKind,
    pub(crate) old: Option<TreeEntry>,
    pub(crate) new: Option<TreeEntry>,
    pub(crate) from: Option<String>,
}

fn join(prefix: &str, name: &str) -> String {
    if prefix.is_empty() {
        name.to_string()
    } else {
        format!("{prefix}/{name}")
    }
}

pub(crate) fn tree_of(lookup: &dyn TreeLookup, id: &ObjectId) -> Result<Tree> {
    lookup.tree(id).ok_or(LgError::MissingObject(*id))
}

/// Every file, link and empty directory under the directory `entry`, as `kind`.
fn all_leaves(
    lookup: &dyn TreeLookup,
    path: &str,
    entry: &TreeEntry,
    kind: ChangeKind,
    out: &mut Vec<Leaf>,
) -> Result<()> {
    let tree = tree_of(lookup, &entry.id)?;
    if tree.entries().is_empty() {
        let (old, new) = match kind {
            ChangeKind::Added => (None, Some(entry.clone())),
            _ => (Some(entry.clone()), None),
        };
        out.push(Leaf {
            path: path.into(),
            kind,
            old,
            new,
            from: None,
        });
        return Ok(());
    }
    for child in tree.entries() {
        let child_path = join(path, child.name.as_str());
        if child.kind == EntryKind::Directory {
            all_leaves(lookup, &child_path, child, kind, out)?;
        } else {
            let (old, new) = match kind {
                ChangeKind::Added => (None, Some(child.clone())),
                _ => (Some(child.clone()), None),
            };
            out.push(Leaf {
                path: child_path,
                kind,
                old,
                new,
                from: None,
            });
        }
    }
    Ok(())
}

fn gone(lookup: &dyn TreeLookup, path: &str, entry: &TreeEntry, out: &mut Vec<Leaf>) -> Result<()> {
    if entry.kind == EntryKind::Directory {
        all_leaves(lookup, path, entry, ChangeKind::Deleted, out)
    } else {
        out.push(Leaf {
            path: path.into(),
            kind: ChangeKind::Deleted,
            old: Some(entry.clone()),
            new: None,
            from: None,
        });
        Ok(())
    }
}

fn came(lookup: &dyn TreeLookup, path: &str, entry: &TreeEntry, out: &mut Vec<Leaf>) -> Result<()> {
    if entry.kind == EntryKind::Directory {
        all_leaves(lookup, path, entry, ChangeKind::Added, out)
    } else {
        out.push(Leaf {
            path: path.into(),
            kind: ChangeKind::Added,
            old: None,
            new: Some(entry.clone()),
            from: None,
        });
        Ok(())
    }
}

/// What changed from `old` to `new` (directories), skipping every subtree whose id is equal.
fn diff(
    lookup: &dyn TreeLookup,
    prefix: &str,
    old: Option<&Tree>,
    new: Option<&Tree>,
    out: &mut Vec<Leaf>,
) -> Result<()> {
    let empty: &[TreeEntry] = &[];
    let a = old.map_or(empty, Tree::entries);
    let b = new.map_or(empty, Tree::entries);
    let (mut i, mut j) = (0, 0);
    while i < a.len() || j < b.len() {
        let order = match (a.get(i), b.get(j)) {
            (Some(x), Some(y)) => x.name.as_str().as_bytes().cmp(y.name.as_str().as_bytes()),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, _) => std::cmp::Ordering::Greater,
        };
        match order {
            std::cmp::Ordering::Less => {
                let x = &a[i];
                gone(lookup, &join(prefix, x.name.as_str()), x, out)?;
                i += 1;
            }
            std::cmp::Ordering::Greater => {
                let y = &b[j];
                came(lookup, &join(prefix, y.name.as_str()), y, out)?;
                j += 1;
            }
            std::cmp::Ordering::Equal => {
                let (x, y) = (&a[i], &b[j]);
                let path = join(prefix, x.name.as_str());
                if x.id != y.id || x.kind != y.kind {
                    let (cx, cy) = (class(&x.kind), class(&y.kind));
                    if cx == EntryClass::Directory && cy == EntryClass::Directory {
                        let (tx, ty) = (tree_of(lookup, &x.id)?, tree_of(lookup, &y.id)?);
                        diff(lookup, &path, Some(&tx), Some(&ty), out)?;
                    } else if cx == cy {
                        out.push(Leaf {
                            path,
                            kind: ChangeKind::Modified,
                            old: Some(x.clone()),
                            new: Some(y.clone()),
                            from: None,
                        });
                    } else {
                        out.push(Leaf {
                            path: path.clone(),
                            kind: ChangeKind::TypeChanged,
                            old: Some(x.clone()),
                            new: Some(y.clone()),
                            from: None,
                        });
                        let tree_x = (cx == EntryClass::Directory)
                            .then(|| tree_of(lookup, &x.id))
                            .transpose()?;
                        let tree_y = (cy == EntryClass::Directory)
                            .then(|| tree_of(lookup, &y.id))
                            .transpose()?;
                        diff(lookup, &path, tree_x.as_ref(), tree_y.as_ref(), out)?;
                    }
                }
                i += 1;
                j += 1;
            }
        }
    }
    Ok(())
}

/// Pairs content that left one path with the same content arriving at another.
fn pair_renames(leaves: Vec<Leaf>) -> Vec<Leaf> {
    let key = |entry: &TreeEntry| (class(&entry.kind), entry.id);
    let mut deleted: HashMap<(EntryClass, ObjectId), VecDeque<usize>> = HashMap::new();
    for (at, leaf) in leaves.iter().enumerate() {
        if leaf.kind == ChangeKind::Deleted {
            if let Some(old) = &leaf.old {
                if old.kind != EntryKind::Directory {
                    deleted.entry(key(old)).or_default().push_back(at);
                }
            }
        }
    }
    let mut consumed = vec![false; leaves.len()];
    let mut renames: HashMap<usize, usize> = HashMap::new();
    for (at, leaf) in leaves.iter().enumerate() {
        if leaf.kind != ChangeKind::Added {
            continue;
        }
        let Some(new) = &leaf.new else { continue };
        if new.kind == EntryKind::Directory {
            continue;
        }
        if let Some(from) = deleted.get_mut(&key(new)).and_then(VecDeque::pop_front) {
            consumed[from] = true;
            renames.insert(at, from);
        }
    }
    let olds: HashMap<usize, (String, Option<TreeEntry>)> = renames
        .values()
        .map(|&from| (from, (leaves[from].path.clone(), leaves[from].old.clone())))
        .collect();
    leaves
        .into_iter()
        .enumerate()
        .filter(|(at, _)| !consumed[*at])
        .map(|(at, mut leaf)| {
            if let Some(from) = renames.get(&at) {
                let (path, old) = olds[from].clone();
                leaf.kind = ChangeKind::Renamed;
                leaf.from = Some(path);
                leaf.old = old;
            }
            leaf
        })
        .collect()
}

pub(crate) fn changes(
    lookup: &dyn TreeLookup,
    old: Option<ObjectId>,
    new: ObjectId,
) -> Result<Vec<Leaf>> {
    if old == Some(new) {
        return Ok(Vec::new());
    }
    let old = old.map(|id| tree_of(lookup, &id)).transpose()?;
    let new = tree_of(lookup, &new)?;
    let mut out = Vec::new();
    diff(lookup, "", old.as_ref(), Some(&new), &mut out)?;
    Ok(pair_renames(out))
}

/// The entry at `path` under the directory `root`, if any.
pub(crate) fn find(
    lookup: &dyn TreeLookup,
    root: Option<ObjectId>,
    path: &str,
) -> Result<Option<TreeEntry>> {
    let Some(mut dir) = root else {
        return Ok(None);
    };
    let names: Vec<&str> = path.split('/').collect();
    for (at, name) in names.iter().enumerate() {
        let tree = tree_of(lookup, &dir)?;
        let key = name_key(name);
        let Some(entry) = tree
            .entries()
            .iter()
            .find(|entry| name_key(entry.name.as_str()) == key)
        else {
            return Ok(None);
        };
        if at + 1 == names.len() {
            return Ok(Some(entry.clone()));
        }
        if entry.kind != EntryKind::Directory {
            return Ok(None);
        }
        dir = entry.id;
    }
    Ok(None)
}

fn to_change(leaf: &Leaf) -> Change {
    Change {
        kind: leaf.kind,
        from: leaf.from.clone(),
        old: leaf.old.as_ref().map(side),
        new: leaf.new.as_ref().map(side),
    }
}

fn slot<'a>(
    entries: &'a mut BTreeMap<(String, String), StatusEntry>,
    folder_id: &str,
    path: &str,
) -> &'a mut StatusEntry {
    entries
        .entry((folder_id.to_string(), path.to_string()))
        .or_insert_with(|| StatusEntry {
            folder_id: folder_id.to_string(),
            path: path.to_string(),
            disk: None,
            effective: None,
            memory: None,
            staged: None,
            unstaged: None,
        })
}

/// A lookup that also knows the empty tree (which may never have been stored).
struct EmptyAware<'a>(&'a dyn TreeLookup);

impl TreeLookup for EmptyAware<'_> {
    fn tree(&self, id: &ObjectId) -> Option<Tree> {
        if *id == Tree::default().id() {
            return Some(Tree::default());
        }
        self.0.tree(id)
    }
}

/// Status of `snapshot` against `head`. `lookup` must have the snapshot's trees.
pub fn compute(
    folders: &[FolderRoot],
    lookup: &dyn TreeLookup,
    head: &Head,
    snapshot: &Snapshot,
    limit: usize,
) -> Result<Status> {
    let mut entries: BTreeMap<(String, String), StatusEntry> = BTreeMap::new();
    let mut disk_counts = Counts::default();
    let mut effective_counts = Counts::default();
    let mut staged_counts = Counts::default();
    let mut unstaged_counts = Counts::default();
    for folder in folders {
        let folder_id = folder.folder_id.as_str().to_string();
        let Some(this) = snapshot.folders.iter().find(|f| f.folder_id == folder_id) else {
            continue;
        };
        let head_tree = head.trees.get(&folder.folder_id).copied();
        for leaf in changes(lookup, head_tree, this.disk_tree.0)? {
            disk_counts.add(leaf.kind);
            slot(&mut entries, &folder_id, &leaf.path).disk = Some(to_change(&leaf));
        }
        for leaf in changes(lookup, head_tree, this.effective_tree.0)? {
            effective_counts.add(leaf.kind);
            slot(&mut entries, &folder_id, &leaf.path).effective = Some(to_change(&leaf));
        }
        // The index: missing folders are empty, and no index is HEAD's tree.
        let index_tree = head
            .index_trees
            .get(&folder.folder_id)
            .copied()
            .or(if head.index_root.is_none() {
                head_tree
            } else {
                None
            })
            .unwrap_or_else(|| Tree::default().id());
        let head_or_empty = head_tree.unwrap_or_else(|| Tree::default().id());
        let empty_aware = EmptyAware(lookup);
        if index_tree != head_or_empty {
            for leaf in changes(&empty_aware, Some(head_or_empty), index_tree)? {
                staged_counts.add(leaf.kind);
                slot(&mut entries, &folder_id, &leaf.path).staged = Some(to_change(&leaf));
            }
        }
        for leaf in changes(&empty_aware, Some(index_tree), this.effective_tree.0)? {
            unstaged_counts.add(leaf.kind);
            slot(&mut entries, &folder_id, &leaf.path).unstaged = Some(to_change(&leaf));
        }
        for overlay in snapshot
            .overlays
            .iter()
            .filter(|o| o.folder_id == folder_id)
        {
            let on_disk = find(lookup, Some(this.disk_tree.0), &overlay.path)?;
            let at_head = find(lookup, head_tree, &overlay.path)?;
            let is_file_with = |entry: &Option<TreeEntry>| {
                entry.as_ref().is_some_and(|entry| {
                    matches!(entry.kind, EntryKind::File { .. }) && entry.id == overlay.blob.0
                })
            };
            let state = match &on_disk {
                None => MemoryState::OpenDeletedOnDisk,
                Some(_) if is_file_with(&on_disk) => MemoryState::EqualsDisk,
                Some(_) => MemoryState::DiffersFromDisk,
            };
            slot(&mut entries, &folder_id, &overlay.path).memory = Some(Memory {
                state,
                equals_head: is_file_with(&at_head),
                version: overlay.version,
            });
        }
    }
    let total = entries.len();
    let entries: Vec<StatusEntry> = entries.into_values().take(limit).collect();
    let staged = head.index_root.is_some() && head.index_root != head.root;
    Ok(Status {
        head_commit: head.commit.map(ObjectIdText),
        head_root: head.root.map(ObjectIdText),
        index: if staged { "staged" } else { "head" },
        index_root: head.index_root.map(ObjectIdText),
        disk_root: snapshot.disk_root,
        effective_root: snapshot.effective_root,
        truncated: entries.len() < total,
        total,
        entries,
        disk: disk_counts,
        effective: effective_counts,
        staged: staged_counts,
        unstaged: unstaged_counts,
        unsaved: snapshot.overlays.len(),
    })
}
