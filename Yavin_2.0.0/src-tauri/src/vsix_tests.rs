//! EXT-04: VS Code packages -- format detection, the adapter, and installing one through the
//! inventory. Every package is built here; nothing touches the network.

use super::*;
use crate::extension_package::tests::{package, temp};
use crate::extension_package::{unpack, Format, LIMITS};
use crate::extension_service::{ExtensionService, Inventory, INVENTORY};
use crate::marketplace::{stage, PackageSource};
use std::time::Duration;

const THEME: &str = r##"{ // VS Code theme files are JSONC
  "colors": { "editor.background": "#282a36" },
  "tokenColors": [{ "scope": "comment", "settings": { "foreground": "#6272A4" } }],
}"##;
const SNIPPETS: &str = r#"{ "Log": { "prefix": "log", "body": ["console.log($1);"] } }"#;

fn package_json(contributes: Value, extra: Value) -> String {
    let mut manifest = json!({
        "publisher": "Dracula-Theme",
        "name": "theme-dracula",
        "version": "2.25.1",
        "displayName": "Dracula\nTheme",
        "engines": {"vscode": "^1.13.0"},
        "contributes": contributes,
    });
    if let Value::Object(more) = extra {
        manifest.as_object_mut().unwrap().extend(more);
    }
    manifest.to_string()
}

fn themed() -> String {
    package_json(
        json!({
            "themes": [{"label": "Dracula", "uiTheme": "vs-dark", "path": "./theme/dracula.json"}],
            "snippets": [{"language": "javascript", "path": "./snippets/js.json"}],
            "commands": [{"command": "dracula.hello", "title": "Hello"}],
            "grammars": [{"language": "x", "path": "./x.tmLanguage.json"}],
            "languages": [{"id": "x", "extensions": [".x"]}],
        }),
        json!({"main": "./out/extension.js", "activationEvents": ["*"], "extensionDependencies": ["a.b"]}),
    )
}

/// A VSIX of `entries` (beside its `extension.vsixmanifest` and content types).
fn vsix(dir: &Path, package: &str, entries: &[(&str, &[u8])]) -> PathBuf {
    let mut all: Vec<(&str, &[u8])> = vec![
        ("extension.vsixmanifest", b"<PackageManifest/>"),
        ("[Content_Types].xml", b"<Types/>"),
        ("extension/package.json", package.as_bytes()),
    ];
    all.extend_from_slice(entries);
    fs::create_dir_all(dir).unwrap();
    package_at(dir, &all)
}

fn package_at(dir: &Path, entries: &[(&str, &[u8])]) -> PathBuf {
    package(dir, entries)
}

fn unpacked(dir: &Path, archive: &Path) -> (PathBuf, crate::extension_package::Unpacked) {
    let out = dir.join("out");
    let _ = fs::remove_dir_all(&out);
    let result = unpack(archive, &out, &LIMITS).unwrap();
    (out, result)
}

#[test]
fn a_vsix_is_recognised_by_its_contents_and_never_taken_for_a_yavin_package() {
    let dir = temp("vsix-format");
    let pkg = vsix(&dir.join("a"), &themed(), &[]);
    let (_, found) = unpacked(&dir, &pkg);
    assert_eq!(found.format, Format::Vsix);
    assert!(found.manifest.contains("theme-dracula"));
    // Both kinds' marks: refused, whichever was meant.
    let both = vsix(
        &dir.join("b"),
        &themed(),
        &[(
            MANIFEST_FILE,
            br#"{"publisher":"a","name":"b","version":"1.0.0"}"#,
        )],
    );
    let error = unpack(&both, &dir.join("o2"), &LIMITS).unwrap_err();
    assert!(error.contains("both a Yavin package"), "{error}");
    // A VSIX without its package.json.
    let at = dir.join("c");
    fs::create_dir_all(&at).unwrap();
    let bare = package(&at, &[("extension.vsixmanifest", b"<x/>")]);
    assert!(unpack(&bare, &dir.join("o3"), &LIMITS)
        .unwrap_err()
        .contains("without extension/package.json"));
    // Windows names and traversal inside a VSIX are refused before anything is written.
    for bad in [
        "extension/CON.json",
        "extension/../../evil.js",
        "extension/a:stream",
        "extension/trailing. ",
    ] {
        let at = dir.join(format!("bad{}", bad.len()));
        let archive = vsix(&at, &themed(), &[(bad, b"x")]);
        let out = at.join("out");
        assert!(
            unpack(&archive, &out, &LIMITS)
                .unwrap_err()
                .starts_with("UnsafePackage"),
            "{bad}"
        );
        assert!(!out.exists());
    }
    // Limits hold for VS Code packages too: too many entries, a compression bomb.
    let many: Vec<(String, Vec<u8>)> = (0..LIMITS.entries)
        .map(|i| (format!("extension/f{i}.txt"), vec![b'x']))
        .collect();
    let refs: Vec<(&str, &[u8])> = many
        .iter()
        .map(|(n, b)| (n.as_str(), b.as_slice()))
        .collect();
    let crowded = vsix(&dir.join("many"), &themed(), &refs);
    assert!(unpack(&crowded, &dir.join("o4"), &LIMITS)
        .unwrap_err()
        .contains("entries"));
    let zeros = vec![0u8; 3 * 1024 * 1024];
    let bomb = vsix(
        &dir.join("bomb"),
        &themed(),
        &[("extension/bomb.json", &zeros)],
    );
    assert!(unpack(&bomb, &dir.join("o5"), &LIMITS)
        .unwrap_err()
        .contains("compressed more than"));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn the_adapter_keeps_themes_and_snippets_and_reports_everything_else() {
    let dir = temp("vsix-adapt");
    let pkg = vsix(
        &dir.join("p"),
        &themed(),
        &[
            ("extension/theme/dracula.json", THEME.as_bytes()),
            ("extension/snippets/js.json", SNIPPETS.as_bytes()),
            (
                "extension/out/extension.js",
                b"require('fs').writeFileSync('ran', '1');",
            ),
        ],
    );
    let (out, found) = unpacked(&dir, &pkg);
    let text = adapt(
        &out,
        &found.manifest,
        "dracula-theme.theme-dracula",
        "2.25.1",
    )
    .unwrap();
    let generated: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(fs::read_to_string(out.join(MANIFEST_FILE)).unwrap(), text);
    // Yavin's own id rule, the published spelling kept beside it.
    assert_eq!(generated["publisher"], "dracula-theme");
    assert_eq!(generated["vsix"]["publisher"], "Dracula-Theme");
    assert_eq!(generated["displayName"], "Dracula Theme", "one line");
    // EXT-25: its code is the manifest's entry point, run by the compatibility layer -- never
    // here: adapting it runs nothing.
    assert_eq!(generated["main"], "extension/out/extension.js");
    assert_eq!(generated["engines"]["yavin"], VSCODE_RUNTIME_API);
    let mapped = format!("dracula-theme.theme-dracula.{}", part("dracula.hello"));
    assert_eq!(
        generated["contributes"]["commands"][0]["command"],
        json!(mapped)
    );
    assert_eq!(
        generated["activationEvents"],
        json!(["*", format!("onCommand:{mapped}")])
    );
    let runtime = &generated["vsix"]["runtime"];
    assert_eq!(runtime["api"], "vscode");
    assert_eq!(runtime["entry"], "main");
    assert_eq!(runtime["commands"][&mapped], "dracula.hello");
    // It asks; the user grants (EXT-07). Nothing is granted by being a VS Code extension.
    assert_eq!(
        generated["permissions"]["request"],
        json!([
            "documents.edit",
            "documents.read",
            "editor.control",
            "secrets",
            "workspace.fs.read"
        ])
    );
    assert_eq!(
        generated["contributes"]["themes"][0]["path"],
        "extension/theme/dracula.json"
    );
    assert_eq!(
        generated["contributes"]["snippets"][0]["language"],
        "javascript"
    );
    assert_eq!(
        generated["contributes"]["languages"][0],
        json!({"id": "x", "extensions": [".x"], "filenames": [], "aliases": []})
    );
    assert_eq!(
        generated["contributes"]
            .as_object()
            .unwrap()
            .keys()
            .collect::<Vec<_>>(),
        ["commands", "languages", "snippets", "themes"]
    );
    let report = &generated["vsix"];
    assert_eq!(report["code"], true);
    assert_eq!(report["signature"], "not verified");
    let supported = report["supported"].to_string();
    assert!(supported.contains("compatibility layer"), "{supported}");
    // Its grammar has no scope name: refused, and said.
    assert!(
        report["rejected"].to_string().contains("not a scope name"),
        "{report}"
    );
    assert!(
        report["ignored"]
            .to_string()
            .contains("extensionDependencies"),
        "{report}"
    );
    assert!(
        !dir.join("ran").exists() && !out.join("ran").exists(),
        "nothing ran"
    );
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn every_referenced_file_must_be_a_plain_file_inside_the_package() {
    let dir = temp("vsix-paths");
    let cases = [
        ("../../outside.json", "leaves"),
        ("/etc/passwd.json", "empty path component"),
        ("C:/Windows/x.json", "contains"),
        ("theme\\x.json", "backslash"),
        ("./missing.json", "not in the package"),
        ("./dir.json", "not a file"),
        ("./theme/notes.txt", "not a JSON colour theme"),
        ("./big.json", "larger than"),
    ];
    for (n, (path, why)) in cases.iter().enumerate() {
        let manifest = package_json(
            json!({
                "themes": [
                    {"label": "Bad", "uiTheme": "vs-dark", "path": path},
                    {"label": "Good", "uiTheme": "vs", "path": "./theme/ok.json"},
                ],
            }),
            json!({}),
        );
        // Incompressible, so the archive's ratio limit lets it through to the size check.
        let mut seed = 0x2545_f491_u32;
        let big: Vec<u8> = (0..=MAX_RESOURCE)
            .map(|_| {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                (seed & 0xff) as u8
            })
            .collect();
        let pkg = vsix(
            &dir.join(format!("p{n}")),
            &manifest,
            &[
                ("extension/theme/ok.json", THEME.as_bytes()),
                ("extension/big.json", &big),
                ("extension/dir.json/inside.txt", b"x"),
            ],
        );
        let (out, found) = unpacked(&dir.join(format!("p{n}")), &pkg);
        let generated: Value = serde_json::from_str(
            &adapt(
                &out,
                &found.manifest,
                "dracula-theme.theme-dracula",
                "2.25.1",
            )
            .unwrap(),
        )
        .unwrap();
        let rejected = generated["vsix"]["rejected"].to_string();
        assert!(rejected.contains(why), "{path}: {rejected}");
        assert_eq!(
            generated["contributes"]["themes"].as_array().unwrap().len(),
            1,
            "{path}"
        );
    }
    // Other refusals: a base theme VS Code does not have, a TextMate theme, a bad language.
    let manifest = package_json(
        json!({
            "themes": [
                {"label": "Odd", "uiTheme": "solarized", "path": "./theme/ok.json"},
                {"label": "Old", "uiTheme": "vs", "path": "./theme/old.tmTheme"},
                {"label": "Ok", "uiTheme": "hc-black", "path": "./theme/ok.json"},
            ],
            "snippets": [{"language": "../js", "path": "./theme/ok.json"}],
        }),
        json!({}),
    );
    let pkg = vsix(
        &dir.join("other"),
        &manifest,
        &[("extension/theme/ok.json", THEME.as_bytes())],
    );
    let (out, found) = unpacked(&dir.join("other"), &pkg);
    let generated: Value = serde_json::from_str(
        &adapt(
            &out,
            &found.manifest,
            "dracula-theme.theme-dracula",
            "2.25.1",
        )
        .unwrap(),
    )
    .unwrap();
    let report = generated["vsix"].to_string();
    for why in [
        "not a VS Code base theme",
        "TextMate theme (.tmTheme)",
        "not a language id",
    ] {
        assert!(report.contains(why), "{why}: {report}");
    }
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn identity_version_and_usefulness_are_checked() {
    let dir = temp("vsix-identity");
    let adapt_with = |name: &str, manifest: String, id: &str, version: &str| {
        let pkg = vsix(
            &dir.join(name),
            &manifest,
            &[("extension/theme/dracula.json", THEME.as_bytes())],
        );
        let (out, found) = unpacked(&dir.join(name), &pkg);
        adapt(&out, &found.manifest, id, version)
    };
    let theme =
        json!({"themes": [{"label": "D", "uiTheme": "vs-dark", "path": "./theme/dracula.json"}]});
    let ok = package_json(theme.clone(), json!({}));
    assert!(adapt_with("other-id", ok.clone(), "acme.other", "2.25.1")
        .unwrap_err()
        .starts_with("ManifestMismatch"));
    assert!(
        adapt_with("other-version", ok, "dracula-theme.theme-dracula", "9.0.0")
            .unwrap_err()
            .starts_with("ManifestMismatch")
    );
    let bad_name = package_json(theme.clone(), json!({"name": "theme_dracula"}));
    assert!(adapt_with("bad-name", bad_name, "x.y", "2.25.1")
        .unwrap_err()
        .starts_with("InvalidPackage"));
    let bad_version = package_json(theme, json!({"version": "v2"}));
    assert!(adapt_with(
        "bad-version",
        bad_version,
        "dracula-theme.theme-dracula",
        "v2"
    )
    .unwrap_err()
    .starts_with("InvalidPackage"));
    assert!(adapt_with("not-json", "{".into(), "a.b", "1.0.0")
        .unwrap_err()
        .starts_with("InvalidPackage"));
    // Only code, commands and grammars: nothing Yavin can use, so not installed at all.
    let code_only = package_json(
        json!({"commands": [{"command": "x", "title": "x"}]}),
        json!({"main": "./out/x.js"}),
    );
    let error = adapt_with(
        "code-only",
        code_only,
        "dracula-theme.theme-dracula",
        "2.25.1",
    )
    .unwrap_err();
    assert!(
        error.starts_with("UnsupportedPackage") && error.contains("colour themes, snippets"),
        "{error}"
    );
    let _ = fs::remove_dir_all(&dir);
}

fn inventory(root: &Path) -> Inventory {
    serde_json::from_str(&fs::read_to_string(root.join(INVENTORY)).unwrap()).unwrap()
}

#[test]
fn a_vsix_installs_through_the_inventory_and_its_files_are_read_only_from_its_copy() {
    let dir = temp("vsix-install");
    let root = dir.join("extensions");
    let service = ExtensionService::new(root.clone(), Vec::new());
    *service.abandoned_after.lock().unwrap() = Some(Duration::ZERO);
    let file = |version: &str| {
        let manifest = package_json(
            json!({"themes": [{"label": "Dracula", "uiTheme": "vs-dark", "path": "./theme/dracula.json"}]}),
            json!({"version": version}),
        );
        let pkg = vsix(
            &dir.join(format!("v{version}")),
            &manifest,
            &[("extension/theme/dracula.json", THEME.as_bytes())],
        );
        PackageSource::File {
            path: pkg.to_string_lossy().into(),
        }
    };
    let id = "dracula-theme.theme-dracula";
    let staged = stage(&service, file("2.25.1"), id, "2.25.1").unwrap();
    assert!(
        staged.manifest.contains("\"vsix\""),
        "the staged manifest is the generated one"
    );
    service.commit(&staged.token, id).unwrap();
    service.finish(&staged.token, id, true).unwrap();
    let record = inventory(&root).extensions[id].clone();
    assert_eq!(record.active.source, "file");
    // The window reads its theme from the inventory's copy; nothing outside it.
    assert_eq!(
        service
            .resource_of(id, "extension/theme/dracula.json")
            .unwrap(),
        THEME
    );
    assert_eq!(
        service
            .resource_of(
                "Dracula-Theme.Theme-Dracula",
                "extension/theme/dracula.json"
            )
            .unwrap(),
        THEME
    );
    for escape in [
        "../inventory.json",
        "../../x",
        "extension/../../inventory.json",
    ] {
        assert!(service.resource_of(id, escape).is_err(), "{escape}");
    }
    assert!(service
        .resource_of("acme.nobody", "x")
        .unwrap_err()
        .starts_with("UnknownExtension"));
    // An update that is not registered rolls back to the copy before it.
    let staged = stage(&service, file("2.26.0"), id, "2.26.0").unwrap();
    service.commit(&staged.token, id).unwrap();
    service.finish(&staged.token, id, false).unwrap();
    assert_eq!(inventory(&root).extensions[id], record);
    // Uninstall removes it, and its files with it.
    service.uninstall(id).unwrap();
    assert!(service
        .resource_of(id, "extension/theme/dracula.json")
        .is_err());
    assert!(inventory(&root).extensions.is_empty());
    let _ = fs::remove_dir_all(&dir);
}

/// EXT-25: what a VS Code extension's code needs is mapped to Yavin's own -- under ids it owns,
/// in the forms Yavin's manifest accepts -- and what has no Yavin equivalent is said.
#[test]
fn code_contributions_are_mapped_to_yavin_ids_or_reported() {
    let dir = temp("vsix-code");
    let grammar = br#"{"scopeName": "source.x", "patterns": []}"#;
    let manifest = package_json(
        json!({
            "commands": [
                {"command": "x.sort", "title": "%sort.title%", "category": "X"},
                {"command": "x.Upper Case!", "title": {"value": "Upper", "original": "Upper"}},
            ],
            "keybindings": [
                {"command": "x.sort", "key": "ctrl+alt+s"},
                {"command": "x.sort", "key": "ctrl+k ctrl+s"},
                {"command": "x.sort", "key": "s"},
                {"command": "x.sort", "key": "cmd+s"},
                {"command": "x.sort", "key": "ctrl+shift+u", "when": "editorLangId == markdown"},
            ],
            "configuration": {"properties": {
                "x.enabled": {"type": "boolean", "default": true, "description": "On"},
                "x.mode": {"type": "string", "enum": ["a", "b"], "default": "b", "markdownDescription": "The *mode*"},
                "x.size": {"type": "integer", "minimum": 1, "maximum": 9, "default": 4},
                "x.list": {"type": "array", "default": ["q"]},
            }},
            "viewsContainers": {"activitybar": [{"id": "xBar", "title": "X Bar", "icon": "i.svg"}]},
            "views": {
                "xBar": [{"id": "x.tree", "name": "Tree"}, {"id": "x.web", "name": "Web", "type": "webview"}],
                "explorer": [{"id": "x.files", "name": "Files"}],
            },
            "menus": {
                "editor/context": [
                    {"command": "x.sort", "when": "editorLangId == markdown"},
                    {"command": "x.sort", "when": "editorHasSelection"},
                ],
                "view/title": [{"command": "x.sort", "when": "view == x.tree"}],
                "commandPalette": [{"command": "x.Upper Case!", "when": "false"}],
                "scm/title": [{"command": "x.sort"}],
            },
            "grammars": [
                {"language": "x", "scopeName": "source.x", "path": "./syntaxes/x.tmLanguage.json"},
                {"scopeName": "inject.x", "path": "./syntaxes/x.tmLanguage.json", "injectTo": ["source.js"]},
            ],
            "debuggers": [{"type": "x"}],
        }),
        json!({"main": "./out/node.js", "browser": "./dist/web", "activationEvents": ["onLanguage:x", "workspaceContains:**/x.json", "onUri"]}),
    );
    let pkg = vsix(
        &dir.join("p"),
        &manifest,
        &[
            (
                "extension/package.nls.json",
                br#"{"sort.title": "Sort Lines"}"#,
            ),
            ("extension/out/node.js", b"exports.activate = () => {};"),
            ("extension/dist/web.js", b"exports.activate = () => {};"),
            ("extension/syntaxes/x.tmLanguage.json", grammar),
        ],
    );
    let (out, found) = unpacked(&dir.join("p"), &pkg);
    let generated: Value = serde_json::from_str(
        &adapt(
            &out,
            &found.manifest,
            "dracula-theme.theme-dracula",
            "2.25.1",
        )
        .unwrap(),
    )
    .unwrap();
    let id = |original: &str| format!("dracula-theme.theme-dracula.{}", part(original));
    // The web entry point (written for a runtime without Node.js) comes first.
    assert_eq!(generated["main"], "extension/dist/web.js");
    assert_eq!(generated["vsix"]["runtime"]["entry"], "browser");
    let c = &generated["contributes"];
    assert_eq!(
        c["commands"][0],
        json!({"command": id("x.sort"), "title": "Sort Lines", "category": "X"})
    );
    assert_eq!(c["commands"][1]["title"], "Upper");
    assert!(
        part("x.Upper Case!").starts_with("x-upper-case-"),
        "{}",
        part("x.Upper Case!")
    );
    assert_ne!(part("a.b"), part("a-b"), "distinct ids stay distinct");
    assert_eq!(
        c["keybindings"],
        json!([{"command": id("x.sort"), "key": "Mod+Alt+s"}])
    );
    let settings = c["configuration"]["properties"].as_object().unwrap();
    assert_eq!(settings.len(), 3);
    assert_eq!(settings[&id("x.mode")]["enum"], json!(["a", "b"]));
    assert_eq!(settings[&id("x.mode")]["description"], "The *mode*");
    assert_eq!(settings[&id("x.size")]["maximum"], 9.0);
    assert_eq!(
        generated["vsix"]["runtime"]["defaults"]["x.list"],
        json!(["q"])
    );
    assert_eq!(
        generated["vsix"]["runtime"]["settings"][&id("x.enabled")],
        "x.enabled"
    );
    assert_eq!(
        c["viewsContainers"]["activitybar"][0]["id"],
        json!(id("xBar"))
    );
    assert_eq!(
        c["views"].as_array().unwrap().len(),
        2,
        "the webview view is left out"
    );
    let tree = c["views"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == json!(id("x.tree")))
        .unwrap();
    assert_eq!(tree["container"], json!(id("xBar")));
    assert_eq!(
        c["menus"]["editor/context"],
        json!([{"command": id("x.sort"), "when": "resourceLangId == markdown"}])
    );
    assert_eq!(c["menus"]["view/title"][0]["view"], json!(id("x.tree")));
    assert_eq!(c["menus"]["commandPalette"][0]["when"], "false");
    assert!(c["menus"].get("scm/title").is_none());
    assert_eq!(
        c["grammars"],
        json!([{"scopeName": "source.x", "path": "extension/syntaxes/x.tmLanguage.json", "language": "x"}])
    );
    let events = generated["activationEvents"].to_string();
    for event in [
        "onLanguage:x",
        "onWorkspace",
        &format!("onCommand:{}", id("x.sort")),
        &format!("onView:{}", id("x.tree")),
    ] {
        assert!(events.contains(event), "{event}: {events}");
    }
    let ignored = generated["vsix"]["ignored"].to_string();
    for said in [
        "injection grammars",
        "debuggers",
        "webview views",
        "keybindings",
        "menu items",
        "onUri",
        "workspaceContains",
        "lists, objects",
    ] {
        assert!(ignored.contains(said), "{said}: {ignored}");
    }
    // An ES module does not run; the package still installs for what else it has.
    let esm = package_json(
        json!({"grammars": [{"language": "x", "scopeName": "source.x", "path": "./g.json"}]}),
        json!({"main": "./out/a.js", "type": "module"}),
    );
    let pkg = vsix(
        &dir.join("esm"),
        &esm,
        &[
            ("extension/out/a.js", b"export {}"),
            ("extension/g.json", grammar),
        ],
    );
    let (out, found) = unpacked(&dir.join("esm"), &pkg);
    let generated: Value = serde_json::from_str(
        &adapt(
            &out,
            &found.manifest,
            "dracula-theme.theme-dracula",
            "2.25.1",
        )
        .unwrap(),
    )
    .unwrap();
    assert!(generated.get("main").is_none());
    assert!(generated["vsix"]["ignored"]
        .to_string()
        .contains("ES module"));
    let _ = fs::remove_dir_all(&dir);
}

// --- EXT-30: file icon themes ------------------------------------------------------------------

#[test]
fn file_icon_themes_are_kept_with_their_file_and_checked() {
    let dir = temp("vsix-icon-themes");
    let theme = br#"{"iconDefinitions":{"f":{"iconPath":"./../icons/f.svg"}},"file":"f"}"#;
    let manifest = |icon_themes: Value| {
        package_json(
            json!({
                "iconThemes": icon_themes,
                "productIconThemes": [{"id": "p", "label": "P", "path": "./p.json"}],
            }),
            json!({}),
        )
    };
    let adapted = |name: &str, icon_themes: Value| {
        let pkg = vsix(
            &dir.join(name),
            &manifest(icon_themes),
            &[
                ("extension/dist/icons.json", theme),
                ("extension/icons/f.svg", b"<svg/>"),
                ("extension/dist/icons.svg", b"<svg/>"),
            ],
        );
        let (out, found) = unpacked(&dir.join(name), &pkg);
        adapt(
            &out,
            &found.manifest,
            "dracula-theme.theme-dracula",
            "2.25.1",
        )
    };
    // Material Icon Theme's contribution, as published (its `_watch` is VS Code's own).
    let text = adapted(
        "ok",
        json!([{"id": "material-icon-theme", "label": "Material Icon Theme", "path": "./dist/icons.json", "_watch": true}]),
    )
    .unwrap();
    let generated: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(
        generated["contributes"]["iconThemes"],
        json!([{"id": "material-icon-theme", "label": "Material Icon Theme", "path": "extension/dist/icons.json"}])
    );
    let supported = generated["vsix"]["supported"].to_string();
    assert!(
        supported.contains("File icon theme \\\"Material Icon Theme\\\""),
        "{supported}"
    );
    let ignored = generated["vsix"]["ignored"].to_string();
    assert!(
        ignored.contains("productIconThemes: product icon themes"),
        "{ignored}"
    );
    assert!(!ignored.contains("iconThemes: icon themes are not supported"));

    // Refused one by one, said why: the rest of the package still adapts if it has anything.
    for (name, entry, why) in [
        (
            "bad-id",
            json!({"id": "a b", "label": "A", "path": "./dist/icons.json"}),
            "is not an icon theme id",
        ),
        (
            "not-json",
            json!({"id": "a", "label": "A", "path": "./dist/icons.svg"}),
            "is not a JSON icon theme",
        ),
        (
            "missing",
            json!({"id": "a", "label": "A", "path": "./dist/gone.json"}),
            "is not in the package",
        ),
        (
            "escape",
            json!({"id": "a", "label": "A", "path": "../../outside.json"}),
            "leaves the extension",
        ),
        (
            "no-label",
            json!({"id": "", "label": "", "path": "./dist/icons.json"}),
            "is not an icon theme id",
        ),
    ] {
        let error = adapted(name, json!([entry])).unwrap_err();
        // Nothing else in it is usable: the refusal names the icon theme's reason.
        assert!(
            error.starts_with("UnsupportedPackage")
                && error.contains("file icon themes")
                && error.contains(why),
            "{name}: {error}"
        );
    }
    // At most 50 kept from one package.
    let many: Vec<Value> = (0..55)
        .map(|i| json!({"id": format!("t{i}"), "label": format!("T{i}"), "path": "./dist/icons.json"}))
        .collect();
    let generated: Value = serde_json::from_str(&adapted("many", json!(many)).unwrap()).unwrap();
    assert_eq!(
        generated["contributes"]["iconThemes"]
            .as_array()
            .unwrap()
            .len(),
        50
    );
    assert!(generated["vsix"]["ignored"]
        .to_string()
        .contains("more than 50 icon themes"));
    let _ = fs::remove_dir_all(&dir);
}
