use super::*;
use ed25519_dalek::{Signer, SigningKey};

const BASE: &str = "https://registry.example/yavin/";
const TODAY: i64 = 20_745; // 2026-10-19

fn key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn anchors_with(keys: &[(&str, u8, &str, Option<&str>)]) -> Result<RegistryAnchors, String> {
    let keys: Vec<serde_json::Value> = keys
        .iter()
        .map(|(id, seed, status, not_after)| {
            serde_json::json!({
                "keyId": id, "algorithm": "ed25519",
                "publicKey": crate::package_trust::tests::pem_of([*seed; 32]),
                "status": status, "notAfter": not_after,
                "added": "2026-10-19", "provenance": "a test key"
            })
        })
        .collect();
    RegistryAnchors::parse(
        &serde_json::json!({"schema": 1, "revision": 3, "registries": [
            {"id": "acme", "base": BASE, "keys": keys}
        ]})
        .to_string(),
    )
}

fn anchors() -> Result<RegistryAnchors, String> {
    anchors_with(&[("k1", 7, "active", None)])
}

fn index(sequence: u64, registry: &str, expires: &str) -> Vec<u8> {
    serde_json::to_vec_pretty(&serde_json::json!({
        "schema": 1, "registryId": registry, "sequence": sequence,
        "issuedAt": "2026-10-01", "expiresAt": expires,
        "name": "Acme", "categories": [], "recommended": [],
        "extensions": [{"id": "acme.one", "versions": [
            {"version": "1.0.0", "package": "packages/acme.one-1.0.0.yvx", "sha256": "a".repeat(64), "size": 10}
        ]}]
    }))
    .unwrap()
}

fn sign(seed: u8, key_id: &str, registry: &str, index: &[u8]) -> Vec<u8> {
    let signature = key(seed).sign(&[DOMAIN, index].concat()).to_bytes();
    serde_json::to_vec(&serde_json::json!({
        "schema": 1, "registryId": registry, "keyId": key_id, "algorithm": "ed25519",
        "signature": base64::engine::general_purpose::STANDARD.encode(signature)
    }))
    .unwrap()
}

fn status(
    anchors: &Result<RegistryAnchors, String>,
    index: &[u8],
    sig: Option<&[u8]>,
    seen: Option<&Seen>,
) -> IndexStatus {
    authenticate(anchors, BASE, index, sig, seen, TODAY).status
}

#[test]
fn a_signed_fresh_index_of_this_registry_verifies() {
    let index = index(5, "acme", "2027-01-01");
    let sig = sign(7, "k1", "acme", &index);
    let found = authenticate(&anchors(), BASE, &index, Some(&sig), None, TODAY);
    assert_eq!(found.status, IndexStatus::Verified);
    assert_eq!(found.registry_id.as_deref(), Some("acme"));
    assert_eq!(found.key_id.as_deref(), Some("k1"));
    assert_eq!(found.sequence, Some(5));
    assert_eq!(found.anchors_revision, 3);
}

/// The attack EXT-20 closes: the index *and* its checksums replaced together -- refused, as is
/// any change to the index or the signature, however small.
#[test]
fn a_changed_index_or_signature_does_not_verify() {
    let original = index(5, "acme", "2027-01-01");
    let sig = sign(7, "k1", "acme", &original);
    let swapped = String::from_utf8(original.clone())
        .unwrap()
        .replace(&"a".repeat(64), &"b".repeat(64));
    assert_eq!(
        status(&anchors(), swapped.as_bytes(), Some(&sig), None),
        IndexStatus::Invalid
    );
    let mut one_byte = original.clone();
    let last = one_byte.len() - 2;
    one_byte[last] ^= 1;
    assert_eq!(
        status(&anchors(), &one_byte, Some(&sig), None),
        IndexStatus::Invalid
    );
    let mut bad: serde_json::Value = serde_json::from_slice(&sig).unwrap();
    let mut bytes = base64::engine::general_purpose::STANDARD
        .decode(bad["signature"].as_str().unwrap())
        .unwrap();
    bytes[0] ^= 1;
    bad["signature"] = base64::engine::general_purpose::STANDARD
        .encode(&bytes)
        .into();
    assert_eq!(
        status(
            &anchors(),
            &original,
            Some(bad.to_string().as_bytes()),
            None
        ),
        IndexStatus::Invalid
    );
    // Without the domain prefix (a signature over the raw bytes, for another use): refused.
    let raw = key(7).sign(&original).to_bytes();
    let raw = serde_json::json!({"schema": 1, "registryId": "acme", "keyId": "k1", "algorithm": "ed25519",
        "signature": base64::engine::general_purpose::STANDARD.encode(raw)}).to_string();
    assert_eq!(
        status(&anchors(), &original, Some(raw.as_bytes()), None),
        IndexStatus::Invalid
    );
    assert_eq!(
        status(&anchors(), &original, None, None),
        IndexStatus::Missing
    );
}

#[test]
fn keys_registries_and_their_status_are_the_anchors_only() {
    let index = index(5, "acme", "2027-01-01");
    // Another key (not pinned), or a pinned key id with another key's signature.
    assert_eq!(
        status(
            &anchors(),
            &index,
            Some(&sign(9, "k9", "acme", &index)),
            None
        ),
        IndexStatus::UnknownKey
    );
    assert_eq!(
        status(
            &anchors(),
            &index,
            Some(&sign(9, "k1", "acme", &index)),
            None
        ),
        IndexStatus::Invalid
    );
    // Revoked, expired.
    let revoked = anchors_with(&[("k1", 7, "revoked", None)]);
    assert_eq!(
        status(&revoked, &index, Some(&sign(7, "k1", "acme", &index)), None),
        IndexStatus::KeyRevoked
    );
    let ended = anchors_with(&[("k1", 7, "active", Some("2026-10-18"))]);
    assert_eq!(
        status(&ended, &index, Some(&sign(7, "k1", "acme", &index)), None),
        IndexStatus::KeyExpired
    );
    // Rotation: a new key pinned beside the old; both verify what they signed; the old revoked.
    let rotated = anchors_with(&[("k1", 7, "revoked", None), ("k2", 8, "active", None)]);
    assert_eq!(
        status(&rotated, &index, Some(&sign(8, "k2", "acme", &index)), None),
        IndexStatus::Verified
    );
    assert_eq!(
        status(&rotated, &index, Some(&sign(7, "k1", "acme", &index)), None),
        IndexStatus::KeyRevoked
    );
    // Another registry: a signature or an index naming another id; a registry with no anchor.
    assert_eq!(
        status(
            &anchors(),
            &index,
            Some(&sign(7, "k1", "other", &index)),
            None
        ),
        IndexStatus::WrongRegistry
    );
    let other = index_for("other");
    assert_eq!(
        status(
            &anchors(),
            &other,
            Some(&sign(7, "k1", "acme", &other)),
            None
        ),
        IndexStatus::WrongRegistry
    );
    let elsewhere = authenticate(
        &anchors(),
        "https://registry.example/other/",
        &index,
        Some(&sign(7, "k1", "acme", &index)),
        None,
        TODAY,
    );
    assert_eq!(elsewhere.status, IndexStatus::Unanchored);
    // No anchors at all: nothing authenticates.
    assert_eq!(
        status(
            &Err("unreadable".into()),
            &index,
            Some(&sign(7, "k1", "acme", &index)),
            None
        ),
        IndexStatus::Unavailable
    );
}

fn index_for(registry: &str) -> Vec<u8> {
    index(5, registry, "2027-01-01")
}

#[test]
fn freshness_replay_and_equivocation() {
    let fresh = index(5, "acme", "2027-01-01");
    let stale = index(5, "acme", "2026-10-18");
    assert_eq!(
        status(
            &anchors(),
            &stale,
            Some(&sign(7, "k1", "acme", &stale)),
            None
        ),
        IndexStatus::Expired
    );
    let seen = Seen {
        sequence: 6,
        sha256: "x".into(),
    };
    // An older signed index (a downgrade to it): refused.
    assert_eq!(
        status(
            &anchors(),
            &fresh,
            Some(&sign(7, "k1", "acme", &fresh)),
            Some(&seen)
        ),
        IndexStatus::Replay
    );
    // The same sequence with other bytes: refused; the very same index again: fine.
    let same = Seen {
        sequence: 5,
        sha256: "x".into(),
    };
    assert_eq!(
        status(
            &anchors(),
            &fresh,
            Some(&sign(7, "k1", "acme", &fresh)),
            Some(&same)
        ),
        IndexStatus::Replay
    );
    let accepted = authenticate(
        &anchors(),
        BASE,
        &fresh,
        Some(&sign(7, "k1", "acme", &fresh)),
        None,
        TODAY,
    );
    let again = Seen {
        sequence: 5,
        sha256: accepted.sha256.clone(),
    };
    assert_eq!(
        status(
            &anchors(),
            &fresh,
            Some(&sign(7, "k1", "acme", &fresh)),
            Some(&again)
        ),
        IndexStatus::Verified
    );
    // Newer: fine.
    let newer = index(7, "acme", "2027-01-01");
    assert_eq!(
        status(
            &anchors(),
            &newer,
            Some(&sign(7, "k1", "acme", &newer)),
            Some(&seen)
        ),
        IndexStatus::Verified
    );
}

/// Signed, but not unambiguous or not well formed: refused -- a duplicate key (which two
/// parsers may read differently), missing freshness fields, another schema; a signature file
/// with a field too many, the wrong length, text instead of base64.
#[test]
fn malformed_and_ambiguous_metadata_is_refused() {
    let dup = br#"{"schema":1,"registryId":"acme","sequence":5,"issuedAt":"2026-10-01","expiresAt":"2027-01-01","extensions":[{"id":"acme.one","id":"acme.evil","versions":[]}]}"#.to_vec();
    assert!(!unambiguous(&dup));
    assert_eq!(
        status(&anchors(), &dup, Some(&sign(7, "k1", "acme", &dup)), None),
        IndexStatus::Malformed
    );
    let top_dup = br#"{"schema":1,"registryId":"acme","registryId":"acme","sequence":5,"issuedAt":"2026-10-01","expiresAt":"2027-01-01"}"#.to_vec();
    assert_eq!(
        status(
            &anchors(),
            &top_dup,
            Some(&sign(7, "k1", "acme", &top_dup)),
            None
        ),
        IndexStatus::Malformed
    );
    for bad in [
        serde_json::json!({"schema": 1, "registryId": "acme", "issuedAt": "2026-10-01", "expiresAt": "2027-01-01"}),
        serde_json::json!({"schema": 2, "registryId": "acme", "sequence": 1, "issuedAt": "2026-10-01", "expiresAt": "2027-01-01"}),
        serde_json::json!({"schema": 1, "registryId": "acme", "sequence": 1, "issuedAt": "2027-02-01", "expiresAt": "2027-01-01"}),
        serde_json::json!({"schema": 1, "registryId": "acme", "sequence": -1, "issuedAt": "2026-10-01", "expiresAt": "2027-01-01"}),
        serde_json::json!({"schema": 1, "registryId": "acme", "sequence": 1, "issuedAt": "yesterday", "expiresAt": "2027-01-01"}),
    ] {
        let bytes = serde_json::to_vec(&bad).unwrap();
        assert_eq!(
            status(
                &anchors(),
                &bytes,
                Some(&sign(7, "k1", "acme", &bytes)),
                None
            ),
            IndexStatus::Malformed,
            "{bad}"
        );
    }
    let index = index(5, "acme", "2027-01-01");
    let good: serde_json::Value = serde_json::from_slice(&sign(7, "k1", "acme", &index)).unwrap();
    let mut extra = good.clone();
    extra["note"] = "x".into();
    let mut short = good.clone();
    short["signature"] = base64::engine::general_purpose::STANDARD
        .encode([0u8; 63])
        .into();
    let mut text = good.clone();
    text["signature"] = "not base64!".into();
    let mut algorithm = good.clone();
    algorithm["algorithm"] = "rsa".into();
    for bad in [extra, short, text, algorithm] {
        assert_eq!(
            status(&anchors(), &index, Some(bad.to_string().as_bytes()), None),
            IndexStatus::Malformed,
            "{bad}"
        );
    }
    let dup_sig = format!(
        r#"{{"schema":1,"registryId":"acme","keyId":"k9","keyId":"k1","algorithm":"ed25519","signature":"{}"}}"#,
        good["signature"].as_str().unwrap()
    );
    assert_eq!(
        status(&anchors(), &index, Some(dup_sig.as_bytes()), None),
        IndexStatus::Malformed
    );
    assert_eq!(
        status(&anchors(), &index, Some(b"not json"), None),
        IndexStatus::Malformed
    );
}

#[test]
fn the_pinned_anchors_read_and_bind_the_official_registry() {
    let pinned = RegistryAnchors::parse(BUILTIN).unwrap();
    let official = pinned
        .for_base(crate::marketplace::OFFICIAL_REGISTRY)
        .expect("the official registry is pinned");
    assert_eq!(official.id, "yavin-official");
    // Same origin, another path (someone else's files on raw.githubusercontent.com): not it.
    assert!(pinned
        .for_base("https://raw.githubusercontent.com/someone/else/main/registry/")
        .is_none());
    // Malformed anchors refuse the whole file.
    for bad in [
        r#"{"schema":2,"revision":1,"registries":[]}"#,
        r#"{"schema":1,"revision":1,"registries":[{"id":"a","base":"http://x.example/","keys":[]}]}"#,
        r#"{"schema":1,"revision":1,"registries":[],"extra":1}"#,
    ] {
        assert!(RegistryAnchors::parse(bad).is_err(), "{bad}");
    }
}

#[test]
fn the_highest_accepted_index_is_kept() {
    let dir = std::env::temp_dir().join(format!("yavin-registry-seen-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let fresh = index(5, "acme", "2027-01-01");
    let accepted = authenticate(
        &anchors(),
        BASE,
        &fresh,
        Some(&sign(7, "k1", "acme", &fresh)),
        None,
        TODAY,
    );
    record_seen(&dir, &accepted).unwrap();
    assert_eq!(read_seen(&dir).unwrap()["acme"].sequence, 5);
    // An older one is never recorded over it; a refused one never at all.
    let older = IndexVerification {
        sequence: Some(4),
        ..accepted.clone()
    };
    record_seen(&dir, &older).unwrap();
    assert_eq!(read_seen(&dir).unwrap()["acme"].sequence, 5);
    let refused = IndexVerification {
        sequence: Some(9),
        status: IndexStatus::Invalid,
        ..accepted
    };
    record_seen(&dir, &refused).unwrap();
    assert_eq!(read_seen(&dir).unwrap()["acme"].sequence, 5);
    let _ = std::fs::remove_dir_all(dir);
}

// --- Through the real installer (EXT-20) ----------------------------------------------------------

use crate::extension_service::ExtensionService;
use crate::marketplace::{stage, PackageSource};
use std::sync::{Arc, Mutex};

/// What a loopback registry serves, by path: its content type and bytes.
type Files = Arc<Mutex<std::collections::BTreeMap<String, (String, Vec<u8>)>>>;

/// A registry served on loopback: what it serves at each path, changeable.
struct Served {
    files: Files,
    base: String,
}

impl Served {
    fn new() -> Served {
        let files: Files = Arc::default();
        let shared = files.clone();
        let base = crate::marketplace::tests::serve(move |path| {
            match shared
                .lock()
                .unwrap()
                .get(path.trim_start_matches("/registry/"))
            {
                Some((kind, body)) => (200, vec![("Content-Type", kind.clone())], body.clone()),
                None => (404, vec![], vec![]),
            }
        });
        Served { files, base }
    }
    fn put(&self, path: &str, kind: &str, body: Vec<u8>) {
        self.files
            .lock()
            .unwrap()
            .insert(path.into(), (kind.into(), body));
    }
    fn drop_file(&self, path: &str) {
        self.files.lock().unwrap().remove(path);
    }
    /// Publishes `packages` (id, version, bytes) in an index signed with sequence `sequence`.
    fn publish(&self, packages: &[(&str, &str, &[u8])], sequence: u64) -> (String, String) {
        let extensions: Vec<serde_json::Value> = packages
            .iter()
            .map(|(id, version, bytes)| {
                let path = format!("{id}-{version}.yvx");
                self.put(&path, "application/octet-stream", bytes.to_vec());
                serde_json::json!({"id": id, "versions": [{"version": version, "package": path,
                    "sha256": crate::marketplace::tests::sha(bytes), "size": bytes.len()}]})
            })
            .collect();
        let (index, signature) =
            fixtures::signed(serde_json::json!({"extensions": extensions}), sequence);
        self.put("index.json", "application/json", index.clone().into_bytes());
        self.put(SIGNATURE_FILE, "text/plain", signature.clone().into_bytes());
        (index, signature)
    }
}

fn package_of(dir: &Path, version: &str, code: &str) -> Vec<u8> {
    let manifest = format!(
        r#"{{"publisher":"acme","name":"hello","version":"{version}","engines":{{"yavin":"^2.0.0"}},"main":"extension.js"}}"#
    );
    let at = dir.join(format!("pkg-{version}-{}", code.len()));
    std::fs::create_dir_all(&at).unwrap();
    std::fs::read(crate::extension_package::tests::package(
        &at,
        &[
            (crate::extensions::MANIFEST_FILE, manifest.as_bytes()),
            ("extension.js", code.as_bytes()),
        ],
    ))
    .unwrap()
}

fn from(served: &Served, version: &str, bytes: &[u8]) -> PackageSource {
    PackageSource::Registry {
        registry_url: served.base.clone(),
        path: format!("acme.hello-{version}.yvx"),
        sha256: crate::marketplace::tests::sha(bytes),
        size: bytes.len() as u64,
    }
}

fn install(service: &ExtensionService, source: PackageSource, version: &str) -> Result<(), String> {
    let staged = stage(service, source, "acme.hello", version)?;
    service.commit(&staged.token, "acme.hello")?;
    service.finish(&staged.token, "acme.hello", true)
}

fn scratch(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("yavin-ext20-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A signed registry's package installs, its record says so -- the registry (its base URL),
/// the key, the package's SHA-256 -- and its trust record (EXT-19) makes it run, after a
/// restart too.
#[test]
fn a_package_from_a_signed_index_installs_and_is_recorded_as_such() {
    let dir = scratch("signed");
    let served = Served::new();
    let v1 = package_of(&dir, "1.0.0", "module.exports = 1;");
    served.publish(&[("acme.hello", "1.0.0", &v1)], 1);
    with_anchors(fixtures::anchors_for(&served.base), || {
        let service = ExtensionService::new(dir.join("extensions"), Vec::new());
        install(&service, from(&served, "1.0.0", &v1), "1.0.0").unwrap();
        let listed = service
            .list(None)
            .unwrap()
            .extensions
            .into_iter()
            .find(|e| e.id.as_deref() == Some("acme.hello"))
            .unwrap();
        let record = listed.signature.clone().unwrap();
        assert_eq!(
            record.status,
            crate::package_trust::SignatureStatus::IndexSigned
        );
        assert_eq!(record.registry, served.base);
        assert_eq!(record.key_id.as_deref(), Some("t"));
        assert_eq!(record.sha256, crate::marketplace::tests::sha(&v1));
        service.host_copy("acme.hello").unwrap();
        // EXT-22: and the listing says where it came from: this very registry.
        let from = listed.provenance.unwrap();
        assert_eq!(
            (from.kind, from.location.as_deref()),
            ("registry", Some(served.base.as_str()))
        );
        assert_eq!(from.sha256, Some(crate::marketplace::tests::sha(&v1)));
        drop(service);
        let service = ExtensionService::new(dir.join("extensions"), Vec::new());
        service.host_copy("acme.hello").expect("after a restart");
        drop(service);
        // The record names the registry's base URL, not just its origin: one rewritten to
        // the origin, or to another registry on it, does not vouch for this copy.
        let origin = served
            .base
            .trim_end_matches("registry/")
            .trim_end_matches('/');
        assert!(served.base.starts_with(origin) && served.base.len() > origin.len() + 1);
        let root = dir.join("extensions");
        let mut was = served.base.clone();
        for other in [origin.to_string(), format!("{origin}/other/")] {
            for name in [
                crate::extension_service::INVENTORY,
                crate::extension_service::LAST_GOOD,
            ] {
                let path = root.join(name);
                let text = std::fs::read_to_string(&path).unwrap();
                assert!(text.contains(&format!("\"registry\": \"{was}\"")), "{name}");
                let text = text.replace(
                    &format!("\"registry\": \"{was}\""),
                    &format!("\"registry\": \"{other}\""),
                );
                std::fs::write(&path, text).unwrap();
            }
            was = other.clone();
            let service = ExtensionService::new(root.clone(), Vec::new());
            let listed = service
                .list(None)
                .unwrap()
                .extensions
                .into_iter()
                .find(|e| e.id.as_deref() == Some("acme.hello"))
                .unwrap();
            assert!(
                listed.signature.is_none(),
                "{other}: not this registry's record"
            );
            assert!(
                service.host_copy("acme.hello").is_err(),
                "{other}: nor trusted"
            );
        }
    });
}

/// The attack: index and checksums replaced together -- and every other way an update's
/// metadata or bytes can be wrong. Each is refused; the installed version, its grant, its
/// trust record and its signature record are exactly as they were, and it still runs.
#[test]
fn a_malicious_update_is_refused_and_the_installed_version_kept() {
    let dir = scratch("update");
    let served = Served::new();
    let v1 = package_of(&dir, "1.0.0", "module.exports = 1;");
    let evil = package_of(&dir, "2.0.0", "module.exports = 'evil';");
    let good2 = package_of(&dir, "2.0.0", "module.exports = 2;");
    let (index1, sig1) = served.publish(&[("acme.hello", "1.0.0", &v1)], 5);
    with_anchors(fixtures::anchors_for(&served.base), || {
        let root = dir.join("extensions");
        let service = ExtensionService::new(root.clone(), Vec::new());
        install(&service, from(&served, "1.0.0", &v1), "1.0.0").unwrap();
        let before =
            std::fs::read_to_string(root.join(crate::extension_service::INVENTORY)).unwrap();
        let refuse = |what: &str, source: PackageSource, code: &str| {
            let error = install(&service, source, "2.0.0").unwrap_err();
            assert!(error.starts_with(code), "{what}: {error}");
            assert_eq!(
                std::fs::read_to_string(root.join(crate::extension_service::INVENTORY)).unwrap(),
                before,
                "{what}: nothing changed"
            );
            service
                .host_copy("acme.hello")
                .unwrap_or_else(|e| panic!("{what}: {e}"));
        };
        // 1. The index and its checksum replaced together; the old signature served beside it.
        served.put(
            "acme.hello-2.0.0.yvx",
            "application/octet-stream",
            evil.clone(),
        );
        let forged = index1.replace(
            r#""versions":[{"#,
            &format!(
                r#""versions":[{{"version":"2.0.0","package":"acme.hello-2.0.0.yvx","sha256":"{}","size":{}}},{{"#,
                crate::marketplace::tests::sha(&evil),
                evil.len()
            ),
        );
        assert_ne!(forged, index1);
        served.put("index.json", "application/json", forged.into_bytes());
        refuse(
            "index and checksum replaced",
            from(&served, "2.0.0", &evil),
            "SignatureInvalid",
        );
        // 2. The signature removed.
        served.drop_file(SIGNATURE_FILE);
        refuse(
            "no signature",
            from(&served, "2.0.0", &evil),
            "SignatureMissing",
        );
        // 3. Signed properly for 2.0.0 -- and then other bytes served for the package.
        served.publish(&[("acme.hello", "2.0.0", &good2)], 6);
        // The same size as the published package, other bytes.
        let swapped = package_of(&dir, "2.0.0", "module.exports = 3;");
        assert_eq!(swapped.len(), good2.len());
        served.put("acme.hello-2.0.0.yvx", "application/octet-stream", swapped);
        refuse(
            "package substituted",
            from(&served, "2.0.0", &good2),
            "IntegrityFailed",
        );
        // 4. Replay: the older signed index again (sequence 5, after 6 was accepted).
        served.put(
            "index.json",
            "application/json",
            index1.clone().into_bytes(),
        );
        served.put(SIGNATURE_FILE, "text/plain", sig1.clone().into_bytes());
        refuse(
            "replay of an older index",
            from(&served, "1.0.0", &v1),
            "RegistryReplay",
        );
    });
    // 5. Another key; another registry; a revoked key -- under anchors that say so.
    // 5. A pinned key id, but not the key that signed (another key is pinned under "t").
    let another = ed25519_dalek::SigningKey::from_bytes(&[9; 32])
        .verifying_key()
        .to_bytes();
    with_anchors(
        RegistryAnchors::single(fixtures::REGISTRY_ID, &served.base, "t", another),
        || {
            served.publish(&[("acme.hello", "2.0.0", &good2)], 7);
            let service = ExtensionService::new(dir.join("extensions"), Vec::new());
            let error = install(&service, from(&served, "2.0.0", &good2), "2.0.0").unwrap_err();
            assert!(error.starts_with("SignatureInvalid"), "{error}");
        },
    );
    with_anchors(
        RegistryAnchors::single(
            "someone-else",
            &served.base,
            "t",
            ed25519_dalek::SigningKey::from_bytes(&[5; 32])
                .verifying_key()
                .to_bytes(),
        ),
        || {
            let service = ExtensionService::new(dir.join("extensions"), Vec::new());
            let error = install(&service, from(&served, "2.0.0", &good2), "2.0.0").unwrap_err();
            assert!(error.starts_with("WrongRegistry"), "{error}");
        },
    );
}

/// A registry with no pinned key (one a user names): its index cannot be authenticated -- a
/// package with code is refused, a declarative one installed (unsigned, said so).
#[test]
fn an_unpinned_registry_installs_no_code() {
    let dir = scratch("unpinned");
    let served = Served::new();
    let code = package_of(&dir, "1.0.0", "module.exports = 1;");
    served.publish(&[("acme.hello", "1.0.0", &code)], 1);
    with_anchors(
        RegistryAnchors::parse(r#"{"schema":1,"revision":1,"registries":[]}"#),
        || {
            let service = ExtensionService::new(dir.join("extensions"), Vec::new());
            let error = install(&service, from(&served, "1.0.0", &code), "1.0.0").unwrap_err();
            assert!(error.starts_with("RegistryUnverified"), "{error}");
            // Declarative: installed, unsigned.
            let manifest = r#"{"publisher":"acme","name":"hello","version":"1.0.1","engines":{"yavin":"^2.0.0"},"contributes":{"configuration":{"properties":{"acme.hello.x":{"type":"boolean","default":true,"description":"X."}}}}}"#;
            let at = dir.join("declarative");
            std::fs::create_dir_all(&at).unwrap();
            let theme = std::fs::read(crate::extension_package::tests::package(
                &at,
                &[(crate::extensions::MANIFEST_FILE, manifest.as_bytes())],
            ))
            .unwrap();
            served.publish(&[("acme.hello", "1.0.1", &theme)], 2);
            install(&service, from(&served, "1.0.1", &theme), "1.0.1").unwrap();
            let listed = service
                .list(None)
                .unwrap()
                .extensions
                .into_iter()
                .find(|e| e.id.as_deref() == Some("acme.hello"))
                .unwrap();
            assert_eq!(
                listed.signature.unwrap().status,
                crate::package_trust::SignatureStatus::Missing
            );
        },
    );
}

/// Offline (the registry unreachable), or stopped mid-update: nothing installed, nothing
/// changed; a signed index accepted before is not trusted from memory -- it is fetched and
/// checked again.
#[test]
fn offline_and_interrupted_updates_change_nothing() {
    let dir = scratch("offline");
    let served = Served::new();
    let v1 = package_of(&dir, "1.0.0", "module.exports = 1;");
    let v2 = package_of(&dir, "2.0.0", "module.exports = 2;");
    served.publish(&[("acme.hello", "1.0.0", &v1)], 1);
    with_anchors(fixtures::anchors_for(&served.base), || {
        let root = dir.join("extensions");
        let service = ExtensionService::new(root.clone(), Vec::new());
        install(&service, from(&served, "1.0.0", &v1), "1.0.0").unwrap();
        let before =
            std::fs::read_to_string(root.join(crate::extension_service::INVENTORY)).unwrap();
        // The index gone (unreachable for it): refused.
        served.drop_file("index.json");
        assert!(install(&service, from(&served, "2.0.0", &v2), "2.0.0").is_err());
        // Stopped after staging: the next start keeps 1.0.0, verified.
        served.publish(&[("acme.hello", "2.0.0", &v2)], 2);
        *service.crash_at.lock().unwrap() = Some("staged");
        assert!(install(&service, from(&served, "2.0.0", &v2), "2.0.0").is_err());
        drop(service);
        let service = ExtensionService::new(root.clone(), Vec::new());
        service.list(None).unwrap();
        // Nothing of either attempt is installed: the copies and grants as they were after 1.0.0
        // (the interrupted one is only noted, as discarded).
        let read = |text: &str| {
            let value: serde_json::Value = serde_json::from_str(text).unwrap();
            (value["extensions"].clone(), value["grants"].clone())
        };
        assert_eq!(
            read(&std::fs::read_to_string(root.join(crate::extension_service::INVENTORY)).unwrap()),
            read(&before)
        );
        service.host_copy("acme.hello").unwrap();
    });
}

/// A local file is never recorded or shown as from a signed index -- not even with a record
/// forged to say so.
#[test]
fn a_file_is_never_index_signed() {
    let dir = scratch("file");
    let v1 = package_of(&dir, "1.0.0", "module.exports = 1;");
    let file = dir.join("hello.yvx");
    std::fs::write(&file, &v1).unwrap();
    let root = dir.join("extensions");
    let service = ExtensionService::new(root.clone(), Vec::new());
    install(
        &service,
        PackageSource::File {
            path: file.to_string_lossy().into(),
        },
        "1.0.0",
    )
    .unwrap();
    let listed = |service: &ExtensionService| {
        service
            .list(None)
            .unwrap()
            .extensions
            .into_iter()
            .find(|e| e.id.as_deref() == Some("acme.hello"))
            .unwrap()
    };
    assert_eq!(
        listed(&service).signature.unwrap().status,
        crate::package_trust::SignatureStatus::Missing
    );
    drop(service);
    for name in [
        crate::extension_service::INVENTORY,
        crate::extension_service::LAST_GOOD,
    ] {
        let path = root.join(name);
        let text = std::fs::read_to_string(&path)
            .unwrap()
            .replace("\"status\": \"missing\"", "\"status\": \"indexSigned\"");
        std::fs::write(&path, text).unwrap();
    }
    let service = ExtensionService::new(root, Vec::new());
    assert!(
        listed(&service).signature.is_none(),
        "a forged record is not shown"
    );
    assert!(
        service
            .host_copy("acme.hello")
            .unwrap_err()
            .starts_with("TrustStateInvalid"),
        "nor trusted"
    );
}

/// The registry in the repository -- what users download -- verifies under the anchors this
/// Yavin pins, as the official registry; changed by one byte, it does not.
#[test]
fn the_published_registry_verifies_under_the_pinned_key() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("registry");
    let index = std::fs::read(folder.join("index.json")).unwrap();
    let signature = std::fs::read(folder.join(SIGNATURE_FILE)).unwrap();
    let pinned = RegistryAnchors::parse(BUILTIN);
    let found = authenticate(
        &pinned,
        crate::marketplace::OFFICIAL_REGISTRY,
        &index,
        Some(&signature),
        None,
        crate::package_trust::today(),
    );
    assert_eq!(found.status, IndexStatus::Verified, "{found:?}");
    assert_eq!(found.registry_id.as_deref(), Some("yavin-official"));
    let mut changed = index.clone();
    let at = changed.len() / 2;
    changed[at] ^= 0x20;
    let refused = authenticate(
        &pinned,
        crate::marketplace::OFFICIAL_REGISTRY,
        &changed,
        Some(&signature),
        None,
        crate::package_trust::today(),
    );
    assert_ne!(refused.status, IndexStatus::Verified);
}

/// EXT-21: Yavin's record of accepted indexes, unreadable -- damaged, or rewritten -- is never
/// taken as "nothing accepted" (an older index could then be accepted, and the next write would
/// erase the record): code is not installed from a signed registry, the record is left byte for
/// byte, and only the user's reset sets it aside (kept) so verification starts again.
#[test]
fn an_unreadable_replay_record_refuses_installs_until_reset() {
    let dir = scratch("state");
    let served = Served::new();
    let v1 = package_of(&dir, "1.0.0", "module.exports = 1;");
    served.publish(&[("acme.hello", "1.0.0", &v1)], 3);
    with_anchors(fixtures::anchors_for(&served.base), || {
        let root = dir.join("extensions");
        let state = root.join(STATE_FILE);
        for damaged in [
            "{ not json",
            r#"{"acme-test": {"sequence": 9, "sha256": "x"}, "acme-test": {"sequence": 1, "sha256": "y"}}"#,
            // JSON, unambiguous, but not the record's shape.
            r#"{"acme-test": 9}"#,
        ] {
            std::fs::create_dir_all(&root).unwrap();
            std::fs::write(&state, damaged).unwrap();
            let service = ExtensionService::new(root.clone(), Vec::new());
            let refused = install(&service, from(&served, "1.0.0", &v1), "1.0.0").unwrap_err();
            assert!(refused.starts_with("RegistryStateInvalid"), "{refused}");
            assert_eq!(
                std::fs::read_to_string(&state).unwrap(),
                damaged,
                "left as it is"
            );
            assert!(read_seen(&root).is_err());
            // Said as such: the index verifies, but is not taken as verified.
            let registry = crate::marketplace::registry(&served.base).unwrap();
            let (_, shown) =
                crate::marketplace::authenticated_index(&registry, Some(&root)).unwrap();
            assert_eq!(shown.status, IndexStatus::StateInvalid, "{damaged}");
            assert_eq!(std::fs::read_to_string(&state).unwrap(), damaged);
            let kept = reset_seen(&root).unwrap().unwrap();
            assert_eq!(
                std::fs::read_to_string(kept).unwrap(),
                damaged,
                "kept on reset"
            );
            install(&service, from(&served, "1.0.0", &v1), "1.0.0").unwrap();
            assert_eq!(read_seen(&root).unwrap()[fixtures::REGISTRY_ID].sequence, 3);
            service.uninstall("acme.hello").unwrap();
        }
    });
}
