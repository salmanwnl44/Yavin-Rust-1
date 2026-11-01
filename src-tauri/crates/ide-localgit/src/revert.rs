//! Revert (LG-05): a new commit that undoes what an earlier one changed.
//!
//! Reset moves history; revert adds to it. Reverting commit T (whose first parent is P, or the
//! empty state for a root commit) makes a new commit on top of HEAD whose tree is HEAD's with
//! every path T changed set back to P's entry -- nothing older is rewritten or moved.
//!
//! It works on the Local Index model, and never on the disk: the index (which must have nothing
//! staged) takes the inverse, and the commit is made from it, HEAD and the index moving together
//! in one atomic step. The working tree is not touched; its files keep what they had, so after
//! a revert they show, as unstaged changes, the difference the revert undid -- until restored.
//!
//! No merging is done (LG-06 owns that). A path is only reverted when HEAD still has exactly
//! what T left there; otherwise, and whenever local work sits on a reverted path, the revert is
//! refused with every reason (`RevertConflict`), before anything changes. Historical content
//! that was never stored (over the storage limit) is never reconstructed:
//! `historicalContentUnavailable`.

use crate::branches::{index_state, resolve_head, INDEX_REF};
use crate::error::{LgError, Result};
use crate::history::{commit_info, require_commit, validate_message, CommitInfo, CommitRequest};
use crate::id::ObjectId;
use crate::index::{graft, Pending};
use crate::object::{Commit, EntryKind, FolderId, Root, Source, Stored, TreeEntry};
use crate::refs::{Head, RefName, RefUpdate};
use crate::repository::Repository;
use crate::scan::TreeLookup;
use crate::snapshot::{FolderRoot, ObjectIdText, Snapshot};
use crate::status::{find, tree_of};
use crate::switch::{differing, same, MemoryAndStore, Trees};
use crate::transition::{commit_folders, disk_folders, tree_or_empty};
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RevertConflict {
    /// Something is staged: the revert's commit is made from the index.
    #[serde(rename_all = "camelCase")]
    StagedChangesPresent { folder_id: String, path: String },
    /// HEAD no longer has what the reverted commit left at this path (a later commit changed
    /// it); undoing it would need a merge.
    #[serde(rename_all = "camelCase")]
    ChangedSince {
        folder_id: String,
        path: String,
        binary: bool,
    },
    /// The working tree has local changes at a path the revert changes.
    #[serde(rename_all = "camelCase")]
    WorkingTreeChanged { folder_id: String, path: String },
    /// A document with unsaved changes is at a path the revert changes.
    #[serde(rename_all = "camelCase")]
    DirtyDocument { folder_id: String, path: String },
    /// The content to go back to was never stored (over the storage limit).
    #[serde(rename_all = "camelCase")]
    HistoricalContentUnavailable { folder_id: String, path: String },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevertResult {
    /// The new commit (none when refused).
    pub commit: Option<CommitInfo>,
    pub reverted: ObjectIdText,
    pub conflicts: Vec<RevertConflict>,
    /// The paths set back (`folderId:path`).
    pub paths: Vec<String>,
    pub revision: Option<u64>,
}

/// `Revert "<summary>"`, and which commit it reverts.
pub fn default_message(target: ObjectId, commit: &Commit) -> String {
    let summary = commit.message.lines().next().unwrap_or("").trim_end();
    format!("Revert \"{summary}\"\n\nThis reverts Local Git commit {target}.")
}

fn is_binary(repo: &Repository, entry: &Option<TreeEntry>) -> bool {
    match entry {
        Some(TreeEntry {
            kind:
                EntryKind::File {
                    stored: Stored::Yes,
                    ..
                },
            id,
            ..
        }) => repo
            .read_blob(id, 8192 * 1024)
            .map(|bytes| bytes[..bytes.len().min(8192)].contains(&0))
            .unwrap_or(false),
        _ => false,
    }
}

/// Reverts `target` on top of HEAD (see the module documentation). `snapshot` (Full, with the
/// unsaved documents) is how the workspace is now.
#[allow(clippy::too_many_arguments)]
pub fn revert(
    lookup: &dyn TreeLookup,
    repo: &mut Repository,
    folders: &[FolderRoot],
    snapshot: &Snapshot,
    target: ObjectId,
    message: Option<String>,
    request: &CommitRequest,
) -> Result<RevertResult> {
    crate::operation::ensure_idle(repo)?;
    require_commit(repo, &target)?;
    let reverted = repo.read_commit(&target)?;
    let message = message.unwrap_or_else(|| default_message(target, &reverted));
    validate_message(&message)?;
    let head_commit = resolve_head(repo).commit().ok_or(LgError::Unborn)?;
    let parent = reverted.parents.first().copied();
    let head = commit_folders(repo, Some(head_commit))?;
    let before = commit_folders(repo, parent)?;
    let after = commit_folders(repo, Some(target))?;
    let index = index_state(repo)?;
    let disk = disk_folders(snapshot)?;
    let mut conflicts = Vec::new();
    type Job = (Vec<String>, Option<TreeEntry>, Vec<String>);
    let mut jobs: Vec<(FolderId, crate::object::Tree, Vec<Job>)> = Vec::new();
    let mut paths = Vec::new();
    {
        let reads = Trees(&MemoryAndStore { repo, lookup });
        for folder in folders {
            let id = &folder.folder_id;
            let folder_id = id.as_str().to_string();
            let head_tree = tree_or_empty(&head, id);
            let index_tree = if index.root.is_none() {
                head_tree
            } else {
                tree_or_empty(&index.folders, id)
            };
            if index_tree != head_tree {
                for (path, _, _) in differing(&reads, head_tree, index_tree)? {
                    conflicts.push(RevertConflict::StagedChangesPresent {
                        folder_id: folder_id.clone(),
                        path,
                    });
                }
            }
            let (from, to) = (tree_or_empty(&before, id), tree_or_empty(&after, id));
            if from == to {
                continue;
            }
            let disk_tree = tree_or_empty(&disk, id);
            let mut folder_jobs = Vec::new();
            for (path, parent_entry, target_entry) in differing(&reads, from, to)? {
                let at_head = find(&reads, Some(head_tree), &path)?;
                if !same(&at_head, &target_entry) {
                    conflicts.push(RevertConflict::ChangedSince {
                        folder_id: folder_id.clone(),
                        path: path.clone(),
                        binary: is_binary(repo, &at_head) || is_binary(repo, &target_entry),
                    });
                    continue;
                }
                if matches!(
                    parent_entry,
                    Some(TreeEntry {
                        kind: EntryKind::File {
                            stored: Stored::No { .. },
                            ..
                        },
                        ..
                    })
                ) {
                    conflicts.push(RevertConflict::HistoricalContentUnavailable {
                        folder_id: folder_id.clone(),
                        path: path.clone(),
                    });
                    continue;
                }
                if !same(&find(&reads, Some(disk_tree), &path)?, &at_head) {
                    conflicts.push(RevertConflict::WorkingTreeChanged {
                        folder_id: folder_id.clone(),
                        path: path.clone(),
                    });
                }
                if snapshot.overlays.iter().any(|o| {
                    o.folder_id == folder_id
                        && (o.path == path || o.path.starts_with(&format!("{path}/")))
                }) {
                    conflicts.push(RevertConflict::DirtyDocument {
                        folder_id: folder_id.clone(),
                        path: path.clone(),
                    });
                }
                paths.push(format!("{folder_id}:{path}"));
                let names: Vec<String> = path.split('/').map(str::to_string).collect();
                let keep_dirs = (1..names.len())
                    .map(|n| names[..n].join("/"))
                    .filter(|dir| {
                        find(&reads, Some(from), dir)
                            .ok()
                            .flatten()
                            .is_some_and(|e| e.kind == EntryKind::Directory)
                    })
                    .collect();
                folder_jobs.push((names, parent_entry, keep_dirs));
            }
            if !folder_jobs.is_empty() {
                jobs.push((id.clone(), tree_of(&reads, &head_tree)?, folder_jobs));
            }
        }
    }
    if !conflicts.is_empty() {
        return Ok(RevertResult {
            commit: None,
            reverted: ObjectIdText(target),
            conflicts,
            paths,
            revision: None,
        });
    }
    // HEAD's tree with each reverted path set back to the parent's entry.
    let mut txn = repo.begin_write()?;
    let mut pending = Pending::default();
    let mut folders_after: BTreeMap<FolderId, ObjectId> = head.clone();
    for (id, mut tree, folder_jobs) in jobs {
        for (names, entry, keep_dirs) in folder_jobs {
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
        folders_after.insert(id, pending.put(&mut txn, tree)?);
    }
    let root = Root {
        folders: folders_after,
    };
    let root_id = txn.put_root(&root)?;
    if root_id == repo_root(txn.repository(), head_commit)? {
        txn.abandon();
        return Err(LgError::NothingToCommit);
    }
    let commit = Commit {
        root: root_id,
        disk_root: None,
        parents: vec![head_commit],
        workspace: txn.repository().meta().workspace.clone(),
        author: request.author.clone(),
        time_ms: request.time_ms,
        tz_offset_min: request.tz_offset_min,
        source: Source::Human,
        meta: [("revert".to_string(), target.to_hex())]
            .into_iter()
            .collect(),
        meta_objects: BTreeMap::new(),
        message,
    };
    let id = txn.put_commit(&commit)?;
    txn.commit()?;
    // HEAD (its branch, or itself when detached) and the index move together.
    let mut updates = Vec::new();
    let index_name = RefName::new(INDEX_REF)?;
    if let Some(current) = repo.refs().refs.get(&index_name).copied() {
        updates.push(RefUpdate {
            name: index_name,
            expected: Some(current),
            new: None,
        });
    }
    let head_update = match repo.refs().head.clone() {
        Head::Symbolic(name) => {
            updates.push(RefUpdate {
                name,
                expected: Some(head_commit),
                new: Some(id),
            });
            None
        }
        Head::Detached(_) => Some(Head::Detached(id)),
    };
    let revision = repo.refs().revision;
    let revision = repo.update_refs(
        revision,
        &updates,
        head_update,
        "revert",
        &format!("revert {}", &target.to_hex()[..12]),
    )?;
    Ok(RevertResult {
        commit: Some(commit_info(id, &commit)),
        reverted: ObjectIdText(target),
        conflicts: Vec::new(),
        paths,
        revision: Some(revision),
    })
}

fn repo_root(repo: &Repository, commit: ObjectId) -> Result<ObjectId> {
    Ok(repo.read_commit(&commit)?.root)
}
