//! VS Code packages (EXT-04, EXT-25): the typed adapter from a VSIX's `extension/package.json`
//! to a Yavin manifest of what Yavin supports of it.
//!
//! A VSIX (verified 2026-10-18 on open-vsx.org packages) is a zip archive: `extension.vsixmanifest`,
//! `[Content_Types].xml`, and the extension under `extension/` (its `package.json`, its files).
//! It is validated and unpacked like any package (`extension_package::unpack`: names, links,
//! sizes, counts, ratios); this adapter then reads its `package.json`, never runs anything in
//! it, and writes `yavin-extension.json` beside it:
//!
//! - the id is `publisher.name`, folded to Yavin's one id rule (VS Code ids are mixed case),
//!   and must be the extension asked for; the version must be the one asked for;
//! - **declarative** (EXT-04, EXT-25): `contributes.themes` (JSON colour themes),
//!   `contributes.snippets`, `contributes.languages` (ids, file associations, language
//!   configuration) and `contributes.grammars` (TextMate grammars) are kept, each path resolved
//!   inside `extension/` to a plain file of at most 1 MiB, or the entry is rejected;
//! - **code** (EXT-25): its entry point -- `browser` (a web extension: written for a runtime
//!   without Node.js) before `main` -- becomes the manifest's `main`, to run in Yavin's
//!   extension host (QuickJS, in the AppContainer sandbox) through the VS Code compatibility
//!   layer (`ide-plugin-host/src/vscode.js`). Its commands, settings, keybindings, views and
//!   menus are mapped to Yavin's, under ids it owns (`<id>.<slug>-<hash>`; the VS Code ids are
//!   recorded in `vsix.runtime` for the layer); its activation events are mapped. It asks for
//!   the optional capabilities the layer can use (`documents.read`, `documents.edit`,
//!   `editor.control`, `workspace.fs.read`, `secrets`), which the user grants or not (EXT-07): nothing is
//!   granted by being a VS Code extension;
//! - everything else -- icon themes, debuggers, webviews, task definitions, dependencies -- is
//!   listed as not supported.
//!
//! What was kept, ignored and rejected is recorded in the manifest's `vsix` report, shown on
//! the extension's page. A package with nothing Yavin supports is refused.

use crate::extension_package::{entry_components, version_ok};
use crate::extensions::MANIFEST_FILE;
use ide_workspace::extension_id::canonical_id;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

/// The largest theme, snippets, language configuration or grammar file a contribution may name.
pub const MAX_RESOURCE: u64 = 1024 * 1024;
/// The largest code file of a VS Code extension (its entry point, or any module it loads).
pub const MAX_CODE: u64 = 8 * 1024 * 1024;
/// The most entries of one kind kept from one package.
const MAX_ENTRIES: usize = 50;
/// The most commands, settings or keybindings kept from one package.
const MAX_MAPPED: usize = 200;
const UI_THEMES: [&str; 4] = ["vs", "vs-dark", "hc-black", "hc-light"];
/// The extension API a VS Code extension's code needs: the compatibility layer's (EXT-25).
pub const VSCODE_RUNTIME_API: &str = "^2.1.0";
/// The VS Code API level the compatibility layer was audited against (`vscode.version`).
pub const VSCODE_API_LEVEL: &str = "1.90.0";
/// What a VS Code extension's code asks for (EXT-07: the user grants each, or not).
const REQUESTED: [&str; 5] = [
    "documents.edit",
    "documents.read",
    "editor.control",
    "secrets",
    "workspace.fs.read",
];

/// Why each contribution point Yavin does not support is left out.
fn unsupported(key: &str) -> String {
    match key {
        "productIconThemes" => {
            "productIconThemes: product icon themes (the workbench's own icons) are not supported."
                .into()
        }
        "debuggers" | "breakpoints" => format!(
            "{key}: debug adapters are not supported (Yavin starts no process for an extension)."
        ),
        "taskDefinitions" | "problemMatchers" | "problemPatterns" => {
            format!("{key}: tasks are not supported.")
        }
        "customEditors" | "notebooks" | "notebookRenderer" => {
            format!("{key}: custom editors and notebooks need webviews, which are not supported.")
        }
        "jsonValidation" => "jsonValidation: JSON schemas from extensions are not applied.".into(),
        "walkthroughs" | "viewsWelcome" => format!("{key}: not shown."),
        "colors" => "colors: new theme colours are not supported.".into(),
        "terminal" => "terminal: terminal profiles are not supported.".into(),
        "authentication" => "authentication: authentication providers are not supported.".into(),
        "submenus" => {
            "submenus: not supported; their commands are still in the Command Palette.".into()
        }
        "semanticTokenTypes" | "semanticTokenModifiers" | "semanticTokenScopes" => {
            format!("{key}: not supported.")
        }
        _ => format!("{key}: not a contribution point Yavin supports."),
    }
}

/// One line from `value`, at most `max` UTF-16 units long (how the renderer's manifest
/// validator measures it).
fn one_line(value: Option<&Value>, max: usize) -> Option<String> {
    let text = value?.as_str()?;
    let cleaned: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let mut units = 0;
    let line: String = cleaned
        .trim()
        .chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= max
        })
        .collect();
    let line = line.trim().to_string();
    (!line.is_empty()).then_some(line)
}

/// `path` (from `package.json`, relative to `extension/`) as a file of the package of at most
/// `max` bytes: its path in the archive (`extension/…`, `/`-separated), or why it cannot be used.
fn file_of(files: &Path, path: &str, max: u64) -> Result<String, String> {
    let relative = path.trim_start_matches("./");
    let inside = format!("extension/{relative}");
    let parts = entry_components(&inside).map_err(|why| {
        let why = why
            .strip_prefix("UnsafePackage: ")
            .unwrap_or(&why)
            .to_string();
        format!("\"{path}\": {why}")
    })?;
    let file: PathBuf = parts
        .iter()
        .fold(files.to_path_buf(), |p, part| p.join(part));
    let meta =
        fs::symlink_metadata(&file).map_err(|_| format!("\"{path}\" is not in the package"))?;
    if !meta.is_file() {
        return Err(format!("\"{path}\" is not a file"));
    }
    if meta.len() > max {
        return Err(format!("\"{path}\" is larger than {} KiB", max / 1024));
    }
    Ok(parts.join("/"))
}

fn resource(files: &Path, path: &str) -> Result<String, String> {
    file_of(files, path, MAX_RESOURCE)
}

/// A VS Code icon theme's id: what the `explorer.iconTheme` setting names, with its extension.
fn icon_theme_id_ok(id: &str) -> bool {
    let mut chars = id.chars();
    id.len() <= 100
        && chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
}

fn language_ok(language: &str) -> bool {
    let mut chars = language.chars();
    language.len() <= 50
        && chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || "+#._-".contains(c))
}

fn scope_ok(scope: &str) -> bool {
    let mut chars = scope.chars();
    scope.len() <= 100
        && chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || "_.+-".contains(c))
}

/// FNV-1a: a stable, short tag that keeps mapped ids distinct (not a security function).
fn tag(text: &str) -> u32 {
    text.bytes().fold(0x811c_9dc5, |hash: u32, byte| {
        (hash ^ byte as u32).wrapping_mul(0x0100_0193)
    })
}

/// A VS Code command, setting, view or container id as the last part of a Yavin id the
/// extension owns: readable, at most 57 characters of `[a-z0-9_-]`, and distinct for distinct
/// ids (the tag of the original spelling).
pub fn part(original: &str) -> String {
    let mut slug = String::new();
    for c in original.chars() {
        let c = c.to_ascii_lowercase();
        if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
            slug.push(c);
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
        if slug.len() >= 48 {
            break;
        }
    }
    let slug = slug
        .trim_start_matches(|c: char| !c.is_ascii_alphanumeric())
        .trim_end_matches('-');
    if slug.is_empty() {
        format!("x{:08x}", tag(original))
    } else {
        format!("{slug}-{:08x}", tag(original))
    }
}

/// `package.nls.json`: the text `%key%` placeholders stand for (the default language's).
fn nls_of(files: &Path) -> Map<String, Value> {
    resource(files, "package.nls.json")
        .ok()
        .and_then(|path| fs::read_to_string(files.join(path)).ok())
        .and_then(|text| serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

/// A text of `package.json` -- a string, `%key%` from `package.nls.json`, or a localized
/// `{value, original}` -- as one line of at most `max` units.
fn text_of(value: Option<&Value>, nls: &Map<String, Value>, max: usize) -> Option<String> {
    let value = value?;
    let value = match value {
        Value::Object(object) => object.get("value")?,
        other => other,
    };
    let text = value.as_str()?;
    if let Some(key) = text
        .strip_prefix('%')
        .and_then(|rest| rest.strip_suffix('%'))
    {
        let found = nls.get(key)?;
        let found = match found {
            Value::Object(object) => object.get("message")?,
            other => other,
        };
        return one_line(Some(found), max);
    }
    one_line(Some(value), max)
}

/// A VS Code keybinding as Yavin's (`Mod+Shift+k`), when it can be one: one chord, at least one
/// modifier that is not Shift alone, and a key Yavin binds.
fn key_of(key: &str) -> Option<String> {
    let key = key.trim().to_ascii_lowercase();
    if key.contains(' ') {
        return None;
    }
    let mut parts: Vec<&str> = key.split('+').collect();
    // `ctrl++` is ctrl with plus.
    if key.ends_with("++") {
        parts.retain(|p| !p.is_empty());
        parts.push("=");
    }
    let last = parts.pop()?;
    let (mut ctrl, mut shift, mut alt) = (false, false, false);
    for modifier in parts {
        match modifier {
            "ctrl" => ctrl = true,
            "shift" => shift = true,
            "alt" => alt = true,
            _ => return None,
        }
    }
    let named = last.len() == 1
        && last
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "`-=[]\\;',./".contains(c));
    let function = last
        .strip_prefix('f')
        .and_then(|n| n.parse::<u8>().ok())
        .is_some_and(|n| (1..=12).contains(&n));
    if !(named || function) || !(ctrl || alt) {
        return None;
    }
    let mut out = Vec::new();
    if ctrl {
        out.push("Mod".to_string());
    }
    if shift {
        out.push("Shift".to_string());
    }
    if alt {
        out.push("Alt".to_string());
    }
    out.push(if function {
        last.to_ascii_uppercase()
    } else {
        last.to_string()
    });
    Some(out.join("+"))
}

/// A `when` clause a keybinding may have and still be bound everywhere Yavin's editor is.
fn editor_when(when: Option<&str>) -> bool {
    match when.map(str::trim) {
        None | Some("") => true,
        Some(when) => matches!(
            when,
            "editorTextFocus"
                | "editorFocus"
                | "textInputFocus"
                | "editorTextFocus && !editorReadonly"
                | "editorFocus && !editorReadonly"
        ),
    }
}

/// A menu item's `when`, as one of the two conditions Yavin evaluates, or no condition.
enum When {
    Always,
    Is(&'static str, String),
    Unsupported,
}

fn menu_when(when: Option<&Value>) -> When {
    let Some(when) = when.and_then(Value::as_str).map(str::trim) else {
        return When::Always;
    };
    if when.is_empty() {
        return When::Always;
    }
    for (vscode, yavin) in [
        ("editorLangId", "resourceLangId"),
        ("resourceLangId", "resourceLangId"),
        ("resourceExtname", "resourceExtname"),
    ] {
        if let Some(rest) = when.strip_prefix(vscode) {
            let value = rest
                .trim_start()
                .strip_prefix("==")
                .map(|v| v.trim().trim_matches('\''));
            if let Some(value) = value.filter(|v| {
                (1..=40).contains(&v.len())
                    && v.chars()
                        .all(|c| c.is_ascii_alphanumeric() || "._+#-".contains(c))
            }) {
                return When::Is(yavin, value.to_string());
            }
        }
    }
    When::Unsupported
}

/// The code file `path` names, as Node would find it: itself, with `.js`, or its `index.js`.
fn code_of(files: &Path, path: &str) -> Result<String, String> {
    let trimmed = path.trim_end_matches('/');
    let mut last = Err(format!("\"{path}\" is not in the package"));
    for candidate in [
        trimmed.to_string(),
        format!("{trimmed}.js"),
        format!("{trimmed}/index.js"),
    ] {
        match file_of(files, &candidate, MAX_CODE) {
            Ok(found) => return Ok(found),
            Err(why) if why.contains("larger than") => return Err(why),
            Err(why) => last = Err(why),
        }
    }
    last
}

/// "1 command", "2 commands".
fn count(n: usize, what: &str) -> String {
    format!("{n} {what}{}", if n == 1 { "" } else { "s" })
}

#[derive(Default)]
struct Report {
    supported: Vec<String>,
    ignored: Vec<String>,
    rejected: Vec<String>,
}

/// The commands, settings, keybindings, views and menus of code that runs, as Yavin's.
struct Mapped {
    contributes: Map<String, Value>,
    commands: BTreeMap<String, String>,
    settings: BTreeMap<String, String>,
    views: BTreeMap<String, String>,
    defaults: BTreeMap<String, Value>,
    activation: Vec<String>,
}

fn map_code(
    id: &str,
    manifest: &Value,
    contributes: &Map<String, Value>,
    nls: &Map<String, Value>,
    report: &mut Report,
) -> Mapped {
    let mut out = Mapped {
        contributes: Map::new(),
        commands: BTreeMap::new(),
        settings: BTreeMap::new(),
        views: BTreeMap::new(),
        defaults: BTreeMap::new(),
        activation: Vec::new(),
    };
    // Commands.
    let mut commands = Vec::new();
    let mut by_vscode: BTreeMap<String, String> = BTreeMap::new();
    for entry in contributes
        .get("commands")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(command) = one_line(entry.get("command"), 200) else {
            report.rejected.push("A command has no id.".into());
            continue;
        };
        if by_vscode.contains_key(&command) {
            continue;
        }
        if commands.len() >= MAX_MAPPED {
            report.ignored.push(format!(
                "Command {command}: more than {MAX_MAPPED} commands"
            ));
            continue;
        }
        let Some(title) = text_of(entry.get("title"), nls, 100) else {
            report
                .rejected
                .push(format!("Command {command}: it has no title"));
            continue;
        };
        let yavin = format!("{id}.{}", part(&command));
        let mut contribution = json!({"command": yavin, "title": title});
        if let Some(category) = text_of(entry.get("category"), nls, 50) {
            contribution["category"] = json!(category);
        }
        commands.push(contribution);
        by_vscode.insert(command.clone(), yavin.clone());
        out.commands.insert(yavin, command);
    }
    if !commands.is_empty() {
        report.supported.push(format!(
            "{} (Command Palette)",
            count(commands.len(), "command")
        ));
        out.contributes
            .insert("commands".into(), Value::Array(commands));
    }

    // Keybindings: only where Yavin's binding means what VS Code's did.
    let mut keybindings = Vec::new();
    let mut skipped = 0;
    for entry in contributes
        .get("keybindings")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let command = entry.get("command").and_then(Value::as_str).unwrap_or("");
        let key = entry
            .get("win")
            .or(entry.get("key"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let mapped = by_vscode.get(command);
        let yavin_key = key_of(key);
        match (mapped, yavin_key) {
            (Some(yavin), Some(yavin_key))
                if entry.get("args").is_none()
                    && editor_when(entry.get("when").and_then(Value::as_str))
                    && keybindings.len() < MAX_MAPPED
                    && !keybindings
                        .iter()
                        .any(|k: &Value| k["key"] == json!(yavin_key)) =>
            {
                keybindings.push(json!({"command": yavin, "key": yavin_key}));
            }
            _ => skipped += 1,
        }
    }
    if !keybindings.is_empty() {
        report
            .supported
            .push(count(keybindings.len(), "keybinding"));
        out.contributes
            .insert("keybindings".into(), Value::Array(keybindings));
    }
    if skipped > 0 {
        report.ignored.push(format!(
            "{skipped} keybindings: a chord, a key Yavin does not bind, arguments, or a \"when\" condition Yavin does not evaluate"
        ));
    }

    // Settings: the four kinds Yavin's settings have; others keep their defaults.
    let blocks: Vec<&Value> = match contributes.get("configuration") {
        Some(Value::Array(list)) => list.iter().collect(),
        Some(object @ Value::Object(_)) => vec![object],
        _ => Vec::new(),
    };
    let mut properties = Map::new();
    let mut unmapped = 0;
    for block in blocks {
        for (key, schema) in block
            .get("properties")
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
        {
            if properties.len() >= MAX_MAPPED
                || key.len() > 200
                || out.settings.values().any(|k| k == key)
            {
                continue;
            }
            let kind = schema.get("type");
            let kind = match kind {
                Some(Value::Array(kinds)) if kinds.len() == 1 => kinds[0].as_str(),
                Some(Value::String(kind)) => Some(kind.as_str()),
                _ => None,
            };
            let values: Vec<String> = schema
                .get("enum")
                .and_then(Value::as_array)
                .map(|list| {
                    list.iter()
                        .filter_map(|v| {
                            one_line(Some(v), 100).filter(|s| Some(s.as_str()) == v.as_str())
                        })
                        .collect()
                })
                .unwrap_or_default();
            let enum_ok = schema.get("enum").is_some()
                && !values.is_empty()
                && values.len() == schema["enum"].as_array().map_or(0, Vec::len);
            let default = schema.get("default");
            let number = |v: Option<&Value>| v.and_then(Value::as_f64).filter(|n| n.is_finite());
            let (minimum, maximum) = (number(schema.get("minimum")), number(schema.get("maximum")));
            let mapped = match kind {
                Some("string") if enum_ok => {
                    let chosen = default
                        .and_then(Value::as_str)
                        .filter(|d| values.iter().any(|v| v == d))
                        .map(str::to_string)
                        .unwrap_or_else(|| values[0].clone());
                    Some(json!({"type": "string", "enum": values, "default": chosen}))
                }
                Some("string") => {
                    let chosen = default.and_then(Value::as_str).unwrap_or("");
                    (chosen.chars().count() <= 1000)
                        .then(|| json!({"type": "string", "default": chosen}))
                }
                Some("boolean") => Some(
                    json!({"type": "boolean", "default": default.and_then(Value::as_bool).unwrap_or(false)}),
                ),
                Some("number") | Some("integer") => {
                    let chosen = number(default).unwrap_or(0.0);
                    let inside =
                        minimum.is_none_or(|m| chosen >= m) && maximum.is_none_or(|m| chosen <= m);
                    let ordered = match (minimum, maximum) {
                        (Some(a), Some(b)) => a <= b,
                        _ => true,
                    };
                    (inside && ordered).then(|| {
                        let mut setting = json!({"type": "number", "default": chosen});
                        if let Some(m) = minimum {
                            setting["minimum"] = json!(m);
                        }
                        if let Some(m) = maximum {
                            setting["maximum"] = json!(m);
                        }
                        setting
                    })
                }
                _ => None,
            };
            let Some(mut setting) = mapped else {
                // Its default is still what the extension reads (it cannot be changed in Yavin).
                let fallback = default.cloned().unwrap_or(match kind {
                    Some("array") => json!([]),
                    Some("object") => json!({}),
                    _ => Value::Null,
                });
                if fallback.to_string().len() <= 4096 {
                    out.defaults.insert(key.clone(), fallback);
                }
                unmapped += 1;
                continue;
            };
            let description = text_of(schema.get("description"), nls, 500)
                .or_else(|| text_of(schema.get("markdownDescription"), nls, 500))
                .unwrap_or_else(|| key.chars().take(500).collect());
            setting["title"] = json!(key.chars().take(100).collect::<String>());
            setting["description"] = json!(description);
            let scope = schema
                .get("scope")
                .and_then(Value::as_str)
                .unwrap_or("window");
            setting["scope"] = json!(if matches!(scope, "application" | "machine") {
                "user"
            } else {
                "both"
            });
            let yavin = format!("{id}.{}", part(key));
            properties.insert(yavin.clone(), setting);
            out.settings.insert(yavin, key.clone());
        }
    }
    if !properties.is_empty() {
        report.supported.push(count(properties.len(), "setting"));
        out.contributes
            .insert("configuration".into(), json!({"properties": properties}));
    }
    if unmapped > 0 {
        report.ignored.push(format!(
            "{unmapped} settings are lists, objects or of several types: they keep their defaults and cannot be changed in Yavin"
        ));
    }

    // View containers and views (tree views; webview views are not supported).
    let mut containers = Vec::new();
    let mut container_ids: BTreeMap<String, String> = BTreeMap::new();
    let mut panels: BTreeSet<String> = BTreeSet::new();
    if let Some(declared) = contributes
        .get("viewsContainers")
        .and_then(Value::as_object)
    {
        for entry in declared
            .get("activitybar")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let (Some(cid), Some(title)) = (
                one_line(entry.get("id"), 200),
                text_of(entry.get("title"), nls, 60),
            ) else {
                continue;
            };
            if containers.len() >= MAX_ENTRIES || container_ids.contains_key(&cid) {
                continue;
            }
            let yavin = format!("{id}.{}", part(&cid));
            containers.push(json!({"id": yavin, "title": title}));
            container_ids.insert(cid, yavin);
        }
        for entry in declared
            .get("panel")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(cid) = one_line(entry.get("id"), 200) {
                panels.insert(cid);
            }
        }
    }
    let mut views = Vec::new();
    let mut webviews = 0;
    for (container, list) in contributes
        .get("views")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
    {
        for entry in list.as_array().into_iter().flatten() {
            if entry.get("type").and_then(Value::as_str) == Some("webview") {
                webviews += 1;
                continue;
            }
            let (Some(vid), Some(name)) = (
                one_line(entry.get("id"), 200),
                text_of(entry.get("name"), nls, 60),
            ) else {
                continue;
            };
            if views.len() >= MAX_ENTRIES || out.views.values().any(|v| *v == vid) {
                continue;
            }
            let yavin = format!("{id}.{}", part(&vid));
            let view = if let Some(mapped) = container_ids.get(container) {
                json!({"id": yavin, "name": name, "location": "container", "container": mapped})
            } else if panels.contains(container) {
                json!({"id": yavin, "name": name, "location": "panel"})
            } else {
                json!({"id": yavin, "name": name, "location": "sidebar"})
            };
            views.push(view);
            out.views.insert(yavin, vid);
        }
    }
    if webviews > 0 {
        report.ignored.push(format!(
            "{webviews} webview views: webviews are not supported"
        ));
    }
    if !views.is_empty() {
        report.supported.push(count(views.len(), "tree view"));
        // Only containers that hold a view.
        let used: BTreeSet<&str> = views
            .iter()
            .filter_map(|v| v.get("container").and_then(Value::as_str))
            .collect();
        let containers: Vec<Value> = containers
            .into_iter()
            .filter(|c| used.contains(c["id"].as_str().unwrap_or("")))
            .collect();
        if !containers.is_empty() {
            out.contributes
                .insert("viewsContainers".into(), json!({"activitybar": containers}));
        }
        out.contributes.insert("views".into(), Value::Array(views));
    }

    // Menus Yavin has, with the conditions it evaluates.
    let mut menus = Map::new();
    let mut dropped = 0;
    for (location, items) in contributes
        .get("menus")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
    {
        if !matches!(
            location.as_str(),
            "commandPalette" | "editor/context" | "explorer/context" | "view/title"
        ) {
            dropped += items.as_array().map_or(0, Vec::len);
            continue;
        }
        let mut kept: Vec<Value> = Vec::new();
        for item in items.as_array().into_iter().flatten() {
            let Some(command) = item
                .get("command")
                .and_then(Value::as_str)
                .and_then(|c| by_vscode.get(c))
            else {
                dropped += 1;
                continue;
            };
            let mut entry = json!({"command": command});
            match location.as_str() {
                "commandPalette" => {
                    if item.get("when").and_then(Value::as_str) == Some("false") {
                        entry["when"] = json!("false");
                    }
                }
                "view/title" => {
                    let when = item.get("when").and_then(Value::as_str).unwrap_or("");
                    let view = when
                        .split("&&")
                        .find_map(|part| part.trim().strip_prefix("view"))
                        .and_then(|rest| rest.trim_start().strip_prefix("=="))
                        .map(|v| v.trim().trim_matches('\''))
                        .and_then(|v| out.views.iter().find(|(_, original)| *original == v))
                        .map(|(yavin, _)| yavin.clone());
                    let Some(view) = view else {
                        dropped += 1;
                        continue;
                    };
                    entry["view"] = json!(view);
                }
                _ => match menu_when(item.get("when")) {
                    When::Always => {}
                    When::Is(key, value) => entry["when"] = json!(format!("{key} == {value}")),
                    When::Unsupported => {
                        dropped += 1;
                        continue;
                    }
                },
            }
            let duplicate = kept
                .iter()
                .any(|k| k["command"] == entry["command"] && k.get("view") == entry.get("view"));
            if !duplicate && kept.len() < MAX_MAPPED {
                kept.push(entry);
            }
        }
        if !kept.is_empty() {
            menus.insert(location.clone(), Value::Array(kept));
        }
    }
    if !menus.is_empty() {
        report.supported.push(format!(
            "Menu items ({})",
            menus.keys().cloned().collect::<Vec<_>>().join(", ")
        ));
        out.contributes.insert("menus".into(), Value::Object(menus));
    }
    if dropped > 0 {
        report.ignored.push(format!(
            "{dropped} menu items: menus Yavin does not have, or \"when\" conditions it does not evaluate"
        ));
    }

    // Activation: the events Yavin raises, and VS Code's implicit ones (1.74+: a contributed
    // command or view activates its extension).
    let mut activation: Vec<String> = Vec::new();
    let mut add = |event: String| {
        if !activation.contains(&event) {
            activation.push(event);
        }
    };
    let mut unmatched: Vec<String> = Vec::new();
    for event in manifest
        .get("activationEvents")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        if event == "*" || event == "onStartupFinished" {
            add(event.to_string());
        } else if let Some(command) = event.strip_prefix("onCommand:") {
            if let Some(yavin) = by_vscode.get(command) {
                add(format!("onCommand:{yavin}"));
            }
        } else if let Some(language) = event.strip_prefix("onLanguage:") {
            if language_ok(language) {
                add(format!("onLanguage:{language}"));
            }
        } else if let Some(view) = event.strip_prefix("onView:") {
            if let Some((yavin, _)) = out.views.iter().find(|(_, v)| *v == view) {
                add(format!("onView:{yavin}"));
            }
        } else if event.starts_with("workspaceContains:") {
            add("onWorkspace".into());
            if !unmatched.iter().any(|e| e.starts_with("workspaceContains")) {
                unmatched
                    .push("workspaceContains (it activates in every open folder instead)".into());
            }
        } else if !unmatched.contains(&event.to_string()) && unmatched.len() < 10 {
            unmatched.push(event.chars().take(100).collect());
        }
    }
    for yavin in out.commands.keys() {
        add(format!("onCommand:{yavin}"));
    }
    for yavin in out.views.keys() {
        add(format!("onView:{yavin}"));
    }
    if !unmatched.is_empty() {
        report.ignored.push(format!(
            "Activation events Yavin does not raise: {}",
            unmatched.join(", ")
        ));
    }
    out.activation = activation;
    out
}

/// The generated manifest stays within what Yavin reads of one (64 KiB, `extension_package`).
const MAX_GENERATED: usize = 63 * 1024;

/// `generated` as text within `MAX_GENERATED`: as written if it fits; else compact; else with
/// shorter setting descriptions; else without settings Yavin would show (their defaults are kept
/// for the code), keybindings, then menu items -- each said in its report.
fn fitted(mut generated: Value) -> Result<String, String> {
    let fail = |e: serde_json::Error| format!("InstallFailed: {e}");
    let pretty = serde_json::to_string_pretty(&generated).map_err(fail)?;
    if pretty.len() <= MAX_GENERATED {
        return Ok(pretty);
    }
    let note = |generated: &mut Value, text: String| {
        if let Some(list) = generated["vsix"]["ignored"].as_array_mut() {
            list.push(json!(text));
        }
    };
    let size = |generated: &Value| {
        serde_json::to_string(generated)
            .map(|t| t.len())
            .unwrap_or(usize::MAX)
    };
    if let Some(settings) = generated
        .pointer_mut("/contributes/configuration/properties")
        .and_then(Value::as_object_mut)
    {
        for setting in settings.values_mut() {
            if let Some(text) = setting["description"].as_str() {
                if text.chars().count() > 80 {
                    let short: String = text.chars().take(79).collect();
                    setting["description"] = json!(format!("{short}…"));
                }
            }
        }
    }
    let mut dropped = 0;
    while size(&generated) > MAX_GENERATED {
        let Some(settings) = generated
            .pointer_mut("/contributes/configuration/properties")
            .and_then(Value::as_object_mut)
        else {
            break;
        };
        let Some(last) = settings.keys().next_back().cloned() else {
            break;
        };
        let setting = settings.remove(&last).unwrap_or(Value::Null);
        if let Some(original) = generated["vsix"]["runtime"]["settings"]
            .as_object_mut()
            .and_then(|map| map.remove(&last))
        {
            generated["vsix"]["runtime"]["defaults"][original.as_str().unwrap_or("")] =
                setting["default"].clone();
        }
        dropped += 1;
    }
    if dropped > 0 {
        note(
            &mut generated,
            format!("{dropped} more settings: too many to show; they keep their defaults"),
        );
    }
    for (key, what) in [("keybindings", "keybindings"), ("menus", "menu items")] {
        if size(&generated) <= MAX_GENERATED {
            break;
        }
        if generated["contributes"]
            .as_object_mut()
            .and_then(|c| c.remove(key))
            .is_some()
        {
            note(&mut generated, format!("Its {what}: too many to keep"));
        }
    }
    let text = serde_json::to_string(&generated).map_err(fail)?;
    if text.len() > MAX_GENERATED {
        return Err(
            "UnsupportedPackage: it contributes more commands than Yavin keeps in a manifest."
                .into(),
        );
    }
    Ok(text)
}

/// Adapts the VS Code package unpacked in `files` (whose `extension/package.json` is
/// `package`): writes `yavin-extension.json` there and returns its text.
pub fn adapt(
    files: &Path,
    package: &str,
    expected_id: &str,
    expected_version: &str,
) -> Result<String, String> {
    let manifest: Value = serde_json::from_str(package)
        .map_err(|e| format!("InvalidPackage: its extension/package.json is not JSON ({e})"))?;
    let text = |key: &str| manifest.get(key).and_then(Value::as_str);
    let (publisher, name) = match (text("publisher"), text("name")) {
        (Some(publisher), Some(name)) => (publisher, name),
        _ => return Err("InvalidPackage: its package.json has no publisher and name".into()),
    };
    let id = canonical_id(&format!("{publisher}.{name}")).ok_or_else(|| {
        format!("InvalidPackage: \"{publisher}.{name}\" is not an id Yavin can use")
    })?;
    let version = text("version").ok_or("InvalidPackage: its package.json has no version")?;
    version_ok(version)?;
    if id != expected_id || version != expected_version {
        return Err(format!(
            "ManifestMismatch: the package is {id} {version}, not {expected_id} {expected_version}."
        ));
    }
    let nls = nls_of(files);

    let mut report = Report::default();
    let mut themes = Vec::new();
    let mut snippets = Vec::new();
    let mut languages = Vec::new();
    let mut grammars = Vec::new();
    // File icon themes (EXT-30): data -- a JSON file and the SVG icons it names, applied by the
    // window (`services/extensions/iconThemes.ts`).
    let mut icon_themes = Vec::new();
    let empty = Map::new();
    let contributes = manifest
        .get("contributes")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    // What the code mapping reads, when there is code to run.
    const CODE_POINTS: [&str; 6] = [
        "commands",
        "keybindings",
        "configuration",
        "views",
        "viewsContainers",
        "menus",
    ];
    for (key, value) in contributes {
        match key.as_str() {
            "themes" => {
                for (n, entry) in value.as_array().into_iter().flatten().enumerate() {
                    let label = text_of(entry.get("label"), &nls, 100)
                        .or_else(|| one_line(entry.get("id"), 100));
                    let ui = entry
                        .get("uiTheme")
                        .and_then(Value::as_str)
                        .unwrap_or("vs-dark");
                    let path = entry.get("path").and_then(Value::as_str).unwrap_or("");
                    let what = format!(
                        "Theme {}",
                        label.as_deref().unwrap_or(&format!("#{}", n + 1))
                    );
                    if themes.len() >= MAX_ENTRIES {
                        report
                            .ignored
                            .push(format!("{what}: more than {MAX_ENTRIES} themes"));
                        continue;
                    }
                    if !UI_THEMES.contains(&ui) {
                        report
                            .rejected
                            .push(format!("{what}: \"{ui}\" is not a VS Code base theme"));
                        continue;
                    }
                    let lower = path.to_ascii_lowercase();
                    if lower.ends_with(".tmtheme") {
                        report.ignored.push(format!(
                            "{what}: \"{path}\" is a TextMate theme (.tmTheme), which is not supported"
                        ));
                        continue;
                    }
                    if !lower.ends_with(".json") {
                        report
                            .rejected
                            .push(format!("{what}: \"{path}\" is not a JSON colour theme"));
                        continue;
                    }
                    match (label, resource(files, path)) {
                        (Some(label), Ok(path)) => {
                            report.supported.push(format!("Colour theme \"{label}\""));
                            themes.push(json!({"label": label, "uiTheme": ui, "path": path}));
                        }
                        (None, _) => report.rejected.push(format!("{what}: it has no label")),
                        (_, Err(why)) => report.rejected.push(format!("{what}: {why}")),
                    }
                }
            }
            "iconThemes" => {
                for (n, entry) in value.as_array().into_iter().flatten().enumerate() {
                    let id = entry.get("id").and_then(Value::as_str).unwrap_or("");
                    let label = text_of(entry.get("label"), &nls, 100)
                        .or_else(|| one_line(entry.get("id"), 100));
                    let path = entry.get("path").and_then(Value::as_str).unwrap_or("");
                    let what = format!(
                        "File icon theme {}",
                        label.as_deref().unwrap_or(&format!("#{}", n + 1))
                    );
                    if icon_themes.len() >= MAX_ENTRIES {
                        report
                            .ignored
                            .push(format!("{what}: more than {MAX_ENTRIES} icon themes"));
                        continue;
                    }
                    if !icon_theme_id_ok(id) {
                        report
                            .rejected
                            .push(format!("{what}: \"{id}\" is not an icon theme id"));
                        continue;
                    }
                    if !path.to_ascii_lowercase().ends_with(".json") {
                        report
                            .rejected
                            .push(format!("{what}: \"{path}\" is not a JSON icon theme"));
                        continue;
                    }
                    match (label, resource(files, path)) {
                        (Some(label), Ok(path)) => {
                            report.supported.push(format!(
                                "File icon theme \"{label}\" (its SVG icons; font and PNG icons are not shown)"
                            ));
                            icon_themes.push(json!({"id": id, "label": label, "path": path}));
                        }
                        (None, _) => report.rejected.push(format!("{what}: it has no label")),
                        (_, Err(why)) => report.rejected.push(format!("{what}: {why}")),
                    }
                }
            }
            "snippets" => {
                for entry in value.as_array().into_iter().flatten() {
                    let language = entry.get("language").and_then(Value::as_str).unwrap_or("");
                    let path = entry.get("path").and_then(Value::as_str).unwrap_or("");
                    let what = format!("Snippets for \"{language}\"");
                    if snippets.len() >= MAX_ENTRIES {
                        report
                            .ignored
                            .push(format!("{what}: more than {MAX_ENTRIES} snippet files"));
                        continue;
                    }
                    if !language_ok(language) {
                        report.rejected.push(format!("{what}: not a language id"));
                        continue;
                    }
                    match resource(files, path) {
                        Ok(path) => {
                            report.supported.push(format!("Snippets for {language}"));
                            snippets.push(json!({"language": language, "path": path}));
                        }
                        Err(why) => report.rejected.push(format!("{what}: {why}")),
                    }
                }
            }
            "languages" => {
                for entry in value.as_array().into_iter().flatten() {
                    let language = entry.get("id").and_then(Value::as_str).unwrap_or("");
                    let what = format!("Language \"{language}\"");
                    if languages.len() >= MAX_ENTRIES {
                        report
                            .ignored
                            .push(format!("{what}: more than {MAX_ENTRIES} languages"));
                        continue;
                    }
                    if !language_ok(language) {
                        report.rejected.push(format!("{what}: not a language id"));
                        continue;
                    }
                    let strings = |key: &str, ok: &dyn Fn(&str) -> bool| -> Vec<String> {
                        entry
                            .get(key)
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                            .filter_map(Value::as_str)
                            .filter(|s| ok(s))
                            .take(MAX_ENTRIES)
                            .map(str::to_string)
                            .collect()
                    };
                    let extensions = strings("extensions", &|s| {
                        s.starts_with('.')
                            && (2..=31).contains(&s.len())
                            && s.chars()
                                .all(|c| c.is_ascii_alphanumeric() || "._+-".contains(c))
                    });
                    let filenames = strings("filenames", &|s| {
                        (1..=100).contains(&s.len())
                            && !s.contains(['/', '\\'])
                            && !s.chars().any(char::is_control)
                    });
                    let aliases: Vec<String> = entry
                        .get("aliases")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter_map(|a| one_line(Some(a), 50))
                        .take(10)
                        .collect();
                    let mut contribution = json!({
                        "id": language, "extensions": extensions, "filenames": filenames, "aliases": aliases,
                    });
                    if let Some(path) = entry.get("configuration").and_then(Value::as_str) {
                        match resource(files, path) {
                            Ok(path) => {
                                contribution["configuration"] = json!(path);
                                report
                                    .supported
                                    .push(format!("Language configuration for {language}"));
                            }
                            Err(why) => report
                                .rejected
                                .push(format!("{what}: its configuration {why}")),
                        }
                    }
                    for (key, what_is) in [
                        ("filenamePatterns", "file name patterns"),
                        ("firstLine", "first-line detection"),
                    ] {
                        if entry.get(key).is_some() {
                            report
                                .ignored
                                .push(format!("{what}: {what_is} are not supported"));
                        }
                    }
                    if !extensions.is_empty() || !filenames.is_empty() {
                        report.supported.push(format!(
                            "Language {language} ({})",
                            extensions
                                .iter()
                                .chain(filenames.iter())
                                .take(6)
                                .cloned()
                                .collect::<Vec<_>>()
                                .join(", ")
                        ));
                    }
                    languages.push(contribution);
                }
            }
            "grammars" => {
                for entry in value.as_array().into_iter().flatten() {
                    let scope = entry.get("scopeName").and_then(Value::as_str).unwrap_or("");
                    let path = entry.get("path").and_then(Value::as_str).unwrap_or("");
                    let what = format!("Grammar {scope}");
                    if grammars.len() >= MAX_ENTRIES {
                        report
                            .ignored
                            .push(format!("{what}: more than {MAX_ENTRIES} grammars"));
                        continue;
                    }
                    if !scope_ok(scope) {
                        report.rejected.push(format!("{what}: not a scope name"));
                        continue;
                    }
                    if entry.get("injectTo").is_some() {
                        report
                            .ignored
                            .push(format!("{what}: injection grammars are not supported"));
                        continue;
                    }
                    let lower = path.to_ascii_lowercase();
                    if ![".json", ".tmlanguage", ".plist"]
                        .iter()
                        .any(|end| lower.ends_with(end))
                    {
                        report.rejected.push(format!(
                            "{what}: \"{path}\" is not a TextMate grammar (.json, .tmLanguage, .plist)"
                        ));
                        continue;
                    }
                    let language = entry
                        .get("language")
                        .and_then(Value::as_str)
                        .filter(|l| language_ok(l));
                    let embedded: Map<String, Value> = entry
                        .get("embeddedLanguages")
                        .and_then(Value::as_object)
                        .into_iter()
                        .flatten()
                        .filter(|(scope, language)| {
                            scope_ok(scope) && language.as_str().is_some_and(language_ok)
                        })
                        .take(MAX_ENTRIES)
                        .map(|(k, v)| (k.clone(), v.clone()))
                        .collect();
                    match resource(files, path) {
                        Ok(path) => {
                            report.supported.push(match language {
                                Some(language) => format!("TextMate grammar {scope} ({language})"),
                                None => format!("TextMate grammar {scope} (embedded)"),
                            });
                            let mut grammar = json!({"scopeName": scope, "path": path});
                            if let Some(language) = language {
                                grammar["language"] = json!(language);
                            }
                            if !embedded.is_empty() {
                                grammar["embeddedLanguages"] = Value::Object(embedded);
                            }
                            grammars.push(grammar);
                        }
                        Err(why) => report.rejected.push(format!("{what}: {why}")),
                    }
                }
            }
            key if CODE_POINTS.contains(&key) => {}
            other => report.ignored.push(unsupported(other)),
        }
    }

    // Its code: the entry point the compatibility layer runs, when it can be run.
    let has_code = manifest.get("main").is_some() || manifest.get("browser").is_some();
    let mut runtime: Option<(String, &str)> = None;
    if has_code {
        let module = manifest.get("type").and_then(Value::as_str) == Some("module");
        let candidates = [("browser", text("browser")), ("main", text("main"))];
        let mut why = Vec::new();
        for (kind, path) in candidates {
            let Some(path) = path else { continue };
            let esm = path.ends_with(".mjs") || (module && !path.ends_with(".cjs"));
            if esm {
                why.push(format!(
                    "{kind} \"{path}\" is an ES module, which is not supported"
                ));
                continue;
            }
            match code_of(files, path) {
                Ok(found) => {
                    runtime = Some((found, kind));
                    break;
                }
                Err(e) => why.push(format!("{kind}: {e}")),
            }
        }
        match &runtime {
            Some((path, kind)) => report.supported.insert(
                0,
                format!(
                    "Its code ({kind}: {}) runs in Yavin's extension sandbox through the VS Code compatibility layer; VS Code APIs Yavin does not provide fail with an error naming them",
                    path.trim_start_matches("extension/")
                ),
            ),
            None => report.ignored.insert(
                0,
                format!("Its code does not run: {}.", why.join("; ")),
            ),
        }
    }
    let mapped = runtime
        .as_ref()
        .map(|_| map_code(&id, &manifest, contributes, &nls, &mut report));
    if runtime.is_none() {
        for key in CODE_POINTS {
            if contributes.contains_key(key) {
                report
                    .ignored
                    .push(format!("{key}: needs its code, which does not run"));
            }
        }
    }
    for key in ["extensionDependencies", "extensionPack"] {
        if manifest
            .get(key)
            .and_then(Value::as_array)
            .is_some_and(|list| !list.is_empty())
        {
            report.ignored.push(format!(
                "{key}: other VS Code extensions are not installed with it."
            ));
        }
    }
    if themes.is_empty()
        && icon_themes.is_empty()
        && snippets.is_empty()
        && languages.is_empty()
        && grammars.is_empty()
        && runtime.is_none()
    {
        let why = report
            .rejected
            .first()
            .or(report.ignored.first())
            .cloned()
            .unwrap_or_else(|| "it contributes nothing Yavin supports".into());
        return Err(format!(
            "UnsupportedPackage: {id} {version} has nothing Yavin can use from a VS Code extension (code it can run, colour themes, snippets, languages, grammars, file icon themes): {why}"
        ));
    }

    let (yavin_publisher, yavin_name) = id.split_once('.').ok_or("InvalidPackage")?;
    let mut contributions = Map::new();
    for (key, list) in [
        ("themes", themes),
        ("iconThemes", icon_themes),
        ("snippets", snippets),
        ("languages", languages),
        ("grammars", grammars),
    ] {
        if !list.is_empty() {
            contributions.insert(key.into(), Value::Array(list));
        }
    }
    let mut vsix = json!({
        "publisher": one_line(Some(&json!(publisher)), 100),
        "name": one_line(Some(&json!(name)), 100),
        "vscode": one_line(manifest.get("engines").and_then(|e| e.get("vscode")), 100),
        "code": has_code,
        "supported": report.supported,
        "ignored": report.ignored,
        "rejected": report.rejected,
        // Fixed: the manifest makes no signature claim; the inventory records what was
        // found (EXT-09, `package_trust.rs`). Kept so installed copies still read.
        "signature": "not verified",
    });
    let display = text_of(manifest.get("displayName"), &nls, 100)
        .unwrap_or_else(|| name.chars().take(100).collect());
    let mut generated = json!({
        "manifestVersion": 1,
        "publisher": yavin_publisher,
        "name": yavin_name,
        "version": version,
        "displayName": display,
        "description": text_of(manifest.get("description"), &nls, 500),
        "engines": {"yavin": "^2.0.0"},
    });
    if let (Some((path, kind)), Some(mapped)) = (runtime, mapped) {
        contributions.extend(mapped.contributes);
        generated["main"] = json!(path);
        generated["engines"] = json!({"yavin": VSCODE_RUNTIME_API});
        generated["activationEvents"] = json!(mapped.activation);
        generated["permissions"] = json!({"version": 1, "request": REQUESTED});
        vsix["runtime"] = json!({
            "api": "vscode",
            "level": VSCODE_API_LEVEL,
            "entry": kind,
            "commands": mapped.commands,
            "settings": mapped.settings,
            "views": mapped.views,
            "defaults": mapped.defaults,
        });
    }
    generated["contributes"] = Value::Object(contributions);
    generated["vsix"] = vsix;
    let text = fitted(generated)?;
    let target = files.join(MANIFEST_FILE);
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .map_err(|e| format!("InstallFailed: {e}"))?;
    std::io::Write::write_all(&mut file, text.as_bytes())
        .map_err(|e| format!("InstallFailed: {e}"))?;
    Ok(text)
}

#[cfg(test)]
#[path = "vsix_tests.rs"]
mod tests;
