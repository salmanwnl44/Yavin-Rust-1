//! Local Git never touches real Git. A real repository -- commits, a branch, a modified file --
//! is fingerprinted (every file under `.git`: content hash and modification time, plus
//! `git status --porcelain`), Local Git is used against the same project, and everything must
//! be exactly as it was, with nothing new anywhere in the project.
//!
//! The test drives `git` itself to build the repository and read its status; Local Git's own
//! code never runs it (see `source_scan.rs`). Skipped, with a message, where `git` is missing.

mod common;

use common::*;
use ide_localgit::*;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::Path;
use std::process::Command;

fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        // A read-only status: no index refresh written back.
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

fn fingerprint(git_dir: &Path) -> BTreeMap<String, (String, std::time::SystemTime)> {
    let mut out = BTreeMap::new();
    for name in listing(git_dir) {
        if name.ends_with('/') {
            continue;
        }
        let path = git_dir.join(&name);
        let bytes = std::fs::read(&path).unwrap();
        let hash: String = Sha256::digest(&bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        out.insert(name, (hash, modified));
    }
    out
}

#[test]
fn using_local_git_leaves_a_real_git_repository_exactly_as_it_was() {
    let f = Fixture::new("realgit");
    if git(&f.project, &["--version"]).is_none() {
        eprintln!("git is not installed: skipping the real-Git non-interference test");
        return;
    }
    git(&f.project, &["init", "-q", "-b", "main"]).unwrap();
    git(&f.project, &["config", "user.email", "t@yavin"]).unwrap();
    git(&f.project, &["config", "user.name", "T"]).unwrap();
    git(&f.project, &["config", "core.autocrlf", "false"]).unwrap();
    std::fs::write(f.project.join("a.txt"), "one\n").unwrap();
    std::fs::write(f.project.join("b.txt"), "two\n").unwrap();
    git(&f.project, &["add", "."]).unwrap();
    git(&f.project, &["commit", "-q", "-m", "first"]).unwrap();
    git(&f.project, &["branch", "feature"]).unwrap();
    std::fs::write(f.project.join("a.txt"), "one, edited\n").unwrap();
    std::fs::write(f.project.join("new.txt"), "untracked\n").unwrap();

    let status_before = git(&f.project, &["status", "--porcelain"]).unwrap();
    let git_before = fingerprint(&f.project.join(".git"));
    let project_before = listing(&f.project);
    assert!(!git_before.is_empty());

    // Use Local Git on this project: store its files' contents, commit, move refs, reopen.
    let mut repo = f.open().unwrap();
    let folder = FolderId::new(&repo.meta().folders[0].folder_id).unwrap();
    let workspace = repo.meta().workspace.clone();
    let mut txn = repo.begin_write().unwrap();
    let mut entries = Vec::new();
    for name in ["a.txt", "b.txt", "new.txt"] {
        let bytes = std::fs::read(f.project.join(name)).unwrap();
        entries.push(TreeEntry {
            name: EntryName::new(name).unwrap(),
            kind: EntryKind::File {
                executable: false,
                stored: Stored::Yes,
            },
            id: txn.put_blob(&bytes).unwrap(),
        });
    }
    let tree = txn.put_tree(&Tree::new(entries).unwrap()).unwrap();
    let root = txn
        .put_root(&Root {
            folders: [(folder, tree)].into_iter().collect(),
        })
        .unwrap();
    let commit = txn
        .put_commit(&Commit {
            root,
            disk_root: None,
            parents: vec![],
            workspace,
            author: Author {
                name: "T".into(),
                id: "t@yavin".into(),
            },
            time_ms: 0,
            tz_offset_min: 0,
            source: Source::Human,
            meta: BTreeMap::new(),
            meta_objects: BTreeMap::new(),
            message: "local only".into(),
        })
        .unwrap();
    txn.commit().unwrap();
    advance(&mut repo, commit);
    assert!(repo.verify(true).is_empty());
    drop(repo);
    drop(f.open().unwrap());

    assert_eq!(
        fingerprint(&f.project.join(".git")),
        git_before,
        ".git changed"
    );
    assert_eq!(
        git(&f.project, &["status", "--porcelain"]).unwrap(),
        status_before
    );
    assert_eq!(
        listing(&f.project),
        project_before,
        "files appeared in the project"
    );
    // And the store is where it should be: outside the project.
    assert!(!f.store().starts_with(&f.project));
}

#[test]
fn snapshots_and_status_leave_a_real_git_repository_exactly_as_it_was() {
    let f = Fixture::new("realgit-snap");
    if git(&f.project, &["--version"]).is_none() {
        eprintln!("git is not installed: skipping the real-Git non-interference test");
        return;
    }
    git(&f.project, &["init", "-q", "-b", "main"]).unwrap();
    git(&f.project, &["config", "user.email", "t@yavin"]).unwrap();
    git(&f.project, &["config", "user.name", "T"]).unwrap();
    git(&f.project, &["config", "core.autocrlf", "false"]).unwrap();
    // Git ignores these; Local Git must not.
    write(&f.project.join(".gitignore"), "ignored-by-git.txt\nlogs/\n");
    write(
        &f.project.join(".git/info/exclude"),
        "excluded-by-git.txt\n",
    );
    write(&f.project.join("tracked.txt"), "tracked\n");
    git(&f.project, &["add", "."]).unwrap();
    git(&f.project, &["commit", "-q", "-m", "first"]).unwrap();
    write(&f.project.join("tracked.txt"), "tracked, edited\n");
    write(&f.project.join("ignored-by-git.txt"), "ignored\n");
    write(&f.project.join("excluded-by-git.txt"), "excluded\n");
    write(&f.project.join("logs/today.log"), "log\n");

    let status_before = git(&f.project, &["status", "--porcelain", "--ignored"]).unwrap();
    let git_before = fingerprint(&f.project.join(".git"));
    let project_before = listing(&f.project);

    let repo = std::sync::Mutex::new(f.open().unwrap());
    let engine = engine_for(&repo, &f.project);
    let first = persist(&engine, &repo);
    commit_root(&repo, first.disk_root.0);
    write(&f.project.join("untracked-by-both.txt"), "new\n");
    let after_write = listing(&f.project);
    let status = status(&engine, &repo);
    snapshot_mode(&engine, &repo, RequestedMode::Verify);
    let overlaid = try_snapshot(
        &engine,
        &repo,
        &SnapshotRequest {
            persist: true,
            overlays: vec![OverlayInput {
                path: ide_workspace::file_tree::clean_path_str(f.project.join("tracked.txt")),
                bytes: std::sync::Arc::new(b"unsaved\n".to_vec()),
                encoding: "utf8".into(),
                line_ending: "lf".into(),
                version: 2,
            }],
            ..Default::default()
        },
    )
    .unwrap();
    assert_ne!(overlaid.effective_root, overlaid.disk_root);
    assert!(repo.lock().unwrap().verify(true).is_empty());

    // Everything Git ignores is in Local Git's snapshot; nothing of .git is.
    let listed = disk_listing(&repo, &first);
    for path in [
        ".gitignore",
        "tracked.txt",
        "ignored-by-git.txt",
        "excluded-by-git.txt",
        "logs/today.log",
    ] {
        assert!(listed.contains_key(path), "{path} missing from {listed:?}");
    }
    assert!(listed.keys().all(|path| !path.starts_with(".git/")));
    assert_eq!(status.entries.len(), 1);
    assert_eq!(status.entries[0].path, "untracked-by-both.txt");

    // Real Git sees exactly what it saw, and nothing was written into the project.
    std::fs::remove_file(f.project.join("untracked-by-both.txt")).unwrap();
    assert_eq!(
        fingerprint(&f.project.join(".git")),
        git_before,
        ".git changed"
    );
    assert_eq!(
        git(&f.project, &["status", "--porcelain", "--ignored"]).unwrap(),
        status_before
    );
    assert_eq!(listing(&f.project), project_before);
    assert_eq!(after_write.len(), project_before.len() + 1);
}
