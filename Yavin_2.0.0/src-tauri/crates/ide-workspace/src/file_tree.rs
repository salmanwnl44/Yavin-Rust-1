use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

pub const MAX_EDITOR_FILE_SIZE: u64 = 10 * 1024 * 1024; // 10 MB limit
pub const BINARY_CHECK_BYTES: usize = 8192; // Inspect first 8 KB

/// Normalizes path to forward slashes `/` and strips Windows extended-length prefixes (`\\?\`, `//?/`, `\??\`).
pub fn clean_path_str<P: AsRef<Path>>(path: P) -> String {
    let s = path.as_ref().to_string_lossy().replace('\\', "/");
    if let Some(unc) = s.strip_prefix("//?/UNC/") {
        return format!("//{unc}");
    }
    let trimmed = if let Some(stripped) = s.strip_prefix("//?/") {
        stripped
    } else if let Some(stripped) = s.strip_prefix("/??/") {
        stripped
    } else if let Some(stripped) = s.strip_prefix("\\\\?\\") {
        stripped
    } else {
        &s
    };
    trimmed.to_string()
}

/// Recursive representation of a file or directory in the workspace.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<u64>,
    pub readonly: bool,
    pub children: Option<Vec<FileNode>>,
}

/// Centralized manager for workspace security, path boundaries, and operations.
#[derive(Debug, Clone)]
pub struct WorkspaceManager {
    root: PathBuf,
}

impl WorkspaceManager {
    /// Creates a new WorkspaceManager with canonicalized root directory.
    pub fn new<P: AsRef<Path>>(root: P) -> Result<Self, String> {
        let path = root.as_ref();
        let canonical_root = path
            .canonicalize()
            .map_err(|e| format!("Invalid workspace root '{}': {}", path.display(), e))?;

        if !canonical_root.is_dir() {
            return Err(format!(
                "Workspace root is not a directory: {}",
                canonical_root.display()
            ));
        }

        Ok(Self {
            root: canonical_root,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Validates that a target path lies strictly within the workspace root.
    /// Traversal sequences like `..` and external symlinks are strictly rejected.
    pub fn validate_path<P: AsRef<Path>>(&self, target: P) -> Result<PathBuf, String> {
        let p = target.as_ref();
        let absolute = if p.is_absolute() {
            p.to_path_buf()
        } else {
            self.root.join(p)
        };

        // Lexical normalization resolving . and ..
        let mut normalized = PathBuf::new();
        for component in absolute.components() {
            match component {
                std::path::Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
                std::path::Component::RootDir => {
                    normalized.push(std::path::MAIN_SEPARATOR.to_string())
                }
                std::path::Component::CurDir => {}
                std::path::Component::ParentDir => {
                    if !normalized.pop() {
                        return Err(format!(
                            "Security rejection: Path '{}' escapes root via parent traversal",
                            p.display()
                        ));
                    }
                }
                std::path::Component::Normal(c) => normalized.push(c),
            }
        }

        // Canonicalize existing ancestors to prevent symlink escapes
        let final_path = if fs::symlink_metadata(&normalized).is_ok() {
            normalized.canonicalize().map_err(|e| e.to_string())?
        } else {
            let mut current = normalized.as_path();
            let mut suffix = Vec::new();
            while !fs::symlink_metadata(current).is_ok() {
                if let Some(name) = current.file_name() {
                    suffix.push(name);
                }
                if let Some(parent) = current.parent() {
                    current = parent;
                } else {
                    break;
                }
            }
            if fs::symlink_metadata(current).is_ok() {
                let mut canonical_ancestor = current.canonicalize().map_err(|e| e.to_string())?;
                for part in suffix.into_iter().rev() {
                    canonical_ancestor.push(part);
                }
                canonical_ancestor
            } else {
                normalized
            }
        };

        // Security check: Target must start with workspace root
        if !final_path.starts_with(&self.root) {
            return Err(format!(
                "Security rejection: Path '{}' is outside the workspace root '{}'",
                p.display(),
                self.root.display()
            ));
        }

        Ok(final_path)
    }

    /// Validates a path whose final component is operated on itself (delete, rename):
    /// the parent is resolved, but a final symbolic link is not followed to its target.
    pub fn validate_entry<P: AsRef<Path>>(&self, target: P) -> Result<PathBuf, String> {
        let p = target.as_ref();
        let name = p
            .file_name()
            .ok_or_else(|| format!("Invalid path: {}", p.display()))?;
        let parent = p.parent().unwrap_or(Path::new(""));
        let entry = self.validate_path(parent)?.join(name);
        if entry == self.root {
            return Err("Security rejection: Cannot modify the workspace root directory".into());
        }
        Ok(entry)
    }

    /// Lists a workspace directory. Directories deeper than `max_depth` have `children: None`,
    /// meaning they have not been loaded yet.
    pub fn list_directory<P: AsRef<Path>>(
        &self,
        path: P,
        max_depth: usize,
    ) -> Result<FileNode, String> {
        let validated = self.validate_path(path)?;
        list_directory_inner(&validated, 0, max_depth, &self.root)
    }

    /// Reads a file from disk with size and binary classification guards.
    pub fn read_file<P: AsRef<Path>>(&self, path: P) -> Result<String, String> {
        let validated = self.validate_path(path)?;
        read_file_content_guarded(&validated)
    }

    /// Safely and atomically writes content to a file.
    pub fn write_file<P: AsRef<Path>>(&self, path: P, content: &str) -> Result<(), String> {
        self.write_file_with(path, content, temp_nonce())
    }

    /// `write_file` through the temporary file `temp_path_for(<validated path>, nonce)`, so a
    /// caller that needs to know that file in advance can.
    pub fn write_file_with<P: AsRef<Path>>(
        &self,
        path: P,
        content: &str,
        nonce: u128,
    ) -> Result<(), String> {
        if content.len() as u64 > MAX_EDITOR_FILE_SIZE {
            return Err("Content exceeds the editor's 10 MB file size limit".into());
        }
        let validated = self.validate_path(path)?;
        atomic_write_file_via(&validated, &temp_path_for(&validated, nonce), content)
    }

    /// Creates a new empty file inside the workspace.
    pub fn create_file<P: AsRef<Path>>(&self, path: P) -> Result<(), String> {
        let validated = self.validate_path(path)?;
        if validated.exists() {
            return Err(format!("File already exists: {}", validated.display()));
        }
        if let Some(parent) = validated.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&validated)
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Creates a new directory inside the workspace.
    pub fn create_directory<P: AsRef<Path>>(&self, path: P) -> Result<(), String> {
        let validated = self.validate_path(path)?;
        if validated.exists() {
            return Err(format!("Directory already exists: {}", validated.display()));
        }
        fs::create_dir_all(&validated).map_err(|e| e.to_string())
    }

    /// Renames a file or directory within the workspace without overwriting existing files.
    /// A symbolic link is renamed itself; a case-only rename is allowed.
    pub fn rename_path<P: AsRef<Path>>(&self, old_path: P, new_path: P) -> Result<(), String> {
        let old_val = self.validate_entry(&old_path)?;
        let new_val = self.validate_entry(&new_path)?;

        if fs::symlink_metadata(&old_val).is_err() {
            return Err(format!("Source does not exist: {}", old_val.display()));
        }
        if fs::symlink_metadata(&new_val).is_ok() && !is_case_only_rename(&old_val, &new_val) {
            return Err(format!("Destination already exists: {}", new_val.display()));
        }

        fs::rename(&old_val, &new_val).map_err(|e| e.to_string())
    }

    /// Deletes a file or directory inside the workspace. Protects the root directory.
    /// A symbolic link or junction is removed itself, never its target.
    pub fn delete_path<P: AsRef<Path>>(&self, path: P, recursive: bool) -> Result<(), String> {
        let validated = self.validate_entry(path)?;
        let metadata = fs::symlink_metadata(&validated)
            .map_err(|_| format!("Path does not exist: {}", validated.display()))?;

        if metadata.file_type().is_symlink() {
            // Directory links and Windows junctions need remove_dir.
            fs::remove_file(&validated)
                .or_else(|_| fs::remove_dir(&validated))
                .map_err(|e| e.to_string())
        } else if metadata.is_dir() {
            if recursive {
                fs::remove_dir_all(&validated).map_err(|e| e.to_string())
            } else {
                fs::remove_dir(&validated).map_err(|e| e.to_string())
            }
        } else {
            fs::remove_file(&validated).map_err(|e| e.to_string())
        }
    }

    /// Lists directory tree up to max_depth.
    pub fn list_tree(&self, max_depth: Option<usize>) -> Result<FileNode, String> {
        list_directory_inner(&self.root, 0, max_depth.unwrap_or(6), &self.root)
    }
}

/// Reads file content with size limit (10MB) and binary detection guards.
pub fn read_file_content_guarded(path: &Path) -> Result<String, String> {
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;

    if metadata.len() > MAX_EDITOR_FILE_SIZE {
        return Err(format!(
            "File is too large to open in text editor ({} MB exceeds 10 MB limit)",
            metadata.len() / (1024 * 1024)
        ));
    }

    let file = File::open(path).map_err(|e| e.to_string())?;
    let mut buffer = Vec::new();
    file.take(MAX_EDITOR_FILE_SIZE + 1)
        .read_to_end(&mut buffer)
        .map_err(|e| e.to_string())?;

    if buffer.len() as u64 > MAX_EDITOR_FILE_SIZE {
        return Err("File grew beyond the editor size limit".into());
    }
    let sample_len = buffer.len().min(BINARY_CHECK_BYTES);
    if buffer[..sample_len].contains(&0) {
        return Err("Binary file cannot be opened as text in editor".to_string());
    }

    String::from_utf8(buffer).map_err(|_| {
        "File contains invalid UTF-8 encoding (binary or unsupported charset)".to_string()
    })
}

/// A fresh value for `temp_path_for`, never the same twice in one process: the clock alone is
/// not enough -- Windows advances it in 100 ns steps, so two saves of one file in the same step
/// would pick the same temporary name, and the second would fail to create it. A per-process
/// sequence number in the low bits keeps every nonce distinct; the time keeps them distinct
/// across processes and restarts.
pub fn temp_nonce() -> u128 {
    static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let sequence = SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    (nanos << 32) | u128::from(sequence as u32)
}

/// The temporary file an atomic write of `path` goes through: a hidden sibling, so the final
/// rename stays on one volume. Derived from `nonce` so a caller can know it before writing.
pub fn temp_path_for(path: &Path, nonce: u128) -> PathBuf {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    path.with_file_name(format!(".{name}.tmp.{nonce}"))
}

/// The folders above `path` that do not exist yet -- what creating `path` with its parents
/// would make -- outermost first. No I/O beyond checking each for existence.
pub fn missing_ancestors(path: &Path) -> Vec<PathBuf> {
    let mut missing: Vec<PathBuf> = path
        .ancestors()
        .skip(1)
        .take_while(|ancestor| !ancestor.as_os_str().is_empty() && !ancestor.exists())
        .map(Path::to_path_buf)
        .collect();
    missing.reverse();
    missing
}

/// Safely writes file to disk via atomic temp file swap.
pub fn atomic_write_file(path: &Path, content: &str) -> Result<(), String> {
    atomic_write_file_via(path, &temp_path_for(path, temp_nonce()), content)
}

/// `atomic_write_file` through a given temporary file (see `temp_path_for`).
pub fn atomic_write_file_via(path: &Path, temp_path: &Path, content: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Missing parent directory".to_string())?;
    if !parent.exists() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let temp_path = temp_path.to_path_buf();

    {
        let mut temp_file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .map_err(|e| e.to_string())?;
        temp_file.write_all(content.as_bytes()).map_err(|e| {
            let _ = fs::remove_file(&temp_path);
            e.to_string()
        })?;
        temp_file.flush().map_err(|e| {
            let _ = fs::remove_file(&temp_path);
            e.to_string()
        })?;
        temp_file
            .sync_all()
            .map_err(|e| format!("Failed to sync saved file: {e}"))?;
    }

    fs::rename(&temp_path, path).map_err(|e| {
        let _ = fs::remove_file(&temp_path);
        format!("Failed atomic write: {}", e)
    })?;

    Ok(())
}

/// On case-insensitive filesystems `Foo` and `foo` name the same entry. Allow renaming to
/// such an alias only when no entry with exactly the new name exists.
fn is_case_only_rename(from: &Path, to: &Path) -> bool {
    let (Some(from_name), Some(to_name), Some(parent)) =
        (from.file_name(), to.file_name(), to.parent())
    else {
        return false;
    };
    from.parent() == Some(parent)
        && from_name != to_name
        && from_name.to_string_lossy().to_lowercase() == to_name.to_string_lossy().to_lowercase()
        && fs::read_dir(parent)
            .map(|entries| !entries.flatten().any(|entry| entry.file_name() == to_name))
            .unwrap_or(false)
}

fn list_directory_inner(
    path: &Path,
    current_depth: usize,
    max_depth: usize,
    workspace_root: &Path,
) -> Result<FileNode, String> {
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    let is_dir = metadata.is_dir();
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(path.to_str().unwrap_or("."))
        .to_string();

    let size = if is_dir { 0 } else { metadata.len() };
    let modified = metadata
        .modified()
        .ok()
        .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);
    let readonly = metadata.permissions().readonly();
    let normalized_path = clean_path_str(path);

    // `None` for a directory means "not loaded yet"; an empty directory is `Some(vec![])`.
    let children = if !is_dir || current_depth >= max_depth {
        None
    } else {
        match fs::read_dir(path) {
            Err(error) if current_depth == 0 => {
                return Err(format!("Cannot read {}: {error}", normalized_path));
            }
            // A nested unreadable directory stays unloaded, so expanding it reports the error.
            Err(_) => None,
            Ok(read_dir) => {
                let mut entries = Vec::new();
                for entry in read_dir.flatten() {
                    let entry_path = entry.path();
                    let entry_name = entry.file_name().to_string_lossy().to_string();

                    if entry_name == ".git" {
                        continue;
                    }
                    if entry.file_type().map(|t| t.is_symlink()).unwrap_or(false) {
                        if let Ok(target) = entry_path.canonicalize() {
                            if !target.starts_with(workspace_root) {
                                continue;
                            }
                        }
                    }

                    // Large generated folders are listed but only loaded when expanded.
                    let depth = if entry_name == "node_modules" || entry_name == "target" {
                        max_depth
                    } else {
                        current_depth + 1
                    };
                    if let Ok(child_node) =
                        list_directory_inner(&entry_path, depth, max_depth, workspace_root)
                    {
                        entries.push(child_node);
                    }
                }

                entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
                    (true, false) => std::cmp::Ordering::Less,
                    (false, true) => std::cmp::Ordering::Greater,
                    _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
                });
                Some(entries)
            }
        }
    };

    Ok(FileNode {
        name,
        path: normalized_path,
        is_dir,
        size,
        modified,
        readonly,
        children,
    })
}

/// Standalone guarded read function.
pub fn read_file_content(path: &str) -> Result<String, String> {
    let p = Path::new(path);
    if !p.exists() {
        return Err(format!("File does not exist: {}", path));
    }
    read_file_content_guarded(p)
}

/// Standalone atomic write function.
pub fn write_file_content(path: &str, content: &str) -> Result<(), String> {
    atomic_write_file(Path::new(path), content)
}

/// Standalone create file function.
pub fn create_file(path: &str) -> Result<(), String> {
    let p = Path::new(path);
    if p.exists() {
        return Err(format!("File already exists: {}", path));
    }
    if let Some(parent) = p.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    File::create(p).map_err(|e| format!("Failed to create file: {}", e))?;
    Ok(())
}

/// Standalone create directory function.
pub fn create_directory(path: &str) -> Result<(), String> {
    let p = Path::new(path);
    if p.exists() {
        return Err(format!("Directory already exists: {}", path));
    }
    fs::create_dir_all(p).map_err(|e| format!("Failed to create directory: {}", e))
}

/// Standalone rename function.
pub fn rename_path(old_path: &str, new_path: &str) -> Result<(), String> {
    let src = Path::new(old_path);
    let dst = Path::new(new_path);
    if !src.exists() {
        return Err(format!("Source does not exist: {}", old_path));
    }
    if dst.exists() {
        return Err(format!("Target already exists: {}", new_path));
    }
    if let Some(parent) = dst.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    fs::rename(src, dst).map_err(|e| format!("Failed to rename: {}", e))
}

/// Standalone delete function.
pub fn delete_path(path: &str, recursive: bool) -> Result<(), String> {
    let p = Path::new(path);
    if !p.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    if p.is_dir() {
        if recursive {
            fs::remove_dir_all(p).map_err(|e| e.to_string())
        } else {
            fs::remove_dir(p).map_err(|e| e.to_string())
        }
    } else {
        fs::remove_file(p).map_err(|e| e.to_string())
    }
}

/// Duplicates a file or directory with a unique `_copy` name.
pub fn duplicate_path(path_str: &str) -> Result<String, String> {
    let destination = duplicate_destination(path_str)?;
    copy_path(path_str, &destination)?;
    Ok(destination)
}

/// The path `duplicate_path` would copy `path_str` to: the first free `_copy` name beside it.
/// Separate so a caller can know the destination before anything is written.
pub fn duplicate_destination(path_str: &str) -> Result<String, String> {
    let p = Path::new(path_str);
    if !p.exists() {
        return Err(format!("Path does not exist: {}", path_str));
    }

    let parent = p.parent().unwrap_or_else(|| Path::new("."));
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
    let ext = p.extension().and_then(|e| e.to_str());

    let mut counter = 1;
    loop {
        let new_name = match ext {
            Some(e) => {
                if counter == 1 {
                    format!("{}_copy.{}", stem, e)
                } else {
                    format!("{}_copy_{}.{}", stem, counter, e)
                }
            }
            None => {
                if counter == 1 {
                    format!("{}_copy", stem)
                } else {
                    format!("{}_copy_{}", stem, counter)
                }
            }
        };

        let candidate = parent.join(&new_name);
        if !candidate.exists() {
            return Ok(clean_path_str(&candidate));
        }
        counter += 1;
    }
}

/// Copies file or directory recursively.
pub fn copy_path(src: &str, dest: &str) -> Result<(), String> {
    let s = Path::new(src);
    let d = Path::new(dest);
    if !s.exists() {
        return Err(format!("Source does not exist: {}", src));
    }
    if d.exists() {
        return Err("Copy destination already exists".into());
    }
    if d.starts_with(s) {
        return Err("Cannot copy a directory into itself".into());
    }
    if fs::symlink_metadata(s)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err("Copying symbolic links is not supported".into());
    }
    if s.is_file() {
        if let Some(parent) = d.parent() {
            if !parent.exists() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
        }
        fs::copy(s, d).map_err(|e| format!("Failed to copy file: {}", e))?;
        Ok(())
    } else {
        copy_dir_recursive(s, d)
    }
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    if !dst.exists() {
        fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    }
    for entry in fs::read_dir(src).map_err(|e| e.to_string())?.flatten() {
        let entry_path = entry.path();
        if entry.file_type().map_err(|e| e.to_string())?.is_symlink() {
            return Err("Copying symbolic links is not supported".into());
        }
        let target_path = dst.join(entry.file_name());
        if entry_path.is_dir() {
            copy_dir_recursive(&entry_path, &target_path)?;
        } else {
            fs::copy(&entry_path, &target_path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Reveals path in the native file explorer.
pub fn reveal_in_os_explorer(path: &str) -> Result<(), String> {
    let p = Path::new(path);
    if !p.exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        let canonical = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
        if p.is_dir() {
            Command::new("explorer")
                .arg(&canonical)
                .spawn()
                .map_err(|e| e.to_string())?;
        } else {
            Command::new("explorer")
                .arg(format!("/select,{}", canonical.to_string_lossy()))
                .spawn()
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        Command::new("open")
            .arg("-R")
            .arg(path)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    #[cfg(target_os = "linux")]
    {
        use std::process::Command;
        let parent = if p.is_dir() {
            p
        } else {
            p.parent().unwrap_or(Path::new("."))
        };
        Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

/// Native folder picker.
pub fn pick_workspace_folder() -> Result<Option<String>, String> {
    let folder = rfd::FileDialog::new()
        .set_title("Open Workspace Folder")
        .pick_folder();

    Ok(folder.map(clean_path_str))
}

/// Native file picker.
pub fn pick_file() -> Result<Option<String>, String> {
    let file = rfd::FileDialog::new().set_title("Open File").pick_file();

    Ok(file.map(clean_path_str))
}

/// Native save file picker.
pub fn pick_save_file(default_name: Option<String>) -> Result<Option<String>, String> {
    let mut dialog = rfd::FileDialog::new().set_title("Save File As");
    if let Some(name) = default_name {
        dialog = dialog.set_file_name(&name);
    }
    let file = dialog.save_file();
    Ok(file.map(clean_path_str))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    #[test]
    fn test_clean_path_str() {
        let p1 = Path::new("//?/C:/Users/test/file.rs");
        assert_eq!(clean_path_str(p1), "C:/Users/test/file.rs");

        let p2 = Path::new(r"\\?\D:\Projects\app\src\main.rs");
        assert_eq!(clean_path_str(p2), "D:/Projects/app/src/main.rs");
        assert_eq!(
            clean_path_str(r"\\?\UNC\server\share\file.ts"),
            "//server/share/file.ts"
        );
    }

    #[test]
    fn test_workspace_security_path_validation() {
        let tmp_dir = env::temp_dir().join(format!(
            "yavin_sec_test_{}",
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&tmp_dir).unwrap();

        let mgr = WorkspaceManager::new(&tmp_dir).unwrap();

        let allowed = mgr.validate_path("src/main.rs");
        assert!(allowed.is_ok());

        let traversal = mgr.validate_path("../../outside.txt");
        assert!(traversal.is_err());
        assert!(traversal.unwrap_err().contains("Security rejection"));

        let system_path = if cfg!(windows) {
            "C:\\Windows\\System32\\cmd.exe"
        } else {
            "/etc/passwd"
        };
        let rejected = mgr.validate_path(system_path);
        assert!(rejected.is_err());

        assert!(mgr.delete_path(&tmp_dir, true).is_err());
        assert!(mgr
            .rename_path(&tmp_dir, &tmp_dir.join("new_root"))
            .is_err());

        let _ = fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn test_binary_and_large_file_guards() {
        let tmp_dir = env::temp_dir().join(format!(
            "yavin_guard_test_{}",
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&tmp_dir).unwrap();

        let mgr = WorkspaceManager::new(&tmp_dir).unwrap();

        let text_path = tmp_dir.join("hello.txt");
        mgr.write_file(&text_path, "Hello, Yavin!").unwrap();
        let read = mgr.read_file(&text_path).unwrap();
        assert_eq!(read, "Hello, Yavin!");

        let binary_path = tmp_dir.join("image.png");
        fs::write(&binary_path, [0x89, 0x50, 0x4E, 0x47, 0x00, 0x00, 0x00]).unwrap();
        let bin_res = mgr.read_file(&binary_path);
        assert!(bin_res.is_err());
        assert!(bin_res.unwrap_err().contains("Binary file"));

        let large_path = tmp_dir.join("large.txt");
        File::create(&large_path)
            .unwrap()
            .set_len(MAX_EDITOR_FILE_SIZE + 1)
            .unwrap();
        assert!(mgr.read_file(&large_path).is_err());
        assert!(mgr
            .write_file(&text_path, &"x".repeat(MAX_EDITOR_FILE_SIZE as usize + 1))
            .is_err());
        assert_eq!(mgr.read_file(&text_path).unwrap(), "Hello, Yavin!");

        let _ = fs::remove_dir_all(&tmp_dir);
    }

    fn unique_temp_dir(label: &str) -> PathBuf {
        let dir = env::temp_dir().join(format!(
            "yavin_{label}_{}",
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn test_lazy_listing_marks_unloaded_directories() {
        let tmp_dir = unique_temp_dir("lazy");
        fs::create_dir_all(tmp_dir.join("src/deep")).unwrap();
        fs::create_dir_all(tmp_dir.join(".git")).unwrap();
        fs::create_dir_all(tmp_dir.join("node_modules/pkg")).unwrap();
        fs::create_dir(tmp_dir.join("empty")).unwrap();
        fs::write(tmp_dir.join("src/main.rs"), "").unwrap();
        let mgr = WorkspaceManager::new(&tmp_dir).unwrap();

        let root = mgr.list_directory(&tmp_dir, 1).unwrap();
        let children = root.children.unwrap();
        let names: Vec<_> = children.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(names, ["empty", "node_modules", "src"]);
        assert!(children.iter().all(|n| n.is_dir && n.children.is_none()));

        let src = mgr.list_directory(tmp_dir.join("src"), 1).unwrap();
        let src_children = src.children.unwrap();
        assert_eq!(src_children[0].name, "deep");
        assert!(src_children[0].children.is_none());
        assert!(!src_children[1].is_dir && src_children[1].children.is_none());

        let empty = mgr.list_directory(tmp_dir.join("empty"), 1).unwrap();
        assert_eq!(empty.children, Some(Vec::new()));

        let deep = mgr.list_directory(&tmp_dir, 3).unwrap();
        let node_modules = &deep.children.unwrap()[1];
        assert_eq!(node_modules.name, "node_modules");
        assert!(node_modules.children.is_none());

        assert!(mgr.list_directory(tmp_dir.join("missing"), 1).is_err());
        let _ = fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn test_case_only_rename() {
        let tmp_dir = unique_temp_dir("case");
        let mgr = WorkspaceManager::new(&tmp_dir).unwrap();
        fs::write(tmp_dir.join("Case.txt"), "x").unwrap();
        mgr.rename_path(&tmp_dir.join("Case.txt"), &tmp_dir.join("case.txt"))
            .unwrap();
        let names: Vec<_> = fs::read_dir(&tmp_dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["case.txt"]);

        fs::write(tmp_dir.join("other.txt"), "keep").unwrap();
        assert!(mgr
            .rename_path(&tmp_dir.join("case.txt"), &tmp_dir.join("other.txt"))
            .is_err());
        assert_eq!(
            fs::read_to_string(tmp_dir.join("other.txt")).unwrap(),
            "keep"
        );
        let _ = fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn test_link_operations_never_touch_the_target() {
        let tmp_dir = unique_temp_dir("link");
        let target = tmp_dir.join("real");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("keep.txt"), "keep").unwrap();
        let link = tmp_dir.join("link");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &link).unwrap();
        #[cfg(windows)]
        assert!(std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&target)
            .output()
            .unwrap()
            .status
            .success());
        let mgr = WorkspaceManager::new(&tmp_dir).unwrap();

        let renamed = tmp_dir.join("renamed");
        mgr.rename_path(&link, &renamed).unwrap();
        assert!(fs::symlink_metadata(&renamed)
            .unwrap()
            .file_type()
            .is_symlink());
        mgr.delete_path(&renamed, true).unwrap();
        assert!(fs::symlink_metadata(&renamed).is_err());
        assert_eq!(fs::read_to_string(target.join("keep.txt")).unwrap(), "keep");
        let _ = fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn test_atomic_saving_and_crud() {
        let tmp_dir = env::temp_dir().join(format!(
            "yavin_crud_test_{}",
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&tmp_dir).unwrap();

        let mgr = WorkspaceManager::new(&tmp_dir).unwrap();

        let file_path = tmp_dir.join("code.rs");
        mgr.create_file(&file_path).unwrap();
        mgr.write_file(&file_path, "fn hello() {}").unwrap();
        assert_eq!(mgr.read_file(&file_path).unwrap(), "fn hello() {}");
        mgr.write_file(&file_path, "replacement").unwrap();
        assert_eq!(mgr.read_file(&file_path).unwrap(), "replacement");

        let destination = tmp_dir.join("existing.txt");
        fs::write(&destination, "keep me").unwrap();
        assert!(copy_path(&clean_path_str(&file_path), &clean_path_str(&destination)).is_err());
        assert_eq!(fs::read_to_string(&destination).unwrap(), "keep me");
        assert!(copy_path(
            &clean_path_str(&tmp_dir),
            &clean_path_str(tmp_dir.join("nested"))
        )
        .is_err());

        let directory = tmp_dir.join("directory");
        fs::create_dir(&directory).unwrap();
        fs::write(directory.join("keep.txt"), "unchanged").unwrap();
        assert!(mgr
            .write_file(&directory, "must not replace directory")
            .is_err());
        assert_eq!(
            fs::read_to_string(directory.join("keep.txt")).unwrap(),
            "unchanged"
        );

        assert!(mgr.create_file(&file_path).is_err());

        let renamed = tmp_dir.join("code_renamed.rs");
        mgr.rename_path(&file_path, &renamed).unwrap();
        assert!(!file_path.exists());
        assert!(renamed.exists());

        mgr.delete_path(&renamed, false).unwrap();
        assert!(!renamed.exists());

        let _ = fs::remove_dir_all(&tmp_dir);
    }
}
