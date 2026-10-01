//! Promotion (LG-09): a Local Git commit's content, explicitly brought into the working tree
//! real Git works in -- for the user to review, stage and commit with real Git.
//!
//! Promotion is not a real Git operation. It writes the working tree only, through LG-03's
//! restore machinery (planned here, carried out by the app as one Module 03 operation recorded
//! by Module 04, after a Local Git recovery checkpoint), and never touches real Git's index,
//! HEAD, branches or history: no commit, no staging, no push. What it writes is exactly what
//! differs between the Local commit and real Git's HEAD (`compare.rs`): files to change, create
//! and delete; paths Local Git leaves out are never touched.
//!
//! **Refused, with every reason, before anything changes**, wherever the user's work would be
//! overwritten: a path real Git reports staged or modified (`realGitChanged`), an untracked or
//! ignored file in the way (`untrackedFileCollision`), a document with unsaved changes on a path
//! it writes, content Local Git never stored, and everything the restore planner refuses. The
//! plan records real Git's state as it was read (`GitSide::fingerprint`); the app reads it again
//! right before writing and refuses if anything changed.

use crate::compare::{compare, GitSide, GitStatus, PathState};
use crate::error::Result;
use crate::id::ObjectId;
use crate::object::FolderId;
use crate::repository::Repository;
use crate::restore::{RestoreConflict, RestorePlan, RestorePolicy};
use crate::scan::TreeLookup;
use crate::snapshot::{FolderRoot, ObjectIdText, Snapshot};
use crate::status::find;
use crate::switch::{MemoryAndStore, Trees};
use crate::transition::{commit_folders, plan_transition, tree_or_empty, Sets};
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromotedPath {
    pub folder_id: String,
    pub path: String,
    /// `create`, `modify` or `delete`, against real Git's HEAD.
    pub action: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromotionPlan {
    pub local_commit: ObjectIdText,
    pub git_head: Option<String>,
    pub git_branch: Option<String>,
    /// Real Git's state when planned, per folder: the app refuses if it changed.
    pub git_fingerprints: BTreeMap<String, String>,
    pub paths: Vec<PromotedPath>,
    /// Every reason it cannot be done (the restore planner's included, in `restore`).
    pub refusals: Vec<RestoreConflict>,
    /// The working tree's side.
    pub restore: RestorePlan,
}

/// Plans promoting `local` into the working tree, from the workspace as `snapshot` (Full,
/// persisted, with the unsaved documents) saw it and real Git's side of each folder.
pub fn plan(
    lookup: &dyn TreeLookup,
    repo: &mut Repository,
    folders: &[FolderRoot],
    snapshot: &Snapshot,
    local: ObjectId,
    git: &BTreeMap<FolderId, GitSide>,
) -> Result<PromotionPlan> {
    crate::history::require_commit(repo, &local)?;
    let comparison = compare(
        lookup,
        repo,
        folders,
        snapshot,
        Some(local),
        git,
        usize::MAX,
    )?;
    let local_folders = commit_folders(repo, Some(local))?;
    let mut sets: Sets = BTreeMap::new();
    let mut paths = Vec::new();
    let mut refusals = Vec::new();
    let mut touched: Vec<(String, String)> = Vec::new();
    {
        let reads = Trees(&MemoryAndStore { repo, lookup });
        for entry in &comparison.entries {
            let action = match entry.state {
                PathState::Same | PathState::NotInLocalGit => continue,
                PathState::Different | PathState::Unavailable => "modify",
                PathState::LocalOnly => "create",
                PathState::GitOnly => "delete",
            };
            if entry.disk_matches_local {
                // The working tree already holds the Local content: nothing to write.
                continue;
            }
            let fid = FolderId::new(&entry.folder_id)?;
            match entry.git_status {
                GitStatus::Staged | GitStatus::Modified => {
                    refusals.push(RestoreConflict::RealGitChanged {
                        folder_id: entry.folder_id.clone(),
                        path: entry.path.clone(),
                        staged: entry.git_status == GitStatus::Staged,
                    });
                }
                GitStatus::Untracked | GitStatus::NotTracked => {
                    let on_disk = std::fs::symlink_metadata(
                        folders
                            .iter()
                            .find(|f| f.folder_id == fid)
                            .map(|f| f.path.join(&entry.path))
                            .unwrap_or_default(),
                    )
                    .is_ok();
                    if on_disk {
                        refusals.push(RestoreConflict::UntrackedFileCollision {
                            folder_id: entry.folder_id.clone(),
                            path: entry.path.clone(),
                        });
                    }
                }
                GitStatus::Clean => {}
            }
            let wanted = find(
                &reads,
                Some(tree_or_empty(&local_folders, &fid)),
                &entry.path,
            )?;
            sets.entry(fid)
                .or_default()
                .push((entry.path.clone(), wanted));
            touched.push((entry.folder_id.clone(), entry.path.clone()));
            paths.push(PromotedPath {
                folder_id: entry.folder_id.clone(),
                path: entry.path.clone(),
                action,
            });
        }
    }
    // Documents matter only on the paths it writes.
    let mut documents = snapshot.clone();
    documents.overlays.retain(|o| {
        touched
            .iter()
            .any(|(f, p)| *f == o.folder_id && *p == o.path)
    });
    let mut restore = plan_transition(
        lookup,
        repo,
        folders,
        &documents,
        local,
        &sets,
        &local_folders,
        RestorePolicy::RefuseIfDirty,
    )?;
    restore.conflicts.splice(0..0, refusals.clone());
    restore.unchanged = restore.operations.is_empty() && restore.conflicts.is_empty();
    Ok(PromotionPlan {
        local_commit: ObjectIdText(local),
        git_head: comparison.git_head,
        git_branch: comparison.git_branch,
        git_fingerprints: git
            .iter()
            .map(|(f, side)| (f.as_str().to_string(), side.fingerprint.clone()))
            .collect(),
        paths,
        refusals: restore.conflicts.clone(),
        restore,
    })
}
