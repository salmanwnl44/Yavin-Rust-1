//! Stash (LG-05): putting the workspace's changes aside, and bringing them back.
//!
//! Not a real Git stash, and never near `.git`. A stash is one commit object (source
//! `automatic`) under its own ref, `refs/yavin/stash/<id>` -- never on a branch's history --
//! whose root is the working tree as it was (unsaved documents included), with the index's
//! root beside it (`metaobj index`) and its base (the HEAD it was made on) as its parent. So the
//! staged changes (base -> index) and the unstaged ones (index -> working tree) are kept apart,
//! and come back apart. Untracked files are in it only when asked (`includeUntracked`); what
//! snapshots leave out (`.git`, excluded paths) and proposed documents never are. Everything
//! is made of the same immutable objects as the rest of Local Git; nothing is copied.
//!
//! **Push**: a Full snapshot; the stash's objects; the stash's ref, durably -- and only then is
//! the workspace cleaned back to HEAD (the stashed paths only; untracked files it did not take
//! stay), through the restore machinery, verified, and the index set to HEAD. If the stash
//! cannot be made durable nothing in the workspace changes.
//!
//! **Apply** puts the index's changes back into the index and the working tree's on disk,
//! through the same machinery -- refused, with every conflict before anything changes, when
//! something is staged, when HEAD no longer has at a stashed path what the stash was made on
//! (`stashBaseChanged`: that would take a merge), when a stashed path holds local changes or an
//! unsaved document, or when an untracked file it brings back is in the way. **Pop** is apply,
//! and the stash's ref is removed only in the same atomic step that sets the index, after the
//! disk was verified: a pop that fails leaves the stash. **Drop** removes the ref; the objects
//! stay until LG-09's GC.

use crate::branches::{index_state, index_update, resolve_head, HeadState};
use crate::error::{LgError, Result};
use crate::history::{validate_message, CommitRequest};
use crate::id::ObjectId;
use crate::index::{graft, Pending};
use crate::object::{Commit, EntryKind, FolderId, Root, Source, Tree, TreeEntry};
use crate::refs::{RefName, RefUpdate};
use crate::repository::Repository;
use crate::restore::{RestoreConflict, RestorePlan, RestorePolicy};
use crate::scan::TreeLookup;
use crate::snapshot::{FolderRoot, ObjectIdText, Snapshot};
use crate::status::{find, tree_of};
use crate::switch::{differing, same, MemoryAndStore, Trees};
use crate::transition::{commit_folders, disk_folders, plan_transition, tree_or_empty, Sets};
use serde::Serialize;
use std::collections::BTreeMap;

pub const STASH_PREFIX: &str = "refs/yavin/stash/";

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashCounts {
    pub staged: usize,
    pub unstaged: usize,
    pub untracked: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashInfo {
    /// The stash's name: `s<ms>-<n>`.
    pub id: String,
    pub ref_name: String,
    pub commit: ObjectIdText,
    pub short_id: String,
    pub message: String,
    pub time_ms: i64,
    /// The HEAD it was made on (none before the first commit).
    pub base: Option<ObjectIdText>,
    /// The branch HEAD was on (none: detached).
    pub branch: Option<String>,
    pub has_untracked: bool,
    pub counts: StashCounts,
}

fn stash_ref(id: &str) -> Result<RefName> {
    if !id.starts_with('s') || !id[1..].bytes().all(|b| b.is_ascii_digit() || b == b'-') {
        return Err(LgError::InvalidName(format!("{id:?} is not a stash id")));
    }
    RefName::new(&format!("{STASH_PREFIX}{id}"))
}

fn info(id: &str, commit_id: ObjectId, commit: &Commit) -> StashInfo {
    let meta = |key: &str| commit.meta.get(key).cloned().unwrap_or_default();
    let count = |key: &str| meta(key).parse().unwrap_or(0);
    StashInfo {
        id: id.into(),
        ref_name: format!("{STASH_PREFIX}{id}"),
        commit: ObjectIdText(commit_id),
        short_id: commit_id.to_hex()[..12].to_string(),
        message: commit.message.clone(),
        time_ms: commit.time_ms,
        base: commit.parents.first().copied().map(ObjectIdText),
        branch: Some(meta("stash.branch")).filter(|b| !b.is_empty()),
        has_untracked: meta("stash.untracked") == "1",
        counts: StashCounts {
            staged: count("stash.staged"),
            unstaged: count("stash.unstaged"),
            untracked: count("stash.untracked-files"),
        },
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashList {
    /// Newest first.
    pub items: Vec<StashInfo>,
    pub total: usize,
}

/// The newest `limit` stashes (ids sort by time), and how many there are. Reads only the refs
/// and the listed stashes' commits -- never the workspace.
pub fn list(repo: &Repository, limit: usize) -> Result<StashList> {
    let mut ids: Vec<(String, ObjectId)> = repo
        .refs()
        .refs
        .iter()
        .filter_map(|(name, id)| Some((name.as_str().strip_prefix(STASH_PREFIX)?.to_string(), *id)))
        .collect();
    ids.sort_by(|a, b| b.0.cmp(&a.0));
    let total = ids.len();
    let items = ids
        .into_iter()
        .take(limit)
        .map(|(id, commit)| Ok(info(&id, commit, &repo.read_commit(&commit)?)))
        .collect::<Result<Vec<_>>>()?;
    Ok(StashList { items, total })
}

pub fn get(repo: &Repository, id: &str) -> Result<StashInfo> {
    let name = stash_ref(id)?;
    let commit = repo
        .refs()
        .refs
        .get(&name)
        .copied()
        .ok_or_else(|| LgError::NotFound(format!("stash {id}")))?;
    Ok(info(id, commit, &repo.read_commit(&commit)?))
}

/// Removes a stash's ref. Its objects are left for LG-09's GC.
pub fn drop_stash(repo: &mut Repository, id: &str) -> Result<()> {
    let stash = get(repo, id)?;
    let revision = repo.refs().revision;
    repo.update_refs(
        revision,
        &[RefUpdate {
            name: stash_ref(id)?,
            expected: Some(stash.commit.0),
            new: None,
        }],
        None,
        "stash",
        &format!("drop {id}"),
    )?;
    Ok(())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashPushPlan {
    pub base: Option<ObjectIdText>,
    pub branch: Option<String>,
    pub index_root: ObjectIdText,
    pub work_root: ObjectIdText,
    pub include_untracked: bool,
    pub counts: StashCounts,
    pub message: String,
    pub revision: u64,
    /// Cleaning the workspace back to HEAD: the stashed paths only.
    pub restore: RestorePlan,
}

/// Plans a stash of the workspace as `snapshot` (Full, persisted, with the unsaved documents)
/// saw it. Writes the stash's trees (unreferenced until `record`); changes nothing else.
#[allow(clippy::too_many_arguments)]
pub fn plan_push(
    lookup: &dyn TreeLookup,
    repo: &mut Repository,
    folders: &[FolderRoot],
    snapshot: &Snapshot,
    message: Option<String>,
    include_untracked: bool,
) -> Result<StashPushPlan> {
    crate::operation::ensure_idle(repo)?;
    let head = resolve_head(repo);
    let base = head.commit();
    let branch = match &head {
        HeadState::Branch { name, .. } | HeadState::Unborn { name, .. } => Some(name.clone()),
        HeadState::Detached { .. } => None,
    };
    let message = match message {
        Some(message) => message,
        None => match base {
            Some(id) => {
                let summary = repo
                    .read_commit(&id)?
                    .message
                    .lines()
                    .next()
                    .unwrap_or("")
                    .to_string();
                format!(
                    "WIP on {}: {} {summary}",
                    branch.as_deref().unwrap_or("detached HEAD"),
                    &id.to_hex()[..12]
                )
            }
            None => "WIP (no commit yet)".into(),
        },
    };
    validate_message(&message)?;
    let revision = repo.refs().revision;
    let head_folders = commit_folders(repo, base)?;
    let index = index_state(repo)?;
    let effective: BTreeMap<FolderId, ObjectId> = snapshot
        .folders
        .iter()
        .map(|f| Ok((FolderId::new(&f.folder_id)?, f.effective_tree.0)))
        .collect::<Result<_>>()?;
    let mut counts = StashCounts::default();
    type Job = (Vec<String>, Vec<String>);
    let mut work: Vec<(FolderId, Tree, Vec<Job>)> = Vec::new();
    let mut index_trees = BTreeMap::new();
    let mut work_trees = BTreeMap::new();
    {
        let reads = Trees(&MemoryAndStore { repo, lookup });
        for folder in folders {
            let id = &folder.folder_id;
            let head_tree = tree_or_empty(&head_folders, id);
            let index_tree = if index.root.is_none() {
                head_tree
            } else {
                tree_or_empty(&index.folders, id)
            };
            let eff = tree_or_empty(&effective, id);
            index_trees.insert(id.clone(), index_tree);
            counts.staged += differing(&reads, head_tree, index_tree)?.len();
            let mut untracked = Vec::new();
            for (path, in_index, _) in differing(&reads, index_tree, eff)? {
                if in_index.is_none() && find(&reads, Some(head_tree), &path)?.is_none() {
                    untracked.push(path);
                } else {
                    counts.unstaged += 1;
                }
            }
            if include_untracked || untracked.is_empty() {
                counts.untracked += if include_untracked {
                    untracked.len()
                } else {
                    0
                };
                work_trees.insert(id.clone(), eff);
            } else {
                // Untracked files stay where they are, and out of the stash.
                let jobs = untracked
                    .into_iter()
                    .map(|path| {
                        let names: Vec<String> = path.split('/').map(str::to_string).collect();
                        let keep = (1..names.len())
                            .map(|n| names[..n].join("/"))
                            .filter(|dir| {
                                find(&reads, Some(index_tree), dir)
                                    .ok()
                                    .flatten()
                                    .is_some_and(|e| e.kind == EntryKind::Directory)
                            })
                            .collect();
                        (names, keep)
                    })
                    .collect();
                work.push((id.clone(), tree_of(&reads, &eff)?, jobs));
            }
        }
    }
    if counts == StashCounts::default() {
        return Err(LgError::NothingToStash);
    }
    let mut txn = repo.begin_write()?;
    let mut pending = Pending::default();
    for (id, mut tree, jobs) in work {
        for (names, keep) in jobs {
            let names: Vec<&str> = names.iter().map(String::as_str).collect();
            tree = graft(
                &mut txn,
                &mut pending,
                Some(&tree),
                "",
                &names,
                None,
                &|dir: &str| keep.iter().any(|k| k == dir),
            )?;
        }
        work_trees.insert(id, pending.put(&mut txn, tree)?);
    }
    for tree in index_trees.values().chain(work_trees.values()) {
        if *tree == Tree::default().id() {
            txn.put_tree(&Tree::default())?;
        }
    }
    let index_root = txn.put_root(&Root {
        folders: index_trees.clone(),
    })?;
    let work_root = txn.put_root(&Root {
        folders: work_trees.clone(),
    })?;
    txn.commit()?;
    // Cleaning: every stashed path back to HEAD's entry; documents on them lose their unsaved
    // changes (they are in the stash).
    let mut sets: Sets = BTreeMap::new();
    let mut paths: Vec<(String, String)> = Vec::new();
    {
        let reads = Trees(&MemoryAndStore { repo, lookup });
        for folder in folders {
            let id = &folder.folder_id;
            let head_tree = tree_or_empty(&head_folders, id);
            let changed = differing(&reads, head_tree, tree_or_empty(&work_trees, id))?;
            for (path, head_entry, _) in changed {
                paths.push((id.as_str().to_string(), path.clone()));
                sets.entry(id.clone()).or_default().push((path, head_entry));
            }
            for (path, _, _) in differing(&reads, head_tree, tree_or_empty(&index_trees, id))? {
                if !paths.iter().any(|(f, p)| f == id.as_str() && *p == path) {
                    let head_entry = find(&reads, Some(head_tree), &path)?;
                    paths.push((id.as_str().to_string(), path.clone()));
                    sets.entry(id.clone()).or_default().push((path, head_entry));
                }
            }
        }
    }
    let mut documents = snapshot.clone();
    documents
        .overlays
        .retain(|o| paths.iter().any(|(f, p)| *f == o.folder_id && *p == o.path));
    let restore = plan_transition(
        lookup,
        repo,
        folders,
        &documents,
        base.unwrap_or(work_root),
        &sets,
        &head_folders,
        RestorePolicy::ReplaceDocument,
    )?;
    Ok(StashPushPlan {
        base: base.map(ObjectIdText),
        branch,
        index_root: ObjectIdText(index_root),
        work_root: ObjectIdText(work_root),
        include_untracked,
        counts,
        message,
        revision,
        restore,
    })
}

/// Makes the stash durable: its commit object, then its ref. Nothing in the workspace changes.
pub fn record(
    repo: &mut Repository,
    plan: &StashPushPlan,
    request: &CommitRequest,
) -> Result<StashInfo> {
    let meta = [
        ("stash", "1".to_string()),
        ("stash.branch", plan.branch.clone().unwrap_or_default()),
        (
            "stash.untracked",
            if plan.include_untracked { "1" } else { "0" }.to_string(),
        ),
        ("stash.staged", plan.counts.staged.to_string()),
        ("stash.unstaged", plan.counts.unstaged.to_string()),
        ("stash.untracked-files", plan.counts.untracked.to_string()),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v))
    .collect();
    let commit = Commit {
        root: plan.work_root.0,
        disk_root: None,
        parents: plan.base.map(|b| b.0).into_iter().collect(),
        workspace: repo.meta().workspace.clone(),
        author: request.author.clone(),
        time_ms: request.time_ms,
        tz_offset_min: request.tz_offset_min,
        source: Source::Automatic,
        meta,
        meta_objects: [("index".to_string(), plan.index_root.0)]
            .into_iter()
            .collect(),
        message: plan.message.clone(),
    };
    let mut txn = repo.begin_write()?;
    let commit_id = txn.put_commit(&commit)?;
    txn.commit()?;
    let ms = ide_workspace::durable::now_millis() as u64;
    let mut n = 0;
    let id = loop {
        let id = format!("s{ms:013}-{n:03}");
        if !repo.refs().refs.contains_key(&stash_ref(&id)?) {
            break id;
        }
        n += 1;
    };
    let revision = repo.refs().revision;
    repo.update_refs(
        revision,
        &[RefUpdate {
            name: stash_ref(&id)?,
            expected: None,
            new: Some(commit_id),
        }],
        None,
        "stash",
        &format!("push {id}"),
    )?;
    Ok(info(&id, commit_id, &commit))
}

/// After the workspace was cleaned and verified: the index back to HEAD's tree.
pub fn finish_push(repo: &mut Repository) -> Result<()> {
    let name = RefName::new(crate::branches::INDEX_REF)?;
    if let Some(current) = repo.refs().refs.get(&name).copied() {
        let revision = repo.refs().revision;
        repo.update_refs(
            revision,
            &[RefUpdate {
                name,
                expected: Some(current),
                new: None,
            }],
            None,
            "stash",
            "index to HEAD",
        )?;
    }
    Ok(())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashApplyPlan {
    pub stash: StashInfo,
    pub pop: bool,
    pub revision: u64,
    /// The index after: HEAD's tree with the stash's staged changes.
    pub index_folders: BTreeMap<String, ObjectIdText>,
    /// The disk's side, with every conflict.
    pub restore: RestorePlan,
}

/// Plans applying (or popping) a stash onto the workspace as `snapshot` (Full, persisted, with
/// the unsaved documents) saw it.
pub fn plan_apply(
    lookup: &dyn TreeLookup,
    repo: &mut Repository,
    folders: &[FolderRoot],
    snapshot: &Snapshot,
    id: &str,
    pop: bool,
) -> Result<StashApplyPlan> {
    crate::operation::ensure_idle(repo)?;
    let stash = get(repo, id)?;
    let commit = repo.read_commit(&stash.commit.0)?;
    let base = commit.parents.first().copied();
    let revision = repo.refs().revision;
    let base_folders = commit_folders(repo, base)?;
    let work_folders = repo.read_root(&commit.root)?.folders;
    let index_root = commit
        .meta_objects
        .get("index")
        .copied()
        .ok_or_else(|| LgError::InvalidFormat(format!("stash {id} has no index")))?;
    let stash_index = repo.read_root(&index_root)?.folders;
    let head_commit = resolve_head(repo).commit();
    let head_folders = commit_folders(repo, head_commit)?;
    let index = index_state(repo)?;
    let disk = disk_folders(snapshot)?;
    let mut conflicts = Vec::new();
    let mut sets: Sets = BTreeMap::new();
    type Job = (Vec<String>, Option<TreeEntry>);
    let mut index_jobs: Vec<(FolderId, Tree, Vec<Job>)> = Vec::new();
    let mut index_after: BTreeMap<FolderId, ObjectId> = BTreeMap::new();
    {
        let reads = Trees(&MemoryAndStore { repo, lookup });
        for folder in folders {
            let fid = &folder.folder_id;
            let folder_id = fid.as_str().to_string();
            let head_tree = tree_or_empty(&head_folders, fid);
            let current_index = if index.root.is_none() {
                head_tree
            } else {
                tree_or_empty(&index.folders, fid)
            };
            if current_index != head_tree {
                for (path, _, _) in differing(&reads, head_tree, current_index)? {
                    conflicts.push(RestoreConflict::StagedChangeConflict {
                        folder_id: folder_id.clone(),
                        path,
                    });
                }
            }
            let (b, w, i) = (
                tree_or_empty(&base_folders, fid),
                tree_or_empty(&work_folders, fid),
                tree_or_empty(&stash_index, fid),
            );
            let d = tree_or_empty(&disk, fid);
            let mut folder_sets = Vec::new();
            for (path, b_entry, w_entry) in differing(&reads, b, w)? {
                let on_disk = find(&reads, Some(d), &path)?;
                let untracked = b_entry.is_none() && find(&reads, Some(i), &path)?.is_none();
                if untracked {
                    if on_disk.is_some() && !same(&on_disk, &w_entry) {
                        conflicts.push(RestoreConflict::UntrackedFileCollision {
                            folder_id: folder_id.clone(),
                            path: path.clone(),
                        });
                    }
                } else {
                    if !same(&find(&reads, Some(head_tree), &path)?, &b_entry) {
                        conflicts.push(RestoreConflict::StashBaseChanged {
                            folder_id: folder_id.clone(),
                            path: path.clone(),
                        });
                    }
                    if !same(&on_disk, &b_entry) && !same(&on_disk, &w_entry) {
                        conflicts.push(RestoreConflict::UnstagedChangeWouldBeOverwritten {
                            folder_id: folder_id.clone(),
                            path: path.clone(),
                        });
                    }
                }
                for overlay in snapshot.overlays.iter().filter(|o| {
                    o.folder_id == folder_id
                        && (o.path == path || o.path.starts_with(&format!("{path}/")))
                }) {
                    let wanted = find(&reads, Some(w), &overlay.path)?;
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
                folder_sets.push((path, w_entry));
            }
            sets.insert(fid.clone(), folder_sets);
            // The staged changes, back into the index.
            let staged = differing(&reads, b, i)?;
            for (path, b_entry, _) in &staged {
                if !same(&find(&reads, Some(head_tree), path)?, b_entry)
                    && !conflicts.iter().any(|c| matches!(c, RestoreConflict::StashBaseChanged { path: p, .. } if p == path))
                {
                    conflicts.push(RestoreConflict::StashBaseChanged {
                        folder_id: folder_id.clone(),
                        path: path.clone(),
                    });
                }
            }
            if staged.is_empty() {
                index_after.insert(fid.clone(), head_tree);
            } else {
                let jobs = staged
                    .into_iter()
                    .map(|(path, _, i_entry)| {
                        (path.split('/').map(str::to_string).collect(), i_entry)
                    })
                    .collect();
                index_jobs.push((fid.clone(), tree_of(&reads, &head_tree)?, jobs));
            }
        }
    }
    let mut txn = repo.begin_write()?;
    let mut pending = Pending::default();
    for (fid, mut tree, jobs) in index_jobs {
        for (names, entry) in jobs {
            let names: Vec<&str> = names.iter().map(String::as_str).collect();
            tree = graft(
                &mut txn,
                &mut pending,
                Some(&tree),
                "",
                &names,
                entry.as_ref(),
                &|_| false,
            )?;
        }
        index_after.insert(fid, pending.put(&mut txn, tree)?);
    }
    for tree in index_after.values() {
        if *tree == Tree::default().id() {
            txn.put_tree(&Tree::default())?;
        }
    }
    txn.commit()?;
    let mut quiet = snapshot.clone();
    quiet.overlays.clear();
    let mut restore = plan_transition(
        lookup,
        repo,
        folders,
        &quiet,
        stash.commit.0,
        &sets,
        &work_folders,
        RestorePolicy::RefuseIfDirty,
    )?;
    conflicts.append(&mut restore.conflicts);
    restore.conflicts = conflicts;
    restore.unchanged = restore.operations.is_empty() && restore.conflicts.is_empty();
    Ok(StashApplyPlan {
        stash,
        pop,
        revision,
        index_folders: index_after
            .into_iter()
            .map(|(k, v)| (k.as_str().to_string(), ObjectIdText(v)))
            .collect(),
        restore,
    })
}

/// After the disk was changed and verified: the index gets the stash's staged changes and, for
/// a pop, the stash's ref goes -- in one atomic step, only if the refs are as the plan saw them.
pub fn finish_apply(repo: &mut Repository, plan: &StashApplyPlan) -> Result<()> {
    let folders = plan
        .index_folders
        .iter()
        .map(|(k, v)| Ok((FolderId::new(k)?, v.0)))
        .collect::<Result<BTreeMap<_, _>>>()?;
    if repo.refs().revision != plan.revision {
        return Err(LgError::StaleRevision {
            expected: plan.revision,
            found: repo.refs().revision,
        });
    }
    let mut updates = Vec::new();
    if let Some(update) = index_update(repo, Root { folders })? {
        updates.push(update);
    }
    if plan.pop {
        updates.push(RefUpdate {
            name: stash_ref(&plan.stash.id)?,
            expected: Some(plan.stash.commit.0),
            new: None,
        });
    }
    if updates.is_empty() {
        return Ok(());
    }
    let revision = repo.refs().revision;
    repo.update_refs(
        revision,
        &updates,
        None,
        "stash",
        &format!(
            "{} {}",
            if plan.pop { "pop" } else { "apply" },
            plan.stash.id
        ),
    )?;
    Ok(())
}
