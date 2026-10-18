//! EXT-09: signatures and trust anchors, with fixed test keys (never a production private key).

use super::*;
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{json, Value};
use std::io::Write;

/// Fixed test seeds: the keys they make sign test fixtures only.
pub(crate) const SEED_A: [u8; 32] = [7; 32];
pub(crate) const SEED_B: [u8; 32] = [9; 32];
pub(crate) const REGISTRY: &str = "https://registry.test";
const DAY: i64 = 20_000;

pub(crate) fn signing(seed: [u8; 32]) -> SigningKey {
    SigningKey::from_bytes(&seed)
}

/// An Ed25519 public key as the SPKI PEM Open VSX serves.
pub(crate) fn pem_of(seed: [u8; 32]) -> String {
    let mut der = vec![
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ];
    der.extend_from_slice(signing(seed).verifying_key().as_bytes());
    format!(
        "-----BEGIN PUBLIC KEY-----\n{}\n-----END PUBLIC KEY-----\n",
        base64::engine::general_purpose::STANDARD.encode(der)
    )
}

pub(crate) fn anchor(registry: &str, key_id: &str, seed: [u8; 32]) -> Value {
    json!({
        "registry": registry, "keyId": key_id, "algorithm": "ed25519", "publicKey": pem_of(seed),
        "scope": "registry", "namespaces": ["*"], "status": "active", "notAfter": null,
        "added": "2026-10-18", "provenance": "a test key",
    })
}

pub(crate) fn store_of(anchors: Vec<Value>) -> Result<TrustStore, String> {
    TrustStore::parse(&json!({"schema": 1, "revision": 7, "anchors": anchors}).to_string())
}

/// A `.sigzip` as Open VSX makes it: the signature, the (unsigned) manifest, an empty `.p7s`.
pub(crate) fn sigzip_with(signature: &[u8]) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default();
    for (name, bytes) in [
        (SIGNATURE_ENTRY, signature),
        (".signature.manifest", b"{}".as_slice()),
        (".signature.p7s", b"".as_slice()),
    ] {
        zip.start_file(name, options).unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

/// `package` signed by `seed`'s key, as a `.sigzip`.
pub(crate) fn signed(seed: [u8; 32], package: &[u8]) -> Vec<u8> {
    sigzip_with(&signing(seed).sign(package).to_bytes())
}

fn check(
    store: &Result<TrustStore, String>,
    key: &str,
    package: &[u8],
    sigzip: &[u8],
) -> SignatureStatus {
    verify(
        store,
        REGISTRY,
        "acme",
        Some(key),
        package,
        Some(sigzip),
        DAY,
    )
}

/// The library is used as the standard says: RFC 8032's first test vector verifies, and fails
/// for any other message -- the same on every platform (no randomness, no platform code).
#[test]
fn rfc_8032_test_vector_1_verifies() {
    let hex = |s: &str| -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    };
    let public: [u8; 32] = hex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
        .try_into()
        .unwrap();
    let signature: [u8; 64] = hex("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b")
        .try_into()
        .unwrap();
    let key = VerifyingKey::from_bytes(&public).unwrap();
    assert!(key
        .verify_strict(b"", &Signature::from_bytes(&signature))
        .is_ok());
    assert!(key
        .verify_strict(b"x", &Signature::from_bytes(&signature))
        .is_err());
    // And our own test key signs deterministically (Ed25519 has no random nonce).
    assert_eq!(signing(SEED_A).sign(b"a"), signing(SEED_A).sign(b"a"));
}

/// The pinned store reads, and pins Open VSX's registry key as a registry key -- not a
/// publisher's.
#[test]
fn the_pinned_store_reads() {
    let store = TrustStore::builtin()
        .as_ref()
        .expect("the pinned store reads");
    let open_vsx: Vec<_> = store.of("https://open-vsx.org").collect();
    assert_eq!(open_vsx.len(), 1);
    assert_eq!(open_vsx[0].key_id, "14ccb407-4e79-41ed-be5a-6d608325c45a");
    assert!(
        !open_vsx[0].publisher,
        "a registry key, vouching for no publisher"
    );
    assert!(store.of("https://registry.test").next().is_none());
}

/// A valid signature over the very bytes verifies; any change -- to the package, to the
/// signature -- or another key does not.
#[test]
fn only_the_signed_bytes_under_the_pinned_key_verify() {
    let store = store_of(vec![anchor(REGISTRY, "key-a", SEED_A)]);
    let package = b"PK\x03\x04 the package bytes".to_vec();
    let sigzip = signed(SEED_A, &package);
    assert_eq!(
        check(&store, "key-a", &package, &sigzip),
        SignatureStatus::RegistrySigned
    );
    let mut changed = package.clone();
    changed[3] ^= 1;
    assert_eq!(
        check(&store, "key-a", &changed, &sigzip),
        SignatureStatus::Invalid
    );
    let mut bad = signing(SEED_A).sign(&package).to_bytes();
    bad[10] ^= 1;
    assert_eq!(
        check(&store, "key-a", &package, &sigzip_with(&bad)),
        SignatureStatus::Invalid
    );
    // Signed by another key than the one pinned under that id.
    assert_eq!(
        check(&store, "key-a", &package, &signed(SEED_B, &package)),
        SignatureStatus::Invalid
    );
    // The same anchor for another registry vouches for nothing here.
    let elsewhere = store_of(vec![anchor("https://other.test", "key-a", SEED_A)]);
    assert_eq!(
        check(&elsewhere, "key-a", &package, &sigzip),
        SignatureStatus::UnknownKey
    );
}

/// A key Yavin does not pin is unknown -- never trusted, whatever signed with it; a revoked or
/// expired one is refused; a publisher key covers its own namespaces only.
#[test]
fn unknown_revoked_expired_and_other_publishers_keys_are_refused() {
    let package = b"bytes".to_vec();
    let sigzip = signed(SEED_A, &package);
    let store = store_of(vec![anchor(REGISTRY, "key-a", SEED_A)]);
    assert_eq!(
        check(&store, "key-z", &package, &sigzip),
        SignatureStatus::UnknownKey
    );

    let mut revoked = anchor(REGISTRY, "key-a", SEED_A);
    revoked["status"] = json!("revoked");
    assert_eq!(
        check(&store_of(vec![revoked]), "key-a", &package, &sigzip),
        SignatureStatus::KeyRevoked
    );

    let mut ended = anchor(REGISTRY, "key-a", SEED_A);
    ended["notAfter"] = json!("2024-01-01");
    let ended = store_of(vec![ended]);
    assert_eq!(
        check(&ended, "key-a", &package, &sigzip),
        SignatureStatus::KeyExpired
    );
    // The last day itself still counts.
    let last = days_of("2024-01-01").unwrap();
    assert_eq!(
        verify(
            &ended,
            REGISTRY,
            "acme",
            Some("key-a"),
            &package,
            Some(&sigzip),
            last
        ),
        SignatureStatus::RegistrySigned
    );

    let mut publisher = anchor(REGISTRY, "acme-key", SEED_A);
    publisher["scope"] = json!("publisher");
    publisher["namespaces"] = json!(["acme"]);
    let publishers = store_of(vec![publisher]);
    assert_eq!(
        check(&publishers, "acme-key", &package, &sigzip),
        SignatureStatus::PublisherSigned
    );
    // Its key for another publisher's package: refused, valid signature or not.
    assert_eq!(
        verify(
            &publishers,
            REGISTRY,
            "evil",
            Some("acme-key"),
            &package,
            Some(&sigzip),
            DAY
        ),
        SignatureStatus::WrongNamespace
    );
    assert_eq!(
        verify(
            &publishers,
            REGISTRY,
            "ACME",
            Some("acme-key"),
            &package,
            Some(&sigzip),
            DAY
        ),
        SignatureStatus::PublisherSigned,
        "namespaces compare case-insensitively, as Open VSX's do"
    );
}

/// Rotation: the old key and the new one are both pinned; each verifies only what it signed;
/// once the old one is revoked, its signatures are refused and the new one's still verify.
#[test]
fn a_rotated_key_is_a_new_anchor_and_the_old_one_can_be_revoked() {
    let old_package = b"signed before".to_vec();
    let new_package = b"signed after".to_vec();
    let old_sig = signed(SEED_A, &old_package);
    let new_sig = signed(SEED_B, &new_package);
    let both = store_of(vec![
        anchor(REGISTRY, "key-1", SEED_A),
        anchor(REGISTRY, "key-2", SEED_B),
    ]);
    assert_eq!(
        check(&both, "key-1", &old_package, &old_sig),
        SignatureStatus::RegistrySigned
    );
    assert_eq!(
        check(&both, "key-2", &new_package, &new_sig),
        SignatureStatus::RegistrySigned
    );
    assert_eq!(
        check(&both, "key-2", &old_package, &old_sig),
        SignatureStatus::Invalid
    );
    let mut old = anchor(REGISTRY, "key-1", SEED_A);
    old["status"] = json!("revoked");
    let rotated = store_of(vec![old, anchor(REGISTRY, "key-2", SEED_B)]);
    assert_eq!(
        check(&rotated, "key-1", &old_package, &old_sig),
        SignatureStatus::KeyRevoked
    );
    assert_eq!(
        check(&rotated, "key-2", &new_package, &new_sig),
        SignatureStatus::RegistrySigned
    );
}

/// No signature is missing; one that cannot be read is malformed -- never valid.
#[test]
fn missing_and_malformed_signatures() {
    let store = store_of(vec![anchor(REGISTRY, "key-a", SEED_A)]);
    let package = b"bytes".to_vec();
    assert_eq!(
        verify(&store, REGISTRY, "acme", Some("key-a"), &package, None, DAY),
        SignatureStatus::Missing
    );
    assert_eq!(
        verify(
            &store,
            REGISTRY,
            "acme",
            None,
            &package,
            Some(&signed(SEED_A, &package)),
            DAY
        ),
        SignatureStatus::Malformed,
        "no key named"
    );
    let sig = signing(SEED_A).sign(&package).to_bytes();
    let mut no_entry = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    no_entry
        .start_file("other.sig", zip::write::SimpleFileOptions::default())
        .unwrap();
    no_entry.write_all(&sig).unwrap();
    let no_entry = no_entry.finish().unwrap().into_inner();
    for (about, sigzip) in [
        ("not a zip", b"not a zip".to_vec()),
        ("63 bytes", sigzip_with(&sig[..63])),
        ("65 bytes", sigzip_with(&[sig.as_slice(), &[0]].concat())),
        (
            "base64 text instead of raw bytes",
            sigzip_with(
                base64::engine::general_purpose::STANDARD
                    .encode(sig)
                    .as_bytes(),
            ),
        ),
        ("no .signature.sig", no_entry),
    ] {
        assert_eq!(
            check(&store, "key-a", &package, &sigzip),
            SignatureStatus::Malformed,
            "{about}"
        );
    }
}

/// A trust store Yavin cannot read whole is refused whole -- and then nothing verifies.
#[test]
fn a_malformed_trust_store_verifies_nothing() {
    let good = anchor(REGISTRY, "key-a", SEED_A);
    let with = |key: &str, value: Value| {
        let mut one = good.clone();
        one[key] = value;
        store_of(vec![one])
    };
    for (about, store) in [
        ("not a PEM", with("publicKey", json!("MCowBQYDK2VwAyEA"))),
        ("an RSA-sized key", with("publicKey", json!("-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA\n-----END PUBLIC KEY-----"))),
        ("another algorithm", with("algorithm", json!("rsa"))),
        ("a registry that is not an origin", with("registry", json!("https://registry.test/path"))),
        ("plain http", with("registry", json!("http://registry.test"))),
        ("an unknown status", with("status", json!("trusted"))),
        ("an unknown scope", with("scope", json!("everyone"))),
        ("a registry key for a few namespaces", with("namespaces", json!(["acme"]))),
        ("a bad date", with("notAfter", json!("tomorrow"))),
        ("no provenance", with("provenance", json!(" "))),
        ("an odd key id", with("keyId", json!("../x"))),
        ("an unknown field", with("trusted", json!(true))),
        ("pinned twice", store_of(vec![good.clone(), good.clone()])),
        ("a newer schema", TrustStore::parse(&json!({"schema": 2, "revision": 1, "anchors": []}).to_string())),
    ] {
        assert!(store.is_err(), "{about}");
        let package = b"bytes".to_vec();
        assert_eq!(
            verify(&store, REGISTRY, "acme", Some("key-a"), &package, Some(&signed(SEED_A, &package)), DAY),
            SignatureStatus::Unavailable,
            "{about}"
        );
    }
}

/// The pinned key verifies a real package open-vsx.org signed (network; run by hand:
/// `cargo test package_trust -- --ignored`).
#[test]
#[ignore]
fn live_open_vsx_signature_verifies_under_the_pinned_key() {
    let base = "https://open-vsx.org/api/redhat/vscode-yaml/2.1.2026101708/file/redhat.vscode-yaml-2.1.2026101708";
    let get = |url: &str| {
        let mut body = Vec::new();
        // Its own agent: native TLS, as Yavin's; redirects followed (the files are on the CDN).
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .tls_config(
                ureq::tls::TlsConfig::builder()
                    .provider(ureq::tls::TlsProvider::NativeTls)
                    .build(),
            )
            .build()
            .into();
        agent
            .get(url)
            .call()
            .unwrap()
            .into_body()
            .into_reader()
            .read_to_end(&mut body)
            .unwrap();
        body
    };
    let package = get(&format!("{base}.vsix"));
    let sigzip = get(&format!("{base}.sigzip"));
    let status = verify(
        TrustStore::builtin(),
        "https://open-vsx.org",
        "redhat",
        Some("14ccb407-4e79-41ed-be5a-6d608325c45a"),
        &package,
        Some(&sigzip),
        today(),
    );
    assert_eq!(status, SignatureStatus::RegistrySigned);
}
