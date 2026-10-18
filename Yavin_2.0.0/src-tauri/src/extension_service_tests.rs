//! EXT-02 acceptance tests: the inventory, install safety and recovery. Every test works in its
//! own temporary folder; "a restart" is a new `ExtensionService` over the same folder.

use super::*;
use crate::extension_package::tests::package;
use crate::extension_package::{unpack, LIMITS};
use crate::extensions::MANIFEST_FILE;
use crate::marketplace::{stage, PackageSource};
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
