//! LG-02: status against Local HEAD, on disk and with unsaved documents; overlays.

mod common;

use common::*;
use ide_localgit::*;
use ide_workspace::file_tree::clean_path_str;
use std::path::Path;
use std::sync::{Arc, Mutex};

struct World {
    f: Fixture,
    repo: Mutex<Repository>,
    engine: SnapshotEngine,
}

impl World {
    fn new(label: &str) -> World {
        World::with_limit(label, DEFAULT_MAX_BLOB_BYTES)
    }

    /// A small storage limit, so "over the limit" files are cheap to make.
    fn with_limit(label: &str, max_blob: u64) -> World {
        let f = Fixture::new(label);
        let repo = Mutex::new(f.open().unwrap());
        let engine = engine_with(&repo.lock().unwrap(), &f.project, max_blob);
        World { f, repo, engine }
    }

    fn p(&self, rel: &str) -> std::path::PathBuf {
        self.f.project.join(rel)
    }

    /// Makes what is on disk now Local HEAD.
    fn commit(&self) {
        let snap = persist(&self.engine, &self.repo);
        assert!(snap.problems.is_empty(), "{:?}", snap.problems);
        commit_root(&self.repo, snap.disk_root.0);
    }

    fn status(&self) -> Status {
        status(&self.engine, &self.repo)
    }

    fn status_with(&self, overlays: Vec<OverlayInput>) -> (Snapshot, Status) {
        status_with(
            &self.engine,
            &self.repo,
            &SnapshotRequest {
                overlays,
                ..Default::default()
            },
        )
    }

    fn overlay(&self, rel: &str, text: &str, version: u64) -> OverlayInput {
        overlay_at(&self.p(rel), text.as_bytes(), version)
    }
}

fn overlay_at(path: &Path, bytes: &[u8], version: u64) -> OverlayInput {
    OverlayInput {
        path: clean_path_str(path),
        bytes: Arc::new(bytes.to_vec()),
        encoding: "utf8".into(),
        line_ending: "lf".into(),
        version,
    }
}

/// `path -> "kind"` or `"kind<-from"`, for the disk comparison.
fn disk(status: &Status) -> Vec<String> {
    status
        .entries
        .iter()
        .filter_map(|e| {
            e.disk.as_ref().map(|c| match &c.from {
                Some(from) => format!("{} {:?}<-{from}", e.path, c.kind),
                None => format!("{} {:?}", e.path, c.kind),
            })
        })
        .collect()
}

fn effective(status: &Status) -> Vec<String> {
    status
        .entries
        .iter()
        .filter_map(|e| {
            e.effective
                .as_ref()
                .map(|c| format!("{} {:?}", e.path, c.kind))
        })
        .collect()
}

fn entry<'a>(status: &'a Status, path: &str) -> &'a StatusEntry {
    status
        .entries
        .iter()
        .find(|e| e.path == path)
        .unwrap_or_else(|| panic!("no entry for {path}: {:?}", status.entries))
}

#[test]
fn with_no_commit_yet_everything_is_added() {
    let w = World::new("status-unborn");
    write(&w.p("a.txt"), "a");
    write(&w.p("dir/b.txt"), "b");
    std::fs::create_dir_all(w.p("empty")).unwrap();
    let status = w.status();
    assert_eq!(status.head_commit, None);
    assert_eq!(status.index, "head");
    assert_eq!(
        disk(&status),
        vec!["a.txt Added", "dir/b.txt Added", "empty Added"]
    );
    assert_eq!(effective(&status), disk(&status));
    assert_eq!(status.disk.added, 3);
}

#[test]
fn clean_added_modified_deleted() {
    let w = World::new("status-basic");
    write(&w.p("keep.txt"), "keep");
    write(&w.p("edit.txt"), "before");
    write(&w.p("drop.txt"), "drop");
    write(&w.p("dir/inner.txt"), "inner");
    w.commit();
    let clean = w.status();
    assert!(clean.entries.is_empty(), "{:?}", clean.entries);
    assert_eq!(clean.disk_root, clean.effective_root);

    write(&w.p("edit.txt"), "after");
    std::fs::remove_file(w.p("drop.txt")).unwrap();
    write(&w.p("dir/new.txt"), "new");
    std::fs::create_dir_all(w.p("brand-new-empty")).unwrap();
    let status = w.status();
    assert_eq!(
        disk(&status),
        vec![
            "brand-new-empty Added",
            "dir/new.txt Added",
            "drop.txt Deleted",
            "edit.txt Modified",
        ]
    );
    let edit = entry(&status, "edit.txt").disk.as_ref().unwrap();
    assert_eq!(edit.old.as_ref().unwrap().id.0, blob_id(b"before"));
    assert_eq!(edit.new.as_ref().unwrap().id.0, blob_id(b"after"));
    assert_eq!(status.disk.modified, 1);
    assert_eq!(status.disk.deleted, 1);
    assert_eq!(status.disk.added, 2);
    // No unsaved documents: memory has nothing to say, effective is disk.
    assert_eq!(effective(&status), disk(&status));
    assert_eq!(status.unsaved, 0);
}

#[test]
fn exact_renames_including_case_only_ones() {
    let w = World::new("status-rename");
    write(&w.p("old/name.txt"), "the same content");
    write(&w.p("Readme.md"), "readme");
    write(&w.p("twin1.txt"), "twin");
    write(&w.p("twin2.txt"), "twin");
    w.commit();
    std::fs::create_dir_all(w.p("new")).unwrap();
    std::fs::rename(w.p("old/name.txt"), w.p("new/renamed.txt")).unwrap();
    std::fs::rename(w.p("Readme.md"), w.p("README.md")).unwrap();
    // Two identical files moved: paired in path order, deterministically.
    std::fs::rename(w.p("twin1.txt"), w.p("z-twin1.txt")).unwrap();
    std::fs::rename(w.p("twin2.txt"), w.p("z-twin2.txt")).unwrap();
    let status = w.status();
    assert_eq!(
        disk(&status),
        vec![
            "README.md Renamed<-Readme.md",
            "new/renamed.txt Renamed<-old/name.txt",
            "z-twin1.txt Renamed<-twin1.txt",
            "z-twin2.txt Renamed<-twin2.txt",
        ]
    );
    assert_eq!(status.disk.renamed, 4);
}

#[test]
fn type_changes_are_reported_as_such() {
    let w = World::new("status-type");
    write(&w.p("was-file"), "file");
    write(&w.p("was-dir/inside.txt"), "inside");
    write(&w.p("stays.txt"), "same");
    w.commit();
    std::fs::remove_file(w.p("was-file")).unwrap();
    write(&w.p("was-file/child.txt"), "now a directory");
    std::fs::remove_dir_all(w.p("was-dir")).unwrap();
    write(&w.p("was-dir"), "now a file");
    let status = w.status();
    assert_eq!(
        disk(&status),
        vec![
            "was-dir TypeChanged",
            "was-dir/inside.txt Deleted",
            "was-file TypeChanged",
            "was-file/child.txt Added",
        ]
    );
    let change = entry(&status, "was-file").disk.as_ref().unwrap();
    assert_eq!(change.old.as_ref().unwrap().class, EntryClass::File);
    assert_eq!(change.new.as_ref().unwrap().class, EntryClass::Directory);
}

#[cfg(windows)]
#[test]
fn a_file_replaced_by_a_link_is_a_type_change() {
    let w = World::new("status-type-link");
    write(&w.p("target/x.txt"), "x");
    write(&w.p("thing"), "a file first");
    w.commit();
    std::fs::remove_file(w.p("thing")).unwrap();
    let made = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(w.p("thing"))
        .arg(w.p("target"))
        .output()
        .unwrap();
    assert!(made.status.success());
    let status = w.status();
    assert_eq!(disk(&status), vec!["thing TypeChanged"]);
    let change = entry(&status, "thing").disk.as_ref().unwrap();
    assert_eq!(change.new.as_ref().unwrap().class, EntryClass::Symlink);
    assert_eq!(change.new.as_ref().unwrap().link, Some("junction"));
}

#[test]
fn files_over_the_limit_are_modified_deleted_and_renamed_by_their_hash() {
    let w = World::with_limit("status-large", 1024);
    let big = |seed: u8| -> Vec<u8> { (0..5000u32).map(|i| (i as u8) ^ seed).collect() };
    write(&w.p("big-edit.bin"), big(1));
    write(&w.p("big-drop.bin"), big(2));
    write(&w.p("big-move.bin"), big(3));
    write(&w.p("big-same.bin"), big(4));
    w.commit();
    assert!(w.status().entries.is_empty());
    write(&w.p("big-edit.bin"), big(9));
    std::fs::remove_file(w.p("big-drop.bin")).unwrap();
    std::fs::create_dir_all(w.p("moved")).unwrap();
    std::fs::rename(w.p("big-move.bin"), w.p("moved/big.bin")).unwrap();
    let status = w.status();
    assert_eq!(
        disk(&status),
        vec![
            "big-drop.bin Deleted",
            "big-edit.bin Modified",
            "moved/big.bin Renamed<-big-move.bin",
        ]
    );
    let edit = entry(&status, "big-edit.bin").disk.as_ref().unwrap();
    let new = edit.new.as_ref().unwrap();
    assert!(!new.stored);
    assert_eq!(new.size, Some(5000));
    assert_eq!(new.id.0, blob_id(&big(9)));
}

#[test]
fn unsaved_documents_are_compared_with_disk_and_head_separately() {
    let w = World::new("status-memory");
    write(&w.p("a.txt"), "A");
    write(&w.p("b.txt"), "B");
    write(&w.p("c.txt"), "C");
    write(&w.p("d.txt"), "D");
    write(&w.p("e.txt"), "E");
    w.commit();
    let disk_before = listing(&w.f.project);
    let bytes_before = std::fs::read(w.p("a.txt")).unwrap();

    // a: disk clean, memory dirty (HEAD A, disk A, memory B).
    // b: disk dirty, memory clean (no overlay).
    // c: both (HEAD C, disk C2, memory C3).
    // d: memory back to HEAD while disk moved on (HEAD D, disk D2, memory D).
    // e: unsaved but equal to disk.
    write(&w.p("b.txt"), "B2");
    write(&w.p("c.txt"), "C2");
    write(&w.p("d.txt"), "D2");
    let (snap, status) = w.status_with(vec![
        w.overlay("a.txt", "B", 3),
        w.overlay("c.txt", "C3", 5),
        w.overlay("d.txt", "D", 8),
        w.overlay("e.txt", "E", 2),
    ]);
    // Nothing was written to disk to take it.
    assert_eq!(listing(&w.f.project), disk_before);
    assert_eq!(std::fs::read(w.p("a.txt")).unwrap(), bytes_before);
    assert_ne!(snap.disk_root, snap.effective_root);
    assert_eq!(snap.overlays.len(), 4);
    assert_eq!(status.unsaved, 4);

    let a = entry(&status, "a.txt");
    assert_eq!(a.disk, None);
    assert_eq!(a.effective.as_ref().unwrap().kind, ChangeKind::Modified);
    let memory = a.memory.as_ref().unwrap();
    assert_eq!(memory.state, MemoryState::DiffersFromDisk);
    assert!(!memory.equals_head);
    assert_eq!(memory.version, 3);

    let b = entry(&status, "b.txt");
    assert_eq!(b.disk.as_ref().unwrap().kind, ChangeKind::Modified);
    assert_eq!(b.effective.as_ref().unwrap().kind, ChangeKind::Modified);
    assert_eq!(b.memory, None);

    let c = entry(&status, "c.txt");
    assert_eq!(c.disk.as_ref().unwrap().kind, ChangeKind::Modified);
    assert_eq!(
        c.disk.as_ref().unwrap().new.as_ref().unwrap().id.0,
        blob_id(b"C2")
    );
    assert_eq!(
        c.effective.as_ref().unwrap().new.as_ref().unwrap().id.0,
        blob_id(b"C3")
    );
    assert_eq!(
        c.memory.as_ref().unwrap().state,
        MemoryState::DiffersFromDisk
    );

    let d = entry(&status, "d.txt");
    assert_eq!(d.disk.as_ref().unwrap().kind, ChangeKind::Modified);
    assert_eq!(d.effective, None);
    assert!(d.memory.as_ref().unwrap().equals_head);

    let e = entry(&status, "e.txt");
    assert_eq!(e.disk, None);
    assert_eq!(e.effective, None);
    assert_eq!(e.memory.as_ref().unwrap().state, MemoryState::EqualsDisk);
}

#[test]
fn a_dirty_document_whose_file_was_deleted_stays_in_the_effective_root() {
    let w = World::new("status-deleted-open");
    write(&w.p("src/open.ts"), "saved");
    w.commit();
    std::fs::remove_file(w.p("src/open.ts")).unwrap();
    std::fs::remove_dir(w.p("src")).unwrap();
    let (snap, status) = w.status_with(vec![w.overlay("src/open.ts", "unsaved", 4)]);
    let open = entry(&status, "src/open.ts");
    assert_eq!(open.disk.as_ref().unwrap().kind, ChangeKind::Deleted);
    assert_eq!(open.effective.as_ref().unwrap().kind, ChangeKind::Modified);
    assert_eq!(
        open.memory.as_ref().unwrap().state,
        MemoryState::OpenDeletedOnDisk
    );
    // The disk root does not have it; the effective root does.
    let persisted = try_snapshot(
        &w.engine,
        &w.repo,
        &SnapshotRequest {
            persist: true,
            overlays: vec![w.overlay("src/open.ts", "unsaved", 4)],
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(persisted.disk_root, snap.disk_root);
    assert_eq!(persisted.effective_root, snap.effective_root);
    let repo = w.repo.lock().unwrap();
    let disk_tree = folder_tree(&repo, persisted.disk_root.0);
    let effective_tree = folder_tree(&repo, persisted.effective_root.0);
    assert!(!tree_listing(&repo, disk_tree).contains_key("src/open.ts"));
    assert_eq!(
        tree_listing(&repo, effective_tree)["src/open.ts"],
        format!("file {}", blob_id(b"unsaved"))
    );
}

#[test]
fn overlays_outside_the_workspace_or_in_left_out_places_are_refused() {
    let w = World::new("status-refused");
    write(&w.p("in.txt"), "in");
    w.commit();
    let outside = w.f.base.parent().unwrap().join("elsewhere/file.txt");
    write(&outside, "outside");
    let sibling = w.f.project.with_file_name("Project Folder 2").join("x.txt");
    let (snap, status) = w.status_with(vec![
        overlay_at(&outside, b"never", 1),
        overlay_at(&sibling, b"never", 1),
        w.overlay(".git/config", "never", 1),
        w.overlay("node_modules/pkg/index.js", "never", 1),
        w.overlay(".env", "never", 1),
        w.overlay("in.txt", "applied", 2),
    ]);
    assert_eq!(snap.overlays.len(), 1);
    assert_eq!(snap.overlays[0].path, "in.txt");
    let refused: Vec<(&str, &str)> = snap
        .problems
        .iter()
        .map(|p| match p {
            Problem::OverlayRefused { path, reason } => (path.as_str(), reason.as_str()),
            other => panic!("unexpected {other:?}"),
        })
        .collect();
    assert_eq!(refused.len(), 5);
    assert_eq!(
        refused
            .iter()
            .filter(|(_, r)| *r == "outside the workspace")
            .count(),
        2
    );
    assert!(refused.contains(&(clean_path_str(w.p(".git/config")).as_str(), "inside .git")));
    assert_eq!(
        refused
            .iter()
            .filter(|(_, r)| *r == "left out by the exclusion rules")
            .count(),
        2
    );
    assert_eq!(effective(&status), vec!["in.txt Modified"]);
}

#[test]
fn overlay_bytes_are_kept_exactly_and_the_overlay_set_is_canonical() {
    let w = World::new("status-overlay-set");
    write(&w.p("crlf.txt"), "x");
    write(&w.p("bom.txt"), "y");
    w.commit();
    // What DocumentService would save: CRLF endings, a byte order mark.
    let crlf = b"line one\r\nline two\r\n".to_vec();
    let bom = "\u{feff}with bom\n".as_bytes().to_vec();
    let mut first = overlay_at(&w.p("crlf.txt"), &crlf, 10);
    first.line_ending = "crlf".into();
    let mut second = overlay_at(&w.p("bom.txt"), &bom, 11);
    second.encoding = "utf8bom".into();
    // An older version of the same document is superseded by the newer one.
    let stale = overlay_at(&w.p("crlf.txt"), b"old", 9);
    let untitled = UntitledInput {
        id: "doc-untitled-1".into(),
        bytes: Arc::new(b"scratch".to_vec()),
        encoding: "utf8".into(),
        line_ending: "lf".into(),
        version: 1,
    };
    let request = SnapshotRequest {
        persist: true,
        overlays: vec![second.clone(), stale, first.clone()],
        untitled: vec![untitled.clone()],
        ..Default::default()
    };
    let snap = try_snapshot(&w.engine, &w.repo, &request).unwrap();
    // The same overlays in another order: the same everything.
    let again = try_snapshot(
        &w.engine,
        &w.repo,
        &SnapshotRequest {
            overlays: vec![first, second],
            untitled: vec![untitled],
            persist: true,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(again.effective_root, snap.effective_root);
    assert_eq!(again.overlay_set, snap.overlay_set);

    let repo = w.repo.lock().unwrap();
    let tree = folder_tree(&repo, snap.effective_root.0);
    let listing = tree_listing(&repo, tree);
    assert_eq!(listing["crlf.txt"], format!("file {}", blob_id(&crlf)));
    assert_eq!(listing["bom.txt"], format!("file {}", blob_id(&bom)));
    let set = repo
        .read_blob(&snap.overlay_set.unwrap().0, 1 << 20)
        .unwrap();
    let text = String::from_utf8(set).unwrap();
    let folder = &snap.folders[0].folder_id;
    assert_eq!(
        text,
        format!(
            "ylg-overlays 1\n\
             doc {folder} bom.txt {} utf8bom lf 11\n\
             doc {folder} crlf.txt {} utf8 crlf 10\n\
             untitled doc-untitled-1 {} utf8 lf 1\n",
            blob_id(&bom),
            blob_id(&crlf),
            blob_id(b"scratch"),
        )
    );
    // The untitled document is stored, but in no tree.
    assert!(repo.contains(&blob_id(b"scratch")));
    assert!(!listing
        .values()
        .any(|v| v.contains(&blob_id(b"scratch").to_hex())));
}

#[test]
fn a_snapshot_without_untitled_documents_has_none() {
    let w = World::new("status-no-untitled");
    write(&w.p("a.txt"), "a");
    let snap = snapshot(&w.engine, &w.repo);
    assert!(snap.untitled.is_empty());
    assert!(snap.overlay_set.is_none());
    assert_eq!(snap.disk_root, snap.effective_root);
}

#[test]
fn a_long_status_is_cut_at_the_limit_and_says_so() {
    let w = World::new("status-limit");
    for i in 0..30 {
        write(&w.p(&format!("f{i:02}.txt")), format!("{i}"));
    }
    let cancel = std::sync::atomic::AtomicBool::new(false);
    let (_, status) = w
        .engine
        .status(
            &w.repo,
            &SnapshotRequest::default(),
            &Control {
                cancel: &cancel,
                progress: &|_| {},
            },
            10,
        )
        .unwrap();
    assert_eq!(status.entries.len(), 10);
    assert_eq!(status.total, 30);
    assert!(status.truncated);
    assert_eq!(status.disk.added, 30);
    assert_eq!(status.entries[0].path, "f00.txt");
}
