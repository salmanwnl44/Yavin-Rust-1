//! Writing the small files Yavin keeps in the user's config directory.
//!
//! Both of them -- the session and the trust decisions -- are rewritten in full every time
//! anything in them changes, which makes a torn write a real possibility rather than a
//! theoretical one. Neither can afford one: a truncated session loses the folders someone
//! works in, and a truncated trust file could lose the tail of a path and leave a decision
//! that reads as covering more than the user ever agreed to.

use std::path::Path;

/// Replaces `file` with `text`, or leaves the previous contents entirely alone.
///
/// The write goes to a uniquely named sibling temporary file, is flushed to disk, and is then
/// renamed over the target, which is atomic on every platform Yavin runs on (see
/// `ide_workspace::durable`). The temporary file is removed on either failure path, so a full
/// disk cannot leave litter next to a file people are told they may read by hand, and a crash
/// that leaves one behind has it swept at the next start.
pub fn write_atomically(file: &Path, text: &str) -> Result<(), String> {
    ide_workspace::durable::write_durably(file, text.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("yavin-config-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_write_replaces_the_previous_contents_and_leaves_nothing_beside_it() {
        let dir = temp("replace");
        let file = dir.join("thing.json");
        write_atomically(&file, "first").unwrap();
        write_atomically(&file, "second").unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "second");
        let names: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["thing.json".to_string()]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_write_leaves_the_previous_contents_and_no_temporary_file() {
        // A directory where the file should be is the portable way to make the rename fail.
        let dir = temp("failure");
        let file = dir.join("thing.json");
        fs::create_dir_all(&file).unwrap();
        assert!(write_atomically(&file, "new contents").is_err());
        assert!(file.is_dir(), "the target is untouched");
        assert!(
            !dir.join("thing.writing").exists(),
            "no temporary file is left"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_directory_is_created_when_it_is_not_there_yet() {
        // A first run has no config directory at all.
        let dir = temp("fresh");
        let file = dir.join("nested").join("thing.json");
        write_atomically(&file, "contents").unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "contents");
        let _ = fs::remove_dir_all(&dir);
    }
}
