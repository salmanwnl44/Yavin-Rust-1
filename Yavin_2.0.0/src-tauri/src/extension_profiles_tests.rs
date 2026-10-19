//! EXT-13 profiles: their rules on their own (the service's tests run them through the inventory).

use super::*;
use serde_json::json;

fn set(ids: &[&str]) -> BTreeSet<String> {
    ids.iter().map(|s| s.to_string()).collect()
}

#[test]
fn create_select_rename_and_delete() {
    let mut profiles = Profiles::default();
    let mut live = set(&["acme.off"]);
    let work = create(&mut profiles, &live, "Work stuff").unwrap();
    assert_eq!(work, "work-stuff");
    assert_eq!(
        create(&mut profiles, &live, "Work stuff").unwrap(),
        "work-stuff-2"
    );
    assert_eq!(create(&mut profiles, &live, "!!!").unwrap(), "profile");
    // A new profile starts as the active one is.
    assert_eq!(profiles.list[&work].disabled, live);
    // Selected: the default keeps what was live; live is the work profile's.
    profiles.list.get_mut(&work).unwrap().disabled = set(&["acme.noisy"]);
    select(&mut profiles, &mut live, &work).unwrap();
    assert_eq!(profiles.active, work);
    assert_eq!(live, set(&["acme.noisy"]));
    assert_eq!(profiles.list[DEFAULT].disabled, set(&["acme.off"]));
    // Back: each is as it was.
    select(&mut profiles, &mut live, DEFAULT).unwrap();
    assert_eq!(live, set(&["acme.off"]));
    assert_eq!(profiles.list[&work].disabled, set(&["acme.noisy"]));
    // Selecting the active one changes nothing; a missing one is refused, nothing changed.
    select(&mut profiles, &mut live, DEFAULT).unwrap();
    assert!(select(&mut profiles, &mut live, "nope")
        .unwrap_err()
        .starts_with("ProfileNotFound"));
    assert_eq!(live, set(&["acme.off"]));
    rename(&mut profiles, &work, "Office").unwrap();
    assert_eq!(profiles.list[&work].name, "Office");
    assert_eq!(
        profiles
            .view()
            .profiles
            .iter()
            .find(|p| p.id == work)
            .unwrap()
            .name,
        "Office"
    );
    // Not the default, not the active one.
    assert!(delete(&mut profiles, DEFAULT).is_err());
    select(&mut profiles, &mut live, &work).unwrap();
    assert!(delete(&mut profiles, &work)
        .unwrap_err()
        .starts_with("ProfileActive"));
    select(&mut profiles, &mut live, DEFAULT).unwrap();
    delete(&mut profiles, &work).unwrap();
    assert!(delete(&mut profiles, &work)
        .unwrap_err()
        .starts_with("ProfileNotFound"));
}

#[test]
fn names_ids_and_limits() {
    let mut profiles = Profiles::default();
    let live = BTreeSet::new();
    for bad in ["", "   ", " padded", "two\nlines", &"n".repeat(65)] {
        assert!(create(&mut profiles, &live, bad).is_err(), "{bad:?}");
        assert!(rename(&mut profiles, DEFAULT, bad).is_err(), "{bad:?}");
    }
    for n in 1..MAX_PROFILES {
        create(&mut profiles, &live, &format!("P{n}")).unwrap();
    }
    assert!(create(&mut profiles, &live, "One too many").is_err());
    assert!(
        valid_id("work-2") && !valid_id("-work") && !valid_id("Work") && !valid_id(&"a".repeat(33))
    );
}

#[test]
fn settings_are_an_extensions_own_and_bounded() {
    let mut profiles = Profiles::default();
    set_setting(
        &mut profiles,
        "acme.one",
        "acme.one.color",
        Some(json!("red")),
    )
    .unwrap();
    assert_eq!(
        profiles.view().settings["acme.one"]["acme.one.color"],
        json!("red")
    );
    for (id, key) in [
        ("acme.one", "acme.two.color"),
        ("acme.one", "acme.one."),
        ("acme.one", "acme.onecolor"),
        ("Acme.One", "Acme.One.color"),
    ] {
        assert!(
            set_setting(&mut profiles, id, key, Some(json!(1))).is_err(),
            "{id} {key}"
        );
    }
    let big = json!("x".repeat(MAX_SETTING));
    assert!(set_setting(&mut profiles, "acme.one", "acme.one.big", Some(big)).is_err());
    set_setting(&mut profiles, "acme.one", "acme.one.color", None).unwrap();
    assert!(profiles.view().settings.is_empty());
    // Settings stay with their profile.
    let mut live = BTreeSet::new();
    set_setting(
        &mut profiles,
        "acme.one",
        "acme.one.color",
        Some(json!("red")),
    )
    .unwrap();
    let work = create(&mut profiles, &live, "Work").unwrap();
    select(&mut profiles, &mut live, &work).unwrap();
    set_setting(
        &mut profiles,
        "acme.one",
        "acme.one.color",
        Some(json!("blue")),
    )
    .unwrap();
    select(&mut profiles, &mut live, DEFAULT).unwrap();
    assert_eq!(
        profiles.view().settings["acme.one"]["acme.one.color"],
        json!("red")
    );
    forget_extension(&mut profiles, "acme.one");
    assert!(profiles.list.values().all(|p| p.settings.is_empty()));
}

#[test]
fn invalid_missing_and_corrupted_profiles_are_made_valid_and_said() {
    let mut corrupt: Profiles = serde_json::from_value(json!({
        "active": "gone",
        "list": {
            "work": {"name": "Work", "disabled": ["acme.ok", "Not An Id"], "settings": {"acme.ok": {"acme.ok.x": 1, "acme.other.y": 2}, "BAD": {"BAD.x": 1}}},
            "Bad Id": {"name": "Bad"},
            "noname": {"name": ""}
        }
    }))
    .unwrap();
    let notes = normalize(&mut corrupt);
    assert_eq!(
        corrupt.active, DEFAULT,
        "a missing active profile falls back to the default"
    );
    assert!(corrupt.list.contains_key(DEFAULT));
    assert!(!corrupt.list.contains_key("Bad Id") && !corrupt.list.contains_key("noname"));
    assert_eq!(corrupt.list["work"].disabled, set(&["acme.ok"]));
    assert_eq!(corrupt.list["work"].settings.len(), 1);
    assert_eq!(corrupt.list["work"].settings["acme.ok"].len(), 1);
    assert!(notes.len() >= 3, "{notes:?}");
    // A valid set is left alone.
    let mut fine = Profiles::default();
    assert!(normalize(&mut fine).is_empty());
    assert_eq!(fine, Profiles::default());
    // A record that is not profiles at all does not parse (the inventory then uses its default).
    assert!(serde_json::from_value::<Profiles>(json!({"active": 3})).is_err());
}
