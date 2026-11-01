//! HEAD, branches, tags and the index ref (LG-04).
//!
//! Every one of them is a ref in LG-01's `refs.json`, moved only by `update_refs`: one atomic
//! compare-and-swap step, the reflog written first. Nothing here reads or writes real Git.
//!
//! - **HEAD** (`resolve_head`, the one place that interprets it): on a branch (which may be
//!   unborn -- no commit yet), or detached (straight on a commit).
//! - **Branches**: `refs/heads/<name>`; **tags**: `refs/tags/<name>`, lightweight (a ref to a
//!   commit), never moved or replaced once made.
//! - **The index**: `refs/yavin/index`, a commit whose root is the tree the next commit would
//!   have (see `index.rs`). No index ref means the index is HEAD's tree (empty when unborn).
//!
//! **Names** (branches and tags alike): 1 to 100 bytes of `/`-separated segments; each segment
//! is ASCII letters, digits, `.`, `_` or `-`, does not start with `.` or `-`, does not end with
//! `.` or `.lock`, and holds no `..`; the whole name is not `HEAD`. No spaces, no control
//! characters, no backslashes, nothing that could be read as a path out of `refs/`. A name
//! cannot be both a branch and a folder of branches (`a` and `a/b`), and names differing only
//! in case are refused (they are one file on some systems).

use crate::error::{LgError, Result};
use crate::history::require_commit;
use crate::id::ObjectId;
use crate::object::{Author, Commit, FolderId, Root, Source};
use crate::refs::{Head, RefName, RefUpdate};
use crate::repository::Repository;
use crate::snapshot::ObjectIdText;
use serde::Serialize;
use std::collections::{BTreeMap, HashSet};

pub const BRANCHES: &str = "refs/heads/";
pub const TAGS: &str = "refs/tags/";
/// Where the Local Index is: a commit whose root is the staged tree.
pub const INDEX_REF: &str = "refs/yavin/index";
/// The branch a new repository's HEAD names.
pub const DEFAULT_BRANCH: &str = "main";

/// Where HEAD is.
#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HeadState {
    /// On a branch that has a commit.
    #[serde(rename_all = "camelCase")]
    Branch {
        name: String,
        ref_name: String,
        commit: ObjectIdText,
    },
    /// Straight on a commit, on no branch.
    #[serde(rename_all = "camelCase")]
    Detached { commit: ObjectIdText },
    /// On a branch with no commit yet.
    #[serde(rename_all = "camelCase")]
    Unborn { name: String, ref_name: String },
}

impl HeadState {
    pub fn commit(&self) -> Option<ObjectId> {
        match self {
            HeadState::Branch { commit, .. } | HeadState::Detached { commit } => Some(commit.0),
            HeadState::Unborn { .. } => None,
        }
    }

    /// The branch's full ref name, when HEAD is on one.
    pub fn branch_ref(&self) -> Option<&str> {
        match self {
            HeadState::Branch { ref_name, .. } | HeadState::Unborn { ref_name, .. } => {
                Some(ref_name)
            }
            HeadState::Detached { .. } => None,
        }
    }
}

/// The one reading of HEAD everything uses.
pub fn resolve_head(repo: &Repository) -> HeadState {
    let refs = repo.refs();
    match &refs.head {
        Head::Detached(id) => HeadState::Detached {
            commit: ObjectIdText(*id),
        },
        Head::Symbolic(name) => {
            let short = name
                .as_str()
                .strip_prefix(BRANCHES)
                .unwrap_or(name.as_str())
                .to_string();
            match refs.refs.get(name) {
                Some(id) => HeadState::Branch {
                    name: short,
                    ref_name: name.as_str().into(),
                    commit: ObjectIdText(*id),
                },
                None => HeadState::Unborn {
                    name: short,
                    ref_name: name.as_str().into(),
                },
            }
        }
    }
}

/// A branch or tag name, checked (see the module documentation for the grammar).
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub struct ShortName(String);

impl ShortName {
    pub fn new(name: &str) -> Result<ShortName> {
        let bad = |why: &str| Err(LgError::InvalidName(format!("{name:?}: {why}")));
        if name.is_empty() || name.trim().is_empty() {
            return bad("a name cannot be empty");
        }
        if name.len() > 100 {
            return bad("longer than 100 bytes");
        }
        if name.eq_ignore_ascii_case("HEAD") {
            return bad("HEAD is reserved");
        }
        for segment in name.split('/') {
            if segment.is_empty() {
                return bad("empty segment (leading, trailing or doubled /)");
            }
            if !segment
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
            {
                return bad("only ASCII letters, digits, . _ - and / separators are allowed");
            }
            if segment.starts_with('.') || segment.starts_with('-') {
                return bad("a segment cannot start with . or -");
            }
            if segment.ends_with('.') || segment.ends_with(".lock") || segment.contains("..") {
                return bad("a segment cannot end with . or .lock, or hold ..");
            }
        }
        Ok(ShortName(name.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    fn under(&self, namespace: &str) -> Result<RefName> {
        RefName::new(&format!("{namespace}{}", self.0))
    }
}

/// Refuses `name` in `namespace` if it is a folder of existing names, or one of them is a
/// folder of it (`a` and `a/b`), ignoring case.
fn check_structure(repo: &Repository, namespace: &str, name: &ShortName) -> Result<()> {
    let wanted = name.as_str().to_lowercase();
    for existing in repo.refs().refs.keys() {
        let Some(other) = existing.as_str().strip_prefix(namespace) else {
            continue;
        };
        let other = other.to_lowercase();
        if other.starts_with(&format!("{wanted}/")) || wanted.starts_with(&format!("{other}/")) {
            return Err(LgError::InvalidName(format!(
                "{} conflicts with {}{}: one would be a folder of the other",
                name.as_str(),
                namespace,
                other
            )));
        }
    }
    Ok(())
}

/// The commit HEAD resolves to, or `Unborn`.
fn head_commit(repo: &Repository) -> Result<ObjectId> {
    resolve_head(repo).commit().ok_or(LgError::Unborn)
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub ref_name: String,
    pub commit: ObjectIdText,
    pub current: bool,
    /// Whether HEAD's history contains the branch's commit; none when that could not be
    /// decided within the walk's bound. (No merging exists yet: this is ancestry only.)
    pub merged: Option<bool>,
    /// Always none: Local Git has no remotes.
    pub upstream: Option<String>,
}

/// How far `merged` looks back through HEAD's history.
const MERGED_WALK: usize = 10_000;

/// The commits reachable from `starts` (all parents), up to `limit`; `true` if complete.
fn ancestry(repo: &Repository, starts: &[ObjectId], limit: usize) -> (HashSet<ObjectId>, bool) {
    let mut seen = HashSet::new();
    let mut stack: Vec<ObjectId> = starts.to_vec();
    while let Some(id) = stack.pop() {
        if seen.len() >= limit {
            return (seen, false);
        }
        if !seen.insert(id) {
            continue;
        }
        if let Ok(commit) = repo.read_commit(&id) {
            stack.extend(commit.parents);
        }
    }
    (seen, true)
}

pub fn list_branches(repo: &Repository) -> Vec<BranchInfo> {
    let head = resolve_head(repo);
    let (history, complete) = match head.commit() {
        Some(id) => ancestry(repo, &[id], MERGED_WALK),
        None => (HashSet::new(), true),
    };
    repo.refs()
        .refs
        .iter()
        .filter_map(|(name, id)| {
            let short = name.as_str().strip_prefix(BRANCHES)?;
            Some(BranchInfo {
                name: short.into(),
                ref_name: name.as_str().into(),
                commit: ObjectIdText(*id),
                current: head.branch_ref() == Some(name.as_str()),
                merged: if history.contains(id) {
                    Some(true)
                } else if complete {
                    Some(false)
                } else {
                    None
                },
                upstream: None,
            })
        })
        .collect()
}

pub fn get_branch(repo: &Repository, name: &str) -> Result<BranchInfo> {
    let name = ShortName::new(name)?;
    let full = name.under(BRANCHES)?;
    list_branches(repo)
        .into_iter()
        .find(|branch| branch.ref_name == full.as_str())
        .ok_or_else(|| LgError::NotFound(format!("branch {}", name.as_str())))
}

/// A new branch at `start` (a commit; HEAD's by default). HEAD does not move.
pub fn create_branch(
    repo: &mut Repository,
    name: &str,
    start: Option<ObjectId>,
) -> Result<BranchInfo> {
    let name = ShortName::new(name)?;
    let full = name.under(BRANCHES)?;
    let start = match start {
        Some(id) => id,
        None => head_commit(repo)?,
    };
    require_commit(repo, &start)?;
    if repo.refs().refs.contains_key(&full) {
        return Err(LgError::AlreadyExists(format!("branch {}", name.as_str())));
    }
    check_structure(repo, BRANCHES, &name)?;
    let revision = repo.refs().revision;
    repo.update_refs(
        revision,
        &[RefUpdate {
            name: full,
            expected: None,
            new: Some(start),
        }],
        None,
        "branch",
        &format!("create {}", name.as_str()),
    )?;
    get_branch(repo, name.as_str())
}

/// Deletes a branch -- never the current one, and never one whose commits nothing else
/// reaches (there is no forcing it).
pub fn delete_branch(repo: &mut Repository, name: &str) -> Result<()> {
    let name = ShortName::new(name)?;
    let full = name.under(BRANCHES)?;
    let head = resolve_head(repo);
    if head.branch_ref() == Some(full.as_str()) {
        return Err(LgError::CurrentBranch(name.as_str().into()));
    }
    let Some(tip) = repo.refs().refs.get(&full).copied() else {
        return Err(LgError::NotFound(format!("branch {}", name.as_str())));
    };
    // Reached from anything else -- HEAD, another branch, a tag -- or its commits would be
    // left unreferenced.
    let mut others: Vec<ObjectId> = repo
        .refs()
        .refs
        .iter()
        .filter(|(other, _)| {
            **other != full
                && (other.as_str().starts_with(BRANCHES) || other.as_str().starts_with(TAGS))
        })
        .map(|(_, id)| *id)
        .collect();
    others.extend(head.commit());
    let (reached, _) = ancestry(repo, &others, usize::MAX);
    if !reached.contains(&tip) {
        return Err(LgError::NotMerged(name.as_str().into()));
    }
    let revision = repo.refs().revision;
    repo.update_refs(
        revision,
        &[RefUpdate {
            name: full,
            expected: Some(tip),
            new: None,
        }],
        None,
        "branch",
        &format!("delete {}", name.as_str()),
    )?;
    Ok(())
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagInfo {
    pub name: String,
    pub ref_name: String,
    pub commit: ObjectIdText,
}

pub fn list_tags(repo: &Repository) -> Vec<TagInfo> {
    repo.refs()
        .refs
        .iter()
        .filter_map(|(name, id)| {
            Some(TagInfo {
                name: name.as_str().strip_prefix(TAGS)?.into(),
                ref_name: name.as_str().into(),
                commit: ObjectIdText(*id),
            })
        })
        .collect()
}

pub fn get_tag(repo: &Repository, name: &str) -> Result<TagInfo> {
    let name = ShortName::new(name)?;
    let full = name.under(TAGS)?;
    repo.refs()
        .refs
        .get(&full)
        .map(|id| TagInfo {
            name: name.as_str().into(),
            ref_name: full.as_str().into(),
            commit: ObjectIdText(*id),
        })
        .ok_or_else(|| LgError::NotFound(format!("tag {}", name.as_str())))
}

/// A lightweight tag at `target` (HEAD's commit by default). Never replaces one.
pub fn create_tag(repo: &mut Repository, name: &str, target: Option<ObjectId>) -> Result<TagInfo> {
    let name = ShortName::new(name)?;
    let full = name.under(TAGS)?;
    let target = match target {
        Some(id) => id,
        None => head_commit(repo)?,
    };
    require_commit(repo, &target)?;
    if repo.refs().refs.contains_key(&full) {
        return Err(LgError::AlreadyExists(format!("tag {}", name.as_str())));
    }
    check_structure(repo, TAGS, &name)?;
    let revision = repo.refs().revision;
    repo.update_refs(
        revision,
        &[RefUpdate {
            name: full,
            expected: None,
            new: Some(target),
        }],
        None,
        "tag",
        &format!("create {}", name.as_str()),
    )?;
    get_tag(repo, name.as_str())
}

pub fn delete_tag(repo: &mut Repository, name: &str) -> Result<()> {
    let tag = get_tag(repo, name)?;
    let revision = repo.refs().revision;
    repo.update_refs(
        revision,
        &[RefUpdate {
            name: RefName::new(&tag.ref_name)?,
            expected: Some(tag.commit.0),
            new: None,
        }],
        None,
        "tag",
        &format!("delete {}", tag.name),
    )?;
    Ok(())
}

/// The Local Index: the commit the index ref names (none: the index is HEAD's tree), and its
/// folders' trees.
#[derive(Clone, Debug)]
pub struct IndexState {
    pub commit: Option<ObjectId>,
    pub root: Option<ObjectId>,
    pub folders: BTreeMap<FolderId, ObjectId>,
}

pub fn index_state(repo: &Repository) -> Result<IndexState> {
    let name = RefName::new(INDEX_REF)?;
    let commit = repo
        .refs()
        .refs
        .get(&name)
        .copied()
        .or_else(|| resolve_head(repo).commit());
    match commit {
        Some(id) => {
            let root = repo.read_commit(&id)?.root;
            Ok(IndexState {
                commit: Some(id),
                root: Some(root),
                folders: repo.read_root(&root)?.folders,
            })
        }
        None => Ok(IndexState {
            commit: None,
            root: None,
            folders: BTreeMap::new(),
        }),
    }
}

/// The ref update (for `update_refs`) that makes the index `root`. `None` when it already
/// is. An index equal to HEAD's tree names HEAD's commit itself; an empty index with no HEAD
/// is no ref at all; anything else is a small, deterministic index commit (written here, in
/// its own published transaction) on top of HEAD.
pub fn index_update(repo: &mut Repository, root: Root) -> Result<Option<RefUpdate>> {
    let name = RefName::new(INDEX_REF)?;
    let current = repo.refs().refs.get(&name).copied();
    let head = resolve_head(repo).commit();
    let head_root = match head {
        Some(id) => Some(repo.read_commit(&id)?.root),
        None => None,
    };
    let root_id = root.id();
    let target = if Some(root_id) == head_root {
        head
    } else if head.is_none()
        && root
            .folders
            .values()
            .all(|tree| *tree == crate::object::Tree::default().id())
    {
        None
    } else {
        let mut txn = repo.begin_write()?;
        let tree_ids: Vec<ObjectId> = root.folders.values().copied().collect();
        for id in tree_ids {
            if id == crate::object::Tree::default().id() {
                txn.put_tree(&crate::object::Tree::default())?;
            }
        }
        txn.put_root(&root)?;
        let commit = Commit {
            root: root_id,
            disk_root: None,
            parents: head.into_iter().collect(),
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
        Some(id)
    };
    if target == current {
        return Ok(None);
    }
    Ok(Some(RefUpdate {
        name,
        expected: current,
        new: target,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_follow_the_grammar() {
        for good in [
            "main",
            "feature/login",
            "v1.2.3",
            "fix_2",
            "a-b",
            "x/y/z",
            "release-2026.09",
        ] {
            assert!(ShortName::new(good).is_ok(), "{good}");
        }
        for bad in [
            "",
            " ",
            "has space",
            "tab\tin",
            "nul\0",
            "back\\slash",
            "../escape",
            "a/../b",
            "/lead",
            "trail/",
            "dou//ble",
            ".hidden",
            "-dash",
            "end.",
            "x.lock",
            "a..b",
            "HEAD",
            "head",
            "ünïcode",
            "a:b",
            "a*b",
            "a?b",
            "a~b",
            "a^b",
            "a[b",
            "@{u}",
        ] {
            assert!(ShortName::new(bad).is_err(), "{bad:?}");
        }
        assert!(ShortName::new(&"x".repeat(101)).is_err());
    }
}
