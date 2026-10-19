//! EXT-13 secrets: ownership, scope, limits, failures -- against an in-memory backend for the
//! rules, and against the real Windows Credential Manager for what the OS actually does.

use super::*;
use std::collections::BTreeMap;
use std::sync::Mutex;

/// A credential store in memory (tests only -- it is not secure storage).
#[derive(Default)]
pub(crate) struct MemoryBackend(pub Mutex<BTreeMap<String, Vec<u8>>>);

impl SecretBackend for MemoryBackend {
    fn read(&self, target: &str) -> Result<Option<Vec<u8>>, String> {
        Ok(self.0.lock().unwrap().get(target).cloned())
    }
    fn write(&self, target: &str, _: &str, blob: &[u8]) -> Result<(), String> {
        self.0.lock().unwrap().insert(target.into(), blob.to_vec());
        Ok(())
    }
    fn delete(&self, target: &str) -> Result<bool, String> {
        Ok(self.0.lock().unwrap().remove(target).is_some())
    }
    fn list(&self, prefix: &str) -> Result<Vec<String>, String> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .keys()
            .filter(|k| k.starts_with(prefix))
            .cloned()
            .collect())
    }
}

/// A store that is locked or broken: every call fails.
pub(crate) struct Failing;

impl SecretBackend for Failing {
    fn read(&self, _: &str) -> Result<Option<Vec<u8>>, String> {
        Err("the store is locked".into())
    }
    fn write(&self, _: &str, _: &str, _: &[u8]) -> Result<(), String> {
        Err("the store is locked".into())
    }
    fn delete(&self, _: &str) -> Result<bool, String> {
        Err("the store is locked".into())
    }
    fn list(&self, _: &str) -> Result<Vec<String>, String> {
        Err("the store is locked".into())
    }
}

pub(crate) fn owner(id: &str) -> SecretOwner {
    SecretOwner {
        id: id.into(),
        origin: "registry https://registry.test/".into(),
    }
}

pub(crate) fn installation(profile: &str) -> SecretScope {
    SecretScope {
        profile: profile.into(),
        workspace: None,
    }
}

fn memory() -> (Arc<MemoryBackend>, SecretStore) {
    let backend = Arc::new(MemoryBackend::default());
    let store = SecretStore::new(
        backend.clone(),
        std::path::Path::new("C:/yavin-test/extensions"),
    );
    (backend, store)
}

#[test]
fn an_extension_reads_back_what_it_stored_and_only_that() {
    let (_, store) = memory();
    let (a, b) = (owner("acme.one"), owner("acme.two"));
    let scope = installation("default");
    assert_eq!(store.get(&a, &scope, "token").unwrap(), None);
    store.store(&a, &scope, "token", "s3cr3t-of-one").unwrap();
    assert_eq!(
        store.get(&a, &scope, "token").unwrap().as_deref(),
        Some("s3cr3t-of-one")
    );
    // Another extension asking for the same name has its own (none).
    assert_eq!(store.get(&b, &scope, "token").unwrap(), None);
    store.store(&b, &scope, "token", "s3cr3t-of-two").unwrap();
    assert_eq!(
        store.get(&a, &scope, "token").unwrap().as_deref(),
        Some("s3cr3t-of-one")
    );
    assert!(store.delete(&a, &scope, "token").unwrap());
    assert!(!store.delete(&a, &scope, "token").unwrap());
    assert_eq!(store.get(&a, &scope, "token").unwrap(), None);
    assert_eq!(
        store.get(&b, &scope, "token").unwrap().as_deref(),
        Some("s3cr3t-of-two")
    );
}

#[test]
fn profiles_and_workspaces_keep_their_own() {
    let (_, store) = memory();
    let a = owner("acme.one");
    let work = installation("work");
    let home = installation("default");
    let w1 = SecretScope {
        profile: "default".into(),
        workspace: Some("C:/w1".into()),
    };
    let w2 = SecretScope {
        profile: "default".into(),
        workspace: Some("C:/w2".into()),
    };
    for (scope, value) in [(&work, "w"), (&home, "h"), (&w1, "1"), (&w2, "2")] {
        store.store(&a, scope, "token", value).unwrap();
    }
    for (scope, value) in [(&work, "w"), (&home, "h"), (&w1, "1"), (&w2, "2")] {
        assert_eq!(
            store.get(&a, scope, "token").unwrap().as_deref(),
            Some(value)
        );
    }
    // A workspace is one by its root, whatever its case.
    let w1_upper = SecretScope {
        profile: "default".into(),
        workspace: Some("C:/W1".into()),
    };
    assert_eq!(
        store.get(&a, &w1_upper, "token").unwrap().as_deref(),
        Some("1")
    );
    // Deleting a profile forgets its secrets, no other profile's.
    assert_eq!(store.forget_profile("work").unwrap(), 1);
    assert_eq!(store.get(&a, &work, "token").unwrap(), None);
    assert_eq!(store.get(&a, &home, "token").unwrap().as_deref(), Some("h"));
}

#[test]
fn another_copy_of_the_same_id_cannot_read_but_may_replace() {
    let (_, store) = memory();
    let scope = installation("default");
    store
        .store(
            &owner("acme.one"),
            &scope,
            "token",
            "kept-by-the-registry-copy",
        )
        .unwrap();
    let elsewhere = SecretOwner {
        id: "acme.one".into(),
        origin: "file".into(),
    };
    let error = store.get(&elsewhere, &scope, "token").unwrap_err();
    assert!(error.starts_with("SecretOwnerChanged"), "{error}");
    assert!(!error.contains("kept-by-the-registry-copy"), "{error}");
    // A recovery-rebuilt copy (origin unknown) is not the owner either.
    let rebuilt = SecretOwner {
        id: "acme.one".into(),
        origin: "unknown".into(),
    };
    assert!(store
        .get(&rebuilt, &scope, "token")
        .unwrap_err()
        .starts_with("SecretOwnerChanged"));
    // It may replace it -- then it is its own -- or delete it.
    store.store(&elsewhere, &scope, "token", "its-own").unwrap();
    assert_eq!(
        store.get(&elsewhere, &scope, "token").unwrap().as_deref(),
        Some("its-own")
    );
    assert!(store
        .get(&owner("acme.one"), &scope, "token")
        .unwrap_err()
        .starts_with("SecretOwnerChanged"));
}

#[test]
fn an_uninstalled_extensions_secrets_are_all_forgotten() {
    let (backend, store) = memory();
    for profile in ["default", "work"] {
        store
            .store(&owner("acme.one"), &installation(profile), "a", "1")
            .unwrap();
        store
            .store(
                &owner("acme.one"),
                &SecretScope {
                    profile: profile.into(),
                    workspace: Some("C:/w".into()),
                },
                "b",
                "2",
            )
            .unwrap();
        store
            .store(&owner("acme.two"), &installation(profile), "a", "3")
            .unwrap();
    }
    assert_eq!(store.forget_extension("acme.one").unwrap(), 4);
    let left: Vec<String> = backend.0.lock().unwrap().keys().cloned().collect();
    assert_eq!(left.len(), 2);
    assert!(left.iter().all(|t| t.contains("/acme.two/")), "{left:?}");
    // Another installation's (another extensions folder) are not touched.
    let other = SecretStore::new(
        backend.clone(),
        std::path::Path::new("D:/other-yavin/extensions"),
    );
    other
        .store(&owner("acme.two"), &installation("default"), "a", "x")
        .unwrap();
    assert_eq!(store.forget_extension("acme.two").unwrap(), 2);
    assert_eq!(
        other
            .get(&owner("acme.two"), &installation("default"), "a")
            .unwrap()
            .as_deref(),
        Some("x")
    );
}

#[test]
fn names_values_owners_and_scopes_are_validated() {
    let (_, store) = memory();
    let a = owner("acme.one");
    let scope = installation("default");
    for key in [
        "",
        "has space",
        "a/b",
        "..",
        &"k".repeat(MAX_KEY + 1),
        "ключ",
    ] {
        let error = store.store(&a, &scope, key, "v").unwrap_err();
        assert!(error.starts_with("SecretInvalid"), "{key:?}: {error}");
    }
    let error = store
        .store(&a, &scope, "big", &"x".repeat(MAX_VALUE + 1))
        .unwrap_err();
    assert!(error.starts_with("SecretTooLarge"), "{error}");
    assert!(!error.contains("xxxx"));
    for bad in ["Acme.One", "acme", "../acme.one"] {
        let forged = SecretOwner {
            id: bad.into(),
            origin: "file".into(),
        };
        assert!(
            store
                .store(&forged, &scope, "k", "v")
                .unwrap_err()
                .starts_with("SecretInvalid"),
            "{bad}"
        );
    }
    for profile in ["", "Work", "a/b", &"p".repeat(33)] {
        assert!(
            store
                .get(&a, &installation(profile), "k")
                .unwrap_err()
                .starts_with("SecretInvalid"),
            "{profile:?}"
        );
    }
}

#[test]
fn a_store_that_is_unavailable_or_corrupted_fails_closed_and_says_nothing_secret() {
    let failing = SecretStore::new(Arc::new(Failing), std::path::Path::new("C:/x"));
    let a = owner("acme.one");
    let scope = installation("default");
    for error in [
        failing
            .store(&a, &scope, "token", "do-not-leak-this")
            .unwrap_err(),
        failing.get(&a, &scope, "token").unwrap_err(),
        failing.delete(&a, &scope, "token").unwrap_err(),
        failing.forget_extension("acme.one").unwrap_err(),
    ] {
        assert!(error.starts_with("SecretStorageUnavailable"), "{error}");
        assert!(!error.contains("do-not-leak-this"), "{error}");
    }
    let none = SecretStore::new(Arc::new(Unavailable), std::path::Path::new("C:/x"));
    assert!(none
        .store(&a, &scope, "token", "v")
        .unwrap_err()
        .starts_with("SecretStorageUnavailable"));
    // A value that is not Yavin's (or tampered with) is not handed out.
    let (backend, store) = memory();
    store.store(&a, &scope, "token", "v").unwrap();
    for garbage in [
        b"not json".to_vec(),
        br#"{"v":9,"id":"acme.one","origin":"registry https://registry.test/","value":"x"}"#
            .to_vec(),
        br#"{"v":1,"id":"acme.two","origin":"registry https://registry.test/","value":"x"}"#
            .to_vec(),
    ] {
        let target = backend.0.lock().unwrap().keys().next().unwrap().clone();
        backend.0.lock().unwrap().insert(target, garbage);
        let error = store.get(&a, &scope, "token").unwrap_err();
        assert!(
            error.starts_with("SecretCorrupted") || error.starts_with("SecretOwnerChanged"),
            "{error}"
        );
    }
}

/// The real Windows Credential Manager: a secret written is kept by Windows (not in any file of
/// Yavin's), read back, listed, deleted -- in a namespace of this test's own, removed after.
#[cfg(windows)]
#[test]
fn the_windows_credential_manager_keeps_reads_and_deletes_a_secret() {
    let root = std::env::temp_dir().join(format!("yavin-ext13-credman-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let store = SecretStore::new(platform(), &root);
    let a = owner("acme.credman-test");
    let scope = installation("default");
    let value = "a-real-secret-value-for-the-test";
    store.store(&a, &scope, "token", value).unwrap();
    assert_eq!(
        store.get(&a, &scope, "token").unwrap().as_deref(),
        Some(value)
    );
    // Nothing of it in Yavin's folder: the OS keeps it.
    let in_files = walk(&root)
        .into_iter()
        .any(|bytes| String::from_utf8_lossy(&bytes).contains(value));
    assert!(!in_files);
    // Another origin cannot read it, from the real store too.
    let other = SecretOwner {
        id: a.id.clone(),
        origin: "file".into(),
    };
    assert!(store
        .get(&other, &scope, "token")
        .unwrap_err()
        .starts_with("SecretOwnerChanged"));
    // Listed under this installation, and forgotten with its extension.
    store
        .store(&a, &installation("work"), "other", "x")
        .unwrap();
    assert_eq!(store.forget_extension(&a.id).unwrap(), 2);
    assert_eq!(store.get(&a, &scope, "token").unwrap(), None);
    assert!(!store.delete(&a, &scope, "token").unwrap());
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(windows)]
fn walk(dir: &std::path::Path) -> Vec<Vec<u8>> {
    let mut all = Vec::new();
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.is_dir() {
            all.extend(walk(&path));
        } else if let Ok(bytes) = std::fs::read(&path) {
            all.push(bytes);
        }
    }
    all
}
