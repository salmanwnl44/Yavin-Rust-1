//! The extension host as Yavin uses it: the real `yavin-extension-host` process, driven over
//! its framed protocol. Each test proves a boundary holds.

use ide_workspace::lsp_framing::{frame, FrameReader};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Receiver};
use std::time::Duration;

struct Host {
    child: Child,
    stdin: ChildStdin,
    messages: Receiver<Value>,
}

const WS: &str = "file://c:/work";

impl Host {
    fn start() -> Host {
        Host::start_with(json!({"memoryBytes": 16 * 1024 * 1024, "loadMs": 2000, "callMs": 500}))
    }
    fn start_with(limits: Value) -> Host {
        let mut child = Command::new(env!("CARGO_BIN_EXE_yavin-extension-host"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("the host starts");
        let stdin = child.stdin.take().unwrap();
        let mut stdout = child.stdout.take().unwrap();
        let (sender, messages) = channel();
        std::thread::spawn(move || {
            let mut reader = FrameReader::default();
            let mut buffer = vec![0u8; 65536];
            while let Ok(count) = stdout.read(&mut buffer) {
                if count == 0 {
                    break;
                }
                for text in reader.push(&buffer[..count]).unwrap_or_default() {
                    let _ = sender.send(serde_json::from_str::<Value>(&text).unwrap());
                }
            }
        });
        let mut host = Host {
            child,
            stdin,
            messages,
        };
        host.send(json!({"type": "init", "workspaceId": WS, "hostGeneration": 3, "workspaceFolder": "C:/work", "apiVersion": "2.0.0", "limits": limits}));
        assert_eq!(host.recv()["type"], "ready");
        host
    }
    fn send(&mut self, message: Value) {
        self.send_text(&message.to_string());
    }
    fn send_text(&mut self, text: &str) {
        self.stdin.write_all(&frame(text)).unwrap();
        self.stdin.flush().unwrap();
    }
    fn recv(&self) -> Value {
        self.messages
            .recv_timeout(Duration::from_secs(10))
            .expect("the host answers")
    }
    /// The next message satisfying `wanted` (others are skipped).
    fn until(&self, wanted: impl Fn(&Value) -> bool) -> Value {
        loop {
            let message = self.recv();
            if wanted(&message) {
                return message;
            }
        }
    }
    fn to(&mut self, extension: &str, mut message: Value) {
        let object = message.as_object_mut().unwrap();
        object.insert("extensionId".into(), json!(extension));
        object.insert("workspaceId".into(), json!(WS));
        object.insert("hostGeneration".into(), json!(3));
        self.send(message);
    }
    fn load(&mut self, extension: &str, code: &str) -> Value {
        self.to(
            extension,
            json!({"type": "load", "code": code, "extensionPath": "C:/ext"}),
        );
        self.until(|m| m["type"] == "loaded" || m["type"] == "error")
    }
    /// Yavin asks the extension; every request it makes meanwhile is answered `ok` with `answer`.
    fn ask(
        &mut self,
        extension: &str,
        id: &str,
        method: &str,
        params: Value,
        answer: Value,
    ) -> Value {
        self.to(
            extension,
            json!({"type": "request", "requestId": id, "method": method, "params": params}),
        );
        loop {
            let message = self.recv();
            if message["type"] == "request" {
                let request_id = message["requestId"].clone();
                self.to(extension, json!({"type": "response", "requestId": request_id, "ok": true, "result": answer}));
                continue;
            }
            if message["type"] == "response" && message["requestId"] == json!(id) {
                return message;
            }
        }
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

const GREETER: &str = r#"
module.exports.activate = function (context, yavin) {
  context.subscriptions.push(yavin.commands.registerCommand("acme.greeter.greet", function (who) {
    return "hello " + who + " from " + context.workspaceFolder;
  }));
};
"#;

#[test]
fn an_extension_is_loaded_activated_and_runs_a_command_through_the_protocol() {
    let mut host = Host::start();
    assert_eq!(host.load("acme.greeter", GREETER)["type"], "loaded");
    host.to("acme.greeter", json!({"type": "request", "requestId": "y1", "method": "activate", "params": {"globalState": {}, "configuration": {}}}));
    // Registering the command is a request to Yavin, stamped with the extension's identity.
    let registered = host.until(|m| m["type"] == "request");
    assert_eq!(registered["method"], "commands.register");
    assert_eq!(registered["params"]["id"], "acme.greeter.greet");
    assert_eq!(registered["extensionId"], "acme.greeter");
    assert_eq!(registered["workspaceId"], WS);
    assert_eq!(registered["hostGeneration"], 3);
    let request_id = registered["requestId"].clone();
    host.to(
        "acme.greeter",
        json!({"type": "response", "requestId": request_id, "ok": true, "result": null}),
    );
    let activated = host.until(|m| m["type"] == "response" && m["requestId"] == "y1");
    assert_eq!(activated["ok"], true);

    let ran = host.ask(
        "acme.greeter",
        "y2",
        "command.run",
        json!({"id": "acme.greeter.greet", "args": ["ada"]}),
        json!(null),
    );
    assert_eq!(ran["result"], "hello ada from C:/work");
}

#[test]
fn extension_code_has_no_filesystem_network_process_or_timers() {
    let mut host = Host::start();
    let probe = r#"
      module.exports.activate = function () {
        return {
          require: typeof require, fetch: typeof fetch, process: typeof process,
          std: typeof std, os: typeof os, xhr: typeof XMLHttpRequest,
          setTimeout: typeof setTimeout, send: typeof __yavin_send,
          webSocket: typeof WebSocket, importScripts: typeof importScripts,
        };
      };
    "#;
    host.load("acme.probe", probe);
    let answer = host.ask("acme.probe", "p1", "activate", json!({}), json!(null));
    for (name, value) in answer["result"].as_object().unwrap() {
        assert_eq!(
            value, "undefined",
            "{name} must not exist inside an extension"
        );
    }
}

#[test]
fn a_hung_or_greedy_extension_is_stopped_and_the_host_and_others_carry_on() {
    let mut host = Host::start();
    host.load(
        "acme.spin",
        "module.exports.activate = function () { while (true) {} };",
    );
    let hung = host.ask("acme.spin", "s1", "activate", json!({}), json!(null));
    assert_eq!(hung["ok"], false);
    assert_eq!(hung["error"]["code"], "ExtensionFailed");

    host.load("acme.hog", "module.exports.activate = function () { var a = []; while (true) a.push('x'.repeat(100000)); };");
    let hog = host.ask("acme.hog", "g1", "activate", json!({}), json!(null));
    assert_eq!(hog["ok"], false);

    // A loop at load time is stopped too.
    let looping = host.load("acme.loop", "while (true) {}");
    assert_eq!(looping["type"], "error");
    assert_eq!(looping["error"]["code"], "LoadFailed");

    // The host still serves a well-behaved extension.
    assert_eq!(host.load("acme.greeter", GREETER)["type"], "loaded");
    let answer = host.ask("acme.greeter", "a1", "activate", json!({}), json!(null));
    assert_eq!(answer["ok"], true);
}

#[test]
fn extensions_do_not_share_globals_and_cannot_forge_their_identity() {
    let mut host = Host::start();
    host.load("acme.one", "globalThis.secret = 'one'; module.exports.activate = function () { return typeof secret; };");
    host.load(
        "acme.two",
        r#"
        // Tries to impersonate another extension, and to take over the dispatch.
        globalThis.__yavin_receive = function () { throw new Error("hijacked"); };
        module.exports.activate = function (context, yavin) {
          yavin.window.showInformationMessage("hi");
          return typeof secret;
        };
        "#,
    );
    assert_eq!(
        host.ask("acme.one", "o1", "activate", json!({}), json!(null))["result"],
        "string"
    );
    host.to(
        "acme.two",
        json!({"type": "request", "requestId": "t1", "method": "activate", "params": {}}),
    );
    let message = host.until(|m| m["type"] == "request");
    // Stamped by the host: its own id, whatever the script did.
    assert_eq!(message["extensionId"], "acme.two");
    let request_id = message["requestId"].clone();
    host.to(
        "acme.two",
        json!({"type": "response", "requestId": request_id, "ok": true, "result": null}),
    );
    let answer = host.until(|m| m["type"] == "response" && m["requestId"] == "t1");
    // Its replacement of __yavin_receive changed nothing, and it cannot see acme.one's global.
    assert_eq!(answer["result"], "undefined");
}

#[test]
fn stale_malformed_unknown_and_oversized_messages_are_refused_and_the_host_lives() {
    let mut host = Host::start();
    host.load("acme.greeter", GREETER);
    // Another generation: refused.
    host.send(json!({"type": "request", "extensionId": "acme.greeter", "workspaceId": WS, "hostGeneration": 2, "requestId": "x", "method": "activate", "params": {}}));
    assert_eq!(host.recv()["error"]["code"], "StaleGeneration");
    // Another workspace: refused.
    host.send(json!({"type": "request", "extensionId": "acme.greeter", "workspaceId": "file://c:/other", "hostGeneration": 3, "requestId": "x", "method": "activate", "params": {}}));
    assert_eq!(host.recv()["error"]["code"], "StaleGeneration");
    // Not JSON, no type, an invalid extension id, an unknown type.
    for text in [
        "{not json".to_string(),
        "{}".to_string(),
        json!({"type": "load", "extensionId": "../evil", "workspaceId": WS, "hostGeneration": 3})
            .to_string(),
        json!({"type": "explode"}).to_string(),
    ] {
        host.send_text(&text);
        assert_eq!(host.recv()["error"]["code"], "MalformedMessage", "{text}");
    }
    // A request for an extension not loaded is answered, not left hanging.
    host.to(
        "acme.ghost",
        json!({"type": "request", "requestId": "g", "method": "activate", "params": {}}),
    );
    assert_eq!(host.recv()["error"]["code"], "NotLoaded");
    // An extension trying to send more than the message limit is cut short with an error.
    host.load("acme.big", "module.exports.activate = function (c, yavin) { yavin.window.showInformationMessage('x'.repeat(2 * 1024 * 1024)); };");
    host.to(
        "acme.big",
        json!({"type": "request", "requestId": "b1", "method": "activate", "params": {}}),
    );
    let too_big = host.until(|m| m["type"] == "error");
    assert_eq!(too_big["error"]["code"], "MessageTooLarge");
    // Still alive.
    assert_eq!(
        host.ask("acme.greeter", "ok", "activate", json!({}), json!(null))["ok"],
        true
    );
}

#[test]
fn deactivation_disposes_subscriptions_and_reports_failures() {
    let mut host = Host::start();
    host.load(
        "acme.tidy",
        r#"
        module.exports.activate = function (context) {
          context.subscriptions.push({ dispose: function () { throw new Error("stuck"); } });
          context.subscriptions.push({ dispose: function () {} });
        };
        module.exports.deactivate = function () {};
        "#,
    );
    host.ask("acme.tidy", "a", "activate", json!({}), json!(null));
    let answer = host.ask("acme.tidy", "d", "deactivate", json!({}), json!(null));
    assert_eq!(answer["ok"], true);
    assert_eq!(answer["result"]["disposeErrors"], json!(["stuck"]));
    host.to("acme.tidy", json!({"type": "unload"}));
    assert_eq!(
        host.until(|m| m["type"] == "unloaded")["extensionId"],
        "acme.tidy"
    );
    // Unloading frees its runtime and the host goes on: loaded again, it works.
    assert_eq!(
        host.load(
            "acme.tidy",
            "module.exports.activate = function () { return 1; };"
        )["type"],
        "loaded"
    );
    assert_eq!(
        host.ask("acme.tidy", "a2", "activate", json!({}), json!(null))["result"],
        1
    );
}

#[test]
fn shutdown_ends_the_host_cleanly() {
    let mut host = Host::start();
    host.send(json!({"type": "shutdown"}));
    let status = host.child.wait().unwrap();
    assert!(status.success());
}

/// The bundled sample, as written, in the real host: activation, a command, a view.
#[test]
fn the_sample_extension_runs_in_the_real_host() {
    let code = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../extensions/samples/hello-world/extension.js"
    ))
    .unwrap();
    let mut host = Host::start();
    assert_eq!(
        host.load("yavin-samples.hello-world", &code)["type"],
        "loaded"
    );
    let activated = host.ask(
        "yavin-samples.hello-world",
        "a",
        "activate",
        json!({"globalState": {}, "workspaceState": {}, "configuration": {"yavin-samples.hello-world.name": "Ada"}}),
        json!(null),
    );
    assert_eq!(activated["ok"], true, "{activated}");
    let greeted = host.ask(
        "yavin-samples.hello-world",
        "g",
        "command.run",
        json!({"id": "yavin-samples.hello-world.greet", "args": []}),
        json!(null),
    );
    assert_eq!(greeted["result"], "Hello, Ada!");
    let rows = host.ask(
        "yavin-samples.hello-world",
        "v",
        "view.items",
        json!({"id": "yavin-samples.hello-world.greetings"}),
        json!(null),
    );
    assert_eq!(rows["result"][0]["label"], "Hello, Ada!");
}

/// Performance budgets (IDE-08), on the real host with the sample. Budgets are for a debug build
/// on a loaded developer machine -- generous ceilings that catch regressions of an order of
/// magnitude, not micro-benchmarks. Measured values are printed (`--nocapture`).
#[test]
fn performance_stays_within_budgets() {
    use std::time::Instant;
    let ms = |since: Instant| since.elapsed().as_secs_f64() * 1000.0;
    let p95 = |mut samples: Vec<f64>| {
        samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
        samples[(samples.len() * 95 / 100).min(samples.len() - 1)]
    };
    let code = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../extensions/samples/hello-world/extension.js"
    ))
    .unwrap();
    let id = "yavin-samples.hello-world";

    let started = Instant::now();
    let mut host = Host::start();
    let startup = ms(started);

    let started = Instant::now();
    assert_eq!(host.load(id, &code)["type"], "loaded");
    let activated = host.ask(
        id,
        "a",
        "activate",
        json!({"globalState": {}, "workspaceState": {}, "configuration": {}}),
        json!(null),
    );
    assert_eq!(activated["ok"], true);
    let activation = ms(started);

    let mut run = |method: &str, params: Value, count: usize| {
        (0..count)
            .map(|n| {
                let started = Instant::now();
                let answer = host.ask(
                    id,
                    &format!("{method}{n}"),
                    method,
                    params.clone(),
                    json!(null),
                );
                assert_eq!(answer["ok"], true, "{answer}");
                ms(started)
            })
            .collect::<Vec<_>>()
    };
    let command = p95(run(
        "command.run",
        json!({"id": "yavin-samples.hello-world.describe", "args": []}),
        100,
    ));
    let view = p95(run(
        "view.items",
        json!({"id": "yavin-samples.hello-world.greetings"}),
        100,
    ));
    let provider = p95(run(
        "provider.invoke",
        json!({"providerId": "yavin-samples.hello-world#hover#1", "kind": "hover", "document": {"uri": "file:///C:/work/a.md", "languageId": "markdown"}, "position": {"line": 1, "column": 1}}),
        100,
    ));

    let started = Instant::now();
    host.send(json!({"type": "shutdown"}));
    assert!(host.child.wait().unwrap().success());
    let shutdown = ms(started);

    eprintln!(
        "extension host: startup {startup:.1} ms, sample load+activate {activation:.1} ms, \
         command p95 {command:.2} ms, view p95 {view:.2} ms, provider p95 {provider:.2} ms, shutdown {shutdown:.1} ms"
    );
    for (what, value, budget) in [
        ("startup", startup, 1000.0),
        ("load+activate", activation, 500.0),
        ("command p95", command, 50.0),
        ("view p95", view, 50.0),
        ("provider p95", provider, 50.0),
        ("shutdown", shutdown, 1000.0),
    ] {
        assert!(
            value < budget,
            "{what}: {value:.1} ms is over its {budget} ms budget"
        );
    }
}
