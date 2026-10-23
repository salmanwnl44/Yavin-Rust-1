//! VS Code API behavioural conformance (EXT-27), in the real host: one probe extension, loaded
//! as a VS Code extension, runs a step of JavaScript per command and returns what the API did;
//! a stateful window (`World`) answers every protocol request as Yavin's would, records each
//! one, and sends the window's events. A test asserts both sides: what the extension saw and
//! what reached the window -- so it cannot pass because an API merely exists, or because a
//! callback was never called.

mod common;

use common::Host;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

const EXT: &str = "acme.probe";
const PROBE: &str = "acme.probe.probe-0001";
const OTHER_COMMAND: &str = "acme.probe.other-0002";
const VIEW: &str = "acme.probe.tree-0003";
const MAIN: &str = "extension/out/main.js";

/// The probe: a contributed command whose argument is a step to run (`vscode`, `context`, `T`
/// for state kept between steps), awaited, its value returned as JSON.
const PROBE_CODE: &str = r#"
const vscode = require("vscode");
globalThis.T = { events: [] };
exports.activate = function (context) {
  T.context = context;
  context.subscriptions.push(vscode.commands.registerCommand("probe.run", async (step) => {
    const value = await new Function("vscode", "context", "T", "require", "return (async () => {" + step + "})()")(vscode, context, T, require);
    return value === undefined ? null : JSON.parse(JSON.stringify(value));
  }));
};
exports.deactivate = function () { T.deactivated = true; };
"#;

fn runtime() -> Value {
    json!({
        "api": "vscode", "level": "1.90.0", "entry": "main",
        "commands": {PROBE: "probe.run", OTHER_COMMAND: "probe.other"},
        "settings": {"acme.probe.mode-1": "probe.mode", "acme.probe.size-2": "probe.size", "acme.probe.deep-3": "probe.deep.flag"},
        "views": {VIEW: "probe.tree"},
        "defaults": {"probe.list": ["a", "b"]},
    })
}

/// A document as Yavin's window holds it.
#[derive(Clone)]
struct Doc {
    text: String,
    version: u64,
    language: String,
}

/// Yavin's window, as the protocol sees it: what it holds and every request it received.
#[derive(Default)]
struct World {
    docs: BTreeMap<String, Doc>,
    active: Option<String>,
    selection: Value,
    files: BTreeMap<String, String>,
    focused: Option<bool>,
    requests: Vec<Value>,
    logs: Vec<(String, String)>,
    decorations: BTreeMap<(String, String), Value>,
    status: BTreeMap<String, Value>,
    views: Vec<String>,
    providers: BTreeMap<String, Value>,
    storage: Map<String, Value>,
    secrets: BTreeMap<String, String>,
    /// Methods answered with PermissionDenied (a capability not granted).
    denied: Vec<&'static str>,
    /// documents.edit answers false (the document changed meanwhile).
    stale: bool,
}

const URI: &str = "file:///C:/work/notes.txt";

impl World {
    fn new() -> World {
        let mut world = World {
            selection: json!({"startLine": 1, "startColumn": 1, "endLine": 1, "endColumn": 1}),
            focused: Some(true),
            ..Default::default()
        };
        world.open(URI, "alpha beta\ngamma\n", "plaintext");
        world.active = Some(URI.into());
        world.files.insert("readme.md".into(), "# Read me".into());
        world
    }
    fn open(&mut self, uri: &str, text: &str, language: &str) {
        self.docs.insert(
            uri.into(),
            Doc {
                text: text.into(),
                version: 1,
                language: language.into(),
            },
        );
    }
    fn info(&self, uri: &str) -> Value {
        let doc = &self.docs[uri];
        json!({"uri": uri, "resourceId": uri, "languageId": doc.language, "version": doc.version, "source": "disk", "dirty": doc.version > 1})
    }
    fn of(&self, method: &str) -> Vec<&Value> {
        self.requests
            .iter()
            .filter(|r| r["method"] == method)
            .collect()
    }
    /// An answer to one request, as Yavin's window would give it.
    fn answer(&mut self, method: &str, params: &Value) -> Result<Value, (&'static str, String)> {
        if self.denied.contains(&method) {
            return Err(("PermissionDenied", format!("\"{method}\" is not allowed")));
        }
        let uri = params["uri"].as_str().unwrap_or("").to_string();
        Ok(match method {
            "documents.all" => Value::Array(self.docs.keys().map(|u| self.info(u)).collect()),
            "documents.get" => {
                if self.docs.contains_key(&uri) {
                    self.info(&uri)
                } else {
                    Value::Null
                }
            }
            "documents.getText" => self
                .docs
                .get(&uri)
                .map(|d| json!(d.text))
                .unwrap_or(Value::Null),
            "documents.edit" => {
                if self.stale || !self.docs.contains_key(&uri) {
                    return Ok(json!(false));
                }
                let doc = self.docs.get_mut(&uri).unwrap();
                let mut lines: Vec<String> = doc.text.split('\n').map(str::to_string).collect();
                // Edits as the window applies them: here, whole-line or in-line replacements.
                let mut edits = params["edits"].as_array().unwrap().clone();
                edits.sort_by_key(|e| {
                    std::cmp::Reverse((
                        e["range"]["startLine"].as_u64(),
                        e["range"]["startColumn"].as_u64(),
                    ))
                });
                let mut text = doc.text.clone();
                for edit in edits {
                    let r = &edit["range"];
                    let offset = |line: u64, column: u64| -> usize {
                        lines[..(line as usize - 1)]
                            .iter()
                            .map(|l| l.chars().count() + 1)
                            .sum::<usize>()
                            + column as usize
                            - 1
                    };
                    let start = offset(
                        r["startLine"].as_u64().unwrap(),
                        r["startColumn"].as_u64().unwrap(),
                    );
                    let end = offset(
                        r["endLine"].as_u64().unwrap(),
                        r["endColumn"].as_u64().unwrap(),
                    );
                    let chars: Vec<char> = text.chars().collect();
                    text = chars[..start].iter().collect::<String>()
                        + edit["text"].as_str().unwrap()
                        + &chars[end..].iter().collect::<String>();
                    lines = text.split('\n').map(str::to_string).collect();
                }
                doc.text = text;
                doc.version += 1;
                json!(true)
            }
            "editor.active" => match &self.active {
                Some(uri) => json!({"document": self.info(uri), "selection": self.selection}),
                None => Value::Null,
            },
            "editor.setSelection" => {
                self.selection = params["range"].clone();
                json!(true)
            }
            "editor.revealRange" | "editor.openLocation" => json!(true),
            "editor.setDecorations" => {
                self.decorations.insert(
                    (uri, params["key"].as_str().unwrap().into()),
                    params["decorations"].clone(),
                );
                Value::Null
            }
            "statusBar.set" => {
                self.status
                    .insert(params["id"].as_str().unwrap().into(), params.clone());
                Value::Null
            }
            "statusBar.remove" => {
                self.status.remove(params["id"].as_str().unwrap());
                Value::Null
            }
            "views.register" => {
                self.views.push(params["id"].as_str().unwrap().into());
                Value::Null
            }
            "views.unregister" => {
                let id = params["id"].as_str().unwrap();
                self.views.retain(|v| v != id);
                Value::Null
            }
            "languages.register" => {
                self.providers.insert(
                    params["providerId"].as_str().unwrap().into(),
                    params.clone(),
                );
                Value::Null
            }
            "languages.unregister" => {
                self.providers
                    .remove(params["providerId"].as_str().unwrap());
                Value::Null
            }
            "storage.update" => {
                let key = params["key"].as_str().unwrap().to_string();
                if params["value"].is_null() {
                    self.storage.remove(&key);
                } else {
                    self.storage.insert(key, params["value"].clone());
                }
                Value::Null
            }
            "secrets.store" => {
                self.secrets.insert(
                    params["key"].as_str().unwrap().into(),
                    params["value"].as_str().unwrap().into(),
                );
                Value::Null
            }
            "secrets.get" => self
                .secrets
                .get(params["key"].as_str().unwrap())
                .map(|v| json!(v))
                .unwrap_or(Value::Null),
            "secrets.delete" => json!(self
                .secrets
                .remove(params["key"].as_str().unwrap())
                .is_some()),
            "fs.readFile" => match self.files.get(params["path"].as_str().unwrap()) {
                Some(text) => json!(text),
                None => return Err(("NotFound", "no such file".into())),
            },
            "window.state" => json!({"focused": self.focused}),
            _ => Value::Null,
        })
    }
}

/// The probe loaded and activated in a host, and the window it talks to.
struct Probe {
    host: Host,
    world: World,
    next: u32,
}

impl Probe {
    fn start(world: World) -> Probe {
        let mut host = Host::start();
        host.to(
            EXT,
            // As extension_host.rs sends a real install: its package.json among its modules.
            json!({"type": "load", "code": PROBE_CODE, "extensionPath": "C:/ext/acme.probe", "modules": {"extension/package.json": r#"{"publisher": "Acme", "name": "probe", "version": "1.0.0"}"#}, "vscode": runtime(), "main": MAIN}),
        );
        assert_eq!(
            host.until(|m| m["type"] == "loaded" || m["type"] == "error")["type"],
            "loaded"
        );
        let mut probe = Probe {
            host,
            world,
            next: 1,
        };
        let activated = probe.request(
            "activate",
            json!({"globalState": {"seen": 1}, "workspaceState": {"local": true}, "configuration": {"acme.probe.mode-1": "fast", "acme.probe.size-2": 3, "acme.probe.deep-3": true}}),
        );
        assert_eq!(activated["ok"], true, "{activated}");
        probe
    }
    /// Asks the extension `method`; its requests meanwhile are answered by the world.
    fn request(&mut self, method: &str, params: Value) -> Value {
        let id = format!("t{}", self.next);
        self.next += 1;
        self.host.to(
            EXT,
            json!({"type": "request", "requestId": id, "method": method, "params": params}),
        );
        self.pump(Some(&id)).unwrap()
    }
    /// Answers requests until the response to `id` (or, with none, until the host is quiet:
    /// a request round-trip that follows everything already sent).
    fn pump(&mut self, id: Option<&str>) -> Option<Value> {
        loop {
            let message = self.host.recv();
            match message["type"].as_str() {
                Some("request") => {
                    let method = message["method"].as_str().unwrap().to_string();
                    let reply = match self.world.answer(&method, &message["params"]) {
                        Ok(result) => {
                            json!({"type": "response", "requestId": message["requestId"], "ok": true, "result": result})
                        }
                        Err((code, text)) => {
                            json!({"type": "response", "requestId": message["requestId"], "ok": false, "error": {"code": code, "message": text}})
                        }
                    };
                    self.world.requests.push(message);
                    self.host.to(EXT, reply);
                }
                Some("log") => self.world.logs.push((
                    message["level"].as_str().unwrap_or("").into(),
                    message["text"].as_str().unwrap_or("").into(),
                )),
                Some("response") if Some(message["requestId"].as_str().unwrap_or("")) == id => {
                    return Some(message)
                }
                _ => {}
            }
        }
    }
    /// Runs a step in the extension; its value, or the error it failed with.
    fn step(&mut self, code: &str) -> Result<Value, Value> {
        let response = self.request("command.run", json!({"id": PROBE, "args": [code]}));
        if response["ok"] == true {
            Ok(response["result"].clone())
        } else {
            Err(response["error"].clone())
        }
    }
    fn ok(&mut self, code: &str) -> Value {
        self.step(code)
            .unwrap_or_else(|e| panic!("{code}\n -> {e}"))
    }
    /// Sends a window event, then waits until the extension has handled it (a step after it
    /// runs only once the event's listeners and the requests they made are done).
    fn event(&mut self, event: &str, payload: Value) {
        self.host.to(
            EXT,
            json!({"type": "event", "event": event, "payload": payload}),
        );
        self.settle();
    }
    /// Lets queued promise jobs and the requests they made complete: a round trip through the
    /// extension that answers only after them.
    fn settle(&mut self) {
        for _ in 0..3 {
            self.ok("await new Promise((r) => setTimeout(r, 0));");
        }
    }
}

fn unsupported(error: &Value, api: &str) {
    let message = error["message"].as_str().unwrap_or("");
    assert!(
        message.starts_with("UnsupportedApi:") && message.contains(api),
        "{api}: {error}"
    );
}

#[test]
fn commands_register_run_execute_and_dispose() {
    let mut p = Probe::start(World::new());
    // Contributed: registered with Yavin under its mapped id; internal: the extension's own.
    assert_eq!(p.world.of("commands.register").len(), 1);
    assert_eq!(p.world.of("commands.register")[0]["params"]["id"], PROBE);
    let value = p.ok(r#"
      T.inner = vscode.commands.registerCommand("probe.inner", (a, b) => a + b);
      T.other = vscode.commands.registerCommand("probe.other", () => "other ran");
      const sum = await vscode.commands.executeCommand("probe.inner", 2, 3);
      const ctx = await vscode.commands.executeCommand("setContext", "probe.on", true);
      let builtin, dup;
      try { await vscode.commands.executeCommand("editor.action.formatDocument"); } catch (e) { builtin = e.code + ":" + e.message; }
      try { vscode.commands.registerCommand("probe.inner", () => 0); } catch (e) { dup = e.message; }
      const listed = await vscode.commands.getCommands();
      return { sum, ctx: ctx ?? "undefined", builtin, dup, listed: listed.filter((c) => c.startsWith("probe.")).sort() };
    "#);
    assert_eq!(value["sum"], 5);
    assert_eq!(value["ctx"], "undefined");
    unsupported(
        &json!({"message": value["builtin"].as_str().unwrap().split_once(':').unwrap().1}),
        "editor.action.formatDocument",
    );
    assert!(value["dup"].as_str().unwrap().contains("already exists"));
    assert_eq!(
        value["listed"],
        json!(["probe.inner", "probe.other", "probe.run"])
    );
    // probe.other is contributed: registered with Yavin when registered; runnable by Yavin.
    assert_eq!(
        p.world.of("commands.register")[1]["params"]["id"],
        OTHER_COMMAND
    );
    let ran = p.request("command.run", json!({"id": OTHER_COMMAND, "args": []}));
    assert_eq!(ran["result"], "other ran");
    // Disposed: unregistered with Yavin, and no longer runnable.
    let after = p.ok(r#"
      T.other.dispose(); T.inner.dispose();
      try { await vscode.commands.executeCommand("probe.inner", 1, 1); return "still ran"; } catch (e) { return e.code; }
    "#);
    assert_eq!(after, "UnsupportedApi");
    p.settle();
    assert_eq!(
        p.world.of("commands.unregister")[0]["params"]["id"],
        OTHER_COMMAND
    );
    // A text editor command edits the active document through its edit builder.
    p.ok(r#"
      T.upper = vscode.commands.registerTextEditorCommand("probe.upper", (editor, edit) => {
        edit.replace(new vscode.Range(0, 0, 0, 5), editor.document.getText(new vscode.Range(0, 0, 0, 5)).toUpperCase());
      });
      await vscode.commands.executeCommand("probe.upper");
    "#);
    assert_eq!(p.world.docs[URI].text, "ALPHA beta\ngamma\n");
    // A handler that is not a function is refused at once.
    let error = p
        .step(r#"vscode.commands.registerCommand("probe.bad", 42);"#)
        .unwrap_err();
    assert!(
        error["message"].as_str().unwrap().contains("is a function"),
        "{error}"
    );
}

#[test]
fn messages_and_output_channels_say_what_they_were_given() {
    let mut p = Probe::start(World::new());
    let value = p.ok(r#"
      const picked = await vscode.window.showWarningMessage("Save?", "Yes", { title: "No" });
      await vscode.window.showErrorMessage("broken");
      const out = vscode.window.createOutputChannel("Probe");
      out.append("one "); out.append("two\nthree"); out.appendLine(" four");
      out.replace("five"); out.appendLine("");
      const log = vscode.window.createOutputChannel("Probe Log", { log: true });
      log.info("n=%d", 3); log.warn("careful"); log.error(new Error("bad"));
      return { picked: picked ?? "undefined", name: out.name, show: typeof out.show };
    "#);
    assert_eq!(
        value["picked"], "undefined",
        "no button can be chosen: as dismissed"
    );
    let shown: Vec<(String, String)> = p
        .world
        .of("window.showMessage")
        .iter()
        .map(|r| {
            (
                r["params"]["level"].as_str().unwrap().into(),
                r["params"]["message"].as_str().unwrap().into(),
            )
        })
        .collect();
    assert_eq!(
        shown,
        [
            (
                "warning".to_string(),
                "Save? [Yes, No: buttons are not supported]".to_string()
            ),
            ("error".to_string(), "broken".to_string()),
        ]
    );
    let lines: Vec<String> = p
        .world
        .logs
        .iter()
        .filter(|(_, t)| t.starts_with("[Probe"))
        .map(|(l, t)| format!("{l} {t}"))
        .collect();
    assert_eq!(
        lines,
        [
            "info [Probe] one two",
            "info [Probe] three four",
            "info [Probe] five",
            "info [Probe Log] n=3",
            "warn [Probe Log] careful",
            "error [Probe Log] bad",
        ]
    );
}

#[test]
fn status_bar_items_show_change_hide_and_run_their_commands() {
    let mut p = Probe::start(World::new());
    p.ok(r#"
      T.clicked = [];
      T.cmd = vscode.commands.registerCommand("probe.clicked", (...args) => T.clicked.push(args));
      T.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 7);
      T.item.text = "$(sync~spin) Syncing";
      T.item.tooltip = new vscode.MarkdownString("**now**");
      T.item.command = { command: "probe.clicked", title: "x", arguments: [1, "two"] };
    "#);
    assert!(p.world.status.is_empty(), "nothing is shown before show()");
    p.ok("T.item.show(); T.item.text = 'Synced'; T.item.text = 'Synced!';");
    p.settle();
    let sets = p.world.of("statusBar.set");
    assert_eq!(sets.len(), 1, "changes in one turn are sent once");
    let set = &sets[0]["params"];
    assert_eq!(set["text"], "Synced!");
    assert_eq!(set["tooltip"], "**now**");
    assert_eq!(set["alignment"], "right");
    assert_eq!(set["priority"], 7);
    assert_eq!(set["clickable"], true);
    let id = set["id"].as_str().unwrap().to_string();
    assert!(id.starts_with("acme.probe#status#"));
    // A codicon alone becomes the item's name.
    p.ok("T.item.name = 'Probe status'; T.item.text = '$(bell)';");
    p.settle();
    assert_eq!(p.world.status[&id]["text"], "Probe status");
    // Clicked in Yavin: its command, with its arguments.
    let clicked = p.request("statusBar.activate", json!({"id": id}));
    assert_eq!(clicked["ok"], true, "{clicked}");
    assert_eq!(p.ok("return T.clicked;"), json!([[1, "two"]]));
    // Hidden, then disposed: removed; a click on a removed item does nothing.
    p.ok("T.item.hide();");
    p.settle();
    assert!(p.world.status.is_empty());
    assert_eq!(
        p.request("statusBar.activate", json!({"id": "acme.probe#status#999"}))["result"],
        Value::Null
    );
    // A timed status message comes and goes (no sleep: its removal is awaited).
    p.ok("T.msg = vscode.window.setStatusBarMessage('Saved', 20);");
    p.settle();
    assert_eq!(p.world.status.len(), 1);
    p.ok("await new Promise((r) => setTimeout(r, 40));");
    p.settle();
    assert!(
        p.world.status.is_empty(),
        "the message was removed when its time was up"
    );
}

#[test]
fn the_active_editor_its_document_selection_and_edits() {
    let mut world = World::new();
    world.selection = json!({"startLine": 2, "startColumn": 2, "endLine": 2, "endColumn": 4});
    let mut p = Probe::start(world);
    let value = p.ok(r#"
      const e = vscode.window.activeTextEditor;
      const d = e.document;
      const word = d.getWordRangeAtPosition(new vscode.Position(0, 7));
      return {
        uri: d.uri.toString(), fsPath: d.fileName, lang: d.languageId, version: d.version, lines: d.lineCount,
        line1: d.lineAt(1).text, firstNonWs: d.lineAt(0).firstNonWhitespaceCharacterIndex,
        offset: d.offsetAt(new vscode.Position(1, 2)), pos: d.positionAt(13),
        word: d.getText(word), clamped: d.validatePosition(new vscode.Position(9, 99)),
        sel: [e.selection.start.line, e.selection.start.character, e.selection.end.line, e.selection.end.character],
        visible: vscode.window.visibleTextEditors.length,
        eol: d.eol, untitled: d.isUntitled, dirty: d.isDirty,
      };
    "#);
    assert_eq!(value["uri"], URI);
    assert_eq!(value["fsPath"], r"c:\work\notes.txt");
    assert_eq!(value["lang"], "plaintext");
    assert_eq!(value["version"], 1);
    assert_eq!(value["lines"], 3);
    assert_eq!(value["line1"], "gamma");
    assert_eq!(value["firstNonWs"], 0);
    assert_eq!(value["offset"], 13);
    assert_eq!(value["pos"], json!({"line": 1, "character": 2}));
    assert_eq!(value["word"], "beta");
    assert_eq!(value["clamped"], json!({"line": 2, "character": 0}));
    assert_eq!(
        value["sel"],
        json!([1, 1, 1, 3]),
        "the window's 1-based selection, 0-based"
    );
    assert_eq!(value["visible"], 1);
    assert_eq!(value["eol"], 1);
    // Setting the selection and revealing a range reach the window, 1-based.
    p.ok("const e = vscode.window.activeTextEditor; e.selection = new vscode.Selection(0, 1, 0, 4); e.revealRange(new vscode.Range(1, 0, 1, 1));");
    p.settle();
    assert_eq!(
        p.world.selection,
        json!({"startLine": 1, "startColumn": 2, "endLine": 1, "endColumn": 5})
    );
    assert_eq!(p.world.of("editor.revealRange").len(), 1);
    // An edit is one documents.edit, naming the version it was made on; the document reads
    // its new text and version after.
    let edited = p.ok(r#"
      const e = vscode.window.activeTextEditor;
      const ok = await e.edit((b) => { b.insert(new vscode.Position(0, 0), ">"); b.delete(new vscode.Range(1, 0, 1, 1)); });
      return { ok, text: e.document.getText(), version: e.document.version };
    "#);
    assert_eq!(
        edited,
        json!({"ok": true, "text": ">alpha beta\namma\n", "version": 2})
    );
    let edit = &p.world.of("documents.edit")[0]["params"];
    assert_eq!(edit["version"], 1);
    assert_eq!(edit["edits"].as_array().unwrap().len(), 2);
    // A document changed meanwhile: the window refuses; the extension is told false.
    p.world.stale = true;
    assert_eq!(p.ok("return await vscode.window.activeTextEditor.edit((b) => b.insert(new vscode.Position(0, 0), 'x'));"), false);
}

#[test]
fn workspace_edits_open_documents_and_files() {
    let mut world = World::new();
    world.open("file:///C:/work/b.txt", "b\n", "plaintext");
    let mut p = Probe::start(world);
    let value = p.ok(r#"
      const edit = new vscode.WorkspaceEdit();
      edit.replace(vscode.Uri.parse("file:///C:/work/notes.txt"), new vscode.Range(0, 0, 0, 5), "ALPHA");
      edit.insert(vscode.Uri.parse("file:///C:/work/b.txt"), new vscode.Position(0, 0), "a");
      const applied = await vscode.workspace.applyEdit(edit);
      const files = new vscode.WorkspaceEdit();
      files.createFile(vscode.Uri.parse("file:///C:/work/new.txt"));
      let refused;
      try { await vscode.workspace.applyEdit(files); } catch (e) { refused = e.message; }
      const open = await vscode.workspace.openTextDocument(vscode.Uri.parse("file:///C:/work/b.txt"));
      const disk = await vscode.workspace.openTextDocument(vscode.Uri.file("C:/work/readme.md"));
      let outside;
      try { await vscode.workspace.openTextDocument(vscode.Uri.file("C:/elsewhere/x.txt")); } catch (e) { outside = e.message; }
      let untitled;
      try { await vscode.workspace.openTextDocument({ content: "x" }); } catch (e) { untitled = e.code; }
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file("C:/work/readme.md"));
      let fsOutside;
      try { await vscode.workspace.fs.readFile(vscode.Uri.file("C:/elsewhere/x")); } catch (e) { fsOutside = e.code; }
      return { applied, refused, open: open.getText(), disk: disk.getText(), diskLang: disk.languageId, outside, untitled,
               bytes: new TextDecoder().decode(bytes), fsOutside, isUint8: bytes instanceof Uint8Array,
               docs: vscode.workspace.textDocuments.map((d) => d.uri.toString()).sort() };
    "#);
    assert_eq!(value["applied"], true);
    assert_eq!(p.world.docs[URI].text, "ALPHA beta\ngamma\n");
    assert_eq!(p.world.docs["file:///C:/work/b.txt"].text, "ab\n");
    unsupported(
        &json!({"message": value["refused"]}),
        "WorkspaceEdit file operations",
    );
    assert_eq!(
        p.world.of("documents.edit").len(),
        2,
        "the refused edit sent nothing"
    );
    assert_eq!(value["open"], "ab\n");
    assert_eq!(value["disk"], "# Read me");
    assert_eq!(value["diskLang"], "plaintext");
    assert!(value["outside"]
        .as_str()
        .unwrap()
        .contains("not in the workspace"));
    assert_eq!(value["untitled"], "UnsupportedApi");
    assert_eq!(value["bytes"], "# Read me");
    assert_eq!(value["isUint8"], true);
    assert_eq!(value["fsOutside"], "NoPermissions");
    assert_eq!(value["docs"], json!(["file:///C:/work/b.txt", URI]));
    // The workspace itself.
    let ws = p.ok(r#"
      const f = vscode.workspace.workspaceFolders;
      return { n: f.length, name: f[0].name, index: f[0].index, root: vscode.workspace.rootPath, wsName: vscode.workspace.name,
               inside: vscode.workspace.getWorkspaceFolder(vscode.Uri.file("C:/work/a/b.ts")) ? "yes" : "no",
               outside: vscode.workspace.getWorkspaceFolder(vscode.Uri.file("C:/x/b.ts")) ? "yes" : "no",
               rel: vscode.workspace.asRelativePath(vscode.Uri.file("C:/work/src/a.ts")),
               relWith: vscode.workspace.asRelativePath("C:/work/src/a.ts", true),
               relOut: vscode.workspace.asRelativePath("C:/x/a.ts"), trusted: vscode.workspace.isTrusted };
    "#);
    assert_eq!(
        ws,
        json!({"n": 1, "name": "work", "index": 0, "root": r"c:\work", "wsName": "work", "inside": "yes", "outside": "no",
                          "rel": "src/a.ts", "relWith": "work/src/a.ts", "relOut": "C:/x/a.ts", "trusted": true})
    );
}

#[test]
fn document_and_editor_events_arrive_in_order_with_their_documents() {
    let mut p = Probe::start(World::new());
    p.ok(r#"
      T.subs = [
        vscode.workspace.onDidOpenTextDocument((d) => T.events.push(["open", d.uri.toString(), d.getText()])),
        vscode.workspace.onDidChangeTextDocument((e) => T.events.push(["change", e.document.uri.toString(), e.contentChanges.length, e.contentChanges[0].text, e.contentChanges[0].rangeLength])),
        vscode.workspace.onDidCloseTextDocument((d) => T.events.push(["close", d.uri.toString(), d.isClosed])),
        vscode.window.onDidChangeActiveTextEditor((e) => T.events.push(["active", e ? e.document.uri.toString() : null])),
      ];
    "#);
    p.settle();
    let subscribed: Vec<&str> = p
        .world
        .of("events.subscribe")
        .iter()
        .map(|r| r["params"]["event"].as_str().unwrap())
        .collect();
    for event in [
        "documents.open",
        "documents.change",
        "documents.close",
        "editor.active",
    ] {
        assert!(subscribed.contains(&event), "{event}: {subscribed:?}");
    }
    let other = "file:///C:/work/other.md";
    p.world.open(other, "# other", "markdown");
    p.event("documents.open", p.world.info(other));
    p.world.docs.get_mut(other).unwrap().text = "# changed".into();
    p.world.docs.get_mut(other).unwrap().version = 2;
    p.event("documents.change", p.world.info(other));
    // A change event with the same text (a version bump only) fires nothing.
    p.world.docs.get_mut(other).unwrap().version = 3;
    p.event("documents.change", p.world.info(other));
    p.world.active = Some(other.into());
    p.event(
        "editor.active",
        json!({"document": p.world.info(other), "selection": p.world.selection}),
    );
    // The window agrees with its event: no active editor now.
    p.world.active = None;
    p.event("editor.active", Value::Null);
    let info = p.world.info(other);
    p.event("documents.close", info);
    let events =
        p.ok("return [T.events, vscode.workspace.textDocuments.map((d) => d.uri.toString())];");
    assert_eq!(
        events[0],
        json!([
            ["open", other, "# other"],
            ["change", other, 1, "# changed", 7],
            ["active", other],
            ["active", null],
            ["close", other, true],
        ])
    );
    assert_eq!(
        events[1],
        json!([URI]),
        "a closed document is no longer listed"
    );
    // Opened again (the same version): a document of its own again, open and listed.
    p.world.open(other, "# reopened", "markdown");
    p.event("documents.open", p.world.info(other));
    let reopened = p.ok("const d = vscode.workspace.textDocuments.find((d) => d.uri.toString().endsWith('other.md')); return d ? [d.isClosed, d.getText()] : 'not listed';");
    assert_eq!(reopened, json!([false, "# reopened"]));
    // Disposed listeners hear nothing more.
    p.ok("T.subs.forEach((s) => s.dispose()); T.events.length = 0;");
    p.world.open(other, "# again", "markdown");
    p.event("documents.open", p.world.info(other));
    assert_eq!(p.ok("return T.events;"), json!([]));
}

#[test]
fn configuration_reads_its_own_settings_and_hears_their_changes() {
    let mut p = Probe::start(World::new());
    let value = p.ok(r#"
      const c = vscode.workspace.getConfiguration("probe");
      return { mode: c.get("mode"), size: c.get("size"), deep: c.get("deep"), list: c.get("list"),
               missing: c.get("nothing", "fallback"), has: [c.has("mode"), c.has("nothing")],
               inspect: c.inspect("mode"), prop: c.mode, full: vscode.workspace.getConfiguration().get("probe.size"),
               editor: vscode.workspace.getConfiguration("editor").get("tabSize", 4) };
    "#);
    assert_eq!(value["mode"], "fast");
    assert_eq!(value["size"], 3);
    assert_eq!(
        value["deep"],
        json!({"flag": true}),
        "a section's settings as an object"
    );
    assert_eq!(
        value["list"],
        json!(["a", "b"]),
        "a list setting keeps its default"
    );
    assert_eq!(value["missing"], "fallback");
    assert_eq!(value["has"], json!([true, false]));
    assert_eq!(value["inspect"]["globalValue"], "fast");
    assert_eq!(value["prop"], "fast");
    assert_eq!(value["full"], 3);
    assert_eq!(value["editor"], 4);
    let said: Vec<&String> = p
        .world
        .logs
        .iter()
        .map(|(_, t)| t)
        .filter(|t| t.contains("is not available in Yavin"))
        .collect();
    assert_eq!(said.len(), 2, "each missing setting said once: {said:?}");
    // A change: the new value, and affectsConfiguration says which.
    p.ok("T.cfg = vscode.workspace.onDidChangeConfiguration((e) => T.events.push([e.affectsConfiguration('probe'), e.affectsConfiguration('probe.size'), e.affectsConfiguration('probe.mode'), e.affectsConfiguration('editor')]));");
    p.settle();
    p.event("configuration.changed", json!({"key": "size-2", "values": {"acme.probe.mode-1": "fast", "acme.probe.size-2": 9, "acme.probe.deep-3": true}}));
    let after = p.ok("return [T.events, vscode.workspace.getConfiguration('probe').get('size')];");
    assert_eq!(after, json!([[[true, true, false, false]], 9]));
    let update = p
        .step("await vscode.workspace.getConfiguration('probe').update('size', 1);")
        .unwrap_err();
    unsupported(&update, "WorkspaceConfiguration.update");
}

#[test]
fn language_providers_are_registered_invoked_converted_and_disposed() {
    let mut p = Probe::start(World::new());
    p.ok(r#"
      T.completion = vscode.languages.registerCompletionItemProvider(["plaintext", { language: "markdown" }], {
        provideCompletionItems(doc, pos, token, ctx) {
          T.seen = [doc.getText(new vscode.Range(pos.line, 0, pos.line, pos.character)), pos.line, pos.character, token.isCancellationRequested, ctx.triggerKind];
          const a = new vscode.CompletionItem("alpha", vscode.CompletionItemKind.Text);
          a.detail = "the first"; a.insertText = new vscode.SnippetString("alpha(${1:x})$0");
          const b = new vscode.CompletionItem({ label: "beta", description: "d" });
          return new vscode.CompletionList([a, b]);
        },
      });
      T.hover = vscode.languages.registerHoverProvider("plaintext", { provideHover: (d, p) => new vscode.Hover([new vscode.MarkdownString("**bold**"), { language: "js", value: "x()" }]) });
      T.def = vscode.languages.registerDefinitionProvider("plaintext", { provideDefinition: (d, p) => [
        new vscode.Location(vscode.Uri.parse("file:///C:/work/a.ts"), new vscode.Range(1, 2, 1, 5)),
        { targetUri: vscode.Uri.parse("file:///C:/work/b.ts"), targetRange: new vscode.Range(0, 0, 9, 0), targetSelectionRange: new vscode.Range(3, 1, 3, 4) } ] });
      T.refs = vscode.languages.registerReferenceProvider("plaintext", { provideReferences: (d, p, ctx) => { T.ctx = ctx.includeDeclaration; return [new vscode.Location(d.uri, new vscode.Position(0, 0))]; } });
      T.syms = vscode.languages.registerDocumentSymbolProvider("plaintext", { provideDocumentSymbols: (d) => {
        const top = new vscode.DocumentSymbol("Top", "class", vscode.SymbolKind.Class, new vscode.Range(0, 0, 1, 0), new vscode.Range(0, 0, 0, 3));
        top.children.push(new vscode.DocumentSymbol("inner", "", vscode.SymbolKind.Method, new vscode.Range(0, 4, 0, 9), new vscode.Range(0, 4, 0, 9)));
        return [top]; } });
      let none;
      try { vscode.languages.registerHoverProvider({ scheme: "file" }, {}); } catch (e) { none = e.message; }
      return none;
    "#);
    let registered: Vec<(String, String)> = p
        .world
        .providers
        .values()
        .map(|r| {
            (
                r["kind"].as_str().unwrap().into(),
                r["language"].as_str().unwrap().into(),
            )
        })
        .collect();
    assert_eq!(registered.len(), 6, "{registered:?}");
    assert!(registered.contains(&("completion".into(), "markdown".into())));
    assert!(registered.contains(&("completion".into(), "plaintext".into())));
    fn invoke(p: &mut Probe, kind: &str, position: Value) -> Value {
        let provider = p
            .world
            .providers
            .iter()
            .find(|(_, r)| r["kind"] == kind)
            .map(|(k, _)| k.clone())
            .unwrap();
        let document = p.world.info(URI);
        p.request("provider.invoke", json!({"providerId": provider, "kind": kind, "document": document, "position": position}))
    }
    let completion = invoke(&mut p, "completion", json!({"line": 1, "column": 6}));
    assert_eq!(
        completion["result"],
        json!([
            {"label": "alpha", "insertText": "alpha(x)", "detail": "the first"},
            {"label": "beta"},
        ])
    );
    assert_eq!(
        p.ok("return T.seen;"),
        json!(["alpha", 0, 5, false, 0]),
        "0-based, with the document's text"
    );
    let hover = invoke(&mut p, "hover", json!({"line": 1, "column": 1}));
    assert_eq!(
        hover["result"],
        json!({"contents": "**bold**\n\n```js\nx()\n```"})
    );
    let definition = invoke(&mut p, "definition", json!({"line": 1, "column": 1}));
    assert_eq!(
        definition["result"],
        json!([
            {"uri": "file:///C:/work/a.ts", "range": {"startLine": 2, "startColumn": 3, "endLine": 2, "endColumn": 6}},
            {"uri": "file:///C:/work/b.ts", "range": {"startLine": 4, "startColumn": 2, "endLine": 4, "endColumn": 5}},
        ])
    );
    let references = invoke(&mut p, "references", json!({"line": 1, "column": 1}));
    assert_eq!(references["result"][0]["uri"], URI);
    assert_eq!(p.ok("return T.ctx;"), true);
    let symbols = invoke(&mut p, "symbols", Value::Null);
    assert_eq!(
        symbols["result"],
        json!([
            {"name": "Top", "detail": "class", "range": {"startLine": 1, "startColumn": 1, "endLine": 2, "endColumn": 1}},
            {"name": "inner", "range": {"startLine": 1, "startColumn": 5, "endLine": 1, "endColumn": 10}},
        ])
    );
    // A provider that throws: the error comes back, the host carries on.
    p.ok("T.bad = vscode.languages.registerHoverProvider('markdown', { provideHover() { throw new Error('provider broke'); } });");
    p.settle();
    let bad = p
        .world
        .providers
        .iter()
        .find(|(_, r)| r["kind"] == "hover" && r["language"] == "markdown")
        .map(|(k, _)| k.clone())
        .unwrap();
    let failed = p.request("provider.invoke", json!({"providerId": bad, "kind": "hover", "document": p.world.info(URI), "position": {"line": 1, "column": 1}}));
    assert_eq!(failed["ok"], false);
    assert!(failed["error"]["message"]
        .as_str()
        .unwrap()
        .contains("provider broke"));
    // Disposed: unregistered, every language of it.
    p.ok("for (const k of ['completion', 'hover', 'def', 'refs', 'syms', 'bad']) T[k].dispose();");
    p.settle();
    assert!(
        p.world.providers.is_empty(),
        "{:?}",
        p.world.providers.keys()
    );
}

#[test]
fn diagnostics_go_to_the_problems_store_and_are_cleared() {
    let mut p = Probe::start(World::new());
    let value = p.ok(r#"
      const c = vscode.languages.createDiagnosticCollection("probe");
      T.diag = c;
      const u = vscode.Uri.parse("file:///C:/work/notes.txt");
      const e = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 5), "bad word", vscode.DiagnosticSeverity.Error); e.source = "lint";
      const w = new vscode.Diagnostic(new vscode.Range(1, 0, 1, 2), "meh", vscode.DiagnosticSeverity.Warning);
      const h = new vscode.Diagnostic(new vscode.Range(1, 3, 1, 4), "hint", vscode.DiagnosticSeverity.Hint);
      c.set(u, [e, w, h]);
      c.set([[vscode.Uri.parse("file:///C:/work/b.txt"), [w]]]);
      const seen = []; c.forEach((uri, list) => seen.push([uri.toString(), list.length]));
      return { name: c.name, has: c.has(u), count: c.get(u).length, seen };
    "#);
    assert_eq!(value["name"], "probe");
    assert_eq!(value["has"], true);
    assert_eq!(value["count"], 3);
    assert_eq!(
        value["seen"],
        json!([[URI, 3], ["file:///C:/work/b.txt", 1]])
    );
    p.settle();
    let sets = asked(&p, "diagnostics.set");
    assert_eq!(sets.len(), 1, "one turn's sets: one request");
    let collection = sets[0]["collection"].as_str().unwrap().to_string();
    assert!(
        collection.starts_with("acme.probe#diagnostics#"),
        "{collection}"
    );
    assert_eq!(sets[0]["name"], "probe");
    assert_eq!(
        sets[0]["entries"],
        json!([
            {"uri": URI, "diagnostics": [
                {"range": {"startLine": 1, "startColumn": 1, "endLine": 1, "endColumn": 6}, "message": "bad word", "severity": "error", "source": "lint"},
                {"range": {"startLine": 2, "startColumn": 1, "endLine": 2, "endColumn": 3}, "message": "meh", "severity": "warning"},
                {"range": {"startLine": 2, "startColumn": 4, "endLine": 2, "endColumn": 5}, "message": "hint", "severity": "hint"},
            ]},
            {"uri": "file:///C:/work/b.txt", "diagnostics": [
                {"range": {"startLine": 2, "startColumn": 1, "endLine": 2, "endColumn": 3}, "message": "meh", "severity": "warning"},
            ]},
        ])
    );
    assert!(
        p.world.decorations.is_empty(),
        "no decorations of their own any more"
    );
    p.ok("T.diag.delete(vscode.Uri.parse('file:///C:/work/notes.txt'));");
    p.settle();
    let sets = asked(&p, "diagnostics.set");
    assert_eq!(
        sets[1]["entries"],
        json!([{"uri": URI, "diagnostics": []}]),
        "delete: that file's problems are emptied"
    );
    p.ok("T.diag.dispose();");
    p.settle();
    let clears = asked(&p, "diagnostics.clear");
    assert_eq!(clears.len(), 1);
    assert_eq!(clears[0]["collection"], json!(collection));
}

/// The params of what the extension asked by `method`, in order.
fn asked(p: &Probe, method: &str) -> Vec<Value> {
    p.world
        .of(method)
        .iter()
        .map(|r| r["params"].clone())
        .collect()
}

#[test]
fn tree_views_register_give_rows_refresh_and_dispose() {
    let mut p = Probe::start(World::new());
    p.ok(r#"
      const emitter = new vscode.EventEmitter();
      T.emitter = emitter;
      T.label = "Root";
      T.view = vscode.window.createTreeView("probe.tree", { treeDataProvider: {
        onDidChangeTreeData: emitter.event,
        getChildren(element) {
          if (!element) return ["root", "leaf"];
          if (element === "root") return ["child"];
          return [];
        },
        getTreeItem(element) {
          if (element === "root") { const t = new vscode.TreeItem(T.label, vscode.TreeItemCollapsibleState.Expanded); t.description = "d"; t.tooltip = new vscode.MarkdownString("tip"); return t; }
          if (element === "child") { const t = new vscode.TreeItem(vscode.Uri.file("C:/work/child.ts")); t.command = { command: "probe.other", title: "go" }; return t; }
          const t = new vscode.TreeItem("leaf"); t.command = { command: "probe.other", title: "go", arguments: [1] }; return t;
        },
      } });
      let unknown;
      try { vscode.window.registerTreeDataProvider("not.contributed", { getChildren: () => [], getTreeItem: (e) => e }); } catch (e) { unknown = e.code; }
      return unknown;
    "#);
    assert_eq!(p.world.views, [VIEW]);
    let rows = p.request("view.items", json!({"id": VIEW}));
    assert_eq!(
        rows["result"],
        json!([
            {"label": "Root", "description": "d", "tooltip": "tip", "children": [{"label": "child.ts", "command": OTHER_COMMAND}]},
            {"label": "leaf"},
        ]),
        "a row runs only a contributed command without arguments"
    );
    p.ok("T.label = 'Root 2'; T.emitter.fire();");
    p.settle();
    assert_eq!(p.world.of("views.refresh").len(), 1);
    assert_eq!(
        p.request("view.items", json!({"id": VIEW}))["result"][0]["label"],
        "Root 2"
    );
    let reveal = p.step("await T.view.reveal('root');").unwrap_err();
    unsupported(&reveal, "TreeView.reveal");
    p.ok("T.view.dispose();");
    p.settle();
    assert!(p.world.views.is_empty());
}

#[test]
fn decoration_types_map_to_yavins_styles_and_are_removed_when_disposed() {
    let mut p = Probe::start(World::new());
    p.ok(r#"
      const e = vscode.window.activeTextEditor;
      T.types = [
        vscode.window.createTextEditorDecorationType({ backgroundColor: "rgba(255,0,0,0.3)" }),
        vscode.window.createTextEditorDecorationType({ textDecoration: "underline wavy" }),
        vscode.window.createTextEditorDecorationType({ opacity: "0.5" }),
      ];
      e.setDecorations(T.types[0], [new vscode.Range(0, 0, 0, 5)]);
      e.setDecorations(T.types[1], [{ range: new vscode.Range(1, 0, 1, 1), hoverMessage: new vscode.MarkdownString("why") }]);
      e.setDecorations(T.types[2], [new vscode.Range(0, 6, 0, 10)]);
    "#);
    p.settle();
    let styles: Vec<(String, Value)> = p
        .world
        .decorations
        .iter()
        .map(|((_, k), v)| (k.clone(), v.clone()))
        .collect();
    assert_eq!(styles.len(), 3);
    let style_of = |n: usize| styles[n].1[0]["style"].clone();
    assert_eq!(
        [style_of(0), style_of(1), style_of(2)],
        [json!("highlight"), json!("underline-info"), json!("dimmed")]
    );
    assert_eq!(styles[1].1[0]["hover"], "why");
    p.ok("T.types.forEach((t) => t.dispose());");
    p.settle();
    assert!(p.world.decorations.values().all(|v| v == &json!([])));
}

#[test]
fn context_state_secrets_paths_and_deactivation() {
    let mut p = Probe::start(World::new());
    let value = p.ok(r#"
      const c = context;
      await c.globalState.update("count", 2);
      await c.globalState.update("seen", undefined);
      await c.secrets.store("token", "s3cret");
      const secret = await c.secrets.get("token");
      const gone = await c.secrets.get("never");
      await c.secrets.delete("token");
      let storage;
      try { c.globalStorageUri; } catch (e) { storage = e.code; }
      return { count: c.globalState.get("count"), fallback: c.globalState.get("absent", 7), keys: c.globalState.keys().sort(),
               local: c.workspaceState.get("local"), secret, gone: gone ?? "undefined", storage,
               path: c.extensionPath, abs: c.asAbsolutePath("media/a.png"), uri: c.extensionUri.fsPath, mode: c.extensionMode,
               own: vscode.extensions.getExtension("acme.probe") && vscode.extensions.getExtension("Acme.Probe").packageJSON.version === "1.0.0" ? "own" : "none", other: vscode.extensions.getExtension("ms-python.python") ?? "undefined" };
    "#);
    assert_eq!(value["count"], 2);
    assert_eq!(value["fallback"], 7);
    assert_eq!(value["keys"], json!(["count"]));
    assert_eq!(value["local"], true);
    assert_eq!(value["secret"], "s3cret");
    assert_eq!(value["gone"], "undefined");
    assert_eq!(value["storage"], "UnsupportedApi");
    assert_eq!(value["path"], r"C:\ext\acme.probe\extension");
    assert_eq!(value["abs"], r"C:\ext\acme.probe\extension\media\a.png");
    assert_eq!(value["uri"], r"c:\ext\acme.probe\extension");
    assert_eq!(value["mode"], 1);
    assert_eq!(value["other"], "undefined");
    assert_eq!(
        value["own"], "own",
        "found by its published id, case-insensitively"
    );
    // The window kept what was stored, scoped as asked.
    let updates: Vec<(String, String)> = p
        .world
        .of("storage.update")
        .iter()
        .map(|r| {
            (
                r["params"]["scope"].as_str().unwrap().into(),
                r["params"]["key"].as_str().unwrap().into(),
            )
        })
        .collect();
    assert_eq!(
        updates,
        [
            ("global".to_string(), "count".to_string()),
            ("global".to_string(), "seen".to_string())
        ]
    );
    assert!(p
        .world
        .of("secrets.store")
        .iter()
        .all(|r| r["params"]["scope"] == "installation"));
    assert!(p.world.secrets.is_empty(), "deleted");
    // Deactivation: deactivate() runs, subscriptions are disposed newest first.
    p.ok("T.order = []; context.subscriptions.push({ dispose: () => T.order.push('first') }, { dispose: () => T.order.push('second') });");
    let done = p.request("deactivate", json!({}));
    assert_eq!(done["ok"], true);
    assert_eq!(done["result"]["disposeErrors"], json!([]));
    p.settle_after_deactivate();
}

impl Probe {
    /// After deactivation the probe's command is gone; what it recorded is read directly.
    fn settle_after_deactivate(&mut self) {
        let unregistered: Vec<&str> = self
            .world
            .of("commands.unregister")
            .iter()
            .map(|r| r["params"]["id"].as_str().unwrap())
            .collect();
        assert_eq!(
            unregistered,
            [PROBE],
            "the probe's own subscription was disposed"
        );
    }
}

#[test]
fn window_state_follows_the_windows_focus_and_fires_only_on_change() {
    let mut p = Probe::start(World::new());
    assert_eq!(
        p.world.of("window.state").len(),
        1,
        "read once, at activation"
    );
    p.ok("T.states = []; T.sub = vscode.window.onDidChangeWindowState((s) => T.states.push([s.focused, s.active]));");
    assert_eq!(
        p.ok("return vscode.window.state;"),
        json!({"focused": true, "active": true})
    );
    p.event("window.state", json!({"focused": false}));
    p.event("window.state", json!({"focused": false}));
    p.event("window.state", json!({"focused": true}));
    p.event("window.state", json!({"bogus": 1}));
    assert_eq!(
        p.ok("return [T.states, vscode.window.state.focused];"),
        json!([[[false, false], [true, true]], true])
    );
    p.ok("T.sub.dispose();");
    p.event("window.state", json!({"focused": false}));
    assert_eq!(
        p.ok("return [T.states.length, vscode.window.state.focused];"),
        json!([2, false]),
        "disposed: not called; the state still follows"
    );
    // A window that does not report its focus: deterministic, never invented.
    let mut world = World::new();
    world.focused = None;
    let mut q = Probe::start(world);
    unsupported(
        &q.step("return vscode.window.state;").unwrap_err(),
        "window.state",
    );
}

#[test]
fn a_refused_permission_is_deterministic_and_said() {
    let mut world = World::new();
    world.denied = vec!["documents.getText", "editor.active", "documents.all"];
    let mut p = Probe::start(world);
    let value = p.ok("return [vscode.window.activeTextEditor === undefined, vscode.workspace.textDocuments.length];");
    assert_eq!(
        value,
        json!([true, 0]),
        "without documents.read: no editor, no documents"
    );
    let asked = p.world.of("editor.active").len();
    p.ok("return vscode.window.activeTextEditor;");
    assert_eq!(
        p.world.of("editor.active").len(),
        asked,
        "a refusal is not asked again at once"
    );
    // An edit refused natively fails the command with the refusal.
    let mut world = World::new();
    world.denied = vec!["documents.edit"];
    let mut q = Probe::start(world);
    let error = q.step("return await vscode.window.activeTextEditor.edit((b) => b.insert(new vscode.Position(0, 0), 'x'));").unwrap_err();
    assert!(
        error["message"].as_str().unwrap().contains("not allowed"),
        "{error}"
    );
}

#[test]
fn values_and_utilities_behave_as_vs_codes() {
    let mut p = Probe::start(World::new());
    let value = p.ok(r#"
      const u = vscode.Uri.parse("file:///C:/work/a%20b.ts?x=1#frag");
      const f = vscode.Uri.file("C:\\work\\src\\x.ts");
      const r = new vscode.Range(2, 5, 1, 0);
      const s = new vscode.Selection(3, 4, 1, 2);
      const em = new vscode.EventEmitter(); const got = []; const sub = em.event((x) => got.push(x)); em.fire(1); sub.dispose(); em.fire(2);
      let disposed = 0; vscode.Disposable.from({ dispose: () => disposed++ }, { dispose: () => disposed++ }).dispose();
      const cts = new vscode.CancellationTokenSource(); let cancelled = 0; cts.token.onCancellationRequested(() => cancelled++); cts.cancel(); cts.cancel();
      const md = new vscode.MarkdownString("a").appendText("*b*").appendCodeblock("c", "js");
      const sn = new vscode.SnippetString("x").appendPlaceholder("y").appendTabstop().appendChoice(["p", "q"]);
      let progress;
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "t" }, async (p, token) => { p.report({ message: "half" }); progress = token.isCancellationRequested; return 42; });
      return {
        uri: [u.scheme, u.path, u.query, u.fragment, u.fsPath, u.toString()],
        file: [f.path, f.fsPath, f.toString(), vscode.Uri.joinPath(f, "..", "y.ts").path, f.with({ path: "/C:/z.ts" }).fsPath],
        range: [r.start.line, r.end.line, r.isSingleLine, r.contains(new vscode.Position(1, 5)), r.intersection(new vscode.Range(0, 0, 1, 1)).end.character],
        sel: [s.isReversed, s.anchor.line, s.active.line], pos: new vscode.Position(1, 1).translate(1, -1).compareTo(new vscode.Position(2, 0)),
        emitted: got, disposed, cancelled, md: md.value, sn: sn.value, result, progress,
        env: [vscode.env.appName, vscode.env.language, vscode.env.uiKind, vscode.env.isTelemetryEnabled],
        l10n: [vscode.l10n.t("Hi {0} and {1}", "a", "b"), vscode.l10n.t("Hi {name}", { name: "n" }), vscode.l10n.t({ message: "{0}!", args: ["x"], comment: "c" })],
        version: vscode.version,
      };
    "#);
    assert_eq!(
        value["uri"],
        json!([
            "file",
            "/C:/work/a b.ts",
            "x=1",
            "frag",
            r"c:\work\a b.ts",
            "file:///C:/work/a%20b.ts?x%3D1#frag"
        ])
    );
    assert_eq!(
        value["file"],
        json!([
            "/C:/work/src/x.ts",
            r"c:\work\src\x.ts",
            "file:///C:/work/src/x.ts",
            "/C:/work/src/y.ts",
            r"c:\z.ts"
        ])
    );
    assert_eq!(
        value["range"],
        json!([1, 2, false, true, 1]),
        "a range orders its ends"
    );
    assert_eq!(value["sel"], json!([true, 3, 1]));
    assert_eq!(value["pos"], 0);
    assert_eq!(value["emitted"], json!([1]));
    assert_eq!(value["disposed"], 2);
    assert_eq!(value["cancelled"], 1, "cancelled once");
    assert_eq!(value["md"], "a\\*b\\*\n```js\nc\n```\n");
    assert_eq!(value["sn"], "x${1:y}$2${3|p,q|}");
    assert_eq!(value["result"], 42);
    assert_eq!(value["progress"], false);
    assert_eq!(value["env"], json!(["Yavin IDE", "en", 1, false]));
    assert_eq!(value["l10n"], json!(["Hi a and b", "Hi n", "x!"]));
    assert_eq!(value["version"], "1.90.0");
}

#[test]
fn the_remaining_members_do_what_they_say() {
    let mut world = World::new();
    world.open("file:///C:/work/b.txt", "b\n", "plaintext");
    let mut p = Probe::start(world);
    let value = p.ok(r#"
      T.never = 0;
      const subs = [vscode.workspace.onDidGrantWorkspaceTrust(() => T.never++), vscode.workspace.onDidChangeWorkspaceFolders(() => T.never++), vscode.env.onDidChangeTelemetryEnabled(() => T.never++)];
      T.visible = [];
      T.vis = vscode.window.onDidChangeVisibleTextEditors((editors) => T.visible.push(editors.map((e) => e.document.uri.toString())));
      const shown = await vscode.window.showTextDocument(vscode.Uri.parse("file:///C:/work/b.txt"), { selection: new vscode.Range(0, 1, 0, 1) });
      const assert = require("assert");
      const asserted = [];
      for (const run of [() => assert.ok(1), () => assert.strictEqual(1, 1), () => assert.deepStrictEqual({ a: [1] }, { a: [1] }), () => assert.equal(1, 2), () => assert.fail("no")]) {
        try { run(); asserted.push("ok"); } catch (e) { asserted.push(e.code); }
      }
      const url = require("url");
      console.log("from console", 2);
      const doc = vscode.window.activeTextEditor.document;
      return {
        match: [vscode.languages.match("plaintext", doc), vscode.languages.match(["markdown", { language: "*" }], doc), vscode.languages.match("markdown", doc)],
        all: vscode.extensions.all.map((e) => e.id), writable: [vscode.workspace.fs.isWritableFileSystem("file"), vscode.workspace.fs.isWritableFileSystem("x") ?? "undefined"],
        scheme: vscode.env.uriScheme, subs: subs.every((s) => typeof s.dispose === "function"),
        shown: shown ? shown.document.uri.toString() : null, asserted,
        url: [url.fileURLToPath("file:///C:/work/a%20b.ts"), url.pathToFileURL("C:\\work\\c.ts").href],
      };
    "#);
    assert_eq!(value["match"], json!([10, 5, 0]));
    assert_eq!(
        value["all"],
        json!(["Acme.probe"]),
        "its own only, by its published id"
    );
    assert_eq!(value["writable"], json!([false, "undefined"]));
    assert_eq!(value["scheme"], "yavin");
    assert_eq!(value["subs"], true);
    assert_eq!(
        value["asserted"],
        json!(["ok", "ok", "ok", "ERR_ASSERTION", "ERR_ASSERTION"])
    );
    // As Node.js answers (EXT-28: the drive keeps its case; EXT-27's layer lower-cased it).
    assert_eq!(
        value["url"],
        json!([r"C:\work\a b.ts", "file:///C:/work/c.ts"])
    );
    // showTextDocument opened it through the window (1-based selection) and returned its editor.
    let open = &p.world.of("editor.openLocation")[0]["params"];
    assert_eq!(open["uri"], "file:///C:/work/b.txt");
    assert_eq!(
        open["range"],
        json!({"startLine": 1, "startColumn": 2, "endLine": 1, "endColumn": 2})
    );
    assert!(
        p.world
            .logs
            .iter()
            .any(|(level, text)| level == "info" && text == "from console 2"),
        "{:?}",
        p.world.logs
    );
    // The window's editor changes: the visible editors with it.
    p.world.active = Some("file:///C:/work/b.txt".into());
    let info = p.world.info("file:///C:/work/b.txt");
    p.event(
        "editor.active",
        json!({"document": info, "selection": p.world.selection}),
    );
    p.world.active = None;
    p.event("editor.active", Value::Null);
    assert_eq!(
        p.ok("return [T.visible, T.never];"),
        json!([[["file:///C:/work/b.txt"], []], 0])
    );
}
