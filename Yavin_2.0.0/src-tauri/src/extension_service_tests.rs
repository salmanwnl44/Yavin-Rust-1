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
        r#"{{"publisher":"{publisher}","name":"{name}","version":"{version}","engines":{{"yavin":"^2.0.0"}},"main":"extension.js"}}"#
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
        r#"{"publisher":"acme","name":"hello","engines":{"yavin":"^2.0.0"},"main":"evil.js"}"#,
    );
    fx.folder(&fx.root, "aaa-other", &manifest("acme.hello", "9.0.0"));
    fx.folder(
        &fx.development,
        "aaa-sample",
        &manifest("acme.hello", "0.1.0"),
    );
    let service = fx.service();
    // The IDE-09 folder is the one chosen -- and, adopted (never checked), its code is not
    // given to the host (EXT-19).
    let folder = fx.root.join("acme.hello");
    let listed = entry(&service, "acme.hello");
    assert_eq!(
        PathBuf::from(&listed.folder),
        folder,
        "the listing chooses it"
    );
    assert!(service
        .folder_of("acme.hello")
        .unwrap_err()
        .starts_with("IntegrityUnverified"));
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
    // Found (EXT-19: adopted, so refused its code -- by name, which is the point here).
    assert!(service
        .folder_of(&long)
        .unwrap_err()
        .starts_with("IntegrityUnverified"));
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
    assert!(service
        .folder_of(&long.to_uppercase())
        .unwrap_err()
        .contains(&long));
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
                files_sha256: None,
                unchecked: Some(Unchecked::Adopted),
                trust: None,
            },
            previous: None,
            broken: None,
            replaced: None,
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
                files_sha256: None,
                unchecked: Some(Unchecked::Adopted),
                trust: None,
            },
            previous: None,
            broken: None,
            replaced: None,
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
        "publisher": publisher, "name": name, "version": "1.0.0", "engines": {"yavin": "^2.0.0"}, "main": "extension.js",
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
        r#"{"publisher":"acme","name":"other","version":"1.0.0","engines":{"yavin":"^2.0.0"},"main":"extension.js","permissions":{"version":1,"request":["process.spawn"]}}"#,
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
        r#"{"publisher":"acme","name":"hello","version":"1.0.0","engines":{"yavin":"^2.0.0"},"main":"extension.js","permissions":{"version":1,"request":["documents.read"]}}"#,
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

// --- EXT-12: dependencies and the extension API, natively -------------------------------------

/// A package of `id` at `version` whose manifest also has `extra` (its dependencies, ...).
fn package_with(fx: &Fixture, id: &str, version: &str, extra: serde_json::Value) -> PathBuf {
    let (publisher, name) = id.split_once('.').unwrap();
    let at = fx.dir.join("packages").join(format!("{id}-{version}-x"));
    fs::create_dir_all(&at).unwrap();
    let mut manifest = serde_json::json!({"publisher": publisher, "name": name, "version": version, "engines": {"yavin": "^2.0.0"}, "main": "extension.js"});
    for (key, value) in extra.as_object().unwrap() {
        manifest[key] = value.clone();
    }
    package(
        &at,
        &[
            (MANIFEST_FILE, manifest.to_string().as_bytes()),
            ("extension.js", b"module.exports = {};"),
        ],
    )
}

/// Installs it through the whole pipeline (stage, commit, finish), or says why not.
fn install_with(
    fx: &Fixture,
    service: &ExtensionService,
    id: &str,
    version: &str,
    extra: serde_json::Value,
) -> Result<(), String> {
    let op = stage_file(service, &package_with(fx, id, version, extra), id, version)?;
    service.commit(&op, id)?;
    service.finish(&op, id, true)
}

/// What a refused install must leave: the inventory as it was, nothing staged or pending.
fn unchanged(fx: &Fixture, before: &Inventory) {
    let now = inventory(fx);
    assert_eq!(now.extensions, before.extensions);
    assert_eq!(now.disabled, before.disabled);
    assert_eq!(now.grants, before.grants);
    assert!(now.operations.is_empty());
    assert_eq!(staging_entries(fx), 0);
}

#[test]
fn ext12_an_install_needs_its_required_dependencies_installed_enabled_and_in_range() {
    let fx = fixture("ext12-install");
    let service = fx.service();
    let needs_base = serde_json::json!({"dependencies": {"acme.base": "^1.2.0"}});
    // None installed: refused, and nothing changed.
    let error = install_with(&fx, &service, "acme.app", "1.0.0", needs_base.clone()).unwrap_err();
    assert!(error.starts_with("DependencyMissing"), "{error}");
    assert!(error.contains("acme.base ^1.2.0"), "{error}");
    assert!(!fx.root.join(INVENTORY).exists() || inventory(&fx).extensions.is_empty());
    // Installed in range: installed.
    install_with(&fx, &service, "acme.base", "1.4.0", serde_json::json!({})).unwrap();
    install_with(&fx, &service, "acme.app", "1.0.0", needs_base).unwrap();
    // Out of range: refused, with which version is there.
    let before = inventory(&fx);
    let error = install_with(
        &fx,
        &service,
        "acme.newer",
        "1.0.0",
        serde_json::json!({"dependencies": {"acme.base": "^2.0.0"}}),
    )
    .unwrap_err();
    assert!(error.starts_with("DependencyConflict"), "{error}");
    assert!(error.contains("acme.base 1.4.0 is not ^2.0.0"), "{error}");
    unchanged(&fx, &before);
    // Disabled: refused -- it is not enabled for it.
    service.set_enabled("acme.base", false).unwrap();
    let before = inventory(&fx);
    let error = install_with(
        &fx,
        &service,
        "acme.other",
        "1.0.0",
        serde_json::json!({"extensionDependencies": ["acme.base"]}),
    )
    .unwrap_err();
    assert!(error.contains("disabled"), "{error}");
    unchanged(&fx, &before);
    service.set_enabled("acme.base", true).unwrap();
    // An optional dependency that is not installed does not hold it back.
    install_with(&fx, &service, "acme.extra", "1.0.0", serde_json::json!({"dependencies": {"acme.nowhere": {"version": "^1.0.0", "optional": true}}})).unwrap();
}

#[test]
fn ext12_an_update_that_would_break_a_dependent_is_refused_and_changes_nothing() {
    let fx = fixture("ext12-update");
    let service = fx.service();
    install_with(&fx, &service, "acme.base", "1.0.0", serde_json::json!({})).unwrap();
    install_with(
        &fx,
        &service,
        "acme.app",
        "1.0.0",
        serde_json::json!({"dependencies": {"acme.base": "^1.0.0"}}),
    )
    .unwrap();
    service.set_grants("acme.base", None, &[]).unwrap();
    let before = inventory(&fx);
    let error =
        install_with(&fx, &service, "acme.base", "2.0.0", serde_json::json!({})).unwrap_err();
    assert!(error.starts_with("WouldBreakDependents"), "{error}");
    assert!(
        error.contains("would break acme.app 1.0.0, which needs acme.base ^1.0.0"),
        "{error}"
    );
    unchanged(&fx, &before);
    assert_eq!(
        inventory(&fx).extensions["acme.base"].active.version,
        "1.0.0"
    );
    // A compatible update goes ahead.
    install_with(&fx, &service, "acme.base", "1.1.0", serde_json::json!({})).unwrap();
    assert_eq!(
        inventory(&fx).extensions["acme.base"].active.version,
        "1.1.0"
    );
    // With the dependent disabled, the breaking update is the user's to make.
    service.set_enabled("acme.app", false).unwrap();
    install_with(&fx, &service, "acme.base", "2.0.0", serde_json::json!({})).unwrap();
    // ...and the dependent then cannot load: what it needs is not there.
    service.set_enabled("acme.app", true).unwrap();
    let error = service.host_copy("acme.app").unwrap_err();
    assert!(error.starts_with("DependencyUnavailable"), "{error}");
    assert!(error.contains("2.0.0 is installed"), "{error}");
}

#[test]
fn ext12_an_incompatible_api_or_an_invalid_declaration_is_never_installed() {
    let fx = fixture("ext12-api");
    let service = fx.service();
    install_with(&fx, &service, "acme.base", "1.0.0", serde_json::json!({})).unwrap();
    let before = inventory(&fx);
    for (extra, code) in [
        (
            serde_json::json!({"engines": {"yavin": "^3.0.0"}}),
            "IncompatibleApi",
        ),
        (
            serde_json::json!({"engines": {"yavin": "^1.0.0"}}),
            "IncompatibleApi",
        ),
        (
            serde_json::json!({"engines": {"yavin": "latest"}}),
            "InvalidManifest",
        ),
        (serde_json::json!({"engines": null}), "InvalidManifest"),
        (
            serde_json::json!({"dependencies": {"acme.base": "1.0.0 || 2.0.0"}}),
            "InvalidManifest",
        ),
        (
            serde_json::json!({"dependencies": {"acme.app": "*"}}),
            "InvalidManifest",
        ),
        (
            serde_json::json!({"extensionDependencies": ["acme.base", "acme.base"]}),
            "InvalidManifest",
        ),
        (serde_json::json!({"manifestVersion": 9}), "InvalidManifest"),
        (
            serde_json::json!({"incompatibilities": {"acme.base": "*"}}),
            "DependencyConflict",
        ),
    ] {
        let error = install_with(&fx, &service, "acme.app", "1.0.0", extra.clone()).unwrap_err();
        assert!(error.starts_with(code), "{extra}: {error}");
        unchanged(&fx, &before);
    }
}

#[test]
fn ext12_a_cycle_among_installed_copies_is_refused() {
    let fx = fixture("ext12-cycle");
    // Two development copies that need each other (an installed pair could not be made so).
    for (id, needs) in [("acme.a", "acme.b"), ("acme.b", "acme.a")] {
        let (publisher, name) = id.split_once('.').unwrap();
        fx.folder(
            &fx.development,
            id,
            &serde_json::json!({"publisher": publisher, "name": name, "version": "1.0.0", "engines": {"yavin": "^2.0.0"}, "main": "extension.js", "extensionDependencies": [needs]}).to_string(),
        );
    }
    let service = fx.service();
    let error = install_with(
        &fx,
        &service,
        "acme.c",
        "1.0.0",
        serde_json::json!({"extensionDependencies": ["acme.a"]}),
    )
    .unwrap_err();
    assert!(error.starts_with("DependencyCycle"), "{error}");
    assert!(error.contains("acme.a → acme.b → acme.a"), "{error}");
}

#[test]
fn ext12_a_failed_update_or_a_rollback_keeps_the_graph_whole() {
    let fx = fixture("ext12-rollback");
    let service = fx.service();
    install_with(&fx, &service, "acme.base", "1.0.0", serde_json::json!({})).unwrap();
    install_with(
        &fx,
        &service,
        "acme.app",
        "1.0.0",
        serde_json::json!({"dependencies": {"acme.base": "^1.0.0"}}),
    )
    .unwrap();
    let before = inventory(&fx);
    // A package that is not what it claims (it fails verification): nothing changes.
    let wrong = package_with(&fx, "acme.base", "1.5.0", serde_json::json!({}));
    let error = stage_file(&service, &wrong, "acme.base", "1.6.0").unwrap_err();
    assert!(error.starts_with("ManifestMismatch"), "{error}");
    unchanged(&fx, &before);
    assert!(
        service.host_copy("acme.app").is_ok(),
        "its dependent still loads"
    );
    // An update whose registration fails is rolled back: the graph is as it was.
    let op = stage_file(
        &service,
        &package_with(&fx, "acme.base", "1.2.0", serde_json::json!({})),
        "acme.base",
        "1.2.0",
    )
    .unwrap();
    service.commit(&op, "acme.base").unwrap();
    service.finish(&op, "acme.base", false).unwrap();
    assert_eq!(
        inventory(&fx).extensions["acme.base"].active.version,
        "1.0.0"
    );
    let app = service.host_copy("acme.app").unwrap();
    assert_eq!(app.requires.len(), 1);
    assert!(service.authorize(&app, None).is_ok());
}

/// What the window believes is never asked: a load reads the manifest natively, so a code
/// extension with no API range, an incompatible one, or one whose dependency is gone does not
/// load -- and a dependency disabled, removed or replaced holds at the next request.
#[test]
fn ext12_loading_and_every_request_check_the_api_and_dependencies_natively() {
    let fx = fixture("ext12-load");
    for (folder, manifest) in [
        (
            "no-api",
            r#"{"publisher":"acme","name":"noapi","version":"1.0.0","main":"extension.js"}"#,
        ),
        (
            "future",
            r#"{"publisher":"acme","name":"future","version":"1.0.0","engines":{"yavin":"^3.0.0"},"main":"extension.js"}"#,
        ),
    ] {
        fx.folder(&fx.development, folder, manifest);
    }
    let service = fx.service();
    assert!(service
        .host_copy("acme.noapi")
        .unwrap_err()
        .starts_with("InvalidManifest"));
    assert!(service
        .host_copy("acme.future")
        .unwrap_err()
        .starts_with("IncompatibleApi"));
    install_with(&fx, &service, "acme.base", "1.0.0", serde_json::json!({})).unwrap();
    install_with(
        &fx,
        &service,
        "acme.app",
        "1.0.0",
        serde_json::json!({"dependencies": {"acme.base": "^1.0.0"}}),
    )
    .unwrap();
    let app = service.host_copy("acme.app").unwrap();
    assert_eq!(
        app.requires,
        [HostRequirement {
            id: "acme.base".into(),
            range: crate::extension_dependencies::Range::parse("^1.0.0").unwrap(),
            code: true,
            installed: true,
        }]
    );
    assert!(service.authorize(&app, None).is_ok());
    // Disabled: its dependent's code is refused at once, and it does not load.
    service.set_enabled("acme.base", false).unwrap();
    assert_eq!(
        service.authorize(&app, None).unwrap_err().code,
        "DependencyUnavailable"
    );
    assert!(service
        .host_copy("acme.app")
        .unwrap_err()
        .starts_with("DependencyUnavailable"));
    service.set_enabled("acme.base", true).unwrap();
    assert!(service.authorize(&app, None).is_ok());
    // Removed: the same.
    service.uninstall("acme.base").unwrap();
    assert_eq!(
        service.authorize(&app, None).unwrap_err().code,
        "DependencyUnavailable"
    );
    assert!(service
        .host_copy("acme.app")
        .unwrap_err()
        .contains("not installed"));
    // Its own grants and copy are untouched by any of it (EXT-07).
    assert_eq!(
        inventory(&fx).extensions["acme.app"].active.version,
        "1.0.0"
    );
}

// --- EXT-13: profiles and secrets through the inventory ----------------------------------------

use crate::extension_secrets::tests::{Failing, MemoryBackend};

fn with_memory_secrets(service: &ExtensionService) -> std::sync::Arc<MemoryBackend> {
    let backend = std::sync::Arc::new(MemoryBackend::default());
    service.use_secret_backend(backend.clone());
    backend
}

/// An installed extension that asks for `secrets`, and the grant of it.
fn secret_keeper(fx: &Fixture, service: &ExtensionService, id: &str) -> HostCopy {
    install_with(
        fx,
        service,
        id,
        "1.0.0",
        serde_json::json!({"permissions": {"version": 1, "request": ["secrets"]}}),
    )
    .unwrap();
    service
        .set_grants(id, None, &strings(&["secrets"]))
        .unwrap();
    service.host_copy(id).unwrap()
}

fn secret(
    service: &ExtensionService,
    copy: &HostCopy,
    workspace: Option<&str>,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, Denial> {
    service.secret(copy, workspace, method, &params)
}

#[test]
fn ext13_profiles_switch_the_enabled_set_in_one_write_and_survive_a_restart() {
    let fx = fixture("ext13-profiles");
    let service = fx.service();
    install(&fx, &service, "acme.one", "1.0.0");
    install(&fx, &service, "acme.two", "1.0.0");
    service.set_enabled("acme.two", false).unwrap();
    let work = service.create_profile("Work").unwrap();
    assert_eq!(work.profiles.len(), 2);
    // The new profile starts as the active one is; switching to it changes nothing yet.
    let switched = service.select_profile("work").unwrap();
    assert_eq!(switched.profiles.active, "work");
    assert!(inventory(&fx).disabled.contains("acme.two"));
    // In "work", one is disabled and two enabled; "default" keeps what it had.
    service.set_enabled("acme.one", false).unwrap();
    service.set_enabled("acme.two", true).unwrap();
    service.select_profile("default").unwrap();
    assert_eq!(
        inventory(&fx).disabled.iter().cloned().collect::<Vec<_>>(),
        ["acme.two"]
    );
    assert!(service.host_copy("acme.one").is_ok());
    assert!(service
        .host_copy("acme.two")
        .unwrap_err()
        .starts_with("ExtensionDisabled"));
    drop(service);
    // A restart reads the same.
    let service = fx.service();
    assert_eq!(service.profiles().unwrap().active, "default");
    service.select_profile("work").unwrap();
    assert!(service
        .host_copy("acme.one")
        .unwrap_err()
        .starts_with("ExtensionDisabled"));
    assert!(service.host_copy("acme.two").is_ok());
    // Renamed, then deleted (not while active, never the default).
    service.rename_profile("work", "Office").unwrap();
    assert!(service
        .delete_profile("work")
        .unwrap_err()
        .starts_with("ProfileActive"));
    assert!(service.delete_profile("default").is_err());
    service.select_profile("default").unwrap();
    service.delete_profile("work").unwrap();
    assert_eq!(service.profiles().unwrap().profiles.len(), 1);
    assert!(service
        .select_profile("work")
        .unwrap_err()
        .starts_with("ProfileNotFound"));
    // Uninstall forgets it in every profile.
    service.create_profile("Other").unwrap();
    service.uninstall("acme.two").unwrap();
    assert!(inventory(&fx)
        .profiles
        .list
        .values()
        .all(|p| !p.disabled.contains("acme.two")));
    assert!(!inventory(&fx).disabled.contains("acme.two"));
}

#[test]
fn ext13_a_profile_never_grants_and_its_dependencies_are_said() {
    let fx = fixture("ext13-profile-deps");
    let service = fx.service();
    install_with(&fx, &service, "acme.base", "1.0.0", serde_json::json!({})).unwrap();
    install_with(&fx, &service, "acme.app", "1.0.0", serde_json::json!({"dependencies": {"acme.base": "^1.0.0"}, "permissions": {"version": 1, "request": ["documents.read"]}})).unwrap();
    service.create_profile("Lean").unwrap();
    service.select_profile("lean").unwrap();
    service.set_enabled("acme.base", false).unwrap();
    service.select_profile("default").unwrap();
    // Switching to a profile that disables a required dependency: done, and said.
    let switched = service.select_profile("lean").unwrap();
    assert_eq!(switched.unavailable.len(), 1, "{:?}", switched.unavailable);
    assert_eq!(switched.unavailable[0].id, "acme.app");
    assert!(switched.unavailable[0]
        .reason
        .starts_with("DependencyUnavailable"));
    assert!(service
        .host_copy("acme.app")
        .unwrap_err()
        .starts_with("DependencyUnavailable"));
    // Back: it loads -- and a profile never granted it anything.
    service.select_profile("default").unwrap();
    let app = service.host_copy("acme.app").unwrap();
    assert_eq!(
        service
            .authorize(&app, Some("documents.read"))
            .unwrap_err()
            .code,
        "PermissionDenied"
    );
}

/// A manifest addition declaring `<id>.color`, a string, for an extension `acme.one`.
fn declares_color() -> serde_json::Value {
    serde_json::json!({"contributes": {"configuration": {"properties": {
        "acme.one.color": {"type": "string", "default": "black", "description": "Its colour."}
    }}}})
}

#[test]
fn ext13_profile_settings_are_an_extensions_own_and_per_profile() {
    let fx = fixture("ext13-settings");
    let service = fx.service();
    // A setting it declares (EXT-18: a profile keeps only those).
    install_with(&fx, &service, "acme.one", "1.0.0", declares_color()).unwrap();
    service
        .set_profile_setting("acme.one", "acme.one.color", Some(serde_json::json!("red")))
        .unwrap();
    assert!(service
        .set_profile_setting("acme.one", "acme.two.color", Some(serde_json::json!("x")))
        .is_err());
    service.create_profile("Work").unwrap();
    service.select_profile("work").unwrap();
    service
        .set_profile_setting(
            "acme.one",
            "acme.one.color",
            Some(serde_json::json!("blue")),
        )
        .unwrap();
    assert_eq!(
        service.list(None).unwrap().profiles.settings["acme.one"]["acme.one.color"],
        serde_json::json!("blue")
    );
    service.select_profile("default").unwrap();
    assert_eq!(
        service.list(None).unwrap().profiles.settings["acme.one"]["acme.one.color"],
        serde_json::json!("red")
    );
}

#[test]
fn ext13_corrupted_profiles_fall_back_to_the_default_and_are_said() {
    let fx = fixture("ext13-corrupt");
    drop(installed(&fx));
    let mut inv = inventory(&fx);
    inv.profiles.active = "vanished".into();
    inv.profiles.list.insert(
        "Bad Id".into(),
        crate::extension_profiles::Profile {
            name: "x".into(),
            disabled: Default::default(),
            settings: Default::default(),
        },
    );
    let text = serde_json::to_string(&inv).unwrap();
    fs::write(fx.root.join(INVENTORY), &text).unwrap();
    fs::write(fx.root.join(LAST_GOOD), &text).unwrap();
    let service = fx.service();
    let profiles = service.profiles().unwrap();
    assert_eq!(profiles.active, "default");
    assert_eq!(profiles.profiles.len(), 1);
    assert!(recovered(&fx, "the default profile is used"));
    // An inventory from before EXT-13 (no profiles): the default, with what was disabled.
    let mut old: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(fx.root.join(INVENTORY)).unwrap()).unwrap();
    old.as_object_mut().unwrap().remove("profiles");
    let text = old.to_string();
    fs::write(fx.root.join(INVENTORY), &text).unwrap();
    fs::write(fx.root.join(LAST_GOOD), &text).unwrap();
    let service = fx.service();
    assert_eq!(service.profiles().unwrap().active, "default");
    assert!(inventory(&fx).disabled.contains("acme.other"));
}

#[test]
fn ext13_concurrent_profile_switches_leave_a_whole_state() {
    let fx = fixture("ext13-concurrent");
    let service = std::sync::Arc::new(fx.service());
    install(&fx, &service, "acme.one", "1.0.0");
    install(&fx, &service, "acme.two", "1.0.0");
    service.create_profile("A").unwrap();
    service.create_profile("B").unwrap();
    service.select_profile("a").unwrap();
    service.set_enabled("acme.one", false).unwrap();
    service.select_profile("b").unwrap();
    service.set_enabled("acme.two", false).unwrap();
    std::thread::scope(|scope| {
        for n in 0..8 {
            let service = service.clone();
            scope.spawn(move || {
                for _ in 0..10 {
                    service
                        .select_profile(if n % 2 == 0 { "a" } else { "b" })
                        .unwrap();
                }
            });
        }
    });
    let inv = inventory(&fx);
    let expected = if inv.profiles.active == "a" {
        "acme.one"
    } else {
        "acme.two"
    };
    assert_eq!(inv.disabled.iter().cloned().collect::<Vec<_>>(), [expected]);
    let other = if inv.profiles.active == "a" { "b" } else { "a" };
    let kept = if other == "a" { "acme.one" } else { "acme.two" };
    assert_eq!(
        inv.profiles.list[other]
            .disabled
            .iter()
            .cloned()
            .collect::<Vec<_>>(),
        [kept]
    );
}

#[test]
fn ext13_secrets_need_the_grant_and_stay_with_their_extension_profile_and_workspace() {
    let fx = fixture("ext13-secrets");
    let service = fx.service();
    let backend = with_memory_secrets(&service);
    let one = secret_keeper(&fx, &service, "acme.one");
    let two = secret_keeper(&fx, &service, "acme.two");
    let store = |copy: &HostCopy, value: &str| {
        secret(
            &service,
            copy,
            None,
            "secrets.store",
            serde_json::json!({"key": "token", "value": value}),
        )
    };
    let get = |copy: &HostCopy, workspace: Option<&str>, scope: &str| {
        secret(
            &service,
            copy,
            workspace,
            "secrets.get",
            serde_json::json!({"key": "token", "scope": scope}),
        )
    };
    store(&one, "one-token").unwrap();
    store(&two, "two-token").unwrap();
    assert_eq!(get(&one, None, "installation").unwrap(), "one-token");
    assert_eq!(get(&two, None, "installation").unwrap(), "two-token");
    // A workspace secret: per workspace, none without one.
    assert_eq!(
        get(&one, Some("C:/w1"), "workspace").unwrap(),
        serde_json::Value::Null
    );
    secret(
        &service,
        &one,
        Some("C:/w1"),
        "secrets.store",
        serde_json::json!({"key": "token", "value": "w1", "scope": "workspace"}),
    )
    .unwrap();
    assert_eq!(get(&one, Some("C:/w1"), "workspace").unwrap(), "w1");
    assert_eq!(
        get(&one, Some("C:/w2"), "workspace").unwrap(),
        serde_json::Value::Null
    );
    assert_eq!(
        get(&one, None, "workspace").unwrap_err().code,
        "NoWorkspace"
    );
    // Another profile has its own.
    service.create_profile("Work").unwrap();
    service.select_profile("work").unwrap();
    assert_eq!(
        get(&one, None, "installation").unwrap(),
        serde_json::Value::Null
    );
    service.select_profile("default").unwrap();
    assert_eq!(get(&one, None, "installation").unwrap(), "one-token");
    // Revoked: refused at once; allowed again: there.
    service.set_grants("acme.one", None, &[]).unwrap();
    assert_eq!(
        get(&one, None, "installation").unwrap_err().code,
        "PermissionDenied"
    );
    service
        .set_grants("acme.one", None, &strings(&["secrets"]))
        .unwrap();
    assert_eq!(get(&one, None, "installation").unwrap(), "one-token");
    // Disabled: refused.
    service.set_enabled("acme.one", false).unwrap();
    assert_eq!(
        get(&one, None, "installation").unwrap_err().code,
        "ExtensionDisabled"
    );
    service.set_enabled("acme.one", true).unwrap();
    // Without asking for it in its manifest, no grant can give it.
    install(&fx, &service, "acme.plain", "1.0.0");
    let plain = service.host_copy("acme.plain").unwrap();
    assert_eq!(
        get(&plain, None, "installation").unwrap_err().code,
        "PermissionDenied"
    );
    // Nothing of a value is in the inventory, its last-good copy or any file of Yavin's.
    let files: Vec<String> = [INVENTORY, LAST_GOOD]
        .iter()
        .map(|f| fs::read_to_string(fx.root.join(f)).unwrap())
        .collect();
    assert!(files
        .iter()
        .all(|text| !text.contains("one-token") && !text.contains("two-token")));
    // Uninstalled: its secrets go, in every profile and scope; the other's stay.
    service.select_profile("work").unwrap();
    secret(
        &service,
        &one,
        None,
        "secrets.store",
        serde_json::json!({"key": "k", "value": "work-one"}),
    )
    .unwrap();
    service.select_profile("default").unwrap();
    service.uninstall("acme.one").unwrap();
    let left: Vec<String> = backend.0.lock().unwrap().keys().cloned().collect();
    assert!(left.iter().all(|t| !t.contains("/acme.one/")), "{left:?}");
    assert_eq!(get(&two, None, "installation").unwrap(), "two-token");
    // Deleting a profile deletes its secrets.
    service.select_profile("work").unwrap();
    secret(
        &service,
        &two,
        None,
        "secrets.store",
        serde_json::json!({"key": "k", "value": "work-two"}),
    )
    .unwrap();
    service.select_profile("default").unwrap();
    service.delete_profile("work").unwrap();
    assert!(backend
        .0
        .lock()
        .unwrap()
        .keys()
        .all(|t| !t.contains("/work/")));
}

#[test]
fn ext13_an_update_keeps_its_secrets_but_another_origin_or_a_rebuild_cannot_read_them() {
    let fx = fixture("ext13-owner");
    let service = fx.service();
    let backend = with_memory_secrets(&service);
    let first = secret_keeper(&fx, &service, "acme.one");
    let value = "the-value-v8x2q";
    secret(
        &service,
        &first,
        None,
        "secrets.store",
        serde_json::json!({"key": "token", "value": value}),
    )
    .unwrap();
    // Updated through the same pipeline (the same origin): still its own.
    install_with(
        &fx,
        &service,
        "acme.one",
        "1.1.0",
        serde_json::json!({"permissions": {"version": 1, "request": ["secrets"]}}),
    )
    .unwrap();
    service
        .set_grants("acme.one", None, &strings(&["secrets"]))
        .unwrap();
    let updated = service.host_copy("acme.one").unwrap();
    assert_eq!(
        secret(
            &service,
            &updated,
            None,
            "secrets.get",
            serde_json::json!({"key": "token"})
        )
        .unwrap(),
        value
    );
    // Rolled back (a failed update): the previous copy, same origin, still reads it.
    let op = stage_file(
        &service,
        &package_with(
            &fx,
            "acme.one",
            "1.2.0",
            serde_json::json!({"permissions": {"version": 1, "request": ["secrets"]}}),
        ),
        "acme.one",
        "1.2.0",
    )
    .unwrap();
    service.commit(&op, "acme.one").unwrap();
    service.finish(&op, "acme.one", false).unwrap();
    service
        .set_grants("acme.one", None, &strings(&["secrets"]))
        .unwrap();
    let back = service.host_copy("acme.one").unwrap();
    assert_eq!(back.version, "1.1.0");
    assert_eq!(
        secret(
            &service,
            &back,
            None,
            "secrets.get",
            serde_json::json!({"key": "token"})
        )
        .unwrap(),
        value
    );
    drop(service);
    // The inventory says another origin -- installed from elsewhere, or rebuilt by recovery:
    // that copy cannot read it (after a restart, from the same store).
    for origin in ["registry https://elsewhere.example/", "unknown"] {
        let mut inv = inventory(&fx);
        inv.extensions.get_mut("acme.one").unwrap().active.source = origin.into();
        let text = serde_json::to_string(&inv).unwrap();
        fs::write(fx.root.join(INVENTORY), &text).unwrap();
        fs::write(fx.root.join(LAST_GOOD), &text).unwrap();
        let restarted = fx.service();
        restarted.use_secret_backend(backend.clone());
        // EXT-19: a source changed in the inventory does not match the copy's trust record --
        // the copy does not load at all.
        assert!(restarted
            .host_copy("acme.one")
            .unwrap_err()
            .starts_with("TrustStateInvalid"));
        // And the secrets' own check, should code of another origin ever be loaded: refused.
        let mut copy = back.clone();
        copy.origin = origin.into();
        let error = secret(
            &restarted,
            &copy,
            None,
            "secrets.get",
            serde_json::json!({"key": "token"}),
        )
        .unwrap_err();
        assert_eq!(error.code, "SecretOwnerChanged", "{origin}");
        assert!(!error.message.contains(value));
    }
}

#[test]
fn ext13_without_a_store_secrets_fail_closed_and_nothing_is_kept_in_plaintext() {
    let fx = fixture("ext13-unavailable");
    let service = fx.service();
    service.use_secret_backend(std::sync::Arc::new(Failing));
    let one = secret_keeper(&fx, &service, "acme.one");
    let error = secret(
        &service,
        &one,
        None,
        "secrets.store",
        serde_json::json!({"key": "token", "value": "plaintext-would-be-here"}),
    )
    .unwrap_err();
    assert_eq!(error.code, "SecretStorageUnavailable");
    assert!(!error.message.contains("plaintext-would-be-here"));
    assert_eq!(
        secret(
            &service,
            &one,
            None,
            "secrets.get",
            serde_json::json!({"key": "token"})
        )
        .unwrap_err()
        .code,
        "SecretStorageUnavailable"
    );
    let anywhere = walk_files(&fx.dir);
    assert!(anywhere
        .iter()
        .all(|text| !text.contains("plaintext-would-be-here")));
    // A profile whose secrets cannot be deleted is kept.
    service.create_profile("Work").unwrap();
    assert!(service
        .delete_profile("work")
        .unwrap_err()
        .starts_with("SecretStorageUnavailable"));
    assert_eq!(service.profiles().unwrap().profiles.len(), 2);
}

fn walk_files(dir: &Path) -> Vec<String> {
    let mut all = Vec::new();
    for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.is_dir() {
            all.extend(walk_files(&path));
        } else if let Ok(bytes) = fs::read(&path) {
            all.push(String::from_utf8_lossy(&bytes).into_owned());
        }
    }
    all
}

// --- EXT-14: install, rollback, recovery and safe mode, recorded ---------------------------

#[test]
fn ext14_install_refusals_rollbacks_and_recoveries_are_recorded_and_cleared() {
    let fx = fixture("ext14-install");
    let service = fx.service();
    let codes = |service: &ExtensionService, id: &str| -> Vec<String> {
        service
            .diagnostics_for("main", Some(id))
            .into_iter()
            .map(|d| d.code)
            .collect()
    };
    // An incompatible API, a missing dependency: refusals, said with what to do.
    assert!(install_with(
        &fx,
        &service,
        "acme.future",
        "1.0.0",
        serde_json::json!({"engines": {"yavin": "^3.0.0"}})
    )
    .is_err());
    assert!(install_with(
        &fx,
        &service,
        "acme.app",
        "1.0.0",
        serde_json::json!({"dependencies": {"acme.base": "^1.0.0"}})
    )
    .is_err());
    let future = service.diagnostics_for("main", Some("acme.future"));
    assert_eq!(future[0].code, "IncompatibleApi");
    assert_eq!(
        future[0].category,
        crate::extension_diagnostics::Category::Api
    );
    assert!(future[0].refusal && future[0].remedy.is_some());
    assert_eq!(future[0].version.as_deref(), Some("1.0.0"));
    assert_eq!(future[0].phase, "install");
    assert_eq!(codes(&service, "acme.app"), ["DependencyMissing"]);
    // An update whose registration fails: rolled back, recorded with its install's correlation.
    install(&fx, &service, "acme.base", "1.0.0");
    let op = stage_file(
        &service,
        &fx.package("acme.base", "1.1.0"),
        "acme.base",
        "1.1.0",
    )
    .unwrap();
    service.commit(&op, "acme.base").unwrap();
    service.finish(&op, "acme.base", false).unwrap();
    let rolled = service.diagnostics_for("main", Some("acme.base"));
    assert_eq!(rolled[0].code, "InstallRolledBack");
    assert!(!rolled[0].refusal);
    assert_eq!(
        rolled[0].correlation.as_deref(),
        Some(format!("install-{op}").as_str())
    );
    drop(service);
    // A damaged inventory, restored: the recovery is shown, its paths redacted.
    fs::write(fx.root.join(INVENTORY), "{ not json").unwrap();
    let service = fx.service();
    service.list(None).unwrap();
    let recovered = service
        .diagnostics_for("main", None)
        .into_iter()
        .find(|d| d.code == "InventoryRecovered")
        .expect("the recovery is a diagnostic");
    let detail = recovered.detail.unwrap();
    assert!(detail.contains("<path>"), "{detail}");
    assert!(!detail.contains(&fx.root.display().to_string()), "{detail}");
    // Kept on disk: a restart still shows the install refusals.
    assert!(codes(&service, "acme.future").contains(&"IncompatibleApi".to_string()));
    // Cleared: the records and the recovery notes go; nothing installed, allowed or trusted does.
    let before = inventory(&fx);
    assert!(service.clear_diagnostics("main", None).unwrap() >= 4);
    assert!(service.diagnostics_for("main", None).is_empty());
    let after = inventory(&fx);
    assert_eq!(after.extensions, before.extensions);
    assert_eq!(after.grants, before.grants);
    assert_eq!(after.disabled, before.disabled);
    assert!(after.recoveries.is_empty());
}

#[test]
fn ext14_safe_mode_refuses_code_and_changes_nothing_else() {
    let fx = fixture("ext14-safe");
    let service = fx.service();
    install_with(
        &fx,
        &service,
        "acme.one",
        "1.0.0",
        serde_json::json!({"permissions": {"version": 1, "request": ["documents.read"]}}),
    )
    .unwrap();
    service
        .set_grants("acme.one", None, &strings(&["documents.read"]))
        .unwrap();
    let copy = service.host_copy("acme.one").unwrap();
    let before = inventory(&fx);
    service.set_safe_mode(true);
    let refused = service.host_copy("acme.one").unwrap_err();
    assert!(refused.starts_with("SafeMode"), "{refused}");
    assert!(service
        .diagnostics_for("main", None)
        .iter()
        .any(|d| d.code == "SafeMode"));
    // Nothing installed, enabled, granted or signed changed.
    let during = inventory(&fx);
    assert_eq!(during.extensions, before.extensions);
    assert_eq!(during.grants, before.grants);
    assert_eq!(during.disabled, before.disabled);
    // It only refuses: what was allowed stays allowed once it is off.
    service.set_safe_mode(false);
    assert_eq!(service.host_copy("acme.one").unwrap(), copy);
    assert!(service.authorize(&copy, Some("documents.read")).is_ok());
}

// --- EXT-15: installed bytes, sources and reconstructed copies ----------------------------------

#[test]
fn ext15_a_changed_active_copy_falls_back_to_its_intact_previous_one() {
    let fx = fixture("ext15-fallback");
    let service = fx.service();
    install(&fx, &service, "acme.hello", "1.0.0");
    install(&fx, &service, "acme.hello", "2.0.0");
    let record = inventory(&fx).extensions["acme.hello"].clone();
    let active = join(&fx.root, &record.active.folder);
    fs::write(
        active.join("extension.js"),
        "module.exports.version = 'tampered';",
    )
    .unwrap();
    // Not used: the intact previous version is, and that is said.
    assert_eq!(version_listed(&service, "acme.hello"), "1.0.0");
    assert!(recovered(&fx, "files changed"));
    let copy = service.host_copy("acme.hello").unwrap();
    assert_eq!(copy.version, "1.0.0");
    // The changed copy's grants are not applied to it -- it is not the copy in use.
    assert_eq!(
        inventory(&fx).extensions["acme.hello"].active.version,
        "1.0.0"
    );
}

#[test]
fn ext15_a_local_file_is_never_signed_and_a_record_naming_another_source_is_not_shown() {
    let fx = fixture("ext15-file");
    let service = fx.service();
    install(&fx, &service, "acme.hello", "1.0.0");
    let record = inventory(&fx).extensions["acme.hello"].active.clone();
    let signature = record.signature.clone().unwrap();
    assert_eq!(signature.status, SignatureStatus::Missing);
    assert_eq!(signature.registry, "file");
    assert_eq!(record.source, "file");
    assert_eq!(
        entry(&service, "acme.hello").signature.unwrap().status,
        SignatureStatus::Missing
    );
    // A record that says "signed by a registry" for a copy installed from a file -- bytes and
    // all matching -- is not this copy's: not listed.
    drop(service);
    let mut inv = inventory(&fx);
    let active = &mut inv.extensions.get_mut("acme.hello").unwrap().active;
    let forged = active.signature.as_mut().unwrap();
    forged.status = SignatureStatus::RegistrySigned;
    forged.registry = "https://open-vsx.org".into();
    let text = serde_json::to_string(&inv).unwrap();
    fs::write(fx.root.join(INVENTORY), &text).unwrap();
    fs::write(fx.root.join(LAST_GOOD), &text).unwrap();
    assert!(entry(&fx.service(), "acme.hello").signature.is_none());
}

#[test]
fn ext15_a_different_package_whose_hash_starts_the_same_gets_a_folder_of_its_own() {
    let fx = fixture("ext15-prefix");
    let service = fx.service();
    install(&fx, &service, "acme.hello", "1.0.0");
    // Pretend the installed copy is other bytes, with the same version and hash prefix (a
    // 32-bit collision): its folder name is the one the next package would take.
    drop(service);
    let mut inv = inventory(&fx);
    let real = inv.extensions["acme.hello"].active.sha256.clone().unwrap();
    let pretend = format!("{}{}", &real[..8], "0".repeat(56));
    inv.extensions.get_mut("acme.hello").unwrap().active.sha256 = Some(pretend.clone());
    let text = serde_json::to_string(&inv).unwrap();
    fs::write(fx.root.join(INVENTORY), &text).unwrap();
    fs::write(fx.root.join(LAST_GOOD), &text).unwrap();
    let service = fx.service();
    // The same version again (the real bytes): not taken for the copy in place.
    let op = stage_file(
        &service,
        &fx.package("acme.hello", "1.0.0"),
        "acme.hello",
        "1.0.0",
    )
    .unwrap();
    service.commit(&op, "acme.hello").unwrap();
    service.finish(&op, "acme.hello", true).unwrap();
    let record = inventory(&fx).extensions["acme.hello"].clone();
    assert_eq!(record.active.sha256.as_deref(), Some(real.as_str()));
    assert!(
        record.active.folder.ends_with(&real),
        "{}",
        record.active.folder
    );
    assert_eq!(
        record.previous.as_ref().unwrap().sha256.as_deref(),
        Some(pretend.as_str())
    );
    assert_ne!(
        record.active.folder,
        record.previous.as_ref().unwrap().folder
    );
    assert_eq!(version_listed(&service, "acme.hello"), "1.0.0");
}

#[test]
fn ext15_copies_installed_before_files_were_bound_still_load_and_recovery_binds_nothing() {
    let fx = fixture("ext15-legacy");
    drop(installed(&fx));
    // An inventory from before EXT-15 (version 1): no files digest. Still used (it cannot be
    // checked) -- as a legacy copy since EXT-17, never as a verified one.
    let text = as_version_1(&fx);
    assert!(!text.contains("filesSha256"));
    let service = fx.service();
    assert_eq!(version_listed(&service, "acme.hello"), "2.0.0");
    assert_eq!(
        entry(&service, "acme.hello").integrity.unwrap().reason,
        Some("legacy")
    );
    // EXT-19: never checked, so its code does not run until it is reinstalled.
    assert!(service
        .host_copy("acme.hello")
        .unwrap_err()
        .starts_with("IntegrityUnverified"));
    // A rebuild from the folders alone: no signature, no files digest -- nothing it cannot know.
    drop(service);
    damage_beyond_the_last_good_copy(&fx);
    let service = fx.service();
    service.list(None).unwrap();
    for record in inventory(&fx).extensions.values() {
        assert!(record.active.signature.is_none() && record.active.files_sha256.is_none());
    }
}

#[test]
fn ext15_a_copy_restored_from_the_last_good_inventory_is_still_checked() {
    let fx = fixture("ext15-restore");
    let service = fx.service();
    install(&fx, &service, "acme.hello", "1.0.0");
    let folder = join(
        &fx.root,
        &inventory(&fx).extensions["acme.hello"].active.folder,
    );
    drop(service);
    fs::write(fx.root.join(INVENTORY), "{ not json").unwrap();
    fs::write(folder.join("extension.js"), "module.exports = 'changed';").unwrap();
    let service = fx.service();
    let listed = entry(&service, "acme.hello");
    assert!(
        listed
            .error
            .as_deref()
            .unwrap_or("")
            .contains("files changed"),
        "{:?}",
        listed.error
    );
    assert!(listed.signature.is_none());
    assert!(service.host_copy("acme.hello").is_err());
}

#[test]
fn ext15_a_rebuild_keeps_a_copy_in_a_full_hash_folder() {
    let fx = fixture("ext15-rebuild-full");
    let service = fx.service();
    install(&fx, &service, "acme.hello", "1.0.0");
    drop(service);
    // The folder a commit uses when the short name was another package's.
    let long = format!("1.1.0-{}", "ab".repeat(32));
    fx.folder(
        &fx.root.join(STORE).join("acme.hello"),
        &long,
        &manifest("acme.hello", "1.1.0"),
    );
    fs::write(fx.root.join(INVENTORY), "{ not json").unwrap();
    fs::write(fx.root.join(LAST_GOOD), "{ not json either").unwrap();
    let service = fx.service();
    assert_eq!(version_listed(&service, "acme.hello"), "1.1.0");
    let record = inventory(&fx).extensions["acme.hello"].clone();
    assert_eq!(record.active.folder, format!("{STORE}/acme.hello/{long}"));
    assert!(record.active.signature.is_none() && record.active.files_sha256.is_none());
}

// --- EXT-16: revocation and operations in flight -----------------------------------------------

/// A store whose next read waits until it is let go (and says when it started).
#[derive(Default)]
struct Gated {
    inner: MemoryBackend,
    armed: std::sync::atomic::AtomicBool,
    entered: Mutex<Option<std::sync::mpsc::Sender<()>>>,
    release: Mutex<Option<std::sync::mpsc::Receiver<()>>>,
}

impl crate::extension_secrets::SecretBackend for Gated {
    fn read(&self, target: &str) -> Result<Option<Vec<u8>>, String> {
        if self.armed.swap(false, std::sync::atomic::Ordering::SeqCst) {
            if let Some(entered) = self.entered.lock().unwrap().take() {
                entered.send(()).unwrap();
            }
            if let Some(release) = self.release.lock().unwrap().take() {
                release.recv().unwrap();
            }
        }
        self.inner.read(target)
    }
    fn write(&self, target: &str, comment: &str, blob: &[u8]) -> Result<(), String> {
        self.inner.write(target, comment, blob)
    }
    fn delete(&self, target: &str) -> Result<bool, String> {
        self.inner.delete(target)
    }
    fn list(&self, prefix: &str) -> Result<Vec<String>, String> {
        self.inner.list(prefix)
    }
}

/// A secret operation allowed before a revocation completes, and the revocation returns only
/// after it has: once \`set_grants\` answers, no operation it revoked is still running, and the
/// next one is refused. (Before EXT-16 the check and the operation were not one step: a
/// revocation could complete while an operation it should have stopped was still to run.)
#[test]
fn ext16_a_revocation_waits_for_the_secret_operation_already_allowed_and_stops_the_next() {
    use std::sync::atomic::{AtomicBool, Ordering};
    let fx = fixture("ext16-secret-race");
    let service = fx.service();
    let backend = std::sync::Arc::new(Gated::default());
    service.use_secret_backend(backend.clone());
    let one = secret_keeper(&fx, &service, "acme.one");
    let get = || {
        secret(
            &service,
            &one,
            None,
            "secrets.get",
            serde_json::json!({"key": "token"}),
        )
    };
    secret(
        &service,
        &one,
        None,
        "secrets.store",
        serde_json::json!({"key": "token", "value": "the-token"}),
    )
    .unwrap();
    let (entered_tx, entered) = std::sync::mpsc::channel();
    let (release, release_rx) = std::sync::mpsc::channel();
    *backend.entered.lock().unwrap() = Some(entered_tx);
    *backend.release.lock().unwrap() = Some(release_rx);
    backend.armed.store(true, Ordering::SeqCst);
    let revoked = AtomicBool::new(false);
    std::thread::scope(|scope| {
        let reading = scope.spawn(get);
        entered.recv().unwrap();
        let revoking = scope.spawn(|| {
            service.set_grants("acme.one", None, &[]).unwrap();
            revoked.store(true, Ordering::SeqCst);
        });
        std::thread::sleep(std::time::Duration::from_millis(300));
        let answered_early = revoked.load(Ordering::SeqCst);
        // Let the operation go before anything can fail (a failure must not leave it waiting).
        release.send(()).unwrap();
        assert!(
            !answered_early,
            "the revocation answered while an operation it covers was still running"
        );
        // Allowed before the revocation: it completes.
        assert_eq!(reading.join().unwrap().unwrap(), "the-token");
        revoking.join().unwrap();
    });
    assert!(revoked.load(Ordering::SeqCst));
    assert_eq!(get().unwrap_err().code, "PermissionDenied");
}

/// A revocation is of that one capability of that one extension: the others it was allowed,
/// other extensions' grants and every signature record are as they were. It holds after an
/// application restart (a new service over the same folder), and a profile switch there and
/// back does not bring it back.
#[test]
fn ext16_a_revocation_touches_nothing_else_and_survives_a_restart_and_profile_switches() {
    let fx = fixture("ext16-revoke-scope");
    let service = fx.service();
    let both = ["documents.read", "workspace.fs.read"];
    for id in ["acme.one", "acme.two"] {
        let op = install_requesting(&fx, &service, id, "1.0.0", &both);
        service.finish(&op, id, true).unwrap();
        service.set_grants(id, None, &strings(&both)).unwrap();
    }
    let before = inventory(&fx);
    let state = service
        .set_grants("acme.one", None, &strings(&["workspace.fs.read"]))
        .unwrap();
    assert_eq!(state.granted, ["workspace.fs.read"]);
    let after = inventory(&fx);
    for id in ["acme.one", "acme.two"] {
        assert_eq!(
            after.extensions[id], before.extensions[id],
            "{id}: its copies and signature record are untouched"
        );
    }
    assert_eq!(after.grants["acme.two"], before.grants["acme.two"]);
    let check = |service: &ExtensionService| {
        let one = service.host_copy("acme.one").unwrap();
        let two = service.host_copy("acme.two").unwrap();
        assert_eq!(
            service
                .authorize(&one, Some("documents.read"))
                .unwrap_err()
                .code,
            "PermissionDenied"
        );
        service.authorize(&one, Some("workspace.fs.read")).unwrap();
        for capability in both {
            service.authorize(&two, Some(capability)).unwrap();
        }
    };
    check(&service);
    // Yavin restarted.
    drop(service);
    let service = fx.service();
    check(&service);
    // Another profile and back: profiles never grant (EXT-13).
    service.create_profile("Work").unwrap();
    service.select_profile("work").unwrap();
    check(&service);
    service.select_profile("default").unwrap();
    check(&service);
    // Revoking the last one removes the grant; the other extension keeps all of its own.
    service.set_grants("acme.one", None, &[]).unwrap();
    assert!(!inventory(&fx).grants.contains_key("acme.one"));
    assert_eq!(inventory(&fx).grants["acme.two"], before.grants["acme.two"]);
}

// --- EXT-17: inventory migration, legacy integrity and recovery --------------------------------

/// The inventory as a version-1 Yavin (before EXT-15) would have written it: no files
/// digests, no `unchecked`, no `replaced`.
fn as_version_1(fx: &Fixture) -> String {
    let mut value: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(fx.root.join(INVENTORY)).unwrap()).unwrap();
    value["version"] = serde_json::json!(1);
    for record in value["extensions"].as_object_mut().unwrap().values_mut() {
        for key in ["active", "previous"] {
            if let Some(copy) = record.get_mut(key).and_then(|c| c.as_object_mut()) {
                copy.remove("filesSha256");
                copy.remove("unchecked");
                copy.remove("trust");
            }
        }
        record.as_object_mut().unwrap().remove("replaced");
    }
    let text = serde_json::to_string_pretty(&value).unwrap();
    fs::write(fx.root.join(INVENTORY), &text).unwrap();
    fs::write(fx.root.join(LAST_GOOD), &text).unwrap();
    text
}

fn backups(fx: &Fixture, prefix: &str) -> Vec<String> {
    fs::read_dir(&fx.root)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with(prefix))
        .collect()
}

/// A version-1 inventory is upgraded once: its copies without a files digest are marked
/// unchecked (legacy), nothing is raised -- their signature records are kept but not shown,
/// grants, enabled state and profiles are as they were -- the original is kept beside it, and
/// the new version is written at once. A legacy copy still runs. A second start changes nothing.
#[test]
fn ext17_a_version_1_inventory_is_upgraded_once_marked_unchecked_and_kept() {
    let fx = fixture("ext17-migrate");
    let service = installed(&fx);
    service.create_profile("Work").unwrap();
    drop(service);
    let before = inventory(&fx);
    let original = as_version_1(&fx);
    let service = fx.service();
    let listed = entry(&service, "acme.hello");
    let integrity = listed.integrity.clone().unwrap();
    assert_eq!(
        (integrity.state, integrity.reason, integrity.runs),
        ("unchecked", Some("legacy"), false)
    );
    assert!(
        listed.signature.is_none(),
        "never shown for files that were not checked"
    );
    // EXT-19: a legacy copy's code does not run until it is reinstalled.
    assert!(service
        .host_copy("acme.hello")
        .unwrap_err()
        .starts_with("IntegrityUnverified"));
    let after = inventory(&fx);
    assert_eq!(after.version, INVENTORY_VERSION);
    let active = &after.extensions["acme.hello"].active;
    assert_eq!(active.unchecked, Some(Unchecked::Legacy));
    assert!(active.files_sha256.is_none(), "no digest is made up");
    assert_eq!(
        active.signature, before.extensions["acme.hello"].active.signature,
        "the record is kept as it was"
    );
    assert_eq!(after.grants, before.grants);
    assert_eq!(after.disabled, before.disabled);
    assert_eq!(after.profiles, before.profiles);
    assert!(recovered(&fx, "upgraded from version 1"));
    let kept = backups(&fx, "inventory.json.v1-migrated-");
    assert_eq!(kept.len(), 1, "{kept:?}");
    assert_eq!(
        fs::read_to_string(fx.root.join(&kept[0])).unwrap(),
        original
    );
    // Again: nothing more to migrate, nothing more kept.
    drop(service);
    let service = fx.service();
    service.list(None).unwrap();
    assert_eq!(backups(&fx, "inventory.json.v1-migrated-").len(), 1);
    assert_eq!(inventory(&fx).extensions, after.extensions);
}

/// Reinstalling a legacy copy (the same package, verified again) checks its files: as
/// installed, they are bound -- the copy is verified and its fresh signature record shown.
#[test]
fn ext17_reinstalling_a_legacy_copy_binds_its_files() {
    let fx = fixture("ext17-bind");
    let service = fx.service();
    install(&fx, &service, "acme.hello", "1.0.0");
    let folder = inventory(&fx).extensions["acme.hello"]
        .active
        .folder
        .clone();
    drop(service);
    as_version_1(&fx);
    let service = fx.service();
    assert_eq!(
        entry(&service, "acme.hello").integrity.unwrap().state,
        "unchecked"
    );
    install(&fx, &service, "acme.hello", "1.0.0");
    let record = inventory(&fx).extensions["acme.hello"].clone();
    assert_eq!(record.active.folder, folder, "the same copy, now bound");
    assert!(record.active.files_sha256.is_some());
    assert_eq!(record.active.unchecked, None);
    let listed = entry(&service, "acme.hello");
    assert_eq!(listed.integrity.unwrap().state, "verified");
    assert_eq!(
        listed.signature.unwrap().status,
        SignatureStatus::Missing,
        "a file: unsigned, said so"
    );
}

/// Reinstalling over legacy files that are no longer the package's: the verified package gets
/// a folder of its own; the changed copy is neither reused nor kept to fall back on, and is
/// removed once the install is kept.
#[test]
fn ext17_reinstalling_over_changed_legacy_files_never_reuses_or_falls_back_to_them() {
    let fx = fixture("ext17-replace");
    let service = fx.service();
    install(&fx, &service, "acme.hello", "1.0.0");
    let old = inventory(&fx).extensions["acme.hello"]
        .active
        .folder
        .clone();
    drop(service);
    as_version_1(&fx);
    fs::write(
        join(&fx.root, &old).join("extension.js"),
        "module.exports.version = 'changed';",
    )
    .unwrap();
    let service = fx.service();
    // Unchecked: nothing can tell it changed -- it runs, and says it is not checked.
    assert_eq!(
        entry(&service, "acme.hello").integrity.unwrap().reason,
        Some("legacy")
    );
    install(&fx, &service, "acme.hello", "1.0.0");
    let record = inventory(&fx).extensions["acme.hello"].clone();
    assert_ne!(record.active.folder, old);
    assert!(
        record.previous.is_none(),
        "the changed copy is not kept to fall back on"
    );
    assert_eq!(
        entry(&service, "acme.hello").integrity.unwrap().state,
        "verified"
    );
    let code =
        fs::read_to_string(join(&fx.root, &record.active.folder).join("extension.js")).unwrap();
    assert_eq!(code, "module.exports.version = '1.0.0';");
    assert!(
        !join(&fx.root, &old).exists(),
        "removed once the install was kept"
    );
}

/// A rebuilt copy (the inventory and its last good copy lost) cannot be checked: listed as
/// such, its code does not run -- even enabled -- until it is reinstalled.
#[test]
fn ext17_a_rebuilt_copy_does_not_run_until_reinstalled() {
    let fx = fixture("ext17-rebuilt");
    drop(installed(&fx));
    damage_beyond_the_last_good_copy(&fx);
    let service = fx.service();
    let listed = entry(&service, "acme.hello");
    let integrity = listed.integrity.unwrap();
    assert_eq!(
        (integrity.state, integrity.reason, integrity.runs),
        ("unchecked", Some("rebuilt"), false)
    );
    assert!(listed.signature.is_none());
    service.set_enabled("acme.hello", true).unwrap();
    let refused = service.host_copy("acme.hello").unwrap_err();
    assert!(refused.starts_with("IntegrityUnverified"), "{refused}");
    // Restarted: still refused.
    drop(service);
    let service = fx.service();
    assert!(service
        .host_copy("acme.hello")
        .unwrap_err()
        .starts_with("IntegrityUnverified"));
    install(&fx, &service, "acme.hello", "2.0.0");
    service
        .host_copy("acme.hello")
        .expect("reinstalled: it runs");
    assert_eq!(
        entry(&service, "acme.hello").integrity.unwrap().state,
        "verified"
    );
}

/// An IDE-09 root folder adopted where it is: unchecked (no package on record), it runs, and
/// it is never shown as signed.
#[test]
fn ext17_an_adopted_folder_is_unchecked_and_never_signed() {
    let fx = fixture("ext17-adopted");
    fx.folder(&fx.root, "acme.hello", &manifest("acme.hello", "1.0.0"));
    let service = fx.service();
    let listed = entry(&service, "acme.hello");
    let integrity = listed.integrity.unwrap();
    assert_eq!(
        (integrity.state, integrity.reason, integrity.runs),
        ("unchecked", Some("adopted"), false)
    );
    assert!(listed.signature.is_none());
    assert_eq!(
        inventory(&fx).extensions["acme.hello"].active.unchecked,
        Some(Unchecked::Adopted)
    );
}

/// An inventory a newer Yavin wrote is refused -- and refused again on every start: nothing
/// is restored or rebuilt over it, no copy is moved or disabled.
#[test]
fn ext17_a_newer_inventory_is_refused_on_every_start_and_nothing_is_rebuilt() {
    let fx = fixture("ext17-newer");
    drop(installed(&fx));
    let mut value: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(fx.root.join(INVENTORY)).unwrap()).unwrap();
    value["version"] = serde_json::json!(INVENTORY_VERSION + 1);
    value["somethingNew"] = serde_json::json!({"kept": true});
    let text = value.to_string();
    fs::write(fx.root.join(INVENTORY), &text).unwrap();
    fs::write(fx.root.join(LAST_GOOD), &text).unwrap();
    let store: Vec<_> = fs::read_dir(fx.root.join(STORE).join("acme.hello"))
        .unwrap()
        .flatten()
        .map(|e| e.file_name())
        .collect();
    for _ in 0..3 {
        let refused = fx.service().list(None).unwrap_err();
        assert!(refused.starts_with("InventoryUnsupported"), "{refused}");
    }
    assert!(
        backups(&fx, ".unrecovered").is_empty(),
        "nothing was rebuilt"
    );
    let after: Vec<_> = fs::read_dir(fx.root.join(STORE).join("acme.hello"))
        .unwrap()
        .flatten()
        .map(|e| e.file_name())
        .collect();
    assert_eq!(after, store);
    let kept: Vec<_> = backups(&fx, "inventory.")
        .into_iter()
        .filter(|n| n.contains(&format!(".v{}-", INVENTORY_VERSION + 1)))
        .collect();
    assert!(!kept.is_empty());
    for name in kept {
        assert_eq!(
            fs::read_to_string(fx.root.join(name)).unwrap(),
            text,
            "kept byte for byte"
        );
    }
}

/// When the active copy cannot be used and its intact previous one takes its place, the
/// listing says which copy was replaced and why -- after a restart too -- until the next install.
#[test]
fn ext17_a_fallback_says_which_copy_it_replaced_and_why() {
    let fx = fixture("ext17-fallback");
    let service = fx.service();
    install(&fx, &service, "acme.hello", "1.0.0");
    install(&fx, &service, "acme.hello", "2.0.0");
    let active = inventory(&fx).extensions["acme.hello"]
        .active
        .folder
        .clone();
    fs::write(
        join(&fx.root, &active).join("extension.js"),
        "module.exports = 'changed';",
    )
    .unwrap();
    let listed = entry(&service, "acme.hello");
    assert_eq!(
        identity(listed.manifest.as_deref().unwrap()).unwrap().1,
        "1.0.0"
    );
    assert_eq!(
        listed.integrity.unwrap().state,
        "verified",
        "the copy used is intact"
    );
    let replaced = listed.replaced.unwrap();
    assert_eq!(replaced.version, "2.0.0");
    assert!(
        replaced.reason.contains("files changed"),
        "{}",
        replaced.reason
    );
    drop(service);
    let service = fx.service();
    assert_eq!(
        entry(&service, "acme.hello").replaced.unwrap().version,
        "2.0.0"
    );
    install(&fx, &service, "acme.hello", "2.0.0");
    let listed = entry(&service, "acme.hello");
    assert!(listed.replaced.is_none());
    assert_eq!(
        identity(listed.manifest.as_deref().unwrap()).unwrap().1,
        "2.0.0"
    );
}

/// Every field the inventory persists, pinned to its version: a new one fails this test until
/// `INVENTORY_VERSION` is raised (and a migration written) -- so an older Yavin refuses the
/// inventory rather than drop the new field on its next write.
#[test]
fn ext17_the_persisted_schema_is_pinned_to_its_version() {
    let fx = fixture("ext17-schema");
    let service = installed(&fx);
    service.create_profile("Work").unwrap();
    drop(service);
    let mut inv = inventory(&fx);
    let record = inv.extensions.get_mut("acme.hello").unwrap();
    record.broken = Some("x".into());
    record.replaced = Some(Replaced {
        version: "0.1.0".into(),
        reason: "x".into(),
        at: 1,
    });
    record.active.unchecked = Some(Unchecked::Legacy);
    record.active.signature = Some(SignatureRecord {
        status: SignatureStatus::RegistrySigned,
        registry: "https://open-vsx.org".into(),
        key_id: Some("k".into()),
        namespace: "acme".into(),
        sha256: "0".repeat(64),
        store_revision: 1,
    });
    record.previous.as_mut().unwrap().unchecked = Some(Unchecked::Adopted);
    let sealed = crate::extension_trust::TrustRecord {
        schema: 1,
        key_id: "k".into(),
        mac: "00".into(),
    };
    record.active.trust = Some(sealed.clone());
    record.previous.as_mut().unwrap().trust = Some(sealed);
    let signature = record.active.signature.clone();
    let before = record.clone();
    inv.operations.insert(
        "0123456789abcdef".into(),
        Operation {
            id: "acme.hello".into(),
            version: "3.0.0".into(),
            source: "file".into(),
            state: OpState::Staged,
            sha256: None,
            before: Some(before),
            signature,
        },
    );
    inv.recoveries.push(Recovery {
        at: 1,
        id: None,
        reason: "x".into(),
    });
    let value = serde_json::to_value(&inv).unwrap();
    // Every persisted field by its path; keys that are data (ids, profile ids, operation
    // keys, setting names) are `*`.
    fn walk(value: &serde_json::Value, path: &str, keys: &mut std::collections::BTreeSet<String>) {
        const DATA: [&str; 5] = [
            "extensions",
            "grants",
            "operations",
            "profiles.list",
            "profiles.list.*.settings",
        ];
        match value {
            serde_json::Value::Object(map) => {
                for (key, child) in map {
                    let name = if DATA.contains(&path) {
                        "*"
                    } else {
                        key.as_str()
                    };
                    let next = if path.is_empty() {
                        name.to_string()
                    } else {
                        format!("{path}.{name}")
                    };
                    if !path.ends_with("settings.*") {
                        keys.insert(next.clone());
                        walk(child, &next, keys);
                    }
                }
            }
            serde_json::Value::Array(items) => items
                .iter()
                .for_each(|item| walk(item, &format!("{path}[]"), keys)),
            _ => {}
        }
    }
    let mut keys = std::collections::BTreeSet::new();
    walk(&value, "", &mut keys);
    assert_eq!(
        INVENTORY_VERSION, 3,
        "a new version: pin its fields with it"
    );
    let text = keys.into_iter().collect::<Vec<_>>().join(
        "
",
    );
    let pinned = include_str!("extension_inventory_v3.fields.txt").replace(
        "
", "
",
    );
    assert_eq!(
        text.trim(),
        pinned.trim(),
        "the persisted fields changed:
{text}"
    );
}

// --- EXT-18: profile settings, checked natively ---------------------------------------------------

/// `acme.one` declaring one setting of each kind.
fn declares_every_kind() -> serde_json::Value {
    serde_json::json!({"contributes": {"configuration": {"properties": {
        "acme.one.enabled": {"type": "boolean", "default": true, "description": "On."},
        "acme.one.size": {"type": "number", "default": 4, "minimum": 1, "maximum": 10, "description": "Size."},
        "acme.one.label": {"type": "string", "default": "x", "description": "Label."},
        "acme.one.mode": {"enum": ["fast", "slow"], "default": "fast", "description": "Mode."}
    }}}})
}

fn change(
    key: &str,
    value: Option<serde_json::Value>,
    expected: Option<serde_json::Value>,
) -> crate::extension_profiles::SettingChange {
    crate::extension_profiles::SettingChange {
        key: key.into(),
        value,
        expected,
    }
}

/// Only settings the extension declares, each with a value valid for its declaration -- the
/// same rules as the window's; anything else is refused and nothing is written.
#[test]
fn ext18_settings_are_checked_against_what_the_extension_declares() {
    let fx = fixture("ext18-schema");
    let service = fx.service();
    install_with(&fx, &service, "acme.one", "1.0.0", declares_every_kind()).unwrap();
    use serde_json::json;
    for (key, value) in [
        ("acme.one.enabled", json!(false)),
        ("acme.one.size", json!(10)),
        ("acme.one.size", json!(1.5)),
        ("acme.one.label", json!("a label")),
        ("acme.one.mode", json!("slow")),
    ] {
        service
            .set_profile_setting("acme.one", key, Some(value.clone()))
            .unwrap_or_else(|e| panic!("{key} {value}: {e}"));
    }
    let before = inventory(&fx);
    for (key, value, code) in [
        ("acme.one.enabled", json!("true"), "InvalidSetting"),
        ("acme.one.size", json!(11), "InvalidSetting"),
        ("acme.one.size", json!(0), "InvalidSetting"),
        ("acme.one.size", json!("5"), "InvalidSetting"),
        ("acme.one.label", json!("   "), "InvalidSetting"),
        ("acme.one.label", json!("two\nlines"), "InvalidSetting"),
        ("acme.one.label", json!("x".repeat(1001)), "InvalidSetting"),
        ("acme.one.mode", json!("medium"), "InvalidSetting"),
        ("acme.one.mode", json!(1), "InvalidSetting"),
        ("acme.one.undeclared", json!(1), "UnknownSetting"),
        ("acme.two.size", json!(1), "UnknownSetting"),
    ] {
        let refused = service
            .set_profile_setting("acme.one", key, Some(value.clone()))
            .unwrap_err();
        assert!(refused.starts_with(code), "{key} {value}: {refused}");
        let refused = service
            .set_profile_settings(
                "acme.one",
                "default",
                &[change(key, Some(value.clone()), None)],
            )
            .unwrap_err();
        assert!(
            refused.starts_with(code) || refused.starts_with("SettingChanged"),
            "{key} {value}: {refused}"
        );
    }
    assert_eq!(
        inventory(&fx).profiles,
        before.profiles,
        "nothing refused was written"
    );
    // An extension that is not installed has no settings to keep.
    assert!(service
        .set_profile_setting("acme.none", "acme.none.x", Some(json!(1)))
        .unwrap_err()
        .starts_with("UnknownExtension"));
}

/// A save is all of its changes or none; a change made against a value that changed meanwhile,
/// or in a profile that is no longer the active one, is refused -- nothing saved.
#[test]
fn ext18_a_save_is_all_or_none_and_refuses_stale_values_and_switched_profiles() {
    let fx = fixture("ext18-stale");
    let service = fx.service();
    install_with(&fx, &service, "acme.one", "1.0.0", declares_every_kind()).unwrap();
    use serde_json::json;
    service
        .set_profile_settings(
            "acme.one",
            "default",
            &[
                change("acme.one.size", Some(json!(5)), None),
                change("acme.one.mode", Some(json!("slow")), None),
            ],
        )
        .unwrap();
    let saved = || {
        service
            .profiles()
            .unwrap()
            .settings
            .get("acme.one")
            .cloned()
            .unwrap_or_default()
    };
    assert_eq!(saved()["acme.one.size"], json!(5));
    // One invalid change: none of them.
    let refused = service
        .set_profile_settings(
            "acme.one",
            "default",
            &[
                change("acme.one.size", Some(json!(6)), Some(json!(5))),
                change("acme.one.mode", Some(json!("medium")), Some(json!("slow"))),
            ],
        )
        .unwrap_err();
    assert!(refused.starts_with("InvalidSetting"), "{refused}");
    assert_eq!(saved()["acme.one.size"], json!(5));
    // Another window changed it meanwhile: this change was made against 5.
    service
        .set_profile_setting("acme.one", "acme.one.size", Some(json!(7)))
        .unwrap();
    let stale = service
        .set_profile_settings(
            "acme.one",
            "default",
            &[change("acme.one.size", Some(json!(6)), Some(json!(5)))],
        )
        .unwrap_err();
    assert!(stale.starts_with("SettingChanged"), "{stale}");
    assert_eq!(saved()["acme.one.size"], json!(7));
    // Edited in "default", but "work" is active now.
    service.create_profile("Work").unwrap();
    service.select_profile("work").unwrap();
    let switched = service
        .set_profile_settings(
            "acme.one",
            "default",
            &[change("acme.one.size", Some(json!(6)), Some(json!(7)))],
        )
        .unwrap_err();
    assert!(
        switched.starts_with("ProfileChanged") && switched.contains("Work"),
        "{switched}"
    );
    service.select_profile("default").unwrap();
    assert_eq!(
        saved()["acme.one.size"],
        json!(7),
        "neither profile was changed"
    );
    // A reset removes the override: the inherited value applies again.
    service
        .set_profile_settings(
            "acme.one",
            "default",
            &[change("acme.one.size", None, Some(json!(7)))],
        )
        .unwrap();
    assert!(!saved().contains_key("acme.one.size"));
}

/// Values kept per profile survive a restart and switching there and back; one stored before
/// the extension changed what it declares (now invalid) is kept as it is -- never applied by
/// the window -- and can be reset.
#[test]
fn ext18_settings_persist_per_profile_and_a_stale_value_can_be_reset() {
    let fx = fixture("ext18-persist");
    let service = fx.service();
    install_with(&fx, &service, "acme.one", "1.0.0", declares_every_kind()).unwrap();
    use serde_json::json;
    service
        .set_profile_settings(
            "acme.one",
            "default",
            &[change("acme.one.mode", Some(json!("slow")), None)],
        )
        .unwrap();
    // A new profile starts as the active one is (EXT-13): "work" has "slow" too.
    service.create_profile("Work").unwrap();
    service.select_profile("work").unwrap();
    service
        .set_profile_settings(
            "acme.one",
            "work",
            &[change(
                "acme.one.mode",
                Some(json!("fast")),
                Some(json!("slow")),
            )],
        )
        .unwrap();
    drop(service);
    let service = fx.service();
    assert_eq!(service.profiles().unwrap().active, "work");
    assert_eq!(
        service.profiles().unwrap().settings["acme.one"]["acme.one.mode"],
        json!("fast")
    );
    service.select_profile("default").unwrap();
    assert_eq!(
        service.profiles().unwrap().settings["acme.one"]["acme.one.mode"],
        json!("slow")
    );
    // 2.0.0 declares the mode differently: the stored "slow" is no longer one of its values.
    let mut redeclared = declares_every_kind();
    redeclared["contributes"]["configuration"]["properties"]["acme.one.mode"] =
        json!({"enum": ["quick", "careful"], "default": "quick", "description": "Mode."});
    install_with(&fx, &service, "acme.one", "2.0.0", redeclared).unwrap();
    assert_eq!(
        service.profiles().unwrap().settings["acme.one"]["acme.one.mode"],
        json!("slow"),
        "kept as it was"
    );
    let invalid = service
        .set_profile_settings(
            "acme.one",
            "default",
            &[change(
                "acme.one.mode",
                Some(json!("slow")),
                Some(json!("slow")),
            )],
        )
        .unwrap_err();
    assert!(invalid.starts_with("InvalidSetting"), "{invalid}");
    service
        .set_profile_settings(
            "acme.one",
            "default",
            &[change("acme.one.mode", None, Some(json!("slow")))],
        )
        .unwrap();
    assert!(!service
        .profiles()
        .unwrap()
        .settings
        .contains_key("acme.one"));
}

/// Settings and profile switches never reach what is not theirs: grants, signature records,
/// copies and the enabled set are as they were; a secret is never in a profile's settings.
#[test]
fn ext18_settings_never_reach_grants_trust_or_secrets() {
    let fx = fixture("ext18-isolation");
    let service = fx.service();
    with_memory_secrets(&service);
    install_with(
        &fx,
        &service,
        "acme.one",
        "1.0.0",
        serde_json::json!({
            "permissions": {"version": 1, "request": ["secrets", "documents.read"]},
            "contributes": declares_every_kind()["contributes"].clone()
        }),
    )
    .unwrap();
    service
        .set_grants("acme.one", None, &strings(&["secrets"]))
        .unwrap();
    let copy = service.host_copy("acme.one").unwrap();
    secret(
        &service,
        &copy,
        None,
        "secrets.store",
        serde_json::json!({"key": "token", "value": "the-secret-value"}),
    )
    .unwrap();
    let before = inventory(&fx);
    service
        .set_profile_settings(
            "acme.one",
            "default",
            &[change(
                "acme.one.label",
                Some(serde_json::json!("shown")),
                None,
            )],
        )
        .unwrap();
    service.create_profile("Work").unwrap();
    service.select_profile("work").unwrap();
    service.select_profile("default").unwrap();
    let after = inventory(&fx);
    assert_eq!(after.grants, before.grants);
    assert_eq!(
        after.extensions, before.extensions,
        "copies and signature records"
    );
    assert_eq!(after.disabled, before.disabled);
    let view = serde_json::to_string(&service.profiles().unwrap()).unwrap();
    assert!(!view.contains("the-secret-value"));
    assert!(!fs::read_to_string(fx.root.join(INVENTORY))
        .unwrap()
        .contains("the-secret-value"));
    // Still exactly what was granted: a setting is not a capability.
    assert_eq!(
        service
            .authorize(&copy, Some("documents.read"))
            .unwrap_err()
            .code,
        "PermissionDenied"
    );
}

// --- EXT-19: strict integrity and authenticated trust records ------------------------------------

/// Rewrites the inventory and its last good copy (so no restore undoes it) with `change`.
fn tamper(fx: &Fixture, change: impl FnOnce(&mut Inventory)) {
    let mut inv = inventory(fx);
    change(&mut inv);
    let text = serde_json::to_string(&inv).unwrap();
    fs::write(fx.root.join(INVENTORY), &text).unwrap();
    fs::write(fx.root.join(LAST_GOOD), &text).unwrap();
}

fn refusal(service: &ExtensionService, id: &str) -> String {
    service
        .host_copy(id)
        .map(|_| "it runs".to_string())
        .unwrap_or_else(|e| e)
}

/// An installed copy is vouched for when it is installed -- a record bound to its facts under
/// the user's protected key -- runs, and still verifies after a restart (the key is kept).
#[test]
fn ext19_an_installed_copy_is_vouched_for_and_runs_across_restarts() {
    let fx = fixture("ext19-sealed");
    let service = fx.service();
    install(&fx, &service, "acme.hello", "1.0.0");
    let trust = inventory(&fx).extensions["acme.hello"]
        .active
        .trust
        .clone()
        .unwrap();
    assert_eq!(trust.schema, crate::extension_trust::RECORD_SCHEMA);
    assert_eq!(trust.mac.len(), 64);
    service.host_copy("acme.hello").unwrap();
    assert!(fx.root.join(crate::extension_trust::KEY_FILE).exists());
    drop(service);
    let service = fx.service();
    service
        .host_copy("acme.hello")
        .expect("the same key after a restart");
    assert_eq!(
        entry(&service, "acme.hello").integrity.unwrap().state,
        "verified"
    );
}

/// Changed files with a digest made to match, a record removed, one taken from another copy, a
/// fact changed (source, package, signature), another format or key: none verifies; the code
/// does not run, and the listing says why. Settings and grants change nothing of that.
#[test]
fn ext19_a_forged_or_changed_trust_record_fails_closed() {
    type Forge = Box<dyn Fn(&Fixture, &mut Inventory)>;
    let cases: Vec<(&str, &str, Forge)> = vec![
        (
            "files and their digest changed together",
            "mismatch",
            Box::new(|fx, inv| {
                let copy = &mut inv.extensions.get_mut("acme.hello").unwrap().active;
                let folder = join(&fx.root, &copy.folder);
                fs::write(
                    folder.join("extension.js"),
                    "module.exports = 'not the package';",
                )
                .unwrap();
                copy.files_sha256 = Some(crate::extension_package::tree_digest(&folder).unwrap());
            }),
        ),
        (
            "record removed",
            "missing",
            Box::new(|_, inv| {
                inv.extensions.get_mut("acme.hello").unwrap().active.trust = None;
            }),
        ),
        (
            "another copy's record",
            "mismatch",
            Box::new(|_, inv| {
                let other = inv.extensions["acme.other"].active.trust.clone();
                inv.extensions.get_mut("acme.hello").unwrap().active.trust = other;
            }),
        ),
        (
            "source",
            "mismatch",
            Box::new(|_, inv| {
                inv.extensions.get_mut("acme.hello").unwrap().active.source =
                    "openvsx https://open-vsx.org".into();
            }),
        ),
        (
            "package digest and its signature record",
            "mismatch",
            Box::new(|_, inv| {
                let copy = &mut inv.extensions.get_mut("acme.hello").unwrap().active;
                let forged = "f".repeat(64);
                copy.sha256 = Some(forged.clone());
                if let Some(sig) = copy.signature.as_mut() {
                    sig.sha256 = forged;
                }
            }),
        ),
        (
            "signature status raised",
            "mismatch",
            Box::new(|_, inv| {
                let copy = &mut inv.extensions.get_mut("acme.hello").unwrap().active;
                copy.signature.as_mut().unwrap().status = SignatureStatus::RegistrySigned;
            }),
        ),
        (
            "another record format",
            "schema",
            Box::new(|_, inv| {
                inv.extensions
                    .get_mut("acme.hello")
                    .unwrap()
                    .active
                    .trust
                    .as_mut()
                    .unwrap()
                    .schema = 2;
            }),
        ),
        (
            "another key named",
            "key",
            Box::new(|_, inv| {
                inv.extensions
                    .get_mut("acme.hello")
                    .unwrap()
                    .active
                    .trust
                    .as_mut()
                    .unwrap()
                    .key_id = "0123456789abcdef".into();
            }),
        ),
    ];
    for (what, reason, change) in cases {
        let fx = fixture(&format!("ext19-forged-{}", reason));
        let service = fx.service();
        install(&fx, &service, "acme.hello", "1.0.0");
        install(&fx, &service, "acme.other", "1.0.0");
        service.host_copy("acme.hello").unwrap();
        drop(service);
        tamper(&fx, |inv| change(&fx, inv));
        let service = fx.service();
        let refused = refusal(&service, "acme.hello");
        assert!(
            refused.starts_with("TrustStateInvalid") && refused.contains(reason),
            "{what}: {refused}"
        );
        let integrity = entry(&service, "acme.hello").integrity.unwrap();
        assert_eq!(
            (integrity.state, integrity.reason, integrity.runs),
            ("untrusted", Some(reason), false),
            "{what}"
        );
        assert!(
            entry(&service, "acme.hello").signature.is_none()
                || reason != "mismatch"
                || what != "signature status raised"
        );
        // Nothing the user sets grants it: a grant, a setting, enabling it.
        service.set_enabled("acme.hello", true).unwrap();
        assert!(
            refusal(&service, "acme.hello").starts_with("TrustStateInvalid"),
            "{what}"
        );
        // The other, untouched, runs.
        if what != "another copy's record" {
            service
                .host_copy("acme.other")
                .unwrap_or_else(|e| panic!("{what}: {e}"));
        }
        // A reinstall vouches for it again.
        install(&fx, &service, "acme.hello", "1.0.0");
        service
            .host_copy("acme.hello")
            .unwrap_or_else(|e| panic!("{what}, reinstalled: {e}"));
    }
}

/// The key lost (deleted) or unusable (damaged): every record made under it fails closed; a
/// damaged key file is kept aside and said; a reinstall vouches under the new key.
#[test]
fn ext19_a_lost_or_damaged_key_fails_closed_and_a_reinstall_recovers() {
    for damage in ["deleted", "damaged"] {
        let fx = fixture(&format!("ext19-key-{damage}"));
        let service = fx.service();
        install(&fx, &service, "acme.hello", "1.0.0");
        drop(service);
        let key = fx.root.join(crate::extension_trust::KEY_FILE);
        if damage == "deleted" {
            fs::remove_file(&key).unwrap();
        } else {
            fs::write(&key, b"damaged").unwrap();
        }
        let service = fx.service();
        let refused = refusal(&service, "acme.hello");
        assert!(
            refused.starts_with("TrustStateInvalid") && refused.contains("(key)"),
            "{damage}: {refused}"
        );
        if damage == "damaged" {
            assert!(recovered(&fx, "trust key could not be used"));
            assert!(fs::read_dir(&fx.root)
                .unwrap()
                .flatten()
                .any(|e| e.file_name().to_string_lossy().contains(".unreadable-")));
        }
        install(&fx, &service, "acme.hello", "1.0.0");
        service.host_copy("acme.hello").unwrap();
    }
}

/// With no protected store for the key, installs still work -- declarative contributions
/// included -- but no extension code runs, and the reason is said.
#[test]
fn ext19_without_a_key_store_no_code_runs() {
    let fx = fixture("ext19-no-store");
    let service = fx.service();
    service.use_trust_keys(std::sync::Arc::new(crate::extension_trust::Unavailable));
    install(&fx, &service, "acme.hello", "1.0.0");
    assert!(
        inventory(&fx).extensions["acme.hello"]
            .active
            .trust
            .is_none(),
        "nothing vouched for"
    );
    assert!(refusal(&service, "acme.hello").starts_with("TrustStateInvalid"));
    // Installed with a key, then the store fails: unavailable, said so.
    let fx = fixture("ext19-store-fails");
    let service = fx.service();
    install(&fx, &service, "acme.hello", "1.0.0");
    drop(service);
    let service = fx.service();
    service.use_trust_keys(std::sync::Arc::new(crate::extension_trust::Unavailable));
    let refused = refusal(&service, "acme.hello");
    assert!(refused.starts_with("TrustStateUnavailable"), "{refused}");
    assert_eq!(
        entry(&service, "acme.hello").integrity.unwrap().reason,
        Some("unavailable")
    );
}

/// Every path that makes a copy no one vouched for -- a version-1 (legacy) inventory, a
/// version-2 one (files bound, no record), an adopted folder, a rebuild -- leaves it unable to
/// run until a reinstall, which checks its files and vouches for them.
#[test]
fn ext19_every_unvouched_copy_needs_a_reinstall() {
    // Legacy (version 1).
    let fx = fixture("ext19-legacy");
    let service = fx.service();
    install(&fx, &service, "acme.hello", "1.0.0");
    drop(service);
    as_version_1(&fx);
    let service = fx.service();
    assert!(refusal(&service, "acme.hello").starts_with("IntegrityUnverified"));
    install(&fx, &service, "acme.hello", "1.0.0");
    service
        .host_copy("acme.hello")
        .expect("reinstalled: checked and vouched for");
    // Version 2: files bound, no record -- not vouched for by a migration.
    let fx = fixture("ext19-v2");
    let service = fx.service();
    install(&fx, &service, "acme.hello", "1.0.0");
    drop(service);
    let mut value: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(fx.root.join(INVENTORY)).unwrap()).unwrap();
    value["version"] = serde_json::json!(2);
    value["extensions"]["acme.hello"]["active"]
        .as_object_mut()
        .unwrap()
        .remove("trust");
    let text = value.to_string();
    fs::write(fx.root.join(INVENTORY), &text).unwrap();
    fs::write(fx.root.join(LAST_GOOD), &text).unwrap();
    let service = fx.service();
    let refused = refusal(&service, "acme.hello");
    assert!(
        refused.starts_with("TrustStateInvalid") && refused.contains("missing"),
        "{refused}"
    );
    assert!(
        inventory(&fx).extensions["acme.hello"]
            .active
            .trust
            .is_none(),
        "the migration made none"
    );
    install(&fx, &service, "acme.hello", "1.0.0");
    service.host_copy("acme.hello").unwrap();
    // Adopted: refused; a package installed over it runs, and the adopted folder is not kept to
    // fall back on as a vouched copy.
    let fx = fixture("ext19-adopted");
    fx.folder(&fx.root, "acme.hello", &manifest("acme.hello", "1.0.0"));
    let service = fx.service();
    assert!(refusal(&service, "acme.hello").starts_with("IntegrityUnverified"));
    install(&fx, &service, "acme.hello", "1.0.0");
    service.host_copy("acme.hello").unwrap();
    // Rebuilt: refused; reinstalled: runs.
    let fx = fixture("ext19-rebuilt");
    drop(installed(&fx));
    damage_beyond_the_last_good_copy(&fx);
    let service = fx.service();
    service.set_enabled("acme.hello", true).unwrap();
    assert!(refusal(&service, "acme.hello").starts_with("IntegrityUnverified"));
    for copy in inventory(&fx).extensions.values() {
        assert!(copy.active.trust.is_none(), "a rebuild vouches for nothing");
    }
    install(&fx, &service, "acme.hello", "2.0.0");
    service.host_copy("acme.hello").unwrap();
}

/// A fallback is checked on its own: an intact previous copy with a valid record runs; one
/// whose record does not verify is used (its files intact) but its code does not run.
#[test]
fn ext19_a_fallback_is_checked_on_its_own() {
    for previous_ok in [true, false] {
        let fx = fixture(&format!("ext19-fallback-{previous_ok}"));
        let service = fx.service();
        install(&fx, &service, "acme.hello", "1.0.0");
        install(&fx, &service, "acme.hello", "2.0.0");
        drop(service);
        let active = inventory(&fx).extensions["acme.hello"]
            .active
            .folder
            .clone();
        fs::write(
            join(&fx.root, &active).join("extension.js"),
            "module.exports = 'changed';",
        )
        .unwrap();
        if !previous_ok {
            tamper(&fx, |inv| {
                inv.extensions
                    .get_mut("acme.hello")
                    .unwrap()
                    .previous
                    .as_mut()
                    .unwrap()
                    .source = "file elsewhere".into();
            });
        }
        let service = fx.service();
        let listed = entry(&service, "acme.hello");
        assert_eq!(listed.replaced.unwrap().version, "2.0.0");
        if previous_ok {
            service.host_copy("acme.hello").unwrap();
        } else {
            assert_eq!(listed.integrity.unwrap().state, "untrusted");
            assert!(refusal(&service, "acme.hello").starts_with("TrustStateInvalid"));
        }
    }
}

/// An update rolled back, and an update stopped after publishing: the copy in use keeps its
/// own record and runs; the inventory never names a copy whose record was not made with it.
#[test]
fn ext19_rollback_and_an_interrupted_update_keep_a_vouched_copy() {
    let fx = fixture("ext19-rollback");
    let service = fx.service();
    install(&fx, &service, "acme.hello", "1.0.0");
    let op = stage_file(
        &service,
        &fx.package("acme.hello", "2.0.0"),
        "acme.hello",
        "2.0.0",
    )
    .unwrap();
    service.commit(&op, "acme.hello").unwrap();
    service
        .host_copy("acme.hello")
        .expect("the new copy, vouched for at commit");
    service.finish(&op, "acme.hello", false).unwrap();
    assert_eq!(version_listed(&service, "acme.hello"), "1.0.0");
    service
        .host_copy("acme.hello")
        .expect("the old copy's own record");
    // Stopped after publishing, before the switch: the next start uses the old copy, vouched.
    let op = stage_file(
        &service,
        &fx.package("acme.hello", "2.0.0"),
        "acme.hello",
        "2.0.0",
    )
    .unwrap();
    *service.crash_at.lock().unwrap() = Some("published");
    assert!(service.commit(&op, "acme.hello").is_err());
    drop(service);
    let service = fx.service();
    assert_eq!(version_listed(&service, "acme.hello"), "1.0.0");
    service.host_copy("acme.hello").unwrap();
}

/// Two Yavins starting at once over one extensions folder make one key between them: what
/// either vouches for, the other -- and any later start -- verifies.
#[test]
fn ext19_two_yavins_share_one_key() {
    let fx = fixture("ext19-two");
    let (a, b) = (fx.service(), fx.service());
    // Both list at once: each gets the key, made by whichever came first.
    std::thread::scope(|scope| {
        scope.spawn(|| a.list(None).unwrap());
        scope.spawn(|| b.list(None).unwrap());
    });
    install(&fx, &a, "acme.one", "1.0.0");
    drop((a, b));
    let c = fx.service();
    install(&fx, &c, "acme.two", "1.0.0");
    let inv = inventory(&fx);
    let ids: Vec<_> = ["acme.one", "acme.two"]
        .iter()
        .map(|id| inv.extensions[*id].active.trust.clone().unwrap().key_id)
        .collect();
    assert_eq!(ids[0], ids[1], "one key");
    drop(c);
    let d = fx.service();
    d.host_copy("acme.one").unwrap();
    d.host_copy("acme.two").unwrap();
}
