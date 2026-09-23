//! Comparing folder paths.
//!
//! Two spellings of the same folder reach Yavin all the time -- a path typed with backslashes
//! and one handed back by a dialog, `C:\Work` and `c:/work` -- and anything that remembers a
//! decision or a session per folder has to treat those as one folder. Shared so that the
//! session and trust stores cannot disagree about what "the same folder" means.

use std::path::Path;

/// A comparison key for a path: lowercased, with `/` separators. Case is folded because
/// Windows and macOS both hand back either case for the same folder; on a case-sensitive
/// filesystem this makes two genuinely different folders compare equal, which costs a
/// needlessly shared session entry and never anything worse.
pub fn normalise(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_same_folder_spelled_differently_has_the_same_key() {
        assert_eq!(
            normalise(Path::new("C:\\Work\\Project")),
            normalise(Path::new("c:/work/project"))
        );
    }

    #[test]
    fn different_folders_keep_different_keys() {
        assert_ne!(
            normalise(Path::new("/work/project")),
            normalise(Path::new("/work/project-two"))
        );
    }
}
