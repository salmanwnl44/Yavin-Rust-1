use file_tree::WorkspaceManager;
use ide_workspace::file_tree::{self, FileNode};
use std::{env, sync::Mutex};
use tauri::State;
mod workbench;
use workbench::{cancel_search, git_workbench, search_project, write_file_guarded};

struct Workspace(Mutex<Option<WorkspaceManager>>);

fn with_workspace<T>(
    state: &Workspace,
    action: impl FnOnce(&WorkspaceManager) -> Result<T, String>,
) -> Result<T, String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    action(guard.as_ref().ok_or("Open a workspace first")?)
}

#[tauri::command]
fn get_default_workspace(state: State<'_, Workspace>) -> Result<String, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if guard.is_none() {
        *guard = Some(WorkspaceManager::new(
            env::current_dir().map_err(|e| e.to_string())?,
        )?);
    }
    guard
        .as_ref()
        .map(|manager| file_tree::clean_path_str(manager.root()))
        .ok_or_else(|| "Workspace initialization failed".into())
}

#[tauri::command]
fn list_workspace_files(
    state: State<'_, Workspace>,
    path: String,
    max_depth: Option<usize>,
) -> Result<FileNode, String> {
    with_workspace(&state, |manager| {
        let validated = manager.validate_path(&path)?;
        file_tree::list_directory(
            &file_tree::clean_path_str(validated),
            Some(max_depth.unwrap_or(6).min(12)),
        )
    })
}

#[tauri::command]
fn read_file_content(state: State<'_, Workspace>, path: String) -> Result<String, String> {
    with_workspace(&state, |manager| manager.read_file(&path))
}

#[tauri::command]
fn create_file(state: State<'_, Workspace>, path: String) -> Result<(), String> {
    with_workspace(&state, |manager| manager.create_file(&path))
}

#[tauri::command]
fn create_directory(state: State<'_, Workspace>, path: String) -> Result<(), String> {
    with_workspace(&state, |manager| manager.create_directory(&path))
}

#[tauri::command]
fn rename_path(
    state: State<'_, Workspace>,
    old_path: String,
    new_path: String,
) -> Result<(), String> {
    with_workspace(&state, |manager| manager.rename_path(&old_path, &new_path))
}

#[tauri::command]
fn delete_path(state: State<'_, Workspace>, path: String, recursive: bool) -> Result<(), String> {
    with_workspace(&state, |manager| manager.delete_path(&path, recursive))
}

#[tauri::command]
fn duplicate_path(state: State<'_, Workspace>, path: String) -> Result<String, String> {
    with_workspace(&state, |manager| {
        let p = manager.validate_path(&path)?;
        if p == manager.root() {
            return Err("Cannot duplicate the workspace root".into());
        }
        file_tree::duplicate_path(&file_tree::clean_path_str(p))
    })
}

#[tauri::command]
fn reveal_in_explorer(state: State<'_, Workspace>, path: String) -> Result<(), String> {
    with_workspace(&state, |manager| {
        file_tree::reveal_in_os_explorer(&file_tree::clean_path_str(manager.validate_path(&path)?))
    })
}

#[tauri::command]
fn open_folder_dialog(state: State<'_, Workspace>) -> Result<Option<String>, String> {
    let selected = file_tree::pick_workspace_folder()?;
    if let Some(path) = &selected {
        let manager = WorkspaceManager::new(path)?;
        *state.0.lock().map_err(|e| e.to_string())? = Some(manager);
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

#[tauri::command]
fn copy_path(state: State<'_, Workspace>, src: String, dest: String) -> Result<(), String> {
    with_workspace(&state, |manager| {
        file_tree::copy_path(
            &file_tree::clean_path_str(manager.validate_path(&src)?),
            &file_tree::clean_path_str(manager.validate_path(&dest)?),
        )
    })
}

#[tauri::command]
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
