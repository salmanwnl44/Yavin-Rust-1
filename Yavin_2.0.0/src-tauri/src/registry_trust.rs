//! Signed Yavin registry metadata (EXT-20).
//!
//! Yavin's registry is static files: `index.json` lists every extension, version, package path,
//! size and SHA-256 (IDE-09). The SHA-256s authenticate the packages only as far as the index
//! itself is authentic -- whoever can replace both could install anything. So the index is
//! signed, and Yavin authenticates it natively before any package it lists is installed.
//!
//! **The protocol (version 1).**
//!
//! - **Bytes signed**: exactly the bytes of `index.json` as served, after the domain prefix
//!   `Yavin.RegistryIndex.v1\0` -- no canonicalization, so there is nothing to disagree about.
//!   The signature is a separate file, `index.json.sig`: strict JSON
//!   `{"schema":1,"registryId":…,"keyId":…,"algorithm":"ed25519","signature":<base64 of 64 bytes>}`
//!   (no other field; the signature exactly 64 bytes).
//! - **Algorithm**: Ed25519 (RFC 8032), checked with `verify_strict` (no small-order keys, no
//!   non-canonical signatures) -- the dalek crate EXT-09 already uses.
//! - **Trust anchors** are **pinned in Yavin** (`registry_anchors.json`, compiled in, reviewed
//!   in the repository) -- never read from the registry, the network or user data: a key served
//!   beside the index would prove nothing. Each anchor binds a **registry id** to the registry's
//!   exact **base URL** (not just its origin: raw.githubusercontent.com serves anyone's files)
//!   and lists its keys with a status (`active`, `revoked`) and an optional last day.
//! - **Identity and freshness**, inside the signed index: `registryId` (must be the anchor's),
//!   `sequence` (a counter the publisher raises with every change), `issuedAt` and `expiresAt`
//!   (`YYYY-MM-DD`). An index past `expiresAt` is refused; one with a lower `sequence` than an
//!   index Yavin already accepted from that registry is a replay (a downgrade to older metadata)
//!   and refused; one with the same `sequence` and other bytes is refused too (equivocation).
//!   The highest accepted `(sequence, SHA-256)` per registry is kept in the extensions folder.
//! - **Strictness**: an index with a duplicate key anywhere is refused (two parsers could read it
//!   differently); its `schema` must be 1; the signature file's schema 1.
//! - **Rotation**: a new key is added to the anchors in a Yavin release; the publisher signs with
//!   it; the old one may stay active for a while or be marked `revoked` (refused at once) or
//!   given a last day. **Revocation and recovery** are a Yavin release too: a compromised key is
//!   marked revoked, a new one pinned. Until a Yavin with the new key is installed, an index
//!   signed only with it is `UnknownKey` -- the safe failure.
//! - **What it proves**: the index -- and so each package's SHA-256 and size -- is the one the
//!   holder of the pinned key published. **Not** who wrote any extension, nor that the
//!   publisher is honest. A registry with no anchor (one a user names in Settings) is
//!   unauthenticated: its declarative packages may be installed, its code is refused.

use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::Path;

/// The signature file, beside `index.json`.
pub const SIGNATURE_FILE: &str = "index.json.sig";
/// The largest signature file read.
pub const MAX_SIGNATURE: u64 = 4096;
const DOMAIN: &[u8] = b"Yavin.RegistryIndex.v1\0";
const BUILTIN: &str = include_str!("registry_anchors.json");
/// Where the highest accepted index per registry is kept (in the extensions folder).
pub const STATE_FILE: &str = "registry-state.json";

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct AnchorsFile {
    schema: u32,
    revision: u32,
    registries: Vec<RegistryFile>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RegistryFile {
    id: String,
    base: String,
    keys: Vec<KeyFile>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct KeyFile {
    key_id: String,
    algorithm: String,
    public_key: String,
    status: String,
    not_after: Option<String>,
    added: String,
    provenance: String,
}

#[derive(Debug, Clone)]
struct PinnedKey {
    key_id: String,
    key: VerifyingKey,
    revoked: bool,
    not_after: Option<i64>,
}

/// One pinned registry: its id, base URL and keys.
#[derive(Debug, Clone)]
pub struct RegistryAnchor {
    pub id: String,
    pub base: String,
    keys: Vec<PinnedKey>,
}

/// Every pinned registry (a parsed `registry_anchors.json`).
#[derive(Debug, Clone)]
pub struct RegistryAnchors {
    pub revision: u32,
    registries: Vec<RegistryAnchor>,
}

fn id_ok(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

impl RegistryAnchors {
    /// The anchors' text, strictly: anything it does not expect refuses it whole (anchors Yavin
    /// cannot read authenticate nothing).
    pub fn parse(text: &str) -> Result<RegistryAnchors, String> {
        let file: AnchorsFile = serde_json::from_str(text)
            .map_err(|e| format!("the registry anchors are not valid: {e}"))?;
        if file.schema != 1 {
            return Err(format!(
                "registry anchors schema {} is not supported",
                file.schema
            ));
        }
        let mut registries: Vec<RegistryAnchor> = Vec::new();
        for one in file.registries {
            let what = format!("registry anchor {}", one.id);
            if !id_ok(&one.id) || registries.iter().any(|r| r.id == one.id) {
                return Err(format!("{what}: its id is not valid, or pinned twice"));
            }
            let base = crate::marketplace::registry(&one.base)
                .map_err(|why| format!("{what}: its base is not a registry URL ({why})"))?
                .base;
            if base != one.base || registries.iter().any(|r| r.base == base) {
                return Err(format!(
                    "{what}: its base must be written as Yavin reads it, once"
                ));
            }
            let mut keys: Vec<PinnedKey> = Vec::new();
            for key in one.keys {
                let what = format!("{what} key {}", key.key_id);
                if !(1..=64).contains(&key.key_id.len())
                    || !key
                        .key_id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-')
                    || keys.iter().any(|k| k.key_id == key.key_id)
                {
                    return Err(format!("{what}: its id is not valid, or pinned twice"));
                }
                if key.algorithm != "ed25519" {
                    return Err(format!(
                        "{what}: algorithm {} is not supported",
                        key.algorithm
                    ));
                }
                let raw = crate::package_trust::ed25519_from_pem(&key.public_key)
                    .map_err(|why| format!("{what}: {why}"))?;
                let verifying = VerifyingKey::from_bytes(&raw)
                    .map_err(|_| format!("{what}: not a valid key"))?;
                let revoked = match key.status.as_str() {
                    "active" => false,
                    "revoked" => true,
                    other => return Err(format!("{what}: status {other} is not known")),
                };
                let not_after = match &key.not_after {
                    None => None,
                    Some(date) => Some(day(date).ok_or(format!("{what}: notAfter is not a date"))?),
                };
                if day(&key.added).is_none() || key.provenance.trim().is_empty() {
                    return Err(format!(
                        "{what}: when and how it was pinned must be recorded"
                    ));
                }
                keys.push(PinnedKey {
                    key_id: key.key_id,
                    key: verifying,
                    revoked,
                    not_after,
                });
            }
            registries.push(RegistryAnchor {
                id: one.id,
                base,
                keys,
            });
        }
        Ok(RegistryAnchors {
            revision: file.revision,
            registries,
        })
    }

    /// The anchor of the registry at `base` (as `marketplace::registry` normalizes it).
    pub fn for_base(&self, base: &str) -> Option<&RegistryAnchor> {
        self.registries.iter().find(|r| r.base == base)
    }

    /// One registry with one key, active (tests; and a test-registry build's loopback registry).
    pub fn single(
        id: &str,
        base: &str,
        key_id: &str,
        key: [u8; 32],
    ) -> Result<RegistryAnchors, String> {
        Ok(RegistryAnchors {
            revision: 0,
            registries: vec![RegistryAnchor {
                id: id.into(),
                base: base.into(),
                keys: vec![PinnedKey {
                    key_id: key_id.into(),
                    key: VerifyingKey::from_bytes(&key).map_err(|_| "not a valid key")?,
                    revoked: false,
                    not_after: None,
                }],
            }],
        })
    }
}

/// `YYYY-MM-DD` as days since 1970-01-01.
fn day(date: &str) -> Option<i64> {
    crate::package_trust::days_of(date)
}

#[cfg(test)]
thread_local! {
    static TEST_ANCHORS: std::cell::RefCell<Option<Result<RegistryAnchors, String>>> =
        const { std::cell::RefCell::new(None) };
}

/// Test only: runs `f` with `anchors` as the pinned registry anchors.
#[cfg(test)]
pub fn with_anchors<R>(anchors: Result<RegistryAnchors, String>, f: impl FnOnce() -> R) -> R {
    TEST_ANCHORS.with(|cell| *cell.borrow_mut() = Some(anchors));
    let result = f();
    TEST_ANCHORS.with(|cell| *cell.borrow_mut() = None);
    result
}

/// The anchors checks use: the pinned ones. A `test-registry` build (the end-to-end test's,
/// never shipped) also pins the loopback registry `YAVIN_TEST_REGISTRY` under the key
/// `YAVIN_TEST_REGISTRY_KEY` (base64, 32 bytes) -- no other build reads either.
pub fn anchors() -> Result<RegistryAnchors, String> {
    #[cfg(test)]
    if let Some(anchors) = TEST_ANCHORS.with(|cell| cell.borrow().clone()) {
        return anchors;
    }
    if cfg!(feature = "test-registry") {
        if let (Ok(url), Ok(key)) = (
            std::env::var("YAVIN_TEST_REGISTRY"),
            std::env::var("YAVIN_TEST_REGISTRY_KEY"),
        ) {
            let raw: [u8; 32] = base64::engine::general_purpose::STANDARD
                .decode(key.trim())
                .ok()
                .and_then(|bytes| bytes.try_into().ok())
                .ok_or("YAVIN_TEST_REGISTRY_KEY is not a base64 Ed25519 key")?;
            let base = crate::marketplace::registry(&url)?.base;
            return RegistryAnchors::single("yavin-test", &base, "test", raw);
        }
    }
    RegistryAnchors::parse(BUILTIN)
}

/// What authenticating a registry's index found.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum IndexStatus {
    /// Signed with a pinned, current key of this very registry, fresh, not a replay.
    Verified,
    /// No anchor is pinned for this registry: nothing can authenticate it.
    Unanchored,
    /// The registry is pinned but served no signature.
    Missing,
    /// The signature does not verify: the index or the signature was changed.
    Invalid,
    /// Signed with a key not pinned for this registry.
    UnknownKey,
    /// Signed with a key pinned as revoked.
    KeyRevoked,
    /// Signed with a key whose pinning has ended.
    KeyExpired,
    /// The index (or its signature) names another registry.
    WrongRegistry,
    /// Past its `expiresAt`.
    Expired,
    /// Older than an index already accepted from this registry (or the same one, changed).
    Replay,
    /// The signature or the index cannot be read unambiguously.
    Malformed,
    /// The anchors cannot be read: nothing authenticates.
    Unavailable,
}

impl IndexStatus {
    pub fn verified(self) -> bool {
        self == IndexStatus::Verified
    }
}

/// The outcome, as the window shows it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IndexVerification {
    pub status: IndexStatus,
    pub registry_id: Option<String>,
    pub key_id: Option<String>,
    pub sequence: Option<u64>,
    pub issued_at: Option<String>,
    pub expires_at: Option<String>,
    /// The index's SHA-256 (what a replay check compares).
    pub sha256: String,
    pub anchors_revision: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SignatureFile {
    schema: u32,
    registry_id: String,
    key_id: String,
    algorithm: String,
    signature: String,
}

/// The highest index accepted from a registry.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Seen {
    pub sequence: u64,
    pub sha256: String,
}

/// Every key in `bytes` (JSON) is unique within its object -- else the text means different
/// things to different readers.
pub fn unambiguous(bytes: &[u8]) -> bool {
    use serde::de::{self, Deserializer, MapAccess, SeqAccess, Visitor};
    struct Check;
    impl<'de> Visitor<'de> for Check {
        type Value = ();
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("JSON")
        }
        fn visit_bool<E>(self, _: bool) -> Result<(), E> {
            Ok(())
        }
        fn visit_i64<E>(self, _: i64) -> Result<(), E> {
            Ok(())
        }
        fn visit_u64<E>(self, _: u64) -> Result<(), E> {
            Ok(())
        }
        fn visit_f64<E>(self, _: f64) -> Result<(), E> {
            Ok(())
        }
        fn visit_str<E>(self, _: &str) -> Result<(), E> {
            Ok(())
        }
        fn visit_unit<E>(self) -> Result<(), E> {
            Ok(())
        }
        fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
            while seq.next_element_seed(Seed)?.is_some() {}
            Ok(())
        }
        fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
            let mut keys = std::collections::HashSet::new();
            while let Some(key) = map.next_key::<String>()? {
                if !keys.insert(key.clone()) {
                    return Err(de::Error::custom(format!("duplicate key {key}")));
                }
                map.next_value_seed(Seed)?;
            }
            Ok(())
        }
    }
    struct Seed;
    impl<'de> de::DeserializeSeed<'de> for Seed {
        type Value = ();
        fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
            d.deserialize_any(Check)
        }
    }
    let mut d = serde_json::Deserializer::from_slice(bytes);
    d.deserialize_any(Check).is_ok() && d.end().is_ok()
}

/// Authenticates `index` (its exact bytes) served from the registry at `base`, with its
/// signature file `signature` (if served), against `anchors`, `today` (days since 1970) and
/// the highest index already accepted from that registry (`seen`).
pub fn authenticate(
    anchors: &Result<RegistryAnchors, String>,
    base: &str,
    index: &[u8],
    signature: Option<&[u8]>,
    seen: Option<&Seen>,
    today: i64,
) -> IndexVerification {
    let sha256 = crate::extension_package::hex(&Sha256::digest(index));
    let mut out = IndexVerification {
        status: IndexStatus::Unavailable,
        registry_id: None,
        key_id: None,
        sequence: None,
        issued_at: None,
        expires_at: None,
        sha256,
        anchors_revision: 0,
    };
    let Ok(anchors) = anchors else {
        return out;
    };
    out.anchors_revision = anchors.revision;
    let Some(anchor) = anchors.for_base(base) else {
        out.status = IndexStatus::Unanchored;
        return out;
    };
    out.registry_id = Some(anchor.id.clone());
    let finish = |mut out: IndexVerification, status| {
        out.status = status;
        out
    };
    let Some(signature) = signature else {
        return finish(out, IndexStatus::Missing);
    };
    let file: SignatureFile = match (unambiguous(signature), serde_json::from_slice(signature)) {
        (true, Ok(file)) => file,
        _ => return finish(out, IndexStatus::Malformed),
    };
    if file.schema != 1 || file.algorithm != "ed25519" {
        return finish(out, IndexStatus::Malformed);
    }
    out.key_id = Some(file.key_id.clone());
    let Some(bytes) = base64::engine::general_purpose::STANDARD
        .decode(&file.signature)
        .ok()
        .and_then(|b| <[u8; 64]>::try_from(b).ok())
    else {
        return finish(out, IndexStatus::Malformed);
    };
    if file.registry_id != anchor.id {
        return finish(out, IndexStatus::WrongRegistry);
    }
    let Some(key) = anchor.keys.iter().find(|k| k.key_id == file.key_id) else {
        return finish(out, IndexStatus::UnknownKey);
    };
    if key.revoked {
        return finish(out, IndexStatus::KeyRevoked);
    }
    if key.not_after.is_some_and(|last| today > last) {
        return finish(out, IndexStatus::KeyExpired);
    }
    let message = [DOMAIN, index].concat();
    if key
        .key
        .verify_strict(&message, &Signature::from_bytes(&bytes))
        .is_err()
    {
        return finish(out, IndexStatus::Invalid);
    }
    // Signed by a pinned key: now what it says is read -- strictly.
    if !unambiguous(index) {
        return finish(out, IndexStatus::Malformed);
    }
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(index) else {
        return finish(out, IndexStatus::Malformed);
    };
    let text = |name: &str| value.get(name).and_then(|v| v.as_str()).map(str::to_string);
    out.sequence = value.get("sequence").and_then(|v| v.as_u64());
    out.issued_at = text("issuedAt");
    out.expires_at = text("expiresAt");
    let registry_id = text("registryId");
    let (Some(sequence), Some(issued), Some(expires)) = (
        out.sequence,
        out.issued_at.as_deref().and_then(day),
        out.expires_at.as_deref().and_then(day),
    ) else {
        return finish(out, IndexStatus::Malformed);
    };
    if value.get("schema").and_then(|v| v.as_u64()) != Some(1) || issued > expires {
        return finish(out, IndexStatus::Malformed);
    }
    if registry_id.as_deref() != Some(anchor.id.as_str()) {
        return finish(out, IndexStatus::WrongRegistry);
    }
    if today > expires {
        return finish(out, IndexStatus::Expired);
    }
    if let Some(seen) = seen {
        if sequence < seen.sequence || (sequence == seen.sequence && seen.sha256 != out.sha256) {
            return finish(out, IndexStatus::Replay);
        }
    }
    finish(out, IndexStatus::Verified)
}

/// The highest index accepted per registry id, from `<extensions>/registry-state.json`.
pub fn read_seen(root: &Path) -> BTreeMap<String, Seen> {
    std::fs::read(root.join(STATE_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// Records `verification` (verified) as accepted, if it is newer than what was.
pub fn record_seen(root: &Path, verification: &IndexVerification) -> Result<(), String> {
    let (Some(id), Some(sequence), true) = (
        &verification.registry_id,
        verification.sequence,
        verification.status.verified(),
    ) else {
        return Ok(());
    };
    let mut seen = read_seen(root);
    if seen.get(id).is_some_and(|s| s.sequence >= sequence) {
        return Ok(());
    }
    seen.insert(
        id.clone(),
        Seen {
            sequence,
            sha256: verification.sha256.clone(),
        },
    );
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let text = serde_json::to_vec_pretty(&seen).map_err(|e| e.to_string())?;
    ide_workspace::durable::write_durably(&root.join(STATE_FILE), &text)
}

/// Why a code package is refused from a registry whose index has `status` (`Code: message`).
pub fn refusal(status: IndexStatus, label: &str) -> String {
    match status {
        IndexStatus::Verified => String::new(),
        IndexStatus::Unanchored => format!("RegistryUnverified: {label} comes from a registry Yavin has no key for, so its index cannot be authenticated; Yavin installs extensions with code only from an authenticated registry."),
        IndexStatus::Missing => format!("SignatureMissing: the registry's index is not signed; {label} was not installed."),
        IndexStatus::Invalid => format!("SignatureInvalid: the registry's index does not match its signature: it was changed after it was signed. {label} was not installed."),
        IndexStatus::UnknownKey => format!("UntrustedKey: the registry's index is signed with a key this Yavin does not trust for it. {label} was not installed; a Yavin update may be needed."),
        IndexStatus::KeyRevoked => format!("KeyRevoked: the registry's index is signed with a key Yavin no longer trusts (revoked). {label} was not installed."),
        IndexStatus::KeyExpired => format!("KeyExpired: the registry's index is signed with a key whose trust has ended. {label} was not installed."),
        IndexStatus::WrongRegistry => format!("WrongRegistry: the index served here is signed for another registry. {label} was not installed."),
        IndexStatus::Expired => format!("RegistryMetadataExpired: the registry's index is past its expiry date; {label} was not installed. Try again later."),
        IndexStatus::Replay => format!("RegistryReplay: the registry served an older index than one Yavin already accepted from it (a downgrade). {label} was not installed."),
        IndexStatus::Malformed => format!("RegistryMetadataMalformed: the registry's index or its signature cannot be read unambiguously. {label} was not installed."),
        IndexStatus::Unavailable => format!("VerificationUnavailable: the registry's index could not be authenticated (no trust anchors); {label} was not installed."),
    }
}

#[cfg(test)]
#[path = "registry_trust_tests.rs"]
mod tests;

/// Test only: a pinned test registry and indexes signed for it.
#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    pub const REGISTRY_ID: &str = "acme-test";
    const SEED: [u8; 32] = [5; 32];

    /// The registry at `base` pinned under the test key.
    pub fn anchors_for(base: &str) -> Result<RegistryAnchors, String> {
        RegistryAnchors::single(
            REGISTRY_ID,
            base,
            "t",
            SigningKey::from_bytes(&SEED).verifying_key().to_bytes(),
        )
    }

    /// `index` (an object) as the registry publishes it -- with its identity, `sequence` and
    /// dates -- and its signature file.
    pub fn signed(mut index: serde_json::Value, sequence: u64) -> (String, String) {
        index["schema"] = 1.into();
        index["registryId"] = REGISTRY_ID.into();
        index["sequence"] = sequence.into();
        index["issuedAt"] = "2026-01-01".into();
        index["expiresAt"] = "2099-12-31".into();
        let text = index.to_string();
        let signature = SigningKey::from_bytes(&SEED)
            .sign(&[DOMAIN, text.as_bytes()].concat())
            .to_bytes();
        let file = serde_json::json!({
            "schema": 1, "registryId": REGISTRY_ID, "keyId": "t", "algorithm": "ed25519",
            "signature": base64::engine::general_purpose::STANDARD.encode(signature)
        });
        (text, file.to_string())
    }
}
