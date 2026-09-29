//! Local Git's own code never runs a process (no `git`, nothing else), never names `.git`
//! except to leave it out of snapshots, and never reads Git's ignore rules or configuration:
//! the separation from real Git is structural, not a matter of being careful.

use std::fs;

/// The one place `.git` may be named: the rule that leaves it out of every snapshot.
const GIT_RULE: &str = r#"name.eq_ignore_ascii_case(".git")"#;

#[test]
fn the_crate_never_runs_a_process_or_touches_dot_git() {
    let src = concat!(env!("CARGO_MANIFEST_DIR"), "/src");
    let mut checked = 0;
    for entry in fs::read_dir(src).unwrap() {
        let path = entry.unwrap().path();
        let text = fs::read_to_string(&path).unwrap();
        // Code only: comments may explain what the crate does not do, and unit tests may build
        // paths containing `.git` to prove it is left out.
        let text = match text.find("#[cfg(test)]\nmod tests") {
            Some(at) => &text[..at],
            None => &text[..],
        };
        let mut code: String = text
            .lines()
            .filter(|line| !line.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        if path.ends_with("exclude.rs") {
            assert_eq!(code.matches(GIT_RULE).count(), 1, "the .git rule moved");
            code = code.replace(GIT_RULE, "");
        }
        for forbidden in [
            "Command::new",
            "process::Command",
            r#"".git"#,
            "/.git",
            r"\\.git",
            // Git's ignore rules and configuration are never read: not `.gitignore`, not
            // `.git/info/exclude`, not `core.excludesFile`, not the global ignore file. (The
            // `ignore` crate's pattern compiler is used only on `.yavinignore` text.)
            ".gitignore",
            "excludesfile",
            "excludesFile",
            "info/exclude",
            "WalkBuilder",
            "git_global",
            "git_exclude",
            "add_ignore",
            "builder.add(",
            "GIT_CONFIG",
        ] {
            assert!(
                !code.contains(forbidden),
                "{} contains {forbidden:?}",
                path.display()
            );
        }
        checked += 1;
    }
    assert!(checked >= 14, "only {checked} files were scanned");
}
