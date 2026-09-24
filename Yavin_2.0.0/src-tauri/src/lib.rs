use file_tree::WorkspaceManager;
use ide_workspace::file_tree::{self, FileNode};
use ide_workspace::resource_events::{
    self, Expectation, ExpectedWrites, ResourceWatch, WatchOutput, WatcherState, WatcherStatus,
};
use std::path::PathBuf;
use std::sync::Arc;
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

/// Runs a file operation with its results registered first, so the watcher can recognise the
/// changes it causes as Yavin's (`ExpectedWrites`). The expectations are settled whatever the
/// outcome: a failed operation's are dropped at once.
pub(crate) fn expecting<T>(
    watch: &Watch,
    results: Vec<(PathBuf, Expectation)>,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let id = watch.expected.expect(
        results
            .into_iter()
            .map(|(path, expectation)| (file_tree::clean_path_str(path), expectation))
            .collect(),
    );
    let result = operation();
    watch.expected.settle(id, result.is_ok());
    result
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
        expecting(&watch, vec![(target, Expectation::content(b""))], || {
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
        expecting(&watch, vec![(target, Expectation::Directory)], || {
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
        let old_after = if case_only {
            Expectation::Present
        } else {
            Expectation::Absent
        };
        expecting(
            &watch,
            vec![(old, old_after), (new, Expectation::Present)],
            || manager.rename_path(&old_path, &new_path),
        )
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
        expecting(&watch, vec![(target, Expectation::Absent)], || {
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
        expecting(
            &watch,
            vec![(PathBuf::from(&destination), Expectation::Present)],
            || file_tree::copy_path(&source, &destination),
        )?;
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
        expecting(&watch, vec![(destination, Expectation::Present)], || {
            file_tree::copy_path(&source, &target)
        })
    })
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
        .invoke_handler(tauri::generate_handler![
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
}
