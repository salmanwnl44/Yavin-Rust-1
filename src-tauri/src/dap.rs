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
use ide_workspace::process::kill_tree;
use serde::Serialize;
use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

/// How long js-debug has to start listening on its loopback port before Yavin gives up.
const BRIDGE_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// An adapter Yavin knows how to start: its program and exact arguments.
struct AdapterSpec {
    /// The id the renderer's adapter list (`src/services/debug/adapters.ts`) uses.
    id: &'static str,
    label: &'static str,
    program: &'static str,
    args: &'static [&'static str],
    /// The program is a Python interpreter, which the user may choose (`debug.python`).
    python: bool,
    /// A **TCP** adapter (js-debug): `program` is `node`, and this is the workspace-relative DAP
    /// server entry it runs. The server listens on an ephemeral loopback port Yavin picks and
    /// connects to (`src-tauri`'s bridge); its DAP flows over that socket, not stdio. `None` for a
    /// stdio adapter (debugpy).
    node_entry: Option<&'static str>,
    /// What to install when it is missing.
    install: &'static str,
}

const ADAPTERS: &[AdapterSpec] = &[
    AdapterSpec {
        id: "debugpy",
        label: "Python (debugpy)",
        program: "python",
        args: &["-m", "debugpy.adapter"],
        python: true,
        node_entry: None,
        install: "pip install debugpy",
    },
    AdapterSpec {
        // JavaScript/TypeScript via vscode-js-debug's standalone DAP server (WS6). It speaks DAP
        // over TCP, so Yavin starts it and bridges the socket into the stdio DAP session.
        id: "node",
        label: "JavaScript (js-debug)",
        program: "node",
        args: &[],
        python: false,
        node_entry: Some("node_modules/@vscode/js-debug/src/dapDebugServer.js"),
        install: "npm install -D @vscode/js-debug",
    },
];

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

// --- TCP transport bridge (js-debug) ------------------------------------------------------------

/// An ephemeral loopback port: bind `127.0.0.1:0`, read the port the OS chose, release it. There
/// is a small window before the adapter binds it, which the connect loop tolerates; nothing but
/// loopback is ever used, and the renderer never supplies a port or address.
fn ephemeral_loopback_port() -> Result<u16, String> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .map_err(|e| format!("AdapterFailedToStart: no local port for the debug adapter: {e}"))?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|e| format!("AdapterFailedToStart: {e}"))
}

/// Connect to the adapter's loopback port, retrying until it is listening or the deadline passes.
fn connect_loopback(port: u16, timeout: Duration) -> Result<TcpStream, String> {
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let deadline = Instant::now() + timeout;
    loop {
        match TcpStream::connect_timeout(&address, Duration::from_millis(250)) {
            Ok(stream) => return Ok(stream),
            Err(_) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(40)),
            Err(e) => {
                return Err(format!(
                    "AdapterFailedToStart: the JavaScript debug adapter did not start listening on \
                     127.0.0.1:{port} within {}s ({e}).",
                    timeout.as_secs()
                ))
            }
        }
    }
}

/// Start a TCP (js-debug) adapter and bridge its loopback socket into the stdio DAP session. Yavin
/// picks the ephemeral port, starts `node <entry> <port> 127.0.0.1` (in the servers' Job Object,
/// so the whole tree is cleaned up), and connects. Loopback only; no external exposure; on a
/// failed connect the child is ended so nothing is left running.
fn start_tcp_node_adapter(
    node: &Path,
    entry: &Path,
    folder: &Path,
    events: Arc<dyn ServerEvents>,
) -> Result<ServerProcess, String> {
    if !entry.is_file() {
        return Err(
            "AdapterUnavailable: The JavaScript debug adapter (js-debug) is not installed. \
             Install it with `npm install -D @vscode/js-debug`."
                .to_string(),
        );
    }
    let port = ephemeral_loopback_port()?;
    let mut command = Command::new(node);
    command
        .arg(entry)
        .arg(port.to_string())
        .arg("127.0.0.1")
        .current_dir(folder)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("AdapterFailedToStart: {e}"))?;
    match connect_loopback(port, BRIDGE_CONNECT_TIMEOUT) {
        Ok(stream) => ServerProcess::from_tcp(child, stream, events),
        Err(error) => {
            kill_tree(&mut child);
            Err(error)
        }
    }
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
    let events = Arc::new(Emitting {
        app: app.clone(),
        session,
    });
    // A TCP adapter (js-debug) is started and bridged over a loopback socket; a stdio adapter
    // (debugpy) runs on the shared process host directly. Either way the result is one
    // `ServerProcess` the session owns identically.
    let process = match spec.node_entry {
        Some(entry) => start_tcp_node_adapter(&program, &folder.join(entry), &folder, events)?,
        None => ServerProcess::spawn(&program, spec.args, &folder, events)
            .map_err(|why| format!("AdapterFailedToStart: {why}"))?,
    };
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

/// Whether an adapter's **complete launch path** resolves in this workspace: the executable (a
/// Python interpreter for debugpy — the package itself is confirmed at launch; the program on
/// PATH otherwise) **and**, for a TCP adapter (js-debug), its DAP-server entry installed in the
/// workspace. Only then is its transport supported end to end.
fn adapter_available(spec: &AdapterSpec, folder: &Path, path: &Option<std::ffi::OsString>) -> bool {
    if let Some(entry) = spec.node_entry {
        // js-debug: `node` must resolve AND its server entry must be installed (the TCP bridge is
        // built in); a bare `node` without js-debug is not enough.
        return resolve_program(spec.program, false, folder, path.clone()).is_some()
            && folder.join(entry).is_file();
    }
    if spec.python {
        return ["python", "python3", "py"]
            .iter()
            .any(|name| resolve_program(name, false, folder, path.clone()).is_some());
    }
    resolve_program(spec.program, false, folder, path.clone()).is_some()
}

/// Which allow-listed adapters are **available for launch** in this workspace (WS6). The renderer
/// gates Debug Test on this, so a framework is enabled only when its whole adapter path resolves —
/// never merely because it is registered. Here it reflects the complete path: a registered-but-
/// uninstalled adapter (or an installed one whose transport dependency is missing) is left out.
#[tauri::command(async)]
pub fn dap_available_adapters(
    state: State<'_, Workspace>,
    root: String,
) -> Result<Vec<String>, String> {
    let folder = with_workspace(&state, |manager| manager.validate_path(&root))
        .unwrap_or(PathBuf::from(root));
    let path = std::env::var_os("PATH");
    Ok(ADAPTERS
        .iter()
        .filter(|spec| adapter_available(spec, &folder, &path))
        .map(|spec| spec.id.to_string())
        .collect())
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
        assert!(find("node").is_some());
        for id in ["", "python", "cmd", "debugpy; calc", "../debugpy", "lldb"] {
            assert!(find(id).is_none(), "{id}");
        }
        for adapter in ADAPTERS {
            // The program is a bare executable name; its node_entry (a path) is a fixed constant.
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
    fn adapter_availability_reflects_the_whole_launch_path_not_just_the_binary() {
        let dir = std::env::temp_dir().join(format!("yavin-dap-avail-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = std::env::var_os("PATH");
        let node = find("node").unwrap();
        // With `node` installed but js-debug absent, the node adapter is NOT available: its TCP
        // server entry (the transport dependency) is missing.
        if resolve_program("node", false, &dir, path.clone()).is_some() {
            assert!(
                !adapter_available(node, &dir, &path),
                "node without js-debug must be unavailable"
            );
            // Install the entry: now the whole path resolves.
            let entry = dir.join(node.node_entry.unwrap());
            std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
            std::fs::write(&entry, b"// fake js-debug entry").unwrap();
            assert!(
                adapter_available(node, &dir, &path),
                "node with js-debug installed is available"
            );
        } else {
            eprintln!("skipped: node is not installed");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn connect_loopback_times_out_on_a_port_nothing_listens_on() {
        // An ephemeral port we bind then release: nothing is listening, so the connect gives up.
        let port = ephemeral_loopback_port().unwrap();
        let error = connect_loopback(port, Duration::from_millis(200)).unwrap_err();
        assert!(error.starts_with("AdapterFailedToStart:"), "{error}");
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

    // --- The TCP transport bridge, against a real node DAP server (stand-in for js-debug) --------

    /// A tiny DAP server over TCP written in Node — the same transport shape as js-debug, so the
    /// bridge is exercised for real without downloading js-debug. It answers `initialize` and
    /// `disconnect`, parsing and emitting `Content-Length` frames.
    const FAKE_DAP_SERVER: &str = r#"
const net = require('net');
const port = parseInt(process.argv[2], 10);
const host = process.argv[3] || '127.0.0.1';
let seq = 10;
const server = net.createServer((socket) => {
  let buf = Buffer.alloc(0);
  const send = (obj) => {
    const b = Buffer.from(JSON.stringify(obj));
    socket.write('Content-Length: ' + b.length + '\r\n\r\n');
    socket.write(b);
  };
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const i = buf.indexOf('\r\n\r\n');
      if (i === -1) break;
      const m = /Content-Length: (\d+)/i.exec(buf.slice(0, i).toString());
      if (!m) { buf = buf.slice(i + 4); continue; }
      const len = parseInt(m[1], 10);
      if (buf.length < i + 4 + len) break;
      const req = JSON.parse(buf.slice(i + 4, i + 4 + len).toString());
      buf = buf.slice(i + 4 + len);
      if (req.command === 'initialize') {
        send({ seq: seq++, type: 'response', request_seq: req.seq, success: true, command: 'initialize', body: { supportsConfigurationDoneRequest: true } });
      } else if (req.command === 'disconnect') {
        send({ seq: seq++, type: 'response', request_seq: req.seq, success: true, command: 'disconnect' });
        socket.end();
        server.close();
      } else {
        send({ seq: seq++, type: 'response', request_seq: req.seq, success: true, command: req.command });
      }
    }
  });
});
server.listen(port, host);
"#;

    #[test]
    fn the_tcp_bridge_carries_a_real_dap_exchange_with_a_node_server() {
        let path = std::env::var_os("PATH");
        let Some(node) = resolve_program("node", false, Path::new("."), path) else {
            eprintln!("skipped: node is not installed");
            return;
        };
        let dir = std::env::temp_dir().join(format!("yavin-dap-tcp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("fake-dap-server.js");
        std::fs::write(&script, FAKE_DAP_SERVER).unwrap();

        let (sender, receiver) = mpsc::channel();
        // The real bridge: pick a loopback port, start the node server, connect, wire the socket.
        let process = start_tcp_node_adapter(&node, &script, &dir, Arc::new(Recorder(sender)))
            .expect("the bridge connects to the node DAP server");
        process
            .send(r#"{"seq":1,"type":"request","command":"initialize","arguments":{"adapterID":"pwa-node"}}"#)
            .unwrap();
        // The framed response comes back through the socket, the shared framing, and the events.
        let answer = loop {
            let message = receiver
                .recv_timeout(Duration::from_secs(30))
                .expect("the server answers over TCP")
                .expect("the server stays up");
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
        let ended = loop {
            match receiver.recv_timeout(Duration::from_secs(15)) {
                Ok(Err(_)) => break true,
                Ok(Ok(_)) => continue,
                Err(_) => break false,
            }
        };
        assert!(
            ended,
            "stopping the bridge closes the socket and ends the node process"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
