//! Extension secrets (EXT-13): small values an extension keeps for itself -- a token, a key --
//! in the operating system's credential store, never in settings, `localStorage`, logs or the
//! window.
//!
//! - **Where.** Windows: the user's Credential Manager (generic credentials, persisted for this
//!   user on this machine, encrypted by Windows with DPAPI under the user's logon). It protects
//!   them at rest and from other users; it does **not** protect them from programs running as
//!   the same user, which can read the user's credentials (an OS limit). It is not hardware-backed
//!   unless Windows itself is configured so. Elsewhere there is no backend: every operation fails
//!   (`SecretStorageUnavailable`) -- never a plaintext fallback.
//! - **Whose.** A secret is named by Yavin's extension root (`namespace`), the profile, its scope
//!   (the installation, or one workspace) and the extension's canonical id, and its stored value
//!   carries its owner: that id and the copy's install origin (`registry <url>`, `openvsx <url>`,
//!   `file`, `development`, `unknown`). A read by a copy of another origin -- an unrelated
//!   package installed under the same id, a copy rebuilt by recovery -- is refused
//!   (`SecretOwnerChanged`); it may overwrite or delete it, never read it.
//! - **Who asks.** Only the native host layer, for a request of an extension whose id the host
//!   stamped and whose copy holds the `secrets` grant (EXT-07); the window never sees a value.
//! - **What is said.** Errors name the operation and the key's name, never a value.

use sha2::{Digest, Sha256};
use std::sync::Arc;

/// The longest secret value, in UTF-8 bytes (Credential Manager keeps at most 2560 per entry).
pub const MAX_VALUE: usize = 1024;
/// The longest key name.
pub const MAX_KEY: usize = 128;
const BLOB_VERSION: u64 = 1;
const PREFIX: &str = "Yavin.ExtensionSecrets";

/// Where secrets are kept: an OS credential store, by target name.
pub trait SecretBackend: Send + Sync {
    fn read(&self, target: &str) -> Result<Option<Vec<u8>>, String>;
    fn write(&self, target: &str, comment: &str, blob: &[u8]) -> Result<(), String>;
    fn delete(&self, target: &str) -> Result<bool, String>;
    /// Every target that starts with `prefix`.
    fn list(&self, prefix: &str) -> Result<Vec<String>, String>;
    /// Whether there is a store at all (`Unavailable` is none).
    fn available(&self) -> bool {
        true
    }
}

/// No credential store on this platform: nothing is kept anywhere.
#[cfg_attr(all(windows, not(test)), allow(dead_code))]
pub struct Unavailable;

impl SecretBackend for Unavailable {
    fn read(&self, _: &str) -> Result<Option<Vec<u8>>, String> {
        Err(UNAVAILABLE.into())
    }
    fn write(&self, _: &str, _: &str, _: &[u8]) -> Result<(), String> {
        Err(UNAVAILABLE.into())
    }
    fn delete(&self, _: &str) -> Result<bool, String> {
        Err(UNAVAILABLE.into())
    }
    fn list(&self, _: &str) -> Result<Vec<String>, String> {
        Err(UNAVAILABLE.into())
    }
    fn available(&self) -> bool {
        false
    }
}

#[cfg_attr(all(windows, not(test)), allow(dead_code))]
const UNAVAILABLE: &str = "this platform has no credential store Yavin uses";

/// The credential store of this platform (Windows: Credential Manager), or none.
pub fn platform() -> Arc<dyn SecretBackend> {
    #[cfg(windows)]
    {
        Arc::new(windows::CredentialManager)
    }
    #[cfg(not(windows))]
    {
        Arc::new(Unavailable)
    }
}

#[cfg(windows)]
pub mod windows {
    use super::SecretBackend;
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_NOT_FOUND};
    use windows_sys::Win32::Security::Credentials::{
        CredDeleteW, CredEnumerateW, CredFree, CredReadW, CredWriteW, CREDENTIALW,
        CRED_MAX_CREDENTIAL_BLOB_SIZE, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
    };

    pub struct CredentialManager;

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn failed(what: &str) -> String {
        // SAFETY: reads this thread's last error.
        format!(
            "the credential store could not {what} (Windows error {})",
            unsafe { GetLastError() }
        )
    }

    impl SecretBackend for CredentialManager {
        fn read(&self, target: &str) -> Result<Option<Vec<u8>>, String> {
            let name = wide(target);
            let mut found: *mut CREDENTIALW = null_mut();
            // SAFETY: a NUL-terminated name; `found` is freed with CredFree once read.
            unsafe {
                if CredReadW(name.as_ptr(), CRED_TYPE_GENERIC, 0, &mut found) == 0 {
                    return if GetLastError() == ERROR_NOT_FOUND {
                        Ok(None)
                    } else {
                        Err(failed("read"))
                    };
                }
                let credential = &*found;
                let blob = if credential.CredentialBlob.is_null() {
                    Vec::new()
                } else {
                    std::slice::from_raw_parts(
                        credential.CredentialBlob,
                        credential.CredentialBlobSize as usize,
                    )
                    .to_vec()
                };
                CredFree(found as _);
                Ok(Some(blob))
            }
        }

        fn write(&self, target: &str, comment: &str, blob: &[u8]) -> Result<(), String> {
            if blob.len() > CRED_MAX_CREDENTIAL_BLOB_SIZE as usize {
                return Err("the secret is larger than the credential store keeps".into());
            }
            let mut name = wide(target);
            let mut note = wide(comment);
            let mut user = wide("yavin-extension");
            // SAFETY: a zeroed CREDENTIALW given its fields; every buffer lives for the call.
            let credential = CREDENTIALW {
                Type: CRED_TYPE_GENERIC,
                TargetName: name.as_mut_ptr(),
                Comment: note.as_mut_ptr(),
                CredentialBlobSize: blob.len() as u32,
                CredentialBlob: blob.as_ptr() as *mut u8,
                Persist: CRED_PERSIST_LOCAL_MACHINE,
                UserName: user.as_mut_ptr(),
                ..unsafe { std::mem::zeroed() }
            };
            // SAFETY: the structure and its buffers are valid for the call.
            if unsafe { CredWriteW(&credential, 0) } == 0 {
                return Err(failed("write"));
            }
            Ok(())
        }

        fn delete(&self, target: &str) -> Result<bool, String> {
            let name = wide(target);
            // SAFETY: a NUL-terminated name.
            unsafe {
                if CredDeleteW(name.as_ptr(), CRED_TYPE_GENERIC, 0) == 0 {
                    return if GetLastError() == ERROR_NOT_FOUND {
                        Ok(false)
                    } else {
                        Err(failed("delete"))
                    };
                }
            }
            Ok(true)
        }

        fn list(&self, prefix: &str) -> Result<Vec<String>, String> {
            let filter = wide(&format!("{prefix}*"));
            let mut count = 0u32;
            let mut found: *mut *mut CREDENTIALW = null_mut();
            // SAFETY: a NUL-terminated filter; the array is freed with CredFree once read.
            unsafe {
                if CredEnumerateW(filter.as_ptr(), 0, &mut count, &mut found) == 0 {
                    return if GetLastError() == ERROR_NOT_FOUND {
                        Ok(Vec::new())
                    } else {
                        Err(failed("list"))
                    };
                }
                let mut targets = Vec::new();
                for n in 0..count as usize {
                    let credential = &**found.add(n);
                    if credential.TargetName.is_null() {
                        continue;
                    }
                    let mut len = 0;
                    while *credential.TargetName.add(len) != 0 {
                        len += 1;
                    }
                    let name = String::from_utf16_lossy(std::slice::from_raw_parts(
                        credential.TargetName,
                        len,
                    ));
                    if name.starts_with(prefix) {
                        targets.push(name);
                    }
                }
                CredFree(found as _);
                let _ = null::<u8>();
                Ok(targets)
            }
        }
    }
}

/// Who a secret belongs to: the extension and the origin of its installed copy.
#[derive(Clone, Debug, PartialEq)]
pub struct SecretOwner {
    pub id: String,
    pub origin: String,
}

/// Where a secret is kept: a profile, and the installation or one workspace.
#[derive(Clone, Debug, PartialEq)]
pub struct SecretScope {
    pub profile: String,
    /// The workspace's canonical root, for a workspace secret.
    pub workspace: Option<String>,
}

/// What a stored secret is.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Blob {
    v: u64,
    id: String,
    origin: String,
    value: String,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn short_hash(text: &str) -> String {
    hex(&Sha256::digest(text.as_bytes())[..12])
}

fn invalid(why: &str) -> String {
    format!("SecretInvalid: {why}.")
}

/// A key name: what an extension calls one of its secrets.
fn check_key(key: &str) -> Result<(), String> {
    let ok = (1..=MAX_KEY).contains(&key.len())
        && key.as_bytes()[0].is_ascii_alphanumeric()
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
    if ok {
        Ok(())
    } else {
        Err(invalid(&format!(
            "a secret's name is 1 to {MAX_KEY} letters, digits, '.', '_' or '-', starting with a letter or digit"
        )))
    }
}

fn check_profile(profile: &str) -> Result<(), String> {
    let ok = (1..=32).contains(&profile.len())
        && profile
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    if ok {
        Ok(())
    } else {
        Err(invalid("not a profile"))
    }
}

/// An extension's secrets in one Yavin installation (its extensions folder).
pub struct SecretStore {
    backend: Arc<dyn SecretBackend>,
    namespace: String,
}

impl SecretStore {
    /// The secrets of the Yavin whose extensions are in `root`.
    pub fn new(backend: Arc<dyn SecretBackend>, root: &std::path::Path) -> SecretStore {
        let canonical = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
        SecretStore {
            backend,
            namespace: short_hash(&canonical.to_string_lossy().to_lowercase()),
        }
    }

    /// Whether this platform has a credential store.
    pub fn available(&self) -> bool {
        self.backend.available()
    }

    fn base(&self) -> String {
        format!("{PREFIX}/{}/", self.namespace)
    }

    fn target(&self, owner: &str, scope: &SecretScope, key: &str) -> Result<String, String> {
        if ide_workspace::extension_id::canonical_id(owner).as_deref() != Some(owner) {
            return Err(invalid("not an extension"));
        }
        check_profile(&scope.profile)?;
        check_key(key)?;
        let place = match &scope.workspace {
            None => "installation".to_string(),
            Some(root) => format!("workspace-{}", short_hash(&root.to_lowercase())),
        };
        Ok(format!(
            "{}{}/{}/{owner}/{key}",
            self.base(),
            scope.profile,
            place
        ))
    }

    fn unavailable(why: String) -> String {
        format!("SecretStorageUnavailable: {why}; nothing was read or kept.")
    }

    /// `key`'s value, if `owner` keeps one in `scope`.
    pub fn get(
        &self,
        owner: &SecretOwner,
        scope: &SecretScope,
        key: &str,
    ) -> Result<Option<String>, String> {
        let target = self.target(&owner.id, scope, key)?;
        let Some(bytes) = self.backend.read(&target).map_err(Self::unavailable)? else {
            return Ok(None);
        };
        let blob: Blob = serde_json::from_slice(&bytes)
            .ok()
            .filter(|b: &Blob| b.v == BLOB_VERSION)
            .ok_or_else(|| format!("SecretCorrupted: the secret \"{key}\" cannot be read; delete it and store it again."))?;
        if blob.id != owner.id || blob.origin != owner.origin {
            return Err(format!(
                "SecretOwnerChanged: the secret \"{key}\" was kept by another copy of {} (installed from elsewhere); it is not readable by this one.",
                owner.id
            ));
        }
        Ok(Some(blob.value))
    }

    /// Keeps `value` as `key` for `owner` in `scope` (over whatever was there).
    pub fn store(
        &self,
        owner: &SecretOwner,
        scope: &SecretScope,
        key: &str,
        value: &str,
    ) -> Result<(), String> {
        let target = self.target(&owner.id, scope, key)?;
        if value.len() > MAX_VALUE {
            return Err(format!(
                "SecretTooLarge: a secret is at most {MAX_VALUE} bytes."
            ));
        }
        let blob = serde_json::to_vec(&Blob {
            v: BLOB_VERSION,
            id: owner.id.clone(),
            origin: owner.origin.clone(),
            value: value.to_string(),
        })
        .map_err(|_| invalid("not storable"))?;
        let comment = format!("Yavin extension secret: {} ({key})", owner.id);
        self.backend
            .write(&target, &comment, &blob)
            .map_err(Self::unavailable)
    }

    /// Deletes `key` of `owner` in `scope`; whether there was one.
    pub fn delete(
        &self,
        owner: &SecretOwner,
        scope: &SecretScope,
        key: &str,
    ) -> Result<bool, String> {
        let target = self.target(&owner.id, scope, key)?;
        self.backend.delete(&target).map_err(Self::unavailable)
    }

    /// Deletes every secret `which` picks among this installation's; how many.
    fn forget(&self, which: impl Fn(&[&str]) -> bool) -> Result<usize, String> {
        let base = self.base();
        let mut gone = 0;
        for target in self.backend.list(&base).map_err(Self::unavailable)? {
            let parts: Vec<&str> = target[base.len()..].split('/').collect();
            // profile / place / extension / key
            if parts.len() == 4
                && which(&parts)
                && self.backend.delete(&target).map_err(Self::unavailable)?
            {
                gone += 1;
            }
        }
        Ok(gone)
    }

    /// Deletes every secret of extension `id`, in every profile and scope (it was uninstalled).
    pub fn forget_extension(&self, id: &str) -> Result<usize, String> {
        self.forget(|parts| parts[2] == id)
    }

    /// Deletes every secret kept in `profile` (it was deleted).
    pub fn forget_profile(&self, profile: &str) -> Result<usize, String> {
        self.forget(|parts| parts[0] == profile)
    }
}

#[cfg(test)]
#[path = "extension_secrets_tests.rs"]
pub(crate) mod tests;
