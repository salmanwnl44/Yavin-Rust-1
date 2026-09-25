//! The workspace's filesystem event source: operating-system notifications in, typed resource
//! changes out.
//!
//! ```text
//! notify (ReadDirectoryChangesW / inotify / FSEvents)
//!   -> normalize   one OS event -> Raw operations on cleaned paths; `.git` internals dropped
//!   -> pair        a rename's old-name/new-name notifications -> one Renamed
//!   -> coalesce    a burst -> at most one change per resource, in order; bounded, with overflow
//!                  collapsing into a scoped rescan
//!   -> attribute   a change whose resulting disk state is what a Yavin operation said it would
//!                  leave carries that operation's id (see `operations`)
//!   -> batch       emitted with the watcher's generation, only while that generation is live
//! ```
//!
//! This reports what happened to the filesystem and nothing else. Whether a change matters --
//! to the explorer, to Git, to an open document -- is each consumer's decision, which is why
//! nothing but Git's own internals is filtered here: `build/`, `dist/`, `node_modules/` and the
//! rest are ordinary folders as far as the filesystem is concerned, and a folder of that name
//! can hold hand-written source. It lives on the native side, as an exception to TypeScript
//! owning behavior, because it has to sit next to the event source: a burst of thousands of
//! raw events cannot be shipped over IPC just to be merged there, a rename's two halves are only
//! recognisable as adjacent notifications, and Yavin's writes happen in native commands that
//! must register what they expect before they touch the disk.
//!
//! Paths are cleaned with `clean_path_str` -- the form the rest of the UI already receives
//! (`/` separators, no extended-length prefix) -- and are otherwise exactly what the OS reported
//! under the watched root. Identity comparison beyond that (case, containment) is the UI's
//! `resource.ts`; nothing here normalises paths a third way.

use crate::file_tree::clean_path_str;
pub use crate::operations::{Expectation, ExpectedWrites, Operation, OperationKind};
use notify::event::{EventKind, ModifyKind, RenameMode};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Component, Path};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Quiet period that ends a burst. The value the workspace watcher has used in production:
/// long enough that a save, a checkout or a formatter pass arrives as one batch, short enough
/// that an external edit shows up in the explorer without a noticeable wait.
pub const SETTLE: Duration = Duration::from_millis(300);
/// The longest a batch is held, however busy the filesystem stays. Without it a build that
/// never pauses for `SETTLE` would never be reported at all.
pub const MAX_BATCH_LATENCY: Duration = Duration::from_millis(1000);
/// Changes one batch may hold before it stops tracking them individually and reports a rescan
/// of their common folder instead. Past this point per-file detail is worth less than bounded
/// memory, and every consumer can reconcile a folder from a listing.
pub const MAX_PENDING_CHANGES: usize = 4096;
/// Distinct rescan scopes one batch may carry before they collapse into the root.
const MAX_RESCAN_SCOPES: usize = 16;

// ---------------------------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------------------------

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    Created,
    Modified,
    Deleted,
    Renamed,
}

/// One resource that changed. `path` is the resource as it is now (the new name, for a rename);
/// `from` is set only for a rename. `operation` is set when the change is the result of a Yavin
/// operation (see `operations`) and absent for anything else -- another program, Git, or a
/// change nothing can vouch for.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResourceChange {
    pub kind: ChangeKind,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation: Option<u64>,
}

impl ResourceChange {
    fn new(kind: ChangeKind, path: String) -> Self {
        Self {
            kind,
            path,
            from: None,
            operation: None,
        }
    }
    fn renamed(from: String, to: String) -> Self {
        Self {
            kind: ChangeKind::Renamed,
            path: to,
            from: Some(from),
            operation: None,
        }
    }
}

/// One settled burst. `rescan` lists folders whose individual changes were not all observed --
/// the OS dropped notifications, the batch overflowed, or the watch failed -- and which a
/// consumer that keeps state about them must re-read rather than trust `changes` alone.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResourceChangeBatch {
    pub generation: u64,
    pub root: String,
    pub changes: Vec<ResourceChange>,
    pub rescan: Vec<String>,
}

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WatcherState {
    /// Changes under the root are being reported.
    Watching,
    /// They are not, or not all of them: the watch stopped or could not be kept up. The
    /// explorer's manual refresh is the fallback until the folder is opened again.
    Failed,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WatcherStatus {
    pub generation: u64,
    pub root: String,
    pub state: WatcherState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WatchOutput {
    Changes(ResourceChangeBatch),
    Status(WatcherStatus),
}

// ---------------------------------------------------------------------------------------------
// Normalize: one notify event -> operations on cleaned paths
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
enum Raw {
    Created(String),
    Modified(String),
    Removed(String),
    RenameFrom(String, Option<usize>),
    RenameTo(String, Option<usize>),
    Renamed(String, String),
    /// Notifications were lost below this folder (`None`: anywhere under the root).
    Rescan(Option<String>),
    /// The watch reported an error; it may no longer be active.
    Failure(String),
    /// The watched root itself is gone.
    RootRemoved,
}

/// Whether `path` is inside a `.git` directory under `root`. Git's own machinery changes on
/// every Git command, Yavin's included; the Git watcher (`watcher::start_git_watcher`) follows
/// the few parts of it that matter. This is the one thing the workspace stream leaves out.
fn is_git_internal(path: &Path, root: &Path) -> bool {
    let inside = path.strip_prefix(root).unwrap_or(path);
    inside
        .components()
        .any(|component| matches!(component, Component::Normal(name) if name == ".git"))
}

fn normalize(result: notify::Result<notify::Event>, root: &Path) -> Vec<Raw> {
    let event = match result {
        Ok(event) => event,
        Err(error) => return vec![Raw::Failure(error.to_string())],
    };
    if event.need_rescan() {
        let scope = event
            .paths
            .first()
            .filter(|path| !is_git_internal(path, root))
            .map(clean_path_str);
        return vec![Raw::Rescan(scope)];
    }
    let tracker = event.tracker();
    let paths: Vec<&Path> = event
        .paths
        .iter()
        .map(|path| path.as_path())
        .filter(|path| !is_git_internal(path, root))
        .collect();
    let clean = |path: &Path| clean_path_str(path);
    match event.kind {
        EventKind::Create(_) => paths.iter().map(|p| Raw::Created(clean(p))).collect(),
        EventKind::Remove(_) => paths
            .iter()
            .map(|p| {
                if *p == root {
                    Raw::RootRemoved
                } else {
                    Raw::Removed(clean(p))
                }
            })
            .collect(),
        EventKind::Modify(ModifyKind::Name(RenameMode::From)) => paths
            .iter()
            .map(|p| Raw::RenameFrom(clean(p), tracker))
            .collect(),
        EventKind::Modify(ModifyKind::Name(RenameMode::To)) => paths
            .iter()
            .map(|p| Raw::RenameTo(clean(p), tracker))
            .collect(),
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)) if paths.len() == 2 => {
            vec![Raw::Renamed(clean(paths[0]), clean(paths[1]))]
        }
        // Reads, opens and closes change nothing.
        EventKind::Access(_) => vec![],
        // Everything else -- content, metadata, a rename whose direction the backend cannot
        // tell (FSEvents), or a kind it cannot classify -- is reported as a modification. A
        // consumer that re-reads the path learns whether it still exists; nothing is lost.
        _ => paths.iter().map(|p| Raw::Modified(clean(p))).collect(),
    }
}

// ---------------------------------------------------------------------------------------------
// Pair + coalesce: a burst of operations -> ordered, de-duplicated changes
// ---------------------------------------------------------------------------------------------

/// Everything observed in one burst, reduced as it arrives.
///
/// Rename pairing: a backend reports a rename as its old name then its new name. On Windows
/// the two are consecutive records of one `ReadDirectoryChangesW` completion; on Linux they
/// carry the same inotify cookie. So a pending old name pairs only with the new name that
/// immediately follows it (and, where the backend supplies one, has the same tracker). Anything
/// else arriving first means it will not be paired: the old name is reported as deleted and the
/// new name, when it comes, as created -- never a guessed rename between unrelated files. At
/// most one old name is ever pending, and none survives the end of the batch. A move between
/// folders arrives on Windows as a removal and a creation and is reported as exactly that.
///
/// Coalescing: at most one live change per path, in the order the paths first changed, by
/// these rules (`x` is the change already held for the path):
///
/// | then       | x = none   | Created      | Modified     | Deleted    | Renamed(a -> p)     |
/// |------------|------------|--------------|--------------|------------|---------------------|
/// | created p  | Created    | --           | --           | Modified   | --                  |
/// | modified p | Modified   | --           | --           | Modified   | + Modified after it |
/// | deleted p  | Deleted    | cancelled    | Deleted      | --         | Deleted(a)          |
///
/// A rename `p -> q` of a path created in this batch is a creation of `q` (an atomic save: a
/// temporary file written and moved into place); of a path renamed from `a` in this batch it is
/// `a -> q` (or nothing, when `q` is `a` again); of a modified path it is the rename followed
/// by a modification of `q`. Ordering is the order changes are held in, never a map's.
#[derive(Debug, Default)]
struct Burst {
    changes: Vec<Option<ResourceChange>>,
    /// The index of the live change describing each path.
    current: HashMap<String, usize>,
    /// Renames whose new name was also written to afterwards: reported as the rename followed
    /// by a modification, but held as one entry so a later delete or rename of the path
    /// carries both.
    modified_after: std::collections::HashSet<usize>,
    live: usize,
    pending_from: Option<(String, Option<usize>)>,
    /// Set once the burst has overflowed: from then on only the folder that covers everything
    /// seen is tracked, and the batch reports a rescan of it instead of individual changes.
    overflow: Option<String>,
    rescan: Vec<String>,
    failures: Vec<String>,
    root_removed: bool,
    root: String,
}

impl Burst {
    fn new(root: String) -> Self {
        Self {
            root,
            ..Self::default()
        }
    }

    fn push(&mut self, raw: Raw) {
        // A pending old name pairs only with the very next notification.
        if let Some((from, from_tracker)) = self.pending_from.take() {
            match &raw {
                Raw::RenameTo(to, tracker)
                    if from_tracker.is_none() || tracker.is_none() || from_tracker == *tracker =>
                {
                    let to = to.clone();
                    self.renamed(from, to);
                    return;
                }
                _ => self.deleted(from),
            }
        }
        match raw {
            Raw::Created(path) => self.created(path),
            Raw::Modified(path) => self.modified(path),
            Raw::Removed(path) => self.deleted(path),
            Raw::RenameFrom(path, tracker) => self.pending_from = Some((path, tracker)),
            Raw::RenameTo(path, _) => self.created(path),
            Raw::Renamed(from, to) => self.renamed(from, to),
            Raw::Rescan(scope) => {
                let scope = scope.unwrap_or_else(|| self.root.clone());
                self.add_rescan(scope);
            }
            Raw::Failure(message) => {
                self.failures.push(message);
                let root = self.root.clone();
                self.add_rescan(root);
            }
            Raw::RootRemoved => {
                self.root_removed = true;
                let root = self.root.clone();
                self.add_rescan(root);
            }
        }
    }

    fn add_rescan(&mut self, scope: String) {
        if self
            .rescan
            .iter()
            .any(|held| is_same_or_inside(&scope, held))
        {
            return;
        }
        self.rescan.retain(|held| !is_same_or_inside(held, &scope));
        self.rescan.push(scope);
        if self.rescan.len() > MAX_RESCAN_SCOPES {
            self.rescan = vec![self.root.clone()];
        }
    }

    /// Records that `paths` changed once the batch is over its bound: only their common folder
    /// is kept.
    fn widen_overflow(&mut self, paths: &[&str]) -> bool {
        let Some(scope) = self.overflow.take() else {
            return false;
        };
        let widened = paths
            .iter()
            .fold(scope, |scope, path| common_folder(&scope, path, &self.root));
        self.overflow = Some(widened);
        true
    }

    fn hold(&mut self, change: ResourceChange) {
        let path = change.path.clone();
        self.changes.push(Some(change));
        self.current.insert(path, self.changes.len() - 1);
        self.live += 1;
        if self.live > MAX_PENDING_CHANGES {
            self.overflow_now();
        }
    }

    fn overflow_now(&mut self) {
        self.modified_after.clear();
        let mut scope: Option<String> = None;
        for change in self.changes.drain(..).flatten() {
            for path in std::iter::once(change.path.as_str()).chain(change.from.as_deref()) {
                scope = Some(match scope {
                    Some(scope) => common_folder(&scope, path, &self.root),
                    None => parent_folder(path, &self.root),
                });
            }
        }
        self.current.clear();
        self.live = 0;
        self.overflow = Some(scope.unwrap_or_else(|| self.root.clone()));
    }

    fn kind_of(&self, path: &str) -> Option<(usize, ChangeKind)> {
        let index = *self.current.get(path)?;
        let change = self.changes[index].as_ref()?;
        Some((index, change.kind))
    }

    fn drop_change(&mut self, index: usize) {
        self.modified_after.remove(&index);
        if let Some(change) = self.changes[index].take() {
            if self.current.get(&change.path) == Some(&index) {
                self.current.remove(&change.path);
            }
            self.live -= 1;
        }
    }

    fn replace(&mut self, index: usize, change: ResourceChange) {
        if let Some(old) = &self.changes[index] {
            if self.current.get(&old.path) == Some(&index) {
                self.current.remove(&old.path);
            }
        }
        self.current.insert(change.path.clone(), index);
        self.changes[index] = Some(change);
    }

    fn created(&mut self, path: String) {
        if self.widen_overflow(&[&path]) {
            return;
        }
        match self.kind_of(&path) {
            None => self.hold(ResourceChange::new(ChangeKind::Created, path)),
            Some((index, ChangeKind::Deleted)) => {
                self.replace(index, ResourceChange::new(ChangeKind::Modified, path))
            }
            Some(_) => {}
        }
    }

    fn modified(&mut self, path: String) {
        if self.widen_overflow(&[&path]) {
            return;
        }
        match self.kind_of(&path) {
            None => self.hold(ResourceChange::new(ChangeKind::Modified, path)),
            Some((index, ChangeKind::Deleted)) => {
                self.replace(index, ResourceChange::new(ChangeKind::Modified, path))
            }
            Some((index, ChangeKind::Renamed)) => {
                // Reported after the rename, so a consumer applies them in that order.
                self.modified_after.insert(index);
            }
            Some(_) => {}
        }
    }

    fn deleted(&mut self, path: String) {
        if self.widen_overflow(&[&path]) {
            return;
        }
        match self.kind_of(&path) {
            None => self.hold(ResourceChange::new(ChangeKind::Deleted, path)),
            Some((index, ChangeKind::Created)) => self.drop_change(index),
            Some((index, ChangeKind::Modified)) => {
                self.replace(index, ResourceChange::new(ChangeKind::Deleted, path))
            }
            Some((_, ChangeKind::Deleted)) => {}
            Some((index, ChangeKind::Renamed)) => {
                let from = self.changes[index]
                    .as_ref()
                    .and_then(|change| change.from.clone())
                    .unwrap_or_default();
                self.drop_change(index);
                self.deleted(from);
            }
        }
    }

    fn renamed(&mut self, from: String, to: String) {
        if self.widen_overflow(&[&from, &to]) {
            return;
        }
        // A "rename" onto the same name moves nothing (a case-only rename is a different name).
        if from == to {
            self.modified(to);
            return;
        }
        // Whatever was held for the destination is superseded: the rename put something else
        // there, and the rename is what a consumer needs to know about that path now.
        if let Some((index, _)) = self.kind_of(&to) {
            self.drop_change(index);
        }
        match self.kind_of(&from) {
            Some((index, ChangeKind::Created)) => {
                self.drop_change(index);
                self.created(to);
            }
            Some((index, ChangeKind::Renamed)) => {
                let origin = self.changes[index]
                    .as_ref()
                    .and_then(|change| change.from.clone())
                    .unwrap_or_default();
                let written = self.modified_after.contains(&index);
                self.drop_change(index);
                if origin == to {
                    // Renamed away and back: nothing moved, though the content may have
                    // changed while it was away.
                    self.modified(to);
                } else {
                    self.renamed(origin, to.clone());
                    if written {
                        self.modified(to);
                    }
                }
            }
            Some((index, ChangeKind::Modified)) => {
                self.drop_change(index);
                self.hold(ResourceChange::renamed(from, to.clone()));
                self.modified(to);
            }
            _ => self.hold(ResourceChange::renamed(from, to)),
        }
    }

    /// Ends the burst: an unpaired old name is a deletion, and what remains is the batch.
    fn finish(mut self) -> (Vec<ResourceChange>, Vec<String>, Vec<String>, bool) {
        if let Some((from, _)) = self.pending_from.take() {
            self.deleted(from);
        }
        if let Some(scope) = self.overflow.take() {
            self.add_rescan(scope);
        }
        let mut changes = Vec::with_capacity(self.live + self.modified_after.len());
        for (index, change) in self.changes.into_iter().enumerate() {
            let Some(change) = change else { continue };
            let written = self
                .modified_after
                .contains(&index)
                .then(|| change.path.clone());
            changes.push(change);
            if let Some(path) = written {
                changes.push(ResourceChange::new(ChangeKind::Modified, path));
            }
        }
        (changes, self.rescan, self.failures, self.root_removed)
    }
}

/// Whether `path` is `folder` or inside it, per segment. Both are cleaned paths from the same
/// watch, so they share one spelling and an exact segment comparison is the right one.
fn is_same_or_inside(path: &str, folder: &str) -> bool {
    path == folder
        || path
            .strip_prefix(folder)
            .is_some_and(|rest| rest.starts_with('/') || folder.ends_with('/'))
}

fn parent_folder(path: &str, root: &str) -> String {
    match path.rfind('/') {
        Some(cut) if is_same_or_inside(&path[..cut], root) && cut > 0 => path[..cut].to_string(),
        _ => root.to_string(),
    }
}

/// The deepest folder containing both `folder` and `path`, never above `root`.
fn common_folder(folder: &str, path: &str, root: &str) -> String {
    let mut common = folder.to_string();
    while !is_same_or_inside(path, &common) {
        let parent = parent_folder(&common, root);
        if parent == common {
            return root.to_string();
        }
        common = parent;
    }
    if is_same_or_inside(&common, root) {
        common
    } else {
        root.to_string()
    }
}

// ---------------------------------------------------------------------------------------------
// The watcher: one generation per watch, emitting only while it is live
// ---------------------------------------------------------------------------------------------

/// Increases for every watch started in this process. Each batch and status carries the
/// generation that produced it, so a consumer can tell a late event from a previous watch.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// A live watch. Dropping it ends the watch: its generation stops emitting -- checked under
/// the same lock every emission takes, so nothing from it can be delivered afterwards -- and
/// the OS watch and its thread are released, discarding any burst still being collected.
pub struct ResourceWatch {
    generation: u64,
    live: Arc<Mutex<bool>>,
    _watcher: RecommendedWatcher,
}

impl ResourceWatch {
    pub fn generation(&self) -> u64 {
        self.generation
    }
}

impl Drop for ResourceWatch {
    fn drop(&mut self) {
        match self.live.lock() {
            Ok(mut live) => *live = false,
            Err(poisoned) => *poisoned.into_inner() = false,
        }
    }
}

fn emit_if_live(live: &Mutex<bool>, emit: &dyn Fn(WatchOutput), output: WatchOutput) {
    if let Ok(live) = live.lock() {
        if *live {
            emit(output);
        }
    }
}

/// Watches `root` recursively and reports typed batches through `emit`, starting with a
/// `Watching` status. `root` should be the canonical root the workspace was opened with.
pub fn start_resource_watcher<F>(
    root: &Path,
    expected: Arc<ExpectedWrites>,
    emit: F,
) -> Result<ResourceWatch, String>
where
    F: Fn(WatchOutput) + Send + 'static,
{
    if !root.is_dir() {
        return Err(format!("Cannot watch {}: not a directory", root.display()));
    }
    let generation = GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
    let root_clean = clean_path_str(root);
    let (sender, receiver) = channel();
    let mut watcher = notify::recommended_watcher(sender).map_err(|e| e.to_string())?;
    watcher
        .watch(root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    let live = Arc::new(Mutex::new(true));
    emit_if_live(
        &live,
        &emit,
        WatchOutput::Status(WatcherStatus {
            generation,
            root: root_clean.clone(),
            state: WatcherState::Watching,
            message: None,
        }),
    );

    let thread_live = Arc::clone(&live);
    let root = root.to_path_buf();
    std::thread::spawn(move || {
        let status = |state, message: Option<String>| {
            WatchOutput::Status(WatcherStatus {
                generation,
                root: root_clean.clone(),
                state,
                message,
            })
        };
        while let Ok(first) = receiver.recv() {
            let mut burst = Burst::new(root_clean.clone());
            for raw in normalize(first, &root) {
                burst.push(raw);
            }
            let started = Instant::now();
            loop {
                let left = MAX_BATCH_LATENCY.saturating_sub(started.elapsed());
                if left.is_zero() {
                    break;
                }
                match receiver.recv_timeout(SETTLE.min(left)) {
                    Ok(next) => {
                        for raw in normalize(next, &root) {
                            burst.push(raw);
                        }
                    }
                    Err(RecvTimeoutError::Timeout) => break,
                    // The watch was dropped: the workspace closed, and so does this burst.
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
            let (mut changes, rescan, failures, root_removed) = burst.finish();
            expected.attribute(&mut changes);
            if !changes.is_empty() || !rescan.is_empty() {
                emit_if_live(
                    &thread_live,
                    &emit,
                    WatchOutput::Changes(ResourceChangeBatch {
                        generation,
                        root: root_clean.clone(),
                        changes,
                        rescan,
                    }),
                );
            }
            if root_removed {
                eprintln!("Watched folder was removed: {root_clean}");
                emit_if_live(
                    &thread_live,
                    &emit,
                    status(
                        WatcherState::Failed,
                        Some("The watched folder was removed.".into()),
                    ),
                );
            } else if let Some(message) = failures.last() {
                eprintln!("Watching {root_clean} failed: {message}");
                emit_if_live(
                    &thread_live,
                    &emit,
                    status(WatcherState::Failed, Some(message.clone())),
                );
            }
        }
    });

    Ok(ResourceWatch {
        generation,
        live,
        _watcher: watcher,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, Flag, RemoveKind};
    use std::fs;
    use std::path::PathBuf;

    const ROOT: &str = "/w";

    /// A change as the tests compare it: kind, path, and the old path of a rename.
    type Summary = (ChangeKind, String, Option<String>);

    fn run(raws: Vec<Raw>) -> (Vec<Summary>, Vec<String>) {
        let mut burst = Burst::new(ROOT.into());
        for raw in raws {
            burst.push(raw);
        }
        let (changes, rescan, _, _) = burst.finish();
        let changes = changes
            .into_iter()
            .map(|change| (change.kind, change.path, change.from))
            .collect();
        (changes, rescan)
    }

    fn p(path: &str) -> String {
        format!("{ROOT}/{path}")
    }
    fn created(path: &str) -> Raw {
        Raw::Created(p(path))
    }
    fn modified(path: &str) -> Raw {
        Raw::Modified(p(path))
    }
    fn removed(path: &str) -> Raw {
        Raw::Removed(p(path))
    }
    fn from(path: &str) -> Raw {
        Raw::RenameFrom(p(path), None)
    }
    fn to(path: &str) -> Raw {
        Raw::RenameTo(p(path), None)
    }
    fn change(kind: ChangeKind, path: &str) -> Summary {
        (kind, p(path), None)
    }
    fn renamed(old: &str, new: &str) -> Summary {
        (ChangeKind::Renamed, p(new), Some(p(old)))
    }

    #[test]
    fn a_creation_followed_by_writes_is_one_creation() {
        let (changes, _) = run(vec![created("a"), modified("a"), modified("a")]);
        assert_eq!(changes, [change(ChangeKind::Created, "a")]);
    }

    #[test]
    fn repeated_writes_are_one_modification() {
        let (changes, _) = run(vec![modified("a"); 50]);
        assert_eq!(changes, [change(ChangeKind::Modified, "a")]);
    }

    #[test]
    fn a_file_created_and_deleted_in_one_burst_never_existed() {
        let (changes, _) = run(vec![created("a"), modified("a"), removed("a")]);
        assert!(changes.is_empty());
    }

    #[test]
    fn deleted_and_recreated_is_modified_and_modified_then_deleted_is_deleted() {
        let (changes, _) = run(vec![
            removed("a"),
            created("a"),
            modified("b"),
            removed("b"),
        ]);
        assert_eq!(
            changes,
            [
                change(ChangeKind::Modified, "a"),
                change(ChangeKind::Deleted, "b")
            ]
        );
    }

    #[test]
    fn an_old_name_followed_by_its_new_name_is_one_rename() {
        let (changes, _) = run(vec![from("a"), to("b")]);
        assert_eq!(changes, [renamed("a", "b")]);
        // A case-only rename is a rename, not a no-op: the names are different.
        let (changes, _) = run(vec![from("readme.md"), to("README.md")]);
        assert_eq!(changes, [renamed("readme.md", "README.md")]);
    }

    #[test]
    fn a_rename_that_cannot_be_paired_is_a_deletion_and_a_creation() {
        // Something else arrives between the halves: never guess that they belong together.
        let (changes, _) = run(vec![from("a"), created("c"), to("b")]);
        assert_eq!(
            changes,
            [
                change(ChangeKind::Deleted, "a"),
                change(ChangeKind::Created, "c"),
                change(ChangeKind::Created, "b"),
            ]
        );
        // An old name still waiting when the burst ends.
        let (changes, _) = run(vec![modified("x"), from("a")]);
        assert_eq!(
            changes,
            [
                change(ChangeKind::Modified, "x"),
                change(ChangeKind::Deleted, "a")
            ]
        );
        // A new name with no old name before it.
        let (changes, _) = run(vec![to("b")]);
        assert_eq!(changes, [change(ChangeKind::Created, "b")]);
    }

    #[test]
    fn halves_with_different_trackers_are_not_paired() {
        let (changes, _) = run(vec![
            Raw::RenameFrom(p("a"), Some(1)),
            Raw::RenameTo(p("b"), Some(2)),
        ]);
        assert_eq!(
            changes,
            [
                change(ChangeKind::Deleted, "a"),
                change(ChangeKind::Created, "b")
            ]
        );
        let (changes, _) = run(vec![
            Raw::RenameFrom(p("a"), Some(7)),
            Raw::RenameTo(p("b"), Some(7)),
        ]);
        assert_eq!(changes, [renamed("a", "b")]);
    }

    #[test]
    fn an_atomic_save_is_a_change_to_the_target_and_the_temporary_file_never_surfaces() {
        let (changes, _) = run(vec![
            created(".a.ts.tmp.1"),
            modified(".a.ts.tmp.1"),
            from(".a.ts.tmp.1"),
            to("a.ts"),
        ]);
        assert_eq!(changes, [change(ChangeKind::Created, "a.ts")]);
    }

    #[test]
    fn a_rename_and_a_write_keep_their_order_either_way_round() {
        let (changes, _) = run(vec![from("a"), to("b"), modified("b")]);
        assert_eq!(
            changes,
            [renamed("a", "b"), change(ChangeKind::Modified, "b")]
        );
        let (changes, _) = run(vec![modified("a"), from("a"), to("b")]);
        assert_eq!(
            changes,
            [renamed("a", "b"), change(ChangeKind::Modified, "b")]
        );
    }

    #[test]
    fn chained_renames_collapse_and_renaming_back_is_only_a_possible_modification() {
        let (changes, _) = run(vec![from("a"), to("b"), from("b"), to("c")]);
        assert_eq!(changes, [renamed("a", "c")]);
        let (changes, _) = run(vec![from("a"), to("b"), from("b"), to("a")]);
        assert_eq!(changes, [change(ChangeKind::Modified, "a")]);
        let (changes, _) = run(vec![from("a"), to("b"), removed("b")]);
        assert_eq!(changes, [change(ChangeKind::Deleted, "a")]);
    }

    #[test]
    fn a_directory_rename_is_one_change_not_one_per_child() {
        let (changes, _) = run(vec![from("src/components"), to("src/ui")]);
        assert_eq!(changes, [renamed("src/components", "src/ui")]);
    }

    #[test]
    fn a_burst_past_its_bound_becomes_a_rescan_of_the_folder_it_touched() {
        let mut burst = Burst::new(ROOT.into());
        for index in 0..MAX_PENDING_CHANGES + 100 {
            burst.push(created(&format!("target/debug/deps/f{index}.o")));
            assert!(burst.live <= MAX_PENDING_CHANGES, "memory stays bounded");
        }
        burst.push(modified("target/debug/build/x"));
        let (changes, rescan, _, _) = burst.finish();
        assert!(
            changes.is_empty(),
            "individual changes are dropped once over the bound"
        );
        assert_eq!(rescan, [p("target/debug")]);

        // Spread across the workspace, the common folder is the root.
        let mut burst = Burst::new(ROOT.into());
        for index in 0..MAX_PENDING_CHANGES + 1 {
            burst.push(created(&format!("a{}/f{index}", index % 2)));
        }
        let (_, rescan, _, _) = burst.finish();
        assert_eq!(rescan, [ROOT.to_string()]);
    }

    #[test]
    fn rescans_are_scoped_merged_and_bounded() {
        let (_, rescan) = run(vec![
            Raw::Rescan(Some(p("a/b"))),
            Raw::Rescan(Some(p("a"))),
            Raw::Rescan(Some(p("a/c"))),
            Raw::Rescan(Some(p("z"))),
        ]);
        assert_eq!(rescan, [p("a"), p("z")]);
        let (_, rescan) = run(vec![Raw::Rescan(None)]);
        assert_eq!(rescan, [ROOT.to_string()]);
        let many = (0..MAX_RESCAN_SCOPES + 1)
            .map(|index| Raw::Rescan(Some(p(&format!("d{index}")))))
            .collect();
        let (_, rescan) = run(many);
        assert_eq!(rescan, [ROOT.to_string()]);
    }

    #[test]
    fn a_failure_or_a_removed_root_asks_for_a_rescan_of_everything() {
        let mut burst = Burst::new(ROOT.into());
        burst.push(Raw::Failure("boom".into()));
        let (_, rescan, failures, removed) = burst.finish();
        assert_eq!(
            (rescan, failures, removed),
            (vec![ROOT.into()], vec!["boom".into()], false)
        );
        let mut burst = Burst::new(ROOT.into());
        burst.push(Raw::RootRemoved);
        let (_, rescan, _, removed) = burst.finish();
        assert_eq!((rescan, removed), (vec![ROOT.to_string()], true));
    }

    #[test]
    fn common_folders_stop_at_the_root_and_respect_segments() {
        assert_eq!(common_folder("/w/a/b", "/w/a/c/d", "/w"), "/w/a");
        assert_eq!(common_folder("/w/src", "/w/src2/x", "/w"), "/w");
        assert_eq!(common_folder("/w/a", "/elsewhere/x", "/w"), "/w");
        assert!(is_same_or_inside("C:/x", "C:/"));
        assert!(!is_same_or_inside("/w/src2", "/w/src"));
    }

    /// Random bursts over a handful of paths: whatever the order, the result is the same on
    /// every run, stays bounded, and holds at most one change per path -- except a rename
    /// followed by a modification of its new name.
    #[test]
    fn properties_of_coalescing_over_random_bursts() {
        let mut state = 0x2545_f491_u64;
        let mut next = move |bound: usize| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state % bound as u64) as usize
        };
        let names = ["a", "b", "c", "d/e"];
        for _ in 0..3000 {
            let raws: Vec<Raw> = (0..next(12))
                .map(|_| {
                    let name = names[next(names.len())];
                    match next(6) {
                        0 => created(name),
                        1 => modified(name),
                        2 => removed(name),
                        3 => from(name),
                        4 => to(name),
                        _ => Raw::Renamed(p(name), p(names[next(names.len())])),
                    }
                })
                .collect();
            let first = run(raws.clone());
            assert_eq!(first, run(raws.clone()), "deterministic: {raws:?}");
            assert!(first.0.len() <= raws.len());
            for name in names {
                let about: Vec<_> = first.0.iter().filter(|c| c.1 == p(name)).collect();
                let renamed_then_modified = about.len() == 2
                    && about[0].0 == ChangeKind::Renamed
                    && about[1].0 == ChangeKind::Modified;
                assert!(
                    about.len() <= 1 || renamed_then_modified,
                    "{raws:?} -> {first:?}"
                );
            }
        }
    }

    // --- normalize ---------------------------------------------------------------------------

    fn event(kind: EventKind, paths: &[&str]) -> notify::Result<notify::Event> {
        let mut event = notify::Event::new(kind);
        for path in paths {
            event = event.add_path(PathBuf::from(path));
        }
        Ok(event)
    }

    #[test]
    fn folders_named_like_build_output_are_reported_and_only_git_internals_are_not() {
        let root = Path::new("/w");
        for path in [
            "/w/src/build/a.ts",
            "/w/src/dist/a.ts",
            "/w/src/target/a.ts",
            "/w/src/node_modules/a.ts",
            "/w/src/.cache/a.ts",
            "/w/packages/foo/node_modules/x/index.js",
            "/w/build/index.html",
            "/w/.github/workflows/ci.yml",
        ] {
            let raws = normalize(event(EventKind::Create(CreateKind::File), &[path]), root);
            assert_eq!(raws, [Raw::Created(path.to_string())], "{path}");
        }
        for path in [
            "/w/.git/index",
            "/w/.git/refs/heads/main",
            "/w/sub/.git/HEAD",
        ] {
            let raws = normalize(event(EventKind::Create(CreateKind::File), &[path]), root);
            assert!(raws.is_empty(), "{path}");
        }
    }

    #[test]
    fn notify_events_become_the_matching_operations() {
        let root = Path::new("/w");
        let rename = |mode| EventKind::Modify(ModifyKind::Name(mode));
        assert_eq!(
            normalize(event(rename(RenameMode::From), &["/w/a"]), root),
            [Raw::RenameFrom("/w/a".into(), None)]
        );
        assert_eq!(
            normalize(event(rename(RenameMode::To), &["/w/b"]), root),
            [Raw::RenameTo("/w/b".into(), None)]
        );
        assert_eq!(
            normalize(event(rename(RenameMode::Both), &["/w/a", "/w/b"]), root),
            [Raw::Renamed("/w/a".into(), "/w/b".into())]
        );
        assert_eq!(
            normalize(event(EventKind::Remove(RemoveKind::File), &["/w/a"]), root),
            [Raw::Removed("/w/a".into())]
        );
        assert_eq!(
            normalize(event(EventKind::Remove(RemoveKind::Folder), &["/w"]), root),
            [Raw::RootRemoved]
        );
        assert!(normalize(
            event(EventKind::Access(notify::event::AccessKind::Any), &["/w/a"]),
            root
        )
        .is_empty());
        let rescan = notify::Event::new(EventKind::Other).set_flag(Flag::Rescan);
        assert_eq!(normalize(Ok(rescan), root), [Raw::Rescan(None)]);
        let failed = normalize(Err(notify::Error::generic("gone")), root);
        assert!(matches!(failed.as_slice(), [Raw::Failure(message)] if message.contains("gone")));
    }

    fn temp(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("yavin-events-{label}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    // --- the real watcher --------------------------------------------------------------------

    struct Recorder {
        outputs: Arc<Mutex<Vec<WatchOutput>>>,
    }

    impl Recorder {
        fn start(root: &Path, expected: Arc<ExpectedWrites>) -> (Recorder, ResourceWatch) {
            let outputs = Arc::new(Mutex::new(Vec::new()));
            let sink = Arc::clone(&outputs);
            let watch = start_resource_watcher(root, expected, move |output| {
                sink.lock().unwrap().push(output)
            })
            .unwrap();
            (Recorder { outputs }, watch)
        }

        /// Waits for the burst to settle and returns every change reported so far.
        fn settled(&self) -> Vec<ResourceChange> {
            std::thread::sleep(SETTLE * 3);
            self.batches()
                .into_iter()
                .flat_map(|batch| batch.changes)
                .collect()
        }

        fn batches(&self) -> Vec<ResourceChangeBatch> {
            self.outputs
                .lock()
                .unwrap()
                .iter()
                .filter_map(|output| match output {
                    WatchOutput::Changes(batch) => Some(batch.clone()),
                    WatchOutput::Status(_) => None,
                })
                .collect()
        }

        fn clear(&self) {
            self.outputs.lock().unwrap().clear();
        }
    }

    fn has(changes: &[ResourceChange], kind: ChangeKind, path: &Path) -> bool {
        let path = clean_path_str(path);
        changes.iter().any(|c| c.kind == kind && c.path == path)
    }

    #[test]
    fn a_real_watch_reports_creation_modification_and_deletion_by_resource() {
        let dir = temp("real-basic");
        let (recorder, watch) = Recorder::start(&dir, Arc::default());
        assert!(matches!(
            recorder.outputs.lock().unwrap().first(),
            Some(WatchOutput::Status(WatcherStatus {
                state: WatcherState::Watching,
                ..
            }))
        ));

        let file = dir.join("a.txt");
        fs::write(&file, "one").unwrap();
        let changes = recorder.settled();
        assert!(has(&changes, ChangeKind::Created, &file), "{changes:?}");
        assert_eq!(
            changes.len(),
            1,
            "one creation, not a creation and a write: {changes:?}"
        );

        recorder.clear();
        for _ in 0..5 {
            fs::write(&file, "two").unwrap();
        }
        let changes = recorder.settled();
        assert_eq!(changes.len(), 1, "{changes:?}");
        assert!(has(&changes, ChangeKind::Modified, &file));

        recorder.clear();
        fs::remove_file(&file).unwrap();
        let changes = recorder.settled();
        assert!(has(&changes, ChangeKind::Deleted, &file), "{changes:?}");
        drop(watch);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_real_rename_of_a_file_or_a_folder_is_one_rename() {
        let dir = temp("real-rename");
        fs::write(dir.join("a.ts"), "x").unwrap();
        fs::create_dir_all(dir.join("components/deep")).unwrap();
        fs::write(dir.join("components/deep/b.ts"), "x").unwrap();
        let (recorder, watch) = Recorder::start(&dir, Arc::default());

        fs::rename(dir.join("a.ts"), dir.join("b.ts")).unwrap();
        let changes = recorder.settled();
        let expected = ResourceChange::renamed(
            clean_path_str(dir.join("a.ts")),
            clean_path_str(dir.join("b.ts")),
        );
        assert_eq!(changes, [expected]);

        recorder.clear();
        fs::rename(dir.join("components"), dir.join("ui")).unwrap();
        let changes = recorder.settled();
        let renames: Vec<_> = changes
            .iter()
            .filter(|c| c.kind == ChangeKind::Renamed)
            .collect();
        assert_eq!(renames.len(), 1, "{changes:?}");
        assert_eq!(renames[0].path, clean_path_str(dir.join("ui")));
        assert!(
            !changes.iter().any(|c| c.path.contains("/ui/deep")),
            "no synthetic events for the folder's contents: {changes:?}"
        );
        drop(watch);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_real_watch_reports_folders_named_like_output_and_ignores_git_internals() {
        let dir = temp("real-filter");
        for folder in [
            "src/build",
            "src/dist",
            "src/target",
            "src/node_modules",
            "src/.cache",
            ".git",
        ] {
            fs::create_dir_all(dir.join(folder)).unwrap();
        }
        let (recorder, watch) = Recorder::start(&dir, Arc::default());
        for folder in [
            "src/build",
            "src/dist",
            "src/target",
            "src/node_modules",
            "src/.cache",
        ] {
            fs::write(dir.join(folder).join("a.ts"), "x").unwrap();
        }
        fs::write(dir.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        let changes = recorder.settled();
        for folder in [
            "src/build",
            "src/dist",
            "src/target",
            "src/node_modules",
            "src/.cache",
        ] {
            assert!(
                has(
                    &changes,
                    ChangeKind::Created,
                    &dir.join(folder).join("a.ts")
                ),
                "{folder}: {changes:?}"
            );
        }
        assert!(
            !changes.iter().any(|c| c.path.contains("/.git")),
            "{changes:?}"
        );
        drop(watch);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_stopped_watch_reports_nothing_and_each_watch_has_a_newer_generation() {
        let dir = temp("real-generation");
        let (first, first_watch) = Recorder::start(&dir, Arc::default());
        let (second, second_watch) = Recorder::start(&dir, Arc::default());
        assert!(second_watch.generation() > first_watch.generation());

        // A burst in flight when the watch stops is dropped with it.
        fs::write(dir.join("during.txt"), "x").unwrap();
        drop(first_watch);
        std::thread::sleep(SETTLE * 3);
        fs::write(dir.join("after.txt"), "x").unwrap();
        let theirs = first.settled();
        assert!(theirs.is_empty(), "the stopped watch emitted {theirs:?}");

        let batches = second.batches();
        assert!(!batches.is_empty());
        assert!(batches
            .iter()
            .all(|batch| batch.generation == second_watch.generation()));
        drop(second_watch);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_yavin_save_is_credited_and_an_external_write_is_not() {
        let dir = temp("real-attribution");
        // In a folder below the root, so any report about the folder itself is seen too.
        fs::create_dir_all(dir.join("sub")).unwrap();
        let file = dir.join("sub/a.ts");
        fs::write(&file, "before").unwrap();
        let expected = Arc::new(ExpectedWrites::default());
        let (recorder, watch) = Recorder::start(&dir, Arc::clone(&expected));

        // Registered the way the save command does: the target and its temporary file, as
        // the canonical paths, cleaned.
        let nonce = crate::file_tree::temp_nonce();
        let temporary = crate::file_tree::temp_path_for(&file, nonce);
        let operation = expected.begin(OperationKind::Save);
        let id = operation.id();
        operation.expect(clean_path_str(&temporary), Expectation::transient(b"saved"));
        operation.expect(clean_path_str(&file), Expectation::content(b"saved"));
        let written = crate::file_tree::atomic_write_file_via(&file, &temporary, "saved");
        operation.finish(&written);
        let changes = recorder.settled();
        let saved: Vec<_> = changes
            .iter()
            .filter(|c| c.path == clean_path_str(&file))
            .collect();
        assert!(!saved.is_empty(), "{changes:?}");
        assert!(
            changes.iter().all(|c| c.operation == Some(id)),
            "{changes:?}"
        );
        assert!(
            !changes.iter().any(|c| c.path.contains(".tmp.")),
            "the temporary file never surfaces: {changes:?}"
        );

        recorder.clear();
        fs::write(&file, "someone else").unwrap();
        let changes = recorder.settled();
        assert!(has(&changes, ChangeKind::Modified, &file), "{changes:?}");
        assert!(changes.iter().all(|c| c.operation.is_none()), "{changes:?}");

        // Another program writing while a Yavin save is still open is reported as theirs.
        recorder.clear();
        let operation = expected.begin(OperationKind::Save);
        operation.expect(clean_path_str(&file), Expectation::content(b"yavin"));
        fs::write(&file, "editor").unwrap();
        let changes = recorder.settled();
        operation.complete();
        assert!(has(&changes, ChangeKind::Modified, &file), "{changes:?}");
        assert!(changes.iter().all(|c| c.operation.is_none()), "{changes:?}");
        drop(watch);
        fs::remove_dir_all(&dir).ok();
    }

    /// Multi-step operations, as the commands register them, through a real watch: every
    /// change they cause arrives credited to the one operation -- none of it looks external.
    #[test]
    fn a_create_with_new_folders_and_a_tree_copy_arrive_as_one_operation_each() {
        let dir = temp("real-operations");
        let source = dir.join("src");
        fs::create_dir_all(source.join("deep/deeper")).unwrap();
        fs::write(source.join("a.ts"), "a").unwrap();
        fs::write(source.join("deep/deeper/b.ts"), "b").unwrap();
        let expected = Arc::new(ExpectedWrites::default());
        let (recorder, watch) = Recorder::start(&dir, Arc::clone(&expected));

        // A file two new folders down, the way `create_file` registers it.
        let file = dir.join("x/y/new.ts");
        let create = expected.begin(OperationKind::CreateFile);
        let create_id = create.id();
        for folder in crate::file_tree::missing_ancestors(&file) {
            create.expect(clean_path_str(&folder), Expectation::Directory);
        }
        create.expect(clean_path_str(&file), Expectation::content(b""));
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, "").unwrap();
        create.complete();
        let changes = recorder.settled();
        assert!(!changes.is_empty());
        assert!(
            changes.iter().all(|c| c.operation == Some(create_id)),
            "{changes:?}"
        );

        // A tree, the way `copy_path` registers it.
        recorder.clear();
        let copy_to = dir.join("src_copy");
        let copy = expected.begin(OperationKind::Copy);
        let copy_id = copy.id();
        copy.expect(
            clean_path_str(&copy_to),
            Expectation::CopyOf {
                source: clean_path_str(&source),
            },
        );
        crate::file_tree::copy_path(&clean_path_str(&source), &clean_path_str(&copy_to)).unwrap();
        copy.complete();
        let changes = recorder.settled();
        assert!(
            has(
                &changes,
                ChangeKind::Created,
                &copy_to.join("deep/deeper/b.ts")
            ) || has(&changes, ChangeKind::Created, &copy_to),
            "{changes:?}"
        );
        assert!(
            changes.iter().all(|c| c.operation == Some(copy_id)),
            "{changes:?}"
        );

        // Another program then writing into the copy is reported as theirs.
        recorder.clear();
        fs::write(copy_to.join("a.ts"), "edited").unwrap();
        let changes = recorder.settled();
        assert!(
            has(&changes, ChangeKind::Modified, &copy_to.join("a.ts")),
            "{changes:?}"
        );
        assert!(changes.iter().all(|c| c.operation.is_none()), "{changes:?}");

        // A rename and a delete inside a folder, the way `rename_path` and `delete_path`
        // register them: nothing about them -- the folder's own change included -- is external.
        recorder.clear();
        let (old, new) = (
            copy_to.join("deep/deeper/b.ts"),
            copy_to.join("deep/deeper/c.ts"),
        );
        let rename = expected.begin(OperationKind::Rename);
        let rename_id = rename.id();
        rename.expect(clean_path_str(&old), Expectation::Absent);
        rename.expect(clean_path_str(&new), Expectation::Present);
        fs::rename(&old, &new).unwrap();
        rename.complete();
        let changes = recorder.settled();
        assert!(!changes.is_empty());
        assert!(
            changes.iter().all(|c| c.operation == Some(rename_id)),
            "{changes:?}"
        );
        recorder.clear();
        let doomed = copy_to.join("deep");
        let delete = expected.begin(OperationKind::Delete);
        let delete_id = delete.id();
        delete.expect(clean_path_str(&doomed), Expectation::Absent);
        fs::remove_dir_all(&doomed).unwrap();
        delete.complete();
        let changes = recorder.settled();
        assert!(has(&changes, ChangeKind::Deleted, &doomed), "{changes:?}");
        assert!(
            changes.iter().all(|c| c.operation == Some(delete_id)),
            "{changes:?}"
        );
        drop(watch);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_removed_root_is_reported_as_a_failed_watch_with_a_rescan() {
        let parent = temp("real-root");
        let dir = parent.join("root");
        fs::create_dir_all(&dir).unwrap();
        let (recorder, watch) = Recorder::start(&dir, Arc::default());
        fs::remove_dir_all(&dir).unwrap();
        std::thread::sleep(SETTLE * 3);
        let outputs = recorder.outputs.lock().unwrap().clone();
        assert!(
            outputs.iter().any(|output| matches!(
                output,
                WatchOutput::Status(WatcherStatus {
                    state: WatcherState::Failed,
                    ..
                })
            )),
            "{outputs:?}"
        );
        let root = clean_path_str(&dir);
        assert!(recorder
            .batches()
            .iter()
            .any(|batch| batch.rescan.contains(&root)));
        drop(watch);
        fs::remove_dir_all(&parent).ok();
    }

    /// Volumes a real workspace produces, through the pure pipeline: every size stays one
    /// bounded batch.
    #[test]
    fn event_volumes_from_one_to_ten_thousand_stay_bounded() {
        for count in [1, 10, 100, 1_000, 10_000] {
            let mut burst = Burst::new(ROOT.into());
            for index in 0..count {
                burst.push(created(&format!("out/f{index}")));
                burst.push(modified(&format!("out/f{index}")));
            }
            assert!(burst.live <= MAX_PENDING_CHANGES);
            let (changes, rescan, _, _) = burst.finish();
            if count <= MAX_PENDING_CHANGES {
                assert_eq!((changes.len(), rescan.len()), (count, 0));
            } else {
                assert_eq!((changes.len(), rescan), (0, vec![p("out")]));
            }
        }
    }
}
