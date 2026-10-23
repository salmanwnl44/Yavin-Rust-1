//! Extension permissions (EXT-07): the capabilities an extension may ask for, what each request
//! an extension makes needs, and what a manifest declares. The renderer has the same rules
//! (`src/services/extensions/permissions.ts`); both are tested against `permissions.cases.json`.
//!
//! **Mandatory** -- every extension, scoped by ownership, no consent: registering its own
//! commands, views and language providers (their ids carry its id), decorating through Yavin's
//! fixed styles, its own storage (`extension.storage`), its own contributed settings
//! (`settings.read` of its own section), messages, its configuration events, and whether the
//! window is focused (`window.state`, EXT-27), its own prompts (Yavin's picker and input box,
//! which the user answers) and its own diagnostic collections in the Problems view (EXT-29).
//!
//! **Optional** -- declared in the manifest (`permissions.request`), then granted by the user,
//! per installed copy (`ExtensionService::set_grants`); none by default:
//!
//! | Capability | Requests |
//! |---|---|
//! | `workspace.fs.read` | `fs.readFile`, `fs.exists` (inside the workspace folder); receiving `files.change` (EXT-29) |
//! | `documents.read` | `documents.all/get/getText`, `editor.active`; receiving the `documents.*` (saves and will-save too, EXT-29), `editor.active` and `editor.selection` events |
//! | `editor.control` | `editor.openLocation`, `editor.setSelection`, `editor.revealRange` |
//! | `documents.edit` | `documents.edit`: text edits to an open document, as unsaved and undoable edits (EXT-25) |
//! | `commands.execute:<id>` | `commands.execute` of a command `<id>` contributes (another extension's) |
//! | `secrets` | `secrets.get`, `secrets.store`, `secrets.delete` -- its own, kept by Yavin in the OS credential store (EXT-13) |
//!
//! Nothing else exists: no network, process, file-write or settings-of-others capability, and
//! a request for a method not listed here needs a capability no extension can have (`Unknown`).
//! A manifest without `permissions` was made before them (legacy): with code, it is taken to
//! request `LEGACY` -- what the API let every extension do, except running other extensions'
//! commands -- and is granted nothing until the user allows it; without code, nothing.

use ide_workspace::extension_id::{canonical_id, is_canonical};
use serde_json::Value;
use std::collections::BTreeSet;

/// The permission model this Yavin reads.
pub const PERMISSIONS_VERSION: u64 = 1;
/// The most capabilities one manifest may request.
pub const MAX_REQUESTED: usize = 16;

pub const FS_READ: &str = "workspace.fs.read";
pub const DOCUMENTS_READ: &str = "documents.read";
pub const EDITOR_CONTROL: &str = "editor.control";
/// Editing open documents' text (EXT-25): unsaved, undoable edits through the document service.
pub const DOCUMENTS_EDIT: &str = "documents.edit";
/// `commands.execute:<extension id>`: the other extension's commands.
pub const COMMANDS_EXECUTE: &str = "commands.execute:";
/// Keeping its own secrets in the OS credential store (EXT-13).
pub const SECRETS: &str = "secrets";
/// What a manifest without `permissions` is taken to request.
pub const LEGACY: [&str; 3] = [DOCUMENTS_READ, EDITOR_CONTROL, FS_READ];

/// `raw` as a capability in its canonical spelling, if it is one. `owner` is the extension
/// asking: its own commands need no capability, so naming them is not one.
pub fn capability(raw: &str, owner: &str) -> Option<String> {
    match raw {
        FS_READ | DOCUMENTS_READ | DOCUMENTS_EDIT | EDITOR_CONTROL | SECRETS => {
            Some(raw.to_string())
        }
        _ => {
            let target = canonical_id(raw.strip_prefix(COMMANDS_EXECUTE)?)?;
            (target != owner).then(|| format!("{COMMANDS_EXECUTE}{target}"))
        }
    }
}

/// What a manifest requests.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Declared {
    /// No `permissions` field: requests `LEGACY`.
    pub legacy: bool,
    pub requested: BTreeSet<String>,
}

/// The manifest's request, or why it is refused (a refused declaration fails closed: the
/// extension is not installed, and an installed copy with one is not loaded).
pub fn declared(manifest: &Value, owner: &str) -> Result<Declared, String> {
    let Some(raw) = manifest.as_object().and_then(|m| m.get("permissions")) else {
        // Without code (a declarative extension) there is nothing to ask for.
        let code = manifest.get("main").is_some_and(|main| !main.is_null());
        return Ok(Declared {
            legacy: true,
            requested: LEGACY
                .iter()
                .filter(|_| code)
                .map(|c| c.to_string())
                .collect(),
        });
    };
    let object = raw
        .as_object()
        .ok_or("\"permissions\" must be an object: {\"version\": 1, \"request\": [...]}")?;
    if let Some(key) = object.keys().find(|k| *k != "version" && *k != "request") {
        return Err(format!(
            "\"permissions.{key}\" is not part of the permission model"
        ));
    }
    // A whole number (`1` and `1.0` are the same number in JSON, as the renderer reads it).
    let version = object
        .get("version")
        .and_then(Value::as_f64)
        .filter(|v| v.fract() == 0.0 && *v >= 0.0 && *v <= u32::MAX as f64)
        .map(|v| v as u64);
    match version {
        Some(PERMISSIONS_VERSION) => {}
        Some(other) => {
            return Err(format!(
                "permission model version {other} is not supported (this Yavin reads version {PERMISSIONS_VERSION})"
            ))
        }
        None => return Err("\"permissions.version\" must be 1".into()),
    }
    let list = object
        .get("request")
        .and_then(Value::as_array)
        .ok_or("\"permissions.request\" must be a list")?;
    if list.len() > MAX_REQUESTED {
        return Err(format!(
            "at most {MAX_REQUESTED} capabilities may be requested"
        ));
    }
    let mut requested = BTreeSet::new();
    for item in list {
        let text = item
            .as_str()
            .ok_or("each requested capability is a string")?;
        let one = capability(text, owner)
            .ok_or_else(|| format!("\"{text}\" is not a capability this Yavin offers"))?;
        if !requested.insert(one) {
            return Err(format!("\"{text}\" is requested twice"));
        }
    }
    Ok(Declared {
        legacy: false,
        requested,
    })
}

/// Why Yavin refused something an extension asked: a code and a message naming what was
/// missing -- never the data asked for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Denial {
    pub code: &'static str,
    pub message: String,
}

impl Denial {
    pub fn new(code: &'static str, message: impl Into<String>) -> Denial {
        Denial {
            code,
            message: message.into(),
        }
    }
}

/// What one request of an extension needs before Yavin acts on it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Need {
    /// Mandatory: allowed for every extension (ownership checked here or by the window).
    Nothing,
    /// The optional capability, granted for the copy whose code asks.
    Capability(String),
    /// It names what is not the extension's own.
    NotOwned(String),
    /// Malformed.
    Invalid(String),
    /// Not a method of the extension API: never allowed.
    Unknown,
}

fn string<'a>(params: &'a Value, name: &str) -> Option<&'a str> {
    params.get(name).and_then(Value::as_str)
}

/// The extension that owns command (or view) `id`: `<publisher>.<name>.<rest>`.
fn owner_of(id: &str) -> Option<String> {
    let mut parts = id.splitn(3, '.');
    let (publisher, name, rest) = (parts.next()?, parts.next()?, parts.next()?);
    if rest.is_empty() {
        return None;
    }
    canonical_id(&format!("{publisher}.{name}"))
}

/// `name` must be one of `caller`'s own: `<caller><separator>...`.
fn owned(params: &Value, name: &str, caller: &str, separator: char) -> Need {
    match string(params, name) {
        None => Need::Invalid(format!("\"{name}\" must be a string")),
        Some(id) if id.starts_with(&format!("{caller}{separator}")) => Need::Nothing,
        Some(id) => Need::NotOwned(format!("\"{id}\" is not {caller}'s own")),
    }
}

/// An event Yavin may send an extension, and what receiving it needs.
pub fn need_of_event(event: &str) -> Need {
    match event {
        // EXT-27: whether the window is focused -- nothing of the user's work.
        "configuration.changed" | "window.state" => Need::Nothing,
        "documents.open" | "documents.change" | "documents.close" | "editor.active" => {
            Need::Capability(DOCUMENTS_READ.into())
        }
        // EXT-29: saves (and being asked before one), and the editor's selection.
        "documents.save" | "documents.willSave" | "editor.selection" => {
            Need::Capability(DOCUMENTS_READ.into())
        }
        // EXT-29: the workspace's file changes (names of files in it).
        "files.change" => Need::Capability(FS_READ.into()),
        other => Need::Invalid(format!(
            "\"{other}\" is not an event an extension can follow"
        )),
    }
}

/// What request `method` from extension `caller` needs. Default deny: a method not listed is
/// `Unknown`.
pub fn need_of_request(caller: &str, method: &str, params: &Value) -> Need {
    let need = |capability: &str| Need::Capability(capability.to_string());
    match method {
        "commands.register" | "commands.unregister" => owned(params, "id", caller, '.'),
        "views.register" | "views.refresh" | "views.unregister" => owned(params, "id", caller, '.'),
        "languages.register" | "languages.unregister" => owned(params, "providerId", caller, '#'),
        // Its own status bar items (EXT-25): `<id>#status#<n>`, shown in Yavin's own style.
        "statusBar.set" | "statusBar.remove" => owned(params, "id", caller, '#'),
        // EXT-29: its own prompts (`<id>#prompt#<n>`): Yavin's picker and input box, which the
        // user answers; its own diagnostic collections (`<id>#diagnostics#<n>`), in Problems.
        "window.quickPick" | "window.inputBox" | "window.cancelPrompt" => {
            owned(params, "id", caller, '#')
        }
        "diagnostics.set" | "diagnostics.clear" => owned(params, "collection", caller, '#'),
        "window.showMessage" | "window.state" | "storage.update" | "editor.setDecorations" => {
            Need::Nothing
        }
        // Following an event is mandatory; receiving one is checked when it is sent
        // (`need_of_event`): a grant given later applies at once, a revocation too.
        "events.subscribe" => match string(params, "event").map(need_of_event) {
            Some(Need::Invalid(why)) => Need::Invalid(why),
            Some(_) => Need::Nothing,
            None => Need::Invalid("\"event\" must be a string".into()),
        },
        "commands.execute" => match string(params, "id").map(|id| (id, owner_of(id))) {
            Some((_, Some(owner))) if owner == caller => Need::Nothing,
            Some((_, Some(owner))) => Need::Capability(format!("{COMMANDS_EXECUTE}{owner}")),
            Some((id, None)) => Need::Invalid(format!("\"{id}\" is not an extension's command")),
            None => Need::Invalid("\"id\" must be a string".into()),
        },
        "documents.all" | "documents.get" | "documents.getText" | "editor.active" => {
            need(DOCUMENTS_READ)
        }
        "editor.openLocation" | "editor.setSelection" | "editor.revealRange" => {
            need(EDITOR_CONTROL)
        }
        "fs.readFile" | "fs.exists" => need(FS_READ),
        "documents.edit" => need(DOCUMENTS_EDIT),
        // Its own secrets (EXT-13): handled natively, never passed to the window.
        "secrets.get" | "secrets.store" | "secrets.delete" => {
            let scope_ok = params.get("scope").is_none_or(|s| {
                s.as_str()
                    .is_some_and(|s| s == "installation" || s == "workspace")
            });
            let value_ok = method != "secrets.store" || string(params, "value").is_some();
            match string(params, "key") {
                Some(_) if scope_ok && value_ok => need(SECRETS),
                Some(_) if !scope_ok => {
                    Need::Invalid("\"scope\" must be \"installation\" or \"workspace\"".into())
                }
                Some(_) => Need::Invalid("\"value\" must be a string".into()),
                None => Need::Invalid("\"key\" must be a string".into()),
            }
        }
        _ => Need::Unknown,
    }
}

/// Whether `id` is an id `capability` could have been granted to (the target is not itself).
pub fn grantable(id: &str, capability: &str) -> bool {
    is_canonical(id) && self::capability(capability, id).as_deref() == Some(capability)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn cases() -> Value {
        serde_json::from_str(include_str!(
            "../../src/services/extensions/permissions.cases.json"
        ))
        .unwrap()
    }

    /// The renderer's rules give the same answers (permissions.test.ts reads the same file).
    #[test]
    fn the_shared_declaration_cases_agree() {
        let cases = cases();
        let all = cases["declarations"].as_array().unwrap();
        assert!(all.len() >= 20);
        for case in all {
            let got = declared(&case["manifest"], "acme.hello");
            let about = case["about"].as_str().unwrap();
            if case["ok"] == json!(true) {
                let got = got.unwrap_or_else(|e| panic!("{about}: {e}"));
                assert_eq!(got.legacy, case["legacy"] == json!(true), "{about}");
                let wanted: Vec<String> =
                    serde_json::from_value(case["requested"].clone()).unwrap();
                assert_eq!(
                    got.requested.into_iter().collect::<Vec<_>>(),
                    wanted,
                    "{about}"
                );
            } else {
                assert!(got.is_err(), "{about}: {got:?}");
            }
        }
    }

    fn label(need: &Need) -> String {
        match need {
            Need::Nothing => "none".into(),
            Need::Capability(c) => c.clone(),
            Need::NotOwned(_) => "notOwned".into(),
            Need::Invalid(_) => "invalid".into(),
            Need::Unknown => "unknown".into(),
        }
    }

    #[test]
    fn the_shared_request_and_event_cases_agree() {
        let cases = cases();
        for case in cases["requests"].as_array().unwrap() {
            let method = case["method"].as_str().unwrap();
            let need = need_of_request("acme.hello", method, &case["params"]);
            assert_eq!(label(&need), case["need"].as_str().unwrap(), "{case}");
        }
        for case in cases["events"].as_array().unwrap() {
            let need = need_of_event(case["event"].as_str().unwrap());
            assert_eq!(label(&need), case["need"].as_str().unwrap(), "{case}");
        }
    }

    /// Every method the window serves (host.ts `methods`) has an explicit decision here: none
    /// falls through to `Unknown` -- and anything else does.
    #[test]
    fn every_bridge_method_has_a_decision() {
        let host = include_str!("../../src/services/extensions/host.ts");
        let start = host.find("const methods: Record<").unwrap();
        let end = start + host[start..].find("\n  };\n").unwrap();
        let methods: Vec<&str> = host[start..end]
            .lines()
            .filter_map(|line| {
                // A method's definition: `"name"(one, params) {` (or `async "name"(...`).
                let line = line.trim_start().trim_start_matches("async ");
                let (name, rest) = line.strip_prefix('"')?.split_once('"')?;
                rest.starts_with('(').then_some(name)
            })
            .collect();
        // EXT-25: documents.edit, statusBar.set, statusBar.remove; EXT-27: window.state; EXT-29:
        // window.quickPick, window.inputBox, window.cancelPrompt, diagnostics.set, diagnostics.clear.
        assert_eq!(methods.len(), 30, "{methods:?}");
        for method in methods {
            assert_ne!(
                need_of_request("acme.hello", method, &json!({})),
                Need::Unknown,
                "{method} has no decision"
            );
        }
    }

    #[test]
    fn grantable_is_what_a_manifest_could_request() {
        assert!(grantable("acme.hello", "documents.read"));
        assert!(grantable("acme.hello", "commands.execute:acme.other"));
        assert!(!grantable("acme.hello", "commands.execute:acme.hello"));
        assert!(!grantable("acme.hello", "commands.execute:Acme.Other"));
        assert!(!grantable("acme.hello", "network.fetch"));
        assert!(!grantable("Acme.Hello", "documents.read"));
    }
}
