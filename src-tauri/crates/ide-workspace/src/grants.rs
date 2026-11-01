//! EXT-33 E2: native **consent and capability grants** for the C1 broker.
//!
//! A C1 filter runs only when the user has granted it (deny by default). A grant is created only
//! through a real approval ([`Approver`] -- a native dialog in production), never from anything
//! the renderer or an extension says: there is no API that turns an outside "approved" into a
//! grant. Each grant binds to the extension's identity and installed copy, the program's path and
//! SHA-256, a C1 profile, the scope, and (optionally) a workspace, plus a monotonic id for
//! revocation. The authority re-validates every binding at launch; the broker independently
//! re-verifies the program's bytes (§7). A change to the copy, the program or the scope matches
//! no grant, so the user is asked again.
//!
//! Revocation ends the grant's running processes **before it returns** and stops new launches,
//! and it is race-safe against a launch in flight: the authority's lock is held across both the
//! check-and-register at launch and the revoke, so a launch either registers before the revoke
//! (and is then ended) or finds its grant gone (and is refused).
//!
//! Grants are persisted by Yavin alone, as JSON in the app's config folder, written atomically
//! ([`crate::durable::write_json`]). If the store cannot be read, or an entry does not parse, the
//! authority holds no grants and every launch is denied (fail closed). Grants are **separate**
//! from Workspace Trust: trust is necessary (as for every class) but never, by itself, consent to
//! run a program.
//!
//! E2 implements the authority and its enforcement; it does not wire a window command or an
//! extension-facing API (that is E4), and Yavin registers no C1 profiles yet.

use crate::broker::{C1Broker, C1Code, C1Error, C1Output, LaunchObserver, SlotValue};
use crate::sandbox::SandboxedChild;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// The capability class a grant covers. C1 is the stdin→stdout filter (E1–E4). C2 is a contained
/// server with read-only workspace access (E5): a C2 grant is always bound to a workspace. C3
/// (contained execution) is not grantable here yet.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Scope {
    C1,
    C2,
}

/// What a C1 grant binds to (§8.2). Everything here is decided natively; none comes from the
/// renderer as an authority.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Grant {
    pub grant_id: u64,
    pub extension_id: String,
    /// The installed copy's identity (version and package hash, EXT-19): an update changes it.
    pub copy_id: String,
    /// The program's canonical path and the SHA-256 it had when granted.
    pub program_path: String,
    pub program_sha256: String,
    pub profile_id: String,
    pub scope: Scope,
    /// The workspace the grant is bound to, or `None` for a C1 filter (its input is stdin, so it
    /// reads no workspace). A bound grant applies only in that workspace.
    pub workspace: Option<String>,
}

/// The launch the broker is about to perform; a grant must match it in every field.
#[derive(Clone, Debug, PartialEq)]
pub struct LaunchKey {
    pub extension_id: String,
    pub copy_id: String,
    pub program_path: String,
    pub program_sha256: String,
    pub profile_id: String,
    pub scope: Scope,
    pub workspace: Option<String>,
}

impl Grant {
    /// Whether this grant authorises `key`: every identity binding equal, and the workspace
    /// either unbound (`None`) or the same.
    fn authorises(&self, key: &LaunchKey) -> bool {
        self.extension_id == key.extension_id
            && self.copy_id == key.copy_id
            && self.program_path == key.program_path
            && self
                .program_sha256
                .eq_ignore_ascii_case(&key.program_sha256)
            && self.profile_id == key.profile_id
            && self.scope == key.scope
            && (self.workspace.is_none() || self.workspace == key.workspace)
    }
}

/// What the user is shown before granting (§8.1). Data only; the [`Approver`] renders it, and the
/// dialog never says "safe" (§8.6).
#[derive(Clone, Debug)]
pub struct ConsentRequest {
    pub extension_id: String,
    pub extension_version: String,
    /// The signer, or `None` for "not signed".
    pub signer: Option<String>,
    pub program_path: String,
    /// The full hash; an approver shows the first 12 hex digits.
    pub program_sha256: String,
    pub bundled: bool,
    pub profile_id: String,
    pub scope: Scope,
    /// The workspace a C2 server would read (shown in the C2 consent); `None` for a C1 filter.
    pub workspace: Option<String>,
}

/// How a grant is approved. The sole authority for creating a grant: nothing the renderer or an
/// extension sends is an input here. A production approver is a native OS dialog
/// ([`DialogApprover`]); tests use a scripted one.
pub trait Approver: Send + Sync {
    /// Shown the request; returns `true` only on the user's explicit approval. Deny by default.
    fn approve(&self, request: &ConsentRequest) -> bool;
}

/// A running launch the authority can end on revocation.
struct Live {
    child: Arc<SandboxedChild>,
    flag: Arc<AtomicBool>,
}

/// Holds one of an extension's [`MAX_PER_EXTENSION`] slots while a run is in flight; releases it
/// (under the authority's lock) when dropped, however the run ends.
struct PerExtensionSlot<'a> {
    authority: &'a GrantAuthority,
    extension_id: String,
}

impl<'a> PerExtensionSlot<'a> {
    fn acquire(
        authority: &'a GrantAuthority,
        extension_id: &str,
    ) -> Result<PerExtensionSlot<'a>, C1Error> {
        let taken = authority
            .with_inner(|inner| {
                let count = inner
                    .per_extension
                    .entry(extension_id.to_string())
                    .or_insert(0);
                if *count >= MAX_PER_EXTENSION {
                    false
                } else {
                    *count += 1;
                    true
                }
            })
            .map_err(|e| denied(format!("grants could not be read: {e}")))?;
        if !taken {
            return Err(C1Error {
                code: C1Code::TooManyProcesses,
                message: "this extension is already running as many filters as it may at once."
                    .into(),
                profile: None,
            });
        }
        Ok(PerExtensionSlot {
            authority,
            extension_id: extension_id.to_string(),
        })
    }
}

impl Drop for PerExtensionSlot<'_> {
    fn drop(&mut self) {
        let _ = self.authority.with_inner(|inner| {
            if let Some(count) = inner.per_extension.get_mut(&self.extension_id) {
                *count = count.saturating_sub(1);
                if *count == 0 {
                    inner.per_extension.remove(&self.extension_id);
                }
            }
        });
    }
}

/// The most C1 filters one extension may run at once (§11; the host-wide cap of 8 is the
/// broker's). A formatter runs per save or keystroke (debounced); two allow a little overlap.
pub const MAX_PER_EXTENSION: u32 = 2;

struct Inner {
    grants: Vec<Grant>,
    next_id: u64,
    live: HashMap<u64, Vec<Live>>,
    /// How many filters each extension is running now, for the per-extension cap.
    per_extension: HashMap<String, u32>,
    loaded: bool,
}

/// The native grant authority: it owns the grants, their persistence, and the live processes so a
/// revocation can end them.
pub struct GrantAuthority {
    file: PathBuf,
    inner: Mutex<Inner>,
}

impl GrantAuthority {
    /// An authority persisting to `file` (in the app's config folder). Grants load lazily on first
    /// use; an unreadable or corrupt store yields no grants (fail closed).
    pub fn new(file: PathBuf) -> GrantAuthority {
        GrantAuthority {
            file,
            inner: Mutex::new(Inner {
                grants: Vec::new(),
                next_id: 1,
                live: HashMap::new(),
                per_extension: HashMap::new(),
                loaded: false,
            }),
        }
    }

    fn with_inner<T>(&self, run: impl FnOnce(&mut Inner) -> T) -> Result<T, String> {
        let mut guard = self.inner.lock().map_err(|e| e.to_string())?;
        if !guard.loaded {
            // Fail closed: anything unreadable or unparseable means no grants.
            let loaded: Vec<Grant> = std::fs::read_to_string(&self.file)
                .ok()
                .and_then(|text| serde_json::from_str(&text).ok())
                .unwrap_or_default();
            guard.next_id = loaded.iter().map(|g| g.grant_id).max().unwrap_or(0) + 1;
            guard.grants = loaded;
            guard.loaded = true;
        }
        Ok(run(&mut guard))
    }

    /// Records a grant, but **only** if `approver` approves (deny by default). The grant's
    /// identity is what the caller verified natively, never a value from the renderer. A new
    /// approval for the same extension copy, profile, scope and workspace replaces the old grant.
    /// Fails (and records nothing) if the scope is unsupported, approval is withheld, or the store
    /// cannot be written.
    pub fn request(&self, grant: GrantRequest, approver: &dyn Approver) -> Result<Grant, String> {
        match grant.scope {
            Scope::C1 => {}
            // A C2 server reads a workspace, so its grant must name one (deny the ambiguous case).
            Scope::C2 => {
                if grant.workspace.is_none() {
                    return Err("a contained server must be granted a specific workspace.".into());
                }
            }
        }
        let consent = ConsentRequest {
            extension_id: grant.extension_id.clone(),
            extension_version: grant.extension_version.clone(),
            signer: grant.signer.clone(),
            program_path: grant.program_path.clone(),
            program_sha256: grant.program_sha256.clone(),
            bundled: grant.bundled,
            profile_id: grant.profile_id.clone(),
            scope: grant.scope,
            workspace: grant.workspace.clone(),
        };
        if !approver.approve(&consent) {
            return Err("not allowed.".into());
        }
        self.with_inner(|inner| {
            let grant_id = inner.next_id;
            let record = Grant {
                grant_id,
                extension_id: grant.extension_id,
                copy_id: grant.copy_id,
                program_path: grant.program_path,
                program_sha256: grant.program_sha256,
                profile_id: grant.profile_id,
                scope: grant.scope,
                workspace: grant.workspace,
            };
            // Replace any prior grant for the same copy, profile, scope and workspace.
            let mut candidate: Vec<Grant> = inner
                .grants
                .iter()
                .filter(|g| {
                    !(g.extension_id == record.extension_id
                        && g.copy_id == record.copy_id
                        && g.profile_id == record.profile_id
                        && g.scope == record.scope
                        && g.workspace == record.workspace)
                })
                .cloned()
                .collect();
            candidate.push(record.clone());
            // Persist first; keep nothing in memory that is not durably stored (fail closed).
            crate::durable::write_json(&self.file, &candidate)
                .map_err(|e| format!("the grant could not be saved: {e}"))?;
            inner.grants = candidate;
            inner.next_id = grant_id + 1;
            Ok(record)
        })?
    }

    /// The grant that authorises `key`, or [`C1Code::PermissionDenied`] if none does (deny by
    /// default; a changed copy, program, scope or workspace matches nothing).
    pub fn authorize(&self, key: &LaunchKey) -> Result<u64, C1Error> {
        let found = self
            .with_inner(|inner| {
                inner
                    .grants
                    .iter()
                    .find(|g| g.authorises(key))
                    .map(|g| g.grant_id)
            })
            .map_err(|e| denied(format!("grants could not be read: {e}")))?;
        found.ok_or_else(|| {
            denied(
                "this extension is not allowed to run this filter; it must be allowed first."
                    .to_string(),
            )
        })
    }

    /// Runs the C1 profile for `key` through `broker`, under this authority: it authorises first
    /// (deny by default), then runs with an observer so a revocation ends the process. The broker
    /// still verifies the program's bytes itself.
    pub fn run_c1(
        &self,
        broker: &C1Broker,
        key: &LaunchKey,
        slots: &[SlotValue],
        stdin: &[u8],
        cancel: Arc<AtomicBool>,
    ) -> Result<C1Output, C1Error> {
        let grant_id = self.authorize(key)?;
        // Per-extension cap (the broker holds the host-wide one). Reserved under the lock and
        // released when this run ends, so an extension cannot exceed its share even under a race.
        let _slot = PerExtensionSlot::acquire(self, &key.extension_id)?;
        let observer = AuthorityObserver {
            authority: self,
            grant_id,
        };
        broker.run_observed(&key.profile_id, slots, stdin, cancel, Some(&observer))
    }

    /// Revokes the grant `grant_id`: it stops new launches and **ends the grant's running
    /// processes before returning** (§8.3, T19). Removing the grant is persisted; the processes
    /// are ended whether or not the write succeeds.
    pub fn revoke(&self, grant_id: u64) -> Result<(), String> {
        // End running processes and drop the grant under the lock, so a launch in flight cannot
        // register after the revoke decides what to end.
        let write = self.with_inner(|inner| {
            if let Some(live) = inner.live.remove(&grant_id) {
                for launch in &live {
                    launch.flag.store(false, Ordering::SeqCst);
                    launch.child.kill();
                }
            }
            let had = inner.grants.iter().any(|g| g.grant_id == grant_id);
            inner.grants.retain(|g| g.grant_id != grant_id);
            if had {
                crate::durable::write_json(&self.file, &inner.grants)
            } else {
                Ok(())
            }
        })?;
        write.map_err(|e| format!("the grant was revoked but the change could not be saved: {e}"))
    }

    /// The current grants (for a management view or a test).
    pub fn grants(&self) -> Result<Vec<Grant>, String> {
        self.with_inner(|inner| inner.grants.clone())
    }

    /// Registers a live C2 server `child` under `grant_id` so [`Self::revoke`] ends it. Returns the
    /// run flag to watch: a `false` flag means the grant was already gone (revoked in the race), so
    /// the caller must end the process at once. Mirrors the C1 broker observer's registration, so a
    /// C2 server is revocable by the same authority and the same race rules.
    pub fn note_launch(&self, grant_id: u64, child: Arc<SandboxedChild>) -> Arc<AtomicBool> {
        self.with_inner(|inner| {
            if !inner.grants.iter().any(|g| g.grant_id == grant_id) {
                return Arc::new(AtomicBool::new(false));
            }
            let flag = Arc::new(AtomicBool::new(true));
            inner.live.entry(grant_id).or_default().push(Live {
                child,
                flag: flag.clone(),
            });
            flag
        })
        .unwrap_or_else(|_| Arc::new(AtomicBool::new(false)))
    }
}

/// The fields of a grant the caller asks for, plus the consent details. Separate from [`Grant`]
/// so the id is assigned by the authority, never by the caller.
pub struct GrantRequest {
    pub extension_id: String,
    pub extension_version: String,
    pub signer: Option<String>,
    pub copy_id: String,
    pub program_path: String,
    pub program_sha256: String,
    pub bundled: bool,
    pub profile_id: String,
    pub scope: Scope,
    pub workspace: Option<String>,
}

/// A `PermissionDenied` [`C1Error`] (constructed by field, since the broker's own constructor is
/// private to its module).
fn denied(message: String) -> C1Error {
    C1Error {
        code: C1Code::PermissionDenied,
        message,
        profile: None,
    }
}

/// The broker observer for one authorised launch: it registers the process so a revocation of
/// this grant can end it, and deregisters when it finishes.
struct AuthorityObserver<'a> {
    authority: &'a GrantAuthority,
    grant_id: u64,
}

impl LaunchObserver for AuthorityObserver<'_> {
    fn started(&self, child: Arc<SandboxedChild>) -> Arc<AtomicBool> {
        let grant_id = self.grant_id;
        self.authority
            .with_inner(|inner| {
                // If the grant is gone (revoked between authorize and now), do not register and
                // tell the broker to end the process at once.
                if !inner.grants.iter().any(|g| g.grant_id == grant_id) {
                    return Arc::new(AtomicBool::new(false));
                }
                let flag = Arc::new(AtomicBool::new(true));
                inner.live.entry(grant_id).or_default().push(Live {
                    child,
                    flag: flag.clone(),
                });
                flag
            })
            // A poisoned lock fails closed: end the process.
            .unwrap_or_else(|_| Arc::new(AtomicBool::new(false)))
    }

    fn ended(&self, child: &Arc<SandboxedChild>) {
        let grant_id = self.grant_id;
        let _ = self.authority.with_inner(|inner| {
            if let Some(live) = inner.live.get_mut(&grant_id) {
                live.retain(|l| !Arc::ptr_eq(&l.child, child));
                if live.is_empty() {
                    inner.live.remove(&grant_id);
                }
            }
        });
    }
}

/// A production [`Approver`] backed by a native OS dialog (`rfd`). The dialog, not the renderer,
/// is the authority. Not used by tests.
pub struct DialogApprover;

/// The body of the consent dialog (§8.1): the extension, the program's path, signer and the first
/// 12 hash digits, the profile, and the C1 class in plain words. It never says or implies "safe"
/// (§8.6). Factored out so its wording is tested without opening a dialog.
pub(crate) fn consent_body(request: &ConsentRequest) -> String {
    let signer = request.signer.as_deref().unwrap_or("not signed");
    let short: String = request.program_sha256.chars().take(12).collect();
    let origin = if request.bundled {
        "shipped by the extension"
    } else {
        "external"
    };
    match request.scope {
        Scope::C1 => format!(
            "{} {} wants to run a filter:\n\n{}\n{} · {} · {}\nprofile: {}\n\nIt can read the text you send it and return text. It cannot read your files, use the network or start programs.\n\nAllow this?",
            request.extension_id,
            request.extension_version,
            request.program_path,
            signer,
            short,
            origin,
            request.profile_id,
        ),
        // A C2 server reads the workspace. The wording states exactly what that exposes and never
        // claims the server is safe (§8.6): granting access is not a judgement that it is.
        Scope::C2 => format!(
            "{} {} wants to run a background server with read access to this workspace:\n\n{}\n{}\n{} · {} · {}\nprofile: {}\n\nThe server will be able to read any file in this workspace, including secrets such as .env files, credentials, private keys and .git/config. Allowing this does not mean the server is safe -- it only grants the access.\n\nAllow this?",
            request.extension_id,
            request.extension_version,
            request.workspace.as_deref().unwrap_or("(this workspace)"),
            request.program_path,
            signer,
            short,
            origin,
            request.profile_id,
        ),
    }
}

impl Approver for DialogApprover {
    fn approve(&self, request: &ConsentRequest) -> bool {
        let body = consent_body(request);
        rfd::MessageDialog::new()
            .set_level(rfd::MessageLevel::Warning)
            .set_title("Allow a filter to run?")
            .set_description(body)
            .set_buttons(rfd::MessageButtons::YesNo)
            .show()
            == rfd::MessageDialogResult::Yes
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;

    fn temp(label: &str) -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "yavin-grants-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("grants.json")
    }

    /// An approver that answers a scripted yes/no and records every request it was shown.
    struct Fake {
        yes: bool,
        shown: Mutex<Vec<ConsentRequest>>,
    }
    impl Fake {
        fn new(yes: bool) -> Fake {
            Fake {
                yes,
                shown: Mutex::new(Vec::new()),
            }
        }
    }
    impl Approver for Fake {
        fn approve(&self, request: &ConsentRequest) -> bool {
            self.shown.lock().unwrap().push(request.clone());
            self.yes
        }
    }

    fn req(ext: &str, copy: &str, program: &str, hash: &str, profile: &str) -> GrantRequest {
        GrantRequest {
            extension_id: ext.into(),
            extension_version: "1.0.0".into(),
            signer: None,
            copy_id: copy.into(),
            program_path: program.into(),
            program_sha256: hash.into(),
            bundled: true,
            profile_id: profile.into(),
            scope: Scope::C1,
            workspace: None,
        }
    }

    fn req_c2(ext: &str, copy: &str, workspace: Option<&str>) -> GrantRequest {
        GrantRequest {
            extension_id: ext.into(),
            extension_version: "1.0.0".into(),
            signer: None,
            copy_id: copy.into(),
            program_path: "server.exe".into(),
            program_sha256: "aa".into(),
            bundled: true,
            profile_id: "srv".into(),
            scope: Scope::C2,
            workspace: workspace.map(str::to_string),
        }
    }

    fn key(ext: &str, copy: &str, program: &str, hash: &str, profile: &str) -> LaunchKey {
        LaunchKey {
            extension_id: ext.into(),
            copy_id: copy.into(),
            program_path: program.into(),
            program_sha256: hash.into(),
            profile_id: profile.into(),
            scope: Scope::C1,
            workspace: None,
        }
    }

    #[test]
    fn nothing_is_authorized_without_a_grant() {
        let a = GrantAuthority::new(temp("deny"));
        let e = a
            .authorize(&key("ext", "c1", "p.exe", "aa", "fmt"))
            .unwrap_err();
        assert_eq!(e.code, C1Code::PermissionDenied);
    }

    #[test]
    fn a_grant_exists_only_after_approval() {
        let a = GrantAuthority::new(temp("approve"));
        let no = Fake::new(false);
        assert!(a
            .request(req("ext", "c1", "p.exe", "aa", "fmt"), &no)
            .is_err());
        assert!(a.grants().unwrap().is_empty());
        assert!(a
            .authorize(&key("ext", "c1", "p.exe", "aa", "fmt"))
            .is_err());
        assert_eq!(no.shown.lock().unwrap().len(), 1, "the user was asked");

        let yes = Fake::new(true);
        let grant = a
            .request(req("ext", "c1", "p.exe", "aa", "fmt"), &yes)
            .unwrap();
        assert_eq!(grant.scope, Scope::C1);
        assert!(a.authorize(&key("ext", "c1", "p.exe", "aa", "fmt")).is_ok());
    }

    #[test]
    fn the_consent_names_the_program_and_never_says_safe() {
        let r = ConsentRequest {
            extension_id: "acme.fmt".into(),
            extension_version: "2.1.0".into(),
            signer: Some("Acme Inc".into()),
            program_path: "C:/ext/clang-format.exe".into(),
            program_sha256: "0123456789abcdeffedcba".into(),
            bundled: true,
            profile_id: "clang-format.stdin".into(),
            scope: Scope::C1,
            workspace: None,
        };
        let body = consent_body(&r).to_lowercase();
        assert!(body.contains("c:/ext/clang-format.exe"));
        assert!(body.contains("0123456789ab"), "first 12 hash digits");
        assert!(!body.contains("0123456789abc"), "not more than 12");
        assert!(body.contains("clang-format.stdin"));
        assert!(body.contains("cannot read your files"));
        for forbidden in ["safe", "verified", "trusted"] {
            assert!(
                !body.contains(forbidden),
                "consent must not say {forbidden:?}"
            );
        }
    }

    #[test]
    fn the_c2_consent_names_the_workspace_and_its_secret_exposure_and_never_says_safe() {
        let r = ConsentRequest {
            extension_id: "acme.srv".into(),
            extension_version: "3.0.0".into(),
            signer: None,
            program_path: "C:/ext/server.exe".into(),
            program_sha256: "abcdef0123456789".into(),
            bundled: true,
            profile_id: "lsp.server".into(),
            scope: Scope::C2,
            workspace: Some("C:/work/project".into()),
        };
        let body = consent_body(&r);
        let lower = body.to_lowercase();
        assert!(body.contains("C:/work/project"), "names the workspace");
        assert!(lower.contains("read access to this workspace"));
        for secret in [".env", "credentials", "private keys", ".git/config"] {
            assert!(lower.contains(secret), "names {secret:?}");
        }
        assert!(
            lower.contains("does not mean the server is safe"),
            "states that access is not a safety judgement"
        );
        // It must never *claim* safety/trust/verification.
        assert!(!lower.contains("is safe to"), "no safety claim");
        for forbidden in ["verified", "trusted"] {
            assert!(!lower.contains(forbidden), "must not say {forbidden:?}");
        }
    }

    #[test]
    fn a_c2_grant_requires_a_workspace() {
        let a = GrantAuthority::new(temp("c2-ws"));
        assert!(
            a.request(req_c2("ext", "c1", None), &Fake::new(true))
                .is_err(),
            "a C2 grant without a workspace is refused"
        );
        assert!(a.grants().unwrap().is_empty());
        let granted = a.request(req_c2("ext", "c1", Some("C:/work/a")), &Fake::new(true));
        assert!(granted.is_ok(), "a C2 grant with a workspace is accepted");
        assert_eq!(granted.unwrap().scope, Scope::C2);
    }

    #[test]
    fn a_c2_grant_authorizes_only_its_own_workspace() {
        let a = GrantAuthority::new(temp("c2-auth"));
        a.request(req_c2("ext", "c1", Some("C:/work/a")), &Fake::new(true))
            .unwrap();
        let mut here = LaunchKey {
            extension_id: "ext".into(),
            copy_id: "c1".into(),
            program_path: "server.exe".into(),
            program_sha256: "aa".into(),
            profile_id: "srv".into(),
            scope: Scope::C2,
            workspace: Some("C:/work/a".into()),
        };
        assert!(a.authorize(&here).is_ok(), "its own workspace");
        here.workspace = Some("C:/work/b".into());
        assert!(a.authorize(&here).is_err(), "another workspace");
        here.workspace = Some("C:/work/a".into());
        here.scope = Scope::C1;
        assert!(a.authorize(&here).is_err(), "another scope");
    }

    #[test]
    fn a_changed_copy_program_or_profile_needs_reapproval() {
        let a = GrantAuthority::new(temp("change"));
        a.request(req("ext", "c1", "p.exe", "aa", "fmt"), &Fake::new(true))
            .unwrap();
        assert!(a.authorize(&key("ext", "c1", "p.exe", "aa", "fmt")).is_ok());
        assert!(
            a.authorize(&key("ext", "c2", "p.exe", "aa", "fmt"))
                .is_err(),
            "updated copy"
        );
        assert!(
            a.authorize(&key("ext", "c1", "p.exe", "bb", "fmt"))
                .is_err(),
            "changed program"
        );
        assert!(
            a.authorize(&key("ext", "c1", "p.exe", "aa", "other"))
                .is_err(),
            "other profile"
        );
        assert!(
            a.authorize(&key("ext", "c1", "q.exe", "aa", "fmt"))
                .is_err(),
            "other path"
        );
    }

    #[test]
    fn a_grant_is_not_reused_across_extensions_or_installs() {
        let a = GrantAuthority::new(temp("reuse"));
        a.request(req("ext.one", "c1", "p.exe", "aa", "fmt"), &Fake::new(true))
            .unwrap();
        assert!(
            a.authorize(&key("ext.two", "c1", "p.exe", "aa", "fmt"))
                .is_err(),
            "other extension"
        );
        assert!(
            a.authorize(&key("ext.one", "other-install", "p.exe", "aa", "fmt"))
                .is_err(),
            "other install"
        );
    }

    #[test]
    fn a_workspace_bound_grant_applies_only_there() {
        let a = GrantAuthority::new(temp("ws"));
        let mut bound = req("ext", "c1", "p.exe", "aa", "fmt");
        bound.workspace = Some("C:/work/a".into());
        a.request(bound, &Fake::new(true)).unwrap();
        let mut here = key("ext", "c1", "p.exe", "aa", "fmt");
        here.workspace = Some("C:/work/a".into());
        assert!(a.authorize(&here).is_ok());
        let mut elsewhere = key("ext", "c1", "p.exe", "aa", "fmt");
        elsewhere.workspace = Some("C:/work/b".into());
        assert!(
            a.authorize(&elsewhere).is_err(),
            "a bound grant is not used elsewhere"
        );
    }

    #[test]
    fn grants_persist_across_a_restart() {
        let file = temp("persist");
        {
            let a = GrantAuthority::new(file.clone());
            a.request(req("ext", "c1", "p.exe", "aa", "fmt"), &Fake::new(true))
                .unwrap();
        }
        let b = GrantAuthority::new(file);
        assert!(b.authorize(&key("ext", "c1", "p.exe", "aa", "fmt")).is_ok());
    }

    #[test]
    fn a_corrupt_store_grants_nothing() {
        let file = temp("corrupt");
        std::fs::write(&file, b"{ this is not valid json ][").unwrap();
        let a = GrantAuthority::new(file);
        assert!(
            a.grants().unwrap().is_empty(),
            "a corrupt store yields no grants"
        );
        assert!(a
            .authorize(&key("ext", "c1", "p.exe", "aa", "fmt"))
            .is_err());
    }

    #[test]
    fn revocation_stops_new_launches_and_persists() {
        let file = temp("revoke");
        let a = GrantAuthority::new(file.clone());
        let grant = a
            .request(req("ext", "c1", "p.exe", "aa", "fmt"), &Fake::new(true))
            .unwrap();
        assert!(a.authorize(&key("ext", "c1", "p.exe", "aa", "fmt")).is_ok());
        a.revoke(grant.grant_id).unwrap();
        assert!(
            a.authorize(&key("ext", "c1", "p.exe", "aa", "fmt"))
                .is_err(),
            "revoked"
        );
        let b = GrantAuthority::new(file);
        assert!(b
            .authorize(&key("ext", "c1", "p.exe", "aa", "fmt"))
            .is_err());
    }

    #[test]
    fn a_grant_that_cannot_be_saved_is_not_in_force() {
        // The grant file's "parent" is actually a regular file, so `create_dir_all` and the write
        // both fail -- a stand-in for any grant-storage failure.
        let blocker = std::env::temp_dir().join(format!(
            "yavin-grants-blocker-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&blocker, b"not a directory").unwrap();
        let file = blocker.join("grants.json");
        let a = GrantAuthority::new(file);
        assert!(
            a.request(req("ext", "c1", "p.exe", "aa", "fmt"), &Fake::new(true))
                .is_err(),
            "a grant that cannot be persisted must not be recorded"
        );
        assert!(a
            .authorize(&key("ext", "c1", "p.exe", "aa", "fmt"))
            .is_err());
    }
}
