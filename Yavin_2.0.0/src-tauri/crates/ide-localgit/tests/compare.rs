//! LG-09: comparing a Local commit with real Git by content, and planning a promotion. Real
//! Git's side is given as the app reads it from real Git; here it is built by hand.

mod common;

use common::*;
use ide_localgit::compare::{GitFile, GitSide, GitStatus, PathState};
use ide_localgit::gitblob::git_blob_id;
use ide_localgit::history::*;
use ide_localgit::index::*;
use ide_localgit::restore::{OpKind, RestoreConflict};
use ide_localgit::*;
use ide_workspace::file_tree::clean_path_str;
use std::collections::BTreeMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

struct World {
    f: Fixture,
    repo: Mutex<Repository>,
    engine: SnapshotEngine,
}

fn quiet(cancel: &AtomicBool) -> Control<'_> {
    Control {
        cancel,
        progress: &|_| {},
    }
}

impl World {
    fn new(label: &str) -> World {
        World::with_limit(label, DEFAULT_MAX_BLOB_BYTES)
    }

    fn with_limit(label: &str, max: u64) -> World {
        let f = Fixture::new(label);
        let repo = Mutex::new(f.open().unwrap());
        let engine = engine_with(&repo.lock().unwrap(), &f.project, max);
        World { f, repo, engine }
    }

    fn put(&self, path: &str, bytes: impl AsRef<[u8]>) {
        write(&self.f.project.join(path), bytes);
    }

    fn commit(&self) -> ObjectId {
        let cancel = AtomicBool::new(false);
        stage_all(
            &self.engine,
            &self.repo,
            &SnapshotRequest::default(),
            &quiet(&cancel),
        )
        .unwrap();
        commit_index(
            &mut self.repo.lock().unwrap(),
            &CommitRequest {
                message: "local".into(),
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

    fn folder(&self) -> FolderId {
        self.engine.folders()[0].folder_id.clone()
    }

    fn compare(&self, local: Option<ObjectId>, git: GitSide) -> ide_localgit::compare::Comparison {
        let cancel = AtomicBool::new(false);
        let mut sides = BTreeMap::new();
        sides.insert(self.folder(), git);
        self.engine
            .compare_with_git(&self.repo, &quiet(&cancel), local, &sides, 1000)
            .unwrap()
            .1
    }

    fn promote_plan(
        &self,
        local: ObjectId,
        git: GitSide,
        overlays: Vec<OverlayInput>,
    ) -> ide_localgit::promote::PromotionPlan {
        let cancel = AtomicBool::new(false);
        let mut sides = BTreeMap::new();
        sides.insert(self.folder(), git);
        self.engine
            .plan_promotion(
                &self.repo,
                &SnapshotRequest {
                    overlays,
                    ..Default::default()
                },
                &quiet(&cancel),
                local,
                &sides,
            )
            .unwrap()
            .1
    }
}

/// Real Git's HEAD holding `files` (text), clean.
fn git_head(files: &[(&str, &[u8])]) -> GitSide {
    GitSide {
        head: Some("9f".repeat(20)),
        branch: Some("main".into()),
        prefix: String::new(),
        files: files
            .iter()
            .map(|(path, bytes)| {
                (
                    path.to_string(),
                    GitFile {
                        mode: "100644".into(),
                        id: git_blob_id(bytes),
                    },
                )
            })
            .collect(),
        fingerprint: "fp-1".into(),
        ..Default::default()
    }
}

fn state_of(comparison: &ide_localgit::compare::Comparison, path: &str) -> Option<PathState> {
    comparison
        .entries
        .iter()
        .find(|e| e.path == path)
        .map(|e| e.state)
}

#[test]
fn the_same_content_is_the_same_whatever_the_ids_and_history() {
    let w = World::new("cmp-same");
    w.put("a.txt", "alpha\n");
    w.put("bin.dat", [0u8, 1, 2, 255]);
    let local = w.commit();
    let comparison = w.compare(
        Some(local),
        git_head(&[("a.txt", b"alpha\n"), ("bin.dat", &[0u8, 1, 2, 255])]),
    );
    assert!(comparison.identical, "{comparison:?}");
    assert!(comparison.entries.is_empty());
    assert_eq!(comparison.git_branch.as_deref(), Some("main"));
    assert_eq!(comparison.local_branch.as_deref(), Some("main"));
    assert_ne!(
        comparison.git_head.as_deref(),
        comparison.local_commit.map(|c| c.0.to_hex()).as_deref(),
        "separate object spaces"
    );
}

#[test]
fn differences_are_exact_whichever_side_has_them() {
    let w = World::new("cmp-diff");
    w.put("same.txt", "s");
    w.put("both.txt", "local version");
    w.put("local-only.txt", "only here");
    w.put("bin.dat", [0u8, 9]);
    let local = w.commit();
    // The working tree moved on since, so equality is decided by content, not by the disk.
    w.put("both.txt", "edited after");
    let mut git = git_head(&[
        ("same.txt", b"s"),
        ("both.txt", b"git version"),
        ("git-only.txt", b"only in git"),
        ("bin.dat", &[0u8, 8]),
    ]);
    git.modified.insert("both.txt".into());
    // The disk holds the Local bin.dat, which real Git sees as a change of its HEAD's.
    git.modified.insert("bin.dat".into());
    let comparison = w.compare(Some(local), git);
    assert_eq!(
        state_of(&comparison, "both.txt"),
        Some(PathState::Different)
    );
    assert_eq!(state_of(&comparison, "bin.dat"), Some(PathState::Different));
    assert_eq!(
        state_of(&comparison, "local-only.txt"),
        Some(PathState::LocalOnly)
    );
    assert_eq!(
        state_of(&comparison, "git-only.txt"),
        Some(PathState::GitOnly)
    );
    assert_eq!(
        state_of(&comparison, "same.txt"),
        None,
        "same paths are counted, not listed"
    );
    assert_eq!(comparison.counts["same"], 1);
    let both = comparison
        .entries
        .iter()
        .find(|e| e.path == "both.txt")
        .unwrap();
    assert_eq!(both.git_status, GitStatus::Modified);
    assert!(!both.disk_matches_local);
    assert!(!comparison.identical);
}

#[test]
fn content_local_git_never_stored_is_unavailable_never_equal() {
    let w = World::with_limit("cmp-unstored", 1024);
    w.put("big.bin", vec![7u8; 5000]);
    let local = w.commit();
    // The disk changed: there is nothing left to compare the Local content by.
    w.put("big.bin", vec![8u8; 5000]);
    let mut git = git_head(&[("big.bin", &vec![7u8; 5000])]);
    git.modified.insert("big.bin".into());
    let comparison = w.compare(Some(local), git);
    assert_eq!(
        state_of(&comparison, "big.bin"),
        Some(PathState::Unavailable)
    );
}

#[test]
fn what_local_git_leaves_out_is_reported_as_such_and_no_repository_or_history_is_said() {
    let w = World::new("cmp-excluded");
    w.put("a.txt", "a");
    w.put(".env", "SECRET=1");
    let local = w.commit();
    let comparison = w.compare(
        Some(local),
        git_head(&[("a.txt", b"a"), (".env", b"SECRET=1")]),
    );
    assert_eq!(
        state_of(&comparison, ".env"),
        Some(PathState::NotInLocalGit)
    );
    // No Local history: everything real Git has is git-only.
    let none = w.compare(None, git_head(&[("a.txt", b"a")]));
    assert!(none.local_commit.is_none());
    assert_eq!(state_of(&none, "a.txt"), Some(PathState::GitOnly));
    // No real Git repository: nothing to compare with.
    let cancel = AtomicBool::new(false);
    let alone = w
        .engine
        .compare_with_git(&w.repo, &quiet(&cancel), Some(local), &BTreeMap::new(), 100)
        .unwrap()
        .1;
    assert!(!alone.git_repository);
    assert!(alone.entries.is_empty());
}

#[test]
fn a_subfolder_of_a_repository_compares_only_its_own_paths() {
    let w = World::new("cmp-prefix");
    w.put("a.txt", "a");
    let local = w.commit();
    let mut git = git_head(&[("pkg/a.txt", b"a"), ("other/b.txt", b"b")]);
    git.prefix = "pkg".into();
    let comparison = w.compare(Some(local), git);
    assert!(comparison.identical, "{comparison:?}");
}

#[test]
fn a_promotion_plan_writes_exactly_the_differences() {
    let w = World::new("promote-plan");
    w.put("same.txt", "s");
    w.put("changed.txt", "local");
    w.put("new.txt", "created locally");
    let local = w.commit();
    // The working tree is real Git's HEAD (as after a checkout).
    w.put("changed.txt", "git");
    std::fs::remove_file(w.f.project.join("new.txt")).unwrap();
    w.put("gone.txt", "deleted locally");
    let git = git_head(&[
        ("same.txt", b"s"),
        ("changed.txt", b"git"),
        ("gone.txt", b"deleted locally"),
    ]);
    let plan = w.promote_plan(local, git, vec![]);
    assert!(plan.refusals.is_empty(), "{:?}", plan.refusals);
    let mut actions: Vec<(String, &str)> = plan
        .paths
        .iter()
        .map(|p| (p.path.clone(), p.action))
        .collect();
    actions.sort();
    assert_eq!(
        actions,
        vec![
            ("changed.txt".into(), "modify"),
            ("gone.txt".into(), "delete"),
            ("new.txt".into(), "create"),
        ]
    );
    let kinds: Vec<(OpKind, String)> = plan
        .restore
        .operations
        .iter()
        .map(|op| (op.kind, op.path.clone()))
        .collect();
    assert!(kinds.contains(&(OpKind::WriteFile, "changed.txt".into())));
    assert!(kinds.contains(&(OpKind::WriteFile, "new.txt".into())));
    assert!(kinds.contains(&(OpKind::RemoveFile, "gone.txt".into())));
    assert_eq!(plan.git_fingerprints.values().next().unwrap(), "fp-1");
    assert_eq!(plan.git_branch.as_deref(), Some("main"));
}

#[test]
fn a_promotion_never_overwrites_the_users_work() {
    let w = World::new("promote-refuse");
    w.put("staged.txt", "local");
    w.put("modified.txt", "local");
    w.put("untracked.txt", "local");
    w.put("dirty.txt", "local");
    let local = w.commit();
    w.put("staged.txt", "git, staged change");
    w.put("modified.txt", "git, working change");
    w.put("untracked.txt", "the user's untracked file");
    w.put("dirty.txt", "git");
    let mut git = git_head(&[
        ("staged.txt", b"git"),
        ("modified.txt", b"git"),
        ("dirty.txt", b"git"),
    ]);
    git.staged.insert("staged.txt".into());
    git.modified.insert("modified.txt".into());
    git.untracked.insert("untracked.txt".into());
    let unsaved = OverlayInput {
        path: clean_path_str(w.f.project.join("dirty.txt")),
        bytes: Arc::new(b"typing".to_vec()),
        encoding: "utf8".into(),
        line_ending: "lf".into(),
        version: 2,
    };
    let disk = listing(&w.f.project);
    let plan = w.promote_plan(local, git, vec![unsaved]);
    let has = |want: &str, at: &str| {
        plan.refusals
            .iter()
            .any(|c| format!("{c:?}").starts_with(want) && format!("{c:?}").contains(at))
    };
    assert!(has("RealGitChanged", "staged.txt"), "{:?}", plan.refusals);
    assert!(plan.refusals.iter().any(|c| matches!(c, RestoreConflict::RealGitChanged { path, staged: true, .. } if path == "staged.txt")));
    assert!(has("RealGitChanged", "modified.txt"));
    assert!(has("UntrackedFileCollision", "untracked.txt"));
    assert!(has("DirtyDocumentWouldBeOverwritten", "dirty.txt"));
    assert_eq!(listing(&w.f.project), disk, "planning changes nothing");
}

#[test]
fn promoting_content_local_git_never_stored_is_refused() {
    let w = World::with_limit("promote-unstored", 1024);
    w.put("big.bin", vec![1u8; 5000]);
    let local = w.commit();
    w.put("big.bin", vec![2u8; 5000]);
    let plan = w.promote_plan(local, git_head(&[("big.bin", &vec![2u8; 5000])]), vec![]);
    assert!(plan.refusals.iter().any(|c| matches!(
        c,
        RestoreConflict::HistoricalContentUnavailable { path, .. } if path == "big.bin"
    )));
}
