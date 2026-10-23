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
//!   disabled extension or an untrusted folder, except its `deactivate`. The window's answer
//!   to an extension's request is checked again when it comes back (EXT-16): it is delivered
//!   only for a request this session passed to the window and is still waiting on, and only if
//!   what that request needed is still allowed -- else the extension is answered why, with
//!   nothing of what the window found;
//! - **one host at a time (EXT-08).** A session is a host's identity (never reused; its own
//!   pipes). Starting one retires every other -- marked (nothing it says is passed on, nothing is
//!   sent to it), then ended. Every message must carry its session's `init` identity, and what
//!   only an extension's code says must come from an extension the session holds.
//!
//! - **an OS sandbox and resource limits (EXT-10).** The host runs in a Windows AppContainer
//!   with no capabilities, in a job of its own (`ide_workspace::sandbox`): no file but its
//!   program and the system's, no network, no process, memory and CPU capped -- set before it
//!   runs, or it does not start (`SandboxUnavailable`). Its limits are `HostResources`: the
//!   user's settings, bounded here; the window's `init` may ask for less, never more. What it
//!   sends is bounded here too: requests waiting for the window (`MAX_PENDING`), messages per
//!   second (`Budget`), and hosts that keep crashing are not started again at once.
//!
//! - **owned by a window (EXT-11).** Every host belongs to the window that started it: its
//!   native label (from the IPC call, never the renderer's word) and that window's page
//!   generation (`HostOwner`). Only its owner can speak to it or stop it (`NotOwner`), its
//!   events go to that window alone (`emit_to`), and starting one retires only its owner's
//!   others. A page load or a closed window ends that window's hosts; a host is bound to the
//!   workspace it started in, and its authority refuses once that is no longer the workspace.
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

use crate::extension_diagnostics::{code_of, Event};
use crate::extension_permissions::{need_of_event, need_of_request, Denial, Need};
use crate::extension_service::{ExtensionService, HostCopy};
use crate::extensions::{read_main, read_modules, read_vscode_main};
use crate::trust::{require_trust, Trust};
use crate::Workspace;
use ide_workspace::lsp_process::{ServerEvents, ServerProcess};
use ide_workspace::sandbox::{cpu_rate_for, SandboxPolicy};
use serde::{Deserialize, Serialize};
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

/// The extension host's resources (EXT-10), in one place: what the user's settings ask for,
/// each bounded (`bounded`). Enforced at three levels -- the job (Windows: the whole process's
/// memory and CPU, hard), the host's QuickJS runtimes (each extension's memory, each entry's
/// time: interrupted), and this layer (requests, messages, restarts).
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct HostResources {
    /// The whole host process's committed memory, MiB (its job).
    pub memory_mb: u64,
    /// Each extension's JavaScript heap, MiB (its runtime).
    pub extension_memory_mb: u64,
    /// CPU, in logical processors' worth (its job's hard cap).
    pub cpu_cores: u32,
    /// The longest one entry into an extension may run, ms (a command, an event, a provider).
    pub call_ms: u64,
    /// The longest loading an extension may run, ms.
    pub load_ms: u64,
}

impl Default for HostResources {
    fn default() -> Self {
        HostResources {
            memory_mb: 1024,
            extension_memory_mb: 64,
            cpu_cores: 1,
            call_ms: 2_000,
            load_ms: 5_000,
        }
    }
}

/// The AppContainer the extension host runs in.
pub const HOST_CONTAINER: &str = "Yavin.ExtensionHost";

impl HostResources {
    /// Each value within its bounds: what any request for resources becomes.
    pub fn bounded(self) -> HostResources {
        let memory_mb = self.memory_mb.clamp(256, 4096);
        HostResources {
            memory_mb,
            // An extension's heap never exceeds the process's.
            extension_memory_mb: self.extension_memory_mb.clamp(16, 512).min(memory_mb / 2),
            cpu_cores: self.cpu_cores.clamp(1, 64),
            call_ms: self.call_ms.clamp(100, 30_000),
            load_ms: self.load_ms.clamp(500, 60_000),
        }
    }

    /// The OS sandbox these resources make.
    pub fn policy(&self) -> SandboxPolicy {
        let processors = std::thread::available_parallelism().map_or(1, |n| n.get() as u32);
        SandboxPolicy {
            container: HOST_CONTAINER.into(),
            memory_bytes: self.memory_mb << 20,
            cpu_rate: cpu_rate_for(self.cpu_cores, processors),
        }
    }

    /// The host's `init` limits: what the window asked for, never more than these (nor less
    /// than the floors `bounded` keeps).
    fn limits(&self, asked: Option<&Value>) -> Value {
        let ask = |name: &str, most: u64, least: u64| {
            asked
                .and_then(|limits| limits.get(name))
                .and_then(Value::as_u64)
                .map_or(most, |value| value.clamp(least, most))
        };
        json!({
            "memoryBytes": ask("memoryBytes", self.extension_memory_mb << 20, 4 << 20),
            "loadMs": ask("loadMs", self.load_ms, 100),
            "callMs": ask("callMs", self.call_ms, 50),
        })
    }
}

/// The most requests of one host's extensions waiting for the window's answer (EXT-10); more
/// are answered `TooManyRequests` at once.
pub const MAX_PENDING: usize = 256;

/// How many messages a host may send: a burst of `BUDGET_BURST`, then `BUDGET_RATE` a second.
/// Past it, messages are dropped (a request is answered `RateLimited`) and the window is told
/// once per burst.
const BUDGET_BURST: f64 = 5_000.0;
const BUDGET_RATE: f64 = 2_000.0;

/// A token bucket over a host's messages.
struct Budget {
    tokens: f64,
    at: std::time::Instant,
    /// Dropping since the last message that fit: told once.
    dropping: bool,
}

impl Budget {
    fn new() -> Budget {
        Budget {
            tokens: BUDGET_BURST,
            at: std::time::Instant::now(),
            dropping: false,
        }
    }

    /// Whether one more message fits now, and whether this is the first one of a burst that
    /// does not (`Err(true)`).
    fn take(&mut self, now: std::time::Instant) -> Result<(), bool> {
        let elapsed = now.saturating_duration_since(self.at).as_secs_f64();
        self.at = now;
        self.tokens = (self.tokens + elapsed * BUDGET_RATE).min(BUDGET_BURST);
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            self.dropping = false;
            Ok(())
        } else {
            Err(!std::mem::replace(&mut self.dropping, true))
        }
    }
}

/// Hosts ending on their own (a crash, a runaway extension the sandbox ended) within
/// `CRASH_WINDOW`: at `MAX_CRASHES`, no host starts until the oldest is out of the window.
/// The window holds extensions off sooner (three, until Restart); this holds whatever it asks.
const MAX_CRASHES: usize = 5;
const CRASH_WINDOW: std::time::Duration = std::time::Duration::from_secs(60);

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
    /// A secret request of the code of `copy` (EXT-13), done natively: its answer.
    fn secret(&self, copy: &HostCopy, method: &str, params: &Value) -> Result<Value, Denial>;
    /// Records what happened (EXT-14). Best effort: never fails, never decides.
    fn note(&self, _event: Event) {}
    /// Changes whenever a grant does (EXT-16): a refusal is told again after one. Never decides.
    fn revision(&self) -> u64 {
        0
    }
}

/// One host's permission state: its authority, and what each extension it loaded is.
struct Shared {
    authority: Arc<dyn HostAuthority>,
    /// Replaced or stopped (EXT-08): nothing it sends is heard, nothing is sent to it.
    retired: std::sync::atomic::AtomicBool,
    /// The workspace and generation of its `init` (the first, which the host takes): what every
    /// stamped message of this session must carry.
    identity: Mutex<Option<(String, u64)>>,
    /// Unloads sent and not yet answered: their `unloaded` is still this extension's.
    unloading: Mutex<std::collections::HashSet<String>>,
    /// What each loaded extension's code is: recorded when the host says it loaded it.
    loaded: Mutex<HashMap<String, HostCopy>>,
    /// Loads sent and not yet answered: the host keeps what it had until a load succeeds.
    loading: Mutex<HashMap<String, HostCopy>>,
    /// Refusals the window was told of, and the last one with the grants' revision then
    /// (repeats are not told again -- unless a grant changed since: EXT-16).
    told: Mutex<(usize, Option<(Denied, u64)>)>,
    /// Its resources (EXT-10): the ceiling of what its `init` may ask.
    resources: HostResources,
    /// Requests of its extensions passed to the window and not yet answered, by (id,
    /// requestId), with the capability each needed (EXT-16: checked again on the answer).
    pending: Mutex<HashMap<(String, String), Option<String>>>,
    /// Its messages' budget.
    budget: Mutex<Budget>,
    /// Its window and session, for what it records (EXT-14).
    owner: Mutex<Option<(String, u32)>>,
}

/// The most refusals one host's window is told of (each extension was answered regardless).
const MAX_TOLD: usize = 1000;

/// A lock that a panic elsewhere did not leave unusable: the maps hold no invariant a panic
/// could break, and a refusal to read them must not open anything.
fn held<T>(lock: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Shared {
    #[cfg(test)]
    fn new(authority: Arc<dyn HostAuthority>) -> Shared {
        Shared::with(authority, HostResources::default())
    }

    fn with(authority: Arc<dyn HostAuthority>, resources: HostResources) -> Shared {
        Shared {
            resources,
            pending: Mutex::new(HashMap::new()),
            budget: Mutex::new(Budget::new()),
            owner: Mutex::new(None),
            authority,
            retired: std::sync::atomic::AtomicBool::new(false),
            identity: Mutex::new(None),
            unloading: Mutex::new(std::collections::HashSet::new()),
            loaded: Mutex::new(HashMap::new()),
            loading: Mutex::new(HashMap::new()),
            told: Mutex::new((0, None)),
        }
    }

    fn loaded(&self, id: &str) -> Option<HostCopy> {
        held(&self.loaded).get(id).cloned()
    }

    /// Records `code` of this session (EXT-14): its window and session, the extension and
    /// its loaded version, a detail that is never a payload (a method name, an exit code).
    fn note(
        &self,
        code: &str,
        phase: &'static str,
        extension: Option<&str>,
        detail: Option<String>,
    ) {
        let mut event = Event::new(code, phase);
        if let Some((window, session)) = held(&self.owner).clone() {
            event = event
                .window(window, session)
                .correlation(format!("session-{session}"));
        }
        if let Some(id) = extension {
            event = event.extension(id.to_string());
            if let Some(copy) = self.loaded(id) {
                event = event.version(copy.version);
            }
        }
        event.detail = detail;
        self.authority.note(event);
    }

    fn retired(&self) -> bool {
        self.retired.load(Ordering::SeqCst)
    }

    /// Whether `value`'s stamp (if it has one) is this session's own identity.
    fn stamped_here(&self, value: &Value) -> bool {
        let identity = held(&self.identity);
        let Some((workspace, generation)) = identity.as_ref() else {
            return true;
        };
        let workspace_ok = value
            .get("workspaceId")
            .is_none_or(|w| w.as_str() == Some(workspace.as_str()));
        let generation_ok = value
            .get("hostGeneration")
            .is_none_or(|g| g.as_u64() == Some(*generation));
        workspace_ok && generation_ok
    }

    /// Whether the window is told of `denied`: not a repeat of the last with no grant changed
    /// since (the window forgets a refusal once what it needed is allowed), not past `MAX_TOLD`.
    fn tell(&self, denied: &Denied) -> bool {
        let revision = self.authority.revision();
        let mut told = held(&self.told);
        let repeat = told
            .1
            .as_ref()
            .is_some_and(|(last, then)| last == denied && *then == revision);
        if repeat || told.0 >= MAX_TOLD {
            return false;
        }
        told.0 += 1;
        told.1 = Some((denied.clone(), revision));
        true
    }

    /// What a request of an extension needs, decided: `Ok` (with the capability it needed, if
    /// any) to pass it to the window.
    fn decide(
        &self,
        id: &str,
        method: &str,
        params: &Value,
    ) -> Result<Option<String>, (Denial, Option<String>)> {
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
                .map(|()| None)
                .map_err(|denial| (denial, None)),
            Need::Capability(capability) => match self.authority.allow(&copy, Some(&capability)) {
                Ok(()) => Ok(Some(capability)),
                Err(denial) => Err((denial, Some(capability))),
            },
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

    /// A message from the host, decided: passed to the window, dropped (a retired host, a
    /// stamp that is not this session's, an extension this session does not hold), or a
    /// refused request (the answer to the extension, and what the window is told).
    fn screen(&self, text: &str) -> Screened {
        if self.retired() {
            return Screened::Drop;
        }
        // The host's own output is JSON, always: anything else is not passed on.
        let Ok(value) = serde_json::from_str::<Value>(text) else {
            return Screened::Drop;
        };
        if !self.stamped_here(&value) {
            return Screened::Drop;
        }
        let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
        let id = value.get("extensionId").and_then(Value::as_str);
        let holds = |id: &str| held(&self.loaded).contains_key(id);
        match (kind, id) {
            // A load's answer: only a load the host made is what that extension now is.
            ("loaded", Some(id)) => {
                return match held(&self.loading).remove(id) {
                    Some(copy) => {
                        held(&self.loaded).insert(id.to_string(), copy);
                        Screened::Pass
                    }
                    None => Screened::Drop,
                };
            }
            ("unloaded", Some(id)) => {
                return if held(&self.unloading).remove(id) {
                    // Its requests will not be answered to it any more: they wait no longer.
                    held(&self.pending).retain(|(of, _), _| of != id);
                    Screened::Pass
                } else {
                    Screened::Drop
                };
            }
            ("error", Some(id)) => {
                held(&self.loading).remove(id);
                return Screened::Pass;
            }
            // What only a loaded extension's code says: from one this session holds, or nothing.
            ("response" | "log", Some(id)) => {
                return if holds(id) || held(&self.loading).contains_key(id) {
                    Screened::Pass
                } else {
                    Screened::Drop
                };
            }
            ("request", _) => {}
            ("response" | "log" | "loaded" | "unloaded", None) => return Screened::Drop,
            _ => return Screened::Pass,
        }
        // The host stamps every message an extension sends; one without an id is not passed on.
        let Some(id) = id else {
            return Screened::Drop;
        };
        let method = value.get("method").and_then(Value::as_str).unwrap_or("");
        let params = value.get("params").cloned().unwrap_or(Value::Null);
        // Its secrets (EXT-13): allowed like any request, then done here -- the window never
        // sees the request or its answer.
        if method.starts_with("secrets.") {
            let result = self.decide(id, method, &params).and_then(|_| {
                let copy = self.loaded(id).ok_or_else(|| {
                    (
                        Denial::new("NotLoaded", format!("{id} is not loaded in this host.")),
                        None,
                    )
                })?;
                self.authority
                    .secret(&copy, method, &params)
                    .map_err(|denial| (denial, None))
            });
            let answer = match &result {
                Ok(result) => {
                    json!({"type": "response", "extensionId": id, "workspaceId": value.get("workspaceId"), "hostGeneration": value.get("hostGeneration"), "requestId": value.get("requestId"), "ok": true, "result": result})
                }
                Err((denial, _)) => {
                    json!({"type": "response", "extensionId": id, "workspaceId": value.get("workspaceId"), "hostGeneration": value.get("hostGeneration"), "requestId": value.get("requestId"), "ok": false, "error": {"code": denial.code, "message": denial.message}})
                }
            };
            if let Err((denial, _)) = &result {
                self.note(
                    denial.code,
                    "secret",
                    Some(id),
                    Some(format!("method {method}")),
                );
            }
            // A refused one is told like any refused request (never what it carried).
            let told = match result {
                Err((denial, capability))
                    if capability.is_some() || denial.code == "PermissionDenied" =>
                {
                    let denied = Denied {
                        extension_id: id.to_string(),
                        method: method.to_string(),
                        capability: Some(crate::extension_permissions::SECRETS.to_string()),
                        code: denial.code.to_string(),
                        message: denial.message,
                    };
                    self.tell(&denied).then_some(denied)
                }
                _ => None,
            };
            return Screened::Refuse(answer.to_string(), told);
        }
        let decided = self.decide(id, method, &params).and_then(|capability| {
            // Allowed: it waits for the window, within the bound (EXT-10).
            let key = (id.to_string(), request_key(&value));
            let mut pending = held(&self.pending);
            if pending.len() >= MAX_PENDING && !pending.contains_key(&key) {
                return Err((
                    Denial::new(
                        "TooManyRequests",
                        format!("{id} has {MAX_PENDING} requests waiting already."),
                    ),
                    None,
                ));
            }
            pending.insert(key, capability);
            Ok(())
        });
        let Err((denial, capability)) = decided else {
            return Screened::Pass;
        };
        self.note(
            denial.code,
            "request",
            Some(id),
            Some(format!("method {method}")),
        );
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
        Screened::Refuse(
            answer.to_string(),
            (tell && self.tell(&denied)).then_some(denied),
        )
    }
}

/// A request's id as a key (whatever JSON it is).
fn request_key(value: &Value) -> String {
    value
        .get("requestId")
        .map(Value::to_string)
        .unwrap_or_default()
}

/// What becomes of a message from the host (`Shared::screen`).
#[derive(Debug, PartialEq)]
enum Screened {
    Pass,
    Drop,
    /// A refused request: the answer to the extension, and what the window is told, if anything.
    Refuse(String, Option<Denied>),
}

#[cfg(test)]
impl Screened {
    fn is_pass(&self) -> bool {
        *self == Screened::Pass
    }
    fn refused(self) -> (String, Option<Denied>) {
        match self {
            Screened::Refuse(answer, told) => (answer, told),
            other => panic!("not refused: {other:?}"),
        }
    }
}

/// The most stderr lines passed on per host, and the longest line.
const MAX_LOG_LINES: usize = 200;
const MAX_LOG_LINE: usize = 1000;
/// The latest stderr lines kept (EXT-08): passed on at the host's end when it wrote more than
/// `MAX_LOG_LINES`, so what it said last -- before a crash -- is not lost. Bounded.
const RECENT_LINES: usize = 20;

/// Who a host belongs to (EXT-11): a window -- its native label -- and that window's page
/// generation (a reload is a new page: what the old one started is not the new one's).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct HostOwner {
    pub window: String,
    pub page: u64,
}

/// The owner tests speak as: the one window of a test (page 0, never reloaded).
#[cfg(test)]
pub fn test_owner() -> HostOwner {
    HostOwner {
        window: "main".into(),
        page: 0,
    }
}

/// A running host: its process, its permission state, whose it is and where it runs.
#[derive(Clone)]
struct Host {
    process: Arc<ServerProcess>,
    shared: Arc<Shared>,
    owner: HostOwner,
    /// The workspace it was started in (EXT-11).
    workspace: Option<String>,
}

type Live = Arc<Mutex<HashMap<u32, Host>>>;

/// How a host process is started: in the OS sandbox (`ServerProcess::spawn_sandboxed`). Tests
/// put one that fails in its place, to see that nothing starts.
pub type Spawner =
    fn(&Path, &SandboxPolicy, Arc<dyn ServerEvents>) -> Result<ServerProcess, String>;

/// Every extension host Yavin started, by session number (never reused).
pub struct ExtHostSessions {
    next: AtomicU32,
    live: Live,
    crashes: Crashes,
    spawn: Spawner,
    /// Held while a host is started (EXT-10): retiring the owner's others, starting it and
    /// recording it are one step, so two starts at once cannot each find no other and both run.
    starting: Mutex<()>,
    /// Each window's page generation (EXT-11): raised when its page loads.
    pages: Mutex<HashMap<String, u64>>,
    /// Yavin is exiting: no host starts any more (EXT-11).
    exiting: std::sync::atomic::AtomicBool,
}

impl Default for ExtHostSessions {
    fn default() -> Self {
        ExtHostSessions::with_spawner(ServerProcess::spawn_sandboxed)
    }
}

/// A session's process events: its end takes it out of the live set before it is reported.
struct Session {
    session: u32,
    live: Live,
    events: Arc<dyn HostEvents>,
    /// Lines of stderr passed on so far.
    logged: AtomicU32,
    /// The latest lines (`RECENT_LINES`), whether passed on or not.
    recent: Mutex<std::collections::VecDeque<String>>,
    shared: Arc<Shared>,
    /// Answers to refused requests, written to the host by the session's answering thread.
    answers: std::sync::mpsc::SyncSender<String>,
    /// When hosts ended on their own (EXT-10), shared by every session.
    crashes: Crashes,
    /// The window that owns it (EXT-11): its crashes are that window's.
    window: String,
}

/// When hosts ended on their own, per window (EXT-10, EXT-11).
type Crashes = Arc<Mutex<HashMap<String, std::collections::VecDeque<std::time::Instant>>>>;

/// The exit code of a host its watchdog ended (`ide_plugin_host::watchdog::EXIT_CODE`).
fn ide_plugin_host_watchdog_exit() -> i32 {
    70
}

/// The most refusals waiting to be answered; more are dropped (a flood is not answered).
const MAX_ANSWERS: usize = 1024;

impl ServerEvents for Session {
    fn message(&self, message: String) {
        if self.shared.retired() {
            return;
        }
        // Within its budget, or dropped -- a request answered, so its caller does not wait.
        if let Err(first) = held(&self.shared.budget).take(std::time::Instant::now()) {
            if first {
                self.shared.note("MessageBudget", "request", None, None);
                self.events.log(
                    self.session,
                    "(the extension host sends more than Yavin takes; its messages are being dropped)"
                        .into(),
                );
            }
            if let Ok(value) = serde_json::from_str::<Value>(&message) {
                if value.get("type").and_then(Value::as_str) == Some("request") {
                    let answer = json!({
                        "type": "response",
                        "extensionId": value.get("extensionId"),
                        "workspaceId": value.get("workspaceId"),
                        "hostGeneration": value.get("hostGeneration"),
                        "requestId": value.get("requestId"),
                        "ok": false,
                        "error": {"code": "RateLimited", "message": "Too many messages: this request was not passed on."},
                    });
                    let _ = self.answers.try_send(answer.to_string());
                }
            }
            return;
        }
        match self.shared.screen(&message) {
            Screened::Pass => self.events.message(self.session, message),
            Screened::Drop => {}
            Screened::Refuse(answer, denied) => {
                let _ = self.answers.try_send(answer);
                if let Some(denied) = denied {
                    self.events.denied(self.session, denied);
                }
            }
        }
    }
    fn log(&self, line: String) {
        let n = self.logged.fetch_add(1, Ordering::Relaxed) as usize;
        let line: String = line.chars().take(MAX_LOG_LINE).collect();
        {
            let mut recent = held(&self.recent);
            if recent.len() == RECENT_LINES {
                recent.pop_front();
            }
            recent.push_back(line.clone());
        }
        if n < MAX_LOG_LINES {
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
        // Not stopped, not replaced: it ended on its own (EXT-14: recorded, without what it
        // wrote -- extensions' output is not a diagnostic).
        if !self.shared.retired() {
            let code_name = if code == Some(ide_plugin_host_watchdog_exit()) {
                "HostWatchdog"
            } else {
                "HostCrashed"
            };
            self.shared.note(
                code_name,
                "host",
                None,
                Some(match code {
                    Some(code) => format!("exit code {code}"),
                    None => "no exit code".to_string(),
                }),
            );
            held(&self.crashes)
                .entry(self.window.clone())
                .or_default()
                .push_back(std::time::Instant::now());
        }
        // Whatever it held is let go: nothing it asked waits for an answer.
        held(&self.shared.pending).clear();
        // It wrote more than was passed on: what it wrote last, before its end.
        if self.logged.load(Ordering::Relaxed) as usize > MAX_LOG_LINES {
            let recent: Vec<String> = held(&self.recent).iter().cloned().collect();
            self.events.log(
                self.session,
                format!("(the last {} lines it wrote:)", recent.len()),
            );
            for line in recent {
                self.events.log(self.session, line);
            }
        }
        self.events.exit(self.session, code, error);
    }
}

impl ExtHostSessions {
    pub fn with_spawner(spawn: Spawner) -> ExtHostSessions {
        ExtHostSessions {
            next: AtomicU32::new(0),
            live: Live::default(),
            crashes: Crashes::default(),
            spawn,
            starting: Mutex::new(()),
            pages: Mutex::new(HashMap::new()),
            exiting: std::sync::atomic::AtomicBool::new(false),
        }
    }

    /// The owner a window is now: its label and its current page (EXT-11).
    pub fn owner_of(&self, window: &str) -> HostOwner {
        HostOwner {
            window: window.to_string(),
            page: held(&self.pages).get(window).copied().unwrap_or(0),
        }
    }

    /// `window` loaded a page: a new page generation, and what the old page started ends.
    pub fn page_loaded(&self, window: &str) {
        *held(&self.pages).entry(window.to_string()).or_insert(0) += 1;
        self.stop_window(window);
    }

    /// `window` closed: its hosts end, and it is forgotten.
    pub fn window_closed(&self, window: &str) {
        self.stop_window(window);
        held(&self.pages).remove(window);
        held(&self.crashes).remove(window);
    }

    /// Hosts of `window` running and not retired: one at most (EXT-08, per window: EXT-11).
    #[cfg(test)]
    pub fn running_hosts_of(&self, window: &str) -> usize {
        held(&self.live)
            .values()
            .filter(|host| !host.shared.retired() && host.owner.window == window)
            .count()
    }

    /// Hosts running and not retired, every window's.
    #[cfg(test)]
    pub fn running_hosts(&self) -> usize {
        held(&self.live)
            .values()
            .filter(|host| !host.shared.retired())
            .count()
    }

    /// Starts `program` as a host whose extensions `authority` decides for, with the default
    /// resources (tests; the application starts hosts with the user's, `start_with`).
    #[cfg(test)]
    pub fn start(
        &self,
        program: &Path,
        events: Arc<dyn HostEvents>,
        authority: Arc<dyn HostAuthority>,
    ) -> Result<u32, String> {
        self.start_with(program, HostResources::default(), events, authority)
    }

    /// `start`, with `resources` (tests: the test window's).
    #[cfg(test)]
    pub fn start_with(
        &self,
        program: &Path,
        resources: HostResources,
        events: Arc<dyn HostEvents>,
        authority: Arc<dyn HostAuthority>,
    ) -> Result<u32, String> {
        self.start_for(&test_owner(), None, program, resources, events, authority)
    }

    /// Starts a host owned by `owner`, in `workspace`, with `resources` (bounded here) -- in
    /// its sandbox, or not at all. Only `owner`'s other hosts are retired (EXT-11).
    pub fn start_for(
        &self,
        owner: &HostOwner,
        workspace: Option<String>,
        program: &Path,
        resources: HostResources,
        events: Arc<dyn HostEvents>,
        authority: Arc<dyn HostAuthority>,
    ) -> Result<u32, String> {
        let resources = resources.bounded();
        let _one = held(&self.starting);
        if self.exiting.load(Ordering::SeqCst) {
            return Err("HostStopped: Yavin is exiting; no extension host starts.".into());
        }
        // A start the window's previous page asked for is not the new page's (EXT-11).
        if self.owner_of(&owner.window) != *owner {
            return Err(
                "NotOwner: this window has loaded again since; the extension host was not started."
                    .into(),
            );
        }
        // A host that keeps ending on its own is not started again at once (EXT-10) -- per
        // window: one window's crash loop does not hold another's extensions off (EXT-11).
        {
            let now = std::time::Instant::now();
            let mut all = held(&self.crashes);
            let crashes = all.entry(owner.window.clone()).or_default();
            while crashes
                .front()
                .is_some_and(|at| now.duration_since(*at) >= CRASH_WINDOW)
            {
                crashes.pop_front();
            }
            if crashes.len() >= MAX_CRASHES {
                let wait = CRASH_WINDOW.saturating_sub(now.duration_since(crashes[0]));
                let mut event = Event::new("HostCrashedRepeatedly", "host");
                event.window = Some(owner.window.clone());
                authority.note(event);
                return Err(format!(
                    "HostCrashedRepeatedly: the extension host ended unexpectedly {MAX_CRASHES} times within a minute; it can start again in {} s.",
                    wait.as_secs().max(1)
                ));
            }
        }
        let session = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        // One host at a time per window (EXT-08, EXT-11): the owner's every other is retired --
        // not heard, not spoken to, ended -- before this one exists, whether or not the window
        // stopped it. Other windows' hosts are not touched.
        self.retire_where(|host| host.owner.window == owner.window);
        let shared = Arc::new(Shared::with(authority.clone(), resources.clone()));
        *held(&shared.owner) = Some((owner.window.clone(), session));
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
        // In its sandbox (EXT-10), or not at all: there is no unsandboxed fallback.
        let process = (self.spawn)(
            program,
            &resources.policy(),
            Arc::new(Session {
                session,
                live: self.live.clone(),
                events,
                logged: AtomicU32::new(0),
                recent: Mutex::new(std::collections::VecDeque::with_capacity(RECENT_LINES)),
                shared: shared.clone(),
                answers,
                crashes: self.crashes.clone(),
                window: owner.window.clone(),
            }),
        )
        .map_err(|why| {
            let why = if why.starts_with("SandboxUnavailable:") {
                why
            } else {
                format!("HostFailed: {why}")
            };
            shared.note(code_of(&why), "host", None, Some(why.clone()));
            why
        })?;
        self.live.lock().map_err(|e| e.to_string())?.insert(
            session,
            Host {
                process: Arc::new(process),
                shared,
                owner: owner.clone(),
                workspace,
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

    /// Retires every live host `which` picks: marked first (nothing more of it is heard),
    /// then ended. Idempotent.
    fn retire_where(&self, which: impl Fn(&Host) -> bool) {
        let picked: Vec<Host> = match self.live.lock() {
            Ok(live) => live.values().filter(|host| which(host)).cloned().collect(),
            Err(_) => return,
        };
        for host in picked {
            host.shared.retired.store(true, Ordering::SeqCst);
            host.process.stop();
        }
    }

    /// `session`, if `owner` owns it; another window's (or an earlier page's) is not its to
    /// speak to or stop (EXT-11).
    fn owned(&self, owner: &HostOwner, session: u32) -> Result<Host, String> {
        let host = self.live(session)?;
        if host.owner != *owner {
            return Err("NotOwner: this extension host belongs to another window.".into());
        }
        Ok(host)
    }

    /// Test only: marks `session` retired without ending it -- a host that outlives its
    /// replacement, for the tests to try to speak through.
    #[cfg(test)]
    pub fn retire_but_keep_running(&self, session: u32) {
        if let Ok(host) = self.live(session) {
            host.shared.retired.store(true, Ordering::SeqCst);
        }
    }

    /// Sends one protocol message, checked (EXT-07, EXT-08); a `load` gets its extension's code
    /// from the copy the authority names for it (and the entry point its manifest names).
    #[cfg(test)]
    pub fn send(&self, session: u32, message: &str) -> Result<(), String> {
        self.send_as(&test_owner(), session, message)
    }

    /// `send`, as `owner`: only to a host it owns (EXT-11).
    pub fn send_as(&self, owner: &HostOwner, session: u32, message: &str) -> Result<(), String> {
        let host = self.owned(owner, session)?;
        if host.shared.retired() {
            return Err(
                "HostRetired: this extension host was replaced or stopped; it takes no more messages."
                    .into(),
            );
        }
        let prepared = prepare(&host.shared, message).inspect_err(|why| {
            let code = code_of(why);
            if matches!(
                code,
                "DependencyNotLoaded"
                    | "DependencyUnavailable"
                    | "IncompatibleApi"
                    | "InvalidManifest"
                    | "ExtensionDisabled"
                    | "TrustRequired"
                    | "PermissionDenied"
                    | "SafeMode"
                    | "WorkspaceChanged"
            ) {
                let value: Value = serde_json::from_str(message).unwrap_or_default();
                let id = value.get("extensionId").and_then(Value::as_str);
                let phase = match value.get("type").and_then(Value::as_str) {
                    Some("load") => "load",
                    Some("event") => "event",
                    _ => "request",
                };
                host.shared.note(code, phase, id, Some(why.clone()));
            }
        })?;
        host.process
            .send(&prepared)
            .map_err(|why| format!("HostStopped: {why}"))
    }

    /// The host process's id, while it runs (the real-host tests watch the process).
    #[cfg(test)]
    pub fn process_id(&self, session: u32) -> Option<u32> {
        self.live(session).ok().and_then(|host| host.process.id())
    }

    /// Ends a host and everything it started (its exit is still reported); nothing more of it
    /// is heard meanwhile.
    #[cfg(test)]
    pub fn stop(&self, session: u32) {
        let _ = self.stop_as(&test_owner(), session);
    }

    /// `stop`, as `owner`: only a host it owns (EXT-11).
    pub fn stop_as(&self, owner: &HostOwner, session: u32) -> Result<(), String> {
        let host = self.owned(owner, session)?;
        host.shared.retired.store(true, Ordering::SeqCst);
        host.process.stop();
        Ok(())
    }

    /// Ends every host of `window`, whatever its page: its page reloaded or it closed.
    pub fn stop_window(&self, window: &str) {
        self.retire_where(|host| host.owner.window == window);
    }

    /// `window` entered `workspace` (EXT-11): its hosts end -- an extension of A never runs on
    /// in B (IDE-08) -- and so does any other window's host started in another workspace than
    /// `workspace`: Yavin's native workspace is one for the whole application, so such a host
    /// has lost its own. Other windows' hosts in `workspace` carry on.
    pub fn workspace_entered(&self, window: &str, workspace: Option<&str>) {
        self.retire_where(|host| {
            host.owner.window == window || host.workspace.as_deref() != workspace
        });
    }

    /// Ends every host of every window: Yavin is exiting. No host starts after it -- a start
    /// under way finishes first (the start lock), and is ended here with the rest (EXT-11).
    pub fn stop_all(&self) {
        let _one = held(&self.starting);
        self.exiting.store(true, Ordering::SeqCst);
        let all: Vec<_> = match self.live.lock() {
            Ok(mut live) => live.drain().map(|(_, host)| host).collect(),
            Err(_) => return,
        };
        for host in all {
            host.shared.retired.store(true, Ordering::SeqCst);
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
    // The session's identity is its first `init`'s; every other message must carry it.
    if kind == "init" {
        let mut identity = held(&shared.identity);
        if identity.is_none() {
            if let (Some(workspace), Some(generation)) = (
                value.get("workspaceId").and_then(Value::as_str),
                value.get("hostGeneration").and_then(Value::as_u64),
            ) {
                *identity = Some((workspace.to_string(), generation));
            }
        }
        drop(identity);
        // Its limits are Yavin's (EXT-10): what the window asked, never past the resources.
        let limits = shared.resources.limits(value.get("limits"));
        let object = value.as_object_mut().ok_or("MalformedMessage")?;
        object.insert("limits".into(), limits);
        return Ok(value.to_string());
    } else if !shared.stamped_here(&value) {
        return Err(
            "StaleGeneration: this message is for another workspace or host generation.".into(),
        );
    }
    match (kind, id) {
        ("load", Some(id)) => {
            let copy = shared.authority.copy_of(&id)?;
            // A dependency with code runs first, in this same host (EXT-12): loaded here, at a
            // version in range -- never another window's or session's (EXT-11).
            for need in copy.requires.iter().filter(|need| need.code) {
                let loaded = shared.loaded(&need.id).and_then(|dependency| {
                    semver::Version::parse(&dependency.version)
                        .ok()
                        .filter(|v| need.range.matches(v))
                });
                if loaded.is_none() {
                    return Err(format!(
                        "DependencyNotLoaded: {id} needs {} {}, which this host has not loaded; it loads first.",
                        need.id, need.range.text
                    ));
                }
            }
            let folder = Path::new(&copy.folder);
            let object = value.as_object_mut().ok_or("MalformedMessage")?;
            if let Some(runtime) = &copy.runtime {
                // A VS Code extension (EXT-25): its entry point and the modules it may
                // `require`, all from its verified copy, and what the compatibility layer maps.
                let main = copy.main.replace('\\', "/");
                let mut modules = read_modules(folder)?;
                modules.remove(&main); // sent once, as the code
                object.insert(
                    "code".into(),
                    Value::String(read_vscode_main(folder, &copy.main)?),
                );
                object.insert("modules".into(), json!(modules));
                object.insert("main".into(), Value::String(main));
                object.insert("vscode".into(), runtime.clone());
            } else {
                object.insert("code".into(), Value::String(read_main(folder, &copy.main)?));
            }
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
            held(&shared.unloading).insert(id);
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
        // A call into an extension's code: only one this session loaded (EXT-08: refused here,
        // at once, not left to a host answer), and only while it may run -- its deactivation
        // always may (it lets the extension let go).
        ("request", Some(id)) => {
            let method = value.get("method").and_then(Value::as_str).unwrap_or("");
            let copy = shared
                .loaded(&id)
                .ok_or_else(|| format!("NotLoaded: {id} is not loaded in this host."))?;
            if method != "deactivate" {
                shared.authority.allow(&copy, None).map_err(refused)?;
            }
            Ok(message.to_string())
        }
        // An answer to an extension's request: only to one this session loaded, and only to a
        // request it passed to the window and is still waiting on. It is no longer waiting.
        ("response", Some(id)) if shared.loaded(&id).is_none() => {
            Err(format!("NotLoaded: {id} is not loaded in this host."))
        }
        ("response", Some(id)) => {
            let Some(capability) = held(&shared.pending).remove(&(id.clone(), request_key(&value)))
            else {
                return Err(format!(
                    "NotPending: {id} is not waiting for an answer to this request."
                ));
            };
            // What the request needed, checked again now (EXT-16): revoked, disabled, replaced
            // or untrusted since it was passed on, the extension gets the refusal -- not the
            // answer. (What the window did for it is done; what it found is not delivered.)
            let copy = shared
                .loaded(&id)
                .ok_or_else(|| format!("NotLoaded: {id} is not loaded in this host."))?;
            match shared.authority.allow(&copy, capability.as_deref()) {
                Ok(()) => Ok(message.to_string()),
                Err(denial) => {
                    shared.note(
                        denial.code,
                        "request",
                        Some(&id),
                        Some("an answer withheld: no longer allowed".into()),
                    );
                    let object = value.as_object_mut().ok_or("MalformedMessage")?;
                    object.remove("result");
                    object.insert("ok".into(), Value::Bool(false));
                    object.insert(
                        "error".into(),
                        json!({"code": denial.code, "message": denial.message}),
                    );
                    Ok(value.to_string())
                }
            }
        }
        _ => Ok(message.to_string()),
    }
}

/// The application's authority (EXT-07): Workspace Trust and the extension inventory, both
/// native, asked every time.
struct AppAuthority {
    app: AppHandle,
    /// The workspace its host was started in (EXT-11): its code may act only while that is
    /// still the workspace.
    workspace: Option<String>,
}

/// The workspace Yavin has open now, as a host is bound to it.
fn current_workspace(app: &AppHandle) -> Option<String> {
    let state = app.state::<Workspace>();
    let open = state.0.lock().ok()?;
    open.as_ref()
        .map(|manager| manager.root().display().to_string())
}

/// Whether a host started in `bound` may act while Yavin has `now` open (EXT-11).
fn still_in(bound: Option<&str>, now: Option<&str>) -> Result<(), Denial> {
    if bound != now {
        return Err(Denial::new(
            "WorkspaceChanged",
            "This extension host was started for another workspace.",
        ));
    }
    Ok(())
}

impl AppAuthority {
    fn trusted(&self) -> Result<(), Denial> {
        still_in(
            self.workspace.as_deref(),
            current_workspace(&self.app).as_deref(),
        )?;
        require_trust(
            &self.app,
            &self.app.state::<Workspace>(),
            &self.app.state::<Trust>(),
        )
        .map_err(|why| Denial::new("TrustRequired", why))
    }
}

impl HostAuthority for AppAuthority {
    fn copy_of(&self, id: &str) -> Result<HostCopy, String> {
        self.trusted().map_err(refused)?;
        self.app.state::<ExtensionService>().host_copy(id)
    }
    fn note(&self, event: Event) {
        self.app
            .state::<ExtensionService>()
            .diagnostics()
            .record(event);
    }
    fn secret(&self, copy: &HostCopy, method: &str, params: &Value) -> Result<Value, Denial> {
        self.trusted()?;
        self.app
            .state::<ExtensionService>()
            .secret(copy, self.workspace.as_deref(), method, params)
    }
    fn allow(&self, copy: &HostCopy, capability: Option<&str>) -> Result<(), Denial> {
        self.trusted()?;
        self.app
            .state::<ExtensionService>()
            .authorize(copy, capability)
    }
    fn revision(&self) -> u64 {
        self.app.state::<ExtensionService>().grants_revision()
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

/// Events to the window that owns the host -- that window alone (EXT-11), never broadcast:
/// `ext-host-message`, `ext-host-log` (its stderr), `ext-host-denied` (a refused request,
/// EXT-07), `ext-host-exit`, by session.
struct Emitting {
    app: AppHandle,
    window: String,
}

impl HostEvents for Emitting {
    fn message(&self, session: u32, message: String) {
        let _ = self.app.emit_to(
            self.window.as_str(),
            "ext-host-message",
            Message { session, message },
        );
    }
    fn log(&self, session: u32, line: String) {
        let _ = self
            .app
            .emit_to(self.window.as_str(), "ext-host-log", Log { session, line });
    }
    fn denied(&self, session: u32, denied: Denied) {
        let _ = self.app.emit_to(
            self.window.as_str(),
            "ext-host-denied",
            DeniedEvent { session, denied },
        );
    }
    fn exit(&self, session: u32, code: Option<i32>, error: Option<String>) {
        let _ = self.app.emit_to(
            self.window.as_str(),
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
    webview: tauri::Webview,
    state: State<'_, Workspace>,
    trust: State<'_, Trust>,
    sessions: State<'_, ExtHostSessions>,
    resources: Option<HostResources>,
) -> Result<u32, String> {
    require_trust(&app, &state, &trust).map_err(|why| format!("TrustRequired: {why}"))?;
    let program = host_program(&app)?;
    // Its owner is the window that asked, as Tauri says it (EXT-11); its workspace is
    // Yavin's now.
    let owner = sessions.owner_of(webview.label());
    let workspace = current_workspace(&app);
    // The user's settings, as the window sends them -- bounded natively (`start_for`).
    sessions.start_for(
        &owner,
        workspace.clone(),
        &program,
        resources.unwrap_or_default(),
        Arc::new(Emitting {
            app: app.clone(),
            window: owner.window.clone(),
        }),
        Arc::new(AppAuthority {
            app: app.clone(),
            workspace,
        }),
    )
}

/// Sends one protocol message to a host of the calling window (framing is added by the
/// process host).
#[tauri::command(async)]
pub fn ext_host_send(
    webview: tauri::Webview,
    sessions: State<'_, ExtHostSessions>,
    session: u32,
    message: String,
) -> Result<(), String> {
    sessions.send_as(&sessions.owner_of(webview.label()), session, &message)
}

/// Ends a host of the calling window and everything it started.
#[tauri::command(async)]
pub fn ext_host_stop(
    webview: tauri::Webview,
    sessions: State<'_, ExtHostSessions>,
    session: u32,
) -> Result<(), String> {
    sessions.stop_as(&sessions.owner_of(webview.label()), session)
}

/// Ends every host of every window: Yavin is exiting.
pub fn stop_all(sessions: &ExtHostSessions) {
    sessions.stop_all();
}

/// Ends the calling window's hosts (an earlier page's left running) -- no other window's.
#[tauri::command(async)]
pub fn ext_host_stop_all(
    webview: tauri::Webview,
    sessions: State<'_, ExtHostSessions>,
) -> Result<(), String> {
    sessions.stop_window(webview.label());
    Ok(())
}

/// The application's authority without Tauri, for tests: the real inventory, and Workspace
/// Trust as a switch.
#[cfg(test)]
pub struct ServiceAuthority {
    pub service: Arc<ExtensionService>,
    pub trusted: std::sync::atomic::AtomicBool,
    /// The workspace its host was started in (EXT-13: a workspace secret's).
    pub workspace: Mutex<Option<String>>,
}

#[cfg(test)]
impl ServiceAuthority {
    pub fn new(service: Arc<ExtensionService>) -> Arc<ServiceAuthority> {
        Arc::new(ServiceAuthority {
            service,
            trusted: std::sync::atomic::AtomicBool::new(true),
            workspace: Mutex::new(None),
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
    fn note(&self, event: Event) {
        self.service.diagnostics().record(event);
    }
    fn secret(&self, copy: &HostCopy, method: &str, params: &Value) -> Result<Value, Denial> {
        self.trusted()?;
        let workspace = held(&self.workspace).clone();
        self.service
            .secret(copy, workspace.as_deref(), method, params)
    }
    fn allow(&self, copy: &HostCopy, capability: Option<&str>) -> Result<(), Denial> {
        self.trusted()?;
        self.service.authorize(copy, capability)
    }
    fn revision(&self) -> u64 {
        self.service.grants_revision()
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
            recent: Mutex::new(std::collections::VecDeque::new()),
            shared: Arc::new(Shared::new(ServiceAuthority::new(Arc::new(
                ExtensionService::default(),
            )))),
            answers: std::sync::mpsc::sync_channel(1).0,
            crashes: Crashes::default(),
            window: "main".into(),
        };
        session.log("x".repeat(MAX_LOG_LINE + 50));
        for n in 0..(MAX_LOG_LINES + 20) {
            session.log(format!("line {n}"));
        }
        {
            let lines = seen.0.lock().unwrap();
            assert_eq!(lines.len(), MAX_LOG_LINES + 1);
            assert!(lines.iter().all(|(s, _)| *s == 7));
            assert_eq!(lines[0].1.chars().count(), MAX_LOG_LINE);
            assert!(lines.last().unwrap().1.contains("the rest is not shown"));
        }
        // At its end, what it wrote last (EXT-08): the latest lines, bounded.
        session.exit(Some(1), None);
        let lines = seen.0.lock().unwrap();
        let tail: Vec<&str> = lines[MAX_LOG_LINES + 1..]
            .iter()
            .map(|(_, l)| l.as_str())
            .collect();
        assert_eq!(tail.len(), RECENT_LINES + 1, "{tail:?}");
        assert!(tail[0].contains("the last 20 lines"));
        assert_eq!(
            tail[1],
            format!("line {}", MAX_LOG_LINES + 20 - RECENT_LINES)
        );
        assert_eq!(
            *tail.last().unwrap(),
            format!("line {}", MAX_LOG_LINES + 19)
        );
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
        // The body of `ExtHostSessions::start_with` (not this test's own text): the program and
        // its sandbox policy, nothing else -- through the sandboxed spawn, which passes no
        // arguments (EXT-06, EXT-10).
        let start = source.find("    pub fn start_for(").unwrap();
        let code = &source[start..start + source[start..].find("\n    }\n").unwrap()];
        assert!(
            code.contains(
                "(self.spawn)(
            program,
            &resources.policy(),"
            ),
            "no arguments"
        );
        assert!(source.contains("ExtHostSessions::with_spawner(ServerProcess::spawn_sandboxed)"));
        let process = include_str!("../crates/ide-workspace/src/lsp_process.rs");
        assert!(process.contains("crate::sandbox::spawn(program, &[], policy)"));
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

    /// A host is bound to the workspace it started in (EXT-11): in any other -- or none -- its
    /// code is refused, whichever window asks.
    #[test]
    fn a_host_acts_only_in_the_workspace_it_started_in() {
        assert!(still_in(Some("C:/w1"), Some("C:/w1")).is_ok());
        assert!(still_in(None, None).is_ok());
        for (bound, now) in [
            (Some("C:/w1"), Some("C:/w2")),
            (Some("C:/w1"), None),
            (None, Some("C:/w1")),
        ] {
            assert_eq!(still_in(bound, now).unwrap_err().code, "WorkspaceChanged");
        }
    }

    // --- EXT-10: resources, bounds, and a sandbox that cannot be set up ---------------------

    /// Whatever the window asks for, the resources are within their bounds -- and a field
    /// that is not a resource (`sandbox: false`) is refused, not ignored.
    #[test]
    fn host_resources_are_bounded_and_cannot_turn_the_sandbox_off() {
        let huge = HostResources {
            memory_mb: u64::MAX,
            extension_memory_mb: u64::MAX,
            cpu_cores: u32::MAX,
            call_ms: u64::MAX,
            load_ms: u64::MAX,
        }
        .bounded();
        assert_eq!(
            huge,
            HostResources {
                memory_mb: 4096,
                extension_memory_mb: 512,
                cpu_cores: 64,
                call_ms: 30_000,
                load_ms: 60_000,
            }
        );
        let tiny = HostResources {
            memory_mb: 0,
            extension_memory_mb: 0,
            cpu_cores: 0,
            call_ms: 0,
            load_ms: 0,
        }
        .bounded();
        assert_eq!(
            (
                tiny.memory_mb,
                tiny.extension_memory_mb,
                tiny.cpu_cores,
                tiny.call_ms,
                tiny.load_ms
            ),
            (256, 16, 1, 100, 500)
        );
        // An extension's heap is at most half the process's.
        let small = HostResources {
            memory_mb: 256,
            extension_memory_mb: 512,
            ..HostResources::default()
        }
        .bounded();
        assert_eq!(small.extension_memory_mb, 128);
        for forged in [
            json!({"sandbox": false}),
            json!({"memoryMb": 512, "container": "Other"}),
            json!({"memoryMb": "all"}),
        ] {
            assert!(
                serde_json::from_value::<HostResources>(forged.clone()).is_err(),
                "{forged}"
            );
        }
        let asked: HostResources = serde_json::from_value(json!({"memoryMb": 512})).unwrap();
        assert_eq!(asked.memory_mb, 512);
        assert_eq!(asked.call_ms, HostResources::default().call_ms);
        let policy = HostResources::default().policy();
        assert_eq!(policy.container, HOST_CONTAINER);
        assert_eq!(policy.memory_bytes, 1024 << 20);
        assert!(policy.validate().is_ok());
    }

    /// The window's `init` limits never pass the resources: more is cut to them, less is kept,
    /// none is them -- whatever the window sends, the host is told this.
    #[test]
    fn the_hosts_init_limits_are_yavins() {
        let (dir, authority) = scratch_authority("init-limits", PROBE_MANIFEST);
        let shared = Shared::with(authority, HostResources::default().bounded());
        let limits = |asked: Value| {
            let init = json!({"type": "init", "workspaceId": "w", "hostGeneration": 1, "apiVersion": "2.0.0", "limits": asked});
            let sent: Value =
                serde_json::from_str(&prepare(&shared, &init.to_string()).unwrap()).unwrap();
            sent["limits"].clone()
        };
        assert_eq!(
            limits(json!({"memoryBytes": u64::MAX, "loadMs": 10_000_000, "callMs": 10_000_000})),
            json!({"memoryBytes": 64u64 << 20, "loadMs": 5_000, "callMs": 2_000})
        );
        assert_eq!(
            limits(json!({"memoryBytes": 32u64 << 20, "loadMs": 3_000, "callMs": 300})),
            json!({"memoryBytes": 32u64 << 20, "loadMs": 3_000, "callMs": 300})
        );
        assert_eq!(
            limits(json!(null)),
            json!({"memoryBytes": 64u64 << 20, "loadMs": 5_000, "callMs": 2_000})
        );
        assert_eq!(
            limits(json!({"memoryBytes": 0, "loadMs": 0, "callMs": 0})),
            json!({"memoryBytes": 4u64 << 20, "loadMs": 100, "callMs": 50})
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    /// At most `MAX_PENDING` requests of a host's extensions wait for the window: the next is
    /// answered `TooManyRequests` here; an answer from the window makes room; an unload lets
    /// its extension's go.
    #[test]
    fn requests_waiting_for_the_window_are_bounded() {
        let (dir, authority) = scratch_authority("pending", PROBE_MANIFEST);
        let shared = Shared::new(authority);
        let load = json!({"type": "load", "extensionId": "acme.probe", "workspaceId": "w", "hostGeneration": 1}).to_string();
        prepare(&shared, &load).unwrap();
        assert!(shared
            .screen(&json!({"type": "loaded", "extensionId": "acme.probe"}).to_string())
            .is_pass());
        let ask = |n: usize| {
            json!({"type": "request", "requestId": format!("r{n}"), "method": "commands.execute", "params": {"id": "acme.probe.go"}, "extensionId": "acme.probe", "workspaceId": "w", "hostGeneration": 1}).to_string()
        };
        for n in 0..MAX_PENDING {
            assert!(shared.screen(&ask(n)).is_pass(), "request {n}");
        }
        let (answer, told) = shared.screen(&ask(MAX_PENDING)).refused();
        assert!(answer.contains("TooManyRequests"), "{answer}");
        assert!(told.is_none());
        // The same request again is not a new one.
        assert!(shared.screen(&ask(0)).is_pass());
        let answered = json!({"type": "response", "requestId": "r0", "ok": true, "result": null, "extensionId": "acme.probe", "workspaceId": "w", "hostGeneration": 1}).to_string();
        prepare(&shared, &answered).unwrap();
        assert!(shared.screen(&ask(MAX_PENDING)).is_pass(), "room again");
        assert!(!shared.screen(&ask(MAX_PENDING + 1)).is_pass());
        // Unloaded: what it asked waits no more.
        let unload = json!({"type": "unload", "extensionId": "acme.probe", "workspaceId": "w", "hostGeneration": 1}).to_string();
        prepare(&shared, &unload).unwrap();
        assert!(shared
            .screen(&json!({"type": "unloaded", "extensionId": "acme.probe"}).to_string())
            .is_pass());
        assert!(held(&shared.pending).is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A host's messages: a burst, then a rate; past it, dropped -- and told once per burst.
    #[test]
    fn a_hosts_messages_have_a_budget() {
        let mut budget = Budget::new();
        let start = budget.at;
        for _ in 0..BUDGET_BURST as usize {
            assert!(budget.take(start).is_ok());
        }
        assert_eq!(budget.take(start), Err(true), "the first dropped is told");
        assert_eq!(budget.take(start), Err(false), "the rest are not");
        // A second later: a second's worth again.
        let later = start + std::time::Duration::from_secs(1);
        for _ in 0..BUDGET_RATE as usize {
            assert!(budget.take(later).is_ok());
        }
        assert!(budget.take(later).is_err());
        // Never more than a burst, however long it was quiet.
        let much_later = start + std::time::Duration::from_secs(3600);
        let mut fitted = 0;
        while budget.take(much_later).is_ok() {
            fitted += 1;
        }
        assert_eq!(fitted, BUDGET_BURST as usize);
    }

    /// A host whose sandbox cannot be set up does not start -- not with less, not at all -- and
    /// nothing of it is left; the sandbox asked for is the resources' own.
    #[test]
    fn a_host_whose_sandbox_cannot_be_set_up_does_not_start() {
        static ASKED: Mutex<Vec<SandboxPolicy>> = Mutex::new(Vec::new());
        fn failing(
            _: &Path,
            policy: &SandboxPolicy,
            _: Arc<dyn ServerEvents>,
        ) -> Result<ServerProcess, String> {
            ASKED.lock().unwrap().push(policy.clone());
            Err("SandboxUnavailable: no AppContainer here.".into())
        }
        struct Quiet;
        impl HostEvents for Quiet {
            fn message(&self, _: u32, _: String) {}
            fn exit(&self, _: u32, _: Option<i32>, _: Option<String>) {}
        }
        let sessions = ExtHostSessions::with_spawner(failing);
        let authority = ServiceAuthority::new(Arc::new(ExtensionService::default()));
        for _ in 0..3 {
            let error = sessions
                .start_with(
                    Path::new("C:/host.exe"),
                    HostResources {
                        memory_mb: 99_999,
                        ..HostResources::default()
                    },
                    Arc::new(Quiet),
                    authority.clone(),
                )
                .unwrap_err();
            assert_eq!(error, "SandboxUnavailable: no AppContainer here.");
            assert_eq!(sessions.running_hosts(), 0);
            assert!(sessions.send(1, "{}").is_err());
        }
        let asked = ASKED.lock().unwrap();
        assert_eq!(asked.len(), 3);
        assert!(asked
            .iter()
            .all(|p| p.container == HOST_CONTAINER && p.memory_bytes == 4096 << 20));
        // Any other failure is the host's own, said as such.
        fn missing(
            _: &Path,
            _: &SandboxPolicy,
            _: Arc<dyn ServerEvents>,
        ) -> Result<ServerProcess, String> {
            Err("C:/host.exe was not found.".into())
        }
        let error = ExtHostSessions::with_spawner(missing)
            .start(Path::new("C:/host.exe"), Arc::new(Quiet), authority)
            .unwrap_err();
        assert!(error.starts_with("HostFailed:"), "{error}");
    }

    /// A sandbox that cannot be set up, a crash loop, a flood of messages: each recorded
    /// (EXT-14) -- with the window -- and the refusal itself unchanged.
    #[test]
    fn a_sandbox_failure_a_crash_loop_and_a_flood_are_recorded() {
        fn failing(
            _: &Path,
            _: &SandboxPolicy,
            _: Arc<dyn ServerEvents>,
        ) -> Result<ServerProcess, String> {
            Err("SandboxUnavailable: no AppContainer here.".into())
        }
        struct Quiet;
        impl HostEvents for Quiet {
            fn message(&self, _: u32, _: String) {}
            fn exit(&self, _: u32, _: Option<i32>, _: Option<String>) {}
        }
        let service = Arc::new(ExtensionService::default());
        let authority = ServiceAuthority::new(service.clone());
        let sessions = ExtHostSessions::with_spawner(failing);
        let owner = HostOwner {
            window: "window-a".into(),
            page: 0,
        };
        let error = sessions
            .start_for(
                &owner,
                None,
                Path::new("C:/host.exe"),
                HostResources::default(),
                Arc::new(Quiet),
                authority.clone(),
            )
            .unwrap_err();
        assert!(error.starts_with("SandboxUnavailable"));
        let seen = service.diagnostics().visible("window-a", None);
        assert_eq!(seen[0].code, "SandboxUnavailable");
        assert_eq!(
            seen[0].category,
            crate::extension_diagnostics::Category::Sandbox
        );
        assert!(seen[0].refusal);
        assert_eq!(seen[0].window.as_deref(), Some("window-a"));
        assert!(service.diagnostics().visible("window-b", None).is_empty());
        // A crash loop: held off, and said.
        held(&sessions.crashes)
            .entry("window-a".into())
            .or_default()
            .extend(std::iter::repeat_n(std::time::Instant::now(), MAX_CRASHES));
        let held_off = sessions
            .start_for(
                &owner,
                None,
                Path::new("C:/host.exe"),
                HostResources::default(),
                Arc::new(Quiet),
                authority.clone(),
            )
            .unwrap_err();
        assert!(held_off.starts_with("HostCrashedRepeatedly"));
        assert!(service
            .diagnostics()
            .visible("window-a", None)
            .iter()
            .any(|d| d.code == "HostCrashedRepeatedly"));
        // A flood: past the budget, messages dropped -- and recorded once per burst, not per
        // message.
        let shared = Arc::new(Shared::new(authority.clone()));
        *held(&shared.owner) = Some(("window-a".into(), 9));
        let session = Session {
            session: 9,
            live: Live::default(),
            events: Arc::new(Quiet),
            logged: AtomicU32::new(0),
            recent: Mutex::new(std::collections::VecDeque::new()),
            shared,
            answers: std::sync::mpsc::sync_channel(4).0,
            crashes: Crashes::default(),
            window: "window-a".into(),
        };
        for _ in 0..(BUDGET_BURST as usize + 200) {
            session.message("{\"type\":\"log\"}".into());
        }
        let floods: Vec<_> = service
            .diagnostics()
            .visible("window-a", None)
            .into_iter()
            .filter(|d| d.code == "MessageBudget")
            .collect();
        assert_eq!(floods.len(), 1);
        assert_eq!(floods[0].session, Some(9));
    }

    const PROBE_MANIFEST: &str = r#"{"publisher":"acme","name":"probe","version":"1.0.0","engines":{"yavin":"^2.0.0"},"main":"extension.js","permissions":{"version":1,"request":["documents.read"]}}"#;

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
        let (_, denied) = shared.screen(&request("commands.execute")).refused();
        assert!(denied.is_none());
        // The host failed to load it: nothing is recorded.
        assert!(shared
            .screen(&json!({"type": "error", "extensionId": "acme.probe", "error": {"code": "LoadFailed", "message": "x"}}).to_string())
            .is_pass());
        assert!(shared.loaded("acme.probe").is_none());
        // Loaded: now it is what it is.
        prepare(&shared, &load).unwrap();
        assert!(shared
            .screen(&json!({"type": "loaded", "extensionId": "acme.probe"}).to_string())
            .is_pass());
        assert_eq!(shared.loaded("acme.probe").unwrap().version, "1.0.0");
        assert!(
            shared.screen(&request("commands.execute")).is_pass(),
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
        let (answer, told) = shared.screen(&request("storage.update")).refused();
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
        let first = shared.screen(&request("documents.all")).refused().1;
        assert_eq!(first.unwrap().capability.as_deref(), Some("documents.read"));
        assert!(shared
            .screen(&request("documents.all"))
            .refused()
            .1
            .is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    // --- EXT-16: revocation and requests in flight ------------------------------------------

    fn probe_loaded(name: &str) -> (PathBuf, Arc<ServiceAuthority>, Shared) {
        let (dir, authority) = scratch_authority(name, PROBE_MANIFEST);
        let shared = Shared::new(authority.clone());
        let load = json!({"type": "load", "extensionId": "acme.probe", "workspaceId": "w", "hostGeneration": 1}).to_string();
        prepare(&shared, &load).unwrap();
        assert!(shared
            .screen(&json!({"type": "loaded", "extensionId": "acme.probe"}).to_string())
            .is_pass());
        (dir, authority, shared)
    }

    fn read_text(request: &str) -> String {
        json!({"type": "request", "requestId": request, "method": "documents.getText", "params": {"uri": "file:///C:/w/a.txt"}, "extensionId": "acme.probe", "workspaceId": "w", "hostGeneration": 1}).to_string()
    }

    fn answer(request: &str, text: &str) -> String {
        json!({"type": "response", "requestId": request, "ok": true, "result": text, "extensionId": "acme.probe", "workspaceId": "w", "hostGeneration": 1}).to_string()
    }

    /// A request allowed before a revocation and still waiting for the window does not carry
    /// the window's answer back once the capability is revoked: the extension is answered
    /// `PermissionDenied`, with nothing of what the window found. Allowed throughout, it passes.
    #[test]
    fn ext16_an_answer_to_a_request_revoked_meanwhile_carries_nothing() {
        let (dir, authority, shared) = probe_loaded("ext16-answer");
        let grant = |caps: &[&str]| {
            let caps: Vec<String> = caps.iter().map(|c| c.to_string()).collect();
            authority
                .service
                .set_grants("acme.probe", None, &caps)
                .unwrap();
        };
        grant(&["documents.read"]);
        assert!(shared.screen(&read_text("r1")).is_pass());
        grant(&[]);
        let sent: Value =
            serde_json::from_str(&prepare(&shared, &answer("r1", "THE DOCUMENT TEXT")).unwrap())
                .unwrap();
        assert!(!sent.to_string().contains("THE DOCUMENT TEXT"), "{sent}");
        assert_eq!(sent["ok"], json!(false));
        assert_eq!(sent["error"]["code"], json!("PermissionDenied"));
        assert_eq!(sent["requestId"], json!("r1"));
        assert!(held(&shared.pending).is_empty(), "no longer waiting");
        // Allowed throughout: the answer passes as it is.
        grant(&["documents.read"]);
        assert!(shared.screen(&read_text("r2")).is_pass());
        let passed = prepare(&shared, &answer("r2", "THE DOCUMENT TEXT")).unwrap();
        assert!(passed.contains("THE DOCUMENT TEXT"));
        // Disabled meanwhile: nothing carried either.
        assert!(shared.screen(&read_text("r3")).is_pass());
        authority.service.set_enabled("acme.probe", false).unwrap();
        let sent = prepare(&shared, &answer("r3", "THE DOCUMENT TEXT")).unwrap();
        assert!(
            !sent.contains("THE DOCUMENT TEXT") && sent.contains("ExtensionDisabled"),
            "{sent}"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    /// An answer to a request this session never passed to the window (or already answered)
    /// is not delivered: nothing reaches an extension that was not asked for and checked.
    #[test]
    fn ext16_an_answer_to_no_waiting_request_is_refused() {
        let (dir, authority, shared) = probe_loaded("ext16-unasked");
        authority
            .service
            .set_grants("acme.probe", None, &["documents.read".to_string()])
            .unwrap();
        let refused = prepare(&shared, &answer("never-asked", "THE DOCUMENT TEXT")).unwrap_err();
        assert!(refused.starts_with("NotPending"), "{refused}");
        assert!(shared.screen(&read_text("r1")).is_pass());
        prepare(&shared, &answer("r1", "first")).unwrap();
        let again = prepare(&shared, &answer("r1", "second")).unwrap_err();
        assert!(again.starts_with("NotPending"), "{again}");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Revoking one capability leaves every other as it was (and its requests passing).
    #[test]
    fn ext16_revoking_one_capability_leaves_the_others() {
        let manifest = PROBE_MANIFEST.replace(
            r#""request":["documents.read"]"#,
            r#""request":["documents.read","editor.control"]"#,
        );
        let (dir, authority) = scratch_authority("ext16-one", &manifest);
        let shared = Shared::new(authority.clone());
        let load = json!({"type": "load", "extensionId": "acme.probe", "workspaceId": "w", "hostGeneration": 1}).to_string();
        prepare(&shared, &load).unwrap();
        shared.screen(&json!({"type": "loaded", "extensionId": "acme.probe"}).to_string());
        let both = vec!["documents.read".to_string(), "editor.control".to_string()];
        authority
            .service
            .set_grants("acme.probe", None, &both)
            .unwrap();
        let reveal = |id: &str| {
            json!({"type": "request", "requestId": id, "method": "editor.revealRange", "params": {}, "extensionId": "acme.probe", "workspaceId": "w", "hostGeneration": 1}).to_string()
        };
        assert!(shared.screen(&reveal("e1")).is_pass());
        assert!(shared.screen(&read_text("d1")).is_pass());
        authority
            .service
            .set_grants("acme.probe", None, &["editor.control".to_string()])
            .unwrap();
        let (_, told) = shared.screen(&read_text("d2")).refused();
        assert_eq!(told.unwrap().capability.as_deref(), Some("documents.read"));
        assert!(shared.screen(&reveal("e2")).is_pass());
        // The answer to the request of the one still allowed passes.
        let ok = json!({"type": "response", "requestId": "e1", "ok": true, "result": null, "extensionId": "acme.probe", "workspaceId": "w", "hostGeneration": 1}).to_string();
        assert!(prepare(&shared, &ok).unwrap().contains(r#""ok":true"#));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Refused, allowed, revoked, refused again: the second refusal is told to the window
    /// too (it forgot the first when the permission was allowed). A repeat with no change of
    /// grants in between is still told once.
    #[test]
    fn ext16_a_refusal_after_a_revocation_is_told_again() {
        let (dir, authority, shared) = probe_loaded("ext16-told");
        let grant = |caps: &[&str]| {
            let caps: Vec<String> = caps.iter().map(|c| c.to_string()).collect();
            authority
                .service
                .set_grants("acme.probe", None, &caps)
                .unwrap();
        };
        assert!(shared.screen(&read_text("a")).refused().1.is_some(), "told");
        assert!(
            shared.screen(&read_text("b")).refused().1.is_none(),
            "a repeat: not again"
        );
        grant(&["documents.read"]);
        assert!(shared.screen(&read_text("c")).is_pass());
        grant(&[]);
        let told = shared.screen(&read_text("d")).refused().1;
        assert_eq!(
            told.expect("told again after the revocation")
                .capability
                .as_deref(),
            Some("documents.read")
        );
        assert!(
            shared.screen(&read_text("e")).refused().1.is_none(),
            "a repeat: not again"
        );
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
