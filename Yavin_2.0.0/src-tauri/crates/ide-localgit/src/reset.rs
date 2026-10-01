//! Reset (LG-05): moving HEAD -- the branch it is on, or HEAD itself when detached -- to a
//! target commit, and with it, as asked, the index and the working tree.
//!
//! | Mode | HEAD | Index | Working tree |
//! | --- | --- | --- | --- |
//! | `soft` | the target | unchanged | unchanged |
//! | `mixed` | the target | the target's tree | unchanged |
//! | `hard` | the target | the target's tree | the target's tree |
//!
//! Soft and mixed only move refs, in one atomic step (LG-01), and never touch the disk. Hard
//! also changes the disk, through the restore machinery (`transition.rs`): planned completely
//! from a Full snapshot, every conflict reported before anything changes, carried out as one
//! Module 03 operation recorded by Module 04, verified, and only then the refs moved. With
//! the default policy, `refuseIfDirty`, a hard reset is refused when it would destroy staged
//! changes, local changes to tracked files, unsaved documents, or an untracked file where the
//! target has one; `allowDestructive` is the caller's explicit choice to lose them. Untracked
//! files the target does not have are never touched. A reset never saves work anywhere on its
//! own (no hidden stash or checkpoint).

use crate::branches::{get_tag, resolve_head, HeadState, ShortName, BRANCHES, INDEX_REF};
use crate::error::{LgError, Result};
use crate::history::require_commit;
use crate::id::ObjectId;
use crate::object::{Author, Commit, EntryKind, FolderId, Root, Source, Tree, TreeEntry};
use crate::refs::{Head, RefName, RefUpdate};
use crate::repository::Repository;
use crate::restore::{RestoreConflict, RestorePlan, RestorePolicy};
use crate::scan::TreeLookup;
use crate::snapshot::{FolderRoot, ObjectIdText, Snapshot};
use crate::status::find;
use crate::switch::{differing, same, MemoryAndStore, Trees};
use crate::transition::{commit_folders, disk_folders, plan_transition, tree_or_empty, Sets};
use serde::Serialize;
use std::collections::BTreeMap;

/// What to reset to.
#[derive(Clone, Debug)]
pub enum ResetTarget {
    Commit(ObjectId),
    Branch(String),
    Tag(String),
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ResetMode {
    Soft,
    Mixed,
    Hard,
}

/// Whether a hard reset may destroy local work.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ResetPolicy {
    /// Refuse, listing everything that would be lost.
    #[default]
    RefuseIfDirty,
    /// The caller's explicit choice: staged changes, local changes and unsaved documents on
    /// the paths the reset sets are discarded.
    AllowDestructive,
}

/// The commit `target` names.
pub fn resolve_target(repo: &Repository, target: &ResetTarget) -> Result<ObjectId> {
    let id = match target {
        ResetTarget::Commit(id) => *id,
        ResetTarget::Branch(name) => {
            let short = ShortName::new(name)?;
            let full = RefName::new(&format!("{BRANCHES}{}", short.as_str()))?;
            repo.refs()
                .refs
                .get(&full)
                .copied()
                .ok_or_else(|| LgError::NotFound(format!("branch {}", short.as_str())))?
        }
        ResetTarget::Tag(name) => get_tag(repo, name)?.commit.0,
    };
    require_commit(repo, &id)?;
    Ok(id)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetDone {
    pub mode: ResetMode,
    pub from: Option<ObjectIdText>,
    pub to: ObjectIdText,
    pub revision: u64,
    pub head: HeadState,
}

/// The ref updates (and HEAD) that move HEAD -- its branch, or HEAD itself -- to `target`.
fn head_move(repo: &Repository, target: ObjectId) -> (Vec<RefUpdate>, Option<Head>) {
    match repo.refs().head.clone() {
        Head::Symbolic(name) => {
            let expected = repo.refs().refs.get(&name).copied();
            (
                vec![RefUpdate {
                    name,
                    expected,
                    new: Some(target),
                }],
                None,
            )
        }
        Head::Detached(_) => (Vec::new(), Some(Head::Detached(target))),
    }
}

fn reason(mode: ResetMode, from: Option<ObjectId>, to: ObjectId) -> String {
    let short = |id: ObjectId| id.to_hex()[..12].to_string();
    format!(
        "{} reset from {} to {}",
        match mode {
            ResetMode::Soft => "soft",
            ResetMode::Mixed => "mixed",
            ResetMode::Hard => "hard",
        },
        from.map(short).unwrap_or_else(|| "nothing".into()),
        short(to)
    )
}

/// Soft: HEAD moves; the index keeps its tree (made explicit, since an index with no ref of its
/// own follows HEAD) and the working tree is not touched.
pub fn reset_soft(
    repo: &mut Repository,
    folders: &[FolderRoot],
    target: &ResetTarget,
) -> Result<ResetDone> {
    crate::operation::ensure_idle(repo)?;
    let to = resolve_target(repo, target)?;
    let from = repo.refs().head_commit();
    let index_name = RefName::new(INDEX_REF)?;
    let index_ref = repo.refs().refs.get(&index_name).copied();
    let (mut updates, head) = head_move(repo, to);
    if index_ref.is_none() && from != Some(to) {
        let pinned = match from {
            // The index is the old HEAD's tree: name that commit.
            Some(old) => old,
            // Nothing committed, nothing staged: an explicit empty index.
            None => {
                let empty = Tree::default().id();
                let root = Root {
                    folders: folders
                        .iter()
                        .map(|f| (f.folder_id.clone(), empty))
                        .collect::<BTreeMap<FolderId, ObjectId>>(),
                };
                let mut txn = repo.begin_write()?;
                txn.put_tree(&Tree::default())?;
                txn.put_root(&root)?;
                let commit = Commit {
                    root: root.id(),
                    disk_root: None,
                    parents: Vec::new(),
                    workspace: txn.repository().meta().workspace.clone(),
                    author: Author {
                        name: "Local Git".into(),
                        id: "index".into(),
                    },
                    time_ms: 0,
                    tz_offset_min: 0,
                    source: Source::Automatic,
                    meta: [("index".to_string(), "1".to_string())]
                        .into_iter()
                        .collect(),
                    meta_objects: BTreeMap::new(),
                    message: "Local Git index".into(),
                };
                let id = txn.put_commit(&commit)?;
                txn.commit()?;
                id
            }
        };
        updates.push(RefUpdate {
            name: index_name,
            expected: None,
            new: Some(pinned),
        });
    }
    let revision = repo.refs().revision;
    let revision = repo.update_refs(
        revision,
        &updates,
        head,
        "reset",
        &reason(ResetMode::Soft, from, to),
    )?;
    Ok(ResetDone {
        mode: ResetMode::Soft,
        from: from.map(ObjectIdText),
        to: ObjectIdText(to),
        revision,
        head: resolve_head(repo),
    })
}

/// The ref updates that move HEAD to `to` and make the index its tree.
fn head_and_index(repo: &Repository, to: ObjectId) -> Result<(Vec<RefUpdate>, Option<Head>)> {
    let (mut updates, head) = head_move(repo, to);
    let index_name = RefName::new(INDEX_REF)?;
    if let Some(current) = repo.refs().refs.get(&index_name).copied() {
        // No index ref: the index is HEAD's tree -- the target's.
        updates.push(RefUpdate {
            name: index_name,
            expected: Some(current),
            new: None,
        });
    }
    Ok((updates, head))
}

/// Mixed: HEAD moves and the index becomes the target's tree; the working tree is not touched
/// (what differs from it is now unstaged).
pub fn reset_mixed(repo: &mut Repository, target: &ResetTarget) -> Result<ResetDone> {
    crate::operation::ensure_idle(repo)?;
    let to = resolve_target(repo, target)?;
    let from = repo.refs().head_commit();
    let (updates, head) = head_and_index(repo, to)?;
    let revision = repo.refs().revision;
    let revision = repo.update_refs(
        revision,
        &updates,
        head,
        "reset",
        &reason(ResetMode::Mixed, from, to),
    )?;
    Ok(ResetDone {
        mode: ResetMode::Mixed,
        from: from.map(ObjectIdText),
        to: ObjectIdText(to),
        revision,
        head: resolve_head(repo),
    })
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HardResetPlan {
    pub from: Option<ObjectIdText>,
    pub to: ObjectIdText,
    pub policy: ResetPolicy,
    /// The refs revision the plan was made at: the reset completes only if it is unchanged.
    pub revision: u64,
    /// The disk's side, with every conflict.
    pub restore: RestorePlan,
}

/// Plans a hard reset from the workspace as `snapshot` (Full, persisted, with the unsaved
/// documents) saw it.
pub fn plan_hard(
    lookup: &dyn TreeLookup,
    repo: &mut Repository,
    folders: &[FolderRoot],
    snapshot: &Snapshot,
    target: &ResetTarget,
    policy: ResetPolicy,
) -> Result<HardResetPlan> {
    crate::operation::ensure_idle(repo)?;
    let to = resolve_target(repo, target)?;
    let from = repo.refs().head_commit();
    let revision = repo.refs().revision;
    let head = commit_folders(repo, from)?;
    let wanted = commit_folders(repo, Some(to))?;
    let index = crate::branches::index_state(repo)?;
    let disk = disk_folders(snapshot)?;
    let mut conflicts = Vec::new();
    let mut sets: Sets = BTreeMap::new();
    let mut touched: Vec<(String, String)> = Vec::new();
    {
        let reads = Trees(&MemoryAndStore { repo, lookup });
        for folder in folders {
            let id = &folder.folder_id;
            let folder_id = id.as_str().to_string();
            let head_tree = tree_or_empty(&head, id);
            let target_tree = tree_or_empty(&wanted, id);
            let index_tree = if index.root.is_none() {
                head_tree
            } else {
                tree_or_empty(&index.folders, id)
            };
            let disk_tree = tree_or_empty(&disk, id);
            let tracked = |path: &str| -> Result<bool> {
                Ok(find(&reads, Some(head_tree), path)?.is_some()
                    || find(&reads, Some(index_tree), path)?.is_some())
            };
            if policy == ResetPolicy::RefuseIfDirty && index_tree != head_tree {
                for (path, _, _) in differing(&reads, head_tree, index_tree)? {
                    conflicts.push(RestoreConflict::StagedChangeConflict {
                        folder_id: folder_id.clone(),
                        path,
                    });
                }
            }
            let mut folder_sets = Vec::new();
            for (path, on_disk, target_entry) in differing(&reads, disk_tree, target_tree)? {
                let is_tracked = tracked(&path)?;
                if !is_tracked && target_entry.is_none() {
                    // Untracked, and the target has nothing there: never touched.
                    continue;
                }
                if policy == ResetPolicy::RefuseIfDirty {
                    let head_entry = find(&reads, Some(head_tree), &path)?;
                    if !same(&on_disk, &head_entry) {
                        // A local change to a tracked file, or an untracked one in the way.
                        conflicts.push(RestoreConflict::UnstagedChangeWouldBeOverwritten {
                            folder_id: folder_id.clone(),
                            path: path.clone(),
                        });
                    }
                }
                touched.push((folder_id.clone(), path.clone()));
                folder_sets.push((path, target_entry));
            }
            // Unsaved documents on tracked paths or paths the target has.
            for overlay in snapshot
                .overlays
                .iter()
                .filter(|o| o.folder_id == folder_id)
            {
                let target_entry = find(&reads, Some(target_tree), &overlay.path)?;
                if !tracked(&overlay.path)? && target_entry.is_none() {
                    continue;
                }
                if matches!(&target_entry, Some(TreeEntry { kind: EntryKind::File { .. }, id, .. }) if *id == overlay.blob.0)
                {
                    continue;
                }
                touched.push((folder_id.clone(), overlay.path.clone()));
                if policy == ResetPolicy::RefuseIfDirty {
                    conflicts.push(match target_entry {
                        Some(TreeEntry {
                            kind: EntryKind::File { .. },
                            ..
                        }) => RestoreConflict::DirtyDocumentWouldBeOverwritten {
                            folder_id: folder_id.clone(),
                            path: overlay.path.clone(),
                        },
                        _ => RestoreConflict::DirtyDocumentWouldBeDeleted {
                            folder_id: folder_id.clone(),
                            path: overlay.path.clone(),
                        },
                    });
                }
            }
            sets.insert(id.clone(), folder_sets);
        }
    }
    // The documents the planner may act on: only those the reset touches (replaced, when
    // destructive; already refused above otherwise).
    let mut documents = snapshot.clone();
    documents.overlays.retain(|o| {
        touched
            .iter()
            .any(|(f, p)| *f == o.folder_id && *p == o.path)
    });
    if policy == ResetPolicy::RefuseIfDirty {
        documents.overlays.clear();
    }
    let mut restore = plan_transition(
        lookup,
        repo,
        folders,
        &documents,
        to,
        &sets,
        &wanted,
        RestorePolicy::ReplaceDocument,
    )?;
    conflicts.append(&mut restore.conflicts);
    restore.conflicts = conflicts;
    restore.unchanged = restore.operations.is_empty()
        && restore.conflicts.is_empty()
        && restore.documents.is_empty();
    Ok(HardResetPlan {
        from: from.map(ObjectIdText),
        to: ObjectIdText(to),
        policy,
        revision,
        restore,
    })
}

/// After the disk was changed and verified: HEAD and the index move to the target, in one
/// step, only if the refs are as the plan saw them.
pub fn finish_hard(repo: &mut Repository, plan: &HardResetPlan) -> Result<ResetDone> {
    let (updates, head) = head_and_index(repo, plan.to.0)?;
    let revision = repo.update_refs(
        plan.revision,
        &updates,
        head,
        "reset",
        &reason(ResetMode::Hard, plan.from.map(|f| f.0), plan.to.0),
    )?;
    Ok(ResetDone {
        mode: ResetMode::Hard,
        from: plan.from,
        to: plan.to,
        revision,
        head: resolve_head(repo),
    })
}
