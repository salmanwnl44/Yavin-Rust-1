//! EXT-14: the catalog, redaction, bounds, rotation, ownership and the report.

use super::*;

fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("yavin-ext14-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

#[test]
fn every_code_yavin_produces_has_a_stable_meaning() {
    // The codes the native extension system returns (EXT-02..13): each classified, none
    // falling through to the unknown failure.
    let unknown = classify("NoSuchCode");
    for code in [
        "IntegrityFailed",
        "UnsafePackage",
        "InvalidPackage",
        "ManifestMismatch",
        "InstallFailed",
        "InstallRolledBack",
        "MarketplaceUnavailable",
        "SignatureMissing",
        "SignatureInvalid",
        "UntrustedKey",
        "KeyRevoked",
        "VerificationUnavailable",
        "PermissionDenied",
        "NotOwned",
        "NotOwner",
        "TrustRequired",
        "ExtensionDisabled",
        "DependencyMissing",
        "DependencyConflict",
        "DependencyCycle",
        "WouldBreakDependents",
        "IncompatibleApi",
        "SandboxUnavailable",
        "HostCrashedRepeatedly",
        "HostCrashed",
        "HostWatchdog",
        "TooManyRequests",
        "HostFailed",
        "SecretStorageUnavailable",
        "SecretOwnerChanged",
        "ProfileNotFound",
        "InventoryRecovered",
        "SafeMode",
    ] {
        assert_ne!(classify(code), unknown, "{code} is not in the catalog");
    }
    // Refusals and failures are told apart.
    assert!(
        classify("SignatureInvalid").refusal
            && classify("SignatureInvalid").category == Category::Trust
    );
    assert!(classify("PermissionDenied").refusal);
    assert!(
        classify("SandboxUnavailable").refusal
            && classify("SandboxUnavailable").category == Category::Sandbox
    );
    assert!(
        !classify("HostCrashed").refusal && classify("HostCrashed").category == Category::Crash
    );
    assert!(!classify("InstallRolledBack").refusal);
    assert_eq!(classify("DependencyMissing").category, Category::Dependency);
    assert_eq!(classify("IncompatibleApi").category, Category::Api);
    assert_eq!(classify("HostWatchdog").category, Category::Timeout);
    assert_eq!(
        classify("SecretStorageUnavailable").category,
        Category::Storage
    );
    assert_eq!(
        code_of("SignatureInvalid: acme.x 1.0.0 …"),
        "SignatureInvalid"
    );
    assert_eq!(code_of("a message with no code"), "Unknown");
    assert_eq!(code_of("Has Space: x"), "Unknown");
}

#[test]
fn redaction_removes_paths_credentials_and_environment() {
    let cases = [
        (
            r"cannot read C:\Users\alice\project\.env now",
            "cannot read <path> now",
        ),
        (
            "cannot read C:/Users/alice/secret.txt.",
            "cannot read <path>.",
        ),
        (r"share \\server\private\file", "share <path>"),
        ("file:///home/alice/x is gone", "<path> is gone"),
        ("/home/alice/.ssh/id_rsa leaked?", "<path> leaked?"),
        (
            "token=ghp_abcdef1234567890ABCDEF1234567890",
            "token=<redacted>",
        ),
        (
            "Authorization: Bearer abc.def.ghi",
            "Authorization: Bearer <redacted>",
        ),
        ("password:hunter2", "password=<redacted>"),
        (
            "GITHUB_TOKEN=xyz OTHER=1",
            "GITHUB_TOKEN=<redacted> OTHER=<redacted>",
        ),
        (
            "key 0123456789abcdef0123456789abcdef in use",
            "key <redacted> in use",
        ),
        ("sk-ant-api03-AbCdEf123456GhIjKl789012MnOpQr", "<redacted>"),
        (
            "see https://user:pw@example.com/path?token=abc",
            "see https://example.com/…",
        ),
        (
            "acme.hello 1.2.0 needs acme.base ^1.0.0",
            "acme.hello 1.2.0 needs acme.base ^1.0.0",
        ),
    ];
    for (input, expected) in cases {
        assert_eq!(redact(input), expected, "{input}");
    }
    let long = "x ".repeat(2_000);
    assert!(redact(&long).chars().count() <= MAX_DETAIL + 1);
    assert!(!redact("bad\u{0}\u{7}control").contains('\u{0}'));
}

#[test]
fn records_are_bounded_deduplicated_and_rotated() {
    let dir = temp("bounds");
    let log = Diagnostics::in_folder(Some(dir.clone()));
    // A flood of the same thing: one record, counted.
    for _ in 0..1000 {
        log.record(
            Event::new("TooManyRequests", "request")
                .extension("acme.noisy")
                .window("main", 1),
        );
    }
    let seen = log.visible("main", None);
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].count, 1000);
    // Many different ones: at most MAX_RECORDS kept, the newest.
    for n in 0..(MAX_RECORDS + 50) {
        log.record(Event::new("HostCrashed", "host").extension(format!("acme.e{n}")));
    }
    let seen = log.visible("main", None);
    assert_eq!(seen.len(), MAX_RECORDS);
    assert_eq!(
        seen[0].extension.as_deref(),
        Some(format!("acme.e{}", MAX_RECORDS + 49).as_str())
    );
    // The files: at most two, the current one bounded (one record past the size, at most).
    for n in 0..6000 {
        log.record(
            Event::new("HostCrashed", "host")
                .extension(format!("acme.f{n}"))
                .detail("x".repeat(300)),
        );
    }
    let names: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert!(names.len() <= 2, "{names:?}");
    for name in &names {
        assert!(
            std::fs::metadata(dir.join(name)).unwrap().len() <= MAX_FILE + 4096,
            "{name}"
        );
    }
    // Read back after a restart: bounded too.
    let again = Diagnostics::in_folder(Some(dir.clone()));
    assert!(again.visible("main", None).len() <= MAX_RECORDS);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_window_sees_its_own_and_the_applications_records_only() {
    let log = Diagnostics::default();
    log.record(
        Event::new("PermissionDenied", "request")
            .extension("acme.a")
            .window("window-a", 1),
    );
    log.record(
        Event::new("PermissionDenied", "request")
            .extension("acme.b")
            .window("window-b", 2),
    );
    log.record(Event::new("SignatureInvalid", "install").extension("acme.c"));
    let a: Vec<_> = log
        .visible("window-a", None)
        .into_iter()
        .map(|r| r.extension.unwrap())
        .collect();
    assert_eq!(a, ["acme.c", "acme.a"]);
    let b: Vec<_> = log
        .visible("window-b", None)
        .into_iter()
        .map(|r| r.extension.unwrap())
        .collect();
    assert_eq!(b, ["acme.c", "acme.b"]);
    // Clearing in A clears what A sees, not B's.
    assert_eq!(log.clear("window-a", None), 2);
    assert!(log.visible("window-a", None).is_empty());
    assert_eq!(log.visible("window-b", None).len(), 1);
    // A window reports only what it can observe, classified here, marked as the window's.
    assert!(log
        .record_from_window("window-a", Event::new("PermissionDenied", "request"))
        .is_err());
    assert!(log
        .record_from_window(
            "window-a",
            Event::new("Timeout", "activation").extension("Not An Id")
        )
        .is_err());
    let noted = log
        .record_from_window(
            "window-a",
            Event::new("ActivationTimeout", "activation")
                .extension("acme.a")
                .detail(r"at C:\Users\alice\x"),
        )
        .unwrap();
    assert_eq!(noted.source, "window");
    assert_eq!(noted.window.as_deref(), Some("window-a"));
    assert_eq!(noted.detail.as_deref(), Some("at <path>"));
}

#[test]
fn the_report_is_redacted_and_holds_only_what_the_window_may_see() {
    let log = Diagnostics::default();
    log.record(Event::new("SecretStorageUnavailable", "secret").extension("acme.a").window("main", 1).detail("the credential store could not write (Windows error 1312) token=supersecretvalue123"));
    log.record(
        Event::new("HostCrashed", "host")
            .extension("acme.other")
            .window("other", 2)
            .detail("other window's"),
    );
    let report = log.report("main", None, "2.0.0");
    assert!(report.contains("SecretStorageUnavailable"));
    assert!(report.contains("Next:") || report.contains("credential store"));
    assert!(!report.contains("supersecretvalue123"));
    assert!(!report.contains("other window's"));
    assert!(report.contains("token=<redacted>"));
}

#[test]
fn a_diagnostics_file_that_cannot_be_written_changes_nothing_else() {
    // A file where its folder should be: every write fails -- recording still works in memory.
    let dir = temp("blocked");
    std::fs::write(&dir, "not a folder").unwrap();
    let log = Diagnostics::in_folder(Some(dir.clone()));
    let record = log.record(Event::new("HostCrashed", "host").extension("acme.a"));
    assert_eq!(record.code, "HostCrashed");
    assert_eq!(log.visible("main", None).len(), 1);
    assert_eq!(log.clear("main", None), 1);
    let _ = std::fs::remove_file(dir);
    // A code that is not a word is not kept as one.
    let odd = log.record(Event::new("Not a code: with C:\\path", "host"));
    assert_eq!(odd.code, "Unknown");
}
