//! EXT-33 E5 release-configuration assertion. Unlike `tests/c2.rs`, this file is **not** gated
//! behind the `c2-test-profiles` feature, so it compiles and runs in the *production* feature set —
//! exactly the configuration a shipped binary is built with. It exists to close the evidence gap
//! that a passing test-only build cannot: that in the real release configuration the C2 registry is
//! empty and every launch/request fails closed. `C2Authority::with_profiles` (the only way to add a
//! profile) does not exist in this configuration, so there is no code path that could register one.
#![cfg(windows)]

use ide_workspace::c2::{C2Authority, LaunchIdentity};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

fn unique(label: &str) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "yavin-c2prod-{label}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn production_authority() -> C2Authority {
    // The only production constructor. `with_profiles` is `#[cfg(feature = "c2-test-profiles")]`,
    // so it is not even compiled here.
    C2Authority::new(
        unique("grants").join("grants.json"),
        unique("journal").join("acl-journal.json"),
    )
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

/// The shipped configuration registers no C2 profiles at all.
#[test]
fn the_release_configuration_registers_no_c2_profiles() {
    let prod = production_authority();
    assert!(
        prod.profiles().is_empty(),
        "a production C2Authority must register no profiles; found {}",
        prod.profiles().len()
    );
}

/// With no profile registered, a launch cannot name one — it fails closed with `UnknownProfile`,
/// never a running server. The profile name below is a plausible future candidate; it must not
/// resolve.
#[test]
fn a_launch_in_the_release_configuration_fails_closed() {
    let prod = production_authority();
    let ws = unique("ws");
    for candidate in ["ruff", "lua-language-server", "test-server"] {
        // `RunningServer` is deliberately not `Debug`, so match rather than `expect_err`.
        match prod.launch(&identity(), &ws, candidate) {
            Ok(_) => panic!("launch of {candidate:?} must not produce a running server"),
            Err(denial) => assert_eq!(
                denial.code, "UnknownProfile",
                "launch of {candidate:?} must fail closed as UnknownProfile, got {denial:?}"
            ),
        }
    }
}

/// The request (activation) channel is equally inert in the release configuration: with no profile,
/// a request is re-authorized against native state, finds no profile, and is refused before any
/// server, pipe or handle exists.
#[test]
fn a_request_in_the_release_configuration_fails_closed() {
    let prod = production_authority();
    let ws = unique("ws");
    let denial = prod
        .request(&identity(), &ws, "ruff", "check", "{}")
        .expect_err("no profile is registered, so no request can reach a server");
    assert_eq!(
        denial.code, "UnknownProfile",
        "a request must fail closed as UnknownProfile, got {denial:?}"
    );
}
