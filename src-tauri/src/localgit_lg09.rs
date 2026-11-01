//! Local Git and real Git, and Local Git's own upkeep (LG-09): comparison, promotion, garbage
//! collection, storage statistics and integrity -- for the window, through a handle.
//!
//! Real Git is only ever *read* here, through the app's one Git process runner
//! (`git::run_read_only`, with optional locks off so even `status` never writes the index):
//! `rev-parse`, `symbolic-ref`, `ls-tree`, `ls-files` and `status`. Promotion writes the working
//! tree only -- through Local Git's restore executor (Module 03, recorded by Module 04), after a
//! Local Git recovery checkpoint -- and never runs a Git command that changes anything: no
//! staging, no commit, no push. The user stages and commits with real Git.

use super::*;
use ide_localgit::compare::{Comparison, GitFile, GitSide};
use ide_localgit::gc::{
    self, GcOutcome, GcPlan, IntegrityReport, PurgeOutcome, RetentionPolicy, StorageStats,
};
use ide_localgit::promote::PromotionPlan;
use ide_localgit::{hash_object, ObjectKind};
use std::collections::{BTreeMap, HashSet};
use std::path::Path;

fn now() -> u64 {
    ide_workspace::durable::now_millis() as u64
}

/// Splits `-z` output into its NUL-separated records.
fn records(text: &str) -> impl Iterator<Item = &str> {
    text.split('\0').filter(|r| !r.is_empty())
}

/// Real Git's side for a workspace folder, read with read-only Git commands -- or none when the
/// folder is not in a repository (or Git is not installed).
pub(crate) fn git_side(folder: &Path) -> Result<Option<GitSide>, String> {
    let Some(top) = crate::git::toplevel_of(folder) else {
        return Ok(None);
    };
    let run = |args: &[&str]| crate::git::run_read_only(&top, args);
    let canonical = folder.canonicalize().map_err(|e| e.to_string())?;
    let prefix = canonical
        .strip_prefix(&top)
        .map(|p| {
            p.components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/")
        })
        .unwrap_or_default();
    let head = run(&["rev-parse", "--verify", "-q", "HEAD"])?;
    let head = (head.code == 0).then(|| head.stdout.trim().to_string());
    let branch = run(&["symbolic-ref", "-q", "--short", "HEAD"])?;
    let branch = (branch.code == 0).then(|| branch.stdout.trim().to_string());
    let mut files = std::collections::HashMap::new();
    if head.is_some() {
        let listed = run(&["ls-tree", "-r", "-z", "--full-tree", "HEAD"])?;
        if listed.code != 0 {
            return Err(format!(
                "Unavailable: git ls-tree failed: {}",
                listed.stderr.trim()
            ));
        }
        for record in records(&listed.stdout) {
            // `<mode> <type> <id>\t<path>`; submodules (`commit`) are not files.
            let Some((meta, path)) = record.split_once('\t') else {
                continue;
            };
            let mut parts = meta.split(' ');
            let (Some(mode), Some(kind), Some(id)) = (parts.next(), parts.next(), parts.next())
            else {
                continue;
            };
            if kind == "blob" {
                files.insert(
                    path.to_string(),
                    GitFile {
                        mode: mode.into(),
                        id: id.into(),
                    },
                );
            }
        }
    }
    let status = run(&["status", "--porcelain=v1", "-z", "--untracked-files=all"])?;
    if status.code != 0 {
        return Err(format!(
            "Unavailable: git status failed: {}",
            status.stderr.trim()
        ));
    }
    let (mut staged, mut modified, mut untracked) =
        (HashSet::new(), HashSet::new(), HashSet::new());
    let mut entries = records(&status.stdout);
    while let Some(entry) = entries.next() {
        if entry.len() < 4 {
            continue;
        }
        let (x, y, path) = (&entry[0..1], &entry[1..2], entry[3..].to_string());
        if x == "?" {
            untracked.insert(path);
            continue;
        }
        if x == "R" || x == "C" {
            // A rename's source follows as its own record: it changed too.
            if let Some(from) = entries.next() {
                staged.insert(from.to_string());
            }
        }
        if x != " " {
            staged.insert(path.clone());
        }
        if y != " " {
            modified.insert(path);
        }
    }
    let index = run(&["ls-files", "-s", "-z"])?;
    let fingerprint = hash_object(
        ObjectKind::Blob,
        format!(
            "{}\0{}\0{}\0{}",
            head.as_deref().unwrap_or(""),
            branch.as_deref().unwrap_or(""),
            index.stdout,
            status.stdout
        )
        .as_bytes(),
    )
    .to_hex();
    Ok(Some(GitSide {
        head,
        branch,
        prefix,
        files,
        staged,
        modified,
        untracked,
        fingerprint,
    }))
}

/// Real Git's side of every folder in a repository.
fn git_sides(store: &Store) -> Result<BTreeMap<FolderId, GitSide>, String> {
    let mut sides = BTreeMap::new();
    for folder in store.engine.folders() {
        if let Some(side) = git_side(&folder.path)? {
            sides.insert(folder.folder_id.clone(), side);
        }
    }
    Ok(sides)
}

/// Compares a Local commit (HEAD's by default) with real Git's HEAD by content. Changes
/// nothing on either side.
#[tauri::command(async)]
pub fn localgit_compare_git(
    app: AppHandle,
    local_git: State<'_, LocalGit>,
    handle: String,
    job_id: String,
    commit: Option<String>,
    limit: usize,
) -> Result<Comparison, String> {
    let store = local_git.handle_store(&handle)?;
    let local = match parse_opt(commit)? {
        Some(id) => Some(id),
        None => {
            let repo = store.repo.lock().map_err(|e| e.to_string())?;
            branches::resolve_head(&repo).commit()
        }
    };
    let sides = git_sides(&store)?;
    let cancel = local_git.start_job(&handle, &job_id, false)?;
    let progress = progress_to(&app, &handle, &job_id);
    let result = store
        .engine
        .compare_with_git(
            &store.repo,
            &Control {
                cancel: &cancel,
                progress: &progress,
            },
            local,
            &sides,
            limit,
        )
        .map(|(_, comparison)| comparison);
    local_git.finish_job(&handle, &job_id, result)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromoteResult {
    /// `planned` (a dry run), `refused`, `completed`, `failed`, `verificationFailed`.
    status: &'static str,
    plan: PromotionPlan,
    conflicts: Vec<RestoreConflict>,
    /// The Local Git checkpoint of the workspace taken before anything changed.
    checkpoint: Option<history::CommitInfo>,
    operation: Option<u64>,
    applied: usize,
    error: Option<String>,
    verification: Option<Verification>,
}

/// Promotes a Local commit's content into the working tree real Git works in -- for the user
/// to stage and commit with real Git. Always planned first (`dryRun` stops there); refused, with
/// every reason, over staged or modified files, untracked files, unsaved documents, content not
/// stored, or real Git having changed since the plan. Never stages, commits or pushes.
#[allow(clippy::too_many_arguments)]
#[tauri::command(async)]
pub fn localgit_promote(
    app: AppHandle,
    workspace: State<'_, Workspace>,
    watch: State<'_, crate::Watch>,
    local_git: State<'_, LocalGit>,
    handle: String,
    job_id: String,
    commit: String,
    dry_run: bool,
    overlays: Vec<OverlayRef>,
    by: Signature,
) -> Result<PromoteResult, String> {
    let local = parse_id(&commit)?;
    let (store, request) = prepare(&local_git, &handle, "full", true, &overlays, &[])?;
    let _only = if dry_run {
        None
    } else {
        Some(exclusive(&store)?)
    };
    let sides = git_sides(&store)?;
    if sides.is_empty() {
        return Err("NotFound: the workspace is not in a real Git repository".into());
    }
    let cancel = local_git.start_job(&handle, &job_id, false)?;
    let progress = progress_to(&app, &handle, &job_id);
    let control = Control {
        cancel: &cancel,
        progress: &progress,
    };
    let (snapshot, plan) =
        match store
            .engine
            .plan_promotion(&store.repo, &request, &control, local, &sides)
        {
            Ok(planned) => planned,
            Err(error) => return local_git.finish_job(&handle, &job_id, Err(error)),
        };
    let mut result = PromoteResult {
        status: "completed",
        conflicts: plan.refusals.clone(),
        plan,
        checkpoint: None,
        operation: None,
        applied: 0,
        error: None,
        verification: None,
    };
    if !result.conflicts.is_empty() {
        result.status = "refused";
        return local_git.finish_job(&handle, &job_id, Ok(result));
    }
    if dry_run {
        result.status = "planned";
        return local_git.finish_job(&handle, &job_id, Ok(result));
    }
    before_changing(&local_git, &workspace, &handle, &cancel)?;
    // Real Git exactly as planned against, or nothing happens.
    let now_sides = git_sides(&store)?;
    let unchanged = now_sides.len() == sides.len()
        && now_sides.iter().all(|(folder, side)| {
            result.plan.git_fingerprints.get(folder.as_str()) == Some(&side.fingerprint)
        });
    if !unchanged {
        result.status = "refused";
        result.error = Some(
            "StaleRevision: real Git's HEAD, index or working tree changed since the plan; plan again"
                .into(),
        );
        return local_git.finish_job(&handle, &job_id, Ok(result));
    }
    let checkpoint = {
        let mut repo = store.repo.lock().map_err(|e| e.to_string())?;
        history::checkpoint_snapshot(
            &mut repo,
            &snapshot,
            Source::Recovery,
            &commit_request(
                format!(
                    "Before promoting {}",
                    &local.to_hex()[..history::SHORT_ID_LEN]
                ),
                by,
            ),
        )
        .map_err(fail)?
    };
    result.checkpoint = Some(checkpoint.commit);
    let carried = carry_out(&watch, &store, &result.plan.restore, &progress);
    result.status = carried.status;
    result.conflicts = carried.conflicts;
    result.operation = carried.operation;
    result.applied = carried.applied;
    result.error = carried.error;
    result.verification = carried.verification;
    local_git.finish_changed(&handle, &job_id, Ok(result))
}

/// What a GC under `policy` would do (reads only).
#[tauri::command(async)]
pub fn localgit_gc_plan(
    local_git: State<'_, LocalGit>,
    handle: String,
    policy: RetentionPolicy,
) -> Result<GcPlan, String> {
    local_git.with(&handle, |repo| gc::plan(repo, &policy, now()))
}

/// Collects what nothing reaches under `policy` (planned afresh under the store's mutation
/// lock). Retired segments wait in quarantine until purged.
#[tauri::command(async)]
pub fn localgit_gc_run(
    local_git: State<'_, LocalGit>,
    handle: String,
    policy: RetentionPolicy,
) -> Result<GcOutcome, String> {
    let store = local_git.handle_store(&handle)?;
    let _only = exclusive(&store)?;
    let mut repo = store.repo.lock().map_err(|e| e.to_string())?;
    let at = now();
    let plan = gc::plan(&repo, &policy, at).map_err(fail)?;
    gc::run(&mut repo, &plan, at).map_err(fail)
}

/// Puts an interrupted GC's segments back (nothing is lost).
#[tauri::command(async)]
pub fn localgit_gc_roll_back(
    local_git: State<'_, LocalGit>,
    handle: String,
) -> Result<Option<gc::GcJournal>, String> {
    let store = local_git.handle_store(&handle)?;
    let _only = exclusive(&store)?;
    let mut repo = store.repo.lock().map_err(|e| e.to_string())?;
    gc::roll_back(&mut repo).map_err(fail)
}

/// Deletes what finished GCs retired -- the only step that removes data, and only when asked.
#[tauri::command(async)]
pub fn localgit_gc_purge(
    local_git: State<'_, LocalGit>,
    handle: String,
) -> Result<PurgeOutcome, String> {
    let store = local_git.handle_store(&handle)?;
    let _only = exclusive(&store)?;
    let mut repo = store.repo.lock().map_err(|e| e.to_string())?;
    gc::purge(&mut repo).map_err(fail)
}

#[tauri::command(async)]
pub fn localgit_storage(
    local_git: State<'_, LocalGit>,
    handle: String,
) -> Result<StorageStats, String> {
    local_git.with(&handle, |repo| gc::stats(repo))
}

/// Checks the store and its records (`full`: every object re-hashed). Reports; repairs nothing.
#[tauri::command(async)]
pub fn localgit_integrity(
    local_git: State<'_, LocalGit>,
    handle: String,
    full: bool,
) -> Result<IntegrityReport, String> {
    local_git.with(&handle, |repo| Ok(gc::integrity(repo, full)))
}

#[cfg(test)]
#[path = "localgit_lg09_tests.rs"]
mod tests;
