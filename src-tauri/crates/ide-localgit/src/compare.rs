//! Local Git against real Git, by content (LG-09). Read-only on both sides.
//!
//! The two histories are separate object spaces -- Local Git's ids are SHA-256 over its own
//! format, real Git's SHA-1 over its own -- so no commit id is ever matched with another;
//! histories are compared by what their trees hold. The caller (the app, through the real-Git
//! layer it already has) gives real Git's side as real Git reports it: HEAD and its branch, the
//! files of HEAD with their blob ids and modes, and `status` (staged, modified, untracked). This
//! module never runs Git and never reads `.git`.
//!
//! Per path of a Local commit's tree and of real Git's HEAD (files and links; folder-relative,
//! the folder's place in the repository given as a prefix):
//!
//! | State | Meaning |
//! | --- | --- |
//! | `same` | the same content (and mode) on both sides |
//! | `different` | on both sides, with different content or mode |
//! | `localOnly` | in the Local commit, not in real Git's HEAD |
//! | `gitOnly` | in real Git's HEAD, not in the Local commit |
//! | `unavailable` | cannot be decided: Local Git never stored the content (over the storage limit), or lost it |
//! | `notInLocalGit` | real Git tracks it, Local Git leaves it out (`node_modules`, `.env`, `.yavinignore`) |
//!
//! Equality is exact: Local content that is also on disk unchanged, where real Git reports the
//! path clean, is the same as HEAD's without reading anything; otherwise the Local content's real
//! Git blob id is computed (`gitblob`) and compared with HEAD's. Timestamps are never used.

use crate::error::Result;
use crate::gitblob::git_blob_id;
use crate::id::ObjectId;
use crate::object::{EntryKind, FolderId, Stored, TreeEntry};
use crate::operation::EntryState;
use crate::repository::Repository;
use crate::scan::TreeLookup;
use crate::snapshot::{FolderRoot, ObjectIdText, Snapshot};
use crate::status::tree_of;
use crate::switch::same;
use crate::transition::{commit_folders, disk_folders, tree_or_empty};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

/// One file of real Git's HEAD, as `ls-tree` reports it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GitFile {
    /// `100644`, `100755`, `120000` (a link), `160000` (a submodule).
    pub mode: String,
    pub id: String,
}

/// Real Git's side, for one workspace folder, as the app read it.
#[derive(Clone, Debug, Default)]
pub struct GitSide {
    /// HEAD's commit (none: no commit yet).
    pub head: Option<String>,
    /// The branch HEAD is on (none: detached).
    pub branch: Option<String>,
    /// The folder's path inside the repository, `/`-separated (`""`: the repository's root).
    pub prefix: String,
    /// HEAD's files, by repository-relative path.
    pub files: HashMap<String, GitFile>,
    /// Paths (repository-relative) whose index differs from HEAD.
    pub staged: HashSet<String>,
    /// Paths whose working tree differs from the index.
    pub modified: HashSet<String>,
    pub untracked: HashSet<String>,
    /// A digest of everything above: a plan made against it holds only while it is unchanged.
    pub fingerprint: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PathState {
    Same,
    Different,
    LocalOnly,
    GitOnly,
    Unavailable,
    NotInLocalGit,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GitStatus {
    Clean,
    Staged,
    Modified,
    Untracked,
    /// Neither in HEAD nor reported: ignored by real Git, or absent.
    NotTracked,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathComparison {
    pub folder_id: String,
    /// Folder-relative.
    pub path: String,
    pub state: PathState,
    pub local: Option<EntryState>,
    /// Real Git's HEAD: mode and blob id.
    pub git_mode: Option<String>,
    pub git_id: Option<String>,
    pub git_status: GitStatus,
    /// The working tree holds exactly the Local content.
    pub disk_matches_local: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    /// The Local commit compared (none: no Local history).
    pub local_commit: Option<ObjectIdText>,
    pub local_branch: Option<String>,
    /// Whether a real Git repository was found.
    pub git_repository: bool,
    pub git_head: Option<String>,
    pub git_branch: Option<String>,
    /// Paths that are not `same` (at most `limit`).
    pub entries: Vec<PathComparison>,
    pub counts: BTreeMap<String, usize>,
    pub truncated: bool,
    /// Every compared path is the same: the Local commit holds exactly real Git's HEAD.
    pub identical: bool,
    /// What each side has staged (folder-relative), for comparing staged states.
    pub local_staged: Vec<String>,
    pub git_staged: Vec<String>,
}

fn join(prefix: &str, name: &str) -> String {
    if prefix.is_empty() {
        name.to_string()
    } else {
        format!("{prefix}/{name}")
    }
}

/// Every file and link under `tree`, by path.
fn flatten(
    lookup: &dyn TreeLookup,
    tree: ObjectId,
    prefix: &str,
    out: &mut BTreeMap<String, TreeEntry>,
) -> Result<()> {
    for entry in tree_of(lookup, &tree)?.entries() {
        let path = join(prefix, entry.name.as_str());
        if entry.kind == EntryKind::Directory {
            flatten(lookup, entry.id, &path, out)?;
        } else {
            out.insert(path, entry.clone());
        }
    }
    Ok(())
}

fn git_mode_of(entry: &TreeEntry) -> &'static str {
    match entry.kind {
        EntryKind::File {
            executable: true, ..
        } => "100755",
        EntryKind::File { .. } => "100644",
        EntryKind::Symlink(_) => "120000",
        EntryKind::Directory => "040000",
    }
}

/// The Local entry's real Git blob id, from its stored content (none: not stored, or lost).
fn local_git_id(repo: &Repository, entry: &TreeEntry) -> Option<String> {
    if let EntryKind::File {
        stored: Stored::No { .. },
        ..
    } = entry.kind
    {
        return None;
    }
    let mut bytes = Vec::new();
    repo.stream_blob(&entry.id, &mut bytes).ok()?;
    Some(git_blob_id(&bytes))
}

/// Compares `local` (a Local commit, or none) with real Git's side of each folder, the working
/// tree as `snapshot` (Full, without unsaved documents) saw it serving as the bridge. Folders
/// with no real Git side are reported as having no repository.
pub fn compare(
    lookup: &dyn TreeLookup,
    repo: &Repository,
    folders: &[FolderRoot],
    snapshot: &Snapshot,
    local: Option<ObjectId>,
    git: &BTreeMap<FolderId, GitSide>,
    limit: usize,
) -> Result<Comparison> {
    let local_folders = commit_folders(repo, local)?;
    let disk = disk_folders(snapshot)?;
    let reads = crate::switch::Trees(&crate::switch::MemoryAndStore { repo, lookup });
    let mut entries = Vec::new();
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut total = 0usize;
    let mut git_staged = BTreeSet::new();
    for folder in folders {
        let fid = &folder.folder_id;
        let Some(side) = git.get(fid) else { continue };
        let mut local_files = BTreeMap::new();
        if local.is_some() {
            flatten(
                &reads,
                tree_or_empty(&local_folders, fid),
                "",
                &mut local_files,
            )?;
        }
        let mut disk_files = BTreeMap::new();
        flatten(&reads, tree_or_empty(&disk, fid), "", &mut disk_files)?;
        let inside = |repo_path: &str| -> Option<String> {
            if side.prefix.is_empty() {
                Some(repo_path.to_string())
            } else {
                repo_path
                    .strip_prefix(&format!("{}/", side.prefix))
                    .map(str::to_string)
            }
        };
        let in_repo = |path: &str| join(&side.prefix, path);
        let git_files: BTreeMap<String, &GitFile> = side
            .files
            .iter()
            .filter_map(|(path, file)| inside(path).map(|p| (p, file)))
            .collect();
        for path in side.staged.iter().filter_map(|p| inside(p)) {
            git_staged.insert(path);
        }
        let paths: BTreeSet<&String> = local_files.keys().chain(git_files.keys()).collect();
        for path in paths {
            let local_entry = local_files.get(path).cloned();
            let disk_entry = disk_files.get(path).cloned();
            let git_file = git_files.get(path).copied();
            let repo_path = in_repo(path);
            let git_status = if side.staged.contains(&repo_path) {
                GitStatus::Staged
            } else if side.modified.contains(&repo_path) {
                GitStatus::Modified
            } else if side.untracked.contains(&repo_path) {
                GitStatus::Untracked
            } else if git_file.is_some() {
                GitStatus::Clean
            } else {
                GitStatus::NotTracked
            };
            let disk_matches_local = local_entry.is_some() && same(&local_entry, &disk_entry);
            let state = match (&local_entry, git_file) {
                (None, None) => continue,
                (Some(_), None) => PathState::LocalOnly,
                (None, Some(_)) => {
                    // On disk, yet not in Local Git's snapshot of it: Local Git leaves it out.
                    let on_disk = std::fs::symlink_metadata(folder.path.join(path)).is_ok();
                    if on_disk && disk_entry.is_none() {
                        PathState::NotInLocalGit
                    } else {
                        PathState::GitOnly
                    }
                }
                (Some(entry), Some(file)) => {
                    if git_mode_of(entry) != file.mode {
                        PathState::Different
                    } else if disk_matches_local && git_status == GitStatus::Clean {
                        PathState::Same
                    } else {
                        match local_git_id(repo, entry) {
                            Some(id) if id == file.id => PathState::Same,
                            Some(_) => PathState::Different,
                            None => PathState::Unavailable,
                        }
                    }
                }
            };
            total += 1;
            let key = serde_json::to_value(state)
                .ok()
                .and_then(|v| v.as_str().map(str::to_string))
                .unwrap_or_default();
            *counts.entry(key).or_default() += 1;
            if state != PathState::Same && entries.len() < limit {
                entries.push(PathComparison {
                    folder_id: fid.as_str().to_string(),
                    path: path.clone(),
                    state,
                    local: EntryState::of_opt(&local_entry),
                    git_mode: git_file.map(|f| f.mode.clone()),
                    git_id: git_file.map(|f| f.id.clone()),
                    git_status,
                    disk_matches_local,
                });
            }
        }
    }
    let first = folders.iter().find_map(|f| git.get(&f.folder_id));
    let differing = counts
        .iter()
        .filter(|(k, _)| k.as_str() != "same")
        .map(|(_, v)| v)
        .sum::<usize>();
    let local_staged = local_staged(lookup, repo, folders)?;
    Ok(Comparison {
        local_commit: local.map(ObjectIdText),
        local_branch: match crate::branches::resolve_head(repo) {
            crate::branches::HeadState::Branch { name, .. }
            | crate::branches::HeadState::Unborn { name, .. } => Some(name),
            crate::branches::HeadState::Detached { .. } => None,
        },
        git_repository: first.is_some(),
        git_head: first.and_then(|s| s.head.clone()),
        git_branch: first.and_then(|s| s.branch.clone()),
        truncated: entries.len() < differing,
        identical: first.is_some() && differing == 0 && total > 0,
        entries,
        counts,
        local_staged,
        git_staged: git_staged.into_iter().collect(),
    })
}

/// What Local Git has staged (the index against HEAD), folder-relative.
fn local_staged(
    lookup: &dyn TreeLookup,
    repo: &Repository,
    folders: &[FolderRoot],
) -> Result<Vec<String>> {
    let index = crate::branches::index_state(repo)?;
    if index.root.is_none() {
        return Ok(Vec::new());
    }
    let head = commit_folders(repo, crate::branches::resolve_head(repo).commit())?;
    let reads = crate::switch::Trees(&crate::switch::MemoryAndStore { repo, lookup });
    let mut out = Vec::new();
    for folder in folders {
        let fid = &folder.folder_id;
        for (path, _, _) in crate::switch::differing(
            &reads,
            tree_or_empty(&head, fid),
            tree_or_empty(&index.folders, fid),
        )? {
            out.push(path);
        }
    }
    Ok(out)
}
