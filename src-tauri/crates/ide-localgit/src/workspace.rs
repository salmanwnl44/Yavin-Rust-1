//! Which workspace a store belongs to.
//!
//! A workspace is identified exactly as the renderer identifies it (`workspaceIdOf` in
//! `src/services/workspaceManager.ts`): its folders' `ResourceId`s (`resourceId(fileUri(path))`
//! in `src/services/resource.ts`), sorted and joined with `|`. `resource_id_of` is a port of that
//! rule, checked against the fixture both sides test
//! (`src/services/localgit/workspaceIds.fixtures.json`). The store's directory name is derived
//! from that identity -- never from the folder name alone -- and paths never enter object ids.

use crate::error::{LgError, Result};
use sha2::{Digest, Sha256};
use std::path::Path;

/// `file://…` for a filesystem path, the renderer's `resourceId`: separators `/`, the
/// extended-length prefix removed, `.` and `..` resolved, no trailing separator, and the whole
/// id lowercased for a drive or UNC path (Windows compares those case-insensitively) but kept
/// as it is otherwise.
pub fn resource_id_of(path: &str) -> Result<String> {
    let bad = |why: &str| LgError::InvalidName(format!("path {path:?}: {why}"));
    if path.is_empty() {
        return Err(bad("empty"));
    }
    if path.contains('\0') {
        return Err(bad("contains NUL"));
    }
    let cleaned = ide_workspace::file_tree::clean_path_str(Path::new(path));
    if cleaned.starts_with("//./") || cleaned.starts_with("//?/") {
        return Err(bad("device paths are not supported"));
    }
    let bytes = cleaned.as_bytes();
    let drive = bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    let (root, rest, insensitive) = if drive {
        if bytes.len() > 2 && bytes[2] != b'/' {
            return Err(bad("a drive-relative path is ambiguous"));
        }
        (
            format!("{}:/", (bytes[0] as char).to_ascii_uppercase()),
            &cleaned[2..],
            true,
        )
    } else if let Some(unc) = cleaned.strip_prefix("//") {
        let mut parts = unc.splitn(3, '/');
        let server = parts.next().unwrap_or("");
        let share = parts.next().unwrap_or("");
        if server.is_empty() || share.is_empty() {
            return Err(bad("a UNC path needs a server and a share"));
        }
        let rest = parts.next().unwrap_or("");
        (format!("//{server}/{share}"), rest, true)
    } else if cleaned.starts_with('/') {
        ("/".to_string(), cleaned.as_str(), false)
    } else {
        return Err(bad("not absolute"));
    };
    let mut resolved: Vec<&str> = Vec::new();
    for segment in rest.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                if resolved.pop().is_none() {
                    return Err(bad("goes above its root"));
                }
            }
            other => resolved.push(other),
        }
    }
    let canonical = if resolved.is_empty() {
        root
    } else if root.ends_with('/') {
        format!("{root}{}", resolved.join("/"))
    } else {
        format!("{root}/{}", resolved.join("/"))
    };
    // `fromCanonical`: a UNC root becomes the authority, anything else is the path.
    let id = match canonical.strip_prefix("//") {
        Some(unc) => format!("file://{unc}"),
        None if drive => format!("file://{canonical}"),
        None => format!("file://{canonical}"),
    };
    Ok(if insensitive { id.to_lowercase() } else { id })
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct FolderSpec {
    pub resource_id: String,
    /// The path as the native side spells it (`/` separators, no `\\?\`), for reopening.
    pub path: String,
}

/// The workspace a store is opened for, computed natively from the open workspace's roots.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct WorkspaceSpec {
    /// Sorted folder `ResourceId`s joined by `|`: the renderer's `WorkspaceId`.
    pub workspace_id: String,
    /// Sorted by `resource_id`.
    pub folders: Vec<FolderSpec>,
}

impl WorkspaceSpec {
    pub fn from_paths<P: AsRef<Path>>(paths: &[P]) -> Result<WorkspaceSpec> {
        if paths.is_empty() {
            return Err(LgError::InvalidName(
                "a workspace needs at least one folder".into(),
            ));
        }
        let mut folders = Vec::with_capacity(paths.len());
        for path in paths {
            let text = path.as_ref().to_string_lossy();
            let resource_id = resource_id_of(&text)?;
            if folders
                .iter()
                .any(|folder: &FolderSpec| folder.resource_id == resource_id)
            {
                continue;
            }
            folders.push(FolderSpec {
                resource_id,
                path: ide_workspace::file_tree::clean_path_str(path.as_ref())
                    .trim_end_matches('/')
                    .to_string(),
            });
        }
        folders.sort_by(|a, b| a.resource_id.cmp(&b.resource_id));
        let workspace_id = folders
            .iter()
            .map(|folder| folder.resource_id.as_str())
            .collect::<Vec<_>>()
            .join("|");
        Ok(WorkspaceSpec {
            workspace_id,
            folders,
        })
    }

    /// `ws-` and 20 hex digits of `sha256("ylg-workspace\0" + workspaceId)`: how commits name
    /// their workspace without containing a path.
    pub fn hash_id(&self) -> String {
        let digest = Sha256::digest(format!("ylg-workspace\0{}", self.workspace_id).as_bytes());
        let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        format!("ws-{}", &hex[..20])
    }

    /// The store's directory name: a readable slug of the first folder's name plus the hash
    /// id. The slug is only for people looking at the directory; identity is the hash.
    pub fn key(&self) -> String {
        let name = self.folders[0]
            .path
            .rsplit('/')
            .find(|segment| !segment.is_empty())
            .unwrap_or("workspace");
        let mut slug: String = name
            .to_lowercase()
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                    c
                } else {
                    '-'
                }
            })
            .collect();
        slug = slug.trim_matches(|c| c == '-' || c == '.').to_string();
        slug.truncate(24);
        if slug.is_empty() {
            slug = "workspace".into();
        }
        format!("{slug}-{}", &self.hash_id()[3..])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Case {
        input: String,
        id: Option<String>,
    }

    /// The same fixture the renderer tests `resourceId(fileUri(input))` against: the two
    /// identities cannot drift apart without one side failing.
    #[test]
    fn resource_ids_match_the_renderer_fixture() {
        let cases: Vec<Case> = serde_json::from_str(include_str!(
            "../../../../src/services/localgit/workspaceIds.fixtures.json"
        ))
        .unwrap();
        assert!(cases.len() >= 10);
        for case in cases {
            match case.id {
                Some(id) => assert_eq!(resource_id_of(&case.input).unwrap(), id, "{}", case.input),
                None => assert!(resource_id_of(&case.input).is_err(), "{}", case.input),
            }
        }
    }

    #[test]
    fn a_workspace_id_is_its_sorted_folder_ids_and_its_key_never_just_its_name() {
        let one = WorkspaceSpec::from_paths(&["C:\\Work\\Project"]).unwrap();
        let same = WorkspaceSpec::from_paths(&["\\\\?\\c:\\work\\project\\"]).unwrap();
        assert_eq!(one.workspace_id, "file://c:/work/project");
        assert_eq!(one.workspace_id, same.workspace_id);
        assert_eq!(one.key(), same.key());
        assert!(one.key().starts_with("project-"));
        // Another folder with the same name is another store.
        let other = WorkspaceSpec::from_paths(&["D:\\Other\\Project"]).unwrap();
        assert_ne!(one.key(), other.key());
        // Several folders: sorted, joined, one identity whatever the order.
        let a = WorkspaceSpec::from_paths(&["/srv/b", "/srv/a"]).unwrap();
        let b = WorkspaceSpec::from_paths(&["/srv/a", "/srv/b"]).unwrap();
        assert_eq!(a.workspace_id, "file:///srv/a|file:///srv/b");
        assert_eq!(a.key(), b.key());
        assert!(!a.hash_id().contains('/'));
        // Case matters where the filesystem says it does.
        assert_ne!(
            WorkspaceSpec::from_paths(&["/srv/A"]).unwrap().key(),
            WorkspaceSpec::from_paths(&["/srv/a"]).unwrap().key()
        );
        // A name with nothing sluggable still gets a readable prefix.
        assert!(WorkspaceSpec::from_paths(&["/srv/😀"])
            .unwrap()
            .key()
            .starts_with("workspace-"));
        assert!(WorkspaceSpec::from_paths::<&str>(&[]).is_err());
    }
}
