//! EXT-32: an extension's workers in the real extension host (QuickJS in its own process, the
//! real bootstrap, layer and `worker.js`): messages both ways, timers, `close` and `terminate`;
//! every bound; scripts that are not the package's; a script that throws; a worker that runs
//! forever, ended while its extension stays responsive; what a worker cannot reach; and its end
//! with its extension.
mod common;

use common::Host;
use serde_json::{json, Value};

const MAIN: &str = "extension/out/main.js";

/// The extension: a command that runs a step (`vscode`, `T` kept between steps) and returns its
/// value as JSON.
const CODE: &str = r#"
const vscode = require("vscode");
globalThis.T = {};
exports.activate = function (context) {
  T.context = context;
  T.at = (path) => vscode.Uri.joinPath(context.extensionUri, path).toString();
  /** A worker's next message (or its error), as a promise. */
  T.next = (w) => new Promise((resolve) => {
    w.onmessage = (e) => resolve({ data: e.data });
    w.onerror = (e) => resolve({ error: e.message });
  });
  context.subscriptions.push(vscode.commands.registerCommand("probe.run", async (step) => {
    const value = await new Function("vscode", "T", "return (async () => {" + step + "})()")(vscode, T);
    return value === undefined ? null : JSON.parse(JSON.stringify(value));
  }));
};
"#;

/// The package's worker scripts.
const ECHO: &str = r#"
let count = 0;
self.onmessage = (e) => {
  count++;
  if (e.data && e.data.later) setTimeout(() => postMessage({ later: e.data.later, count }), 5);
  else if (e.data === "close") close();
  else postMessage({ echo: e.data, count, name: self.name });
};
addEventListener("message", (e) => { if (e.data === "twice") postMessage("second listener"); });
"#;
const PROBE: &str = r#"
const has = (name) => typeof globalThis[name];
const report = {
  natives: Object.getOwnPropertyNames(globalThis).filter((n) => n.startsWith("__yavin")),
  require: has("require"), process: has("process"), Worker: has("Worker"), XMLHttpRequest: has("XMLHttpRequest"),
  WebAssembly: has("WebAssembly"), setTimeout: has("setTimeout"), TextEncoder: has("TextEncoder"), URL: has("URL"),
  crypto: typeof crypto.getRandomValues, location: location.href,
};
let importScriptsError = "";
try { importScripts("x.js"); } catch (e) { importScriptsError = e.message; }
report.importScripts = importScriptsError;
fetch("https://example.com/").then(() => { report.fetch = "ALLOWED"; postMessage(report); }, (e) => { report.fetch = e.message; postMessage(report); });
"#;
const BIG: &str = r#"
self.onmessage = (e) => {
  try { postMessage("x".repeat(4 * 1024 * 1024 + 1)); } catch (error) { postMessage({ refused: error.message }); }
  try { postMessage(() => 1); } catch (error) { postMessage({ notJson: error.name }); }
};
"#;
const FOREVER: &str = r#"
self.onmessage = (e) => { if (e.data === "spin") for (;;) {} else postMessage("still here"); };
"#;
const THROWS: &str = r#"
self.onmessage = () => { throw new Error("listener broke"); };
throw new Error("top level broke");
"#;
const TICKS: &str = r#"
setInterval(() => console.log("tick from the worker"), 20);
"#;
const HUNGRY: &str = r#"
self.onmessage = () => { const keep = []; for (;;) keep.push(new Array(100000).fill(1)); };
"#;

struct Ext {
    host: Host,
    id: &'static str,
    next: u32,
    logs: Vec<String>,
}

impl Ext {
    fn start(id: &'static str, host: Host) -> Ext {
        let mut host = host;
        host.to(
            id,
            json!({"type": "load", "code": CODE, "extensionPath": format!("C:/ext/{id}"), "main": MAIN,
                "modules": {
                    "extension/package.json": r#"{"publisher": "Acme", "name": "work", "version": "1.0.0"}"#,
                    "extension/w/echo.js": ECHO, "extension/w/probe.js": PROBE, "extension/w/big.js": BIG,
                    "extension/w/forever.js": FOREVER, "extension/w/throws.js": THROWS,
                    "extension/w/ticks.js": TICKS, "extension/w/hungry.js": HUNGRY,
                    "extension/w/data.json": "{}",
                },
                "vscode": {"api": "vscode", "level": "1.90.0", "entry": "main", "commands": {"run-0001": "probe.run"}, "settings": {}, "views": {}, "defaults": {}}}),
        );
        let loaded = host.until(|m| m["type"] == "loaded" || m["type"] == "error");
        assert_eq!(loaded["type"], "loaded", "{loaded}");
        let mut ext = Ext {
            host,
            id,
            next: 1,
            logs: Vec::new(),
        };
        let activated = ext.request("activate", json!({}));
        assert_eq!(activated["ok"], true, "{activated}");
        ext
    }
    /** Loads and activates another extension, `id`, in the same host; its steps run from then on. */
    fn also(self, id: &'static str) -> Ext {
        Ext::start(id, self.host)
    }
    fn request(&mut self, method: &str, params: Value) -> Value {
        let request = format!("r{}", self.next);
        self.next += 1;
        self.host.to(
            self.id,
            json!({"type": "request", "requestId": request, "method": method, "params": params}),
        );
        loop {
            let message = self.host.recv();
            if message["extensionId"] != json!(self.id) {
                continue;
            }
            match message["type"].as_str() {
                Some("request") => {
                    let result = match message["method"].as_str() {
                        Some("window.state") => json!({"focused": true}),
                        _ => Value::Null,
                    };
                    self.host.to(self.id, json!({"type": "response", "requestId": message["requestId"], "ok": true, "result": result}));
                }
                Some("log") => self
                    .logs
                    .push(message["text"].as_str().unwrap_or("").to_string()),
                Some("response") if message["requestId"] == json!(request) => return message,
                _ => {}
            }
        }
    }
    fn step(&mut self, code: &str) -> Value {
        let response = self.request("command.run", json!({"id": "run-0001", "args": [code]}));
        assert_eq!(response["ok"], true, "the step failed: {response}\n{code}");
        response["result"].clone()
    }
}

fn host() -> Host {
    Host::start_with(json!({"memoryBytes": 32 * 1024 * 1024, "loadMs": 3000, "callMs": 500}))
}

#[test]
fn a_worker_runs_its_packages_script_and_messages_pass_both_ways_with_timers_and_close() {
    let mut e = Ext::start("acme.work", host());
    let first = e.step(
        r#"const w = new Worker(T.at("w/echo.js"), { name: "echoer" }); T.w = w;
           const got = T.next(w); w.postMessage({ hello: [1, 2] }); return await got;"#,
    );
    assert_eq!(
        first,
        json!({"data": {"echo": {"hello": [1, 2]}, "count": 1, "name": "echoer"}})
    );
    // Its timers fire as entries of their own; both of its listeners hear a message.
    let later =
        e.step(r#"const got = T.next(T.w); T.w.postMessage({ later: "soon" }); return await got;"#);
    assert_eq!(later, json!({"data": {"later": "soon", "count": 2}}));
    let both = e.step(
        r#"const seen = []; await new Promise((resolve) => { T.w.onmessage = (m) => { seen.push(m.data); if (seen.length === 2) resolve(); }; T.w.postMessage("twice"); });
           return seen.sort();"#,
    );
    assert_eq!(
        both,
        json!([{"count": 3, "echo": "twice", "name": "echoer"}, "second listener"])
    );
    // Closed from inside: nothing more is heard, and posting to it is refused.
    let closed = e.step(
        r#"T.w.postMessage("close"); await new Promise((r) => setTimeout(r, 50));
           try { T.w.postMessage(1); return "posted"; } catch (error) { return error.message; }"#,
    );
    assert_eq!(
        closed,
        json!("posted"),
        "an ended worker takes nothing, silently"
    );
    // Terminated from outside: the same.
    let ended = e.step(
        r#"const w = new Worker(T.at("w/echo.js")); w.terminate(); w.postMessage(1);
           const heard = await Promise.race([T.next(w), new Promise((r) => setTimeout(() => r("nothing"), 100))]);
           return heard;"#,
    );
    assert_eq!(ended, json!("nothing"));
}

#[test]
fn a_worker_has_a_workers_scope_and_nothing_of_yavins() {
    let mut e = Ext::start("acme.work", host());
    let report =
        e.step(r#"const w = new Worker(T.at("w/probe.js")); return (await T.next(w)).data;"#);
    assert_eq!(
        report["natives"],
        json!([]),
        "no host function is left to call: {report}"
    );
    for absent in [
        "require",
        "process",
        "Worker",
        "XMLHttpRequest",
        "WebAssembly",
    ] {
        assert_eq!(report[absent], "undefined", "{absent}: {report}");
    }
    for present in ["setTimeout", "TextEncoder", "URL"] {
        assert_eq!(report[present], "function", "{present}: {report}");
    }
    assert_eq!(report["crypto"], "function");
    let location = report["location"].as_str().unwrap();
    assert!(
        location.starts_with("file:///")
            && location.ends_with("/ext/acme.work/extension/w/probe.js"),
        "{location}"
    );
    assert!(
        report["importScripts"]
            .as_str()
            .unwrap()
            .contains("not supported in Yavin's workers"),
        "{report}"
    );
    assert!(
        report["fetch"]
            .as_str()
            .unwrap()
            .contains("no network access"),
        "{report}"
    );
}

#[test]
fn only_its_packages_javascript_files_can_be_a_workers_script() {
    let mut e = Ext::start("acme.work", host());
    let refused = e.step(
        r#"const tries = {
             remote: "https://example.com/w.js", blob: "blob:https://x/1", data: "data:text/javascript,postMessage(1)",
             outside: "file:///c%3A/ext/acme.other/extension/w/echo.js", missing: T.at("w/none.js"), notScript: T.at("w/data.json"),
             parent: T.at("../package.json"),
           };
           const out = {};
           for (const [k, url] of Object.entries(tries)) { try { new Worker(url); out[k] = "STARTED"; } catch (e) { out[k] = e.name || e.message; } }
           try { new Worker(T.at("w/echo.js"), { type: "module" }); out.module = "STARTED"; } catch (e) { out.module = e.name; }
           return out;"#,
    );
    assert_eq!(
        refused,
        json!({"remote": "UnsupportedApi", "blob": "UnsupportedApi", "data": "UnsupportedApi", "outside": "SecurityError",
               "missing": "SecurityError", "notScript": "SecurityError", "parent": "SecurityError", "module": "UnsupportedApi"})
    );
}

#[test]
fn messages_and_workers_are_bounded() {
    let mut e = Ext::start("acme.work", host());
    let out = e.step(
        r#"const w = new Worker(T.at("w/big.js")); const out = {};
           try { w.postMessage("x".repeat(4 * 1024 * 1024 + 1)); out.tooLarge = "SENT"; } catch (e) { out.tooLarge = e.name; }
           try { w.postMessage(() => 1); out.notJson = "SENT"; } catch (e) { out.notJson = e.name; }
           const seen = [];
           await new Promise((resolve) => { w.onmessage = (m) => { seen.push(m.data); if (seen.length === 2) resolve(); }; w.postMessage(1); });
           out.fromWorker = seen;
           // At most 1000 waiting for a worker: posted in one turn, the 1001st is refused.
           const echo = new Worker(T.at("w/echo.js"));
           let refusedAt = 0;
           for (let i = 1; i <= 1001; i++) { try { echo.postMessage(i); } catch (error) { refusedAt = i; out.queue = error.message; break; } }
           out.refusedAt = refusedAt;
           return out;"#,
    );
    assert_eq!(out["tooLarge"], "RangeError");
    assert_eq!(out["notJson"], "DataCloneError");
    assert_eq!(
        out["fromWorker"][0]["refused"],
        "A worker's message is at most 4 MiB of JSON."
    );
    assert_eq!(out["fromWorker"][1]["notJson"], "DataCloneError");
    assert_eq!(out["refusedAt"], 1001, "{out}");
    assert!(
        out["queue"]
            .as_str()
            .unwrap()
            .contains("Too many messages are waiting"),
        "{out}"
    );
    // Four workers an extension, at once; a fifth is refused, and one ended frees a place.
    let count = e.step(
        r#"const all = [];
           for (let i = 0; i < 2; i++) all.push(new Worker(T.at("w/echo.js")));
           let fifth = "STARTED"; try { new Worker(T.at("w/echo.js")); } catch (error) { fifth = error.message; }
           all[0].terminate(); await new Promise((r) => setTimeout(r, 30));
           let again = "STARTED"; try { new Worker(T.at("w/echo.js")); } catch (error) { again = error.message; }
           return { fifth, again };"#,
    );
    assert_eq!(
        count["fifth"],
        "An extension may have at most 4 workers at once."
    );
    assert_eq!(count["again"], "STARTED");
}

#[test]
fn a_worker_that_throws_is_said_and_one_that_runs_forever_is_ended_while_its_extension_answers() {
    let mut e = Ext::start("acme.work", host());
    let thrown = e.step(
        r#"const w = new Worker(T.at("w/throws.js")); const errors = [];
           await new Promise((resolve) => { w.onerror = (ev) => { errors.push(ev.message); if (errors.length === 2) resolve(); }; setTimeout(() => w.postMessage(1), 20); });
           return errors;"#,
    );
    assert_eq!(thrown, json!(["top level broke", "listener broke"]));
    let ended = e.step(
        r#"const w = new Worker(T.at("w/forever.js")); T.spinner = w;
           const heard = T.next(w); w.postMessage("spin"); return await heard;"#,
    );
    assert!(
        ended["error"]
            .as_str()
            .unwrap()
            .contains("The worker was stopped"),
        "{ended}"
    );
    // The extension answers meanwhile and after; the ended worker takes nothing more.
    let after = e.step(r#"try { T.spinner.postMessage("hello"); return "posted"; } catch (error) { return "refused"; }"#);
    assert_eq!(
        after,
        json!("posted"),
        "its handle is still the extension's, but ended"
    );
    assert_eq!(e.step("return 1 + 1;"), json!(2));
}

#[test]
fn a_worker_that_takes_too_much_memory_is_stopped_and_the_host_goes_on() {
    let mut e = Ext::start("acme.work", host());
    let heard = e.step(
        r#"const w = new Worker(T.at("w/hungry.js")); const heard = T.next(w); w.postMessage(1);
           return await Promise.race([heard, new Promise((r) => setTimeout(() => r("nothing"), 3000))]);"#,
    );
    assert!(heard["error"].is_string(), "{heard}");
    assert_eq!(e.step("return 6 * 7;"), json!(42));
}

#[test]
fn workers_are_their_extensions_alone_and_end_with_it() {
    let mut a = Ext::start("acme.work", host());
    // Another extension in the same host: its worker ids are its own.
    let mut b = Ext::start(
        "acme.other",
        Host::start_with(json!({"memoryBytes": 32 * 1024 * 1024, "loadMs": 3000, "callMs": 500})),
    );
    let one = a.step(r#"T.w = new Worker(T.at("w/echo.js")); const got = T.next(T.w); T.w.postMessage("a"); return (await got).data.echo;"#);
    let two = b.step(r#"T.w = new Worker(T.at("w/echo.js")); const got = T.next(T.w); T.w.postMessage("b"); return (await got).data.echo;"#);
    assert_eq!((one, two), (json!("a"), json!("b")));
    // A worker's logs are its extension's, named as a worker's.
    a.step(r#"T.t = new Worker(T.at("w/ticks.js"), { name: "ticker" }); await new Promise((r) => setTimeout(r, 120)); return 1;"#);
    assert!(
        a.logs
            .iter()
            .any(|l| l == "[worker ticker] tick from the worker"),
        "{:?}",
        a.logs
    );
    // Unloaded, its workers go with it: no more of its ticks.
    a.host.to("acme.work", json!({"type": "unload"}));
    a.host.until(|m| m["type"] == "unloaded");
    let quiet = std::time::Instant::now() + std::time::Duration::from_millis(300);
    while std::time::Instant::now() < quiet {
        if let Ok(message) = a
            .host
            .messages
            .recv_timeout(std::time::Duration::from_millis(50))
        {
            assert_ne!(
                message["type"], "log",
                "a worker outlived its extension: {message}"
            );
        }
    }
}

#[test]
fn a_host_runs_at_most_sixteen_workers_across_its_extensions() {
    let ids = [
        "acme.one",
        "acme.two",
        "acme.three",
        "acme.four",
        "acme.five",
    ];
    let mut e = Ext::start(ids[0], host());
    for (n, id) in ids.iter().enumerate() {
        if n > 0 {
            e = e.also(id);
        }
        let heard = e.step(
            r#"const all = []; for (let i = 0; i < 4; i++) all.push(new Worker(T.at("w/echo.js")));
               const got = T.next(all[3]); all[3].postMessage("hi"); return await got;"#,
        );
        if n < 4 {
            assert_eq!(heard["data"]["echo"], "hi", "{id}: {heard}");
        } else {
            // The host's sixteen are running: the fifth extension's are refused, and it hears why.
            assert_eq!(
                heard,
                json!({"error": "This host runs at most 16 workers at once."}),
                "{id}"
            );
        }
    }
}
