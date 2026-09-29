//! Diffs between two states of the workspace (LG-03): commit to commit, or a commit (HEAD by
//! default) to the workspace as the user has it -- disk plus unsaved documents, taken by an
//! LG-02 snapshot, never a second scanner.
//!
//! **Which paths changed** comes from the same tree comparison as status (`status.rs`): whole
//! subtrees with equal ids are skipped, so two identical commits cost nothing, and a change is
//! added, deleted, modified, type-changed or renamed (exactly the same content at another
//! path, paired deterministically; no similarity matching).
//!
//! **What changed in a file** is a line diff in structured hunks (`LineDiff`) -- for text
//! only. A side is *binary* when its first 8 KiB hold a NUL or it is not UTF-8, and binary
//! files get no line diff. A side whose content is not available says why:
//!
//! - `notStored`: over the storage limit when it was recorded; only its hash and size exist.
//!   Its historical content is never read from disk in its place.
//! - `missing`: the store does not have the blob (damage; see `verify`).
//! - `changedOnDisk`: the workspace file changed after the snapshot was taken.
//! - `notAFile`: a directory or a link.
//!
//! Line diffs are bounded: a file over `DiffOptions::max_file_bytes` gets none (`tooLarge`),
//! and once `budget_bytes` of content have been compared the remaining files get none
//! (`budget`) -- their entries are still there.

use crate::error::Result;
use crate::id::{hash_object, ObjectId, ObjectKind};
use crate::object::{EntryKind, FolderId, Stored, Tree, TreeEntry};
use crate::repository::Repository;
use crate::scan::TreeLookup;
use crate::snapshot::ObjectIdText;
use crate::status::{changes, side, ChangeKind, Counts, Side};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::Arc;

/// How much a diff reads and compares.
#[derive(Clone, Copy, Debug)]
pub struct DiffOptions {
    /// Compute line diffs (otherwise only which paths changed, and how).
    pub line_diffs: bool,
    /// No line diff for a file larger than this on either side.
    pub max_file_bytes: u64,
    /// Stop computing line diffs once this much content has been compared.
    pub budget_bytes: u64,
    /// Unchanged lines around each change.
    pub context: usize,
}

impl Default for DiffOptions {
    fn default() -> Self {
        DiffOptions {
            line_diffs: true,
            max_file_bytes: 2 * 1024 * 1024,
            budget_bytes: 32 * 1024 * 1024,
            context: 3,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LineKind {
    Context,
    Addition,
    Deletion,
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: LineKind,
    /// The line without its line ending.
    pub text: String,
    /// 1-based, on the side it exists on.
    pub old_line: Option<u32>,
    pub new_line: Option<u32>,
    /// The file's last line, with no line ending after it.
    pub no_newline: bool,
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    /// 1-based first line and count on each side (a count of 0 has the line before it).
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub lines: Vec<DiffLine>,
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineDiff {
    pub hunks: Vec<Hunk>,
    pub additions: usize,
    pub deletions: usize,
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffEntry {
    pub folder_id: String,
    pub path: String,
    /// For a rename: where it was.
    pub old_path: Option<String>,
    pub kind: ChangeKind,
    pub old: Option<Side>,
    pub new: Option<Side>,
    /// Whether both sides' content (where there is a side) could be read.
    pub content_available: bool,
    /// Why not: `notStored`, `missing`, `changedOnDisk`, `notAFile`.
    pub unavailable: Option<&'static str>,
    pub binary: bool,
    pub line_diff: Option<LineDiff>,
    /// Why there is no line diff where one could be expected: `binary`, `unavailable`,
    /// `tooLarge`, `budget`, `notRequested`, `notAFile`.
    pub line_diff_skipped: Option<&'static str>,
}

/// One end of a diff.
#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffEnd {
    /// `commit`, `workspace` or `empty` (before the first commit).
    pub kind: &'static str,
    pub commit: Option<ObjectIdText>,
    pub root: Option<ObjectIdText>,
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffResult {
    pub from: DiffEnd,
    pub to: DiffEnd,
    /// Both ends are the same tree: nothing was compared.
    pub identical: bool,
    pub entries: Vec<DiffEntry>,
    pub counts: Counts,
}

/// A side's bytes, or why they cannot be had.
pub enum Content {
    Bytes(Arc<Vec<u8>>),
    Unavailable(&'static str),
}

/// Where one end of a diff gets file content.
pub trait ContentSource {
    fn content(&self, folder: &FolderId, path: &str, entry: &TreeEntry) -> Content;
}

/// History: the store, and nothing else.
pub struct StoreContent<'a> {
    pub repo: &'a Repository,
}

impl ContentSource for StoreContent<'_> {
    fn content(&self, _folder: &FolderId, _path: &str, entry: &TreeEntry) -> Content {
        match entry.kind {
            EntryKind::File {
                stored: Stored::No { .. },
                ..
            } => Content::Unavailable("notStored"),
            EntryKind::Directory => Content::Unavailable("notAFile"),
            _ => match self.repo.read_blob(&entry.id, u64::MAX) {
                Ok(bytes) => Content::Bytes(Arc::new(bytes)),
                Err(_) => Content::Unavailable("missing"),
            },
        }
    }
}

/// The workspace as a snapshot saw it: unsaved documents' bytes, then the store, then the file
/// on disk -- accepted only if it still hashes to what the snapshot recorded.
pub struct WorkspaceContent<'a> {
    pub repo: &'a Repository,
    pub overlays: HashMap<ObjectId, Arc<Vec<u8>>>,
    pub folders: HashMap<FolderId, PathBuf>,
}

impl ContentSource for WorkspaceContent<'_> {
    fn content(&self, folder: &FolderId, path: &str, entry: &TreeEntry) -> Content {
        match entry.kind {
            EntryKind::File {
                stored: Stored::No { .. },
                ..
            } => return Content::Unavailable("notStored"),
            EntryKind::Directory => return Content::Unavailable("notAFile"),
            _ => {}
        }
        if let Some(bytes) = self.overlays.get(&entry.id) {
            return Content::Bytes(bytes.clone());
        }
        if let Ok(bytes) = self.repo.read_blob(&entry.id, u64::MAX) {
            return Content::Bytes(Arc::new(bytes));
        }
        if let EntryKind::Symlink(_) = entry.kind {
            return Content::Unavailable("notAFile");
        }
        let Some(root) = self.folders.get(folder) else {
            return Content::Unavailable("missing");
        };
        match std::fs::read(root.join(path)) {
            Ok(bytes) if hash_object(ObjectKind::Blob, &bytes) == entry.id => {
                Content::Bytes(Arc::new(bytes))
            }
            _ => Content::Unavailable("changedOnDisk"),
        }
    }
}

/// A store's trees, plus the empty tree (which may never have been stored).
pub struct Trees<'a> {
    pub repo: Option<&'a Repository>,
    pub extra: Option<&'a (dyn TreeLookup + 'a)>,
}

impl TreeLookup for Trees<'_> {
    fn tree(&self, id: &ObjectId) -> Option<Tree> {
        if *id == Tree::default().id() {
            return Some(Tree::default());
        }
        if let Some(tree) = self.extra.and_then(|extra| extra.tree(id)) {
            return Some(tree);
        }
        self.repo.and_then(|repo| repo.read_tree(id).ok())
    }
}

fn is_binary(bytes: &[u8]) -> bool {
    bytes[..bytes.len().min(8192)].contains(&0) || std::str::from_utf8(bytes).is_err()
}

/// Lines of `bytes`, each with its line ending (so `a\n` and `a` differ, and so do `a\r\n`
/// and `a\n`).
fn lines(bytes: &[u8]) -> Vec<&[u8]> {
    let mut out = Vec::new();
    let mut start = 0;
    for (at, byte) in bytes.iter().enumerate() {
        if *byte == b'\n' {
            out.push(&bytes[start..=at]);
            start = at + 1;
        }
    }
    if start < bytes.len() {
        out.push(&bytes[start..]);
    }
    out
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Edit {
    Equal,
    Delete,
    Insert,
}

/// The most differences the exact algorithm looks for before treating the rest of the file
/// as replaced (still a correct diff, just not a minimal one).
const MAX_EDIT_DISTANCE: usize = 4000;

/// Myers' O(ND) shortest edit script between `a` and `b`, after trimming their common start
/// and end. Beyond `MAX_EDIT_DISTANCE` the middle is reported as deleted then inserted.
fn edit_script(a: &[&[u8]], b: &[&[u8]]) -> Vec<Edit> {
    let prefix = a.iter().zip(b).take_while(|(x, y)| x == y).count();
    let suffix = a[prefix..]
        .iter()
        .rev()
        .zip(b[prefix..].iter().rev())
        .take_while(|(x, y)| x == y)
        .count();
    let (am, bm) = (&a[prefix..a.len() - suffix], &b[prefix..b.len() - suffix]);
    let mut script = vec![Edit::Equal; prefix];
    script.extend(middle(am, bm));
    script.extend(std::iter::repeat_n(Edit::Equal, suffix));
    script
}

fn middle(a: &[&[u8]], b: &[&[u8]]) -> Vec<Edit> {
    let (n, m) = (a.len(), b.len());
    if n == 0 || m == 0 {
        let mut out = vec![Edit::Delete; n];
        out.extend(std::iter::repeat_n(Edit::Insert, m));
        return out;
    }
    let max = (n + m).min(MAX_EDIT_DISTANCE);
    let offset = max as isize;
    let mut v = vec![0isize; 2 * max + 2];
    let mut trace: Vec<Vec<isize>> = Vec::new();
    let mut found = None;
    'outer: for d in 0..=max as isize {
        trace.push(v.clone());
        let mut k = -d;
        while k <= d {
            let at = (k + offset) as usize;
            let mut x = if k == -d || (k != d && v[at - 1] < v[at + 1]) {
                v[at + 1]
            } else {
                v[at - 1] + 1
            };
            let mut y = x - k;
            while (x as usize) < n && (y as usize) < m && a[x as usize] == b[y as usize] {
                x += 1;
                y += 1;
            }
            v[at] = x;
            if x as usize >= n && y as usize >= m {
                found = Some(d);
                break 'outer;
            }
            k += 2;
        }
    }
    let Some(d_end) = found else {
        // Too different to find the shortest script: replace the whole middle.
        let mut out = vec![Edit::Delete; n];
        out.extend(std::iter::repeat_n(Edit::Insert, m));
        return out;
    };
    // Walk back through the recorded frontiers.
    let mut out = Vec::new();
    let (mut x, mut y) = (n as isize, m as isize);
    for d in (1..=d_end).rev() {
        let v = &trace[d as usize];
        let k = x - y;
        let at = (k + offset) as usize;
        let prev_k = if k == -d || (k != d && v[at - 1] < v[at + 1]) {
            k + 1
        } else {
            k - 1
        };
        let prev_x = v[(prev_k + offset) as usize];
        let prev_y = prev_x - prev_k;
        while x > prev_x && y > prev_y {
            out.push(Edit::Equal);
            x -= 1;
            y -= 1;
        }
        if x == prev_x {
            out.push(Edit::Insert);
        } else {
            out.push(Edit::Delete);
        }
        x = prev_x;
        y = prev_y;
    }
    while x > 0 && y > 0 {
        out.push(Edit::Equal);
        x -= 1;
        y -= 1;
    }
    out.reverse();
    out
}

fn line_text(line: &[u8]) -> (String, bool) {
    let has_newline = line.ends_with(b"\n");
    let mut body = if has_newline {
        &line[..line.len() - 1]
    } else {
        line
    };
    if body.ends_with(b"\r") {
        body = &body[..body.len() - 1];
    }
    (String::from_utf8_lossy(body).into_owned(), !has_newline)
}

/// The line diff of two texts, in hunks with `context` unchanged lines around each change.
pub fn line_diff(old: &[u8], new: &[u8], context: usize) -> LineDiff {
    let (a, b) = (lines(old), lines(new));
    let script = edit_script(&a, &b);
    // Every line, numbered.
    let mut all = Vec::with_capacity(script.len());
    let (mut i, mut j) = (0usize, 0usize);
    for edit in script {
        match edit {
            Edit::Equal => {
                let (text, no_newline) = line_text(a[i]);
                all.push(DiffLine {
                    kind: LineKind::Context,
                    text,
                    old_line: Some(i as u32 + 1),
                    new_line: Some(j as u32 + 1),
                    no_newline,
                });
                i += 1;
                j += 1;
            }
            Edit::Delete => {
                let (text, no_newline) = line_text(a[i]);
                all.push(DiffLine {
                    kind: LineKind::Deletion,
                    text,
                    old_line: Some(i as u32 + 1),
                    new_line: None,
                    no_newline,
                });
                i += 1;
            }
            Edit::Insert => {
                let (text, no_newline) = line_text(b[j]);
                all.push(DiffLine {
                    kind: LineKind::Addition,
                    text,
                    old_line: None,
                    new_line: Some(j as u32 + 1),
                    no_newline,
                });
                j += 1;
            }
        }
    }
    let changed: Vec<usize> = all
        .iter()
        .enumerate()
        .filter(|(_, line)| line.kind != LineKind::Context)
        .map(|(at, _)| at)
        .collect();
    let mut hunks = Vec::new();
    let mut at = 0;
    while at < changed.len() {
        let start = changed[at].saturating_sub(context);
        let mut end = changed[at];
        at += 1;
        while at < changed.len() && changed[at] <= end + 2 * context + 1 {
            end = changed[at];
            at += 1;
        }
        let end = (end + context).min(all.len() - 1);
        let lines: Vec<DiffLine> = all[start..=end].to_vec();
        let old_lines = lines
            .iter()
            .filter(|l| l.kind != LineKind::Addition)
            .count() as u32;
        let new_lines = lines
            .iter()
            .filter(|l| l.kind != LineKind::Deletion)
            .count() as u32;
        // Where each side's part of the hunk starts: its first line there, or (none) the
        // line before it.
        let old_before = all[..start]
            .iter()
            .filter(|l| l.kind != LineKind::Addition)
            .count();
        let new_before = all[..start]
            .iter()
            .filter(|l| l.kind != LineKind::Deletion)
            .count();
        hunks.push(Hunk {
            old_start: if old_lines == 0 {
                old_before as u32
            } else {
                old_before as u32 + 1
            },
            old_lines,
            new_start: if new_lines == 0 {
                new_before as u32
            } else {
                new_before as u32 + 1
            },
            new_lines,
            lines,
        });
    }
    LineDiff {
        additions: all.iter().filter(|l| l.kind == LineKind::Addition).count(),
        deletions: all.iter().filter(|l| l.kind == LineKind::Deletion).count(),
        hunks,
    }
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

/// Compares `old` and `new` (folder -> tree), with content from `old_src` and `new_src`.
#[allow(clippy::too_many_arguments)]
pub fn diff_trees(
    lookup: &dyn TreeLookup,
    old: &BTreeMap<FolderId, ObjectId>,
    new: &BTreeMap<FolderId, ObjectId>,
    old_src: &dyn ContentSource,
    new_src: &dyn ContentSource,
    options: &DiffOptions,
) -> Result<(Vec<DiffEntry>, Counts)> {
    let empty = Tree::default().id();
    let mut folders: Vec<&FolderId> = old.keys().chain(new.keys()).collect();
    folders.sort();
    folders.dedup();
    let mut entries = Vec::new();
    let mut counts = Counts::default();
    let mut budget = options.budget_bytes;
    for folder in folders {
        let from = old.get(folder).copied();
        let to = new.get(folder).copied().unwrap_or(empty);
        for leaf in changes(lookup, from.or(Some(empty)), to)? {
            match leaf.kind {
                ChangeKind::Added => counts.added += 1,
                ChangeKind::Modified => counts.modified += 1,
                ChangeKind::Deleted => counts.deleted += 1,
                ChangeKind::TypeChanged => counts.type_changed += 1,
                ChangeKind::Renamed => counts.renamed += 1,
            }
            let old_path = leaf.from.clone();
            let read = |src: &dyn ContentSource, entry: &Option<TreeEntry>, path: &str| {
                entry.as_ref().map(|entry| src.content(folder, path, entry))
            };
            let files = (leaf.old.is_none() || is_file(&leaf.old))
                && (leaf.new.is_none() || is_file(&leaf.new));
            let mut entry = DiffEntry {
                folder_id: folder.as_str().into(),
                path: leaf.path.clone(),
                old_path: old_path.clone(),
                kind: leaf.kind,
                old: leaf.old.as_ref().map(side),
                new: leaf.new.as_ref().map(side),
                content_available: true,
                unavailable: None,
                binary: false,
                line_diff: None,
                line_diff_skipped: None,
            };
            if !files {
                entry.content_available = false;
                entry.unavailable = Some("notAFile");
                entry.line_diff_skipped = Some("notAFile");
                entries.push(entry);
                continue;
            }
            let too_large = [&leaf.old, &leaf.new].iter().any(|side| {
                side.as_ref().is_some_and(|e| match e.kind {
                    EntryKind::File {
                        stored: Stored::No { size },
                        ..
                    } => size > options.max_file_bytes,
                    _ => false,
                })
            });
            let old_content = read(
                old_src,
                &leaf.old,
                old_path.as_deref().unwrap_or(&leaf.path),
            );
            let new_content = read(new_src, &leaf.new, &leaf.path);
            let mut texts: Vec<Arc<Vec<u8>>> = Vec::new();
            for content in [&old_content, &new_content].into_iter().flatten() {
                match content {
                    Content::Bytes(bytes) => texts.push(bytes.clone()),
                    Content::Unavailable(why) => {
                        entry.content_available = false;
                        entry.unavailable.get_or_insert(why);
                    }
                }
            }
            entry.binary = texts.iter().any(|bytes| is_binary(bytes));
            entry.line_diff_skipped = if !entry.content_available {
                Some(if too_large { "tooLarge" } else { "unavailable" })
            } else if entry.binary {
                Some("binary")
            } else if !options.line_diffs {
                Some("notRequested")
            } else if texts
                .iter()
                .any(|t| t.len() as u64 > options.max_file_bytes)
            {
                Some("tooLarge")
            } else {
                let cost: u64 = texts.iter().map(|t| t.len() as u64).sum();
                if cost > budget {
                    Some("budget")
                } else {
                    budget -= cost;
                    None
                }
            };
            if entry.line_diff_skipped.is_none() {
                let empty = Vec::new();
                let old_bytes = match &old_content {
                    Some(Content::Bytes(bytes)) => bytes.as_slice(),
                    _ => &empty,
                };
                let new_bytes = match &new_content {
                    Some(Content::Bytes(bytes)) => bytes.as_slice(),
                    _ => &empty,
                };
                entry.line_diff = Some(line_diff(old_bytes, new_bytes, options.context));
            }
            entries.push(entry);
        }
    }
    Ok((entries, counts))
}

/// A commit's root folders.
fn commit_folders(
    repo: &Repository,
    commit: &ObjectId,
) -> Result<(ObjectId, BTreeMap<FolderId, ObjectId>)> {
    let root = repo.read_commit(commit)?.root;
    Ok((root, repo.read_root(&root)?.folders))
}

/// Commit `from` (none: the empty state before the first commit) to commit `to`.
pub fn diff_commits(
    repo: &Repository,
    from: Option<ObjectId>,
    to: ObjectId,
    options: &DiffOptions,
) -> Result<DiffResult> {
    let (to_root, to_folders) = commit_folders(repo, &to)?;
    let (from_root, from_folders) = match from {
        Some(id) => {
            let (root, folders) = commit_folders(repo, &id)?;
            (Some(root), folders)
        }
        None => (None, BTreeMap::new()),
    };
    let end = |commit: Option<ObjectId>, root: Option<ObjectId>| DiffEnd {
        kind: if commit.is_some() { "commit" } else { "empty" },
        commit: commit.map(ObjectIdText),
        root: root.map(ObjectIdText),
    };
    if from_root == Some(to_root) {
        return Ok(DiffResult {
            from: end(from, from_root),
            to: end(Some(to), Some(to_root)),
            identical: true,
            entries: Vec::new(),
            counts: Counts::default(),
        });
    }
    let trees = Trees {
        repo: Some(repo),
        extra: None,
    };
    let source = StoreContent { repo };
    let (entries, counts) = diff_trees(
        &trees,
        &from_folders,
        &to_folders,
        &source,
        &source,
        options,
    )?;
    Ok(DiffResult {
        from: end(from, from_root),
        to: end(Some(to), Some(to_root)),
        identical: false,
        entries,
        counts,
    })
}

/// A commit, its root, and the root's folder trees.
pub type BaseCommit = (ObjectId, ObjectId, BTreeMap<FolderId, ObjectId>);

/// The commit a diff against the workspace starts from: `from`, or HEAD (none if unborn).
pub fn base_commit(repo: &Repository, from: Option<ObjectId>) -> Result<Option<BaseCommit>> {
    match from.or_else(|| repo.refs().head_commit()) {
        Some(id) => {
            let (root, folders) = commit_folders(repo, &id)?;
            Ok(Some((id, root, folders)))
        }
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn render(diff: &LineDiff) -> Vec<String> {
        let mut out = Vec::new();
        for hunk in &diff.hunks {
            out.push(format!(
                "@@ -{},{} +{},{} @@",
                hunk.old_start, hunk.old_lines, hunk.new_start, hunk.new_lines
            ));
            for line in &hunk.lines {
                let mark = match line.kind {
                    LineKind::Context => ' ',
                    LineKind::Addition => '+',
                    LineKind::Deletion => '-',
                };
                out.push(format!("{mark}{}", line.text));
            }
        }
        out
    }

    #[test]
    fn a_one_line_change_is_one_hunk_with_context() {
        let old = b"1\n2\n3\n4\n5\n6\n7\n8\n9\n";
        let new = b"1\n2\n3\n4\nfive\n6\n7\n8\n9\n";
        let diff = line_diff(old, new, 3);
        assert_eq!(
            render(&diff),
            vec![
                "@@ -2,7 +2,7 @@",
                " 2",
                " 3",
                " 4",
                "-5",
                "+five",
                " 6",
                " 7",
                " 8"
            ]
        );
        assert_eq!((diff.additions, diff.deletions), (1, 1));
    }

    #[test]
    fn far_apart_changes_are_separate_hunks_and_near_ones_merge() {
        let text = |changed: &[(usize, &str)]| -> String {
            (1..=30)
                .map(|i| match changed.iter().find(|(at, _)| *at == i) {
                    Some((_, to)) => format!(
                        "{to}
"
                    ),
                    None => format!(
                        "{i}
"
                    ),
                })
                .collect()
        };
        let old = text(&[]);
        let far = text(&[(3, "three"), (27, "twenty-seven")]);
        assert_eq!(line_diff(old.as_bytes(), far.as_bytes(), 3).hunks.len(), 2);
        let near = text(&[(10, "ten"), (14, "fourteen")]);
        assert_eq!(line_diff(old.as_bytes(), near.as_bytes(), 3).hunks.len(), 1);
    }

    #[test]
    fn added_and_removed_files_and_edges() {
        let added = line_diff(b"", b"a\nb\n", 3);
        assert_eq!(render(&added), vec!["@@ -0,0 +1,2 @@", "+a", "+b"]);
        let removed = line_diff(b"a\nb\n", b"", 3);
        assert_eq!(render(&removed), vec!["@@ -1,2 +0,0 @@", "-a", "-b"]);
        // The line ending at the end of the file, and CRLF against LF, are changes.
        let eof = line_diff(b"a\nb\n", b"a\nb", 3);
        assert_eq!(eof.deletions, 1);
        assert!(eof.hunks[0].lines.last().unwrap().no_newline);
        let crlf = line_diff(b"a\r\nb\r\n", b"a\nb\n", 3);
        assert_eq!((crlf.additions, crlf.deletions), (2, 2));
        assert!(line_diff(b"same\n", b"same\n", 3).hunks.is_empty());
    }

    #[test]
    fn the_script_is_minimal_and_reproduces_the_new_text() {
        let old = b"a\nb\nc\nd\ne\nf\n";
        let new = b"a\nc\nd\nx\ne\nf\ng\n";
        let diff = line_diff(old, new, 100);
        assert_eq!((diff.additions, diff.deletions), (2, 1));
        let rebuilt: Vec<String> = diff.hunks[0]
            .lines
            .iter()
            .filter(|l| l.kind != LineKind::Deletion)
            .map(|l| l.text.clone())
            .collect();
        assert_eq!(rebuilt, vec!["a", "c", "d", "x", "e", "f", "g"]);
    }

    #[test]
    fn binary_is_a_nul_or_not_utf8() {
        assert!(is_binary(b"a\0b"));
        assert!(is_binary(&[0xff, 0xfe, 0x41]));
        assert!(!is_binary("ünïcode\n".as_bytes()));
    }
}
