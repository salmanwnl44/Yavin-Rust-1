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

use crate::config::write_atomically;
use crate::paths::normalise;
use crate::{with_workspace, Workspace};
use ide_workspace::durable::{read_versioned, BadVersion, Loaded};
use serde::Serialize;
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
    /// False when the file on disk could be neither read nor set aside: saving would destroy
    /// decisions the user made, so this run does not save.
    writable: bool,
}

/// Whether `folder` is `ancestor` or sits underneath it. Compared per segment so
/// `/work/project-two` is not treated as living inside `/work/project`.
fn within(ancestor: &str, folder: &str) -> bool {
    let ancestor = ancestor.trim_end_matches('/');
    folder == ancestor || folder.starts_with(&format!("{ancestor}/"))
}

/// The trust file's format, named on its first line (`# yavin-trust 1`). A file without that
/// line is version 0 -- the same lines, written before versions existed.
pub const TRUST_VERSION: u32 = 1;
const TRUST_HEADER: &str = "# yavin-trust ";

fn trust_version(text: &str) -> Result<Option<u32>, BadVersion> {
    match text
        .lines()
        .next()
        .and_then(|line| line.strip_prefix(TRUST_HEADER))
    {
        None => Ok(None),
        Some(version) => version.trim().parse().map(Some).map_err(|_| BadVersion),
    }
}

/// Every decision in the file, or `None` if any line is not one: a file with a line that
/// does not parse is set aside whole rather than rewritten without it -- a torn or
/// hand-damaged line might be a decision the user made.
fn parse_trust(text: &str, version: u32) -> Option<Vec<(Decision, PathBuf)>> {
    if version > TRUST_VERSION {
        return None;
    }
    let mut entries = Vec::new();
    for line in text.lines().filter(|line| !line.starts_with(TRUST_HEADER)) {
        if line.trim().is_empty() {
            continue;
        }
        let (kind, path) = line.split_once('\t')?;
        let decision = match kind {
            "trust" => Decision::Trusted,
            "restrict" => Decision::Restricted,
            _ => return None,
        };
        if path.is_empty() {
            return None;
        }
        entries.push((decision, PathBuf::from(path)));
    }
    Some(entries)
}

impl Store {
    /// Reads the decisions. A file that cannot be read as any version -- or that a newer
    /// Yavin wrote -- is moved aside (`trusted-folders.txt.corrupt-<ms>.bak`), and the store
    /// starts empty: nothing trusted, which asks again rather than assuming.
    fn load(file: PathBuf) -> Store {
        let loaded = read_versioned(&file, TRUST_VERSION, trust_version, parse_trust);
        if let Loaded::Corrupt { backup } | Loaded::Future { backup, .. } = &loaded {
            eprintln!(
                "The trust settings could not be read and were set aside{}",
                backup
                    .as_ref()
                    .map(|b| format!(" as {}", b.display()))
                    .unwrap_or_default()
            );
        }
        let writable = loaded.can_replace();
        let entries = loaded.value().unwrap_or_default();
        Store {
            file,
            entries,
            writable,
        }
    }

    /// Written atomically. A torn write here is worse than losing the file: truncation just
    /// after a path separator would leave an entry covering more than the user agreed to.
    fn save(&self) -> Result<(), String> {
        if !self.writable {
            return Err(
                "The trust settings could not be read at startup, so they are not overwritten."
                    .into(),
            );
        }
        let text: String = std::iter::once(format!("{TRUST_HEADER}{TRUST_VERSION}\n"))
            .chain(self.entries.iter().map(|(decision, path)| {
                let kind = match decision {
                    Decision::Trusted => "trust",
                    Decision::Restricted => "restrict",
                };
                format!("{kind}\t{}\n", path.to_string_lossy())
            }))
            .collect();
        write_atomically(&self.file, &text).map_err(|e| format!("Cannot save trust settings: {e}"))
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
        parent: root.parent().map(ide_workspace::file_tree::clean_path_str),
        root: Some(ide_workspace::file_tree::clean_path_str(&root)),
    }
}

#[tauri::command(async)]
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
#[tauri::command(async)]
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

#[tauri::command(async)]
pub fn trusted_folders(app: AppHandle, trust: State<'_, Trust>) -> Result<Vec<String>, String> {
    let guard = store(&app, &trust)?;
    Ok(guard
        .as_ref()
        .expect("loaded")
        .entries
        .iter()
        .filter(|(decision, _)| *decision == Decision::Trusted)
        .map(|(_, path)| ide_workspace::file_tree::clean_path_str(path))
        .collect())
}

#[tauri::command(async)]
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

/// Whether the open folder may have its own toolchain run.
///
/// Separate from `require_trust` so that a caller deciding what to *offer* can tell "the user
/// said no" from "the trust settings could not be read at all" -- reporting the second as the
/// first told people a project had no checkers when what it really had was a broken config
/// directory.
pub fn is_trusted(
    app: &AppHandle,
    state: &State<'_, Workspace>,
    trust: &State<'_, Trust>,
) -> Result<bool, String> {
    let guard = store(app, trust)?;
    Ok(state_for(guard.as_ref().expect("loaded"), workspace_root(state)).trusted)
}

/// Refuses when the open folder has not been trusted. Called by anything that would run the
/// project's own toolchain.
pub fn require_trust(
    app: &AppHandle,
    state: &State<'_, Workspace>,
    trust: &State<'_, Trust>,
) -> Result<(), String> {
    if is_trusted(app, state, trust)? {
        return Ok(());
    }
    Err("This folder is open in Restricted Mode, so its build tools are not run. Trust the folder to enable them.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn store_at(dir: &Path) -> Store {
        Store::load(dir.join("trusted-folders.txt"))
    }

    fn temp() -> PathBuf {
        // One directory per test. Tests run in parallel threads, and a directory shared
        // between them that each one wipes on entry meant they deleted each other's files:
        // an occasional failure in whichever test happened to lose the race.
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let ordinal = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("yavin-trust-{}-{ordinal}", std::process::id()));
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
    fn a_folder_recorded_in_extended_length_form_is_forgotten_by_its_plain_path() {
        // The store records the canonical root (`\\?\C:\...` on Windows); the trust list in the
        // UI shows, and sends back, the cleaned `C:/...`. Forgetting used to match nothing.
        let dir = temp();
        let mut store = store_at(&dir);
        store.remember(Path::new(r"\\?\C:\Work\Project"), Decision::Trusted);
        store.save().unwrap();
        let mut reloaded = store_at(&dir);
        assert!(state_for(&reloaded, Some(PathBuf::from("C:/Work/Project"))).trusted);
        reloaded.forget(Path::new("C:/Work/Project"));
        assert!(reloaded.entries.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_extended_length_decision_covers_only_its_own_folder_and_below() {
        let dir = temp();
        let mut store = store_at(&dir);
        store.remember(Path::new(r"\\?\C:\Work"), Decision::Trusted);
        assert!(state_for(&store, Some(PathBuf::from(r"\\?\C:\Work\a"))).trusted);
        assert!(state_for(&store, Some(PathBuf::from("c:/work/a"))).trusted);
        assert!(!state_for(&store, Some(PathBuf::from(r"\\?\C:\Work2"))).trusted);
        assert!(!state_for(&store, Some(PathBuf::from("C:/Work2/a"))).trusted);
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

    fn backups(dir: &Path) -> Vec<PathBuf> {
        fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.to_string_lossy().ends_with(".bak"))
            .collect()
    }

    #[test]
    fn decisions_are_written_under_a_version_line_and_read_back() {
        let dir = temp();
        let mut store = store_at(&dir);
        store.remember(Path::new("/work/project"), Decision::Trusted);
        store.save().unwrap();
        let text = fs::read_to_string(dir.join("trusted-folders.txt")).unwrap();
        assert_eq!(text.lines().next(), Some("# yavin-trust 1"));
        assert!(state_for(&store_at(&dir), Some(PathBuf::from("/work/project"))).trusted);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_from_before_versions_is_read_as_it_stands() {
        let dir = temp();
        fs::write(dir.join("trusted-folders.txt"), "trust\t/work/old\n").unwrap();
        assert!(state_for(&store_at(&dir), Some(PathBuf::from("/work/old"))).trusted);
        assert!(backups(&dir).is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_damaged_or_newer_file_is_set_aside_and_nothing_is_trusted() {
        for (label, text) in [
            ("torn", "# yavin-trust 1\ntrust\t/work/a\ntru"),
            ("newer", "# yavin-trust 4\ntrust\t/work/a\nsomething new\n"),
            ("bad header", "# yavin-trust one\ntrust\t/work/a\n"),
        ] {
            let dir = temp();
            fs::write(dir.join("trusted-folders.txt"), text).unwrap();
            let store = store_at(&dir);
            // Unknown means untrusted: the user is asked again, never assumed.
            assert!(
                !state_for(&store, Some(PathBuf::from("/work/a"))).trusted,
                "{label}"
            );
            let kept = backups(&dir);
            assert_eq!(kept.len(), 1, "{label}");
            assert_eq!(
                fs::read_to_string(&kept[0]).unwrap(),
                text,
                "{label}: kept intact"
            );
            let _ = fs::remove_dir_all(&dir);
        }
    }

    /// As for the session: a file another program holds unreadable is not replaced.
    #[cfg(windows)]
    #[test]
    fn a_trust_file_that_cannot_be_read_is_never_saved_over() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = temp();
        let file = dir.join("trusted-folders.txt");
        fs::write(&file, "# yavin-trust 1\ntrust\t/work/precious\n").unwrap();
        let held = fs::OpenOptions::new()
            .read(true)
            .share_mode(0x4) // FILE_SHARE_DELETE
            .open(&file)
            .unwrap();
        let mut store = store_at(&dir);
        store.remember(Path::new("/work/project"), Decision::Trusted);
        let saved = store.save();
        drop(held);
        assert!(saved.is_err());
        assert!(fs::read_to_string(&file)
            .unwrap()
            .contains("/work/precious"));
        let _ = fs::remove_dir_all(&dir);
    }
}
