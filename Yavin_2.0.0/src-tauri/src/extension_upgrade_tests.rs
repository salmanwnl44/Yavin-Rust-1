//! EXT-21: upgrade, downgrade and recovery. What an older Yavin does to an inventory it cannot
//! read is reproduced on disk exactly as those builds do it (renamed to `.v<N>-<ms>.bak` or
//! `.corrupt-<ms>.bak`, then -- before EXT-17, or for EXT-20's `indexSigned` under EXT-19 --
//! rebuilt over); this Yavin must neither do that itself nor lose what they set aside.

use super::*;

/// What each test starts from: two versions of `acme.hello` (so a previous copy to fall back
/// on) allowed `documents.read`; `acme.one` with a setting in profile "Work"; `acme.vault`
/// holding a secret; a record of an accepted registry index. Returns the secret store too, so
/// a restart can use the same one.
fn rich(fx: &Fixture) -> std::sync::Arc<crate::extension_secrets::tests::MemoryBackend> {
    let service = fx.service();
    let backend = with_memory_secrets(&service);
    install(fx, &service, "acme.hello", "1.0.0");
    install(fx, &service, "acme.hello", "2.0.0");
    service
        .set_grants("acme.hello", None, &strings(&["documents.read"]))
        .unwrap();
    install_with(fx, &service, "acme.one", "1.0.0", declares_color()).unwrap();
    let work = service.create_profile("Work").unwrap();
    let work = work
        .profiles
        .iter()
        .find(|p| p.name == "Work")
        .unwrap()
        .id
        .clone();
    service.select_profile(&work).unwrap();
    service
        .set_profile_setting("acme.one", "acme.one.color", Some(serde_json::json!("red")))
        .unwrap();
    let vault = secret_keeper(fx, &service, "acme.vault");
    secret(
        &service,
        &vault,
        None,
        "secrets.store",
        serde_json::json!({"key": "token", "value": "s3cret"}),
    )
    .unwrap();
    fs::write(
        fx.root.join(crate::registry_trust::STATE_FILE),
        r#"{"yavin-official": {"sequence": 7, "sha256": "ab"}}"#,
    )
    .unwrap();
    backend
}

fn restart(
    fx: &Fixture,
    backend: &std::sync::Arc<crate::extension_secrets::tests::MemoryBackend>,
) -> ExtensionService {
    let service = fx.service();
    service.use_secret_backend(backend.clone());
    service
}

/// What a user would lose: installed records, enabled state, grants, profiles and settings.
fn held(inventory: &Inventory) -> serde_json::Value {
    serde_json::json!({
        "extensions": inventory.extensions,
        "disabled": inventory.disabled,
        "grants": inventory.grants,
        "profiles": inventory.profiles,
    })
}

fn raw(fx: &Fixture, name: &str) -> serde_json::Value {
    serde_json::from_str(&fs::read_to_string(fx.root.join(name)).unwrap()).unwrap()
}

/// Everything in the extensions folder but diagnostics, byte for byte.
fn everything(fx: &Fixture) -> BTreeMap<String, Vec<u8>> {
    let mut all = tree(&fx.root);
    all.retain(|name, _| !name.starts_with(".diagnostics"));
    all
}

/// The secret `acme.vault` stored, read through the service as the extension would.
fn vault_secret(service: &ExtensionService) -> Result<serde_json::Value, String> {
    let copy = service.host_copy("acme.vault")?;
    secret(
        service,
        &copy,
        None,
        "secrets.get",
        serde_json::json!({"key": "token", "scope": "installation"}),
    )
    .map_err(|d| d.code.to_string())
}

/// An older Yavin's damage, as those builds do it: both files renamed with `label`, then (if
/// `rebuild`) an inventory rebuilt from the store over them -- here by this build with the
/// set-aside files out of its sight, which gives the same: copies disabled, unchecked
/// (`rebuilt`), no grants, no records.
fn older_yavin_set_aside(fx: &Fixture, label: &str, rebuild: bool) -> Vec<String> {
    let at = 1_790_000_000_000u64;
    let names: Vec<String> = [INVENTORY, LAST_GOOD]
        .iter()
        .map(|name| format!("{name}.{label}-{at}.bak"))
        .collect();
    let away = fx.dir.join("away");
    fs::create_dir_all(&away).unwrap();
    for (name, kept) in [INVENTORY, LAST_GOOD].iter().zip(&names) {
        fs::rename(fx.root.join(name), away.join(kept)).unwrap();
    }
    if rebuild {
        drop(fx.service().list(None).unwrap());
        assert!(inventory(fx)
            .extensions
            .values()
            .all(|r| r.active.unchecked == Some(Unchecked::Rebuilt)));
    }
    for kept in &names {
        fs::rename(away.join(kept), fx.root.join(kept)).unwrap();
    }
    names
}

/// Downgrade: an inventory a newer Yavin wrote stays exactly where it is -- not moved, not
/// rewritten, not migrated down, never rebuilt over -- on every start; no code runs and nothing
/// can change; the reason says what to do. The registry's replay record and the trust key are
/// untouched.
#[test]
fn ext21_a_newer_inventory_is_left_in_place_and_nothing_runs() {
    let fx = fixture("ext21-newer");
    let backend = rich(&fx);
    for name in [INVENTORY, LAST_GOOD] {
        let mut value = raw(&fx, name);
        value["version"] = serde_json::json!(INVENTORY_VERSION + 1);
        value["fromTheFuture"] = serde_json::json!({"trust": "semantics this Yavin lacks"});
        fs::write(fx.root.join(name), value.to_string()).unwrap();
    }
    let before = everything(&fx);
    for _ in 0..3 {
        let service = restart(&fx, &backend);
        let refused = service.list(None).unwrap_err();
        assert!(refused.starts_with("InventoryUnsupported"), "{refused}");
        assert!(refused.contains("left exactly as it is"), "{refused}");
        assert!(refused.contains("Nothing needs to be deleted"), "{refused}");
        for refused in [
            service.host_copy("acme.hello").map(|_| ()),
            service.set_enabled("acme.hello", false).map(|_| ()),
            service.set_grants("acme.hello", None, &[]).map(|_| ()),
            service.uninstall("acme.hello").map(|_| ()),
            service.restore_set_aside("inventory.json").map(|_| ()),
        ] {
            assert!(refused.unwrap_err().starts_with("InventoryUnsupported"));
        }
        assert!(vault_secret(&service).is_err(), "no code, no secrets");
        assert_eq!(everything(&fx), before, "nothing in the folder changed");
    }
}

/// Valid JSON of a known version that this Yavin cannot read -- exactly what EXT-19 met in
/// EXT-20's inventories and rebuilt over -- is never rebuilt over. With a last good copy that
/// reads, that copy is used and the unreadable one kept byte for byte.
#[test]
fn ext21_an_inventory_this_yavin_cannot_read_is_never_rebuilt_over() {
    let fx = fixture("ext21-unreadable");
    let backend = rich(&fx);
    let damage = |name: &str| {
        let mut value = raw(&fx, name);
        value["extensions"]["acme.hello"]["active"]["signature"] = serde_json::json!({
            "status": "aStatusFromTheFuture", "registry": "file", "namespace": "acme",
            "sha256": "0", "storeRevision": 1});
        let text = value.to_string();
        fs::write(fx.root.join(name), &text).unwrap();
        text
    };
    let good = inventory(&fx);
    // Both: refused where they are, on every start.
    let text = damage(INVENTORY);
    let last_good = fs::read(fx.root.join(LAST_GOOD)).unwrap();
    damage(LAST_GOOD);
    let before = everything(&fx);
    for _ in 0..2 {
        let refused = restart(&fx, &backend).list(None).unwrap_err();
        assert!(refused.starts_with("InventoryUnsupported"), "{refused}");
        assert_eq!(everything(&fx), before);
    }
    // Only the inventory: its last good copy is used; it is kept.
    fs::write(fx.root.join(LAST_GOOD), last_good).unwrap();
    let service = restart(&fx, &backend);
    service.list(None).unwrap();
    assert_eq!(held(&inventory(&fx)), held(&good));
    let kept: Vec<_> = backups(&fx, &format!("{INVENTORY}.unreadable-"));
    assert_eq!(kept.len(), 1);
    assert_eq!(fs::read_to_string(fx.root.join(&kept[0])).unwrap(), text);
    service.host_copy("acme.hello").unwrap();
    assert_eq!(vault_secret(&service).unwrap(), "s3cret");
}

/// Every schema Yavin has written migrates to the current one keeping what it holds: grants,
/// profiles and settings, package and files digests, trust and signature records, recovery
/// notes, previous copies. The original is kept; a second start migrates nothing; nothing is
/// vouched for that was not -- copies from before trust records need a reinstall.
#[test]
fn ext21_every_schema_migrates_keeping_what_it_holds() {
    // version, what that Yavin did not have, whether its copies' code still runs.
    for (version, runs) in [(1u32, false), (2, false), (3, true), (4, true)] {
        let fx = fixture(&format!("ext21-from-v{version}"));
        let backend = rich(&fx);
        let current = inventory(&fx);
        let mut value = raw(&fx, INVENTORY);
        value["version"] = serde_json::json!(version);
        let strip = |value: &mut serde_json::Value, fields: &[&str]| {
            for record in value["extensions"].as_object_mut().unwrap().values_mut() {
                for copy in ["active", "previous"] {
                    if let Some(copy) = record[copy].as_object_mut() {
                        for field in fields {
                            copy.remove(*field);
                        }
                    }
                }
                if version < 2 {
                    record.as_object_mut().unwrap().remove("replaced");
                }
            }
        };
        if version < 3 {
            strip(&mut value, &["trust"]);
        }
        if version < 2 {
            strip(&mut value, &["filesSha256", "unchecked"]);
        }
        let text = value.to_string();
        fs::write(fx.root.join(INVENTORY), &text).unwrap();
        fs::write(fx.root.join(LAST_GOOD), &text).unwrap();

        let service = restart(&fx, &backend);
        service.list(None).unwrap();
        let migrated = inventory(&fx);
        assert_eq!(migrated.version, INVENTORY_VERSION);
        assert_eq!(migrated.grants, current.grants, "v{version}: grants");
        assert_eq!(migrated.profiles, current.profiles, "v{version}: profiles");
        assert_eq!(
            migrated.disabled, current.disabled,
            "v{version}: enabled state"
        );
        for (id, record) in &current.extensions {
            let now = &migrated.extensions[id];
            for (was, is) in [
                (Some(&record.active), Some(&now.active)),
                (record.previous.as_ref(), now.previous.as_ref()),
            ] {
                let (Some(was), Some(is)) = (was, is) else {
                    assert_eq!(
                        was.is_some(),
                        is.is_some(),
                        "v{version} {id}: previous kept"
                    );
                    continue;
                };
                assert_eq!(is.sha256, was.sha256, "v{version} {id}: package digest");
                assert_eq!(
                    is.signature, was.signature,
                    "v{version} {id}: signature record"
                );
                assert_eq!(is.folder, was.folder);
                if version >= 2 {
                    assert_eq!(
                        is.files_sha256, was.files_sha256,
                        "v{version} {id}: files digest"
                    );
                } else {
                    assert_eq!(is.files_sha256, None, "v{version}: never made up");
                    assert_eq!(is.unchecked, Some(Unchecked::Legacy));
                }
                if version >= 3 {
                    assert_eq!(is.trust, was.trust, "v{version} {id}: trust record");
                } else {
                    assert_eq!(
                        is.trust, None,
                        "v{version}: no record is made by a migration"
                    );
                }
            }
        }
        for recovery in &current.recoveries {
            assert!(
                migrated.recoveries.contains(recovery),
                "v{version}: recovery notes kept"
            );
        }
        let originals = backups(&fx, &format!("{INVENTORY}.v{version}-migrated-"));
        if version < INVENTORY_VERSION {
            assert_eq!(originals.len(), 1, "v{version}: the original kept");
            assert_eq!(
                fs::read_to_string(fx.root.join(&originals[0])).unwrap(),
                text
            );
        } else {
            assert!(originals.is_empty());
        }
        assert_eq!(
            service.host_copy("acme.hello").is_ok(),
            runs,
            "v{version}: runs"
        );
        if runs {
            assert_eq!(
                vault_secret(&service).unwrap(),
                "s3cret",
                "v{version}: its secret"
            );
        }
        drop(service);
        // A second start: nothing to migrate.
        let before = everything(&fx);
        restart(&fx, &backend).list(None).unwrap();
        assert_eq!(everything(&fx), before, "v{version}: idempotent");
        // Code of copies from before trust records runs again once reinstalled.
        if !runs {
            let service = restart(&fx, &backend);
            install(&fx, &service, "acme.hello", "2.0.0");
            service.host_copy("acme.hello").unwrap();
            assert_eq!(
                inventory(&fx).grants,
                current.grants,
                "v{version}: a reinstall keeps grants it matches"
            );
        }
    }
}

/// EXT-20 wrote `indexSigned` under version 3: this Yavin reads such an inventory (it is the
/// version it migrates), keeping the record -- it is not damage.
#[test]
fn ext21_an_ext20_inventory_is_read_with_its_index_signed_records() {
    let fx = fixture("ext21-ext20");
    let backend = rich(&fx);
    let mut value = raw(&fx, INVENTORY);
    value["version"] = serde_json::json!(3);
    value["extensions"]["acme.other"] = value["extensions"]["acme.one"].clone();
    value["extensions"]["acme.other"]["active"]["signature"] = serde_json::json!({
        "status": "indexSigned", "registry": "https://example.test/registry/", "keyId": "k",
        "namespace": "acme", "sha256": "0".repeat(64), "storeRevision": 1});
    let text = value.to_string();
    fs::write(fx.root.join(INVENTORY), &text).unwrap();
    fs::write(fx.root.join(LAST_GOOD), &text).unwrap();
    restart(&fx, &backend).list(None).unwrap();
    let migrated = inventory(&fx);
    assert_eq!(migrated.version, INVENTORY_VERSION);
    assert_eq!(
        migrated.extensions["acme.other"]
            .active
            .signature
            .as_ref()
            .unwrap()
            .status,
        crate::package_trust::SignatureStatus::IndexSigned
    );
    assert!(backups(&fx, ".unrecovered").is_empty(), "nothing rebuilt");
}

/// A migration interrupted at any point -- its original kept, or its last good copy already
/// written in the new version -- is simply done again at the next start, with the same result,
/// and never leaves a copy vouched for that was not.
#[test]
fn ext21_an_interrupted_migration_is_done_again_at_the_next_start() {
    for interrupted in ["after keeping the original", "after the last good copy"] {
        let fx = fixture(&format!("ext21-interrupted-{}", interrupted.len()));
        let backend = rich(&fx);
        let current = inventory(&fx);
        let mut value = raw(&fx, INVENTORY);
        value["version"] = serde_json::json!(3);
        let text = value.to_string();
        fs::write(fx.root.join(INVENTORY), &text).unwrap();
        fs::write(fx.root.join(LAST_GOOD), &text).unwrap();
        // Where the interrupted start got to.
        fs::write(
            fx.root.join(format!("{INVENTORY}.v3-migrated-1.bak")),
            &text,
        )
        .unwrap();
        if interrupted == "after the last good copy" {
            let mut newer = value.clone();
            newer["version"] = serde_json::json!(INVENTORY_VERSION);
            fs::write(fx.root.join(LAST_GOOD), newer.to_string()).unwrap();
        }
        let service = restart(&fx, &backend);
        service.list(None).unwrap();
        let migrated = inventory(&fx);
        assert_eq!(migrated.version, INVENTORY_VERSION, "{interrupted}");
        assert_eq!(held(&migrated), held(&current), "{interrupted}");
        assert_eq!(
            raw(&fx, LAST_GOOD),
            raw(&fx, INVENTORY),
            "{interrupted}: both written"
        );
        service.host_copy("acme.hello").unwrap();
        assert_eq!(vault_secret(&service).unwrap(), "s3cret");
    }
}

/// Damage: a current inventory that is not JSON comes back from its last good copy, whole. Both
/// damaged: restored from an inventory an older Yavin set aside if there is one, else rebuilt --
/// and a rebuild makes nothing up: no grant, no files digest, no trust or signature record, no
/// copy's code running until it is reinstalled.
#[test]
fn ext21_damaged_inventories_and_their_backups() {
    // A good last good copy.
    let fx = fixture("ext21-damaged-one");
    let backend = rich(&fx);
    let good = inventory(&fx);
    fs::write(fx.root.join(INVENTORY), "{ not json").unwrap();
    let service = restart(&fx, &backend);
    service.list(None).unwrap();
    assert_eq!(held(&inventory(&fx)), held(&good));
    service.host_copy("acme.hello").unwrap();
    drop(service);

    // Both damaged, with an older Yavin's set-aside inventory: that is used.
    let fx = fixture("ext21-damaged-both-set-aside");
    let backend = rich(&fx);
    let good = inventory(&fx);
    let names = older_yavin_set_aside(&fx, "v4", false);
    fs::write(fx.root.join(INVENTORY), "{ not json").unwrap();
    fs::write(fx.root.join(LAST_GOOD), "{ not json").unwrap();
    let service = restart(&fx, &backend);
    service.list(None).unwrap();
    assert_eq!(held(&inventory(&fx)), held(&good));
    assert!(recovered(&fx, "which an older Yavin had set aside"));
    assert!(fx
        .root
        .join(names[0].replace(".bak", ".restored.bak"))
        .exists());
    service.host_copy("acme.hello").unwrap();
    drop(service);

    // Both damaged, nothing set aside: rebuilt, nothing made up.
    let fx = fixture("ext21-damaged-both");
    let backend = rich(&fx);
    fs::write(fx.root.join(INVENTORY), "{ not json").unwrap();
    fs::write(fx.root.join(LAST_GOOD), "{ not json").unwrap();
    let service = restart(&fx, &backend);
    service.list(None).unwrap();
    let rebuilt = inventory(&fx);
    assert!(rebuilt.grants.is_empty());
    for record in rebuilt.extensions.values() {
        for copy in std::iter::once(&record.active).chain(record.previous.as_ref()) {
            assert_eq!(copy.files_sha256, None);
            assert_eq!(copy.trust, None);
            assert_eq!(copy.signature, None);
            assert_eq!(copy.unchecked, Some(Unchecked::Rebuilt));
        }
    }
    // Disabled -- and, enabled, still no code: nothing vouches for it.
    service.set_enabled("acme.hello", true).unwrap();
    {
        let e = service.host_copy("acme.hello").unwrap_err();
        assert!(e.starts_with("IntegrityUnverified"), "{e}");
    }
}

/// The recovery path from an older Yavin's damage (EXT-13/14 rebuilt over a newer inventory on
/// its third start; EXT-19 over EXT-20's on its first): what it set aside is offered -- not
/// applied -- and restoring it brings back grants, profiles, settings and records, verified as
/// always; the inventory it replaces is kept; secrets were never touched. Keeping the current
/// one instead is offered too. Nothing but such a file can be restored.
#[test]
fn ext21_what_an_older_yavin_set_aside_is_offered_and_restored() {
    for label in ["corrupt", "v3"] {
        let fx = fixture(&format!("ext21-offered-{label}"));
        let backend = rich(&fx);
        let good = inventory(&fx);
        let names = older_yavin_set_aside(&fx, label, true);
        let rebuilt = fs::read_to_string(fx.root.join(INVENTORY)).unwrap();

        let service = restart(&fx, &backend);
        let listing = service.list(None).unwrap();
        let offered = listing.set_aside.expect("offered");
        assert_eq!(
            offered.file, names[0],
            "{label}: the inventory before its last good copy"
        );
        assert_eq!(
            (offered.extensions, offered.grants, offered.profiles),
            (3, 2, 2)
        );
        assert_eq!(
            fs::read_to_string(fx.root.join(INVENTORY)).unwrap(),
            rebuilt,
            "only offered"
        );
        for wrong in [
            "inventory.json",
            "../inventory.json.v3-1.bak",
            "inventory.json.v1-migrated-1.bak",
            "registry-state.json",
            "inventory.json.v3-1790000000000.restored.bak",
        ] {
            let refused = service.restore_set_aside(wrong).unwrap_err();
            assert!(
                refused.starts_with("SetAsideUnavailable"),
                "{wrong}: {refused}"
            );
        }

        let listing = service.restore_set_aside(&offered.file).unwrap();
        assert!(listing.set_aside.is_none(), "{label}: not offered again");
        assert_eq!(
            held(&inventory(&fx)),
            held(&good),
            "{label}: restored whole"
        );
        let replaced = backups(&fx, &format!("{INVENTORY}.replaced-"));
        assert_eq!(
            fs::read_to_string(fx.root.join(&replaced[0])).unwrap(),
            rebuilt
        );
        assert!(fx
            .root
            .join(names[0].replace(".bak", ".restored.bak"))
            .exists());
        assert!(fx.root.join(&names[1]).exists(), "its last good copy kept");
        service.host_copy("acme.hello").unwrap();
        assert_eq!(
            vault_secret(&service).unwrap(),
            "s3cret",
            "{label}: its secret"
        );
        drop(service);
        let service = restart(&fx, &backend);
        assert!(
            service.list(None).unwrap().set_aside.is_none(),
            "{label}: after a restart"
        );
        service.host_copy("acme.hello").unwrap();
    }

    // Keeping the current one: the set-aside file is renamed, never deleted, and not offered.
    let fx = fixture("ext21-dismissed");
    let backend = rich(&fx);
    let names = older_yavin_set_aside(&fx, "corrupt", true);
    let service = restart(&fx, &backend);
    let rebuilt = inventory(&fx);
    let listing = service.dismiss_set_aside(&names[0]).unwrap();
    // The last good copy (same content) is offered next, until it is dismissed too.
    assert_eq!(listing.set_aside.unwrap().file, names[1]);
    assert!(service
        .dismiss_set_aside(&names[1])
        .unwrap()
        .set_aside
        .is_none());
    assert_eq!(held(&inventory(&fx)), held(&rebuilt));
    for name in &names {
        assert!(fx
            .root
            .join(name.replace(".bak", ".dismissed.bak"))
            .exists());
    }
}

/// Restoring makes nothing up: a copy whose trust key is gone, or whose files changed, is
/// refused as it would be anyway -- a restore recovers the user's data, it never authorizes
/// code -- and a fallback runs only on its own files digest and trust record.
#[test]
fn ext21_a_restore_authorizes_nothing() {
    let fx = fixture("ext21-authorizes-nothing");
    let backend = rich(&fx);
    let names = older_yavin_set_aside(&fx, "v3", true);
    fs::remove_file(fx.root.join(crate::extension_trust::KEY_FILE)).unwrap();
    let service = restart(&fx, &backend);
    service.restore_set_aside(&names[0]).unwrap();
    let refused = refusal(&service, "acme.hello");
    assert!(
        refused.starts_with("TrustStateInvalid") && refused.contains("(key)"),
        "{refused}"
    );
    assert!(vault_secret(&service).is_err());
    // Reinstalled: vouched for again, by a verification.
    install(&fx, &service, "acme.hello", "2.0.0");
    service.host_copy("acme.hello").unwrap();
    drop(service);

    // A fallback: the active copy's files changed; the previous one runs on its own record.
    let fx = fixture("ext21-restore-fallback");
    let backend = rich(&fx);
    let names = older_yavin_set_aside(&fx, "v3", true);
    let service = restart(&fx, &backend);
    service.restore_set_aside(&names[0]).unwrap();
    let active = inventory(&fx).extensions["acme.hello"]
        .active
        .folder
        .clone();
    fs::write(
        fx.root.join(&active).join("extension.js"),
        "module.exports = 'changed';",
    )
    .unwrap();
    let copy = service.host_copy("acme.hello").unwrap();
    assert!(copy.folder.contains("1.0.0"), "{}", copy.folder);
    drop(service);
    let mut value = raw(&fx, INVENTORY);
    // The copy that runs now -- 1.0.0, wherever the record holds it -- with a forged record.
    for slot in ["active", "previous"] {
        let copy = &mut value["extensions"]["acme.hello"][slot];
        if copy["version"] == "1.0.0" {
            copy["trust"]["mac"] = serde_json::json!("00");
        }
    }
    fs::write(fx.root.join(INVENTORY), value.to_string()).unwrap();
    let r = refusal(&restart(&fx, &backend), "acme.hello");
    assert!(r != "it runs", "{r}");
}

/// Continuing with this Yavin instead -- only at the user's request, only when it cannot use
/// the inventory: both files are set aside byte for byte, where a Yavin that reads them finds
/// them, and an inventory is rebuilt that runs no code until copies are reinstalled.
#[test]
fn ext21_starting_over_is_explicit_and_keeps_everything() {
    let fx = fixture("ext21-start-over");
    let backend = rich(&fx);
    let service = restart(&fx, &backend);
    assert!(service
        .start_over()
        .unwrap_err()
        .starts_with("InventoryInUse"));
    drop(service);
    let mut value = raw(&fx, INVENTORY);
    value["version"] = serde_json::json!(INVENTORY_VERSION + 1);
    let text = value.to_string();
    fs::write(fx.root.join(INVENTORY), &text).unwrap();
    fs::write(fx.root.join(LAST_GOOD), &text).unwrap();
    let service = restart(&fx, &backend);
    assert!(service.list(None).is_err());
    let listing = service.start_over().unwrap();
    assert!(
        listing.set_aside.is_none(),
        "a newer inventory is not one this Yavin can restore"
    );
    let kept = backups(&fx, &format!(".v{}-", INVENTORY_VERSION + 1));
    assert!(kept.is_empty(), "named after the file: {kept:?}");
    let kept: Vec<_> = backups(&fx, "inventory.")
        .into_iter()
        .filter(|n| n.contains(&format!(".v{}-", INVENTORY_VERSION + 1)))
        .collect();
    assert_eq!(kept.len(), 2);
    for name in &kept {
        assert_eq!(fs::read_to_string(fx.root.join(name)).unwrap(), text);
    }
    let rebuilt = inventory(&fx);
    assert!(rebuilt.grants.is_empty());
    // Disabled -- and, enabled, still no code: nothing vouches for it.
    service.set_enabled("acme.hello", true).unwrap();
    {
        let e = service.host_copy("acme.hello").unwrap_err();
        assert!(e.starts_with("IntegrityUnverified"), "{e}");
    }
    drop(service);
    // The next start uses the new inventory: the kept ones do not stop it.
    restart(&fx, &backend).list(None).unwrap();
}

/// The registry's replay record (EXT-20) survives every one of these paths -- a newer
/// inventory refused, a migration, damage and a rebuild, a restore, starting over -- byte for
/// byte: no recovery of the inventory erases or weakens it.
#[test]
fn ext21_the_registry_replay_record_survives_recovery() {
    let fx = fixture("ext21-registry-state");
    let backend = rich(&fx);
    let state = fx.root.join(crate::registry_trust::STATE_FILE);
    let recorded = fs::read(&state).unwrap();
    let unchanged = |what: &str| assert_eq!(fs::read(&state).unwrap(), recorded, "{what}");
    let names = older_yavin_set_aside(&fx, "v3", true);
    unchanged("an older Yavin's rebuild");
    let service = restart(&fx, &backend);
    service.restore_set_aside(&names[0]).unwrap();
    unchanged("a restore");
    drop(service);
    fs::write(fx.root.join(INVENTORY), "{ not json").unwrap();
    fs::write(fx.root.join(LAST_GOOD), "{ not json").unwrap();
    restart(&fx, &backend).list(None).unwrap();
    unchanged("a rebuild");
    let mut value = raw(&fx, INVENTORY);
    value["version"] = serde_json::json!(INVENTORY_VERSION + 1);
    fs::write(fx.root.join(INVENTORY), value.to_string()).unwrap();
    let service = restart(&fx, &backend);
    assert!(service.list(None).is_err());
    unchanged("a newer inventory refused");
    service.start_over().unwrap();
    unchanged("starting over");
    assert_eq!(
        crate::registry_trust::read_seen(&fx.root).unwrap()["yavin-official"].sequence,
        7
    );
}

/// EXT-22: the listing says where the copy in use came from and its package's digest -- the
/// inventory's record, never what the window browses -- including after a fallback, when it is
/// the previous copy's. Nothing is said for what has no package on record.
#[test]
fn ext22_the_listing_says_where_the_copy_in_use_came_from() {
    let fx = fixture("ext22-provenance");
    let service = fx.service();
    install(&fx, &service, "acme.hello", "1.0.0");
    install(&fx, &service, "acme.hello", "2.0.0");
    let record = inventory(&fx).extensions["acme.hello"].clone();
    let provenance = entry(&service, "acme.hello").provenance.unwrap();
    assert_eq!(provenance.kind, "file");
    assert_eq!(provenance.location, None);
    assert_eq!(provenance.sha256, record.active.sha256);
    // The active copy's files changed: the previous copy is used, and it is that one's.
    fs::write(
        fx.root.join(&record.active.folder).join("extension.js"),
        "module.exports = 'changed';",
    )
    .unwrap();
    let after = entry(&service, "acme.hello").provenance.unwrap();
    assert_eq!(after.sha256, record.previous.as_ref().unwrap().sha256);
    assert_ne!(after.sha256, record.active.sha256);
    drop(service);
    // Rebuilt from the folders alone: nothing known, nothing made up.
    fs::write(fx.root.join(INVENTORY), "{ not json").unwrap();
    fs::write(fx.root.join(LAST_GOOD), "{ not json").unwrap();
    let service = fx.service();
    let rebuilt = entry(&service, "acme.hello").provenance.unwrap();
    assert_eq!(
        (rebuilt.kind, rebuilt.location, rebuilt.sha256),
        ("unknown", None, None)
    );
}
