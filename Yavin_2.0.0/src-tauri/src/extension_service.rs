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
use crate::extension_diagnostics::{self as diag, Diagnostic, Diagnostics, Event};
use crate::extension_package::identity;
use crate::extension_permissions::{declared, grantable, Denial};
use crate::extension_profiles::{self as profiles, Profiles, ProfilesView};
use crate::extension_secrets::{SecretBackend, SecretOwner, SecretScope, SecretStore};
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
/// The inventory's schema (EXT-17). 2 adds `filesSha256` and `unchecked` on copies and
/// `replaced` on records. **Every change of what is persisted bumps it** (and is migrated in
/// `read_inventory`): a Yavin that reads an inventory written by a newer one refuses it --
/// it never reads it and drops what it does not know (grants, profiles, signature records,
/// files digests) on its next write. A test pins the persisted fields to this version.
/// 3 (EXT-19) adds `trust` on copies.
const INVENTORY_VERSION: u32 = 3;
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
    /// The digest of its files as they were put in place (EXT-15, `tree_digest`): what binds
    /// the unpacked copy to the verified package. Checked whenever the copy is used; none for a
    /// copy installed before EXT-15, adopted or rebuilt (its files cannot be checked).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files_sha256: Option<String>,
    /// Why it has no files digest (EXT-17), when it has none: never a claim that its files
    /// are the package's. A copy with neither is taken for `Rebuilt` (the most restricted).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unchecked: Option<Unchecked>,
    /// Its trust facts, authenticated (EXT-19: `extension_trust`): made when Yavin verified
    /// its package and files -- at install, or a reinstall that bound them -- and checked
    /// whenever it is listed or loaded. None: never vouched for; its code does not run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trust: Option<crate::extension_trust::TrustRecord>,
}

/// Why a copy's files cannot be checked (EXT-17), and so what it may do.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Unchecked {
    /// Installed by Yavin before files were bound (EXT-15): its package was verified then;
    /// its files were never compared. It runs; a reinstall checks and binds them.
    Legacy,
    /// One of IDE-09's root folders, adopted where it was: no package is on record. It runs;
    /// a reinstall from a registry binds it.
    Adopted,
    /// Recovered from the folders after the inventory and its last good copy were lost --
    /// what an attacker who stripped the digests would cause. Its code does not run until it
    /// is reinstalled; what is declarative (themes, snippets) still applies.
    Rebuilt,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub active: Copy,
    pub previous: Option<Copy>,
    /// Why the active copy cannot be used and there was nothing to fall back to.
    pub broken: Option<String>,
    /// The copy that could not be used when its previous one took its place (EXT-17): said
    /// beside the copy now used, until the next install, update or uninstall.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replaced: Option<Replaced>,
}

/// A copy that was replaced by its intact previous one (EXT-17).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Replaced {
    pub version: String,
    pub reason: String,
    /// Seconds since the Unix epoch.
    pub at: u64,
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
    /// The extension profiles (EXT-13); the active one's enabled set is `disabled`. Absent
    /// in an older inventory: the default profile alone, with what was disabled.
    #[serde(default)]
    pub profiles: Profiles,
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
            profiles: Profiles::default(),
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
    /// What its package's signature was found to be when installed (EXT-09) -- reported only
    /// while its files are bound to that package (EXT-17).
    pub signature: Option<SignatureRecord>,
    /// Whether its files are the package's (EXT-17); none for an entry with no copy.
    pub integrity: Option<Integrity>,
    /// The copy that could not be used, when this one -- its intact previous one -- took its
    /// place (EXT-17).
    pub replaced: Option<Replaced>,
}

/// What is known of a copy's files (EXT-17), as the window shows it.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Integrity {
    /// `verified` (bound and as installed), `unchecked` (no digest), `changed` (not as
    /// installed: not used), or `development` (a repository sample: mutable by design).
    pub state: &'static str,
    /// For `unchecked`: `legacy`, `adopted` or `rebuilt`.
    pub reason: Option<&'static str>,
    /// Whether its code may run.
    pub runs: bool,
}

impl Integrity {
    /// What is known of `copy` of `id`: its files digest, and -- EXT-19 -- its trust record,
    /// authenticated under `key`. Only a copy with both runs. A copy never checked (legacy,
    /// adopted, rebuilt) does not run either: it is reinstalled to be checked (EXT-19).
    fn of(
        id: &str,
        copy: &Copy,
        key: Result<&crate::extension_trust::TrustKey, &String>,
    ) -> Integrity {
        use crate::extension_trust::TrustFailure;
        let untrusted = |why: TrustFailure| Integrity {
            state: "untrusted",
            reason: Some(why.code()),
            runs: false,
        };
        match (&copy.files_sha256, copy.unchecked) {
            (Some(_), _) => match (&copy.trust, key) {
                (None, _) => untrusted(TrustFailure::Missing),
                (Some(_), Err(_)) => untrusted(TrustFailure::Unavailable),
                (Some(record), Ok(key)) => match key.verify(&trust_facts(id, copy), record) {
                    Ok(()) => Integrity {
                        state: "verified",
                        reason: None,
                        runs: true,
                    },
                    Err(why) => untrusted(why),
                },
            },
            (None, Some(Unchecked::Legacy)) => Integrity {
                state: "unchecked",
                reason: Some("legacy"),
                runs: false,
            },
            (None, Some(Unchecked::Adopted)) => Integrity {
                state: "unchecked",
                reason: Some("adopted"),
                runs: false,
            },
            (None, Some(Unchecked::Rebuilt) | None) => Integrity {
                state: "unchecked",
                reason: Some("rebuilt"),
                runs: false,
            },
        }
    }
    fn changed() -> Integrity {
        Integrity {
            state: "changed",
            reason: None,
            runs: false,
        }
    }
    fn development() -> Integrity {
        Integrity {
            state: "development",
            reason: None,
            runs: true,
        }
    }
}

/// The facts a trust record of `copy` of `id` binds (EXT-19).
fn trust_facts<'a>(id: &'a str, copy: &'a Copy) -> crate::extension_trust::TrustFacts<'a> {
    crate::extension_trust::TrustFacts {
        id,
        version: &copy.version,
        folder: &copy.folder,
        sha256: copy.sha256.as_deref(),
        files_sha256: copy.files_sha256.as_deref(),
        source: &copy.source,
        signature: copy.signature.as_ref(),
    }
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
    /// Where its copy came from (`Copy::source`; `development` for a sample): who its
    /// secrets belong to (EXT-13).
    pub origin: String,
    /// Its required dependencies (EXT-12): each must stay enabled, installed and in range for
    /// its code to act. `installed`: it was an installed copy (not a development one) when
    /// loaded.
    pub requires: Vec<HostRequirement>,
}

/// A profile switch (EXT-13): the profiles now, and which enabled extensions it leaves unable
/// to load, and why.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSwitch {
    pub profiles: ProfilesView,
    pub unavailable: Vec<Unavailable>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Unavailable {
    pub id: String,
    pub reason: String,
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
    /// The extension profiles, and the active one's settings (EXT-13).
    pub profiles: ProfilesView,
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
    /// Where extensions' secrets are kept (EXT-13): the platform's credential store unless a
    /// test says otherwise.
    secret_backend: Mutex<Option<std::sync::Arc<dyn SecretBackend>>>,
    /// What happened to extensions (EXT-14), beside them.
    diagnostics: OnceLock<Diagnostics>,
    /// Safe mode (EXT-14): no extension code loads, whatever is enabled. It only refuses.
    safe_mode: std::sync::atomic::AtomicBool,
    /// Copies' files digests, by folder, with the fingerprint they were computed for (EXT-15):
    /// computed again only when a file changed.
    digests: Mutex<HashMap<PathBuf, (String, String)>>,
    /// Counts grant changes in this process (EXT-16): a refusal already told to a window is
    /// told again once a grant changed since (it forgot it when the permission was allowed).
    grants_revision: std::sync::atomic::AtomicU64,
    /// Where the trust key is kept (EXT-19); the platform's unless a test says otherwise.
    trust_keys: Mutex<Option<std::sync::Arc<dyn crate::extension_trust::TrustKeyStore>>>,
    /// The trust key, once had (it does not change while Yavin runs).
    trust_key: Mutex<Option<std::sync::Arc<crate::extension_trust::TrustKey>>>,
    /// What getting the key said (an unreadable key kept aside), to be recorded as a recovery.
    trust_notes: Mutex<Vec<String>>,
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

/// `ExtensionService::authorize` against `inv` (the inventory, its lock held by the caller).
fn authorize_in(inv: &Inventory, copy: &HostCopy, capability: Option<&str>) -> Result<(), Denial> {
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
            format!(
                "The running code of {id} is no longer the installed copy; it must be reloaded."
            ),
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

/// Whether signature record `s` can be the record of a copy installed from `source`
/// (EXT-15): a signed one only from that very registry (`openvsx <url>` whose origin it
/// names); an unsigned one from a file only if it says `file`. A record that names another
/// source is not this copy's.
fn record_matches_source(s: &SignatureRecord, source: &str) -> bool {
    let origin_of = |url: &str| {
        url::Url::parse(url)
            .ok()
            .map(|u| u.origin().ascii_serialization())
    };
    match source.split_once(' ') {
        Some(("openvsx", url)) => origin_of(url).is_some_and(|o| o == s.registry),
        Some(("registry", url)) => {
            !s.status.trusted() && origin_of(url).is_some_and(|o| o == s.registry)
        }
        None if source == "file" => !s.status.trusted() && s.registry == "file",
        _ => false,
    }
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
            // A newer Yavin's inventory was kept aside: nothing is restored or rebuilt over it,
            // however often this Yavin starts (EXT-17).
            Loaded::Missing if newer_kept_aside(&paths.root).is_some() => Err(format!(
                "InventoryUnsupported: the extension inventory was written by a newer Yavin (version {}); it was kept aside, untouched. Update Yavin.",
                newer_kept_aside(&paths.root).unwrap_or_default()
            )),
            Loaded::Missing if !installed_data(&paths.root) => Ok((Inventory::default(), false)),
            Loaded::Missing => self.restore(paths, "was missing").map(|inv| (inv, true)),
            Loaded::Current(inventory) => Ok((inventory, false)),
            // Migrated (EXT-17): the file as it was is kept beside it, then the new version is
            // written at once -- an older Yavin then refuses it rather than drop what is new.
            Loaded::Migrated { value: mut inventory, from } => {
                let original = paths.root.join(format!(
                    "{INVENTORY}.v{from}-migrated-{}.bak",
                    ide_workspace::durable::now_millis()
                ));
                let text = fs::read(&file).map_err(|e| {
                    format!("InventoryUnavailable: the extension inventory cannot be read right now ({e}); nothing was changed.")
                })?;
                write_durably(&original, &text).map_err(|e| {
                    format!("InventoryUnavailable: the extension inventory could not be kept before it was upgraded ({e}); nothing was changed.")
                })?;
                note(
                    &mut inventory,
                    None,
                    format!(
                        "The extension inventory was upgraded from version {from} (the original was kept as {}). Copies installed before Yavin checked installed files are marked as not checked.",
                        display(&original)
                    ),
                );
                Ok((inventory, true))
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
                files_sha256: None,
                unchecked: Some(Unchecked::Rebuilt),
                trust: None,
            };
            inventory.extensions.insert(
                id.clone(),
                Record {
                    active: copy(&found[0]),
                    previous: found.get(1).map(copy),
                    broken: None,
                    replaced: None,
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
        let before = inner
            .inventory
            .as_ref()
            .and_then(|inv| inv.extensions.get(&id).cloned());
        // A copy already in place is reused only if it is these very bytes: a different package
        // whose hash merely starts the same (32 bits) gets a folder of its own (EXT-15).
        let short = format!("{STORE}/{id}/{}-{}", operation.version, &sha256[..8]);
        let taken_by_other = before.as_ref().is_some_and(|record| {
            std::iter::once(&record.active)
                .chain(record.previous.as_ref())
                .any(|copy| {
                    copy.folder == short
                        && !copy
                            .sha256
                            .as_deref()
                            .is_some_and(|s| s.eq_ignore_ascii_case(&sha256))
                })
        });
        let mut folder = if taken_by_other {
            format!(
                "{STORE}/{id}/{}-{}",
                operation.version,
                sha256.to_ascii_lowercase()
            )
        } else {
            short
        };
        let mut target = join(root, &folder);
        // What binds the files to the verified package (EXT-15): their digest, as staged.
        let files_sha256 = Some(
            crate::extension_package::tree_digest(&staged).map_err(|why| {
                format!("InstallFailed: the staged package cannot be read: {why}.")
            })?,
        );
        let mut in_use = folders_of(before.as_ref()).contains(&folder);
        // The same package again (a reinstall) into a copy already in place (EXT-17): its files
        // are compared with the verified package's. The same: they are bound to it (and its
        // fresh signature record kept). Not the same: that copy is not reused, nor kept to
        // fall back on -- the package gets a folder of its own.
        let mut mismatched: Option<String> = None;
        if in_use {
            let actual = crate::extension_package::tree_digest(&target).ok();
            if actual.as_deref() != files_sha256.as_deref() {
                mismatched = Some(folder.clone());
                let short = format!("{STORE}/{id}/{}-{}", operation.version, &sha256[..8]);
                let long = format!(
                    "{STORE}/{id}/{}-{}",
                    operation.version,
                    sha256.to_ascii_lowercase()
                );
                let other = if folder == short { long } else { short };
                if folders_of(before.as_ref()).contains(&other) {
                    return Err(format!(
                        "InstallFailed: both of {id} {}'s folders are in use; uninstall it, then install it again.",
                        operation.version
                    ));
                }
                folder = other;
                target = join(root, &folder);
                in_use = false;
            }
        }
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
        let mut copy = Copy {
            version: operation.version.clone(),
            folder: folder.clone(),
            sha256: Some(sha256),
            source: operation.source.clone(),
            installed_at: now(),
            signature: operation.signature.clone(),
            files_sha256,
            unchecked: None,
            trust: None,
        };
        // Vouched for (EXT-19): its package verified, its files just digested.
        copy.trust = self.seal(root, &id, &copy);
        // A copy in place that is this package, checked just now: bound to it (EXT-17).
        let fresh = copy.clone();
        let bound = |old: &Copy| {
            let mut bound = Copy {
                files_sha256: fresh.files_sha256.clone(),
                unchecked: None,
                signature: fresh.signature.clone(),
                source: fresh.source.clone(),
                trust: None,
                ..old.clone()
            };
            // Its files are the verified package's, checked just now: vouched for (EXT-19).
            bound.trust = self.seal(root, &id, &bound);
            bound
        };
        let switched = Self::write(&mut inner, paths, |inv| {
            let record = match &before {
                Some(old) if old.active.folder == folder => Record {
                    active: bound(&old.active),
                    previous: old.previous.clone(),
                    broken: None,
                    replaced: None,
                },
                Some(old) if old.previous.as_ref().is_some_and(|p| p.folder == folder) => Record {
                    active: bound(old.previous.as_ref().ok_or("InstallFailed")?),
                    previous: Some(old.active.clone()),
                    broken: None,
                    replaced: None,
                },
                // The copy in place was not this package: never kept to fall back on.
                Some(old) if mismatched.is_some() => Record {
                    previous: [Some(&old.active), old.previous.as_ref()]
                        .into_iter()
                        .flatten()
                        .find(|c| Some(&c.folder) != mismatched.as_ref())
                        .cloned(),
                    active: copy,
                    broken: None,
                    replaced: None,
                },
                Some(old) => Record {
                    active: copy,
                    previous: Some(old.active.clone()),
                    broken: None,
                    replaced: None,
                },
                None => Record {
                    active: copy,
                    previous: None,
                    broken: None,
                    replaced: None,
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
        if !keep {
            self.diagnostics().record(
                Event::new("InstallRolledBack", "update")
                    .extension(canonical_id(requested).unwrap_or_default())
                    .correlation(format!("install-{op}")),
            );
        }
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
            profiles::forget_extension(&mut inv.profiles, &id);
            inv.extensions.remove(&id).ok_or_else(|| {
                format!("UnknownExtension: {id} is not installed in Yavin's extensions folder.")
            })
        })?;
        for folder in folders_of(Some(&record)) {
            remove_copy(&paths.root, &folder);
        }
        let _ = fs::remove_dir(paths.root.join(STORE).join(&id));
        // Its secrets go with it (EXT-13). If the store cannot delete them now, that is said;
        // a later install from another origin still cannot read them (`SecretOwnerChanged`).
        let store = self.secret_store(paths);
        if let Err(why) = store.forget_extension(&id) {
            if store.available() {
                let _ = Self::write(&mut inner, paths, |inv| {
                    note(
                        inv,
                        Some(&id),
                        format!(
                            "{id} was uninstalled, but its secrets could not be deleted: {why}"
                        ),
                    );
                    Ok(())
                });
            }
        }
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

    // --- Profiles (EXT-13) -----------------------------------------------------------------------

    pub fn profiles(&self) -> Result<ProfilesView, String> {
        let (inner, _) = self.lock()?;
        Ok(inner
            .inventory
            .as_ref()
            .ok_or("InstallFailed")?
            .profiles
            .view())
    }

    /// One change to the profiles, written with the inventory or not at all.
    fn change_profiles(
        &self,
        change: impl FnOnce(&mut Inventory) -> Result<(), String>,
    ) -> Result<ProfilesView, String> {
        let (mut inner, paths) = self.lock()?;
        Self::write(&mut inner, paths, change)?;
        Ok(inner
            .inventory
            .as_ref()
            .ok_or("InstallFailed")?
            .profiles
            .view())
    }

    pub fn create_profile(&self, name: &str) -> Result<ProfilesView, String> {
        self.change_profiles(|inv| {
            let live = inv.disabled.clone();
            profiles::create(&mut inv.profiles, &live, name).map(|_| ())
        })
    }

    pub fn rename_profile(&self, id: &str, name: &str) -> Result<ProfilesView, String> {
        self.change_profiles(|inv| profiles::rename(&mut inv.profiles, id, name))
    }

    /// Deletes profile `id` and its secrets -- the secrets first: if they cannot be deleted,
    /// the profile is kept (nothing is left that no profile owns).
    pub fn delete_profile(&self, id: &str) -> Result<ProfilesView, String> {
        let (mut inner, paths) = self.lock()?;
        let view = inner
            .inventory
            .as_ref()
            .ok_or("InstallFailed")?
            .profiles
            .clone();
        if id == view.active || id == profiles::DEFAULT || !view.list.contains_key(id) {
            let mut probe = view;
            profiles::delete(&mut probe, id)?;
        }
        let store = self.secret_store(paths);
        if store.available() {
            store.forget_profile(id)?;
        }
        Self::write(&mut inner, paths, |inv| {
            profiles::delete(&mut inv.profiles, id)
        })?;
        Ok(inner
            .inventory
            .as_ref()
            .ok_or("InstallFailed")?
            .profiles
            .view())
    }

    /// Makes `id` the active profile, in one write: from now on every load and request sees its
    /// enabled set. Its enabled extensions whose required dependency it disables are said
    /// (they do not load: EXT-12) -- the switch is not refused for them.
    pub fn select_profile(&self, id: &str) -> Result<ProfileSwitch, String> {
        let view = self.change_profiles(|inv| {
            let mut live = std::mem::take(&mut inv.disabled);
            let result = profiles::select(&mut inv.profiles, &mut live, id);
            inv.disabled = live;
            result
        })?;
        let (mut inner, paths) = self.lock()?;
        let listed = self.reconcile(&mut inner, paths)?.0;
        let mut unavailable = Vec::new();
        for one in listed.iter().filter(|one| one.error.is_none()) {
            let Some(own) = one.id.as_deref() else {
                continue;
            };
            if inner
                .inventory
                .as_ref()
                .is_some_and(|inv| inv.disabled.contains(own))
            {
                continue;
            }
            let value: serde_json::Value =
                serde_json::from_str(one.manifest.as_deref().unwrap_or("{}")).unwrap_or_default();
            if let Err(why) = load_requirements(&inner, &listed, one, own) {
                if value.get("main").is_some() || why.starts_with("DependencyUnavailable") {
                    unavailable.push(Unavailable {
                        id: own.to_string(),
                        reason: why,
                    });
                }
            }
        }
        for one in &unavailable {
            self.diagnostics().record(
                Event::new("ProfileDependency", "profile")
                    .extension(one.id.clone())
                    .detail(one.reason.clone())
                    .correlation(format!("profile-{id}")),
            );
        }
        Ok(ProfileSwitch {
            profiles: view,
            unavailable,
        })
    }

    /// Sets (`None`: removes) extension `id`'s setting `key` in the active profile -- a
    /// setting it declares, a value valid for it (EXT-18), whatever it replaces.
    pub fn set_profile_setting(
        &self,
        id: &str,
        key: &str,
        value: Option<serde_json::Value>,
    ) -> Result<ProfilesView, String> {
        let (mut inner, paths) = self.lock()?;
        let declared = self.declared_settings(&mut inner, paths, id)?;
        let kind = declared
            .get(key)
            .ok_or_else(|| format!("UnknownSetting: {id} declares no setting \"{key}\"."))?;
        if let Some(value) = &value {
            profiles::check_value(kind, value)
                .map_err(|why| format!("InvalidSetting: {key} {why}."))?;
        }
        Self::write(&mut inner, paths, |inv| {
            profiles::set_setting(&mut inv.profiles, id, key, value)
        })?;
        Ok(inner
            .inventory
            .as_ref()
            .ok_or("InstallFailed")?
            .profiles
            .view())
    }

    /// Changes extension `id`'s settings in profile `profile`, all or none, each checked
    /// against what the extension declares and against the value it was made from (EXT-18:
    /// `profiles::apply_settings`). One durable write; the view after it.
    pub fn set_profile_settings(
        &self,
        id: &str,
        profile: &str,
        changes: &[profiles::SettingChange],
    ) -> Result<ProfilesView, String> {
        let (mut inner, paths) = self.lock()?;
        let declared = self.declared_settings(&mut inner, paths, id)?;
        Self::write(&mut inner, paths, |inv| {
            profiles::apply_settings(&mut inv.profiles, profile, id, &declared, changes)
        })?;
        Ok(inner
            .inventory
            .as_ref()
            .ok_or("InstallFailed")?
            .profiles
            .view())
    }

    /// The settings the copy of `id` that `list` reports declares (EXT-18) -- installed or
    /// development, enabled or not; refused for one that is not listed usable.
    fn declared_settings(
        &self,
        inner: &mut Inner,
        paths: &Paths,
        requested: &str,
    ) -> Result<BTreeMap<String, profiles::SettingKind>, String> {
        let id = canonical_id(requested)
            .ok_or_else(|| format!("InvalidRequest: \"{requested}\" is not an extension id."))?;
        let (listed, _) = self.reconcile(inner, paths)?;
        let manifest = listed
            .iter()
            .find(|one| one.id.as_deref() == Some(id.as_str()) && one.error.is_none())
            .and_then(|one| one.manifest.as_deref())
            .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
            .ok_or_else(|| format!("UnknownExtension: {id} is not installed."))?;
        Ok(profiles::declared_settings(&manifest, &id))
    }

    // --- Diagnostics and safe mode (EXT-14) ------------------------------------------------

    /// The diagnostic log, beside the extensions (in memory only until the folder is known).
    pub fn diagnostics(&self) -> &Diagnostics {
        self.diagnostics.get_or_init(|| {
            Diagnostics::in_folder(self.paths().ok().map(|paths| diag::folder_of(&paths.root)))
        })
    }

    /// The files digest of the copy in `folder` (`tree_digest`), computed again only when a
    /// file of it changed (`tree_fingerprint`).
    fn files_digest(&self, folder: &Path) -> Result<String, String> {
        let fingerprint = crate::extension_package::tree_fingerprint(folder)?;
        if let Some((seen, digest)) = self
            .digests
            .lock()
            .ok()
            .and_then(|m| m.get(folder).cloned())
        {
            if seen == fingerprint {
                return Ok(digest);
            }
        }
        let digest = crate::extension_package::tree_digest(folder)?;
        if let Ok(mut memo) = self.digests.lock() {
            memo.insert(folder.to_path_buf(), (fingerprint, digest.clone()));
        }
        Ok(digest)
    }

    /// How many times grants changed in this process (EXT-16; never decides anything).
    pub fn grants_revision(&self) -> u64 {
        self.grants_revision.load(Ordering::SeqCst)
    }

    pub fn safe_mode(&self) -> bool {
        self.safe_mode.load(Ordering::SeqCst)
    }

    /// Turns safe mode on or off (for this run of Yavin). On, no extension code loads; what is
    /// enabled, installed, granted or signed is untouched.
    pub fn set_safe_mode(&self, on: bool) {
        if self.safe_mode.swap(on, Ordering::SeqCst) != on && on {
            self.diagnostics().record(Event::new("SafeMode", "host"));
        }
    }

    /// What `window` may see -- its own records, the application's, and the inventory's
    /// recoveries (EXT-02) -- newest first; for one extension if `extension`.
    pub fn diagnostics_for(&self, window: &str, extension: Option<&str>) -> Vec<Diagnostic> {
        let mut records = self.diagnostics().visible(window, extension);
        if let Ok((inner, _)) = self.lock() {
            if let Some(inv) = inner.inventory.as_ref() {
                for recovery in &inv.recoveries {
                    if extension.is_some_and(|id| recovery.id.as_deref() != Some(id)) {
                        continue;
                    }
                    let meaning = diag::classify("InventoryRecovered");
                    records.push(Diagnostic {
                        at: recovery.at,
                        code: "InventoryRecovered".into(),
                        category: meaning.category,
                        severity: meaning.severity,
                        refusal: meaning.refusal,
                        extension: recovery.id.clone(),
                        version: None,
                        window: None,
                        session: None,
                        phase: "recovery".into(),
                        summary: meaning.summary.into(),
                        remedy: meaning.remedy.map(str::to_string),
                        detail: Some(diag::redact(&recovery.reason)),
                        correlation: None,
                        count: 1,
                        source: "native".into(),
                    });
                }
            }
        }
        records.sort_by_key(|r| std::cmp::Reverse(r.at));
        records.truncate(diag::MAX_RECORDS);
        records
    }

    /// Clears what `window` may see (for one extension if `extension`): its diagnostic
    /// records and the inventory's recovery notes. Nothing else -- no extension, grant, trust
    /// record or secret -- is touched. How many.
    pub fn clear_diagnostics(
        &self,
        window: &str,
        extension: Option<&str>,
    ) -> Result<usize, String> {
        let mut cleared = self.diagnostics().clear(window, extension);
        let (mut inner, paths) = self.lock()?;
        let notes = inner.inventory.as_ref().map_or(0, |inv| {
            inv.recoveries
                .iter()
                .filter(|r| extension.is_none_or(|id| r.id.as_deref() == Some(id)))
                .count()
        });
        if notes > 0 {
            Self::write(&mut inner, paths, |inv| {
                inv.recoveries
                    .retain(|r| extension.is_some_and(|id| r.id.as_deref() != Some(id)));
                Ok(())
            })?;
            cleared += notes;
        }
        Ok(cleared)
    }

    // --- Secrets (EXT-13) --------------------------------------------------------------------

    /// Test only: keeps the trust key in `keys` (a store that is unavailable or fails).
    #[cfg(test)]
    pub fn use_trust_keys(&self, keys: std::sync::Arc<dyn crate::extension_trust::TrustKeyStore>) {
        *self.trust_keys.lock().unwrap() = Some(keys);
        *self.trust_key.lock().unwrap() = None;
    }

    /// The trust key for `root` (EXT-19), had once and kept; an error when none can be had.
    fn trust_key(
        &self,
        root: &Path,
    ) -> Result<std::sync::Arc<crate::extension_trust::TrustKey>, String> {
        if let Some(key) = self.trust_key.lock().ok().and_then(|k| k.clone()) {
            return Ok(key);
        }
        let store = self
            .trust_keys
            .lock()
            .ok()
            .and_then(|s| s.clone())
            .unwrap_or_else(crate::extension_trust::platform);
        let (key, note) = store.key(root)?;
        let key = std::sync::Arc::new(key);
        if let Ok(mut kept) = self.trust_key.lock() {
            *kept = Some(key.clone());
        }
        if let (Some(note), Ok(mut notes)) = (note, self.trust_notes.lock()) {
            notes.push(note);
        }
        Ok(key)
    }

    /// A trust record for `copy` of `id`, if a key can be had (else none: it will not run).
    fn seal(
        &self,
        root: &Path,
        id: &str,
        copy: &Copy,
    ) -> Option<crate::extension_trust::TrustRecord> {
        self.trust_key(root)
            .ok()
            .map(|key| key.seal(&trust_facts(id, copy)))
    }

    /// Test only: another credential store.
    #[cfg(test)]
    pub fn use_secret_backend(&self, backend: std::sync::Arc<dyn SecretBackend>) {
        *self.secret_backend.lock().unwrap() = Some(backend);
    }

    fn secret_store(&self, paths: &Paths) -> SecretStore {
        let backend = self
            .secret_backend
            .lock()
            .ok()
            .and_then(|b| b.clone())
            .unwrap_or_else(crate::extension_secrets::platform);
        SecretStore::new(backend, &paths.root)
    }

    /// A secret request of the code of `copy` (`secrets.get|store|delete`), in `workspace`
    /// (the one its host was started in): allowed for that very copy now (EXT-07: the
    /// `secrets` grant, enabled, still installed, its dependencies there), then done in the OS
    /// store for its owner (its id and origin), the active profile and the scope asked. The
    /// answer is the value for a read; nothing else carries one.
    ///
    /// The check and the operation are one step (EXT-16): the inventory's lock is held across
    /// both, so a revocation, a disable or an update -- each a change of the inventory, under
    /// the same lock -- either comes before the check (the operation is refused) or waits until
    /// the operation is done (it completes, allowed). Once `set_grants` answers, nothing it
    /// revoked is still running.
    pub fn secret(
        &self,
        copy: &HostCopy,
        workspace: Option<&str>,
        method: &str,
        params: &serde_json::Value,
    ) -> Result<serde_json::Value, Denial> {
        let (inner, paths) = self
            .lock()
            .map_err(|why| Denial::new("InventoryUnavailable", why))?;
        let inv = inner
            .inventory
            .as_ref()
            .ok_or_else(|| Denial::new("InventoryUnavailable", "The inventory is not read."))?;
        authorize_in(inv, copy, Some(crate::extension_permissions::SECRETS))?;
        let profile = inv.profiles.active.clone();
        // `inner` stays held until the operation is done (see above).
        let refused = |text: String| {
            let (code, message) = text
                .split_once(": ")
                .unwrap_or(("SecretFailed", text.as_str()));
            let code: &'static str = match code {
                "SecretInvalid" => "SecretInvalid",
                "SecretTooLarge" => "SecretTooLarge",
                "SecretCorrupted" => "SecretCorrupted",
                "SecretOwnerChanged" => "SecretOwnerChanged",
                "SecretStorageUnavailable" => "SecretStorageUnavailable",
                _ => "SecretFailed",
            };
            Denial::new(code, message.to_string())
        };
        let scope = SecretScope {
            profile,
            workspace: match params.get("scope").and_then(serde_json::Value::as_str) {
                Some("workspace") => Some(workspace.map(str::to_string).ok_or_else(|| {
                    Denial::new("NoWorkspace", "There is no workspace to keep a secret in.")
                })?),
                _ => None,
            },
        };
        let owner = SecretOwner {
            id: copy.id.clone(),
            origin: copy.origin.clone(),
        };
        let key = params
            .get("key")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let store = self.secret_store(paths);
        match method {
            "secrets.get" => store
                .get(&owner, &scope, key)
                .map(|value| value.map_or(serde_json::Value::Null, serde_json::Value::String))
                .map_err(refused),
            "secrets.store" => {
                let value = params
                    .get("value")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("");
                store
                    .store(&owner, &scope, key, value)
                    .map(|()| serde_json::Value::Null)
                    .map_err(refused)
            }
            "secrets.delete" => store
                .delete(&owner, &scope, key)
                .map(serde_json::Value::Bool)
                .map_err(refused),
            _ => Err(Denial::new(
                "UnknownMethod",
                format!("\"{method}\" is not a secrets method."),
            )),
        }
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
            profiles: inventory.profiles.view(),
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
        self.grants_revision.fetch_add(1, Ordering::SeqCst);
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
        if self.safe_mode() {
            return Err(format!(
                "SafeMode: safe mode is on: {id}'s code does not run until it is turned off."
            ));
        }
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
        // Only a copy whose files are bound and whose trust record verifies runs (EXT-17,
        // EXT-19); every other is refused, saying why, with the way out.
        if let Some(integrity) = chosen.integrity.as_ref().filter(|i| !i.runs) {
            return Err(match (integrity.state, integrity.reason) {
                ("untrusted", Some("unavailable")) => format!(
                    "TrustStateUnavailable: Yavin's trust key cannot be used, so {id}'s record of verified files cannot be checked and its code does not run."
                ),
                ("untrusted", reason) => format!(
                    "TrustStateInvalid: Yavin could not authenticate its record of {id}'s verified files ({}); its code does not run. Reinstall it.",
                    reason.unwrap_or("mismatch")
                ),
                (_, Some("rebuilt")) => format!(
                    "IntegrityUnverified: {id} was recovered from its folder after Yavin's extension inventory was lost; its files cannot be checked, so its code does not run. Reinstall it."
                ),
                _ => format!(
                    "IntegrityUnverified: {id}'s installed files have never been checked against its package, so its code does not run. Reinstall it to have them checked."
                ),
            });
        }
        let (Some(copy), Some(state)) = (chosen.copy.clone(), chosen.permissions.clone()) else {
            return Err(format!("UnknownExtension: {id} is not installed."));
        };
        // Its API and its dependencies (EXT-12), natively, whatever the window believes.
        let requires = load_requirements(&inner, &listed, &chosen, &id)?;
        let origin = match (
            chosen.source,
            inner
                .inventory
                .as_ref()
                .and_then(|inv| inv.extensions.get(&id)),
        ) {
            ("installed", Some(record)) => record.active.source.clone(),
            ("installed", None) => "unknown".into(),
            _ => "development".into(),
        };
        Ok(HostCopy {
            id,
            folder: chosen.folder,
            main,
            version: copy.version,
            sha256: copy.sha256,
            stored: copy.stored,
            requested: state.requested.into_iter().collect(),
            origin,
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
        authorize_in(inv, copy, capability)
    }

    /// The disk and the inventory, made to agree; what to list. Root folders the inventory
    /// does not know are adopted; other copies of a recorded id are shadowed; an unusable
    /// active copy falls back to the previous one, or the install is reported broken.
    fn reconcile(&self, inner: &mut Inner, paths: &Paths) -> Result<(Vec<Listed>, usize), String> {
        let root = &paths.root;
        // The trust key (EXT-19): each copy's record is checked under it. None to be had: no
        // record verifies, and no extension code runs.
        let key = self.trust_key(root);
        let notes: Vec<String> = self
            .trust_notes
            .lock()
            .map(|mut n| std::mem::take(&mut *n))
            .unwrap_or_default();
        if !notes.is_empty() {
            Self::write(inner, paths, |inv| {
                for text in &notes {
                    note(inv, None, text.clone());
                }
                Ok(())
            })?;
        }
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
                    integrity: None,
                    replaced: None,
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
                            files_sha256: None,
                            unchecked: Some(Unchecked::Adopted),
                            trust: None,
                        },
                        previous: None,
                        broken: None,
                        replaced: None,
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
                let text = read_copy(&join(root, &copy.folder), &id, Some(&copy.version))?;
                // Its files are still the ones put in place (EXT-15): else it is not the copy
                // that was verified -- not used, not listed as signed, its grants not applied.
                if let Some(expected) = &copy.files_sha256 {
                    let actual = self.files_digest(&join(root, &copy.folder))?;
                    if !actual.eq_ignore_ascii_case(expected) {
                        return Err("its files changed since it was installed (they are not the package that was verified)".to_string());
                    }
                }
                Ok(text)
            };
            let facts = |copy: &Copy| CopyFacts {
                version: copy.version.clone(),
                sha256: copy.sha256.clone(),
                stored: Some(copy.folder.clone()),
            };
            // A signature record holds only for the bytes it was checked against (EXT-09): one
            // whose SHA-256 is not this copy's is not reported at all.
            // ... and only while its files are bound to those bytes (EXT-17): a copy whose
            // files were never checked keeps its record, unshown, until a reinstall binds them.
            let signature_of = |copy: &Copy| {
                copy.signature.clone().filter(|s| {
                    copy.files_sha256.is_some()
                        && copy
                            .sha256
                            .as_deref()
                            .is_some_and(|sha| s.sha256.eq_ignore_ascii_case(sha))
                        && record_matches_source(s, &copy.source)
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
                integrity: Some(Integrity::of(&id, &record.active, key.as_deref())),
                replaced: record.replaced.clone(),
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
                            let replaced = Replaced {
                                version: record.active.version.clone(),
                                reason: why.clone(),
                                at: now(),
                            };
                            Self::write(inner, paths, |inv| {
                                if let Some(r) = inv.extensions.get_mut(&id) {
                                    r.active = previous.clone();
                                    r.previous = None;
                                    r.broken = None;
                                    r.replaced = Some(replaced.clone());
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
                            // The fallback is checked on its own (its own record, files).
                            entry.integrity = Some(Integrity::of(&id, &previous, key.as_deref()));
                            entry.replaced = Some(replaced);
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
                            entry.integrity = why
                                .starts_with("its files changed")
                                .then(Integrity::changed);
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
                        integrity: None,
                        replaced: None,
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
                    integrity: Some(Integrity::development()),
                    replaced: None,
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
    // Profiles that are not valid are made so, and said (EXT-13).
    for why in profiles::normalize(&mut inventory.profiles) {
        note(&mut inventory, None, why);
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
        let inventory = serde_json::from_str::<Inventory>(text).ok()?;
        match version {
            INVENTORY_VERSION => Some(inventory),
            // Version 3 (EXT-19) adds only `trust`, which no older copy has: such a copy is
            // unauthenticated and its code does not run until it is reinstalled. No record is
            // made for it here -- a migration never vouches for files it did not check.
            2 => Some(Inventory {
                version: INVENTORY_VERSION,
                ..inventory
            }),
            1 => Some(migrate_v1(inventory)),
            _ => None,
        }
    })
}

/// A version-1 inventory as version 2 (EXT-17). Nothing is raised: a copy without a files
/// digest is marked unchecked -- `Adopted` (an IDE-09 root folder), `Rebuilt` (a store
/// copy with no recorded source: a rebuild), else `Legacy` (installed before EXT-15). Its
/// signature record, grants, profiles and the rest are kept as they were.
fn migrate_v1(mut inventory: Inventory) -> Inventory {
    inventory.version = INVENTORY_VERSION;
    let mark = |copy: &mut Copy| {
        if copy.files_sha256.is_none() && copy.unchecked.is_none() {
            copy.unchecked = Some(if !copy.folder.starts_with(&format!("{STORE}/")) {
                Unchecked::Adopted
            } else if copy.source == "unknown" {
                Unchecked::Rebuilt
            } else {
                Unchecked::Legacy
            });
        }
    };
    for record in inventory.extensions.values_mut() {
        mark(&mut record.active);
        if let Some(previous) = record.previous.as_mut() {
            mark(previous);
        }
    }
    for operation in inventory.operations.values_mut() {
        if let Some(before) = operation.before.as_mut() {
            mark(&mut before.active);
            if let Some(previous) = before.previous.as_mut() {
                mark(previous);
            }
        }
    }
    inventory
}

/// Whether a newer Yavin's inventory was kept aside here (`inventory.json.v<N>-<ms>.bak`, N
/// past this one's): then a missing inventory is not restored or rebuilt over it (EXT-17).
fn newer_kept_aside(root: &Path) -> Option<u32> {
    fs::read_dir(root).ok()?.flatten().find_map(|entry| {
        let name = entry.file_name().to_string_lossy().into_owned();
        [INVENTORY, LAST_GOOD].iter().find_map(|file| {
            let rest = name.strip_prefix(&format!("{file}.v"))?;
            let version: u32 = rest.split('-').next()?.parse().ok()?;
            (version > INVENTORY_VERSION && name.ends_with(".bak")).then_some(version)
        })
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
/// named `<version>-<sha8>` (or `<version>-<sha256>`, when the short name was another package's:
/// EXT-15), whose manifest is `id` at that version.
fn validated(root: &Path, id: &str, folder: &str) -> Option<String> {
    if !folder_ok(folder) {
        return None;
    }
    let path = join(root, folder);
    if !fs::symlink_metadata(&path).is_ok_and(|m| m.is_dir()) {
        return None;
    }
    let name = folder.rsplit('/').next()?;
    let (version, sha) = name.rsplit_once('-')?;
    let hex =
        matches!(sha.len(), 8 | 64) && sha.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
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

/// What the calling window may see of extensions' diagnostics (EXT-14): newest first.
#[tauri::command(async)]
pub fn extensions_diagnostics(
    webview: tauri::Webview,
    service: State<'_, ExtensionService>,
    id: Option<String>,
) -> Result<Vec<Diagnostic>, String> {
    Ok(service.diagnostics_for(webview.label(), id.as_deref()))
}

/// The redacted report of those, for the user to copy.
#[tauri::command(async)]
pub fn extensions_diagnostics_report(
    webview: tauri::Webview,
    service: State<'_, ExtensionService>,
    id: Option<String>,
) -> Result<String, String> {
    let records = service.diagnostics_for(webview.label(), id.as_deref());
    Ok(diag::render_report(&records, env!("CARGO_PKG_VERSION")))
}

/// Clears what the calling window may see.
#[tauri::command(async)]
pub fn extensions_diagnostics_clear(
    webview: tauri::Webview,
    service: State<'_, ExtensionService>,
    id: Option<String>,
) -> Result<usize, String> {
    service.clear_diagnostics(webview.label(), id.as_deref())
}

/// What the window observed (an activation that timed out, say): one of a few codes,
/// classified and redacted here, marked as the window's -- it decides nothing.
#[tauri::command(async)]
pub fn extensions_diagnostics_note(
    webview: tauri::Webview,
    service: State<'_, ExtensionService>,
    code: String,
    id: Option<String>,
    detail: Option<String>,
) -> Result<Diagnostic, String> {
    let mut event = Event::new(&code, "activation");
    event.extension = id;
    event.detail = detail;
    service
        .diagnostics()
        .record_from_window(webview.label(), event)
}

/// Safe mode (EXT-14): on, no extension code loads (for this run of Yavin).
#[tauri::command(async)]
pub fn extensions_safe_mode(
    service: State<'_, ExtensionService>,
    enabled: Option<bool>,
) -> Result<bool, String> {
    if let Some(on) = enabled {
        service.set_safe_mode(on);
    }
    Ok(service.safe_mode())
}

/// The extension profiles (EXT-13).
#[tauri::command(async)]
pub fn extensions_profiles(service: State<'_, ExtensionService>) -> Result<ProfilesView, String> {
    service.profiles()
}

#[tauri::command(async)]
pub fn extensions_profile_create(
    service: State<'_, ExtensionService>,
    name: String,
) -> Result<ProfilesView, String> {
    service.create_profile(&name)
}

#[tauri::command(async)]
pub fn extensions_profile_rename(
    service: State<'_, ExtensionService>,
    id: String,
    name: String,
) -> Result<ProfilesView, String> {
    service.rename_profile(&id, &name)
}

#[tauri::command(async)]
pub fn extensions_profile_delete(
    service: State<'_, ExtensionService>,
    id: String,
) -> Result<ProfilesView, String> {
    service.delete_profile(&id)
}

#[tauri::command(async)]
pub fn extensions_profile_select(
    service: State<'_, ExtensionService>,
    id: String,
) -> Result<ProfileSwitch, String> {
    service.select_profile(&id)
}

/// Changes an extension's settings in a profile, all or none (EXT-18).
#[tauri::command(async)]
pub fn extensions_profile_settings(
    service: State<'_, ExtensionService>,
    id: String,
    profile: String,
    changes: Vec<profiles::SettingChange>,
) -> Result<ProfilesView, String> {
    service.set_profile_settings(&id, &profile, &changes)
}

#[tauri::command(async)]
pub fn extensions_profile_setting(
    service: State<'_, ExtensionService>,
    id: String,
    key: String,
    value: Option<serde_json::Value>,
) -> Result<ProfilesView, String> {
    service.set_profile_setting(&id, &key, value)
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
