//! Extension profiles (EXT-13): named sets of which extensions are enabled and which values
//! their settings take -- one active at a time, for the whole application (Yavin's workspace,
//! trust and inventory are the application's; a profile per window would be a claim nothing
//! else supports).
//!
//! They live in the inventory (`Inventory::profiles`), so a change is one durable write with
//! everything else (EXT-02): there is no second record to disagree with. The active profile's
//! enabled set *is* the inventory's `disabled` -- what every load and every request checks
//! (EXT-07, EXT-12); the others are kept here until selected. A profile never grants anything:
//! grants stay per copy, given by the user (EXT-07), and enabling an extension by switching to
//! a profile does not skip its signature (EXT-09), API or dependency checks (EXT-12) -- those are
//! made when it loads.

use ide_workspace::extension_id::canonical_id;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

pub const DEFAULT: &str = "default";
pub const MAX_PROFILES: usize = 20;
/// The largest one setting value a profile keeps, as JSON.
pub const MAX_SETTING: usize = 4096;
/// The most setting values one profile keeps.
pub const MAX_SETTINGS: usize = 500;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub name: String,
    /// Disabled while this profile is not the active one (the active one's are the
    /// inventory's).
    #[serde(default)]
    pub disabled: BTreeSet<String>,
    /// Per extension, its settings' values in this profile (`<extension>.<key>` → value).
    #[serde(default)]
    pub settings: BTreeMap<String, BTreeMap<String, Value>>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Profiles {
    pub active: String,
    pub list: BTreeMap<String, Profile>,
}

impl Default for Profiles {
    fn default() -> Self {
        let mut list = BTreeMap::new();
        list.insert(DEFAULT.to_string(), default_profile());
        Profiles {
            active: DEFAULT.into(),
            list,
        }
    }
}

fn default_profile() -> Profile {
    Profile {
        name: "Default".into(),
        disabled: BTreeSet::new(),
        settings: BTreeMap::new(),
    }
}

/// What the window is told: the profiles, and the active one's settings.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProfilesView {
    pub active: String,
    pub profiles: Vec<ProfileEntry>,
    pub settings: BTreeMap<String, BTreeMap<String, Value>>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ProfileEntry {
    pub id: String,
    pub name: String,
}

impl Profiles {
    pub fn view(&self) -> ProfilesView {
        ProfilesView {
            active: self.active.clone(),
            profiles: self
                .list
                .iter()
                .map(|(id, p)| ProfileEntry {
                    id: id.clone(),
                    name: p.name.clone(),
                })
                .collect(),
            settings: self
                .list
                .get(&self.active)
                .map(|p| p.settings.clone())
                .unwrap_or_default(),
        }
    }
}

pub fn valid_id(id: &str) -> bool {
    (1..=32).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !id.starts_with('-')
}

pub fn valid_name(name: &str) -> bool {
    let trimmed = name.trim();
    !trimmed.is_empty()
        && trimmed.chars().count() <= 64
        && trimmed == name
        && !name.chars().any(char::is_control)
}

/// A setting a profile may hold for extension `id`: one of its own (`<id>.<key>`), a value
/// small enough.
fn valid_setting(id: &str, key: &str, value: &Value) -> bool {
    canonical_id(id).as_deref() == Some(id)
        && key
            .strip_prefix(id)
            .and_then(|rest| rest.strip_prefix('.'))
            .is_some_and(|rest| {
                !rest.is_empty() && rest.len() <= 200 && !rest.chars().any(char::is_control)
            })
        && serde_json::to_string(value).is_ok_and(|text| text.len() <= MAX_SETTING)
}

/// Makes `profiles` valid, saying what was not: the default profile exists, every id and name
/// is one, every disabled id and setting is an extension's, at most `MAX_PROFILES`, and the
/// active one exists (else the default is active).
pub fn normalize(profiles: &mut Profiles) -> Vec<String> {
    let mut notes = Vec::new();
    let before = profiles.list.len();
    profiles
        .list
        .retain(|id, profile| valid_id(id) && valid_name(&profile.name));
    if profiles.list.len() != before {
        notes.push("Extension profiles that are not valid were dropped.".to_string());
    }
    if !profiles.list.contains_key(DEFAULT) {
        profiles.list.insert(DEFAULT.into(), default_profile());
    }
    while profiles.list.len() > MAX_PROFILES {
        let last = profiles
            .list
            .keys()
            .rev()
            .find(|id| *id != DEFAULT && **id != profiles.active)
            .cloned();
        let Some(last) = last else { break };
        profiles.list.remove(&last);
        notes.push(format!(
            "The extension profile \"{last}\" was dropped: at most {MAX_PROFILES} are kept."
        ));
    }
    let mut dropped = false;
    for profile in profiles.list.values_mut() {
        let n = profile.disabled.len();
        profile
            .disabled
            .retain(|id| canonical_id(id).as_deref() == Some(id.as_str()));
        dropped |= n != profile.disabled.len();
        profile.settings.retain(|id, values| {
            let n = values.len();
            values.retain(|key, value| valid_setting(id, key, value));
            dropped |= n != values.len();
            !values.is_empty()
        });
        let total: usize = profile.settings.values().map(BTreeMap::len).sum();
        if total > MAX_SETTINGS {
            profile.settings.clear();
            dropped = true;
        }
    }
    if dropped {
        notes.push("Entries of extension profiles that are not valid were dropped.".to_string());
    }
    if !profiles.list.contains_key(&profiles.active) {
        notes.push(format!(
            "The selected extension profile \"{}\" does not exist; the default profile is used.",
            profiles.active
        ));
        profiles.active = DEFAULT.into();
    }
    notes
}

fn not_found(id: &str) -> String {
    format!("ProfileNotFound: there is no extension profile \"{id}\".")
}

/// A new profile named `name`, starting as the active one is (`live`: its enabled set now);
/// its id.
pub fn create(
    profiles: &mut Profiles,
    live: &BTreeSet<String>,
    name: &str,
) -> Result<String, String> {
    if !valid_name(name) {
        return Err("InvalidRequest: a profile's name is 1 to 64 characters on one line.".into());
    }
    if profiles.list.len() >= MAX_PROFILES {
        return Err(format!(
            "InvalidRequest: at most {MAX_PROFILES} extension profiles."
        ));
    }
    let mut base: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    while base.contains("--") {
        base = base.replace("--", "-");
    }
    let mut base = base.trim_matches('-').chars().take(28).collect::<String>();
    if base.is_empty() {
        base = "profile".into();
    }
    let id = std::iter::once(base.clone())
        .chain((2..).map(|n| format!("{base}-{n}")))
        .find(|id| !profiles.list.contains_key(id))
        .expect("an unused id");
    let settings = profiles
        .list
        .get(&profiles.active)
        .map(|p| p.settings.clone())
        .unwrap_or_default();
    profiles.list.insert(
        id.clone(),
        Profile {
            name: name.to_string(),
            disabled: live.clone(),
            settings,
        },
    );
    Ok(id)
}

pub fn rename(profiles: &mut Profiles, id: &str, name: &str) -> Result<(), String> {
    if !valid_name(name) {
        return Err("InvalidRequest: a profile's name is 1 to 64 characters on one line.".into());
    }
    let profile = profiles.list.get_mut(id).ok_or_else(|| not_found(id))?;
    profile.name = name.to_string();
    Ok(())
}

/// Removes profile `id`: not the default, not the active one.
pub fn delete(profiles: &mut Profiles, id: &str) -> Result<(), String> {
    if id == DEFAULT {
        return Err("InvalidRequest: the default profile cannot be deleted.".into());
    }
    if id == profiles.active {
        return Err("ProfileActive: switch to another profile before deleting this one.".into());
    }
    profiles.list.remove(id).ok_or_else(|| not_found(id))?;
    Ok(())
}

/// Makes `id` the active profile: the active one keeps `live` (the enabled set now), and
/// `live` becomes `id`'s. Nothing changes if `id` does not exist.
pub fn select(
    profiles: &mut Profiles,
    live: &mut BTreeSet<String>,
    id: &str,
) -> Result<(), String> {
    if !profiles.list.contains_key(id) {
        return Err(not_found(id));
    }
    if id == profiles.active {
        return Ok(());
    }
    let old = profiles.active.clone();
    let incoming = std::mem::take(&mut profiles.list.get_mut(id).expect("checked").disabled);
    if let Some(left) = profiles.list.get_mut(&old) {
        left.disabled = std::mem::replace(live, incoming);
    } else {
        *live = incoming;
    }
    profiles.active = id.to_string();
    Ok(())
}

/// Sets (or, with `None`, removes) setting `key` of extension `id` in the active profile.
pub fn set_setting(
    profiles: &mut Profiles,
    id: &str,
    key: &str,
    value: Option<Value>,
) -> Result<(), String> {
    let active = profiles.active.clone();
    let profile = profiles
        .list
        .get_mut(&active)
        .ok_or_else(|| not_found(&active))?;
    match value {
        Some(value) => {
            if !valid_setting(id, key, &value) {
                return Err(format!(
                    "InvalidRequest: a profile keeps only {id}'s own settings ({id}.<key>), each at most {MAX_SETTING} bytes."
                ));
            }
            let total: usize = profile.settings.values().map(BTreeMap::len).sum();
            let entry = profile.settings.entry(id.to_string()).or_default();
            if !entry.contains_key(key) && total >= MAX_SETTINGS {
                return Err(format!(
                    "InvalidRequest: a profile keeps at most {MAX_SETTINGS} setting values."
                ));
            }
            entry.insert(key.to_string(), value);
        }
        None => {
            if let Some(entry) = profile.settings.get_mut(id) {
                entry.remove(key);
                if entry.is_empty() {
                    profile.settings.remove(id);
                }
            }
        }
    }
    Ok(())
}

// --- EXT-18: settings as their extension declares them -----------------------------------------

/// What an extension declares one of its settings to be (its manifest's
/// `contributes.configuration.properties`), as the window reads it (`manifest.ts`,
/// `registry.ts`): a value is valid natively exactly when it is valid there.
#[derive(Debug, Clone, PartialEq)]
pub enum SettingKind {
    Boolean,
    /// Finite, within its bounds (absent: the safe-integer range).
    Number {
        min: f64,
        max: f64,
    },
    /// One line, not blank, at most `MAX_STRING` UTF-16 units.
    String,
    /// One of these.
    Enum(Vec<String>),
}

/// The longest string setting value, in UTF-16 units (as the window counts).
pub const MAX_STRING: usize = 1000;
const SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// The settings extension `id`'s manifest declares, by key (`<id>.<name>`). A declaration
/// the window would refuse is not one: none of its values is accepted.
pub fn declared_settings(manifest: &Value, id: &str) -> BTreeMap<String, SettingKind> {
    let mut found = BTreeMap::new();
    let Some(properties) = manifest
        .pointer("/contributes/configuration/properties")
        .and_then(Value::as_object)
    else {
        return found;
    };
    for (key, entry) in properties {
        let owned = key
            .strip_prefix(id)
            .and_then(|rest| rest.strip_prefix('.'))
            .is_some_and(|rest| !rest.is_empty());
        let Some(entry) = entry.as_object().filter(|_| owned) else {
            continue;
        };
        let default = entry.get("default");
        let kind = if let Some(values) = entry.get("enum") {
            let Some(values) = values.as_array().filter(|v| !v.is_empty()) else {
                continue;
            };
            let values: Option<Vec<String>> = values
                .iter()
                .map(|v| v.as_str().map(str::to_string))
                .collect();
            match values {
                Some(values)
                    if default
                        .and_then(Value::as_str)
                        .is_some_and(|d| values.iter().any(|v| v == d)) =>
                {
                    SettingKind::Enum(values)
                }
                _ => continue,
            }
        } else {
            match entry.get("type").and_then(Value::as_str) {
                Some("boolean") if default.is_some_and(Value::is_boolean) => SettingKind::Boolean,
                Some("string") if default.is_some_and(Value::is_string) => SettingKind::String,
                Some("number") if default.is_some_and(Value::is_number) => {
                    let bound = |name: &str, fallback: f64| {
                        entry.get(name).and_then(Value::as_f64).unwrap_or(fallback)
                    };
                    let (min, max) = (
                        bound("minimum", -SAFE_INTEGER),
                        bound("maximum", SAFE_INTEGER),
                    );
                    if min > max {
                        continue;
                    }
                    SettingKind::Number { min, max }
                }
                _ => continue,
            }
        };
        found.insert(key.clone(), kind);
    }
    found
}

/// Whether `value` is a valid value of a setting declared `kind` -- or what is wrong with it.
pub fn check_value(kind: &SettingKind, value: &Value) -> Result<(), String> {
    match kind {
        SettingKind::Boolean if value.is_boolean() => Ok(()),
        SettingKind::Boolean => Err("must be true or false".into()),
        SettingKind::Number { min, max } => match value.as_f64() {
            Some(n) if n.is_finite() && n >= *min && n <= *max => Ok(()),
            _ => Err(format!("must be a number from {min} to {max}")),
        },
        SettingKind::String => match value.as_str() {
            Some(text)
                if !text.trim().is_empty()
                    && text.encode_utf16().count() <= MAX_STRING
                    && !text.chars().any(|c| (c as u32) < 0x20 || c as u32 == 0x7f) =>
            {
                Ok(())
            }
            _ => Err(format!(
                "must be one line of text, not blank, of at most {MAX_STRING} characters"
            )),
        },
        SettingKind::Enum(values) => match value.as_str() {
            Some(text) if values.iter().any(|v| v == text) => Ok(()),
            _ => Err(format!("must be one of: {}", values.join(", "))),
        },
    }
}

/// One change of a profile's setting value (EXT-18): `value` none removes the override; the
/// value it replaces must still be `expected` (none: not set) -- else it changed meanwhile.
#[derive(Deserialize, Clone, Debug, PartialEq)]
pub struct SettingChange {
    pub key: String,
    pub value: Option<Value>,
    pub expected: Option<Value>,
}

/// Applies `changes` to extension `id`'s settings in profile `profile` -- all of them or
/// none (EXT-18). Refused: `profile` is no longer the active one (`ProfileChanged`: it was
/// switched meanwhile, by this window or another); a key the extension does not declare
/// (`UnknownSetting`); a value invalid for its declaration (`InvalidSetting`); a value that
/// is no longer the one the change was made against (`SettingChanged`).
pub fn apply_settings(
    profiles: &mut Profiles,
    profile: &str,
    id: &str,
    declared: &BTreeMap<String, SettingKind>,
    changes: &[SettingChange],
) -> Result<(), String> {
    if profiles.active != profile {
        let name = profiles
            .list
            .get(&profiles.active)
            .map(|p| p.name.clone())
            .unwrap_or_else(|| profiles.active.clone());
        return Err(format!(
            "ProfileChanged: the active extension profile is now \"{name}\", not the one these settings were edited in; nothing was saved. Review them again."
        ));
    }
    let mut next = profiles.clone();
    for change in changes {
        let kind = declared.get(&change.key).ok_or_else(|| {
            format!(
                "UnknownSetting: {id} declares no setting \"{}\".",
                change.key
            )
        })?;
        if let Some(value) = &change.value {
            check_value(kind, value)
                .map_err(|why| format!("InvalidSetting: {} {why}.", change.key))?;
        }
        let current = next
            .list
            .get(profile)
            .and_then(|p| p.settings.get(id))
            .and_then(|values| values.get(&change.key));
        if current != change.expected.as_ref() {
            return Err(format!(
                "SettingChanged: {} was changed elsewhere since it was read; nothing was saved. Review it again.",
                change.key
            ));
        }
        set_setting(&mut next, id, &change.key, change.value.clone())?;
    }
    *profiles = next;
    Ok(())
}

/// Forgets extension `id` in every profile (it was uninstalled).
pub fn forget_extension(profiles: &mut Profiles, id: &str) {
    for profile in profiles.list.values_mut() {
        profile.disabled.remove(id);
        profile.settings.remove(id);
    }
}

#[cfg(test)]
#[path = "extension_profiles_tests.rs"]
mod tests;
