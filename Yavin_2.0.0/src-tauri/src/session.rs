//! The session: the folders Yavin has opened, and what each of them looked like.
//!
//! Closing the window and opening it again should land you back where you were -- the same
//! folder, the same editor tabs, the same part of the tree unfolded. That is the whole point
//! of this module, and it is why the state lives in the user's own config directory rather
//! than in the webview's storage: it has to survive a cleared cache, and it should be
//! readable and removable by hand.
//!
//! Everything here is bounded. A session file that grew with every folder ever opened, or
//! with every folder ever unfolded inside a large project, would eventually cost more to read
//! at startup than the feature is worth, so the lists are capped and the oldest entries fall
//! off. The caps are the only reason this cannot become a slow startup.

use crate::paths::normalise;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

/// Folders remembered in the recent list. Enough to cover the projects someone moves
/// between in a week, short enough to stay a list rather than a search problem.
const MAX_FOLDERS: usize = 15;
/// Editor tabs remembered per folder. Beyond this, reopening costs more than it restores.
const MAX_FILES: usize = 50;
/// Unfolded directories remembered per folder, so one enormous tree cannot bloat the file.
const MAX_EXPANDED: usize = 500;

/// What one folder looked like when it was last open.
#[derive(Serialize, Deserialize, Clone, Default, Debug, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct WorkspaceSession {
    pub folder: String,
    /// Open editor tabs, in tab order.
    pub files: Vec<String>,
    /// The tab that was in front, if any of `files` was.
    pub active: Option<String>,
    /// Directories the explorer had unfolded.
    pub expanded: Vec<String>,
    /// Where the explorer was scrolled, in pixels.
    pub scroll: u32,
}

/// The whole session. `folders` is the recent list, most recent first; its head is the
/// folder to reopen. Keeping one ordered list rather than a separate "last folder" means
/// the two can never disagree about which folder that is.
#[derive(Serialize, Deserialize, Clone, Default, Debug, PartialEq)]
#[serde(default)]
pub struct Session {
    pub folders: Vec<String>,
    pub workspaces: Vec<WorkspaceSession>,
}

impl Session {
    /// Moves `folder` to the front of the recent list, without duplicating a folder that is
    /// merely spelled differently, and drops whatever falls off the end.
    fn promote(&mut self, folder: &str) {
        let key = normalise(Path::new(folder));
        self.folders
            .retain(|existing| normalise(Path::new(existing)) != key);
        self.folders.insert(0, folder.to_string());
        self.folders.truncate(MAX_FOLDERS);
    }

    /// Removes a folder from the recent list and forgets what it looked like.
    fn forget(&mut self, folder: &str) {
        let key = normalise(Path::new(folder));
        self.folders
            .retain(|existing| normalise(Path::new(existing)) != key);
        self.workspaces
            .retain(|state| normalise(Path::new(&state.folder)) != key);
    }

    fn remember(&mut self, mut state: WorkspaceSession) {
        state.files.truncate(MAX_FILES);
        state.expanded.truncate(MAX_EXPANDED);
        // An active tab that is not open is not a tab; dropping it here means the UI never
        // has to defend against restoring a selection it cannot show.
        if let Some(active) = &state.active {
            if !state.files.iter().any(|file| file == active) {
                state.active = None;
            }
        }
        let key = normalise(Path::new(&state.folder));
        self.workspaces
            .retain(|existing| normalise(Path::new(&existing.folder)) != key);
        self.promote(&state.folder);
        self.workspaces.push(state);
        self.prune();
    }

    /// Drops state for folders that are no longer in the recent list: they can never be
    /// restored from the UI again, so keeping their tabs would only grow the file.
    fn prune(&mut self) {
        let keys: Vec<String> = self
            .folders
            .iter()
            .map(|folder| normalise(Path::new(folder)))
            .collect();
        self.workspaces
            .retain(|state| keys.contains(&normalise(Path::new(&state.folder))));
    }

    /// The state remembered for one folder. The UI is handed the whole session in a single
    /// call and looks its folder up there, so this is here for the tests that assert what
    /// was actually stored.
    #[cfg(test)]
    fn workspace(&self, folder: &str) -> Option<&WorkspaceSession> {
        let key = normalise(Path::new(folder));
        self.workspaces
            .iter()
            .find(|state| normalise(Path::new(&state.folder)) == key)
    }
}

/// The session file, loaded once and written through on every change.
#[derive(Default)]
pub struct Sessions(pub Mutex<Option<Store>>);

pub struct Store {
    file: PathBuf,
    session: Session,
}

impl Store {
    fn load(file: PathBuf) -> Store {
        // A session that cannot be read is not worth failing to start over: the worst case
        // is opening the way a first run does.
        let session = fs::read_to_string(&file)
            .ok()
            .and_then(|text| serde_json::from_str::<Session>(&text).ok())
            .unwrap_or_default();
        Store { file, session }
    }

    /// Writes through a temporary file, so a crash or a full disk mid-write leaves the
    /// previous session intact rather than a half-written one that reads as empty.
    fn save(&self) -> Result<(), String> {
        if let Some(parent) = self.file.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("Cannot save the session: {e}"))?;
        }
        let text = serde_json::to_string_pretty(&self.session)
            .map_err(|e| format!("Cannot save the session: {e}"))?;
        let temporary = self.file.with_extension("json.writing");
        fs::write(&temporary, text).map_err(|e| format!("Cannot save the session: {e}"))?;
        fs::rename(&temporary, &self.file).map_err(|e| {
            let _ = fs::remove_file(&temporary);
            format!("Cannot save the session: {e}")
        })
    }
}

fn store<'a>(
    app: &AppHandle,
    sessions: &'a State<'_, Sessions>,
) -> Result<std::sync::MutexGuard<'a, Option<Store>>, String> {
    let mut guard = sessions.0.lock().map_err(|e| e.to_string())?;
    if guard.is_none() {
        let directory = app
            .path()
            .app_config_dir()
            .map_err(|e| format!("Cannot find the settings folder: {e}"))?;
        *guard = Some(Store::load(directory.join("session.json")));
    }
    Ok(guard)
}

#[tauri::command]
pub fn read_session(app: AppHandle, sessions: State<'_, Sessions>) -> Result<Session, String> {
    let guard = store(&app, &sessions)?;
    Ok(guard.as_ref().expect("loaded").session.clone())
}

/// Records what a folder looks like now, and makes it the folder to reopen.
#[tauri::command]
pub fn save_workspace_session(
    app: AppHandle,
    sessions: State<'_, Sessions>,
    state: WorkspaceSession,
) -> Result<(), String> {
    if state.folder.is_empty() {
        return Err("A session needs a folder.".into());
    }
    let mut guard = store(&app, &sessions)?;
    let held = guard.as_mut().expect("loaded");
    held.session.remember(state);
    held.save()
}

/// Removes a folder from the recent list, for "Remove from Recently Opened".
#[tauri::command]
pub fn forget_workspace(
    app: AppHandle,
    sessions: State<'_, Sessions>,
    folder: String,
) -> Result<Session, String> {
    let mut guard = store(&app, &sessions)?;
    let held = guard.as_mut().expect("loaded");
    held.session.forget(&folder);
    held.save()?;
    Ok(held.session.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("yavin-session-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn store_at(dir: &Path) -> Store {
        Store::load(dir.join("session.json"))
    }

    fn workspace(folder: &str, files: &[&str]) -> WorkspaceSession {
        WorkspaceSession {
            folder: folder.to_string(),
            files: files.iter().map(|file| file.to_string()).collect(),
            active: files.first().map(|file| file.to_string()),
            expanded: Vec::new(),
            scroll: 0,
        }
    }

    #[test]
    fn a_folder_and_its_tabs_come_back_after_a_restart() {
        let dir = temp("restart");
        let mut store = store_at(&dir);
        store
            .session
            .remember(workspace("/work/project", &["/work/project/a.ts"]));
        store.save().unwrap();

        let reloaded = store_at(&dir);
        assert_eq!(reloaded.session.folders.first().unwrap(), "/work/project");
        let state = reloaded.session.workspace("/work/project").unwrap();
        assert_eq!(state.files, vec!["/work/project/a.ts".to_string()]);
        assert_eq!(state.active.as_deref(), Some("/work/project/a.ts"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn opening_a_folder_again_moves_it_to_the_front_rather_than_listing_it_twice() {
        let mut session = Session::default();
        session.remember(workspace("/work/one", &[]));
        session.remember(workspace("/work/two", &[]));
        session.remember(workspace("/work/one", &[]));
        assert_eq!(session.folders, vec!["/work/one", "/work/two"]);
    }

    #[test]
    fn the_same_folder_spelled_differently_is_the_same_folder() {
        // Windows hands back either separator and either case.
        let mut session = Session::default();
        session.remember(workspace("C:\\Work\\Project", &[]));
        session.remember(workspace("c:/work/project", &["c:/work/project/a.ts"]));
        assert_eq!(session.folders.len(), 1);
        assert_eq!(session.workspaces.len(), 1);
        assert_eq!(
            session.workspace("C:/WORK/PROJECT").unwrap().files,
            vec!["c:/work/project/a.ts".to_string()]
        );
    }

    #[test]
    fn the_recent_list_is_capped_and_the_oldest_falls_off() {
        let mut session = Session::default();
        for index in 0..MAX_FOLDERS + 5 {
            session.remember(workspace(&format!("/work/p{index}"), &[]));
        }
        assert_eq!(session.folders.len(), MAX_FOLDERS);
        assert_eq!(session.folders[0], format!("/work/p{}", MAX_FOLDERS + 4));
        assert!(!session.folders.contains(&"/work/p0".to_string()));
    }

    #[test]
    fn state_for_a_folder_that_fell_off_the_list_is_dropped_with_it() {
        // Otherwise the file keeps growing with tabs for folders the UI can no longer reach.
        let mut session = Session::default();
        for index in 0..MAX_FOLDERS + 3 {
            session.remember(workspace(&format!("/work/p{index}"), &["/work/p/a.ts"]));
        }
        assert_eq!(session.workspaces.len(), MAX_FOLDERS);
        assert!(session.workspace("/work/p0").is_none());
    }

    #[test]
    fn one_enormous_project_cannot_bloat_the_file() {
        let mut session = Session::default();
        let files: Vec<String> = (0..MAX_FILES + 40)
            .map(|n| format!("/work/{n}.ts"))
            .collect();
        session.remember(WorkspaceSession {
            folder: "/work".into(),
            files: files.clone(),
            active: Some(files[0].clone()),
            expanded: (0..MAX_EXPANDED + 200)
                .map(|n| format!("/work/{n}"))
                .collect(),
            scroll: 0,
        });
        let state = session.workspace("/work").unwrap();
        assert_eq!(state.files.len(), MAX_FILES);
        assert_eq!(state.expanded.len(), MAX_EXPANDED);
    }

    #[test]
    fn an_active_tab_that_is_not_open_is_not_restored() {
        let mut session = Session::default();
        session.remember(WorkspaceSession {
            folder: "/work".into(),
            files: vec!["/work/a.ts".into()],
            active: Some("/work/closed.ts".into()),
            ..Default::default()
        });
        assert_eq!(session.workspace("/work").unwrap().active, None);
    }

    #[test]
    fn forgetting_a_folder_removes_it_and_what_it_looked_like() {
        let mut session = Session::default();
        session.remember(workspace("/work/one", &["/work/one/a.ts"]));
        session.remember(workspace("/work/two", &[]));
        session.forget("/work/one");
        assert_eq!(session.folders, vec!["/work/two"]);
        assert!(session.workspace("/work/one").is_none());
    }

    #[test]
    fn a_corrupt_or_missing_session_starts_as_a_first_run_rather_than_failing() {
        let dir = temp("corrupt");
        fs::write(dir.join("session.json"), "{ this is not json").unwrap();
        assert_eq!(store_at(&dir).session, Session::default());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_session_written_from_an_older_version_keeps_the_fields_it_does_have() {
        // Fields are all optional, so adding one later cannot make an old file unreadable.
        let dir = temp("older");
        fs::write(
            dir.join("session.json"),
            r#"{"folders":["/work"],"workspaces":[{"folder":"/work"}]}"#,
        )
        .unwrap();
        let store = store_at(&dir);
        assert_eq!(store.session.folders, vec!["/work"]);
        assert_eq!(store.session.workspace("/work").unwrap().files.len(), 0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn saving_leaves_the_session_file_and_nothing_else_behind() {
        // The write goes through a temporary file; leaving it would be read as garbage next
        // time someone went looking for the session by hand.
        let dir = temp("atomic");
        let mut store = store_at(&dir);
        store.session.remember(workspace("/work", &[]));
        store.save().unwrap();
        let names: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["session.json".to_string()]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_save_replaces_the_previous_contents_rather_than_appending() {
        let dir = temp("replace");
        let mut store = store_at(&dir);
        store.session.remember(workspace("/work/one", &[]));
        store.save().unwrap();
        store.session.remember(workspace("/work/two", &[]));
        store.save().unwrap();

        let reloaded = store_at(&dir);
        assert_eq!(reloaded.session.folders, vec!["/work/two", "/work/one"]);
        let _ = fs::remove_dir_all(&dir);
    }
}
