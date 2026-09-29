//! A Local Git restore in a project that is also a real Git repository: the working tree
//! changes, and `.git` -- HEAD, the index, every file in it -- does not.

use super::tests::{listing, put, setup};
use super::*;
use std::process::Command;

fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        // Read-only status: no index refresh written back.
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .ok()?;
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Every file under `.git`: its bytes and modification time.
fn fingerprint(git_dir: &Path) -> Vec<(String, Vec<u8>, std::time::SystemTime)> {
    listing(git_dir)
        .into_iter()
        .filter(|(name, _)| !name.ends_with('/'))
        .map(|(name, bytes)| {
            let modified = fs::metadata(git_dir.join(&name))
                .unwrap()
                .modified()
                .unwrap();
            (name, bytes, modified)
        })
        .collect()
}

#[test]
fn a_restore_never_touches_real_git() {
    let s = setup("realgit");
    if git(&s.project, &["--version"]).is_none() {
        eprintln!("git is not installed: skipping");
        return;
    }
    git(&s.project, &["init", "-q", "-b", "main"]).unwrap();
    git(&s.project, &["config", "user.email", "t@yavin"]).unwrap();
    git(&s.project, &["config", "user.name", "T"]).unwrap();
    git(&s.project, &["config", "core.autocrlf", "false"]).unwrap();
    put(&s.p("a.txt"), "one\n");
    put(&s.p("b.txt"), "two\n");
    git(&s.project, &["add", "."]).unwrap();
    git(&s.project, &["commit", "-q", "-m", "first"]).unwrap();
    let clean_status = git(&s.project, &["status", "--porcelain"]).unwrap();
    // Local Git's commit of the same state.
    let target = s.commit();
    // The working tree moves on.
    put(&s.p("a.txt"), "one, edited\n");
    fs::remove_file(s.p("b.txt")).unwrap();
    put(&s.p("c.txt"), "new\n");
    assert_ne!(
        git(&s.project, &["status", "--porcelain"]).unwrap(),
        clean_status
    );

    let git_before = fingerprint(&s.p(".git"));
    let head_before = git(&s.project, &["rev-parse", "HEAD"]).unwrap();
    let index_before = fs::read(s.p(".git/index")).unwrap();

    let plan = s.plan(target, None);
    assert!(plan
        .operations
        .iter()
        .all(|op| !op.path.split('/').any(|n| n.eq_ignore_ascii_case(".git"))));
    assert!(matches!(s.run(&plan), Outcome::Done { .. }));
    assert!(s.verify(&plan).matches);

    // The working tree is Git's again...
    assert_eq!(
        git(&s.project, &["status", "--porcelain"]).unwrap(),
        clean_status
    );
    // ...and nothing of Git's was touched.
    assert_eq!(fingerprint(&s.p(".git")), git_before, ".git changed");
    assert_eq!(
        git(&s.project, &["rev-parse", "HEAD"]).unwrap(),
        head_before
    );
    assert_eq!(fs::read(s.p(".git/index")).unwrap(), index_before);
}
