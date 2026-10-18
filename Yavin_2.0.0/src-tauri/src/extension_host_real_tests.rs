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
    /// A request the native layer refused (EXT-07).
    Denied(Denied),
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
    fn denied(&self, session: u32, denied: Denied) {
        let _ = self
            .0
            .lock()
            .unwrap()
            .send((session, Event::Denied(denied)));
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

/// Yavin's side of one or more hosts: the native sessions, the events, the extension inventory.
struct Yavin {
    sessions: ExtHostSessions,
    events: Receiver<(u32, Event)>,
    sink: Arc<Channel>,
    extensions: Arc<ExtensionService>,
    /// The native authority, as the application has it (trust a switch here).
    authority: Arc<ServiceAuthority>,
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
        let with: Vec<_> = extensions
            .iter()
            .map(|(id, code)| (*id, json!({}), *code))
            .collect();
        Yavin::with(test, &with)
    }

    /// Test extensions with more in their manifests (`extra`: its permissions, EXT-07).
    fn with(test: &str, extensions: &[(&str, Value, &str)]) -> Yavin {
        let scratch =
            std::env::temp_dir().join(format!("yavin-ext-e2e-{test}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&scratch);
        for (id, extra, code) in extensions {
            let (publisher, name) = id.split_once('.').unwrap();
            let folder = scratch.join(id);
            std::fs::create_dir_all(&folder).unwrap();
            let mut manifest = json!({"publisher": publisher, "name": name, "version": "1.0.0", "engines": {"yavin": "^2.0.0"}, "main": "extension.js"});
            for (key, value) in extra.as_object().unwrap() {
                manifest[key] = value.clone();
            }
            std::fs::write(folder.join("yavin-extension.json"), manifest.to_string()).unwrap();
            std::fs::write(folder.join("extension.js"), code).unwrap();
        }
        std::fs::create_dir_all(&scratch).unwrap();
        let samples = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("extensions")
            .join("samples");
        let (sender, events) = channel();
        let extensions = Arc::new(ExtensionService::new(scratch.clone(), vec![samples]));
        Yavin {
            sessions: ExtHostSessions::default(),
            events,
            sink: Arc::new(Channel(Mutex::new(sender))),
            authority: ServiceAuthority::new(extensions.clone()),
            extensions,
            _scratch: Scratch(scratch),
        }
    }

    fn start(&self) -> u32 {
        self.sessions
            .start(&built_host(), self.sink.clone(), self.authority.clone())
            .expect("the real host starts")
    }

    fn send(&self, session: u32, message: Value) -> Result<(), String> {
        self.sessions.send(session, &message.to_string())
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
        // By image name too: once the host is gone, Windows may give its id to another process.
        let out = std::process::Command::new("tasklist")
            .args([
                "/FI",
                &format!("PID eq {pid}"),
                "/FI",
                &format!("IMAGENAME eq {HOST_NAME}"),
                "/NH",
            ])
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
    // Windows may list an exited process for a moment after its exit was reported.
    let deadline = Instant::now() + Duration::from_secs(5);
    while running(pid) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
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
            yavin.authority.clone(),
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
        .send(session, "{not json")
        .unwrap_err()
        .starts_with("MalformedMessage"));
    // A call into an extension before `init`: nothing is loaded, refused natively (EXT-08).
    assert!(yavin
        .send(session, json!({"type": "request", "requestId": "x", "method": "activate", "extensionId": SAMPLE, "workspaceId": WS, "hostGeneration": 1}))
        .unwrap_err()
        .starts_with("NotLoaded"));
    // A load before `init` reaches the host, which refuses it.
    yavin
        .send(
            session,
            json!({"type": "load", "extensionId": SAMPLE, "workspaceId": WS, "hostGeneration": 1}),
        )
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
    // Refused natively (EXT-08), against the identity of this session's `init`.
    let old = yavin
        .send(session, json!({"type": "request", "requestId": "old", "method": "activate", "params": {}, "extensionId": SAMPLE, "workspaceId": WS, "hostGeneration": 9001}))
        .unwrap_err();
    assert!(old.starts_with("StaleGeneration"), "{old}");
    let foreign = yavin
        .send(session, json!({"type": "request", "requestId": "b", "method": "activate", "params": {}, "extensionId": SAMPLE, "workspaceId": "file://c:/other", "hostGeneration": 9002}))
        .unwrap_err();
    assert!(foreign.starts_with("StaleGeneration"), "{foreign}");
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

/// A new host retires the one before it (EXT-08), and the workspace closing (or changing) ends
/// every host: each end is reported, nothing is left running, and nothing more can be sent.
#[test]
fn closing_the_workspace_ends_every_host() {
    let yavin = Yavin::new("dispose", &[]);
    let first = yavin.start();
    let first_pid = yavin.sessions.process_id(first).unwrap();
    yavin.handshake(first, 10_001, 2000);
    let second = yavin.start();
    let second_pid = yavin.sessions.process_id(second).unwrap();
    let sessions = [first, second];
    let pids = [first_pid, second_pid];
    // The first, retired by the second, ends (whatever the window did).
    let _ = yavin.exit_of(first);
    yavin.handshake(second, 10_002, 2000);
    yavin.sessions.stop_all();
    let _ = yavin.exit_of(second);
    for (&session, &pid) in sessions.iter().zip(&pids) {
        let refused = yavin
            .send(session, json!({"type": "shutdown"}))
            .unwrap_err();
        assert!(
            refused.starts_with("HostStopped") || refused.starts_with("HostRetired"),
            "{refused}"
        );
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

// --- EXT-07: the permission boundary, through the real host --------------------------------------

/// Calls every privileged API, and the mandatory ones, and returns what each answered: `ok`
/// (it reached the window: the test answers everything it sees) or the refusal's code.
const PROBE: &str = r#"
module.exports.activate = function (c, yavin) {
  c.subscriptions.push(yavin.commands.registerCommand(c.extensionId + ".go", async function () {
    const out = {};
    const attempt = async (name, run) => {
      try { await run(); out[name] = "ok"; } catch (e) { out[name] = e.code || String(e); }
    };
    await attempt("fs", () => yavin.workspace.fs.readFile("a.txt"));
    await attempt("exists", () => yavin.workspace.fs.exists("a.txt"));
    await attempt("text", () => yavin.documents.getText("file:///c:/work/a.txt"));
    await attempt("all", () => yavin.documents.all());
    await attempt("active", () => yavin.editor.activeEditor());
    await attempt("open", () => yavin.editor.openLocation("file:///c:/work/a.txt"));
    await attempt("other", () => yavin.commands.executeCommand("acme.other.secret"));
    await attempt("own", () => yavin.commands.executeCommand(c.extensionId + ".go"));
    await attempt("storage", () => yavin.storage.global.update("k", 1));
    await attempt("message", () => yavin.window.showInformationMessage("hi"));
    return out;
  }));
};
"#;

fn permissions(request: &[&str]) -> Value {
    json!({"permissions": {"version": 1, "request": request}})
}

impl Yavin {
    /// Like `ask`, also collecting what the native layer refused meanwhile.
    fn ask_seeing(
        &self,
        session: u32,
        generation: u64,
        extension: &str,
        id: &str,
        method: &str,
        params: Value,
    ) -> (Value, Vec<Value>, Vec<Denied>) {
        self.to(
            session,
            generation,
            extension,
            json!({"type": "request", "requestId": id, "method": method, "params": params}),
        );
        let (mut asked, mut denied) = (Vec::new(), Vec::new());
        loop {
            match self.next() {
                (s, Event::Denied(one)) if s == session => denied.push(one),
                (s, Event::Message(message)) if s == session => {
                    if message["type"] == "request" {
                        let from = message["extensionId"].as_str().unwrap().to_string();
                        self.to(session, generation, &from, json!({"type": "response", "requestId": message["requestId"], "ok": true, "result": null}));
                        asked.push(message);
                    } else if message["type"] == "response" && message["requestId"] == json!(id) {
                        return (message, asked, denied);
                    }
                }
                (s, Event::Exit(code, error)) if s == session => {
                    panic!("the host ended: {code:?} {error:?}")
                }
                _ => {}
            }
        }
    }

    /// A started host with `extension` loaded and activated.
    fn ready(&self, generation: u64, extension: &str) -> u32 {
        let session = self.start();
        self.handshake(session, generation, 2000);
        assert_eq!(self.load(session, generation, extension)["type"], "loaded");
        let activated = self
            .ask(
                session,
                generation,
                extension,
                "a",
                "activate",
                json!({"globalState": {}, "workspaceState": {}, "configuration": {}}),
            )
            .0;
        assert_eq!(activated["ok"], true, "{activated}");
        session
    }

    /// Runs the probe's command: what each API answered, what the window saw, what was refused.
    fn probe(
        &self,
        session: u32,
        generation: u64,
        extension: &str,
    ) -> (Value, Vec<Value>, Vec<Denied>) {
        let (answer, asked, denied) = self.ask_seeing(
            session,
            generation,
            extension,
            "p",
            "command.run",
            json!({"id": format!("{extension}.go"), "args": []}),
        );
        assert_eq!(answer["ok"], true, "{answer}");
        (answer["result"].clone(), asked, denied)
    }

    fn grant(&self, id: &str, capabilities: &[&str]) {
        let list: Vec<String> = capabilities.iter().map(|c| c.to_string()).collect();
        self.extensions.set_grants(id, None, &list).unwrap();
    }
}

const ALL: [&str; 4] = [
    "workspace.fs.read",
    "documents.read",
    "editor.control",
    "commands.execute:acme.other",
];

/// No optional grant: every privileged request is refused natively -- answered
/// `PermissionDenied` to the extension, never shown to the window -- while the mandatory ones
/// pass. A grant opens exactly its own requests; a revocation closes them for the next request,
/// in the same host.
#[test]
fn privileged_requests_need_their_grant_and_a_revocation_holds_at_once() {
    let yavin = Yavin::with("grants", &[("acme.probe", permissions(&ALL), PROBE)]);
    let session = yavin.ready(20_001, "acme.probe");

    let (out, asked, denied) = yavin.probe(session, 20_001, "acme.probe");
    for name in ["fs", "exists", "text", "all", "active", "open", "other"] {
        assert_eq!(out[name], "PermissionDenied", "{name}: {out}");
    }
    for name in ["own", "storage", "message"] {
        assert_eq!(out[name], "ok", "{name}: {out}");
    }
    let seen: Vec<_> = asked
        .iter()
        .map(|m| m["method"].as_str().unwrap())
        .collect();
    assert_eq!(
        seen,
        ["commands.execute", "storage.update", "window.showMessage"],
        "the window never saw a refused request"
    );
    let refused: std::collections::BTreeSet<_> = denied
        .iter()
        .map(|d| d.capability.clone().unwrap())
        .collect();
    assert_eq!(refused, ALL.iter().map(|c| c.to_string()).collect());
    assert!(denied
        .iter()
        .all(|d| d.extension_id == "acme.probe" && d.code == "PermissionDenied"));

    // documents.read: only the document requests open.
    yavin.grant("acme.probe", &["documents.read"]);
    let (out, ..) = yavin.probe(session, 20_001, "acme.probe");
    for name in ["text", "all", "active"] {
        assert_eq!(out[name], "ok", "{name}: {out}");
    }
    for name in ["fs", "exists", "open", "other"] {
        assert_eq!(out[name], "PermissionDenied", "{name}: {out}");
    }
    // Everything requested.
    yavin.grant("acme.probe", &ALL);
    let (out, ..) = yavin.probe(session, 20_001, "acme.probe");
    for name in ["fs", "exists", "text", "all", "active", "open", "other"] {
        assert_eq!(out[name], "ok", "{name}: {out}");
    }
    // Revoked: the very next request is refused, without a reload.
    yavin.grant("acme.probe", &["editor.control"]);
    let (out, ..) = yavin.probe(session, 20_001, "acme.probe");
    assert_eq!(out["open"], "ok");
    for name in ["fs", "exists", "text", "all", "active", "other"] {
        assert_eq!(out[name], "PermissionDenied", "{name}: {out}");
    }
}

/// What an extension's script puts in its messages cannot change who it is or what it may do:
/// the host stamps its real id, and the native check reads only the inventory. Here the script
/// replaces `JSON.stringify` to claim another extension's id, a capability list and a grant, in
/// the message and in its parameters; another extension really has every grant.
#[test]
fn a_forged_identity_or_capability_list_changes_nothing() {
    let forger = PROBE.replace(
        "module.exports.activate = function (c, yavin) {",
        r#"const real = JSON.stringify;
JSON.stringify = function (value) {
  if (value && typeof value === "object" && value.type === "request") {
    value = Object.assign({}, value, { extensionId: "acme.trusted", capabilities: ["documents.read", "workspace.fs.read"], granted: true });
    value.params = Object.assign({}, value.params || {}, { extensionId: "acme.trusted", grant: ["documents.read"] });
  }
  return real.call(JSON, value);
};
module.exports.activate = function (c, yavin) {"#,
    );
    let yavin = Yavin::with(
        "forged",
        &[
            ("acme.forger", permissions(&ALL), forger.as_str()),
            ("acme.trusted", permissions(&ALL), PROBE),
        ],
    );
    yavin.grant("acme.trusted", &ALL);
    let session = yavin.ready(21_001, "acme.forger");
    let (out, asked, denied) = yavin.probe(session, 21_001, "acme.forger");
    for name in ["fs", "exists", "text", "all", "active", "open", "other"] {
        assert_eq!(out[name], "PermissionDenied", "{name}: {out}");
    }
    assert!(!asked.is_empty());
    assert!(
        asked.iter().all(|m| m["extensionId"] == "acme.forger"),
        "the window sees only the real id: {asked:?}"
    );
    assert!(denied.iter().all(|d| d.extension_id == "acme.forger"));
    // The extension that is granted is, with the same code.
    assert_eq!(
        yavin.load(session, 21_001, "acme.trusted")["type"],
        "loaded"
    );
    let activated = yavin
        .ask(session, 21_001, "acme.trusted", "t", "activate", json!({}))
        .0;
    assert_eq!(activated["ok"], true);
    let (out, ..) = yavin.probe(session, 21_001, "acme.trusted");
    assert_eq!(out["text"], "ok", "{out}");
}

/// What the window sends cannot grant anything either: an event an extension may not have is
/// refused natively, a load that carries a capability list loads the same copy with the same
/// (inventory's) grants, and a disabled extension or an untrusted folder is refused whatever the
/// window's own state says.
#[test]
fn the_windows_state_cannot_grant_or_bypass() {
    let yavin = Yavin::with("window", &[("acme.probe", permissions(&ALL), PROBE)]);
    let session = yavin.start();
    yavin.handshake(session, 22_001, 2000);
    yavin
        .send(session, json!({"type": "load", "extensionId": "acme.probe", "workspaceId": WS, "hostGeneration": 22_001, "capabilities": ALL, "granted": ALL, "trusted": true}))
        .unwrap();
    assert_eq!(yavin.next_message(session)["type"], "loaded");
    let activated = yavin
        .ask(
            session,
            22_001,
            "acme.probe",
            "a",
            "activate",
            json!({"granted": ALL}),
        )
        .0;
    assert_eq!(activated["ok"], true);
    let (out, ..) = yavin.probe(session, 22_001, "acme.probe");
    assert_eq!(out["text"], "PermissionDenied", "{out}");

    // An event with a document, to an extension without documents.read.
    let event = json!({"type": "event", "extensionId": "acme.probe", "workspaceId": WS, "hostGeneration": 22_001, "event": "documents.open", "payload": {"uri": "file:///c:/work/secret.env"}});
    let refused = yavin.send(session, event.clone()).unwrap_err();
    assert!(refused.starts_with("PermissionDenied"), "{refused}");
    yavin.grant("acme.probe", &["documents.read"]);
    yavin.send(session, event).unwrap();
    // configuration.changed needs nothing; an event that does not exist is refused.
    yavin
        .send(session, json!({"type": "event", "extensionId": "acme.probe", "workspaceId": WS, "hostGeneration": 22_001, "event": "configuration.changed", "payload": {"values": {}}}))
        .unwrap();
    let unknown = yavin
        .send(session, json!({"type": "event", "extensionId": "acme.probe", "workspaceId": WS, "hostGeneration": 22_001, "event": "secrets.read", "payload": {}}))
        .unwrap_err();
    assert!(unknown.starts_with("InvalidRequest"), "{unknown}");

    // Disabled natively: its code is not called, its privileged requests are refused, and it
    // is not loaded again -- whatever the window believes.
    yavin.extensions.set_enabled("acme.probe", false).unwrap();
    let call = yavin
        .send(session, json!({"type": "request", "requestId": "x", "method": "command.run", "params": {"id": "acme.probe.go", "args": []}, "extensionId": "acme.probe", "workspaceId": WS, "hostGeneration": 22_001}))
        .unwrap_err();
    assert!(call.starts_with("ExtensionDisabled"), "{call}");
    let load = yavin
        .send(session, json!({"type": "load", "extensionId": "acme.probe", "workspaceId": WS, "hostGeneration": 22_001}))
        .unwrap_err();
    assert!(load.starts_with("ExtensionDisabled"), "{load}");
    // Its deactivation still goes: it lets go of what it holds.
    let (deactivated, ..) =
        yavin.ask_seeing(session, 22_001, "acme.probe", "d", "deactivate", json!({}));
    assert_eq!(deactivated["ok"], true, "{deactivated}");

    // Untrusted natively: nothing loads, nothing is called, nothing privileged passes.
    yavin.extensions.set_enabled("acme.probe", true).unwrap();
    yavin
        .authority
        .trusted
        .store(false, std::sync::atomic::Ordering::SeqCst);
    let load = yavin
        .send(session, json!({"type": "load", "extensionId": "acme.probe", "workspaceId": WS, "hostGeneration": 22_001}))
        .unwrap_err();
    assert!(load.starts_with("TrustRequired"), "{load}");
    let call = yavin
        .send(session, json!({"type": "request", "requestId": "y", "method": "command.run", "params": {"id": "acme.probe.go", "args": []}, "extensionId": "acme.probe", "workspaceId": WS, "hostGeneration": 22_001}))
        .unwrap_err();
    assert!(call.starts_with("TrustRequired"), "{call}");
}

/// Running another extension's command needs `commands.execute:<its id>` for that very
/// extension: a grant for one is not a grant for another (no confused deputy), and its own
/// commands need nothing.
#[test]
fn another_extensions_commands_need_a_grant_naming_it() {
    let caller = PROBE.replace(
        r#"await attempt("own""#,
        r#"await attempt("third", () => yavin.commands.executeCommand("acme.third.run"));
    await attempt("own""#,
    );
    let yavin = Yavin::with(
        "commands",
        &[(
            "acme.probe",
            permissions(&["commands.execute:acme.other", "commands.execute:acme.third"]),
            caller.as_str(),
        )],
    );
    yavin.grant("acme.probe", &["commands.execute:acme.other"]);
    let session = yavin.ready(23_001, "acme.probe");
    let (out, asked, denied) = yavin.probe(session, 23_001, "acme.probe");
    assert_eq!(out["other"], "ok", "{out}");
    assert_eq!(out["third"], "PermissionDenied", "{out}");
    assert_eq!(out["own"], "ok", "{out}");
    assert!(asked
        .iter()
        .any(|m| m["method"] == "commands.execute" && m["params"]["id"] == "acme.other.secret"));
    assert!(denied
        .iter()
        .any(|d| d.capability.as_deref() == Some("commands.execute:acme.third")));
}

/// A legacy manifest (no `permissions`) is granted nothing until the user allows it, and can
/// be allowed only what extensions could do before -- never another extension's commands.
#[test]
fn a_legacy_extension_is_allowed_nothing_until_allowed() {
    let yavin = Yavin::with("legacy", &[("acme.probe", json!({}), PROBE)]);
    let session = yavin.ready(24_001, "acme.probe");
    let (out, ..) = yavin.probe(session, 24_001, "acme.probe");
    for name in ["fs", "text", "open", "other"] {
        assert_eq!(out[name], "PermissionDenied", "{name}: {out}");
    }
    let refused = yavin
        .extensions
        .set_grants("acme.probe", None, &["commands.execute:acme.other".into()])
        .unwrap_err();
    assert!(refused.starts_with("NotRequested"), "{refused}");
    yavin.grant(
        "acme.probe",
        &["workspace.fs.read", "documents.read", "editor.control"],
    );
    let (out, ..) = yavin.probe(session, 24_001, "acme.probe");
    for name in ["fs", "text", "open"] {
        assert_eq!(out[name], "ok", "{name}: {out}");
    }
    assert_eq!(out["other"], "PermissionDenied");
}

/// A crash and a restart change nothing: the new host's extensions have what the inventory
/// grants, no more -- nothing of the old session is carried over.
#[test]
fn a_restarted_host_has_no_more_than_the_inventory_grants() {
    let yavin = Yavin::with("restart", &[("acme.probe", permissions(&ALL), PROBE)]);
    let first = yavin.ready(25_001, "acme.probe");
    kill(yavin.sessions.process_id(first).unwrap());
    let _ = yavin.exit_of(first);
    let second = yavin.ready(25_002, "acme.probe");
    let (out, ..) = yavin.probe(second, 25_002, "acme.probe");
    assert_eq!(out["text"], "PermissionDenied", "{out}");
    // A call into code this host never loaded (an extension named by the window only): refused
    // natively, at once (EXT-08).
    let refused = yavin
        .send(second, json!({"type": "request", "requestId": "z", "method": "command.run", "params": {"id": "acme.ghost.go"}, "extensionId": "acme.ghost", "workspaceId": WS, "hostGeneration": 25_002}))
        .unwrap_err();
    assert!(refused.starts_with("NotLoaded"), "{refused}");
}

// --- EXT-08: a retired host, through the real host -------------------------------------------------

/// Busy for a moment, then asks Yavin for everything at once -- every request class an
/// extension can make -- and logs, and answers.
const BURST: &str = r#"
module.exports.activate = function (c, yavin) {
  c.subscriptions.push(yavin.commands.registerCommand("acme.probe.burst", function () {
    const until = Date.now() + 400;
    while (Date.now() < until) {}
    yavin.commands.registerCommand("acme.probe.late", function () { return 1; });
    yavin.commands.executeCommand("acme.probe.late");
    yavin.storage.global.update("k", 1);
    yavin.window.showInformationMessage("from the old host");
    yavin.documents.getText("file:///c:/work/a.txt");
    yavin.workspace.fs.readFile("a.txt");
    yavin.editor.openLocation("file:///c:/work/a.txt");
    yavin.documents.onDidChange(function () {});
    yavin.views.registerView("acme.probe.list", { getItems: function () { return []; } });
    yavin.languages.registerHoverProvider("markdown", { provideHover: function () { return null; } });
    console.log("the old host speaks");
    return "done";
  }));
};
"#;

impl Yavin {
    /// Everything `session` made heard for `wait`: messages, refusals.
    fn heard_from(&self, session: u32, wait: Duration) -> Vec<String> {
        let deadline = Instant::now() + wait;
        let mut heard = Vec::new();
        while let Some(left) = deadline.checked_duration_since(Instant::now()) {
            match self.events.recv_timeout(left) {
                Ok((s, Event::Message(message))) if s == session => heard.push(message.to_string()),
                Ok((s, Event::Denied(denied))) if s == session => heard.push(format!("{denied:?}")),
                Ok(_) => {}
                Err(_) => break,
            }
        }
        heard
    }
}

/// A host replaced (retired) while it still runs: whatever it then says -- registrations,
/// commands, events, requests for data, logs, the answer it owes -- never reaches the window,
/// and nothing of any kind can be sent to it. Its replacement works.
#[test]
fn a_retired_host_cannot_act_through_the_bridge() {
    let yavin = Yavin::with("retired", &[("acme.probe", permissions(&ALL), BURST)]);
    yavin.grant("acme.probe", &ALL);
    let old = yavin.ready(26_001, "acme.probe");
    // Asked to do everything; retired (but left running) before it answers.
    yavin.to(old, 26_001, "acme.probe", json!({"type": "request", "requestId": "b", "method": "command.run", "params": {"id": "acme.probe.burst", "args": []}}));
    yavin.sessions.retire_but_keep_running(old);
    let heard = yavin.heard_from(old, Duration::from_millis(1500));
    assert!(heard.is_empty(), "the retired host was heard: {heard:?}");
    assert!(yavin.sessions.process_id(old).is_some(), "it still runs");
    // Nothing reaches it: no message of any kind.
    let to_old = |message: Value| {
        let mut message = message;
        let object = message.as_object_mut().unwrap();
        object.insert("workspaceId".into(), json!(WS));
        object.insert("hostGeneration".into(), json!(26_001));
        yavin.send(old, message).unwrap_err()
    };
    for message in [
        json!({"type": "init", "apiVersion": "2.0.0"}),
        json!({"type": "load", "extensionId": "acme.probe"}),
        json!({"type": "unload", "extensionId": "acme.probe"}),
        json!({"type": "request", "extensionId": "acme.probe", "requestId": "c", "method": "command.run", "params": {"id": "acme.probe.burst"}}),
        json!({"type": "request", "extensionId": "acme.probe", "requestId": "d", "method": "deactivate", "params": {}}),
        json!({"type": "response", "extensionId": "acme.probe", "requestId": "h1", "ok": true, "result": null}),
        json!({"type": "event", "extensionId": "acme.probe", "event": "documents.change", "payload": {}}),
        json!({"type": "event", "extensionId": "acme.probe", "event": "configuration.changed", "payload": {}}),
        json!({"type": "shutdown"}),
    ] {
        let refused = to_old(message.clone());
        assert!(refused.starts_with("HostRetired"), "{message}: {refused}");
    }
    // Its replacement: a new session, which also ends the old process.
    let new = yavin.ready(26_002, "acme.probe");
    let (answer, asked, _) = yavin.ask_seeing(
        new,
        26_002,
        "acme.probe",
        "n",
        "command.run",
        json!({"id": "acme.probe.burst", "args": []}),
    );
    assert_eq!(answer["result"], "done", "{answer}");
    assert!(asked.iter().all(|m| m["hostGeneration"] == 26_002));
    // Starting it ended the old process.
    let deadline = Instant::now() + Duration::from_secs(10);
    while yavin.sessions.process_id(old).is_some() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        yavin.sessions.process_id(old).is_none(),
        "the retired host ended"
    );
}

/// What a host says must be its own session's: a message stamped for another generation or
/// workspace, an answer or log of an extension it does not hold, an `unloaded` nobody asked for
/// -- each is dropped natively, not passed on.
#[test]
fn only_this_sessions_own_messages_are_passed_on() {
    let yavin = Yavin::new("stamps", &[]);
    let session = yavin.start();
    yavin.handshake(session, 27_001, 2000);
    assert_eq!(yavin.load(session, 27_001, SAMPLE)["type"], "loaded");
    let host = yavin.sessions.live(session).unwrap();
    let screen = |message: Value| host.shared.screen(&message.to_string());
    for message in [
        json!({"type": "response", "extensionId": SAMPLE, "workspaceId": WS, "hostGeneration": 27_000, "requestId": "y1", "ok": true}),
        json!({"type": "response", "extensionId": SAMPLE, "workspaceId": "file://c:/other", "hostGeneration": 27_001, "requestId": "y1", "ok": true}),
        json!({"type": "response", "extensionId": "acme.ghost", "workspaceId": WS, "hostGeneration": 27_001, "requestId": "y1", "ok": true}),
        json!({"type": "log", "extensionId": "acme.ghost", "workspaceId": WS, "hostGeneration": 27_001, "level": "info", "text": "x"}),
        json!({"type": "unloaded", "extensionId": SAMPLE, "workspaceId": WS, "hostGeneration": 27_001}),
        json!({"type": "loaded", "extensionId": "acme.ghost", "workspaceId": WS, "hostGeneration": 27_001}),
        json!({"type": "response", "requestId": "y1", "ok": true}),
    ] {
        assert_eq!(screen(message.clone()), Screened::Drop, "{message}");
    }
    let own = json!({"type": "response", "extensionId": SAMPLE, "workspaceId": WS, "hostGeneration": 27_001, "requestId": "y1", "ok": true});
    assert_eq!(screen(own), Screened::Pass);
    // An unload asked for: its answer is passed on, once.
    yavin.to(session, 27_001, SAMPLE, json!({"type": "unload"}));
    assert_eq!(yavin.next_message(session)["type"], "unloaded");
    assert_eq!(
        screen(
            json!({"type": "unloaded", "extensionId": SAMPLE, "workspaceId": WS, "hostGeneration": 27_001})
        ),
        Screened::Drop
    );
}
