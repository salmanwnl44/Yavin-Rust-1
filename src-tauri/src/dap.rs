//! Debug adapters, as processes the renderer can ask for by name (IDE-05).
//!
//! A debug adapter speaks the Debug Adapter Protocol over stdin/stdout with the same base
//! protocol as a language server -- `Content-Length` headers and a JSON body -- so it runs on the
//! same process host as the language servers (`ide_workspace::lsp_process::ServerProcess`): the
//! framing (`lsp_framing`: partial reads, several messages per read, a malformed header ends the
//! session), the Job Object that ends an adapter and everything it started (the debuggee
//! included) however Yavin ends, and the exit report. There is no second process system.
//!
//! As for language servers and checkers there is no "run this program": a fixed allow-list of
//! adapters, each with a fixed command line, picked by id. Starting one needs the folder to be
//! trusted -- an adapter runs the project's code. The one thing a user may choose is which
//! Python runs debugpy (the `debug.python` setting), and only an existing Python interpreter
//! is accepted for it. Everything above the framing -- the DAP requests, events, session
//! state -- is the renderer's (`src/services/debug`).
//!
//! Errors are `Code: message`, the code one the renderer maps to its typed `DebugError`.

use crate::trust::{require_trust, Trust};
use crate::{with_workspace, Workspace};
use ide_workspace::lsp_process::{resolve_program, ServerEvents, ServerProcess};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

/// An adapter Yavin knows how to start: its program and exact arguments.
struct AdapterSpec {
    /// The id the renderer's adapter list (`src/services/debug/adapters.ts`) uses.
    id: &'static str,
    label: &'static str,
    program: &'static str,
    args: &'static [&'static str],
    /// The program is a Python interpreter, which the user may choose (`debug.python`).
    python: bool,
    /// What to install when it is missing.
    install: &'static str,
}

const ADAPTERS: &[AdapterSpec] = &[AdapterSpec {
    id: "debugpy",
    label: "Python (debugpy)",
    program: "python",
    args: &["-m", "debugpy.adapter"],
    python: true,
    install: "pip install debugpy",
}];

fn find(id: &str) -> Option<&'static AdapterSpec> {
    ADAPTERS.iter().find(|adapter| adapter.id == id)
}

/// A Python interpreter the user named: an existing file called `python…` or `py`. Anything
/// else is refused -- this is not a way to run an arbitrary program.
fn interpreter(path: &str) -> Result<PathBuf, String> {
    let candidate = PathBuf::from(path);
    let named = candidate
        .file_stem()
        .and_then(|stem| stem.to_str())
        .map(|stem| stem.to_ascii_lowercase());
    let python =
        matches!(named.as_deref(), Some(stem) if stem == "py" || stem.starts_with("python"));
    if !candidate.is_absolute() || !python {
        return Err(format!(
            "InvalidConfiguration: \"{path}\" is not a Python interpreter (debug.python must be the full path of python or python3)."
        ));
    }
    if !candidate.is_file() {
        return Err(format!(
            "AdapterUnavailable: The Python interpreter \"{path}\" (debug.python) does not exist."
        ));
    }
    Ok(candidate)
}

/// Every debug adapter Yavin started, by session number. Numbers are never reused, so an event
/// of an adapter that has ended can never be taken for one of its successor's.
#[derive(Default)]
pub struct DapSessions {
    next: AtomicU32,
    live: Mutex<HashMap<u32, Arc<ServerProcess>>>,
}

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
struct Exit {
    session: u32,
    code: Option<i32>,
    error: Option<String>,
}

struct Emitting {
    app: AppHandle,
    session: u32,
}

impl ServerEvents for Emitting {
    fn message(&self, message: String) {
        let _ = self.app.emit(
            "dap-message",
            Message {
                session: self.session,
                message,
            },
        );
    }
    fn log(&self, line: String) {
        let _ = self.app.emit(
            "dap-log",
            Log {
                session: self.session,
                line,
            },
        );
    }
    fn exit(&self, code: Option<i32>, error: Option<String>) {
        if let Ok(mut live) = self.app.state::<DapSessions>().live.lock() {
            live.remove(&self.session);
        }
        let _ = self.app.emit(
            "dap-exit",
            Exit {
                session: self.session,
                code,
                error,
            },
        );
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    session: u32,
    program: String,
}

/// The program to start `spec` with: the user's interpreter for a Python adapter when one is
/// set, else the program on `PATH`.
fn program_for(spec: &AdapterSpec, python: Option<&str>, folder: &Path) -> Result<PathBuf, String> {
    if let Some(path) = python.filter(|path| !path.trim().is_empty()) {
        if !spec.python {
            return Err(format!(
                "InvalidConfiguration: The {} adapter does not run on Python.",
                spec.label
            ));
        }
        return interpreter(path.trim());
    }
    resolve_program(spec.program, false, folder, std::env::var_os("PATH")).ok_or_else(|| {
        format!(
            "AdapterUnavailable: The {} debug adapter needs {}, which was not found ({}).",
            spec.label, spec.program, spec.install
        )
    })
}

/// Starts adapter `adapter` in the folder `root` (inside the workspace). Its messages arrive
/// as `dap-message` events, its log as `dap-log`, its end as `dap-exit`.
#[tauri::command]
pub async fn dap_start(
    app: AppHandle,
    state: State<'_, Workspace>,
    trust: State<'_, Trust>,
    sessions: State<'_, DapSessions>,
    adapter: String,
    root: String,
    python: Option<String>,
) -> Result<Started, String> {
    require_trust(&app, &state, &trust).map_err(|why| format!("TrustDenied: {why}"))?;
    let spec = find(&adapter)
        .ok_or_else(|| format!("InvalidConfiguration: No debug adapter named {adapter}."))?;
    let folder = with_workspace(&state, |manager| manager.validate_path(&root))
        .map_err(|why| format!("InvalidConfiguration: {why}"))?;
    if !folder.is_dir() {
        return Err(format!("InvalidConfiguration: {root} is not a folder."));
    }
    let program = program_for(spec, python.as_deref(), &folder)?;
    let session = sessions.next.fetch_add(1, Ordering::Relaxed) + 1;
    let process = ServerProcess::spawn(
        &program,
        spec.args,
        &folder,
        Arc::new(Emitting {
            app: app.clone(),
            session,
        }),
    )
    .map_err(|why| format!("AdapterFailedToStart: {why}"))?;
    sessions
        .live
        .lock()
        .map_err(|e| e.to_string())?
        .insert(session, Arc::new(process));
    Ok(Started {
        session,
        program: program.to_string_lossy().into_owned(),
    })
}

fn live(sessions: &DapSessions, session: u32) -> Result<Arc<ServerProcess>, String> {
    sessions
        .live
        .lock()
        .map_err(|e| e.to_string())?
        .get(&session)
        .cloned()
        .ok_or_else(|| "SessionTerminated: The debug adapter has stopped.".to_string())
}

/// Sends one DAP message (the JSON body; framing is added here).
#[tauri::command(async)]
pub fn dap_send(
    sessions: State<'_, DapSessions>,
    session: u32,
    message: String,
) -> Result<(), String> {
    live(&sessions, session)?
        .send(&message)
        .map_err(|why| format!("SessionTerminated: {why}"))
}

/// Ends an adapter's process and everything it started -- the debuggee too. The renderer asks
/// the adapter to terminate and disconnect first; this is the end of that, or what happens
/// when it does not answer.
#[tauri::command(async)]
pub fn dap_stop(sessions: State<'_, DapSessions>, session: u32) -> Result<(), String> {
    if let Ok(process) = live(&sessions, session) {
        process.stop();
    }
    Ok(())
}

/// Ends every adapter: the window is closing, the page reloaded, or the workspace changed.
pub fn stop_all(sessions: &DapSessions) {
    let all: Vec<_> = match sessions.live.lock() {
        Ok(mut live) => live.drain().map(|(_, process)| process).collect(),
        Err(_) => return,
    };
    for process in all {
        process.stop();
    }
}

#[tauri::command(async)]
pub fn dap_stop_all(sessions: State<'_, DapSessions>) -> Result<(), String> {
    stop_all(&sessions);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_workspace::lsp_framing::{frame, FrameError, FrameReader};
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn only_a_listed_adapter_can_be_started() {
        assert!(find("debugpy").is_some());
        for id in ["", "python", "cmd", "debugpy; calc", "../debugpy", "node"] {
            assert!(find(id).is_none(), "{id}");
        }
        for adapter in ADAPTERS {
            assert!(!adapter.program.contains(['/', '\\', ' ']));
            for argument in adapter.args {
                assert!(!argument.is_empty() && !argument.contains(char::is_whitespace));
            }
        }
        let renderer = include_str!("../../src/services/debug/adapters.ts");
        for adapter in ADAPTERS {
            assert!(
                renderer.contains(&format!("id: \"{}\"", adapter.id)),
                "no renderer entry for {}",
                adapter.id
            );
        }
    }

    #[test]
    fn only_an_existing_python_interpreter_may_be_chosen() {
        let dir = std::env::temp_dir().join(format!("yavin-dap-python-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let python = dir.join(if cfg!(windows) {
            "python.exe"
        } else {
            "python3"
        });
        std::fs::write(&python, b"").unwrap();
        let other = dir.join(if cfg!(windows) { "calc.exe" } else { "sh" });
        std::fs::write(&other, b"").unwrap();

        assert_eq!(interpreter(python.to_str().unwrap()).unwrap(), python);
        for refused in [other.to_str().unwrap(), "python", "python.exe", "../python"] {
            let error = interpreter(refused).unwrap_err();
            assert!(
                error.starts_with("InvalidConfiguration:"),
                "{refused}: {error}"
            );
        }
        let missing = dir.join("python3.12");
        let error = interpreter(missing.to_str().unwrap()).unwrap_err();
        assert!(error.starts_with("AdapterUnavailable:"), "{error}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // --- The DAP base protocol, on the shared framing -------------------------------------------

    const INITIALIZED: &str = r#"{"seq":2,"type":"event","event":"initialized"}"#;
    const RESPONSE: &str = r#"{"seq":1,"type":"response","request_seq":1,"success":true,"command":"initialize","body":{"supportsConfigurationDoneRequest":true}}"#;

    #[test]
    fn a_dap_message_split_inside_its_header_and_its_body_comes_out_whole() {
        let bytes = frame(RESPONSE);
        // Byte by byte: every split of the header ("Content-Le|ngth") and of the body.
        let mut reader = FrameReader::default();
        let mut out = Vec::new();
        for byte in &bytes {
            out.extend(reader.push(std::slice::from_ref(byte)).unwrap());
        }
        assert_eq!(out, vec![RESPONSE.to_string()]);
        assert_eq!(reader.pending(), 0);
    }

    #[test]
    fn several_dap_messages_in_one_read_come_out_in_order_with_the_rest_held() {
        let mut bytes = frame(RESPONSE);
        bytes.extend(frame(INITIALIZED));
        let third = frame(r#"{"seq":3,"type":"event","event":"output","body":{"output":"é\n"}}"#);
        let split = third.len() - 5;
        bytes.extend(&third[..split]);
        let mut reader = FrameReader::default();
        assert_eq!(
            reader.push(&bytes).unwrap(),
            vec![RESPONSE.to_string(), INITIALIZED.to_string()]
        );
        assert!(reader.pending() > 0, "the third waits for its end");
        let rest = reader.push(&third[split..]).unwrap();
        assert_eq!(rest.len(), 1);
        assert!(rest[0].contains("é"));
    }

    #[test]
    fn a_malformed_dap_frame_is_an_error_and_an_unfinished_one_is_left_pending() {
        let mut reader = FrameReader::default();
        assert!(matches!(
            reader.push(b"Content-Type: application/json\r\n\r\n{}"),
            Err(FrameError::Malformed(_))
        ));
        let mut reader = FrameReader::default();
        assert!(matches!(
            reader.push(b"Content-Length: nine\r\n\r\n{}"),
            Err(FrameError::Malformed(_))
        ));
        // A stream that ends here ended mid-message (the host reports it as a broken session).
        let mut reader = FrameReader::default();
        assert!(reader
            .push(b"Content-Length: 40\r\n\r\n{\"seq\":1")
            .unwrap()
            .is_empty());
        assert!(reader.pending() > 0);
    }

    // --- A real adapter -------------------------------------------------------------------------

    /// debugpy, where it can be found: a Python that imports it, or the copy bundled with the
    /// VS Code Python debugger extension (put on `sys.path` by the command line, so nothing is
    /// installed for the test). `None` skips the test.
    fn debugpy() -> Option<(PathBuf, Vec<String>)> {
        let path = std::env::var_os("PATH");
        let python = std::env::var("YAVIN_TEST_PYTHON")
            .ok()
            .map(PathBuf::from)
            .or_else(|| resolve_program("py", false, Path::new("."), path.clone()))
            .or_else(|| resolve_program("python3", false, Path::new("."), path.clone()))
            .or_else(|| resolve_program("python", false, Path::new("."), path))?;
        let launcher = python
            .file_stem()
            .is_some_and(|stem| stem.eq_ignore_ascii_case("py"));
        let mut args: Vec<String> = if launcher { vec!["-3".into()] } else { vec![] };
        let libs = std::env::var("YAVIN_TEST_DEBUGPY").ok().or_else(|| {
            let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
            let extensions = PathBuf::from(home).join(".vscode").join("extensions");
            std::fs::read_dir(extensions)
                .ok()?
                .filter_map(|entry| entry.ok().map(|entry| entry.path()))
                .filter(|dir| {
                    dir.file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name.starts_with("ms-python.debugpy-"))
                })
                .map(|dir| dir.join("bundled").join("libs"))
                .find(|libs| libs.join("debugpy").is_dir())
                .map(|libs| libs.to_string_lossy().into_owned())
        });
        let prelude = libs
            .map(|libs| format!("import sys; sys.path.insert(0, {libs:?}); "))
            .unwrap_or_default();
        args.extend([
            "-c".into(),
            format!(
                "{prelude}import runpy; runpy.run_module('debugpy.adapter', run_name='__main__')"
            ),
        ]);
        // Only if it really imports.
        let probe = std::process::Command::new(&python)
            .args(&args[..args.len() - 2])
            .args(["-c", &format!("{prelude}import debugpy")])
            .output()
            .ok()?;
        probe.status.success().then_some((python, args))
    }

    struct Recorder(mpsc::Sender<Result<String, Option<String>>>);
    impl ServerEvents for Recorder {
        fn message(&self, body: String) {
            let _ = self.0.send(Ok(body));
        }
        fn log(&self, _line: String) {}
        fn exit(&self, _code: Option<i32>, error: Option<String>) {
            let _ = self.0.send(Err(error));
        }
    }

    /// The process host and its framing carry a real adapter's protocol: debugpy answers
    /// `initialize` with its capabilities and a `disconnect`, and stopping it ends it.
    #[test]
    fn a_real_debug_adapter_answers_initialize_through_the_shared_process_host() {
        let Some((python, args)) = debugpy() else {
            eprintln!("skipped: debugpy is not available");
            return;
        };
        let (sender, receiver) = mpsc::channel();
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let process = ServerProcess::spawn(
            &python,
            &args,
            &std::env::temp_dir(),
            Arc::new(Recorder(sender)),
        )
        .unwrap();
        process
            .send(r#"{"seq":1,"type":"request","command":"initialize","arguments":{"clientID":"yavin","adapterID":"debugpy","pathFormat":"path","linesStartAt1":true,"columnsStartAt1":true}}"#)
            .unwrap();
        // Generous: a real Python starting while the whole workspace suite runs in parallel can
        // take far longer than the ~3 s it takes alone (it once exceeded 30 s under that load).
        let answer = loop {
            let message = receiver
                .recv_timeout(Duration::from_secs(120))
                .expect("debugpy answers")
                .expect("debugpy stays up");
            let value: serde_json::Value = serde_json::from_str(&message).unwrap();
            if value["type"] == "response" {
                break value;
            }
        };
        assert_eq!(answer["request_seq"], 1);
        assert_eq!(answer["command"], "initialize");
        assert_eq!(answer["success"], true);
        assert_eq!(answer["body"]["supportsConfigurationDoneRequest"], true);

        process.stop();
        // The exit is reported once the output closes.
        let ended = loop {
            match receiver.recv_timeout(Duration::from_secs(15)) {
                Ok(Err(_)) => break true,
                Ok(Ok(_)) => continue,
                Err(_) => break false,
            }
        };
        assert!(ended, "stopping the adapter ends it");
    }
}
