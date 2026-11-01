//! What a snapshot leaves out. Local Git owns these rules; they are **not** Git's.
//!
//! Nothing here reads `.gitignore`, `.git/info/exclude`, `core.excludesFile` or any Git
//! configuration, so what Local Git records never depends on real Git's files or settings.
//! In order, the first rule that decides wins:
//!
//! 1. `.git` -- a directory or a file (a worktree's gitfile), at any depth, in any letter
//!    case -- is always left out. Nothing re-includes it.
//! 2. `.yavinignore` files, the deepest directory's first: within a file the last matching
//!    line decides (gitignore syntax: `*`, `**`, a trailing `/` for directories only, a
//!    leading `/` to anchor, `!` to re-include). A directory left out is not entered, so
//!    nothing inside it can be re-included -- the same rule gitignore syntax has.
//! 3. The built-in list (`BUILTIN_PATTERNS`), lowest precedence: `!node_modules/` in a
//!    `.yavinignore` brings `node_modules` back.
//!
//! Patterns match case-sensitively on every platform, so one set of files gives one snapshot
//! wherever it is taken; `.git` alone is matched in any case, because `.GIT` is the same
//! directory on Windows.

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use ignore::Match;
use std::path::Path;
use std::sync::Arc;

/// The name of Local Git's own ignore file.
pub const YAVINIGNORE: &str = ".yavinignore";

/// What is left out when nothing says otherwise, and why:
///
/// | Pattern          | Why                                                          |
/// | ---------------- | ------------------------------------------------------------ |
/// | `node_modules/`  | installed packages: huge, and restored by the package manager |
/// | `target/`        | Rust (and Maven) build output                                |
/// | `__pycache__/`   | Python bytecode caches                                       |
/// | `.venv/`         | Python virtual environments                                  |
/// | `.gradle/`       | Gradle caches                                                |
/// | `.next/`, `.nuxt/`, `.turbo/` | framework build caches                          |
/// | `.env`, `.env.*` | secrets: never copied into history by default                |
/// | `.DS_Store`, `Thumbs.db` | operating-system clutter                              |
///
/// `dist/`, `build/`, `out/` and `obj/` are deliberately not here: without `.gitignore` they
/// may be source, so a `.yavinignore` decides.
pub const BUILTIN_PATTERNS: &[&str] = &[
    "node_modules/",
    "target/",
    "__pycache__/",
    ".venv/",
    ".gradle/",
    ".next/",
    ".nuxt/",
    ".turbo/",
    ".env",
    ".env.*",
    ".DS_Store",
    "Thumbs.db",
];

/// Whether `name` is a `.git` entry, which is never recorded.
pub fn is_git(name: &str) -> bool {
    name.eq_ignore_ascii_case(".git")
}

/// A `.yavinignore` line that is not a valid pattern: reported, and skipped.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct BadPattern {
    pub line: usize,
    pub detail: String,
}

/// One directory's `.yavinignore`, compiled against that directory.
#[derive(Debug)]
pub struct IgnoreFile {
    matcher: Gitignore,
}

impl IgnoreFile {
    /// Compiles `text` (a `.yavinignore` in `dir`). Invalid lines are skipped and returned.
    pub fn parse(dir: &Path, text: &str) -> (IgnoreFile, Vec<BadPattern>) {
        let mut builder = GitignoreBuilder::new(dir);
        let mut bad = Vec::new();
        for (index, line) in text.lines().enumerate() {
            if let Err(error) = builder.add_line(None, line) {
                bad.push(BadPattern {
                    line: index + 1,
                    detail: error.to_string(),
                });
            }
        }
        let matcher = builder.build().unwrap_or_else(|_| Gitignore::empty());
        (IgnoreFile { matcher }, bad)
    }
}

/// The rules in force in one directory: the built-ins plus every `.yavinignore` from the
/// folder's root down to it. Cheap to extend for a subdirectory (shared, reference-counted).
#[derive(Clone, Debug)]
pub struct Rules {
    builtin: Arc<Gitignore>,
    /// Outermost first.
    files: Vec<Arc<IgnoreFile>>,
}

impl Rules {
    /// The rules at a folder's root, before its own `.yavinignore`.
    pub fn for_folder(root: &Path) -> Rules {
        let mut builder = GitignoreBuilder::new(root);
        for pattern in BUILTIN_PATTERNS {
            builder
                .add_line(None, pattern)
                .expect("the built-in patterns are valid");
        }
        Rules {
            builtin: Arc::new(builder.build().expect("the built-in patterns compile")),
            files: Vec::new(),
        }
    }

    /// The rules inside a directory that has its own `.yavinignore`.
    pub fn with(&self, file: IgnoreFile) -> Rules {
        let mut files = self.files.clone();
        files.push(Arc::new(file));
        Rules {
            builtin: self.builtin.clone(),
            files,
        }
    }

    /// Whether the entry at `path` (named `name`) is left out.
    pub fn excludes(&self, path: &Path, name: &str, is_dir: bool) -> bool {
        if is_git(name) {
            return true;
        }
        for file in self.files.iter().rev() {
            match file.matcher.matched(path, is_dir) {
                Match::Ignore(_) => return true,
                Match::Whitelist(_) => return false,
                Match::None => {}
            }
        }
        matches!(self.builtin.matched(path, is_dir), Match::Ignore(_))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn built_ins_apply_at_any_depth_and_a_yavinignore_can_bring_them_back() {
        let root = Path::new("/w");
        let rules = Rules::for_folder(root);
        assert!(rules.excludes(Path::new("/w/node_modules"), "node_modules", true));
        assert!(rules.excludes(Path::new("/w/a/b/node_modules"), "node_modules", true));
        // `node_modules/` is a directory pattern: a file of that name is kept.
        assert!(!rules.excludes(Path::new("/w/node_modules"), "node_modules", false));
        assert!(rules.excludes(Path::new("/w/.env"), ".env", false));
        assert!(rules.excludes(Path::new("/w/sub/.env.local"), ".env.local", false));
        assert!(!rules.excludes(Path::new("/w/.envrc"), ".envrc", false));
        assert!(!rules.excludes(Path::new("/w/dist"), "dist", true));
        assert!(!rules.excludes(Path::new("/w/build"), "build", true));
        // Case-sensitive, so the same files give the same snapshot on every platform.
        assert!(!rules.excludes(Path::new("/w/Node_Modules"), "Node_Modules", true));

        let (file, bad) = IgnoreFile::parse(root, "!node_modules/\n*.log\n!keep.log\n");
        assert!(bad.is_empty());
        let rules = rules.with(file);
        assert!(!rules.excludes(Path::new("/w/node_modules"), "node_modules", true));
        assert!(rules.excludes(Path::new("/w/a.log"), "a.log", false));
        assert!(!rules.excludes(Path::new("/w/keep.log"), "keep.log", false));
    }

    #[test]
    fn dot_git_is_always_left_out_whatever_a_yavinignore_says() {
        let root = Path::new("/w");
        let (file, _) = IgnoreFile::parse(root, "!.git\n!.git/\n!**/.git\n");
        let rules = Rules::for_folder(root).with(file);
        assert!(rules.excludes(Path::new("/w/.git"), ".git", true));
        assert!(rules.excludes(Path::new("/w/.git"), ".git", false));
        assert!(rules.excludes(Path::new("/w/sub/.GIT"), ".GIT", true));
    }

    #[test]
    fn a_deeper_yavinignore_overrides_a_shallower_one() {
        let root = Path::new("/w");
        let (top, _) = IgnoreFile::parse(root, "*.tmp\n");
        let (inner, _) = IgnoreFile::parse(Path::new("/w/keep"), "!*.tmp\n");
        let outer = Rules::for_folder(root).with(top);
        assert!(outer.excludes(Path::new("/w/a.tmp"), "a.tmp", false));
        let deeper = outer.with(inner);
        assert!(!deeper.excludes(Path::new("/w/keep/a.tmp"), "a.tmp", false));
    }

    #[test]
    fn anchored_and_directory_only_patterns() {
        let root = Path::new("/w");
        let (file, bad) = IgnoreFile::parse(root, "/out\nlogs/\n# a comment\n\n");
        assert!(bad.is_empty());
        let rules = Rules::for_folder(root).with(file);
        assert!(rules.excludes(Path::new("/w/out"), "out", true));
        assert!(!rules.excludes(Path::new("/w/src/out"), "out", true));
        assert!(rules.excludes(Path::new("/w/src/logs"), "logs", true));
        assert!(!rules.excludes(Path::new("/w/src/logs"), "logs", false));
    }

    #[test]
    fn an_invalid_line_is_reported_and_the_rest_still_apply() {
        let root = Path::new("/w");
        let (file, bad) = IgnoreFile::parse(root, "*.log\n[z-a\n*.bak\n");
        assert_eq!(bad.len(), 1);
        assert_eq!(bad[0].line, 2);
        let rules = Rules::for_folder(root).with(file);
        assert!(rules.excludes(Path::new("/w/x.log"), "x.log", false));
        assert!(rules.excludes(Path::new("/w/x.bak"), "x.bak", false));
    }
}
