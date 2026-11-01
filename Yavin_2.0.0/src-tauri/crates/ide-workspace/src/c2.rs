//! EXT-33 E5 (test-only): the native authority that launches a **contained server** (class C2).
//!
//! This composes the pieces E1–E4 and Q5 already proved, and it is the one place a C2 launch is
//! decided. Every security decision is native; nothing a renderer or extension says is an
//! authority:
//!
//! - **identity is derived, never chosen.** The AppContainer name comes from
//!   [`crate::workspace_identity::derive`] over the loaded copy, the class and the canonical
//!   workspace; the program comes from a registered profile. A request names neither.
//! - **consent is required.** [`crate::grants::GrantAuthority`] gates the launch (deny by default,
//!   bound to the copy, program, profile, scope and workspace), with C2 consent wording that states
//!   the workspace-secret exposure and never claims safety.
//! - **the workspace ACL is verified before start.** [`crate::workspace_acl::WorkspaceGrantManager`]
//!   applies the read-only grant asynchronously and `may_start` re-verifies it (identity, journal,
//!   fresh effective read-only) immediately before launch.
//! - **the container is proven.** After spawn, the server's token AppContainer SID must equal the
//!   SID derived from its name, or it is killed (defence against a server not in its container).
//! - **revocation is complete.** It ends the process, drops the grant, removes the workspace ACE
//!   and verifies zero residue.
//!
//! **Production ships no C2 profiles** (`C2Authority::new` has an empty set, exactly as E4), so in a
//! packaged build every launch is `UnknownProfile`. A profile is injected only by `with_profiles`,
//! which is `#[cfg(test)]`, so no profile can reach a shipped binary. Enabling a real profile needs
//! a reviewed use case and the human approvals in `PROCESS_CAPABILITY_DESIGN.md` §24; until then
//! this path is reachable only from tests.

use crate::broker::{sha256_hex, ProgramId};
use crate::grants::{Approver, GrantAuthority, GrantRequest, LaunchKey, Scope};
use crate::sandbox::{self, SandboxPolicy, SandboxedChild};
use crate::workspace_acl::{GrantJournal, GrantState, WorkspaceGrantManager};
use crate::workspace_identity::{derive, CapabilityClass};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

/// How long a launch waits for the asynchronous workspace grant to reach a verified state before
/// giving up (and cleaning up). Generous: a large tree's grant can take seconds (§24.2).
const LAUNCH_TIMEOUT: Duration = Duration::from_secs(120);
const POLL: Duration = Duration::from_millis(10);

// --- Extension-to-server channel bounds (EXT-33 E5) -------------------------------------------
/// The largest request input (bytes) an extension may send a contained server.
const MAX_REQUEST: usize = 64 * 1024;
/// The largest response frame (bytes) the host will read back; a larger length prefix is refused
/// before any allocation, so a server cannot force an unbounded read.
const MAX_RESPONSE: usize = 1 << 20;
/// How long one request waits for its response before the server is terminated (the test protocol
/// cannot cancel one request on a blocking pipe, so a timeout ends the process -- documented).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// The most requests one grant's server may have in flight at once (its own serialize-per-server
/// lock makes them sequential; this bounds queueing so one extension cannot monopolize it).
const MAX_INFLIGHT_PER_GRANT: usize = 2;

/// A request sent to a contained server. The correlation `id` is assigned **natively** (never by
/// the extension), so responses cannot be cross-delivered. `op`/`input` are the extension's only
/// say, both bounded and validated against the profile's protocol.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct ServerRequest {
    pub id: u64,
    pub op: String,
    pub input: String,
}

/// A response from a contained server, correlated by `id`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct ServerResponse {
    pub id: u64,
    /// The result payload on success.
    #[serde(default)]
    pub data: Option<String>,
    /// A structured error from the server (an unknown op, bad input, …).
    #[serde(default)]
    pub error: Option<String>,
}

/// A Yavin-authored C2 server profile. Extensions cannot add one; production registers none.
#[derive(Clone, Debug)]
pub struct C2Profile {
    pub id: &'static str,
    pub program: ProgramId,
    pub argv: Vec<String>,
    pub memory_bytes: u64,
    pub cpu_rate: u32,
}

/// The native-sourced identity of the extension asking to launch. In production every field comes
/// from the loaded `HostCopy` (EXT-08), never from the request; tests build it directly.
#[derive(Clone, Debug)]
pub struct LaunchIdentity {
    pub extension_id: String,
    pub extension_version: String,
    /// The installed copy's identity (version + package hash): an update changes it.
    pub copy_id: String,
    pub signer: Option<String>,
    pub bundled: bool,
}

/// A refused launch: a stable code and a message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct C2Denial {
    pub code: &'static str,
    pub message: String,
}

fn denial(code: &'static str, message: impl Into<String>) -> C2Denial {
    C2Denial {
        code,
        message: message.into(),
    }
}

/// A launched contained server. Dropping it ends the process (its job closes). The pipes are held
/// so the server is not blocked on a closed stdout.
pub struct RunningServer {
    pub grant_id: u64,
    pub container: String,
    pub workspace_root: PathBuf,
    child: Arc<SandboxedChild>,
    run: Arc<AtomicBool>,
    pub stdin: Option<File>,
    pub stdout: Option<File>,
    pub stderr: Option<File>,
}

impl RunningServer {
    pub fn pid(&self) -> u32 {
        self.child.id()
    }
    /// The AppContainer SID actually on the server's token.
    pub fn token_container_sid(&self) -> Result<String, String> {
        sandbox::process_container_sid(&self.child)
    }
    /// Whether the authority still considers this launch live (its run flag is set).
    pub fn is_live(&self) -> bool {
        self.run.load(Ordering::SeqCst)
    }
    pub fn try_wait(&self) -> std::io::Result<Option<i32>> {
        self.child.try_wait()
    }
    pub fn kill(&self) {
        self.child.kill()
    }
}

/// What a live C2 launch needs for a complete revocation: the ACL key to revoke and the
/// root/container to verify the ACL cleaned to zero.
struct LiveC2 {
    acl_key: String,
    root: PathBuf,
    container: String,
}

/// The result of the shared launch sequence: a verified, contained, running server and its pipes.
struct Established {
    grant_id: u64,
    root: PathBuf,
    container: String,
    acl_key: String,
    child: Arc<SandboxedChild>,
    run: Arc<AtomicBool>,
    stdin: File,
    stdout: File,
    stderr: File,
}

/// A contained server the authority owns for the request channel: the host holds its pipes (never
/// an extension), serializes one request/response at a time over them, and can end it on timeout or
/// revocation.
struct ChannelServer {
    root: PathBuf,
    container: String,
    acl_key: String,
    child: Arc<SandboxedChild>,
    /// stdin+stdout, held under one lock so only one request/response is on the wire at a time.
    io: Mutex<ServerIo>,
    /// Requests currently queued/in flight, to bound monopolization.
    inflight: AtomicUsize,
    _stderr: File,
}

struct ServerIo {
    stdin: File,
    stdout: File,
}

/// The native C2 launch authority. One per app.
pub struct C2Authority {
    grants: GrantAuthority,
    acl: WorkspaceGrantManager,
    profiles: Vec<C2Profile>,
    live: Mutex<HashMap<u64, LiveC2>>,
    /// Contained servers owned for the request channel, keyed by grant id.
    channels: Mutex<HashMap<u64, Arc<ChannelServer>>>,
    /// Monotonic native request-correlation ids (never from an extension).
    request_seq: AtomicU64,
}

impl C2Authority {
    /// The production authority: **no** profiles (nothing launches), grants at `grants_file`, the
    /// ACL journal at `acl_journal`.
    pub fn new(grants_file: PathBuf, acl_journal: PathBuf) -> C2Authority {
        C2Authority {
            grants: GrantAuthority::new(grants_file),
            acl: WorkspaceGrantManager::new(GrantJournal::new(acl_journal)),
            profiles: Vec::new(),
            live: Mutex::new(HashMap::new()),
            channels: Mutex::new(HashMap::new()),
            request_seq: AtomicU64::new(1),
        }
    }

    /// A test authority over an explicit profile set. Gated behind the `c2-test-profiles` feature,
    /// which is off in every production build, so no profile can be compiled into a shipped binary.
    #[cfg(feature = "c2-test-profiles")]
    pub fn with_profiles(
        grants_file: PathBuf,
        acl_journal: PathBuf,
        profiles: Vec<C2Profile>,
    ) -> C2Authority {
        C2Authority {
            grants: GrantAuthority::new(grants_file),
            acl: WorkspaceGrantManager::new(GrantJournal::new(acl_journal)),
            profiles,
            live: Mutex::new(HashMap::new()),
            channels: Mutex::new(HashMap::new()),
            request_seq: AtomicU64::new(1),
        }
    }

    pub fn grants(&self) -> &GrantAuthority {
        &self.grants
    }

    /// The registered profiles (empty in production).
    pub fn profiles(&self) -> &[C2Profile] {
        &self.profiles
    }

    fn profile(&self, id: &str) -> Option<&C2Profile> {
        self.profiles.iter().find(|p| p.id == id)
    }

    /// Records consent for `ext` to run `profile_id` over `workspace_root`, through a native
    /// `approver`. The program and the derived identity are native; the grant binds to them.
    pub fn request_consent(
        &self,
        ext: &LaunchIdentity,
        workspace_root: &Path,
        profile_id: &str,
        approver: &dyn Approver,
    ) -> Result<(), String> {
        let profile = self
            .profile(profile_id)
            .ok_or("no such contained server.")?;
        // Bind consent to the canonical workspace the server will actually read.
        let identity = derive(&ext.copy_id, CapabilityClass::C2, workspace_root)
            .map_err(|e| format!("workspace identity could not be derived: {e:?}"))?;
        self.grants.request(
            GrantRequest {
                extension_id: ext.extension_id.clone(),
                extension_version: ext.extension_version.clone(),
                signer: ext.signer.clone(),
                copy_id: ext.copy_id.clone(),
                program_path: profile.program.path.to_string_lossy().into_owned(),
                program_sha256: profile.program.sha256.clone(),
                bundled: ext.bundled,
                profile_id: profile_id.to_string(),
                scope: Scope::C2,
                workspace: Some(identity.workspace_root.to_string_lossy().into_owned()),
            },
            approver,
        )?;
        Ok(())
    }

    /// Launches the contained server for `ext`/`profile_id` over `workspace_root` and returns a
    /// caller-owned handle. The full gate sequence runs in [`Self::establish`].
    pub fn launch(
        &self,
        ext: &LaunchIdentity,
        workspace_root: &Path,
        profile_id: &str,
    ) -> Result<RunningServer, C2Denial> {
        let e = self.establish(ext, workspace_root, profile_id)?;
        self.live.lock().unwrap_or_else(|p| p.into_inner()).insert(
            e.grant_id,
            LiveC2 {
                acl_key: e.acl_key.clone(),
                root: e.root.clone(),
                container: e.container.clone(),
            },
        );
        Ok(RunningServer {
            grant_id: e.grant_id,
            container: e.container,
            workspace_root: e.root,
            child: e.child,
            run: e.run,
            stdin: Some(e.stdin),
            stdout: Some(e.stdout),
            stderr: Some(e.stderr),
        })
    }

    /// The full launch sequence (shared by [`Self::launch`] and the request channel), enforcing:
    /// identity derivation, consent, async workspace grant, `may_start` re-verify, program-bytes
    /// check, sandboxed spawn, and token-SID verification. No step can be skipped; any failure
    /// cleans up (the ACL is revoked, the process killed). Production refuses every call
    /// (`UnknownProfile`), since it registers no profiles.
    fn establish(
        &self,
        ext: &LaunchIdentity,
        workspace_root: &Path,
        profile_id: &str,
    ) -> Result<Established, C2Denial> {
        // 1. The program is the profile's; a request never names a path. Unknown => refused.
        let profile = self
            .profile(profile_id)
            .ok_or_else(|| denial("UnknownProfile", "no such contained server."))?
            .clone();
        // 2–3. Derive the container identity from native records (copy, class, canonical workspace).
        let identity = derive(&ext.copy_id, CapabilityClass::C2, workspace_root).map_err(|e| {
            denial(
                "SandboxUnavailable",
                format!("workspace identity could not be derived: {e:?}"),
            )
        })?;
        let root = identity.workspace_root.clone();
        let container = identity.name.clone();

        // 4. Consent gate (deny by default): a grant must already bind this exact launch.
        let key = LaunchKey {
            extension_id: ext.extension_id.clone(),
            copy_id: ext.copy_id.clone(),
            program_path: profile.program.path.to_string_lossy().into_owned(),
            program_sha256: profile.program.sha256.clone(),
            profile_id: profile_id.to_string(),
            scope: Scope::C2,
            workspace: Some(root.to_string_lossy().into_owned()),
        };
        let grant_id = self
            .grants
            .authorize(&key)
            .map_err(|e| denial("PermissionDenied", e.message))?;

        // 5. Apply the workspace read grant asynchronously and wait for a verified outcome.
        let acl_key = self.acl.begin_grant(&root, &container);
        if !self.wait_ready(&acl_key) {
            let state = self.acl.state(&acl_key);
            self.cleanup_acl(&acl_key);
            return Err(denial(
                "GrantFailed",
                format!("the workspace read grant did not complete: {state:?}"),
            ));
        }
        // 6. Server-start gating: a fresh, native-authoritative re-verify of the effective grant.
        if let Err(e) = self.acl.may_start(&root, &container) {
            self.cleanup_acl(&acl_key);
            return Err(denial("NotReady", format!("{e:?}")));
        }
        // 7. The grant bound to a program hash; the bytes must still match (no process starts else).
        match sha256_hex(&profile.program.path) {
            Ok(h) if h.eq_ignore_ascii_case(&profile.program.sha256) => {}
            Ok(_) => {
                self.cleanup_acl(&acl_key);
                return Err(denial(
                    "ExecutableChanged",
                    "the server program changed since it was registered.",
                ));
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                self.cleanup_acl(&acl_key);
                return Err(denial(
                    "ExecutableNotFound",
                    "the server program was not found.",
                ));
            }
            Err(e) => {
                self.cleanup_acl(&acl_key);
                return Err(denial(
                    "SandboxUnavailable",
                    format!("the server program could not be read: {e}"),
                ));
            }
        }
        // 8. Spawn in exactly the derived container.
        let argv: Vec<&str> = profile.argv.iter().map(String::as_str).collect();
        let policy = SandboxPolicy {
            container: container.clone(),
            memory_bytes: profile.memory_bytes,
            cpu_rate: profile.cpu_rate,
        };
        let spawned = match sandbox::spawn(&profile.program.path, &argv, &policy) {
            Ok(s) => s,
            Err(e) => {
                self.cleanup_acl(&acl_key);
                return Err(denial("SandboxUnavailable", e));
            }
        };
        let child = Arc::new(spawned.child);
        // 9. The server must be in exactly its derived container (token SID == derived SID).
        let derived_sid = sandbox::container_sid_string(&container);
        let token_sid = sandbox::process_container_sid(&child);
        let matches =
            matches!((&derived_sid, &token_sid), (Ok(a), Ok(b)) if a.eq_ignore_ascii_case(b));
        if !matches {
            child.kill();
            self.cleanup_acl(&acl_key);
            return Err(denial(
                "SidMismatch",
                format!("the server is not in its derived container (derived {derived_sid:?}, token {token_sid:?})."),
            ));
        }
        // 10. Register for revocation; lose the race to a concurrent revoke => end at once.
        let run = self.grants.note_launch(grant_id, child.clone());
        if !run.load(Ordering::SeqCst) {
            child.kill();
            self.cleanup_acl(&acl_key);
            return Err(denial(
                "Revoked",
                "the grant was revoked as the server started.",
            ));
        }
        Ok(Established {
            grant_id,
            root,
            container,
            acl_key,
            child,
            run,
            stdin: spawned.stdin,
            stdout: spawned.stdout,
            stderr: spawned.stderr,
        })
    }

    /// EXT-33 E5: send one request to the contained server for (`ext`, `profile_id`,
    /// `workspace_root`) and return its bounded response. **Every** request is re-authorized from
    /// native state: the extension must be the grant's copy, the profile must be registered, the
    /// grant must be active for the derived container and workspace, the server must still be the
    /// grant's process, and the request must be within the protocol's bounds. The server is
    /// launched lazily on the first request and reused; a timeout or a dead server is a structured
    /// error (and the server is ended). If the grant is revoked during the call, no response is
    /// delivered. `op`/`input` are the extension's only say; identity, program, SID, container,
    /// workspace and the correlation id are all native.
    pub fn request(
        &self,
        ext: &LaunchIdentity,
        workspace_root: &Path,
        profile_id: &str,
        op: &str,
        input: &str,
    ) -> Result<ServerResponse, C2Denial> {
        // Bounds first: an oversized request never reaches a server.
        if input.len() > MAX_REQUEST {
            return Err(denial(
                "RequestTooLarge",
                format!("the request exceeds {MAX_REQUEST} bytes."),
            ));
        }
        if op.is_empty() || op.len() > 64 {
            return Err(denial(
                "InvalidRequest",
                "the operation name is missing or too long.",
            ));
        }
        // Re-authorize from native state on every request.
        let (grant_id, root, container, key) =
            self.authorize_request(ext, workspace_root, profile_id)?;
        // Get or lazily establish the server for this grant (verified startable before reuse).
        let server =
            self.channel_server(ext, workspace_root, &root, &container, profile_id, grant_id)?;
        // Bound how many requests one grant's server can have queued, so one extension cannot
        // monopolize it. The per-server io lock makes the accepted ones sequential.
        if server.inflight.fetch_add(1, Ordering::SeqCst) >= MAX_INFLIGHT_PER_GRANT {
            server.inflight.fetch_sub(1, Ordering::SeqCst);
            return Err(denial(
                "TooBusy",
                "this server is already handling as many requests as it may at once.",
            ));
        }
        let _guard = InflightGuard(&server.inflight);

        let id = self.request_seq.fetch_add(1, Ordering::SeqCst);
        let frame = ServerRequest {
            id,
            op: op.to_string(),
            input: input.to_string(),
        };
        let outcome = {
            let mut io = server.io.lock().unwrap_or_else(|p| p.into_inner());
            round_trip(&mut io, &server.child, &frame)
        };
        let response = match outcome {
            Ok(r) => r,
            Err(e) => {
                // A dead/timed-out server is removed so a later request re-establishes a fresh one;
                // the process is already ended by round_trip on timeout/too-large.
                self.channels
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .remove(&grant_id);
                return Err(e);
            }
        };
        // Post-revocation safety: if the grant went away during the round trip, do not deliver.
        if self.grants.authorize(&key).is_err() {
            return Err(denial(
                "Revoked",
                "the grant was revoked during the request; the response is not delivered.",
            ));
        }
        // Correlation: a response id that is not the one we assigned is a protocol violation.
        if response.id != id {
            return Err(denial(
                "ProtocolError",
                "the server's response did not correlate to the request.",
            ));
        }
        Ok(response)
    }

    /// Re-authorizes a request from native state: profile registered, identity derived, grant
    /// authorizes this exact (copy, program, profile, scope, workspace). Returns the grant id, the
    /// canonical root, the derived container, and the launch key (reused to re-check at delivery).
    fn authorize_request(
        &self,
        ext: &LaunchIdentity,
        workspace_root: &Path,
        profile_id: &str,
    ) -> Result<(u64, PathBuf, String, LaunchKey), C2Denial> {
        let profile = self
            .profile(profile_id)
            .ok_or_else(|| denial("UnknownProfile", "no such contained server."))?
            .clone();
        let identity = derive(&ext.copy_id, CapabilityClass::C2, workspace_root).map_err(|e| {
            denial(
                "SandboxUnavailable",
                format!("workspace identity could not be derived: {e:?}"),
            )
        })?;
        let root = identity.workspace_root.clone();
        let container = identity.name.clone();
        let key = LaunchKey {
            extension_id: ext.extension_id.clone(),
            copy_id: ext.copy_id.clone(),
            program_path: profile.program.path.to_string_lossy().into_owned(),
            program_sha256: profile.program.sha256.clone(),
            profile_id: profile_id.to_string(),
            scope: Scope::C2,
            workspace: Some(root.to_string_lossy().into_owned()),
        };
        // Per-request grant check (distinct from the launch-time one in `establish`): deny by
        // default on every call, so a revoked or mismatched grant cannot keep using the channel.
        let grant_id = match self.grants.authorize(&key) {
            Ok(id) => id,
            Err(e) => return Err(denial("PermissionDenied", e.message)),
        };
        Ok((grant_id, root, container, key))
    }

    /// The live channel server for `grant_id`, reused only if alive, in its container, and still
    /// startable (`may_start` fresh re-verify); otherwise a fresh one is established.
    fn channel_server(
        &self,
        ext: &LaunchIdentity,
        workspace_root: &Path,
        root: &Path,
        container: &str,
        _profile_id: &str,
        grant_id: u64,
    ) -> Result<Arc<ChannelServer>, C2Denial> {
        // Reuse path: check liveness/container under the lock, then re-verify may_start without it.
        let candidate = {
            let mut map = self.channels.lock().unwrap_or_else(|p| p.into_inner());
            match map.get(&grant_id) {
                Some(s) => {
                    let alive = s.child.try_wait().map(|w| w.is_none()).unwrap_or(false);
                    if alive && s.container == container {
                        Some(s.clone())
                    } else {
                        // Dead or not this grant's container: drop it and re-establish.
                        if let Some(old) = map.remove(&grant_id) {
                            old.child.kill();
                        }
                        None
                    }
                }
                None => None,
            }
        };
        if let Some(server) = candidate {
            self.acl
                .may_start(root, container)
                .map_err(|e| denial("NotReady", format!("{e:?}")))?;
            return Ok(server);
        }
        // Establish a fresh server (runs the full gate sequence, including may_start).
        let e = self.establish(ext, workspace_root, _profile_id)?;
        let server = Arc::new(ChannelServer {
            root: e.root,
            container: e.container,
            acl_key: e.acl_key,
            child: e.child,
            io: Mutex::new(ServerIo {
                stdin: e.stdin,
                stdout: e.stdout,
            }),
            inflight: AtomicUsize::new(0),
            _stderr: e.stderr,
        });
        let mut map = self.channels.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(existing) = map.get(&e.grant_id) {
            // Another thread won the race: keep its server, end ours.
            server.child.kill();
            return Ok(existing.clone());
        }
        map.insert(e.grant_id, server.clone());
        Ok(server)
    }

    /// Revokes `grant_id`: ends the running server and stops new launches (via the grant
    /// authority), then removes the workspace ACE and verifies zero residue. Returns an error if
    /// the ACL could not be cleaned (recovery required).
    pub fn revoke(&self, grant_id: u64) -> Result<(), String> {
        // Ends the process and drops the grant record before returning (race-safe, §8.3). This
        // kills any server registered under the grant -- a launched one and/or a channel one.
        self.grants.revoke(grant_id)?;
        let live = self
            .live
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&grant_id);
        // Remove and end the channel server too, so no in-flight or later request reaches it and no
        // stale response can be delivered.
        let channel = self
            .channels
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&grant_id);
        if let Some(channel) = &channel {
            channel.child.kill();
        }
        // The ACL metadata is the same from either path; clean it once and verify zero residue.
        let acl = live.map(|l| (l.acl_key, l.root, l.container)).or_else(|| {
            channel
                .as_ref()
                .map(|c| (c.acl_key.clone(), c.root.clone(), c.container.clone()))
        });
        if let Some((acl_key, root, container)) = acl {
            self.acl.begin_revoke(&acl_key);
            self.wait_quiescent();
            let residue = sandbox::container_aces(&root, &container).unwrap_or(1);
            if residue != 0 {
                return Err(format!(
                    "the server was stopped but {residue} workspace ACE(s) remain; recovery required."
                ));
            }
        }
        Ok(())
    }

    /// Startup reconciliation: remove any workspace ACE a crash left journalled before any C2
    /// launch is permitted. Returns how many were reconciled clean, or an error (recovery required).
    pub fn reconcile(&self) -> Result<usize, crate::workspace_acl::GrantError> {
        self.acl.reconcile()
    }

    /// Shutdown: revoke every live server (ending the process and removing its workspace ACE) and
    /// wait for the ACL workers to quiesce, so nothing is left running and no ACL worker outlives
    /// the app. Best effort per grant; the wait guarantees no untracked worker remains.
    pub fn shutdown(&self) {
        let mut ids: Vec<u64> = self
            .live
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .keys()
            .copied()
            .collect();
        ids.extend(
            self.channels
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .keys()
                .copied(),
        );
        ids.sort_unstable();
        ids.dedup();
        for id in ids {
            let _ = self.revoke(id);
        }
        self.wait_quiescent();
    }

    /// Whether no ACL worker is in flight (for a shutdown barrier).
    pub fn quiescent(&self) -> bool {
        self.acl.quiescent()
    }

    /// Waits until the ACL grant for `acl_key` is `Granted`, or a terminal non-granted state or the
    /// timeout ends the wait. Returns whether it reached `Granted`.
    fn wait_ready(&self, acl_key: &str) -> bool {
        let start = Instant::now();
        while start.elapsed() < LAUNCH_TIMEOUT {
            match self.acl.state(acl_key) {
                Some(GrantState::Granted) => return true,
                Some(GrantState::Pending)
                | Some(GrantState::Scanning)
                | Some(GrantState::Applying)
                | Some(GrantState::Verifying)
                | Some(GrantState::Revoking)
                | Some(GrantState::RollingBack) => {}
                // Terminal non-granted (Failed/Cancelled/RecoveryRequired) or gone: stop.
                _ => return false,
            }
            std::thread::sleep(POLL);
        }
        false
    }

    /// Waits (bounded) until no ACL worker is in flight, so a revoke's cleanup has settled.
    fn wait_quiescent(&self) {
        let start = Instant::now();
        while start.elapsed() < LAUNCH_TIMEOUT && !self.acl.quiescent() {
            std::thread::sleep(POLL);
        }
    }

    /// Best-effort ACL rollback for a launch that failed after `begin_grant`.
    fn cleanup_acl(&self, acl_key: &str) {
        self.acl.begin_revoke(acl_key);
        self.wait_quiescent();
    }
}

/// Decrements a server's in-flight count when a request ends, however it ends.
struct InflightGuard<'a>(&'a AtomicUsize);
impl Drop for InflightGuard<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// A frame sync marker. Each frame is `FRAME_MAGIC + 4-byte big-endian length + payload`. The
/// reader resynchronizes to the marker, discarding any preamble, so a server whose stdout also
/// carries unrelated bytes (e.g. a test harness's progress lines) cannot desync the protocol.
pub const FRAME_MAGIC: [u8; 4] = [0x1e, 0x59, 0x43, 0x32];
/// The most bytes to discard while resynchronizing before giving up (bounds a garbage stream).
const MAX_PREAMBLE: usize = 64 * 1024;

/// Why a response frame could not be read.
enum FrameError {
    /// The length prefix exceeds the cap (or too much garbage preceded a frame): nothing is read.
    TooLarge,
    Io(std::io::Error),
}

/// Writes one framed message: the magic marker, a 4-byte big-endian length, then the payload.
fn write_frame(w: &mut File, payload: &[u8]) -> std::io::Result<()> {
    w.write_all(&FRAME_MAGIC)?;
    w.write_all(&(payload.len() as u32).to_be_bytes())?;
    w.write_all(payload)?;
    w.flush()
}

/// Reads one framed message, resynchronizing to [`FRAME_MAGIC`] first and refusing a length over
/// `max` (or an over-long preamble) before allocating.
fn read_frame(r: &mut File, max: usize) -> Result<Vec<u8>, FrameError> {
    // Slide a 4-byte window over the stream until it equals the marker.
    let mut window = [0u8; 4];
    let mut seen = 0usize;
    loop {
        let mut b = [0u8; 1];
        r.read_exact(&mut b).map_err(FrameError::Io)?;
        window.rotate_left(1);
        window[3] = b[0];
        seen += 1;
        if seen >= 4 && window == FRAME_MAGIC {
            break;
        }
        if seen > MAX_PREAMBLE {
            return Err(FrameError::TooLarge);
        }
    }
    let mut len = [0u8; 4];
    r.read_exact(&mut len).map_err(FrameError::Io)?;
    let n = u32::from_be_bytes(len) as usize;
    if n > max {
        return Err(FrameError::TooLarge);
    }
    let mut buf = vec![0u8; n];
    r.read_exact(&mut buf).map_err(FrameError::Io)?;
    Ok(buf)
}

/// One request/response on a server's pipes, bounded by [`REQUEST_TIMEOUT`]. The response is read
/// on a helper thread so a stuck server cannot block forever; on timeout or an over-large frame the
/// process is ended (the test protocol cannot cancel a single blocking request).
fn round_trip(
    io: &mut ServerIo,
    child: &Arc<SandboxedChild>,
    frame: &ServerRequest,
) -> Result<ServerResponse, C2Denial> {
    let payload = serde_json::to_vec(frame).map_err(|e| denial("ProtocolError", format!("{e}")))?;
    write_frame(&mut io.stdin, &payload).map_err(|e| {
        denial(
            "ServerExited",
            format!("the server could not be written to: {e}"),
        )
    })?;
    let mut stdout = io
        .stdout
        .try_clone()
        .map_err(|e| denial("ServerExited", format!("{e}")))?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(read_frame(&mut stdout, MAX_RESPONSE));
    });
    match rx.recv_timeout(REQUEST_TIMEOUT) {
        Ok(Ok(bytes)) => serde_json::from_slice::<ServerResponse>(&bytes).map_err(|e| {
            denial(
                "ProtocolError",
                format!("the server sent a malformed response: {e}"),
            )
        }),
        Ok(Err(FrameError::TooLarge)) => {
            child.kill();
            Err(denial(
                "ResponseTooLarge",
                "the server's response exceeds the limit; it was ended.",
            ))
        }
        Ok(Err(FrameError::Io(e))) => Err(denial(
            "ServerExited",
            format!("the server ended or errored: {e}"),
        )),
        Err(_) => {
            child.kill();
            Err(denial(
                "Timeout",
                "the server did not respond in time; it was ended.",
            ))
        }
    }
}
