//! EXT-33 Q5 (foundation; **not** wired to C2): the safe workspace read-grant manager.
//!
//! It composes the `sandbox` ACL primitive into a grant that establishes the C2 read-only
//! invariant or refuses, and journals every change so a crash cannot leave a workspace with a
//! stray container-SID ACE:
//!
//! - **canonical single root.** The grant is for one canonicalized directory; multi-root/nested
//!   configurations are the caller's to split (one grant each), never mixed.
//! - **reparse refusal.** If any reparse point under the root resolves outside it, the grant is
//!   refused. (Reads through such a link are already denied by the target's DACL -- a granted
//!   container holds no ACE outside the root -- so this is defence in depth; see the test
//!   `reads_cannot_escape_the_root_through_a_junction`.)
//! - **broad-ACE refusal.** If any existing ACE already grants the container (or ALL APPLICATION
//!   PACKAGES) write, a read-only ACE cannot cancel it, so the grant is refused: Yavin will not
//!   claim a read-only guarantee it cannot keep.
//! - **verify after apply.** After granting, the ACE must be present and the folder must still be
//!   not-writable by the container; otherwise the grant is rolled back and fails closed.
//! - **journalled.** The intent is written durably before the ACL is touched and cleared only
//!   after a verified revoke, so startup reconciliation can remove residue a crash left.
//!
//! Still missing for production (deferred, see `PROCESS_CAPABILITY_DESIGN.md` §24): asynchronous
//! execution with progress and lifecycle states, the per-workspace SID derivation, and wiring to
//! consent and the extension host. Nothing here is reachable from the renderer or extensions.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

/// Why a safe grant was refused or failed. Every path stays inside the refusal, never silently
/// downgraded to a weaker grant.
#[derive(Debug, Clone, PartialEq)]
pub enum GrantError {
    NotADirectory,
    /// A reparse point under the root resolves outside it (its path).
    OutwardReparse(String),
    /// A file under the root is hard-linked to a name outside it (its path): a grant's inherited
    /// ACE would expose that shared object, so the grant is refused.
    ExternalHardLink(String),
    /// An existing ACE already grants the container write; a read-only grant cannot override it.
    AlreadyWritable,
    /// The ACL operation itself failed.
    Failed(String),
    /// The grant applied but verification (ACE present and still read-only) did not hold.
    VerifyFailed(String),
    /// The journal could not be read or written, so cleanup cannot be guaranteed: fail closed.
    JournalUnavailable(String),
    /// A server was asked to start but the grant is not in a startable state (the reason).
    NotReady(String),
}

/// A verified read-only grant: a canonical root and the container SID name it is for.
#[derive(Debug, Clone, PartialEq)]
pub struct WorkspaceReadGrant {
    pub root: PathBuf,
    pub container: String,
}

#[derive(Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
struct JournalEntry {
    root: String,
    container: String,
}

/// The durable record of active grants (one JSON file). It exists so that if Yavin dies between
/// applying and removing a grant, the next start can find and remove the residual ACE.
pub struct GrantJournal {
    file: PathBuf,
}

impl GrantJournal {
    pub fn new(file: PathBuf) -> GrantJournal {
        GrantJournal { file }
    }

    /// The journalled entries, or an error if the file exists but cannot be read/parsed (a corrupt
    /// journal means cleanup cannot be reasoned about: the caller must fail closed).
    fn load(&self) -> Result<Vec<JournalEntry>, GrantError> {
        match std::fs::read_to_string(&self.file) {
            Ok(text) => serde_json::from_str(&text)
                .map_err(|e| GrantError::JournalUnavailable(format!("corrupt journal: {e}"))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(GrantError::JournalUnavailable(e.to_string())),
        }
    }

    fn save(&self, entries: &[JournalEntry]) -> Result<(), GrantError> {
        crate::durable::write_json(&self.file, &entries.to_vec())
            .map_err(GrantError::JournalUnavailable)
    }

    fn record(&self, root: &str, container: &str) -> Result<(), GrantError> {
        let mut entries = self.load()?;
        if !entries
            .iter()
            .any(|e| e.root == root && e.container == container)
        {
            entries.push(JournalEntry {
                root: root.to_string(),
                container: container.to_string(),
            });
            self.save(&entries)?;
        }
        Ok(())
    }

    fn clear(&self, root: &str, container: &str) -> Result<(), GrantError> {
        let mut entries = self.load()?;
        let before = entries.len();
        entries.retain(|e| !(e.root == root && e.container == container));
        if entries.len() != before {
            self.save(&entries)?;
        }
        Ok(())
    }
}

/// The canonical form of `root` as the ACL APIs and the journal use it.
fn canonical(root: &Path) -> Result<PathBuf, GrantError> {
    if !root.is_dir() {
        return Err(GrantError::NotADirectory);
    }
    let c = std::fs::canonicalize(root).map_err(|e| GrantError::Failed(e.to_string()))?;
    // Strip the `\\?\` prefix so it matches what the sandbox grant and journal store.
    let text = c.to_string_lossy();
    Ok(PathBuf::from(
        text.strip_prefix(r"\\?\")
            .map(str::to_string)
            .unwrap_or_else(|| text.into_owned()),
    ))
}

/// The first reparse point under `root` (canonical) whose target resolves outside `root`, if any.
/// A reparse point that cannot be resolved is treated as outward (fail closed).
pub fn outward_reparse(root: &Path) -> Option<PathBuf> {
    #[cfg(windows)]
    use std::os::windows::fs::MetadataExt;
    fn walk(dir: &Path, root: &Path) -> Option<PathBuf> {
        for entry in std::fs::read_dir(dir).ok()?.flatten() {
            let path = entry.path();
            let Ok(meta) = std::fs::symlink_metadata(&path) else {
                return Some(path);
            };
            let is_reparse = meta.file_type().is_symlink() || {
                #[cfg(windows)]
                {
                    meta.file_attributes() & 0x400 != 0 // FILE_ATTRIBUTE_REPARSE_POINT
                }
                #[cfg(not(windows))]
                {
                    false
                }
            };
            if is_reparse {
                match std::fs::canonicalize(&path) {
                    Ok(target) if target.starts_with(root) => {}
                    _ => return Some(path),
                }
            } else if meta.is_dir() {
                if let Some(found) = walk(&path, root) {
                    return Some(found);
                }
            }
        }
        None
    }
    let canonical_root = std::fs::canonicalize(root).ok()?;
    walk(&canonical_root, &canonical_root)
}

/// The first file under `root` (canonical) that is hard-linked to a name outside `root`, if any.
/// Such a file's object is shared with outside data, so a grant's inherited ACE would expose it;
/// the grant must be refused. Hard links are same-volume only, so every name is discoverable.
pub fn external_hard_link(root: &Path) -> Option<PathBuf> {
    let canonical_root = std::fs::canonicalize(root).ok()?;
    let canonical_root = {
        let text = canonical_root.to_string_lossy();
        PathBuf::from(
            text.strip_prefix(r"\\?\")
                .map(str::to_string)
                .unwrap_or_else(|| text.into_owned()),
        )
    };
    fn walk(dir: &Path, root: &Path) -> Option<PathBuf> {
        for entry in std::fs::read_dir(dir).ok()?.flatten() {
            let path = entry.path();
            let Ok(meta) = std::fs::symlink_metadata(&path) else {
                continue;
            };
            if meta.is_dir() {
                // Do not descend into reparse points (handled by `outward_reparse`).
                if !meta.file_type().is_symlink() {
                    if let Some(found) = walk(&path, root) {
                        return Some(found);
                    }
                }
            } else if meta.is_file()
                && crate::sandbox::external_hard_link_name(&path, root).is_some()
            {
                return Some(path);
            }
        }
        None
    }
    walk(&canonical_root, &canonical_root)
}

/// Grants `container` read-only access to `root`, or refuses. Journals the intent before touching
/// the ACL and verifies the result; on any failure it rolls back and fails closed. Idempotent: a
/// second grant of the same root/container re-verifies and returns the grant.
pub fn safe_grant(
    root: &Path,
    container: &str,
    journal: &GrantJournal,
) -> Result<WorkspaceReadGrant, GrantError> {
    safe_grant_observed(root, container, journal, &mut |_| {})
}

/// The phase a grant has reached, for the async lifecycle's progress.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrantPhase {
    /// Checking the tree for outward reparse points, external hard links and broad write ACEs.
    Scanning,
    /// Writing the journal and applying the inheritable read ACE.
    Applying,
    /// Re-reading the effective access to confirm the ACE is present and still read-only.
    Verifying,
}

/// As [`safe_grant`], reporting each [`GrantPhase`] through `on_phase` before it runs. The scan
/// and apply are the slow parts on a large tree; a caller can surface the phase as progress.
pub fn safe_grant_observed(
    root: &Path,
    container: &str,
    journal: &GrantJournal,
    on_phase: &mut dyn FnMut(GrantPhase),
) -> Result<WorkspaceReadGrant, GrantError> {
    let root = canonical(root)?;
    on_phase(GrantPhase::Scanning);
    if let Some(bad) = outward_reparse(&root) {
        return Err(GrantError::OutwardReparse(
            bad.to_string_lossy().into_owned(),
        ));
    }
    // A hard link to data outside the root would be exposed by the inherited ACE: refuse.
    if let Some(bad) = external_hard_link(&root) {
        return Err(GrantError::ExternalHardLink(
            bad.to_string_lossy().into_owned(),
        ));
    }
    // A pre-existing broad write ACE cannot be cancelled by a read-only ACE: refuse.
    if crate::sandbox::container_writable(&root, container).map_err(GrantError::Failed)? {
        return Err(GrantError::AlreadyWritable);
    }
    on_phase(GrantPhase::Applying);
    // Journal before mutating, so a crash leaves a record to reconcile.
    journal.record(&root.to_string_lossy(), container)?;
    if let Err(e) = crate::sandbox::grant_read_tree(&root, container) {
        // The ACL was not applied; drop the journal record and fail.
        let _ = journal.clear(&root.to_string_lossy(), container);
        return Err(GrantError::Failed(e));
    }
    on_phase(GrantPhase::Verifying);
    // Verify: the ACE is present and the container still cannot write.
    let present = crate::sandbox::container_aces(&root, container).unwrap_or(0) >= 1;
    let still_read_only = !crate::sandbox::container_writable(&root, container).unwrap_or(true);
    if !present || !still_read_only {
        let _ = crate::sandbox::revoke_read_tree(&root, container);
        let _ = journal.clear(&root.to_string_lossy(), container);
        return Err(GrantError::VerifyFailed(format!(
            "ace_present={present} read_only={still_read_only}"
        )));
    }
    Ok(WorkspaceReadGrant {
        root,
        container: container.to_string(),
    })
}

/// Revokes `grant`, verifying zero residual ACEs before clearing the journal. If residue remains,
/// the journal entry is kept and an error returned (fail closed; reconciliation will retry).
pub fn revoke(grant: &WorkspaceReadGrant, journal: &GrantJournal) -> Result<(), GrantError> {
    let root = grant.root.to_string_lossy().into_owned();
    crate::sandbox::revoke_read_tree(&grant.root, &grant.container).map_err(GrantError::Failed)?;
    let residue = crate::sandbox::container_aces(&grant.root, &grant.container).unwrap_or(1);
    if residue != 0 {
        return Err(GrantError::VerifyFailed(format!("{residue} ACEs remain")));
    }
    journal.clear(&root, &grant.container)
}

/// Startup reconciliation: remove the ACE of every journalled grant and verify zero residue. Any
/// entry that cannot be verified clean is kept and counted; the caller must then block server
/// startup until it is resolved. Returns how many entries were reconciled clean.
pub fn reconcile(journal: &GrantJournal) -> Result<usize, GrantError> {
    let entries = journal.load()?;
    let mut cleaned = 0;
    let mut residual = Vec::new();
    for entry in entries {
        let _ = crate::sandbox::revoke_read_tree(Path::new(&entry.root), &entry.container);
        let residue =
            crate::sandbox::container_aces(Path::new(&entry.root), &entry.container).unwrap_or(1);
        if residue == 0 {
            cleaned += 1;
        } else {
            residual.push(entry);
        }
    }
    journal.save(&residual)?;
    if residual.is_empty() {
        Ok(cleaned)
    } else {
        Err(GrantError::VerifyFailed(format!(
            "{} grant(s) could not be reconciled to zero ACEs",
            residual.len()
        )))
    }
}

// --- Asynchronous lifecycle (EXT-33 Q5) -------------------------------------------------------
//
// The recursive ACL propagation takes seconds on a large tree (§24.2), so grant and revoke run
// off the caller's thread. The manager exposes explicit states and never reports a grant ready
// until `safe_grant` has verified it; a server is started only when `is_ready` is true. Windows'
// `SetNamedSecurityInfoW` is atomic and gives no sub-operation progress, so "progress" here is the
// state transition, not a percentage. All ACL mutations are serialized by one lock, so concurrent
// grant / revoke / workspace-switch cannot race the DACL into a broader state.

/// The lifecycle state of one workspace grant. Transitions are driven only by the manager's
/// worker threads; a caller observes them through [`WorkspaceGrantManager::state`]. The sequence a
/// successful grant passes through is `Pending -> Scanning -> Applying -> Verifying -> Granted`,
/// and a revoke is `Revoking -> (removed)`; a cancellation after apply is
/// `... -> RollingBack -> Cancelled`.
#[derive(Debug, Clone, PartialEq)]
pub enum GrantState {
    /// Requested; the worker has not started the scan yet. A server must not start.
    Pending,
    /// Checking the tree for outward reparse points, external hard links and broad write ACEs.
    Scanning,
    /// Writing the journal and applying the inheritable read ACE.
    Applying,
    /// Re-reading the effective access to confirm the ACE is present and still read-only.
    Verifying,
    /// Applied and verified read-only. A server may start.
    Granted,
    /// Being removed off-thread.
    Revoking,
    /// A cancellation or supersession is removing a grant that had already applied.
    RollingBack,
    /// Cancelled before or after applying; nothing is left applied. A server must not start.
    Cancelled,
    /// The grant was refused or failed; the reason. Nothing was left applied.
    Failed(GrantError),
    /// Cleanup could not be verified: a residual ACE may remain. A server must not start, and
    /// startup reconciliation must resolve it.
    RecoveryRequired(String),
}

/// A monotonic operation sequence. Every `begin_grant` / `begin_revoke` stamps the entry with a
/// fresh value; a worker that finds the entry's sequence has moved on knows a newer operation
/// superseded it and must undo (never publish) its own result. This is what stops a slow grant
/// from re-applying permissions after a newer revoke -- the stale-operation safety requirement.
static OP_SEQ: AtomicU64 = AtomicU64::new(1);

fn key(root: &Path, container: &str) -> String {
    format!("{}\u{1f}{container}", root.display())
}

fn phase_state(phase: GrantPhase) -> GrantState {
    match phase {
        GrantPhase::Scanning => GrantState::Scanning,
        GrantPhase::Applying => GrantState::Applying,
        GrantPhase::Verifying => GrantState::Verifying,
    }
}

struct Entry {
    state: GrantState,
    grant: Option<WorkspaceReadGrant>,
    cancel: Arc<AtomicBool>,
    /// The sequence of the operation that currently owns this entry.
    seq: u64,
}

/// Decrements the in-flight counter when a worker thread finishes, on every return path.
struct InFlight(Arc<AtomicUsize>);
impl Drop for InFlight {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Manages workspace read grants asynchronously, with explicit states and serialized ACL work.
pub struct WorkspaceGrantManager {
    journal: Arc<GrantJournal>,
    entries: Arc<Mutex<HashMap<String, Entry>>>,
    /// Serializes the actual ACL mutations so two operations never touch overlapping DACLs at once.
    acl_lock: Arc<Mutex<()>>,
    /// Count of grant/revoke worker threads still running; `quiescent` reports when it is zero.
    in_flight: Arc<AtomicUsize>,
}

impl WorkspaceGrantManager {
    pub fn new(journal: GrantJournal) -> WorkspaceGrantManager {
        WorkspaceGrantManager {
            journal: Arc::new(journal),
            entries: Arc::new(Mutex::new(HashMap::new())),
            acl_lock: Arc::new(Mutex::new(())),
            in_flight: Arc::new(AtomicUsize::new(0)),
        }
    }

    /// Whether no grant/revoke work is in flight. A shutdown or workspace switch waits on this so a
    /// late worker cannot mutate a DACL after the manager is believed idle.
    pub fn quiescent(&self) -> bool {
        self.in_flight.load(Ordering::SeqCst) == 0
    }

    /// Starts granting `container` read of `root` off-thread. Returns the key to poll; the state
    /// is `Pending` until the worker starts, then moves through `Scanning`/`Applying`/`Verifying`
    /// to `Granted`. Re-begin of a key supersedes any in-flight operation on it (the older worker
    /// undoes its own result rather than publishing it).
    pub fn begin_grant(&self, root: &Path, container: &str) -> String {
        let k = key(root, container);
        let cancel = Arc::new(AtomicBool::new(false));
        let seq = OP_SEQ.fetch_add(1, Ordering::SeqCst);
        {
            let mut entries = self.entries.lock().unwrap_or_else(|p| p.into_inner());
            entries.insert(
                k.clone(),
                Entry {
                    state: GrantState::Pending,
                    grant: None,
                    cancel: cancel.clone(),
                    seq,
                },
            );
        }
        let (root, container) = (root.to_path_buf(), container.to_string());
        let (journal, entries, acl_lock, key_c) = (
            self.journal.clone(),
            self.entries.clone(),
            self.acl_lock.clone(),
            k.clone(),
        );
        self.in_flight.fetch_add(1, Ordering::SeqCst);
        let flight = InFlight(self.in_flight.clone());
        std::thread::spawn(move || {
            let _flight = flight;
            // The ACL mutation itself is serialized against other grants/revokes. The phase
            // callback reflects progress into the entry, but only while this operation still owns
            // it (so a superseded worker cannot overwrite a newer operation's state).
            let result = {
                let _serial = acl_lock.lock().unwrap_or_else(|p| p.into_inner());
                let entries_cb = entries.clone();
                let key_cb = key_c.clone();
                let mut on_phase = move |phase: GrantPhase| {
                    let mut g = entries_cb.lock().unwrap_or_else(|p| p.into_inner());
                    if let Some(entry) = g.get_mut(&key_cb) {
                        if entry.seq == seq {
                            entry.state = phase_state(phase);
                        }
                    }
                };
                safe_grant_observed(&root, &container, &journal, &mut on_phase)
            };

            // Decide publication. If a newer operation has taken the entry, undo our own grant so
            // no stale ACE survives, and never touch the newer operation's state.
            let superseded = {
                let g = entries.lock().unwrap_or_else(|p| p.into_inner());
                g.get(&key_c).map(|e| e.seq != seq).unwrap_or(true)
            };
            if superseded {
                if let Ok(g) = &result {
                    let _serial = acl_lock.lock().unwrap_or_else(|p| p.into_inner());
                    let _ = revoke(g, &journal);
                }
                return;
            }

            let cancelled = cancel.load(Ordering::SeqCst);
            match result {
                Ok(grant) if !cancelled => {
                    let mut g = entries.lock().unwrap_or_else(|p| p.into_inner());
                    match g.get_mut(&key_c) {
                        Some(entry) if entry.seq == seq => {
                            entry.grant = Some(grant);
                            entry.state = GrantState::Granted;
                        }
                        // Superseded in the gap since the check above: undo instead of publishing.
                        _ => {
                            drop(g);
                            let _serial = acl_lock.lock().unwrap_or_else(|p| p.into_inner());
                            let _ = revoke(&grant, &journal);
                        }
                    }
                }
                Ok(grant) => {
                    // Cancelled after the grant applied: roll back and verify clean.
                    {
                        let mut g = entries.lock().unwrap_or_else(|p| p.into_inner());
                        if let Some(entry) = g.get_mut(&key_c) {
                            if entry.seq == seq {
                                entry.state = GrantState::RollingBack;
                            }
                        }
                    }
                    let rolled = {
                        let _serial = acl_lock.lock().unwrap_or_else(|p| p.into_inner());
                        revoke(&grant, &journal)
                    };
                    let mut g = entries.lock().unwrap_or_else(|p| p.into_inner());
                    if let Some(entry) = g.get_mut(&key_c) {
                        if entry.seq == seq {
                            match rolled {
                                Ok(()) => {
                                    entry.grant = None;
                                    entry.state = GrantState::Cancelled;
                                }
                                Err(e) => {
                                    entry.state = GrantState::RecoveryRequired(format!("{e:?}"));
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    let mut g = entries.lock().unwrap_or_else(|p| p.into_inner());
                    if let Some(entry) = g.get_mut(&key_c) {
                        if entry.seq == seq {
                            entry.state = GrantState::Failed(e);
                        }
                    }
                }
            }
        });
        k
    }

    /// Requests cancellation. If the grant is still running it is rolled back by its worker; if it
    /// already reached `Granted` (the cancel lost the race) it is revoked. Either way the key ends
    /// with no applied permission.
    pub fn cancel(&self, k: &str) {
        let already_granted = {
            let entries = self.entries.lock().unwrap_or_else(|p| p.into_inner());
            match entries.get(k) {
                Some(entry) => {
                    entry.cancel.store(true, Ordering::SeqCst);
                    matches!(entry.state, GrantState::Granted)
                }
                None => false,
            }
        };
        // The worker finished before the flag was seen: fall back to an explicit revoke.
        if already_granted {
            self.begin_revoke(k);
        }
    }

    /// Starts revoking a key off-thread. This supersedes any in-flight grant on the key (stamps a
    /// fresh sequence and sets the cancel flag), so a slow grant worker cannot re-apply permissions
    /// after this revoke. If a grant had already applied, its ACE is removed; otherwise the entry
    /// becomes `Cancelled` and the in-flight worker undoes whatever it applied.
    pub fn begin_revoke(&self, k: &str) {
        let seq = OP_SEQ.fetch_add(1, Ordering::SeqCst);
        let grant = {
            let mut entries = self.entries.lock().unwrap_or_else(|p| p.into_inner());
            match entries.get_mut(k) {
                Some(entry) => {
                    // Supersede any in-flight grant: the older worker will see the bumped sequence
                    // and undo itself rather than publishing `Granted`.
                    entry.seq = seq;
                    entry.cancel.store(true, Ordering::SeqCst);
                    if entry.grant.is_some() {
                        entry.state = GrantState::Revoking;
                        entry.grant.clone()
                    } else {
                        entry.state = GrantState::Cancelled;
                        None
                    }
                }
                None => None,
            }
        };
        let Some(grant) = grant else { return };
        let (journal, entries, acl_lock, key_c) = (
            self.journal.clone(),
            self.entries.clone(),
            self.acl_lock.clone(),
            k.to_string(),
        );
        self.in_flight.fetch_add(1, Ordering::SeqCst);
        let flight = InFlight(self.in_flight.clone());
        std::thread::spawn(move || {
            let _flight = flight;
            let result = {
                let _serial = acl_lock.lock().unwrap_or_else(|p| p.into_inner());
                revoke(&grant, &journal)
            };
            let mut entries = entries.lock().unwrap_or_else(|p| p.into_inner());
            // Only act if this revoke still owns the entry (a newer begin_grant may have replaced
            // it with a fresh sequence, in which case leave that newer operation alone).
            match entries.get(&key_c) {
                Some(entry) if entry.seq != seq => return,
                None => return,
                _ => {}
            }
            match result {
                Ok(()) => {
                    entries.remove(&key_c);
                }
                Err(e) => {
                    if let Some(entry) = entries.get_mut(&key_c) {
                        entry.state = GrantState::RecoveryRequired(format!("{e:?}"));
                    }
                }
            }
        });
    }

    /// The current state of `k` (absent = never requested or fully revoked).
    pub fn state(&self, k: &str) -> Option<GrantState> {
        let entries = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        entries.get(k).map(|e| e.state.clone())
    }

    /// Whether a server for `k` may start: only when the grant is applied and verified.
    pub fn is_ready(&self, k: &str) -> bool {
        matches!(self.state(k), Some(GrantState::Granted))
    }

    /// Server-start gating. Returns `Ok(())` only when launching a contained server for `root` is
    /// safe: the grant is `Granted` with a stored grant whose identity matches, the journal is
    /// readable and still records it, and a *fresh* effective re-verify shows at least one
    /// container ACE present and no effective write. Any other situation -- pending, cancelled,
    /// failed, revoked, recovery-required, an unreadable journal, or a workspace/identity mismatch
    /// -- is refused, so a stale or superseded grant can never gate a launch. This is the
    /// native-authoritative check; nothing the renderer says can substitute for it.
    pub fn may_start(&self, root: &Path, container: &str) -> Result<(), GrantError> {
        let k = key(root, container);
        let grant = {
            let entries = self.entries.lock().unwrap_or_else(|p| p.into_inner());
            match entries.get(&k) {
                Some(entry) => match &entry.state {
                    GrantState::Granted => entry.grant.clone().ok_or_else(|| {
                        GrantError::NotReady("granted without a stored grant".into())
                    })?,
                    other => {
                        return Err(GrantError::NotReady(format!("grant state is {other:?}")));
                    }
                },
                None => return Err(GrantError::NotReady("no grant for this workspace".into())),
            }
        };
        // The stored grant must match the identity and workspace asked for (defence against a key
        // collision or a forged request reaching a different grant).
        if grant.container != container || grant.root != canonical(root)? {
            return Err(GrantError::NotReady(
                "stored grant does not match the requested workspace/identity".into(),
            ));
        }
        // The journal must be healthy and still record this grant.
        let journalled = self.journal.load()?;
        let root_s = grant.root.to_string_lossy();
        if !journalled
            .iter()
            .any(|e| e.root == root_s && e.container == grant.container)
        {
            return Err(GrantError::NotReady(
                "grant is not present in the journal".into(),
            ));
        }
        // Fresh effective re-verify under the ACL lock: at least one container ACE, no write.
        let _serial = self.acl_lock.lock().unwrap_or_else(|p| p.into_inner());
        if crate::sandbox::container_aces(&grant.root, &grant.container)
            .map_err(GrantError::Failed)?
            < 1
        {
            return Err(GrantError::NotReady(
                "no container ACE present at start".into(),
            ));
        }
        if crate::sandbox::container_writable(&grant.root, &grant.container)
            .map_err(GrantError::Failed)?
        {
            return Err(GrantError::VerifyFailed(
                "container can write at start".into(),
            ));
        }
        Ok(())
    }

    /// Startup reconciliation of grants a crash left journalled.
    pub fn reconcile(&self) -> Result<usize, GrantError> {
        let _serial = self.acl_lock.lock().unwrap_or_else(|p| p.into_inner());
        reconcile(&self.journal)
    }
}
