//! EXT-33 (Q5 → C2): deterministic AppContainer identity for a contained server.
//!
//! A C2 server runs in an AppContainer whose name is **derived**, never chosen by a renderer or an
//! extension. The name is a function of three trusted, native-sourced inputs:
//!
//! - the loaded extension copy's identity (version + package hash, from `HostCopy`, EXT-08/19);
//! - the capability class (so one class's grant is never reachable by another's container);
//! - the canonical workspace root (so a grant for one workspace is never reachable from another).
//!
//! The name is `Yavin.<class>.<version>.<32 hex>`, where the hex is a domain-separated SHA-256 over
//! the `(version, class, copy, canonical-root)` tuple. Because
//! `DeriveAppContainerSidFromAppContainerName` is deterministic, the same name always yields the
//! same SID — so the SID the sandbox token carries, the SID the workspace ACL is granted to, and
//! the SID this identity names are one and the same. The caller must pass values it read from
//! native records; nothing a window or extension sends may reach this directly, and an extension
//! cannot steer the derivation toward another copy, class or workspace.

use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// The capability class a container identity is for. The class is part of the identity, so a
/// workspace granted to a C2 server's container is not reachable by any other class's container.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CapabilityClass {
    /// Contained server with read-only workspace access (E5).
    C2,
    /// Reserved for contained execution (E6); present so class separation is derivable and tested.
    C3,
}

impl CapabilityClass {
    fn tag(self) -> &'static str {
        match self {
            CapabilityClass::C2 => "c2",
            CapabilityClass::C3 => "c3",
        }
    }
}

/// Why an identity could not be derived. Every path fails closed: no name is produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdentityError {
    /// The copy identity was empty.
    EmptyCopyId,
    /// The copy identity held a control character (which would blur the field separators).
    InvalidCopyId(String),
    /// The workspace root is not an existing directory.
    NotADirectory,
    /// The workspace root could not be canonicalized (the reason).
    Canonicalize(String),
}

/// The identity-format version. It is baked into both the hashed input **and** the name prefix, so
/// a future change re-derives every identity; old grants (bound to the old name) then simply stop
/// matching and the user is asked again. Bump this only with a deliberate migration.
pub const IDENTITY_VERSION: &str = "v1";

/// A derived AppContainer identity: the name, the canonical workspace root it is bound to, and the
/// class. The canonical root is exactly what the ACL manager and `may_start` must be given.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContainerIdentity {
    pub name: String,
    pub workspace_root: PathBuf,
    pub class: CapabilityClass,
}

/// Derive the deterministic AppContainer identity from trusted native records. The workspace root
/// is canonicalized (must be an existing directory) and matched case-insensitively, so two
/// spellings of one directory yield one identity while distinct directories never collide.
pub fn derive(
    copy_id: &str,
    class: CapabilityClass,
    workspace_root: &Path,
) -> Result<ContainerIdentity, IdentityError> {
    if copy_id.is_empty() {
        return Err(IdentityError::EmptyCopyId);
    }
    // 0x1f is the implicit field boundary a control char could forge; reject all control chars.
    if copy_id.bytes().any(|b| b < 0x20) {
        return Err(IdentityError::InvalidCopyId(copy_id.to_string()));
    }
    if !workspace_root.is_dir() {
        return Err(IdentityError::NotADirectory);
    }
    let canonical = std::fs::canonicalize(workspace_root)
        .map_err(|e| IdentityError::Canonicalize(e.to_string()))?;
    let canonical = strip_verbatim(&canonical);
    // Windows paths are case-insensitive; normalize so two spellings of one directory agree. Only
    // the hash input is lowercased -- the stored root keeps its on-disk casing for the ACL APIs.
    let root_key = canonical.to_string_lossy().to_lowercase();

    // Length-prefix every field so no two distinct tuples can serialize to the same bytes.
    let mut hasher = Sha256::new();
    for field in [IDENTITY_VERSION, class.tag(), copy_id, root_key.as_str()] {
        hasher.update((field.len() as u64).to_le_bytes());
        hasher.update(field.as_bytes());
    }
    let digest = hasher.finalize();
    let hex: String = digest.iter().take(16).map(|b| format!("{b:02x}")).collect();
    let name = format!("Yavin.{}.{}.{}", class.tag(), IDENTITY_VERSION, hex);
    Ok(ContainerIdentity {
        name,
        workspace_root: canonical,
        class,
    })
}

/// Strip a `\\?\` verbatim prefix so the path matches what the ACL grant and journal store.
fn strip_verbatim(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    PathBuf::from(
        s.strip_prefix(r"\\?\")
            .map(str::to_string)
            .unwrap_or_else(|| s.into_owned()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temp(label: &str) -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "yavin-identity-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    const COPY: &str = "acme.ext@1.2.3#deadbeef";

    #[test]
    fn derivation_is_deterministic() {
        let dir = temp("det");
        let a = derive(COPY, CapabilityClass::C2, &dir).unwrap();
        let b = derive(COPY, CapabilityClass::C2, &dir).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn the_name_is_a_valid_appcontainer_name() {
        let dir = temp("shape");
        let id = derive(COPY, CapabilityClass::C2, &dir).unwrap();
        assert!(id.name.starts_with("Yavin.c2.v1."), "{}", id.name);
        assert!(id.name.len() <= 64, "len {}", id.name.len());
        assert!(id
            .name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-'));
    }

    #[test]
    fn path_aliases_map_to_one_identity() {
        let dir = temp("alias");
        let plain = derive(COPY, CapabilityClass::C2, &dir).unwrap();
        // A trailing `.` component and a trailing separator are the same directory.
        let dotted = derive(COPY, CapabilityClass::C2, &dir.join(".")).unwrap();
        let trailing = derive(
            COPY,
            CapabilityClass::C2,
            Path::new(&format!("{}\\", dir.display())),
        )
        .unwrap_or_else(|_| plain.clone());
        assert_eq!(plain.name, dotted.name, "`.` alias");
        assert_eq!(plain.name, trailing.name, "trailing separator alias");
        // An upper-cased spelling of the same path resolves to the same directory and identity.
        let upper = PathBuf::from(dir.to_string_lossy().to_uppercase());
        if upper.is_dir() {
            assert_eq!(
                plain.name,
                derive(COPY, CapabilityClass::C2, &upper).unwrap().name,
                "case alias"
            );
        }
    }

    #[test]
    fn a_different_copy_derives_a_different_identity() {
        let dir = temp("copy");
        let a = derive(COPY, CapabilityClass::C2, &dir).unwrap();
        let b = derive("acme.ext@2.0.0#feedface", CapabilityClass::C2, &dir).unwrap();
        assert_ne!(a.name, b.name);
    }

    #[test]
    fn a_different_class_derives_a_different_identity() {
        let dir = temp("class");
        let c2 = derive(COPY, CapabilityClass::C2, &dir).unwrap();
        let c3 = derive(COPY, CapabilityClass::C3, &dir).unwrap();
        assert_ne!(c2.name, c3.name, "classes must not share a container");
    }

    #[test]
    fn a_different_workspace_derives_a_different_identity() {
        let a_dir = temp("ws-a");
        let b_dir = temp("ws-b");
        let a = derive(COPY, CapabilityClass::C2, &a_dir).unwrap();
        let b = derive(COPY, CapabilityClass::C2, &b_dir).unwrap();
        assert_ne!(a.name, b.name);
    }

    #[test]
    fn invalid_inputs_fail_closed() {
        let dir = temp("invalid");
        assert_eq!(
            derive("", CapabilityClass::C2, &dir),
            Err(IdentityError::EmptyCopyId)
        );
        assert_eq!(
            derive("has\u{1f}sep", CapabilityClass::C2, &dir),
            Err(IdentityError::InvalidCopyId("has\u{1f}sep".into()))
        );
        assert_eq!(
            derive(COPY, CapabilityClass::C2, &dir.join("does-not-exist")),
            Err(IdentityError::NotADirectory)
        );
    }
}
