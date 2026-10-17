//! The installed-extension inventory and its one writer (EXT-02).
//!
//! `<extensions root>/inventory.json` records, per canonical id, the installed copy Yavin uses
//! (`active`), the one it replaced (`previous`, kept as the known-good fallback), whether the
//! extension is disabled, and the install operations in flight. It is the single source of
//! truth: the renderer's registry is built from `list`, and the extension host loads code only
//! from the folder `folder_of` chooses -- the same choice `list` reported.
//!
//! **One writer.** Every change -- install, update, rollback, uninstall, enable/disable,
//! recovery, cleanup -- goes through `ExtensionService` under one lock, and every inventory
//! change is one durable replacement of the file (`durable::write_durably`). The lock is not
//! held while a package downloads: an operation owns its staging folder (`.staging/<op>/`),
//! recorded in the inventory, and nothing else touches it. One operation per id at a time.
//!
//! **Layout.** `.store/<id>/<version>-<sha8>/` holds immutable installed copies (never
//! overwritten: a published copy is only ever deleted, when nothing references it). Folders
//! directly in the root (`<root>/<id>/`) are IDE-09 installs, adopted as they are by
//! migration and never moved. Dot-folders stay invisible to an older Yavin's discovery.
//!
//! **An install** (`begin` → download → `staged` → `commit` → `finish`):
//!
//! 1. `begin`: the operation is recorded (`staging`) and its folder made;
//! 2. the package is downloaded and unpacked into it (no lock held);
//! 3. `staged`: the unpacked manifest must be the id and version asked for (`staged`);
//! 4. `commit`: the staged manifest is read again from disk and checked; the files are renamed
//!    into a new store folder (atomic, one volume); then one inventory write makes it active
//!    and records the operation `committed` with the record as it was before;
//! 5. `finish`: kept -- the operation ends and copies only the old record held are deleted;
//!    rolled back -- the old record is restored and copies only the new one held are deleted.
//!
//! **Recovery** runs once, when the inventory is first read in a process -- before any
//! operation of this process exists -- so it never touches an operation in flight: an
//! operation still `staging`/`staged` is discarded (the old version was never changed), one
//! `committed` is kept (the inventory already chose the new copy); staging folders and store
//! copies nothing references are then deleted. Listing adopts root folders the inventory does
//! not know (migration: recorded as they are, nothing copied or deleted), reports every other
//! copy of an id as shadowed, and falls back to the previous copy when the active one is gone
//! or unusable (recorded as a recovery), else reports the install as broken.

use crate::extension_package::identity;
use crate::extensions::{discover, read_manifest};
use ide_workspace::durable::{json_version, read_versioned, write_durably, Loaded};
use ide_workspace::extension_id::{canonical_id, is_canonical};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State};

pub const INVENTORY: &str = "inventory.json";
pub const STORE: &str = ".store";
pub const STAGING: &str = ".staging";
/// IDE-09's folder for a version moved aside during an update.
const LEGACY_PREVIOUS: &str = ".previous";
const INVENTORY_VERSION: u32 = 1;
const MAX_RECOVERIES: usize = 20;
/// How long a staged or committed operation of this process may wait for its window before
/// another operation of its id may end it. The window takes milliseconds between the steps; an
/// operation idle this long lost its window (a page reload).
const ABANDONED_AFTER: Duration = Duration::from_secs(60);

/// One installed copy of an extension.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Copy {
    pub version: String,
    /// Inside the root, `/`-separated: `.store/<id>/<version>-<sha8>`, or `<folder>` (IDE-09).
    pub folder: String,
    /// The verified package's SHA-256; none for an adopted copy.
    pub sha256: Option<String>,
    /// Where it came from: `registry <url>`, `file`, or `unknown` (adopted).
    pub source: String,
    /// Seconds since the Unix epoch.
    pub installed_at: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub active: Copy,
    pub previous: Option<Copy>,
    /// Why the active copy cannot be used and there was nothing to fall back to.
    pub broken: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum OpState {
    Staging,
    Staged,
    Committed,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Operation {
    pub id: String,
    pub version: String,
    pub source: String,
    pub state: OpState,
    pub sha256: Option<String>,
    /// The record before `commit` changed it (for `finish`).
    pub before: Option<Record>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Recovery {
    pub at: u64,
    pub id: Option<String>,
    pub reason: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Inventory {
    pub version: u32,
    pub extensions: BTreeMap<String, Record>,
    /// Disabled extension ids (installed or development copies alike).
    pub disabled: BTreeSet<String>,
    /// Whether the renderer's IDE-07 disabled list has been brought in.
    pub disabled_imported: bool,
    pub operations: BTreeMap<String, Operation>,
    /// The latest recoveries, newest last.
    pub recoveries: Vec<Recovery>,
}

impl Default for Inventory {
    fn default() -> Self {
        Inventory {
            version: INVENTORY_VERSION,
            extensions: BTreeMap::new(),
            disabled: BTreeSet::new(),
            disabled_imported: false,
            operations: BTreeMap::new(),
            recoveries: Vec::new(),
        }
    }
}

/// A copy found but not used: another copy of its id is.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Shadowed {
    pub folder: String,
    pub version: Option<String>,
    pub reason: String,
}

/// What the renderer registers: one entry per id (the copy used), or a folder that is not a
/// usable extension (with its manifest, if readable, for the renderer to explain).
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Listed {
    pub id: Option<String>,
    pub folder: String,
    pub manifest: Option<String>,
    pub error: Option<String>,
    /// `installed` (Yavin's extensions folder) or `development` (a repository sample).
    pub source: &'static str,
    pub shadowed: Vec<Shadowed>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub root: String,
    pub extensions: Vec<Listed>,
    pub skipped: usize,
    pub disabled: Vec<String>,
    pub recoveries: Vec<Recovery>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Committed {
    pub folder: String,
    pub replaced: bool,
}

struct Paths {
    root: PathBuf,
    development: Vec<PathBuf>,
}

#[derive(Default)]
struct Inner {
    inventory: Option<Inventory>,
    /// Operations of this process whose native work is running now (a download).
    running: HashSet<String>,
    /// Operations of this process waiting for their window (staged, or committed), since when.
    waiting: HashMap<String, Instant>,
}

#[derive(Default)]
pub struct ExtensionService {
    paths: OnceLock<Paths>,
    inner: Mutex<Inner>,
    /// Test only: the step at which to stop as if Yavin crashed there.
    #[cfg(test)]
    pub crash_at: Mutex<Option<&'static str>>,
    /// Test only: instead of `ABANDONED_AFTER`.
    #[cfg(test)]
    pub abandoned_after: Mutex<Option<Duration>>,
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn new_operation_id() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!(
        "{:x}{:x}{:x}",
        nanos,
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

/// An operation id as `new_operation_id` makes them (it names a folder).
pub fn operation_id_ok(op: &str) -> Result<(), String> {
    if (8..=64).contains(&op.len()) && op.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(format!("InvalidRequest: \"{op}\" is not an install token."))
    }
}

/// A recorded folder Yavin may use and delete: a store copy, or one plain folder of the root.
fn folder_ok(folder: &str) -> bool {
    let parts: Vec<_> = folder.split('/').collect();
    // One plain component: never empty, hidden (Yavin's own folders), `..` or a path.
    let plain = |part: &str| {
        !part.is_empty()
            && !part.starts_with('.')
            && !part
                .chars()
                .any(|c| c == '\\' || c == ':' || c.is_control())
    };
    match parts.as_slice() {
        [one] => plain(one),
        [store, id, key] => *store == STORE && is_canonical(id) && plain(key),
        _ => false,
    }
}

fn join(root: &Path, folder: &str) -> PathBuf {
    folder
        .split('/')
        .fold(root.to_path_buf(), |path, part| path.join(part))
}

fn display(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// The manifest of the extension in `folder`, which must be a real folder holding `id` at
/// `version` (when given). Returns the manifest's text.
fn read_copy(folder: &Path, id: &str, version: Option<&str>) -> Result<String, String> {
    let kind = fs::symlink_metadata(folder).map_err(|_| "its folder is missing".to_string())?;
    if !kind.is_dir() {
        return Err("its folder is not a plain folder".into());
    }
    let text = read_manifest(folder)?;
    let (found, found_version) = identity(&text)?;
    if found != id {
        return Err(format!("its manifest is {found}, not {id}"));
    }
    if let Some(version) = version {
        if found_version != version {
            return Err(format!(
                "its manifest is version {found_version}, not {version}"
            ));
        }
    }
    Ok(text)
}

fn note(inventory: &mut Inventory, id: Option<&str>, reason: String) {
    inventory.recoveries.push(Recovery {
        at: now(),
        id: id.map(str::to_string),
        reason,
    });
    let over = inventory.recoveries.len().saturating_sub(MAX_RECOVERIES);
    inventory.recoveries.drain(..over);
}

/// The folders a record uses.
fn folders_of(record: Option<&Record>) -> Vec<String> {
    record
        .map(|r| {
            std::iter::once(r.active.folder.clone())
                .chain(r.previous.iter().map(|p| p.folder.clone()))
                .collect()
        })
        .unwrap_or_default()
}

impl ExtensionService {
    #[cfg(test)]
    pub fn new(root: PathBuf, development: Vec<PathBuf>) -> Self {
        let service = ExtensionService::default();
        service.set_paths(root, development);
        service
    }

    pub fn set_paths(&self, root: PathBuf, development: Vec<PathBuf>) {
        let _ = self.paths.set(Paths { root, development });
    }

    fn paths(&self) -> Result<&Paths, String> {
        self.paths
            .get()
            .ok_or_else(|| "InstallFailed: Yavin's extensions folder is not known.".to_string())
    }

    #[cfg(test)]
    fn crash(&self, step: &'static str) -> Result<(), String> {
        if *self.crash_at.lock().unwrap() == Some(step) {
            return Err(format!("Crashed: at {step}"));
        }
        Ok(())
    }
    #[cfg(not(test))]
    fn crash(&self, _step: &'static str) -> Result<(), String> {
        Ok(())
    }

    #[cfg(test)]
    fn abandoned_after(&self) -> Duration {
        self.abandoned_after
            .lock()
            .unwrap()
            .unwrap_or(ABANDONED_AFTER)
    }
    #[cfg(not(test))]
    fn abandoned_after(&self) -> Duration {
        ABANDONED_AFTER
    }

    /// The lock, with the inventory read (and recovered) the first time.
    fn lock(&self) -> Result<(MutexGuard<'_, Inner>, &Paths), String> {
        let paths = self.paths()?;
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "InstallFailed: the extension inventory is unavailable.".to_string())?;
        if inner.inventory.is_none() {
            let loaded = self.load(paths)?;
            let before = loaded.clone();
            let mut inventory = sanitized(loaded);
            self.recover(paths, &mut inventory);
            if inventory != before {
                save(paths, &inventory)?;
            }
            inner.inventory = Some(inventory);
        }
        Ok((inner, paths))
    }

    fn load(&self, paths: &Paths) -> Result<Inventory, String> {
        fs::create_dir_all(&paths.root).map_err(|e| format!("InstallFailed: {e}"))?;
        let file = paths.root.join(INVENTORY);
        let loaded = read_versioned(&file, INVENTORY_VERSION, json_version, |text, version| {
            (version == INVENTORY_VERSION)
                .then(|| serde_json::from_str::<Inventory>(text).ok())
                .flatten()
        });
        match loaded {
            Loaded::Missing => Ok(Inventory::default()),
            Loaded::Current(inventory) | Loaded::Migrated { value: inventory, .. } => {
                Ok(inventory)
            }
            Loaded::Corrupt { backup: Some(backup) } => {
                let mut inventory = Inventory::default();
                note(
                    &mut inventory,
                    None,
                    format!(
                        "The extension inventory could not be read; it was kept as {} and rebuilt from the installed folders.",
                        display(&backup)
                    ),
                );
                Ok(inventory)
            }
            Loaded::Future { version, .. } => Err(format!(
                "InventoryUnsupported: the extension inventory was written by a newer Yavin (version {version}); it was kept aside, untouched. Update Yavin."
            )),
            Loaded::Corrupt { backup: None } | Loaded::Unreadable => Err(
                "InventoryUnavailable: the extension inventory cannot be read right now; nothing was changed.".into(),
            ),
        }
    }

    /// The start of a process: no operation of it exists yet, so every recorded one is an
    /// interrupted one. Idempotent.
    fn recover(&self, paths: &Paths, inventory: &mut Inventory) {
        let root = &paths.root;
        for (op, operation) in std::mem::take(&mut inventory.operations) {
            let id = operation.id.clone();
            match operation.state {
                OpState::Staging | OpState::Staged => {
                    let _ = fs::remove_dir_all(root.join(STAGING).join(&op));
                    note(
                        inventory,
                        Some(&id),
                        format!("An interrupted install of {id} {} was discarded; the installed version was not changed.", operation.version),
                    );
                }
                OpState::Committed => {
                    let keep = folders_of(inventory.extensions.get(&id));
                    for folder in folders_of(operation.before.as_ref()) {
                        if !keep.contains(&folder) {
                            remove_copy(root, &folder);
                        }
                    }
                    note(
                        inventory,
                        Some(&id),
                        format!(
                            "An interrupted install of {id} {} was completed.",
                            operation.version
                        ),
                    );
                }
            }
        }
        // IDE-09's interrupted update: an installation moved aside whose replacement never
        // arrived is moved back (what IDE-09's recovery did). Anything else is left alone.
        if let Ok(entries) = fs::read_dir(root.join(LEGACY_PREVIOUS)) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                let Some((id, _)) = name.rsplit_once('-') else {
                    continue;
                };
                if is_canonical(id)
                    && !inventory.extensions.contains_key(id)
                    && !root.join(id).exists()
                    && fs::rename(entry.path(), root.join(id)).is_ok()
                {
                    note(
                        inventory,
                        Some(id),
                        format!("{id}, set aside by an interrupted update, was put back."),
                    );
                }
            }
            let _ = fs::remove_dir(root.join(LEGACY_PREVIOUS));
        }
        // Staging nothing owns any more.
        if let Ok(entries) = fs::read_dir(root.join(STAGING)) {
            for entry in entries.flatten() {
                let path = entry.path();
                let _ = if path.is_dir() {
                    fs::remove_dir_all(&path)
                } else {
                    fs::remove_file(&path)
                };
            }
        }
        // Store copies nothing references.
        let referenced: HashSet<String> = inventory
            .extensions
            .values()
            .flat_map(|record| folders_of(Some(record)))
            .collect();
        if let Ok(ids) = fs::read_dir(root.join(STORE)) {
            for id in ids.flatten() {
                let id_name = id.file_name().to_string_lossy().into_owned();
                if let Ok(keys) = fs::read_dir(id.path()) {
                    for key in keys.flatten() {
                        let folder =
                            format!("{STORE}/{id_name}/{}", key.file_name().to_string_lossy());
                        if !referenced.contains(&folder) {
                            let _ = fs::remove_dir_all(key.path());
                        }
                    }
                }
                let _ = fs::remove_dir(id.path());
            }
        }
    }

    /// Applies `change` to a copy of the inventory and makes it durable; the inventory in
    /// memory changes only when the write succeeded.
    fn write<R>(
        inner: &mut Inner,
        paths: &Paths,
        change: impl FnOnce(&mut Inventory) -> Result<R, String>,
    ) -> Result<R, String> {
        let current = inner.inventory.as_ref().ok_or("InstallFailed")?;
        let mut next = current.clone();
        let result = change(&mut next)?;
        if &next != current {
            save(paths, &next)?;
            inner.inventory = Some(next);
        }
        Ok(result)
    }

    /// Ends an idle operation of `id` before another starts: a staged one is discarded, a
    /// committed one kept. One that is running refuses (`Busy`).
    fn settle(&self, inner: &mut Inner, paths: &Paths, id: &str) -> Result<(), String> {
        let found = inner.inventory.as_ref().and_then(|inv| {
            inv.operations
                .iter()
                .find(|(_, op)| op.id == id)
                .map(|(op, operation)| (op.clone(), operation.state))
        });
        let Some((op, state)) = found else {
            return Ok(());
        };
        let abandoned = inner
            .waiting
            .get(&op)
            .is_some_and(|since| since.elapsed() >= self.abandoned_after());
        if inner.running.contains(&op) || !abandoned {
            return Err(format!("Busy: {id} is already being installed."));
        }
        inner.waiting.remove(&op);
        match state {
            OpState::Committed => self.finish_locked(inner, paths, &op, true),
            _ => {
                Self::write(inner, paths, |inv| {
                    inv.operations.remove(&op);
                    Ok(())
                })?;
                let _ = fs::remove_dir_all(paths.root.join(STAGING).join(&op));
                Ok(())
            }
        }
    }

    // --- Install -----------------------------------------------------------------------------

    /// Records a new install operation of `id` at `version` and makes its staging folder.
    /// Returns the operation id and the folder the package goes into.
    pub fn begin(
        &self,
        id: &str,
        version: &str,
        source: &str,
    ) -> Result<(String, PathBuf), String> {
        if !is_canonical(id) {
            return Err(format!("InvalidRequest: \"{id}\" is not an extension id."));
        }
        crate::extension_package::version_ok(version)?;
        let (mut inner, paths) = self.lock()?;
        self.settle(&mut inner, paths, id)?;
        let op = new_operation_id();
        let folder = paths.root.join(STAGING).join(&op);
        Self::write(&mut inner, paths, |inv| {
            inv.operations.insert(
                op.clone(),
                Operation {
                    id: id.to_string(),
                    version: version.to_string(),
                    source: source.to_string(),
                    state: OpState::Staging,
                    sha256: None,
                    before: None,
                },
            );
            Ok(())
        })?;
        fs::create_dir_all(&folder).map_err(|e| format!("InstallFailed: {e}"))?;
        inner.running.insert(op.clone());
        Ok((op, folder))
    }

    /// The package of `op` is unpacked into `<staging>/files`: its manifest must be what
    /// `begin` was asked for. Returns the manifest's text.
    pub fn staged(&self, op: &str, sha256: &str) -> Result<String, String> {
        let (mut inner, paths) = self.lock()?;
        inner.running.remove(op);
        let operation = inner
            .inventory
            .as_ref()
            .and_then(|inv| inv.operations.get(op).cloned())
            .filter(|operation| operation.state == OpState::Staging)
            .ok_or_else(|| format!("InvalidRequest: nothing is being staged as {op}."))?;
        let files = paths.root.join(STAGING).join(op).join("files");
        let checked = read_copy(&files, &operation.id, Some(&operation.version)).map_err(|why| {
            format!(
                "ManifestMismatch: the package is not {} {}: {why}.",
                operation.id, operation.version
            )
        });
        let manifest = match checked {
            Ok(manifest) => manifest,
            Err(error) => {
                drop(inner);
                self.abort(op);
                return Err(error);
            }
        };
        Self::write(&mut inner, paths, |inv| {
            let operation = inv.operations.get_mut(op).ok_or("InstallFailed")?;
            operation.state = OpState::Staged;
            operation.sha256 = Some(sha256.to_ascii_lowercase());
            Ok(())
        })?;
        inner.waiting.insert(op.to_string(), Instant::now());
        self.crash("staged")?;
        Ok(manifest)
    }

    /// Ends `op` without installing anything (a failed download, a refused package).
    pub fn abort(&self, op: &str) {
        let Ok((mut inner, paths)) = self.lock() else {
            return;
        };
        inner.running.remove(op);
        inner.waiting.remove(op);
        let _ = Self::write(&mut inner, paths, |inv| {
            if inv
                .operations
                .get(op)
                .is_some_and(|o| o.state != OpState::Committed)
            {
                inv.operations.remove(op);
            }
            Ok(())
        });
        let _ = fs::remove_dir_all(paths.root.join(STAGING).join(op));
    }

    /// Throws a staged package away.
    pub fn discard(&self, op: &str) -> Result<(), String> {
        operation_id_ok(op)?;
        let (inner, _) = self.lock()?;
        if inner.running.contains(op) {
            return Err(format!("Busy: {op} is still being downloaded."));
        }
        let committed = inner
            .inventory
            .as_ref()
            .and_then(|inv| inv.operations.get(op))
            .is_some_and(|o| o.state == OpState::Committed);
        if committed {
            return Err(format!(
                "InvalidRequest: {op} is installed; finish it instead."
            ));
        }
        drop(inner);
        self.abort(op);
        Ok(())
    }

    /// Puts staged `op` in place: a new immutable store copy, made active in one inventory
    /// write. `requested` is the renderer's id: it must be the operation's -- the id itself
    /// comes from the staged manifest, read again here.
    pub fn commit(&self, op: &str, requested: &str) -> Result<Committed, String> {
        operation_id_ok(op)?;
        let (mut inner, paths) = self.lock()?;
        let root = &paths.root;
        let operation = inner
            .inventory
            .as_ref()
            .and_then(|inv| inv.operations.get(op).cloned())
            .filter(|operation| operation.state == OpState::Staged)
            .ok_or_else(|| format!("InvalidRequest: nothing is staged as {op}."))?;
        let id = operation.id.clone();
        if canonical_id(requested).as_deref() != Some(id.as_str()) {
            return Err(format!(
                "ManifestMismatch: {op} installs {id}, not \"{requested}\"."
            ));
        }
        let staged = root.join(STAGING).join(op).join("files");
        read_copy(&staged, &id, Some(&operation.version)).map_err(|why| {
            format!(
                "ManifestMismatch: the staged package is no longer {id} {}: {why}.",
                operation.version
            )
        })?;
        let sha256 = operation.sha256.clone().unwrap_or_default();
        if sha256.len() != 64 || !sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(format!("InstallFailed: {op} has no verified package hash."));
        }
        let folder = format!("{STORE}/{id}/{}-{}", operation.version, &sha256[..8]);
        let target = join(root, &folder);
        let before = inner
            .inventory
            .as_ref()
            .and_then(|inv| inv.extensions.get(&id).cloned());
        let in_use = folders_of(before.as_ref()).contains(&folder);
        let mut published = false;
        if !in_use {
            // An unreferenced folder of that name is a publish a crash interrupted.
            if target.exists() {
                fs::remove_dir_all(&target).map_err(|e| format!("InstallFailed: {e}"))?;
            }
            fs::create_dir_all(root.join(STORE).join(&id))
                .map_err(|e| format!("InstallFailed: {e}"))?;
            fs::rename(&staged, &target).map_err(|e| format!("InstallFailed: {e}"))?;
            published = true;
        }
        self.crash("published")?;
        let copy = Copy {
            version: operation.version.clone(),
            folder: folder.clone(),
            sha256: Some(sha256),
            source: operation.source.clone(),
            installed_at: now(),
        };
        let switched = Self::write(&mut inner, paths, |inv| {
            let record = match &before {
                Some(old) if old.active.folder == folder => old.clone(),
                Some(old) if old.previous.as_ref().is_some_and(|p| p.folder == folder) => Record {
                    active: old.previous.clone().ok_or("InstallFailed")?,
                    previous: Some(old.active.clone()),
                    broken: None,
                },
                Some(old) => Record {
                    active: copy,
                    previous: Some(old.active.clone()),
                    broken: None,
                },
                None => Record {
                    active: copy,
                    previous: None,
                    broken: None,
                },
            };
            inv.extensions.insert(id.clone(), record);
            let operation = inv.operations.get_mut(op).ok_or("InstallFailed")?;
            operation.state = OpState::Committed;
            operation.before = before.clone();
            Ok(())
        });
        if let Err(error) = switched {
            if published {
                let _ = fs::rename(&target, &staged);
            }
            return Err(error);
        }
        inner.waiting.insert(op.to_string(), Instant::now());
        self.crash("switched")?;
        let _ = fs::remove_dir_all(root.join(STAGING).join(op));
        Ok(Committed {
            folder: display(&target),
            replaced: before.is_some(),
        })
    }

    /// After `commit`: keep the new copy, or roll back to the record as it was.
    pub fn finish(&self, op: &str, requested: &str, keep: bool) -> Result<(), String> {
        operation_id_ok(op)?;
        let (mut inner, paths) = self.lock()?;
        let id = inner
            .inventory
            .as_ref()
            .and_then(|inv| inv.operations.get(op))
            .map(|o| o.id.clone());
        if id.is_none() || id != canonical_id(requested) {
            return Err(format!(
                "InvalidRequest: {op} is not an install of \"{requested}\"."
            ));
        }
        self.finish_locked(&mut inner, paths, op, keep)
    }

    fn finish_locked(
        &self,
        inner: &mut Inner,
        paths: &Paths,
        op: &str,
        keep: bool,
    ) -> Result<(), String> {
        let operation = inner
            .inventory
            .as_ref()
            .and_then(|inv| inv.operations.get(op).cloned())
            .filter(|o| o.state == OpState::Committed)
            .ok_or_else(|| format!("InvalidRequest: {op} is not installed."))?;
        let id = operation.id.clone();
        let current = inner
            .inventory
            .as_ref()
            .and_then(|inv| inv.extensions.get(&id).cloned());
        let (gone, kept) = if keep {
            (
                folders_of(operation.before.as_ref()),
                folders_of(current.as_ref()),
            )
        } else {
            (
                folders_of(current.as_ref()),
                folders_of(operation.before.as_ref()),
            )
        };
        inner.waiting.remove(op);
        Self::write(inner, paths, |inv| {
            inv.operations.remove(op);
            if !keep {
                match &operation.before {
                    Some(before) => {
                        inv.extensions.insert(id.clone(), before.clone());
                    }
                    None => {
                        inv.extensions.remove(&id);
                    }
                }
            }
            Ok(())
        })?;
        for folder in gone.iter().filter(|f| !kept.contains(f)) {
            remove_copy(&paths.root, folder);
        }
        let _ = fs::remove_dir(paths.root.join(STORE).join(&id));
        Ok(())
    }

    // --- Uninstall, enable/disable -------------------------------------------------------------

    /// Removes `id` from the inventory (and its disabled state), then deletes its copies.
    pub fn uninstall(&self, requested: &str) -> Result<String, String> {
        let id = canonical_id(requested)
            .ok_or_else(|| format!("InvalidRequest: \"{requested}\" is not an extension id."))?;
        let (mut inner, paths) = self.lock()?;
        self.settle(&mut inner, paths, &id)?;
        self.reconcile(&mut inner, paths)?;
        let record = Self::write(&mut inner, paths, |inv| {
            inv.disabled.remove(&id);
            inv.extensions.remove(&id).ok_or_else(|| {
                format!("UnknownExtension: {id} is not installed in Yavin's extensions folder.")
            })
        })?;
        for folder in folders_of(Some(&record)) {
            remove_copy(&paths.root, &folder);
        }
        let _ = fs::remove_dir(paths.root.join(STORE).join(&id));
        Ok(display(&join(&paths.root, &record.active.folder)))
    }

    pub fn set_enabled(&self, requested: &str, enabled: bool) -> Result<(), String> {
        let id = canonical_id(requested)
            .ok_or_else(|| format!("InvalidRequest: \"{requested}\" is not an extension id."))?;
        let (mut inner, paths) = self.lock()?;
        Self::write(&mut inner, paths, |inv| {
            if enabled {
                inv.disabled.remove(&id);
            } else {
                inv.disabled.insert(id.clone());
            }
            Ok(())
        })
    }

    // --- Listing and the host's choice ---------------------------------------------------------

    /// Every extension, one entry per id, with the copies it shadows. `legacy_disabled`, the
    /// renderer's IDE-07 disabled list, is brought into the inventory once.
    pub fn list(&self, legacy_disabled: Option<Vec<String>>) -> Result<Listing, String> {
        let (mut inner, paths) = self.lock()?;
        if let Some(ids) = legacy_disabled {
            Self::write(&mut inner, paths, |inv| {
                if !inv.disabled_imported {
                    inv.disabled
                        .extend(ids.iter().filter_map(|id| canonical_id(id)));
                    inv.disabled_imported = true;
                }
                Ok(())
            })?;
        }
        let (extensions, skipped) = self.reconcile(&mut inner, paths)?;
        let inventory = inner.inventory.as_ref().ok_or("InstallFailed")?;
        Ok(Listing {
            root: display(&paths.root),
            extensions,
            skipped,
            disabled: inventory.disabled.iter().cloned().collect(),
            recoveries: inventory.recoveries.clone(),
        })
    }

    /// The folder and entry point the host loads for `id`: the copy `list` reports for it.
    pub fn folder_of(&self, requested: &str) -> Result<(PathBuf, String), String> {
        let id = canonical_id(requested)
            .ok_or_else(|| format!("UnknownExtension: \"{requested}\" is not an extension id."))?;
        let (mut inner, paths) = self.lock()?;
        let (listed, _) = self.reconcile(&mut inner, paths)?;
        let chosen = listed
            .into_iter()
            .find(|one| one.id.as_deref() == Some(id.as_str()) && one.error.is_none())
            .ok_or_else(|| format!("UnknownExtension: {id} is not installed."))?;
        let main = chosen
            .manifest
            .as_deref()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
            .and_then(|value| value.get("main")?.as_str().map(str::to_string))
            .ok_or_else(|| format!("UnsupportedRuntime: {id} has no code (no \"main\")."))?;
        Ok((PathBuf::from(chosen.folder), main))
    }

    /// The disk and the inventory, made to agree; what to list. Root folders the inventory
    /// does not know are adopted; other copies of a recorded id are shadowed; an unusable
    /// active copy falls back to the previous one, or the install is reported broken.
    fn reconcile(&self, inner: &mut Inner, paths: &Paths) -> Result<(Vec<Listed>, usize), String> {
        let root = &paths.root;
        let scan = discover(root);
        let mut skipped = scan.skipped;
        let mut invalid = Vec::new();
        let mut copies: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();
        for found in scan.extensions {
            let name = Path::new(&found.folder)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let checked = found
                .manifest
                .as_deref()
                .ok_or_else(|| found.error.clone().unwrap_or_default())
                .and_then(identity);
            match checked {
                Ok((id, version)) if folder_ok(&name) => {
                    copies.entry(id).or_default().push((name, version))
                }
                Ok(_) | Err(_) => invalid.push(Listed {
                    id: None,
                    folder: found.folder,
                    error: Some(found.error.or_else(|| checked.err()).unwrap_or_else(|| {
                        "Its folder name cannot be used by Yavin's extensions folder.".into()
                    })),
                    manifest: found.manifest,
                    source: "installed",
                    shadowed: Vec::new(),
                }),
            }
        }
        let shadow = |folder: &str, version: &str, reason: &str| Shadowed {
            folder: display(&root.join(folder)),
            version: Some(version.to_string()),
            reason: reason.to_string(),
        };
        let mut shadows: BTreeMap<String, Vec<Shadowed>> = BTreeMap::new();
        Self::write(inner, paths, |inv| {
            for (id, mut found) in copies {
                if let Some(record) = inv.extensions.get(&id) {
                    let used = folders_of(Some(record));
                    for (folder, version) in found.iter().filter(|(f, _)| !used.contains(f)) {
                        shadows.entry(id.clone()).or_default().push(shadow(
                            folder,
                            version,
                            "Yavin's inventory records another copy of this extension.",
                        ));
                    }
                    continue;
                }
                // Migration: the IDE-09 installer named the folder after the id.
                found.sort_by_key(|(folder, _)| (folder != &id, folder.clone()));
                let (folder, version) = found.remove(0);
                for (other, other_version) in &found {
                    shadows.entry(id.clone()).or_default().push(shadow(
                        other,
                        other_version,
                        "Another copy of this extension in Yavin's extensions folder is used.",
                    ));
                }
                inv.extensions.insert(
                    id,
                    Record {
                        active: Copy {
                            version,
                            folder,
                            sha256: None,
                            source: "unknown".into(),
                            installed_at: now(),
                        },
                        previous: None,
                        broken: None,
                    },
                );
            }
            Ok(())
        })?;

        let mut listed = Vec::new();
        let records: Vec<(String, Record)> = inner
            .inventory
            .as_ref()
            .map(|inv| inv.extensions.clone().into_iter().collect())
            .unwrap_or_default();
        for (id, record) in records {
            let usable = |copy: &Copy| {
                if !folder_ok(&copy.folder) {
                    return Err(
                        "its recorded folder is not inside Yavin's extensions folder".to_string(),
                    );
                }
                read_copy(&join(root, &copy.folder), &id, Some(&copy.version))
            };
            let mut entry = Listed {
                id: Some(id.clone()),
                folder: display(&join(root, &record.active.folder)),
                manifest: None,
                error: None,
                source: "installed",
                shadowed: shadows.remove(&id).unwrap_or_default(),
            };
            match usable(&record.active) {
                Ok(text) => {
                    entry.manifest = Some(text);
                    if record.broken.is_some() {
                        Self::write(inner, paths, |inv| {
                            if let Some(r) = inv.extensions.get_mut(&id) {
                                r.broken = None;
                            }
                            Ok(())
                        })?;
                    }
                }
                Err(why) => {
                    let fallback = record.previous.as_ref().and_then(|previous| {
                        usable(previous).ok().map(|text| (previous.clone(), text))
                    });
                    match fallback {
                        Some((previous, text)) => {
                            Self::write(inner, paths, |inv| {
                                if let Some(r) = inv.extensions.get_mut(&id) {
                                    r.active = previous.clone();
                                    r.previous = None;
                                    r.broken = None;
                                }
                                note(inv, Some(&id), format!(
                                    "{id} {} could not be used ({why}); the previous version, {}, is used instead.",
                                    record.active.version, previous.version
                                ));
                                Ok(())
                            })?;
                            entry.folder = display(&join(root, &previous.folder));
                            entry.manifest = Some(text);
                        }
                        None => {
                            let reason = format!("The installed {id} {} cannot be used: {why}. Reinstall or uninstall it.", record.active.version);
                            if record.broken.as_deref() != Some(reason.as_str()) {
                                Self::write(inner, paths, |inv| {
                                    if let Some(r) = inv.extensions.get_mut(&id) {
                                        r.broken = Some(reason.clone());
                                    }
                                    note(inv, Some(&id), reason.clone());
                                    Ok(())
                                })?;
                            }
                            entry.error = Some(reason);
                        }
                    }
                }
            }
            listed.push(entry);
        }
        listed.extend(invalid);

        // Development samples: never recorded; an installed copy takes precedence.
        for development in &paths.development {
            let scan = discover(development);
            skipped += scan.skipped;
            for found in scan.extensions {
                let checked = found
                    .manifest
                    .as_deref()
                    .ok_or_else(|| found.error.clone().unwrap_or_default())
                    .and_then(identity);
                let Ok((id, version)) = checked else {
                    listed.push(Listed {
                        id: None,
                        folder: found.folder,
                        error: found.error.or_else(|| checked.err()),
                        manifest: found.manifest,
                        source: "development",
                        shadowed: Vec::new(),
                    });
                    continue;
                };
                if let Some(winner) = listed
                    .iter_mut()
                    .find(|one| one.id.as_deref() == Some(id.as_str()))
                {
                    let reason = if winner.source == "installed" {
                        "An installed copy takes precedence over a development copy."
                    } else {
                        "Another development copy of this extension sorts first."
                    };
                    winner.shadowed.push(Shadowed {
                        folder: found.folder,
                        version: Some(version),
                        reason: reason.into(),
                    });
                    continue;
                }
                listed.push(Listed {
                    id: Some(id),
                    folder: found.folder,
                    manifest: found.manifest,
                    error: None,
                    source: "development",
                    shadowed: Vec::new(),
                });
            }
        }
        Ok((listed, skipped))
    }
}

/// An inventory read from disk, without what could name a path outside Yavin's folders: an
/// extension or operation whose id breaks the id rule, an operation key that is not one Yavin
/// makes. (Recorded folders are checked where they are used, `folder_ok`.)
fn sanitized(mut inventory: Inventory) -> Inventory {
    let before = (inventory.extensions.len(), inventory.operations.len());
    inventory.extensions.retain(|id, _| is_canonical(id));
    inventory
        .operations
        .retain(|op, operation| operation_id_ok(op).is_ok() && is_canonical(&operation.id));
    if before != (inventory.extensions.len(), inventory.operations.len()) {
        note(
            &mut inventory,
            None,
            "Entries of the extension inventory that are not valid extension ids or install operations were dropped.".into(),
        );
    }
    inventory
}

fn save(paths: &Paths, inventory: &Inventory) -> Result<(), String> {
    let text =
        serde_json::to_string_pretty(inventory).map_err(|e| format!("InstallFailed: {e}"))?;
    write_durably(&paths.root.join(INVENTORY), text.as_bytes())
        .map_err(|e| format!("InstallFailed: the extension inventory could not be saved ({e})."))
}

/// Deletes a copy no record uses any more: a store copy, or an IDE-09 folder directly in the
/// root -- never a link, never anything outside the root.
fn remove_copy(root: &Path, folder: &str) {
    if !folder_ok(folder) {
        return;
    }
    let path = join(root, folder);
    let real_folder = fs::symlink_metadata(&path).is_ok_and(|m| m.is_dir());
    let inside = match (root.canonicalize(), path.canonicalize()) {
        (Ok(base), Ok(real)) => real.starts_with(&base) && real != base,
        _ => false,
    };
    if real_folder && inside {
        let _ = fs::remove_dir_all(&path);
    }
}

/// Yavin's extensions folder, and in development builds the repository's samples.
pub fn paths_of(app: &AppHandle) -> Result<(PathBuf, Vec<PathBuf>), String> {
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Cannot find Yavin's data folder: {e}"))?
        .join("extensions");
    let mut development = Vec::new();
    if cfg!(debug_assertions) {
        development.push(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("extensions")
                .join("samples"),
        );
    }
    Ok((root, development))
}

// --- Commands --------------------------------------------------------------------------------

/// The extensions, one per id (the inventory's choice), with shadowed copies and recoveries.
#[tauri::command(async)]
pub fn extensions_list(
    service: State<'_, ExtensionService>,
    legacy_disabled: Option<Vec<String>>,
) -> Result<Listing, String> {
    service.list(legacy_disabled)
}

#[tauri::command(async)]
pub fn extensions_set_enabled(
    service: State<'_, ExtensionService>,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    service.set_enabled(&id, enabled)
}

#[cfg(test)]
#[path = "extension_service_tests.rs"]
mod tests;
