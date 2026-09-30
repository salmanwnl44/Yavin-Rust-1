//! Moving the workspace's disk to a new state through LG-03's restore machinery (LG-05).
//!
//! A reset, a stash's cleanup and a stash's application all need the same thing a branch
//! switch does: some paths set to given entries, everything else on disk carried over, and the
//! change planned (and later carried out, as one Module 03 operation recorded by Module 04) by
//! the restore planner and executor -- never a second restore engine.

use crate::error::{LgError, Result};
use crate::id::ObjectId;
use crate::index::{graft, Pending};
use crate::object::{EntryKind, FolderId, Root, Tree, TreeEntry};
use crate::repository::Repository;
use crate::restore::{RestorePlan, RestorePolicy};
use crate::scan::TreeLookup;
use crate::snapshot::{FolderRoot, Snapshot};
use crate::status::{find, tree_of};
use crate::switch::{MemoryAndStore, Trees};
use std::collections::BTreeMap;

/// Per folder: the paths to set, each to an entry (`None`: removed).
pub(crate) type Sets = BTreeMap<FolderId, Vec<(String, Option<TreeEntry>)>>;

/// A commit's folders' trees (none: the empty state before the first commit).
pub(crate) fn commit_folders(
    repo: &Repository,
    commit: Option<ObjectId>,
) -> Result<BTreeMap<FolderId, ObjectId>> {
    match commit {
        Some(id) => {
            let root = repo.read_commit(&id)?.root;
            Ok(repo.read_root(&root)?.folders)
        }
        None => Ok(BTreeMap::new()),
    }
}

/// The disk trees a snapshot saw, per folder.
pub(crate) fn disk_folders(snapshot: &Snapshot) -> Result<BTreeMap<FolderId, ObjectId>> {
    snapshot
        .folders
        .iter()
        .map(|f| Ok((FolderId::new(&f.folder_id)?, f.disk_tree.0)))
        .collect()
}

pub(crate) fn tree_or_empty(map: &BTreeMap<FolderId, ObjectId>, folder: &FolderId) -> ObjectId {
    map.get(folder)
        .copied()
        .unwrap_or_else(|| Tree::default().id())
}

/// Plans the disk going to *desired*: the current disk (as `snapshot` saw it) with `sets`
/// applied. Folders a removal empties are pruned unless `keep` has them as folders. The
/// snapshot's overlays are the documents the planner considers (the caller filters them), with
/// `policy`. `label` is the commit the plan names.
#[allow(clippy::too_many_arguments)]
pub(crate) fn plan_transition(
    lookup: &dyn TreeLookup,
    repo: &mut Repository,
    folders: &[FolderRoot],
    snapshot: &Snapshot,
    label: ObjectId,
    sets: &Sets,
    keep: &BTreeMap<FolderId, ObjectId>,
    policy: RestorePolicy,
) -> Result<RestorePlan> {
    let disk = disk_folders(snapshot)?;
    type Job = (Vec<String>, Option<TreeEntry>, Vec<String>);
    let mut work: Vec<(FolderId, Tree, Vec<Job>)> = Vec::new();
    let mut desired: BTreeMap<FolderId, ObjectId> = BTreeMap::new();
    {
        let reads = Trees(&MemoryAndStore { repo, lookup });
        for folder in folders {
            let id = &folder.folder_id;
            let disk_tree = disk.get(id).copied().ok_or_else(|| {
                LgError::InvalidFormat(format!("no snapshot of folder {}", id.as_str()))
            })?;
            let Some(paths) = sets.get(id).filter(|p| !p.is_empty()) else {
                desired.insert(id.clone(), disk_tree);
                continue;
            };
            let keep_tree = tree_or_empty(keep, id);
            let mut paths = paths.clone();
            paths.sort_by(|a, b| a.0.cmp(&b.0));
            let jobs = paths
                .into_iter()
                .map(|(path, entry)| {
                    let names: Vec<String> = path.split('/').map(str::to_string).collect();
                    let keep_dirs = (1..names.len())
                        .map(|n| names[..n].join("/"))
                        .filter(|dir| {
                            find(&reads, Some(keep_tree), dir)
                                .ok()
                                .flatten()
                                .is_some_and(|e| e.kind == EntryKind::Directory)
                        })
                        .collect();
                    (names, entry, keep_dirs)
                })
                .collect();
            work.push((id.clone(), tree_of(&reads, &disk_tree)?, jobs));
        }
    }
    let mut txn = repo.begin_write()?;
    let mut pending = Pending::default();
    for (folder, mut tree, jobs) in work {
        for (names, entry, keep_dirs) in jobs {
            let names: Vec<&str> = names.iter().map(String::as_str).collect();
            tree = graft(
                &mut txn,
                &mut pending,
                Some(&tree),
                "",
                &names,
                entry.as_ref(),
                &|dir: &str| keep_dirs.iter().any(|k| k == dir),
            )?;
        }
        let id = pending.put(&mut txn, tree)?;
        desired.insert(folder, id);
    }
    let desired_id = txn.put_root(&Root {
        folders: desired.clone(),
    })?;
    txn.commit()?;
    let memory = MemoryAndStore { repo, lookup };
    let mut plan = crate::restore::plan(
        &memory, repo, folders, snapshot, label, desired_id, &desired, None, policy,
    )?;
    plan.unchanged =
        plan.operations.is_empty() && plan.conflicts.is_empty() && plan.documents.is_empty();
    Ok(plan)
}
