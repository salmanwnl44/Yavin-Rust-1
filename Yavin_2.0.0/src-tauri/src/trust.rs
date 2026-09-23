//! Workspace Trust: whether the folder that is open is allowed to make Yavin run its code.
//!
//! Opening a repository should not run anything it contains. Some features necessarily do --
//! `cargo check` runs `build.rs` and proc macros, `eslint.config.js` is JavaScript evaluated
//! on load, `npx` resolves binaries out of the project's own `node_modules`. Trust is the
//! decision about whether this particular folder may do that.
//!
//! Two things are deliberate, both copied from VS Code because the reasoning holds:
//!
//! * **The decision lives in the user's own config directory, never in the workspace.** A
//!   folder that could declare itself trusted would make the whole feature pointless.
//! * **Restricted mode blocks what runs *without being asked*, not what the user does
//!   deliberately.** Editing, saving, searching, Git and the terminal all keep working;
//!   opening a terminal is an explicit act, and a mode that blocked it would just teach
//!   people to click Trust without reading. What is blocked is running the project's
//!   toolchain.

use crate::paths::normalise;
use crate::{with_workspace, Workspace};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

/// What the user has decided about a folder. A remembered "restricted" is why opening the
/// same folder again does not ask a second time.
#[derive(Clone, Copy, PartialEq)]
enum Decision {
    Trusted,
    Restricted,
}

#[derive(Default)]
pub struct Trust(pub Mutex<Option<Store>>);

pub struct Store {
    file: PathBuf,
    entries: Vec<(Decision, PathBuf)>,
}

/// Whether `folder` is `ancestor` or sits underneath it. Compared per segment so
/// `/work/project-two` is not treated as living inside `/work/project`.
fn within(ancestor: &str, folder: &str) -> bool {
    let ancestor = ancestor.trim_end_matches('/');
    folder == ancestor || folder.starts_with(&format!("{ancestor}/"))
}

impl Store {
    fn load(file: PathBuf) -> Store {
        let mut entries = Vec::new();
        if let Ok(text) = fs::read_to_string(&file) {
            for line in text.lines() {
                let Some((kind, path)) = line.split_once('\t') else {
                    continue;
                };
                let decision = match kind {
                    "trust" => Decision::Trusted,
                    "restrict" => Decision::Restricted,
                    _ => continue,
                };
                if !path.is_empty() {
                    entries.push((decision, PathBuf::from(path)));
                }
            }
        }
        Store { file, entries }
    }

    fn save(&self) -> Result<(), String> {
        if let Some(parent) = self.file.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("Cannot save trust settings: {e}"))?;
        }
        let text: String = self
            .entries
            .iter()
            .map(|(decision, path)| {
                let kind = match decision {
                    Decision::Trusted => "trust",
                    Decision::Restricted => "restrict",
                };
                format!("{kind}\t{}\n", path.to_string_lossy())
            })
            .collect();
        fs::write(&self.file, text).map_err(|e| format!("Cannot save trust settings: {e}"))
    }

    /// The decision covering `folder`: its own, or the nearest ancestor's. The longest match
    /// wins, so trusting a parent and then restricting one project inside it behaves the way
    /// it reads.
    fn decision_for(&self, folder: &Path) -> Option<Decision> {
        let wanted = normalise(folder);
        self.entries
            .iter()
            .filter(|(_, path)| within(&normalise(path), &wanted))
            .max_by_key(|(_, path)| normalise(path).len())
            .map(|(decision, _)| *decision)
    }

    fn remember(&mut self, folder: &Path, decision: Decision) {
        let wanted = normalise(folder);
        self.entries.retain(|(_, path)| normalise(path) != wanted);
        self.entries.push((decision, folder.to_path_buf()));
    }

    fn forget(&mut self, folder: &Path) {
        let wanted = normalise(folder);
        self.entries.retain(|(_, path)| normalise(path) != wanted);
    }
}

#[derive(Serialize)]
pub struct TrustState {
    /// Whether the project's toolchain may be run. An empty window is trusted: there is no
    /// untrusted content in it to protect against.
    pub trusted: bool,
    /// False when this folder has never been decided, which is what prompts the user.
    pub decided: bool,
    /// The open folder, or null when there is none.
    pub root: Option<String>,
    /// The folder whose trust could be granted in one step to cover sibling projects too.
    pub parent: Option<String>,
}

fn store<'a>(
    app: &AppHandle,
    trust: &'a State<'_, Trust>,
) -> Result<std::sync::MutexGuard<'a, Option<Store>>, String> {
    let mut guard = trust.0.lock().map_err(|e| e.to_string())?;
    if guard.is_none() {
        let directory = app
            .path()
            .app_config_dir()
            .map_err(|e| format!("Cannot find the settings folder: {e}"))?;
        *guard = Some(Store::load(directory.join("trusted-folders.txt")));
    }
    Ok(guard)
}

fn workspace_root(state: &State<'_, Workspace>) -> Option<PathBuf> {
    with_workspace(state, |manager| Ok(manager.root().to_path_buf())).ok()
}

fn state_for(store: &Store, root: Option<PathBuf>) -> TrustState {
    let Some(root) = root else {
        // No folder open: nothing untrusted can be in scope.
        return TrustState {
            trusted: true,
            decided: true,
            root: None,
            parent: None,
        };
    };
    let decision = store.decision_for(&root);
    TrustState {
        trusted: decision == Some(Decision::Trusted),
        decided: decision.is_some(),
        parent: root
            .parent()
            .map(|parent| parent.to_string_lossy().into_owned()),
        root: Some(root.to_string_lossy().into_owned()),
    }
}

#[tauri::command]
pub fn workspace_trust(
    app: AppHandle,
    state: State<'_, Workspace>,
    trust: State<'_, Trust>,
) -> Result<TrustState, String> {
    let guard = store(&app, &trust)?;
    Ok(state_for(
        guard.as_ref().expect("loaded"),
        workspace_root(&state),
    ))
}

/// Records the decision for the open folder, or for its parent when `parent` is set -- the
/// "trust everything under here" case, which is how someone with all their projects in one
/// directory avoids being asked about each of them.
#[tauri::command]
pub fn set_workspace_trust(
    app: AppHandle,
    state: State<'_, Workspace>,
    trust: State<'_, Trust>,
    trusted: bool,
    parent: bool,
) -> Result<TrustState, String> {
    let root = workspace_root(&state).ok_or("No folder is open.")?;
    let target = if parent {
        root.parent().map(Path::to_path_buf).unwrap_or(root.clone())
    } else {
        root.clone()
    };
    // The store is one line per folder, so a path containing either separator could not be
    // read back. Refusing is better than silently trusting the wrong thing.
    let text = target.to_string_lossy();
    if text.contains('\t') || text.contains('\n') || text.contains('\r') {
        return Err("That folder's name cannot be stored in the trust settings.".into());
    }

    let mut guard = store(&app, &trust)?;
    let held = guard.as_mut().expect("loaded");
    held.remember(
        &target,
        if trusted {
            Decision::Trusted
        } else {
            Decision::Restricted
        },
    );
    held.save()?;
    Ok(state_for(held, Some(root)))
}

#[tauri::command]
pub fn trusted_folders(app: AppHandle, trust: State<'_, Trust>) -> Result<Vec<String>, String> {
    let guard = store(&app, &trust)?;
    Ok(guard
        .as_ref()
        .expect("loaded")
        .entries
        .iter()
        .filter(|(decision, _)| *decision == Decision::Trusted)
        .map(|(_, path)| path.to_string_lossy().into_owned())
        .collect())
}

#[tauri::command]
pub fn forget_trusted_folder(
    app: AppHandle,
    state: State<'_, Workspace>,
    trust: State<'_, Trust>,
    folder: String,
) -> Result<TrustState, String> {
    let mut guard = store(&app, &trust)?;
    let held = guard.as_mut().expect("loaded");
    held.forget(Path::new(&folder));
    held.save()?;
    Ok(state_for(held, workspace_root(&state)))
}

/// Refuses when the open folder has not been trusted. Called by anything that would run the
/// project's own toolchain.
pub fn require_trust(
    app: &AppHandle,
    state: &State<'_, Workspace>,
    trust: &State<'_, Trust>,
) -> Result<(), String> {
    let guard = store(app, trust)?;
    if state_for(guard.as_ref().expect("loaded"), workspace_root(state)).trusted {
        return Ok(());
    }
    Err("This folder is open in Restricted Mode, so its build tools are not run. Trust the folder to enable them.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_at(dir: &Path) -> Store {
        Store::load(dir.join("trusted-folders.txt"))
    }

    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("yavin-trust-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn an_undecided_folder_is_neither_trusted_nor_remembered() {
        let dir = temp();
        let store = store_at(&dir);
        let state = state_for(&store, Some(PathBuf::from("/work/project")));
        assert!(!state.trusted, "nothing is trusted until it is said to be");
        assert!(!state.decided, "so the user is asked");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_window_with_no_folder_open_is_trusted() {
        // There is no untrusted content in scope, so there is nothing to protect against.
        let dir = temp();
        let state = state_for(&store_at(&dir), None);
        assert!(state.trusted && state.decided);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_decision_survives_a_restart() {
        let dir = temp();
        let mut store = store_at(&dir);
        store.remember(Path::new("/work/project"), Decision::Trusted);
        store.remember(Path::new("/work/other"), Decision::Restricted);
        store.save().unwrap();

        let reloaded = store_at(&dir);
        assert!(state_for(&reloaded, Some(PathBuf::from("/work/project"))).trusted);
        let other = state_for(&reloaded, Some(PathBuf::from("/work/other")));
        assert!(!other.trusted);
        // Remembered, so opening it again does not ask a second time.
        assert!(other.decided);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn trusting_a_parent_covers_the_projects_inside_it() {
        let dir = temp();
        let mut store = store_at(&dir);
        store.remember(Path::new("/work"), Decision::Trusted);
        assert!(state_for(&store, Some(PathBuf::from("/work/project"))).trusted);
        assert!(state_for(&store, Some(PathBuf::from("/work/a/b/c"))).trusted);
        // But not a sibling of the trusted folder that merely shares a prefix.
        assert!(!state_for(&store, Some(PathBuf::from("/workshop"))).trusted);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_nearer_decision_beats_an_inherited_one() {
        // Trust everything under /work, except this one project.
        let dir = temp();
        let mut store = store_at(&dir);
        store.remember(Path::new("/work"), Decision::Trusted);
        store.remember(Path::new("/work/sketchy"), Decision::Restricted);
        assert!(state_for(&store, Some(PathBuf::from("/work/mine"))).trusted);
        assert!(!state_for(&store, Some(PathBuf::from("/work/sketchy"))).trusted);
        assert!(!state_for(&store, Some(PathBuf::from("/work/sketchy/deep"))).trusted);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_same_folder_spelled_differently_is_the_same_folder() {
        // Windows hands back either separator and either case.
        let dir = temp();
        let mut store = store_at(&dir);
        store.remember(Path::new("C:\\Work\\Project"), Decision::Trusted);
        assert!(state_for(&store, Some(PathBuf::from("c:/work/project"))).trusted);
        assert!(state_for(&store, Some(PathBuf::from("C:/Work/Project/src"))).trusted);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn deciding_again_replaces_the_previous_answer_rather_than_stacking() {
        let dir = temp();
        let mut store = store_at(&dir);
        store.remember(Path::new("/work/project"), Decision::Trusted);
        store.remember(Path::new("/work/project"), Decision::Restricted);
        assert_eq!(store.entries.len(), 1);
        assert!(!state_for(&store, Some(PathBuf::from("/work/project"))).trusted);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn forgetting_a_folder_returns_it_to_undecided() {
        let dir = temp();
        let mut store = store_at(&dir);
        store.remember(Path::new("/work/project"), Decision::Trusted);
        store.forget(Path::new("/work/project"));
        let state = state_for(&store, Some(PathBuf::from("/work/project")));
        assert!(!state.trusted && !state.decided);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_corrupt_or_missing_store_reads_as_nothing_trusted() {
        // Failing open would be the one unacceptable outcome.
        let dir = temp();
        fs::write(
            dir.join("trusted-folders.txt"),
            "garbage\nnot\ta\tdecision\n",
        )
        .unwrap();
        let store = store_at(&dir);
        assert!(!state_for(&store, Some(PathBuf::from("/work/project"))).trusted);
        let _ = fs::remove_dir_all(&dir);
    }
}
