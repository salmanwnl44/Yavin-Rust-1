//! Comparing folder paths.
//!
//! Two spellings of the same folder reach Yavin all the time -- a path typed with backslashes
//! and one handed back by a dialog, `C:\Work` and `c:/work` -- and anything that remembers a
//! decision or a session per folder has to treat those as one folder. Shared so that the
//! session and trust stores cannot disagree about what "the same folder" means.

use ide_workspace::file_tree::clean_path_str;
use std::path::Path;

/// A comparison key for a path: lowercased, `/` separators, no trailing separator. Case is
/// folded because Windows and macOS both hand back either case for the same folder; on a
/// case-sensitive filesystem this makes two genuinely different folders compare equal, which
/// costs a needlessly shared session entry and never anything worse.
///
/// The extended-length prefix is removed first (`clean_path_str`), because the two forms
/// both occur for one folder: `canonicalize` produces `\\?\C:\Work`, which is what the trust
/// store records for the open workspace, while the UI only ever sees and sends `C:/Work`.
/// Keyed with the prefix, forgetting a trusted folder from the UI matched nothing.
///
/// The UI folds the same way (`src/services/paths.ts`), and the two have to agree exactly: a
/// folder the UI counts as one entry and this counts as two shows a recent entry that comes
/// back after being removed, and a trust decision that does not cover what it appears to.
/// Both are tested against `src/services/folderKeys.fixtures.json`.
pub fn normalise(path: &Path) -> String {
    let key = clean_path_str(path).to_lowercase();
    let trimmed = key.trim_end_matches('/');
    // A path of nothing but separators is the root, not the empty string: an empty key is a
    // prefix of every path, which in the trust store would read as trusting the whole machine.
    if trimmed.is_empty() {
        "/".into()
    } else {
        trimmed.into()
    }
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
    fn a_trailing_separator_does_not_make_a_second_folder() {
        // The UI strips them, so this has to as well: otherwise one folder to the user is
        // two entries here, and removing the one they can see leaves the other behind.
        assert_eq!(
            normalise(Path::new("/work/project/")),
            normalise(Path::new("/work/project"))
        );
        assert_eq!(
            normalise(Path::new(r"C:\Work\")),
            normalise(Path::new("c:/work"))
        );
    }

    #[test]
    fn a_path_of_nothing_but_separators_is_the_root_rather_than_empty() {
        // An empty key is a prefix of every path, which in the trust store would read as a
        // decision covering the whole machine.
        assert_eq!(normalise(Path::new("/")), "/");
        assert_eq!(normalise(Path::new("//")), "/");
    }

    #[test]
    fn the_extended_length_form_has_the_same_key_as_the_plain_one() {
        assert_eq!(
            normalise(Path::new(r"\\?\C:\Work\Project")),
            normalise(Path::new("C:/Work/Project"))
        );
        assert_eq!(
            normalise(Path::new(r"\\?\UNC\server\share\project")),
            normalise(Path::new(r"\\server\share\project"))
        );
    }

    #[test]
    fn keys_match_the_fixture_the_ui_folder_key_is_checked_against() {
        #[derive(serde::Deserialize)]
        struct Case {
            input: String,
            key: String,
        }
        let cases: Vec<Case> =
            serde_json::from_str(include_str!("../../src/services/folderKeys.fixtures.json"))
                .expect("the fixture is valid JSON");
        assert!(!cases.is_empty());
        for case in cases {
            assert_eq!(
                normalise(Path::new(&case.input)),
                case.key,
                "{}",
                case.input
            );
        }
    }

    #[test]
    fn different_folders_keep_different_keys() {
        assert_ne!(
            normalise(Path::new("/work/project")),
            normalise(Path::new("/work/project-two"))
        );
    }
}
