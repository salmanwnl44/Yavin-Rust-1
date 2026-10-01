//! Merge and cherry-pick (LG-06): three-way merges of Local Git trees.
//!
//! **Merge** of a target commit T into HEAD (H):
//!
//! - T is H, or an ancestor of it: *up to date* -- nothing changes at all.
//! - H is an ancestor of T (or there is no commit yet): a *fast-forward* -- the disk goes to
//!   T's tree on the paths that differ (local work elsewhere carried over), then HEAD (its
//!   branch, or HEAD itself when detached) and the index move to T. No merge commit.
//! - Otherwise a *three-way merge* of BASE (the best common ancestor), OURS (H) and THEIRS
//!   (T). Conflict-free, it ends in a merge commit with parents H then T; with conflicts, it
//!   stops with the conflicts recorded (`operation.rs`), for the user to resolve, then continue
//!   or abort. Histories with nothing in common are refused (`UnrelatedHistories`).
//!
//! **Cherry-pick** of commit C (one parent P, or none) is the same three-way merge with BASE =
//! P and THEIRS = C: C's change, applied to HEAD. It makes a new commit on HEAD -- C's message
//! and author, a `cherry-pick` record of C -- and never touches C. A merge commit is refused.
//!
//! **The tree merge** goes folder by folder and down each tree only where both sides changed
//! something (equal subtrees are taken whole). Per path: equal sides are taken; a side equal
//! to BASE takes the other; otherwise both changed it, and:
//!
//! | Both sides | Result |
//! | --- | --- |
//! | text files | line-merged (`merge3.rs`); overlapping changes conflict (`modifyModify`, `addAdd`), and the working file gets conflict markers |
//! | binary, not stored, or over 8 MiB | conflict; the working file keeps ours |
//! | deleted / changed | conflict (`deleteModify`: the working tree gets theirs to look at; `modifyDelete`: keeps ours) |
//! | folder / file or link | conflict (`directoryFile`), ours kept |
//! | file / link | conflict (`typeChange`), ours kept |
//!
//! A file one side renamed (exactly the same content at a new path, LG-02's rename pairing)
//! and the other side changed gets that change at its new path. The index after a merge with
//! conflicts holds every clean result, and OURS at each conflicted path until it is resolved;
//! the conflict record, not the file, says it is unresolved.
//!
//! **Safety** is LG-04's switch's, before anything changes: nothing may be staged; every path
//! the merge changes on disk must hold HEAD's entry (or already the result) -- a local change
//! is `unstagedChangeWouldBeOverwritten`, an untracked file in the way
//! `untrackedFileCollision`; a document with unsaved changes there is refused; two names in one
//! folder differing only in case are `caseOnlyRename`; and the restore planner's own checks
//! (content never stored, unreadable paths) apply. Nothing is overwritten, saved or stashed
//! on the user's behalf.
//!
//! **The disk** changes through LG-03's restore machinery (`transition.rs`): one Module 03
//! operation recorded by Module 04, then verified. The order is: the state recorded (`begin`)
//! -> the disk changed and verified (the app) -> the refs moved (`finish_apply`: HEAD and the
//! index for a clean result, the index and the conflicts otherwise), each ref step one atomic
//! compare-and-swap.

use crate::branches::{index_state, index_update, resolve_head, HeadState, INDEX_REF};
use crate::diff::is_binary;
use crate::error::{LgError, Result};
use crate::history::{commit_info, require_commit, validate_message, CommitRequest, Created};
use crate::id::ObjectId;
use crate::index::{graft, Pending, PendingTrees};
use crate::merge3;
use crate::object::{
    Commit, EntryKind, EntryName, FolderId, Root, Source, Stored, Tree, TreeEntry,
};
use crate::operation::{
    current, ensure_idle, entry_at, id, opt_id, state_update, write_state, Conflict, ConflictKind,
    EntryState, OperationKind, OperationState, Phase, Resolution, Touched, STATE_VERSION,
};
use crate::refs::{Head, RefName, RefUpdate};
use crate::repository::{Repository, WriteTxn};
use crate::reset::{resolve_target, ResetPolicy, ResetTarget};
use crate::restore::{RestoreConflict, RestorePlan, RestorePolicy};
use crate::scan::{name_key, TreeLookup};
use crate::snapshot::{FolderRoot, ObjectIdText, OverlayRecord, Snapshot};
use crate::status::{changes, find, ChangeKind};
use crate::switch::{differing, same, MemoryAndStore, Trees};
use crate::transition::{commit_folders, disk_folders, plan_transition, tree_or_empty, Sets};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

/// No line merge for a file larger than this (either side, or the base).
pub const MERGE_MAX_BYTES: u64 = 8 * 1024 * 1024;

/// What to do.
#[derive(Clone, Debug)]
pub enum OperationRequest {
    /// Merge a commit, branch or tag into HEAD. `message` replaces the merge commit's default.
    Merge {
        target: ResetTarget,
        message: Option<String>,
    },
    /// Apply one commit's change to HEAD, as a new commit.
    CherryPick { commit: ObjectId },
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    /// Nothing to do.
    UpToDate,
    FastForward,
    /// Conflict-free: a merge commit, or the cherry-picked commit's copy.
    Merged,
    /// Stops with conflicts to resolve.
    Conflicted,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationPlan {
    pub kind: OperationKind,
    pub outcome: Outcome,
    /// The branch HEAD is on (none: detached).
    pub branch: Option<String>,
    pub head: Option<ObjectIdText>,
    pub theirs: ObjectIdText,
    pub base: Option<ObjectIdText>,
    /// How many other best common ancestors there were (one is used; see ARCHITECTURE.md).
    pub other_bases: usize,
    pub label: String,
    /// Paths the merge changes in the index, cleanly (`folderId:path`).
    pub merged: Vec<String>,
    /// Paths that will need resolving.
    pub conflicts: Vec<Conflict>,
    /// The refs revision the plan was made at.
    pub revision: u64,
    /// The disk's side, with every reason it cannot start (none when up to date).
    pub restore: Option<RestorePlan>,
    /// What `begin` records.
    #[serde(skip)]
    pub state: Option<OperationState>,
}

fn short(id: &ObjectId) -> String {
    id.to_hex()[..12].to_string()
}

fn summary(message: &str) -> &str {
    message.lines().next().unwrap_or("").trim_end()
}

fn join(prefix: &str, name: &str) -> String {
    if prefix.is_empty() {
        name.to_string()
    } else {
        format!("{prefix}/{name}")
    }
}

fn last(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

// --- Ancestry ---------------------------------------------------------------------------------

/// Every commit `start` reaches through its parents, itself included.
fn ancestors(repo: &Repository, start: ObjectId) -> Result<HashSet<ObjectId>> {
    let mut seen = HashSet::new();
    let mut stack = vec![start];
    while let Some(id) = stack.pop() {
        if seen.insert(id) {
            stack.extend(repo.read_commit(&id)?.parents);
        }
    }
    Ok(seen)
}

/// The best common ancestors of `a` (whose ancestry is `of_a`) and `b`: common ancestors none
/// of the others reaches, nearest to `b` first.
fn merge_bases(repo: &Repository, of_a: &HashSet<ObjectId>, b: ObjectId) -> Result<Vec<ObjectId>> {
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();
    let mut queue = VecDeque::from([b]);
    while let Some(id) = queue.pop_front() {
        if !seen.insert(id) {
            continue;
        }
        if of_a.contains(&id) {
            candidates.push(id);
            continue;
        }
        queue.extend(repo.read_commit(&id)?.parents);
    }
    let mut best = Vec::new();
    for candidate in &candidates {
        let mut reached = false;
        for other in candidates.iter().filter(|o| *o != candidate) {
            if ancestors(repo, *other)?.contains(candidate) {
                reached = true;
                break;
            }
        }
        if !reached {
            best.push(*candidate);
        }
    }
    Ok(best)
}

/// The merge base of two commits (the nearest to `b` when there are several), if any.
pub fn merge_base(repo: &Repository, a: ObjectId, b: ObjectId) -> Result<Option<ObjectId>> {
    Ok(merge_bases(repo, &ancestors(repo, a)?, b)?.first().copied())
}

// --- The tree merge -----------------------------------------------------------------------------

/// A path's result: its entry in the index, and on disk.
type Pair = (Option<TreeEntry>, Option<TreeEntry>);

struct Merger<'t, 'r> {
    txn: &'t mut WriteTxn<'r>,
    pending: Pending,
    folder: String,
    labels: (String, String),
    conflicts: Vec<Conflict>,
    /// Two names in one folder of the result that one disk may take for the same file.
    clashes: Vec<(String, String, String)>,
}

fn is_dir(entry: &Option<TreeEntry>) -> bool {
    entry
        .as_ref()
        .is_some_and(|e| e.kind == EntryKind::Directory)
}

fn is_file(entry: &Option<TreeEntry>) -> bool {
    matches!(
        entry,
        Some(TreeEntry {
            kind: EntryKind::File { .. },
            ..
        })
    )
}

fn executable(entry: &TreeEntry) -> bool {
    matches!(
        entry.kind,
        EntryKind::File {
            executable: true,
            ..
        }
    )
}

impl Merger<'_, '_> {
    fn tree(&self, id: &ObjectId) -> Result<Tree> {
        self.pending.read(self.txn.repository(), id)
    }

    #[allow(clippy::too_many_arguments)]
    fn conflict(
        &mut self,
        path: &str,
        kind: ConflictKind,
        base: &Option<TreeEntry>,
        ours: &Option<TreeEntry>,
        theirs: &Option<TreeEntry>,
        markers: bool,
        binary: bool,
        unavailable: Option<&str>,
    ) {
        self.conflicts.push(Conflict {
            folder_id: self.folder.clone(),
            path: path.into(),
            kind,
            base: EntryState::of_opt(base),
            ours: EntryState::of_opt(ours),
            theirs: EntryState::of_opt(theirs),
            markers,
            binary,
            unavailable: unavailable.map(str::to_string),
            resolution: Resolution::Unresolved,
            resolved: None,
        });
    }

    /// One folder: its index tree and its working tree after the merge.
    fn folder(&mut self, b: ObjectId, o: ObjectId, t: ObjectId) -> Result<(ObjectId, ObjectId)> {
        if o == t || b == t {
            return Ok((o, o));
        }
        if b == o {
            return Ok((t, t));
        }
        let (b, o, t) = self.carry_renames(b, o, t)?;
        let (index, work) = self.dir("", Some(b), Some(o), Some(t))?;
        let index = self.pending.put(self.txn, index)?;
        let work = self.pending.put(self.txn, work)?;
        Ok((index, work))
    }

    fn dir(
        &mut self,
        prefix: &str,
        b: Option<ObjectId>,
        o: Option<ObjectId>,
        t: Option<ObjectId>,
    ) -> Result<(Tree, Tree)> {
        let mut names: BTreeMap<String, [Option<TreeEntry>; 3]> = BTreeMap::new();
        for (slot, tree) in [b, o, t].into_iter().enumerate() {
            if let Some(tree) = tree {
                for entry in self.tree(&tree)?.entries() {
                    names.entry(entry.name.as_str().to_string()).or_default()[slot] =
                        Some(entry.clone());
                }
            }
        }
        let (mut index, mut work) = (Vec::new(), Vec::new());
        for (name, [be, oe, te]) in names {
            let (i, w) = self.entry(&join(prefix, &name), be, oe, te)?;
            let named = |e: TreeEntry| -> Result<TreeEntry> {
                Ok(TreeEntry {
                    name: EntryName::new(&name)?,
                    ..e
                })
            };
            if let Some(i) = i {
                index.push(named(i)?);
            }
            if let Some(w) = w {
                work.push(named(w)?);
            }
        }
        let mut keys: HashMap<String, String> = HashMap::new();
        for entry in &work {
            let name = entry.name.as_str();
            if let Some(other) = keys.insert(name_key(name), name.to_string()) {
                self.clashes.push((
                    self.folder.clone(),
                    join(prefix, name),
                    join(prefix, &other),
                ));
            }
        }
        Ok((Tree::new(index)?, Tree::new(work)?))
    }

    fn entry(
        &mut self,
        path: &str,
        be: Option<TreeEntry>,
        oe: Option<TreeEntry>,
        te: Option<TreeEntry>,
    ) -> Result<Pair> {
        if same(&oe, &te) || same(&be, &te) {
            return Ok((oe.clone(), oe));
        }
        if same(&be, &oe) {
            return Ok((te.clone(), te));
        }
        let dir_or_none = |e: &Option<TreeEntry>| e.is_none() || is_dir(e);
        if (is_dir(&oe) || is_dir(&te)) && dir_or_none(&oe) && dir_or_none(&te) {
            let tree_id = |e: &Option<TreeEntry>| {
                e.as_ref()
                    .filter(|e| e.kind == EntryKind::Directory)
                    .map(|e| e.id)
            };
            let (index, work) = self.dir(path, tree_id(&be), tree_id(&oe), tree_id(&te))?;
            let keep = is_dir(&oe) && is_dir(&te);
            let mut wrap = |tree: Tree| -> Result<Option<TreeEntry>> {
                if tree.entries().is_empty() && !keep {
                    return Ok(None);
                }
                Ok(Some(TreeEntry {
                    name: EntryName::new(last(path))?,
                    kind: EntryKind::Directory,
                    id: self.pending.put(self.txn, tree)?,
                }))
            };
            let index = wrap(index)?;
            let work = wrap(work)?;
            return Ok((index, work));
        }
        let (Some(o), Some(t)) = (&oe, &te) else {
            if oe.is_none() {
                self.conflict(
                    path,
                    ConflictKind::DeleteModify,
                    &be,
                    &oe,
                    &te,
                    false,
                    false,
                    None,
                );
                return Ok((None, te));
            }
            self.conflict(
                path,
                ConflictKind::ModifyDelete,
                &be,
                &oe,
                &te,
                false,
                false,
                None,
            );
            return Ok((oe.clone(), oe));
        };
        let both = if be.is_none() {
            ConflictKind::AddAdd
        } else {
            ConflictKind::ModifyModify
        };
        match (o.kind, t.kind) {
            (EntryKind::File { .. }, EntryKind::File { .. }) => self.file(path, &be, o, t),
            (EntryKind::Symlink(_), EntryKind::Symlink(_)) => {
                self.conflict(path, both, &be, &oe, &te, false, false, None);
                Ok((oe.clone(), oe))
            }
            (EntryKind::Directory, _) | (_, EntryKind::Directory) => {
                self.conflict(
                    path,
                    ConflictKind::DirectoryFile,
                    &be,
                    &oe,
                    &te,
                    false,
                    false,
                    None,
                );
                Ok((oe.clone(), oe))
            }
            _ => {
                self.conflict(
                    path,
                    ConflictKind::TypeChange,
                    &be,
                    &oe,
                    &te,
                    false,
                    false,
                    None,
                );
                Ok((oe.clone(), oe))
            }
        }
    }

    /// A file's content, for a line merge -- or why there is none to merge.
    fn content(&self, entry: &TreeEntry) -> std::result::Result<Vec<u8>, &'static str> {
        if let EntryKind::File {
            stored: Stored::No { .. },
            ..
        } = entry.kind
        {
            return Err("notStored");
        }
        let repo = self.txn.repository();
        match repo.object_info(&entry.id) {
            Err(_) => Err("missing"),
            Ok((_, size)) if size > MERGE_MAX_BYTES => Err("tooLarge"),
            Ok(_) => repo
                .read_blob(&entry.id, MERGE_MAX_BYTES)
                .map_err(|_| "missing"),
        }
    }

    /// Both sides changed a file, differently.
    fn file(
        &mut self,
        path: &str,
        be: &Option<TreeEntry>,
        o: &TreeEntry,
        t: &TreeEntry,
    ) -> Result<Pair> {
        let (oe, te) = (Some(o.clone()), Some(t.clone()));
        let base_file = be.as_ref().filter(|b| is_file(&Some((*b).clone())));
        let kind = if base_file.is_some() {
            ConflictKind::ModifyModify
        } else {
            ConflictKind::AddAdd
        };
        let exec = match base_file {
            _ if executable(o) == executable(t) => executable(o),
            Some(b) if executable(b) == executable(o) => executable(t),
            _ => executable(o),
        };
        let base = match base_file {
            Some(b) => self.content(b),
            None => Ok(Vec::new()),
        };
        let (base, ours, theirs) = match (base, self.content(o), self.content(t)) {
            (Ok(b), Ok(x), Ok(y)) => (b, x, y),
            (b, x, y) => {
                let why = [b.err(), x.err(), y.err()].into_iter().flatten().next();
                self.conflict(path, kind, be, &oe, &te, false, false, why);
                return Ok((oe.clone(), oe));
            }
        };
        if is_binary(&base) || is_binary(&ours) || is_binary(&theirs) {
            self.conflict(path, kind, be, &oe, &te, false, true, None);
            return Ok((oe.clone(), oe));
        }
        let merged = merge3::merge(&base, &ours, &theirs, (&self.labels.0, &self.labels.1));
        let id = self.txn.put_blob(&merged.bytes)?;
        let result = TreeEntry {
            name: o.name.clone(),
            kind: EntryKind::File {
                executable: if merged.conflicts == 0 {
                    exec
                } else {
                    executable(o)
                },
                stored: Stored::Yes,
            },
            id,
        };
        if merged.conflicts == 0 {
            return Ok((Some(result.clone()), Some(result)));
        }
        self.conflict(path, kind, be, &oe, &te, true, false, None);
        Ok((oe, Some(result)))
    }

    /// A file one side renamed (exactly) and the other changed: the change is moved to the new
    /// name, in rewritten BASE and changing-side trees, before the merge proper.
    fn carry_renames(
        &mut self,
        b: ObjectId,
        o: ObjectId,
        t: ObjectId,
    ) -> Result<(ObjectId, ObjectId, ObjectId)> {
        type Jobs = Vec<(String, Option<TreeEntry>)>;
        let (mut b_jobs, mut o_jobs, mut t_jobs): (Jobs, Jobs, Jobs) = Default::default();
        {
            let lookup = PendingTrees {
                pending: &self.pending,
                repo: self.txn.repository(),
            };
            let renames = |from: ObjectId, to: ObjectId| -> Result<Vec<(String, String)>> {
                Ok(changes(&lookup, Some(from), to)?
                    .into_iter()
                    .filter(|l| l.kind == ChangeKind::Renamed)
                    .filter_map(|l| Some((l.from?, l.path)))
                    .collect())
            };
            // A name on the way to `to` that is not a folder: grafting there would replace it.
            let blocked = |tree: ObjectId, to: &str| -> Result<bool> {
                let names: Vec<&str> = to.split('/').collect();
                for n in 1..names.len() {
                    let at = find(&lookup, Some(tree), &names[..n].join("/"))?;
                    if at.is_some() && !is_dir(&at) {
                        return Ok(true);
                    }
                }
                Ok(false)
            };
            for (renamed, changed, into_theirs) in [(o, t, true), (t, o, false)] {
                for (from, to) in renames(b, renamed)? {
                    let (at_base, at_changed) = (
                        find(&lookup, Some(b), &from)?,
                        find(&lookup, Some(changed), &from)?,
                    );
                    if is_file(&at_changed)
                        && !same(&at_changed, &at_base)
                        && find(&lookup, Some(changed), &to)?.is_none()
                        && find(&lookup, Some(b), &to)?.is_none()
                        && !blocked(changed, &to)?
                        && !blocked(b, &to)?
                    {
                        let jobs = if into_theirs {
                            &mut t_jobs
                        } else {
                            &mut o_jobs
                        };
                        jobs.push((from, None));
                        jobs.push((to.clone(), at_changed));
                        b_jobs.push((to, at_base));
                    }
                }
            }
        }
        let mut rewrite = |tree: ObjectId, mut jobs: Jobs| -> Result<ObjectId> {
            if jobs.is_empty() {
                return Ok(tree);
            }
            jobs.sort_by(|a, b| a.0.cmp(&b.0));
            let mut current = self.tree(&tree)?;
            for (path, entry) in jobs {
                let names: Vec<&str> = path.split('/').collect();
                current = graft(
                    self.txn,
                    &mut self.pending,
                    Some(&current),
                    "",
                    &names,
                    entry.as_ref(),
                    &|_| false,
                )?;
            }
            self.pending.put(self.txn, current)
        };
        let b = rewrite(b, b_jobs)?;
        let o = rewrite(o, o_jobs)?;
        let t = rewrite(t, t_jobs)?;
        Ok((b, o, t))
    }
}

// --- Planning ----------------------------------------------------------------------------------

/// Unsaved documents on (or under) `path` in `folder`.
fn overlays_on<'s>(snapshot: &'s Snapshot, folder: &str, path: &str) -> Vec<&'s OverlayRecord> {
    snapshot
        .overlays
        .iter()
        .filter(|o| {
            o.folder_id == folder && (o.path == path || o.path.starts_with(&format!("{path}/")))
        })
        .collect()
}

/// The conflict a document with unsaved changes at `overlay` is in, when `wanted` (what the
/// path under it will hold) is not exactly its text.
fn document_conflict(
    lookup: &dyn TreeLookup,
    folder: &str,
    overlay: &OverlayRecord,
    wanted_tree: Option<ObjectId>,
) -> Result<Option<RestoreConflict>> {
    let wanted = find(lookup, wanted_tree, &overlay.path)?;
    Ok(match wanted {
        Some(TreeEntry {
            kind: EntryKind::File { .. },
            id,
            ..
        }) if id == overlay.blob.0 => None,
        Some(TreeEntry {
            kind: EntryKind::File { .. },
            ..
        }) => Some(RestoreConflict::DirtyDocumentWouldBeOverwritten {
            folder_id: folder.into(),
            path: overlay.path.clone(),
        }),
        _ => Some(RestoreConflict::DirtyDocumentWouldBeDeleted {
            folder_id: folder.into(),
            path: overlay.path.clone(),
        }),
    })
}

/// Plans a merge or a cherry-pick from the workspace as `snapshot` (Full, persisted, with the
/// unsaved documents) saw it. Writes the result's objects (unreferenced until `begin`);
/// changes nothing else.
pub fn plan(
    lookup: &dyn TreeLookup,
    repo: &mut Repository,
    folders: &[FolderRoot],
    snapshot: &Snapshot,
    request: &OperationRequest,
    by: &CommitRequest,
) -> Result<OperationPlan> {
    ensure_idle(repo)?;
    let revision = repo.refs().revision;
    let head_state = resolve_head(repo);
    let head = head_state.commit();
    let branch = match &head_state {
        HeadState::Branch { name, .. } | HeadState::Unborn { name, .. } => Some(name.clone()),
        HeadState::Detached { .. } => None,
    };
    let mut other_bases = 0;
    let mut fast_forward = false;
    let mut up_to_date = false;
    let (kind, theirs, label, base, message, picked) = match request {
        OperationRequest::Merge { target, message } => {
            let theirs = resolve_target(repo, target)?;
            let label = match target {
                ResetTarget::Branch(name) => format!("branch '{name}'"),
                ResetTarget::Tag(name) => format!("tag '{name}'"),
                ResetTarget::Commit(id) => format!("commit {}", short(id)),
            };
            let mut base = None;
            match head {
                None => fast_forward = true,
                Some(h) if h == theirs => up_to_date = true,
                Some(h) => {
                    let of_head = ancestors(repo, h)?;
                    if of_head.contains(&theirs) {
                        up_to_date = true;
                    } else if ancestors(repo, theirs)?.contains(&h) {
                        fast_forward = true;
                    } else {
                        let bases = merge_bases(repo, &of_head, theirs)?;
                        let Some(first) = bases.first() else {
                            return Err(LgError::UnrelatedHistories);
                        };
                        other_bases = bases.len() - 1;
                        base = Some(*first);
                    }
                }
            }
            let message = message.clone().unwrap_or_else(|| format!("Merge {label}"));
            validate_message(&message)?;
            (OperationKind::Merge, theirs, label, base, message, None)
        }
        OperationRequest::CherryPick { commit } => {
            head.ok_or(LgError::Unborn)?;
            require_commit(repo, commit)?;
            let picked = repo.read_commit(commit)?;
            if picked.parents.len() > 1 {
                return Err(LgError::CherryPickMerge(commit.to_hex()));
            }
            let label = format!("{} ({})", short(commit), summary(&picked.message));
            let message = format!(
                "{}\n\n(cherry picked from Local Git commit {})",
                picked.message.trim_end(),
                commit.to_hex()
            );
            validate_message(&message)?;
            let base = picked.parents.first().copied();
            (
                OperationKind::CherryPick,
                *commit,
                label,
                base,
                message,
                Some(picked),
            )
        }
    };
    let mut plan = OperationPlan {
        kind,
        outcome: Outcome::UpToDate,
        branch: branch.clone(),
        head: head.map(ObjectIdText),
        theirs: ObjectIdText(theirs),
        base: base.map(ObjectIdText),
        other_bases,
        label: label.clone(),
        merged: Vec::new(),
        conflicts: Vec::new(),
        revision,
        restore: None,
        state: None,
    };
    if up_to_date {
        return Ok(plan);
    }
    let head_folders = commit_folders(repo, head)?;
    let their_folders = commit_folders(repo, Some(theirs))?;
    let base_folders = commit_folders(repo, base)?;
    let head_root = head
        .map(|h| repo.read_commit(&h).map(|c| c.root))
        .transpose()?;
    let mut index_folders: BTreeMap<FolderId, ObjectId> = BTreeMap::new();
    let mut work_folders: BTreeMap<FolderId, ObjectId> = BTreeMap::new();
    let mut conflicts = Vec::new();
    let mut clashes = Vec::new();
    let mut txn = repo.begin_write()?;
    txn.put_tree(&Tree::default())?;
    if fast_forward {
        for folder in folders {
            let tree = tree_or_empty(&their_folders, &folder.folder_id);
            index_folders.insert(folder.folder_id.clone(), tree);
            work_folders.insert(folder.folder_id.clone(), tree);
        }
    } else {
        let ours_label = match &branch {
            Some(name) => format!("HEAD ({name})"),
            None => "HEAD".to_string(),
        };
        let mut merger = Merger {
            txn: &mut txn,
            pending: Pending::default(),
            folder: String::new(),
            labels: (ours_label, label.clone()),
            conflicts: Vec::new(),
            clashes: Vec::new(),
        };
        for folder in folders {
            let fid = &folder.folder_id;
            merger.folder = fid.as_str().to_string();
            let (index, work) = merger.folder(
                tree_or_empty(&base_folders, fid),
                tree_or_empty(&head_folders, fid),
                tree_or_empty(&their_folders, fid),
            )?;
            index_folders.insert(fid.clone(), index);
            work_folders.insert(fid.clone(), work);
        }
        conflicts = merger.conflicts;
        clashes = merger.clashes;
    }
    let index_root = txn.put_root(&Root {
        folders: index_folders.clone(),
    })?;
    let work_root = txn.put_root(&Root {
        folders: work_folders.clone(),
    })?;
    let commit = if !conflicts.is_empty() {
        None
    } else if fast_forward {
        Some(theirs)
    } else {
        let h = head.expect("a three-way merge has a HEAD");
        let commit = match &picked {
            None => Commit {
                root: index_root,
                disk_root: None,
                parents: vec![h, theirs],
                workspace: txn.repository().meta().workspace.clone(),
                author: by.author.clone(),
                time_ms: by.time_ms,
                tz_offset_min: by.tz_offset_min,
                source: Source::Human,
                meta: [("merge".to_string(), theirs.to_hex())]
                    .into_iter()
                    .collect(),
                meta_objects: BTreeMap::new(),
                message: message.clone(),
            },
            Some(original) => {
                if Some(index_root) == head_root {
                    txn.abandon();
                    return Err(LgError::NothingToCommit);
                }
                picked_commit(
                    txn.repository(),
                    index_root,
                    h,
                    theirs,
                    original,
                    &message,
                    by,
                )
            }
        };
        Some(txn.put_commit(&commit)?)
    };
    txn.commit()?;

    // What changes, and whether it may.
    let index = index_state(repo)?;
    let disk = disk_folders(snapshot)?;
    let mut refusals = Vec::new();
    let mut sets: Sets = BTreeMap::new();
    let mut touched = Vec::new();
    let mut merged = Vec::new();
    {
        let reads = Trees(&MemoryAndStore { repo, lookup });
        for folder in folders {
            let fid = &folder.folder_id;
            let folder_id = fid.as_str().to_string();
            let head_tree = tree_or_empty(&head_folders, fid);
            let index_tree = if index.root.is_none() {
                head_tree
            } else {
                tree_or_empty(&index.folders, fid)
            };
            if index_tree != head_tree {
                for (path, _, _) in differing(&reads, head_tree, index_tree)? {
                    refusals.push(RestoreConflict::StagedChangeConflict {
                        folder_id: folder_id.clone(),
                        path,
                    });
                }
            }
            for (path, _, _) in differing(&reads, head_tree, index_folders[fid])? {
                merged.push(format!("{folder_id}:{path}"));
            }
            let work_tree = work_folders[fid];
            let disk_tree = tree_or_empty(&disk, fid);
            let changed = differing(&reads, head_tree, work_tree)?;
            for (path, head_entry, work_entry) in &changed {
                let on_disk = find(&reads, Some(disk_tree), path)?;
                if !same(&on_disk, work_entry) && !same(&on_disk, head_entry) {
                    refusals.push(if head_entry.is_none() {
                        RestoreConflict::UntrackedFileCollision {
                            folder_id: folder_id.clone(),
                            path: path.clone(),
                        }
                    } else {
                        RestoreConflict::UnstagedChangeWouldBeOverwritten {
                            folder_id: folder_id.clone(),
                            path: path.clone(),
                        }
                    });
                }
                touched.push(Touched {
                    folder_id: folder_id.clone(),
                    path: path.clone(),
                    before: EntryState::of_opt(&on_disk),
                    written: vec![EntryState::of_opt(work_entry)],
                });
                sets.entry(fid.clone())
                    .or_default()
                    .push((path.clone(), work_entry.clone()));
            }
            for overlay in snapshot
                .overlays
                .iter()
                .filter(|o| o.folder_id == folder_id)
            {
                let hit = changed.iter().any(|(path, _, _)| {
                    overlay.path == *path || overlay.path.starts_with(&format!("{path}/"))
                });
                if hit {
                    if let Some(conflict) =
                        document_conflict(&reads, &folder_id, overlay, Some(work_tree))?
                    {
                        refusals.push(conflict);
                    }
                }
            }
        }
    }
    for (folder_id, path, on_disk) in clashes {
        refusals.push(RestoreConflict::CaseOnlyRename {
            folder_id,
            path,
            on_disk,
        });
    }
    let mut quiet = snapshot.clone();
    quiet.overlays.clear();
    let mut restore = plan_transition(
        lookup,
        repo,
        folders,
        &quiet,
        commit.unwrap_or(theirs),
        &sets,
        &work_folders,
        RestorePolicy::RefuseIfDirty,
    )?;
    restore.conflicts.splice(0..0, refusals);
    restore.unchanged = restore.operations.is_empty() && restore.conflicts.is_empty();
    let hex = |id: &ObjectId| id.to_hex();
    plan.outcome = if fast_forward {
        Outcome::FastForward
    } else if conflicts.is_empty() {
        Outcome::Merged
    } else {
        Outcome::Conflicted
    };
    plan.merged = merged;
    plan.conflicts = conflicts.clone();
    plan.state = Some(OperationState {
        version: STATE_VERSION,
        kind,
        phase: Phase::Applying,
        branch,
        head: head.as_ref().map(hex),
        theirs: hex(&theirs),
        base: base.as_ref().map(hex),
        label,
        fast_forward,
        index_before: repo.refs().refs.get(&RefName::new(INDEX_REF)?).map(hex),
        disk_before: snapshot.disk_root.0.to_hex(),
        result_index: hex(&index_root),
        result_work: hex(&work_root),
        commit: commit.as_ref().map(hex),
        message,
        touched,
        conflicts,
    });
    plan.restore = Some(restore);
    Ok(plan)
}

/// The commit a cherry-pick makes: the picked commit's author and message, on HEAD.
fn picked_commit(
    repo: &Repository,
    root: ObjectId,
    head: ObjectId,
    picked: ObjectId,
    original: &Commit,
    message: &str,
    by: &CommitRequest,
) -> Commit {
    Commit {
        root,
        disk_root: None,
        parents: vec![head],
        workspace: repo.meta().workspace.clone(),
        author: original.author.clone(),
        time_ms: by.time_ms,
        tz_offset_min: by.tz_offset_min,
        source: Source::Human,
        meta: [
            ("cherry-pick".to_string(), picked.to_hex()),
            (
                "committer".to_string(),
                format!("{} <{}>", by.author.name, by.author.id),
            ),
        ]
        .into_iter()
        .collect(),
        meta_objects: BTreeMap::new(),
        message: message.to_string(),
    }
}

// --- Carrying it out ---------------------------------------------------------------------------

/// Records the planned operation durably (phase `applying`), before the disk changes -- only
/// if the refs are still as the plan saw them.
pub fn begin(repo: &mut Repository, plan: &OperationPlan) -> Result<u64> {
    let state = plan.state.as_ref().ok_or(LgError::NoOperation)?;
    ensure_idle(repo)?;
    let recorded = write_state(repo, state)?;
    let update = state_update(repo, Some(recorded));
    repo.update_refs(
        plan.revision,
        &[update],
        None,
        state.kind.op(),
        &format!("begin {}", state.label),
    )
}

/// What a finished step left.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finished {
    pub revision: u64,
    /// The commit HEAD moved to, when the operation completed.
    pub commit: Option<crate::history::CommitInfo>,
    /// The operation still in progress (with its conflicts), if it did not complete.
    pub state: Option<OperationState>,
}

/// The ref updates (and HEAD) that complete an operation: HEAD -- its branch, or itself when
/// detached, only if still where the operation began -- moves to `commit`, the index follows
/// it, and the recorded state goes.
fn completion(
    repo: &Repository,
    state: &OperationState,
    commit: ObjectId,
) -> Result<(Vec<RefUpdate>, Option<Head>)> {
    let began = opt_id(&state.head)?;
    let mut updates = Vec::new();
    let head = match repo.refs().head.clone() {
        Head::Symbolic(name) => {
            let now = repo.refs().refs.get(&name).copied();
            if now != began {
                return Err(LgError::RefConflict {
                    name: name.as_str().into(),
                    expected: began,
                    found: now,
                });
            }
            updates.push(RefUpdate {
                name,
                expected: now,
                new: Some(commit),
            });
            None
        }
        Head::Detached(at) => {
            if Some(at) != began {
                return Err(LgError::RefConflict {
                    name: "HEAD".into(),
                    expected: began,
                    found: Some(at),
                });
            }
            Some(Head::Detached(commit))
        }
    };
    let index = RefName::new(INDEX_REF)?;
    if let Some(now) = repo.refs().refs.get(&index).copied() {
        updates.push(RefUpdate {
            name: index,
            expected: Some(now),
            new: None,
        });
    }
    updates.push(state_update(repo, None));
    Ok((updates, head))
}

/// After the disk was changed and verified: a conflict-free operation completes (HEAD and the
/// index move, the state goes); one with conflicts records them, with the index holding the
/// clean results -- one atomic step either way.
pub fn finish_apply(repo: &mut Repository) -> Result<Finished> {
    let (_, mut state) = current(repo)?.ok_or(LgError::NoOperation)?;
    if state.phase != Phase::Applying {
        return Err(LgError::InvalidFormat(format!(
            "the {} is not applying",
            state.kind.op()
        )));
    }
    if state.conflicts.is_empty() {
        let commit = opt_id(&state.commit)?
            .ok_or_else(|| LgError::InvalidFormat("a clean operation without a commit".into()))?;
        let (updates, head) = completion(repo, &state, commit)?;
        let reason = if state.fast_forward {
            format!("fast-forward to {} ({})", short(&commit), state.label)
        } else {
            format!("{} {} -> {}", state.kind.op(), state.label, short(&commit))
        };
        let revision = repo.refs().revision;
        let revision = repo.update_refs(revision, &updates, head, state.kind.op(), &reason)?;
        return Ok(Finished {
            revision,
            commit: Some(commit_info(commit, &repo.read_commit(&commit)?)),
            state: None,
        });
    }
    state.phase = Phase::Conflicts;
    let root = repo.read_root(&id(&state.result_index)?)?;
    let mut updates = Vec::new();
    if let Some(update) = index_update(repo, root)? {
        updates.push(update);
    }
    let recorded = write_state(repo, &state)?;
    updates.push(state_update(repo, Some(recorded)));
    let revision = repo.refs().revision;
    let revision = repo.update_refs(
        revision,
        &updates,
        None,
        state.kind.op(),
        &format!("{}: {} conflict(s)", state.label, state.conflicts.len()),
    )?;
    Ok(Finished {
        revision,
        commit: None,
        state: Some(state),
    })
}

/// Removes the recorded state of an operation whose disk change was refused by the executor's
/// last checks -- before anything was touched.
pub fn withdraw(repo: &mut Repository) -> Result<u64> {
    let (_, state) = current(repo)?.ok_or(LgError::NoOperation)?;
    if state.phase != Phase::Applying {
        return Err(LgError::InvalidFormat(format!(
            "the {} is past applying",
            state.kind.op()
        )));
    }
    let update = state_update(repo, None);
    let revision = repo.refs().revision;
    repo.update_refs(
        revision,
        &[update],
        None,
        &format!("{}-abort", state.kind.op()),
        "refused before the disk changed",
    )
}

// --- Resolving ---------------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResolveChoice {
    TakeOurs,
    TakeTheirs,
    Delete,
    /// The document's current text (unsaved changes included) -- or the file, when none is open.
    Manual,
    /// The file on disk as it is (refused while a document on it has unsaved changes).
    MarkResolved,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvePlan {
    pub folder_id: String,
    pub path: String,
    pub choice: ResolveChoice,
    /// What the index will hold at the path (none: deleted).
    pub entry: Option<EntryState>,
    /// The disk's side (take ours, take theirs, delete), with every reason it cannot be done.
    pub restore: Option<RestorePlan>,
    #[serde(skip)]
    pub record: Option<OperationState>,
    #[serde(skip)]
    pub state: Option<OperationState>,
    #[serde(skip)]
    pub index: Option<Root>,
}

fn interrupted(state: &OperationState) -> LgError {
    LgError::RecoveryRequired(format!(
        "the {} stopped while changing the disk: continue it or abort it",
        state.kind.op()
    ))
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

/// A resolution's content must be there, stored, and free of conflict markers (`markers`).
fn check_content(
    repo: &Repository,
    lookup: &dyn TreeLookup,
    path: &str,
    entry: &Option<TreeEntry>,
    markers: bool,
) -> Result<()> {
    let Some(entry) = entry else { return Ok(()) };
    match entry.kind {
        EntryKind::Directory => {
            let tree = lookup
                .tree(&entry.id)
                .ok_or(LgError::MissingObject(entry.id))?;
            for child in tree.entries() {
                check_content(
                    repo,
                    lookup,
                    &join(path, child.name.as_str()),
                    &Some(child.clone()),
                    markers,
                )?;
            }
        }
        EntryKind::File {
            stored: Stored::No { .. },
            ..
        } => {
            if markers {
                return Err(LgError::ContentUnavailableForStaging(path.into()));
            }
        }
        _ => {
            if !repo.contains(&entry.id) {
                return Err(LgError::MissingObject(entry.id));
            }
            if markers && matches!(entry.kind, EntryKind::File { .. }) {
                let (_, size) = repo.object_info(&entry.id)?;
                if size <= MERGE_MAX_BYTES
                    && merge3::has_markers(&repo.read_blob(&entry.id, MERGE_MAX_BYTES)?)
                {
                    return Err(LgError::ConflictMarkers(path.into()));
                }
            }
        }
    }
    Ok(())
}

/// Plans resolving one conflict, from the workspace as `snapshot` (Full, persisted, with the
/// unsaved documents) saw it. Take ours / take theirs / delete also set the file on disk --
/// refused when it holds something the operation did not write there (the user's edits),
/// unless `policy` is `allowDestructive`, or a document with unsaved changes is on it.
#[allow(clippy::too_many_arguments)]
pub fn plan_resolve(
    lookup: &dyn TreeLookup,
    repo: &mut Repository,
    folders: &[FolderRoot],
    snapshot: &Snapshot,
    folder: Option<FolderId>,
    path: &str,
    choice: ResolveChoice,
    policy: ResetPolicy,
) -> Result<ResolvePlan> {
    let (_, state) = current(repo)?.ok_or(LgError::NoOperation)?;
    if state.phase != Phase::Conflicts {
        return Err(interrupted(&state));
    }
    let fid = folder_of(folders, &folder)?;
    let folder_id = fid.as_str().to_string();
    let path = path.trim_matches('/').to_string();
    let at = state
        .conflicts
        .iter()
        .position(|c| c.folder_id == folder_id && c.path == path)
        .ok_or_else(|| LgError::NotFound(format!("a conflict at {path}")))?;
    let conflict = state.conflicts[at].clone();
    let disk = disk_folders(snapshot)?;
    let effective: BTreeMap<FolderId, ObjectId> = snapshot
        .folders
        .iter()
        .map(|f| Ok((FolderId::new(&f.folder_id)?, f.effective_tree.0)))
        .collect::<Result<_>>()?;
    let work_folders = repo.read_root(&id(&state.result_work)?)?.folders;
    let index_folders = repo.read_root(&id(&state.result_index)?)?.folders;
    let destructive = policy == ResetPolicy::AllowDestructive;
    let on_path = overlays_on(snapshot, &folder_id, &path);
    let writes_disk = matches!(
        choice,
        ResolveChoice::TakeOurs | ResolveChoice::TakeTheirs | ResolveChoice::Delete
    );
    let mut refusals = Vec::new();
    let (entry, resolution, on_disk, keep_dirs) = {
        let reads = Trees(&MemoryAndStore { repo, lookup });
        let (entry, resolution) = match choice {
            ResolveChoice::TakeOurs => (entry_at(&conflict.ours, &path)?, Resolution::TakeOurs),
            ResolveChoice::TakeTheirs => {
                (entry_at(&conflict.theirs, &path)?, Resolution::TakeTheirs)
            }
            ResolveChoice::Delete => (None, Resolution::Deleted),
            ResolveChoice::Manual => (
                find(&reads, Some(tree_or_empty(&effective, &fid)), &path)?,
                Resolution::Manual,
            ),
            ResolveChoice::MarkResolved => {
                if !on_path.is_empty() {
                    return Err(LgError::UnsavedDocument(path));
                }
                (
                    find(&reads, Some(tree_or_empty(&disk, &fid)), &path)?,
                    Resolution::Resolved,
                )
            }
        };
        let markers = matches!(choice, ResolveChoice::Manual | ResolveChoice::MarkResolved);
        check_content(repo, &reads, &path, &entry, markers)?;
        let on_disk = find(&reads, Some(tree_or_empty(&disk, &fid)), &path)?;
        let mut accepted: Vec<Option<TreeEntry>> = match state
            .touched
            .iter()
            .find(|t| t.folder_id == folder_id && t.path == path)
        {
            Some(t) => t
                .written
                .iter()
                .map(|w| entry_at(w, &path))
                .collect::<Result<_>>()?,
            None => vec![find(
                &reads,
                Some(tree_or_empty(&work_folders, &fid)),
                &path,
            )?],
        };
        accepted.push(entry.clone());
        let names: Vec<&str> = path.split('/').collect();
        let keep_dirs: Vec<String> = (1..names.len())
            .map(|n| names[..n].join("/"))
            .filter(|dir| {
                find(&reads, Some(tree_or_empty(&index_folders, &fid)), dir)
                    .ok()
                    .flatten()
                    .is_some_and(|e| e.kind == EntryKind::Directory)
            })
            .collect();
        if writes_disk {
            if !accepted.iter().any(|a| same(a, &on_disk)) && !destructive {
                refusals.push(RestoreConflict::UnstagedChangeWouldBeOverwritten {
                    folder_id: folder_id.clone(),
                    path: path.clone(),
                });
            }
            if !destructive {
                for overlay in &on_path {
                    let same_text = overlay.path == path
                        && matches!(&entry, Some(TreeEntry { kind: EntryKind::File { .. }, id, .. }) if *id == overlay.blob.0);
                    if !same_text {
                        refusals.push(if is_file(&entry) && overlay.path == path {
                            RestoreConflict::DirtyDocumentWouldBeOverwritten {
                                folder_id: folder_id.clone(),
                                path: overlay.path.clone(),
                            }
                        } else {
                            RestoreConflict::DirtyDocumentWouldBeDeleted {
                                folder_id: folder_id.clone(),
                                path: overlay.path.clone(),
                            }
                        });
                    }
                }
            }
        }
        (entry, resolution, on_disk, keep_dirs)
    };
    // The index: the path set to the resolution.
    let index = index_state(repo)?;
    let mut trees: BTreeMap<FolderId, ObjectId> = folders
        .iter()
        .map(|f| {
            (
                f.folder_id.clone(),
                tree_or_empty(&index.folders, &f.folder_id),
            )
        })
        .collect();
    let mut txn = repo.begin_write()?;
    txn.put_tree(&Tree::default())?;
    let mut pending = Pending::default();
    let current_tree = pending.read(txn.repository(), &trees[&fid])?;
    let names: Vec<&str> = path.split('/').collect();
    let grafted = graft(
        &mut txn,
        &mut pending,
        Some(&current_tree),
        "",
        &names,
        entry.as_ref(),
        &|dir: &str| keep_dirs.iter().any(|k| k == dir),
    )?;
    trees.insert(fid.clone(), pending.put(&mut txn, grafted)?);
    txn.commit()?;
    let mut recorded = state.clone();
    let writes = writes_disk && !same(&on_disk, &entry);
    if writes {
        match recorded
            .touched
            .iter_mut()
            .find(|t| t.folder_id == folder_id && t.path == path)
        {
            Some(t) => t.written.push(EntryState::of_opt(&entry)),
            None => recorded.touched.push(Touched {
                folder_id: folder_id.clone(),
                path: path.clone(),
                before: EntryState::of_opt(&on_disk),
                written: vec![EntryState::of_opt(&entry)],
            }),
        }
    }
    let mut after = recorded.clone();
    after.conflicts[at].resolution = resolution;
    after.conflicts[at].resolved = EntryState::of_opt(&entry);
    let restore = if writes_disk {
        let mut sets: Sets = BTreeMap::new();
        sets.insert(fid.clone(), vec![(path.clone(), entry.clone())]);
        let mut documents = snapshot.clone();
        if destructive {
            documents.overlays.retain(|o| {
                o.folder_id == folder_id
                    && (o.path == path || o.path.starts_with(&format!("{path}/")))
            });
        } else {
            documents.overlays.clear();
        }
        let mut restore = plan_transition(
            lookup,
            repo,
            folders,
            &documents,
            id(&state.theirs)?,
            &sets,
            &work_folders,
            RestorePolicy::ReplaceDocument,
        )?;
        restore.conflicts.splice(0..0, refusals);
        restore.unchanged = restore.operations.is_empty()
            && restore.conflicts.is_empty()
            && restore.documents.is_empty();
        Some(restore)
    } else {
        None
    };
    Ok(ResolvePlan {
        folder_id,
        path,
        choice,
        entry: EntryState::of_opt(&entry),
        restore,
        record: writes.then_some(recorded),
        state: Some(after),
        index: Some(Root { folders: trees }),
    })
}

/// Before a resolution's disk change: the state records what is about to be written there
/// (so an abort after a crash knows it), durably.
pub fn record_resolve(repo: &mut Repository, plan: &ResolvePlan) -> Result<()> {
    let Some(record) = &plan.record else {
        return Ok(());
    };
    let recorded = write_state(repo, record)?;
    let update = state_update(repo, Some(recorded));
    let revision = repo.refs().revision;
    repo.update_refs(
        revision,
        &[update],
        None,
        &format!("{}-resolve", record.kind.op()),
        &format!("writing {}", plan.path),
    )?;
    Ok(())
}

/// After the disk (if any of it) was changed and verified: the index holds the resolution and
/// the conflict is resolved -- one atomic step.
pub fn finish_resolve(repo: &mut Repository, plan: &ResolvePlan) -> Result<OperationState> {
    let state = plan.state.clone().ok_or(LgError::NoOperation)?;
    let root = plan.index.clone().ok_or(LgError::NoOperation)?;
    let mut updates = Vec::new();
    if let Some(update) = index_update(repo, root)? {
        updates.push(update);
    }
    let recorded = write_state(repo, &state)?;
    updates.push(state_update(repo, Some(recorded)));
    let revision = repo.refs().revision;
    repo.update_refs(
        revision,
        &updates,
        None,
        &format!("{}-resolve", state.kind.op()),
        &format!("{}: {:?}", plan.path, plan.choice),
    )?;
    Ok(state)
}

// --- Continuing and aborting -------------------------------------------------------------------

/// Completes an operation whose conflicts are all resolved: the commit (a merge commit with
/// parents HEAD then theirs, or the cherry-pick's copy) is made from the index, and HEAD, the
/// index and the state move together. Refused, with nothing changed, while anything is
/// unresolved or the index does not hold the resolutions.
pub fn finish_continue(
    repo: &mut Repository,
    message: Option<String>,
    by: &CommitRequest,
) -> Result<Created> {
    let (_, state) = current(repo)?.ok_or(LgError::NoOperation)?;
    if state.phase != Phase::Conflicts {
        return Err(interrupted(&state));
    }
    let unresolved = state.unresolved();
    if unresolved > 0 {
        return Err(LgError::UnresolvedConflicts(unresolved));
    }
    let message = message.unwrap_or_else(|| state.message.clone());
    validate_message(&message)?;
    let head = opt_id(&state.head)?.ok_or(LgError::Unborn)?;
    let theirs = id(&state.theirs)?;
    let index = index_state(repo)?;
    let root = index
        .root
        .ok_or_else(|| LgError::InvalidFormat("no index".into()))?;
    {
        let lookup = crate::diff::Trees {
            repo: Some(repo),
            extra: None,
        };
        for conflict in &state.conflicts {
            let fid = FolderId::new(&conflict.folder_id)?;
            let wanted = entry_at(&conflict.resolved, &conflict.path)?;
            let held = find(
                &lookup,
                Some(tree_or_empty(&index.folders, &fid)),
                &conflict.path,
            )?;
            if !same(&held, &wanted) {
                return Err(LgError::InvalidFormat(format!(
                    "the index no longer holds the resolution of {}",
                    conflict.path
                )));
            }
            let markers = matches!(
                conflict.resolution,
                Resolution::Manual | Resolution::Resolved
            );
            check_content(repo, &lookup, &conflict.path, &wanted, markers)?;
        }
    }
    let commit = match state.kind {
        OperationKind::Merge => Commit {
            root,
            disk_root: None,
            parents: vec![head, theirs],
            workspace: repo.meta().workspace.clone(),
            author: by.author.clone(),
            time_ms: by.time_ms,
            tz_offset_min: by.tz_offset_min,
            source: Source::Human,
            meta: [("merge".to_string(), theirs.to_hex())]
                .into_iter()
                .collect(),
            meta_objects: BTreeMap::new(),
            message,
        },
        OperationKind::CherryPick => {
            if root == repo.read_commit(&head)?.root {
                return Err(LgError::NothingToCommit);
            }
            let original = repo.read_commit(&theirs)?;
            picked_commit(repo, root, head, theirs, &original, &message, by)
        }
    };
    let mut txn = repo.begin_write()?;
    let commit_id = txn.put_commit(&commit)?;
    txn.commit()?;
    let (updates, head_update) = completion(repo, &state, commit_id)?;
    let revision = repo.refs().revision;
    let revision = repo.update_refs(
        revision,
        &updates,
        head_update,
        &format!("{}-continue", state.kind.op()),
        &format!("{} -> {}", state.label, short(&commit_id)),
    )?;
    Ok(Created {
        commit: commit_info(commit_id, &commit),
        revision,
    })
}

/// Plans taking every path the operation changed on disk back to what it held before --
/// refused where a path holds something the operation did not write (the user's edits) or a
/// document with unsaved changes is on one, unless `policy` is `allowDestructive`.
pub fn plan_abort(
    lookup: &dyn TreeLookup,
    repo: &mut Repository,
    folders: &[FolderRoot],
    snapshot: &Snapshot,
    policy: ResetPolicy,
) -> Result<RestorePlan> {
    let (_, state) = current(repo)?.ok_or(LgError::NoOperation)?;
    let before = repo.read_root(&id(&state.disk_before)?)?.folders;
    let destructive = policy == ResetPolicy::AllowDestructive;
    back_to(
        lookup,
        repo,
        folders,
        snapshot,
        &state,
        |t| t.before.clone(),
        &before,
        destructive,
        opt_id(&state.head)?.unwrap_or(id(&state.theirs)?),
    )
}

/// Plans taking the disk the rest of the way to the operation's result, after it stopped
/// while changing it (phase `applying`).
pub fn plan_resume(
    lookup: &dyn TreeLookup,
    repo: &mut Repository,
    folders: &[FolderRoot],
    snapshot: &Snapshot,
) -> Result<RestorePlan> {
    let (_, state) = current(repo)?.ok_or(LgError::NoOperation)?;
    if state.phase != Phase::Applying {
        return Err(LgError::InvalidFormat(format!(
            "the {} is not applying",
            state.kind.op()
        )));
    }
    let work = repo.read_root(&id(&state.result_work)?)?.folders;
    let label = opt_id(&state.commit)?.unwrap_or(id(&state.theirs)?);
    back_to(
        lookup,
        repo,
        folders,
        snapshot,
        &state,
        |t| t.written.last().cloned().flatten(),
        &work,
        false,
        label,
    )
}

/// Plans setting every touched path to `target(path)`: each must hold what it held before or
/// something the operation wrote there (or be `destructive`), and documents with unsaved
/// changes on them must already have that text (or be replaced, when `destructive`).
#[allow(clippy::too_many_arguments)]
fn back_to(
    lookup: &dyn TreeLookup,
    repo: &mut Repository,
    folders: &[FolderRoot],
    snapshot: &Snapshot,
    state: &OperationState,
    target: impl Fn(&Touched) -> Option<EntryState>,
    keep: &BTreeMap<FolderId, ObjectId>,
    destructive: bool,
    label: ObjectId,
) -> Result<RestorePlan> {
    let disk = disk_folders(snapshot)?;
    let mut refusals = Vec::new();
    let mut sets: Sets = BTreeMap::new();
    let mut documents = snapshot.clone();
    documents.overlays.clear();
    {
        let reads = Trees(&MemoryAndStore { repo, lookup });
        for touched in &state.touched {
            let fid = FolderId::new(&touched.folder_id)?;
            let path = &touched.path;
            let wanted = entry_at(&target(touched), path)?;
            let on_disk = find(&reads, Some(tree_or_empty(&disk, &fid)), path)?;
            let mut known = vec![entry_at(&touched.before, path)?];
            for written in &touched.written {
                known.push(entry_at(written, path)?);
            }
            if !known.iter().any(|k| same(k, &on_disk)) && !destructive {
                refusals.push(if known[0].is_none() {
                    RestoreConflict::UntrackedFileCollision {
                        folder_id: touched.folder_id.clone(),
                        path: path.clone(),
                    }
                } else {
                    RestoreConflict::UnstagedChangeWouldBeOverwritten {
                        folder_id: touched.folder_id.clone(),
                        path: path.clone(),
                    }
                });
            }
            for overlay in overlays_on(snapshot, &touched.folder_id, path) {
                let same_text = overlay.path == *path
                    && matches!(&wanted, Some(TreeEntry { kind: EntryKind::File { .. }, id, .. }) if *id == overlay.blob.0);
                if same_text {
                    continue;
                }
                if destructive {
                    documents.overlays.push(overlay.clone());
                } else {
                    refusals.push(if is_file(&wanted) && overlay.path == *path {
                        RestoreConflict::DirtyDocumentWouldBeOverwritten {
                            folder_id: touched.folder_id.clone(),
                            path: overlay.path.clone(),
                        }
                    } else {
                        RestoreConflict::DirtyDocumentWouldBeDeleted {
                            folder_id: touched.folder_id.clone(),
                            path: overlay.path.clone(),
                        }
                    });
                }
            }
            if !same(&on_disk, &wanted) {
                sets.entry(fid).or_default().push((path.clone(), wanted));
            }
        }
    }
    let mut restore = plan_transition(
        lookup,
        repo,
        folders,
        &documents,
        label,
        &sets,
        keep,
        RestorePolicy::ReplaceDocument,
    )?;
    restore.conflicts.splice(0..0, refusals);
    restore.unchanged = restore.operations.is_empty()
        && restore.conflicts.is_empty()
        && restore.documents.is_empty();
    Ok(restore)
}

/// After the disk was taken back and verified: the index goes back to what it was, and the
/// state goes -- one atomic step. HEAD never moved.
pub fn finish_abort(repo: &mut Repository) -> Result<u64> {
    let (_, state) = current(repo)?.ok_or(LgError::NoOperation)?;
    let began = opt_id(&state.head)?;
    if repo.refs().head_commit() != began {
        return Err(LgError::RefConflict {
            name: "HEAD".into(),
            expected: began,
            found: repo.refs().head_commit(),
        });
    }
    let mut updates = Vec::new();
    let index = RefName::new(INDEX_REF)?;
    let now = repo.refs().refs.get(&index).copied();
    let before = opt_id(&state.index_before)?;
    if now != before {
        updates.push(RefUpdate {
            name: index,
            expected: now,
            new: before,
        });
    }
    updates.push(state_update(repo, None));
    let revision = repo.refs().revision;
    repo.update_refs(
        revision,
        &updates,
        None,
        &format!("{}-abort", state.kind.op()),
        &format!("abort {}", state.label),
    )
}
