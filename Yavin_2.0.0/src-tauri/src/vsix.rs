//! VS Code packages (EXT-04): the typed adapter from a VSIX's `extension/package.json` to a
//! Yavin manifest of the declarative contributions Yavin supports -- colour themes and
//! snippets -- and nothing else.
//!
//! A VSIX (verified 2026-10-18 on open-vsx.org packages) is a zip archive: `extension.vsixmanifest`,
//! `[Content_Types].xml`, and the extension under `extension/` (its `package.json`, its files).
//! It is validated and unpacked like any package (`extension_package::unpack`: names, links,
//! sizes, counts, ratios); this adapter then reads its `package.json`, never runs anything in
//! it, and writes `yavin-extension.json` beside it:
//!
//! - the id is `publisher.name`, folded to Yavin's one id rule (VS Code ids are mixed case),
//!   and must be the extension asked for; the version must be the one asked for;
//! - `contributes.themes` (JSON colour themes) and `contributes.snippets` are kept, each path
//!   resolved inside `extension/` to a plain file of at most 1 MiB, or the entry is rejected;
//! - everything else -- its code (`main`, `browser`), commands, settings, languages, TextMate
//!   grammars, icon themes, debuggers, dependencies -- is listed as not supported;
//! - the generated manifest has no `main`: no code of it can ever load.
//!
//! What was kept, ignored and rejected is recorded in the manifest's `vsix` report, shown on
//! the extension's page. A package with nothing Yavin supports is refused.

use crate::extension_package::{entry_components, version_ok};
use crate::extensions::MANIFEST_FILE;
use ide_workspace::extension_id::canonical_id;
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

/// The largest theme or snippets file a contribution may name.
pub const MAX_RESOURCE: u64 = 1024 * 1024;
/// The most themes or snippet files kept from one package.
const MAX_ENTRIES: usize = 50;
const UI_THEMES: [&str; 4] = ["vs", "vs-dark", "hc-black", "hc-light"];

/// Why each contribution point Yavin does not support is left out.
fn unsupported(key: &str) -> String {
    match key {
        "languages" => "Languages and language configuration are not supported: Yavin decides each file's language itself.".into(),
        "grammars" => "TextMate grammars are not supported: Yavin's editor has no TextMate engine.".into(),
        "iconThemes" | "productIconThemes" => format!("{key}: icon themes are not supported."),
        _ => format!("{key}: needs the VS Code extension API, which Yavin does not provide."),
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

/// `path` (from `package.json`, relative to `extension/`) as a file of the package: its path
/// in the archive (`extension/…`, `/`-separated), or why it cannot be used.
fn resource(files: &Path, path: &str) -> Result<String, String> {
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
    if meta.len() > MAX_RESOURCE {
        return Err(format!(
            "\"{path}\" is larger than {} KiB",
            MAX_RESOURCE / 1024
        ));
    }
    Ok(parts.join("/"))
}

fn language_ok(language: &str) -> bool {
    let mut chars = language.chars();
    language.len() <= 50
        && chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || "+#._-".contains(c))
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

    let mut supported = Vec::new();
    let mut ignored = Vec::new();
    let mut rejected = Vec::new();
    let mut themes = Vec::new();
    let mut snippets = Vec::new();
    let empty = Map::new();
    let contributes = manifest
        .get("contributes")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    for (key, value) in contributes {
        match key.as_str() {
            "themes" => {
                for (n, entry) in value.as_array().into_iter().flatten().enumerate() {
                    let label = one_line(entry.get("label"), 100)
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
                        ignored.push(format!("{what}: more than {MAX_ENTRIES} themes"));
                        continue;
                    }
                    if !UI_THEMES.contains(&ui) {
                        rejected.push(format!("{what}: \"{ui}\" is not a VS Code base theme"));
                        continue;
                    }
                    let lower = path.to_ascii_lowercase();
                    if lower.ends_with(".tmtheme") {
                        ignored.push(format!(
                            "{what}: \"{path}\" is a TextMate theme (.tmTheme), which is not supported"
                        ));
                        continue;
                    }
                    if !lower.ends_with(".json") {
                        rejected.push(format!("{what}: \"{path}\" is not a JSON colour theme"));
                        continue;
                    }
                    match (label, resource(files, path)) {
                        (Some(label), Ok(path)) => {
                            supported.push(format!("Colour theme \"{label}\""));
                            themes.push(json!({"label": label, "uiTheme": ui, "path": path}));
                        }
                        (None, _) => rejected.push(format!("{what}: it has no label")),
                        (_, Err(why)) => rejected.push(format!("{what}: {why}")),
                    }
                }
            }
            "snippets" => {
                for entry in value.as_array().into_iter().flatten() {
                    let language = entry.get("language").and_then(Value::as_str).unwrap_or("");
                    let path = entry.get("path").and_then(Value::as_str).unwrap_or("");
                    let what = format!("Snippets for \"{language}\"");
                    if snippets.len() >= MAX_ENTRIES {
                        ignored.push(format!("{what}: more than {MAX_ENTRIES} snippet files"));
                        continue;
                    }
                    if !language_ok(language) {
                        rejected.push(format!("{what}: not a language id"));
                        continue;
                    }
                    match resource(files, path) {
                        Ok(path) => {
                            supported.push(format!("Snippets for {language}"));
                            snippets.push(json!({"language": language, "path": path}));
                        }
                        Err(why) => rejected.push(format!("{what}: {why}")),
                    }
                }
            }
            other => ignored.push(unsupported(other)),
        }
    }
    let code = manifest.get("main").is_some() || manifest.get("browser").is_some();
    if code {
        ignored.insert(
            0,
            "Its code (main, browser) does not run: Yavin runs no VS Code extension code, so its commands and features are not available.".into(),
        );
    }
    for key in ["extensionDependencies", "extensionPack"] {
        if manifest
            .get(key)
            .and_then(Value::as_array)
            .is_some_and(|list| !list.is_empty())
        {
            ignored.push(format!(
                "{key}: other VS Code extensions are not installed with it."
            ));
        }
    }
    if themes.is_empty() && snippets.is_empty() {
        let why = rejected
            .first()
            .or(ignored.first())
            .cloned()
            .unwrap_or_else(|| "it contributes no colour themes or snippets".into());
        return Err(format!(
            "UnsupportedPackage: {id} {version} has nothing Yavin can use from a VS Code extension (colour themes, snippets): {why}"
        ));
    }

    let (yavin_publisher, yavin_name) = id.split_once('.').ok_or("InvalidPackage")?;
    let mut contributions = Map::new();
    if !themes.is_empty() {
        contributions.insert("themes".into(), Value::Array(themes));
    }
    if !snippets.is_empty() {
        contributions.insert("snippets".into(), Value::Array(snippets));
    }
    let generated = json!({
        "manifestVersion": 1,
        "publisher": yavin_publisher,
        "name": yavin_name,
        "version": version,
        "displayName": one_line(manifest.get("displayName"), 100).unwrap_or_else(|| name.chars().take(100).collect()),
        "description": one_line(manifest.get("description"), 500),
        "engines": {"yavin": "^2.0.0"},
        "contributes": contributions,
        "vsix": {
            "publisher": one_line(Some(&json!(publisher)), 100),
            "name": one_line(Some(&json!(name)), 100),
            "vscode": one_line(manifest.get("engines").and_then(|e| e.get("vscode")), 100),
            "code": code,
            "supported": supported,
            "ignored": ignored,
            "rejected": rejected,
            "signature": "not verified",
        },
    });
    let text =
        serde_json::to_string_pretty(&generated).map_err(|e| format!("InstallFailed: {e}"))?;
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
