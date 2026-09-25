//! Yavin's own filesystem operations, as the watcher needs to know them.
//!
//! One logical action -- a save, a copy, a Git switch -- is one operation, however many
//! filesystem effects it has: a save writes a temporary file and renames it over the target, a
//! create may make the folders above the file first, a copy writes a whole tree. The operation
//! is begun before anything touches the disk, every effect it will have is registered against
//! it as an `Expectation`, and it ends completed or failed. When the watcher reports a change,
//! `ExpectedWrites::attribute` credits it to the operation whose expectation the disk -- read
//! at that moment -- satisfies.
//!
//! Nothing is ever credited by timing or by path alone. A change is Yavin's only if the disk
//! is in the state the operation said it would leave: the bytes it wrote, the folder it made,
//! the file it copied, the index Git checked out. Another program writing something else to the
//! same path, even while the operation runs, is reported as external. There is no "ignore this
//! path for a while".
//!
//! Attribution grants nothing: every operation is still checked by the command that performs
//! it. And an operation that fails is forgotten at once, so its expectations cannot account for
//! anything that happens afterwards.

use crate::process::capture_within;
use crate::resource_events::{ChangeKind, ResourceChange};
use std::collections::{HashSet, VecDeque};
use std::hash::{DefaultHasher, Hasher};
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// A completed operation is forgotten this long after it finished. Only memory is at stake:
/// matching is by disk state, so keeping one longer could not hide a change, and dropping one
/// earlier could only leave a Yavin change unattributed.
const COMPLETED_TTL: Duration = Duration::from_secs(10);
/// A started operation that never finished -- its thread died without the guard running --
/// is forgotten after this. Long enough for the slowest legitimate operation, a clone or a pull.
const STARTED_TTL: Duration = Duration::from_secs(30 * 60);
/// Operations held at once. Past it the oldest go, completed ones first.
const MAX_OPERATIONS: usize = 256;
/// Expectations one operation may register. Enough for a create under a new folder chain as
/// deep as anyone makes one; a tree (a copy, a checkout) is one expectation, not one per file.
const MAX_EXPECTATIONS_PER_OPERATION: usize = 64;
/// How long a `git status` asked for attribution may take before it is abandoned (and the
/// changes it was checking reported as external).
const GIT_CHECK_TIMEOUT: Duration = Duration::from_secs(10);

/// What kind of action an operation is. Kept for diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OperationKind {
    Save,
    CreateFile,
    CreateDirectory,
    Rename,
    Delete,
    Copy,
    Git,
}

/// What an operation leaves at a path when it succeeds. Each is checked against the disk when
/// a change is reported there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Expectation {
    /// A file with exactly these bytes.
    Content { size: u64, hash: u64 },
    /// A file that exists only while the operation runs -- a save's temporary file: either
    /// already gone, or holding exactly these bytes.
    Transient { size: u64, hash: u64 },
    /// A directory.
    Directory,
    /// Something: a rename's destination, or its old name after a case-only rename.
    Present,
    /// Nothing -- and, for a deletion, nothing below it either.
    Absent,
    /// A copy of `source`: the path, and anything created or written below it, holds exactly
    /// what the corresponding path under `source` holds.
    CopyOf { source: String },
    /// A Git working tree, for an operation that writes it: the path, and anything below it,
    /// is exactly what Git's index says -- as `git status` reports it.
    GitClean,
}

impl Expectation {
    pub fn content(bytes: &[u8]) -> Self {
        Expectation::Content {
            size: bytes.len() as u64,
            hash: content_hash(bytes),
        }
    }

    pub fn transient(bytes: &[u8]) -> Self {
        Expectation::Transient {
            size: bytes.len() as u64,
            hash: content_hash(bytes),
        }
    }
}

/// An identity for file content. Not cryptographic -- it only has to tell Yavin's own bytes
/// from anything else that lands at the same path, and it is always checked with the size.
fn content_hash(bytes: &[u8]) -> u64 {
    let mut hasher = DefaultHasher::new();
    hasher.write(bytes);
    hasher.finish()
}

/// Whether the file at `path` holds exactly `size` bytes hashing to `hash`. Reads the file
/// only when the size already matches.
fn has_content(path: &Path, size: u64, hash: u64) -> bool {
    std::fs::metadata(path).is_ok_and(|meta| meta.is_file() && meta.len() == size)
        && std::fs::read(path).is_ok_and(|bytes| content_hash(&bytes) == hash)
}

fn is_absent(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
}

/// Whether `path` and `source` hold the same thing: both folders, or both files with the same
/// bytes.
fn same_as(path: &Path, source: &Path) -> bool {
    match (std::fs::metadata(path), std::fs::metadata(source)) {
        (Ok(ours), Ok(theirs)) if ours.is_dir() && theirs.is_dir() => true,
        (Ok(ours), Ok(theirs)) if ours.is_file() && theirs.is_file() => {
            ours.len() == theirs.len()
                && matches!(
                    (std::fs::read(path), std::fs::read(source)),
                    (Ok(a), Ok(b)) if content_hash(&a) == content_hash(&b)
                )
        }
        _ => false,
    }
}

/// `path` relative to `folder`, per segment: `Some("")` for the folder itself, `Some("a/b")`
/// below it, `None` outside. Both are cleaned paths from one watch, so they share a spelling.
fn below(path: &str, folder: &str) -> Option<String> {
    if path == folder {
        return Some(String::new());
    }
    let rest = path.strip_prefix(folder)?;
    if folder.ends_with('/') {
        Some(rest.to_string())
    } else {
        rest.strip_prefix('/').map(str::to_string)
    }
}

/// Whether a change of this kind at `path` is what `expectation`, registered at `at`, says the
/// operation leaves. Git working trees are checked a batch at a time instead (`attribute`).
fn accounts_for(expectation: &Expectation, at: &str, path: &str, kind: ChangeKind) -> bool {
    // Reading a folder to copy it updates the folder's access time, which Windows reports as a
    // modification of the *source*. That is the copy's doing -- but only for folders: a file
    // under the source changing is someone else's edit, and a file added inside a source
    // folder arrives as its own creation, which is not credited here.
    if let Expectation::CopyOf { source } = expectation {
        if kind == ChangeKind::Modified && below(path, source).is_some() && Path::new(path).is_dir()
        {
            return true;
        }
    }
    let Some(rest) = below(path, at) else {
        return false;
    };
    let here = rest.is_empty();
    let disk = Path::new(path);
    match expectation {
        Expectation::Content { size, hash } => here && has_content(disk, *size, *hash),
        Expectation::Transient { size, hash } => {
            here && (is_absent(disk) || has_content(disk, *size, *hash))
        }
        Expectation::Directory => here && disk.is_dir(),
        Expectation::Present => here && !is_absent(disk),
        // A deletion below a folder the operation deleted is its too: the folder being gone is
        // exactly what it said it would leave.
        Expectation::Absent => (here || kind == ChangeKind::Deleted) && is_absent(Path::new(at)),
        // A copy creates and writes; it never deletes.
        Expectation::CopyOf { source } => {
            kind != ChangeKind::Deleted && {
                let source = if here {
                    source.clone()
                } else {
                    format!("{source}/{rest}")
                };
                same_as(disk, Path::new(&source))
            }
        }
        Expectation::GitClean => false,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OperationState {
    Started,
    Completed,
}

#[derive(Debug)]
struct Record {
    id: u64,
    kind: OperationKind,
    state: OperationState,
    expectations: Vec<(String, Expectation)>,
    started: Instant,
    finished: Option<Instant>,
}

/// The operations in flight or recently finished, and what each will leave on disk.
#[derive(Debug, Default)]
pub struct ExpectedWrites {
    operations: Mutex<VecDeque<Record>>,
    next: AtomicU64,
}

/// A running operation. Register every effect with `expect` before causing it, then `complete`
/// or `fail`. Dropped without either -- an early return, a panic -- it counts as failed, so its
/// expectations never outlive it.
#[must_use = "an operation that is dropped immediately is failed"]
pub struct Operation<'a> {
    owner: &'a ExpectedWrites,
    id: u64,
    finished: bool,
}

impl Operation<'_> {
    pub fn id(&self) -> u64 {
        self.id
    }

    /// Registers what the operation will leave at `path` (a cleaned path). Must come before
    /// the effect: registered afterwards, the change may already have been reported.
    pub fn expect(&self, path: impl Into<String>, expectation: Expectation) {
        self.owner.add(self.id, path.into(), expectation);
    }

    pub fn complete(mut self) {
        self.finished = true;
        self.owner.finish(self.id, true);
    }

    pub fn fail(mut self) {
        self.finished = true;
        self.owner.finish(self.id, false);
    }

    /// Completes or fails the operation to match how it went.
    pub fn finish<T, E>(self, result: &Result<T, E>) {
        if result.is_ok() {
            self.complete();
        } else {
            self.fail();
        }
    }
}

impl Drop for Operation<'_> {
    fn drop(&mut self) {
        if !self.finished {
            self.owner.finish(self.id, false);
        }
    }
}

impl ExpectedWrites {
    /// Starts an operation. Nothing it causes is credited to it until its effects are
    /// registered with `Operation::expect`.
    pub fn begin(&self, kind: OperationKind) -> Operation<'_> {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let now = Instant::now();
        if let Ok(mut operations) = self.operations.lock() {
            prune(&mut operations, now);
            if operations.len() >= MAX_OPERATIONS {
                let oldest_completed = operations
                    .iter()
                    .position(|record| record.state == OperationState::Completed);
                if let Some(evicted) = operations.remove(oldest_completed.unwrap_or(0)) {
                    if evicted.state == OperationState::Started {
                        // Its changes will now be reported as external: worth knowing why.
                        eprintln!(
                            "{MAX_OPERATIONS} file operations in flight; no longer attributing \
                             changes to the oldest ({:?})",
                            evicted.kind
                        );
                    }
                }
            }
            operations.push_back(Record {
                id,
                kind,
                state: OperationState::Started,
                expectations: Vec::new(),
                started: now,
                finished: None,
            });
        }
        Operation {
            owner: self,
            id,
            finished: false,
        }
    }

    fn add(&self, id: u64, path: String, expectation: Expectation) {
        if let Ok(mut operations) = self.operations.lock() {
            if let Some(record) = operations.iter_mut().find(|record| record.id == id) {
                if record.expectations.len() < MAX_EXPECTATIONS_PER_OPERATION {
                    record.expectations.push((path, expectation));
                }
            }
        }
    }

    /// A completed operation is kept until `COMPLETED_TTL` after this; a failed one goes now.
    fn finish(&self, id: u64, succeeded: bool) {
        if let Ok(mut operations) = self.operations.lock() {
            if succeeded {
                if let Some(record) = operations.iter_mut().find(|record| record.id == id) {
                    record.state = OperationState::Completed;
                    record.finished = Some(Instant::now());
                }
            } else {
                operations.retain(|record| record.id != id);
            }
        }
    }

    /// Credits each change in a batch to the operation that accounts for it, where one does,
    /// by setting `operation`. Changes already credited are left alone.
    pub fn attribute(&self, changes: &mut [ResourceChange]) {
        let working_trees = {
            let Ok(mut operations) = self.operations.lock() else {
                return;
            };
            prune(&mut operations, Instant::now());
            for change in changes.iter_mut().filter(|c| c.operation.is_none()) {
                change.operation = credit(&operations, change);
            }
            // Newest first, so a tree two operations wrote is credited to the later one.
            operations
                .iter()
                .rev()
                .flat_map(|record| {
                    record
                        .expectations
                        .iter()
                        .filter(|(_, e)| *e == Expectation::GitClean)
                        .map(move |(root, _)| (root.clone(), record.id))
                })
                .collect::<Vec<_>>()
        };
        // Git is asked outside the lock: it is a process, and file operations must not wait
        // for it to begin.
        for (root, id) in working_trees {
            credit_git(&root, id, changes);
        }
    }

    #[cfg(test)]
    pub(crate) fn operation_count(&self) -> usize {
        self.operations.lock().map(|o| o.len()).unwrap_or(0)
    }

    #[cfg(test)]
    pub(crate) fn expectation_count(&self) -> usize {
        self.operations
            .lock()
            .map(|o| o.iter().map(|r| r.expectations.len()).sum())
            .unwrap_or(0)
    }

    #[cfg(test)]
    pub(crate) fn kinds(&self) -> Vec<OperationKind> {
        self.operations
            .lock()
            .map(|o| o.iter().map(|r| r.kind).collect())
            .unwrap_or_default()
    }
}

fn prune(operations: &mut VecDeque<Record>, now: Instant) {
    operations.retain(|record| match record.finished {
        Some(finished) => now.duration_since(finished) < COMPLETED_TTL,
        None => now.duration_since(record.started) < STARTED_TTL,
    });
}

/// The operation whose expectations account for `change`, newest operation first. A rename is
/// credited only when both of its ends are, by the same operation.
fn credit(operations: &VecDeque<Record>, change: &ResourceChange) -> Option<u64> {
    // Newest operation first: of two that could account for a change, the later one made it.
    let find = |path: &str, kind: ChangeKind| {
        operations
            .iter()
            .rev()
            .find(|record| record_accounts_for(record, path, kind))
            .map(|record| record.id)
    };
    match &change.from {
        Some(from) => {
            let to = find(&change.path, ChangeKind::Created)?;
            (find(from, ChangeKind::Deleted) == Some(to)).then_some(to)
        }
        None => find(&change.path, change.kind),
    }
}

/// Whether one operation accounts for a change of `kind` at `path`: by one of its
/// expectations, or as the folder an effect of it sits in.
///
/// Adding, removing or renaming an entry changes its folder's own modification time, which
/// Windows reports as a change to the folder. That report is the operation's when the
/// operation changed an entry directly inside that folder and the entry is as it left it.
/// Anything else changed in the folder meanwhile is reported on its own, uncredited.
fn record_accounts_for(record: &Record, path: &str, kind: ChangeKind) -> bool {
    record
        .expectations
        .iter()
        .any(|(at, expectation)| accounts_for(expectation, at, path, kind))
        || (kind == ChangeKind::Modified
            && Path::new(path).is_dir()
            && record.expectations.iter().any(|(at, expectation)| {
                at.rsplit_once('/')
                    .is_some_and(|(parent, _)| parent == path)
                    && *expectation != Expectation::GitClean
                    && accounts_for(expectation, at, at, effect_kind(expectation))
            }))
}

/// The change an expectation's own effect is, for checking it at its own path.
fn effect_kind(expectation: &Expectation) -> ChangeKind {
    match expectation {
        Expectation::Absent => ChangeKind::Deleted,
        _ => ChangeKind::Created,
    }
}

/// Credits to `id` the changes in `root` -- a working tree a Git operation wrote -- that Git
/// reports as exactly what its index holds.
fn credit_git(root: &str, id: u64, changes: &mut [ResourceChange]) {
    let inside = |path: &str| below(path, root).filter(|rest| !rest.is_empty());
    let candidates: Vec<usize> = changes
        .iter()
        .enumerate()
        .filter(|(_, change)| change.operation.is_none())
        .filter(|(_, change)| {
            inside(&change.path).is_some()
                && change
                    .from
                    .as_deref()
                    .is_none_or(|from| inside(from).is_some())
        })
        .map(|(index, _)| index)
        .collect();
    if candidates.is_empty() {
        return;
    }
    let mut relative: Vec<String> = Vec::new();
    for &index in &candidates {
        let change = &changes[index];
        relative.extend(inside(&change.path));
        relative.extend(change.from.as_deref().and_then(inside));
    }
    let Some(dirty) = git_dirty(root, &relative) else {
        return;
    };
    // Dirty if Git lists the path itself, anything below it (a folder with an untracked file
    // in it), or a folder above it (Git lists an ignored or untracked folder once, as a whole).
    let related = |listed: &str, path: &str| {
        listed == path
            || listed
                .strip_prefix(path)
                .is_some_and(|t| t.starts_with('/'))
            || path
                .strip_prefix(listed)
                .is_some_and(|t| t.starts_with('/'))
    };
    let clean = |path: &str| {
        inside(path).is_some_and(|rest| !dirty.iter().any(|listed| related(listed, &rest)))
    };
    for index in candidates {
        let change = &changes[index];
        if clean(&change.path) && change.from.as_deref().is_none_or(clean) {
            changes[index].operation = Some(id);
        }
    }
}

/// Paths per `git status`: keeps each command line far below Windows' 32,767-character limit.
const PATHS_PER_GIT_CHECK: usize = 100;

/// The paths among `relative` (to `root`) that are *not* exactly what Git's index holds --
/// modified, deleted, untracked, ignored, conflicted -- or `None` if Git could not say.
///
/// Read-only and safe to run beside the operation it checks: no optional locks (so never
/// `index.lock`), the repository's fsmonitor hook disabled (it is a command the repository
/// configures), and literal pathspecs after `--`.
fn git_dirty(root: &str, relative: &[String]) -> Option<HashSet<String>> {
    let mut dirty = HashSet::new();
    for chunk in relative.chunks(PATHS_PER_GIT_CHECK) {
        let mut command = Command::new("git");
        command
            .current_dir(root)
            .args([
                "--no-pager",
                "--literal-pathspecs",
                "-c",
                "core.fsmonitor=false",
                "status",
                "--porcelain=v1",
                "-z",
                "--ignored=matching",
                "--untracked-files=all",
                "--no-renames",
                "--",
            ])
            .args(chunk)
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "C");
        let output = capture_within(
            command,
            None,
            Arc::new(AtomicBool::new(false)),
            GIT_CHECK_TIMEOUT,
        )
        .ok()?;
        if output.code != 0 || output.truncated {
            return None;
        }
        dirty.extend(
            output
                .stdout
                .split('\0')
                .filter(|entry| entry.len() > 3)
                .map(|entry| entry[3..].trim_end_matches('/').to_string()),
        );
    }
    Some(dirty)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file_tree::clean_path_str;
    use std::fs;
    use std::path::PathBuf;

    fn temp(label: &str) -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "yavin-operations-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn clean(path: &Path) -> String {
        clean_path_str(path)
    }

    fn change(kind: ChangeKind, path: &Path) -> ResourceChange {
        ResourceChange {
            kind,
            path: clean(path),
            from: None,
            operation: None,
        }
    }

    fn renamed(from: &Path, to: &Path) -> ResourceChange {
        ResourceChange {
            kind: ChangeKind::Renamed,
            path: clean(to),
            from: Some(clean(from)),
            operation: None,
        }
    }

    fn credited(writes: &ExpectedWrites, change: ResourceChange) -> Option<u64> {
        let mut changes = [change];
        writes.attribute(&mut changes);
        changes[0].operation
    }

    #[test]
    fn a_single_operation_is_credited_with_what_it_wrote_and_nothing_else() {
        let dir = temp("single");
        let file = dir.join("a.ts");
        let writes = ExpectedWrites::default();
        let op = writes.begin(OperationKind::Save);
        let id = op.id();
        op.expect(clean(&file), Expectation::content(b"mine"));
        fs::write(&file, "mine").unwrap();
        op.complete();
        assert_eq!(
            credited(&writes, change(ChangeKind::Modified, &file)),
            Some(id)
        );
        assert_eq!(
            credited(&writes, change(ChangeKind::Created, &dir.join("b"))),
            None
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_save_owns_its_temporary_file_and_the_rename_onto_the_target() {
        let dir = temp("save");
        let target = dir.join("a.ts");
        fs::write(&target, "before").unwrap();
        let writes = ExpectedWrites::default();
        let temporary = crate::file_tree::temp_path_for(&target, 42);
        let op = writes.begin(OperationKind::Save);
        let id = op.id();
        op.expect(clean(&temporary), Expectation::transient(b"after"));
        op.expect(clean(&target), Expectation::content(b"after"));
        crate::file_tree::atomic_write_file_via(&target, &temporary, "after").unwrap();
        op.complete();
        // Seen in one batch the temporary file never surfaces; seen across two, each half is
        // this save's: the temporary file created (and already gone), then moved onto the target.
        assert_eq!(
            credited(&writes, change(ChangeKind::Created, &temporary)),
            Some(id)
        );
        assert_eq!(credited(&writes, renamed(&temporary, &target)), Some(id));
        assert_eq!(
            credited(&writes, change(ChangeKind::Created, &target)),
            Some(id)
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_temporary_file_holding_other_bytes_is_not_the_save() {
        let dir = temp("save-other");
        let temporary = dir.join(".a.ts.tmp.1");
        let writes = ExpectedWrites::default();
        let op = writes.begin(OperationKind::Save);
        op.expect(clean(&temporary), Expectation::transient(b"after"));
        fs::write(&temporary, "somebody else").unwrap();
        assert_eq!(
            credited(&writes, change(ChangeKind::Created, &temporary)),
            None
        );
        op.complete();
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_external_write_during_or_after_an_operation_is_never_its() {
        let dir = temp("concurrent");
        let file = dir.join("a.ts");
        let writes = ExpectedWrites::default();
        let op = writes.begin(OperationKind::Save);
        let id = op.id();
        op.expect(clean(&file), Expectation::content(b"yavin"));
        fs::write(&file, "yavin").unwrap();
        // Another program writes while the operation is still running...
        fs::write(&file, "editor").unwrap();
        assert_eq!(credited(&writes, change(ChangeKind::Modified, &file)), None);
        op.complete();
        // ...or just after it, with the same length as Yavin's bytes.
        fs::write(&file, "yaviN").unwrap();
        assert_eq!(credited(&writes, change(ChangeKind::Modified, &file)), None);
        // Yavin's bytes again: indistinguishable from Yavin's own write, so credited.
        fs::write(&file, "yavin").unwrap();
        assert_eq!(
            credited(&writes, change(ChangeKind::Modified, &file)),
            Some(id)
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_create_owns_the_folders_it_made_but_not_what_others_put_in_them() {
        let dir = temp("create");
        let (a, b) = (dir.join("a"), dir.join("a/b"));
        let file = b.join("new.ts");
        let writes = ExpectedWrites::default();
        let op = writes.begin(OperationKind::CreateFile);
        let id = op.id();
        for folder in crate::file_tree::missing_ancestors(&file) {
            op.expect(clean(&folder), Expectation::Directory);
        }
        op.expect(clean(&file), Expectation::content(b""));
        fs::create_dir_all(&b).unwrap();
        fs::write(&file, "").unwrap();
        op.complete();
        assert_eq!(credited(&writes, change(ChangeKind::Created, &a)), Some(id));
        assert_eq!(credited(&writes, change(ChangeKind::Created, &b)), Some(id));
        assert_eq!(
            credited(&writes, change(ChangeKind::Created, &file)),
            Some(id)
        );
        let other = b.join("theirs.ts");
        fs::write(&other, "x").unwrap();
        assert_eq!(credited(&writes, change(ChangeKind::Created, &other)), None);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_copy_owns_what_it_wrote_below_its_destination_and_nothing_different() {
        let dir = temp("copy");
        let source = dir.join("src");
        fs::create_dir_all(source.join("deep")).unwrap();
        fs::write(source.join("a.ts"), "a").unwrap();
        fs::write(source.join("deep/b.ts"), "b").unwrap();
        let destination = dir.join("src_copy");
        let writes = ExpectedWrites::default();
        let op = writes.begin(OperationKind::Copy);
        let id = op.id();
        op.expect(
            clean(&destination),
            Expectation::CopyOf {
                source: clean(&source),
            },
        );
        crate::file_tree::copy_path(&clean(&source), &clean(&destination)).unwrap();
        op.complete();
        for path in [
            destination.clone(),
            destination.join("a.ts"),
            destination.join("deep"),
            destination.join("deep/b.ts"),
        ] {
            assert_eq!(
                credited(&writes, change(ChangeKind::Created, &path)),
                Some(id),
                "{}",
                path.display()
            );
        }
        // Reading the source touched its folders' access times; those reports are the copy's.
        // A file in the source changing is not.
        for folder in [source.clone(), source.join("deep")] {
            assert_eq!(
                credited(&writes, change(ChangeKind::Modified, &folder)),
                Some(id)
            );
        }
        fs::write(source.join("a.ts"), "edited").unwrap();
        assert_eq!(
            credited(&writes, change(ChangeKind::Modified, &source.join("a.ts"))),
            None
        );
        assert_eq!(
            credited(&writes, change(ChangeKind::Deleted, &source.join("deep"))),
            None
        );

        // Something else writing into the copy, or deleting from it, is not the copy.
        fs::write(destination.join("a.ts"), "changed").unwrap();
        assert_eq!(
            credited(
                &writes,
                change(ChangeKind::Modified, &destination.join("a.ts"))
            ),
            None
        );
        fs::write(destination.join("extra.ts"), "x").unwrap();
        assert_eq!(
            credited(
                &writes,
                change(ChangeKind::Created, &destination.join("extra.ts"))
            ),
            None
        );
        fs::remove_file(destination.join("deep/b.ts")).unwrap();
        assert_eq!(
            credited(
                &writes,
                change(ChangeKind::Deleted, &destination.join("deep/b.ts"))
            ),
            None
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_rename_needs_both_ends_and_a_case_only_rename_keeps_its_old_spelling_present() {
        let dir = temp("rename");
        let (old, new) = (dir.join("old.ts"), dir.join("new.ts"));
        fs::write(&old, "x").unwrap();
        let writes = ExpectedWrites::default();
        let op = writes.begin(OperationKind::Rename);
        let id = op.id();
        op.expect(clean(&old), Expectation::Absent);
        op.expect(clean(&new), Expectation::Present);
        fs::rename(&old, &new).unwrap();
        op.complete();
        assert_eq!(credited(&writes, renamed(&old, &new)), Some(id));
        assert_eq!(
            credited(&writes, change(ChangeKind::Deleted, &old)),
            Some(id)
        );
        assert_eq!(
            credited(&writes, change(ChangeKind::Created, &new)),
            Some(id)
        );
        // One end that is not the operation's: not credited.
        let elsewhere = dir.join("elsewhere.ts");
        assert_eq!(credited(&writes, renamed(&elsewhere, &new)), None);

        let (lower, upper) = (dir.join("readme.md"), dir.join("README.md"));
        fs::write(&lower, "x").unwrap();
        let op = writes.begin(OperationKind::Rename);
        let id = op.id();
        op.expect(clean(&lower), Expectation::Present);
        op.expect(clean(&upper), Expectation::Present);
        fs::rename(&lower, &upper).unwrap();
        op.complete();
        assert_eq!(credited(&writes, renamed(&lower, &upper)), Some(id));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_delete_owns_everything_that_went_with_it_and_only_that() {
        let dir = temp("delete");
        let folder = dir.join("gone");
        fs::create_dir_all(folder.join("inner")).unwrap();
        let writes = ExpectedWrites::default();
        let op = writes.begin(OperationKind::Delete);
        let id = op.id();
        op.expect(clean(&folder), Expectation::Absent);
        fs::remove_dir_all(&folder).unwrap();
        op.complete();
        assert_eq!(
            credited(&writes, change(ChangeKind::Deleted, &folder)),
            Some(id)
        );
        assert_eq!(
            credited(&writes, change(ChangeKind::Deleted, &folder.join("inner"))),
            Some(id)
        );
        // A sibling sharing the name's prefix, and something re-created where it was.
        assert_eq!(
            credited(&writes, change(ChangeKind::Deleted, &dir.join("gone2"))),
            None
        );
        fs::create_dir_all(&folder).unwrap();
        assert_eq!(
            credited(&writes, change(ChangeKind::Created, &folder)),
            None
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_newest_operation_wins_only_when_the_disk_satisfies_it() {
        let dir = temp("overlap");
        let file = dir.join("a.ts");
        let writes = ExpectedWrites::default();
        let older = writes.begin(OperationKind::Save);
        let older_id = older.id();
        older.expect(clean(&file), Expectation::content(b"first"));
        fs::write(&file, "first").unwrap();
        older.complete();
        let newer = writes.begin(OperationKind::Save);
        let newer_id = newer.id();
        newer.expect(clean(&file), Expectation::content(b"second"));
        // The newer operation has not written yet: the disk holds the older one's bytes, so
        // the change is the older one's, however recent the newer one is.
        assert_eq!(
            credited(&writes, change(ChangeKind::Modified, &file)),
            Some(older_id)
        );
        fs::write(&file, "second").unwrap();
        newer.complete();
        assert_eq!(
            credited(&writes, change(ChangeKind::Modified, &file)),
            Some(newer_id)
        );
        // Both satisfiable at once (both expect the path gone): the newer one, every time.
        let gone = dir.join("gone");
        let first = writes.begin(OperationKind::Delete);
        first.expect(clean(&gone), Expectation::Absent);
        first.complete();
        let second = writes.begin(OperationKind::Delete);
        let second_id = second.id();
        second.expect(clean(&gone), Expectation::Absent);
        second.complete();
        for _ in 0..10 {
            assert_eq!(
                credited(&writes, change(ChangeKind::Deleted, &gone)),
                Some(second_id)
            );
        }
        // Neither satisfied: nobody's.
        fs::write(&file, "third").unwrap();
        assert_eq!(credited(&writes, change(ChangeKind::Modified, &file)), None);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn temporary_names_never_repeat_even_within_one_clock_tick() {
        let target = Path::new("/w/a.ts");
        let names: HashSet<_> = (0..10_000)
            .map(|_| crate::file_tree::temp_path_for(target, crate::file_tree::temp_nonce()))
            .collect();
        assert_eq!(names.len(), 10_000);
    }

    #[test]
    fn a_folder_reported_changed_is_the_operation_that_changed_an_entry_in_it() {
        let dir = temp("folder");
        let folder = dir.join("sub");
        fs::create_dir_all(&folder).unwrap();
        let file = folder.join("a.ts");
        let writes = ExpectedWrites::default();
        let op = writes.begin(OperationKind::Save);
        let id = op.id();
        op.expect(clean(&file), Expectation::content(b"x"));
        fs::write(&file, "x").unwrap();
        op.complete();
        assert_eq!(
            credited(&writes, change(ChangeKind::Modified, &folder)),
            Some(id)
        );
        // Not the folder above, and not once the entry is no longer what the operation left.
        assert_eq!(credited(&writes, change(ChangeKind::Modified, &dir)), None);
        fs::write(&file, "somebody else").unwrap();
        assert_eq!(
            credited(&writes, change(ChangeKind::Modified, &folder)),
            None
        );
        // A folder is never "created" or "deleted" by this rule, only reported modified.
        fs::write(&file, "x").unwrap();
        assert_eq!(
            credited(&writes, change(ChangeKind::Created, &folder)),
            None
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_failed_or_abandoned_operation_accounts_for_nothing_at_once() {
        let dir = temp("failed");
        let file = dir.join("a.ts");
        let writes = ExpectedWrites::default();
        let op = writes.begin(OperationKind::Save);
        op.expect(clean(&file), Expectation::content(b"x"));
        op.fail();
        fs::write(&file, "x").unwrap();
        assert_eq!(credited(&writes, change(ChangeKind::Created, &file)), None);
        assert_eq!(writes.operation_count(), 0);

        // Dropped without finishing -- an early return, a panic -- is a failure too.
        {
            let op = writes.begin(OperationKind::Save);
            op.expect(clean(&file), Expectation::content(b"x"));
        }
        assert_eq!(writes.operation_count(), 0);
        assert_eq!(credited(&writes, change(ChangeKind::Modified, &file)), None);

        // `finish` follows the result.
        let op = writes.begin(OperationKind::Save);
        op.expect(clean(&file), Expectation::content(b"x"));
        op.finish(&Err::<(), _>("disk full"));
        assert_eq!(writes.operation_count(), 0);
        let op = writes.begin(OperationKind::Save);
        op.finish(&Ok::<_, ()>(()));
        assert_eq!(writes.kinds(), [OperationKind::Save]);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn operations_and_their_expectations_are_bounded() {
        let writes = ExpectedWrites::default();
        for index in 0..MAX_OPERATIONS * 2 {
            let op = writes.begin(OperationKind::Delete);
            op.expect(format!("/w/{index}"), Expectation::Absent);
            op.complete();
        }
        assert_eq!(writes.operation_count(), MAX_OPERATIONS);
        let op = writes.begin(OperationKind::CreateFile);
        for index in 0..MAX_EXPECTATIONS_PER_OPERATION * 2 {
            op.expect(format!("/w/deep/{index}"), Expectation::Directory);
        }
        let held = writes.expectation_count();
        assert!(
            held <= MAX_OPERATIONS * MAX_EXPECTATIONS_PER_OPERATION,
            "{held}"
        );
        op.complete();
        // Evicting keeps the operation still running over completed ones.
        let running = writes.begin(OperationKind::Git);
        let running_id = running.id();
        for _ in 0..MAX_OPERATIONS {
            writes.begin(OperationKind::Delete).complete();
        }
        let ids: Vec<u64> = writes
            .operations
            .lock()
            .unwrap()
            .iter()
            .map(|r| r.id)
            .collect();
        assert!(ids.contains(&running_id));
        running.complete();
    }

    #[test]
    fn completed_operations_expire_and_started_ones_last_their_run() {
        let now = Instant::now();
        let record = |finished: Option<Instant>, started: Instant| Record {
            id: 1,
            kind: OperationKind::Save,
            state: OperationState::Completed,
            expectations: vec![],
            started,
            finished,
        };
        let long_ago = now - COMPLETED_TTL - Duration::from_millis(1);
        let mut operations: VecDeque<Record> = [
            record(Some(long_ago), long_ago),
            record(Some(now), now),
            record(None, now - Duration::from_secs(60)),
            record(None, now - STARTED_TTL - Duration::from_secs(1)),
        ]
        .into();
        prune(&mut operations, now);
        assert_eq!(
            operations.len(),
            2,
            "the recently completed and the still-running one"
        );
    }

    // --- Git ---------------------------------------------------------------------------------

    fn git(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .current_dir(dir)
            .args(args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .unwrap();
        assert!(status.status.success(), "git {args:?}: {status:?}");
    }

    fn repository(label: &str) -> PathBuf {
        let dir = temp(label);
        git(&dir, &["init", "-q", "-b", "main"]);
        git(&dir, &["config", "user.email", "t@example.com"]);
        git(&dir, &["config", "user.name", "Tester"]);
        git(&dir, &["config", "core.autocrlf", "false"]);
        fs::write(dir.join("a.txt"), "main\n").unwrap();
        fs::write(dir.join(".gitignore"), "out/\n").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-qm", "main"]);
        git(&dir, &["switch", "-qc", "other"]);
        fs::write(dir.join("a.txt"), "other\n").unwrap();
        fs::create_dir_all(dir.join("added")).unwrap();
        fs::write(dir.join("added/b.txt"), "b\n").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-qm", "other"]);
        git(&dir, &["switch", "-q", "main"]);
        dir
    }

    #[test]
    fn what_a_git_operation_checked_out_is_its_and_what_else_changed_is_not() {
        let dir = repository("git");
        let root = clean(&dir);
        let writes = ExpectedWrites::default();
        let op = writes.begin(OperationKind::Git);
        let id = op.id();
        op.expect(root.clone(), Expectation::GitClean);
        git(&dir, &["switch", "-q", "other"]);
        // Meanwhile another program writes a tracked file, an untracked one and an ignored one.
        fs::write(dir.join("stray.txt"), "untracked\n").unwrap();
        fs::create_dir_all(dir.join("out")).unwrap();
        fs::write(dir.join("out/build.o"), "ignored\n").unwrap();
        op.complete();

        let mut changes = vec![
            change(ChangeKind::Modified, &dir.join("a.txt")),
            change(ChangeKind::Created, &dir.join("added")),
            change(ChangeKind::Created, &dir.join("added/b.txt")),
            change(ChangeKind::Created, &dir.join("stray.txt")),
            change(ChangeKind::Created, &dir.join("out/build.o")),
        ];
        writes.attribute(&mut changes);
        let credits: Vec<_> = changes.iter().map(|c| c.operation).collect();
        assert_eq!(
            credits,
            [Some(id), Some(id), Some(id), None, None],
            "{changes:?}"
        );

        // A tracked file another program changes after the switch is not Git's either.
        fs::write(dir.join("a.txt"), "edited elsewhere\n").unwrap();
        let mut changes = vec![change(ChangeKind::Modified, &dir.join("a.txt"))];
        writes.attribute(&mut changes);
        assert_eq!(changes[0].operation, None);

        // Switching back deletes what only `other` had: those deletions are Git's.
        fs::write(dir.join("a.txt"), "other\n").unwrap();
        let op = writes.begin(OperationKind::Git);
        let id = op.id();
        op.expect(root.clone(), Expectation::GitClean);
        git(&dir, &["switch", "-q", "main"]);
        op.complete();
        let mut changes = vec![
            change(ChangeKind::Deleted, &dir.join("added/b.txt")),
            change(ChangeKind::Modified, &dir.join("a.txt")),
        ];
        writes.attribute(&mut changes);
        assert_eq!(changes[0].operation, Some(id));
        assert_eq!(changes[1].operation, Some(id));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn without_a_git_operation_nothing_is_checked_against_the_index() {
        let dir = repository("git-none");
        let writes = ExpectedWrites::default();
        // An operation in another tree does not reach this one.
        let op = writes.begin(OperationKind::Git);
        op.expect(clean(&dir.join("added")), Expectation::GitClean);
        op.complete();
        let mut changes = vec![change(ChangeKind::Modified, &dir.join("a.txt"))];
        writes.attribute(&mut changes);
        assert_eq!(changes[0].operation, None);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_git_check_that_cannot_run_credits_nothing() {
        let dir = temp("not-a-repository");
        fs::write(dir.join("a.txt"), "x").unwrap();
        let writes = ExpectedWrites::default();
        let op = writes.begin(OperationKind::Git);
        op.expect(clean(&dir), Expectation::GitClean);
        op.complete();
        let mut changes = vec![change(ChangeKind::Modified, &dir.join("a.txt"))];
        writes.attribute(&mut changes);
        assert_eq!(changes[0].operation, None);
        fs::remove_dir_all(&dir).ok();
    }
}
