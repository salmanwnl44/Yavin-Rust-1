//! Crash recovery for Yavin's own file operations.
//!
//! Every Module 03 operation (`operations.rs`) writes a durable **intent record** before it
//! touches the disk: what it will change, what each path holds now (`pre`), and what it will
//! hold afterwards (`post`). The record is removed when the operation ends. A record that
//! outlives its process is therefore the evidence of a crash in the middle of an operation, and
//! the next start inspects it.
//!
//! Recovery acts only when the disk *proves* an action safe, and the only operation where it
//! can is a save: its temporary file holds exactly the new bytes, and the target's pre-save
//! bytes are recorded by hash. Everything else -- a half-finished recursive delete, a partial
//! copy, a Git command -- is classified and reported, never touched: without a snapshot there
//! is nothing that could be proven to finish or undo it. And any path in neither its recorded
//! pre nor post state is a conflict: someone else changed it, and recovery never overwrites it.
//!
//! Layout, under the recovery folder:
//!
//! ```text
//! instances/<pid>-<start ms>/owner.lock    held (locked) by the live process that owns the folder
//! instances/<pid>-<start ms>/op-<id>.json  one record per operation in flight
//! unresolved/<instance>-<op>.json          what recovery could not settle, until dismissed
//! ```
//!
//! A folder whose `owner.lock` can be locked by someone else has no live owner: that process
//! is gone, and its records are recovered. One still locked belongs to another running Yavin
//! and is left alone.

use crate::durable::{
    json_version, now_millis, read_versioned, remove_durably, sweep_stale_temps, write_json, Loaded,
};
use serde::{Deserialize, Serialize};
use std::fs::{self, File, TryLockError};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use xxhash_rust::xxh3::xxh3_128;

/// The record format written now. Older versions are migrated in `parse_record`.
pub const RECORD_VERSION: u32 = 1;
/// The hash in every record: stable across builds and platforms, which std's `DefaultHasher`
/// is not -- it is fine for Module 03's in-memory matching, not for anything read back later.
pub const HASH_ALGORITHM: &str = "xxh3-128";
/// Records one process may have open at once -- Module 03's operation bound.
const MAX_LIVE_RECORDS: usize = 256;
/// A folder counted for a delete's pre-state is walked at most this far; past it, the
/// recorded state is `Present` and an interrupted delete of it is reported, not classified.
const MAX_TREE_ENTRIES: u64 = 100_000;
/// Temporary files of Yavin's own persistence older than this are leftovers of a crash.
pub const STALE_TEMP_AGE: Duration = Duration::from_secs(60 * 60);
/// Past this many unresolved items a warning is logged. They are never deleted for it.
const UNRESOLVED_WARNING: usize = 1000;

/// A stable content identity for persisted records.
pub fn stable_hash(bytes: &[u8]) -> String {
    format!("{:032x}", xxh3_128(bytes))
}

// ---------------------------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum IntentKind {
    Save,
    CreateFile,
    CreateDirectory,
    Rename,
    Delete,
    Copy,
    Git,
}

impl From<crate::operations::OperationKind> for IntentKind {
    fn from(kind: crate::operations::OperationKind) -> Self {
        use crate::operations::OperationKind as K;
        match kind {
            K::Save => IntentKind::Save,
            K::CreateFile => IntentKind::CreateFile,
            K::CreateDirectory => IntentKind::CreateDirectory,
            K::Rename => IntentKind::Rename,
            K::Delete => IntentKind::Delete,
            K::Copy => IntentKind::Copy,
            K::Git => IntentKind::Git,
        }
    }
}

/// What a path holds, as far as recovery needs to know.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum DiskState {
    Absent,
    /// A file with exactly these bytes (`hash` is `HASH_ALGORITHM`).
    File {
        size: u64,
        hash: String,
    },
    Directory,
    /// Something is there; what exactly is not recorded.
    Present,
    /// A folder holding exactly this many entries, all the way down.
    Tree {
        entries: u64,
    },
    /// A copy of `source`: the same tree, every file byte-identical.
    CopyOf {
        source: String,
    },
    /// Not knowable from the disk alone (a Git working tree).
    Unknown,
}

impl DiskState {
    pub fn file(bytes: &[u8]) -> Self {
        DiskState::File {
            size: bytes.len() as u64,
            hash: stable_hash(bytes),
        }
    }

    /// What is at `path` now, cheaply: nothing, a folder, or something else. Files are not
    /// read -- an operation that needs their bytes records them itself.
    pub fn observe(path: &Path) -> Self {
        match fs::symlink_metadata(path) {
            Err(_) => DiskState::Absent,
            Ok(meta) if meta.is_dir() => DiskState::Directory,
            Ok(_) => DiskState::Present,
        }
    }

    /// `observe`, but a folder is recorded with its entry count (bounded), so an interrupted
    /// delete can tell "untouched" from "half deleted". Only a delete needs it.
    pub fn observe_tree(path: &Path) -> Self {
        match DiskState::observe(path) {
            DiskState::Directory => match count_entries(path, MAX_TREE_ENTRIES) {
                Some(entries) => DiskState::Tree { entries },
                None => DiskState::Present,
            },
            other => other,
        }
    }

    /// Whether `path` holds this now.
    fn holds(&self, path: &Path) -> bool {
        match self {
            DiskState::Absent => is_absent(path),
            DiskState::File { size, hash } => {
                fs::metadata(path).is_ok_and(|m| m.is_file() && m.len() == *size)
                    && fs::read(path).is_ok_and(|bytes| stable_hash(&bytes) == *hash)
            }
            DiskState::Directory => path.is_dir(),
            DiskState::Present => !is_absent(path),
            DiskState::Tree { entries } => {
                path.is_dir() && count_entries(path, MAX_TREE_ENTRIES) == Some(*entries)
            }
            DiskState::CopyOf { source } => same_tree(path, Path::new(source)),
            DiskState::Unknown => false,
        }
    }
}

fn is_absent(path: &Path) -> bool {
    fs::symlink_metadata(path).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
}

/// Entries below `folder`, recursively; `None` past `limit` or on any error.
fn count_entries(folder: &Path, limit: u64) -> Option<u64> {
    let mut count = 0u64;
    let mut pending = vec![folder.to_path_buf()];
    while let Some(dir) = pending.pop() {
        for entry in fs::read_dir(&dir).ok()? {
            let entry = entry.ok()?;
            count += 1;
            if count > limit {
                return None;
            }
            if entry.file_type().ok()?.is_dir() {
                pending.push(entry.path());
            }
        }
    }
    Some(count)
}

/// Whether `copy` is exactly `source`: the same entries, every file byte-identical. Bounded
/// like `count_entries`; past the bound it cannot be proven, so it is not.
fn same_tree(copy: &Path, source: &Path) -> bool {
    let (Ok(a), Ok(b)) = (fs::metadata(copy), fs::metadata(source)) else {
        return false;
    };
    if a.is_file() && b.is_file() {
        return a.len() == b.len()
            && matches!((fs::read(copy), fs::read(source)), (Ok(x), Ok(y)) if x == y);
    }
    if !(a.is_dir() && b.is_dir()) {
        return false;
    }
    let mut seen = 0u64;
    let mut pending = vec![(copy.to_path_buf(), source.to_path_buf())];
    while let Some((ours, theirs)) = pending.pop() {
        let names = |dir: &Path| -> Option<Vec<std::ffi::OsString>> {
            let mut names: Vec<_> = fs::read_dir(dir)
                .ok()?
                .map(|e| e.map(|e| e.file_name()))
                .collect::<Result<_, _>>()
                .ok()?;
            names.sort();
            Some(names)
        };
        let (Some(left), Some(right)) = (names(&ours), names(&theirs)) else {
            return false;
        };
        if left != right {
            return false;
        }
        for name in left {
            seen += 1;
            if seen > MAX_TREE_ENTRIES {
                return false;
            }
            let (x, y) = (ours.join(&name), theirs.join(&name));
            match (fs::metadata(&x), fs::metadata(&y)) {
                (Ok(m), Ok(n)) if m.is_dir() && n.is_dir() => pending.push((x, y)),
                (Ok(m), Ok(n)) if m.is_file() && n.is_file() => {
                    if m.len() != n.len()
                        || !matches!((fs::read(&x), fs::read(&y)), (Ok(p), Ok(q)) if p == q)
                    {
                        return false;
                    }
                }
                _ => return false,
            }
        }
    }
    true
}

/// What part a path plays in its operation. Only a save needs to tell them apart.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum Role {
    #[default]
    Target,
    /// A save's temporary file.
    Temporary,
    /// A folder the operation makes on the way.
    Folder,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Effect {
    pub path: String,
    pub pre: DiskState,
    pub post: DiskState,
    #[serde(default)]
    pub role: Role,
}

impl Effect {
    pub fn new(path: impl Into<String>, pre: DiskState, post: DiskState) -> Self {
        Self {
            path: path.into(),
            pre,
            post,
            role: Role::Target,
        }
    }
    pub fn role(mut self, role: Role) -> Self {
        self.role = role;
        self
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IntentRecord {
    pub version: u32,
    pub instance: String,
    pub operation: u64,
    pub kind: IntentKind,
    pub started_at: u64,
    pub hash: String,
    pub effects: Vec<Effect>,
}

fn parse_record(text: &str, version: u32) -> Option<IntentRecord> {
    match version {
        // Version 1 is the only one there has been. A future migration reads its old shape
        // here and returns the current one.
        1 => {
            let record: IntentRecord = serde_json::from_str(text).ok()?;
            (record.hash == HASH_ALGORITHM).then_some(record)
        }
        _ => None,
    }
}

// ---------------------------------------------------------------------------------------------
// The intent log: one per process
// ---------------------------------------------------------------------------------------------

/// This process's intent records, in its own instance folder, which it holds locked for as
/// long as it runs.
pub struct IntentLog {
    root: PathBuf,
    instance: String,
    folder: PathBuf,
    _owner: File,
    live: Mutex<usize>,
}

impl std::fmt::Debug for IntentLog {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IntentLog")
            .field("instance", &self.instance)
            .finish()
    }
}

impl IntentLog {
    /// Claims a fresh instance folder under `root`.
    pub fn open(root: &Path) -> Result<IntentLog, String> {
        let instance = format!("{}-{}", std::process::id(), now_millis());
        let folder = root.join("instances").join(&instance);
        // Another Yavin starting at the same moment sees this folder before its lock exists,
        // takes it for a dead instance with nothing in it, and removes it. Creating the folder
        // and its lock again is enough: once the lock is held, nobody removes the folder.
        let mut attempts = 0;
        let owner = loop {
            attempts += 1;
            let opened = fs::create_dir_all(&folder).and_then(|()| {
                File::options()
                    .create(true)
                    .truncate(false)
                    .read(true)
                    .write(true)
                    .open(folder.join("owner.lock"))
            });
            match opened {
                Ok(owner) => break owner,
                Err(error) if attempts >= 3 => return Err(error.to_string()),
                Err(_) => continue,
            }
        };
        owner.try_lock().map_err(|e| e.to_string())?;
        Ok(IntentLog {
            root: root.to_path_buf(),
            instance,
            folder,
            _owner: owner,
            live: Mutex::new(0),
        })
    }

    pub fn instance(&self) -> &str {
        &self.instance
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Durably records an operation's intent. Must succeed before the operation touches the
    /// disk; if it fails, the operation must not run.
    pub fn record(
        &self,
        operation: u64,
        kind: IntentKind,
        effects: Vec<Effect>,
    ) -> Result<Intent<'_>, String> {
        {
            let mut live = self.live.lock().map_err(|e| e.to_string())?;
            if *live >= MAX_LIVE_RECORDS {
                return Err(format!(
                    "{MAX_LIVE_RECORDS} operations are already in progress"
                ));
            }
            *live += 1;
        }
        let record = IntentRecord {
            version: RECORD_VERSION,
            instance: self.instance.clone(),
            operation,
            kind,
            started_at: now_millis() as u64,
            hash: HASH_ALGORITHM.to_string(),
            effects,
        };
        let path = self.folder.join(format!("op-{operation}.json"));
        if let Err(error) = write_json(&path, &record) {
            self.release();
            return Err(error);
        }
        Ok(Intent {
            log: self,
            path,
            closed: false,
        })
    }

    fn release(&self) {
        if let Ok(mut live) = self.live.lock() {
            *live = live.saturating_sub(1);
        }
    }

    /// For a normal exit: removes this process's temporary leftovers. The instance folder and
    /// its lock go when the process does; the next start clears an empty one.
    pub fn sweep(&self) {
        sweep_stale_temps(&self.folder, Duration::ZERO);
    }
}

/// One recorded operation. `close` it when the operation has ended, however it ended: the live
/// process knows the outcome and has reported it. Dropped without `close` -- a panic in the
/// middle of the operation -- the record stays, and the next start inspects it like a crash.
#[must_use = "an intent that is never closed is inspected as a crash at the next start"]
pub struct Intent<'a> {
    log: &'a IntentLog,
    path: PathBuf,
    closed: bool,
}

impl Intent<'_> {
    pub fn close(mut self) {
        self.closed = true;
        if let Err(error) = remove_durably(&self.path) {
            // Harmless: the next start finds the operation completed and finalizes it.
            eprintln!(
                "Cannot remove the intent record {}: {error}",
                self.path.display()
            );
        }
        self.log.release();
    }
}

impl Drop for Intent<'_> {
    fn drop(&mut self) {
        if !self.closed {
            self.log.release();
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    /// The operation had finished; only its record was left.
    Completed,
    /// The operation had not changed anything.
    NotApplied,
    /// An interrupted save, finished: its temporary file moved onto the target.
    RolledForward,
    /// An interrupted save that had not reached its target: its temporary file removed.
    RolledBack,
    /// A path is in neither its recorded state before nor after: someone else changed it.
    Conflict,
    /// Some paths reached their end state and others did not.
    Partial,
    /// A Git command stopped midway (its lock file remains).
    Interrupted,
    /// The record could not be read.
    Corrupt,
}

impl Outcome {
    /// Whether this needs the user: reported and kept until dismissed.
    pub fn unresolved(self) -> bool {
        matches!(
            self,
            Outcome::Conflict | Outcome::Partial | Outcome::Interrupted | Outcome::Corrupt
        )
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryItem {
    pub version: u32,
    pub id: String,
    pub kind: Option<IntentKind>,
    pub outcome: Outcome,
    pub paths: Vec<String>,
    pub message: String,
    pub at: u64,
}

#[derive(Serialize, Debug, Clone, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryReport {
    /// What this start did: operations settled, saves finished or undone.
    pub actions: Vec<RecoveryItem>,
    /// Everything still needing the user, from this start or earlier ones.
    pub unresolved: Vec<RecoveryItem>,
}

fn item(record: &IntentRecord, outcome: Outcome, message: String) -> RecoveryItem {
    RecoveryItem {
        version: RECORD_VERSION,
        id: format!("{}-{}", record.instance, record.operation),
        kind: Some(record.kind),
        outcome,
        paths: record.effects.iter().map(|e| e.path.clone()).collect(),
        message,
        at: now_millis() as u64,
    }
}

fn name(kind: IntentKind) -> &'static str {
    match kind {
        IntentKind::Save => "save",
        IntentKind::CreateFile => "file creation",
        IntentKind::CreateDirectory => "folder creation",
        IntentKind::Rename => "rename",
        IntentKind::Delete => "delete",
        IntentKind::Copy => "copy",
        IntentKind::Git => "Git command",
    }
}

/// Settles one interrupted operation: decides what happened from the disk as it is now, acts
/// only where that is proven safe, and says what it found.
fn settle(record: &IntentRecord) -> RecoveryItem {
    match record.kind {
        IntentKind::Save => settle_save(record),
        IntentKind::Git => settle_git(record),
        _ => settle_generic(record),
    }
}

/// The operation as a whole: every path in its end state, every path untouched, a mixture,
/// or some path in neither -- never one path at a time.
fn settle_generic(record: &IntentRecord) -> RecoveryItem {
    let (mut all_post, mut all_pre, mut neither) = (true, true, Vec::new());
    for effect in &record.effects {
        let path = Path::new(&effect.path);
        let (pre, post) = (effect.pre.holds(path), effect.post.holds(path));
        all_post &= post;
        all_pre &= pre;
        if !pre && !post {
            neither.push(effect.path.clone());
        }
    }
    let what = name(record.kind);
    let first = record
        .effects
        .first()
        .map(|e| e.path.as_str())
        .unwrap_or("");
    if all_post {
        item(
            record,
            Outcome::Completed,
            format!("The {what} of {first} had completed."),
        )
    } else if all_pre {
        item(
            record,
            Outcome::NotApplied,
            format!("The {what} of {first} had not started."),
        )
    } else if !neither.is_empty() && matches!(record.kind, IntentKind::Delete | IntentKind::Copy) {
        // A tree half deleted or half copied is in neither state either -- the likelier story
        // than someone else changing it, though the disk cannot tell the two apart.
        item(
            record,
            Outcome::Partial,
            format!(
                "The {what} of {first} was interrupted partway (or it changed since). Nothing \
                 was touched; check it and finish or undo it by hand."
            ),
        )
    } else if !neither.is_empty() {
        item(
            record,
            Outcome::Conflict,
            format!(
                "The {what} of {first} was interrupted, and {} changed since. Nothing was \
                 touched.",
                neither.join(", ")
            ),
        )
    } else {
        item(
            record,
            Outcome::Partial,
            format!(
                "The {what} of {first} was interrupted partway. Nothing was touched; check it \
                 and finish or undo it by hand."
            ),
        )
    }
}

fn settle_save(record: &IntentRecord) -> RecoveryItem {
    let find = |role| record.effects.iter().find(|e| e.role == role);
    let (Some(target), Some(temporary)) = (find(Role::Target), find(Role::Temporary)) else {
        return settle_generic(record);
    };
    let (p, t) = (Path::new(&target.path), Path::new(&temporary.path));
    let saved = target.post.holds(p);
    let untouched = target.pre.holds(p);
    let temp_complete = temporary.post.holds(t);
    let temp_there = !is_absent(t);
    let file = &target.path;

    if saved {
        let _ = temp_there.then(|| remove_durably(t));
        return item(
            record,
            Outcome::Completed,
            format!("The save of {file} had completed."),
        );
    }
    if untouched && temp_complete {
        if replace_if_unchanged(p, t, &target.pre) {
            return item(
                record,
                Outcome::RolledForward,
                format!("Finished an interrupted save of {file}."),
            );
        }
        return item(
            record,
            Outcome::Conflict,
            format!(
                "An interrupted save of {file} could not be finished. The saved text is kept \
                 in {}.",
                temporary.path
            ),
        );
    }
    if untouched {
        let _ = temp_there.then(|| remove_durably(t));
        return item(
            record,
            if temp_there {
                Outcome::RolledBack
            } else {
                Outcome::NotApplied
            },
            format!("An interrupted save of {file} had not reached it; the file is unchanged."),
        );
    }
    // The target is neither what the save found nor what it wrote: changed by someone else.
    // It is not touched, and the saved text is kept if there is any.
    let kept = if temp_complete {
        format!(" The text Yavin was saving is kept in {}.", temporary.path)
    } else {
        String::new()
    };
    item(
        record,
        Outcome::Conflict,
        format!("A save of {file} was interrupted, and the file has changed since.{kept}"),
    )
}

/// Opens `path` so that, on Windows, no other program can read or write it while it is held --
/// only replace it, which is what recovery is about to do. Elsewhere this is an ordinary open:
/// POSIX has no mandatory locks, and the check-then-rename window is as small as it can be.
fn hold(path: &Path) -> std::io::Result<File> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_DELETE: u32 = 0x4;
        File::options()
            .read(true)
            .share_mode(FILE_SHARE_DELETE)
            .open(path)
    }
    #[cfg(not(windows))]
    File::open(path)
}

/// Moves `temporary` onto `target` only if `target` is still exactly the file `pre` records --
/// checked through a handle that keeps other writers out until the rename is done, so nothing
/// written in between can be overwritten. Only a recorded file hash can prove that: a save
/// whose "before" was not a known file is never finished automatically.
fn replace_if_unchanged(target: &Path, temporary: &Path, pre: &DiskState) -> bool {
    use std::io::Read;
    let DiskState::File { size, hash } = pre else {
        return false;
    };
    let Ok(mut held) = hold(target) else {
        // Held by someone else (it is being written right now), or gone.
        return false;
    };
    let mut bytes = Vec::new();
    if held.read_to_end(&mut bytes).is_err()
        || bytes.len() as u64 != *size
        || stable_hash(&bytes) != *hash
    {
        return false;
    }
    let replaced = fs::rename(temporary, target).is_ok();
    drop(held);
    replaced
}

fn settle_git(record: &IntentRecord) -> RecoveryItem {
    let root = record
        .effects
        .first()
        .map(|e| e.path.as_str())
        .unwrap_or("");
    // A clone records its destination as absent beforehand. Whatever is there now may be a
    // partial checkout: reported, never deleted.
    if record
        .effects
        .first()
        .is_some_and(|e| e.pre == DiskState::Absent)
    {
        return if is_absent(Path::new(root)) {
            item(
                record,
                Outcome::NotApplied,
                format!("A clone into {root} had not started."),
            )
        } else {
            item(
                record,
                Outcome::Partial,
                format!(
                    "A clone into {root} was interrupted. What is there may be incomplete; check \
                     it, or delete it and clone again."
                ),
            )
        };
    }
    let lock = Path::new(root).join(".git").join("index.lock");
    if lock.exists() {
        item(
            record,
            Outcome::Interrupted,
            format!(
                "A Git command in {root} was interrupted. Git's lock file {} remains; remove it \
                 once no Git command is running there.",
                lock.display()
            ),
        )
    } else {
        item(
            record,
            Outcome::Completed,
            format!("A Git command in {root} was running when Yavin stopped; Git shows no sign of an unfinished command."),
        )
    }
}

fn unresolved_folder(root: &Path) -> PathBuf {
    root.join("unresolved")
}

fn keep_unresolved(root: &Path, item: &RecoveryItem) -> Result<(), String> {
    write_json(
        &unresolved_folder(root).join(format!("{}.json", item.id)),
        item,
    )
}

/// Every item still needing the user, oldest first. An unreadable one is reported as corrupt
/// rather than dropped.
pub fn unresolved(root: &Path) -> Vec<RecoveryItem> {
    let Ok(entries) = fs::read_dir(unresolved_folder(root)) else {
        return Vec::new();
    };
    let mut items: Vec<RecoveryItem> = entries
        .flatten()
        .filter(|e| e.file_name().to_str().is_some_and(|n| n.ends_with(".json")))
        .map(|entry| {
            let path = entry.path();
            let id = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            fs::read_to_string(&path)
                .ok()
                .and_then(|text| serde_json::from_str::<RecoveryItem>(&text).ok())
                .unwrap_or(RecoveryItem {
                    version: RECORD_VERSION,
                    id,
                    kind: None,
                    outcome: Outcome::Corrupt,
                    paths: vec![path.to_string_lossy().into_owned()],
                    message: "A recovery note could not be read.".into(),
                    at: 0,
                })
        })
        .collect();
    items.sort_by(|a, b| (a.at, &a.id).cmp(&(b.at, &b.id)));
    if items.len() > UNRESOLVED_WARNING {
        eprintln!("{} unresolved recovery items are kept", items.len());
    }
    items
}

/// Removes the named unresolved items -- the user has dealt with them. Nothing else is ever
/// removed from `unresolved/`.
pub fn dismiss(root: &Path, ids: &[String]) -> Result<(), String> {
    for id in ids {
        if id.contains(['/', '\\']) || id.contains("..") || id.is_empty() {
            return Err(format!("Not a recovery item: {id}"));
        }
        remove_durably(&unresolved_folder(root).join(format!("{id}.json")))?;
    }
    Ok(())
}

/// Recovers every operation a dead Yavin process left in progress under `root`, skipping the
/// instance `own` (this process) and any other that is still running. Cost follows the number
/// of records, never the size of any project.
pub fn recover(root: &Path, own: &str) -> RecoveryReport {
    let mut report = RecoveryReport::default();
    let instances = root.join("instances");
    if let Ok(entries) = fs::read_dir(&instances) {
        let mut folders: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
        folders.sort();
        for folder in folders {
            let is_own = folder.file_name().and_then(|n| n.to_str()) == Some(own);
            if is_own || !folder.is_dir() {
                continue;
            }
            recover_instance(root, &folder, &mut report);
        }
    }
    sweep_stale_temps(root, STALE_TEMP_AGE);
    sweep_stale_temps(&unresolved_folder(root), STALE_TEMP_AGE);
    report.unresolved = unresolved(root);
    report
}

fn recover_instance(root: &Path, folder: &Path, report: &mut RecoveryReport) {
    let lock_path = folder.join("owner.lock");
    // Locking the owner's lock succeeds only if its owner is gone. Held for the whole
    // recovery, so a second Yavin starting at the same moment cannot recover it twice.
    let owner = match File::options().read(true).write(true).open(&lock_path) {
        Ok(file) => match file.try_lock() {
            Ok(()) => Some(file),
            Err(TryLockError::WouldBlock) => return,
            Err(TryLockError::Error(_)) => return,
        },
        // No lock file: an instance that died while being created, or already recovered.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        // Any other failure says nothing about whether its owner is alive. Leave it: the
        // records of a running Yavin must never be recovered by another.
        Err(_) => return,
    };
    let mut records: Vec<PathBuf> = fs::read_dir(folder)
        .map(|entries| {
            entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.starts_with("op-") && n.ends_with(".json"))
                })
                .collect()
        })
        .unwrap_or_default();
    records.sort();
    let mut all_settled = true;
    for path in records {
        let settled = match read_versioned(&path, RECORD_VERSION, json_version, parse_record) {
            Loaded::Current(record) | Loaded::Migrated { value: record, .. } => {
                let found = settle(&record);
                if found.outcome.unresolved() && keep_unresolved(root, &found).is_err() {
                    // Could not be written down: keep the record itself for next time.
                    all_settled = false;
                    continue;
                }
                let _ = remove_durably(&path);
                found
            }
            Loaded::Corrupt { backup } | Loaded::Future { backup, .. } => {
                let kept = backup.unwrap_or(path.clone());
                let found = RecoveryItem {
                    version: RECORD_VERSION,
                    id: format!(
                        "{}-{}",
                        folder
                            .file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or("unknown"),
                        path.file_stem()
                            .and_then(|s| s.to_str())
                            .unwrap_or("record")
                    ),
                    kind: None,
                    outcome: Outcome::Corrupt,
                    paths: vec![kept.to_string_lossy().into_owned()],
                    message: "A recovery record could not be read, so nothing was done with it. \
                              It is kept for inspection."
                        .into(),
                    at: now_millis() as u64,
                };
                if keep_unresolved(root, &found).is_err() {
                    all_settled = false;
                }
                found
            }
            Loaded::Missing => continue,
            // Locked or denied right now: not evidence of anything. Left exactly where it is,
            // with its folder, for the next start.
            Loaded::Unreadable => {
                all_settled = false;
                continue;
            }
        };
        report.actions.push(settled);
    }
    sweep_stale_temps(folder, Duration::ZERO);
    if all_settled {
        drop(owner);
        let _ = fs::remove_file(&lock_path);
        let _ = fs::remove_dir(folder);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temp(label: &str) -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "yavin-recovery-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn clean(path: &Path) -> String {
        crate::file_tree::clean_path_str(path)
    }

    /// A process that recorded `effects` and then died: its log dropped without closing the
    /// intent (so the record stays) and its lock released.
    fn crashed(root: &Path, kind: IntentKind, effects: Vec<Effect>) -> String {
        let log = IntentLog::open(root).unwrap();
        let intent = log.record(1, kind, effects).unwrap();
        std::mem::forget(intent);
        let instance = log.instance().to_string();
        drop(log);
        instance
    }

    fn only_action(report: &RecoveryReport) -> &RecoveryItem {
        assert_eq!(report.actions.len(), 1, "{report:?}");
        &report.actions[0]
    }

    /// A save that died at the point `stage`, as the save command records and performs it.
    fn save_crashed_at(root: &Path, dir: &Path, stage: u8) -> (PathBuf, PathBuf) {
        let target = dir.join("a.ts");
        fs::write(&target, "before").unwrap();
        let temporary = dir.join(".a.ts.tmp.1");
        let effects = vec![
            Effect::new(
                clean(&temporary),
                DiskState::Absent,
                DiskState::file(b"after"),
            )
            .role(Role::Temporary),
            Effect::new(
                clean(&target),
                DiskState::file(b"before"),
                DiskState::file(b"after"),
            ),
        ];
        crashed(root, IntentKind::Save, effects);
        match stage {
            0 => {}                                       // record written, nothing else
            1 => fs::write(&temporary, "af").unwrap(),    // temporary half written
            2 => fs::write(&temporary, "after").unwrap(), // temporary complete
            3 => fs::write(&target, "after").unwrap(),    // renamed onto the target
            _ => unreachable!(),
        }
        (target, temporary)
    }

    #[test]
    fn a_clean_start_has_nothing_to_do() {
        let root = temp("clean");
        let log = IntentLog::open(&root).unwrap();
        let report = recover(&root, log.instance());
        assert_eq!(report, RecoveryReport::default());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_save_is_settled_at_every_point_it_could_have_died() {
        for (stage, outcome, target_after, temp_left) in [
            (0, Outcome::NotApplied, "before", false),
            (1, Outcome::RolledBack, "before", false),
            (2, Outcome::RolledForward, "after", false),
            (3, Outcome::Completed, "after", false),
        ] {
            let root = temp("save");
            let dir = temp("save-files");
            let (target, temporary) = save_crashed_at(&root, &dir, stage);
            let report = recover(&root, "me");
            assert_eq!(only_action(&report).outcome, outcome, "stage {stage}");
            assert_eq!(
                fs::read_to_string(&target).unwrap(),
                target_after,
                "stage {stage}"
            );
            assert_eq!(temporary.exists(), temp_left, "stage {stage}");
            assert!(report.unresolved.is_empty());
            // Settled: nothing is left to recover next time.
            assert!(recover(&root, "me").actions.is_empty());
            fs::remove_dir_all(&root).ok();
            fs::remove_dir_all(&dir).ok();
        }
    }

    #[test]
    fn a_file_changed_since_the_crash_is_never_overwritten_and_the_saved_text_is_kept() {
        let root = temp("conflict");
        let dir = temp("conflict-files");
        let (target, temporary) = save_crashed_at(&root, &dir, 2);
        // Another program edits the file before Yavin restarts -- same length, other bytes.
        fs::write(&target, "BEFORE").unwrap();
        let report = recover(&root, "me");
        let found = only_action(&report);
        assert_eq!(found.outcome, Outcome::Conflict);
        assert_eq!(fs::read_to_string(&target).unwrap(), "BEFORE");
        assert_eq!(
            fs::read_to_string(&temporary).unwrap(),
            "after",
            "kept, not deleted"
        );
        assert!(found.message.contains(&clean(&temporary)));
        // Kept until the user dismisses it -- across starts, whatever its age.
        assert_eq!(report.unresolved.len(), 1);
        assert_eq!(recover(&root, "me").unresolved.len(), 1);
        dismiss(&root, std::slice::from_ref(&found.id)).unwrap();
        assert!(recover(&root, "me").unresolved.is_empty());
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_multi_path_operation_is_judged_as_a_whole() {
        let dir = temp("whole-files");
        let (old, new) = (dir.join("old.ts"), dir.join("new.ts"));
        let effects = || {
            vec![
                Effect::new(clean(&old), DiskState::Present, DiskState::Absent),
                Effect::new(clean(&new), DiskState::Absent, DiskState::Present),
            ]
        };
        let outcome_with = |old_there: bool, new_there: bool| {
            let root = temp("whole");
            let _ = fs::remove_file(&old);
            let _ = fs::remove_file(&new);
            if old_there {
                fs::write(&old, "x").unwrap();
            }
            crashed(&root, IntentKind::Rename, effects());
            if new_there {
                fs::write(&new, "x").unwrap();
            }
            if !old_there {
                let _ = fs::remove_file(&old);
            }
            let outcome = only_action(&recover(&root, "me")).outcome;
            fs::remove_dir_all(&root).ok();
            outcome
        };
        assert_eq!(outcome_with(true, false), Outcome::NotApplied);
        assert_eq!(outcome_with(false, true), Outcome::Completed);
        // Both there: `old` is in its pre state, `new` in its post state -- partway, and not
        // settled one path at a time.
        assert_eq!(outcome_with(true, true), Outcome::Partial);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_interrupted_delete_or_copy_is_reported_and_never_touched() {
        let dir = temp("partial-files");
        let folder = dir.join("gone");
        fs::create_dir_all(folder.join("a")).unwrap();
        fs::write(folder.join("a/1.ts"), "1").unwrap();
        fs::write(folder.join("2.ts"), "2").unwrap();
        let root = temp("partial");
        crashed(
            &root,
            IntentKind::Delete,
            vec![Effect::new(
                clean(&folder),
                DiskState::observe_tree(&folder),
                DiskState::Absent,
            )],
        );
        // It died halfway through deleting.
        fs::remove_file(folder.join("2.ts")).unwrap();
        let found = only_action(&recover(&root, "me")).clone();
        assert_eq!(found.outcome, Outcome::Partial);
        assert!(folder.join("a/1.ts").exists(), "nothing more is deleted");

        let source = dir.join("src");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("x.ts"), "x").unwrap();
        fs::write(source.join("y.ts"), "y").unwrap();
        let copy = dir.join("src_copy");
        let root = temp("partial-copy");
        crashed(
            &root,
            IntentKind::Copy,
            vec![Effect::new(
                clean(&copy),
                DiskState::Absent,
                DiskState::CopyOf {
                    source: clean(&source),
                },
            )],
        );
        fs::create_dir_all(&copy).unwrap();
        fs::write(copy.join("x.ts"), "x").unwrap();
        let found = only_action(&recover(&root, "me")).clone();
        assert_eq!(found.outcome, Outcome::Partial, "{found:?}");
        assert!(
            copy.join("x.ts").exists(),
            "the partial copy is left as it is"
        );
        // Complete after all: settled quietly.
        let root = temp("full-copy");
        crashed(
            &root,
            IntentKind::Copy,
            vec![Effect::new(
                clean(&copy),
                DiskState::Absent,
                DiskState::CopyOf {
                    source: clean(&source),
                },
            )],
        );
        fs::write(copy.join("y.ts"), "y").unwrap();
        assert_eq!(
            only_action(&recover(&root, "me")).outcome,
            Outcome::Completed
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_interrupted_git_command_is_reported_only_while_its_lock_remains() {
        let dir = temp("git-files");
        fs::create_dir_all(dir.join(".git")).unwrap();
        let effects = || {
            vec![Effect::new(
                clean(&dir),
                DiskState::Unknown,
                DiskState::Unknown,
            )]
        };
        let root = temp("git");
        crashed(&root, IntentKind::Git, effects());
        fs::write(dir.join(".git/index.lock"), "").unwrap();
        assert_eq!(
            only_action(&recover(&root, "me")).outcome,
            Outcome::Interrupted
        );
        fs::remove_file(dir.join(".git/index.lock")).unwrap();
        let root = temp("git-clean");
        crashed(&root, IntentKind::Git, effects());
        assert_eq!(
            only_action(&recover(&root, "me")).outcome,
            Outcome::Completed
        );

        // A clone: nothing there is "not started"; anything there is reported, not deleted.
        let destination = dir.join("cloned");
        let clone = || {
            vec![Effect::new(
                clean(&destination),
                DiskState::Absent,
                DiskState::Present,
            )]
        };
        let root = temp("clone-none");
        crashed(&root, IntentKind::Git, clone());
        assert_eq!(
            only_action(&recover(&root, "me")).outcome,
            Outcome::NotApplied
        );
        let root = temp("clone-partial");
        crashed(&root, IntentKind::Git, clone());
        fs::create_dir_all(destination.join(".git")).unwrap();
        assert_eq!(only_action(&recover(&root, "me")).outcome, Outcome::Partial);
        assert!(destination.join(".git").exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_corrupt_truncated_or_future_record_is_kept_and_reported_never_acted_on() {
        let dir = temp("bad-files");
        let target = dir.join("a.ts");
        fs::write(&target, "untouched").unwrap();
        for (label, text) in [
            ("truncated", r#"{"version":1,"instance":"x","opera"#.to_string()),
            ("garbage", "not json".to_string()),
            ("wrong-hash", r#"{"version":1,"instance":"x","operation":1,"kind":"save","startedAt":0,"hash":"sha1","effects":[]}"#.to_string()),
            ("future", r#"{"version":9,"everything":"different"}"#.to_string()),
        ] {
            let root = temp(label);
            let folder = root.join("instances").join(format!("dead-{label}"));
            fs::create_dir_all(&folder).unwrap();
            fs::write(folder.join("op-1.json"), &text).unwrap();
            let report = recover(&root, "me");
            let found = only_action(&report);
            assert_eq!(found.outcome, Outcome::Corrupt, "{label}");
            assert_eq!(report.unresolved.len(), 1, "{label}");
            let kept = &found.paths[0];
            assert_eq!(fs::read_to_string(kept).unwrap(), text, "{label}: kept intact");
            fs::remove_dir_all(&root).ok();
        }
        assert_eq!(fs::read_to_string(&target).unwrap(), "untouched");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_running_yavins_records_are_never_recovered_by_another() {
        let root = temp("live");
        let dir = temp("live-files");
        let live = IntentLog::open(&root).unwrap();
        let target = dir.join("a.ts");
        fs::write(&target, "before").unwrap();
        let intent = live
            .record(
                1,
                IntentKind::Save,
                vec![Effect::new(
                    clean(&target),
                    DiskState::file(b"before"),
                    DiskState::file(b"after"),
                )],
            )
            .unwrap();
        // A second Yavin starting now must leave the first one's operation alone.
        let other = IntentLog::open(&root).unwrap();
        assert!(recover(&root, other.instance()).actions.is_empty());
        intent.close();
        drop(live);
        // Once it has gone -- having closed its record -- there is nothing to do but tidy up.
        assert!(recover(&root, other.instance()).actions.is_empty());
        let instances: Vec<_> = fs::read_dir(root.join("instances")).unwrap().collect();
        assert_eq!(
            instances.len(),
            1,
            "only the running instance's folder is left"
        );
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn records_are_bounded_and_every_operation_has_its_own() {
        let root = temp("bounded");
        let log = IntentLog::open(&root).unwrap();
        let mut open = Vec::new();
        for id in 0..MAX_LIVE_RECORDS as u64 {
            open.push(log.record(id, IntentKind::Delete, vec![]).unwrap());
        }
        assert!(log.record(9999, IntentKind::Delete, vec![]).is_err());
        let records = fs::read_dir(root.join("instances").join(log.instance()))
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with("op-")
            })
            .count();
        assert_eq!(records, MAX_LIVE_RECORDS);
        for intent in open {
            intent.close();
        }
        assert!(log.record(9999, IntentKind::Delete, vec![]).is_ok_and(|i| {
            i.close();
            true
        }));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_record_that_cannot_be_written_refuses_the_operation() {
        let root = temp("unwritable");
        let log = IntentLog::open(&root).unwrap();
        // A folder where the record file would go makes the durable write fail.
        fs::create_dir_all(
            root.join("instances")
                .join(log.instance())
                .join("op-5.json"),
        )
        .unwrap();
        assert!(log.record(5, IntentKind::Save, vec![]).is_err());
        // And the failed attempt does not count against the bound.
        assert_eq!(*log.live.lock().unwrap(), 0);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn an_intent_dropped_without_closing_is_left_for_the_next_start() {
        let root = temp("panic");
        let log = IntentLog::open(&root).unwrap();
        {
            let _intent = log.record(3, IntentKind::Delete, vec![]).unwrap();
            // A panic mid-operation unwinds through here.
        }
        let record = root
            .join("instances")
            .join(log.instance())
            .join("op-3.json");
        assert!(record.exists());
        assert_eq!(*log.live.lock().unwrap(), 0);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn records_hold_paths_sizes_and_hashes_never_contents() {
        let root = temp("contents");
        let log = IntentLog::open(&root).unwrap();
        let secret = b"password=hunter2";
        let intent = log
            .record(
                1,
                IntentKind::Save,
                vec![Effect::new(
                    "/w/a",
                    DiskState::Absent,
                    DiskState::file(secret),
                )],
            )
            .unwrap();
        let text = fs::read_to_string(
            root.join("instances")
                .join(log.instance())
                .join("op-1.json"),
        )
        .unwrap();
        assert!(!text.contains("hunter2"));
        assert!(text.contains(HASH_ALGORITHM));
        intent.close();
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn dismissing_touches_only_the_named_unresolved_items() {
        let root = temp("dismiss");
        assert!(dismiss(&root, &["../../etc".into()]).is_err());
        assert!(dismiss(&root, &["a/b".into()]).is_err());
        dismiss(&root, &["not-there".into()]).unwrap();
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn an_instance_whose_lock_cannot_be_opened_is_left_alone() {
        let root = temp("unknown-owner");
        let dir = temp("unknown-owner-files");
        let target = dir.join("a.ts");
        fs::write(&target, "before").unwrap();
        let folder = root.join("instances").join("someone");
        // The lock is there but cannot be opened: that says nothing about whether its owner is
        // alive, so its records must not be touched.
        fs::create_dir_all(folder.join("owner.lock")).unwrap();
        let record = IntentRecord {
            version: RECORD_VERSION,
            instance: "someone".into(),
            operation: 1,
            kind: IntentKind::Delete,
            started_at: 0,
            hash: HASH_ALGORITHM.into(),
            effects: vec![Effect::new(
                clean(&target),
                DiskState::Present,
                DiskState::Absent,
            )],
        };
        write_json(&folder.join("op-1.json"), &record).unwrap();
        let report = recover(&root, "me");
        assert!(report.actions.is_empty(), "{report:?}");
        assert!(folder.join("op-1.json").exists());
        assert!(target.exists());
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_save_is_finished_only_from_a_recorded_file_never_from_nothing() {
        // A save whose "before" was not a known file (it could not be read) is not finished
        // automatically, even with its temporary file complete: kept and reported instead.
        let root = temp("pre-absent");
        let dir = temp("pre-absent-files");
        let target = dir.join("a.ts");
        let temporary = dir.join(".a.ts.tmp.1");
        crashed(
            &root,
            IntentKind::Save,
            vec![
                Effect::new(
                    clean(&temporary),
                    DiskState::Absent,
                    DiskState::file(b"after"),
                )
                .role(Role::Temporary),
                Effect::new(clean(&target), DiskState::Absent, DiskState::file(b"after")),
            ],
        );
        fs::write(&temporary, "after").unwrap();
        let found = only_action(&recover(&root, "me")).clone();
        assert_eq!(found.outcome, Outcome::Conflict);
        assert!(!target.exists());
        assert_eq!(fs::read_to_string(&temporary).unwrap(), "after", "kept");
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&dir).ok();
    }

    /// While another program has the target open for writing, recovery cannot hold it, so it
    /// cannot rule out a write landing between its check and its rename: it does not finish
    /// the save.
    #[cfg(windows)]
    #[test]
    fn a_target_another_program_is_writing_is_never_replaced() {
        let root = temp("held");
        let dir = temp("held-files");
        let (target, temporary) = save_crashed_at(&root, &dir, 2);
        let writer = File::options().write(true).open(&target).unwrap();
        let found = only_action(&recover(&root, "me")).clone();
        drop(writer);
        assert_eq!(found.outcome, Outcome::Conflict);
        assert_eq!(fs::read_to_string(&target).unwrap(), "before");
        assert_eq!(fs::read_to_string(&temporary).unwrap(), "after", "kept");
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&dir).ok();
    }
}
