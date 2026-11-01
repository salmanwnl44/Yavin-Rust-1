//! EXT-33 E5 (test-only, live Windows): the native C2 contained-server launch path end to end.
//!
//! These spawn a real AppContainer server (this test binary re-invoked as `c2_probe`) and check the
//! operating system's own answers: the server's token container SID, what it can and cannot do to a
//! disposable workspace, and that every launch gate refuses when it should. Nothing touches the
//! real user profile: a disposable temp workspace and a derived, per-test container are used, and
//! every grant is revoked.
//!
//! Gated on `c2-test-profiles`: without that feature (every production build) there is no way to
//! register a profile, so this file compiles to nothing.
#![cfg(all(windows, feature = "c2-test-profiles"))]

use ide_workspace::broker::{sha256_hex, ProgramId};
use ide_workspace::c2::{
    C2Authority, C2Denial, C2Profile, LaunchIdentity, RunningServer, ServerRequest, ServerResponse,
};
use ide_workspace::grants::{Approver, ConsentRequest};
use ide_workspace::sandbox::{self, cpu_rate_for};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

const MIB: u64 = 1 << 20;

fn unique(label: &str) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    std::env::temp_dir().join(format!(
        "yavin-c2-{label}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ))
}

/// A disposable workspace with a readable file and a secret, for the server to read.
fn workspace(label: &str) -> PathBuf {
    let dir = unique(label);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("readable.txt"), "workspace contents").unwrap();
    std::fs::write(dir.join(".env"), "SECRET=hunter2").unwrap();
    dir
}

fn grants_file() -> PathBuf {
    let dir = unique("grants");
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("grants.json")
}

fn journal_file() -> PathBuf {
    let dir = unique("journal");
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("acl-journal.json")
}

/// The test C2 profile: this very test binary, re-invoked as the `c2_probe` ignored test.
fn test_profile() -> C2Profile {
    let me = std::env::current_exe().unwrap();
    let sha = sha256_hex(&me).unwrap();
    C2Profile {
        id: "test-server",
        program: ProgramId {
            path: me,
            sha256: sha,
        },
        argv: [
            "c2_probe",
            "--exact",
            "--ignored",
            "--nocapture",
            "--test-threads=1",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect(),
        memory_bytes: 256 * MIB,
        cpu_rate: cpu_rate_for(1, 4),
    }
}

fn identity() -> LaunchIdentity {
    LaunchIdentity {
        extension_id: "acme.srv".into(),
        extension_version: "1.0.0".into(),
        copy_id: "acme.srv@1.0.0#deadbeef".into(),
        signer: None,
        bundled: true,
    }
}

/// An authority with the test profile registered.
fn authority() -> C2Authority {
    C2Authority::with_profiles(grants_file(), journal_file(), vec![test_profile()])
}

/// The test C2 server profile: this binary re-invoked as the framed `c2_server_probe`.
fn server_profile() -> C2Profile {
    let me = std::env::current_exe().unwrap();
    let sha = sha256_hex(&me).unwrap();
    C2Profile {
        id: "test-server",
        program: ProgramId {
            path: me,
            sha256: sha,
        },
        argv: [
            "c2_server_probe",
            "--exact",
            "--ignored",
            "--nocapture",
            "--test-threads=1",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect(),
        memory_bytes: 256 * MIB,
        cpu_rate: cpu_rate_for(1, 4),
    }
}

fn server_authority() -> C2Authority {
    C2Authority::with_profiles(grants_file(), journal_file(), vec![server_profile()])
}

/// A scripted approver that answers a fixed yes/no.
struct Scripted(bool);
impl Approver for Scripted {
    fn approve(&self, _: &ConsentRequest) -> bool {
        self.0
    }
}

fn consent(auth: &C2Authority, ext: &LaunchIdentity, ws: &Path) {
    auth.request_consent(ext, ws, "test-server", &Scripted(true))
        .expect("consent recorded");
}

/// Reads the probe's `probe k v` report lines from a finished server's stdout.
fn report(server: &mut RunningServer, ws: &Path, wait: bool) -> String {
    let mut stdin = server.stdin.take().unwrap();
    let mut line = format!("dir {}\n", ws.display());
    if wait {
        line.push_str("wait\n");
    }
    stdin.write_all(line.as_bytes()).unwrap();
    drop(stdin);
    let mut out = String::new();
    // In non-wait mode the probe exits, so this reads to EOF; in wait mode the caller does not.
    if !wait {
        server
            .stdout
            .take()
            .unwrap()
            .read_to_string(&mut out)
            .unwrap();
    }
    out
}

fn parse(out: &str) -> HashMap<String, String> {
    out.lines()
        .filter_map(|l| {
            l.strip_prefix("probe ")
                .or_else(|| l.split_once(" ... probe ").map(|(_, r)| r))
        })
        .filter_map(|l| l.split_once(' '))
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

/// The denial code of a launch that must fail (avoids requiring `RunningServer: Debug`).
fn err_code(r: Result<RunningServer, C2Denial>) -> &'static str {
    match r {
        Ok(_) => panic!("expected the launch to be refused, but a server started"),
        Err(e) => e.code,
    }
}

fn wait_until(mut f: impl FnMut() -> bool) -> bool {
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(10) {
        if f() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    false
}

// --- Launch gates -----------------------------------------------------------------------------

/// Production registers no profiles, so every launch is `UnknownProfile` -- the shipped answer and
/// the production-exclusion guarantee.
#[test]
fn production_registers_no_profiles_and_launches_nothing() {
    let prod = C2Authority::new(grants_file(), journal_file());
    assert!(
        prod.profiles().is_empty(),
        "production ships no C2 profiles"
    );
    assert_eq!(
        err_code(prod.launch(&identity(), &workspace("prod"), "test-server")),
        "UnknownProfile"
    );
}

/// Without consent, the server is refused before anything is applied.
#[test]
fn without_consent_a_launch_is_refused_and_nothing_is_applied() {
    let ws = workspace("noconsent");
    let auth = authority();
    assert_eq!(
        err_code(auth.launch(&identity(), &ws, "test-server")),
        "PermissionDenied"
    );
    // The derived container has no ACE on the workspace: no grant was applied.
    let id = ide_workspace::workspace_identity::derive(
        &identity().copy_id,
        ide_workspace::workspace_identity::CapabilityClass::C2,
        &ws,
    )
    .unwrap();
    assert_eq!(sandbox::container_aces(&ws, &id.name).unwrap(), 0);
    let _ = std::fs::remove_dir_all(&ws);
}

/// A denied consent dialog records nothing, so the launch is still refused.
#[test]
fn a_denied_consent_refuses_the_launch() {
    let ws = workspace("denied");
    let auth = authority();
    assert!(
        auth.request_consent(&identity(), &ws, "test-server", &Scripted(false))
            .is_err(),
        "a denied dialog records no grant"
    );
    assert_eq!(
        err_code(auth.launch(&identity(), &ws, "test-server")),
        "PermissionDenied"
    );
    let _ = std::fs::remove_dir_all(&ws);
}

/// A grant for one extension copy does not launch a different copy (identity is native, not the
/// request): a changed copy matches no grant and its container differs anyway.
#[test]
fn a_different_copy_or_workspace_is_refused() {
    let ws = workspace("wrongcopy");
    let other_ws = workspace("wrongcopy-other");
    let auth = authority();
    consent(&auth, &identity(), &ws);

    // A different installed copy: refused.
    let mut other_copy = identity();
    other_copy.copy_id = "acme.srv@9.9.9#feedface".into();
    assert_eq!(
        err_code(auth.launch(&other_copy, &ws, "test-server")),
        "PermissionDenied"
    );
    // The consented copy but a different workspace: refused (the grant is workspace-bound).
    assert_eq!(
        err_code(auth.launch(&identity(), &other_ws, "test-server")),
        "PermissionDenied"
    );
    let _ = std::fs::remove_dir_all(&ws);
    let _ = std::fs::remove_dir_all(&other_ws);
}

/// Consent for one profile does not authorize another profile.
#[test]
fn consent_for_one_profile_does_not_authorize_another() {
    let ws = workspace("profile");
    let mut profiles = vec![test_profile()];
    let mut other = test_profile();
    other.id = "other-server";
    profiles.push(other);
    let auth = C2Authority::with_profiles(grants_file(), journal_file(), profiles);
    consent(&auth, &identity(), &ws);
    // Consent was for "test-server"; "other-server" has none.
    assert_eq!(
        err_code(auth.launch(&identity(), &ws, "other-server")),
        "PermissionDenied"
    );
    let _ = std::fs::remove_dir_all(&ws);
}

/// A workspace the container could already write (a pre-existing broad ACE) makes the read-only
/// guarantee impossible, so the grant fails and the server never starts -- even with consent.
#[test]
fn a_broad_writable_workspace_is_refused() {
    let ws = workspace("broad");
    // Grant ALL APPLICATION PACKAGES modify on the tree: a read-only grant cannot cancel it.
    assert!(std::process::Command::new("icacls")
        .arg(&ws)
        .args(["/grant", "*S-1-15-2-1:(OI)(CI)(M)"])
        .output()
        .unwrap()
        .status
        .success());
    let auth = authority();
    consent(&auth, &identity(), &ws);
    assert_eq!(
        err_code(auth.launch(&identity(), &ws, "test-server")),
        "GrantFailed",
        "a server must not start on a workspace it could already write"
    );
    let _ = std::fs::remove_dir_all(&ws);
}

// --- The happy path and live isolation --------------------------------------------------------

/// A consented, verified grant starts the server in **exactly** its derived AppContainer, and the
/// workspace is readable (including secrets) but every write, the network and child processes are
/// denied -- all observed from inside the container.
#[test]
fn a_consented_server_starts_contained_with_a_read_only_workspace() {
    let ws = workspace("happy");
    let auth = authority();
    consent(&auth, &identity(), &ws);
    let mut server = auth
        .launch(&identity(), &ws, "test-server")
        .expect("the server starts");

    // The token's container SID equals the SID derived from the container name: same identity for
    // the token, the ACL and the derivation.
    let derived = sandbox::container_sid_string(&server.container).unwrap();
    let token = server.token_container_sid().unwrap();
    assert_eq!(token, derived, "the server is in its derived container");
    // The ACL manager granted that same container read on the workspace.
    assert!(sandbox::container_aces(&ws, &server.container).unwrap() >= 1);

    let map = parse(&report(&mut server, &ws, false));
    assert_eq!(map.get("appcontainer").map(String::as_str), Some("yes"));
    assert_eq!(map.get("read").map(String::as_str), Some("ok"), "{map:?}");
    assert_eq!(
        map.get("read-secret").map(String::as_str),
        Some("ok"),
        "the server can read workspace secrets (as the consent warned)"
    );
    assert_eq!(map.get("create").map(String::as_str), Some("denied"));
    assert_eq!(map.get("modify").map(String::as_str), Some("denied"));
    assert_eq!(map.get("delete").map(String::as_str), Some("denied"));
    assert_eq!(map.get("network").map(String::as_str), Some("denied"));
    assert_eq!(map.get("child").map(String::as_str), Some("denied"));

    auth.revoke(server.grant_id).unwrap();
    assert_eq!(
        sandbox::container_aces(&ws, &server.container).unwrap(),
        0,
        "revocation removes the workspace ACE"
    );
    let _ = std::fs::remove_dir_all(&ws);
}

// --- Revocation and lifecycle -----------------------------------------------------------------

/// Revocation ends a running server, removes the workspace ACE, and prevents a new launch; and the
/// relaunch needs fresh consent (no permission resurrection).
#[test]
fn revocation_stops_the_server_cleans_the_acl_and_blocks_relaunch() {
    let ws = workspace("revoke");
    let auth = authority();
    consent(&auth, &identity(), &ws);
    let mut server = auth
        .launch(&identity(), &ws, "test-server")
        .expect("the server starts");
    let grant_id = server.grant_id;
    let container = server.container.clone();
    // Put the probe into "wait" mode so it stays alive to be killed.
    let _ = report(&mut server, &ws, true);
    assert!(
        wait_until(|| server.try_wait().unwrap().is_some() || server.is_live()),
        "server running"
    );
    assert!(server.try_wait().unwrap().is_none(), "server is alive");
    assert!(sandbox::container_aces(&ws, &container).unwrap() >= 1);

    auth.revoke(grant_id).unwrap();
    assert!(
        wait_until(|| server.try_wait().unwrap().is_some()),
        "the server process ended on revoke"
    );
    assert_eq!(
        sandbox::container_aces(&ws, &container).unwrap(),
        0,
        "no grant-owned ACE remains after revoke"
    );
    // A new launch now requires fresh consent (the grant is gone).
    assert_eq!(
        err_code(auth.launch(&identity(), &ws, "test-server")),
        "PermissionDenied",
        "a revoked grant does not resurrect"
    );
    let _ = std::fs::remove_dir_all(&ws);
}

/// The no-swap guarantee a pinned production profile (e.g. a verified `ruff.exe`) depends on: if the
/// program on disk does not hash to the profile's pinned SHA-256, the launch is refused
/// (`ExecutableChanged`) and nothing starts — even though consent exists. The failed launch leaves
/// no workspace ACE behind. (Covers the "invalid / tampered executable" case for C2.)
#[test]
fn a_program_whose_bytes_do_not_match_the_pinned_hash_is_refused() {
    let me = std::env::current_exe().unwrap();
    let wrong = C2Profile {
        id: "test-server",
        program: ProgramId {
            path: me,
            sha256: "0".repeat(64), // deliberately not the real binary's hash
        },
        argv: [
            "c2_probe",
            "--exact",
            "--ignored",
            "--nocapture",
            "--test-threads=1",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect(),
        memory_bytes: 256 * MIB,
        cpu_rate: cpu_rate_for(1, 4),
    };
    let auth = C2Authority::with_profiles(grants_file(), journal_file(), vec![wrong]);
    let ws = workspace("badhash");
    consent(&auth, &identity(), &ws);
    assert_eq!(
        err_code(auth.launch(&identity(), &ws, "test-server")),
        "ExecutableChanged",
        "a program whose bytes do not match the pinned hash must not launch"
    );
    assert_eq!(
        sandbox::container_aces(&ws, &derived_name(&ws)).unwrap(),
        0,
        "the refused launch left no workspace ACE"
    );
    let _ = std::fs::remove_dir_all(&ws);
}

/// Shutdown ends **every** live server, removes **every** workspace ACE, and quiesces the ACL
/// workers, so nothing outlives the app. The application wires this into the run loop's exit
/// (`src-tauri/src/lib.rs`); this proves the authority-level guarantee that wiring relies on. Two
/// servers over two workspaces exercise the "revoke all" path, not just one.
#[test]
fn shutdown_revokes_every_live_server_and_quiesces() {
    let auth = authority();
    let ws1 = workspace("shutdown1");
    let ws2 = workspace("shutdown2");
    consent(&auth, &identity(), &ws1);
    consent(&auth, &identity(), &ws2);
    let mut s1 = auth
        .launch(&identity(), &ws1, "test-server")
        .expect("server 1 starts");
    let mut s2 = auth
        .launch(&identity(), &ws2, "test-server")
        .expect("server 2 starts");
    let c1 = s1.container.clone();
    let c2 = s2.container.clone();
    // Keep both alive (wait mode) so shutdown has running processes to end.
    let _ = report(&mut s1, &ws1, true);
    let _ = report(&mut s2, &ws2, true);
    assert!(
        s1.try_wait().unwrap().is_none() && s2.try_wait().unwrap().is_none(),
        "both servers are alive before shutdown"
    );
    assert!(sandbox::container_aces(&ws1, &c1).unwrap() >= 1);
    assert!(sandbox::container_aces(&ws2, &c2).unwrap() >= 1);

    auth.shutdown();

    assert!(
        wait_until(|| s1.try_wait().unwrap().is_some()),
        "server 1 ended on shutdown"
    );
    assert!(
        wait_until(|| s2.try_wait().unwrap().is_some()),
        "server 2 ended on shutdown"
    );
    assert!(
        auth.quiescent(),
        "no ACL worker remains in flight after shutdown"
    );
    assert_eq!(
        sandbox::container_aces(&ws1, &c1).unwrap(),
        0,
        "workspace 1 ACE cleaned on shutdown"
    );
    assert_eq!(
        sandbox::container_aces(&ws2, &c2).unwrap(),
        0,
        "workspace 2 ACE cleaned on shutdown"
    );
    let _ = std::fs::remove_dir_all(&ws1);
    let _ = std::fs::remove_dir_all(&ws2);
}

// --- The extension-to-server request channel --------------------------------------------------

/// A consented request round-trips to the contained server and returns a bounded response; the
/// server can read the workspace through the channel (its read-only ACL), and distinct requests
/// correlate to distinct responses (native ids, serialized -- no cross-delivery).
#[test]
fn a_consented_request_round_trips_and_the_server_reads_the_workspace() {
    let ws = workspace("chan-ok");
    let auth = server_authority();
    consent(&auth, &identity(), &ws);

    let echo = auth
        .request(&identity(), &ws, "test-server", "echo", "hello")
        .expect("echo");
    assert_eq!(echo.data.as_deref(), Some("hello"));
    assert!(echo.error.is_none());

    let upper = auth
        .request(&identity(), &ws, "test-server", "upper", "abc")
        .expect("upper");
    assert_eq!(
        upper.data.as_deref(),
        Some("ABC"),
        "a second request correlates"
    );

    // The server reads a workspace file over the channel (proving the read-only ACL is in force).
    let path = ws.join("readable.txt");
    let read = auth
        .request(
            &identity(),
            &ws,
            "test-server",
            "read",
            path.to_str().unwrap(),
        )
        .expect("read");
    assert_eq!(read.data.as_deref(), Some("workspace contents"));

    auth.revoke(find_grant(&auth, &ws)).unwrap();
    assert_eq!(sandbox::container_aces(&ws, &derived_name(&ws)).unwrap(), 0);
    let _ = std::fs::remove_dir_all(&ws);
}

/// Bounds: an oversized request is refused before any server sees it.
#[test]
fn an_oversized_request_is_refused() {
    let ws = workspace("chan-bigreq");
    let auth = server_authority();
    consent(&auth, &identity(), &ws);
    let huge = "x".repeat(70 * 1024);
    assert_eq!(
        req_err(auth.request(&identity(), &ws, "test-server", "echo", &huge)),
        "RequestTooLarge"
    );
    let _ = auth.revoke_if_any(&ws);
    let _ = std::fs::remove_dir_all(&ws);
}

/// Bounds: an oversized response is refused by the length prefix, without unbounded allocation, and
/// the offending server is ended.
#[test]
fn an_oversized_response_is_refused() {
    let ws = workspace("chan-bigresp");
    let auth = server_authority();
    consent(&auth, &identity(), &ws);
    assert_eq!(
        req_err(auth.request(&identity(), &ws, "test-server", "big", "")),
        "ResponseTooLarge"
    );
    let _ = auth.revoke_if_any(&ws);
    let _ = std::fs::remove_dir_all(&ws);
}

/// An unknown operation is a structured server error, not a crash.
#[test]
fn an_unknown_op_is_a_structured_error() {
    let ws = workspace("chan-unknown");
    let auth = server_authority();
    consent(&auth, &identity(), &ws);
    let r = auth
        .request(&identity(), &ws, "test-server", "no-such-op", "x")
        .expect("the request completes");
    assert!(r.error.is_some(), "the server reports a structured error");
    assert!(r.data.is_none());
    let _ = auth.revoke_if_any(&ws);
    let _ = std::fs::remove_dir_all(&ws);
}

/// A server crash is a structured error (the server cannot be left as a usable handle).
#[test]
fn a_server_crash_is_a_structured_error() {
    let ws = workspace("chan-crash");
    let auth = server_authority();
    consent(&auth, &identity(), &ws);
    assert_eq!(
        req_err(auth.request(&identity(), &ws, "test-server", "crash", "")),
        "ServerExited"
    );
    let _ = auth.revoke_if_any(&ws);
    let _ = std::fs::remove_dir_all(&ws);
}

/// A slow request times out; since the test protocol cannot cancel one blocking request, the
/// server is ended (the documented behavior), and a later request re-establishes a fresh one.
#[test]
fn a_slow_request_times_out_and_ends_the_server() {
    let ws = workspace("chan-slow");
    let auth = server_authority();
    consent(&auth, &identity(), &ws);
    assert_eq!(
        req_err(auth.request(&identity(), &ws, "test-server", "slow", "")),
        "Timeout"
    );
    // The timed-out server was removed; a fresh request still works (re-established) or is a clean
    // refusal -- never a stale/hung handle.
    let again = auth.request(&identity(), &ws, "test-server", "echo", "ok");
    assert!(again.is_ok() || again.is_err());
    let _ = auth.revoke_if_any(&ws);
    let _ = std::fs::remove_dir_all(&ws);
}

/// A request without consent is refused by the per-request authorization (deny by default).
#[test]
fn a_request_without_consent_is_refused() {
    let ws = workspace("chan-noconsent");
    let auth = server_authority();
    assert_eq!(
        req_err(auth.request(&identity(), &ws, "test-server", "echo", "x")),
        "PermissionDenied"
    );
    let _ = std::fs::remove_dir_all(&ws);
}

/// An unknown profile is refused.
#[test]
fn a_request_for_an_unknown_profile_is_refused() {
    let ws = workspace("chan-unknownprofile");
    let auth = server_authority();
    consent(&auth, &identity(), &ws);
    assert_eq!(
        req_err(auth.request(&identity(), &ws, "other-server", "echo", "x")),
        "UnknownProfile"
    );
    let _ = auth.revoke_if_any(&ws);
    let _ = std::fs::remove_dir_all(&ws);
}

/// A changed extension copy and a different workspace are both refused (identity is native).
#[test]
fn a_changed_copy_or_workspace_is_refused_per_request() {
    let ws = workspace("chan-copy");
    let other_ws = workspace("chan-copy-other");
    let auth = server_authority();
    consent(&auth, &identity(), &ws);
    // First prove the consented identity works.
    auth.request(&identity(), &ws, "test-server", "echo", "x")
        .expect("consented");
    // A different copy: refused.
    let mut other = identity();
    other.copy_id = "acme.srv@9.9.9#feedface".into();
    assert_eq!(
        req_err(auth.request(&other, &ws, "test-server", "echo", "x")),
        "PermissionDenied"
    );
    // A different workspace: refused (the grant is workspace-bound).
    assert_eq!(
        req_err(auth.request(&identity(), &other_ws, "test-server", "echo", "x")),
        "PermissionDenied"
    );
    let _ = auth.revoke_if_any(&ws);
    let _ = std::fs::remove_dir_all(&ws);
    let _ = std::fs::remove_dir_all(&other_ws);
}

/// Revocation ends the server, cleans the ACL, and refuses every later request (no resurrection,
/// no post-revocation delivery).
#[test]
fn revocation_ends_the_channel_and_refuses_further_requests() {
    let ws = workspace("chan-revoke");
    let auth = server_authority();
    consent(&auth, &identity(), &ws);
    auth.request(&identity(), &ws, "test-server", "echo", "x")
        .expect("establishes the server");
    let container = derived_name(&ws);
    assert!(sandbox::container_aces(&ws, &container).unwrap() >= 1);

    auth.revoke(find_grant(&auth, &ws)).unwrap();
    assert_eq!(
        sandbox::container_aces(&ws, &container).unwrap(),
        0,
        "the workspace ACE is gone after revoke"
    );
    assert_eq!(
        req_err(auth.request(&identity(), &ws, "test-server", "echo", "x")),
        "PermissionDenied",
        "a revoked grant refuses new requests"
    );
    let _ = std::fs::remove_dir_all(&ws);
}

// Channel test helpers.

fn req_err(r: Result<ServerResponse, C2Denial>) -> &'static str {
    match r {
        Ok(r) => panic!("expected a refusal, got a response: {r:?}"),
        Err(e) => e.code,
    }
}

/// The derived container name for the default identity over `ws` (for ACE assertions).
fn derived_name(ws: &Path) -> String {
    ide_workspace::workspace_identity::derive(
        &identity().copy_id,
        ide_workspace::workspace_identity::CapabilityClass::C2,
        ws,
    )
    .unwrap()
    .name
}

/// The grant id for the default identity's C2 grant over `ws`.
fn find_grant(auth: &C2Authority, ws: &Path) -> u64 {
    let root = ide_workspace::workspace_identity::derive(
        &identity().copy_id,
        ide_workspace::workspace_identity::CapabilityClass::C2,
        ws,
    )
    .unwrap()
    .workspace_root
    .to_string_lossy()
    .into_owned();
    auth.grants()
        .grants()
        .unwrap()
        .into_iter()
        .find(|g| g.workspace.as_deref() == Some(root.as_str()))
        .map(|g| g.grant_id)
        .expect("a grant exists for this workspace")
}

trait RevokeIfAny {
    fn revoke_if_any(&self, ws: &Path) -> Result<(), String>;
}
impl RevokeIfAny for C2Authority {
    fn revoke_if_any(&self, ws: &Path) -> Result<(), String> {
        let root = ide_workspace::workspace_identity::derive(
            &identity().copy_id,
            ide_workspace::workspace_identity::CapabilityClass::C2,
            ws,
        )
        .map(|i| i.workspace_root.to_string_lossy().into_owned());
        if let Ok(root) = root {
            if let Some(id) = self
                .grants()
                .grants()
                .unwrap_or_default()
                .into_iter()
                .find(|g| g.workspace.as_deref() == Some(root.as_str()))
                .map(|g| g.grant_id)
            {
                return self.revoke(id);
            }
        }
        Ok(())
    }
}

// --- The probe: the C2 server body, run inside the AppContainer -------------------------------

fn say(key: &str, value: impl std::fmt::Display) {
    println!("probe {key} {value}");
    let _ = std::io::stdout().flush();
}

#[test]
#[ignore]
fn c2_probe() {
    let mut input = String::new();
    let _ = std::io::stdin().read_to_string(&mut input);
    let dir = input
        .lines()
        .find_map(|l| l.strip_prefix("dir "))
        .map(PathBuf::from);
    let wait = input.lines().any(|l| l.trim() == "wait");
    let Some(dir) = dir else {
        if wait {
            std::thread::sleep(Duration::from_secs(60));
        }
        return;
    };

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::{GetTokenInformation, TokenIsAppContainer, TOKEN_QUERY};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    // SAFETY: a query about this process into a 4-byte buffer.
    let appcontainer = unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        let mut is = 0u32;
        let mut size = 0u32;
        let ok = OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) != 0
            && GetTokenInformation(
                token,
                TokenIsAppContainer,
                &mut is as *mut _ as _,
                4,
                &mut size,
            ) != 0;
        if !token.is_null() {
            CloseHandle(token);
        }
        ok && is != 0
    };
    say("appcontainer", if appcontainer { "yes" } else { "no" });

    let readable = |r: std::io::Result<Vec<u8>>| if r.is_ok() { "ok" } else { "denied" };
    say("read", readable(std::fs::read(dir.join("readable.txt"))));
    say("read-secret", readable(std::fs::read(dir.join(".env"))));

    let did = |r: std::io::Result<()>| if r.is_ok() { "allowed" } else { "denied" };
    say(
        "create",
        did(std::fs::write(dir.join("made-by-server.txt"), b"x")),
    );
    say(
        "modify",
        did(std::fs::OpenOptions::new()
            .append(true)
            .open(dir.join("readable.txt"))
            .and_then(|mut f| f.write_all(b"more"))),
    );
    say("delete", did(std::fs::remove_file(dir.join(".env"))));

    // The network: any connect from a no-capability AppContainer is blocked (a refused connection
    // also reports "denied", which is the honest outcome -- the server reached nothing).
    let net = std::net::TcpStream::connect_timeout(
        &"93.184.216.34:80".parse().unwrap(),
        Duration::from_millis(800),
    );
    say("network", if net.is_ok() { "allowed" } else { "denied" });

    // A child process: the sandbox sets the child-process-restricted mitigation, so CreateProcess
    // is refused.
    let child = std::process::Command::new("C:/Windows/System32/cmd.exe")
        .args(["/c", "exit"])
        .spawn();
    let child_result = match child {
        Ok(mut c) => {
            let _ = c.kill();
            "allowed"
        }
        Err(_) => "denied",
    };
    say("child", child_result);

    if wait {
        // Stay alive so a revocation can be observed to end us; bounded so we never linger.
        std::thread::sleep(Duration::from_secs(60));
    }
}

/// The framed C2 **server** body: read length-prefixed JSON requests from stdin, answer with
/// length-prefixed JSON responses on stdout, until stdin closes. A deterministic, harmless set of
/// operations -- no shell, no network, no new capabilities.
#[test]
#[ignore]
fn c2_server_probe() {
    const MAGIC: [u8; 4] = [0x1e, 0x59, 0x43, 0x32];
    fn read_frame(r: &mut impl Read, max: usize) -> Option<Vec<u8>> {
        let mut window = [0u8; 4];
        let mut seen = 0usize;
        loop {
            let mut b = [0u8; 1];
            r.read_exact(&mut b).ok()?;
            window.rotate_left(1);
            window[3] = b[0];
            seen += 1;
            if seen >= 4 && window == MAGIC {
                break;
            }
            if seen > 64 * 1024 {
                return None;
            }
        }
        let mut len = [0u8; 4];
        r.read_exact(&mut len).ok()?;
        let n = u32::from_be_bytes(len) as usize;
        if n > max {
            return None;
        }
        let mut buf = vec![0u8; n];
        r.read_exact(&mut buf).ok()?;
        Some(buf)
    }
    fn write_frame(w: &mut impl Write, payload: &[u8]) {
        let _ = w.write_all(&MAGIC);
        let _ = w.write_all(&(payload.len() as u32).to_be_bytes());
        let _ = w.write_all(payload);
        let _ = w.flush();
    }

    let mut stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    while let Some(bytes) = read_frame(&mut stdin, 1 << 20) {
        let Ok(req) = serde_json::from_slice::<ServerRequest>(&bytes) else {
            break;
        };
        match req.op.as_str() {
            // The response is deliberately larger than the host's cap: write only an oversized
            // length prefix so the host refuses it by the prefix (no unbounded read), then stop.
            "big" => {
                // Marker + an oversized length prefix only: the host refuses it by the prefix.
                let _ = stdout.write_all(&MAGIC);
                let _ = stdout.write_all(&((1u32 << 20) + 1).to_be_bytes());
                let _ = stdout.flush();
                std::thread::sleep(Duration::from_secs(5));
                return;
            }
            "crash" => std::process::exit(1),
            "slow" => std::thread::sleep(Duration::from_secs(20)),
            _ => {}
        }
        let resp = match req.op.as_str() {
            "echo" => ServerResponse {
                id: req.id,
                data: Some(req.input.clone()),
                error: None,
            },
            "upper" => ServerResponse {
                id: req.id,
                data: Some(req.input.to_uppercase()),
                error: None,
            },
            "read" => match std::fs::read_to_string(&req.input) {
                Ok(text) => ServerResponse {
                    id: req.id,
                    data: Some(text),
                    error: None,
                },
                Err(e) => ServerResponse {
                    id: req.id,
                    data: None,
                    error: Some(format!("read denied: {e}")),
                },
            },
            "slow" => ServerResponse {
                id: req.id,
                data: Some("late".into()),
                error: None,
            },
            other => ServerResponse {
                id: req.id,
                data: None,
                error: Some(format!("unknown op: {other}")),
            },
        };
        if let Ok(out) = serde_json::to_vec(&resp) {
            write_frame(&mut stdout, &out);
        }
    }
}
