//! Package trust (EXT-09): Open VSX package signatures, checked natively against keys Yavin
//! pins, before a package can be installed.
//!
//! **The protocol** (Open VSX's server, eclipse-openvsx/openvsx: `ExtensionVersionIntegrityService`,
//! `GenerateKeyPairJobService`, `RegistryAPI`; confirmed against a package open-vsx.org signed):
//!
//! - the registry holds **one** active Ed25519 key pair (`SignatureKeyPair`, a random UUID as its
//!   `publicId`) and signs **every** package it publishes with it -- the publisher has no key;
//! - the signature is pure Ed25519 (RFC 8032) over the **whole `.vsix` file's bytes**: 64 raw
//!   bytes, the `.signature.sig` entry of the version's `.sigzip` (beside `.signature.manifest`,
//!   per-entry SHA-256 digests, which is *not* signed, and an empty `.signature.p7s` VS Code
//!   expects);
//! - the version's metadata names the signature (`files.signature`) and the key
//!   (`files.publicKey`: `/api/-/public-key/<publicId>`, an SPKI PEM served by the same registry);
//! - a renewed key pair becomes the active one; versions keep the signature they were given
//!   unless re-signed.
//!
//! **What a valid signature proves**: the package is byte for byte the one that registry
//! published. **Not**: who its publisher is -- every package carries the registry's signature --
//! nor that the registry is honest or uncompromised. And a key fetched beside the package proves
//! nothing (whoever can change the package can change the key): Yavin only ever uses keys it
//! **pins** (`trust_anchors.json`, compiled in: reviewed in the repository, never read from the
//! network or from user data). The metadata's key id only selects among them.
//!
//! **Trust anchors** carry their registry (an origin), key id, key, scope -- `registry` (vouches
//! for that registry's publication of any package) or `publisher` (vouches only for the listed
//! namespaces) -- status (`active` / `revoked`), an optional end date and their provenance. A
//! key Yavin does not pin is unknown, never trusted; a revoked or expired one, or one used for a
//! namespace it does not cover, is refused. A store that cannot be read is unavailable: nothing
//! verifies (fail closed).

use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use std::io::Read;

/// The signature's entry in a `.sigzip`.
pub const SIGNATURE_ENTRY: &str = ".signature.sig";
/// The largest `.sigzip` read (the real ones are a few KiB: the manifest lists every entry).
pub const MAX_SIGZIP: u64 = 4 * 1024 * 1024;
/// The trust store this Yavin pins.
const BUILTIN: &str = include_str!("trust_anchors.json");
const STORE_SCHEMA: u32 = 1;

/// What checking a package's signature found.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SignatureStatus {
    /// Valid under a pinned key of the registry itself: the package is the one that registry
    /// published. The publisher's identity is not established by it.
    RegistrySigned,
    /// Valid under a pinned key scoped to this publisher's namespace.
    PublisherSigned,
    /// No signature (Yavin's own registry, a file: integrity by SHA-256 only).
    Missing,
    /// It does not verify: the package or the signature was changed.
    Invalid,
    /// Signed with a key Yavin does not pin.
    UnknownKey,
    /// Signed with a key Yavin pins as revoked.
    KeyRevoked,
    /// Signed with a key whose pinning has ended.
    KeyExpired,
    /// Signed with a pinned publisher key for another namespace.
    WrongNamespace,
    /// The signature or its key reference cannot be read.
    Malformed,
    /// It could not be checked: the signature could not be fetched, or no trust store.
    Unavailable,
    /// Yavin's registry (EXT-20): the package is the one listed -- by SHA-256 -- in a registry
    /// index signed with a key Yavin pins for that registry. The package itself carries no
    /// signature, and the publisher's identity is not established by it.
    IndexSigned,
}

impl SignatureStatus {
    /// Whether a package with it may be installed where a signature is required.
    pub fn trusted(self) -> bool {
        matches!(
            self,
            SignatureStatus::RegistrySigned | SignatureStatus::PublisherSigned
        )
    }
}

/// What was found, bound to the package it was found for (EXT-09); kept with the installed copy.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SignatureRecord {
    pub status: SignatureStatus,
    /// The registry's origin (`file` for a file).
    pub registry: String,
    /// The pinned key that verified it, or the one named.
    pub key_id: Option<String>,
    pub namespace: String,
    /// The SHA-256 of the exact package bytes checked.
    pub sha256: String,
    /// The trust store's revision used.
    pub store_revision: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct StoreFile {
    schema: u32,
    revision: u32,
    anchors: Vec<AnchorFile>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct AnchorFile {
    registry: String,
    key_id: String,
    algorithm: String,
    public_key: String,
    scope: String,
    namespaces: Vec<String>,
    status: String,
    not_after: Option<String>,
    added: String,
    provenance: String,
}

/// One pinned key.
#[derive(Debug, Clone)]
pub struct Anchor {
    pub registry: String,
    pub key_id: String,
    key: VerifyingKey,
    /// `publisher` scope: only `namespaces` (lower case); `registry` scope: any.
    publisher: bool,
    namespaces: Vec<String>,
    revoked: bool,
    /// Days since 1970-01-01 of the last day it may be used.
    not_after: Option<i64>,
}

/// The pinned keys (a parsed `trust_anchors.json`).
#[derive(Debug, Clone)]
pub struct TrustStore {
    pub revision: u32,
    anchors: Vec<Anchor>,
}

/// The 32 bytes of an Ed25519 public key from its SPKI PEM -- exactly one, nothing else.
pub fn ed25519_from_pem(pem: &str) -> Result<[u8; 32], String> {
    const PREFIX: [u8; 12] = [
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ];
    let body = pem
        .trim()
        .strip_prefix("-----BEGIN PUBLIC KEY-----")
        .and_then(|rest| rest.strip_suffix("-----END PUBLIC KEY-----"))
        .ok_or("not a PEM public key")?;
    let text: String = body.split_whitespace().collect();
    let der = base64::engine::general_purpose::STANDARD
        .decode(text)
        .map_err(|_| "its base64 is not valid")?;
    if der.len() != PREFIX.len() + 32 || der[..PREFIX.len()] != PREFIX {
        return Err("not an Ed25519 public key (SubjectPublicKeyInfo)".into());
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&der[PREFIX.len()..]);
    Ok(key)
}

/// `YYYY-MM-DD` as days since 1970-01-01 (the civil calendar).
pub(crate) fn days_of(date: &str) -> Option<i64> {
    let mut parts = date.split('-');
    let (y, m, d) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() || y.len() != 4 || m.len() != 2 || d.len() != 2 {
        return None;
    }
    let (y, m, d): (i64, i64, i64) = (y.parse().ok()?, m.parse().ok()?, d.parse().ok()?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * ((m + 9) % 12) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

/// Today, as days since 1970-01-01.
pub fn today() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| (d.as_secs() / 86_400) as i64)
        .unwrap_or(0)
}

fn origin_ok(origin: &str) -> bool {
    // Plain HTTP only to the loopback interface, where the marketplace allows it (tests).
    if crate::marketplace::LOOPBACK_ALLOWED && origin.starts_with("http://127.0.0.1:") {
        return origin["http://127.0.0.1:".len()..]
            .bytes()
            .all(|b| b.is_ascii_digit());
    }
    origin.starts_with("https://")
        && !origin["https://".len()..].contains(['/', '?', '#', '@'])
        && origin.len() > "https://".len()
}

fn key_id_ok(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

impl TrustStore {
    /// A trust store's text, strictly: any field, value or key it does not expect refuses it
    /// whole (a store Yavin cannot read verifies nothing).
    pub fn parse(text: &str) -> Result<TrustStore, String> {
        let file: StoreFile =
            serde_json::from_str(text).map_err(|e| format!("the trust store is not valid: {e}"))?;
        if file.schema != STORE_SCHEMA {
            return Err(format!(
                "trust store schema {} is not supported",
                file.schema
            ));
        }
        let mut anchors: Vec<Anchor> = Vec::new();
        for one in file.anchors {
            let what = format!("trust anchor {}", one.key_id);
            if !origin_ok(&one.registry) {
                return Err(format!("{what}: its registry is not an https origin"));
            }
            if !key_id_ok(&one.key_id) {
                return Err(format!("{what}: its key id is not valid"));
            }
            if anchors
                .iter()
                .any(|a| a.registry == one.registry && a.key_id == one.key_id)
            {
                return Err(format!("{what}: it is pinned twice"));
            }
            if one.algorithm != "ed25519" {
                return Err(format!(
                    "{what}: algorithm {} is not supported",
                    one.algorithm
                ));
            }
            let raw = ed25519_from_pem(&one.public_key).map_err(|why| format!("{what}: {why}"))?;
            let key =
                VerifyingKey::from_bytes(&raw).map_err(|_| format!("{what}: not a valid key"))?;
            let publisher = match one.scope.as_str() {
                "registry" => false,
                "publisher" => true,
                other => return Err(format!("{what}: scope {other} is not known")),
            };
            let namespaces: Vec<String> = one.namespaces.clone();
            let any = namespaces == ["*"];
            if publisher == any
                || (publisher
                    && (namespaces.is_empty()
                        || namespaces.iter().any(|n| {
                            n.is_empty()
                                || n.len() > 64
                                || !n.bytes().all(|b| {
                                    b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'
                                })
                        })))
            {
                return Err(format!(
                    "{what}: a registry key covers \"*\", a publisher key its own namespaces"
                ));
            }
            let revoked = match one.status.as_str() {
                "active" => false,
                "revoked" => true,
                other => return Err(format!("{what}: status {other} is not known")),
            };
            let not_after = match &one.not_after {
                None => None,
                Some(date) => Some(days_of(date).ok_or(format!("{what}: notAfter is not a date"))?),
            };
            if days_of(&one.added).is_none() || one.provenance.trim().is_empty() {
                return Err(format!(
                    "{what}: when and how it was pinned must be recorded"
                ));
            }
            anchors.push(Anchor {
                registry: one.registry,
                key_id: one.key_id,
                key,
                publisher,
                namespaces,
                revoked,
                not_after,
            });
        }
        Ok(TrustStore {
            revision: file.revision,
            anchors,
        })
    }

    /// The store this Yavin pins.
    pub fn builtin() -> &'static Result<TrustStore, String> {
        static STORE: std::sync::OnceLock<Result<TrustStore, String>> = std::sync::OnceLock::new();
        STORE.get_or_init(|| TrustStore::parse(BUILTIN))
    }

    /// The anchors of `registry` (an origin), for the trust page.
    pub fn of(&self, registry: &str) -> impl Iterator<Item = &Anchor> {
        let registry = registry.to_string();
        self.anchors.iter().filter(move |a| a.registry == registry)
    }
}

#[cfg(test)]
thread_local! {
    /// Test only: the store this thread's checks use instead of the pinned one.
    static TEST_STORE: std::cell::RefCell<Option<Result<TrustStore, String>>> =
        const { std::cell::RefCell::new(None) };
}

/// Test only: runs `f` with `store` as the trust store.
#[cfg(test)]
pub fn with_store<R>(store: Result<TrustStore, String>, f: impl FnOnce() -> R) -> R {
    TEST_STORE.with(|cell| *cell.borrow_mut() = Some(store));
    let result = f();
    TEST_STORE.with(|cell| *cell.borrow_mut() = None);
    result
}

/// The trust store checks use: the pinned one (tests may set their own).
pub fn store() -> Result<TrustStore, String> {
    #[cfg(test)]
    if let Some(store) = TEST_STORE.with(|cell| cell.borrow().clone()) {
        return store;
    }
    TrustStore::builtin().clone()
}

/// The 64-byte signature in a `.sigzip`, or why it cannot be read.
pub fn signature_in(sigzip: &[u8]) -> Result<[u8; 64], String> {
    if sigzip.len() as u64 > MAX_SIGZIP {
        return Err("the signature archive is too large".into());
    }
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(sigzip))
        .map_err(|_| "the signature archive is not a zip")?;
    if archive.len() > 16 {
        return Err("the signature archive has too many entries".into());
    }
    let mut entry = archive
        .by_name(SIGNATURE_ENTRY)
        .map_err(|_| format!("the signature archive has no {SIGNATURE_ENTRY}"))?;
    if entry.size() != 64 {
        return Err(format!("{SIGNATURE_ENTRY} is not 64 bytes"));
    }
    let mut bytes = Vec::with_capacity(64);
    entry
        .by_ref()
        .take(65)
        .read_to_end(&mut bytes)
        .map_err(|_| format!("{SIGNATURE_ENTRY} cannot be read"))?;
    bytes
        .try_into()
        .map_err(|_| format!("{SIGNATURE_ENTRY} is not 64 bytes"))
}

/// The status of `package` (its exact bytes) from `registry` (an origin) in `namespace`,
/// signed (`sigzip`) with the key the metadata names (`key_id`) -- checked against `store` only.
pub fn verify(
    store: &Result<TrustStore, String>,
    registry: &str,
    namespace: &str,
    key_id: Option<&str>,
    package: &[u8],
    sigzip: Option<&[u8]>,
    today: i64,
) -> SignatureStatus {
    let Ok(store) = store else {
        return SignatureStatus::Unavailable;
    };
    let Some(sigzip) = sigzip else {
        return SignatureStatus::Missing;
    };
    let Some(key_id) = key_id else {
        return SignatureStatus::Malformed;
    };
    let Some(anchor) = store.of(registry).find(|a| a.key_id == key_id) else {
        return SignatureStatus::UnknownKey;
    };
    if anchor.revoked {
        return SignatureStatus::KeyRevoked;
    }
    if anchor.not_after.is_some_and(|last| today > last) {
        return SignatureStatus::KeyExpired;
    }
    let namespace = namespace.to_ascii_lowercase();
    if anchor.publisher && !anchor.namespaces.contains(&namespace) {
        return SignatureStatus::WrongNamespace;
    }
    let Ok(bytes) = signature_in(sigzip) else {
        return SignatureStatus::Malformed;
    };
    match anchor
        .key
        .verify_strict(package, &Signature::from_bytes(&bytes))
    {
        Ok(()) if anchor.publisher => SignatureStatus::PublisherSigned,
        Ok(()) => SignatureStatus::RegistrySigned,
        Err(_) => SignatureStatus::Invalid,
    }
}

/// Why a package with `status` is refused where a signature is required (`Code: message`).
pub fn refusal(status: SignatureStatus, label: &str, registry: &str) -> String {
    match status {
        SignatureStatus::Missing => format!("SignatureMissing: {label} is not signed by {registry}; Yavin installs only signed packages from it."),
        SignatureStatus::Invalid => format!("SignatureInvalid: {label}'s signature does not match the package: it was changed after {registry} signed it."),
        SignatureStatus::UnknownKey => format!("UntrustedKey: {label} is signed with a key Yavin does not trust for {registry}."),
        SignatureStatus::KeyRevoked => format!("KeyRevoked: {label} is signed with a key Yavin no longer trusts (revoked)."),
        SignatureStatus::KeyExpired => format!("KeyExpired: {label} is signed with a key Yavin trusts no longer (its pinning ended)."),
        SignatureStatus::WrongNamespace => format!("UntrustedKey: {label} is signed with another publisher's key."),
        SignatureStatus::Malformed => format!("SignatureMalformed: {label}'s signature cannot be read."),
        SignatureStatus::Unavailable => format!("VerificationUnavailable: {label}'s signature could not be checked; it was not installed."),
        SignatureStatus::RegistrySigned
        | SignatureStatus::PublisherSigned
        | SignatureStatus::IndexSigned => String::new(),
    }
}

#[cfg(test)]
#[path = "package_trust_tests.rs"]
pub(crate) mod tests;
