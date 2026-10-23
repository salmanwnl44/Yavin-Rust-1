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
    fn with(test: &str, wanted: &[(&str, Value, &str)]) -> Yavin {
        let scratch =
            std::env::temp_dir().join(format!("yavin-ext-e2e-{test}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&scratch);
        std::fs::create_dir_all(&scratch).unwrap();
        let samples = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("extensions")
            .join("samples");
        let extensions = Arc::new(ExtensionService::new(
            scratch.join("extensions"),
            vec![samples],
        ));
        // Each installed as a user installs one (EXT-19): a package, staged, verified and
        // committed -- so its files are bound and its trust record made. (A folder put in
        // Yavin's extensions folder by hand is adopted, never checked, and does not run.)
        for (id, extra, code) in wanted {
            let (publisher, name) = id.split_once('.').unwrap();
            let mut manifest = json!({"publisher": publisher, "name": name, "version": "1.0.0", "engines": {"yavin": "^2.0.0"}, "main": "extension.js"});
            for (key, value) in extra.as_object().unwrap() {
                manifest[key] = value.clone();
            }
            let at = scratch.join("packages").join(id);
            std::fs::create_dir_all(&at).unwrap();
            let package = crate::extension_package::tests::package(
                &at,
                &[
                    (
                        crate::extensions::MANIFEST_FILE,
                        manifest.to_string().as_bytes(),
                    ),
                    ("extension.js", code.as_bytes()),
                ],
            );
            let staged = crate::marketplace::stage(
                &extensions,
                crate::marketplace::PackageSource::File {
                    path: package.to_string_lossy().into(),
                },
                id,
                "1.0.0",
            )
            .unwrap_or_else(|e| panic!("{id} stages: {e}"));
            extensions.commit(&staged.token, id).unwrap();
            extensions.finish(&staged.token, id, true).unwrap();
        }
        let (sender, events) = channel();
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

// --- EXT-10: the real host in its sandbox -----------------------------------------------------

/// The real host runs in its sandbox -- an AppContainer, in a job -- and the sample works there.
#[cfg(windows)]
#[test]
fn the_real_host_runs_in_its_sandbox() {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::{GetTokenInformation, TokenIsAppContainer, TOKEN_QUERY};
    use windows_sys::Win32::System::JobObjects::IsProcessInJob;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    let yavin = Yavin::new("sandboxed", &[]);
    let session = yavin.start();
    yavin.handshake(session, 12001, 2000);
    let pid = yavin.sessions.process_id(session).unwrap();
    // SAFETY: handles opened here, queried into buffers of the size given, closed once.
    let (in_container, in_job) = unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        assert!(!process.is_null());
        let mut token: HANDLE = std::ptr::null_mut();
        assert!(OpenProcessToken(process, TOKEN_QUERY, &mut token) != 0);
        let (mut is, mut size) = (0u32, 0u32);
        assert!(
            GetTokenInformation(
                token,
                TokenIsAppContainer,
                &mut is as *mut _ as _,
                4,
                &mut size
            ) != 0
        );
        let mut job = 0;
        assert!(IsProcessInJob(process, std::ptr::null_mut(), &mut job) != 0);
        CloseHandle(token);
        CloseHandle(process);
        (is != 0, job != 0)
    };
    assert!(in_container, "the host's token is an AppContainer's");
    assert!(in_job, "the host is in its job");
    assert_eq!(yavin.load(session, 12001, SAMPLE)["type"], "loaded");
    yavin.ask(
        session,
        12001,
        SAMPLE,
        "a",
        "activate",
        json!({"globalState": {}, "workspaceState": {}, "configuration": {}}),
    );
    let greeted = yavin
        .ask(
            session,
            12001,
            SAMPLE,
            "g",
            "command.run",
            json!({"id": "yavin-samples.hello-world.greet", "args": []}),
        )
        .0;
    assert_eq!(greeted["result"], "Hello, world!");
}

/// The host's memory is capped as a whole (its job): each extension stays within its own
/// heap, yet together they cannot pass the process's limit -- the allocation that would is
/// refused, and the host carries on.
#[test]
fn the_hosts_memory_is_capped_as_a_whole() {
    let code = r#"var kept = [];
        module.exports.activate = function (c, yavin) {
            c.subscriptions.push(yavin.commands.registerCommand(EXT + ".grow", function () {
                var buffer = new ArrayBuffer(100 * 1024 * 1024);
                new Uint8Array(buffer).fill(1);
                kept.push(buffer);
                return "grew";
            }));
            c.subscriptions.push(yavin.commands.registerCommand(EXT + ".ok", function () { return "fine"; }));
        };"#;
    let ids = ["acme.big1", "acme.big2", "acme.big3"];
    let sources: Vec<String> = ids
        .iter()
        .map(|id| format!("var EXT = \"{id}\";\n{code}"))
        .collect();
    let extensions: Vec<(&str, &str)> = ids
        .iter()
        .zip(&sources)
        .map(|(id, source)| (*id, source.as_str()))
        .collect();
    let yavin = Yavin::new("memory", &extensions);
    let session = yavin
        .sessions
        .start_with(
            &built_host(),
            HostResources {
                memory_mb: 256,
                extension_memory_mb: 128,
                ..HostResources::default()
            },
            yavin.sink.clone(),
            yavin.authority.clone(),
        )
        .unwrap();
    yavin
        .send(session, json!({"type": "init", "workspaceId": WS, "hostGeneration": 13001, "workspaceFolder": "C:/work", "apiVersion": "2.0.0", "limits": {"memoryBytes": 128u64 << 20, "loadMs": 3000, "callMs": 5000}}))
        .unwrap();
    assert_eq!(yavin.next_message(session)["type"], "ready");
    for id in ids {
        assert_eq!(yavin.load(session, 13001, id)["type"], "loaded");
        assert_eq!(
            yavin.ask(session, 13001, id, "a", "activate", json!({})).0["ok"],
            true
        );
    }
    let grow = |id: &str| {
        yavin
            .ask(
                session,
                13001,
                id,
                "g",
                "command.run",
                json!({"id": format!("{id}.grow"), "args": []}),
            )
            .0
    };
    assert_eq!(grow("acme.big1")["result"], "grew");
    assert_eq!(grow("acme.big2")["result"], "grew");
    // A third 100 MiB would pass the host's 256 MiB: refused, though within its own heap.
    let third = grow("acme.big3");
    assert_eq!(third["ok"], false, "{third}");
    let fine = yavin
        .ask(
            session,
            13001,
            "acme.big1",
            "o",
            "command.run",
            json!({"id": "acme.big1.ok", "args": []}),
        )
        .0;
    assert_eq!(fine["result"], "fine", "the host carries on");
}

/// Hosts that keep ending on their own are not started again at once (EXT-10) -- a host
/// stopped or replaced is not one of them.
#[test]
fn a_host_that_keeps_crashing_is_not_started_again_at_once() {
    let yavin = Yavin::new("crashloop", &[]);
    for _ in 0..(MAX_CRASHES + 1) {
        let session = yavin.start();
        yavin.sessions.stop(session);
        yavin.exit_of(session);
    }
    for _ in 0..MAX_CRASHES {
        let session = yavin.start();
        yavin.handshake(session, 14001, 2000);
        kill(yavin.sessions.process_id(session).unwrap());
        yavin.exit_of(session);
    }
    let refused = yavin
        .sessions
        .start(&built_host(), yavin.sink.clone(), yavin.authority.clone())
        .unwrap_err();
    assert!(refused.starts_with("HostCrashedRepeatedly:"), "{refused}");
    assert_eq!(yavin.sessions.running_hosts(), 0);
}

/// Many starts at once: one host runs, every other is retired -- none speaks.
#[test]
fn concurrent_starts_leave_one_host_running() {
    let yavin = Yavin::new("concurrent", &[]);
    let program = built_host();
    let sessions: Vec<u32> = std::thread::scope(|scope| {
        let started: Vec<_> = (0..8)
            .map(|_| {
                let (sessions, sink, authority, program) = (
                    &yavin.sessions,
                    yavin.sink.clone(),
                    yavin.authority.clone(),
                    &program,
                );
                scope.spawn(move || sessions.start(program, sink, authority).unwrap())
            })
            .collect();
        started.into_iter().map(|h| h.join().unwrap()).collect()
    });
    assert_eq!(yavin.sessions.running_hosts(), 1);
    let init = |generation: u64| json!({"type": "init", "workspaceId": WS, "hostGeneration": generation, "workspaceFolder": "C:/work", "apiVersion": "2.0.0", "limits": {}});
    let speaking: Vec<u32> = sessions
        .iter()
        .copied()
        .filter(|&session| yavin.send(session, init(15000 + session as u64)).is_ok())
        .collect();
    assert_eq!(speaking.len(), 1, "{speaking:?} of {sessions:?}");
    assert_eq!(yavin.next_message(speaking[0])["type"], "ready");
}

// --- EXT-11: windows -----------------------------------------------------------------------------

/// One window's side: its owner and the events sent to it (and only those).
struct Window {
    owner: HostOwner,
    events: Receiver<(u32, Event)>,
    sink: Arc<Channel>,
    /// The sessions this window started: the only ones it may hear of.
    mine: Mutex<std::collections::HashSet<u32>>,
}

impl Window {
    fn new(label: &str) -> Window {
        let (sender, events) = channel();
        Window {
            owner: HostOwner {
                window: label.into(),
                page: 0,
            },
            events,
            sink: Arc::new(Channel(Mutex::new(sender))),
            mine: Mutex::new(std::collections::HashSet::new()),
        }
    }

    fn own(&self, session: u32) {
        self.mine.lock().unwrap().insert(session);
    }

    /// The next event -- which must be one of this window's own sessions'.
    fn next(&self) -> (u32, Event) {
        let (session, event) = self
            .events
            .recv_timeout(Duration::from_secs(15))
            .expect("the host answers in time");
        assert!(
            self.mine.lock().unwrap().contains(&session),
            "{} got session {session}'s event, not its own: {event:?}",
            self.owner.window
        );
        (session, event)
    }

    /// The next message of `session` (this window's other sessions' events are passed over).
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

    /// Nothing more arrived for this window.
    fn quiet(&self) {
        if let Ok((session, event)) = self.events.recv_timeout(Duration::from_millis(300)) {
            panic!("{} got {event:?} of session {session}", self.owner.window);
        }
    }

    fn exit_of(&self, session: u32) -> Option<i32> {
        loop {
            if let (s, Event::Exit(code, _)) = self.next() {
                if s == session {
                    return code;
                }
            }
        }
    }
}

impl Yavin {
    fn start_in(&self, window: &Window, workspace: Option<&str>) -> Result<u32, String> {
        let session = self.sessions.start_for(
            &window.owner,
            workspace.map(str::to_string),
            &built_host(),
            HostResources::default(),
            window.sink.clone(),
            self.authority.clone(),
        )?;
        window.own(session);
        Ok(session)
    }

    fn send_in(&self, window: &Window, session: u32, message: Value) -> Result<(), String> {
        self.sessions
            .send_as(&window.owner, session, &message.to_string())
    }

    fn to_in(
        &self,
        window: &Window,
        session: u32,
        generation: u64,
        extension: &str,
        mut message: Value,
    ) {
        let object = message.as_object_mut().unwrap();
        object.insert("extensionId".into(), json!(extension));
        object.insert("workspaceId".into(), json!(WS));
        object.insert("hostGeneration".into(), json!(generation));
        self.send_in(window, session, message).unwrap();
    }

    fn handshake_in(&self, window: &Window, session: u32, generation: u64) {
        self.send_in(window, session, json!({"type": "init", "workspaceId": WS, "hostGeneration": generation, "workspaceFolder": "C:/work", "apiVersion": "2.0.0", "limits": {}}))
            .unwrap();
        assert_eq!(window.next_message(session)["type"], "ready");
    }

    fn load_in(&self, window: &Window, session: u32, generation: u64, extension: &str) -> Value {
        self.to_in(
            window,
            session,
            generation,
            extension,
            json!({"type": "load"}),
        );
        loop {
            let message = window.next_message(session);
            if message["type"] == "loaded" || message["type"] == "error" {
                return message;
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn ask_in(
        &self,
        window: &Window,
        session: u32,
        generation: u64,
        extension: &str,
        id: &str,
        method: &str,
        params: Value,
    ) -> Value {
        self.to_in(
            window,
            session,
            generation,
            extension,
            json!({"type": "request", "requestId": id, "method": method, "params": params}),
        );
        loop {
            let message = window.next_message(session);
            if message["type"] == "request" {
                self.to_in(window, session, generation, extension, json!({"type": "response", "requestId": message["requestId"], "ok": true, "result": null}));
                continue;
            }
            if message["type"] == "response" && message["requestId"] == json!(id) {
                return message;
            }
        }
    }

    /// A window's host with the Hello World sample active in it.
    fn greeter_in(&self, window: &Window, generation: u64) -> u32 {
        let session = self.start_in(window, None).unwrap();
        self.handshake_in(window, session, generation);
        assert_eq!(
            self.load_in(window, session, generation, SAMPLE)["type"],
            "loaded"
        );
        let activated = self.ask_in(
            window,
            session,
            generation,
            SAMPLE,
            "a",
            "activate",
            json!({"globalState": {}, "workspaceState": {}, "configuration": {}}),
        );
        assert_eq!(activated["ok"], true, "{activated}");
        session
    }

    fn greet_in(&self, window: &Window, session: u32, generation: u64, id: &str) -> Value {
        self.ask_in(
            window,
            session,
            generation,
            SAMPLE,
            id,
            "command.run",
            json!({"id": "yavin-samples.hello-world.greet", "args": []}),
        )
    }
}

/// Whether `pid` runs in an AppContainer, in a job (EXT-10).
#[cfg(windows)]
fn sandboxed(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::{GetTokenInformation, TokenIsAppContainer, TOKEN_QUERY};
    use windows_sys::Win32::System::JobObjects::IsProcessInJob;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    // SAFETY: handles opened here, queried into buffers of the size given, closed once.
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return false;
        }
        let mut token: HANDLE = std::ptr::null_mut();
        let (mut is, mut size, mut job) = (0u32, 0u32, 0);
        let ok = OpenProcessToken(process, TOKEN_QUERY, &mut token) != 0
            && GetTokenInformation(
                token,
                TokenIsAppContainer,
                &mut is as *mut _ as _,
                4,
                &mut size,
            ) != 0
            && IsProcessInJob(process, std::ptr::null_mut(), &mut job) != 0;
        CloseHandle(token);
        CloseHandle(process);
        ok && is != 0 && job != 0
    }
}

/// Two windows run the same extension, each in its own host: the same command in both, each
/// answered in its own window; every event goes to its owner alone; both hosts are sandboxed
/// processes of their own (EXT-10).
#[test]
fn two_windows_run_the_same_extension_independently() {
    let yavin = Yavin::new("two-windows", &[]);
    let (a, b) = (Window::new("window-a"), Window::new("window-b"));
    let in_a = yavin.greeter_in(&a, 21_001);
    let in_b = yavin.greeter_in(&b, 22_001);
    assert_ne!(in_a, in_b);
    assert_eq!(
        yavin.sessions.running_hosts(),
        2,
        "starting B did not retire A"
    );
    for round in 0..3 {
        let id = format!("g{round}");
        assert_eq!(
            yavin.greet_in(&a, in_a, 21_001, &id)["result"],
            "Hello, world!"
        );
        assert_eq!(
            yavin.greet_in(&b, in_b, 22_001, &id)["result"],
            "Hello, world!"
        );
    }
    a.quiet();
    b.quiet();
    let (pa, pb) = (
        yavin.sessions.process_id(in_a).unwrap(),
        yavin.sessions.process_id(in_b).unwrap(),
    );
    assert_ne!(pa, pb, "a process each");
    #[cfg(windows)]
    assert!(sandboxed(pa) && sandboxed(pb), "each in its sandbox");
}

/// Two windows with different extensions: each host holds only what its window loaded -- the
/// other's extension is not loaded there, and is refused at once (not passed on).
#[test]
fn two_windows_hold_different_extensions() {
    let yavin = Yavin::new(
        "two-extensions",
        &[
            (
                "acme.one",
                r#"module.exports.activate = function (c, yavin) { c.subscriptions.push(yavin.commands.registerCommand("acme.one.who", function () { return "one"; })); };"#,
            ),
            (
                "acme.two",
                r#"module.exports.activate = function (c, yavin) { c.subscriptions.push(yavin.commands.registerCommand("acme.two.who", function () { return "two"; })); };"#,
            ),
        ],
    );
    let (a, b) = (Window::new("window-a"), Window::new("window-b"));
    let in_a = yavin.start_in(&a, None).unwrap();
    let in_b = yavin.start_in(&b, None).unwrap();
    yavin.handshake_in(&a, in_a, 23_001);
    yavin.handshake_in(&b, in_b, 24_001);
    assert_eq!(
        yavin.load_in(&a, in_a, 23_001, "acme.one")["type"],
        "loaded"
    );
    assert_eq!(
        yavin.load_in(&b, in_b, 24_001, "acme.two")["type"],
        "loaded"
    );
    assert_eq!(
        yavin.ask_in(&a, in_a, 23_001, "acme.one", "a", "activate", json!({}))["ok"],
        true
    );
    assert_eq!(
        yavin.ask_in(&b, in_b, 24_001, "acme.two", "a", "activate", json!({}))["ok"],
        true
    );
    assert_eq!(
        yavin.ask_in(
            &a,
            in_a,
            23_001,
            "acme.one",
            "w",
            "command.run",
            json!({"id": "acme.one.who", "args": []})
        )["result"],
        "one"
    );
    assert_eq!(
        yavin.ask_in(
            &b,
            in_b,
            24_001,
            "acme.two",
            "w",
            "command.run",
            json!({"id": "acme.two.who", "args": []})
        )["result"],
        "two"
    );
    // Window A asking for B's extension in its own host: not loaded there.
    let refused = yavin
        .send_in(&a, in_a, json!({"type": "request", "requestId": "x", "method": "command.run", "params": {"id": "acme.two.who", "args": []}, "extensionId": "acme.two", "workspaceId": WS, "hostGeneration": 23_001}))
        .unwrap_err();
    assert!(refused.starts_with("NotLoaded"), "{refused}");
    a.quiet();
    b.quiet();
}

/// What another window says about a host is refused natively: B cannot speak to, stop or
/// answer A's host; an earlier page of A is not A; a session that is not one is not; a stamp
/// of another generation is stale -- and A's host carries on through all of it.
#[test]
fn another_windows_or_pages_identity_is_refused() {
    let yavin = Yavin::new("forged-windows", &[]);
    let (a, b) = (Window::new("window-a"), Window::new("window-b"));
    let in_a = yavin.greeter_in(&a, 25_001);
    let in_b = yavin.greeter_in(&b, 26_001);
    let request = json!({"type": "request", "requestId": "f", "method": "command.run", "params": {"id": "yavin-samples.hello-world.greet", "args": []}, "extensionId": SAMPLE, "workspaceId": WS, "hostGeneration": 25_001});
    for forged in [
        request.clone(),
        json!({"type": "response", "requestId": "r1", "ok": true, "result": null, "extensionId": SAMPLE, "workspaceId": WS, "hostGeneration": 25_001}),
        json!({"type": "shutdown"}),
    ] {
        let refused = yavin.send_in(&b, in_a, forged).unwrap_err();
        assert!(refused.starts_with("NotOwner"), "{refused}");
    }
    let refused = yavin.sessions.stop_as(&b.owner, in_a).unwrap_err();
    assert!(refused.starts_with("NotOwner"), "{refused}");
    // A window that is not one, a session that is not one.
    let nobody = HostOwner {
        window: "window-c".into(),
        page: 0,
    };
    assert!(yavin
        .sessions
        .send_as(&nobody, in_a, "{}")
        .unwrap_err()
        .starts_with("NotOwner"));
    assert!(yavin
        .sessions
        .send_as(&a.owner, 999_999, "{}")
        .unwrap_err()
        .starts_with("HostStopped"));
    // A's own window, another generation: stale.
    let stale = json!({"type": "request", "requestId": "s", "method": "command.run", "params": {"id": "yavin-samples.hello-world.greet", "args": []}, "extensionId": SAMPLE, "workspaceId": WS, "hostGeneration": 26_001});
    assert!(yavin
        .send_in(&a, in_a, stale)
        .unwrap_err()
        .starts_with("StaleGeneration"));
    assert_eq!(
        yavin.greet_in(&a, in_a, 25_001, "ok")["result"],
        "Hello, world!"
    );
    assert_eq!(
        yavin.greet_in(&b, in_b, 26_001, "ok")["result"],
        "Hello, world!"
    );
    // A loads its page again: its earlier page's owner is no longer A, and that page's host ends.
    yavin.sessions.page_loaded("window-a");
    let _ = a.exit_of(in_a);
    let refused = yavin.send_in(&a, in_a, request).unwrap_err();
    assert!(
        refused.starts_with("NotOwner") || refused.starts_with("HostStopped"),
        "{refused}"
    );
    // A start the earlier page asked for is refused; the new page's starts.
    assert!(yavin
        .start_in(&a, None)
        .unwrap_err()
        .starts_with("NotOwner"));
    let new_a = Window {
        owner: yavin.sessions.owner_of("window-a"),
        ..Window::new("window-a")
    };
    assert_eq!(new_a.owner.page, 1);
    let again = yavin.greeter_in(&new_a, 25_002);
    assert_eq!(
        yavin.greet_in(&new_a, again, 25_002, "n")["result"],
        "Hello, world!"
    );
    assert_eq!(
        yavin.greet_in(&b, in_b, 26_001, "still")["result"],
        "Hello, world!"
    );
}

/// Closing one window ends its host -- reported once, to it -- and nothing of the other's.
#[test]
fn closing_one_window_leaves_the_other_working() {
    let yavin = Yavin::new("close-one", &[]);
    let (a, b) = (Window::new("window-a"), Window::new("window-b"));
    let in_a = yavin.greeter_in(&a, 27_001);
    let in_b = yavin.greeter_in(&b, 28_001);
    yavin.sessions.window_closed("window-a");
    let _ = a.exit_of(in_a);
    a.quiet();
    assert_eq!(yavin.sessions.running_hosts_of("window-a"), 0);
    assert_eq!(yavin.sessions.running_hosts_of("window-b"), 1);
    assert_eq!(
        yavin.greet_in(&b, in_b, 28_001, "after")["result"],
        "Hello, world!"
    );
    b.quiet();
    // Closing it again changes nothing.
    yavin.sessions.window_closed("window-a");
    assert_eq!(
        yavin.greet_in(&b, in_b, 28_001, "again")["result"],
        "Hello, world!"
    );
}

/// Restarting one window's host retires its old one -- nothing of it is heard or taken any
/// more -- and the other window's host is not touched; a crash in one is that window's alone.
#[test]
fn restarting_or_crashing_one_window_does_not_touch_the_other() {
    let yavin = Yavin::new("restart-one", &[]);
    let (a, b) = (Window::new("window-a"), Window::new("window-b"));
    let first = yavin.greeter_in(&a, 29_001);
    let in_b = yavin.greeter_in(&b, 30_001);
    let second = yavin.greeter_in(&a, 29_002);
    let refused = yavin
        .send_in(&a, first, json!({"type": "shutdown"}))
        .unwrap_err();
    assert!(
        refused.starts_with("HostRetired") || refused.starts_with("HostStopped"),
        "{refused}"
    );
    assert_eq!(
        yavin.greet_in(&a, second, 29_002, "g")["result"],
        "Hello, world!"
    );
    assert_eq!(
        yavin.greet_in(&b, in_b, 30_001, "g")["result"],
        "Hello, world!"
    );
    // A's crashes hold A's starts, not B's.
    for _ in 0..MAX_CRASHES {
        let session = yavin.start_in(&a, None).unwrap();
        yavin.handshake_in(&a, session, 29_100);
        kill(yavin.sessions.process_id(session).unwrap());
        loop {
            if let (s, Event::Exit(..)) = a.next() {
                if s == session {
                    break;
                }
            }
        }
    }
    assert!(yavin
        .start_in(&a, None)
        .unwrap_err()
        .starts_with("HostCrashedRepeatedly"));
    assert_eq!(
        yavin.greet_in(&b, in_b, 30_001, "after")["result"],
        "Hello, world!"
    );
    let c = Window::new("window-c");
    assert!(yavin.start_in(&c, None).is_ok(), "another window starts");
}

/// Starts at once: for one window, one host runs; for different windows, one each.
#[test]
fn concurrent_starts_are_one_per_window() {
    let yavin = Yavin::new("concurrent-windows", &[]);
    let (a, b) = (Window::new("window-a"), Window::new("window-b"));
    let program = built_host();
    std::thread::scope(|scope| {
        let mut started = Vec::new();
        for window in [&a, &b, &a, &b, &a, &b, &a, &b] {
            let (sessions, sink, authority, program) = (
                &yavin.sessions,
                window.sink.clone(),
                yavin.authority.clone(),
                &program,
            );
            let owner = window.owner.clone();
            started.push((
                window,
                scope.spawn(move || {
                    sessions
                        .start_for(
                            &owner,
                            None,
                            program,
                            HostResources::default(),
                            sink,
                            authority,
                        )
                        .unwrap()
                }),
            ));
        }
        for (window, handle) in started {
            window.own(handle.join().unwrap());
        }
    });
    assert_eq!(yavin.sessions.running_hosts_of("window-a"), 1);
    assert_eq!(yavin.sessions.running_hosts_of("window-b"), 1);
    assert_eq!(yavin.sessions.running_hosts(), 2);
}

/// Entering a workspace ends the entering window's hosts, and any host started in another
/// workspace than the one entered (Yavin's native workspace is one); another window's host in
/// that workspace carries on.
#[test]
fn entering_a_workspace_ends_only_what_it_must() {
    let yavin = Yavin::new("workspaces", &[]);
    let (a, b) = (Window::new("window-a"), Window::new("window-b"));
    let in_a = yavin.start_in(&a, Some("C:/w1")).unwrap();
    let in_b = yavin.start_in(&b, Some("C:/w1")).unwrap();
    yavin.handshake_in(&a, in_a, 31_001);
    yavin.handshake_in(&b, in_b, 32_001);
    // A opens the same workspace again: its host ends, B's does not.
    yavin.sessions.workspace_entered("window-a", Some("C:/w1"));
    let _ = a.exit_of(in_a);
    assert_eq!(yavin.sessions.running_hosts_of("window-b"), 1);
    assert!(yavin.send_in(&b, in_b, json!({"type": "init", "workspaceId": WS, "hostGeneration": 32_001, "apiVersion": "2.0.0"})).is_ok());
    // A moves to another workspace: B's host, in the workspace Yavin left, ends too.
    let in_a = yavin.start_in(&a, Some("C:/w1")).unwrap();
    yavin.sessions.workspace_entered("window-a", Some("C:/w2"));
    let _ = a.exit_of(in_a);
    let _ = b.exit_of(in_b);
    assert_eq!(yavin.sessions.running_hosts(), 0);
}

/// Revoking trust holds in every window at once (it is the application's); restoring it,
/// every window's host acts again. A window cannot use another's pending request either.
#[test]
fn a_revocation_holds_in_every_window_and_pending_requests_stay_with_their_window() {
    let yavin = Yavin::new("revoke-windows", &[]);
    let (a, b) = (Window::new("window-a"), Window::new("window-b"));
    let in_a = yavin.greeter_in(&a, 33_001);
    let in_b = yavin.greeter_in(&b, 34_001);
    yavin.authority.trusted.store(false, Ordering::SeqCst);
    for (window, session, generation) in [(&a, in_a, 33_001), (&b, in_b, 34_001)] {
        let refused = yavin
            .send_in(window, session, json!({"type": "request", "requestId": "r", "method": "command.run", "params": {"id": "yavin-samples.hello-world.greet", "args": []}, "extensionId": SAMPLE, "workspaceId": WS, "hostGeneration": generation}))
            .unwrap_err();
        assert!(refused.starts_with("TrustRequired"), "{refused}");
    }
    yavin.authority.trusted.store(true, Ordering::SeqCst);
    assert_eq!(
        yavin.greet_in(&a, in_a, 33_001, "back")["result"],
        "Hello, world!"
    );
    assert_eq!(
        yavin.greet_in(&b, in_b, 34_001, "back")["result"],
        "Hello, world!"
    );
}

/// Yavin exiting during a start and an active request: every host of every window ends, each
/// end reported once, and nothing starts afterwards.
#[test]
fn exiting_ends_every_window_once_and_starts_nothing_after() {
    let yavin = Yavin::new(
        "exit-windows",
        &[(
            "acme.spin",
            r#"module.exports.activate = function (c, yavin) { c.subscriptions.push(yavin.commands.registerCommand("acme.spin.spin", function () { while (true) {} })); };"#,
        )],
    );
    let (a, b) = (Window::new("window-a"), Window::new("window-b"));
    let in_a = yavin.start_in(&a, None).unwrap();
    yavin.handshake_in(&a, in_a, 35_001);
    assert_eq!(
        yavin.load_in(&a, in_a, 35_001, "acme.spin")["type"],
        "loaded"
    );
    assert_eq!(
        yavin.ask_in(&a, in_a, 35_001, "acme.spin", "a", "activate", json!({}))["ok"],
        true
    );
    // A request running in A's host...
    yavin.to_in(&a, in_a, 35_001, "acme.spin", json!({"type": "request", "requestId": "spin", "method": "command.run", "params": {"id": "acme.spin.spin", "args": []}}));
    let program = built_host();
    std::thread::scope(|scope| {
        // ...and B starting while Yavin exits.
        let starting = {
            let (sessions, sink, authority, owner, program) = (
                &yavin.sessions,
                b.sink.clone(),
                yavin.authority.clone(),
                b.owner.clone(),
                &program,
            );
            scope.spawn(move || {
                sessions.start_for(
                    &owner,
                    None,
                    program,
                    HostResources::default(),
                    sink,
                    authority,
                )
            })
        };
        yavin.sessions.stop_all();
        if let Ok(in_b) = starting.join().unwrap() {
            // It started before the exit: ended with the rest.
            b.own(in_b);
            let _ = b.exit_of(in_b);
        }
    });
    let mut ends = 0;
    while let Ok((session, event)) = a.events.recv_timeout(Duration::from_secs(5)) {
        if let Event::Exit(..) = event {
            assert_eq!(session, in_a);
            ends += 1;
        }
    }
    assert_eq!(ends, 1, "its end is reported once");
    b.quiet();
    assert_eq!(yavin.sessions.running_hosts(), 0);
    let refused = yavin.start_in(&b, None).unwrap_err();
    assert!(refused.starts_with("HostStopped"), "{refused}");
}

// --- EXT-12: dependencies in the real host ----------------------------------------------------

const BASE: &str = r#"module.exports.activate = function (c, yavin) { c.subscriptions.push(yavin.commands.registerCommand("acme.base.hello", function () { return "base"; })); };"#;
const APP: &str = r#"module.exports.activate = function (c, yavin) { c.subscriptions.push(yavin.commands.registerCommand("acme.app.hello", function () { return "app"; })); };"#;

fn with_dependency(test: &str) -> Yavin {
    Yavin::with(
        test,
        &[
            ("acme.base", json!({}), BASE),
            (
                "acme.app",
                json!({"dependencies": {"acme.base": "^1.0.0"}}),
                APP,
            ),
        ],
    )
}

/// A dependency with code loads first, in the same host: loading its dependent before it is
/// refused natively (and leaves nothing behind -- the right order then works); a dependency
/// disabled while both run holds at the dependent's next call.
#[test]
fn a_dependency_loads_first_in_the_same_host() {
    let yavin = with_dependency("ext12-order");
    let session = yavin.start();
    yavin.handshake(session, 40_001, 2000);
    let early = yavin
        .send(session, json!({"type": "load", "extensionId": "acme.app", "workspaceId": WS, "hostGeneration": 40_001}))
        .unwrap_err();
    assert!(early.starts_with("DependencyNotLoaded"), "{early}");
    assert!(early.contains("acme.base ^1.0.0"), "{early}");
    assert_eq!(yavin.load(session, 40_001, "acme.base")["type"], "loaded");
    assert_eq!(yavin.load(session, 40_001, "acme.app")["type"], "loaded");
    for id in ["acme.base", "acme.app"] {
        assert_eq!(
            yavin.ask(session, 40_001, id, "a", "activate", json!({})).0["ok"],
            true
        );
    }
    let run = |id: &str| {
        yavin.send(session, json!({"type": "request", "requestId": "r", "method": "command.run", "params": {"id": format!("{id}.hello"), "args": []}, "extensionId": id, "workspaceId": WS, "hostGeneration": 40_001}))
    };
    assert_eq!(
        yavin
            .ask(
                session,
                40_001,
                "acme.app",
                "h",
                "command.run",
                json!({"id": "acme.app.hello", "args": []})
            )
            .0["result"],
        "app"
    );
    // Its dependency disabled: the dependent's code is refused at once; the dependency's too.
    yavin.extensions.set_enabled("acme.base", false).unwrap();
    let refused = run("acme.app").unwrap_err();
    assert!(refused.starts_with("DependencyUnavailable"), "{refused}");
    assert!(run("acme.base")
        .unwrap_err()
        .starts_with("ExtensionDisabled"));
    // Enabled again: both run.
    yavin.extensions.set_enabled("acme.base", true).unwrap();
    assert_eq!(
        yavin
            .ask(
                session,
                40_001,
                "acme.app",
                "h2",
                "command.run",
                json!({"id": "acme.app.hello", "args": []})
            )
            .0["result"],
        "app"
    );
}

/// A dependency loaded in another window's host is not this window's (EXT-11): each host
/// loads what its own extensions need.
#[test]
fn a_dependency_in_another_windows_host_does_not_count() {
    let yavin = with_dependency("ext12-windows");
    let (a, b) = (Window::new("window-a"), Window::new("window-b"));
    let in_a = yavin.start_in(&a, None).unwrap();
    let in_b = yavin.start_in(&b, None).unwrap();
    yavin.handshake_in(&a, in_a, 41_001);
    yavin.handshake_in(&b, in_b, 42_001);
    assert_eq!(
        yavin.load_in(&a, in_a, 41_001, "acme.base")["type"],
        "loaded"
    );
    let refused = yavin
        .send_in(&b, in_b, json!({"type": "load", "extensionId": "acme.app", "workspaceId": WS, "hostGeneration": 42_001}))
        .unwrap_err();
    assert!(refused.starts_with("DependencyNotLoaded"), "{refused}");
    assert_eq!(
        yavin.load_in(&b, in_b, 42_001, "acme.base")["type"],
        "loaded"
    );
    assert_eq!(
        yavin.load_in(&b, in_b, 42_001, "acme.app")["type"],
        "loaded"
    );
    a.quiet();
}

// --- EXT-13: secrets through the real host -----------------------------------------------------

const KEEPER: &str = r#"module.exports.activate = function (c, yavin) {
    c.subscriptions.push(yavin.commands.registerCommand(EXT + ".keep", function (value) {
        return c.secrets.store("token", value).then(function () { return "kept"; });
    }));
    c.subscriptions.push(yavin.commands.registerCommand(EXT + ".length", function () {
        return c.secrets.get("token").then(function (value) { return value === null ? -1 : value.length; });
    }));
    c.subscriptions.push(yavin.commands.registerCommand(EXT + ".forget", function () {
        return c.secrets.delete("token");
    }));
};"#;

/// An extension keeps a secret through `context.secrets`: the native layer stores it in the
/// OS credential store (Windows: Credential Manager) and answers the host itself -- nothing the
/// window is sent ever holds the value; another extension, without the grant, is refused and the
/// window is told only that.
#[test]
fn secrets_are_kept_natively_and_never_reach_the_window() {
    let keeper = format!("var EXT = \"acme.keeper\";\n{KEEPER}");
    let other = format!("var EXT = \"acme.other\";\n{KEEPER}");
    let yavin = Yavin::with(
        "ext13-secrets",
        &[
            ("acme.keeper", permissions(&["secrets"]), keeper.as_str()),
            ("acme.other", permissions(&["secrets"]), other.as_str()),
        ],
    );
    yavin.grant("acme.keeper", &["secrets"]);
    let session = yavin.start();
    yavin.handshake(session, 43_001, 2000);
    for id in ["acme.keeper", "acme.other"] {
        assert_eq!(yavin.load(session, 43_001, id)["type"], "loaded");
        assert_eq!(
            yavin.ask(session, 43_001, id, "a", "activate", json!({})).0["ok"],
            true
        );
    }
    let value = "token-q7w3-never-in-the-window";
    let mut seen = Vec::new();
    let mut run = |id: &str, command: &str, args: Value| {
        let (answer, asked, denied) = yavin.ask_seeing(
            session,
            43_001,
            id,
            command,
            "command.run",
            json!({"id": format!("{id}.{command}"), "args": args}),
        );
        seen.push(answer.to_string());
        seen.extend(asked.iter().map(Value::to_string));
        (answer, denied)
    };
    let (kept, _) = run("acme.keeper", "keep", json!([value]));
    assert_eq!(kept["result"], "kept", "{kept}");
    let (length, _) = run("acme.keeper", "length", json!([]));
    assert_eq!(length["result"], value.len(), "{length}");
    // Without the grant: refused natively, and the window told only which method.
    let (refused, denied) = run("acme.other", "length", json!([]));
    assert_eq!(refused["ok"], false, "{refused}");
    assert!(
        denied
            .iter()
            .any(|d| d.method == "secrets.get" && d.capability.as_deref() == Some("secrets")),
        "{denied:?}"
    );
    // The keeper's own, deleted.
    let (forgot, _) = run("acme.keeper", "forget", json!([]));
    assert_eq!(forgot["result"], true);
    let (gone, _) = run("acme.keeper", "length", json!([]));
    assert_eq!(gone["result"], -1);
    // No message the window got held the value, nor a secrets request at all -- the only time
    // the value crossed to the window was in the command's own arguments, which Yavin sent.
    for text in &seen {
        assert!(!text.contains(value) || text.contains("\"args\""), "{text}");
        assert!(!text.contains("\"method\":\"secrets."), "{text}");
    }
    // Clean the real store of this test's namespace.
    let store = crate::extension_secrets::SecretStore::new(
        crate::extension_secrets::platform(),
        &yavin._scratch.0,
    );
    let _ = store.forget_extension("acme.keeper");
    let _ = store.forget_extension("acme.other");
}

// --- EXT-14: diagnostics from the real host ----------------------------------------------------

/// Refusals and a crash in one window are recorded -- with that window, its session, the
/// extension and its version -- and another window does not see them; the report the user
/// copies says what happened and holds no workspace path or payload.
#[test]
fn diagnostics_record_refusals_and_crashes_with_their_window() {
    let yavin = Yavin::with("ext14-diag", &[("acme.probe", permissions(&ALL), PROBE)]);
    let (a, b) = (Window::new("window-a"), Window::new("window-b"));
    let in_a = yavin.start_in(&a, None).unwrap();
    let in_b = yavin.start_in(&b, None).unwrap();
    yavin.handshake_in(&a, in_a, 44_001);
    yavin.handshake_in(&b, in_b, 45_001);
    assert_eq!(
        yavin.load_in(&a, in_a, 44_001, "acme.probe")["type"],
        "loaded"
    );
    assert_eq!(
        yavin.ask_in(&a, in_a, 44_001, "acme.probe", "a", "activate", json!({}))["ok"],
        true
    );
    // Nothing granted: its probe is refused, natively, several times.
    let ran = yavin.ask_in(
        &a,
        in_a,
        44_001,
        "acme.probe",
        "p",
        "command.run",
        json!({"id": "acme.probe.go", "args": []}),
    );
    assert_eq!(ran["ok"], true, "{ran}");
    let seen = yavin
        .extensions
        .diagnostics_for("window-a", Some("acme.probe"));
    let denied = seen
        .iter()
        .find(|d| d.code == "PermissionDenied")
        .unwrap_or_else(|| panic!("{seen:?}"));
    assert!(denied.refusal);
    assert_eq!(
        denied.category,
        crate::extension_diagnostics::Category::Permission
    );
    assert_eq!(denied.window.as_deref(), Some("window-a"));
    assert_eq!(denied.session, Some(in_a));
    assert_eq!(denied.version.as_deref(), Some("1.0.0"));
    assert!(denied.remedy.is_some());
    assert!(denied
        .detail
        .as_deref()
        .unwrap_or("")
        .starts_with("method "));
    // Window B sees none of window A's.
    assert!(yavin
        .extensions
        .diagnostics_for("window-b", Some("acme.probe"))
        .is_empty());
    // A crash of A's host: recorded for A, as a failure, not a refusal.
    kill(yavin.sessions.process_id(in_a).unwrap());
    let _ = a.exit_of(in_a);
    let crashed = yavin
        .extensions
        .diagnostics_for("window-a", None)
        .into_iter()
        .find(|d| d.code == "HostCrashed")
        .expect("the crash is recorded");
    assert!(!crashed.refusal);
    assert_eq!(
        crashed.correlation.as_deref(),
        Some(format!("session-{in_a}").as_str())
    );
    assert!(yavin
        .extensions
        .diagnostics_for("window-b", None)
        .iter()
        .all(|d| d.code != "HostCrashed"));
    // The report: what happened, what to do -- nothing of the workspace or a payload.
    let report = crate::extension_diagnostics::render_report(
        &yavin.extensions.diagnostics_for("window-a", None),
        "test",
    );
    assert!(
        report.contains("PermissionDenied") && report.contains("HostCrashed"),
        "{report}"
    );
    assert!(report.contains("Next:"));
    assert!(!report.to_lowercase().contains("c:/work"), "{report}");
    assert!(!report.contains("a.txt"), "{report}");
    let _ = b;
}

/// A credential store that fails: the extension is refused, the failure recorded -- and the
/// secret it tried to keep is in no record, report or diagnostics file.
#[test]
fn a_secret_store_failure_is_recorded_without_the_secret() {
    let keeper = format!("var EXT = \"acme.keeper\";\n{KEEPER}");
    let yavin = Yavin::with(
        "ext14-secret",
        &[("acme.keeper", permissions(&["secrets"]), keeper.as_str())],
    );
    yavin.extensions.use_secret_backend(std::sync::Arc::new(
        crate::extension_secrets::tests::Failing,
    ));
    yavin.grant("acme.keeper", &["secrets"]);
    let session = yavin.ready(46_001, "acme.keeper");
    let value = "q9-secret-that-must-not-be-recorded";
    let (answer, _) = yavin.ask(
        session,
        46_001,
        "acme.keeper",
        "k",
        "command.run",
        json!({"id": "acme.keeper.keep", "args": [value]}),
    );
    assert_eq!(answer["ok"], false, "{answer}");
    let seen = yavin
        .extensions
        .diagnostics_for("main", Some("acme.keeper"));
    let failed = seen
        .iter()
        .find(|d| d.code == "SecretStorageUnavailable")
        .unwrap_or_else(|| panic!("{seen:?}"));
    assert_eq!(
        failed.category,
        crate::extension_diagnostics::Category::Storage
    );
    let report = crate::extension_diagnostics::render_report(&seen, "test");
    assert!(!report.contains(value));
    let files = std::fs::read_dir(yavin._scratch.0.join("extensions").join(".diagnostics"))
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| std::fs::read_to_string(e.path()).unwrap_or_default())
        .collect::<Vec<_>>();
    assert!(!files.is_empty(), "the diagnostics are kept on disk");
    assert!(files.iter().all(|text| !text.contains(value)));
}

// --- EXT-16: a revocation while a request is in flight, through the real host -----------------

/// Asks for a document's text; returns it, or the refusal's code.
const READER: &str = r#"
module.exports.activate = function (c, yavin) {
  c.subscriptions.push(yavin.commands.registerCommand(c.extensionId + ".read", async function () {
    try { return { text: await yavin.documents.getText("file:///c:/work/a.txt") }; }
    catch (e) { return { refused: e.code || String(e) }; }
  }));
};
"#;

impl Yavin {
    /// Runs the reader's command; when its request reaches the window, `meanwhile` runs (the
    /// user acting) and then the window answers it with `text`. What the extension got.
    fn read_while(&self, session: u32, generation: u64, meanwhile: impl FnOnce()) -> Value {
        self.to(
            session,
            generation,
            "acme.reader",
            json!({"type": "request", "requestId": "rd", "method": "command.run", "params": {"id": "acme.reader.read", "args": []}}),
        );
        let mut meanwhile = Some(meanwhile);
        loop {
            match self.next() {
                (s, Event::Message(message)) if s == session => {
                    if message["type"] == "request" && message["method"] == "documents.getText" {
                        (meanwhile.take().expect("asked once"))();
                        self.to(session, generation, "acme.reader", json!({"type": "response", "requestId": message["requestId"], "ok": true, "result": "THE DOCUMENT TEXT"}));
                    } else if message["type"] == "response" && message["requestId"] == "rd" {
                        assert_eq!(message["ok"], true, "{message}");
                        return message["result"].clone();
                    }
                }
                (s, Event::Exit(code, error)) if s == session => {
                    panic!("the host ended: {code:?} {error:?}")
                }
                _ => {}
            }
        }
    }
}

/// A running extension's request, allowed and waiting for the window, when the user revokes
/// what it needed: the window's answer does not reach the extension (it is told
/// `PermissionDenied`), and its next request is refused before the window sees it. Granted
/// again, it reads again -- in the same host, without a reload.
#[test]
fn a_revocation_while_a_request_is_in_flight_withholds_the_answer() {
    let yavin = Yavin::with(
        "inflight",
        &[("acme.reader", permissions(&["documents.read"]), READER)],
    );
    yavin.grant("acme.reader", &["documents.read"]);
    let session = yavin.ready(27_001, "acme.reader");
    let allowed = yavin.read_while(session, 27_001, || {});
    assert_eq!(allowed["text"], "THE DOCUMENT TEXT", "{allowed}");
    let revoked = yavin.read_while(session, 27_001, || yavin.grant("acme.reader", &[]));
    assert_eq!(revoked["refused"], "PermissionDenied", "{revoked}");
    assert!(!revoked.to_string().contains("THE DOCUMENT TEXT"));
    // The next one never reaches the window.
    let (answer, asked, denied) = yavin.ask_seeing(
        session,
        27_001,
        "acme.reader",
        "n",
        "command.run",
        json!({"id": "acme.reader.read", "args": []}),
    );
    assert_eq!(answer["result"]["refused"], "PermissionDenied", "{answer}");
    assert!(asked.is_empty(), "the window saw it: {asked:?}");
    assert_eq!(denied[0].capability.as_deref(), Some("documents.read"));
    yavin.grant("acme.reader", &["documents.read"]);
    let again = yavin.read_while(session, 27_001, || {});
    assert_eq!(again["text"], "THE DOCUMENT TEXT", "{again}");
}

/// The Open VSX benchmark's activation stage (EXT-25): every catalogue package the native stage
/// installed that has code is installed again here, from its downloaded file, through the
/// inventory (staged, verified, committed), loaded into the real host in its AppContainer, and
/// activated -- with every capability it requests granted, in a disposable workspace whose only
/// document is a scratch text (no user data). Then each command it contributes is run once.
/// What happened is recorded, not judged: `<out>/activation.json`.
///
/// Ignored (it runs third-party code, sandboxed): after `openvsx_benchmark_tests`,
/// `YAVIN_BENCH_OUT=<its folder> cargo test open_vsx_benchmark_activation -- --ignored`.
#[test]
#[ignore = "runs downloaded VS Code extensions in the sandboxed host"]
fn open_vsx_benchmark_activation() {
    let out = PathBuf::from(std::env::var("YAVIN_BENCH_OUT").expect("the benchmark folder"));
    let native: Value =
        serde_json::from_str(&std::fs::read_to_string(out.join("native.json")).unwrap()).unwrap();
    let yavin = Yavin::new("openvsx-benchmark", &[]);
    let doc = json!({"uri": "file:///C:/work/scratch.txt", "resourceId": "r", "languageId": "plaintext", "version": 1, "source": "disk", "dirty": false});
    let text = "pear\napple\nfig";
    let mut results = Vec::new();
    let mut generation = 30_000;
    for entry in native["results"].as_array().unwrap() {
        let id = entry["id"].as_str().unwrap();
        let manifest = &entry["adapt"]["manifest"];
        if manifest.get("main").is_none() {
            continue;
        }
        let version = entry["version"].as_str().unwrap();
        let archive = out.join(id).join("package.vsix");
        let mut record = json!({"id": id, "version": version});
        let staged = crate::marketplace::stage(
            &yavin.extensions,
            crate::marketplace::PackageSource::File {
                path: archive.to_string_lossy().into(),
            },
            id,
            version,
        );
        let staged = match staged {
            Ok(staged) => staged,
            Err(error) => {
                record["install"] = json!({"ok": false, "error": error});
                results.push(record);
                continue;
            }
        };
        // A commit can meet a file another process holds a moment (os error 5): tried again,
        // and recorded.
        let mut committed = yavin.extensions.commit(&staged.token, id);
        let mut retries = 0;
        while committed.as_ref().is_err_and(|e| e.contains("os error 5")) && retries < 5 {
            retries += 1;
            std::thread::sleep(Duration::from_millis(500));
            committed = yavin.extensions.commit(&staged.token, id);
        }
        if let Err(error) = committed {
            eprintln!("{id}: commit failed: {error}");
            record["install"] = json!({"ok": false, "error": error, "retries": retries});
            yavin.extensions.abort(&staged.token);
            results.push(record);
            continue;
        }
        yavin.extensions.finish(&staged.token, id, true).unwrap();
        record["install"] = json!({"ok": true, "retries": retries});
        let requested: Vec<String> = manifest["permissions"]["request"]
            .as_array()
            .map(|l| {
                l.iter()
                    .filter_map(|c| c.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        yavin.extensions.set_grants(id, None, &requested).unwrap();
        // Its settings as the window gives them: here, the defaults.
        let mut configuration = serde_json::Map::new();
        for (key, setting) in manifest["contributes"]["configuration"]["properties"]
            .as_object()
            .into_iter()
            .flatten()
        {
            configuration.insert(key.clone(), setting["default"].clone());
        }
        generation += 1;
        let session = yavin.start();
        record["sandboxed"] = json!(yavin.sessions.process_id(session).is_some_and(sandboxed));
        yavin
            .send(session, json!({"type": "init", "workspaceId": WS, "hostGeneration": generation, "workspaceFolder": "C:/work", "apiVersion": "2.1.0", "limits": {"memoryBytes": 128 * 1024 * 1024, "loadMs": 10_000, "callMs": 3000}}))
            .unwrap();
        let ready = yavin.next_message(session);
        assert_eq!(ready["type"], "ready");
        let started = Instant::now();
        let mut seen = Seen::default();
        let loaded = yavin.load_seeing(session, generation, id, &mut seen);
        record["load"] = if loaded["type"] == "loaded" {
            json!({"ok": true, "ms": started.elapsed().as_millis() as u64})
        } else {
            json!({"ok": false, "error": loaded["error"]})
        };
        let _ = &loaded["error"]["stack"];
        if loaded["type"] == "loaded" {
            let started = Instant::now();
            let activated = yavin.drive(
                session,
                generation,
                id,
                "activate",
                json!({"globalState": {}, "workspaceState": {}, "configuration": configuration}),
                &doc,
                text,
                &mut seen,
            );
            record["activate"] = match activated {
                Some(r) if r["ok"] == json!(true) => {
                    json!({"ok": true, "ms": started.elapsed().as_millis() as u64})
                }
                Some(r) => json!({"ok": false, "error": r["error"]}),
                None => {
                    json!({"ok": false, "error": {"code": "NoAnswer", "message": "activation did not finish within 20 s"}})
                }
            };
            if record["activate"]["ok"] == json!(true) {
                let mut commands = Vec::new();
                for command in manifest["contributes"]["commands"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .take(30)
                {
                    let name = command["command"].as_str().unwrap();
                    let before = seen.edits;
                    let ran = yavin.drive(
                        session,
                        generation,
                        id,
                        "command.run",
                        json!({"id": name, "args": []}),
                        &doc,
                        text,
                        &mut seen,
                    );
                    commands.push(json!({
                        "command": name,
                        "vscode": manifest["vsix"]["runtime"]["commands"][name],
                        "ok": ran.as_ref().map(|r| r["ok"].clone()).unwrap_or(json!(false)),
                        "error": ran.as_ref().map(|r| r["error"].clone()).unwrap_or(json!({"code": "NoAnswer"})),
                        "edited": seen.edits > before,
                    }));
                }
                record["commands"] = json!(commands);
            }
        }
        record["unsupported"] = json!(seen.unsupported);
        record["requests"] = json!(seen.methods);
        record["messages"] = json!(seen.messages);
        record["exited"] = json!(seen.exited);
        yavin.sessions.stop(session);
        eprintln!(
            "{id}: load {} activate {}",
            record["load"]["ok"], record["activate"]["ok"]
        );
        results.push(record);
    }
    std::fs::write(
        out.join("activation.json"),
        serde_json::to_string_pretty(&json!({"results": results})).unwrap(),
    )
    .unwrap();
}

/// What the window saw while a benchmark extension ran.
#[derive(Default)]
struct Seen {
    unsupported: Vec<String>,
    methods: std::collections::BTreeMap<String, u64>,
    messages: Vec<String>,
    edits: u64,
    asked: u64,
    exited: bool,
}

impl Yavin {
    /// Loads a benchmark extension; a host that ends meanwhile is recorded, not a panic.
    fn load_seeing(
        &self,
        session: u32,
        generation: u64,
        extension: &str,
        seen: &mut Seen,
    ) -> Value {
        // A load refused natively (EXT-30: packages now install whose code is past what is
        // read, `extensions::read_modules`) is that extension's result, as in the application.
        let message = json!({"type": "load", "extensionId": extension, "workspaceId": WS, "hostGeneration": generation});
        if let Err(error) = self.send(session, message) {
            let code = error.split(':').next().unwrap_or("LoadFailed").to_string();
            return json!({"type": "error", "error": {"code": code, "message": error}});
        }
        let until = Instant::now() + Duration::from_secs(30);
        while Instant::now() < until {
            match self.events.recv_timeout(Duration::from_millis(500)) {
                Ok((s, Event::Exit(code, error))) if s == session => {
                    seen.exited = true;
                    return json!({"type": "error", "error": {"code": "HostEnded", "message": format!("the host ended: {code:?} {error:?}")}});
                }
                Ok((s, Event::Message(m)))
                    if s == session && (m["type"] == "loaded" || m["type"] == "error") =>
                {
                    return m
                }
                _ => {}
            }
        }
        json!({"type": "error", "error": {"code": "NoAnswer", "message": "the load did not finish within 30 s"}})
    }

    /// Asks the extension `method`; its requests are answered as a window with one scratch
    /// document would. None when it gives no answer within 20 s (or its host ended).
    #[allow(clippy::too_many_arguments)]
    fn drive(
        &self,
        session: u32,
        generation: u64,
        extension: &str,
        method: &str,
        params: Value,
        doc: &Value,
        text: &str,
        seen: &mut Seen,
    ) -> Option<Value> {
        seen.asked += 1;
        let request = format!("bench{}", seen.asked);
        self.to(
            session,
            generation,
            extension,
            json!({"type": "request", "requestId": request, "method": method, "params": params}),
        );
        let until = Instant::now() + Duration::from_secs(20);
        while Instant::now() < until {
            let Ok((s, event)) = self.events.recv_timeout(Duration::from_millis(500)) else {
                continue;
            };
            if s != session {
                continue;
            }
            match event {
                Event::Exit(..) => {
                    seen.exited = true;
                    return None;
                }
                Event::Denied(_) => {}
                Event::Message(message) => match message["type"].as_str() {
                    Some("log") => {
                        let line = message["text"].as_str().unwrap_or("");
                        if line.starts_with("UnsupportedApi:")
                            && !seen.unsupported.iter().any(|u| u == line)
                        {
                            seen.unsupported.push(line.chars().take(300).collect());
                        }
                    }
                    Some("request") => {
                        let asked = message["method"].as_str().unwrap_or("").to_string();
                        *seen.methods.entry(asked.clone()).or_default() += 1;
                        let result = match asked.as_str() {
                            "documents.all" => json!([doc]),
                            "documents.get" => doc.clone(),
                            "documents.getText" => json!(text),
                            "editor.active" => {
                                json!({"document": doc, "selection": {"startLine": 1, "startColumn": 1, "endLine": 3, "endColumn": 4}})
                            }
                            "documents.edit" => {
                                seen.edits += 1;
                                json!(true)
                            }
                            // As the application's window answers (EXT-27): it always reports
                            // its focus; here, a window in the foreground.
                            "window.state" => json!({"focused": true}),
                            "window.showMessage" => {
                                if seen.messages.len() < 20 {
                                    seen.messages.push(
                                        message["params"]["message"]
                                            .as_str()
                                            .unwrap_or("")
                                            .chars()
                                            .take(200)
                                            .collect(),
                                    );
                                }
                                Value::Null
                            }
                            _ => Value::Null,
                        };
                        self.to(session, generation, extension, json!({"type": "response", "requestId": message["requestId"], "ok": true, "result": result}));
                    }
                    Some("response") if message["requestId"] == json!(request) => {
                        return Some(message)
                    }
                    _ => {}
                },
            }
        }
        None
    }
}
