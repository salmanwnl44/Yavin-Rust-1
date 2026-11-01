//! LG-03: diffs between commits, and between a commit and the workspace.

mod common;

use common::*;
use ide_localgit::diff::*;
use ide_localgit::history::*;
use ide_localgit::*;
use ide_workspace::file_tree::clean_path_str;
use std::sync::atomic::AtomicBool;
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

    fn with_limit(label: &str, max_blob: u64) -> World {
        let f = Fixture::new(label);
        let repo = Mutex::new(f.open().unwrap());
        let engine = engine_with(&repo.lock().unwrap(), &f.project, max_blob);
        World { f, repo, engine }
    }

    fn p(&self, rel: &str) -> std::path::PathBuf {
        self.f.project.join(rel)
    }

    fn commit(&self, message: &str) -> ObjectId {
        let snap = persist(&self.engine, &self.repo);
        commit_snapshot(
            &mut self.repo.lock().unwrap(),
            &snap,
            &CommitRequest {
                message: message.into(),
                author: Author {
                    name: "T".into(),
                    id: "t".into(),
                },
                time_ms: 0,
                tz_offset_min: 0,
            },
        )
        .unwrap()
        .commit
        .id
        .0
    }

    fn diff(&self, from: Option<ObjectId>, to: ObjectId) -> DiffResult {
        diff_commits(
            &self.repo.lock().unwrap(),
            from,
            to,
            &DiffOptions::default(),
        )
        .unwrap()
    }

    fn workspace(&self, overlays: Vec<OverlayInput>) -> DiffResult {
        let cancel = AtomicBool::new(false);
        self.engine
            .diff_workspace(
                &self.repo,
                &SnapshotRequest {
                    overlays,
                    ..Default::default()
                },
                &Control {
                    cancel: &cancel,
                    progress: &|_| {},
                },
                None,
                &DiffOptions::default(),
            )
            .unwrap()
            .1
    }
}

fn kinds(diff: &DiffResult) -> Vec<String> {
    diff.entries
        .iter()
        .map(|e| match &e.old_path {
            Some(from) => format!("{} {:?}<-{from}", e.path, e.kind),
            None => format!("{} {:?}", e.path, e.kind),
        })
        .collect()
}

fn entry<'a>(diff: &'a DiffResult, path: &str) -> &'a DiffEntry {
    diff.entries.iter().find(|e| e.path == path).unwrap()
}

fn text_of(line_diff: &LineDiff) -> Vec<String> {
    line_diff
        .hunks
        .iter()
        .flat_map(|h| h.lines.iter())
        .map(|l| {
            let mark = match l.kind {
                LineKind::Context => ' ',
                LineKind::Addition => '+',
                LineKind::Deletion => '-',
            };
            format!("{mark}{}", l.text)
        })
        .collect()
}

#[test]
fn commit_to_commit_finds_every_kind_of_change() {
    let w = World::new("diff-kinds");
    write(&w.p("edit.txt"), "one\ntwo\nthree\n");
    write(&w.p("drop.txt"), "gone\n");
    write(&w.p("move/me.txt"), "moved content\n");
    write(&w.p("was-file"), "a file\n");
    std::fs::create_dir_all(w.p("old-empty")).unwrap();
    let a = w.commit("a");
    write(&w.p("edit.txt"), "one\n2\nthree\n");
    std::fs::remove_file(w.p("drop.txt")).unwrap();
    write(&w.p("add.txt"), "new\n");
    std::fs::create_dir_all(w.p("moved")).unwrap();
    std::fs::rename(w.p("move/me.txt"), w.p("moved/me.txt")).unwrap();
    std::fs::remove_file(w.p("was-file")).unwrap();
    write(&w.p("was-file/inside.txt"), "x\n");
    std::fs::remove_dir(w.p("old-empty")).unwrap();
    std::fs::create_dir_all(w.p("new-empty")).unwrap();
    let b = w.commit("b");

    let diff = w.diff(Some(a), b);
    assert!(!diff.identical);
    assert_eq!(
        kinds(&diff),
        vec![
            "add.txt Added",
            "drop.txt Deleted",
            "edit.txt Modified",
            "moved/me.txt Renamed<-move/me.txt",
            "new-empty Added",
            "old-empty Deleted",
            "was-file TypeChanged",
            "was-file/inside.txt Added",
        ]
    );
    let edit = entry(&diff, "edit.txt");
    assert!(edit.content_available && !edit.binary);
    assert_eq!(
        text_of(edit.line_diff.as_ref().unwrap()),
        vec![" one", "-two", "+2", " three"]
    );
    let hunk = &edit.line_diff.as_ref().unwrap().hunks[0];
    assert_eq!(
        (
            hunk.old_start,
            hunk.old_lines,
            hunk.new_start,
            hunk.new_lines
        ),
        (1, 3, 1, 3)
    );
    // A pure rename has nothing to show line by line.
    let moved = entry(&diff, "moved/me.txt");
    assert!(moved.line_diff.as_ref().unwrap().hunks.is_empty());
    // Directories carry no content.
    assert_eq!(entry(&diff, "new-empty").unavailable, Some("notAFile"));
    assert_eq!(diff.counts.renamed, 1);
    // The first commit against nothing: all added.
    let first = w.diff(None, a);
    assert_eq!(first.from.kind, "empty");
    assert_eq!(first.counts.added, 5);
}

#[test]
fn identical_commits_compare_nothing() {
    let w = World::new("diff-identical");
    write(&w.p("a.txt"), "a");
    let a = w.commit("a");
    let b = w.commit("b, same tree");
    let diff = w.diff(Some(a), b);
    assert!(diff.identical);
    assert!(diff.entries.is_empty());
}

#[test]
fn binary_files_get_no_line_diff_and_unstored_ones_say_so() {
    let w = World::with_limit("diff-binary", 1024);
    write(&w.p("image.bin"), [0u8, 1, 2, 3]);
    write(&w.p("big.log"), "x".repeat(5000));
    let a = w.commit("a");
    write(&w.p("image.bin"), [0u8, 9, 9, 9]);
    write(&w.p("big.log"), "y".repeat(5000));
    let b = w.commit("b");
    let diff = w.diff(Some(a), b);
    let image = entry(&diff, "image.bin");
    assert!(image.binary && image.content_available);
    assert_eq!(image.line_diff_skipped, Some("binary"));
    assert!(image.line_diff.is_none());
    let big = entry(&diff, "big.log");
    assert!(!big.content_available);
    assert_eq!(big.unavailable, Some("notStored"));
    assert!(big.line_diff.is_none());
    assert_eq!(big.new.as_ref().unwrap().size, Some(5000));
    // Its current bytes are on disk -- and are not taken for the historical ones.
    assert!(w.p("big.log").exists());
}

#[test]
fn head_to_workspace_includes_unsaved_documents_and_touches_nothing() {
    let w = World::new("diff-workspace");
    write(&w.p("foo.txt"), "A\n");
    write(&w.p("bar.txt"), "bar\n");
    w.commit("head");
    // On disk bar changes; in the editor foo is dirty with B.
    write(&w.p("bar.txt"), "bar, saved\n");
    let before = std::fs::read(w.p("foo.txt")).unwrap();
    let diff = w.workspace(vec![OverlayInput {
        path: clean_path_str(w.p("foo.txt")),
        bytes: Arc::new(b"B\n".to_vec()),
        encoding: "utf8".into(),
        line_ending: "lf".into(),
        version: 2,
    }]);
    assert_eq!(diff.to.kind, "workspace");
    assert_eq!(kinds(&diff), vec!["bar.txt Modified", "foo.txt Modified"]);
    assert_eq!(
        text_of(entry(&diff, "foo.txt").line_diff.as_ref().unwrap()),
        vec!["-A", "+B"]
    );
    assert_eq!(
        text_of(entry(&diff, "bar.txt").line_diff.as_ref().unwrap()),
        vec!["-bar", "+bar, saved"]
    );
    // Nothing saved.
    assert_eq!(std::fs::read(w.p("foo.txt")).unwrap(), before);
    // A clean workspace: identical, nothing compared.
    let clean = World::new("diff-workspace-clean");
    write(&clean.p("a.txt"), "a");
    clean.commit("a");
    assert!(clean.workspace(vec![]).identical);
}

#[test]
fn a_workspace_file_that_changes_after_the_snapshot_is_not_shown_as_its_content() {
    let w = World::new("diff-changed-after");
    write(&w.p("a.txt"), "one\n");
    w.commit("a");
    write(&w.p("a.txt"), "two\n");
    let cancel = AtomicBool::new(false);
    let path = w.p("a.txt");
    // It changes between the scan and the diff reading it.
    let (_, diff) = {
        let snap_and_diff = w.engine.diff_workspace(
            &w.repo,
            &SnapshotRequest::default(),
            &Control {
                cancel: &cancel,
                progress: &|p| {
                    if p.phase == "overlays" {
                        std::fs::write(&path, "three\n").unwrap();
                    }
                },
            },
            None,
            &DiffOptions::default(),
        );
        snap_and_diff.unwrap()
    };
    let a = entry(&diff, "a.txt");
    assert!(!a.content_available);
    assert_eq!(a.unavailable, Some("changedOnDisk"));
}
