//! Extension host processes (IDE-08), as the renderer may ask for them.
//!
//! One `yavin-extension-host` process per workspace host generation, started on the same
//! process host as language servers and debug adapters (`ServerProcess`: Content-Length
//! framing, the Job Object, the exit report) -- not a second process system. Starting one
//! needs the folder to be trusted: extensions run their authors' code. The renderer speaks the
//! extension protocol to it through `ext_host_send`; this layer adds one thing, and checks one:
//!
//! - a `load` names only an extension id; the code is read here, from the folder discovery
//!   found for that id (`extensions::locate` / `read_main`: contained, bounded) -- the renderer
//!   never supplies code, so it cannot make the host run something that is not an extension;
//! - every message is bounded (1 MiB).
//!
//! The work is done by `ExtHostSessions` (no Tauri in it, so the real host is tested through
//! the same code the application runs); the commands add trust, the extension roots and the
//! window's events. Errors are `Code: message`, mapped by the renderer to `ExtensionError`.
//!
//! **Where the host is.** Packaged as a bundle resource, like the search tool:
//! `<resources>/resources/extension-host/yavin-extension-host(.exe)`, put there by
//! `scripts/build-extension-host.mjs`, which the Tauri build runs first. A development build
//! also looks beside its own executable (the Cargo target folder) and in the source tree's
//! resource folder. `YAVIN_EXTENSION_HOST` overrides all of them.

use crate::extensions::{locate, read_main, roots};
use crate::trust::{require_trust, Trust};
use crate::Workspace;
use ide_workspace::lsp_process::{ServerEvents, ServerProcess};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

/// The largest message either way (the host enforces the same).
const MAX_MESSAGE: usize = 1024 * 1024;

/// The host's file name.
pub const HOST_NAME: &str = if cfg!(windows) {
    "yavin-extension-host.exe"
} else {
    "yavin-extension-host"
};
/// The host's folder among Yavin's bundle resources (`bundle.resources` in tauri.conf.json).
pub const HOST_RESOURCE: &str = "resources/extension-host";

/// Where to look for the host, in order: an explicit override alone; else, packaged, the
/// resource folder; in a development build, the Cargo target folder beside Yavin's executable
/// (freshest), then the source tree's resource folder.
pub fn host_candidates(
    explicit: Option<PathBuf>,
    development: bool,
    executable: Option<&Path>,
    resources: Option<&Path>,
    source_tree: &Path,
) -> Vec<PathBuf> {
    if let Some(path) = explicit {
        return vec![path];
    }
    let mut candidates = Vec::new();
    if development {
        if let Some(folder) = executable.and_then(Path::parent) {
            candidates.push(folder.join(HOST_NAME));
        }
        candidates.push(source_tree.join(HOST_RESOURCE).join(HOST_NAME));
    } else if let Some(resources) = resources {
        candidates.push(resources.join(HOST_RESOURCE).join(HOST_NAME));
    }
    candidates
}

/// The first candidate that is a file, or `HostUnavailable` naming where it looked.
pub fn find_host(candidates: &[PathBuf]) -> Result<PathBuf, String> {
    candidates
        .iter()
        .find(|path| path.is_file())
        .cloned()
        .ok_or_else(|| {
            let looked = candidates
                .iter()
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>()
                .join("; ");
            format!(
                "HostUnavailable: The extension host ({HOST_NAME}) is missing (looked in: {looked}). Reinstall Yavin; in development, run `node scripts/build-extension-host.mjs`."
            )
        })
}

fn host_program(app: &AppHandle) -> Result<PathBuf, String> {
    let executable = std::env::current_exe().ok();
    let resources = app.path().resource_dir().ok();
    find_host(&host_candidates(
        std::env::var_os("YAVIN_EXTENSION_HOST").map(PathBuf::from),
        cfg!(debug_assertions),
        executable.as_deref(),
        resources.as_deref(),
        Path::new(env!("CARGO_MANIFEST_DIR")),
    ))
}

/// What a host sends, and its end, for one session.
pub trait HostEvents: Send + Sync + 'static {
    fn message(&self, session: u32, message: String);
    fn exit(&self, session: u32, code: Option<i32>, error: Option<String>);
}

type Live = Arc<Mutex<HashMap<u32, Arc<ServerProcess>>>>;

/// Every extension host Yavin started, by session number (never reused).
#[derive(Default)]
pub struct ExtHostSessions {
    next: AtomicU32,
    live: Live,
}

/// A session's process events: its end takes it out of the live set before it is reported.
struct Session {
    session: u32,
    live: Live,
    events: Arc<dyn HostEvents>,
}

impl ServerEvents for Session {
    fn message(&self, message: String) {
        self.events.message(self.session, message);
    }
    fn log(&self, _line: String) {}
    fn exit(&self, code: Option<i32>, error: Option<String>) {
        if let Ok(mut live) = self.live.lock() {
            live.remove(&self.session);
        }
        self.events.exit(self.session, code, error);
    }
}

impl ExtHostSessions {
    /// Starts `program` as a host. The caller then sends `init`.
    pub fn start(&self, program: &Path, events: Arc<dyn HostEvents>) -> Result<u32, String> {
        let session = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let process = ServerProcess::spawn(
            program,
            &[],
            &std::env::temp_dir(),
            Arc::new(Session {
                session,
                live: self.live.clone(),
                events,
            }),
        )
        .map_err(|why| format!("HostFailed: {why}"))?;
        self.live
            .lock()
            .map_err(|e| e.to_string())?
            .insert(session, Arc::new(process));
        Ok(session)
    }

    fn live(&self, session: u32) -> Result<Arc<ServerProcess>, String> {
        self.live
            .lock()
            .map_err(|e| e.to_string())?
            .get(&session)
            .cloned()
            .ok_or_else(|| "HostStopped: The extension host has stopped.".to_string())
    }

    /// Sends one protocol message; a `load` gets its extension's code from `roots`.
    pub fn send(&self, session: u32, message: &str, roots: &[PathBuf]) -> Result<(), String> {
        let process = self.live(session)?;
        let prepared = prepare(roots, message)?;
        process
            .send(&prepared)
            .map_err(|why| format!("HostStopped: {why}"))
    }

    /// The host process's id, while it runs (the real-host tests watch the process).
    #[cfg(test)]
    pub fn process_id(&self, session: u32) -> Option<u32> {
        self.live(session).ok().and_then(|process| process.id())
    }

    /// Ends a host and everything it started (its exit is still reported).
    pub fn stop(&self, session: u32) {
        if let Ok(process) = self.live(session) {
            process.stop();
        }
    }

    /// Ends every host: the window is closing, the page reloaded, or the workspace changed.
    pub fn stop_all(&self) {
        let all: Vec<_> = match self.live.lock() {
            Ok(mut live) => live.drain().map(|(_, process)| process).collect(),
            Err(_) => return,
        };
        for process in all {
            process.stop();
        }
    }
}

/// A `load` with the extension's code read here; any other message as it is.
fn prepare(roots: &[PathBuf], message: &str) -> Result<String, String> {
    if message.len() > MAX_MESSAGE {
        return Err(format!(
            "MessageTooLarge: {} bytes (the limit is {MAX_MESSAGE}).",
            message.len()
        ));
    }
    let mut value: Value =
        serde_json::from_str(message).map_err(|e| format!("MalformedMessage: {e}"))?;
    if value.get("type").and_then(Value::as_str) != Some("load") {
        return Ok(message.to_string());
    }
    let id = value
        .get("extensionId")
        .and_then(Value::as_str)
        .ok_or("MalformedMessage: a load names its extension")?
        .to_string();
    let (folder, main) = locate(roots, &id)?;
    let code = read_main(&folder, &main)?;
    let object = value.as_object_mut().ok_or("MalformedMessage")?;
    object.insert("code".into(), Value::String(code));
    object.insert(
        "extensionPath".into(),
        Value::String(folder.to_string_lossy().into_owned()),
    );
    Ok(value.to_string())
}

// --- The window's commands -------------------------------------------------------------------

#[derive(Clone, Serialize)]
struct Message {
    session: u32,
    message: String,
}

#[derive(Clone, Serialize)]
struct Exit {
    session: u32,
    code: Option<i32>,
    error: Option<String>,
}

/// Events to the window: `ext-host-message`, `ext-host-exit`, by session.
struct Emitting(AppHandle);

impl HostEvents for Emitting {
    fn message(&self, session: u32, message: String) {
        let _ = self
            .0
            .emit("ext-host-message", Message { session, message });
    }
    fn exit(&self, session: u32, code: Option<i32>, error: Option<String>) {
        let _ = self.0.emit(
            "ext-host-exit",
            Exit {
                session,
                code,
                error,
            },
        );
    }
}

/// Starts an extension host. Its messages arrive as `ext-host-message`, its end as
/// `ext-host-exit`. The renderer then sends `init`.
#[tauri::command]
pub async fn ext_host_start(
    app: AppHandle,
    state: State<'_, Workspace>,
    trust: State<'_, Trust>,
    sessions: State<'_, ExtHostSessions>,
) -> Result<u32, String> {
    require_trust(&app, &state, &trust).map_err(|why| format!("TrustRequired: {why}"))?;
    let program = host_program(&app)?;
    sessions.start(&program, Arc::new(Emitting(app.clone())))
}

/// Sends one protocol message to a host (framing is added by the process host).
#[tauri::command(async)]
pub fn ext_host_send(
    app: AppHandle,
    sessions: State<'_, ExtHostSessions>,
    session: u32,
    message: String,
) -> Result<(), String> {
    sessions.send(session, &message, &roots(&app)?)
}

/// Ends a host and everything it started.
#[tauri::command(async)]
pub fn ext_host_stop(sessions: State<'_, ExtHostSessions>, session: u32) -> Result<(), String> {
    sessions.stop(session);
    Ok(())
}

/// Ends every host: the window is closing, the page reloaded, or the workspace changed.
pub fn stop_all(sessions: &ExtHostSessions) {
    sessions.stop_all();
}

#[tauri::command(async)]
pub fn ext_host_stop_all(sessions: State<'_, ExtHostSessions>) -> Result<(), String> {
    stop_all(&sessions);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_packaged_build_looks_only_in_its_resources() {
        let found = host_candidates(
            None,
            false,
            Some(Path::new("C:/Program Files/Yavin IDE/yavin-ide.exe")),
            Some(Path::new("C:/Program Files/Yavin IDE")),
            Path::new("C:/src/src-tauri"),
        );
        assert_eq!(
            found,
            vec![Path::new("C:/Program Files/Yavin IDE")
                .join(HOST_RESOURCE)
                .join(HOST_NAME)]
        );
    }

    #[test]
    fn a_development_build_looks_beside_itself_then_in_the_source_tree() {
        let found = host_candidates(
            None,
            true,
            Some(Path::new("C:/src/target/debug/yavin-ide.exe")),
            Some(Path::new("C:/src/target/debug")),
            Path::new("C:/src/src-tauri"),
        );
        assert_eq!(
            found,
            vec![
                Path::new("C:/src/target/debug").join(HOST_NAME),
                Path::new("C:/src/src-tauri")
                    .join(HOST_RESOURCE)
                    .join(HOST_NAME),
            ]
        );
    }

    #[test]
    fn an_override_is_the_only_place_looked() {
        let found = host_candidates(
            Some(PathBuf::from("D:/host.exe")),
            true,
            None,
            None,
            Path::new("C:/src"),
        );
        assert_eq!(found, vec![PathBuf::from("D:/host.exe")]);
    }

    #[test]
    fn a_missing_host_is_reported_with_where_it_was_looked_for() {
        let error = find_host(&[PathBuf::from("Z:/nowhere/yavin-extension-host.exe")]).unwrap_err();
        assert!(error.starts_with("HostUnavailable:"), "{error}");
        assert!(error.contains("Z:/nowhere"), "{error}");
    }
}

#[cfg(test)]
#[path = "extension_host_real_tests.rs"]
mod real_host;
