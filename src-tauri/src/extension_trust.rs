//! Authenticated trust records (EXT-19).
//!
//! What Yavin decided about an installed copy -- which package it is (its SHA-256), which files
//! it has (`filesSha256`), where it came from, and its signature record -- is kept in the
//! inventory, a file. This binds those facts with an HMAC-SHA256 tag under a key that only this
//! user's Windows logon can unwrap (DPAPI), so a record changed, copied between copies, or made
//! by anyone without that key does not verify, and the copy's code does not run.
//!
//! **What it protects against** (the boundary): changes made without the user's DPAPI keys --
//! the inventory edited offline or from another account, a profile copied to another machine,
//! a tool or person rewriting the JSON (a digest and a signature record made to match changed
//! files), records swapped between copies. **What it does not**: a process running as the same
//! user can ask DPAPI to unwrap the key, as Yavin does, and so forge a record; an administrator
//! can do anything. No user-mode design can stop those without a separate, more privileged
//! principal holding the key (a service): that is a release decision, not this module's claim
//! (ARCHITECTURE.md, EXT-19).
//!
//! **The key**: 32 random bytes (the system RNG), stored DPAPI-protected (current user) in
//! `<extensions>/trust-key.dpapi`, created once -- atomically, so two Yavins agree on one -- and
//! identified by the first 16 hex digits of its SHA-256. A key file that cannot be unwrapped
//! (another user, another machine, damage) is kept aside and a new key made: every record made
//! under the old one then fails, closed, until its copy is reinstalled. Rotation is the same:
//! a new key, reinstalls. Without DPAPI (not Windows) there is no key: no record verifies, so no
//! executable extension runs (they are Windows-only).

use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::package_trust::SignatureRecord;

/// The trust record format: part of what is tagged, so a record of another format never verifies.
pub const RECORD_SCHEMA: u32 = 1;
/// The key file, in the extensions folder.
pub const KEY_FILE: &str = "trust-key.dpapi";
/// What the tag is of (domain separation from any other use of the key).
const DOMAIN: &str = "Yavin.ExtensionTrust";

/// The tag on a copy's trust facts.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrustRecord {
    pub schema: u32,
    /// The key it was made with (`TrustKey::id`).
    pub key_id: String,
    /// HMAC-SHA256, hex.
    pub mac: String,
}

/// The facts a record binds -- everything a trust decision rests on.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustFacts<'a> {
    pub id: &'a str,
    pub version: &'a str,
    pub folder: &'a str,
    pub sha256: Option<&'a str>,
    pub files_sha256: Option<&'a str>,
    pub source: &'a str,
    pub signature: Option<&'a SignatureRecord>,
}

/// Why a record does not verify.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrustFailure {
    /// None was made (installed before EXT-19, or without a key).
    Missing,
    /// Another format.
    Schema,
    /// Made with another key (lost, replaced, another machine).
    Key,
    /// The facts or the tag were changed.
    Mismatch,
    /// No key can be had (no DPAPI, or it failed).
    Unavailable,
}

impl TrustFailure {
    pub fn code(self) -> &'static str {
        match self {
            TrustFailure::Missing => "missing",
            TrustFailure::Schema => "schema",
            TrustFailure::Key => "key",
            TrustFailure::Mismatch => "mismatch",
            TrustFailure::Unavailable => "unavailable",
        }
    }
}

pub struct TrustKey {
    pub id: String,
    bytes: [u8; 32],
}

impl TrustKey {
    pub fn from_bytes(bytes: [u8; 32]) -> TrustKey {
        let id = crate::extension_package::hex(&Sha256::digest(bytes))[..16].to_string();
        TrustKey { id, bytes }
    }

    fn mac(&self, schema: u32, key_id: &str, facts: &TrustFacts) -> Hmac<Sha256> {
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.bytes).expect("any key length");
        mac.update(DOMAIN.as_bytes());
        mac.update(&[0]);
        mac.update(&schema.to_le_bytes());
        mac.update(key_id.as_bytes());
        mac.update(&[0]);
        // A fixed field order (the struct's): the same facts are always the same bytes.
        mac.update(&serde_json::to_vec(facts).unwrap_or_default());
        mac
    }

    pub fn seal(&self, facts: &TrustFacts) -> TrustRecord {
        TrustRecord {
            schema: RECORD_SCHEMA,
            key_id: self.id.clone(),
            mac: crate::extension_package::hex(
                &self
                    .mac(RECORD_SCHEMA, &self.id, facts)
                    .finalize()
                    .into_bytes(),
            ),
        }
    }

    pub fn verify(&self, facts: &TrustFacts, record: &TrustRecord) -> Result<(), TrustFailure> {
        if record.schema != RECORD_SCHEMA {
            return Err(TrustFailure::Schema);
        }
        if record.key_id != self.id {
            return Err(TrustFailure::Key);
        }
        let given = decode_hex(&record.mac).ok_or(TrustFailure::Mismatch)?;
        // Compared in constant time (the hmac crate's verify).
        self.mac(record.schema, &record.key_id, facts)
            .verify_slice(&given)
            .map_err(|_| TrustFailure::Mismatch)
    }
}

fn decode_hex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(text.get(i..i + 2)?, 16).ok())
        .collect()
}

/// Where the key is kept.
pub trait TrustKeyStore: Send + Sync {
    /// The key for the extensions folder `root`, made if there is none -- and a note when an
    /// unreadable one was kept aside.
    fn key(&self, root: &Path) -> Result<(TrustKey, Option<String>), String>;
}

/// No key anywhere: nothing verifies (a platform without DPAPI).
#[cfg_attr(all(windows, not(test)), allow(dead_code))]
pub struct Unavailable;

impl TrustKeyStore for Unavailable {
    fn key(&self, _: &Path) -> Result<(TrustKey, Option<String>), String> {
        Err("this platform has no protected store for Yavin's trust key".into())
    }
}

/// The platform's key store: DPAPI (current user) on Windows; none elsewhere.
pub fn platform() -> Arc<dyn TrustKeyStore> {
    #[cfg(windows)]
    {
        Arc::new(dpapi::Dpapi)
    }
    #[cfg(not(windows))]
    {
        Arc::new(Unavailable)
    }
}

#[cfg(windows)]
pub mod dpapi {
    use super::*;
    use std::fs;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        BCryptGenRandom, CryptProtectData, CryptUnprotectData, BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    /// What DPAPI mixes in besides the user's keys: a blob for another purpose does not unwrap.
    const ENTROPY: &[u8] = b"Yavin.ExtensionTrust.v1";

    pub struct Dpapi;

    fn blob(bytes: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB {
            cbData: bytes.len() as u32,
            pbData: bytes.as_ptr() as *mut u8,
        }
    }

    fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        // SAFETY: DPAPI allocated `cbData` bytes at `pbData` (LocalAlloc); copied, then freed.
        let bytes = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize) }.to_vec();
        unsafe { LocalFree(out.pbData as _) };
        bytes
    }

    pub fn protect(secret: &[u8]) -> Result<Vec<u8>, String> {
        let input = blob(secret);
        let entropy = blob(ENTROPY);
        let mut out = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        // SAFETY: the blobs point at live slices for the call; `out` is DPAPI's to fill.
        let ok = unsafe {
            CryptProtectData(
                &input,
                std::ptr::null(),
                &entropy,
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        };
        if ok == 0 {
            return Err(format!(
                "the key could not be protected ({})",
                std::io::Error::last_os_error()
            ));
        }
        Ok(take(out))
    }

    pub fn unprotect(sealed: &[u8]) -> Result<Vec<u8>, String> {
        let input = blob(sealed);
        let entropy = blob(ENTROPY);
        let mut out = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        // SAFETY: as in `protect`.
        let ok = unsafe {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                &entropy,
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        };
        if ok == 0 {
            return Err(format!(
                "the key could not be unwrapped ({})",
                std::io::Error::last_os_error()
            ));
        }
        Ok(take(out))
    }

    fn random() -> Result<[u8; 32], String> {
        let mut bytes = [0u8; 32];
        // SAFETY: the buffer is 32 writable bytes.
        let status = unsafe {
            BCryptGenRandom(
                std::ptr::null_mut(),
                bytes.as_mut_ptr(),
                bytes.len() as u32,
                BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            )
        };
        if status != 0 {
            return Err(format!("no random key could be made (status {status:#x})"));
        }
        Ok(bytes)
    }

    fn read(file: &Path) -> Result<Option<TrustKey>, String> {
        let sealed = match fs::read(file) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(format!("the key file cannot be read ({e})")),
        };
        let bytes = unprotect(&sealed)?;
        let bytes: [u8; 32] = bytes
            .try_into()
            .map_err(|_| "the key file does not hold a key".to_string())?;
        Ok(Some(TrustKey::from_bytes(bytes)))
    }

    impl TrustKeyStore for Dpapi {
        fn key(&self, root: &Path) -> Result<(TrustKey, Option<String>), String> {
            let file = root.join(KEY_FILE);
            let mut note = None;
            match read(&file) {
                Ok(Some(key)) => return Ok((key, None)),
                Ok(None) => {}
                Err(why) if file.exists() => {
                    // Not unwrappable here: kept aside (never deleted), a new key made. Every
                    // record made under the old one now fails, closed.
                    let aside: PathBuf = root.join(format!(
                        "{KEY_FILE}.unreadable-{}.bak",
                        ide_workspace::durable::now_millis()
                    ));
                    fs::rename(&file, &aside)
                        .map_err(|e| format!("{why}; and it could not be kept aside ({e})"))?;
                    note = Some(format!(
                        "Yavin's trust key could not be used ({why}); it was kept as {} and a new one made. Extensions with code must be reinstalled before they run.",
                        aside.display()
                    ));
                }
                Err(why) => return Err(why),
            }
            fs::create_dir_all(root).map_err(|e| format!("the key cannot be kept ({e})"))?;
            let sealed = protect(&random()?)?;
            // Made once: written beside, then linked into place only if no key is there yet --
            // so two Yavins starting together agree on the first one made.
            // A name of this attempt's own (another process, or another thread here, may be
            // making one at the same moment).
            static ATTEMPT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let attempt = ATTEMPT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let temp = root.join(format!("{KEY_FILE}.new-{}-{attempt}", std::process::id()));
            ide_workspace::durable::write_durably(&temp, &sealed)
                .map_err(|e| format!("the key cannot be kept ({e})"))?;
            let linked = fs::hard_link(&temp, &file);
            let _ = fs::remove_file(&temp);
            if let Err(e) = linked {
                if e.kind() != std::io::ErrorKind::AlreadyExists {
                    return Err(format!("the key cannot be kept ({e})"));
                }
            }
            let key = read(&file)?.ok_or("the key was not kept")?;
            Ok((key, note))
        }
    }
}

#[cfg(test)]
#[path = "extension_trust_tests.rs"]
mod tests;
