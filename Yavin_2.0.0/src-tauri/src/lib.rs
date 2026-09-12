use file_tree::WorkspaceManager;
use ide_workspace::file_tree::{self, FileNode};
use ide_workspace::watcher::{self, RecommendedWatcher};
use std::{env, path::Path, sync::Mutex};
use tauri::{AppHandle, Emitter, State};
mod workbench;
use workbench::{cancel_search, git_workbench, search_project, write_file_guarded};

struct Workspace(Mutex<Option<WorkspaceManager>>);

/// Holds the live filesystem watcher; replacing it stops watching the previous root.
#[derive(Default)]
struct Watch(Mutex<Option<RecommendedWatcher>>);

/// Reports edits made outside the app (a checkout, a build, another editor) to the UI.
fn watch_workspace(app: &AppHandle, watch: &Watch, root: &Path) {
    let handle = app.clone();
    let started = watcher::start_watcher(root, move || {
        let _ = handle.emit("workspace-changed", ());
    });
    match started {
        Ok(active) => {
            if let Ok(mut guard) = watch.0.lock() {
                *guard = Some(active);
            }
        }
        // Losing live updates is not fatal; the explorer still has manual Refresh.
        Err(error) => eprintln!("Cannot watch workspace: {error}"),
    }
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
fn create_file(state: State<'_, Workspace>, path: String) -> Result<(), String> {
    with_workspace(&state, |manager| manager.create_file(&path))
}

#[tauri::command(async)]
fn create_directory(state: State<'_, Workspace>, path: String) -> Result<(), String> {
    with_workspace(&state, |manager| manager.create_directory(&path))
}

#[tauri::command(async)]
fn rename_path(
    state: State<'_, Workspace>,
    old_path: String,
    new_path: String,
) -> Result<(), String> {
    with_workspace(&state, |manager| manager.rename_path(&old_path, &new_path))
}

#[tauri::command(async)]
fn delete_path(state: State<'_, Workspace>, path: String, recursive: bool) -> Result<(), String> {
    with_workspace(&state, |manager| manager.delete_path(&path, recursive))
}

#[tauri::command(async)]
fn duplicate_path(state: State<'_, Workspace>, path: String) -> Result<String, String> {
    with_workspace(&state, |manager| {
        let p = manager.validate_path(&path)?;
        if p == manager.root() {
            return Err("Cannot duplicate the workspace root".into());
        }
        file_tree::duplicate_path(&file_tree::clean_path_str(p))
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
    let selected = file_tree::pick_workspace_folder()?;
    if let Some(path) = &selected {
        let manager = WorkspaceManager::new(path)?;
        let root = manager.root().to_path_buf();
        *state.0.lock().map_err(|e| e.to_string())? = Some(manager);
        watch_workspace(&app, &watch, &root);
    }
    Ok(selected)
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
fn copy_path(state: State<'_, Workspace>, src: String, dest: String) -> Result<(), String> {
    with_workspace(&state, |manager| {
        file_tree::copy_path(
            &file_tree::clean_path_str(manager.validate_path(&src)?),
            &file_tree::clean_path_str(manager.validate_path(&dest)?),
        )
    })
}

#[tauri::command(async)]
fn get_git_status(
    state: State<'_, Workspace>,
    path: String,
) -> Result<ide_workspace::git::GitStatus, String> {
    with_workspace(&state, |manager| {
        ide_workspace::git::get_workspace_git_status(&file_tree::clean_path_str(
            manager.validate_path(&path)?,
        ))
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if let Err(error) = tauri::Builder::default()
        .manage(Workspace(Mutex::new(None)))
        .manage(Watch::default())
        .manage(workbench::Jobs::default())
        .manage(workbench::GitLock::default())
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
            open_file_dialog,
            get_git_status,
            search_project,
            cancel_search,
            write_file_guarded,
            git_workbench,
        ])
        .run(tauri::generate_context!())
    {
        eprintln!("Failed to run Yavin: {error}");
        std::process::exit(1);
    }
}
