//! The real extension host, end to end through Yavin's native layer (IDE-08): the built
//! `yavin-extension-host` binary, started and spoken to by `ExtHostSessions` -- the code the
//! window's commands run -- with extension code read natively from extension folders (the
//! repository's real sample, and test extensions written to a temporary root). Nothing here is
//! a stand-in: the process, the framing, the protocol, QuickJS and `bootstrap.js` are the real
//! ones. The host binary must be built (`cargo test --workspace` builds it; alone:
//! `cargo build -p ide-plugin-host`).

use super::*;
use serde_json::json;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::time::{Duration, Instant};

const WS: &str = "file://c:/work";
const SAMPLE: &str = "yavin-samples.hello-world";

#[derive(Debug)]
enum Event {
    Message(Value),
    Exit(Option<i32>, Option<String>),
}

struct Channel(Mutex<Sender<(u32, Event)>>);

impl HostEvents for Channel {
    fn message(&self, session: u32, message: String) {
        let value = serde_json::from_str(&message).expect("the host sends JSON");
        let _ = self
            .0
            .lock()
            .unwrap()
            .send((session, Event::Message(value)));
    }
    fn exit(&self, session: u32, code: Option<i32>, error: Option<String>) {
        let _ = self
            .0
            .lock()
            .unwrap()
            .send((session, Event::Exit(code, error)));
    }
}

/// The host binary Cargo built beside this test (`target/<profile>/`).
fn built_host() -> PathBuf {
    let path = std::env::current_exe()
        .unwrap()
        .parent()
        .and_then(Path::parent)
        .unwrap()
        .join(HOST_NAME);
    assert!(
        path.is_file(),
        "{} is not built: run `cargo build -p ide-plugin-host` (or `cargo test --workspace`)",
        path.display()
    );
    path
}

/// Yavin's side of one or more hosts: the native sessions, the events, the extension roots.
struct Yavin {
    sessions: ExtHostSessions,
    events: Receiver<(u32, Event)>,
    sink: Arc<Channel>,
    roots: Vec<PathBuf>,
    _scratch: Scratch,
}

/// A temporary extension root, removed afterwards.
struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

impl Drop for Yavin {
    fn drop(&mut self) {
        self.sessions.stop_all();
    }
}

impl Yavin {
    fn new(test: &str, extensions: &[(&str, &str)]) -> Yavin {
        let scratch =
            std::env::temp_dir().join(format!("yavin-ext-e2e-{test}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&scratch);
        for (id, code) in extensions {
            let (publisher, name) = id.split_once('.').unwrap();
            let folder = scratch.join(id);
            std::fs::create_dir_all(&folder).unwrap();
            std::fs::write(
                folder.join("yavin-extension.json"),
                json!({"publisher": publisher, "name": name, "version": "1.0.0", "engines": {"yavin": "^2.0.0"}, "main": "extension.js"}).to_string(),
            )
            .unwrap();
            std::fs::write(folder.join("extension.js"), code).unwrap();
        }
        std::fs::create_dir_all(&scratch).unwrap();
        let samples = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("extensions")
            .join("samples");
        let (sender, events) = channel();
        Yavin {
            sessions: ExtHostSessions::default(),
            events,
            sink: Arc::new(Channel(Mutex::new(sender))),
            roots: vec![scratch.clone(), samples],
            _scratch: Scratch(scratch),
        }
    }

    fn start(&self) -> u32 {
        self.sessions
            .start(&built_host(), self.sink.clone())
            .expect("the real host starts")
    }

    fn send(&self, session: u32, message: Value) -> Result<(), String> {
        self.sessions
            .send(session, &message.to_string(), &self.roots)
    }

    /// `init` and its `ready`: the handshake.
    fn handshake(&self, session: u32, generation: u64, call_ms: u64) {
        self.send(session, json!({"type": "init", "workspaceId": WS, "hostGeneration": generation, "workspaceFolder": "C:/work", "apiVersion": "2.0.0", "limits": {"memoryBytes": 32 * 1024 * 1024, "loadMs": 3000, "callMs": call_ms}}))
            .unwrap();
        let ready = self.next_message(session);
        assert_eq!(ready["type"], "ready", "{ready}");
    }

    fn next(&self) -> (u32, Event) {
        self.events
            .recv_timeout(Duration::from_secs(15))
            .expect("the host answers in time")
    }

    fn next_message(&self, session: u32) -> Value {
        loop {
            match self.next() {
                (s, Event::Message(value)) if s == session => return value,
                (s, Event::Exit(code, error)) if s == session => {
                    panic!("the host ended: {code:?} {error:?}")
                }
                _ => {}
            }
        }
    }

    fn to(&self, session: u32, generation: u64, extension: &str, mut message: Value) {
        let object = message.as_object_mut().unwrap();
        object.insert("extensionId".into(), json!(extension));
        object.insert("workspaceId".into(), json!(WS));
        object.insert("hostGeneration".into(), json!(generation));
        self.send(session, message).unwrap();
    }

    /// Asks an extension; every request it makes meanwhile is answered as Yavin would for a
    /// test (ok, `null`). Returns the answer and those requests.
    fn ask(
        &self,
        session: u32,
        generation: u64,
        extension: &str,
        id: &str,
        method: &str,
        params: Value,
    ) -> (Value, Vec<Value>) {
        self.to(
            session,
            generation,
            extension,
            json!({"type": "request", "requestId": id, "method": method, "params": params}),
        );
        let mut asked = Vec::new();
        loop {
            let message = self.next_message(session);
            if message["type"] == "request" {
                self.to(session, generation, extension, json!({"type": "response", "requestId": message["requestId"], "ok": true, "result": null}));
                asked.push(message);
                continue;
            }
            if message["type"] == "response" && message["requestId"] == json!(id) {
                return (message, asked);
            }
        }
    }

    fn load(&self, session: u32, generation: u64, extension: &str) -> Value {
        self.to(
            session,
            generation,
            extension,
            json!({"type": "load", "extensionId": extension}),
        );
        loop {
            let message = self.next_message(session);
            if message["type"] == "loaded" || message["type"] == "error" {
                return message;
            }
        }
    }

    fn exit_of(&self, session: u32) -> (Option<i32>, Option<String>) {
        loop {
            if let (s, Event::Exit(code, error)) = self.next() {
                if s == session {
                    return (code, error);
                }
            }
        }
    }
}

fn kill(pid: u32) {
    #[cfg(windows)]
    let status = std::process::Command::new("taskkill")
        .args(["/F", "/PID", &pid.to_string()])
        .output()
        .unwrap()
        .status;
    #[cfg(not(windows))]
    let status = std::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .status()
        .unwrap();
    assert!(status.success(), "the host process {pid} could be ended");
}

fn running(pid: u32) -> bool {
    #[cfg(windows)]
    {
        let out = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
    }
    #[cfg(not(windows))]
    {
        Path::new(&format!("/proc/{pid}")).exists()
    }
}

/// The whole path: start, handshake, load the real Hello World sample (its code read natively
/// from its folder), activate, its command registered, run, the result back; its view and its
/// hover provider; deactivate, unload, shutdown -- and the process gone.
#[test]
fn the_real_host_runs_the_hello_world_sample_from_start_to_shutdown() {
    let yavin = Yavin::new("smoke", &[]);
    let session = yavin.start();
    let pid = yavin.sessions.process_id(session).expect("a process");
    yavin.handshake(session, 4001, 2000);

    let loaded = yavin.load(session, 4001, SAMPLE);
    assert_eq!(loaded["type"], "loaded", "{loaded}");
    assert_eq!(loaded["extensionId"], SAMPLE);
    assert_eq!(loaded["hostGeneration"], 4001);

    let (activated, asked) = yavin.ask(session, 4001, SAMPLE, "a1", "activate", json!({"globalState": {}, "workspaceState": {}, "configuration": {"yavin-samples.hello-world.name": "Ada"}}));
    assert_eq!(activated["ok"], true, "{activated}");
    let registered: Vec<_> = asked
        .iter()
        .filter(|m| m["method"] == "commands.register")
        .map(|m| m["params"]["id"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(
        registered,
        [
            "yavin-samples.hello-world.greet",
            "yavin-samples.hello-world.reset",
            "yavin-samples.hello-world.describe"
        ]
    );
    // Every request is stamped with the extension's real identity by the host.
    for request in &asked {
        assert_eq!(request["extensionId"], SAMPLE);
        assert_eq!(request["workspaceId"], WS);
        assert_eq!(request["hostGeneration"], 4001);
    }
    assert!(asked.iter().any(|m| m["method"] == "views.register"));
    assert!(asked
        .iter()
        .any(|m| m["method"] == "languages.register" && m["params"]["kind"] == "hover"));

    let (greeted, asked) = yavin.ask(
        session,
        4001,
        SAMPLE,
        "c1",
        "command.run",
        json!({"id": "yavin-samples.hello-world.greet", "args": []}),
    );
    assert_eq!(greeted["ok"], true, "{greeted}");
    assert_eq!(greeted["result"], "Hello, Ada!");
    assert!(asked.iter().any(|m| m["method"] == "storage.update"));
    assert!(asked
        .iter()
        .any(|m| m["method"] == "window.showMessage" && m["params"]["message"] == "Hello, Ada!"));

    let rows = yavin
        .ask(
            session,
            4001,
            SAMPLE,
            "v1",
            "view.items",
            json!({"id": "yavin-samples.hello-world.greetings"}),
        )
        .0;
    assert_eq!(rows["result"][0]["label"], "Hello, Ada!", "{rows}");
    let hover = yavin.ask(session, 4001, SAMPLE, "p1", "provider.invoke", json!({"providerId": "yavin-samples.hello-world#hover#1", "kind": "hover", "document": {"uri": "file:///C:/work/readme.md", "languageId": "markdown"}, "position": {"line": 3, "column": 1}})).0;
    assert_eq!(
        hover["result"]["contents"],
        "Hello from the sample (line 3 of readme.md)"
    );

    let (deactivated, asked) = yavin.ask(session, 4001, SAMPLE, "d1", "deactivate", json!({}));
    assert_eq!(deactivated["ok"], true, "{deactivated}");
    assert_eq!(deactivated["result"]["disposeErrors"], json!([]));
    assert!(asked.iter().any(|m| m["method"] == "commands.unregister"));

    yavin.to(session, 4001, SAMPLE, json!({"type": "unload"}));
    assert_eq!(yavin.next_message(session)["type"], "unloaded");

    yavin.send(session, json!({"type": "shutdown"})).unwrap();
    let (code, _) = yavin.exit_of(session);
    assert_eq!(code, Some(0), "a clean shutdown");
    assert!(yavin.sessions.process_id(session).is_none());
    assert!(!running(pid), "the host process is gone");
    assert!(yavin
        .send(session, json!({"type": "shutdown"}))
        .unwrap_err()
        .starts_with("HostStopped"));
}

#[test]
fn a_missing_host_is_reported_and_nothing_starts() {
    let error = find_host(&host_candidates(
        None,
        false,
        None,
        Some(Path::new("Z:/not-installed")),
        Path::new("Z:/src"),
    ))
    .unwrap_err();
    assert!(error.starts_with("HostUnavailable:"), "{error}");
    let yavin = Yavin::new("missing", &[]);
    let failed = yavin
        .sessions
        .start(
            Path::new("Z:/not-installed/yavin-extension-host.exe"),
            yavin.sink.clone(),
        )
        .unwrap_err();
    assert!(failed.starts_with("HostFailed:"), "{failed}");
}

/// A host killed from outside: its end is reported (not a clean exit), its session is gone, and
/// the next host -- a restart -- is a new process that works.
#[test]
fn a_crashed_host_is_reported_and_a_restarted_one_works() {
    let yavin = Yavin::new("crash", &[]);
    let first = yavin.start();
    yavin.handshake(first, 5001, 2000);
    assert_eq!(yavin.load(first, 5001, SAMPLE)["type"], "loaded");
    let pid = yavin.sessions.process_id(first).unwrap();
    kill(pid);
    let (code, _) = yavin.exit_of(first);
    assert_ne!(code, Some(0), "a crash is not a clean exit");
    assert!(yavin.sessions.process_id(first).is_none());
    assert!(yavin
        .send(first, json!({"type": "shutdown"}))
        .unwrap_err()
        .starts_with("HostStopped"));

    let second = yavin.start();
    assert_ne!(second, first, "sessions are never reused");
    assert_ne!(yavin.sessions.process_id(second), Some(pid));
    yavin.handshake(second, 5002, 2000);
    assert_eq!(yavin.load(second, 5002, SAMPLE)["type"], "loaded");
    let activated = yavin
        .ask(
            second,
            5002,
            SAMPLE,
            "a",
            "activate",
            json!({"globalState": {}, "workspaceState": {}, "configuration": {}}),
        )
        .0;
    assert_eq!(activated["ok"], true);
    let greeted = yavin
        .ask(
            second,
            5002,
            SAMPLE,
            "g",
            "command.run",
            json!({"id": "yavin-samples.hello-world.greet", "args": []}),
        )
        .0;
    assert_eq!(greeted["result"], "Hello, world!");
}

/// A broken handshake: not JSON (refused natively, never sent), messages before `init`, an
/// unknown type -- each refused, and the host still completes a proper handshake afterwards.
#[test]
fn a_malformed_handshake_is_refused_and_the_host_survives() {
    let yavin = Yavin::new("handshake", &[]);
    let session = yavin.start();
    assert!(yavin
        .sessions
        .send(session, "{not json", &yavin.roots)
        .unwrap_err()
        .starts_with("MalformedMessage"));
    yavin
        .send(session, json!({"type": "request", "requestId": "x", "method": "activate", "extensionId": SAMPLE, "workspaceId": WS, "hostGeneration": 1}))
        .unwrap();
    assert_eq!(
        yavin.next_message(session)["error"]["code"],
        "NotInitialized"
    );
    yavin.send(session, json!({"type": "teleport"})).unwrap();
    assert_eq!(
        yavin.next_message(session)["error"]["code"],
        "MalformedMessage"
    );
    yavin.send(session, json!({"type": "init"})).unwrap();
    assert_eq!(
        yavin.next_message(session)["error"]["code"],
        "MalformedMessage"
    );
    yavin.handshake(session, 6001, 2000);
    yavin.handshake_again_refused(session);
    assert_eq!(yavin.load(session, 6001, SAMPLE)["type"], "loaded");
}

impl Yavin {
    fn handshake_again_refused(&self, session: u32) {
        self.send(session, json!({"type": "init", "workspaceId": "file://c:/other", "hostGeneration": 1, "workspaceFolder": null, "apiVersion": "2.0.0"}))
            .unwrap();
        assert_eq!(
            self.next_message(session)["error"]["code"],
            "AlreadyInitialized",
            "a host's identity is set once"
        );
    }
}

/// An extension whose activation throws fails alone; the sample in the same host activates.
#[test]
fn an_activation_failure_stays_with_its_extension() {
    let yavin = Yavin::new(
        "activation",
        &[(
            "acme.broken",
            "module.exports.activate = function () { throw new Error('kaboom'); };",
        )],
    );
    let session = yavin.start();
    yavin.handshake(session, 7001, 2000);
    assert_eq!(yavin.load(session, 7001, "acme.broken")["type"], "loaded");
    let failed = yavin
        .ask(session, 7001, "acme.broken", "a", "activate", json!({}))
        .0;
    assert_eq!(failed["ok"], false);
    assert!(
        failed["error"]["message"]
            .as_str()
            .unwrap()
            .contains("kaboom"),
        "{failed}"
    );
    assert_eq!(yavin.load(session, 7001, SAMPLE)["type"], "loaded");
    let activated = yavin
        .ask(
            session,
            7001,
            SAMPLE,
            "b",
            "activate",
            json!({"globalState": {}, "workspaceState": {}, "configuration": {}}),
        )
        .0;
    assert_eq!(activated["ok"], true);
}

/// A command that never returns is stopped at the host's deadline; the host and the extension
/// answer the next call.
#[test]
fn a_hung_command_times_out_and_the_host_carries_on() {
    let yavin = Yavin::new(
        "timeout",
        &[(
            "acme.spin",
            r#"module.exports.activate = function (c, yavin) {
                c.subscriptions.push(yavin.commands.registerCommand("acme.spin.spin", function () { while (true) {} }));
                c.subscriptions.push(yavin.commands.registerCommand("acme.spin.ok", function () { return "fine"; }));
            };"#,
        )],
    );
    let session = yavin.start();
    yavin.handshake(session, 8001, 300);
    assert_eq!(yavin.load(session, 8001, "acme.spin")["type"], "loaded");
    assert_eq!(
        yavin
            .ask(session, 8001, "acme.spin", "a", "activate", json!({}))
            .0["ok"],
        true
    );
    let started = Instant::now();
    let hung = yavin
        .ask(
            session,
            8001,
            "acme.spin",
            "s",
            "command.run",
            json!({"id": "acme.spin.spin", "args": []}),
        )
        .0;
    assert_eq!(hung["ok"], false, "{hung}");
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "stopped at its deadline"
    );
    let fine = yavin
        .ask(
            session,
            8001,
            "acme.spin",
            "o",
            "command.run",
            json!({"id": "acme.spin.ok", "args": []}),
        )
        .0;
    assert_eq!(fine["result"], "fine");
}

/// Messages for another generation or workspace are refused by the real host, never delivered.
#[test]
fn stale_generation_and_foreign_workspace_messages_are_refused() {
    let yavin = Yavin::new("stale", &[]);
    let session = yavin.start();
    yavin.handshake(session, 9002, 2000);
    assert_eq!(yavin.load(session, 9002, SAMPLE)["type"], "loaded");
    yavin.to(
        session,
        9001,
        SAMPLE,
        json!({"type": "request", "requestId": "old", "method": "activate", "params": {}}),
    );
    assert_eq!(
        yavin.next_message(session)["error"]["code"],
        "StaleGeneration"
    );
    yavin
        .send(session, json!({"type": "request", "requestId": "b", "method": "activate", "params": {}, "extensionId": SAMPLE, "workspaceId": "file://c:/other", "hostGeneration": 9002}))
        .unwrap();
    assert_eq!(
        yavin.next_message(session)["error"]["code"],
        "StaleGeneration"
    );
    // The current generation is served.
    let activated = yavin
        .ask(
            session,
            9002,
            SAMPLE,
            "now",
            "activate",
            json!({"globalState": {}, "workspaceState": {}, "configuration": {}}),
        )
        .0;
    assert_eq!(activated["ok"], true);
}

/// The workspace closing (or changing) ends every host: each end is reported, nothing is left
/// running, and nothing more can be sent to them.
#[test]
fn closing_the_workspace_ends_every_host() {
    let yavin = Yavin::new("dispose", &[]);
    let sessions = [yavin.start(), yavin.start()];
    let pids: Vec<_> = sessions
        .iter()
        .map(|&s| yavin.sessions.process_id(s).unwrap())
        .collect();
    for (n, &session) in sessions.iter().enumerate() {
        yavin.handshake(session, 10_001 + n as u64, 2000);
    }
    yavin.sessions.stop_all();
    let mut ended = Vec::new();
    while ended.len() < 2 {
        if let (session, Event::Exit(..)) = yavin.next() {
            ended.push(session);
        }
    }
    ended.sort();
    assert_eq!(ended, sessions);
    for (&session, &pid) in sessions.iter().zip(&pids) {
        assert!(yavin
            .send(session, json!({"type": "shutdown"}))
            .unwrap_err()
            .starts_with("HostStopped"));
        let deadline = Instant::now() + Duration::from_secs(5);
        while running(pid) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(!running(pid), "host {pid} is gone");
    }
}

/// A load names an extension; only one discovery found is read -- never code the renderer sent.
#[test]
fn a_load_reads_only_a_discovered_extension() {
    let yavin = Yavin::new("load", &[]);
    let session = yavin.start();
    yavin.handshake(session, 11_001, 2000);
    let unknown = yavin
        .send(session, json!({"type": "load", "extensionId": "acme.ghost", "workspaceId": WS, "hostGeneration": 11_001}))
        .unwrap_err();
    assert!(unknown.starts_with("UnknownExtension"), "{unknown}");
    // Code smuggled in a load is replaced by the extension's own.
    yavin
        .send(session, json!({"type": "load", "extensionId": SAMPLE, "code": "module.exports.activate = function () { return 'smuggled'; };", "workspaceId": WS, "hostGeneration": 11_001}))
        .unwrap();
    assert_eq!(yavin.next_message(session)["type"], "loaded");
    let activated = yavin
        .ask(
            session,
            11_001,
            SAMPLE,
            "a",
            "activate",
            json!({"globalState": {}, "workspaceState": {}, "configuration": {}}),
        )
        .0;
    assert_eq!(activated["ok"], true);
    assert_ne!(activated["result"], "smuggled");
}
