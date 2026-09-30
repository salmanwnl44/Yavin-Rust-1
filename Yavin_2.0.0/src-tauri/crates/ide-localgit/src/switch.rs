//! Switching branches, and detaching HEAD at a commit (LG-04).
//!
//! A switch changes only what differs between HEAD and the target: every other path -- local
//! changes, untracked files, unsaved documents -- is carried over untouched. It is refused,
//! with every conflict found before anything changes, when:
//!
//! - anything is staged (`stagedChangeConflict`): the index becomes the target's tree, and
//!   staged work is never dropped;
//! - a path that differs between HEAD and the target does not hold HEAD's content on disk
//!   (`unstagedChangeWouldBeOverwritten` -- a local change, or an untracked file in the way),
//!   unless it already holds the target's;
//! - a document with unsaved changes is on such a path (`dirtyDocumentWouldBeOverwritten`,
//!   `dirtyDocumentWouldBeDeleted`);
//! - anything the restore planner refuses (content not stored, case-only renames, ...).
//!
//! The disk goes where it must through LG-03's restore machinery: a plan from the disk to the
//! *desired* disk tree (the current disk with the changed paths set to the target's), carried
//! out as one Module 03 operation recorded by Module 04, and verified. Only then do HEAD and the
//! index move -- together, in one compare-and-swap of the refs (`finish`). There is no forced
//! switch.

use crate::branches::{ShortName, BRANCHES, INDEX_REF};
use crate::error::{LgError, Result};
use crate::history::require_commit;
use crate::id::ObjectId;
use crate::index::graft;
use crate::object::{EntryKind, FolderId, Root, Tree, TreeEntry};
use crate::refs::{Head, RefName, RefUpdate};
use crate::repository::Repository;
use crate::restore::{RestoreConflict, RestorePlan, RestorePolicy};
use crate::scan::TreeLookup;
use crate::snapshot::{FolderRoot, ObjectIdText, Snapshot};
use crate::status::{changes, find, tree_of, ChangeKind};
use serde::Serialize;
use std::collections::BTreeMap;

/// Where to switch to.
#[derive(Clone, Debug)]
pub enum SwitchTarget {
    /// A branch: HEAD will name it.
    Branch(String),
    /// A commit: HEAD will be detached there.
    Commit(ObjectId),
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchPlan {
    /// The branch HEAD will name (none: detached).
    pub branch: Option<String>,
    pub commit: ObjectIdText,
    /// HEAD's commit before (none when unborn).
    pub from: Option<ObjectIdText>,
    /// The refs revision the plan was made at: the switch completes only if it is unchanged.
    pub revision: u64,
    /// The target is HEAD's own commit: only HEAD moves, the index and disk stay.
    pub same_commit: bool,
    /// The disk's side of it (and every conflict, the switch's own included).
    pub restore: RestorePlan,
}

/// A tree lookup that also knows the empty tree.
struct Trees<'a>(&'a dyn TreeLookup);

impl TreeLookup for Trees<'_> {
    fn tree(&self, id: &ObjectId) -> Option<Tree> {
        if *id == Tree::default().id() {
            return Some(Tree::default());
        }
        self.0.tree(id)
    }
}

fn same(a: &Option<TreeEntry>, b: &Option<TreeEntry>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => a.id == b.id && a.kind == b.kind,
        _ => false,
    }
}

/// A path that differs, with its entry before and after.
type PathChange = (String, Option<TreeEntry>, Option<TreeEntry>);

/// The paths that differ between two trees, a rename being its two paths.
fn differing(lookup: &dyn TreeLookup, from: ObjectId, to: ObjectId) -> Result<Vec<PathChange>> {
    let mut out = Vec::new();
    for leaf in changes(lookup, Some(from), to)? {
        if leaf.kind == ChangeKind::Renamed {
            if let Some(from_path) = &leaf.from {
                out.push((from_path.clone(), leaf.old.clone(), None));
            }
            out.push((leaf.path, None, leaf.new));
        } else {
            out.push((leaf.path, leaf.old, leaf.new));
        }
    }
    Ok(out)
}

/// Plans switching to `target` from the workspace as `snapshot` (Full, persisted, with the
/// unsaved documents) saw it.
pub fn plan(
    lookup: &dyn TreeLookup,
    repo: &mut Repository,
    folders: &[FolderRoot],
    snapshot: &Snapshot,
    target: &SwitchTarget,
) -> Result<SwitchPlan> {
    let (branch, commit) = match target {
        SwitchTarget::Branch(name) => {
            let short = ShortName::new(name)?;
            let full = RefName::new(&format!("{BRANCHES}{}", short.as_str()))?;
            let id = repo
                .refs()
                .refs
                .get(&full)
                .copied()
                .ok_or_else(|| LgError::NotFound(format!("branch {}", short.as_str())))?;
            (Some(short.as_str().to_string()), id)
        }
        SwitchTarget::Commit(id) => {
            require_commit(repo, id)?;
            (None, *id)
        }
    };
    let revision = repo.refs().revision;
    let from = repo.refs().head_commit();
    let empty = Tree::default().id();
    let folder_trees =
        |repo: &Repository, commit: Option<ObjectId>| -> Result<BTreeMap<FolderId, ObjectId>> {
            match commit {
                Some(id) => {
                    let root = repo.read_commit(&id)?.root;
                    Ok(repo.read_root(&root)?.folders)
                }
                None => Ok(BTreeMap::new()),
            }
        };
    let head_folders = folder_trees(repo, from)?;
    let target_folders = folder_trees(repo, Some(commit))?;
    let index = crate::branches::index_state(repo)?;
    let disk_of = |folder: &FolderId| {
        snapshot
            .folders
            .iter()
            .find(|f| f.folder_id == folder.as_str())
            .map(|f| f.disk_tree.0)
            .ok_or_else(|| {
                LgError::InvalidFormat(format!("no snapshot of folder {}", folder.as_str()))
            })
    };
    let mut conflicts = Vec::new();
    let mut desired: BTreeMap<FolderId, ObjectId> = BTreeMap::new();
    let same_commit = from == Some(commit);
    // First everything read (trees from memory, then the store), then everything written.
    let reads = Trees(&MemoryAndStore { repo, lookup });
    let trees = &reads;
    type Graft = (Vec<String>, Option<TreeEntry>, Vec<String>);
    let mut grafts: Vec<(FolderId, Tree, Vec<Graft>)> = Vec::new();
    for folder in folders {
        let id = &folder.folder_id;
        let folder_id = id.as_str().to_string();
        let disk = disk_of(id)?;
        let head_tree = head_folders.get(id).copied().unwrap_or(empty);
        let target_tree = target_folders.get(id).copied().unwrap_or(empty);
        // Staged work would be lost: the index becomes the target's tree.
        let index_tree = index
            .folders
            .get(id)
            .copied()
            .unwrap_or(if index.root.is_none() {
                head_tree
            } else {
                empty
            });
        if !same_commit && index_tree != head_tree {
            for (path, _, _) in differing(trees, head_tree, index_tree)? {
                conflicts.push(RestoreConflict::StagedChangeConflict {
                    folder_id: folder_id.clone(),
                    path,
                });
            }
        }
        if same_commit || head_tree == target_tree {
            desired.insert(id.clone(), disk);
            continue;
        }
        let changed = differing(trees, head_tree, target_tree)?;
        for (path, head_entry, target_entry) in &changed {
            let on_disk = find(trees, Some(disk), path)?;
            if !same(&on_disk, target_entry) && !same(&on_disk, head_entry) {
                conflicts.push(RestoreConflict::UnstagedChangeWouldBeOverwritten {
                    folder_id: folder_id.clone(),
                    path: path.clone(),
                });
            }
        }
        for overlay in snapshot
            .overlays
            .iter()
            .filter(|o| o.folder_id == folder_id)
        {
            let touched = changed.iter().any(|(path, _, _)| {
                overlay.path == *path || overlay.path.starts_with(&format!("{path}/"))
            });
            if !touched {
                continue;
            }
            let wanted = find(trees, Some(target_tree), &overlay.path)?;
            match wanted {
                Some(TreeEntry {
                    kind: EntryKind::File { .. },
                    id,
                    ..
                }) if id == overlay.blob.0 => {}
                Some(TreeEntry {
                    kind: EntryKind::File { .. },
                    ..
                }) => conflicts.push(RestoreConflict::DirtyDocumentWouldBeOverwritten {
                    folder_id: folder_id.clone(),
                    path: overlay.path.clone(),
                }),
                _ => conflicts.push(RestoreConflict::DirtyDocumentWouldBeDeleted {
                    folder_id: folder_id.clone(),
                    path: overlay.path.clone(),
                }),
            }
        }
        // The disk as it should be after: the current disk with the changed paths set.
        let mut jobs = Vec::new();
        for (path, _, target_entry) in &changed {
            let names: Vec<String> = path.split('/').map(str::to_string).collect();
            let keep_dirs: Vec<String> = (1..names.len())
                .map(|n| names[..n].join("/"))
                .filter(|dir| {
                    find(trees, Some(target_tree), dir)
                        .ok()
                        .flatten()
                        .is_some_and(|e| e.kind == EntryKind::Directory)
                })
                .collect();
            jobs.push((names, target_entry.clone(), keep_dirs));
        }
        grafts.push((id.clone(), tree_of(trees, &disk)?, jobs));
    }
    let mut txn = repo.begin_write()?;
    let mut pending = crate::index::Pending::default();
    for (folder, mut tree, jobs) in grafts {
        for (names, target_entry, keep_dirs) in jobs {
            let names: Vec<&str> = names.iter().map(String::as_str).collect();
            tree = graft(
                &mut txn,
                &mut pending,
                Some(&tree),
                "",
                &names,
                target_entry.as_ref(),
                &|dir: &str| keep_dirs.iter().any(|k| k == dir),
            )?;
        }
        let id_tree = pending.put(&mut txn, tree)?;
        desired.insert(folder, id_tree);
    }
    let desired_root = Root {
        folders: desired.clone(),
    };
    let desired_id = txn.put_root(&desired_root)?;
    txn.commit()?;
    // The disk's plan; the documents were checked above, only on the paths that change.
    let mut quiet = snapshot.clone();
    quiet.overlays.clear();
    let memory = MemoryAndStore { repo, lookup };
    let mut restore = crate::restore::plan(
        &memory,
        repo,
        folders,
        &quiet,
        commit,
        desired_id,
        &desired,
        None,
        RestorePolicy::RefuseIfDirty,
    )?;
    restore.conflicts.splice(0..0, conflicts);
    restore.unchanged = restore.operations.is_empty() && restore.conflicts.is_empty();
    Ok(SwitchPlan {
        branch,
        commit: ObjectIdText(commit),
        from: from.map(ObjectIdText),
        revision,
        same_commit,
        restore,
    })
}

/// Trees just written (the desired tree) come from the store; the rest as the caller has them.
struct MemoryAndStore<'a> {
    repo: &'a Repository,
    lookup: &'a dyn TreeLookup,
}

impl TreeLookup for MemoryAndStore<'_> {
    fn tree(&self, id: &ObjectId) -> Option<Tree> {
        if *id == Tree::default().id() {
            return Some(Tree::default());
        }
        self.lookup
            .tree(id)
            .or_else(|| self.repo.read_tree(id).ok())
    }
}

/// Moves HEAD to the plan's target, and the index to its tree (unless the target is HEAD's own
/// commit), in one atomic step -- only if the refs are still as the plan saw them.
pub fn finish(repo: &mut Repository, plan: &SwitchPlan) -> Result<u64> {
    let head = match &plan.branch {
        Some(name) => Head::Symbolic(RefName::new(&format!("{BRANCHES}{name}"))?),
        None => Head::Detached(plan.commit.0),
    };
    let mut updates = Vec::new();
    if !plan.same_commit {
        let index = RefName::new(INDEX_REF)?;
        if let Some(current) = repo.refs().refs.get(&index).copied() {
            // No index ref: the index is HEAD's tree -- the target's, once HEAD is there.
            updates.push(RefUpdate {
                name: index,
                expected: Some(current),
                new: None,
            });
        }
    }
    let reason = match &plan.branch {
        Some(name) => format!("to {name}"),
        None => format!("to {} (detached)", &plan.commit.0.to_hex()[..12]),
    };
    repo.update_refs(plan.revision, &updates, Some(head), "switch", &reason)
}
