//! The snapshot walker: one workspace folder on disk -> Local Git trees.
//!
//! **What is recorded.** Regular files (as blobs, or only hashed over `maxBlobBytes`),
//! directories (empty ones included), and links -- symbolic links and Windows junctions -- as
//! their target text, never followed: nothing behind a link is ever read, so a loop or a link
//! out of the workspace is harmless. `.git` and whatever the exclusion rules leave out
//! (`exclude.rs`) are skipped. Anything else -- a name that is not UTF-8 or not a valid tree
//! name, a FIFO, socket or device -- is left out and reported as a `Problem`, never converted.
//!
//! **Reading a file safely.** Its metadata is taken, its bytes read (streamed when too large
//! to store), and its metadata taken again. The file is accepted only if the two agree on
//! size, modification time and (Windows) creation time or (Unix) inode and change time, and
//! exactly `size` bytes were read. Otherwise it is read once more; if that fails too it is
//! `unstable`. A file that disappears is simply absent. A file that is unstable or cannot be
//! read is **carried forward** -- its previous entry kept, never recorded as deleted -- and
//! reported; without a previous entry it is left out and reported.
//!
//! **The scan cache** (`CacheEntry`) is only a way not to hash again: an entry is used only
//! when the file's metadata is exactly what was recorded and the file was last modified more
//! than `RACY_WINDOW_NS` before the scan that recorded it (a file modified during or just
//! before that scan might change again without its time changing, as Git's "racy" entries).
//! Anything else is hashed. A `Verify` scan ignores the cache entirely.
//!
//! **Incremental scans** take a `DirtyNode` tree built from watcher events: a directory
//! marked `relist` is listed again, one marked `deep` is scanned as if new, and every other
//! directory is taken from the previous scan's tree without being opened. See `snapshot.rs`
//! for when an incremental scan is allowed at all.

use crate::error::{LgError, Result};
use crate::exclude::{is_git, IgnoreFile, Rules, YAVINIGNORE};
use crate::fault::read_hook;
use crate::id::{hash_blob_stream, hash_object, ObjectId, ObjectKind};
use crate::object::{EntryKind, EntryName, LinkKind, Stored, Tree, TreeEntry};
use crate::repository::WriteTxn;
use rayon::prelude::*;
use serde::Serialize;
use std::collections::HashMap;
use std::fs::{self, File, Metadata};
use std::io::{ErrorKind, Read};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

/// How long before a scan a file must have been last modified for its cache entry to be
/// trusted later: more than the coarsest timestamp resolution Yavin runs on (FAT's 2 s).
pub const RACY_WINDOW_NS: i128 = 3_000_000_000;

/// A modification time that could not be read: such an entry is never trusted from the cache.
const UNKNOWN_TIME: i128 = i128::MIN;

/// What must not change while a file is read, and what the cache compares.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct FileIdentity {
    pub len: u64,
    pub modified_ns: i128,
    /// Windows: creation time. Unix: inode and change time, folded together.
    pub extra: u64,
}

fn nanos(time: std::io::Result<std::time::SystemTime>) -> i128 {
    match time {
        Ok(time) => match time.duration_since(UNIX_EPOCH) {
            Ok(after) => after.as_nanos() as i128,
            Err(before) => -(before.duration().as_nanos() as i128),
        },
        Err(_) => UNKNOWN_TIME,
    }
}

pub fn identity(meta: &Metadata) -> FileIdentity {
    #[cfg(windows)]
    let extra = {
        use std::os::windows::fs::MetadataExt;
        meta.creation_time()
    };
    #[cfg(unix)]
    let extra = {
        use std::os::unix::fs::MetadataExt;
        (meta.ino() ^ (meta.ctime() as u64).rotate_left(32) ^ meta.ctime_nsec() as u64)
            .wrapping_add(meta.dev())
    };
    #[cfg(not(any(windows, unix)))]
    let extra = 0;
    FileIdentity {
        len: meta.len(),
        modified_ns: nanos(meta.modified()),
        extra,
    }
}

/// What the scan cache remembers of one file.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct CacheEntry {
    pub identity: FileIdentity,
    pub id: ObjectId,
    /// When the scan that hashed it started (ns since the epoch).
    pub recorded_ns: i128,
}

impl CacheEntry {
    /// Whether the file, now `now`, can be taken to still have this content.
    pub fn trusted_for(&self, now: &FileIdentity) -> bool {
        self.identity == *now
            && self.identity.modified_ns != UNKNOWN_TIME
            && self.identity.modified_ns.saturating_add(RACY_WINDOW_NS) < self.recorded_ns
    }
}

/// One folder's cache, by folder-relative path (`a/b.ts`).
pub type FolderCache = HashMap<String, CacheEntry>;

/// Something a snapshot could not record as it is. Always reported; never silent.
#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Problem {
    /// Changed each time it was read.
    #[serde(rename_all = "camelCase")]
    Unstable {
        folder_id: String,
        path: String,
        carried_forward: bool,
    },
    /// Could not be read (locked, no permission) -- a file or a whole directory.
    #[serde(rename_all = "camelCase")]
    Unreadable {
        folder_id: String,
        path: String,
        detail: String,
        carried_forward: bool,
    },
    /// A name a tree cannot hold exactly (not UTF-8, too long, ...). Left out.
    #[serde(rename_all = "camelCase")]
    Unrepresentable {
        folder_id: String,
        path: String,
        detail: String,
    },
    /// A FIFO, socket or device. Left out.
    #[serde(rename_all = "camelCase")]
    Unsupported {
        folder_id: String,
        path: String,
        what: String,
    },
    /// A `.yavinignore` line that is not a valid pattern; the rest of the file applies.
    #[serde(rename_all = "camelCase")]
    InvalidIgnorePattern {
        folder_id: String,
        path: String,
        line: usize,
        detail: String,
    },
    /// An unsaved document that could not be applied (outside the workspace, left out by the
    /// exclusion rules, or at a path that cannot be recorded).
    #[serde(rename_all = "camelCase")]
    OverlayRefused { path: String, reason: String },
}

/// Live counters, read by progress reporting.
#[derive(Default, Debug)]
pub struct Counters {
    pub files: AtomicU64,
    pub directories: AtomicU64,
    pub reused_directories: AtomicU64,
    pub bytes_hashed: AtomicU64,
    pub files_hashed: AtomicU64,
    pub cache_hits: AtomicU64,
}

/// What watcher events say changed in a folder, as a tree of directory names.
#[derive(Default, Debug, Clone)]
pub struct DirtyNode {
    /// List this directory again: an entry in it was created, deleted, renamed or modified.
    pub relist: bool,
    /// Scan everything below as if new (a rescan scope, or a directory that was replaced).
    pub deep: bool,
    pub children: HashMap<String, DirtyNode>,
}

/// How names are compared when events are matched to directory entries. Windows folders
/// are case-insensitive, and an event may spell a name differently from the listing.
pub fn name_key(name: &str) -> String {
    if cfg!(windows) {
        name.to_lowercase()
    } else {
        name.to_string()
    }
}

impl DirtyNode {
    fn node(&mut self, components: &[&str]) -> &mut DirtyNode {
        let mut node = self;
        for component in components {
            node = node.children.entry(name_key(component)).or_default();
        }
        node
    }

    /// `path` (folder-relative components) was created, deleted, modified or renamed.
    pub fn changed(&mut self, components: &[&str]) {
        match components.split_last() {
            None => self.deep = true,
            Some((_, parent)) => {
                self.node(parent).relist = true;
                // If it is (or was) a directory, nothing below it is known.
                self.node(components).deep = true;
            }
        }
    }

    /// Everything under `path` must be read again.
    pub fn rescan(&mut self, components: &[&str]) {
        if let Some((_, parent)) = components.split_last() {
            self.node(parent).relist = true;
        }
        self.node(components).deep = true;
    }

    pub fn is_empty(&self) -> bool {
        !self.relist && !self.deep && self.children.is_empty()
    }

    /// Whether any changed path is named `name` (a `.yavinignore` changing forces a full scan).
    pub fn touches_name(&self, name: &str) -> bool {
        let key = name_key(name);
        self.children
            .iter()
            .any(|(child, node)| *child == key || node.touches_name(name))
    }
}

/// Where a scan finds the trees of the previous one (and of HEAD).
pub trait TreeLookup: Sync {
    fn tree(&self, id: &ObjectId) -> Option<Tree>;
}

/// One walk over one folder.
pub struct Walk<'a, 'r> {
    pub folder_id: &'a str,
    pub max_blob: u64,
    /// Ignore the cache: hash every file.
    pub verify: bool,
    pub cancel: &'a AtomicBool,
    pub counters: &'a Counters,
    pub tick: &'a (dyn Fn() + Sync),
    pub cache: &'a FolderCache,
    /// When this scan started (ns since the epoch): what new cache entries record.
    pub started_ns: i128,
    pub lookup: &'a dyn TreeLookup,
    /// Set when persisting: every object the trees need is written through it.
    pub sink: Option<&'a Mutex<WriteTxn<'r>>>,
    pub cache_out: Mutex<FolderCache>,
    pub trees: Mutex<HashMap<ObjectId, Tree>>,
    pub problems: Mutex<Vec<Problem>>,
}

enum DirOutcome {
    Tree(ObjectId),
    /// It is not there (any more), or is no longer a directory.
    Gone,
    /// It could not be listed; reported by the callee.
    Unreadable,
}

enum ReadOutcome {
    Read {
        id: ObjectId,
        identity: FileIdentity,
    },
    Gone,
    Unreadable(String),
    Unstable,
}

fn join(rel: &str, name: &str) -> String {
    if rel.is_empty() {
        name.to_string()
    } else {
        format!("{rel}/{name}")
    }
}

impl<'r> Walk<'_, 'r> {
    fn problem(&self, problem: Problem) {
        self.problems.lock().unwrap().push(problem);
    }

    fn check_cancel(&self) -> Result<()> {
        if self.cancel.load(Ordering::Relaxed) {
            Err(LgError::Cancelled)
        } else {
            Ok(())
        }
    }

    fn sink_has(&self, id: &ObjectId) -> bool {
        match self.sink {
            Some(sink) => sink.lock().unwrap().has(id),
            None => true,
        }
    }

    /// Whether `entry` (from an earlier scan) can be kept as it is: when persisting, only if
    /// everything it needs is already stored.
    fn can_carry(&self, entry: &TreeEntry) -> bool {
        match entry.kind {
            EntryKind::File {
                stored: Stored::No { .. },
                ..
            } => true,
            _ => self.sink_has(&entry.id),
        }
    }

    fn remember_tree(&self, tree: Tree) -> Result<ObjectId> {
        let id = tree.id();
        if let Some(sink) = self.sink {
            sink.lock().unwrap().put_tree(&tree)?;
        }
        self.trees.lock().unwrap().insert(id, tree);
        Ok(id)
    }

    /// Scans the folder root at `abs`.
    pub fn scan_root(
        &self,
        abs: &Path,
        base: Option<ObjectId>,
        dirty: Option<&DirtyNode>,
    ) -> Result<ObjectId> {
        let rules = Rules::for_folder(abs);
        let base = base.and_then(|id| self.lookup.tree(&id));
        match self.scan_dir(abs, "", &rules, base.as_ref(), dirty)? {
            DirOutcome::Tree(id) => Ok(id),
            DirOutcome::Gone => Err(LgError::Io(format!(
                "The folder {} is not there",
                abs.display()
            ))),
            DirOutcome::Unreadable => Err(LgError::Io(format!(
                "The folder {} cannot be read",
                abs.display()
            ))),
        }
    }

    /// The rules inside the directory at `abs`: `rules` plus its own `.yavinignore`. `Err` if
    /// the file is there but cannot be read (the directory is then treated as unreadable).
    fn rules_in(
        &self,
        abs: &Path,
        rel: &str,
        rules: &Rules,
        has_file: Option<bool>,
    ) -> std::result::Result<Rules, String> {
        if has_file == Some(false) {
            return Ok(rules.clone());
        }
        let path = abs.join(YAVINIGNORE);
        match fs::symlink_metadata(&path) {
            Ok(meta) if meta.is_file() => {}
            Ok(_) => return Ok(rules.clone()),
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(rules.clone()),
            Err(error) => return Err(error.to_string()),
        }
        let text = match fs::read(&path) {
            Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(rules.clone()),
            Err(error) => return Err(error.to_string()),
        };
        let (file, bad) = IgnoreFile::parse(abs, &text);
        for bad in bad {
            self.problem(Problem::InvalidIgnorePattern {
                folder_id: self.folder_id.into(),
                path: join(rel, YAVINIGNORE),
                line: bad.line,
                detail: bad.detail,
            });
        }
        Ok(rules.with(file))
    }

    fn scan_dir(
        &self,
        abs: &Path,
        rel: &str,
        rules: &Rules,
        base: Option<&Tree>,
        dirty: Option<&DirtyNode>,
    ) -> Result<DirOutcome> {
        self.check_cancel()?;
        self.counters.directories.fetch_add(1, Ordering::Relaxed);
        (self.tick)();
        let full = dirty.is_none_or(|node| node.deep);
        if !full {
            let node = dirty.expect("not full");
            if !node.relist {
                if let Some(base) = base {
                    if let Some(outcome) = self.rebuild(abs, rel, rules, base, node)? {
                        return Ok(outcome);
                    }
                }
            }
        }
        self.relist(abs, rel, rules, base, if full { None } else { dirty })
    }

    /// A directory that did not change itself, only somewhere below: its previous entries,
    /// with the changed subdirectories scanned again. `None` if that is not enough (a changed
    /// name the previous tree has no directory for): the caller lists it instead.
    fn rebuild(
        &self,
        abs: &Path,
        rel: &str,
        rules: &Rules,
        base: &Tree,
        node: &DirtyNode,
    ) -> Result<Option<DirOutcome>> {
        match fs::symlink_metadata(abs) {
            Ok(meta) if meta.is_dir() => {}
            Ok(_) => return Ok(Some(DirOutcome::Gone)),
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Some(DirOutcome::Gone)),
            Err(_) => return Ok(None),
        }
        let mut targets = Vec::new();
        for (key, child) in &node.children {
            if child.is_empty() {
                continue;
            }
            match base
                .entries()
                .iter()
                .position(|entry| name_key(entry.name.as_str()) == *key)
            {
                Some(at) if base.entries()[at].kind == EntryKind::Directory => {
                    targets.push((at, child))
                }
                // A change the previous tree cannot place: list this directory.
                _ => return Ok(None),
            }
        }
        let Ok(inner) = self.rules_in(abs, rel, rules, None) else {
            return Ok(None);
        };
        let results: Vec<(usize, Result<DirOutcome>)> = targets
            .par_iter()
            .map(|(at, child)| {
                let entry = &base.entries()[*at];
                let name = entry.name.as_str();
                let child_base = self.lookup.tree(&entry.id);
                (
                    *at,
                    self.scan_dir(
                        &abs.join(name),
                        &join(rel, name),
                        &inner,
                        child_base.as_ref(),
                        Some(child),
                    ),
                )
            })
            .collect();
        let mut entries: Vec<Option<TreeEntry>> =
            base.entries().iter().cloned().map(Some).collect();
        for (at, result) in results {
            match result? {
                DirOutcome::Tree(id) => {
                    if let Some(entry) = entries[at].as_mut() {
                        entry.id = id;
                    }
                }
                DirOutcome::Gone => {
                    // Gone, or replaced by something else: list this directory to know which.
                    return Ok(None);
                }
                DirOutcome::Unreadable => {
                    if !entries[at]
                        .as_ref()
                        .is_some_and(|entry| self.can_carry(entry))
                    {
                        entries[at] = None;
                    }
                }
            }
        }
        let tree = Tree::new(entries.into_iter().flatten().collect())?;
        self.counters
            .reused_directories
            .fetch_add(1, Ordering::Relaxed);
        Ok(Some(DirOutcome::Tree(self.remember_tree(tree)?)))
    }

    fn relist(
        &self,
        abs: &Path,
        rel: &str,
        rules: &Rules,
        base: Option<&Tree>,
        dirty: Option<&DirtyNode>,
    ) -> Result<DirOutcome> {
        let listing = match fs::read_dir(abs) {
            Ok(listing) => listing,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(DirOutcome::Gone),
            Err(error) => {
                if fs::symlink_metadata(abs).is_ok_and(|meta| !meta.is_dir()) {
                    return Ok(DirOutcome::Gone);
                }
                self.problem(Problem::Unreadable {
                    folder_id: self.folder_id.into(),
                    path: rel.into(),
                    detail: error.to_string(),
                    carried_forward: base.is_some() && !rel.is_empty(),
                });
                return Ok(DirOutcome::Unreadable);
            }
        };
        let mut found = Vec::new();
        for item in listing {
            let item = match item {
                Ok(item) => item,
                Err(error) => {
                    self.problem(Problem::Unreadable {
                        folder_id: self.folder_id.into(),
                        path: rel.into(),
                        detail: error.to_string(),
                        carried_forward: base.is_some() && !rel.is_empty(),
                    });
                    return Ok(DirOutcome::Unreadable);
                }
            };
            found.push(item);
        }
        let has_ignore_file = found
            .iter()
            .any(|item| item.file_name() == std::ffi::OsStr::new(YAVINIGNORE));
        let inner = match self.rules_in(abs, rel, rules, Some(has_ignore_file)) {
            Ok(inner) => inner,
            Err(detail) => {
                self.problem(Problem::Unreadable {
                    folder_id: self.folder_id.into(),
                    path: join(rel, YAVINIGNORE),
                    detail,
                    carried_forward: base.is_some() && !rel.is_empty(),
                });
                return Ok(DirOutcome::Unreadable);
            }
        };

        enum Kind {
            File(Option<Metadata>),
            Dir,
            Link(fs::FileType),
        }
        let mut items = Vec::with_capacity(found.len());
        for item in found {
            let os_name = item.file_name();
            let Some(name) = os_name.to_str() else {
                self.problem(Problem::Unrepresentable {
                    folder_id: self.folder_id.into(),
                    path: join(rel, &os_name.to_string_lossy()),
                    detail: "the name is not valid Unicode".into(),
                });
                continue;
            };
            if is_git(name) {
                continue;
            }
            let file_type = match item.file_type() {
                Ok(file_type) => file_type,
                Err(error) if error.kind() == ErrorKind::NotFound => continue,
                Err(error) => {
                    self.problem(Problem::Unreadable {
                        folder_id: self.folder_id.into(),
                        path: join(rel, name),
                        detail: error.to_string(),
                        carried_forward: false,
                    });
                    continue;
                }
            };
            let path = abs.join(name);
            if inner.excludes(&path, name, file_type.is_dir()) {
                continue;
            }
            let entry_name = match EntryName::new(name) {
                Ok(entry_name) => entry_name,
                Err(error) => {
                    self.problem(Problem::Unrepresentable {
                        folder_id: self.folder_id.into(),
                        path: join(rel, name),
                        detail: error.to_string(),
                    });
                    continue;
                }
            };
            let kind = if file_type.is_symlink() {
                Kind::Link(file_type)
            } else if file_type.is_dir() {
                Kind::Dir
            } else if file_type.is_file() {
                // On Windows the listing already has the metadata; elsewhere it is one stat.
                Kind::File(item.metadata().ok())
            } else {
                self.problem(Problem::Unsupported {
                    folder_id: self.folder_id.into(),
                    path: join(rel, name),
                    what: "not a file, directory or link".into(),
                });
                continue;
            };
            items.push((entry_name, kind));
        }

        let base_entry = |name: &EntryName| {
            base.and_then(|tree| {
                tree.entries()
                    .iter()
                    .find(|entry| entry.name == *name)
                    .cloned()
            })
        };
        let results: Vec<Result<Option<TreeEntry>>> = items
            .into_par_iter()
            .map(|(name, kind)| {
                self.check_cancel()?;
                let path = abs.join(name.as_str());
                let child_rel = join(rel, name.as_str());
                let previous = base_entry(&name);
                match kind {
                    Kind::File(meta) => self.file(&path, &child_rel, name, meta, previous),
                    Kind::Link(file_type) => self.link(&path, &child_rel, name, file_type),
                    Kind::Dir => {
                        let child_dirty =
                            dirty.map(|node| node.children.get(&name_key(name.as_str())));
                        let previous_dir =
                            previous.filter(|entry| entry.kind == EntryKind::Directory);
                        // Incremental and nothing changed below it: taken as it was, unopened.
                        if let (Some(None), Some(entry)) = (child_dirty, previous_dir.as_ref()) {
                            self.counters
                                .reused_directories
                                .fetch_add(1, Ordering::Relaxed);
                            return Ok(Some(entry.clone()));
                        }
                        let child_base = previous_dir
                            .as_ref()
                            .and_then(|entry| self.lookup.tree(&entry.id));
                        let child_node = child_dirty.flatten();
                        let outcome = self.scan_dir(
                            &path,
                            &child_rel,
                            &inner,
                            child_base.as_ref(),
                            // A directory that is new here is scanned in full.
                            if previous_dir.is_some() {
                                child_node
                            } else {
                                None
                            },
                        )?;
                        Ok(match outcome {
                            DirOutcome::Tree(id) => Some(TreeEntry {
                                name,
                                kind: EntryKind::Directory,
                                id,
                            }),
                            DirOutcome::Gone => None,
                            DirOutcome::Unreadable => {
                                previous_dir.filter(|entry| self.can_carry(entry))
                            }
                        })
                    }
                }
            })
            .collect();
        let mut entries = Vec::with_capacity(results.len());
        for result in results {
            if let Some(entry) = result? {
                entries.push(entry);
            }
        }
        let tree = Tree::new(entries)?;
        Ok(DirOutcome::Tree(self.remember_tree(tree)?))
    }

    fn file(
        &self,
        abs: &Path,
        rel: &str,
        name: EntryName,
        listed: Option<Metadata>,
        previous: Option<TreeEntry>,
    ) -> Result<Option<TreeEntry>> {
        self.counters.files.fetch_add(1, Ordering::Relaxed);
        (self.tick)();
        let meta = match listed {
            Some(meta) => meta,
            None => match fs::symlink_metadata(abs) {
                Ok(meta) => meta,
                Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
                Err(error) => {
                    return Ok(self.carry(rel, previous, |carried| Problem::Unreadable {
                        folder_id: self.folder_id.into(),
                        path: rel.into(),
                        detail: error.to_string(),
                        carried_forward: carried,
                    }))
                }
            },
        };
        let executable = executable(&meta, previous.as_ref());
        let now = identity(&meta);
        let entry = |id: ObjectId, len: u64| TreeEntry {
            name: name.clone(),
            kind: EntryKind::File {
                executable,
                stored: if len > self.max_blob {
                    Stored::No { size: len }
                } else {
                    Stored::Yes
                },
            },
            id,
        };
        if !self.verify {
            if let Some(cached) = self.cache.get(rel) {
                let needs_storing = now.len <= self.max_blob && !self.sink_has(&cached.id);
                if cached.trusted_for(&now) && !needs_storing {
                    self.counters.cache_hits.fetch_add(1, Ordering::Relaxed);
                    self.cache_out.lock().unwrap().insert(rel.into(), *cached);
                    return Ok(Some(entry(cached.id, now.len)));
                }
            }
        }
        match self.read(abs)? {
            ReadOutcome::Read { id, identity } => {
                self.cache_out.lock().unwrap().insert(
                    rel.into(),
                    CacheEntry {
                        identity,
                        id,
                        recorded_ns: self.started_ns,
                    },
                );
                Ok(Some(entry(id, identity.len)))
            }
            ReadOutcome::Gone => Ok(None),
            ReadOutcome::Unreadable(detail) => {
                Ok(self.carry(rel, previous, |carried| Problem::Unreadable {
                    folder_id: self.folder_id.into(),
                    path: rel.into(),
                    detail,
                    carried_forward: carried,
                }))
            }
            ReadOutcome::Unstable => Ok(self.carry(rel, previous, |carried| Problem::Unstable {
                folder_id: self.folder_id.into(),
                path: rel.into(),
                carried_forward: carried,
            })),
        }
    }

    /// Keeps a file's previous entry when it cannot be read now, and reports it.
    fn carry(
        &self,
        _rel: &str,
        previous: Option<TreeEntry>,
        problem: impl FnOnce(bool) -> Problem,
    ) -> Option<TreeEntry> {
        let kept = previous
            .filter(|entry| matches!(entry.kind, EntryKind::File { .. }) && self.can_carry(entry));
        self.problem(problem(kept.is_some()));
        kept
    }

    /// Reads (or, over the limit, only hashes) a file, with the stat-read-stat check.
    fn read(&self, abs: &Path) -> Result<ReadOutcome> {
        for attempt in 0..2 {
            self.check_cancel()?;
            let before = match fs::symlink_metadata(abs) {
                Ok(meta) if meta.is_file() => meta,
                // It became something else while being scanned: try once more, then give up.
                Ok(_) => continue,
                Err(error) if error.kind() == ErrorKind::NotFound => return Ok(ReadOutcome::Gone),
                Err(error) => return Ok(ReadOutcome::Unreadable(error.to_string())),
            };
            let len = before.len();
            let mut file = match File::open(abs) {
                Ok(file) => file,
                Err(error) if error.kind() == ErrorKind::NotFound => return Ok(ReadOutcome::Gone),
                Err(error) => return Ok(ReadOutcome::Unreadable(error.to_string())),
            };
            let (id, bytes) = if len <= self.max_blob {
                let mut bytes = Vec::with_capacity(len as usize);
                if let Err(error) = (&mut file).take(len + 1).read_to_end(&mut bytes) {
                    return Ok(ReadOutcome::Unreadable(error.to_string()));
                }
                if bytes.len() as u64 != len {
                    drop(file);
                    read_hook::run(abs, attempt);
                    continue;
                }
                (hash_object(ObjectKind::Blob, &bytes), Some(bytes))
            } else {
                match hash_blob_stream(len, &mut file) {
                    Ok(id) => (id, None),
                    Err(LgError::Io(detail)) => return Ok(ReadOutcome::Unreadable(detail)),
                    // Fewer or more bytes than its size said: it changed while being read.
                    Err(_) => {
                        drop(file);
                        read_hook::run(abs, attempt);
                        continue;
                    }
                }
            };
            drop(file);
            self.counters.bytes_hashed.fetch_add(len, Ordering::Relaxed);
            self.counters.files_hashed.fetch_add(1, Ordering::Relaxed);
            read_hook::run(abs, attempt);
            let after = match fs::symlink_metadata(abs) {
                Ok(meta) => meta,
                Err(error) if error.kind() == ErrorKind::NotFound => return Ok(ReadOutcome::Gone),
                Err(error) => return Ok(ReadOutcome::Unreadable(error.to_string())),
            };
            let identity_before = identity(&before);
            if !after.is_file() || identity(&after) != identity_before {
                continue;
            }
            if let (Some(bytes), Some(sink)) = (bytes, self.sink) {
                sink.lock().unwrap().put_blob(&bytes)?;
            }
            return Ok(ReadOutcome::Read {
                id,
                identity: identity_before,
            });
        }
        Ok(ReadOutcome::Unstable)
    }

    fn link(
        &self,
        abs: &Path,
        rel: &str,
        name: EntryName,
        file_type: fs::FileType,
    ) -> Result<Option<TreeEntry>> {
        self.counters.files.fetch_add(1, Ordering::Relaxed);
        let target = match fs::read_link(abs) {
            Ok(target) => target,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                self.problem(Problem::Unreadable {
                    folder_id: self.folder_id.into(),
                    path: rel.into(),
                    detail: error.to_string(),
                    carried_forward: false,
                });
                return Ok(None);
            }
        };
        let Some(text) = target.to_str() else {
            self.problem(Problem::Unrepresentable {
                folder_id: self.folder_id.into(),
                path: rel.into(),
                detail: "the link's target is not valid Unicode".into(),
            });
            return Ok(None);
        };
        let id = hash_object(ObjectKind::Blob, text.as_bytes());
        if let Some(sink) = self.sink {
            sink.lock().unwrap().put_blob(text.as_bytes())?;
        }
        Ok(Some(TreeEntry {
            name,
            kind: EntryKind::Symlink(link_kind(abs, file_type)),
            id,
        }))
    }
}

/// Unix: the owner's execute bit. Windows has none: the previous entry's is kept, as Git does
/// with `core.fileMode=false`, so a script committed from elsewhere stays executable.
fn executable(meta: &Metadata, previous: Option<&TreeEntry>) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = previous;
        meta.permissions().mode() & 0o100 != 0
    }
    #[cfg(not(unix))]
    {
        let _ = meta;
        matches!(
            previous,
            Some(TreeEntry {
                kind: EntryKind::File {
                    executable: true,
                    ..
                },
                ..
            })
        )
    }
}

#[cfg(windows)]
fn link_kind(abs: &Path, file_type: fs::FileType) -> LinkKind {
    use std::os::windows::fs::{FileTypeExt, OpenOptionsExt};
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        FileAttributeTagInfo, GetFileInformationByHandleEx, FILE_ATTRIBUTE_TAG_INFO,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    };
    const IO_REPARSE_TAG_MOUNT_POINT: u32 = 0xA000_0003;
    // The link itself is opened (never its target) to read its reparse tag.
    let tag = fs::OpenOptions::new()
        .access_mode(0)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
        .open(abs)
        .ok()
        .and_then(|handle| {
            let mut info = FILE_ATTRIBUTE_TAG_INFO {
                FileAttributes: 0,
                ReparseTag: 0,
            };
            // SAFETY: `info` is a valid FILE_ATTRIBUTE_TAG_INFO of the size passed, and the
            // handle is open for the duration of the call.
            let ok = unsafe {
                GetFileInformationByHandleEx(
                    handle.as_raw_handle() as _,
                    FileAttributeTagInfo,
                    &mut info as *mut _ as *mut _,
                    std::mem::size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
                )
            };
            (ok != 0).then_some(info.ReparseTag)
        });
    if tag == Some(IO_REPARSE_TAG_MOUNT_POINT) {
        LinkKind::Junction
    } else if file_type.is_symlink_dir() {
        LinkKind::Directory
    } else {
        LinkKind::File
    }
}

#[cfg(not(windows))]
fn link_kind(_abs: &Path, _file_type: fs::FileType) -> LinkKind {
    LinkKind::File
}
