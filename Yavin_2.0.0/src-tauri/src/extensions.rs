//! Extension discovery (IDE-07): the manifests of the extensions installed for this user.
//!
//! There is exactly one place extensions are found: `<app local data>/extensions/<folder>/`
//! `yavin-extension.json` -- Yavin's own data directory, never the open project (a project's
//! files are the project's, and untrusted) and never the network (there is no marketplace,
//! download or update). Only the manifest is read; no code is read, loaded or run from here.
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

/// The extensions installed for this user (manifests only).
#[tauri::command(async)]
pub fn extensions_list(app: AppHandle) -> Result<Discovery, String> {
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Cannot find Yavin's data folder: {e}"))?
        .join("extensions");
    Ok(discover(&root))
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

    /// No code is read from an extension's folder: discovery returns its manifest only.
    #[test]
    fn only_the_manifest_is_read_never_code() {
        let source = include_str!("extensions.rs");
        let code = source.split("#[cfg(test)]").next().unwrap();
        assert_eq!(code.matches("fs::read_to_string(").count(), 1);
        assert!(!code.contains("Command::new"));
    }
}
