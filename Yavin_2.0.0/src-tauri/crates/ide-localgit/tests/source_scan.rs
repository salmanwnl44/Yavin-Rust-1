//! Local Git's own code never runs a process (no `git`, nothing else) and never names `.git`:
//! the separation from real Git is structural, not a matter of being careful.

use std::fs;

#[test]
fn the_crate_never_runs_a_process_or_touches_dot_git() {
    let src = concat!(env!("CARGO_MANIFEST_DIR"), "/src");
    let mut checked = 0;
    for entry in fs::read_dir(src).unwrap() {
        let path = entry.unwrap().path();
        let text = fs::read_to_string(&path).unwrap();
        // Code only: comments may explain what the crate does not do.
        let code: String = text
            .lines()
            .filter(|line| !line.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        for forbidden in [
            "Command::new",
            "process::Command",
            "\".git",
            "/.git",
            "\\\\.git",
        ] {
            assert!(
                !code.contains(forbidden),
                "{} contains {forbidden:?}",
                path.display()
            );
        }
        checked += 1;
    }
    assert!(checked >= 10, "only {checked} files were scanned");
}
