//! Extension discovery (IDE-07): reading the manifests in an extensions folder.
//!
//! Which folders those are, and which copy of an extension is used, is the inventory's
//! (`extension_service.rs`, EXT-02): Yavin's own `<app local data>/extensions` -- never the open
//! project (a project's files are the project's, and untrusted) -- and, in development builds
//! only, the repository's `extensions/samples`. Discovery reads manifests only; Yavin's own
//! folders (`.store`, `.staging`, any dot-folder) are skipped. An extension's code is read by
//! `extension_host.rs` alone, when its host loads it (`read_main`), from the folder the
//! inventory chose. Everything is bounded: the number of folders, a manifest's size, and
//! nothing is followed through a link. Validating a manifest is the renderer's
//! (`src/services/extensions`).

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

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
            // `.store`, `.staging`: the inventory's, never extensions (EXT-02).
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
        let (manifest, error) = match read_manifest(&folder) {
            Ok(text) => (Some(text), None),
            Err(why) => (None, Some(why)),
        };
        extensions.push(FoundExtension {
            folder: folder.to_string_lossy().into_owned(),
            manifest,
            error,
        });
    }
    Discovery {
        root: root.to_string_lossy().into_owned(),
        extensions,
        skipped,
    }
}

/// The manifest in `folder`: a plain file (not a link), at most 64 KiB.
pub fn read_manifest(folder: &Path) -> Result<String, String> {
    let file = folder.join(MANIFEST_FILE);
    let metadata =
        fs::symlink_metadata(&file).map_err(|_| format!("It has no {MANIFEST_FILE}."))?;
    if !metadata.file_type().is_file() {
        return Err(format!("Its {MANIFEST_FILE} is not a plain file."));
    }
    if metadata.len() > MAX_MANIFEST {
        return Err(format!(
            "Its {MANIFEST_FILE} is larger than {} KiB.",
            MAX_MANIFEST / 1024
        ));
    }
    fs::read_to_string(&file)
        .map_err(|error| format!("Its {MANIFEST_FILE} could not be read: {error}"))
}

/// The largest entry point read.
const MAX_MAIN: u64 = 2 * 1024 * 1024;

/// An extension's entry point: inside its folder (no `..`, no absolute path, no link out of
/// it), a plain file, at most 2 MiB, UTF-8.
pub fn read_main(folder: &Path, main: &str) -> Result<String, String> {
    read_inside(folder, main, MAX_MAIN)
}

/// The largest file of an extension's own read for the window (a theme, snippets: EXT-04).
const MAX_RESOURCE: u64 = 1024 * 1024;

/// One of an extension's files, as `read_main` reads its entry point, at most 1 MiB.
pub fn read_resource(folder: &Path, path: &str) -> Result<String, String> {
    read_inside(folder, path, MAX_RESOURCE)
}

fn read_inside(folder: &Path, main: &str, max: u64) -> Result<String, String> {
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
    if metadata.len() > max {
        return Err(format!(
            "LoadFailed: {main} is larger than {} KiB.",
            max / 1024
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
    fn an_extensions_main_is_read_only_from_inside_its_folder() {
        let root = temp("locate");
        let folder = root.join("hello");
        fs::create_dir_all(folder.join("out")).unwrap();
        fs::write(
            folder.join("out").join("extension.js"),
            "module.exports = {};",
        )
        .unwrap();
        fs::write(root.join("secret.txt"), "not yours").unwrap();

        assert_eq!(
            read_main(&folder, "out/extension.js").unwrap(),
            "module.exports = {};"
        );
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
