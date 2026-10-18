//! The installed-extension inventory and its one writer (EXT-02).
//!
//! `<extensions root>/inventory.json` records, per canonical id, the installed copy Yavin uses
//! (`active`), the one it replaced (`previous`, kept as the known-good fallback), whether the
//! extension is disabled, and the install operations in flight. It is the single source of
//! truth: the renderer's registry is built from `list`, and the extension host loads code only
//! from the copy `host_copy` chooses -- the same choice `list` reported.
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
//!
//! **A damaged or missing inventory** never costs an installation. Every save writes the
//! inventory twice, durably: `inventory.last-good.json` first, then `inventory.json` -- so the
//! last-good copy is never older than the inventory. When `inventory.json` is missing or cannot
//! be read while installed copies exist (`.store`, `.staging`, a last-good copy), it is restored
//! from the last-good copy; if that cannot be read either, it is rebuilt from the store copies
//! that validate (`rebuild`) -- each recorded **disabled** (what was enabled is not known) and
//! with no grant -- and everything that does not validate, staging included, is moved into
//! `.unrecovered-<ms>/` (never swept, never discovered): nothing is deleted. A missing inventory
//! with nothing installed is a new folder, or IDE-09's (its root folders are adopted as before).
//!
//! **Permissions** (EXT-07, `extension_permissions.rs`). What the user allowed an extension is
//! recorded here too (`grants`), bound to the very copy it was allowed for -- its folder,
//! version and package hash: an update, a reinstall or another copy has none of it. Only a
//! capability that copy's manifest requests can be granted (`set_grants`); the window names
//! capabilities, never the copy. `authorize` is what the host bridge asks before every
//! privileged request, from the inventory in memory: a revocation holds for the next request.

use crate::extension_dependencies as deps;
use crate::extension_package::identity;
use crate::extension_permissions::{declared, grantable, Denial};
use crate::extensions::{discover, read_manifest, read_resource};
use crate::package_trust::SignatureRecord;
use ide_workspace::durable::{json_version, read_versioned, remove_durably, write_durably, Loaded};
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
/// The inventory as last written (written before it): what a damaged inventory is restored from.
pub const LAST_GOOD: &str = "inventory.last-good.json";
/// Where a rebuild keeps what it could not validate (`.unrecovered-<ms>`).
const UNRECOVERED: &str = ".unrecovered";
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
    /// What its package's signature was found to be when installed (EXT-09), bound to the
    /// package's SHA-256. None: installed before signatures were checked, adopted, or rebuilt
    /// by a recovery -- never taken for verified.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<SignatureRecord>,
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
    /// Its package's signature, as `staged` was told (EXT-09).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<SignatureRecord>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Recovery {
    pub at: u64,
    pub id: Option<String>,
    pub reason: String,
}

/// What the user allowed one copy of an extension (EXT-07): bound to that copy -- its folder,
/// version and package hash -- so no other copy (an update, a reinstall) has any of it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Grant {
    /// The copy's folder as listed (`Listed::folder`).
    pub folder: String,
    pub version: String,
    pub sha256: Option<String>,
    pub capabilities: BTreeSet<String>,
    /// Seconds since the Unix epoch.
    pub granted_at: u64,
}

impl Grant {
    fn binds(&self, folder: &str, version: &str, sha256: Option<&str>) -> bool {
        self.folder == folder && self.version == version && self.sha256.as_deref() == sha256
    }
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
    /// What the user allowed, per extension id (EXT-07). Absent in an older inventory: none.
    #[serde(default)]
    pub grants: BTreeMap<String, Grant>,
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
            grants: BTreeMap::new(),
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
    /// What it requests and what of it is allowed (EXT-07); none for an unusable copy.
    pub permissions: Option<PermissionState>,
    /// Which copy it is, for the host and for grants (not sent to the window).
    #[serde(skip)]
    pub copy: Option<CopyFacts>,
    /// What its package's signature was found to be when installed (EXT-09).
    pub signature: Option<SignatureRecord>,
}

/// The copy an entry is (EXT-07): what a grant is bound to.
#[derive(Debug, Clone, PartialEq)]
pub struct CopyFacts {
    pub version: String,
    pub sha256: Option<String>,
    /// The inventory's folder for an installed copy; none for a development copy.
    pub stored: Option<String>,
}

/// An extension's permissions as the window shows them (EXT-07).
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PermissionState {
    /// Its manifest has no `permissions`: it is taken to request what extensions could do before.
    pub legacy: bool,
    pub requested: Vec<String>,
    /// Allowed for this very copy.
    pub granted: Vec<String>,
    /// Allowed for another copy (the version before an update): shown, never used.
    pub previous: Option<PreviousGrant>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreviousGrant {
    pub version: String,
    pub granted: Vec<String>,
}

/// What the host loads for an extension, and what its requests are checked against (EXT-07).
#[derive(Debug, Clone, PartialEq)]
pub struct HostCopy {
    pub id: String,
    /// As listed (`Listed::folder`).
    pub folder: String,
    pub main: String,
    pub version: String,
    pub sha256: Option<String>,
    pub stored: Option<String>,
    pub requested: BTreeSet<String>,
    /// Its required dependencies (EXT-12): each must stay enabled, installed and in range for
    /// its code to act. `installed`: it was an installed copy (not a development one) when
    /// loaded.
    pub requires: Vec<HostRequirement>,
}

/// A required dependency of a loaded copy (EXT-12).
#[derive(Debug, Clone, PartialEq)]
pub struct HostRequirement {
    pub id: String,
    pub range: deps::Range,
    /// It has code: the host must have loaded it first (`extension_host::prepare`).
    pub code: bool,
    pub installed: bool,
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
    /// An operation in neither set has no owner: a step of it failed (EXT-06).
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

/// Every usable listed copy but `except`, as the resolver's candidates (EXT-12): its version,
/// enabled or not, and what its manifest declares -- or why it cannot be used.
fn installed_candidates(inner: &Inner, listed: &[Listed], except: &str) -> Vec<deps::Candidate> {
    let disabled = |id: &str| {
        inner
            .inventory
            .as_ref()
            .is_some_and(|inv| inv.disabled.contains(id))
    };
    listed
        .iter()
        .filter(|one| one.error.is_none())
        .filter_map(|one| {
            let id = one.id.clone()?;
            if id == except {
                return None;
            }
            let version = semver::Version::parse(&one.copy.as_ref()?.version).ok()?;
            let value: serde_json::Value = serde_json::from_str(one.manifest.as_deref()?).ok()?;
            let (declared, unusable) = match deps::declared(&value, &id) {
                Ok(declared) => (declared, None),
                Err(why) => (
                    deps::Declared::default(),
                    Some(format!("its manifest cannot be read: {why}")),
                ),
            };
            Some(deps::Candidate {
                source: deps::Source::Installed {
                    enabled: !disabled(&id),
                },
                id,
                version,
                declared,
                unusable,
            })
        })
        .collect()
}

/// What a load of `chosen` needs (EXT-12): its API this Yavin's, and each required dependency
/// listed, usable, enabled, in range and itself API-compatible -- or why it cannot load.
fn load_requirements(
    inner: &Inner,
    listed: &[Listed],
    chosen: &Listed,
    id: &str,
) -> Result<Vec<HostRequirement>, String> {
    let value: serde_json::Value = serde_json::from_str(chosen.manifest.as_deref().unwrap_or("{}"))
        .map_err(|e| format!("InvalidManifest: {e}."))?;
    let declared =
        deps::declared(&value, id).map_err(|e| format!("InvalidManifest: {id}: {e}."))?;
    deps::check_api(&declared).map_err(|e| format!("IncompatibleApi: {id}: {e}."))?;
    let disabled = |dep: &str| {
        inner
            .inventory
            .as_ref()
            .is_some_and(|inv| inv.disabled.contains(dep))
    };
    let mut requires = Vec::new();
    for need in declared.required() {
        let unavailable = |why: String| {
            format!(
                "DependencyUnavailable: {id} needs {} {}: {why}.",
                need.id, need.range.text
            )
        };
        let Some(found) = listed
            .iter()
            .find(|one| one.id.as_deref() == Some(need.id.as_str()) && one.error.is_none())
        else {
            return Err(unavailable("it is not installed".into()));
        };
        if disabled(&need.id) {
            return Err(unavailable("it is disabled".into()));
        }
        let version = found
            .copy
            .as_ref()
            .map(|c| c.version.clone())
            .unwrap_or_default();
        if !semver::Version::parse(&version).is_ok_and(|v| need.range.matches(&v)) {
            return Err(unavailable(format!("{version} is installed")));
        }
        let dependency: serde_json::Value =
            serde_json::from_str(found.manifest.as_deref().unwrap_or("{}")).unwrap_or_default();
        let declared = deps::declared(&dependency, &need.id).map_err(unavailable)?;
        deps::check_api(&declared).map_err(unavailable)?;
        requires.push(HostRequirement {
            id: need.id.clone(),
            range: need.range.clone(),
            code: declared.code,
            installed: found.source == "installed",
        });
    }
    Ok(requires)
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
            let (loaded, restored) = self.load(paths)?;
            let before = loaded.clone();
            let mut inventory = sanitized(loaded);
            self.recover(paths, &mut inventory);
            // A restored or rebuilt inventory is written at once: the next start reads it.
            if restored || inventory != before {
                save(paths, &inventory)?;
            }
            inner.inventory = Some(inventory);
        }
        Ok((inner, paths))
    }

    /// The inventory, and whether it was restored or rebuilt (so it must be written now).
    fn load(&self, paths: &Paths) -> Result<(Inventory, bool), String> {
        fs::create_dir_all(&paths.root).map_err(|e| format!("InstallFailed: {e}"))?;
        let file = paths.root.join(INVENTORY);
        match read_inventory(&file) {
            // Nothing installed: a new folder, or IDE-09's (adopted as it is by listing).
            Loaded::Missing if !installed_data(&paths.root) => Ok((Inventory::default(), false)),
            Loaded::Missing => self.restore(paths, "was missing").map(|inv| (inv, true)),
            Loaded::Current(inventory) | Loaded::Migrated { value: inventory, .. } => {
                Ok((inventory, false))
            }
            Loaded::Corrupt { backup: Some(backup) } => self
                .restore(
                    paths,
                    &format!("could not be read (it was kept as {})", display(&backup)),
                )
                .map(|inv| (inv, true)),
            Loaded::Future { version, .. } => Err(format!(
                "InventoryUnsupported: the extension inventory was written by a newer Yavin (version {version}); it was kept aside, untouched. Update Yavin."
            )),
            Loaded::Corrupt { backup: None } | Loaded::Unreadable => Err(
                "InventoryUnavailable: the extension inventory cannot be read right now; nothing was changed.".into(),
            ),
        }
    }

    /// `inventory.json` `what` (missing, unreadable) while copies are installed: the last-good
    /// copy if it reads, else a rebuild. A last-good copy a newer Yavin wrote, or one that cannot
    /// be read right now, stops here: nothing is rebuilt over it.
    fn restore(&self, paths: &Paths, what: &str) -> Result<Inventory, String> {
        match read_inventory(&paths.root.join(LAST_GOOD)) {
            Loaded::Current(mut inventory) | Loaded::Migrated { value: mut inventory, .. } => {
                note(
                    &mut inventory,
                    None,
                    format!("The extension inventory {what}; it was restored from its last good copy."),
                );
                Ok(inventory)
            }
            Loaded::Future { version, .. } => Err(format!(
                "InventoryUnsupported: the extension inventory {what}, and its last good copy was written by a newer Yavin (version {version}); both were kept, untouched. Update Yavin."
            )),
            Loaded::Unreadable | Loaded::Corrupt { backup: None } => Err(format!(
                "InventoryUnavailable: the extension inventory {what}, and its last good copy cannot be read right now; nothing was changed."
            )),
            Loaded::Missing | Loaded::Corrupt { backup: Some(_) } => self.rebuild(paths, what),
        }
    }

    /// An inventory from the store copies alone: each that validates -- a canonical id, a plain
    /// folder inside the store named `<version>-<sha8>`, its manifest that id and version -- is
    /// recorded (the newest active, the next its previous), disabled, with no grant. Everything
    /// else -- what does not validate, older copies, staging -- is moved, not deleted, into
    /// `.unrecovered-<ms>/`. Idempotent: run again (after a crash), it finds what is left.
    fn rebuild(&self, paths: &Paths, what: &str) -> Result<Inventory, String> {
        let root = &paths.root;
        let aside = root.join(format!(
            "{UNRECOVERED}-{}",
            ide_workspace::durable::now_millis()
        ));
        let mut kept = 0;
        let mut copies: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();
        if let Ok(ids) = fs::read_dir(root.join(STORE)) {
            for entry in ids.flatten() {
                let id = entry.file_name().to_string_lossy().into_owned();
                let plain = fs::symlink_metadata(entry.path()).is_ok_and(|m| m.is_dir());
                if !is_canonical(&id) || !plain {
                    self.keep(root, &aside, &entry.path(), &mut kept)?;
                    continue;
                }
                for copy in fs::read_dir(entry.path()).into_iter().flatten().flatten() {
                    let folder = format!("{STORE}/{id}/{}", copy.file_name().to_string_lossy());
                    match validated(root, &id, &folder) {
                        Some(version) => copies
                            .entry(id.clone())
                            .or_default()
                            .push((version, folder)),
                        None => self.keep(root, &aside, &copy.path(), &mut kept)?,
                    }
                }
            }
        }
        // Staging nothing records any more: kept, not discarded.
        for entry in fs::read_dir(root.join(STAGING))
            .into_iter()
            .flatten()
            .flatten()
        {
            self.keep(root, &aside, &entry.path(), &mut kept)?;
        }
        let mut inventory = Inventory {
            // Imported long ago, or never needed: a stale list is not brought in again.
            disabled_imported: true,
            ..Inventory::default()
        };
        for (id, mut found) in copies {
            found.sort_by(|a, b| version_order(&b.0, &a.0));
            for (_, folder) in found.iter().skip(2) {
                self.keep(root, &aside, &join(root, folder), &mut kept)?;
            }
            let copy = |(version, folder): &(String, String)| Copy {
                version: version.clone(),
                folder: folder.clone(),
                sha256: None,
                source: "unknown".into(),
                installed_at: now(),
                // Rebuilt from the folder alone: what its signature was is not known (EXT-09).
                signature: None,
            };
            inventory.extensions.insert(
                id.clone(),
                Record {
                    active: copy(&found[0]),
                    previous: found.get(1).map(copy),
                    broken: None,
                },
            );
            inventory.disabled.insert(id);
        }
        // IDE-09's root folders are adopted by listing, as always -- disabled too.
        for found in discover(root).extensions {
            if let Some(Ok((id, _))) = found.manifest.as_deref().map(identity) {
                inventory.disabled.insert(id);
            }
        }
        self.crash("rebuilt")?;
        let count = inventory.disabled.len();
        note(
            &mut inventory,
            None,
            format!(
                "The extension inventory {what}, and so was its last good copy; it was rebuilt from the installed copies. {count} extension(s) are disabled until you enable them again, and none has the permissions it had.{}",
                if kept > 0 {
                    format!(" {kept} folder(s) that could not be used were kept in {}.", display(&aside))
                } else {
                    String::new()
                }
            ),
        );
        Ok(inventory)
    }

    /// Moves `path` (inside the root) to the same place under `aside`: kept, never deleted. A
    /// move that fails stops the rebuild with nothing written.
    fn keep(&self, root: &Path, aside: &Path, path: &Path, kept: &mut usize) -> Result<(), String> {
        let relative = path
            .strip_prefix(root)
            .map_err(|_| "InventoryUnrecoverable: a folder outside the extensions folder.")?;
        let target = aside.join(relative);
        let refused = |e: std::io::Error| {
            format!(
                "InventoryUnrecoverable: {} could not be kept aside ({e}); nothing was deleted or written.",
                display(path)
            )
        };
        fs::create_dir_all(target.parent().unwrap_or(aside)).map_err(refused)?;
        fs::rename(path, &target).map_err(refused)?;
        *kept += 1;
        self.crash("kept")
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
    /// committed one kept. One that is running, or waiting for its window, refuses (`Busy`);
    /// one waiting longer than `ABANDONED_AFTER`, or with no owner (a step of it failed, so
    /// no window can go on with it), is ended now.
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
        let waiting = inner
            .waiting
            .get(&op)
            .is_some_and(|since| since.elapsed() < self.abandoned_after());
        if inner.running.contains(&op) || waiting {
            return Err(format!("Busy: {id} is already being installed."));
        }
        // Each end leaves `waiting` only once its write succeeded: a failed one is tried again.
        match state {
            OpState::Committed => self.finish_locked(inner, paths, &op, true),
            _ => {
                Self::write(inner, paths, |inv| {
                    inv.operations.remove(&op);
                    Ok(())
                })?;
                inner.waiting.remove(&op);
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
                    signature: None,
                },
            );
            Ok(())
        })?;
        if let Err(e) = fs::create_dir_all(&folder) {
            // Not left recorded. Should this write fail too, the operation has no owner and the
            // next `settle` ends it.
            let _ = Self::write(&mut inner, paths, |inv| {
                inv.operations.remove(&op);
                Ok(())
            });
            let _ = fs::remove_dir_all(&folder);
            return Err(format!("InstallFailed: {e}"));
        }
        inner.running.insert(op.clone());
        Ok((op, folder))
    }

    /// The package of `op` is unpacked into `<staging>/files`: its manifest must be what
    /// `begin` was asked for. Returns the manifest's text.
    #[cfg(test)]
    pub fn staged(&self, op: &str, sha256: &str) -> Result<String, String> {
        self.staged_with(op, sha256, None)
    }

    /// `staged`, with what the package's signature was found to be (EXT-09) -- bound to these
    /// very package bytes (its SHA-256), or refused.
    pub fn staged_with(
        &self,
        op: &str,
        sha256: &str,
        signature: Option<SignatureRecord>,
    ) -> Result<String, String> {
        if signature
            .as_ref()
            .is_some_and(|s| !s.sha256.eq_ignore_ascii_case(sha256))
        {
            self.abort(op);
            return Err("InstallFailed: the signature checked is not this package's.".into());
        }
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
        // Its permissions must be ones this Yavin offers (EXT-07): a refused declaration is
        // never installed.
        let checked = checked.and_then(|manifest| {
            let value = serde_json::from_str::<serde_json::Value>(&manifest).unwrap_or_default();
            declared(&value, &operation.id)
                .map(|_| manifest)
                .map_err(|why| format!("InvalidPackage: its permissions cannot be used: {why}."))
        });
        // Its API and its dependencies (EXT-12): the whole graph, against what is installed,
        // before anything is put in place -- or nothing is.
        let checked = match checked {
            Ok(manifest) => self
                .resolvable(
                    &mut inner,
                    paths,
                    &operation.id,
                    &operation.version,
                    &manifest,
                )
                .map(|()| manifest),
            Err(error) => Err(error),
        };
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
            operation.signature = signature.clone();
            Ok(())
        })?;
        inner.waiting.insert(op.to_string(), Instant::now());
        self.crash("staged")?;
        Ok(manifest)
    }

    /// Whether `id` `version` (its `manifest`) can be installed beside what is installed
    /// (EXT-12): its API is this Yavin's, its declarations are valid, every required dependency
    /// is installed, enabled, usable and in range (none is installed, replaced or enabled for
    /// it), no cycle, no incompatibility, and no installed extension it would break.
    fn resolvable(
        &self,
        inner: &mut Inner,
        paths: &Paths,
        id: &str,
        version: &str,
        manifest: &str,
    ) -> Result<(), String> {
        let value = serde_json::from_str::<serde_json::Value>(manifest)
            .map_err(|e| format!("InvalidManifest: {e}."))?;
        let declared = deps::declared(&value, id).map_err(|e| format!("InvalidManifest: {e}."))?;
        deps::check_api(&declared).map_err(|e| format!("IncompatibleApi: {id} {version}: {e}."))?;
        let version = semver::Version::parse(version)
            .map_err(|e| format!("InvalidManifest: version {version}: {e}."))?;
        let listed = self.reconcile(inner, paths)?.0;
        let mut candidates = installed_candidates(inner, &listed, id);
        candidates.push(deps::Candidate {
            id: id.to_string(),
            version: version.clone(),
            source: deps::Source::Available,
            declared,
            unusable: None,
        });
        let plan = deps::resolve(id, &deps::Range::exactly(&version), &candidates)
            .map_err(|conflict| conflict.text())?;
        // Nothing is installed for it: what it needs must already be there.
        let others: Vec<String> = plan
            .install
            .iter()
            .filter(|(other, _)| other != id)
            .map(|(other, v)| format!("{other} {v}"))
            .collect();
        if !others.is_empty() {
            return Err(format!(
                "DependencyMissing: {id} needs {}; install them first.",
                others.join(", ")
            ));
        }
        Ok(())
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
            signature: operation.signature.clone(),
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
        // Only now: a failed write leaves it the window's, to finish again.
        inner.waiting.remove(op);
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
            inv.grants.remove(&id);
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

    /// A file of `id`'s copy -- the one `list` reports -- for the window to read: a theme or
    /// snippets (EXT-04). Contained in that folder, a plain file, at most 1 MiB.
    pub fn resource_of(&self, requested: &str, path: &str) -> Result<String, String> {
        let id = canonical_id(requested)
            .ok_or_else(|| format!("UnknownExtension: \"{requested}\" is not an extension id."))?;
        let (mut inner, paths) = self.lock()?;
        let (listed, _) = self.reconcile(&mut inner, paths)?;
        drop(inner);
        let chosen = listed
            .into_iter()
            .find(|one| one.id.as_deref() == Some(id.as_str()) && one.error.is_none())
            .ok_or_else(|| format!("UnknownExtension: {id} is not installed."))?;
        read_resource(Path::new(&chosen.folder), path)
    }

    /// The folder and entry point the host loads for `id` (`host_copy`'s choice), for tests.
    #[cfg(test)]
    pub fn folder_of(&self, requested: &str) -> Result<(PathBuf, String), String> {
        self.host_copy(requested)
            .map(|copy| (PathBuf::from(copy.folder), copy.main))
    }

    // --- Permissions (EXT-07) ------------------------------------------------------------------

    /// Allows exactly `capabilities` for the copy of `id` that `list` reports (an empty list
    /// allows nothing: the grant is removed). Each must be one that copy's manifest requests;
    /// the copy is chosen here, never by the window. `reviewed`: the version the user decided
    /// about -- another copy listed meanwhile (an update) is refused (`ExtensionChanged`).
    /// Returns the state now.
    pub fn set_grants(
        &self,
        requested: &str,
        reviewed: Option<&str>,
        capabilities: &[String],
    ) -> Result<PermissionState, String> {
        let id = canonical_id(requested)
            .ok_or_else(|| format!("InvalidRequest: \"{requested}\" is not an extension id."))?;
        let (mut inner, paths) = self.lock()?;
        let (listed, _) = self.reconcile(&mut inner, paths)?;
        let chosen = listed
            .into_iter()
            .find(|one| one.id.as_deref() == Some(id.as_str()) && one.error.is_none())
            .ok_or_else(|| format!("UnknownExtension: {id} is not installed."))?;
        let (Some(copy), Some(state)) = (chosen.copy, chosen.permissions) else {
            return Err(format!("UnknownExtension: {id} is not installed."));
        };
        if let Some(version) = reviewed.filter(|v| *v != copy.version) {
            return Err(format!(
                "ExtensionChanged: {id} is now version {}, not {version}; review its permissions again.",
                copy.version
            ));
        }
        let mut wanted = BTreeSet::new();
        for capability in capabilities {
            if !state.requested.contains(capability) {
                return Err(format!(
                    "NotRequested: {id} {} does not request \"{capability}\"; only what an extension's manifest requests can be allowed.",
                    copy.version
                ));
            }
            wanted.insert(capability.clone());
        }
        let grant = Grant {
            folder: chosen.folder.clone(),
            version: copy.version.clone(),
            sha256: copy.sha256.clone(),
            capabilities: wanted,
            granted_at: now(),
        };
        Self::write(&mut inner, paths, |inv| {
            if grant.capabilities.is_empty() {
                inv.grants.remove(&id);
            } else {
                inv.grants.insert(id.clone(), grant.clone());
            }
            Ok(())
        })?;
        let grants = &inner.inventory.as_ref().ok_or("InstallFailed")?.grants;
        let requested: BTreeSet<String> = state.requested.iter().cloned().collect();
        Ok(permission_state(
            &requested,
            state.legacy,
            grants.get(&id),
            &chosen.folder,
            &copy,
        ))
    }

    /// The copy the host loads for `id` (the one `list` reports), with what it requests. A
    /// disabled extension is never loaded (EXT-07, F5).
    pub fn host_copy(&self, requested: &str) -> Result<HostCopy, String> {
        let id = canonical_id(requested)
            .ok_or_else(|| format!("UnknownExtension: \"{requested}\" is not an extension id."))?;
        let (mut inner, paths) = self.lock()?;
        let (listed, _) = self.reconcile(&mut inner, paths)?;
        let disabled = inner
            .inventory
            .as_ref()
            .is_some_and(|inv| inv.disabled.contains(&id));
        if disabled {
            return Err(format!("ExtensionDisabled: {id} is disabled."));
        }
        let chosen = listed
            .iter()
            .find(|one| one.id.as_deref() == Some(id.as_str()) && one.error.is_none())
            .cloned()
            .ok_or_else(|| format!("UnknownExtension: {id} is not installed."))?;
        let main = chosen
            .manifest
            .as_deref()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
            .and_then(|value| value.get("main")?.as_str().map(str::to_string))
            .ok_or_else(|| format!("UnsupportedRuntime: {id} has no code (no \"main\")."))?;
        let (Some(copy), Some(state)) = (chosen.copy.clone(), chosen.permissions.clone()) else {
            return Err(format!("UnknownExtension: {id} is not installed."));
        };
        // Its API and its dependencies (EXT-12), natively, whatever the window believes.
        let requires = load_requirements(&inner, &listed, &chosen, &id)?;
        Ok(HostCopy {
            id,
            folder: chosen.folder,
            main,
            version: copy.version,
            sha256: copy.sha256,
            stored: copy.stored,
            requested: state.requested.into_iter().collect(),
            requires,
        })
    }

    /// Whether the code of `copy` (what a host loaded) may still act: the extension is enabled
    /// and `copy` is still the copy Yavin uses -- and, for `capability`, its manifest requests
    /// it and it is granted for that very copy. From the inventory in memory, so a revocation,
    /// a disable or an update holds for the next request.
    pub fn authorize(&self, copy: &HostCopy, capability: Option<&str>) -> Result<(), Denial> {
        let (inner, _) = self
            .lock()
            .map_err(|why| Denial::new("InventoryUnavailable", why))?;
        let inv = inner
            .inventory
            .as_ref()
            .ok_or_else(|| Denial::new("InventoryUnavailable", "The inventory is not read."))?;
        let id = &copy.id;
        if inv.disabled.contains(id) {
            return Err(Denial::new(
                "ExtensionDisabled",
                format!("{id} is disabled."),
            ));
        }
        let current = match (&copy.stored, inv.extensions.get(id)) {
            (Some(stored), Some(record)) => {
                record.active.folder == *stored && record.active.version == copy.version
            }
            // A development copy: still the one used while nothing is installed over it.
            (None, None) => true,
            _ => false,
        };
        if !current {
            return Err(Denial::new(
                "ExtensionChanged",
                format!("The running code of {id} is no longer the installed copy; it must be reloaded."),
            ));
        }
        // Its required dependencies still there, enabled and in range (EXT-12).
        for need in &copy.requires {
            let gone = || {
                Denial::new(
                    "DependencyUnavailable",
                    format!(
                        "{id} needs {} {}, which is no longer available.",
                        need.id, need.range.text
                    ),
                )
            };
            if inv.disabled.contains(&need.id) {
                return Err(Denial::new(
                    "DependencyUnavailable",
                    format!("{id} needs {}, which is disabled.", need.id),
                ));
            }
            match inv.extensions.get(&need.id) {
                Some(record) => {
                    let fits = semver::Version::parse(&record.active.version)
                        .is_ok_and(|v| need.range.matches(&v));
                    if !fits {
                        return Err(gone());
                    }
                }
                None if need.installed => return Err(gone()),
                None => {}
            }
        }
        let Some(capability) = capability else {
            return Ok(());
        };
        if !copy.requested.contains(capability) {
            return Err(Denial::new(
                "PermissionDenied",
                format!("{id} does not request \"{capability}\" in its manifest."),
            ));
        }
        let granted = inv.grants.get(id).is_some_and(|grant| {
            grant.binds(&copy.folder, &copy.version, copy.sha256.as_deref())
                && grant.capabilities.contains(capability)
        });
        if !granted {
            return Err(Denial::new(
                "PermissionDenied",
                format!("\"{capability}\" is not allowed for {id} {}.", copy.version),
            ));
        }
        Ok(())
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
                    permissions: None,
                    copy: None,
                    signature: None,
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
                            signature: None,
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
            let facts = |copy: &Copy| CopyFacts {
                version: copy.version.clone(),
                sha256: copy.sha256.clone(),
                stored: Some(copy.folder.clone()),
            };
            // A signature record holds only for the bytes it was checked against (EXT-09): one
            // whose SHA-256 is not this copy's is not reported at all.
            let signature_of = |copy: &Copy| {
                copy.signature.clone().filter(|s| {
                    copy.sha256
                        .as_deref()
                        .is_some_and(|sha| s.sha256.eq_ignore_ascii_case(sha))
                })
            };
            let mut entry = Listed {
                id: Some(id.clone()),
                folder: display(&join(root, &record.active.folder)),
                manifest: None,
                error: None,
                source: "installed",
                shadowed: shadows.remove(&id).unwrap_or_default(),
                permissions: None,
                copy: Some(facts(&record.active)),
                signature: signature_of(&record.active),
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
                            entry.copy = Some(facts(&previous));
                            entry.signature = signature_of(&previous);
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
                            entry.copy = None;
                            entry.signature = None;
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
                        permissions: None,
                        copy: None,
                        signature: None,
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
                    permissions: None,
                    copy: Some(CopyFacts {
                        version,
                        sha256: None,
                        stored: None,
                    }),
                    signature: None,
                });
            }
        }
        // What each usable copy requests, and what of it is granted for that very copy. A
        // declaration this Yavin cannot read makes the copy unusable: it is never loaded.
        let grants = &inner.inventory.as_ref().ok_or("InstallFailed")?.grants;
        for entry in &mut listed {
            let (Some(id), Some(copy), None) = (&entry.id, &entry.copy, &entry.error) else {
                continue;
            };
            let manifest = entry
                .manifest
                .as_deref()
                .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
                .unwrap_or_default();
            match declared(&manifest, id) {
                Ok(wanted) => {
                    entry.permissions = Some(permission_state(
                        &wanted.requested,
                        wanted.legacy,
                        grants.get(id),
                        &entry.folder,
                        copy,
                    ))
                }
                Err(why) => {
                    entry.error = Some(format!("Its permissions cannot be used: {why}."));
                    entry.copy = None;
                }
            }
        }
        Ok((listed, skipped))
    }
}

/// The window's view of a copy's permissions: what it requests, what of it the grant -- if
/// bound to this very copy -- allows, and a grant for another copy, shown as such.
fn permission_state(
    requested: &BTreeSet<String>,
    legacy: bool,
    grant: Option<&Grant>,
    folder: &str,
    copy: &CopyFacts,
) -> PermissionState {
    let bound = grant.filter(|g| g.binds(folder, &copy.version, copy.sha256.as_deref()));
    PermissionState {
        legacy,
        requested: requested.iter().cloned().collect(),
        granted: bound
            .map(|g| g.capabilities.intersection(requested).cloned().collect())
            .unwrap_or_default(),
        previous: grant.filter(|_| bound.is_none()).map(|g| PreviousGrant {
            version: g.version.clone(),
            granted: g.capabilities.iter().cloned().collect(),
        }),
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
    // A grant naming what is not a capability, or for what is not an id, is dropped whole: an
    // unreadable grant allows nothing (EXT-07).
    let grants = inventory.grants.len();
    inventory
        .grants
        .retain(|id, grant| grant.capabilities.iter().all(|c| grantable(id, c)));
    if grants != inventory.grants.len() {
        note(
            &mut inventory,
            None,
            "Extension permissions that are not valid were dropped; those extensions are allowed nothing until they are allowed again.".into(),
        );
    }
    if before != (inventory.extensions.len(), inventory.operations.len()) {
        note(
            &mut inventory,
            None,
            "Entries of the extension inventory that are not valid extension ids or install operations were dropped.".into(),
        );
    }
    inventory
}

/// Both copies, the last-good one first: it is never older than the inventory. Either write
/// failing leaves the inventory as it was -- and, should the inventory's own write fail, the
/// last-good copy is put back as it was too, so it is never ahead with a change that failed.
fn save(paths: &Paths, inventory: &Inventory) -> Result<(), String> {
    let text =
        serde_json::to_string_pretty(inventory).map_err(|e| format!("InstallFailed: {e}"))?;
    let failed =
        |e: String| format!("InstallFailed: the extension inventory could not be saved ({e}).");
    let last_good = paths.root.join(LAST_GOOD);
    let earlier = fs::read(&last_good).ok();
    write_durably(&last_good, text.as_bytes()).map_err(failed)?;
    if let Err(error) = write_durably(&paths.root.join(INVENTORY), text.as_bytes()) {
        let _ = match &earlier {
            Some(bytes) => write_durably(&last_good, bytes),
            None => remove_durably(&last_good),
        };
        return Err(failed(error));
    }
    Ok(())
}

fn read_inventory(file: &Path) -> Loaded<Inventory> {
    read_versioned(file, INVENTORY_VERSION, json_version, |text, version| {
        (version == INVENTORY_VERSION)
            .then(|| serde_json::from_str::<Inventory>(text).ok())
            .flatten()
    })
}

/// Whether anything was installed here by an inventory (not just IDE-09's root folders).
fn installed_data(root: &Path) -> bool {
    let nonempty = |folder: &str| {
        fs::read_dir(root.join(folder)).is_ok_and(|mut entries| entries.next().is_some())
    };
    nonempty(STORE) || nonempty(STAGING) || root.join(LAST_GOOD).exists()
}

/// The version of store copy `folder` of `id` if it is one: a plain folder inside the root
/// named `<version>-<sha8>`, whose manifest is `id` at that version.
fn validated(root: &Path, id: &str, folder: &str) -> Option<String> {
    if !folder_ok(folder) {
        return None;
    }
    let path = join(root, folder);
    if !fs::symlink_metadata(&path).is_ok_and(|m| m.is_dir()) {
        return None;
    }
    let name = folder.rsplit('/').next()?;
    let (version, sha8) = name.rsplit_once('-')?;
    let hex = sha8.len() == 8 && sha8.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    if !hex || crate::extension_package::version_ok(version).is_err() {
        return None;
    }
    let inside = match (root.canonicalize(), path.canonicalize()) {
        (Ok(base), Ok(real)) => real.starts_with(&base),
        _ => false,
    };
    (inside && read_copy(&path, id, Some(version)).is_ok()).then(|| version.to_string())
}

/// Semantic version order (a pre-release before its release); enough to choose the newest copy.
fn version_order(a: &str, b: &str) -> std::cmp::Ordering {
    let parts = |v: &str| {
        let v = v.split('+').next().unwrap_or(v);
        let (core, pre) = match v.split_once('-') {
            Some((core, pre)) => (core.to_string(), Some(pre.to_string())),
            None => (v.to_string(), None),
        };
        let numbers: Vec<u64> = core.split('.').map(|n| n.parse().unwrap_or(0)).collect();
        (numbers, pre)
    };
    let ((a_core, a_pre), (b_core, b_pre)) = (parts(a), parts(b));
    a_core.cmp(&b_core).then_with(|| match (a_pre, b_pre) {
        (None, None) => std::cmp::Ordering::Equal,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (Some(_), None) => std::cmp::Ordering::Less,
        (Some(x), Some(y)) => x.cmp(&y),
    })
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

/// One of an installed extension's files (its themes and snippets: EXT-04), as text.
#[tauri::command(async)]
pub fn extensions_read_resource(
    service: State<'_, ExtensionService>,
    id: String,
    path: String,
) -> Result<String, String> {
    service.resource_of(&id, &path)
}

#[tauri::command(async)]
pub fn extensions_set_enabled(
    service: State<'_, ExtensionService>,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    service.set_enabled(&id, enabled)
}

/// Allows exactly `capabilities` for an extension's installed copy, the `version` the user
/// reviewed (EXT-07); returns the state.
#[tauri::command(async)]
pub fn extensions_set_grants(
    service: State<'_, ExtensionService>,
    id: String,
    version: String,
    capabilities: Vec<String>,
) -> Result<PermissionState, String> {
    service.set_grants(&id, Some(&version), &capabilities)
}

#[cfg(test)]
#[path = "extension_service_tests.rs"]
mod tests;
