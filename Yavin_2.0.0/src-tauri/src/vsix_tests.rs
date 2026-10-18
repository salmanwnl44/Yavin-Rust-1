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
    // No code: nothing of it can ever be loaded.
    assert!(generated.get("main").is_none());
    assert!(generated.get("activationEvents").is_none());
    assert_eq!(
        generated["contributes"]["themes"][0]["path"],
        "extension/theme/dracula.json"
    );
    assert_eq!(
        generated["contributes"]["snippets"][0]["language"],
        "javascript"
    );
    assert_eq!(
        generated["contributes"]
            .as_object()
            .unwrap()
            .keys()
            .collect::<Vec<_>>(),
        ["snippets", "themes"]
    );
    let report = &generated["vsix"];
    assert_eq!(report["code"], true);
    assert_eq!(report["signature"], "not verified");
    let ignored = report["ignored"].to_string();
    for expected in [
        "does not run",
        "commands",
        "TextMate grammars",
        "Languages",
        "extensionDependencies",
    ] {
        assert!(ignored.contains(expected), "{expected}: {ignored}");
    }
    assert_eq!(report["supported"].as_array().unwrap().len(), 2);
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
