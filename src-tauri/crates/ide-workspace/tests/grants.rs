//! EXT-33 E2: the grant authority's enforcement, end to end through the real broker and the
//! Windows sandbox. The test binary is itself the brokered program; a grant lets it run, and a
//! revocation ends it while it runs. Nothing is mocked: the process really starts in the sandbox
//! and is really killed by the revocation.
#![cfg(windows)]

use ide_workspace::broker::{self, C1Broker, C1Code, C1Profile, ProgramId, Slot, SlotValue};
use ide_workspace::grants::{
    Approver, ConsentRequest, GrantAuthority, GrantRequest, LaunchKey, Scope,
};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

struct Yes;
impl Approver for Yes {
    fn approve(&self, _: &ConsentRequest) -> bool {
        true
    }
}

fn grants_file() -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "yavin-grants-live-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("grants.json")
}

fn program() -> (PathBuf, String) {
    let me = std::env::current_exe().unwrap();
    let sha = broker::sha256_hex(&me).unwrap();
    (me, sha)
}

fn broker() -> C1Broker {
    let (path, sha256) = program();
    C1Broker::new(vec![C1Profile {
        id: "probe",
        program: ProgramId { path, sha256 },
        argv: vec![
            Slot::Literal("grants_probe"),
            Slot::Literal("--exact"),
            Slot::Literal("--ignored"),
            Slot::Literal("--nocapture"),
            Slot::Literal("--test-threads=1"),
        ],
    }])
}

fn request() -> GrantRequest {
    let (path, sha256) = program();
    GrantRequest {
        extension_id: "acme.fmt".into(),
        extension_version: "1.0.0".into(),
        signer: None,
        copy_id: "copy-1".into(),
        program_path: path.to_string_lossy().into_owned(),
        program_sha256: sha256,
        bundled: true,
        profile_id: "probe".into(),
        scope: Scope::C1,
        workspace: None,
    }
}

fn launch_key() -> LaunchKey {
    let (path, sha256) = program();
    // The canonical path, as the broker verifies it (sha256_hex uses the plain path; the broker
    // canonicalises, so match that for the grant key).
    let canonical = std::fs::canonicalize(&path).unwrap();
    let canonical = canonical
        .to_string_lossy()
        .strip_prefix(r"\\?\")
        .map(str::to_string)
        .unwrap_or_else(|| canonical.to_string_lossy().into_owned());
    LaunchKey {
        extension_id: "acme.fmt".into(),
        copy_id: "copy-1".into(),
        program_path: canonical,
        program_sha256: sha256,
        profile_id: "probe".into(),
        scope: Scope::C1,
        workspace: None,
    }
}

fn fixed() -> Vec<SlotValue> {
    (0..5).map(|_| SlotValue::Fixed).collect()
}

/// The grant key's program path must be the canonical path (the authority stores what the caller
/// gives; the broker verifies the canonical file). We align them here so a granted key authorises.
fn grant_with_canonical_path(a: &GrantAuthority) {
    let mut r = request();
    r.program_path = launch_key().program_path;
    a.request(r, &Yes).unwrap();
}

/// A granted filter runs end to end: authority → broker → sandbox → stdout.
#[test]
fn a_granted_filter_runs() {
    let a = GrantAuthority::new(grants_file());
    grant_with_canonical_path(&a);
    let out = a
        .run_c1(
            &broker(),
            &launch_key(),
            &fixed(),
            b"mode echo\nMARK-xyz\n",
            Arc::new(AtomicBool::new(false)),
        )
        .expect("a granted filter runs");
    assert!(String::from_utf8_lossy(&out.stdout).contains("echo MARK-xyz"));
}

/// Without a grant the launch never reaches the broker.
#[test]
fn an_ungranted_filter_is_denied() {
    let a = GrantAuthority::new(grants_file());
    let e = a
        .run_c1(
            &broker(),
            &launch_key(),
            &fixed(),
            b"mode echo\n",
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap_err();
    assert_eq!(e.code, C1Code::PermissionDenied);
}

/// Revocation ends a running filter before `revoke` returns, and the run fails `PermissionDenied`.
#[test]
fn revocation_ends_a_running_filter() {
    let a = Arc::new(GrantAuthority::new(grants_file()));
    grant_with_canonical_path(&a);
    let grant_id = a.grants().unwrap()[0].grant_id;

    let broker = Arc::new(broker());
    let run_a = a.clone();
    let run_broker = broker.clone();
    let handle = std::thread::spawn(move || {
        run_a.run_c1(
            &run_broker,
            &launch_key(),
            &fixed(),
            b"mode block\n",
            Arc::new(AtomicBool::new(false)),
        )
    });

    // Let the process actually start and register, then revoke it.
    std::thread::sleep(Duration::from_millis(800));
    let before = Instant::now();
    a.revoke(grant_id).expect("revoke succeeds");
    // `revoke` must have ended the process before returning; the run then finishes promptly.
    let result = loop {
        if handle.is_finished() {
            break handle.join().unwrap();
        }
        assert!(
            before.elapsed() < Duration::from_secs(10),
            "the run did not end after revoke"
        );
        std::thread::sleep(Duration::from_millis(20));
    };
    let e = result.expect_err("a revoked run fails");
    assert_eq!(e.code, C1Code::PermissionDenied, "{e:?}");

    // And the grant is gone: a new launch is denied.
    assert_eq!(
        a.run_c1(
            &broker,
            &launch_key(),
            &fixed(),
            b"mode echo\n",
            Arc::new(AtomicBool::new(false))
        )
        .unwrap_err()
        .code,
        C1Code::PermissionDenied
    );
}

/// EXT-33 E4: one extension may run at most `MAX_PER_EXTENSION` filters at once. Two block; the
/// third is refused `TooManyProcesses`; after they end, the cap is free again.
#[test]
fn an_extension_cannot_exceed_its_per_extension_cap() {
    use ide_workspace::grants::MAX_PER_EXTENSION;
    assert_eq!(MAX_PER_EXTENSION, 2);
    let a = Arc::new(GrantAuthority::new(grants_file()));
    grant_with_canonical_path(&a);
    // A deadline bounds the blocking filters so the threads finish on their own.
    let broker = Arc::new(broker().with_deadline(Duration::from_secs(3)));

    let mut threads = Vec::new();
    for _ in 0..MAX_PER_EXTENSION {
        let (ra, rb) = (a.clone(), broker.clone());
        threads.push(std::thread::spawn(move || {
            ra.run_c1(
                &rb,
                &launch_key(),
                &fixed(),
                b"mode block\n",
                Arc::new(AtomicBool::new(false)),
            )
        }));
    }
    // Let both register their per-extension slots.
    std::thread::sleep(Duration::from_millis(800));
    // A third launch for the same extension is refused -- the cap, not the host-wide limit.
    let third = a
        .run_c1(
            &broker,
            &launch_key(),
            &fixed(),
            b"mode echo\nx\n",
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap_err();
    assert_eq!(third.code, C1Code::TooManyProcesses, "{third:?}");

    for t in threads {
        let _ = t.join();
    }
    // The slots are freed: a launch succeeds again.
    let ok = a
        .run_c1(
            &broker,
            &launch_key(),
            &fixed(),
            b"mode echo\nagain\n",
            Arc::new(AtomicBool::new(false)),
        )
        .expect("the cap is free after the blocked filters end");
    assert!(String::from_utf8_lossy(&ok.stdout).contains("echo again"));
}

// --- The probe --------------------------------------------------------------------------------

#[test]
#[ignore]
fn grants_probe() {
    use std::io::Read;
    let mut input = String::new();
    let _ = std::io::stdin().read_to_string(&mut input);
    if input.contains("mode block") {
        // Runs until the broker ends it (revocation).
        std::thread::sleep(Duration::from_secs(120));
    } else {
        for line in input.lines() {
            if !line.starts_with("mode ") {
                println!("echo {line}");
                let _ = std::io::stdout().flush();
            }
        }
    }
}
