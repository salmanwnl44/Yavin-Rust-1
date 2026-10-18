//! Extension host processes (IDE-08), as the renderer may ask for them.
//!
//! One `yavin-extension-host` process per workspace host generation, started on the same
//! process host as language servers and debug adapters (`ServerProcess`: Content-Length
//! framing, the Job Object, the exit report) -- not a second process system. Starting one
//! needs the folder to be trusted: extensions run their authors' code. The renderer speaks the
//! extension protocol to it through `ext_host_send`; this layer adds what follows, and checks it:
//!
//! - a `load` names only an extension id; the code is read here, from the folder the inventory
//!   chose for that id (`ExtensionService::host_copy`, the copy the renderer was listed;
//!   `read_main`: contained, bounded) -- the renderer never supplies code or a folder, so it
//!   cannot make the host run something that is not the installed extension (EXT-02). A
//!   disabled extension, or any in an untrusted folder, is not loaded (EXT-07);
//! - every message is bounded (1 MiB);
//! - **the permission boundary (EXT-07).** Every request an extension makes passes here before
//!   the window sees it. The host stamps each with the extension's real id (the script cannot
//!   choose it); this layer checks it against what that extension's loaded code is
//!   (`HostCopy`, recorded once the host has loaded it) and the native authority
//!   (`HostAuthority`: trust, enabled, still the installed copy -- for every request -- and for
//!   a capability, granted for that very copy: `extension_permissions::need_of_request`). A
//!   refused request never reaches the window: the extension is answered `PermissionDenied` (or
//!   why) here, and the window is told that it was refused (`ext-host-denied`). Events the
//!   window sends an extension pass the same check (`documents.*` needs `documents.read`), and
//!   so does every call into an extension's code (`activate`, `command.run`, ...): none for a
//!   disabled extension or an untrusted folder, except its `deactivate`. The window's answers
//!   to an extension's requests are not checked again: each answers a checked request.
//!
//! The work is done by `ExtHostSessions` (no Tauri in it, so the real host is tested through
//! the same code the application runs); the commands add trust, the inventory's choices and
//! the window's events (`AppAuthority`). Errors are `Code: message`, mapped by the renderer to
//! `ExtensionError`.
//!
//! **Where the host is.** Packaged as a bundle resource, like the search tool:
//! `<resources>/resources/extension-host/yavin-extension-host(.exe)`, put there by
//! `scripts/build-extension-host.mjs`, which the Tauri build runs first. A development build
//! also looks beside its own executable (the Cargo target folder) and in the source tree's
//! resource folder, and `YAVIN_EXTENSION_HOST` overrides both. A release build looks only in
//! its own resources: no environment variable or setting chooses the executable it runs, and the
//! host is started with no arguments (EXT-06).

use crate::extension_permissions::{need_of_event, need_of_request, Denial, Need};
use crate::extension_service::{ExtensionService, HostCopy};
use crate::extensions::read_main;
use crate::trust::{require_trust, Trust};
use crate::Workspace;
use ide_workspace::lsp_process::{ServerEvents, ServerProcess};
use serde::Serialize;
use serde_json::{json, Value};
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

/// Where to look for the host, in order. Packaged (a release build): its resource folder only --
/// `explicit` (`YAVIN_EXTENSION_HOST`) is ignored, so nothing outside the installation picks
/// the program it starts. In a development build: `explicit` alone if set; else the Cargo target
/// folder beside Yavin's executable (freshest), then the source tree's resource folder.
pub fn host_candidates(
    explicit: Option<PathBuf>,
    development: bool,
    executable: Option<&Path>,
    resources: Option<&Path>,
    source_tree: &Path,
) -> Vec<PathBuf> {
    if let Some(path) = explicit.filter(|_| development) {
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
    /// A line the process wrote to stderr (a panic, a runtime error), bounded (EXT-05).
    fn log(&self, _session: u32, _line: String) {}
    /// A request of an extension this layer refused (EXT-07); the extension was answered.
    fn denied(&self, _session: u32, _denied: Denied) {}
}

/// A refused request, as the window is told of it (EXT-07): which extension, which method,
/// the capability it needed (if one), and why -- never what the request carried.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Denied {
    pub extension_id: String,
    pub method: String,
    pub capability: Option<String>,
    pub code: String,
    pub message: String,
}

/// The native authority over a host's extensions (EXT-07). The window's own state -- what it
/// thinks is trusted, enabled or granted -- is never asked.
pub trait HostAuthority: Send + Sync + 'static {
    /// The copy a `load` of `id` reads; refused for an untrusted folder, a disabled, unknown
    /// or unusable extension.
    fn copy_of(&self, id: &str) -> Result<HostCopy, String>;
    /// Whether the code of `copy` may act now: the folder trusted, the extension enabled and
    /// `copy` still its installed copy -- and, with `capability`, that granted for `copy`.
    fn allow(&self, copy: &HostCopy, capability: Option<&str>) -> Result<(), Denial>;
}

/// One host's permission state: its authority, and what each extension it loaded is.
struct Shared {
    authority: Arc<dyn HostAuthority>,
    /// What each loaded extension's code is: recorded when the host says it loaded it.
    loaded: Mutex<HashMap<String, HostCopy>>,
    /// Loads sent and not yet answered: the host keeps what it had until a load succeeds.
    loading: Mutex<HashMap<String, HostCopy>>,
    /// Refusals the window was told of, and the last one (repeats are not told again).
    told: Mutex<(usize, Option<Denied>)>,
}

/// The most refusals one host's window is told of (each extension was answered regardless).
const MAX_TOLD: usize = 1000;

/// A lock that a panic elsewhere did not leave unusable: the maps hold no invariant a panic
/// could break, and a refusal to read them must not open anything.
fn held<T>(lock: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Shared {
    fn new(authority: Arc<dyn HostAuthority>) -> Shared {
        Shared {
            authority,
            loaded: Mutex::new(HashMap::new()),
            loading: Mutex::new(HashMap::new()),
            told: Mutex::new((0, None)),
        }
    }

    fn loaded(&self, id: &str) -> Option<HostCopy> {
        held(&self.loaded).get(id).cloned()
    }

    /// Whether the window is told of `denied`: not a repeat of the last, not past `MAX_TOLD`.
    fn tell(&self, denied: &Denied) -> bool {
        let mut told = held(&self.told);
        if told.1.as_ref() == Some(denied) || told.0 >= MAX_TOLD {
            return false;
        }
        told.0 += 1;
        told.1 = Some(denied.clone());
        true
    }

    /// What a request of an extension needs, decided: `Ok` to pass it to the window.
    fn decide(
        &self,
        id: &str,
        method: &str,
        params: &Value,
    ) -> Result<(), (Denial, Option<String>)> {
        let copy = self.loaded(id).ok_or_else(|| {
            (
                Denial::new("NotLoaded", format!("{id} is not loaded in this host.")),
                None,
            )
        })?;
        match need_of_request(id, method, params) {
            // Mandatory, but only while its code may act at all: enabled, current, trusted.
            Need::Nothing => self
                .authority
                .allow(&copy, None)
                .map_err(|denial| (denial, None)),
            Need::Capability(capability) => self
                .authority
                .allow(&copy, Some(&capability))
                .map_err(|denial| (denial, Some(capability))),
            Need::NotOwned(why) => Err((Denial::new("NotOwned", why), None)),
            Need::Invalid(why) => Err((Denial::new("InvalidRequest", why), None)),
            Need::Unknown => Err((
                Denial::new(
                    "UnknownMethod",
                    format!("\"{method}\" is not part of the extension API."),
                ),
                None,
            )),
        }
    }

    /// A message from the host: `None` to pass it to the window, or the refusal of a request
    /// (the answer to the extension, and what the window is told).
    fn screen(&self, text: &str) -> Option<(String, Option<Denied>)> {
        let value: Value = serde_json::from_str(text).ok()?;
        let kind = value.get("type").and_then(Value::as_str);
        let id = value.get("extensionId").and_then(Value::as_str);
        // A load's answer: only a load the host made is what that extension now is.
        match (kind, id) {
            (Some("loaded"), Some(id)) => {
                if let Some(copy) = held(&self.loading).remove(id) {
                    held(&self.loaded).insert(id.to_string(), copy);
                }
                return None;
            }
            (Some("error"), Some(id)) => {
                held(&self.loading).remove(id);
                return None;
            }
            (Some("request"), _) => {}
            _ => return None,
        }
        // The host stamps every message an extension sends; one without an id is not passed on.
        let Some(id) = id else {
            return Some((String::new(), None));
        };
        let method = value.get("method").and_then(Value::as_str).unwrap_or("");
        let params = value.get("params").cloned().unwrap_or(Value::Null);
        let (denial, capability) = self.decide(id, method, &params).err()?;
        let answer = json!({
            "type": "response",
            "extensionId": id,
            "workspaceId": value.get("workspaceId"),
            "hostGeneration": value.get("hostGeneration"),
            "requestId": value.get("requestId"),
            "ok": false,
            "error": {"code": denial.code, "message": denial.message},
        });
        // The window is told what the user can act on: a capability, or a request that is not
        // the extension's to make. (A disabled or replaced extension's cleanup is just answered.)
        let tell = capability.is_some()
            || matches!(denial.code, "NotOwned" | "InvalidRequest" | "UnknownMethod");
        let denied = Denied {
            extension_id: id.to_string(),
            method: method.to_string(),
            capability,
            code: denial.code.to_string(),
            message: denial.message,
        };
        Some((
            answer.to_string(),
            (tell && self.tell(&denied)).then_some(denied),
        ))
    }
}

/// The most stderr lines passed on per host, and the longest line.
const MAX_LOG_LINES: usize = 200;
const MAX_LOG_LINE: usize = 1000;

/// A running host: its process and its permission state.
#[derive(Clone)]
struct Host {
    process: Arc<ServerProcess>,
    shared: Arc<Shared>,
}

type Live = Arc<Mutex<HashMap<u32, Host>>>;

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
    /// Lines of stderr passed on so far.
    logged: AtomicU32,
    shared: Arc<Shared>,
    /// Answers to refused requests, written to the host by the session's answering thread.
    answers: std::sync::mpsc::SyncSender<String>,
}

/// The most refusals waiting to be answered; more are dropped (a flood is not answered).
const MAX_ANSWERS: usize = 1024;

impl ServerEvents for Session {
    fn message(&self, message: String) {
        let Some((answer, denied)) = self.shared.screen(&message) else {
            self.events.message(self.session, message);
            return;
        };
        if !answer.is_empty() {
            let _ = self.answers.try_send(answer);
        }
        if let Some(denied) = denied {
            self.events.denied(self.session, denied);
        }
    }
    fn log(&self, line: String) {
        let n = self.logged.fetch_add(1, Ordering::Relaxed) as usize;
        if n < MAX_LOG_LINES {
            let line: String = line.chars().take(MAX_LOG_LINE).collect();
            self.events.log(self.session, line);
        } else if n == MAX_LOG_LINES {
            self.events.log(
                self.session,
                "(the extension host wrote more; the rest is not shown)".into(),
            );
        }
    }
    fn exit(&self, code: Option<i32>, error: Option<String>) {
        if let Ok(mut live) = self.live.lock() {
            live.remove(&self.session);
        }
        self.events.exit(self.session, code, error);
    }
}

impl ExtHostSessions {
    /// Starts `program` as a host whose extensions `authority` decides for. The caller then
    /// sends `init`.
    pub fn start(
        &self,
        program: &Path,
        events: Arc<dyn HostEvents>,
        authority: Arc<dyn HostAuthority>,
    ) -> Result<u32, String> {
        let session = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let shared = Arc::new(Shared::new(authority));
        // Refusals are answered on a thread of their own: the thread reading the host's output
        // never waits to write its input (with both pipes full, that would deadlock). It ends
        // with the session (its `Session`, holding the sender, goes with the process).
        let (answers, queue) = std::sync::mpsc::sync_channel::<String>(MAX_ANSWERS);
        let live = self.live.clone();
        std::thread::spawn(move || {
            for answer in queue {
                let process = live
                    .lock()
                    .ok()
                    .and_then(|live| live.get(&session).map(|host| host.process.clone()));
                if let Some(process) = process {
                    let _ = process.send(&answer);
                }
            }
        });
        let process = ServerProcess::spawn(
            program,
            &[],
            &std::env::temp_dir(),
            Arc::new(Session {
                session,
                live: self.live.clone(),
                events,
                logged: AtomicU32::new(0),
                shared: shared.clone(),
                answers,
            }),
        )
        .map_err(|why| format!("HostFailed: {why}"))?;
        self.live.lock().map_err(|e| e.to_string())?.insert(
            session,
            Host {
                process: Arc::new(process),
                shared,
            },
        );
        Ok(session)
    }

    fn live(&self, session: u32) -> Result<Host, String> {
        self.live
            .lock()
            .map_err(|e| e.to_string())?
            .get(&session)
            .cloned()
            .ok_or_else(|| "HostStopped: The extension host has stopped.".to_string())
    }

    /// Sends one protocol message, checked (EXT-07); a `load` gets its extension's code from
    /// the copy the authority names for it (and the entry point its manifest names).
    pub fn send(&self, session: u32, message: &str) -> Result<(), String> {
        let host = self.live(session)?;
        let prepared = prepare(&host.shared, message)?;
        host.process
            .send(&prepared)
            .map_err(|why| format!("HostStopped: {why}"))
    }

    /// The host process's id, while it runs (the real-host tests watch the process).
    #[cfg(test)]
    pub fn process_id(&self, session: u32) -> Option<u32> {
        self.live(session).ok().and_then(|host| host.process.id())
    }

    /// Ends a host and everything it started (its exit is still reported).
    pub fn stop(&self, session: u32) {
        if let Ok(host) = self.live(session) {
            host.process.stop();
        }
    }

    /// Ends every host: the window is closing, the page reloaded, or the workspace changed.
    pub fn stop_all(&self) {
        let all: Vec<_> = match self.live.lock() {
            Ok(mut live) => live.drain().map(|(_, host)| host).collect(),
            Err(_) => return,
        };
        for host in all {
            host.process.stop();
        }
    }
}

/// `Code: message`, as the window maps errors.
fn refused(denial: Denial) -> String {
    format!("{}: {}", denial.code, denial.message)
}

/// A message from the window, checked and completed (EXT-07): a `load` gets the code of the
/// copy the authority names, recorded as what that extension is in this host; an event, and a
/// call into an extension, must be allowed for it now; the rest goes as it is.
fn prepare(shared: &Shared, message: &str) -> Result<String, String> {
    if message.len() > MAX_MESSAGE {
        return Err(format!(
            "MessageTooLarge: {} bytes (the limit is {MAX_MESSAGE}).",
            message.len()
        ));
    }
    let mut value: Value =
        serde_json::from_str(message).map_err(|e| format!("MalformedMessage: {e}"))?;
    let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
    let id = value
        .get("extensionId")
        .and_then(Value::as_str)
        .map(str::to_string);
    match (kind, id) {
        ("load", Some(id)) => {
            let copy = shared.authority.copy_of(&id)?;
            let code = read_main(Path::new(&copy.folder), &copy.main)?;
            let object = value.as_object_mut().ok_or("MalformedMessage")?;
            object.insert("code".into(), Value::String(code));
            object.insert("extensionPath".into(), Value::String(copy.folder.clone()));
            // What it is once the host says it loaded it (`Shared::screen`): a load that fails
            // leaves the host, and this, as they were.
            held(&shared.loading).insert(id, copy);
            Ok(value.to_string())
        }
        ("load", None) => Err("MalformedMessage: a load names its extension".into()),
        ("unload", Some(id)) => {
            held(&shared.loaded).remove(&id);
            held(&shared.loading).remove(&id);
            Ok(message.to_string())
        }
        ("event", Some(id)) => {
            let event = value.get("event").and_then(Value::as_str).unwrap_or("");
            match need_of_event(event) {
                // Its configuration: only while its code may act at all.
                Need::Nothing => {
                    if let Some(copy) = shared.loaded(&id) {
                        shared.authority.allow(&copy, None).map_err(refused)?;
                    }
                    Ok(message.to_string())
                }
                Need::Capability(capability) => {
                    let copy = shared
                        .loaded(&id)
                        .ok_or_else(|| format!("NotLoaded: {id} is not loaded in this host."))?;
                    shared
                        .authority
                        .allow(&copy, Some(&capability))
                        .map_err(refused)?;
                    Ok(message.to_string())
                }
                Need::Invalid(why) => Err(format!("InvalidRequest: {why}")),
                _ => Err(format!("InvalidRequest: \"{event}\" is not an event.")),
            }
        }
        // A call into an extension's code: only while it may run. Its deactivation always may
        // (it lets the extension let go); one not loaded is answered by the host itself.
        ("request", Some(id)) => {
            let method = value.get("method").and_then(Value::as_str).unwrap_or("");
            if method != "deactivate" {
                if let Some(copy) = shared.loaded(&id) {
                    shared.authority.allow(&copy, None).map_err(refused)?;
                }
            }
            Ok(message.to_string())
        }
        _ => Ok(message.to_string()),
    }
}

/// The application's authority (EXT-07): Workspace Trust and the extension inventory, both
/// native, asked every time.
struct AppAuthority(AppHandle);

impl AppAuthority {
    fn trusted(&self) -> Result<(), Denial> {
        require_trust(
            &self.0,
            &self.0.state::<Workspace>(),
            &self.0.state::<Trust>(),
        )
        .map_err(|why| Denial::new("TrustRequired", why))
    }
}

impl HostAuthority for AppAuthority {
    fn copy_of(&self, id: &str) -> Result<HostCopy, String> {
        self.trusted().map_err(refused)?;
        self.0.state::<ExtensionService>().host_copy(id)
    }
    fn allow(&self, copy: &HostCopy, capability: Option<&str>) -> Result<(), Denial> {
        self.trusted()?;
        self.0
            .state::<ExtensionService>()
            .authorize(copy, capability)
    }
}

// --- The window's commands -------------------------------------------------------------------

#[derive(Clone, Serialize)]
struct Message {
    session: u32,
    message: String,
}

#[derive(Clone, Serialize)]
struct Log {
    session: u32,
    line: String,
}

#[derive(Clone, Serialize)]
struct DeniedEvent {
    session: u32,
    #[serde(flatten)]
    denied: Denied,
}

#[derive(Clone, Serialize)]
struct Exit {
    session: u32,
    code: Option<i32>,
    error: Option<String>,
}

/// Events to the window: `ext-host-message`, `ext-host-log` (its stderr), `ext-host-denied` (a
/// refused request, EXT-07), `ext-host-exit`, by session.
struct Emitting(AppHandle);

impl HostEvents for Emitting {
    fn message(&self, session: u32, message: String) {
        let _ = self
            .0
            .emit("ext-host-message", Message { session, message });
    }
    fn log(&self, session: u32, line: String) {
        let _ = self.0.emit("ext-host-log", Log { session, line });
    }
    fn denied(&self, session: u32, denied: Denied) {
        let _ = self
            .0
            .emit("ext-host-denied", DeniedEvent { session, denied });
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
    sessions.start(
        &program,
        Arc::new(Emitting(app.clone())),
        Arc::new(AppAuthority(app.clone())),
    )
}

/// Sends one protocol message to a host (framing is added by the process host).
#[tauri::command(async)]
pub fn ext_host_send(
    sessions: State<'_, ExtHostSessions>,
    session: u32,
    message: String,
) -> Result<(), String> {
    sessions.send(session, &message)
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

/// The application's authority without Tauri, for tests: the real inventory, and Workspace
/// Trust as a switch.
#[cfg(test)]
pub struct ServiceAuthority {
    pub service: Arc<ExtensionService>,
    pub trusted: std::sync::atomic::AtomicBool,
}

#[cfg(test)]
impl ServiceAuthority {
    pub fn new(service: Arc<ExtensionService>) -> Arc<ServiceAuthority> {
        Arc::new(ServiceAuthority {
            service,
            trusted: std::sync::atomic::AtomicBool::new(true),
        })
    }
    fn trusted(&self) -> Result<(), Denial> {
        if self.trusted.load(Ordering::SeqCst) {
            Ok(())
        } else {
            Err(Denial::new("TrustRequired", "This folder is not trusted."))
        }
    }
}

#[cfg(test)]
impl HostAuthority for ServiceAuthority {
    fn copy_of(&self, id: &str) -> Result<HostCopy, String> {
        self.trusted().map_err(refused)?;
        self.service.host_copy(id)
    }
    fn allow(&self, copy: &HostCopy, capability: Option<&str>) -> Result<(), Denial> {
        self.trusted()?;
        self.service.authorize(copy, capability)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A host's stderr reaches the window, bounded: at most `MAX_LOG_LINES` lines, each cut to
    /// `MAX_LOG_LINE` characters, then one notice -- never more (EXT-05).
    #[test]
    fn a_hosts_stderr_is_passed_on_bounded() {
        #[derive(Default)]
        struct Seen(Mutex<Vec<(u32, String)>>);
        impl HostEvents for Seen {
            fn message(&self, _: u32, _: String) {}
            fn exit(&self, _: u32, _: Option<i32>, _: Option<String>) {}
            fn log(&self, session: u32, line: String) {
                self.0.lock().unwrap().push((session, line));
            }
        }
        let seen = Arc::new(Seen::default());
        let session = Session {
            session: 7,
            live: Live::default(),
            events: seen.clone(),
            logged: AtomicU32::new(0),
            shared: Arc::new(Shared::new(ServiceAuthority::new(Arc::new(
                ExtensionService::default(),
            )))),
            answers: std::sync::mpsc::sync_channel(1).0,
        };
        session.log("x".repeat(MAX_LOG_LINE + 50));
        for n in 0..(MAX_LOG_LINES + 20) {
            session.log(format!("line {n}"));
        }
        let lines = seen.0.lock().unwrap();
        assert_eq!(lines.len(), MAX_LOG_LINES + 1);
        assert!(lines.iter().all(|(s, _)| *s == 7));
        assert_eq!(lines[0].1.chars().count(), MAX_LOG_LINE);
        assert!(lines.last().unwrap().1.contains("the rest is not shown"));
    }

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

    /// A release build runs only its packaged host: an override from the environment is not
    /// looked at (EXT-06), and the host is started with no arguments.
    #[test]
    fn a_release_build_ignores_the_override() {
        let found = host_candidates(
            Some(PathBuf::from("C:/Users/Public/evil.exe")),
            false,
            Some(Path::new("C:/Program Files/Yavin IDE/yavin-ide.exe")),
            Some(Path::new("C:/Program Files/Yavin IDE")),
            Path::new("C:/src"),
        );
        assert_eq!(
            found,
            vec![Path::new("C:/Program Files/Yavin IDE")
                .join(HOST_RESOURCE)
                .join(HOST_NAME)]
        );
        let source = include_str!("extension_host.rs");
        let code = source.split("#[cfg(test)]").next().unwrap();
        assert!(
            code.contains(
                "ServerProcess::spawn(
            program,
            &[],"
            ),
            "no arguments"
        );
    }

    /// A development extension folder in a scratch root, and the authority over it.
    fn scratch_authority(name: &str, manifest: &str) -> (PathBuf, Arc<ServiceAuthority>) {
        let dir =
            std::env::temp_dir().join(format!("yavin-ext07-shared-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let folder = dir.join("samples").join("acme.probe");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::create_dir_all(dir.join("extensions")).unwrap();
        std::fs::write(folder.join("yavin-extension.json"), manifest).unwrap();
        std::fs::write(folder.join("extension.js"), "module.exports = {};").unwrap();
        let service = ExtensionService::new(dir.join("extensions"), vec![dir.join("samples")]);
        (dir, ServiceAuthority::new(Arc::new(service)))
    }

    const PROBE_MANIFEST: &str = r#"{"publisher":"acme","name":"probe","version":"1.0.0","main":"extension.js","permissions":{"version":1,"request":["documents.read"]}}"#;

    fn request(method: &str) -> String {
        json!({"type": "request", "requestId": "r", "method": method, "params": {"id": "acme.probe.go"}, "extensionId": "acme.probe", "workspaceId": "w", "hostGeneration": 1}).to_string()
    }

    /// What an extension is, in a host, is what the host says it loaded: a load that fails
    /// leaves nothing recorded (its requests are not checked against a copy it does not run),
    /// and only a successful one is.
    #[test]
    fn a_load_counts_only_once_the_host_has_made_it() {
        let (dir, authority) = scratch_authority("load", PROBE_MANIFEST);
        let shared = Shared::new(authority);
        let load = json!({"type": "load", "extensionId": "acme.probe", "workspaceId": "w", "hostGeneration": 1}).to_string();
        prepare(&shared, &load).unwrap();
        assert!(
            shared.loaded("acme.probe").is_none(),
            "not until the host answers"
        );
        let (_, denied) = shared.screen(&request("commands.execute")).unwrap();
        assert!(denied.is_none());
        // The host failed to load it: nothing is recorded.
        assert!(shared
            .screen(&json!({"type": "error", "extensionId": "acme.probe", "error": {"code": "LoadFailed", "message": "x"}}).to_string())
            .is_none());
        assert!(shared.loaded("acme.probe").is_none());
        // Loaded: now it is what it is.
        prepare(&shared, &load).unwrap();
        assert!(shared
            .screen(&json!({"type": "loaded", "extensionId": "acme.probe"}).to_string())
            .is_none());
        assert_eq!(shared.loaded("acme.probe").unwrap().version, "1.0.0");
        assert!(
            shared.screen(&request("commands.execute")).is_none(),
            "its own command passes"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A disabled extension's code may not act at all: its mandatory requests, its configuration
    /// events and calls into it are refused natively too -- quietly for the window (nothing the
    /// user can allow), answered to the extension.
    #[test]
    fn a_disabled_extensions_mandatory_traffic_is_refused_too() {
        let (dir, authority) = scratch_authority("disabled", PROBE_MANIFEST);
        let shared = Shared::new(authority.clone());
        let load = json!({"type": "load", "extensionId": "acme.probe", "workspaceId": "w", "hostGeneration": 1}).to_string();
        prepare(&shared, &load).unwrap();
        shared.screen(&json!({"type": "loaded", "extensionId": "acme.probe"}).to_string());
        authority.service.set_enabled("acme.probe", false).unwrap();
        let (answer, told) = shared.screen(&request("storage.update")).unwrap();
        assert!(answer.contains("ExtensionDisabled"), "{answer}");
        assert!(told.is_none(), "not a permission the user can give");
        let event = json!({"type": "event", "extensionId": "acme.probe", "workspaceId": "w", "hostGeneration": 1, "event": "configuration.changed", "payload": {}}).to_string();
        assert!(prepare(&shared, &event)
            .unwrap_err()
            .starts_with("ExtensionDisabled"));
        let call = json!({"type": "request", "requestId": "c", "method": "command.run", "params": {}, "extensionId": "acme.probe", "workspaceId": "w", "hostGeneration": 1}).to_string();
        assert!(prepare(&shared, &call)
            .unwrap_err()
            .starts_with("ExtensionDisabled"));
        let deactivate = json!({"type": "request", "requestId": "d", "method": "deactivate", "params": {}, "extensionId": "acme.probe", "workspaceId": "w", "hostGeneration": 1}).to_string();
        prepare(&shared, &deactivate).unwrap();
        // A refusal the user can act on is told once, not on every repeat.
        authority.service.set_enabled("acme.probe", true).unwrap();
        let first = shared.screen(&request("documents.all")).unwrap().1;
        assert_eq!(first.unwrap().capability.as_deref(), Some("documents.read"));
        assert!(shared
            .screen(&request("documents.all"))
            .unwrap()
            .1
            .is_none());
        let _ = std::fs::remove_dir_all(dir);
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
