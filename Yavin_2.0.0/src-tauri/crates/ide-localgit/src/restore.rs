//! Restore planning (LG-03): what it would take to make the workspace match a commit, and
//! everything that stands in the way -- computed completely before anything is touched.
//!
//! Local Git never writes into a project. This module only *plans*: it compares the current
//! snapshot (disk, and unsaved documents) with the target commit and produces an ordered list
//! of operations and a list of conflicts. The app's file-operation layer carries the plan out
//! as one Module 03 operation recorded by Module 04 (`src-tauri/src/localgit_restore.rs`), and
//! the window reconciles its documents through DocumentService afterwards.
//!
//! **Operations**, in the order they must run: removals (files, links, then directories,
//! deepest first), then new directories (shallowest first), then files and links written.
//! Each names the state the plan saw at its path (`Expected`), which the executor checks again
//! before touching anything: a path that changed since is `diskChangedSinceSnapshot`, and
//! nothing is done.
//!
//! **Conflicts** stop a restore before it starts:
//!
//! | Conflict | When |
//! | --- | --- |
//! | `dirtyDocumentWouldBeOverwritten` | a document with unsaved changes would get other content (policy `refuseIfDirty`) |
//! | `dirtyDocumentWouldBeDeleted` | a document with unsaved changes would be removed (policy `refuseIfDirty`) |
//! | `historicalContentUnavailable` | the commit's content for a path was never stored (over the size limit) or is missing |
//! | `currentContentNotStored` | a file over the size limit would be replaced or removed -- no checkpoint can keep it |
//! | `currentStateUnknown` | the snapshot could not read a path in scope (locked, unstable, unrepresentable) |
//! | `pathBlocked` | a single-path restore needs a folder where a file or link is |
//! | `caseOnlyRename` | the commit and the disk spell one name differently in letter case only |
//! | `targetUnavailable` | the commit does not have the folder (or path) asked for |
//!
//! The executor adds what only the disk can tell at the last moment: `diskChangedSinceSnapshot`,
//! `pathBlocked` (a link on the way), `linkNotRestorable`, and `wouldRemoveUntracked` (a folder
//! to remove holds something snapshots leave out -- a nested `.git`, `node_modules` -- which a
//! restore never deletes).
//!
//! With policy `replaceDocument`, the two document conflicts become document actions instead:
//! the restore goes ahead and the window discards those documents' unsaved changes (reloading
//! or closing them) afterwards -- by the user's explicit choice, never by default.

use crate::error::{LgError, Result};
use crate::id::ObjectId;
use crate::object::{EntryKind, FolderId, LinkKind, Stored, Tree, TreeEntry};
use crate::repository::Repository;
use crate::scan::{name_key, Problem, TreeLookup};
use crate::snapshot::{FolderRoot, ObjectIdText, Snapshot};
use crate::status::tree_of;
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum RestorePolicy {
    /// Refuse when a document with unsaved changes would be overwritten or deleted.
    #[default]
    RefuseIfDirty,
    /// Go ahead, and have the window discard those documents' unsaved changes.
    ReplaceDocument,
}

/// What the plan saw at a path, before the restore.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Expected {
    Absent,
    #[serde(rename_all = "camelCase")]
    File {
        id: ObjectIdText,
        stored: bool,
    },
    Directory,
    #[serde(rename_all = "camelCase")]
    Link {
        id: ObjectIdText,
    },
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OpKind {
    RemoveFile,
    RemoveLink,
    RemoveDirectory,
    CreateDirectory,
    WriteFile,
    CreateLink,
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreOp {
    pub kind: OpKind,
    pub folder_id: String,
    /// Folder-relative, `/`-separated.
    pub path: String,
    /// The state at `path` before the restore.
    pub expected: Expected,
    /// For a file or link written: its blob (a link's is its target text).
    pub blob: Option<ObjectIdText>,
    pub size: Option<u64>,
    pub executable: bool,
    pub link: Option<&'static str>,
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RestoreConflict {
    #[serde(rename_all = "camelCase")]
    DirtyDocumentWouldBeOverwritten { folder_id: String, path: String },
    #[serde(rename_all = "camelCase")]
    DirtyDocumentWouldBeDeleted { folder_id: String, path: String },
    #[serde(rename_all = "camelCase")]
    HistoricalContentUnavailable {
        folder_id: String,
        path: String,
        /// `notStored` or `missing`.
        reason: &'static str,
    },
    #[serde(rename_all = "camelCase")]
    CurrentContentNotStored { folder_id: String, path: String },
    #[serde(rename_all = "camelCase")]
    CurrentStateUnknown {
        folder_id: String,
        path: String,
        reason: String,
    },
    #[serde(rename_all = "camelCase")]
    PathBlocked { folder_id: String, path: String },
    #[serde(rename_all = "camelCase")]
    CaseOnlyRename {
        folder_id: String,
        path: String,
        on_disk: String,
    },
    #[serde(rename_all = "camelCase")]
    TargetUnavailable { folder_id: String, path: String },
    /// A switch (LG-04): something is staged, and the index is about to become the target's.
    #[serde(rename_all = "camelCase")]
    StagedChangeConflict { folder_id: String, path: String },
    /// A switch (LG-04): a path the switch changes holds neither HEAD's content nor the
    /// target's (a local change, or an untracked file in the way).
    #[serde(rename_all = "camelCase")]
    UnstagedChangeWouldBeOverwritten { folder_id: String, path: String },
    /// A stash (LG-05): HEAD no longer has, at a path the stash changes, what the stash was
    /// made on; applying it would mean merging, which stash does not do.
    #[serde(rename_all = "camelCase")]
    StashBaseChanged { folder_id: String, path: String },
    /// A stash (LG-05): an untracked file the stash would bring back is already there, with
    /// other content.
    #[serde(rename_all = "camelCase")]
    UntrackedFileCollision { folder_id: String, path: String },
    /// Found by the executor: a folder the restore would remove holds something snapshots
    /// leave out (`.git`, `node_modules`, `.env`, ...). It is never removed.
    #[serde(rename_all = "camelCase")]
    WouldRemoveUntracked {
        folder_id: String,
        path: String,
        entry: String,
    },
    /// Found by the executor: the disk no longer holds what the plan saw.
    #[serde(rename_all = "camelCase")]
    DiskChangedSinceSnapshot { folder_id: String, path: String },
    /// Found by the executor: this system cannot create the link (Windows symbolic links need
    /// Developer Mode or elevation).
    #[serde(rename_all = "camelCase")]
    LinkNotRestorable {
        folder_id: String,
        path: String,
        reason: String,
    },
}

/// A document the window must reconcile after the restore (policy `replaceDocument`).
#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentAction {
    pub folder_id: String,
    pub path: String,
    /// `overwrite`: reload it, discarding its unsaved changes. `delete`: close it, discarding them.
    pub action: &'static str,
    pub version: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePlan {
    pub commit: ObjectIdText,
    pub target_root: ObjectIdText,
    /// The one path restored, or none for the whole commit.
    pub scope: Option<String>,
    /// The folder `scope` is in.
    pub scope_folder: Option<String>,
    pub policy: RestorePolicy,
    pub operations: Vec<RestoreOp>,
    pub conflicts: Vec<RestoreConflict>,
    pub documents: Vec<DocumentAction>,
    /// The disk already matches (and no document needs anything).
    pub unchanged: bool,
    /// The snapshot the plan compared with.
    pub snapshot_sequence: u64,
    pub disk_root: ObjectIdText,
}

fn join(prefix: &str, name: &str) -> String {
    if prefix.is_empty() {
        name.to_string()
    } else {
        format!("{prefix}/{name}")
    }
}

fn expected_of(entry: Option<&TreeEntry>) -> Expected {
    match entry {
        None => Expected::Absent,
        Some(entry) => match entry.kind {
            EntryKind::File { stored, .. } => Expected::File {
                id: ObjectIdText(entry.id),
                stored: stored == Stored::Yes,
            },
            EntryKind::Directory => Expected::Directory,
            EntryKind::Symlink(_) => Expected::Link {
                id: ObjectIdText(entry.id),
            },
        },
    }
}

fn link_name(kind: LinkKind) -> &'static str {
    match kind {
        LinkKind::File => "file",
        LinkKind::Directory => "directory",
        LinkKind::Junction => "junction",
    }
}

struct Planner<'a> {
    lookup: &'a dyn TreeLookup,
    repo: &'a Repository,
    folder: String,
    ops: Vec<RestoreOp>,
    conflicts: Vec<RestoreConflict>,
}

impl Planner<'_> {
    fn op(
        &mut self,
        kind: OpKind,
        path: &str,
        before: Option<&TreeEntry>,
        target: Option<&TreeEntry>,
    ) {
        let (blob, size, executable, link) = match target.map(|t| (t, t.kind)) {
            Some((t, EntryKind::File { executable, stored })) => (
                Some(ObjectIdText(t.id)),
                match stored {
                    Stored::No { size } => Some(size),
                    Stored::Yes => self.repo.object_info(&t.id).ok().map(|(_, size)| size),
                },
                executable,
                None,
            ),
            Some((t, EntryKind::Symlink(kind))) => {
                (Some(ObjectIdText(t.id)), None, false, Some(link_name(kind)))
            }
            _ => (None, None, false, None),
        };
        self.ops.push(RestoreOp {
            kind,
            folder_id: self.folder.clone(),
            path: path.to_string(),
            expected: expected_of(before),
            blob,
            size,
            executable,
            link,
        });
    }

    fn check_available(&mut self, path: &str, target: &TreeEntry) {
        let reason = match target.kind {
            EntryKind::File {
                stored: Stored::No { .. },
                ..
            } => Some("notStored"),
            EntryKind::Directory => None,
            _ if !self.repo.contains(&target.id) => Some("missing"),
            _ => None,
        };
        if let Some(reason) = reason {
            self.conflicts
                .push(RestoreConflict::HistoricalContentUnavailable {
                    folder_id: self.folder.clone(),
                    path: path.into(),
                    reason,
                });
        }
    }

    fn check_current_kept(&mut self, path: &str, before: &TreeEntry) {
        if let EntryKind::File {
            stored: Stored::No { .. },
            ..
        } = before.kind
        {
            self.conflicts
                .push(RestoreConflict::CurrentContentNotStored {
                    folder_id: self.folder.clone(),
                    path: path.into(),
                });
        }
    }

    /// Removes what is on disk at `path` (everything below it, for a directory).
    fn remove(&mut self, path: &str, before: &TreeEntry) -> Result<()> {
        match before.kind {
            EntryKind::Directory => {
                let tree = tree_of(self.lookup, &before.id)?;
                for child in tree.entries() {
                    self.remove(&join(path, child.name.as_str()), child)?;
                }
                self.op(OpKind::RemoveDirectory, path, Some(before), None);
            }
            EntryKind::Symlink(_) => self.op(OpKind::RemoveLink, path, Some(before), None),
            EntryKind::File { .. } => {
                self.check_current_kept(path, before);
                self.op(OpKind::RemoveFile, path, Some(before), None);
            }
        }
        Ok(())
    }

    /// Creates the commit's entry at `path` (everything below it, for a directory). `before`
    /// is what was there (already planned to be removed), for the executor's check.
    fn create(&mut self, path: &str, target: &TreeEntry, before: Option<&TreeEntry>) -> Result<()> {
        match target.kind {
            EntryKind::Directory => {
                self.op(OpKind::CreateDirectory, path, before, Some(target));
                let tree = tree_of(self.lookup, &target.id)?;
                for child in tree.entries() {
                    self.create(&join(path, child.name.as_str()), child, None)?;
                }
            }
            EntryKind::Symlink(_) => {
                self.check_available(path, target);
                self.op(OpKind::CreateLink, path, before, Some(target));
            }
            EntryKind::File { .. } => {
                self.check_available(path, target);
                self.op(OpKind::WriteFile, path, before, Some(target));
            }
        }
        Ok(())
    }

    /// Makes `path` hold `target` where it holds `before` now.
    fn entry(
        &mut self,
        path: &str,
        before: Option<&TreeEntry>,
        target: Option<&TreeEntry>,
    ) -> Result<()> {
        match (before, target) {
            (None, None) => {}
            (Some(before), None) => self.remove(path, before)?,
            (None, Some(target)) => self.create(path, target, None)?,
            (Some(before), Some(target)) => {
                if before.id == target.id && before.kind == target.kind {
                    return Ok(());
                }
                match (before.kind, target.kind) {
                    (EntryKind::Directory, EntryKind::Directory) => {
                        let (b, t) = (
                            tree_of(self.lookup, &before.id)?,
                            tree_of(self.lookup, &target.id)?,
                        );
                        self.dir(path, &b, &t)?;
                    }
                    (EntryKind::File { .. }, EntryKind::File { .. }) => {
                        self.check_current_kept(path, before);
                        self.check_available(path, target);
                        self.op(OpKind::WriteFile, path, Some(before), Some(target));
                    }
                    _ => {
                        // A type change, or a link retargeted: out with the old, in with the new.
                        self.remove(path, before)?;
                        self.create(path, target, Some(before))?;
                    }
                }
            }
        }
        Ok(())
    }

    fn dir(&mut self, prefix: &str, before: &Tree, target: &Tree) -> Result<()> {
        let mut names: BTreeMap<&str, (Option<&TreeEntry>, Option<&TreeEntry>)> = BTreeMap::new();
        for entry in before.entries() {
            names.entry(entry.name.as_str()).or_default().0 = Some(entry);
        }
        for entry in target.entries() {
            names.entry(entry.name.as_str()).or_default().1 = Some(entry);
        }
        // Spellings that differ only in case are one file on a case-insensitive disk.
        if cfg!(windows) {
            for entry in target.entries() {
                if let Some(on_disk) = before.entries().iter().find(|b| {
                    b.name != entry.name
                        && name_key(b.name.as_str()) == name_key(entry.name.as_str())
                }) {
                    self.conflicts.push(RestoreConflict::CaseOnlyRename {
                        folder_id: self.folder.clone(),
                        path: join(prefix, entry.name.as_str()),
                        on_disk: join(prefix, on_disk.name.as_str()),
                    });
                }
            }
        }
        for (name, (b, t)) in names {
            self.entry(&join(prefix, name), b, t)?;
        }
        Ok(())
    }
}

fn depth(path: &str) -> usize {
    path.split('/').count()
}

/// The order a plan's operations must run in.
fn order(ops: &mut [RestoreOp]) {
    let phase = |kind: OpKind| match kind {
        OpKind::RemoveFile | OpKind::RemoveLink | OpKind::RemoveDirectory => 0,
        OpKind::CreateDirectory => 1,
        OpKind::WriteFile | OpKind::CreateLink => 2,
    };
    ops.sort_by(|a, b| {
        let (pa, pb) = (phase(a.kind), phase(b.kind));
        pa.cmp(&pb)
            .then_with(|| match pa {
                // Removals: deepest first, so a folder is empty when its turn comes.
                0 => depth(&b.path).cmp(&depth(&a.path)),
                1 => depth(&a.path).cmp(&depth(&b.path)),
                _ => std::cmp::Ordering::Equal,
            })
            .then_with(|| a.folder_id.cmp(&b.folder_id))
            .then_with(|| a.path.cmp(&b.path))
    });
}

fn inside(path: &str, scope: &str) -> bool {
    scope.is_empty() || path == scope || path.starts_with(&format!("{scope}/"))
}

/// Plans restoring `target` (a commit, whose root's folders are `target_folders`) over the
/// workspace as `snapshot` saw it -- all of it, or only `scope` (a folder and a path in it).
#[allow(clippy::too_many_arguments)]
pub fn plan(
    lookup: &dyn TreeLookup,
    repo: &Repository,
    folders: &[FolderRoot],
    snapshot: &Snapshot,
    commit: ObjectId,
    target_root: ObjectId,
    target_folders: &BTreeMap<FolderId, ObjectId>,
    scope: Option<(&FolderId, &str)>,
    policy: RestorePolicy,
) -> Result<RestorePlan> {
    let mut ops = Vec::new();
    let mut conflicts = Vec::new();
    let mut documents = Vec::new();
    for folder in folders {
        let folder_id = folder.folder_id.as_str().to_string();
        let scoped = match scope {
            Some((only, path)) if *only == folder.folder_id => Some(path.trim_matches('/')),
            Some(_) => continue,
            None => None,
        };
        let disk_tree = snapshot
            .folders
            .iter()
            .find(|f| f.folder_id == folder_id)
            .map(|f| f.disk_tree.0)
            .ok_or_else(|| LgError::InvalidFormat(format!("no snapshot of folder {folder_id}")))?;
        let Some(target_tree) = target_folders.get(&folder.folder_id).copied() else {
            conflicts.push(RestoreConflict::TargetUnavailable {
                folder_id: folder_id.clone(),
                path: scoped.unwrap_or("").into(),
            });
            continue;
        };
        let mut planner = Planner {
            lookup,
            repo,
            folder: folder_id.clone(),
            ops: Vec::new(),
            conflicts: Vec::new(),
        };
        let scope_path = scoped.unwrap_or("");
        match scoped {
            None | Some("") => {
                let (b, t) = (tree_of(lookup, &disk_tree)?, tree_of(lookup, &target_tree)?);
                planner.dir("", &b, &t)?;
            }
            Some(path) => {
                // Walk to the path's parent in both trees; folders missing on disk are made.
                let names: Vec<&str> = path.split('/').collect();
                let (last, parents) = names.split_last().expect("a path has a name");
                let mut disk = Some(tree_of(lookup, &disk_tree)?);
                let mut target = Some(tree_of(lookup, &target_tree)?);
                let mut prefix = String::new();
                let mut blocked = false;
                for name in parents {
                    let here = join(&prefix, name);
                    let find = |tree: &Option<Tree>| {
                        tree.as_ref().and_then(|tree| {
                            tree.entries()
                                .iter()
                                .find(|e| e.name.as_str() == *name)
                                .cloned()
                        })
                    };
                    let (d, t) = (find(&disk), find(&target));
                    target = match &t {
                        Some(entry) if entry.kind == EntryKind::Directory => {
                            Some(tree_of(lookup, &entry.id)?)
                        }
                        _ => None,
                    };
                    disk = match &d {
                        Some(entry) if entry.kind == EntryKind::Directory => {
                            Some(tree_of(lookup, &entry.id)?)
                        }
                        None => {
                            if target.is_some() {
                                planner.op(OpKind::CreateDirectory, &here, None, t.as_ref());
                            }
                            None
                        }
                        Some(_) => {
                            if target.is_some() {
                                blocked = true;
                                planner.conflicts.push(RestoreConflict::PathBlocked {
                                    folder_id: folder_id.clone(),
                                    path: here.clone(),
                                });
                            }
                            None
                        }
                    };
                    prefix = here;
                }
                if !blocked {
                    let find = |tree: &Option<Tree>| {
                        tree.as_ref().and_then(|tree| {
                            tree.entries()
                                .iter()
                                .find(|e| e.name.as_str() == *last)
                                .cloned()
                        })
                    };
                    let (d, t) = (find(&disk), find(&target));
                    if d.is_none() && t.is_none() {
                        planner.conflicts.push(RestoreConflict::TargetUnavailable {
                            folder_id: folder_id.clone(),
                            path: path.into(),
                        });
                    }
                    // Only the path's own folders are made: none if there is nothing to create.
                    if t.is_none() {
                        planner.ops.retain(|op| op.kind != OpKind::CreateDirectory);
                    }
                    planner.entry(path, d.as_ref(), t.as_ref())?;
                }
            }
        }
        // What the snapshot could not read, in scope: its real state is unknown.
        for problem in &snapshot.problems {
            let (problem_folder, path, reason) = match problem {
                Problem::Unstable {
                    folder_id, path, ..
                } => (folder_id, path, "unstable".to_string()),
                Problem::Unreadable {
                    folder_id,
                    path,
                    detail,
                    ..
                } => (folder_id, path, detail.clone()),
                Problem::Unrepresentable {
                    folder_id,
                    path,
                    detail,
                } => (folder_id, path, detail.clone()),
                Problem::Unsupported {
                    folder_id,
                    path,
                    what,
                } => (folder_id, path, what.clone()),
                _ => continue,
            };
            if *problem_folder == folder_id
                && (inside(path, scope_path) || inside(scope_path, path))
            {
                planner
                    .conflicts
                    .push(RestoreConflict::CurrentStateUnknown {
                        folder_id: folder_id.clone(),
                        path: path.clone(),
                        reason,
                    });
            }
        }
        // Unsaved documents in scope: kept, or replaced by the user's choice.
        for overlay in snapshot
            .overlays
            .iter()
            .filter(|o| o.folder_id == folder_id)
        {
            if !inside(&overlay.path, scope_path) {
                continue;
            }
            let target_entry = crate::status::find(lookup, Some(target_tree), &overlay.path)?;
            let same = target_entry.as_ref().is_some_and(|entry| {
                matches!(entry.kind, EntryKind::File { .. }) && entry.id == overlay.blob.0
            });
            if same {
                continue;
            }
            let overwrite = matches!(
                target_entry,
                Some(TreeEntry {
                    kind: EntryKind::File { .. },
                    ..
                })
            );
            match policy {
                RestorePolicy::RefuseIfDirty => planner.conflicts.push(if overwrite {
                    RestoreConflict::DirtyDocumentWouldBeOverwritten {
                        folder_id: folder_id.clone(),
                        path: overlay.path.clone(),
                    }
                } else {
                    RestoreConflict::DirtyDocumentWouldBeDeleted {
                        folder_id: folder_id.clone(),
                        path: overlay.path.clone(),
                    }
                }),
                RestorePolicy::ReplaceDocument => documents.push(DocumentAction {
                    folder_id: folder_id.clone(),
                    path: overlay.path.clone(),
                    action: if overwrite { "overwrite" } else { "delete" },
                    version: overlay.version,
                }),
            }
        }
        ops.extend(planner.ops);
        conflicts.extend(planner.conflicts);
    }
    order(&mut ops);
    Ok(RestorePlan {
        commit: ObjectIdText(commit),
        target_root: ObjectIdText(target_root),
        scope: scope.map(|(_, path)| path.to_string()),
        scope_folder: scope.map(|(folder, _)| folder.as_str().to_string()),
        policy,
        unchanged: ops.is_empty() && documents.is_empty() && conflicts.is_empty(),
        operations: ops,
        conflicts,
        documents,
        snapshot_sequence: snapshot.sequence,
        disk_root: snapshot.disk_root,
    })
}

/// What a Full snapshot taken after a restore says about it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Verification {
    /// The disk now holds exactly the commit's state (in scope).
    pub matches: bool,
    /// Paths that do not (at most 100), as `<folder>:<path> <change>`.
    pub mismatches: Vec<String>,
    pub disk_root: ObjectIdText,
    pub snapshot_sequence: u64,
}

/// Compares a snapshot taken after a restore with what the restore aimed for.
pub fn verify(
    lookup: &dyn TreeLookup,
    snapshot: &Snapshot,
    target_folders: &BTreeMap<FolderId, ObjectId>,
    scope: Option<(&FolderId, &str)>,
) -> Result<Verification> {
    let mut mismatches = Vec::new();
    for folder in &snapshot.folders {
        let Ok(folder_id) = FolderId::new(&folder.folder_id) else {
            continue;
        };
        let path = match scope {
            Some((only, path)) if *only == folder_id => Some(path),
            Some(_) => continue,
            None => None,
        };
        let target = target_folders.get(&folder_id).copied();
        match path {
            None | Some("") => {
                let Some(target) = target else {
                    mismatches.push(format!("{}: not in the commit", folder.folder_id));
                    continue;
                };
                if target == folder.disk_tree.0 {
                    continue;
                }
                for leaf in crate::status::changes(lookup, Some(target), folder.disk_tree.0)? {
                    mismatches.push(format!(
                        "{}:{} {:?}",
                        folder.folder_id, leaf.path, leaf.kind
                    ));
                }
            }
            Some(path) => {
                let on_disk = crate::status::find(lookup, Some(folder.disk_tree.0), path)?;
                let wanted = match target {
                    Some(target) => crate::status::find(lookup, Some(target), path)?,
                    None => None,
                };
                let same = match (&on_disk, &wanted) {
                    (None, None) => true,
                    (Some(a), Some(b)) => a.id == b.id && a.kind == b.kind,
                    _ => false,
                };
                if !same {
                    mismatches.push(format!("{}:{path} differs", folder.folder_id));
                }
            }
        }
    }
    mismatches.truncate(100);
    Ok(Verification {
        matches: mismatches.is_empty(),
        mismatches,
        disk_root: snapshot.disk_root,
        snapshot_sequence: snapshot.sequence,
    })
}
