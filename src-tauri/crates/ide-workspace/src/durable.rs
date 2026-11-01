//! Writing and reading the files Yavin keeps about itself -- the session, trust decisions,
//! recovery records -- so that a crash, a full disk or a newer Yavin can never leave them
//! destroyed.
//!
//! Writes go to a unique sibling temporary file, are flushed to disk, and are renamed over the
//! target: the target always holds either the previous complete contents or the new complete
//! contents, never a mixture, and never nothing. (On Windows the rename is `MoveFileEx` with
//! replace, atomic on one volume; a directory cannot be flushed through the standard library
//! there, which is the one step Unix gets and Windows does not.)
//!
//! Reads never destroy either. A file that does not parse, or that a newer Yavin wrote, is
//! moved aside -- `<file>.corrupt-<ms>`, `<file>.v<N>.bak` -- before anything takes its place,
//! so the next write cannot overwrite what might still be recovered by hand.

use serde::Serialize;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// The suffix of every temporary file this module writes. Only files with it are ever swept.
pub const TEMP_SUFFIX: &str = ".yavin-tmp";
/// Backups of one file kept whatever their age.
const KEEP_BACKUPS: usize = 5;
/// Backups younger than this are kept however many there are.
const BACKUP_MIN_AGE: Duration = Duration::from_secs(30 * 24 * 60 * 60);

pub fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn temporary_for(file: &Path) -> PathBuf {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let name = file.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    file.with_file_name(format!(
        ".{name}.{}-{}{TEMP_SUFFIX}",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ))
}

/// Replaces `file` with `bytes` durably, or leaves the previous contents entirely alone.
pub fn write_durably(file: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = file
        .parent()
        .ok_or_else(|| format!("{} has no folder", file.display()))?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temporary = temporary_for(file);
    let written = (|| {
        let mut handle = File::create_new(&temporary)?;
        handle.write_all(bytes)?;
        handle.sync_all()?;
        drop(handle);
        fs::rename(&temporary, file)?;
        sync_folder(parent);
        Ok::<(), std::io::Error>(())
    })()
    .map_err(|error| error.to_string());
    if written.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    written
}

/// Flushes a folder's entries (the rename just made) to disk, where the platform allows it.
fn sync_folder(folder: &Path) {
    #[cfg(unix)]
    if let Ok(handle) = File::open(folder) {
        let _ = handle.sync_all();
    }
    #[cfg(not(unix))]
    let _ = folder;
}

/// Removes `file`, then flushes its folder so the removal survives a crash (on Unix).
pub fn remove_durably(file: &Path) -> Result<(), String> {
    match fs::remove_file(file) {
        Ok(()) => {
            if let Some(parent) = file.parent() {
                sync_folder(parent);
            }
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

/// What reading a versioned file found.
#[derive(Debug, PartialEq)]
pub enum Loaded<T> {
    /// No file: a first run.
    Missing,
    /// The current version.
    Current(T),
    /// An older version, migrated to the current one.
    Migrated { value: T, from: u32 },
    /// Not readable as any version. Moved to `backup`.
    Corrupt { backup: Option<PathBuf> },
    /// Written by a newer Yavin. Moved to `backup`, untouched.
    Future {
        version: u32,
        backup: Option<PathBuf>,
    },
    /// There, but could not be read right now (locked, denied). Not evidence of corruption,
    /// and not moved.
    Unreadable,
}

impl<T> Loaded<T> {
    /// The value to run with: what was read, or nothing for a first run and for anything
    /// that had to be moved aside.
    pub fn value(self) -> Option<T> {
        match self {
            Loaded::Current(value) | Loaded::Migrated { value, .. } => Some(value),
            _ => None,
        }
    }

    /// Whether a later write may replace the file. Not when it could not be read, nor when it
    /// was corrupt or newer and could not be set aside -- it is still where it was, and a
    /// write would destroy the only copy.
    pub fn can_replace(&self) -> bool {
        !matches!(
            self,
            Loaded::Unreadable
                | Loaded::Corrupt { backup: None }
                | Loaded::Future { backup: None, .. }
        )
    }
}

/// A version marker that is there but cannot be read: the file is corrupt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BadVersion;

/// How a file's text tells its version. `None`: no version at all (the legacy, version-0
/// format). `Err`: a version marker that cannot be read.
pub type VersionOf = fn(&str) -> Result<Option<u32>, BadVersion>;

/// The version of a JSON file with a top-level numeric `version`.
pub fn json_version(text: &str) -> Result<Option<u32>, BadVersion> {
    let value: serde_json::Value = serde_json::from_str(text).map_err(|_| BadVersion)?;
    match value.get("version") {
        None => Ok(None),
        Some(version) => version
            .as_u64()
            .and_then(|v| u32::try_from(v).ok())
            .map(Some)
            .ok_or(BadVersion),
    }
}

/// Reads `file`, which the current code writes at version `current`.
///
/// `parse(text, version)` reads any version up to and including `current` into the current
/// shape -- that is the migration, done in one deterministic place -- or fails. A file that
/// fails, or whose version is newer than `current`, is moved aside before this returns.
pub fn read_versioned<T>(
    file: &Path,
    current: u32,
    version_of: VersionOf,
    parse: impl Fn(&str, u32) -> Option<T>,
) -> Loaded<T> {
    let text = match fs::read(file) {
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(text) => text,
            Err(_) => {
                return Loaded::Corrupt {
                    backup: move_aside(file, "corrupt"),
                }
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Loaded::Missing,
        // Unreadable right now (locked, denied): not evidence of corruption, and nothing to
        // move. Run without it -- and without replacing it (`can_replace`).
        Err(_) => return Loaded::Unreadable,
    };
    let version = match version_of(&text) {
        Ok(version) => version.unwrap_or(0),
        Err(BadVersion) => {
            return Loaded::Corrupt {
                backup: move_aside(file, "corrupt"),
            }
        }
    };
    if version > current {
        return Loaded::Future {
            version,
            backup: move_aside(file, &format!("v{version}")),
        };
    }
    match parse(&text, version) {
        Some(value) if version == current => Loaded::Current(value),
        Some(value) => Loaded::Migrated {
            value,
            from: version,
        },
        None => Loaded::Corrupt {
            backup: move_aside(file, "corrupt"),
        },
    }
}

/// Moves `file` to a backup name beside it, returning where; `None` if it could not be moved,
/// in which case it is left where it was and `Loaded::can_replace` forbids overwriting it.
fn move_aside(file: &Path, label: &str) -> Option<PathBuf> {
    let name = file.file_name()?.to_str()?;
    let backup = file.with_file_name(format!("{name}.{label}-{}.bak", now_millis()));
    fs::rename(file, &backup).ok()?;
    prune_backups(file);
    Some(backup)
}

/// Keeps the newest `KEEP_BACKUPS` backups of `file`, and any younger than `BACKUP_MIN_AGE`.
pub fn prune_backups(file: &Path) {
    let (Some(parent), Some(name)) = (file.parent(), file.file_name().and_then(|n| n.to_str()))
    else {
        return;
    };
    let prefix = format!("{name}.");
    let Ok(entries) = fs::read_dir(parent) else {
        return;
    };
    let mut backups: Vec<(SystemTime, PathBuf)> = entries
        .flatten()
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|n| n.starts_with(&prefix) && n.ends_with(".bak"))
        })
        .filter_map(|entry| Some((entry.metadata().ok()?.modified().ok()?, entry.path())))
        .collect();
    backups.sort_by_key(|backup| std::cmp::Reverse(backup.0));
    let now = SystemTime::now();
    for (modified, path) in backups.into_iter().skip(KEEP_BACKUPS) {
        let old = now.duration_since(modified).unwrap_or_default() >= BACKUP_MIN_AGE;
        if old {
            let _ = fs::remove_file(path);
        }
    }
}

/// Removes this module's own temporary files in `folder` older than `min_age` -- left by a
/// write a crash interrupted. Never anything else, and never recursively.
pub fn sweep_stale_temps(folder: &Path, min_age: Duration) -> usize {
    let Ok(entries) = fs::read_dir(folder) else {
        return 0;
    };
    let now = SystemTime::now();
    let mut removed = 0;
    for entry in entries.flatten() {
        let is_ours = entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.starts_with('.') && name.ends_with(TEMP_SUFFIX));
        let old = entry
            .metadata()
            .ok()
            .filter(|meta| meta.is_file())
            .and_then(|meta| meta.modified().ok())
            .is_some_and(|modified| now.duration_since(modified).unwrap_or_default() >= min_age);
        if is_ours && old && fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// `value` as pretty JSON, written durably.
pub fn write_json(file: &Path, value: &impl Serialize) -> Result<(), String> {
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    write_durably(file, text.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(label: &str) -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "yavin-durable-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn a_write_replaces_the_contents_and_leaves_nothing_beside_the_file() {
        let dir = temp("replace");
        let file = dir.join("state.json");
        write_durably(&file, b"first").unwrap();
        write_durably(&file, b"second").unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"second");
        assert_eq!(names(&dir), ["state.json"]);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_write_that_cannot_finish_leaves_the_previous_file_and_no_temporary() {
        let dir = temp("fail");
        // A folder where the file should be makes the final rename fail.
        let file = dir.join("state.json");
        fs::create_dir_all(&file).unwrap();
        assert!(write_durably(&file, b"new").is_err());
        assert!(file.is_dir());
        assert_eq!(names(&dir), ["state.json"]);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_crash_mid_write_leaves_the_old_file_whole_and_its_temporary_is_swept() {
        let dir = temp("crash");
        let file = dir.join("state.json");
        write_durably(&file, b"old and complete").unwrap();
        // What a crash after writing part of the temporary file, before the rename, leaves.
        let temporary = temporary_for(&file);
        fs::write(&temporary, b"new but trunc").unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"old and complete");
        // Too recent to be a leftover: another write may still own it.
        assert_eq!(sweep_stale_temps(&dir, Duration::from_secs(3600)), 0);
        assert_eq!(sweep_stale_temps(&dir, Duration::ZERO), 1);
        assert_eq!(names(&dir), ["state.json"]);
        // Nothing that is not this module's temporary file is ever swept.
        fs::write(dir.join("notes.tmp"), b"x").unwrap();
        fs::write(dir.join("a.yavin-tmp"), b"x").unwrap();
        assert_eq!(sweep_stale_temps(&dir, Duration::ZERO), 0);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn two_writers_to_one_file_never_share_a_temporary() {
        let file = Path::new("/w/state.json");
        assert_ne!(temporary_for(file), temporary_for(file));
    }

    fn parse(text: &str, version: u32) -> Option<String> {
        let value: serde_json::Value = serde_json::from_str(text).ok()?;
        match version {
            0 => value.get("name")?.as_str().map(|n| format!("legacy:{n}")),
            1 => value.get("name")?.as_str().map(str::to_string),
            _ => None,
        }
    }

    #[test]
    fn each_version_is_read_or_moved_aside_never_reinterpreted() {
        let dir = temp("versions");
        let file = dir.join("state.json");
        assert_eq!(
            read_versioned(&file, 1, json_version, parse),
            Loaded::Missing
        );

        fs::write(&file, r#"{"version":1,"name":"a"}"#).unwrap();
        assert_eq!(
            read_versioned(&file, 1, json_version, parse),
            Loaded::Current("a".to_string())
        );

        // No version at all: the legacy format, migrated.
        fs::write(&file, r#"{"name":"a"}"#).unwrap();
        assert_eq!(
            read_versioned(&file, 1, json_version, parse),
            Loaded::Migrated {
                value: "legacy:a".to_string(),
                from: 0
            }
        );

        // From a newer Yavin: moved aside intact, never read as this version.
        let future = r#"{"version":7,"name":"a","extra":true}"#;
        fs::write(&file, future).unwrap();
        match read_versioned(&file, 1, json_version, parse) {
            Loaded::Future {
                version: 7,
                backup: Some(backup),
            } => assert_eq!(fs::read_to_string(backup).unwrap(), future),
            other => panic!("{other:?}"),
        }
        assert!(!file.exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_corrupt_or_truncated_file_is_backed_up_not_overwritten() {
        let dir = temp("corrupt");
        let file = dir.join("state.json");
        for broken in [
            &br#"{"version":1,"na"#[..],
            br#"{"version":"one"}"#,
            br#"{"version":1,"other":1}"#,
            &[0xff, 0xfe, 0x00][..],
        ] {
            fs::write(&file, broken).unwrap();
            match read_versioned(&file, 1, json_version, parse) {
                Loaded::Corrupt {
                    backup: Some(backup),
                } => assert_eq!(fs::read(backup).unwrap(), broken),
                other => panic!("{other:?}"),
            }
            assert!(!file.exists(), "moved, so the next write cannot destroy it");
        }
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn backups_are_pruned_to_the_newest_but_never_the_recent_ones() {
        let dir = temp("prune");
        let file = dir.join("state.json");
        let old = SystemTime::now() - BACKUP_MIN_AGE - Duration::from_secs(60);
        for index in 0..8 {
            let backup = dir.join(format!("state.json.corrupt-{index}.bak"));
            fs::write(&backup, b"x").unwrap();
            let handle = File::options().write(true).open(&backup).unwrap();
            // The first three are old; the rest are recent.
            let when = if index < 3 {
                old - Duration::from_secs(index)
            } else {
                SystemTime::now()
            };
            handle.set_modified(when).unwrap();
        }
        fs::write(dir.join("other.json.corrupt-1.bak"), b"x").unwrap();
        prune_backups(&file);
        let left = names(&dir);
        // Five recent ones are the newest five: the three old ones go. Another file's backup
        // is not this file's to prune.
        assert_eq!(left.len(), 6, "{left:?}");
        assert!(left.contains(&"other.json.corrupt-1.bak".to_string()));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn removing_a_file_that_is_already_gone_is_not_an_error() {
        let dir = temp("remove");
        let file = dir.join("x");
        fs::write(&file, b"x").unwrap();
        remove_durably(&file).unwrap();
        remove_durably(&file).unwrap();
        assert!(!file.exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_file_that_cannot_be_read_is_never_marked_replaceable() {
        let dir = temp("unreadable");
        // Something is there that cannot be read as a file (a folder stands in for a file
        // locked by another program): not missing, and not to be written over.
        let file = dir.join("state.json");
        fs::create_dir_all(&file).unwrap();
        let loaded = read_versioned(&file, 1, json_version, parse);
        assert_eq!(loaded, Loaded::Unreadable);
        assert!(!loaded.can_replace());
        assert!(file.is_dir(), "left where it was");
        // Nor a corrupt or newer file that could not be set aside.
        assert!(!Loaded::<String>::Corrupt { backup: None }.can_replace());
        assert!(!Loaded::<String>::Future {
            version: 9,
            backup: None
        }
        .can_replace());
        assert!(Loaded::<String>::Missing.can_replace());
        assert!(Loaded::<String>::Corrupt {
            backup: Some(dir.join("x"))
        }
        .can_replace());
        fs::remove_dir_all(&dir).ok();
    }
}
