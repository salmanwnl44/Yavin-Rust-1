//! Extension discovery (IDE-07): the manifests of the extensions installed for this user.
//!
//! Extensions are found in `<app local data>/extensions/<folder>/yavin-extension.json` --
//! Yavin's own data directory, never the open project (a project's files are the project's,
//! and untrusted); the marketplace installs into it (IDE-09: `marketplace.rs`,
//! `extension_package.rs`; its `.staging` and `.previous` folders are skipped here) -- and, in
//! development builds only, in the repository's `extensions/samples`. Discovery reads
//! manifests only. An extension's code is read by `extension_host.rs` alone, when its host
//! loads it (`read_main`), from the folder discovery found.
//! Everything is bounded: the number of folders, a manifest's size, and nothing is followed
//! through a link. Validating a manifest is the renderer's (`src/services/extensions`).

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// The manifest's file name in an extension's folder (`MANIFEST_FILE` in the renderer).
pub const MANIFEST_FILE: &str = "yavin-extension.json";
/// The most extension folders read.
const MAX_EXTENSIONS: usize = 200;
/// The largest manifest read.
const MAX_MANIFEST: u64 = 64 * 1024;

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FoundExtension {
    /// Its folder, for messages and as its `extensionPath`.
    pub folder: String,
    /// The manifest's text, when it could be read.
    pub manifest: Option<String>,
    /// Why it could not be, otherwise.
    pub error: Option<String>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Discovery {
    pub root: String,
    pub extensions: Vec<FoundExtension>,
    /// Folders beyond the cap, not read.
    pub skipped: usize,
}

/// Reads the manifests under `root`. A missing root is no extensions, not an error.
pub fn discover(root: &Path) -> Discovery {
    let mut extensions = Vec::new();
    let mut skipped = 0;
    let mut folders: Vec<PathBuf> = match fs::read_dir(root) {
        Ok(entries) => entries
            .filter_map(|entry| entry.ok())
            // A link is never followed: an extension is a real folder in the extensions root.
            .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
            // `.staging`, `.previous`: the installer's, never extensions (IDE-09).
            .filter(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
            .map(|entry| entry.path())
            .collect(),
        Err(_) => Vec::new(),
    };
    folders.sort();
    for folder in folders {
        if extensions.len() >= MAX_EXTENSIONS {
            skipped += 1;
            continue;
        }
        let file = folder.join(MANIFEST_FILE);
        let found = |manifest: Option<String>, error: Option<String>| FoundExtension {
            folder: folder.to_string_lossy().into_owned(),
            manifest,
            error,
        };
        let metadata = match fs::symlink_metadata(&file) {
            Ok(metadata) => metadata,
            Err(_) => {
                extensions.push(found(None, Some(format!("It has no {MANIFEST_FILE}."))));
                continue;
            }
        };
        if !metadata.file_type().is_file() {
            extensions.push(found(
                None,
                Some(format!("Its {MANIFEST_FILE} is not a plain file.")),
            ));
            continue;
        }
        if metadata.len() > MAX_MANIFEST {
            extensions.push(found(
                None,
                Some(format!(
                    "Its {MANIFEST_FILE} is larger than {} KiB.",
                    MAX_MANIFEST / 1024
                )),
            ));
            continue;
        }
        match fs::read_to_string(&file) {
            Ok(text) => extensions.push(found(Some(text), None)),
            Err(error) => extensions.push(found(
                None,
                Some(format!("Its {MANIFEST_FILE} could not be read: {error}")),
            )),
        }
    }
    Discovery {
        root: root.to_string_lossy().into_owned(),
        extensions,
        skipped,
    }
}

/// The largest entry point read.
const MAX_MAIN: u64 = 2 * 1024 * 1024;

/// Where extensions are found: the user's installed extensions, and (development builds only)
/// the repository's samples.
pub fn roots(app: &AppHandle) -> Result<Vec<PathBuf>, String> {
    let mut roots = vec![app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Cannot find Yavin's data folder: {e}"))?
        .join("extensions")];
    if cfg!(debug_assertions) {
        roots.push(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("extensions")
                .join("samples"),
        );
    }
    Ok(roots)
}

/// The extensions found (manifests only), the user's first.
#[tauri::command(async)]
pub fn extensions_list(app: AppHandle) -> Result<Discovery, String> {
    let roots = roots(&app)?;
    // An install or update interrupted by a crash is repaired first (IDE-09).
    crate::extension_package::recover(&roots[0]);
    let mut all = discover(&roots[0]);
    for root in &roots[1..] {
        let more = discover(root);
        all.extensions.extend(more.extensions);
        all.skipped += more.skipped;
    }
    Ok(all)
}

/// `publisher.name` of a manifest's text, if it has one.
fn manifest_id(text: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    Some(format!(
        "{}.{}",
        value.get("publisher")?.as_str()?,
        value.get("name")?.as_str()?
    ))
}

/// The folder of extension `id` and its manifest's `main`, from discovery's roots.
pub fn locate(roots: &[PathBuf], id: &str) -> Result<(PathBuf, String), String> {
    for root in roots {
        for found in discover(root).extensions {
            let Some(text) = found.manifest else { continue };
            if manifest_id(&text).as_deref() != Some(id) {
                continue;
            }
            let main = serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|value| value.get("main")?.as_str().map(str::to_string))
                .ok_or_else(|| format!("UnsupportedRuntime: {id} has no code (no \"main\")."))?;
            return Ok((PathBuf::from(found.folder), main));
        }
    }
    Err(format!("UnknownExtension: {id} is not installed."))
}

/// An extension's entry point: inside its folder (no `..`, no absolute path, no link out of
/// it), a plain file, at most 2 MiB, UTF-8.
pub fn read_main(folder: &Path, main: &str) -> Result<String, String> {
    let relative = Path::new(main);
    if relative.is_absolute()
        || relative.components().any(|part| {
            !matches!(
                part,
                std::path::Component::Normal(_) | std::path::Component::CurDir
            )
        })
    {
        return Err(format!(
            "InvalidManifest: \"{main}\" is not a path inside the extension."
        ));
    }
    let base = folder
        .canonicalize()
        .map_err(|e| format!("LoadFailed: {e}"))?;
    let file = folder.join(relative);
    let metadata = fs::symlink_metadata(&file)
        .map_err(|_| format!("LoadFailed: {main} does not exist in the extension."))?;
    if !metadata.file_type().is_file() {
        return Err(format!("LoadFailed: {main} is not a plain file."));
    }
    let real = file
        .canonicalize()
        .map_err(|e| format!("LoadFailed: {e}"))?;
    if !real.starts_with(&base) {
        return Err(format!("LoadFailed: {main} is outside the extension."));
    }
    if metadata.len() > MAX_MAIN {
        return Err(format!(
            "LoadFailed: {main} is larger than {} MiB.",
            MAX_MAIN / 1024 / 1024
        ));
    }
    fs::read_to_string(&real).map_err(|e| format!("LoadFailed: {main} could not be read: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("yavin-extensions-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn manifests_are_read_from_each_folder_and_problems_are_reported_per_folder() {
        let root = temp("discover");
        fs::create_dir_all(root.join("acme.hello")).unwrap();
        fs::write(
            root.join("acme.hello").join(MANIFEST_FILE),
            r#"{"name":"hello"}"#,
        )
        .unwrap();
        fs::create_dir_all(root.join("empty")).unwrap();
        fs::create_dir_all(root.join("huge")).unwrap();
        fs::write(
            root.join("huge").join(MANIFEST_FILE),
            "x".repeat((MAX_MANIFEST + 1) as usize),
        )
        .unwrap();
        // A file at the root is not an extension.
        fs::write(root.join("stray.json"), "{}").unwrap();

        let found = discover(&root);
        assert_eq!(found.extensions.len(), 3);
        let by = |name: &str| {
            found
                .extensions
                .iter()
                .find(|one| one.folder.ends_with(name))
                .unwrap()
        };
        assert_eq!(
            by("acme.hello").manifest.as_deref(),
            Some(r#"{"name":"hello"}"#)
        );
        assert!(by("empty").error.as_ref().unwrap().contains("has no"));
        assert!(by("huge").error.as_ref().unwrap().contains("larger than"));
        assert_eq!(found.skipped, 0);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_missing_root_is_no_extensions() {
        let found = discover(&std::env::temp_dir().join("yavin-no-such-extensions-root"));
        assert!(found.extensions.is_empty());
    }

    #[test]
    fn the_number_of_folders_read_is_capped() {
        let root = temp("cap");
        for i in 0..(MAX_EXTENSIONS + 3) {
            fs::create_dir_all(root.join(format!("e{i:04}"))).unwrap();
        }
        let found = discover(&root);
        assert_eq!(found.extensions.len(), MAX_EXTENSIONS);
        assert_eq!(found.skipped, 3);
        let _ = fs::remove_dir_all(&root);
    }

    /// Discovery returns manifests; code is read only by `read_main`, and nothing here runs.
    #[test]
    fn discovery_reads_manifests_and_only_read_main_reads_code() {
        let source = include_str!("extensions.rs");
        let code = source.split("#[cfg(test)]").next().unwrap();
        assert_eq!(code.matches("fs::read_to_string(").count(), 2);
        assert!(!code.contains("Command::new"));
    }

    #[test]
    fn an_extension_is_located_by_id_and_its_main_read_only_from_inside_it() {
        let root = temp("locate");
        let folder = root.join("hello");
        fs::create_dir_all(folder.join("out")).unwrap();
        fs::write(
            folder.join(MANIFEST_FILE),
            r#"{"publisher":"acme","name":"hello","main":"out/extension.js"}"#,
        )
        .unwrap();
        fs::write(
            folder.join("out").join("extension.js"),
            "module.exports = {};",
        )
        .unwrap();
        fs::write(root.join("secret.txt"), "not yours").unwrap();

        let (found, main) = locate(std::slice::from_ref(&root), "acme.hello").unwrap();
        assert_eq!(read_main(&found, &main).unwrap(), "module.exports = {};");
        assert!(locate(std::slice::from_ref(&root), "acme.nobody")
            .unwrap_err()
            .starts_with("UnknownExtension"));
        for escape in ["../secret.txt", r"..\secret.txt", "out/../../secret.txt"] {
            assert!(
                read_main(&folder, escape)
                    .unwrap_err()
                    .starts_with("InvalidManifest"),
                "{escape}"
            );
        }
        let absolute = root.join("secret.txt");
        assert!(read_main(&folder, absolute.to_str().unwrap()).is_err());
        assert!(read_main(&folder, "missing.js")
            .unwrap_err()
            .starts_with("LoadFailed"));
        fs::write(folder.join("big.js"), "x".repeat((MAX_MAIN + 1) as usize)).unwrap();
        assert!(read_main(&folder, "big.js")
            .unwrap_err()
            .contains("larger than"));
        let _ = fs::remove_dir_all(&root);
    }
}
