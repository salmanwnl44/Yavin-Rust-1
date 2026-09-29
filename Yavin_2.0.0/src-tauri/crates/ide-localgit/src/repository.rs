//! A workspace's Local Git store: opening it (as its one writer, or read-only), its objects,
//! refs and reflog, and the invariants that hold across crashes.
//!
//! ```text
//! <base>/<key>/                  key = slug + hash of the WorkspaceId (workspace.rs)
//!   workspace.json               identity, format, folders (strict; never recreated over data)
//!   repo.lock                    held (File::try_lock) by the one writer for as long as it is open
//!   refs.json                    HEAD + refs + revision, replaced atomically (write_durably)
//!   logs/refs.log                append-only reflog, written before refs.json
//!   objects/seg-NNNNNNNN.ylseg   immutable segments
//!   tmp/                         segments being written (swept by the writer at open)
//!   cache/                       disposable (later phases)
//!   quarantine/                  copies of anything found damaged; never deleted automatically
//! ```

use crate::error::{LgError, Result};
use crate::fault::{self, FaultPoint};
use crate::finding::{hex, Finding, InterruptedUpdate};
use crate::id::{hash_object, ObjectId, ObjectKind};
use crate::object::{Commit, EntryKind, Root, Stored, Tree};
use crate::odb::ObjectDb;
use crate::reflog::{self, ReflogRecord};
use crate::refs::{Head, RefUpdate, RefsState};
use crate::segment::SegmentWriter;
use crate::workspace::WorkspaceSpec;
use ide_workspace::durable::{now_millis, sweep_stale_temps, write_durably};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File, OpenOptions as FileOptions};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// The layout this code reads and writes.
pub const FORMAT_VERSION: u64 = 1;
const META_VERSION: u64 = 1;
/// The default storage limit for one file's content: larger files are hashed, not stored.
pub const DEFAULT_MAX_BLOB_BYTES: u64 = 20 * 1024 * 1024;
/// The most bytes an object other than a blob may be: trees, roots and commits are small.
const MAX_METADATA_OBJECT: u64 = 64 * 1024 * 1024;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ReadOnlyReason {
    /// Another process holds the writer lock (another Yavin window on the same workspace).
    HeldByOtherProcess,
    /// Opened read-only on purpose.
    Requested,
}

/// What this handle may do. A read-only store can read, list and verify, and every mutation
/// returns `LgError::ReadOnly`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    Writer,
    ReadOnly(ReadOnlyReason),
}

#[derive(Clone, Copy, Default, Debug)]
pub struct OpenOptions {
    /// Never take the writer lock.
    pub read_only: bool,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct FolderRecord {
    /// Stable for the life of the store: how objects name this folder.
    pub folder_id: String,
    pub resource_id: String,
    pub path: String,
}

/// `workspace.json`.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct WorkspaceMeta {
    pub format: u64,
    pub created_ms: u64,
    /// `ws-…`: the workspace in commits, never a path.
    pub workspace: String,
    pub workspace_id: String,
    pub folders: Vec<FolderRecord>,
    pub max_blob_bytes: u64,
}

impl WorkspaceMeta {
    fn to_json(&self) -> String {
        let folders: Vec<Value> = self
            .folders
            .iter()
            .map(
                |f| json!({ "folderId": f.folder_id, "resourceId": f.resource_id, "path": f.path }),
            )
            .collect();
        serde_json::to_string_pretty(&json!({
            "version": META_VERSION,
            "format": self.format,
            "hash": crate::id::HASH_ALGORITHM,
            "createdMs": self.created_ms,
            "workspace": self.workspace,
            "workspaceId": self.workspace_id,
            "folders": folders,
            "settings": { "maxBlobBytes": self.max_blob_bytes },
        }))
        .expect("workspace.json serialises")
    }

    fn parse(text: &str) -> Result<WorkspaceMeta> {
        Self::parse_inner(text).map_err(|error| match error {
            LgError::UnsupportedVersion { .. } | LgError::InvalidFormat(_) => error,
            other => LgError::InvalidFormat(format!("workspace.json: {other}")),
        })
    }

    fn parse_inner(text: &str) -> Result<WorkspaceMeta> {
        let bad = |why: &str| LgError::InvalidFormat(format!("workspace.json: {why}"));
        let value: Value = serde_json::from_str(text).map_err(|e| bad(&e.to_string()))?;
        let number = |key: &str| value.get(key).and_then(Value::as_u64);
        let text_of = |value: &Value, key: &str| {
            value
                .get(key)
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or_else(|| bad(&format!("no {key}")))
        };
        let version = number("version").ok_or_else(|| bad("no version"))?;
        let format = number("format").ok_or_else(|| bad("no format"))?;
        for (what, found, supported) in [
            ("workspace.json", version, META_VERSION),
            ("the Local Git format", format, FORMAT_VERSION),
        ] {
            if found > supported {
                return Err(LgError::UnsupportedVersion {
                    what: what.into(),
                    found,
                    supported,
                });
            }
        }
        let hash = text_of(&value, "hash")?;
        if hash != crate::id::HASH_ALGORITHM {
            return Err(LgError::UnsupportedVersion {
                what: format!("hash algorithm {hash}"),
                found: 0,
                supported: 0,
            });
        }
        let mut folders = Vec::new();
        for folder in value
            .get("folders")
            .and_then(Value::as_array)
            .ok_or_else(|| bad("no folders"))?
        {
            let record = FolderRecord {
                folder_id: text_of(folder, "folderId")?,
                resource_id: text_of(folder, "resourceId")?,
                path: text_of(folder, "path")?,
            };
            crate::object::FolderId::new(&record.folder_id)?;
            folders.push(record);
        }
        if folders.is_empty() {
            return Err(bad("no folders"));
        }
        Ok(WorkspaceMeta {
            format,
            created_ms: number("createdMs").unwrap_or(0),
            workspace: text_of(&value, "workspace")?,
            workspace_id: text_of(&value, "workspaceId")?,
            folders,
            max_blob_bytes: value
                .get("settings")
                .and_then(|s| s.get("maxBlobBytes"))
                .and_then(Value::as_u64)
                .unwrap_or(DEFAULT_MAX_BLOB_BYTES),
        })
    }
}

/// An object as stored, decoded.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Object {
    Blob(Vec<u8>),
    Tree(Tree),
    Root(Root),
    Commit(Box<Commit>),
}

pub struct Repository {
    dir: PathBuf,
    key: String,
    mode: Mode,
    /// Held for as long as this is the writer; the OS releases it if the process dies.
    _lock: Option<File>,
    meta: WorkspaceMeta,
    odb: ObjectDb,
    refs: RefsState,
    /// The highest revision the reflog has used, applied or not: the next update is above it.
    reflog_revision: u64,
    findings: Vec<Finding>,
}

impl std::fmt::Debug for Repository {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Repository")
            .field("key", &self.key)
            .field("mode", &self.mode)
            .finish()
    }
}

/// Reads a file that must be exactly right. Missing is `None`; unreadable content is an error,
/// never "empty". When the writer finds it damaged (not merely newer), a copy goes to
/// `quarantine/` -- the original stays where it is, so every later open fails the same way
/// until someone decides, and nothing is lost.
fn read_strict<T>(
    path: &Path,
    quarantine: Option<&Path>,
    parse: impl Fn(&str) -> Result<T>,
) -> Result<Option<T>> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let parsed = std::str::from_utf8(&bytes)
        .map_err(|_| LgError::InvalidFormat(format!("{} is not UTF-8", path.display())))
        .and_then(&parse);
    match parsed {
        Ok(value) => Ok(Some(value)),
        Err(error) => {
            if let (Some(dir), LgError::InvalidFormat(_)) = (quarantine, &error) {
                quarantine_copy(dir, path, &bytes, "corrupt");
            }
            Err(error)
        }
    }
}

/// Copies damaged bytes aside, named by their content, so the same damage is kept once.
fn quarantine_copy(dir: &Path, original: &Path, bytes: &[u8], reason: &str) -> Option<String> {
    let digest = Sha256::digest(bytes);
    let short: String = digest.iter().take(6).map(|b| format!("{b:02x}")).collect();
    let name = format!(
        "{}.{short}.{reason}",
        original.file_name()?.to_string_lossy()
    );
    let target = dir.join(&name);
    if !target.exists() {
        fs::create_dir_all(dir).ok()?;
        fs::write(&target, bytes).ok()?;
    }
    Some(name)
}

fn new_folder_id(resource_id: &str, index: usize) -> String {
    let digest = Sha256::digest(
        format!(
            "{resource_id}\0{index}\0{}\0{}",
            now_millis(),
            std::process::id()
        )
        .as_bytes(),
    );
    let hex: String = digest.iter().take(6).map(|b| format!("{b:02x}")).collect();
    format!("f-{hex}")
}

impl Repository {
    /// Opens `spec`'s store under `base`, creating it on first use. The first process to open
    /// a store is its writer; while it holds it, others open it read-only. A store that belongs
    /// to another workspace, is damaged, or was written by a newer Yavin is refused -- never
    /// recreated, reset or read as empty.
    pub fn open(base: &Path, spec: &WorkspaceSpec, options: OpenOptions) -> Result<Repository> {
        let key = spec.key();
        let dir = base.join(&key);
        fs::create_dir_all(&dir)?;
        let (mode, lock) = if options.read_only {
            (Mode::ReadOnly(ReadOnlyReason::Requested), None)
        } else {
            let lock = FileOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(dir.join("repo.lock"))?;
            match lock.try_lock() {
                Ok(()) => (Mode::Writer, Some(lock)),
                Err(std::fs::TryLockError::WouldBlock) => {
                    (Mode::ReadOnly(ReadOnlyReason::HeldByOtherProcess), None)
                }
                Err(std::fs::TryLockError::Error(error)) => return Err(error.into()),
            }
        };
        let writer = mode == Mode::Writer;
        let quarantine = dir.join("quarantine");
        let quarantine_dir = writer.then_some(quarantine.as_path());
        let mut findings = Vec::new();

        // Only the writer may clean up, and it is the only process that could have left these.
        if writer {
            let removed = sweep_stale_temps(&dir, Duration::ZERO)
                + sweep_stale_temps(&dir.join("tmp"), Duration::ZERO);
            if removed > 0 {
                findings.push(Finding::StaleTempsRemoved { count: removed });
            }
        }

        let meta_path = dir.join("workspace.json");
        let refs_path = dir.join("refs.json");
        let log_path = dir.join("logs").join("refs.log");
        let objects_dir = dir.join("objects");
        let has_data = refs_path.exists()
            || log_path.exists()
            || fs::read_dir(&objects_dir)
                .map(|mut entries| entries.next().is_some())
                .unwrap_or(false);

        let meta =
            match read_strict(&meta_path, quarantine_dir, WorkspaceMeta::parse)? {
                Some(meta) => {
                    if meta.workspace_id != spec.workspace_id {
                        return Err(LgError::WorkspaceMismatch {
                            stored: meta.workspace_id,
                            expected: spec.workspace_id.clone(),
                        });
                    }
                    let stored: HashSet<&str> = meta
                        .folders
                        .iter()
                        .map(|f| f.resource_id.as_str())
                        .collect();
                    let wanted: HashSet<&str> = spec
                        .folders
                        .iter()
                        .map(|f| f.resource_id.as_str())
                        .collect();
                    if stored != wanted {
                        return Err(LgError::WorkspaceMismatch {
                            stored: meta.workspace_id,
                            expected: spec.workspace_id.clone(),
                        });
                    }
                    meta
                }
                None if has_data => return Err(LgError::RecoveryRequired(
                    "workspace.json is missing but the store has data; it is not recreated over it"
                        .into(),
                )),
                None if !writer => {
                    return Err(LgError::RecoveryRequired(
                        "the store has not been created yet and this handle is read-only".into(),
                    ))
                }
                None => {
                    let meta = WorkspaceMeta {
                        format: FORMAT_VERSION,
                        created_ms: now_millis() as u64,
                        workspace: spec.hash_id(),
                        workspace_id: spec.workspace_id.clone(),
                        folders: spec
                            .folders
                            .iter()
                            .enumerate()
                            .map(|(i, f)| FolderRecord {
                                folder_id: new_folder_id(&f.resource_id, i),
                                resource_id: f.resource_id.clone(),
                                path: f.path.clone(),
                            })
                            .collect(),
                        max_blob_bytes: DEFAULT_MAX_BLOB_BYTES,
                    };
                    write_durably(&meta_path, meta.to_json().as_bytes()).map_err(LgError::Io)?;
                    meta
                }
            };

        let (odb, segment_findings) = ObjectDb::load(&objects_dir, quarantine_dir)?;
        findings.extend(segment_findings);

        let refs = match read_strict(&refs_path, quarantine_dir, RefsState::parse)? {
            Some(refs) => refs,
            None => {
                // Only a store that never got past creation has no refs: anything else lost
                // them, and inventing an empty history over existing data is refused.
                if log_path.exists() || odb.object_count() > 0 {
                    return Err(LgError::RecoveryRequired(
                        "refs.json is missing but the store has history; it is not recreated"
                            .into(),
                    ));
                }
                let initial = RefsState::initial();
                if writer {
                    write_durably(&refs_path, initial.to_json().as_bytes()).map_err(LgError::Io)?;
                }
                initial
            }
        };

        let mut repository = Repository {
            dir,
            key,
            mode,
            _lock: lock,
            meta,
            odb,
            refs,
            reflog_revision: 0,
            findings,
        };
        repository.reconcile_reflog(&quarantine)?;
        repository.findings.extend(repository.dangling_refs());
        Ok(repository)
    }

    /// Compares the reflog with `refs.json` after a possible crash. An update the reflog has
    /// and `refs.json` does not was never applied: it is reported and marked aborted, never
    /// completed. A half-written last line is copied aside and removed.
    fn reconcile_reflog(&mut self, quarantine: &Path) -> Result<()> {
        let log_path = self.log_path();
        let mut read = reflog::read(&log_path)?;
        let writer = self.mode == Mode::Writer;
        if read.torn {
            let mut quarantined = None;
            if writer {
                let bytes = fs::read(&log_path)?;
                quarantined = quarantine_copy(quarantine, &log_path, &bytes, "torn");
                let file = FileOptions::new().write(true).open(&log_path)?;
                file.set_len(read.complete_len)?;
                file.sync_data()?;
                read.torn = false;
            }
            self.findings.push(Finding::TornReflog { quarantined });
        }
        let aborted: HashSet<u64> = read
            .records
            .iter()
            .filter_map(|record| match record {
                ReflogRecord::Aborted { revision, .. } => Some(*revision),
                _ => None,
            })
            .collect();
        let highest = read
            .records
            .iter()
            .map(ReflogRecord::revision)
            .max()
            .unwrap_or(0);
        self.reflog_revision = highest;
        let mut interrupted: BTreeMap<u64, Vec<InterruptedUpdate>> = BTreeMap::new();
        for record in &read.records {
            if let ReflogRecord::Update {
                revision,
                name,
                old,
                new,
                ..
            } = record
            {
                if *revision > self.refs.revision {
                    interrupted
                        .entry(*revision)
                        .or_default()
                        .push(InterruptedUpdate {
                            name: name.clone(),
                            old: old.clone(),
                            new: new.clone(),
                        });
                }
            }
        }
        let mut markers = Vec::new();
        for (revision, updates) in interrupted {
            if !aborted.contains(&revision) {
                markers.push(ReflogRecord::Aborted {
                    revision,
                    ms: now_millis() as u64,
                });
            }
            self.findings
                .push(Finding::InterruptedRefUpdate { revision, updates });
        }
        if writer && !markers.is_empty() {
            reflog::append(&log_path, &markers)?;
        }
        let applied = read
            .records
            .iter()
            .filter(|record| matches!(record, ReflogRecord::Update { .. }))
            .map(ReflogRecord::revision)
            .filter(|revision| !aborted.contains(revision) && *revision <= self.refs.revision)
            .max()
            .unwrap_or(0);
        if self.refs.revision > applied && self.refs.revision > 0 {
            self.findings.push(Finding::ReflogBehind {
                refs: self.refs.revision,
                reflog: applied,
            });
        }
        Ok(())
    }

    fn dangling_refs(&self) -> Vec<Finding> {
        let mut found = Vec::new();
        for (name, id) in &self.refs.refs {
            if !self.odb.contains(id) {
                found.push(Finding::DanglingRef {
                    name: name.as_str().into(),
                    id: id.to_hex(),
                });
            }
        }
        if let Head::Detached(id) = &self.refs.head {
            if !self.odb.contains(id) {
                found.push(Finding::DanglingRef {
                    name: "HEAD".into(),
                    id: id.to_hex(),
                });
            }
        }
        found
    }

    fn log_path(&self) -> PathBuf {
        self.dir.join("logs").join("refs.log")
    }

    fn require_writer(&self) -> Result<()> {
        match self.mode {
            Mode::Writer => Ok(()),
            Mode::ReadOnly(_) => Err(LgError::ReadOnly),
        }
    }

    // --- Reading ---------------------------------------------------------------------------

    /// `cache/`: disposable data a later open may use to go faster (the snapshot scan cache).
    /// Nothing in it is ever needed for correctness.
    pub fn cache_dir(&self) -> PathBuf {
        self.dir.join("cache")
    }

    pub fn key(&self) -> &str {
        &self.key
    }

    pub fn mode(&self) -> Mode {
        self.mode
    }

    pub fn meta(&self) -> &WorkspaceMeta {
        &self.meta
    }

    pub fn refs(&self) -> &RefsState {
        &self.refs
    }

    pub fn findings(&self) -> &[Finding] {
        &self.findings
    }

    pub fn object_count(&self) -> usize {
        self.odb.object_count()
    }

    pub fn segment_count(&self) -> usize {
        self.odb.segment_count()
    }

    pub fn storage_bytes(&self) -> u64 {
        self.odb.storage_bytes()
    }

    pub fn contains(&self, id: &ObjectId) -> bool {
        self.odb.contains(id)
    }

    /// Any object except a blob, decoded (blobs can be large: use `read_blob`).
    pub fn object(&self, id: &ObjectId) -> Result<Object> {
        let (kind, bytes) = self.odb.read(id, MAX_METADATA_OBJECT)?;
        Ok(match kind {
            ObjectKind::Blob => Object::Blob(bytes),
            ObjectKind::Tree => Object::Tree(Tree::decode(&bytes)?),
            ObjectKind::Root => Object::Root(Root::decode(&bytes)?),
            ObjectKind::Commit => Object::Commit(Box::new(Commit::decode(&bytes)?)),
        })
    }

    fn expect_kind(&self, id: &ObjectId, expected: ObjectKind) -> Result<()> {
        match self.odb.kind_of(id) {
            None => Err(LgError::MissingObject(*id)),
            Some(kind) if kind == expected => Ok(()),
            Some(kind) => Err(LgError::WrongKind {
                id: *id,
                expected: expected.name(),
                found: kind.name(),
            }),
        }
    }

    pub fn read_tree(&self, id: &ObjectId) -> Result<Tree> {
        self.expect_kind(id, ObjectKind::Tree)?;
        match self.object(id)? {
            Object::Tree(tree) => Ok(tree),
            _ => unreachable!("checked kind"),
        }
    }

    pub fn read_root(&self, id: &ObjectId) -> Result<Root> {
        self.expect_kind(id, ObjectKind::Root)?;
        match self.object(id)? {
            Object::Root(root) => Ok(root),
            _ => unreachable!("checked kind"),
        }
    }

    pub fn read_commit(&self, id: &ObjectId) -> Result<Commit> {
        self.expect_kind(id, ObjectKind::Commit)?;
        match self.object(id)? {
            Object::Commit(commit) => Ok(*commit),
            _ => unreachable!("checked kind"),
        }
    }

    /// A blob's bytes, refused over `max_len`.
    pub fn read_blob(&self, id: &ObjectId, max_len: u64) -> Result<Vec<u8>> {
        self.expect_kind(id, ObjectKind::Blob)?;
        Ok(self.odb.read(id, max_len)?.1)
    }

    /// A file entry's content: its blob, or `ContentUnavailable` for a file that was hashed but
    /// deliberately not stored -- never "missing", never empty.
    pub fn read_file(&self, kind: &EntryKind, id: &ObjectId, max_len: u64) -> Result<Vec<u8>> {
        if let EntryKind::File {
            stored: Stored::No { .. },
            ..
        } = kind
        {
            return Err(LgError::ContentUnavailable(*id));
        }
        self.read_blob(id, max_len)
    }

    /// Streams a blob into `out`, 64 KiB at a time, checking it at the end.
    pub fn stream_blob(&self, id: &ObjectId, out: &mut impl std::io::Write) -> Result<u64> {
        self.expect_kind(id, ObjectKind::Blob)?;
        self.odb.stream(id, out)
    }

    /// A blob's size and whether it looks binary (a NUL in its first 8 KiB, the rule the
    /// editor's own file reading uses).
    /// An object's kind and size, from the segment index (nothing is read or hashed).
    pub fn object_info(&self, id: &ObjectId) -> Result<(ObjectKind, u64)> {
        self.odb.info(id)
    }

    pub fn blob_info(&self, id: &ObjectId) -> Result<(u64, bool)> {
        self.expect_kind(id, ObjectKind::Blob)?;
        let (_, size) = self.odb.info(id)?;
        let mut head = PrefixWriter {
            bytes: Vec::new(),
            limit: 8192,
        };
        // Streams the whole blob to check its hash, keeping only the first 8 KiB.
        self.odb.stream(id, &mut head)?;
        Ok((size, head.bytes.contains(&0)))
    }

    pub fn reflog(&self) -> Result<Vec<ReflogRecord>> {
        Ok(reflog::read(&self.log_path())?.records)
    }

    /// Re-reads refs and segments: how a read-only handle sees what the writer published.
    pub fn reload(&mut self) -> Result<()> {
        let quarantine = self.dir.join("quarantine");
        let writer = self.mode == Mode::Writer;
        let (odb, _) = ObjectDb::load(
            &self.dir.join("objects"),
            writer.then_some(quarantine.as_path()),
        )?;
        let refs = read_strict(&self.dir.join("refs.json"), None, RefsState::parse)?
            .ok_or_else(|| LgError::RecoveryRequired("refs.json disappeared".into()))?;
        self.odb = odb;
        self.refs = refs;
        Ok(())
    }

    // --- Writing ---------------------------------------------------------------------------

    /// Starts a write transaction: its objects go into one new segment, published by
    /// `WriteTxn::commit` and visible only after it.
    pub fn begin_write(&mut self) -> Result<WriteTxn<'_>> {
        self.require_writer()?;
        Ok(WriteTxn {
            repo: self,
            segment: None,
        })
    }

    /// Moves refs (and optionally HEAD) together, as one atomic step, if they are still what
    /// the caller last saw: `expected_revision` must be the current revision and every
    /// `expected` value must match. Every new target must already be durably stored. The
    /// reflog records the change before `refs.json` does. Returns the new revision.
    pub fn update_refs(
        &mut self,
        expected_revision: u64,
        updates: &[RefUpdate],
        head: Option<Head>,
        op: &str,
        reason: &str,
    ) -> Result<u64> {
        self.require_writer()?;
        if expected_revision != self.refs.revision {
            return Err(LgError::StaleRevision {
                expected: expected_revision,
                found: self.refs.revision,
            });
        }
        let mut next = self.refs.clone();
        let mut seen = HashSet::new();
        for update in updates {
            if !seen.insert(update.name.clone()) {
                return Err(LgError::InvalidName(format!(
                    "{} is updated twice in one step",
                    update.name.as_str()
                )));
            }
            let current = self.refs.refs.get(&update.name).copied();
            if current != update.expected {
                return Err(LgError::RefConflict {
                    name: update.name.as_str().into(),
                    expected: update.expected,
                    found: current,
                });
            }
            match update.new {
                Some(id) => {
                    if !self.odb.contains(&id) {
                        return Err(LgError::MissingObject(id));
                    }
                    if current.is_none() {
                        let folded = update.name.as_str().to_lowercase();
                        if next
                            .refs
                            .keys()
                            .any(|name| name.as_str().to_lowercase() == folded)
                        {
                            return Err(LgError::InvalidName(format!(
                                "{} differs only in case from an existing ref",
                                update.name.as_str()
                            )));
                        }
                    }
                    next.refs.insert(update.name.clone(), id);
                }
                None => {
                    next.refs.remove(&update.name);
                }
            }
        }
        if let Some(Head::Detached(id)) = &head {
            if !self.odb.contains(id) {
                return Err(LgError::MissingObject(*id));
            }
        }
        let revision = self.refs.revision.max(self.reflog_revision) + 1;
        let ms = now_millis() as u64;
        let mut records: Vec<ReflogRecord> = updates
            .iter()
            .map(|update| ReflogRecord::Update {
                revision,
                name: update.name.as_str().into(),
                old: hex(&update.expected),
                new: hex(&update.new),
                ms,
                op: op.into(),
                reason: reason.into(),
            })
            .collect();
        if let Some(head) = &head {
            records.push(ReflogRecord::Update {
                revision,
                name: "HEAD".into(),
                old: Some(self.refs.head.describe()),
                new: Some(head.describe()),
                ms,
                op: op.into(),
                reason: reason.into(),
            });
            next.head = head.clone();
        }
        next.revision = revision;
        reflog::append(&self.log_path(), &records)?;
        self.reflog_revision = revision;
        write_durably(&self.dir.join("refs.json"), next.to_json().as_bytes())
            .map_err(LgError::Io)?;
        fault::hit(FaultPoint::RefsWritten);
        self.refs = next;
        Ok(revision)
    }

    /// Checks the store. `quick`: every ref's target exists. `full`: also re-hashes every
    /// object and walks everything reachable from the refs and HEAD, reporting what is missing
    /// (files hashed but deliberately not stored are expected to be absent).
    pub fn verify(&self, full: bool) -> Vec<Finding> {
        let mut findings = self.dangling_refs();
        if !full {
            return findings;
        }
        for id in self.odb.ids() {
            if let Err(error) = self.odb.stream(id, &mut std::io::sink()) {
                findings.push(Finding::CorruptObject {
                    id: id.to_hex(),
                    detail: error.to_string(),
                });
            }
        }
        let mut seen = HashSet::new();
        let mut stack: Vec<(ObjectId, ObjectKind, String)> = Vec::new();
        for (name, id) in &self.refs.refs {
            stack.push((*id, ObjectKind::Commit, name.as_str().into()));
        }
        if let Head::Detached(id) = &self.refs.head {
            stack.push((*id, ObjectKind::Commit, "HEAD".into()));
        }
        while let Some((id, kind, from)) = stack.pop() {
            if !seen.insert(id) {
                continue;
            }
            if !self.odb.contains(&id) {
                findings.push(Finding::MissingObject {
                    id: id.to_hex(),
                    from,
                });
                continue;
            }
            let here = format!("{} {}", kind.name(), id);
            match self.object_quietly(&id) {
                Some(Object::Commit(commit)) => {
                    stack.push((commit.root, ObjectKind::Root, here.clone()));
                    if let Some(disk) = commit.disk_root {
                        stack.push((disk, ObjectKind::Root, here.clone()));
                    }
                    for parent in commit.parents {
                        stack.push((parent, ObjectKind::Commit, here.clone()));
                    }
                    for (_, id) in commit.meta_objects {
                        stack.push((id, ObjectKind::Blob, here.clone()));
                    }
                }
                Some(Object::Root(root)) => {
                    for tree in root.folders.values() {
                        stack.push((*tree, ObjectKind::Tree, here.clone()));
                    }
                }
                Some(Object::Tree(tree)) => {
                    for entry in tree.entries() {
                        match entry.kind {
                            EntryKind::Directory => {
                                stack.push((entry.id, ObjectKind::Tree, here.clone()))
                            }
                            EntryKind::File {
                                stored: Stored::No { .. },
                                ..
                            } => {}
                            _ => stack.push((entry.id, ObjectKind::Blob, here.clone())),
                        }
                    }
                }
                _ => {}
            }
        }
        findings
    }

    fn object_quietly(&self, id: &ObjectId) -> Option<Object> {
        match self.odb.kind_of(id)? {
            ObjectKind::Blob => None,
            _ => self.object(id).ok(),
        }
    }
}

struct PrefixWriter {
    bytes: Vec<u8>,
    limit: usize,
}

impl std::io::Write for PrefixWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let room = self.limit.saturating_sub(self.bytes.len());
        self.bytes.extend_from_slice(&buf[..buf.len().min(room)]);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// A set of new objects, written into one segment and published together. Every object it
/// adds must refer only to objects already stored or added before it in the same transaction,
/// so nothing published can dangle. Dropped without `commit`, nothing is published (the
/// temporary segment is left for the next open to sweep, exactly as after a crash).
pub struct WriteTxn<'a> {
    repo: &'a mut Repository,
    segment: Option<SegmentWriter>,
}

impl WriteTxn<'_> {
    /// Whether the store, or this transaction, already has `id`.
    pub fn has(&self, id: &ObjectId) -> bool {
        self.repo.odb.contains(id) || self.segment.as_ref().is_some_and(|s| s.contains(id))
    }

    fn require(&self, id: &ObjectId) -> Result<()> {
        if self.has(id) {
            Ok(())
        } else {
            Err(LgError::MissingObject(*id))
        }
    }

    fn segment(&mut self) -> Result<&mut SegmentWriter> {
        if self.segment.is_none() {
            self.segment = Some(SegmentWriter::create(&self.repo.dir.join("tmp"))?);
        }
        Ok(self.segment.as_mut().expect("just created"))
    }

    fn put(&mut self, kind: ObjectKind, payload: &[u8]) -> Result<ObjectId> {
        let id = hash_object(kind, payload);
        if self.has(&id) {
            return Ok(id);
        }
        self.segment()?.put(kind, payload)
    }

    /// The store this transaction writes to, for reading while it is open.
    pub fn repository(&self) -> &Repository {
        self.repo
    }

    /// Stores bytes as a blob. The store itself sets no size limit; deciding what is too big to
    /// keep (and hashing it with `hash_blob_stream` instead) is the snapshot layer's job.
    pub fn put_blob(&mut self, bytes: &[u8]) -> Result<ObjectId> {
        self.put(ObjectKind::Blob, bytes)
    }

    /// Stores `len` bytes from `reader` as a blob without holding them in memory.
    pub fn put_blob_stream(&mut self, len: u64, reader: &mut impl Read) -> Result<ObjectId> {
        self.segment()?.put_stream(len, reader)
    }

    pub fn put_tree(&mut self, tree: &Tree) -> Result<ObjectId> {
        for entry in tree.entries() {
            match entry.kind {
                EntryKind::File {
                    stored: Stored::No { .. },
                    ..
                } => {}
                _ => self.require(&entry.id)?,
            }
        }
        self.put(ObjectKind::Tree, &tree.encode())
    }

    pub fn put_root(&mut self, root: &Root) -> Result<ObjectId> {
        for tree in root.folders.values() {
            self.require(tree)?;
        }
        self.put(ObjectKind::Root, &root.encode())
    }

    pub fn put_commit(&mut self, commit: &Commit) -> Result<ObjectId> {
        self.require(&commit.root)?;
        if let Some(disk) = &commit.disk_root {
            self.require(disk)?;
        }
        for id in commit.parents.iter().chain(commit.meta_objects.values()) {
            self.require(id)?;
        }
        let bytes = commit.encode()?;
        self.put(ObjectKind::Commit, &bytes)
    }

    /// Publishes the transaction's objects: synced, then renamed into `objects/`. Refs may
    /// point at them only after this returns.
    pub fn commit(self) -> Result<()> {
        let WriteTxn { repo, segment } = self;
        let Some(segment) = segment else {
            return Ok(());
        };
        if segment.is_empty() {
            segment.abandon();
            return Ok(());
        }
        let name = repo.odb.next_segment_name();
        let objects_dir = repo.odb.objects_dir().to_path_buf();
        let records = segment.finish(&objects_dir, &name)?;
        repo.odb.publish(objects_dir.join(name), &records);
        Ok(())
    }

    /// Discards everything added: nothing is published.
    pub fn abandon(self) {
        if let Some(segment) = self.segment {
            segment.abandon();
        }
    }
}
