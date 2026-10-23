//! The VS Code compatibility layer (EXT-25) in the real host: VS Code extensions' code loaded as
//! CommonJS modules with `require("vscode")`, mapped onto the extension protocol; what Yavin does
//! not provide failing with `UnsupportedApi`; and the host's timers.

mod common;

use common::Host;
use serde_json::{json, Value};

const MAIN: &str = "extension/out/extension.js";
const COMMAND: &str = "acme.sorter.sortlines-1a2b3c4d";

fn runtime(extra: Value) -> Value {
    let mut meta = json!({
        "api": "vscode", "level": "1.90.0", "entry": "main",
        "commands": {COMMAND: "sortLines.sortLines"},
        "settings": {"acme.sorter.filter-5": "sortLines.filterBlankLines"},
        "views": {}, "defaults": {"sortLines.order": ["a", "b"]},
    });
    if let (Some(meta), Value::Object(extra)) = (meta.as_object_mut(), extra) {
        meta.extend(extra);
    }
    meta
}

/// Loads `code` as a VS Code extension's entry point, beside `modules`.
fn load(host: &mut Host, id: &str, code: &str, modules: Value, meta: Value) -> Value {
    host.to(
        id,
        json!({"type": "load", "code": code, "extensionPath": "C:/ext/acme.sorter", "modules": modules, "vscode": meta, "main": MAIN}),
    );
    host.until(|m| m["type"] == "loaded" || m["type"] == "error")
}

/// How the test answers an extension's requests: a result, or an error code and message.
type Answer<'a> = &'a mut dyn FnMut(&str, &Value) -> Result<Value, (&'static str, String)>;

/// What Yavin answered and saw while one request to the extension ran.
struct Ran {
    response: Value,
    requests: Vec<Value>,
    logs: Vec<String>,
}

/// Asks the extension `method`; its requests meanwhile are answered by `answer` (an error is
/// `Err((code, message))`).
fn run(
    host: &mut Host,
    id: &str,
    request: &str,
    method: &str,
    params: Value,
    answer: Answer<'_>,
) -> Ran {
    host.to(
        id,
        json!({"type": "request", "requestId": request, "method": method, "params": params}),
    );
    let mut ran = Ran {
        response: Value::Null,
        requests: Vec::new(),
        logs: Vec::new(),
    };
    loop {
        let message = host.recv();
        match message["type"].as_str() {
            Some("request") => {
                let reply = match answer(message["method"].as_str().unwrap(), &message["params"]) {
                    Ok(result) => {
                        json!({"type": "response", "requestId": message["requestId"], "ok": true, "result": result})
                    }
                    Err((code, text)) => {
                        json!({"type": "response", "requestId": message["requestId"], "ok": false, "error": {"code": code, "message": text}})
                    }
                };
                ran.requests.push(message);
                host.to(id, reply);
            }
            Some("log") => ran
                .logs
                .push(message["text"].as_str().unwrap_or("").to_string()),
            Some("response") if message["requestId"] == json!(request) => {
                ran.response = message;
                return ran;
            }
            _ => {}
        }
    }
}

fn doc(version: u64) -> Value {
    json!({"uri": "file:///C:/work/list.txt", "resourceId": "r", "languageId": "plaintext", "version": version, "source": "disk", "dirty": false})
}

/// A workspace with one open document, `text`, as Yavin's window would answer.
fn window(text: &'static str) -> impl FnMut(&str, &Value) -> Result<Value, (&'static str, String)> {
    let mut current = text.to_string();
    let mut version = 1;
    move |method, params| match method {
        "documents.all" => Ok(json!([doc(version)])),
        // As Yavin's window: it reports its focus (EXT-27).
        "window.state" => Ok(json!({"focused": true})),
        "documents.get" => Ok(doc(version)),
        "documents.getText" => Ok(json!(current)),
        "editor.active" => Ok(
            json!({"document": doc(version), "selection": {"startLine": 1, "startColumn": 1, "endLine": 1, "endColumn": 1}}),
        ),
        "documents.edit" => {
            assert_eq!(
                params["version"],
                json!(version),
                "edits name the version they were made on"
            );
            let edit = &params["edits"][0];
            assert_eq!(edit["range"]["startLine"], 1);
            current = edit["text"].as_str().unwrap().to_string();
            version += 1;
            Ok(json!(true))
        }
        _ => Ok(Value::Null),
    }
}

const SORTER: &str = r#"
const vscode = require("vscode");
const path = require("node:path");
const { upper } = require("./lib/helper");
const pkg = require("../package.json");
exports.activate = function (context) {
  context.subscriptions.push(vscode.commands.registerCommand("sortLines.sortLines", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return "no editor";
    const doc = editor.document;
    const last = doc.lineAt(doc.lineCount - 1);
    const sorted = doc.getText().split("\n").sort().join("\n");
    const ok = await editor.edit((b) => b.replace(new vscode.Range(new vscode.Position(0, 0), last.range.end), sorted));
    return [ok, upper(pkg.name), path.basename(doc.fileName), doc.getText(), doc.version,
            vscode.workspace.getConfiguration("sortLines").get("filterBlankLines"),
            vscode.workspace.getConfiguration("sortLines").get("order"),
            vscode.workspace.getConfiguration().get("editor.tabSize", 4)].join("|");
  }));
};
"#;

#[test]
fn a_vs_code_extension_loads_its_modules_activates_and_edits_the_active_document() {
    let mut host = Host::start();
    let modules = json!({
        "extension/out/lib/helper.js": "exports.upper = (s) => s.toUpperCase();",
        "extension/package.json": r#"{"name": "sorter", "publisher": "Acme", "version": "1.0.0"}"#,
    });
    assert_eq!(
        load(
            &mut host,
            "acme.sorter",
            SORTER,
            modules,
            runtime(json!({}))
        )["type"],
        "loaded"
    );
    let mut answer = window("pear\napple\nfig");
    let activated = run(
        &mut host,
        "acme.sorter",
        "a1",
        "activate",
        json!({"globalState": {}, "configuration": {"acme.sorter.filter-5": true}}),
        &mut answer,
    );
    assert_eq!(activated.response["ok"], true, "{:?}", activated.response);
    // The VS Code command is registered under the Yavin id the adapter gave it.
    let registered: Vec<&Value> = activated
        .requests
        .iter()
        .filter(|r| r["method"] == "commands.register")
        .collect();
    assert_eq!(registered.len(), 1);
    assert_eq!(registered[0]["params"]["id"], COMMAND);
    let ran = run(
        &mut host,
        "acme.sorter",
        "c1",
        "command.run",
        json!({"id": COMMAND, "args": []}),
        &mut answer,
    );
    assert_eq!(ran.response["ok"], true, "{:?}", ran.response);
    assert_eq!(
        ran.response["result"], "true|SORTER|list.txt|apple\nfig\npear|2|true|a,b|4",
        "the edit went through documents.edit, and the document reads its new text and version"
    );
    assert!(ran.requests.iter().any(|r| r["method"] == "documents.edit"));
    // A setting Yavin does not have is said, once, and the extension's own default used.
    assert!(
        ran.logs
            .iter()
            .any(|l| l.contains("\"editor.tabSize\" is not available")),
        "{:?}",
        ran.logs
    );
}

#[test]
fn what_yavin_does_not_provide_fails_with_an_error_that_names_it() {
    let mut host = Host::start();
    let probe = r#"
const vscode = require("vscode");
const fs = require("fs");
const cp = require("child_process");
// esbuild's and tsc's module interop, as bundles use them.
const __toESM = (mod) => { const target = { default: mod }; for (const k of Object.getOwnPropertyNames(mod)) Object.defineProperty(target, k, { get: () => mod[k], enumerable: true }); return target; };
const esm = __toESM(require("os"));
const outcome = (run) => { try { const v = run(); return v && typeof v.then === "function" ? "promise" : "ok:" + typeof v; } catch (e) { return (e.code || e.name) + ":" + e.message; } };
exports.activate = function (context) {
  context.subscriptions.push(vscode.commands.registerCommand("sortLines.sortLines", async () => ({
    openDialog: outcome(() => vscode.window.showOpenDialog({})),
    webview: outcome(() => vscode.window.registerWebviewViewProvider("x", {})),
    debug: outcome(() => vscode.debug.startDebugging(undefined, "x")),
    scm: outcome(() => vscode.scm.createSourceControl("git", "Git")),
    rename: outcome(() => vscode.languages.registerRenameProvider("x", {})),
    unknownMember: outcome(() => vscode.window.someFutureApi()),
    machineId: outcome(() => vscode.env.machineId),
    storage: outcome(() => ({}).x),
    readFile: outcome(() => fs.readFileSync("C:/Windows/win.ini")),
    spawn: outcome(() => cp.spawn("cmd.exe")),
    esmOs: outcome(() => esm.homedir()),
    eol: outcome(() => require("os").EOL),
    missing: outcome(() => require("./nothing-here")),
    native: outcome(() => require("./build/addon.node")),
    unknownPackage: outcome(() => require("left-pad")),
    buffer: Buffer.from("héllo").toString("base64") + "|" + Buffer.from("aGk=", "base64").toString() + "|" + Buffer.concat([Buffer.from([1]), Buffer.from("ff", "hex")]).toString("hex"),
    constants: outcome(() => require("constants").O_RDONLY),
    builtinLoads: typeof require("punycode"),
    homedir: outcome(() => require("os").homedir()),
    location: typeof location.href + "|" + outcome(() => importScripts("x.js")),
    fetch: typeof fetch,
    processCwd: outcome(() => process.cwd()),
    platform: process.platform,
    env: JSON.stringify(process.env),
    path: require("path").join("C:\\work", "..", "a", "b.ts"),
    posix: require("path").posix.join("/a/b", "../c"),
    format: require("util").format("%s=%d", "n", 5),
    oldStyle: (() => { const E = require("events"); function Old() { E.call(this); } require("util").inherits(Old, E); const o = new Old(); let got = 0; o.on("x", (n) => (got = n)); o.emit("x", 7); return got; })(),
    pure: [typeof require("util").debuglog("x"), require("tty").isatty(1), require("http").STATUS_CODES[404], typeof require("util").inspect.custom].join("|"),
    httpRequest: outcome(() => require("http").request("http://example.com")),
    // graceful-fs marks fs, then clones it; vscode-languageclient subclasses data classes.
    marked: outcome(() => { const f = require("fs"); Object.defineProperty(f, Symbol.for("graceful-fs.queue"), { get: () => [] }); const copy = {}; for (const k of Object.getOwnPropertyNames(f)) Object.defineProperty(copy, k, Object.getOwnPropertyDescriptor(f, k)); return Object.getOwnPropertyNames(copy).length; }),
    importStar: outcome(() => { const v = {}; for (const k of Object.getOwnPropertyNames(vscode)) v[k] = vscode[k]; class C extends v.CallHierarchyItem {} return new C(0, "n").name; }),
    clipboard: await vscode.env.clipboard.readText().then(() => "ok", (e) => e.code),
  })));
};
"#;
    assert_eq!(
        load(
            &mut host,
            "acme.sorter",
            probe,
            json!({}),
            runtime(json!({}))
        )["type"],
        "loaded"
    );
    let mut answer = window("x");
    let ran = run(
        &mut host,
        "acme.sorter",
        "a1",
        "activate",
        json!({}),
        &mut answer,
    );
    assert_eq!(ran.response["ok"], true, "{:?}", ran.response);
    let ran = run(
        &mut host,
        "acme.sorter",
        "c1",
        "command.run",
        json!({"id": COMMAND, "args": []}),
        &mut answer,
    );
    assert_eq!(ran.response["ok"], true, "{:?}", ran.response);
    let out = &ran.response["result"];
    let unsupported = |key: &str, names: &str| {
        let text = out[key].as_str().unwrap_or("");
        assert!(
            text.starts_with("UnsupportedApi:") && text.contains(names),
            "{key}: {text}"
        );
    };
    unsupported("openDialog", "window.showOpenDialog");
    unsupported("webview", "window.registerWebviewViewProvider");
    unsupported("debug", "debug.startDebugging");
    unsupported("scm", "scm.createSourceControl");
    unsupported("rename", "languages.registerRenameProvider");
    unsupported("unknownMember", "window.someFutureApi");
    unsupported("machineId", "env.machineId");
    unsupported("readFile", "Node.js fs.readFileSync");
    unsupported("spawn", "Node.js child_process.spawn");
    unsupported("esmOs", "Node.js os.homedir");
    assert_eq!(out["eol"], "ok:string", "os says only the platform");
    unsupported("homedir", "Node.js os.homedir");
    unsupported("constants", "Node.js constants.O_RDONLY");
    assert_eq!(
        out["builtinLoads"], "object",
        "importing a Node built-in never fails by itself"
    );
    unsupported("native", "native module");
    unsupported("unknownPackage", "left-pad");
    unsupported("processCwd", "process.cwd");
    assert!(
        out["missing"]
            .as_str()
            .unwrap()
            .starts_with("MODULE_NOT_FOUND"),
        "{}",
        out["missing"]
    );
    assert_eq!(out["clipboard"], "UnsupportedApi");
    assert_eq!(out["buffer"], "aMOpbGxv|hi|01ff");
    let location = out["location"].as_str().unwrap();
    assert!(
        location.starts_with("string|UnsupportedApi:") && location.contains("importScripts"),
        "{location}"
    );
    assert_eq!(out["fetch"], "undefined");
    assert_eq!(out["platform"], "win32");
    assert_eq!(out["env"], "{}", "no environment reaches an extension");
    assert_eq!(out["path"], r"C:\a\b.ts");
    assert_eq!(out["posix"], "/a/c");
    assert_eq!(out["format"], "n=5");
    assert_eq!(
        out["oldStyle"], 7,
        "EventEmitter subclassed the Node.js way"
    );
    assert_eq!(out["marked"], "ok:number");
    assert_eq!(out["importStar"], "ok:string");
    assert_eq!(out["pure"], "function|false|Not Found|symbol");
    unsupported("httpRequest", "Node.js http.request");
    // Each unsupported API is logged once, by name.
    let named: Vec<&String> = ran
        .logs
        .iter()
        .filter(|l| l.starts_with("UnsupportedApi:"))
        .collect();
    assert!(named.len() >= 12, "{named:?}");
}

/// EXT-25: timers are the host's -- they fire as entries of their own, under the call deadline,
/// at most 1000 waiting per extension; a timer that hangs is interrupted and the host carries on.
#[test]
fn timers_are_the_hosts_bounded_and_interruptible() {
    let mut host = Host::start();
    let code = r#"
module.exports.activate = function (context, yavin) {
  const say = (text) => yavin.window.showInformationMessage(text);
  const flood = [];
  let refused = "none";
  try { for (let i = 0; i < 1001; i++) flood.push(setTimeout(() => say("flood ran"), 60000)); } catch (e) { refused = e.code + " after " + flood.length; }
  flood.forEach(clearTimeout);
  const started = Date.now();
  let ticks = 0;
  const interval = setInterval(() => { if (++ticks === 3) { clearInterval(interval); say("interval 3"); } }, 10);
  // Due times 100 ms apart: Windows timers tick every ~15.6 ms, and the interval is rescheduled
  // from each run (as in Node.js), so its third run can be ~50 ms in (EXT-27: 50 ms was flaky).
  setTimeout((a, b) => say("timeout " + (Date.now() - started >= 140) + " " + a + b), 150, "x", "y");
  clearTimeout(setTimeout(() => say("cancelled ran"), 20));
  setTimeout(() => { for (;;) {} }, 300);
  setTimeout(() => say("after the hang"), 1200);
  return refused;
};
"#;
    assert_eq!(host.load("acme.timers", code)["type"], "loaded");
    let activated = host.ask("acme.timers", "a1", "activate", json!({}), json!(null));
    assert_eq!(activated["result"], "TooManyTimers after 1000");
    let mut said = Vec::new();
    let mut hung = false;
    let until = std::time::Instant::now() + std::time::Duration::from_secs(8);
    while std::time::Instant::now() < until && !said.iter().any(|s: &String| s == "after the hang")
    {
        let message = host.recv();
        match message["type"].as_str() {
            Some("request") => {
                said.push(message["params"]["message"].as_str().unwrap().to_string());
                host.to("acme.timers", json!({"type": "response", "requestId": message["requestId"], "ok": true, "result": null}));
            }
            Some("error") if message["error"]["code"] == "ExtensionFailed" => hung = true,
            _ => {}
        }
    }
    assert_eq!(
        said,
        ["interval 3", "timeout true xy", "after the hang"],
        "in order; a cleared timer never runs"
    );
    assert!(hung, "the hung timer was interrupted and said so");
}

/// EXT-25: the inventory (`src/services/extensions/vscodeApi.json`) says what the layer is: every
/// member it lists as provided exists and is not a stand-in; every one it lists as unsupported
/// fails with UnsupportedApi -- in the real host.
#[test]
fn the_inventory_matches_the_layer() {
    let inventory: Value = serde_json::from_str(include_str!(
        "../../../../src/services/extensions/vscodeApi.json"
    ))
    .unwrap();
    let mut probes = Vec::new();
    for entry in inventory["api"].as_array().unwrap() {
        let api = entry["api"].as_str().unwrap();
        // Members of the vscode module by path; classes, context and editor members are tested
        // by behaviour (the tests above).
        let path_like = api.chars().all(|c| c.is_ascii_alphanumeric() || c == '.')
            && !api.starts_with("ExtensionContext")
            && !api.starts_with("TextEditor")
            && api != "TextDocument"
            && api != "Uri";
        if path_like {
            probes.push(json!({"api": api, "status": entry["status"]}));
        }
    }
    assert!(probes.len() > 120, "{}", probes.len());
    let code = format!(
        r#"
const vscode = require("vscode");
const TAG = Symbol.for("yavin.unsupported");
const look = (api) => {{
  try {{
    let value = vscode;
    for (const part of api.split(".")) value = value[part];
    if (value === undefined) return "absent";
    if (typeof value === "function" && value[TAG]) return "unsupported";
    if (value && typeof value === "object" && !Array.isArray(value) && typeof value.anything === "function" && value.anything[TAG]) return "unsupported";
    if (value && typeof value === "object" && Object.values(value).length && Object.values(value).every((v) => typeof v === "function" && v[TAG])) return "unsupported";
    return "provided";
  }} catch (e) {{
    return e.code === "UnsupportedApi" ? "unsupported" : "threw " + e.message;
  }}
}};
exports.activate = (context) => {{
  context.subscriptions.push(vscode.commands.registerCommand("sortLines.sortLines", () => {{
    const out = {{}};
    for (const p of {probes}) out[p.api] = look(p.api);
    return out;
  }}));
}};
"#,
        probes = Value::Array(probes.clone())
    );
    let mut host = Host::start();
    assert_eq!(
        load(
            &mut host,
            "acme.sorter",
            &code,
            json!({}),
            runtime(json!({}))
        )["type"],
        "loaded"
    );
    let mut answer = window("x");
    assert_eq!(
        run(
            &mut host,
            "acme.sorter",
            "a1",
            "activate",
            json!({}),
            &mut answer
        )
        .response["ok"],
        true
    );
    let ran = run(
        &mut host,
        "acme.sorter",
        "c1",
        "command.run",
        json!({"id": COMMAND, "args": []}),
        &mut answer,
    );
    let found = &ran.response["result"];
    let mut wrong = Vec::new();
    for probe in &probes {
        let api = probe["api"].as_str().unwrap();
        let expected = if probe["status"] == "UNSUPPORTED" {
            "unsupported"
        } else {
            "provided"
        };
        if found[api] != json!(expected) {
            wrong.push(format!(
                "{api}: listed {} but {}",
                probe["status"], found[api]
            ));
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}
