//! EXT-33 E4: the native bridge from an extension's `process.runFilter` request to the C1 broker
//! and grant authority. It is the one place the renderer-facing API meets the native enforcement,
//! and it keeps every security decision on the native side:
//!
//! - **identity is native.** The calling extension's id and installed-copy identity come from the
//!   `HostCopy` the host loaded for this session (EXT-08), never from the request. A compromised
//!   window or extension cannot name another extension or another copy.
//! - **the program is Yavin's.** A request names only a profile id and typed slots; the program's
//!   path and SHA-256 come from the profile ([`C1Broker`]), never from the request.
//! - **two native gates.** The host first checks the `process` capability (EXT-07, `allow`); then
//!   this module checks the specific grant ([`GrantAuthority`]: extension copy, program, profile,
//!   scope, workspace) and runs through the broker, which re-verifies the program's bytes and
//!   enforces the E3 limits (including the per-extension concurrency cap).
//! - **consent is native.** A grant is created only by [`GrantAuthority::request`] through a native
//!   `Approver`; nothing the window sends is an authority.
//!
//! E4 registers **no production profiles**: a reviewed profile with a concrete use case is a later
//! step, so in the shipped build every `process.runFilter` is `UnknownProfile`. The path, its
//! authorization and its tests are all in place for when the first profile is approved.

use crate::extension_permissions::Denial;
use crate::extension_service::ExtensionService;
use crate::extension_service::HostCopy;
use ide_workspace::broker::{C1Broker, C1Code, C1Error, SlotValue};
use ide_workspace::grants::{
    Approver, DialogApprover, Grant, GrantAuthority, GrantRequest, LaunchKey, Scope,
};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};

/// The C1 process capability: the broker (profiles + sandbox) and the grant authority, together.
pub struct ProcessCapability {
    broker: C1Broker,
    grants: GrantAuthority,
}

impl ProcessCapability {
    /// The production capability: an empty profile set (nothing runs until a profile is approved)
    /// and grants persisted at `grants_file`.
    pub fn new(grants_file: PathBuf) -> ProcessCapability {
        ProcessCapability {
            broker: C1Broker::new(Vec::new()),
            grants: GrantAuthority::new(grants_file),
        }
    }

    /// A capability over an explicit profile set, for tests.
    #[cfg(test)]
    pub fn with_profiles(
        grants_file: PathBuf,
        profiles: Vec<ide_workspace::broker::C1Profile>,
    ) -> ProcessCapability {
        ProcessCapability {
            broker: C1Broker::new(profiles),
            grants: GrantAuthority::new(grants_file),
        }
    }

    pub fn grants(&self) -> &GrantAuthority {
        &self.grants
    }

    /// The installed-copy identity a grant binds to: version and package hash, from the native
    /// `HostCopy` -- never anything the request supplies.
    fn copy_id(copy: &HostCopy) -> String {
        format!(
            "{}@{}",
            copy.version,
            copy.sha256.as_deref().unwrap_or("unverified")
        )
    }

    /// Runs the `process.runFilter` request `params` for the extension whose loaded copy is
    /// `copy`, in `workspace`. Identity and the program come from `copy` and the profile, not the
    /// request. Returns `{ stdout, code }` or a [`Denial`] whose code is the broker's.
    pub fn run_filter(
        &self,
        copy: &HostCopy,
        workspace: Option<&str>,
        params: &Value,
    ) -> Result<Value, Denial> {
        let request = ProcessRequest::parse(params)?;
        // The program is the profile's; the request never names a path. An unknown profile is
        // refused (and E4 ships none, so this is the shipped answer).
        let program = self
            .broker
            .profile_program(&request.profile)
            .ok_or_else(|| Denial::new("UnknownProfile", "no such filter."))?;
        let key = LaunchKey {
            extension_id: copy.id.clone(),
            copy_id: Self::copy_id(copy),
            program_path: program.path.to_string_lossy().into_owned(),
            program_sha256: program.sha256.clone(),
            profile_id: request.profile.clone(),
            scope: Scope::C1,
            workspace: workspace.map(str::to_string),
        };
        let cancel = Arc::new(AtomicBool::new(false));
        match self.grants.run_c1(
            &self.broker,
            &key,
            &request.slots,
            request.input.as_bytes(),
            cancel,
        ) {
            Ok(output) => Ok(json!({
                "stdout": String::from_utf8_lossy(&output.stdout),
                "code": output.code,
            })),
            Err(error) => Err(denial_of(error)),
        }
    }

    /// Records consent for the extension `copy` to run `profile`, through `approver` (a native
    /// dialog). The program and identity are native; the grant binds to them. Fails if there is no
    /// such profile, the approver withholds approval, or the grant cannot be saved.
    pub fn request_consent(
        &self,
        copy: &HostCopy,
        workspace: Option<&str>,
        profile: &str,
        signer: Option<String>,
        approver: &dyn Approver,
    ) -> Result<(), String> {
        let program = self
            .broker
            .profile_program(profile)
            .ok_or("no such filter.")?;
        self.grants.request(
            GrantRequest {
                extension_id: copy.id.clone(),
                extension_version: copy.version.clone(),
                signer,
                copy_id: Self::copy_id(copy),
                program_path: program.path.to_string_lossy().into_owned(),
                program_sha256: program.sha256.clone(),
                bundled: true,
                profile_id: profile.to_string(),
                scope: Scope::C1,
                workspace: workspace.map(str::to_string),
                // A C1 filter reads no workspace; the consent dialog shows no workspace line.
            },
            approver,
        )?;
        Ok(())
    }

    /// Test seam: grants `profile` to `copy` in `workspace` without a dialog (an always-approve
    /// approver), returning the grant id.
    #[cfg(test)]
    pub fn grant_for_test(&self, copy: &HostCopy, workspace: Option<&str>, profile: &str) -> u64 {
        struct Yes;
        impl Approver for Yes {
            fn approve(&self, _: &ide_workspace::grants::ConsentRequest) -> bool {
                true
            }
        }
        self.request_consent(copy, workspace, profile, None, &Yes)
            .unwrap();
        self.grants.grants().unwrap().last().unwrap().grant_id
    }
}

/// Maps a broker error to the host's structured denial. Every code is a static string.
fn denial_of(error: C1Error) -> Denial {
    let code: &'static str = match error.code {
        C1Code::PermissionDenied => "PermissionDenied",
        C1Code::UnknownProfile => "UnknownProfile",
        C1Code::BadRequest => "InvalidRequest",
        C1Code::InputTooLarge => "InputTooLarge",
        C1Code::UnsupportedPlatform => "UnsupportedApi",
        C1Code::SandboxUnavailable => "SandboxUnavailable",
        C1Code::ExecutableNotFound => "ExecutableNotFound",
        C1Code::ExecutableChanged => "ExecutableChanged",
        C1Code::OutputTooLarge => "OutputTooLarge",
        C1Code::Timeout => "Timeout",
        C1Code::TooManyProcesses => "TooManyProcesses",
        C1Code::Cancelled => "Cancelled",
    };
    Denial::new(code, error.message)
}

/// A validated `process.runFilter` request. `need_of_request` already checked the shape; this
/// parses it into typed slot values, refusing anything malformed.
struct ProcessRequest {
    profile: String,
    slots: Vec<SlotValue>,
    input: String,
}

impl ProcessRequest {
    fn parse(params: &Value) -> Result<ProcessRequest, Denial> {
        let bad = |m: &str| Denial::new("InvalidRequest", m.to_string());
        let profile = params
            .get("profile")
            .and_then(Value::as_str)
            .ok_or_else(|| bad("\"profile\" must be a string"))?
            .to_string();
        let input = params
            .get("input")
            .and_then(Value::as_str)
            .ok_or_else(|| bad("\"input\" must be a string"))?
            .to_string();
        let slots_json = params
            .get("slots")
            .and_then(Value::as_array)
            .ok_or_else(|| bad("\"slots\" must be an array"))?;
        let mut slots = Vec::with_capacity(slots_json.len());
        for slot in slots_json {
            // Each slot value is tagged so it cannot be mistaken for another kind; the broker's
            // profile template still decides which kind each position must be.
            let value = if slot.is_null() {
                SlotValue::Fixed
            } else if let Some(s) = slot.get("enum").and_then(Value::as_str) {
                SlotValue::Enum(s.to_string())
            } else if let Some(n) = slot.get("int").and_then(Value::as_i64) {
                SlotValue::Int(n)
            } else if let Some(s) = slot.get("fileName").and_then(Value::as_str) {
                SlotValue::FileName(s.to_string())
            } else {
                return Err(bad("each slot must be null or { enum | int | fileName }"));
            };
            slots.push(value);
        }
        Ok(ProcessRequest {
            profile,
            slots,
            input,
        })
    }
}

/// The workspace Yavin has open now (a C1 grant is bound to it where the profile says).
fn open_workspace(app: &AppHandle) -> Option<String> {
    let state = app.state::<crate::Workspace>();
    let open = state.0.lock().ok()?;
    open.as_ref()
        .map(|manager| manager.root().display().to_string())
}

/// EXT-33 E4: the window asks the user to allow an extension to run a filter. The window only
/// triggers this; the decision is the native dialog's, and identity is the loaded copy's -- so an
/// extension cannot approve itself and the renderer cannot forge approval.
#[tauri::command]
pub async fn process_request_consent(
    app: AppHandle,
    capability: State<'_, ProcessCapability>,
    service: State<'_, ExtensionService>,
    id: String,
    profile: String,
) -> Result<(), String> {
    let copy = service.host_copy(&id)?;
    let workspace = open_workspace(&app);
    capability.request_consent(&copy, workspace.as_deref(), &profile, None, &DialogApprover)
}

/// EXT-33 E4: the window revokes a grant. Running processes under it end before this returns.
#[tauri::command]
pub async fn process_revoke(
    capability: State<'_, ProcessCapability>,
    grant_id: u64,
) -> Result<(), String> {
    capability.grants().revoke(grant_id)
}

/// EXT-33 E4: the grants in force, for a management view.
#[tauri::command]
pub async fn process_grants(
    capability: State<'_, ProcessCapability>,
) -> Result<Vec<Grant>, String> {
    capability.grants().grants()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_workspace::broker::{C1Profile, ProgramId};
    use std::sync::atomic::{AtomicU64, Ordering};

    fn grants_file() -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "yavin-e4-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("grants.json")
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

    /// A profile whose program is a path that does not exist: the broker reaches identity
    /// verification and fails `ExecutableNotFound` -- without starting any process.
    fn profile_with_missing_program() -> Vec<C1Profile> {
        vec![C1Profile {
            id: "probe",
            program: ProgramId {
                path: PathBuf::from("C:/does/not/exist/filter.exe"),
                sha256: "00".repeat(32),
            },
            argv: vec![],
        }]
    }

    fn run(cap: &ProcessCapability, copy: &HostCopy) -> Result<Value, Denial> {
        cap.run_filter(
            copy,
            None,
            &json!({ "profile": "probe", "slots": [], "input": "hi" }),
        )
    }

    #[test]
    fn an_unknown_profile_is_refused() {
        // Production ships no profiles: every run is UnknownProfile.
        let cap = ProcessCapability::new(grants_file());
        let e = run(&cap, &copy("acme.fmt")).unwrap_err();
        assert_eq!(e.code, "UnknownProfile");
    }

    #[test]
    fn without_a_grant_the_broker_is_never_reached() {
        let cap = ProcessCapability::with_profiles(grants_file(), profile_with_missing_program());
        // No grant: PermissionDenied, decided before the program is even looked at.
        let e = run(&cap, &copy("acme.fmt")).unwrap_err();
        assert_eq!(e.code, "PermissionDenied");
    }

    #[test]
    fn a_grant_lets_it_reach_the_broker_which_verifies_the_program() {
        let cap = ProcessCapability::with_profiles(grants_file(), profile_with_missing_program());
        let c = copy("acme.fmt");
        cap.grant_for_test(&c, None, "probe");
        // Authorised: it reaches the broker, which refuses the missing program (no process starts).
        let e = run(&cap, &c).unwrap_err();
        assert_eq!(e.code, "ExecutableNotFound", "{e:?}");
    }

    #[test]
    fn identity_comes_from_the_copy_not_the_request() {
        let cap = ProcessCapability::with_profiles(grants_file(), profile_with_missing_program());
        // Grant is for acme.fmt only.
        cap.grant_for_test(&copy("acme.fmt"), None, "probe");
        // The authorised extension reaches the broker (ExecutableNotFound).
        assert_eq!(
            run(&cap, &copy("acme.fmt")).unwrap_err().code,
            "ExecutableNotFound"
        );
        // A different extension -- even with identical request params -- is denied: identity is the
        // loaded copy's, so no request can borrow another extension's grant.
        assert_eq!(
            run(&cap, &copy("evil.ext")).unwrap_err().code,
            "PermissionDenied"
        );
    }

    #[test]
    fn an_updated_copy_loses_the_grant() {
        let cap = ProcessCapability::with_profiles(grants_file(), profile_with_missing_program());
        cap.grant_for_test(&copy("acme.fmt"), None, "probe");
        let mut updated = copy("acme.fmt");
        updated.version = "2.0.0".into(); // a new copy id
        assert_eq!(run(&cap, &updated).unwrap_err().code, "PermissionDenied");
    }

    #[test]
    fn malformed_slots_are_refused() {
        let cap = ProcessCapability::with_profiles(grants_file(), profile_with_missing_program());
        let c = copy("acme.fmt");
        cap.grant_for_test(&c, None, "probe");
        for bad in [
            json!({ "profile": "probe", "slots": "notarray", "input": "x" }),
            json!({ "profile": "probe", "slots": [ { "wrong": 1 } ], "input": "x" }),
            json!({ "profile": "probe", "slots": [], "input": 5 }),
            json!({ "profile": 1, "slots": [], "input": "x" }),
        ] {
            let e = cap.run_filter(&c, None, &bad).unwrap_err();
            assert_eq!(e.code, "InvalidRequest", "{bad}");
        }
    }

    #[test]
    fn a_workspace_bound_grant_does_not_apply_elsewhere() {
        let cap = ProcessCapability::with_profiles(grants_file(), profile_with_missing_program());
        let c = copy("acme.fmt");
        cap.grant_for_test(&c, Some("C:/work/a"), "probe");
        // In the granted workspace: reaches the broker.
        assert_eq!(
            cap.run_filter(
                &c,
                Some("C:/work/a"),
                &json!({ "profile": "probe", "slots": [], "input": "x" })
            )
            .unwrap_err()
            .code,
            "ExecutableNotFound"
        );
        // In another workspace: denied.
        assert_eq!(
            cap.run_filter(
                &c,
                Some("C:/work/b"),
                &json!({ "profile": "probe", "slots": [], "input": "x" })
            )
            .unwrap_err()
            .code,
            "PermissionDenied"
        );
    }
}
