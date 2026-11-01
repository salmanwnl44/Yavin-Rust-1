use super::*;
use crate::package_trust::SignatureStatus;

fn signature() -> SignatureRecord {
    SignatureRecord {
        status: SignatureStatus::RegistrySigned,
        registry: "https://open-vsx.org".into(),
        key_id: Some("k1".into()),
        namespace: "acme".into(),
        sha256: "a".repeat(64),
        store_revision: 1,
    }
}

fn facts(signature: &SignatureRecord) -> TrustFacts<'_> {
    TrustFacts {
        id: "acme.one",
        version: "1.0.0",
        folder: ".store/acme.one/1.0.0-aaaaaaaa",
        sha256: Some("a".repeat(64).leak()),
        files_sha256: Some("b".repeat(64).leak()),
        source: "openvsx https://open-vsx.org",
        signature: Some(signature),
    }
}

/// A record verifies for exactly the facts it was made for, with the key and format it names:
/// any fact changed -- or the tag, the key id, the format -- and it does not.
#[test]
fn a_record_binds_every_fact_its_key_and_its_format() {
    let key = TrustKey::from_bytes([7; 32]);
    let sig = signature();
    let record = key.seal(&facts(&sig));
    key.verify(&facts(&sig), &record).unwrap();
    let other_sig = SignatureRecord {
        status: SignatureStatus::Missing,
        ..signature()
    };
    let changed: Vec<(&str, TrustFacts)> = vec![
        (
            "id",
            TrustFacts {
                id: "acme.two",
                ..facts(&sig)
            },
        ),
        (
            "version",
            TrustFacts {
                version: "1.0.1",
                ..facts(&sig)
            },
        ),
        (
            "folder",
            TrustFacts {
                folder: ".store/acme.one/other",
                ..facts(&sig)
            },
        ),
        (
            "package",
            TrustFacts {
                sha256: Some("c".repeat(64).leak()),
                ..facts(&sig)
            },
        ),
        (
            "no package",
            TrustFacts {
                sha256: None,
                ..facts(&sig)
            },
        ),
        (
            "files",
            TrustFacts {
                files_sha256: Some("d".repeat(64).leak()),
                ..facts(&sig)
            },
        ),
        (
            "no files",
            TrustFacts {
                files_sha256: None,
                ..facts(&sig)
            },
        ),
        (
            "source",
            TrustFacts {
                source: "registry https://example.com",
                ..facts(&sig)
            },
        ),
        (
            "signature",
            TrustFacts {
                signature: Some(&other_sig),
                ..facts(&sig)
            },
        ),
        (
            "no signature",
            TrustFacts {
                signature: None,
                ..facts(&sig)
            },
        ),
    ];
    for (what, changed) in changed {
        assert_eq!(
            key.verify(&changed, &record),
            Err(TrustFailure::Mismatch),
            "{what}"
        );
    }
    let mut tag = record.clone();
    tag.mac
        .replace_range(0..1, if tag.mac.starts_with('0') { "1" } else { "0" });
    assert_eq!(key.verify(&facts(&sig), &tag), Err(TrustFailure::Mismatch));
    assert_eq!(
        key.verify(
            &facts(&sig),
            &TrustRecord {
                mac: "zz".into(),
                ..record.clone()
            }
        ),
        Err(TrustFailure::Mismatch)
    );
    assert_eq!(
        key.verify(
            &facts(&sig),
            &TrustRecord {
                schema: 2,
                ..record.clone()
            }
        ),
        Err(TrustFailure::Schema)
    );
    // Another key: refused for its id, and -- the id forged to match -- for its tag.
    let other = TrustKey::from_bytes([9; 32]);
    assert_eq!(other.verify(&facts(&sig), &record), Err(TrustFailure::Key));
    let forged = TrustRecord {
        key_id: key.id.clone(),
        ..other.seal(&facts(&sig))
    };
    assert_eq!(
        key.verify(&facts(&sig), &forged),
        Err(TrustFailure::Mismatch)
    );
    assert_ne!(key.id, other.id);
}

#[cfg(windows)]
fn scratch(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("yavin-trust-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// The key is made once, kept DPAPI-protected (no key bytes in the file), and is the same key
/// on the next start; a key file that cannot be unwrapped is kept aside and replaced -- what was
/// made under it no longer verifies.
#[cfg(windows)]
#[test]
fn the_key_is_kept_protected_reused_and_replaced_when_unreadable() {
    let dir = scratch("key");
    let store = dpapi::Dpapi;
    let (key, note) = store.key(&dir).unwrap();
    assert!(note.is_none());
    let sealed = std::fs::read(dir.join(KEY_FILE)).unwrap();
    assert!(sealed.len() > 32, "a DPAPI blob, not the key");
    let (again, _) = store.key(&dir).unwrap();
    assert_eq!(key.id, again.id, "the same key on the next start");
    let sig = signature();
    let record = key.seal(&facts(&sig));
    again.verify(&facts(&sig), &record).unwrap();
    // Damaged: kept aside, a new key; the old records fail.
    std::fs::write(dir.join(KEY_FILE), b"not a DPAPI blob").unwrap();
    let (new, note) = store.key(&dir).unwrap();
    assert!(note.unwrap().contains("kept as"));
    assert_ne!(new.id, key.id);
    assert_eq!(new.verify(&facts(&sig), &record), Err(TrustFailure::Key));
    let aside = std::fs::read_dir(&dir)
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().contains(".unreadable-"))
        .count();
    assert_eq!(aside, 1, "never deleted");
    // DPAPI's entropy is Yavin's: a blob protected for another purpose does not unwrap as one.
    assert!(dpapi::unprotect(b"\x01\x02").is_err());
    let _ = std::fs::remove_dir_all(dir);
}

/// Two Yavins making the key at once agree on one.
#[cfg(windows)]
#[test]
fn concurrent_starts_agree_on_one_key() {
    let dir = scratch("race");
    let ids: Vec<String> = std::thread::scope(|scope| {
        let workers: Vec<_> = (0..8)
            .map(|_| scope.spawn(|| dpapi::Dpapi.key(&dir).unwrap().0.id))
            .collect();
        workers.into_iter().map(|w| w.join().unwrap()).collect()
    });
    assert!(ids.windows(2).all(|w| w[0] == w[1]), "{ids:?}");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn without_a_protected_store_there_is_no_key() {
    assert!(Unavailable.key(std::path::Path::new(".")).is_err());
}
