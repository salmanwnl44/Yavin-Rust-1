use file_tree::WorkspaceManager;
use ide_workspace::durable::{prune_backups, sweep_stale_temps};
use ide_workspace::file_tree::{self, FileNode};
use ide_workspace::recovery::{
    self, DiskState, Effect, Intent, IntentLog, RecoveryReport, Role, STALE_TEMP_AGE,
};
use ide_workspace::resource_events::{
    self, Expectation, ExpectedWrites, OperationKind, ResourceWatch, WatchOutput, WatcherState,
    WatcherStatus,
};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::{env, path::Path, sync::Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
mod checkers;
mod config;
mod external;
mod git;
mod paths;
mod ports;
mod session;
mod terminal;
mod trust;
mod workbench;
use checkers::{available_checkers, cancel_checker, run_checker, Checks};
use external::open_external_url;
use git::{
    git_cancel_repo, git_clone_repo, git_close_repo, git_exec, git_init_repo, git_open_repo,
    git_probe_worktree, git_repo_state, git_unwatch_repo, git_watch_repo, GitJobs, GitWatches,
    NetworkLocks, Repos, StashLocks,
};
use ports::{list_listening_ports, stop_listening_process};
use session::{forget_workspace, read_session, save_workspace_session, Sessions};
use terminal::{
    terminal_close, terminal_close_all, terminal_open, terminal_resize, terminal_shells,
    terminal_write, Terminals,
};
use trust::{forget_trusted_folder, set_workspace_trust, trusted_folders, workspace_trust, Trust};
use workbench::{cancel_search, search_project, write_file_guarded};

struct Workspace(Mutex<Option<WorkspaceManager>>);

/// The live filesystem watch, and what Yavin's own file operations expect it to see.
/// Replacing the watch stops the previous one before anything else can be emitted from it.
#[derive(Default)]
pub(crate) struct Watch {
    current: Mutex<Option<ResourceWatch>>,
    expected: Arc<ExpectedWrites>,
    /// This process's crash-recovery intent log, opened at startup (see `recover_at_startup`).
    /// An error here means no operation can be recorded, and so none is performed.
    intents: OnceLock<Result<IntentLog, String>>,
}

/// What startup recovery found, for the UI to show (`recovery_report`).
#[derive(Default)]
struct Recovery {
    root: OnceLock<PathBuf>,
    report: Mutex<RecoveryReport>,
}

/// Reports every change under `root` to the UI as `resource-changes` batches, and the watch's
/// health as `watcher-status` (see `resource_events`).
fn watch_workspace(app: &AppHandle, watch: &Watch, root: &Path) {
    // The previous watch ends first, so none of its events can follow the new one's.
    if let Ok(mut guard) = watch.current.lock() {
        guard.take();
    }
    let handle = app.clone();
    let started =
        resource_events::start_resource_watcher(root, Arc::clone(&watch.expected), move |output| {
            let _ = match output {
                WatchOutput::Changes(batch) => handle.emit("resource-changes", batch),
                WatchOutput::Status(status) => handle.emit("watcher-status", status),
            };
        });
    match started {
        Ok(active) => {
            if let Ok(mut guard) = watch.current.lock() {
                *guard = Some(active);
            }
        }
        // Losing live updates is not fatal -- the explorer still has manual Refresh -- but
        // the UI is told, rather than left believing the folder is watched.
        Err(error) => {
            eprintln!("Cannot watch workspace: {error}");
            let _ = app.emit(
                "watcher-status",
                WatcherStatus {
                    generation: 0,
                    root: file_tree::clean_path_str(root),
                    state: WatcherState::Failed,
                    message: Some(error),
                },
            );
        }
    }
}

/// One effect of a file operation, described twice: what the watcher's change will be matched
/// against (`expectation`, Module 03), and what crash recovery compares the disk with --
/// before the operation (`pre`) and after it (`post`).
pub(crate) struct Planned {
    path: PathBuf,
    expectation: Expectation,
    pre: DiskState,
    post: DiskState,
    role: Role,
}

impl Planned {
    /// An effect whose `pre` is whatever is at `path` now.
    pub(crate) fn new(path: PathBuf, expectation: Expectation, post: DiskState) -> Self {
        Planned {
            pre: DiskState::observe(&path),
            path,
            expectation,
            post,
            role: Role::Target,
        }
    }

    pub(crate) fn pre(mut self, pre: DiskState) -> Self {
        self.pre = pre;
        self
    }

    pub(crate) fn role(mut self, role: Role) -> Self {
        self.role = role;
        self
    }
}

/// Durably records an operation's intent, before it touches the disk. Fails closed: if the
/// intent cannot be recorded, the caller must not perform the operation.
pub(crate) fn record_intent<'a>(
    watch: &'a Watch,
    operation: u64,
    kind: OperationKind,
    effects: Vec<Effect>,
) -> Result<Intent<'a>, String> {
    let log = watch
        .intents
        .get()
        .ok_or("Crash recovery has not started yet; try again in a moment.")?
        .as_ref()
        .map_err(|error| {
            format!("Crash recovery is unavailable ({error}), so this was not done.")
        })?;
    log.record(operation, kind.into(), effects)
        .map_err(|error| format!("Cannot record this operation for crash recovery: {error}"))
}

/// Runs one file operation as Module 03 describes it, with its crash-recovery intent recorded
/// first:
///
/// ```text
/// begin -> expect every effect -> record the intent durably -> mutate -> finish -> close intent
/// ```
///
/// The watcher credits the changes it causes to it (`operations`); a crash between recording
/// and closing leaves the record for the next start to settle (`recovery`). If the intent
/// cannot be recorded, nothing is done and the error says why.
pub(crate) fn expecting<T>(
    watch: &Watch,
    kind: OperationKind,
    plan: Vec<Planned>,
    run: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let operation = watch.expected.begin(kind);
    let mut effects = Vec::with_capacity(plan.len());
    for planned in plan {
        let path = file_tree::clean_path_str(&planned.path);
        operation.expect(path.clone(), planned.expectation);
        effects.push(Effect {
            path,
            pre: planned.pre,
            post: planned.post,
            role: planned.role,
        });
    }
    // On failure the operation is dropped, which fails it: nothing has touched the disk.
    let intent = record_intent(watch, operation.id(), kind, effects)?;
    let result = run();
    operation.finish(&result);
    intent.close();
    result
}

/// The folders a create of `target` will make on the way, as effects of that create.
pub(crate) fn made_folders(target: &Path) -> Vec<Planned> {
    file_tree::missing_ancestors(target)
        .into_iter()
        .map(|folder| {
            Planned::new(folder, Expectation::Directory, DiskState::Directory).role(Role::Folder)
        })
        .collect()
}

/// Runs `action` on a copy of the workspace so long filesystem work does not hold the lock.
fn with_workspace<T>(
    state: &Workspace,
    action: impl FnOnce(&WorkspaceManager) -> Result<T, String>,
) -> Result<T, String> {
    let manager = state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("Open a workspace first")?;
    action(&manager)
}

/// Release builds start without a workspace; development builds open the current directory.
#[tauri::command(async)]
fn get_default_workspace(
    app: AppHandle,
    state: State<'_, Workspace>,
    watch: State<'_, Watch>,
) -> Result<Option<String>, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if guard.is_none() && cfg!(debug_assertions) {
        *guard = Some(WorkspaceManager::new(
            env::current_dir().map_err(|e| e.to_string())?,
        )?);
    }
    let root = guard.as_ref().map(|manager| manager.root().to_path_buf());
    drop(guard);
    if let Some(root) = &root {
        watch_workspace(&app, &watch, root);
    }
    Ok(root.as_deref().map(file_tree::clean_path_str))
}

#[tauri::command(async)]
fn list_workspace_files(
    state: State<'_, Workspace>,
    path: String,
    max_depth: Option<usize>,
) -> Result<FileNode, String> {
    with_workspace(&state, |manager| {
        manager.list_directory(&path, max_depth.unwrap_or(1).min(12))
    })
}

#[tauri::command(async)]
fn read_file_content(state: State<'_, Workspace>, path: String) -> Result<String, String> {
    with_workspace(&state, |manager| manager.read_file(&path))
}

#[tauri::command(async)]
fn create_file(
    state: State<'_, Workspace>,
    watch: State<'_, Watch>,
    path: String,
) -> Result<(), String> {
    with_workspace(&state, |manager| {
        let target = manager.validate_path(&path)?;
        let mut plan = made_folders(&target);
        plan.push(Planned::new(
            target,
            Expectation::content(b""),
            DiskState::file(b""),
        ));
        expecting(&watch, OperationKind::CreateFile, plan, || {
            manager.create_file(&path)
        })
    })
}

#[tauri::command(async)]
fn create_directory(
    state: State<'_, Workspace>,
    watch: State<'_, Watch>,
    path: String,
) -> Result<(), String> {
    with_workspace(&state, |manager| {
        let target = manager.validate_path(&path)?;
        let mut plan = made_folders(&target);
        plan.push(Planned::new(
            target,
            Expectation::Directory,
            DiskState::Directory,
        ));
        expecting(&watch, OperationKind::CreateDirectory, plan, || {
            manager.create_directory(&path)
        })
    })
}

#[tauri::command(async)]
fn rename_path(
    state: State<'_, Workspace>,
    watch: State<'_, Watch>,
    old_path: String,
    new_path: String,
) -> Result<(), String> {
    with_workspace(&state, |manager| {
        let old = manager.validate_entry(&old_path)?;
        let new = manager.validate_entry(&new_path)?;
        // A case-only rename leaves the old spelling resolving, on a case-insensitive disk, to
        // the same entry -- so it cannot be expected to be gone.
        let case_only = file_tree::clean_path_str(&old).to_lowercase()
            == file_tree::clean_path_str(&new).to_lowercase();
        let (old_after, old_state) = if case_only {
            (Expectation::Present, DiskState::Present)
        } else {
            (Expectation::Absent, DiskState::Absent)
        };
        let plan = vec![
            Planned::new(old, old_after, old_state),
            Planned::new(new, Expectation::Present, DiskState::Present),
        ];
        expecting(&watch, OperationKind::Rename, plan, || {
            manager.rename_path(&old_path, &new_path)
        })
    })
}

#[tauri::command(async)]
fn delete_path(
    state: State<'_, Workspace>,
    watch: State<'_, Watch>,
    path: String,
    recursive: bool,
) -> Result<(), String> {
    with_workspace(&state, |manager| {
        let target = manager.validate_entry(&path)?;
        // A folder is recorded with its entry count, so an interrupted delete of it can be
        // told from one that never started.
        let pre = DiskState::observe_tree(&target);
        let plan = vec![Planned::new(target, Expectation::Absent, DiskState::Absent).pre(pre)];
        expecting(&watch, OperationKind::Delete, plan, || {
            manager.delete_path(&path, recursive)
        })
    })
}

#[tauri::command(async)]
fn duplicate_path(
    state: State<'_, Workspace>,
    watch: State<'_, Watch>,
    path: String,
) -> Result<String, String> {
    with_workspace(&state, |manager| {
        let p = manager.validate_path(&path)?;
        if p == manager.root() {
            return Err("Cannot duplicate the workspace root".into());
        }
        let source = file_tree::clean_path_str(p);
        let destination = file_tree::duplicate_destination(&source)?;
        // Everything written below the destination is the copy's, checked file by file
        // against the source.
        let copy = Expectation::CopyOf {
            source: source.clone(),
        };
        let copied = DiskState::CopyOf {
            source: source.clone(),
        };
        let plan = vec![Planned::new(PathBuf::from(&destination), copy, copied)];
        expecting(&watch, OperationKind::Copy, plan, || {
            file_tree::copy_path(&source, &destination)
        })?;
        Ok(destination)
    })
}

#[tauri::command(async)]
fn reveal_in_explorer(state: State<'_, Workspace>, path: String) -> Result<(), String> {
    with_workspace(&state, |manager| {
        file_tree::reveal_in_os_explorer(&file_tree::clean_path_str(manager.validate_path(&path)?))
    })
}

// Native dialogs stay on the main thread (required on macOS).
#[tauri::command]
fn open_folder_dialog(
    app: AppHandle,
    state: State<'_, Workspace>,
    watch: State<'_, Watch>,
) -> Result<Option<String>, String> {
    file_tree::pick_workspace_folder()?
        .map(|path| enter_workspace(&app, &state, &watch, &path))
        .transpose()
}

/// A chosen folder as a workspace, and the one spelling of its root the UI is given back.
///
/// That spelling is the canonical root, cleaned for the UI -- the same string the tree's root
/// node carries -- never the spelling the folder arrived in. The dialog hands back the path as
/// the user navigated to it (a junction, a `subst` drive, a short name, a different case), and
/// returning that meant one folder had two spellings: the recent list and the session kept the
/// dialog's while the tree and every later lookup used the canonical one, and the explorer and
/// Source Control, keyed on the workspace path, mounted twice as it changed from one to the other.
fn workspace_for(path: &Path) -> Result<(WorkspaceManager, String), String> {
    let manager = WorkspaceManager::new(path)?;
    let root = file_tree::clean_path_str(manager.root());
    Ok((manager, root))
}

/// Makes `path` the window's workspace and starts watching it, whichever way it was chosen.
fn enter_workspace(
    app: &AppHandle,
    state: &State<'_, Workspace>,
    watch: &State<'_, Watch>,
    path: &str,
) -> Result<String, String> {
    let (manager, root) = workspace_for(Path::new(path))?;
    let watched = manager.root().to_path_buf();
    *state.0.lock().map_err(|e| e.to_string())? = Some(manager);
    watch_workspace(app, watch, &watched);
    Ok(root)
}

/// Opens a folder the user has already chosen once -- restoring the last session, or a pick
/// from the recent list -- without putting a dialog in front of them.
///
/// It is as powerful as `open_folder_dialog` and grants the same access: from here on, every
/// file command is bounded by this root rather than the previous one. What it checks is only
/// that the path exists and is a directory (`WorkspaceManager` canonicalizes it) -- not that
/// the user ever chose it, which no command can tell. The protection against opening
/// something unexpected is that the only paths sent here come from the user's own session
/// file. A folder that has been moved or deleted since is reported as an error rather than
/// silently leaving the previous workspace in place.
#[tauri::command(async)]
fn open_workspace(
    app: AppHandle,
    state: State<'_, Workspace>,
    watch: State<'_, Watch>,
    path: String,
) -> Result<String, String> {
    enter_workspace(&app, &state, &watch, &path)
}

// A side-effect-free folder picker: unlike `open_folder_dialog`, this never replaces
// the active file-tree workspace. Used to add an extra repository to Source Control.
#[tauri::command]
fn pick_folder_dialog() -> Result<Option<String>, String> {
    file_tree::pick_workspace_folder()
}

#[tauri::command]
fn open_file_dialog(state: State<'_, Workspace>) -> Result<Option<String>, String> {
    let selected = file_tree::pick_file()?;
    selected
        .map(|path| {
            with_workspace(&state, |manager| {
                manager.validate_path(path).map(file_tree::clean_path_str)
            })
        })
        .transpose()
}

#[tauri::command(async)]
fn copy_path(
    state: State<'_, Workspace>,
    watch: State<'_, Watch>,
    src: String,
    dest: String,
) -> Result<(), String> {
    with_workspace(&state, |manager| {
        let destination = manager.validate_path(&dest)?;
        let source = file_tree::clean_path_str(manager.validate_path(&src)?);
        let target = file_tree::clean_path_str(&destination);
        let copy = Expectation::CopyOf {
            source: source.clone(),
        };
        let copied = DiskState::CopyOf {
            source: source.clone(),
        };
        let mut plan = made_folders(&destination);
        plan.push(Planned::new(destination, copy, copied));
        expecting(&watch, OperationKind::Copy, plan, || {
            file_tree::copy_path(&source, &target)
        })
    })
}

/// Opens this process's intent log and settles whatever a previous Yavin left in progress,
/// before any window can start a new operation. Cost follows the number of interrupted
/// operations, never the size of a project.
fn recover_at_startup(app: &AppHandle) {
    let watch = app.state::<Watch>();
    let state = app.state::<Recovery>();
    let root = app
        .path()
        .app_local_data_dir()
        .map(|folder| folder.join("recovery"))
        .map_err(|error| error.to_string());
    let opened = root.and_then(|root| {
        let log = IntentLog::open(&root)?;
        let report = recovery::recover(&root, log.instance());
        for item in report.actions.iter().chain(&report.unresolved) {
            eprintln!("Recovery ({:?}): {}", item.outcome, item.message);
        }
        if let Ok(mut held) = state.report.lock() {
            *held = report;
        }
        let _ = state.root.set(root);
        Ok(log)
    });
    if let Err(error) = &opened {
        eprintln!("Crash recovery is unavailable: {error}");
    }
    let _ = watch.intents.set(opened);
    // Leftovers of Yavin's own settings writes; the settings files themselves are never swept.
    if let Ok(config) = app.path().app_config_dir() {
        sweep_stale_temps(&config, STALE_TEMP_AGE);
        prune_backups(&config.join("session.json"));
        prune_backups(&config.join("trusted-folders.txt"));
    }
}

/// What startup recovery did, and everything still waiting for the user.
#[tauri::command]
fn recovery_report(state: State<'_, Recovery>) -> Result<RecoveryReport, String> {
    let mut report = state.report.lock().map_err(|e| e.to_string())?.clone();
    if let Some(root) = state.root.get() {
        report.unresolved = recovery::unresolved(root);
    }
    Ok(report)
}

/// The user has dealt with these items: forget them. Nothing else is ever removed.
#[tauri::command]
fn recovery_dismiss(
    state: State<'_, Recovery>,
    ids: Vec<String>,
) -> Result<RecoveryReport, String> {
    let root = state.root.get().ok_or("Crash recovery is unavailable.")?;
    recovery::dismiss(root, &ids)?;
    recovery_report(state)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if let Err(error) = tauri::Builder::default()
        .manage(Workspace(Mutex::new(None)))
        .manage(Watch::default())
        .manage(workbench::Jobs::default())
        .manage(Repos::default())
        .manage(StashLocks::default())
        .manage(NetworkLocks::default())
        .manage(GitJobs::default())
        .manage(GitWatches::default())
        .manage(Terminals::default())
        .manage(Trust::default())
        .manage(Sessions::default())
        .manage(Checks::default())
        .manage(Recovery::default())
        .setup(|app| {
            recover_at_startup(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            recovery_report,
            recovery_dismiss,
            get_default_workspace,
            list_workspace_files,
            read_file_content,
            create_file,
            create_directory,
            rename_path,
            delete_path,
            duplicate_path,
            copy_path,
            reveal_in_explorer,
            open_folder_dialog,
            open_workspace,
            pick_folder_dialog,
            open_file_dialog,
            search_project,
            cancel_search,
            write_file_guarded,
            git_open_repo,
            git_init_repo,
            git_clone_repo,
            git_close_repo,
            git_exec,
            git_cancel_repo,
            git_probe_worktree,
            open_external_url,
            available_checkers,
            workspace_trust,
            set_workspace_trust,
            trusted_folders,
            forget_trusted_folder,
            read_session,
            save_workspace_session,
            forget_workspace,
            run_checker,
            cancel_checker,
            list_listening_ports,
            stop_listening_process,
            git_repo_state,
            git_watch_repo,
            git_unwatch_repo,
            terminal_shells,
            terminal_open,
            terminal_write,
            terminal_resize,
            terminal_close,
            terminal_close_all,
        ])
        .build(tauri::generate_context!())
        .map(|app| {
            // Shells are children of this process, not of the window, so they have to be
            // ended explicitly or they outlive the application.
            app.run(|handle, event| {
                if matches!(
                    event,
                    tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
                ) {
                    terminal::close_all(&handle.state::<Terminals>());
                    // A checker is a child process too, and a cold `cargo check` outlives
                    // the window by minutes if nothing stops it.
                    checkers::cancel_running(&handle.state::<Checks>());
                    // Leftover temporary files of this process's own records. The records
                    // themselves are gone unless an operation is still running, which the
                    // next start then settles.
                    if let Some(Ok(log)) = handle.state::<Watch>().intents.get() {
                        log.sweep();
                    }
                }
            })
        })
    {
        eprintln!("Failed to run Yavin: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_folder(name: &str) -> PathBuf {
        let dir = env::temp_dir()
            .join(format!("yavin-open-{}", std::process::id()))
            .join(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        dir
    }

    /// What the UI is told the workspace root is, for a folder chosen spelled as `spelling`,
    /// checked against the root node the explorer then lists for it -- the two have to be one
    /// string, or the recent list, the session and the explorer each hold a different one.
    fn opened_as(spelling: &str) -> String {
        let (manager, root) = workspace_for(Path::new(spelling)).unwrap();
        let tree = manager.list_directory(&root, 1).unwrap();
        assert_eq!(root, tree.path, "the root returned for {spelling}");
        root
    }

    #[test]
    fn every_spelling_of_a_chosen_folder_opens_as_the_explorers_root() {
        let dir = temp_folder("Spelled");
        let canonical = opened_as(&dir.to_string_lossy());
        let spellings = if cfg!(windows) {
            let plain = dir.to_string_lossy().to_string();
            vec![
                format!(r"{plain}\"),
                plain.replace('\\', "/"),
                plain.to_uppercase(),
                plain.to_lowercase(),
                format!(r"\\?\{plain}"),
                format!(r"{plain}\src\.."),
            ]
        } else {
            let plain = dir.to_string_lossy().to_string();
            vec![format!("{plain}/"), format!("{plain}/src/..")]
        };
        for spelling in spellings {
            assert_eq!(opened_as(&spelling), canonical, "{spelling}");
        }
        // The one spelling is the cleaned form the rest of the UI compares against: no
        // extended-length prefix, `/` separators.
        assert!(!canonical.starts_with("//?/") && !canonical.contains('\\'));
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn records_in(root: &Path) -> usize {
        std::fs::read_dir(root.join("instances"))
            .map(|instances| {
                instances
                    .flatten()
                    .flat_map(|i| std::fs::read_dir(i.path()).into_iter().flatten().flatten())
                    .filter(|f| f.file_name().to_string_lossy().starts_with("op-"))
                    .count()
            })
            .unwrap_or(0)
    }

    /// The whole path, through `expecting` as the save command drives it: the intent is
    /// recorded, the temporary file is written, and then the process dies. The next start
    /// finds the target untouched and the temporary file complete, and finishes the save.
    #[test]
    fn a_save_interrupted_by_a_crash_is_finished_at_the_next_start() {
        use ide_workspace::recovery::Outcome;
        let root = temp_folder("recovery-root");
        let dir = temp_folder("recovery-files");
        let target = dir.join("a.ts");
        std::fs::write(&target, "before").unwrap();
        let temporary = file_tree::temp_path_for(&target, 7);

        let watch = Watch::default();
        watch
            .intents
            .set(Ok(IntentLog::open(&root).unwrap()))
            .unwrap();
        let plan = vec![
            Planned::new(
                temporary.clone(),
                Expectation::transient(b"after"),
                DiskState::file(b"after"),
            )
            .pre(DiskState::Absent)
            .role(Role::Temporary),
            Planned::new(
                target.clone(),
                Expectation::content(b"after"),
                DiskState::file(b"after"),
            )
            .pre(DiskState::file(b"before")),
        ];
        let died = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            expecting(
                &watch,
                OperationKind::Save,
                plan,
                || -> Result<(), String> {
                    std::fs::write(&temporary, "after").unwrap();
                    panic!("the process dies between writing the temporary file and renaming it");
                },
            )
        }));
        assert!(died.is_err());
        assert_eq!(records_in(&root), 1, "the intent outlives the crash");
        drop(watch); // The process is gone: its instance lock goes with it.

        let report = recovery::recover(&root, "the-next-start");
        assert_eq!(report.actions.len(), 1, "{report:?}");
        assert_eq!(report.actions[0].outcome, Outcome::RolledForward);
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "after");
        assert!(!temporary.exists());
        assert_eq!(records_in(&root), 0);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_operation_whose_intent_cannot_be_recorded_is_not_performed() {
        let dir = temp_folder("refused");
        let target = dir.join("new.ts");
        let watch = Watch::default();
        watch
            .intents
            .set(Err("the recovery folder cannot be created".into()))
            .unwrap();
        let mut ran = false;
        let plan = vec![Planned::new(
            target.clone(),
            Expectation::content(b""),
            DiskState::file(b""),
        )];
        let result = expecting(&watch, OperationKind::CreateFile, plan, || {
            ran = true;
            std::fs::write(&target, "").map_err(|e| e.to_string())
        });
        assert!(result
            .unwrap_err()
            .contains("Crash recovery is unavailable"));
        assert!(!ran, "nothing touched the disk");
        assert!(!target.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_operation_that_ends_either_way_leaves_no_record() {
        let root = temp_folder("closed-root");
        let dir = temp_folder("closed-files");
        let watch = Watch::default();
        watch
            .intents
            .set(Ok(IntentLog::open(&root).unwrap()))
            .unwrap();
        let target = dir.join("made");
        let plan = || {
            vec![Planned::new(
                target.clone(),
                Expectation::Directory,
                DiskState::Directory,
            )]
        };
        expecting(&watch, OperationKind::CreateDirectory, plan(), || {
            std::fs::create_dir(&target).map_err(|e| e.to_string())
        })
        .unwrap();
        assert_eq!(records_in(&root), 0);
        // A failure the live process reports is not a crash: nothing is left for recovery.
        let failed: Result<(), String> =
            expecting(&watch, OperationKind::CreateDirectory, plan(), || {
                Err("already exists".into())
            });
        assert!(failed.is_err());
        assert_eq!(records_in(&root), 0);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
