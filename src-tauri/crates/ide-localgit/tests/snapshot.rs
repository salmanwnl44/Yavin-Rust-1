//! LG-02: snapshots of what is on disk -- what is recorded, how, and what is left out.

mod common;

use common::*;
use ide_localgit::fault::read_hook;
use ide_localgit::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

const MIB: u64 = 1024 * 1024;

fn setup(label: &str) -> (Fixture, Mutex<Repository>, SnapshotEngine) {
    let f = Fixture::new(label);
    let repo = Mutex::new(f.open().unwrap());
    let engine = engine_for(&repo, &f.project);
    (f, repo, engine)
}

#[test]
fn an_empty_folder_is_the_empty_tree() {
    let (_f, repo, engine) = setup("snap-empty");
    let snap = persist(&engine, &repo);
    assert_eq!(snap.disk_root, snap.effective_root);
    let repo = repo.lock().unwrap();
    let tree = folder_tree(&repo, snap.disk_root.0);
    assert_eq!(tree, Tree::default().id());
    assert!(snap.problems.is_empty());
}

#[test]
fn files_directories_and_names_are_recorded_exactly() {
    let (f, repo, engine) = setup("snap-basics");
    let p = &f.project;
    write(&p.join("one.txt"), "one\n");
    write(&p.join("src/lib/deep.rs"), "fn main() {}\n");
    std::fs::create_dir_all(p.join("empty/inner-empty")).unwrap();
    let binary: Vec<u8> = (0..=255u8).cycle().take(10_000).collect();
    write(&p.join("image.bin"), &binary);
    write(&p.join("Ünïcödé ñame.md"), "u");
    write(&p.join("emoji 🚀✨.txt"), "e");
    let long = "l".repeat(200) + ".txt";
    write(&p.join(&long), "long");
    write(&p.join("ReadMe.MD"), "case kept");
    write(&p.join("crlf.txt"), "a\r\nb\r\n");

    let snap = persist(&engine, &repo);
    assert!(snap.problems.is_empty(), "{:?}", snap.problems);
    let listing = disk_listing(&repo, &snap);
    let file = |bytes: &[u8]| format!("file {}", blob_id(bytes));
    assert_eq!(listing["one.txt"], file(b"one\n"));
    assert_eq!(listing["src"], "dir");
    assert_eq!(listing["src/lib"], "dir");
    assert_eq!(listing["src/lib/deep.rs"], file(b"fn main() {}\n"));
    assert_eq!(listing["empty"], "dir");
    assert_eq!(listing["empty/inner-empty"], "dir");
    assert_eq!(listing["image.bin"], file(&binary));
    assert_eq!(listing["Ünïcödé ñame.md"], file(b"u"));
    assert_eq!(listing["emoji 🚀✨.txt"], file(b"e"));
    assert_eq!(listing[&long], file(b"long"));
    assert_eq!(listing["ReadMe.MD"], file(b"case kept"));
    // Bytes as they are: line endings are never normalised.
    assert_eq!(listing["crlf.txt"], file(b"a\r\nb\r\n"));
    assert_eq!(listing.len(), 12);
    // The stored content reads back byte for byte.
    let repo = repo.lock().unwrap();
    assert_eq!(repo.read_blob(&blob_id(&binary), u64::MAX).unwrap(), binary);
}

#[test]
fn the_same_state_always_gives_the_same_ids() {
    let (f, repo, engine) = setup("snap-determinism");
    let p = &f.project;
    for i in 0..40 {
        write(
            &p.join(format!("d{}/f{i}.txt", i % 7)),
            format!("content {i}"),
        );
    }
    std::fs::create_dir_all(p.join("d9/empty")).unwrap();
    let first = persist(&engine, &repo);
    let second = persist(&engine, &repo);
    let ephemeral = snapshot(&engine, &repo);
    let verified = snapshot_mode(&engine, &repo, RequestedMode::Verify);
    // Another engine, with no cache and no history, agrees.
    let fresh = engine_for(&repo, &f.project);
    let other = snapshot(&fresh, &repo);
    for snap in [&second, &ephemeral, &verified, &other] {
        assert_eq!(snap.disk_root, first.disk_root);
        assert_eq!(snap.folders[0].disk_tree, first.folders[0].disk_tree);
    }
    assert_eq!(verified.mode, ScanMode::Verify);
    assert_eq!(verified.stats.cache_hits, 0);
}

#[test]
fn a_second_full_scan_hashes_only_what_the_cache_cannot_vouch_for() {
    let (f, repo, engine) = setup("snap-cache");
    for i in 0..20 {
        let path = f.project.join(format!("f{i}.txt"));
        write(&path, format!("{i}"));
        age(&path);
    }
    write(&f.project.join("fresh.txt"), "just written");
    let first = snapshot_mode(&engine, &repo, RequestedMode::Full);
    assert_eq!(first.stats.files_hashed, 21);
    let second = snapshot_mode(&engine, &repo, RequestedMode::Full);
    assert_eq!(second.disk_root, first.disk_root);
    // The aged files are trusted; the one written moments ago is hashed again (racy).
    assert_eq!(second.stats.cache_hits, 20);
    assert_eq!(second.stats.files_hashed, 1);
    // The cache survives the store closing (it is on disk), and is only an optimisation.
    drop(engine);
    let reopened = engine_for(&repo, &f.project);
    let third = snapshot_mode(&reopened, &repo, RequestedMode::Full);
    assert_eq!(third.disk_root, first.disk_root);
    assert_eq!(third.stats.cache_hits, 20);
    // A damaged cache is ignored, never trusted.
    let cache = f.store().join("cache");
    for entry in std::fs::read_dir(&cache).unwrap() {
        let path = entry.unwrap().path();
        let mut bytes = std::fs::read(&path).unwrap();
        let middle = bytes.len() / 2;
        bytes[middle] ^= 0xff;
        std::fs::write(&path, bytes).unwrap();
    }
    let again = engine_for(&repo, &f.project);
    let fourth = snapshot_mode(&again, &repo, RequestedMode::Full);
    assert_eq!(fourth.disk_root, first.disk_root);
    assert_eq!(fourth.stats.cache_hits, 0);
}

#[test]
fn a_file_changed_behind_an_unchanged_modification_time_is_caught_when_racy() {
    // Written and then rewritten at once, with the same size: only the racy rule saves it.
    let (f, repo, engine) = setup("snap-racy");
    let path = f.project.join("a.txt");
    write(&path, "aaaa");
    let first = snapshot_mode(&engine, &repo, RequestedMode::Full);
    let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
    write(&path, "bbbb");
    std::fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(modified)
        .unwrap();
    let second = snapshot_mode(&engine, &repo, RequestedMode::Full);
    assert_ne!(second.disk_root, first.disk_root);
}

#[test]
fn files_over_the_limit_are_hashed_but_not_stored() {
    let (f, repo, engine) = setup("snap-large");
    let limit = DEFAULT_MAX_BLOB_BYTES;
    assert_eq!(limit, 20 * MIB);
    let body = |len: u64| -> Vec<u8> { (0..len).map(|i| (i % 251) as u8).collect() };
    let below = body(limit - 1);
    let exactly = body(limit);
    let above = body(limit + 1);
    write(&f.project.join("below.bin"), &below);
    write(&f.project.join("exactly.bin"), &exactly);
    write(&f.project.join("above.bin"), &above);
    let before = repo.lock().unwrap().storage_bytes();
    let snap = persist(&engine, &repo);
    let listing = disk_listing(&repo, &snap);
    assert_eq!(listing["below.bin"], format!("file {}", blob_id(&below)));
    assert_eq!(
        listing["exactly.bin"],
        format!("file {}", blob_id(&exactly))
    );
    // The id is the content's own: computed here without the snapshot code.
    assert_eq!(
        listing["above.bin"],
        format!("unstored {} {}", limit + 1, blob_id(&above))
    );
    let repo = repo.lock().unwrap();
    assert!(!repo.contains(&blob_id(&above)));
    assert!(matches!(
        repo.read_blob(&blob_id(&above), u64::MAX),
        Err(LgError::MissingObject(_))
    ));
    // Two files of 20 MiB stored; the third added nothing but its entry.
    let grown = repo.storage_bytes() - before;
    assert!(grown < 2 * limit + MIB, "grew by {grown}");
    assert!(grown > 2 * limit);
}

#[test]
fn links_are_recorded_and_never_followed() {
    let (f, repo, engine) = setup("snap-links");
    let p = &f.project;
    write(&p.join("real/inside.txt"), "behind the link");
    let outside = f.base.parent().unwrap().join("outside");
    write(&outside.join("secret.txt"), "never read");

    let mut made = Vec::new();
    #[cfg(windows)]
    {
        // A junction needs no privilege.
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(p.join("junction"))
            .arg(&outside)
            .output()
            .unwrap();
        assert!(status.status.success(), "{status:?}");
        made.push("junction");
        // A junction to nowhere, and one back to the project itself (a loop if followed).
        for (link, target) in [
            (p.join("broken-junction"), p.join("does-not-exist")),
            (p.join("real/loop-junction"), p.clone()),
        ] {
            let made_link = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(&link)
                .arg(&target)
                .output()
                .unwrap();
            assert!(made_link.status.success(), "{made_link:?}");
        }
        made.push("junction-edges");
        // Symbolic links need Developer Mode or elevation; tested when available.
        if std::os::windows::fs::symlink_dir(&outside, p.join("dirlink")).is_ok() {
            made.push("dirlink");
            std::os::windows::fs::symlink_file(p.join("missing.txt"), p.join("broken")).unwrap();
            made.push("broken");
            std::os::windows::fs::symlink_dir(p, p.join("real/loop")).unwrap();
            made.push("loop");
        } else {
            eprintln!("symbolic links unavailable (no Developer Mode): junctions only");
        }
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&outside, p.join("dirlink")).unwrap();
        std::os::unix::fs::symlink("missing.txt", p.join("broken")).unwrap();
        std::os::unix::fs::symlink("..", p.join("real/loop")).unwrap();
        made.extend(["dirlink", "broken", "loop"]);
    }

    let snap = persist(&engine, &repo);
    assert!(snap.problems.is_empty(), "{:?}", snap.problems);
    let listing = disk_listing(&repo, &snap);
    // Nothing behind any link was read.
    assert!(
        listing.keys().all(|path| !path.contains("secret")),
        "{listing:?}"
    );
    assert!(!listing.contains_key("real/loop/real"));
    if made.contains(&"junction") {
        let junction = &listing["junction"];
        assert!(junction.starts_with("link:Junction "), "{junction}");
        assert!(junction.ends_with("outside"), "{junction}");
    }
    if made.contains(&"junction-edges") {
        let broken = &listing["broken-junction"];
        assert!(broken.starts_with("link:Junction ") && broken.ends_with("does-not-exist"));
        assert!(listing["real/loop-junction"].starts_with("link:Junction "));
        assert!(!listing.contains_key("real/loop-junction/real"));
    }
    if made.contains(&"dirlink") {
        assert!(listing["dirlink"].starts_with(if cfg!(windows) {
            "link:Directory "
        } else {
            "link:File "
        }));
    }
    if made.contains(&"broken") {
        assert!(listing["broken"].starts_with("link:"));
    }
    if made.contains(&"loop") {
        assert!(listing["real/loop"].starts_with("link:"));
    }
    // The same links, the same ids.
    assert_eq!(persist(&engine, &repo).disk_root, snap.disk_root);
}

#[test]
fn a_file_that_changes_once_while_read_is_read_again() {
    let (f, repo, engine) = setup("snap-race-once");
    let path = f.project.join("busy.txt");
    write(&path, "first");
    let changed = Arc::new(AtomicUsize::new(0));
    let counter = changed.clone();
    read_hook::set(&path, move |path, attempt| {
        if attempt == 0 {
            counter.fetch_add(1, Ordering::SeqCst);
            std::fs::write(path, "second, longer").unwrap();
        }
    });
    let snap = persist(&engine, &repo);
    read_hook::clear(&path);
    assert_eq!(changed.load(Ordering::SeqCst), 1);
    assert!(snap.problems.is_empty(), "{:?}", snap.problems);
    assert_eq!(
        disk_listing(&repo, &snap)["busy.txt"],
        format!("file {}", blob_id(b"second, longer"))
    );
}

#[test]
fn a_file_that_keeps_changing_is_unstable_and_carried_forward() {
    let (f, repo, engine) = setup("snap-race-twice");
    let path = f.project.join("busy.txt");
    write(&path, "stable at first");
    let first = persist(&engine, &repo);
    let n = Arc::new(AtomicUsize::new(0));
    let counter = n.clone();
    read_hook::set(&path, move |path, _| {
        let i = counter.fetch_add(1, Ordering::SeqCst);
        std::fs::write(path, format!("changing {i} {}", "x".repeat(i))).unwrap();
    });
    let snap = snapshot_mode(&engine, &repo, RequestedMode::Verify);
    read_hook::clear(&path);
    assert_eq!(n.load(Ordering::SeqCst), 2);
    assert_eq!(
        snap.problems,
        vec![Problem::Unstable {
            folder_id: snap.folders[0].folder_id.clone(),
            path: "busy.txt".into(),
            carried_forward: true,
        }]
    );
    // Its previous content is kept, never recorded as deleted.
    assert_eq!(snap.disk_root, first.disk_root);

    // With nothing to carry forward, it is left out -- and still reported.
    let (g, repo2, engine2) = setup("snap-race-new");
    let path = g.project.join("new.txt");
    write(&path, "new");
    read_hook::set(&path, move |path, attempt| {
        std::fs::write(
            path,
            format!("changing {attempt} {}", "y".repeat(attempt as usize + 1)),
        )
        .unwrap();
    });
    let snap = snapshot(&engine2, &repo2);
    read_hook::clear(&path);
    assert!(matches!(
        snap.problems.as_slice(),
        [Problem::Unstable {
            carried_forward: false,
            ..
        }]
    ));
    let repo2 = repo2.lock().unwrap();
    drop(repo2);
}

#[test]
fn a_file_that_disappears_while_read_is_absent() {
    let (f, repo, engine) = setup("snap-race-gone");
    let path = f.project.join("going.txt");
    write(&path, "here, then not");
    write(&f.project.join("staying.txt"), "stays");
    read_hook::set(&path, |path, _| std::fs::remove_file(path).unwrap());
    let snap = persist(&engine, &repo);
    read_hook::clear(&path);
    assert!(snap.problems.is_empty(), "{:?}", snap.problems);
    let listing = disk_listing(&repo, &snap);
    assert!(!listing.contains_key("going.txt"));
    assert!(listing.contains_key("staying.txt"));
}

#[cfg(windows)]
#[test]
fn a_file_that_cannot_be_read_is_carried_forward_and_reported() {
    use std::os::windows::fs::OpenOptionsExt;
    let (f, repo, engine) = setup("snap-locked");
    let path = f.project.join("locked.txt");
    write(&path, "readable at first");
    let first = persist(&engine, &repo);
    std::fs::write(&path, "changed, then locked").unwrap();
    // Share mode 0: nobody else may open it while this handle lives.
    let _lock = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&path)
        .unwrap();
    let snap = snapshot_mode(&engine, &repo, RequestedMode::Verify);
    assert_eq!(snap.disk_root, first.disk_root);
    assert!(
        matches!(
            snap.problems.as_slice(),
            [Problem::Unreadable {
                carried_forward: true,
                ..
            }]
        ),
        "{:?}",
        snap.problems
    );
}

#[test]
fn dot_git_and_the_built_ins_are_left_out_and_git_ignore_files_mean_nothing() {
    let (f, repo, engine) = setup("snap-exclude");
    let p = &f.project;
    write(&p.join(".git/HEAD"), "ref: refs/heads/main\n");
    write(&p.join(".git/info/exclude"), "src/\n*.txt\n");
    write(&p.join("sub/.git"), "gitdir: ../.git/worktrees/sub\n");
    write(&p.join(".gitignore"), "src/\n*.txt\nkept.log\n");
    write(&p.join("src/main.rs"), "fn main() {}");
    write(&p.join("notes.txt"), "notes");
    write(&p.join("kept.log"), "log");
    write(&p.join("node_modules/pkg/index.js"), "x");
    write(&p.join("app/node_modules/pkg/index.js"), "x");
    write(&p.join("target/debug/app"), "x");
    write(&p.join("__pycache__/m.pyc"), "x");
    write(&p.join(".venv/bin/python"), "x");
    write(&p.join(".gradle/cache"), "x");
    write(&p.join(".next/build"), "x");
    write(&p.join(".nuxt/build"), "x");
    write(&p.join(".turbo/cache"), "x");
    write(&p.join(".env"), "SECRET=1");
    write(&p.join("config/.env.local"), "SECRET=2");
    write(&p.join(".DS_Store"), "x");
    write(&p.join("pics/Thumbs.db"), "x");
    write(&p.join("dist/bundle.js"), "kept: dist may be source");
    write(&p.join("build/out.txt"), "kept");
    write(&p.join(".envrc"), "kept: not .env");

    let snap = persist(&engine, &repo);
    let listing = disk_listing(&repo, &snap);
    let paths: Vec<&str> = listing.keys().map(String::as_str).collect();
    assert_eq!(
        paths,
        vec![
            ".envrc",
            ".gitignore",
            "app",
            "build",
            "build/out.txt",
            "config",
            "dist",
            "dist/bundle.js",
            "kept.log",
            "notes.txt",
            "pics",
            "src",
            "src/main.rs",
            "sub",
        ]
    );
}

#[test]
fn yavinignore_rules_nest_negate_and_never_bring_back_dot_git() {
    let (f, repo, engine) = setup("snap-yavinignore");
    let p = &f.project;
    write(
        &p.join(".yavinignore"),
        "*.log\n!important.log\n/generated/\ncache/\n!node_modules/\n!.git\n[z-a\n",
    );
    write(&p.join("a.log"), "x");
    write(&p.join("important.log"), "kept");
    write(&p.join("generated/g.rs"), "x");
    write(
        &p.join("src/generated/g.rs"),
        "kept: /generated/ is anchored",
    );
    write(&p.join("src/cache/c.bin"), "x");
    write(
        &p.join("src/cache.txt"),
        "kept: cache/ is a directory pattern",
    );
    write(&p.join("node_modules/pkg/index.js"), "kept: re-included");
    write(&p.join(".git/HEAD"), "x");
    write(&p.join("nested/.yavinignore"), "!*.log\n*.tmp\n");
    write(&p.join("nested/n.log"), "kept: the deeper file re-includes");
    write(&p.join("nested/n.tmp"), "x");
    write(&p.join("x.tmp"), "kept: the rule is only nested");

    let snap = persist(&engine, &repo);
    let listing = disk_listing(&repo, &snap);
    let paths: Vec<&str> = listing.keys().map(String::as_str).collect();
    assert_eq!(
        paths,
        vec![
            ".yavinignore",
            "important.log",
            "nested",
            "nested/.yavinignore",
            "nested/n.log",
            "node_modules",
            "node_modules/pkg",
            "node_modules/pkg/index.js",
            "src",
            "src/cache.txt",
            "src/generated",
            "src/generated/g.rs",
            "x.tmp",
        ]
    );
    // The invalid line is reported, with where it is.
    assert!(
        matches!(
            snap.problems.as_slice(),
            [Problem::InvalidIgnorePattern { path, line: 7, .. }] if path == ".yavinignore"
        ),
        "{:?}",
        snap.problems
    );
}

#[test]
fn a_cancelled_snapshot_stops_and_the_next_one_is_full() {
    let (f, repo, engine) = setup("snap-cancel");
    for i in 0..300 {
        write(&f.project.join(format!("d{}/f{i}", i % 10)), "x");
    }
    engine.watcher_status(1, true);
    snapshot(&engine, &repo);
    let cancel = AtomicBool::new(false);
    let result = engine.snapshot(
        &repo,
        &SnapshotRequest {
            mode: RequestedMode::Verify,
            ..Default::default()
        },
        &Control {
            cancel: &cancel,
            // Cancelled as soon as the scan reports it is under way.
            progress: &|_| cancel.store(true, Ordering::SeqCst),
        },
    );
    assert!(matches!(result, Err(LgError::Cancelled)));
    let next = snapshot(&engine, &repo);
    assert_eq!(next.mode, ScanMode::Full);
    assert_eq!(next.full_reason, Some(FullReason::WatcherUnavailable));
}

#[test]
fn progress_is_reported_at_most_ten_times_a_second() {
    let (f, repo, engine) = setup("snap-progress");
    for i in 0..2000 {
        write(&f.project.join(format!("d{}/f{i}", i % 50)), format!("{i}"));
    }
    let reports = Mutex::new(Vec::new());
    let cancel = AtomicBool::new(false);
    let started = std::time::Instant::now();
    let snap = engine
        .snapshot(
            &repo,
            &SnapshotRequest::default(),
            &Control {
                cancel: &cancel,
                progress: &|p| reports.lock().unwrap().push(p.clone()),
            },
        )
        .unwrap();
    let elapsed = started.elapsed().as_millis() as usize;
    let reports = reports.into_inner().unwrap();
    // One at the start and per phase, then no more than one per 100 ms.
    assert!(
        reports.len() <= elapsed / 100 + 4,
        "{} in {elapsed} ms",
        reports.len()
    );
    assert_eq!(reports[0].phase, "scanning");
    assert!(reports.iter().any(|r| r.phase == "overlays"));
    assert_eq!(snap.stats.files, 2000);
}

#[test]
fn a_read_only_store_takes_snapshots_but_cannot_persist_them() {
    let f = Fixture::new("snap-readonly");
    write(&f.project.join("a.txt"), "a");
    let _writer = f.open().unwrap();
    let repo = Mutex::new(f.open_read_only().unwrap());
    let engine = engine_for(&repo, &f.project);
    let snap = snapshot(&engine, &repo);
    assert!(!snap.persisted);
    assert!(matches!(
        try_snapshot(
            &engine,
            &repo,
            &SnapshotRequest {
                persist: true,
                ..Default::default()
            }
        ),
        Err(LgError::ReadOnly)
    ));
}

#[test]
fn nothing_is_ever_written_into_the_project() {
    let (f, repo, engine) = setup("snap-no-writes");
    write(&f.project.join("a.txt"), "a");
    write(&f.project.join("dir/b.txt"), "b");
    let before = listing(&f.project);
    persist(&engine, &repo);
    snapshot_mode(&engine, &repo, RequestedMode::Verify);
    status(&engine, &repo);
    assert_eq!(listing(&f.project), before);
    assert!(!f.store().starts_with(&f.project));
}
