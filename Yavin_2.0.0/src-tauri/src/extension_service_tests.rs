//! EXT-02 acceptance tests: the inventory, install safety and recovery. Every test works in its
//! own temporary folder; "a restart" is a new `ExtensionService` over the same folder.

use super::*;
use crate::extension_package::tests::package;
use crate::extension_package::{unpack, LIMITS};
use crate::extensions::MANIFEST_FILE;
use crate::marketplace::{stage, PackageSource};
use crate::package_trust::SignatureStatus;
use std::collections::BTreeMap;
use std::time::Duration;

struct Fixture {
    dir: PathBuf,
    root: PathBuf,
    development: PathBuf,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn fixture(name: &str) -> Fixture {
    let dir = std::env::temp_dir().join(format!("yavin-ext02-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let root = dir.join("extensions");
    let development = dir.join("samples");
    fs::create_dir_all(&root).unwrap();
    fs::create_dir_all(&development).unwrap();
    Fixture {
        dir,
        root,
        development,
    }
}

impl Fixture {
    fn service(&self) -> ExtensionService {
        ExtensionService::new(self.root.clone(), vec![self.development.clone()])
    }

    /// A package of `id` at `version` (a folder of its own per package).
    fn package(&self, id: &str, version: &str) -> PathBuf {
        let (publisher, name) = id.split_once('.').unwrap();
        let at = self.dir.join("packages").join(format!("{id}-{version}"));
        fs::create_dir_all(&at).unwrap();
        let manifest = format!(
            r#"{{"publisher":"{publisher}","name":"{name}","version":"{version}","engines":{{"yavin":"^2.0.0"}},"main":"extension.js"}}"#
        );
        let code = format!("module.exports.version = '{version}';");
        package(
            &at,
            &[
                (MANIFEST_FILE, manifest.as_bytes()),
                ("extension.js", code.as_bytes()),
            ],
        )
    }

    /// An extension folder written by hand (an IDE-09 install, or a sample).
    fn folder(&self, at: &Path, folder: &str, manifest: &str) {
        fs::create_dir_all(at.join(folder)).unwrap();
        fs::write(at.join(folder).join(MANIFEST_FILE), manifest).unwrap();
        fs::write(at.join(folder).join("extension.js"), "module.exports = {};").unwrap();
    }
}

fn manifest(id: &str, version: &str) -> String {
    let (publisher, name) = id.split_once('.').unwrap();
    format!(
        r#"{{"publisher":"{publisher}","name":"{name}","version":"{version}","main":"extension.js"}}"#
    )
}

fn stage_file(
    service: &ExtensionService,
    pkg: &Path,
    id: &str,
    version: &str,
) -> Result<String, String> {
    stage(
        service,
        PackageSource::File {
            path: pkg.to_string_lossy().into(),
        },
        id,
        version,
    )
    .map(|staged| staged.token)
}

fn install(fx: &Fixture, service: &ExtensionService, id: &str, version: &str) {
    let op = stage_file(service, &fx.package(id, version), id, version).unwrap();
    service.commit(&op, id).unwrap();
    service.finish(&op, id, true).unwrap();
}

/// The one listed entry of `id`.
fn entry(service: &ExtensionService, id: &str) -> Listed {
    let listing = service.list(None).unwrap();
    let mut found: Vec<_> = listing
        .extensions
        .into_iter()
        .filter(|one| one.id.as_deref() == Some(id))
        .collect();
    assert_eq!(found.len(), 1, "one entry for {id}");
    found.remove(0)
}

fn version_listed(service: &ExtensionService, id: &str) -> String {
    let listed = entry(service, id);
    assert!(listed.error.is_none(), "{:?}", listed.error);
    identity(listed.manifest.as_deref().unwrap()).unwrap().1
}

fn inventory(fx: &Fixture) -> Inventory {
    serde_json::from_str(&fs::read_to_string(fx.root.join(INVENTORY)).unwrap()).unwrap()
}

fn store_copies(fx: &Fixture, id: &str) -> Vec<String> {
    let mut names: Vec<_> = fs::read_dir(fx.root.join(STORE).join(id))
        .map(|entries| {
            entries
                .flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

fn staging_entries(fx: &Fixture) -> usize {
    fs::read_dir(fx.root.join(STAGING))
        .map(|entries| entries.count())
        .unwrap_or(0)
}

/// Every file under `folder` with its bytes.
fn tree(folder: &Path) -> BTreeMap<String, Vec<u8>> {
    let mut files = BTreeMap::new();
    let mut pending = vec![folder.to_path_buf()];
    while let Some(next) = pending.pop() {
        for entry in fs::read_dir(&next).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
            } else {
                let relative = path
                    .strip_prefix(folder)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned();
                files.insert(relative, fs::read(&path).unwrap());
            }
        }
    }
    files
}

/// Scenario 1: listing while an install is staging leaves the operation's files alone.
#[test]
fn s01_listing_during_an_install_keeps_its_staging() {
    let fx = fixture("s01");
    let service = fx.service();
    let (op, folder) = service.begin("acme.hello", "1.0.0", "file").unwrap();
    fs::write(folder.join("package.yvx.partial"), b"half a download").unwrap();
    // Reloads and other windows' listings, while the download runs.
    std::thread::scope(|scope| {
        for _ in 0..4 {
            scope.spawn(|| {
                for _ in 0..10 {
                    service.list(None).unwrap();
                }
            });
        }
    });
    assert!(
        folder.join("package.yvx.partial").is_file(),
        "the staging was kept"
    );
    // The download finishes; the install completes.
    unpack(
        &fx.package("acme.hello", "1.0.0"),
        &folder.join("files"),
        &LIMITS,
    )
    .unwrap();
    service.staged(&op, &"ab".repeat(32)).unwrap();
    service.list(None).unwrap();
    service.commit(&op, "acme.hello").unwrap();
    service.finish(&op, "acme.hello", true).unwrap();
    assert_eq!(version_listed(&service, "acme.hello"), "1.0.0");

    // The same through the real staging path, with listings racing it on other threads.
    let pkg = fx.package("acme.other", "1.0.0");
    std::thread::scope(|scope| {
        let lister = scope.spawn(|| {
            for _ in 0..50 {
                service.list(None).unwrap();
            }
        });
        for _ in 0..5 {
            let op = stage_file(&service, &pkg, "acme.other", "1.0.0").unwrap();
            service.commit(&op, "acme.other").unwrap();
            service.finish(&op, "acme.other", true).unwrap();
        }
        lister.join().unwrap();
    });
    assert_eq!(version_listed(&service, "acme.other"), "1.0.0");
    assert_eq!(staging_entries(&fx), 0);
}

/// Scenario 2: uninstall cannot interleave with an install of the same id; one of another id
/// leaves the install alone.
#[test]
fn s02_uninstall_and_install_do_not_interleave() {
    let fx = fixture("s02");
    let service = fx.service();
    install(&fx, &service, "acme.hello", "1.0.0");
    install(&fx, &service, "acme.other", "1.0.0");
    let (op, folder) = service.begin("acme.hello", "2.0.0", "file").unwrap();
    let error = service.uninstall("acme.hello").unwrap_err();
    assert!(error.starts_with("Busy"), "{error}");
    assert_eq!(version_listed(&service, "acme.hello"), "1.0.0");
    // Another extension's uninstall, while this download runs.
    service.uninstall("acme.other").unwrap();
    assert!(folder.is_dir(), "the in-flight staging was kept");
    assert!(store_copies(&fx, "acme.other").is_empty());
    // A second install of the same id while the first runs is refused too.
    let busy = service.begin("acme.hello", "3.0.0", "file").unwrap_err();
    assert!(busy.starts_with("Busy"), "{busy}");

    unpack(
        &fx.package("acme.hello", "2.0.0"),
        &folder.join("files"),
        &LIMITS,
    )
    .unwrap();
    service.staged(&op, &"cd".repeat(32)).unwrap();
    // Staged and waiting for its window: still the window's; uninstall waits too.
    assert!(service
        .uninstall("acme.hello")
        .unwrap_err()
        .starts_with("Busy"));
    assert_eq!(version_listed(&service, "acme.hello"), "1.0.0");
    // Abandoned (its window went away): uninstall ends it first, then uninstalls.
    *service.abandoned_after.lock().unwrap() = Some(Duration::ZERO);
    service.uninstall("acme.hello").unwrap();
    let inv = inventory(&fx);
    assert!(
        inv.extensions.is_empty() && inv.operations.is_empty(),
        "{inv:?}"
    );
    assert_eq!(staging_entries(&fx), 0);
    assert!(store_copies(&fx, "acme.hello").is_empty());
    assert!(
        service.commit(&op, "acme.hello").is_err(),
        "nothing half-published"
    );

    // Committed but not finished:
    install(&fx, &service, "acme.hello", "1.0.0");
    let op = stage_file(
        &service,
        &fx.package("acme.hello", "2.0.0"),
        "acme.hello",
        "2.0.0",
    )
    .unwrap();
    service.commit(&op, "acme.hello").unwrap();
    // Abandoned after commit: uninstall keeps the commit, then removes everything.
    service.uninstall("acme.hello").unwrap();
    assert!(inventory(&fx).extensions.is_empty());
    assert!(store_copies(&fx, "acme.hello").is_empty());
    assert!(service.finish(&op, "acme.hello", false).is_err());
}

/// Scenario 3: an update that fails after publication rolls back to the previous version,
/// a listing in between notwithstanding (IDE-09's race B).
#[test]
fn s03_a_failed_update_keeps_the_previous_version() {
    let fx = fixture("s03");
    let service = fx.service();
    install(&fx, &service, "acme.hello", "1.0.0");
    let before = tree(&fx.root.join(STORE).join("acme.hello"));
    let op = stage_file(
        &service,
        &fx.package("acme.hello", "2.0.0"),
        "acme.hello",
        "2.0.0",
    )
    .unwrap();
    service.commit(&op, "acme.hello").unwrap();
    assert_eq!(version_listed(&service, "acme.hello"), "2.0.0");
    service.list(None).unwrap(); // a Reload between commit and finish
    service.finish(&op, "acme.hello", false).unwrap(); // the registry refused it
    assert_eq!(version_listed(&service, "acme.hello"), "1.0.0");
    assert_eq!(
        tree(&fx.root.join(STORE).join("acme.hello")),
        before,
        "1.0.0 is untouched; 2.0.0 is gone"
    );
    assert!(inventory(&fx).operations.is_empty());
}

/// Scenario 4: a crash after staging, before publication: the old version stays, the staging
/// is cleaned up on the next start.
#[test]
fn s04_a_crash_after_staging_keeps_the_old_version() {
    let fx = fixture("s04");
    let service = fx.service();
    install(&fx, &service, "acme.hello", "1.0.0");
    *service.crash_at.lock().unwrap() = Some("staged");
    let pkg = fx.package("acme.hello", "2.0.0");
    assert!(stage_file(&service, &pkg, "acme.hello", "2.0.0")
        .unwrap_err()
        .starts_with("Crashed"));
    assert_eq!(staging_entries(&fx), 1);
    drop(service);

    let service = fx.service();
    assert_eq!(version_listed(&service, "acme.hello"), "1.0.0");
    assert_eq!(staging_entries(&fx), 0);
    let inv = inventory(&fx);
    assert!(inv.operations.is_empty());
    assert!(inv
        .recoveries
        .last()
        .unwrap()
        .reason
        .contains("was discarded"));
    assert_eq!(store_copies(&fx, "acme.hello").len(), 1);
}

/// Scenario 5: a crash after the new copy is published, before the inventory switches to it:
/// the orphan is removed, the old version stays.
#[test]
fn s05_a_crash_after_publication_removes_the_orphan() {
    let fx = fixture("s05");
    let service = fx.service();
    install(&fx, &service, "acme.hello", "1.0.0");
    let old = store_copies(&fx, "acme.hello");
    let op = stage_file(
        &service,
        &fx.package("acme.hello", "2.0.0"),
        "acme.hello",
        "2.0.0",
    )
    .unwrap();
    *service.crash_at.lock().unwrap() = Some("published");
    assert!(service
        .commit(&op, "acme.hello")
        .unwrap_err()
        .starts_with("Crashed"));
    assert_eq!(
        store_copies(&fx, "acme.hello").len(),
        2,
        "published, not yet active"
    );
    drop(service);

    let service = fx.service();
    assert_eq!(version_listed(&service, "acme.hello"), "1.0.0");
    assert_eq!(store_copies(&fx, "acme.hello"), old);
    // Recovering again changes nothing.
    drop(service);
    let service = fx.service();
    assert_eq!(version_listed(&service, "acme.hello"), "1.0.0");
    assert_eq!(store_copies(&fx, "acme.hello"), old);
}

/// Scenario 6: a crash after the inventory switched: the new version is kept.
#[test]
fn s06_a_crash_after_the_switch_keeps_the_new_version() {
    let fx = fixture("s06");
    let service = fx.service();
    install(&fx, &service, "acme.hello", "1.0.0");
    let op = stage_file(
        &service,
        &fx.package("acme.hello", "2.0.0"),
        "acme.hello",
        "2.0.0",
    )
    .unwrap();
    *service.crash_at.lock().unwrap() = Some("switched");
    assert!(service
        .commit(&op, "acme.hello")
        .unwrap_err()
        .starts_with("Crashed"));
    drop(service);

    let service = fx.service();
    assert_eq!(version_listed(&service, "acme.hello"), "2.0.0");
    let inv = inventory(&fx);
    assert!(inv.operations.is_empty());
    assert!(inv
        .recoveries
        .last()
        .unwrap()
        .reason
        .contains("was completed"));
    // The version it replaced stays, as the fallback.
    assert_eq!(
        inv.extensions["acme.hello"]
            .previous
            .as_ref()
            .unwrap()
            .version,
        "1.0.0"
    );
    assert_eq!(store_copies(&fx, "acme.hello").len(), 2);
    assert_eq!(staging_entries(&fx), 0);
}

/// Scenario 7: the active copy's folder disappears: the previous version is used, and why is
/// recorded; with nothing to fall back to, the install is reported broken.
#[test]
fn s07_a_missing_active_folder_falls_back_or_is_reported() {
    let fx = fixture("s07");
    let service = fx.service();
    install(&fx, &service, "acme.hello", "1.0.0");
    install(&fx, &service, "acme.hello", "2.0.0");
    let active = inventory(&fx).extensions["acme.hello"]
        .active
        .folder
        .clone();
    fs::remove_dir_all(join(&fx.root, &active)).unwrap();

    assert_eq!(version_listed(&service, "acme.hello"), "1.0.0");
    let inv = inventory(&fx);
    let record = &inv.extensions["acme.hello"];
    assert_eq!(record.active.version, "1.0.0");
    assert!(record.previous.is_none());
    let reason = &inv.recoveries.last().unwrap().reason;
    assert!(
        reason.contains("folder is missing") && reason.contains("1.0.0"),
        "{reason}"
    );
    assert_eq!(
        service.folder_of("acme.hello").unwrap().0,
        join(&fx.root, &record.active.folder)
    );

    fs::remove_dir_all(join(&fx.root, &record.active.folder)).unwrap();
    let listed = entry(&service, "acme.hello");
    let error = listed.error.unwrap();
    assert!(error.contains("cannot be used"), "{error}");
    assert!(inventory(&fx).extensions["acme.hello"].broken.is_some());
    assert!(
        service.folder_of("acme.hello").is_err(),
        "nothing is loaded from a broken install"
    );
    service.uninstall("acme.hello").unwrap();
    assert!(inventory(&fx).extensions.is_empty());
}

/// Scenario 8: an invalid copy sorting first never supplies the code; the host loads the
/// folder the inventory chose, the one the listing reported.
#[test]
fn s08_the_host_loads_the_inventorys_folder() {
    let fx = fixture("s08");
    // An IDE-09 install, and copies of the same id sorting before it.
    fx.folder(&fx.root, "acme.hello", &manifest("acme.hello", "1.0.0"));
    fx.folder(
        &fx.root,
        "aaa-broken",
        r#"{"publisher":"acme","name":"hello","main":"evil.js"}"#,
    );
    fx.folder(&fx.root, "aaa-other", &manifest("acme.hello", "9.0.0"));
    fx.folder(
        &fx.development,
        "aaa-sample",
        &manifest("acme.hello", "0.1.0"),
    );
    let service = fx.service();
    let (folder, main) = service.folder_of("acme.hello").unwrap();
    assert_eq!(folder, fx.root.join("acme.hello"));
    assert_eq!(main, "extension.js");
    let listed = entry(&service, "acme.hello");
    assert_eq!(
        PathBuf::from(&listed.folder),
        folder,
        "the listing and the host agree"
    );
    assert_eq!(listed.shadowed.len(), 2, "{:?}", listed.shadowed);
    // The invalid one is reported as such, with no id: it can never be loaded.
    let listing = service.list(None).unwrap();
    let broken = listing
        .extensions
        .iter()
        .find(|one| one.folder.ends_with("aaa-broken"))
        .unwrap();
    assert!(broken.id.is_none() && broken.error.is_some(), "{broken:?}");
    // A development copy is loaded only when nothing installed has that id.
    fx.folder(&fx.development, "zzz", &manifest("acme.sample", "1.0.0"));
    assert_eq!(
        service.folder_of("acme.sample").unwrap().0,
        fx.development.join("zzz")
    );
    assert!(service
        .folder_of("acme.ghost")
        .unwrap_err()
        .starts_with("UnknownExtension"));
}

/// Scenario 9: a staged package that is not the requested extension is refused, and the
/// active version does not change.
#[test]
fn s09_a_manifest_id_mismatch_is_refused() {
    let fx = fixture("s09");
    let service = fx.service();
    install(&fx, &service, "acme.hello", "1.0.0");
    let before = inventory(&fx).extensions;
    // The package says it is another extension.
    let error = stage_file(
        &service,
        &fx.package("acme.other", "1.0.0"),
        "acme.hello",
        "2.0.0",
    )
    .unwrap_err();
    assert!(error.starts_with("ManifestMismatch"), "{error}");
    // The renderer names another id at commit.
    let op = stage_file(
        &service,
        &fx.package("acme.hello", "2.0.0"),
        "acme.hello",
        "2.0.0",
    )
    .unwrap();
    let error = service.commit(&op, "acme.other").unwrap_err();
    assert!(error.starts_with("ManifestMismatch"), "{error}");
    // The staged manifest is changed on disk after staging.
    let staged = fx
        .root
        .join(STAGING)
        .join(&op)
        .join("files")
        .join(MANIFEST_FILE);
    fs::write(&staged, manifest("acme.other", "2.0.0")).unwrap();
    let error = service.commit(&op, "acme.hello").unwrap_err();
    assert!(error.starts_with("ManifestMismatch"), "{error}");
    service.discard(&op).unwrap();
    let inv = inventory(&fx);
    assert_eq!(inv.extensions, before);
    assert!(inv.operations.is_empty());
    assert_eq!(staging_entries(&fx), 0);
    assert_eq!(version_listed(&service, "acme.hello"), "1.0.0");
}

/// Scenario 10: one id rule everywhere: requests are folded, manifests must be canonical, and
/// the length limit is the renderer's (the shared cases are `extension_id`'s test).
#[test]
fn s10_one_identity_rule_everywhere() {
    let fx = fixture("s10");
    let long = format!("{}.{}", "p".repeat(50), "n".repeat(50));
    fx.folder(&fx.root, "long", &manifest(&long, "1.0.0"));
    let too_long = format!("{}.n", "p".repeat(51));
    fx.folder(&fx.root, "too-long", &manifest(&too_long, "1.0.0"));
    fx.folder(&fx.root, "upper", &manifest("Acme.Upper", "1.0.0"));
    let service = fx.service();
    assert!(service.folder_of(&long).is_ok());
    assert!(service.folder_of(&too_long).is_err());
    let listing = service.list(None).unwrap();
    for refused in ["too-long", "upper"] {
        let one = listing
            .extensions
            .iter()
            .find(|e| e.folder.ends_with(refused))
            .unwrap();
        assert!(
            one.id.is_none()
                && one
                    .error
                    .as_deref()
                    .unwrap()
                    .contains("not an extension id"),
            "{one:?}"
        );
    }
    // A request is folded: the same extension whatever its case.
    assert_eq!(
        service.folder_of(&long.to_uppercase()).unwrap().0,
        fx.root.join("long")
    );
    service.set_enabled(&long.to_uppercase(), false).unwrap();
    assert_eq!(service.list(None).unwrap().disabled, vec![long.clone()]);
    // An install names its id canonically.
    assert!(service
        .begin("Acme.Hello", "1.0.0", "file")
        .unwrap_err()
        .starts_with("InvalidRequest"));
    assert!(service
        .begin(&too_long, "1.0.0", "file")
        .unwrap_err()
        .starts_with("InvalidRequest"));
}

/// Scenario 11: copies of one id are one entry, the others shadowed with their folders; the
/// choice is deterministic.
#[test]
fn s11_duplicates_are_one_entry_with_shadowed_copies() {
    let fx = fixture("s11");
    let service = fx.service();
    install(&fx, &service, "yavin-samples.hello-world", "2.1.0");
    fx.folder(
        &fx.development,
        "hello-world",
        &manifest("yavin-samples.hello-world", "2.0.0"),
    );
    fx.folder(
        &fx.root,
        "hello-copy",
        &manifest("yavin-samples.hello-world", "1.0.0"),
    );
    let first = service.list(None).unwrap();
    let ours: Vec<_> = first
        .extensions
        .iter()
        .filter(|one| one.id.as_deref() == Some("yavin-samples.hello-world"))
        .collect();
    assert_eq!(ours.len(), 1);
    let winner = ours[0];
    assert_eq!(winner.source, "installed");
    assert_eq!(
        identity(winner.manifest.as_deref().unwrap()).unwrap().1,
        "2.1.0"
    );
    let shadowed: Vec<_> = winner
        .shadowed
        .iter()
        .map(|s| {
            (
                Path::new(&s.folder)
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                s.version.clone().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        shadowed,
        vec![
            ("hello-copy".to_string(), "1.0.0".to_string()),
            ("hello-world".to_string(), "2.0.0".to_string())
        ]
    );
    assert!(winner.shadowed[1]
        .reason
        .contains("installed copy takes precedence"));
    for _ in 0..3 {
        assert_eq!(
            service.list(None).unwrap().extensions,
            first.extensions,
            "deterministic"
        );
        assert_eq!(
            fx.service().list(None).unwrap().extensions,
            first.extensions,
            "after a restart too"
        );
    }
    // Without an installed copy, the development one is used.
    service.uninstall("yavin-samples.hello-world").unwrap();
    fs::remove_dir_all(fx.root.join("hello-copy")).unwrap();
    let listed = entry(&service, "yavin-samples.hello-world");
    assert_eq!(listed.source, "development");
    assert!(listed.shadowed.is_empty());
}

/// Scenario 12: uninstall forgets the disabled state; a reinstall is enabled (the default).
#[test]
fn s12_uninstall_forgets_disabled_state() {
    let fx = fixture("s12");
    let service = fx.service();
    // The renderer's IDE-07 list is brought in once.
    let listing = service
        .list(Some(vec![
            "acme.hello".into(),
            "Acme.Other".into(),
            "not an id".into(),
        ]))
        .unwrap();
    assert_eq!(listing.disabled, vec!["acme.hello", "acme.other"]);
    let again = service.list(Some(vec!["acme.third".into()])).unwrap();
    assert_eq!(
        again.disabled,
        vec!["acme.hello", "acme.other"],
        "imported once"
    );

    install(&fx, &service, "acme.hello", "1.0.0");
    assert!(service
        .list(None)
        .unwrap()
        .disabled
        .contains(&"acme.hello".to_string()));
    service.uninstall("acme.hello").unwrap();
    assert!(!service
        .list(None)
        .unwrap()
        .disabled
        .contains(&"acme.hello".to_string()));
    install(&fx, &service, "acme.hello", "1.0.0");
    assert!(!fx
        .service()
        .list(None)
        .unwrap()
        .disabled
        .contains(&"acme.hello".to_string()));
    service.set_enabled("acme.hello", false).unwrap();
    service.set_enabled("acme.hello", true).unwrap();
    assert_eq!(
        fx.service().list(None).unwrap().disabled,
        vec!["acme.other"]
    );
}

/// Scenario 13: migration adopts IDE-09 installs as they are, and migration and recovery can
/// run any number of times with the same result.
#[test]
fn s13_migration_and_recovery_are_idempotent_and_change_no_files() {
    let fx = fixture("s13");
    fx.folder(&fx.root, "acme.hello", &manifest("acme.hello", "1.0.0"));
    fs::create_dir_all(fx.root.join("acme.hello").join("media")).unwrap();
    fs::write(
        fx.root.join("acme.hello").join("media").join("icon.png"),
        b"\x89PNG..",
    )
    .unwrap();
    fx.folder(
        &fx.root,
        "yavin.word-count",
        &manifest("yavin.word-count", "1.0.0"),
    );
    fx.folder(&fx.root, "not-an-extension", "{");
    // IDE-09 left an update half done: the old copy set aside, no new one.
    fx.folder(
        &fx.root.join(".previous"),
        "acme.aside-1f2e3d4c",
        &manifest("acme.aside", "1.0.0"),
    );
    let before: Vec<_> = ["acme.hello", "yavin.word-count", "not-an-extension"]
        .iter()
        .map(|folder| tree(&fx.root.join(folder)))
        .collect();

    let mut previous_inventory = None;
    for _ in 0..3 {
        let service = fx.service();
        let listing = service.list(None).unwrap();
        let ids: Vec<_> = listing
            .extensions
            .iter()
            .filter_map(|e| e.id.clone())
            .collect();
        assert_eq!(ids, vec!["acme.aside", "acme.hello", "yavin.word-count"]);
        let inv = inventory(&fx);
        assert_eq!(inv.extensions.len(), 3, "no duplicate rows");
        assert_eq!(
            inv.extensions["acme.hello"].active.folder, "acme.hello",
            "adopted in place"
        );
        assert_eq!(inv.extensions["acme.hello"].active.source, "unknown");
        if let Some(previous) = &previous_inventory {
            assert_eq!(&inv.extensions, previous, "the same result every time");
        }
        previous_inventory = Some(inv.extensions.clone());
        let after: Vec<_> = ["acme.hello", "yavin.word-count", "not-an-extension"]
            .iter()
            .map(|folder| tree(&fx.root.join(folder)))
            .collect();
        assert_eq!(after, before, "nothing on disk changed");
    }
    assert!(
        fx.root.join("acme.aside").join(MANIFEST_FILE).is_file(),
        "put back"
    );

    // A corrupt inventory is kept aside and rebuilt from the folders.
    fs::write(fx.root.join(INVENTORY), "{ not json").unwrap();
    let service = fx.service();
    assert_eq!(
        service
            .list(None)
            .unwrap()
            .extensions
            .iter()
            .filter(|e| e.id.is_some())
            .count(),
        3
    );
    let backups = fs::read_dir(&fx.root)
        .unwrap()
        .flatten()
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("inventory.json.corrupt")
        })
        .count();
    assert_eq!(backups, 1);
    assert!(inventory(&fx)
        .recoveries
        .iter()
        .any(|r| r.reason.contains("could not be read")));
}

/// An inventory that cannot be written changes nothing, on disk or in memory.
#[test]
fn a_failed_inventory_write_changes_nothing() {
    let fx = fixture("write-fails");
    let service = fx.service();
    install(&fx, &service, "acme.hello", "1.0.0");
    let saved = fs::read_to_string(fx.root.join(INVENTORY)).unwrap();
    // A folder where the inventory's temporary file would go makes every write fail.
    let blocker = fx.root.join(INVENTORY);
    fs::remove_file(&blocker).unwrap();
    fs::create_dir(&blocker).unwrap();
    assert!(service.set_enabled("acme.hello", false).is_err());
    assert!(service.uninstall("acme.hello").is_err());
    let pkg = fx.package("acme.hello", "2.0.0");
    assert!(stage_file(&service, &pkg, "acme.hello", "2.0.0").is_err());
    fs::remove_dir(&blocker).unwrap();
    fs::write(&blocker, &saved).unwrap();
    assert!(service.list(None).unwrap().disabled.is_empty());
    assert_eq!(version_listed(&service, "acme.hello"), "1.0.0");
    assert_eq!(store_copies(&fx, "acme.hello").len(), 1);
}

/// A newer Yavin's inventory is never overwritten.
#[test]
fn a_newer_inventory_is_left_alone() {
    let fx = fixture("future");
    fs::write(fx.root.join(INVENTORY), r#"{"version": 99}"#).unwrap();
    let error = fx.service().list(None).unwrap_err();
    assert!(error.starts_with("InventoryUnsupported"), "{error}");
}

/// A tampered inventory cannot point Yavin outside its folder.
#[test]
fn a_recorded_folder_outside_the_root_is_never_used_or_deleted() {
    let fx = fixture("tampered");
    let outside = fx.dir.join("outside");
    fx.folder(&fx.dir, "outside", &manifest("acme.hello", "1.0.0"));
    let mut inv = Inventory::default();
    inv.extensions.insert(
        "acme.hello".into(),
        Record {
            active: Copy {
                version: "1.0.0".into(),
                folder: "../outside".into(),
                sha256: None,
                source: "unknown".into(),
                installed_at: 0,
                signature: None,
            },
            previous: None,
            broken: None,
        },
    );
    fs::write(
        fx.root.join(INVENTORY),
        serde_json::to_string(&inv).unwrap(),
    )
    .unwrap();
    let service = fx.service();
    assert!(entry(&service, "acme.hello").error.is_some());
    assert!(service.folder_of("acme.hello").is_err());
    service.uninstall("acme.hello").unwrap();
    assert!(
        outside.join(MANIFEST_FILE).is_file(),
        "nothing outside the root is deleted"
    );
}

/// An operation waiting for its window is never ended by another: only one abandoned for
/// `ABANDONED_AFTER` is, and what is installed is untouched either way.
#[test]
fn a_waiting_operation_is_not_replaced_but_an_abandoned_one_is() {
    let fx = fixture("abandoned");
    let service = fx.service();
    install(&fx, &service, "acme.hello", "1.0.0");
    let pkg = fx.package("acme.hello", "2.0.0");
    // Staged, its window still validating it.
    let first = stage_file(&service, &pkg, "acme.hello", "2.0.0").unwrap();
    let busy = stage_file(&service, &pkg, "acme.hello", "2.0.0").unwrap_err();
    assert!(busy.starts_with("Busy"), "{busy}");
    // Committed, its window still registering it: its rollback stays possible.
    service.commit(&first, "acme.hello").unwrap();
    let busy = stage_file(&service, &pkg, "acme.hello", "2.0.0").unwrap_err();
    assert!(busy.starts_with("Busy"), "{busy}");
    service.finish(&first, "acme.hello", false).unwrap();
    assert_eq!(version_listed(&service, "acme.hello"), "1.0.0");

    // Abandoned: the next install ends it. The first window then fails cleanly.
    let first = stage_file(&service, &pkg, "acme.hello", "2.0.0").unwrap();
    *service.abandoned_after.lock().unwrap() = Some(Duration::ZERO);
    let second = stage_file(&service, &pkg, "acme.hello", "2.0.0").unwrap();
    assert!(service
        .commit(&first, "acme.hello")
        .unwrap_err()
        .starts_with("InvalidRequest"));
    assert_eq!(version_listed(&service, "acme.hello"), "1.0.0");
    service.commit(&second, "acme.hello").unwrap();
    service.finish(&second, "acme.hello", true).unwrap();
    assert_eq!(version_listed(&service, "acme.hello"), "2.0.0");
    assert_eq!(staging_entries(&fx), 0);
}

/// A tampered inventory cannot make recovery delete outside the staging folder.
#[test]
fn a_tampered_operation_cannot_name_a_path() {
    let fx = fixture("tampered-op");
    let victim = fx.dir.join("victim");
    fs::create_dir_all(&victim).unwrap();
    fs::write(victim.join("keep.txt"), "mine").unwrap();
    let mut inv = Inventory::default();
    for (op, id) in [
        ("../../victim", "acme.hello"),
        ("0123456789abcdef", "../../victim"),
    ] {
        inv.operations.insert(
            op.into(),
            Operation {
                id: id.into(),
                version: "1.0.0".into(),
                source: "file".into(),
                state: OpState::Committed,
                sha256: None,
                before: None,
                signature: None,
            },
        );
    }
    inv.extensions.insert(
        "../../victim".into(),
        Record {
            active: Copy {
                version: "1.0.0".into(),
                folder: "acme.hello".into(),
                sha256: None,
                source: "unknown".into(),
                installed_at: 0,
                signature: None,
            },
            previous: None,
            broken: None,
        },
    );
    fs::write(
        fx.root.join(INVENTORY),
        serde_json::to_string(&inv).unwrap(),
    )
    .unwrap();
    fs::create_dir_all(fx.root.join(STAGING)).unwrap();
    let service = fx.service();
    service.list(None).unwrap();
    assert!(
        victim.join("keep.txt").is_file(),
        "nothing outside was deleted"
    );
    let inv = inventory(&fx);
    assert!(
        inv.extensions.is_empty() && inv.operations.is_empty(),
        "{inv:?}"
    );
    assert!(inv
        .recoveries
        .iter()
        .any(|r| r.reason.contains("were dropped")));
}

/// A crash while the package downloads (`staging`): the next start discards it.
#[test]
fn a_crash_during_the_download_is_discarded() {
    let fx = fixture("crash-staging");
    let service = fx.service();
    install(&fx, &service, "acme.hello", "1.0.0");
    let (_, folder) = service.begin("acme.hello", "2.0.0", "file").unwrap();
    fs::write(folder.join("package.yvx"), b"part of a download").unwrap();
    drop(service);
    let service = fx.service();
    assert_eq!(version_listed(&service, "acme.hello"), "1.0.0");
    assert_eq!(staging_entries(&fx), 0);
    assert!(inventory(&fx).operations.is_empty());
    // And it does not block the next install.
    install(&fx, &service, "acme.hello", "2.0.0");
    assert_eq!(version_listed(&service, "acme.hello"), "2.0.0");
}

/// The inventory switch fails after the new copy was published: the copy goes back to staging,
/// the active version is unchanged, and the operation can still be discarded.
#[test]
fn a_failed_switch_unpublishes_the_new_copy() {
    let fx = fixture("switch-fails");
    let service = fx.service();
    install(&fx, &service, "acme.hello", "1.0.0");
    let op = stage_file(
        &service,
        &fx.package("acme.hello", "2.0.0"),
        "acme.hello",
        "2.0.0",
    )
    .unwrap();
    let saved = fs::read_to_string(fx.root.join(INVENTORY)).unwrap();
    let blocker = fx.root.join(INVENTORY);
    fs::remove_file(&blocker).unwrap();
    fs::create_dir(&blocker).unwrap();
    assert!(service.commit(&op, "acme.hello").is_err());
    fs::remove_dir(&blocker).unwrap();
    fs::write(&blocker, &saved).unwrap();
    assert_eq!(
        store_copies(&fx, "acme.hello").len(),
        1,
        "the new copy was unpublished"
    );
    assert!(fx
        .root
        .join(STAGING)
        .join(&op)
        .join("files")
        .join(MANIFEST_FILE)
        .is_file());
    assert_eq!(version_listed(&service, "acme.hello"), "1.0.0");
    service.discard(&op).unwrap();
    assert_eq!(staging_entries(&fx), 0);
    assert!(inventory(&fx).operations.is_empty());
}

/// Makes every inventory write fail until the returned closure puts the inventory back.
fn block_inventory(fx: &Fixture) -> impl FnOnce() + '_ {
    let saved = fs::read_to_string(fx.root.join(INVENTORY)).unwrap();
    let blocker = fx.root.join(INVENTORY);
    fs::remove_file(&blocker).unwrap();
    fs::create_dir(&blocker).unwrap();
    move || {
        fs::remove_dir(&blocker).unwrap();
        fs::write(&blocker, &saved).unwrap();
    }
}

/// EXT-06 (F1): a staging folder that cannot be made leaves no operation recorded, so the
/// extension is not Busy; what is installed is untouched.
#[test]
fn a_failed_staging_folder_leaves_nothing_busy() {
    let fx = fixture("staging-fails");
    let service = fx.service();
    install(&fx, &service, "acme.hello", "1.0.0");
    let copies = store_copies(&fx, "acme.hello");
    // A file where the staging folder goes: every operation's folder fails.
    let _ = fs::remove_dir_all(fx.root.join(STAGING));
    fs::write(fx.root.join(STAGING), b"in the way").unwrap();
    let error = service.begin("acme.hello", "2.0.0", "file").unwrap_err();
    assert!(error.starts_with("InstallFailed"), "{error}");
    assert!(inventory(&fx).operations.is_empty(), "nothing recorded");
    let again = service.begin("acme.hello", "2.0.0", "file").unwrap_err();
    assert!(again.starts_with("InstallFailed"), "not Busy: {again}");
    fs::remove_file(fx.root.join(STAGING)).unwrap();
    assert_eq!(version_listed(&service, "acme.hello"), "1.0.0");
    assert_eq!(store_copies(&fx, "acme.hello"), copies);
    install(&fx, &service, "acme.hello", "2.0.0");
    assert_eq!(version_listed(&service, "acme.hello"), "2.0.0");
}

/// EXT-06 (F1): an operation a failed step left without an owner (here `staged`'s write) is
/// ended by the next install of that id -- not Busy until a restart -- and only it: another
/// extension's install in flight, and the installed version, are untouched.
#[test]
fn an_operation_left_without_an_owner_is_ended_by_the_next() {
    let fx = fixture("ownerless");
    let service = fx.service();
    install(&fx, &service, "acme.hello", "1.0.0");
    let copies = store_copies(&fx, "acme.hello");
    let (other, other_folder) = service.begin("acme.other", "1.0.0", "file").unwrap();
    let (op, folder) = service.begin("acme.hello", "2.0.0", "file").unwrap();
    unpack(
        &fx.package("acme.hello", "2.0.0"),
        &folder.join("files"),
        &LIMITS,
    )
    .unwrap();
    let restore = block_inventory(&fx);
    assert!(service.staged(&op, &"ab".repeat(32)).is_err());
    restore();
    // Recorded, but neither running nor waiting: nothing can go on with it.
    assert!(inventory(&fx).operations.contains_key(&op));
    let pkg = fx.package("acme.hello", "3.0.0");
    let next = stage_file(&service, &pkg, "acme.hello", "3.0.0").unwrap();
    assert!(!folder.exists(), "its staging was removed");
    assert!(!inventory(&fx).operations.contains_key(&op));
    assert!(service.commit(&op, "acme.hello").is_err(), "it is gone");
    assert_eq!(version_listed(&service, "acme.hello"), "1.0.0");
    assert_eq!(store_copies(&fx, "acme.hello"), copies);
    // The other extension's download went on throughout.
    assert!(other_folder.is_dir());
    unpack(
        &fx.package("acme.other", "1.0.0"),
        &other_folder.join("files"),
        &LIMITS,
    )
    .unwrap();
    service.staged(&other, &"cd".repeat(32)).unwrap();
    service.commit(&other, "acme.other").unwrap();
    service.finish(&other, "acme.other", true).unwrap();
    assert_eq!(version_listed(&service, "acme.other"), "1.0.0");
    service.commit(&next, "acme.hello").unwrap();
    service.finish(&next, "acme.hello", true).unwrap();
    assert_eq!(version_listed(&service, "acme.hello"), "3.0.0");
    assert_eq!(staging_entries(&fx), 0);
}

/// EXT-06 (F1): a `finish` whose write fails stays its window's: the rollback can be asked
/// again (another install is Busy meanwhile, never ending it with the wrong choice).
#[test]
fn a_failed_finish_can_be_finished_again() {
    let fx = fixture("finish-fails");
    let service = fx.service();
    install(&fx, &service, "acme.hello", "1.0.0");
    let pkg = fx.package("acme.hello", "2.0.0");
    let op = stage_file(&service, &pkg, "acme.hello", "2.0.0").unwrap();
    service.commit(&op, "acme.hello").unwrap();
    let restore = block_inventory(&fx);
    assert!(service.finish(&op, "acme.hello", false).is_err());
    restore();
    let busy = stage_file(&service, &pkg, "acme.hello", "2.0.0").unwrap_err();
    assert!(busy.starts_with("Busy"), "{busy}");
    service.finish(&op, "acme.hello", false).unwrap();
    assert_eq!(version_listed(&service, "acme.hello"), "1.0.0");
    assert_eq!(store_copies(&fx, "acme.hello").len(), 1);
    assert!(inventory(&fx).operations.is_empty());
    install(&fx, &service, "acme.hello", "2.0.0");
    assert_eq!(version_listed(&service, "acme.hello"), "2.0.0");
}

// --- EXT-07: grants -----------------------------------------------------------------------------

impl Fixture {
    /// A package whose manifest requests `request` (`permissions`, EXT-07).
    fn package_requesting(&self, id: &str, version: &str, request: &[&str]) -> PathBuf {
        let (publisher, name) = id.split_once('.').unwrap();
        let at = self
            .dir
            .join("packages")
            .join(format!("{id}-{version}-p{}", request.len()));
        fs::create_dir_all(&at).unwrap();
        let manifest = serde_json::json!({
            "publisher": publisher, "name": name, "version": version,
            "engines": {"yavin": "^2.0.0"}, "main": "extension.js",
            "permissions": {"version": 1, "request": request},
        })
        .to_string();
        package(
            &at,
            &[
                (MANIFEST_FILE, manifest.as_bytes()),
                ("extension.js", b"module.exports.activate = function () {};"),
            ],
        )
    }
}

fn install_requesting(
    fx: &Fixture,
    service: &ExtensionService,
    id: &str,
    version: &str,
    request: &[&str],
) -> String {
    let pkg = fx.package_requesting(id, version, request);
    let op = stage_file(service, &pkg, id, version).unwrap();
    service.commit(&op, id).unwrap();
    op
}

fn strings(list: &[&str]) -> Vec<String> {
    list.iter().map(|c| c.to_string()).collect()
}

fn permissions_of(service: &ExtensionService, id: &str) -> PermissionState {
    entry(service, id).permissions.expect("a usable copy")
}

/// A grant is bound to the copy it was given for: an update has none of it (it is shown as the
/// previous version's), what the new version requests anew needs review like the rest, and a
/// rollback brings the old copy back with its own grant.
#[test]
fn a_new_version_does_not_inherit_a_grant() {
    let fx = fixture("grant-version");
    let service = fx.service();
    let op = install_requesting(&fx, &service, "acme.hello", "1.0.0", &["documents.read"]);
    service.finish(&op, "acme.hello", true).unwrap();
    let state = service
        .set_grants("acme.hello", None, &strings(&["documents.read"]))
        .unwrap();
    assert_eq!(state.granted, ["documents.read"]);
    let old = service.host_copy("acme.hello").unwrap();
    service.authorize(&old, Some("documents.read")).unwrap();

    // 2.0.0 requests more. Nothing is granted for it.
    let op = install_requesting(
        &fx,
        &service,
        "acme.hello",
        "2.0.0",
        &["documents.read", "workspace.fs.read"],
    );
    let state = permissions_of(&service, "acme.hello");
    assert!(state.granted.is_empty(), "{state:?}");
    assert_eq!(state.requested, ["documents.read", "workspace.fs.read"]);
    let previous = state.previous.expect("the previous version's grant, shown");
    assert_eq!(previous.version, "1.0.0");
    assert_eq!(previous.granted, ["documents.read"]);
    let new = service.host_copy("acme.hello").unwrap();
    for capability in ["documents.read", "workspace.fs.read"] {
        let denied = service.authorize(&new, Some(capability)).unwrap_err();
        assert_eq!(denied.code, "PermissionDenied", "{capability}");
    }
    // The 1.0.0 code a host may still run is no longer the installed copy.
    assert_eq!(
        service
            .authorize(&old, Some("documents.read"))
            .unwrap_err()
            .code,
        "ExtensionChanged"
    );
    assert_eq!(
        service.authorize(&old, None).unwrap_err().code,
        "ExtensionChanged"
    );

    // Rolled back: 1.0.0 is installed again, and so its grant applies again.
    service.finish(&op, "acme.hello", false).unwrap();
    assert_eq!(
        permissions_of(&service, "acme.hello").granted,
        ["documents.read"]
    );
    let again = service.host_copy("acme.hello").unwrap();
    service.authorize(&again, Some("documents.read")).unwrap();

    // Updated and kept, then reviewed: only what it was allowed.
    let op = install_requesting(
        &fx,
        &service,
        "acme.hello",
        "2.0.0",
        &["documents.read", "workspace.fs.read"],
    );
    service.finish(&op, "acme.hello", true).unwrap();
    service
        .set_grants("acme.hello", None, &strings(&["workspace.fs.read"]))
        .unwrap();
    let new = service.host_copy("acme.hello").unwrap();
    service.authorize(&new, Some("workspace.fs.read")).unwrap();
    assert_eq!(
        service
            .authorize(&new, Some("documents.read"))
            .unwrap_err()
            .code,
        "PermissionDenied"
    );
    let state = permissions_of(&service, "acme.hello");
    assert_eq!(state.granted, ["workspace.fs.read"]);
    assert!(state.previous.is_none());
}

/// Only what the copy's manifest requests can be granted -- not another capability, not a
/// misspelled one, not for another extension -- and the copy is the inventory's choice.
#[test]
fn only_what_a_copy_requests_can_be_granted() {
    let fx = fixture("grant-requested");
    let service = fx.service();
    let op = install_requesting(&fx, &service, "acme.hello", "1.0.0", &["documents.read"]);
    service.finish(&op, "acme.hello", true).unwrap();
    for wrong in [
        "workspace.fs.read",
        "Documents.Read",
        "documents.read ",
        "commands.execute:acme.other",
        "network.fetch",
    ] {
        let refused = service
            .set_grants("acme.hello", None, &strings(&[wrong]))
            .unwrap_err();
        assert!(refused.starts_with("NotRequested"), "{wrong}: {refused}");
    }
    assert!(service
        .set_grants("acme.ghost", None, &strings(&["documents.read"]))
        .unwrap_err()
        .starts_with("UnknownExtension"));
    assert!(inventory(&fx).grants.is_empty(), "nothing was granted");
    // Upper case names the same extension; the grant is the canonical one's.
    service
        .set_grants("Acme.Hello", None, &strings(&["documents.read"]))
        .unwrap();
    assert!(inventory(&fx).grants.contains_key("acme.hello"));
    // An empty list revokes everything.
    let state = service.set_grants("acme.hello", None, &[]).unwrap();
    assert!(state.granted.is_empty());
    assert!(inventory(&fx).grants.is_empty());
}

/// Uninstalling forgets the grant: a reinstall of the very same version starts with none.
/// Disabling keeps it, but a disabled extension is allowed nothing and is not loaded.
#[test]
fn uninstall_forgets_grants_and_disable_suspends_them() {
    let fx = fixture("grant-lifecycle");
    let service = fx.service();
    let op = install_requesting(&fx, &service, "acme.hello", "1.0.0", &["documents.read"]);
    service.finish(&op, "acme.hello", true).unwrap();
    service
        .set_grants("acme.hello", None, &strings(&["documents.read"]))
        .unwrap();
    let copy = service.host_copy("acme.hello").unwrap();

    service.set_enabled("acme.hello", false).unwrap();
    assert_eq!(
        service
            .authorize(&copy, Some("documents.read"))
            .unwrap_err()
            .code,
        "ExtensionDisabled"
    );
    assert_eq!(
        service.authorize(&copy, None).unwrap_err().code,
        "ExtensionDisabled"
    );
    assert!(service
        .host_copy("acme.hello")
        .unwrap_err()
        .starts_with("ExtensionDisabled"));
    service.set_enabled("acme.hello", true).unwrap();
    service.authorize(&copy, Some("documents.read")).unwrap();

    service.uninstall("acme.hello").unwrap();
    assert!(inventory(&fx).grants.is_empty());
    assert_eq!(
        service
            .authorize(&copy, Some("documents.read"))
            .unwrap_err()
            .code,
        "ExtensionChanged"
    );
    let op = install_requesting(&fx, &service, "acme.hello", "1.0.0", &["documents.read"]);
    service.finish(&op, "acme.hello", true).unwrap();
    assert!(permissions_of(&service, "acme.hello").granted.is_empty());
    let copy = service.host_copy("acme.hello").unwrap();
    assert_eq!(
        service
            .authorize(&copy, Some("documents.read"))
            .unwrap_err()
            .code,
        "PermissionDenied"
    );
}

/// A grant record that is not what Yavin writes allows nothing: one naming what is not a
/// capability, or for what is not an extension id, is dropped (and said); one bound to another
/// copy, or forged for a capability the copy does not request, opens nothing; an inventory
/// whose grants cannot be read at all is kept aside and rebuilt, with no grant.
#[test]
fn invalid_or_corrupted_grants_fail_closed() {
    let fx = fixture("grant-corrupt");
    let service = fx.service();
    let op = install_requesting(&fx, &service, "acme.hello", "1.0.0", &["documents.read"]);
    service.finish(&op, "acme.hello", true).unwrap();
    let listed = entry(&service, "acme.hello").folder;
    drop(service);

    let mut inv = inventory(&fx);
    let grant = |folder: &str, version: &str, sha: Option<String>, caps: &[&str]| Grant {
        folder: folder.to_string(),
        version: version.to_string(),
        sha256: sha,
        capabilities: caps.iter().map(|c| c.to_string()).collect(),
        granted_at: 0,
    };
    let sha = inv.extensions["acme.hello"].active.sha256.clone();
    // Not a capability: the whole grant goes.
    inv.grants.insert(
        "acme.hello".into(),
        grant(
            &listed,
            "1.0.0",
            sha.clone(),
            &["documents.read", "network.fetch"],
        ),
    );
    inv.grants.insert(
        "../evil".into(),
        grant(&listed, "1.0.0", None, &["documents.read"]),
    );
    fs::write(
        fx.root.join(INVENTORY),
        serde_json::to_string(&inv).unwrap(),
    )
    .unwrap();
    let service = fx.service();
    assert!(permissions_of(&service, "acme.hello").granted.is_empty());
    let copy = service.host_copy("acme.hello").unwrap();
    assert_eq!(
        service
            .authorize(&copy, Some("documents.read"))
            .unwrap_err()
            .code,
        "PermissionDenied"
    );
    let saved = inventory(&fx);
    assert!(saved.grants.is_empty(), "{:?}", saved.grants);
    assert!(saved
        .recoveries
        .iter()
        .any(|r| r.reason.contains("permissions that are not valid")));
    drop(service);

    // Bound to another copy (a different hash, another version, another folder): nothing.
    for wrong in [
        grant(&listed, "1.0.0", Some("00".repeat(32)), &["documents.read"]),
        grant(&listed, "0.9.0", sha.clone(), &["documents.read"]),
        grant(
            "C:/elsewhere/acme.hello",
            "1.0.0",
            sha.clone(),
            &["documents.read"],
        ),
    ] {
        let mut inv = inventory(&fx);
        inv.grants.insert("acme.hello".into(), wrong);
        fs::write(
            fx.root.join(INVENTORY),
            serde_json::to_string(&inv).unwrap(),
        )
        .unwrap();
        let service = fx.service();
        let copy = service.host_copy("acme.hello").unwrap();
        assert_eq!(
            service
                .authorize(&copy, Some("documents.read"))
                .unwrap_err()
                .code,
            "PermissionDenied"
        );
        assert!(permissions_of(&service, "acme.hello").granted.is_empty());
    }

    // Forged for a capability its manifest does not request: valid as a capability, but the
    // copy does not ask for it, so it opens nothing.
    let mut inv = inventory(&fx);
    inv.grants.insert(
        "acme.hello".into(),
        grant(
            &listed,
            "1.0.0",
            sha.clone(),
            &["documents.read", "workspace.fs.read"],
        ),
    );
    fs::write(
        fx.root.join(INVENTORY),
        serde_json::to_string(&inv).unwrap(),
    )
    .unwrap();
    let service = fx.service();
    let copy = service.host_copy("acme.hello").unwrap();
    service.authorize(&copy, Some("documents.read")).unwrap();
    assert_eq!(
        service
            .authorize(&copy, Some("workspace.fs.read"))
            .unwrap_err()
            .code,
        "PermissionDenied"
    );
    assert_eq!(
        permissions_of(&service, "acme.hello").granted,
        ["documents.read"]
    );
    drop(service);

    // Grants that are not even grants: the inventory is kept aside, rebuilt, nothing granted.
    let text = fs::read_to_string(fx.root.join(INVENTORY)).unwrap();
    let mut raw: serde_json::Value = serde_json::from_str(&text).unwrap();
    raw["grants"] = serde_json::json!({"acme.hello": "everything"});
    fs::write(fx.root.join(INVENTORY), raw.to_string()).unwrap();
    let service = fx.service();
    let listing = service.list(None).unwrap();
    assert!(listing
        .recoveries
        .iter()
        .any(|r| r.reason.contains("could not be read")));
    // (EXT-02's rebuild also lets go of the store copies the empty inventory does not know:
    // whatever is left, nothing in it is granted.)
    let grants = fs::read_to_string(fx.root.join(INVENTORY))
        .map(|text| serde_json::from_str::<Inventory>(&text).unwrap().grants)
        .unwrap_or_default();
    assert!(grants.is_empty(), "{grants:?}");
    if let Ok(copy) = service.host_copy("acme.hello") {
        assert_eq!(
            service
                .authorize(&copy, Some("documents.read"))
                .unwrap_err()
                .code,
            "PermissionDenied"
        );
    }
}

/// A declaration Yavin cannot read fails closed: such a package is not installed, and a copy
/// already in the folder with one is listed as unusable and never loaded.
#[test]
fn an_unreadable_declaration_is_never_installed_or_loaded() {
    let fx = fixture("grant-declaration");
    let service = fx.service();
    let (publisher, name) = ("acme", "hello");
    let at = fx.dir.join("packages").join("bad");
    fs::create_dir_all(&at).unwrap();
    let manifest = serde_json::json!({
        "publisher": publisher, "name": name, "version": "1.0.0", "main": "extension.js",
        "permissions": {"version": 2, "request": ["documents.read"]},
    })
    .to_string();
    let pkg = package(
        &at,
        &[
            (MANIFEST_FILE, manifest.as_bytes()),
            ("extension.js", b"module.exports.activate = function () {};"),
        ],
    );
    let refused = stage_file(&service, &pkg, "acme.hello", "1.0.0").unwrap_err();
    assert!(refused.starts_with("InvalidPackage"), "{refused}");
    assert!(refused.contains("permission model version 2"), "{refused}");
    assert!(inventory(&fx).operations.is_empty());
    assert_eq!(staging_entries(&fx), 0);

    // Put in the folder by hand (an older Yavin, a copy): listed, unusable, not loaded.
    fx.folder(
        &fx.root,
        "acme.other",
        r#"{"publisher":"acme","name":"other","version":"1.0.0","main":"extension.js","permissions":{"version":1,"request":["process.spawn"]}}"#,
    );
    let listed = entry(&service, "acme.other");
    assert!(
        listed
            .error
            .as_deref()
            .unwrap_or("")
            .contains("permissions cannot be used"),
        "{listed:?}"
    );
    assert!(listed.permissions.is_none());
    assert!(service.host_copy("acme.other").is_err());
    assert!(service
        .set_grants("acme.other", None, &strings(&["documents.read"]))
        .is_err());
}

/// A development copy (a repository sample) is granted like an installed one, bound to its
/// folder and version; an installed copy of the same id then takes over without its grant.
#[test]
fn a_development_copys_grant_is_its_own() {
    let fx = fixture("grant-development");
    fx.folder(
        &fx.development,
        "acme.hello",
        r#"{"publisher":"acme","name":"hello","version":"1.0.0","main":"extension.js","permissions":{"version":1,"request":["documents.read"]}}"#,
    );
    let service = fx.service();
    assert_eq!(entry(&service, "acme.hello").source, "development");
    service
        .set_grants("acme.hello", None, &strings(&["documents.read"]))
        .unwrap();
    let development = service.host_copy("acme.hello").unwrap();
    assert!(development.stored.is_none());
    service
        .authorize(&development, Some("documents.read"))
        .unwrap();

    let op = install_requesting(&fx, &service, "acme.hello", "1.0.0", &["documents.read"]);
    service.finish(&op, "acme.hello", true).unwrap();
    assert_eq!(entry(&service, "acme.hello").source, "installed");
    assert!(permissions_of(&service, "acme.hello").granted.is_empty());
    let installed = service.host_copy("acme.hello").unwrap();
    assert_eq!(
        service
            .authorize(&installed, Some("documents.read"))
            .unwrap_err()
            .code,
        "PermissionDenied"
    );
    assert_eq!(
        service.authorize(&development, None).unwrap_err().code,
        "ExtensionChanged"
    );
}

/// What the user allowed applies to the version they reviewed: if another copy is listed
/// meanwhile (an update finished between the review and the click), nothing is granted.
#[test]
fn a_grant_for_a_version_no_longer_installed_is_refused() {
    let fx = fixture("grant-reviewed");
    let service = fx.service();
    let op = install_requesting(&fx, &service, "acme.hello", "1.0.0", &["documents.read"]);
    service.finish(&op, "acme.hello", true).unwrap();
    let op = install_requesting(&fx, &service, "acme.hello", "2.0.0", &["documents.read"]);
    service.finish(&op, "acme.hello", true).unwrap();
    let refused = service
        .set_grants("acme.hello", Some("1.0.0"), &strings(&["documents.read"]))
        .unwrap_err();
    assert!(refused.starts_with("ExtensionChanged"), "{refused}");
    assert!(inventory(&fx).grants.is_empty());
    service
        .set_grants("acme.hello", Some("2.0.0"), &strings(&["documents.read"]))
        .unwrap();
    assert_eq!(
        permissions_of(&service, "acme.hello").granted,
        ["documents.read"]
    );
}

// --- A damaged or missing inventory (EXT-02 recovery safety) --------------------------------------

/// Every file under the root but the inventory's own (its two copies, their backups, temps):
/// what a recovery must never lose, by content.
fn kept_files(fx: &Fixture) -> Vec<Vec<u8>> {
    let mut all: Vec<Vec<u8>> = tree(&fx.root)
        .into_iter()
        .filter(|(path, _)| {
            let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
            !name.starts_with("inventory.") && !name.starts_with(".inventory.")
        })
        .map(|(_, bytes)| bytes)
        .collect();
    all.sort();
    all
}

/// Installed through the store: acme.hello 1.0.0 then 2.0.0 (active 2.0.0, previous 1.0.0),
/// acme.other 1.0.0 disabled, acme.hello allowed documents.read.
fn installed(fx: &Fixture) -> ExtensionService {
    let service = fx.service();
    install(fx, &service, "acme.hello", "1.0.0");
    install(fx, &service, "acme.hello", "2.0.0");
    install(fx, &service, "acme.other", "1.0.0");
    service.set_enabled("acme.other", false).unwrap();
    service
        .set_grants("acme.hello", None, &strings(&["documents.read"]))
        .unwrap();
    service
}

fn recovered(fx: &Fixture, about: &str) -> bool {
    inventory(fx)
        .recoveries
        .iter()
        .any(|r| r.reason.contains(about))
}

/// Every save writes the last-good copy first and the inventory after it: the same text.
#[test]
fn every_save_keeps_a_last_good_copy() {
    let fx = fixture("last-good");
    let service = installed(&fx);
    drop(service);
    assert_eq!(
        fs::read(fx.root.join(LAST_GOOD)).unwrap(),
        fs::read(fx.root.join(INVENTORY)).unwrap()
    );
}

/// A missing inventory, a malformed one, a truncated one: restored from the last-good copy --
/// every record, disabled state and grant as it was, nothing on disk changed, the damaged file
/// kept aside.
#[test]
fn a_missing_malformed_or_truncated_inventory_is_restored_from_its_last_good_copy() {
    let fx = fixture("restore");
    drop(installed(&fx));
    let good = inventory(&fx);
    // What each copy's signature was found to be is restored with it (EXT-09): a file is unsigned.
    let signature = good.extensions["acme.hello"]
        .active
        .signature
        .clone()
        .unwrap();
    assert_eq!(signature.status, SignatureStatus::Missing);
    assert_eq!(signature.registry, "file");
    assert_eq!(
        Some(&signature.sha256),
        good.extensions["acme.hello"].active.sha256.as_ref()
    );
    let text = fs::read_to_string(fx.root.join(INVENTORY)).unwrap();
    let files = kept_files(&fx);
    for (damage, about) in [
        ("missing", "was missing"),
        ("malformed", "could not be read"),
        ("truncated", "could not be read"),
    ] {
        match damage {
            "missing" => fs::remove_file(fx.root.join(INVENTORY)).unwrap(),
            "malformed" => fs::write(fx.root.join(INVENTORY), "{ not json").unwrap(),
            _ => fs::write(fx.root.join(INVENTORY), &text[..text.len() / 2]).unwrap(),
        }
        let service = fx.service();
        assert_eq!(version_listed(&service, "acme.hello"), "2.0.0", "{damage}");
        let now = inventory(&fx);
        assert_eq!(now.extensions, good.extensions, "{damage}");
        assert_eq!(now.disabled, good.disabled, "{damage}");
        assert_eq!(
            now.grants, good.grants,
            "{damage}: the grants come back too"
        );
        assert!(recovered(&fx, about), "{damage}");
        assert!(
            recovered(&fx, "it was restored from its last good copy"),
            "{damage}"
        );
        assert_eq!(kept_files(&fx), files, "{damage}: nothing on disk changed");
        let copy = service.host_copy("acme.hello").unwrap();
        service.authorize(&copy, Some("documents.read")).unwrap();
    }
    let backups = fs::read_dir(&fx.root)
        .unwrap()
        .flatten()
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("inventory.json.corrupt")
        })
        .count();
    assert_eq!(backups, 2, "the damaged inventories are kept");
}

/// What a rebuild must handle: the installs, and what does not validate.
fn damage_beyond_the_last_good_copy(fx: &Fixture) {
    // A third, older copy of acme.hello (a rebuild keeps two).
    let store = fx.root.join(STORE);
    fx.folder(
        &store.join("acme.hello"),
        "0.9.0-0123abcd",
        &manifest("acme.hello", "0.9.0"),
    );
    // Not a store copy name; a manifest that is not its folder's version; not an id.
    fx.folder(
        &store.join("acme.hello"),
        "9.9.9-zzzzzzzz",
        &manifest("acme.hello", "9.9.9"),
    );
    fx.folder(
        &store.join("acme.hello"),
        "3.0.0-0123abcd",
        &manifest("acme.hello", "1.0.0"),
    );
    fx.folder(
        &store.join("Bad_ID"),
        "1.0.0-0123abcd",
        &manifest("acme.bad", "1.0.0"),
    );
    // Staging nothing records.
    fs::create_dir_all(fx.root.join(STAGING).join("0123456789abcdef")).unwrap();
    fs::write(
        fx.root
            .join(STAGING)
            .join("0123456789abcdef")
            .join("package.yvx"),
        b"half",
    )
    .unwrap();
    // Both copies of the inventory unreadable.
    fs::write(fx.root.join(INVENTORY), "{ not json").unwrap();
    fs::write(fx.root.join(LAST_GOOD), "{\"version\": 1, \"extensions\": ").unwrap();
}

fn unrecovered(fx: &Fixture) -> Vec<PathBuf> {
    fs::read_dir(&fx.root)
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .is_some_and(|n| n.to_string_lossy().starts_with(".unrecovered-"))
        })
        .collect()
}

fn assert_rebuilt(fx: &Fixture, service: &ExtensionService) {
    let inv = inventory(fx);
    let hello = &inv.extensions["acme.hello"];
    assert_eq!(
        hello.active.version, "2.0.0",
        "the newest copy is the active one"
    );
    assert_eq!(hello.previous.as_ref().unwrap().version, "1.0.0");
    assert_eq!(inv.extensions["acme.other"].active.version, "1.0.0");
    assert_eq!(inv.extensions.len(), 2, "{:?}", inv.extensions.keys());
    // Its state is not known: disabled, with no grant (fail closed).
    assert_eq!(
        inv.disabled.iter().cloned().collect::<Vec<_>>(),
        ["acme.hello", "acme.other"]
    );
    assert!(inv.grants.is_empty());
    // Nor is what its signature was: a rebuilt copy is never taken for checked (EXT-09).
    for record in inv.extensions.values() {
        assert!(record.active.signature.is_none());
        assert!(record
            .previous
            .as_ref()
            .is_none_or(|p| p.signature.is_none()));
    }
    assert!(service
        .host_copy("acme.hello")
        .unwrap_err()
        .starts_with("ExtensionDisabled"));
    assert!(recovered(fx, "it was rebuilt from the installed copies"));
    // What did not validate, the third copy and the staging are kept, not deleted.
    let aside: Vec<String> = unrecovered(fx)
        .iter()
        .flat_map(|dir| tree(dir).into_keys())
        .map(|p| p.replace('\\', "/"))
        .collect();
    for expected in [
        ".store/acme.hello/9.9.9-zzzzzzzz/yavin-extension.json",
        ".store/acme.hello/3.0.0-0123abcd/yavin-extension.json",
        ".store/Bad_ID/1.0.0-0123abcd/yavin-extension.json",
        ".staging/0123456789abcdef/package.yvx",
    ] {
        assert!(
            aside.iter().any(|p| p == expected),
            "{expected} in {aside:?}"
        );
    }
    assert!(
        aside
            .iter()
            .any(|p| p.starts_with(".store/acme.hello/0.9.0-")),
        "{aside:?}"
    );
    assert_eq!(staging_entries(fx), 0);
    // Enabled again by the user, it runs.
    service.set_enabled("acme.hello", true).unwrap();
    assert_eq!(version_listed(service, "acme.hello"), "2.0.0");
}

/// Neither copy of the inventory readable: rebuilt from the store copies that validate --
/// disabled, no grant -- and everything else kept in `.unrecovered-*`. Nothing is deleted;
/// both damaged copies are kept too.
#[test]
fn with_no_readable_copy_the_inventory_is_rebuilt_and_nothing_is_deleted() {
    let fx = fixture("rebuild");
    drop(installed(&fx));
    damage_beyond_the_last_good_copy(&fx);
    let files = kept_files(&fx);
    let service = fx.service();
    service.list(None).unwrap();
    assert_eq!(kept_files(&fx), files, "every file is still there");
    assert_rebuilt(&fx, &service);
    let backups: Vec<_> = fs::read_dir(&fx.root)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".bak"))
        .collect();
    assert!(
        backups
            .iter()
            .any(|n| n.starts_with("inventory.json.corrupt")),
        "{backups:?}"
    );
    assert!(
        backups
            .iter()
            .any(|n| n.starts_with("inventory.last-good.json.corrupt")),
        "{backups:?}"
    );
}

/// Recovering again changes nothing: the rebuilt inventory is read as it is, and a rebuild run
/// once more (both copies lost again) finds the same and moves nothing.
#[test]
fn recovery_repeated_gives_the_same_result() {
    let fx = fixture("rebuild-again");
    drop(installed(&fx));
    damage_beyond_the_last_good_copy(&fx);
    fx.service().list(None).unwrap();
    let first = inventory(&fx).extensions;
    let files = kept_files(&fx);
    for _ in 0..2 {
        fx.service().list(None).unwrap();
        assert_eq!(inventory(&fx).extensions, first);
        assert_eq!(kept_files(&fx), files);
    }
    assert_eq!(unrecovered(&fx).len(), 1);
    fs::remove_file(fx.root.join(INVENTORY)).unwrap();
    fs::remove_file(fx.root.join(LAST_GOOD)).unwrap();
    let service = fx.service();
    service.list(None).unwrap();
    let mut again = inventory(&fx).extensions;
    let mut expected = first.clone();
    for record in again.values_mut().chain(expected.values_mut()) {
        record.active.installed_at = 0;
        if let Some(previous) = record.previous.as_mut() {
            previous.installed_at = 0;
        }
    }
    assert_eq!(again, expected);
    assert_eq!(kept_files(&fx), files, "nothing more moved or deleted");
}

/// A rebuild stopped at each of its steps -- after a folder was moved aside, after all were,
/// before the inventory was written -- loses nothing, writes no inventory, and completes the
/// next time with the same result.
#[test]
fn a_rebuild_interrupted_at_each_step_completes_the_next_time() {
    for step in ["kept", "rebuilt"] {
        let fx = fixture(&format!("rebuild-crash-{step}"));
        drop(installed(&fx));
        damage_beyond_the_last_good_copy(&fx);
        let files = kept_files(&fx);
        let service = fx.service();
        *service.crash_at.lock().unwrap() = Some(step);
        let error = service.list(None).unwrap_err();
        assert!(error.starts_with("Crashed"), "{step}: {error}");
        assert!(!fx.root.join(INVENTORY).exists(), "{step}: nothing written");
        assert_eq!(kept_files(&fx), files, "{step}: nothing lost");
        drop(service);
        let service = fx.service();
        service.list(None).unwrap();
        assert_eq!(kept_files(&fx), files, "{step}");
        assert_rebuilt(&fx, &service);
    }
}

/// A last-good copy written by a newer Yavin is not rebuilt over: nothing is changed, and the
/// extensions folder is unusable until Yavin is updated (fail closed).
#[test]
fn a_newer_last_good_copy_stops_recovery_untouched() {
    let fx = fixture("rebuild-future");
    drop(installed(&fx));
    fs::write(fx.root.join(INVENTORY), "{ not json").unwrap();
    fs::write(fx.root.join(LAST_GOOD), r#"{"version": 99}"#).unwrap();
    let files = kept_files(&fx);
    let error = fx.service().list(None).unwrap_err();
    assert!(error.starts_with("InventoryUnsupported"), "{error}");
    assert_eq!(kept_files(&fx), files);
    assert!(unrecovered(&fx).is_empty());
}

/// Nothing installed by an inventory (only IDE-09's root folders): a missing inventory is the
/// first start -- adopted as before, enabled.
#[test]
fn a_missing_inventory_with_nothing_installed_is_a_first_start() {
    let fx = fixture("first-start");
    fx.folder(&fx.root, "acme.hello", &manifest("acme.hello", "1.0.0"));
    let service = fx.service();
    assert_eq!(version_listed(&service, "acme.hello"), "1.0.0");
    assert!(inventory(&fx).disabled.is_empty());
    assert!(inventory(&fx).recoveries.is_empty());
    assert!(unrecovered(&fx).is_empty());
}

/// A save whose inventory write fails leaves the last-good copy as it was: a change reported
/// as failed (here a grant) never comes back through a later restore.
#[test]
fn a_failed_save_does_not_leave_the_last_good_copy_ahead() {
    let fx = fixture("last-good-failed");
    let service = fx.service();
    install(&fx, &service, "acme.hello", "1.0.0");
    let before = fs::read(fx.root.join(LAST_GOOD)).unwrap();
    // A folder where the inventory goes: its write fails, the last-good one does not.
    let blocker = fx.root.join(INVENTORY);
    fs::remove_file(&blocker).unwrap();
    fs::create_dir(&blocker).unwrap();
    assert!(service
        .set_grants("acme.hello", None, &strings(&["documents.read"]))
        .is_err());
    assert_eq!(
        fs::read(fx.root.join(LAST_GOOD)).unwrap(),
        before,
        "put back as it was"
    );
    drop(service);
    // The inventory is then lost: the restore has no trace of the failed grant.
    fs::remove_dir(&blocker).unwrap();
    let service = fx.service();
    assert_eq!(version_listed(&service, "acme.hello"), "1.0.0");
    assert!(inventory(&fx).grants.is_empty());
    assert!(recovered(&fx, "it was restored from its last good copy"));
}

/// A signature record holds only for the bytes it was checked against (EXT-09): one for other
/// bytes is refused when staged, and one an inventory carries for another copy is not listed.
#[test]
fn a_signature_record_is_bound_to_its_package_bytes() {
    let fx = fixture("signature-binding");
    let service = fx.service();
    let (op, _folder) = service.begin("acme.hello", "1.0.0", "file").unwrap();
    let record = SignatureRecord {
        status: SignatureStatus::RegistrySigned,
        registry: "https://open-vsx.org".into(),
        key_id: Some("k".into()),
        namespace: "acme".into(),
        sha256: "ab".repeat(32),
        store_revision: 1,
    };
    let error = service
        .staged_with(&op, &"cd".repeat(32), Some(record))
        .unwrap_err();
    assert!(error.starts_with("InstallFailed"), "{error}");
    assert!(
        inventory(&fx).operations.is_empty(),
        "the operation was ended"
    );

    install(&fx, &service, "acme.hello", "1.0.0");
    assert_eq!(
        entry(&service, "acme.hello").signature.unwrap().status,
        SignatureStatus::Missing
    );
    drop(service);
    let mut inv = inventory(&fx);
    let active = &mut inv.extensions.get_mut("acme.hello").unwrap().active;
    let signature = active.signature.as_mut().unwrap();
    signature.status = SignatureStatus::RegistrySigned;
    signature.sha256 = "ef".repeat(32);
    let text = serde_json::to_string(&inv).unwrap();
    fs::write(fx.root.join(INVENTORY), &text).unwrap();
    fs::write(fx.root.join(LAST_GOOD), &text).unwrap();
    assert!(entry(&fx.service(), "acme.hello").signature.is_none());
}
