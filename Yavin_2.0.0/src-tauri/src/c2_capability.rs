//! EXT-33 E5 (plumbing; **activation stays disabled**): the Tauri + application layer over the
//! native [`C2Authority`]. It mirrors `process_capability.rs` and keeps every security decision on
//! the native side:
//!
//! - **identity is native.** The launch identity is built only from the loaded `HostCopy`
//!   (`ExtensionService::host_copy`, EXT-08), never from the request. A request carries only a
//!   lookup key (the extension id) and a profile id.
//! - **the workspace is native.** The workspace a server would read is Yavin's open workspace
//!   root, read from the native `Workspace` manager -- never a path from the request. No open
//!   workspace means no consent.
//! - **the program and class are native.** They come from the registered C2 profile and the fixed
//!   C2 class inside [`C2Authority`]; a request names neither, and there is no ACL-mutation or
//!   arbitrary-launch command.
//! - **consent is native.** A grant is created only through [`C2Authority::request_consent`] and a
//!   native `Approver` (the OS dialog in production); the renderer cannot forge approval.
//!
//! Production registers **no** C2 profiles, so `c2_request_consent` always answers "no such
//! contained server" and nothing can launch. These commands are the application plumbing for when a
//! reviewed profile and the human approvals in `PROCESS_CAPABILITY_DESIGN.md` §24 are in place.

use crate::extension_permissions::Denial;
use crate::extension_service::{ExtensionService, HostCopy};
use ide_workspace::c2::{C2Authority, LaunchIdentity};
use ide_workspace::grants::{Approver, DialogApprover, Grant, Scope};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::Path;
use tauri::{AppHandle, Manager, State};

/// The launch identity a C2 grant binds to, built **only** from the native loaded copy: its id,
/// version and package hash. Never anything a request supplies.
fn launch_identity_of(copy: &HostCopy) -> LaunchIdentity {
    LaunchIdentity {
        extension_id: copy.id.clone(),
        extension_version: copy.version.clone(),
        copy_id: format!(
            "{}@{}",
            copy.version,
            copy.sha256.as_deref().unwrap_or("unverified")
        ),
        signer: None,
        // A C2 server's program is a Yavin-authored, bundled profile program.
        bundled: true,
    }
}

/// The minimum a management view needs: never the program path/hash, copy id, SID or container.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct C2GrantView {
    pub grant_id: u64,
    pub extension_id: String,
    pub workspace: Option<String>,
    pub profile_id: String,
}

fn views_of(grants: Vec<Grant>) -> Vec<C2GrantView> {
    grants
        .into_iter()
        .filter(|g| g.scope == Scope::C2)
        .map(|g| C2GrantView {
            grant_id: g.grant_id,
            extension_id: g.extension_id,
            workspace: g.workspace,
            profile_id: g.profile_id,
        })
        .collect()
}

/// Records consent for the loaded copy to run `profile` over the **native** workspace. Refuses with
/// a structured error if there is no open workspace (a C2 server must read a specific one).
fn do_request_consent(
    authority: &C2Authority,
    copy: &HostCopy,
    workspace: Option<&str>,
    profile: &str,
    approver: &dyn Approver,
) -> Result<(), String> {
    let workspace = workspace.ok_or("open a folder before allowing a server to read it.")?;
    let identity = launch_identity_of(copy);
    authority.request_consent(&identity, Path::new(workspace), profile, approver)
}

/// Revokes a C2 grant, but only after verifying it exists as a C2 grant in the native authority
/// (an unknown or non-C2 id is refused -- the renderer cannot revoke by guessing an id).
fn do_revoke(authority: &C2Authority, grant_id: u64) -> Result<(), String> {
    let is_c2 = authority
        .grants()
        .grants()?
        .iter()
        .any(|g| g.grant_id == grant_id && g.scope == Scope::C2);
    if !is_c2 {
        return Err("no such server grant.".into());
    }
    authority.revoke(grant_id)
}

/// EXT-33 E5: the extension-host entry point for one contained-server request. The host has
/// already checked the `process` capability; this re-authorizes the C2 grant and runs the request
/// natively. Identity comes from the loaded `copy`, the workspace is Yavin's native open one, and
/// only `profile`/`op`/`input` come from the request (bounded, validated). Returns the server's
/// bounded `{data, error}` -- never a raw pipe or process handle -- or a structured [`Denial`].
pub fn call_server(
    authority: &C2Authority,
    copy: &HostCopy,
    workspace: Option<&str>,
    params: &Value,
) -> Result<Value, Denial> {
    let ws = workspace
        .ok_or_else(|| Denial::new("NoWorkspace", "open a folder before a server can read it."))?;
    let bad = |m: &str| Denial::new("InvalidRequest", m.to_string());
    let profile = params
        .get("profile")
        .and_then(Value::as_str)
        .ok_or_else(|| bad("\"profile\" must be a string"))?;
    let op = params
        .get("op")
        .and_then(Value::as_str)
        .ok_or_else(|| bad("\"op\" must be a string"))?;
    let input = params
        .get("input")
        .and_then(Value::as_str)
        .ok_or_else(|| bad("\"input\" must be a string"))?;
    let identity = launch_identity_of(copy);
    match authority.request(&identity, Path::new(ws), profile, op, input) {
        // Only the bounded payload and the server's structured error reach the extension.
        Ok(resp) => Ok(json!({ "data": resp.data, "error": resp.error })),
        Err(e) => Err(Denial::new(e.code, e.message)),
    }
}

/// The workspace Yavin has open now, read from the native manager (never from a request).
fn open_workspace(app: &AppHandle) -> Option<String> {
    let state = app.state::<crate::Workspace>();
    let open = state.0.lock().ok()?;
    open.as_ref()
        .map(|manager| manager.root().display().to_string())
}

/// EXT-33 E5: the window asks the user to allow a contained server to read the workspace. The
/// window only triggers this; identity is the loaded copy's, the workspace is Yavin's open one, and
/// the decision is the native dialog's -- so an extension cannot approve itself and the renderer
/// cannot forge approval, name a program, choose a SID or pick a workspace.
#[tauri::command]
pub async fn c2_request_consent(
    app: AppHandle,
    authority: State<'_, C2Authority>,
    service: State<'_, ExtensionService>,
    id: String,
    profile: String,
) -> Result<(), String> {
    // `id` is only a lookup key: the actual installed copy is resolved natively and must be loaded.
    let copy = service.host_copy(&id)?;
    let workspace = open_workspace(&app);
    do_request_consent(
        &authority,
        &copy,
        workspace.as_deref(),
        &profile,
        &DialogApprover,
    )
}

/// EXT-33 E5: the window revokes a C2 grant. The grant is selected by id and verified to exist as a
/// C2 grant natively; revocation ends the server, removes the workspace ACE and verifies cleanup
/// (returning an error if it cannot be verified -- never a silent success).
#[tauri::command]
pub async fn c2_revoke(authority: State<'_, C2Authority>, grant_id: u64) -> Result<(), String> {
    do_revoke(&authority, grant_id)
}

/// EXT-33 E5: the C2 grants in force, for a management view (minimal display fields only).
#[tauri::command]
pub async fn c2_grants(authority: State<'_, C2Authority>) -> Result<Vec<C2GrantView>, String> {
    Ok(views_of(authority.grants().grants()?))
}

#[cfg(all(test, windows, feature = "c2-test-profiles"))]
mod tests {
    use super::*;
    use ide_workspace::broker::{sha256_hex, ProgramId};
    use ide_workspace::c2::C2Profile;
    use ide_workspace::grants::ConsentRequest;
    use ide_workspace::sandbox::cpu_rate_for;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn unique(label: &str) -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "yavin-c2cap-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn workspace() -> PathBuf {
        let dir = unique("ws");
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn files() -> (PathBuf, PathBuf) {
        let g = unique("grants");
        let j = unique("journal");
        std::fs::create_dir_all(&g).unwrap();
        std::fs::create_dir_all(&j).unwrap();
        (g.join("c2-grants.json"), j.join("c2-acl-journal.json"))
    }

    fn test_profile() -> C2Profile {
        let me = std::env::current_exe().unwrap();
        let sha = sha256_hex(&me).unwrap();
        C2Profile {
            id: "test-server",
            program: ProgramId {
                path: me,
                sha256: sha,
            },
            argv: vec![],
            memory_bytes: 256 << 20,
            cpu_rate: cpu_rate_for(1, 4),
        }
    }

    fn authority_with_profile() -> C2Authority {
        let (g, j) = files();
        C2Authority::with_profiles(g, j, vec![test_profile()])
    }

    fn copy(id: &str) -> HostCopy {
        HostCopy {
            id: id.into(),
            folder: "folder".into(),
            main: "main.js".into(),
            version: "1.0.0".into(),
            sha256: Some("deadbeef".into()),
            stored: None,
            requested: Default::default(),
            origin: "development".into(),
            requires: Vec::new(),
            runtime: None,
        }
    }

    struct Scripted(bool);
    impl Approver for Scripted {
        fn approve(&self, _: &ConsentRequest) -> bool {
            self.0
        }
    }

    #[test]
    fn identity_is_built_from_the_copy_not_a_request() {
        // Different installed copies derive different identities; the fields come from the copy.
        let a = launch_identity_of(&copy("acme.srv"));
        let mut other = copy("acme.srv");
        other.version = "2.0.0".into();
        let b = launch_identity_of(&other);
        assert_eq!(a.extension_id, "acme.srv");
        assert!(a.copy_id.starts_with("1.0.0@"));
        assert_ne!(
            a.copy_id, b.copy_id,
            "a different copy is a different identity"
        );
    }

    #[test]
    fn consent_requires_a_native_open_workspace() {
        let auth = authority_with_profile();
        let e = do_request_consent(
            &auth,
            &copy("acme.srv"),
            None,
            "test-server",
            &Scripted(true),
        )
        .unwrap_err();
        assert!(e.contains("open a folder"), "{e}");
    }

    #[test]
    fn an_unknown_profile_is_refused() {
        let auth = authority_with_profile();
        let ws = workspace();
        assert!(do_request_consent(
            &auth,
            &copy("acme.srv"),
            Some(ws.to_str().unwrap()),
            "no-such-profile",
            &Scripted(true)
        )
        .is_err());
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn a_denied_dialog_records_no_grant() {
        let auth = authority_with_profile();
        let ws = workspace();
        assert!(do_request_consent(
            &auth,
            &copy("acme.srv"),
            Some(ws.to_str().unwrap()),
            "test-server",
            &Scripted(false)
        )
        .is_err());
        assert!(
            auth.grants().grants().unwrap().is_empty(),
            "nothing recorded"
        );
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn consent_is_recorded_and_listed_with_minimal_fields() {
        let auth = authority_with_profile();
        let ws = workspace();
        do_request_consent(
            &auth,
            &copy("acme.srv"),
            Some(ws.to_str().unwrap()),
            "test-server",
            &Scripted(true),
        )
        .expect("consent recorded");
        let views = views_of(auth.grants().grants().unwrap());
        assert_eq!(views.len(), 1);
        let v = &views[0];
        assert_eq!(v.extension_id, "acme.srv");
        assert_eq!(v.profile_id, "test-server");
        // The serialized view exposes only the permitted keys -- no program path, hash or copy id.
        let json = serde_json::to_value(v).unwrap();
        let keys: std::collections::BTreeSet<_> =
            json.as_object().unwrap().keys().cloned().collect();
        let allowed: std::collections::BTreeSet<_> =
            ["grantId", "extensionId", "workspace", "profileId"]
                .into_iter()
                .map(String::from)
                .collect();
        assert_eq!(keys, allowed, "only minimal display fields are exposed");
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn revoking_an_unknown_grant_is_refused() {
        let auth = authority_with_profile();
        assert!(do_revoke(&auth, 9999).is_err(), "an unknown id is refused");
    }

    #[test]
    fn the_production_authority_registers_no_profiles() {
        let (g, j) = files();
        let prod = C2Authority::new(g, j);
        assert!(
            prod.profiles().is_empty(),
            "production ships no C2 profiles"
        );
        let ws = workspace();
        // With no profile, consent is refused (nothing can be launched in production).
        assert!(do_request_consent(
            &prod,
            &copy("acme.srv"),
            Some(ws.to_str().unwrap()),
            "test-server",
            &Scripted(true)
        )
        .is_err());
        let _ = std::fs::remove_dir_all(&ws);
    }
}
