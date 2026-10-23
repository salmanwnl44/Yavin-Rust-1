//! EXT-29: VS Code's pickers, file watchers, save and selection events, diagnostics and
//! formatting and code-action providers, in the real extension host (QuickJS in its own process,
//! the real bootstrap and layer), under the production limits. A fake window answers the layer's
//! requests and records them: each test asserts what the extension saw and what it asked Yavin.
mod common;

use common::Host;
use serde_json::{json, Value};

const EXT: &str = "acme.core";
const MAIN: &str = "extension/out/main.js";

/// The extension: a command that runs a step (`vscode`, `T` kept between steps) and returns its
/// value as JSON.
const CODE: &str = r#"
const vscode = require("vscode");
globalThis.T = {};
exports.activate = function (context) {
  T.context = context;
  context.subscriptions.push(vscode.commands.registerCommand("probe.run", async (step) => {
    const value = await new Function("vscode", "T", "return (async () => {" + step + "})()")(vscode, T);
    return value === undefined ? null : JSON.parse(JSON.stringify(value));
  }));
};
"#;

const DOC_URI: &str = "file:///c%3A/work/notes.md";

fn doc_info(version: u64) -> Value {
    json!({"uri": DOC_URI, "resourceId": "file:///c:/work/notes.md", "languageId": "markdown", "version": version, "source": "disk", "dirty": false})
}

/// What the fake window answers, and what it was asked.
struct Window {
    requests: Vec<Value>,
    logs: Vec<String>,
    /// The next answers to `window.quickPick` / `window.inputBox`.
    pick: Value,
    input: Value,
    /// Requests by these methods are kept unanswered (in `held`), as a prompt the user has open.
    hold: Vec<&'static str>,
    held: Vec<Value>,
}

impl Window {
    fn answer(&mut self, method: &str, params: &Value) -> Value {
        match method {
            "documents.all" => json!([doc_info(1)]),
            "documents.get" => doc_info(1),
            "documents.getText" => json!("# Title\nbad line\n"),
            "editor.active" => {
                json!({"document": doc_info(1), "selection": {"startLine": 1, "startColumn": 1, "endLine": 1, "endColumn": 1}})
            }
            "window.state" => json!({"focused": true}),
            "window.quickPick" => self.pick.clone(),
            "window.inputBox" => self.input.clone(),
            "documents.edit" => json!(true),
            // EXT-31: a panel is shown; a message is delivered.
            "webview.postMessage" => json!(true),
            _ => {
                let _ = params;
                Value::Null
            }
        }
    }
}

struct Ext {
    host: Host,
    next: u32,
    window: Window,
}

impl Ext {
    fn start() -> Ext {
        let mut host = Host::start_with(
            json!({"memoryBytes": 64 * 1024 * 1024, "loadMs": 5000, "callMs": 2000}),
        );
        host.to(
            EXT,
            json!({"type": "load", "code": CODE, "extensionPath": "C:/ext/acme.core", "main": MAIN,
                "modules": {"extension/package.json": r#"{"publisher": "Acme", "name": "core", "version": "1.0.0"}"#},
                "vscode": {"api": "vscode", "level": "1.90.0", "entry": "main", "commands": {"acme.core.run-0001": "probe.run"}, "settings": {}, "views": {}, "defaults": {}}}),
        );
        let loaded = host.until(|m| m["type"] == "loaded" || m["type"] == "error");
        assert_eq!(loaded["type"], "loaded", "{loaded}");
        let mut ext = Ext {
            host,
            next: 1,
            window: Window {
                requests: Vec::new(),
                logs: Vec::new(),
                pick: Value::Null,
                input: Value::Null,
                hold: Vec::new(),
                held: Vec::new(),
            },
        };
        let activated = ext.request("activate", json!({}));
        assert_eq!(activated["ok"], true, "{activated}");
        ext
    }
    /// Sends `method` to the extension and answers its requests until the response.
    fn request(&mut self, method: &str, params: Value) -> Value {
        let id = format!("r{}", self.next);
        self.next += 1;
        self.host.to(
            EXT,
            json!({"type": "request", "requestId": id, "method": method, "params": params}),
        );
        self.pump(Some(&id)).unwrap()
    }
    fn pump(&mut self, id: Option<&str>) -> Option<Value> {
        loop {
            if let Some(answer) = self.pump_one(id) {
                return Some(answer);
            }
        }
    }
    /// Handles the next message: answers a request (or keeps it, if held), keeps a log; returns
    /// the response to `id` (any response, for `*`), or an error, when that is the message.
    fn pump_one(&mut self, id: Option<&str>) -> Option<Value> {
        let message = self.host.recv();
        match message["type"].as_str() {
            Some("request") => {
                let method = message["method"].as_str().unwrap_or("").to_string();
                if self.window.hold.contains(&method.as_str()) {
                    self.window.held.push(message);
                    return None;
                }
                let result = self.window.answer(&method, &message["params"]);
                self.window.requests.push(message.clone());
                self.host.to(EXT, json!({"type": "response", "requestId": message["requestId"], "ok": true, "result": result}));
                None
            }
            Some("log") => {
                self.window
                    .logs
                    .push(message["text"].as_str().unwrap_or("").to_string());
                None
            }
            Some("response")
                if id.is_some_and(|id| id == "*" || message["requestId"] == json!(id)) =>
            {
                Some(message)
            }
            Some("error") if id.is_some() => Some(json!({"ok": false, "error": message["error"]})),
            _ => None,
        }
    }
    fn step(&mut self, code: &str) -> Value {
        let response = self.request(
            "command.run",
            json!({"id": "acme.core.run-0001", "args": [code]}),
        );
        assert_eq!(response["ok"], true, "the step failed: {response}\n{code}");
        response["result"].clone()
    }
    fn event(&mut self, event: &str, payload: Value) {
        self.host.to(
            EXT,
            json!({"type": "event", "event": event, "payload": payload}),
        );
    }
    /// What the extension asked by `method`, in order.
    fn asked(&self, method: &str) -> Vec<Value> {
        self.window
            .requests
            .iter()
            .filter(|r| r["method"] == method)
            .map(|r| r["params"].clone())
            .collect()
    }
}

#[test]
fn quick_pick_and_input_box_ask_the_window_with_an_owned_id_and_return_what_it_answers() {
    let mut e = Ext::start();
    e.window.pick = json!(2);
    let picked = e.step(
        r#"return await vscode.window.showQuickPick(["a", { label: "b", description: "d", detail: "x", picked: true }, "c", { label: "sep", kind: vscode.QuickPickItemKind.Separator }], { title: "T", placeHolder: "P", matchOnDetail: true, ignoreFocusOut: true });"#,
    );
    assert_eq!(picked, "c");
    let asked = &e.asked("window.quickPick")[0];
    assert!(asked["id"]
        .as_str()
        .unwrap()
        .starts_with("acme.core#prompt#"));
    assert_eq!(asked["title"], "T");
    assert_eq!(asked["placeHolder"], "P");
    assert_eq!(asked["matchOnDetail"], true);
    assert_eq!(asked["ignoreFocusOut"], true);
    assert_eq!(asked["canPickMany"], false);
    assert_eq!(
        asked["items"],
        json!([{"label": "a"}, {"label": "b", "description": "d", "detail": "x", "picked": true}, {"label": "c"}, {"label": "sep", "separator": true}])
    );
    // A separator, an index past the end, or something else: no item.
    for answer in [json!(3), json!(9), json!("c"), Value::Null] {
        e.window.pick = answer.clone();
        assert_eq!(
            e.step(r#"return (await vscode.window.showQuickPick(["a", "b", "c", { label: "s", kind: -1 }])) ?? "none";"#),
            "none",
            "{answer}"
        );
    }
    e.window.pick = json!([0, 2, 7]);
    assert_eq!(
        e.step(r#"return await vscode.window.showQuickPick(Promise.resolve(["a", "b", "c"]), { canPickMany: true });"#),
        json!(["a", "c"]),
        "the items checked (a promise of items too)"
    );
    // The input box: its options as asked, and the window's answer.
    e.window.input = json!("typed");
    assert_eq!(
        e.step(r#"return await vscode.window.showInputBox({ value: "v", valueSelection: [0, 1], password: true, prompt: "Pr" });"#),
        "typed"
    );
    let asked = &e.asked("window.inputBox")[0];
    assert_eq!(asked["value"], "v");
    assert_eq!(asked["valueSelection"], json!([0, 1]));
    assert_eq!(asked["password"], true);
    assert_eq!(asked["prompt"], "Pr");
    assert_eq!(asked["validates"], false);
    e.window.input = Value::Null;
    assert_eq!(
        e.step(r#"return (await vscode.window.showInputBox({})) ?? "cancelled";"#),
        "cancelled"
    );
    // A token cancelled before the items are ready: the window is never asked.
    let before = e.asked("window.quickPick").len();
    assert_eq!(
        e.step(r#"const s = new vscode.CancellationTokenSource(); const p = vscode.window.showQuickPick(["a"], {}, s.token); s.cancel(); return (await p) ?? "none";"#),
        "none"
    );
    assert_eq!(e.asked("window.quickPick").len(), before);
    // Cancelled while the picker is open: the window is told to close that prompt, and the
    // window's late answer is not taken.
    e.window.hold = vec!["window.quickPick"];
    e.step(r#"T.s = new vscode.CancellationTokenSource(); T.p = vscode.window.showQuickPick(["a"], {}, T.s.token);"#);
    while e.window.held.is_empty() {
        e.pump_one(None);
    }
    let open = e.window.held.remove(0);
    e.step("T.s.cancel();");
    assert_eq!(e.step(r#"return (await T.p) ?? "none";"#), "none");
    let cancels = e.asked("window.cancelPrompt");
    assert_eq!(cancels.len(), 1);
    assert_eq!(cancels[0]["id"], open["params"]["id"]);
    e.host.to(
        EXT,
        json!({"type": "response", "requestId": open["requestId"], "ok": true, "result": 0}),
    );
    assert_eq!(e.step(r#"return (await T.p) ?? "none";"#), "none");
}

#[test]
fn input_validation_is_answered_by_the_extension_while_the_box_is_open() {
    let mut e = Ext::start();
    e.window.hold = vec!["window.inputBox"];
    // The window asks the validation while its box is open: answered from the pending box.
    e.step(
        r#"T.box = vscode.window.showInputBox({ validateInput: (v) => v === "" ? "required" : v.length < 3 ? { message: "short", severity: vscode.InputBoxValidationSeverity.Info } : undefined });"#,
    );
    while e.window.held.is_empty() {
        e.pump_one(None);
    }
    let message = e.window.held.remove(0);
    let id = message["params"]["id"].as_str().unwrap().to_string();
    assert_eq!(message["params"]["validates"], true);
    let mut ask = |value: &str| {
        e.request("prompt.validate", json!({"id": id, "value": value}))["result"].clone()
    };
    assert_eq!(ask(""), json!({"message": "required", "severity": "error"}));
    assert_eq!(ask("ab"), json!({"message": "short", "severity": "info"}));
    assert_eq!(ask("abc"), Value::Null);
    // Another id (not a box of this extension's): nothing to validate.
    assert_eq!(
        e.request(
            "prompt.validate",
            json!({"id": "acme.core#prompt#999", "value": ""})
        )["result"],
        Value::Null
    );
    e.host.to(
        EXT,
        json!({"type": "response", "requestId": message["requestId"], "ok": true, "result": "abc"}),
    );
    assert_eq!(e.step("return await T.box;"), "abc");
}

#[test]
fn diagnostics_go_to_the_window_in_batches_of_the_collection_owned_by_the_extension() {
    let mut e = Ext::start();
    e.step(
        r#"T.d = vscode.languages.createDiagnosticCollection("lint");
        const a = new vscode.Diagnostic(new vscode.Range(1, 0, 1, 3), "bad", vscode.DiagnosticSeverity.Warning);
        a.source = "lint"; a.code = { value: "MD001", target: vscode.Uri.parse("https://example.com") }; a.tags = [vscode.DiagnosticTag.Deprecated, 99];
        a.relatedInformation = [new vscode.DiagnosticRelatedInformation(new vscode.Location(vscode.Uri.file("C:/work/b.md"), new vscode.Range(0, 0, 0, 1)), "there")];
        const many = [];
        for (let i = 0; i < 250; i++) many.push([vscode.Uri.file("C:/work/f" + i + ".md"), [new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), "m" + i)]]);
        T.d.set(vscode.Uri.file("C:/work/notes.md"), [a]);
        T.d.set(many);
        await new Promise((r) => setTimeout(r, 0));"#,
    );
    let sets = e.asked("diagnostics.set");
    assert_eq!(
        sets.len(),
        2,
        "251 files in one turn: two requests (200 + 51)"
    );
    let id = sets[0]["collection"].as_str().unwrap();
    assert!(id.starts_with("acme.core#diagnostics#"));
    assert_eq!(sets[0]["name"], "lint");
    assert_eq!(sets[0]["entries"].as_array().unwrap().len(), 200);
    assert_eq!(sets[1]["entries"].as_array().unwrap().len(), 51);
    let first = &sets[0]["entries"][0];
    assert_eq!(
        first["uri"], "file:///C:/work/notes.md",
        "Yavin's spelling: the drive keeps its colon"
    );
    assert_eq!(
        first["diagnostics"],
        json!([{"range": {"startLine": 2, "startColumn": 1, "endLine": 2, "endColumn": 4}, "message": "bad", "severity": "warning",
            "source": "lint", "code": {"value": "MD001", "target": "https://example.com"}, "tags": ["deprecated"],
            "related": [{"uri": "file:///C:/work/b.md", "range": {"startLine": 1, "startColumn": 1, "endLine": 1, "endColumn": 2}, "message": "there"}]}])
    );
    e.step("T.d.clear(); T.d.dispose(); T.d.set(vscode.Uri.file('C:/work/x.md'), [new vscode.Diagnostic(new vscode.Range(0,0,0,1), 'late')]); await new Promise((r) => setTimeout(r, 0));");
    assert_eq!(
        e.asked("diagnostics.clear").len(),
        2,
        "clear() and dispose() each clear its problems"
    );
    assert_eq!(e.asked("diagnostics.set").len(), 2, "nothing after dispose");
}

#[test]
fn formatting_and_code_actions_answer_through_the_provider_protocol_and_cancel_their_token() {
    let mut e = Ext::start();
    e.step(
        r##"T.coll = vscode.languages.createDiagnosticCollection("x");
        T.diag = new vscode.Diagnostic(new vscode.Range(1, 0, 1, 3), "bad");
        T.coll.set(vscode.Uri.parse("file:///c%3A/work/notes.md"), [T.diag]);
        T.context.subscriptions.push(vscode.commands.registerCommand("core.fix", (n) => { T.fixed = n; }));
        vscode.languages.registerDocumentFormattingEditProvider({ language: "markdown" }, { provideDocumentFormattingEdits: (doc, options) => [vscode.TextEdit.replace(new vscode.Range(0, 0, 0, 1), "#"), vscode.TextEdit.insert(new vscode.Position(1, 0), " ".repeat(options.tabSize))] });
        vscode.languages.registerDocumentRangeFormattingEditProvider("markdown", { provideDocumentRangeFormattingEdits: (doc, range, options, token) => new Promise((resolve) => token.onCancellationRequested(() => { T.cancelled = true; resolve([]); })) });
        vscode.languages.registerCodeActionsProvider("markdown", { provideCodeActions(doc, range, ctx) {
          T.same = ctx.diagnostics.length === 1 && ctx.diagnostics[0] === T.diag;
          T.range = [range.start.line, range.end.character];
          const fix = new vscode.CodeAction("Fix it", vscode.CodeActionKind.QuickFix);
          fix.edit = new vscode.WorkspaceEdit(); fix.edit.replace(doc.uri, new vscode.Range(1, 0, 1, 3), "good");
          fix.command = { command: "core.fix", title: "", arguments: [5] };
          return [fix];
        } });"##,
    );
    let registered = e.asked("languages.register");
    let kinds: Vec<&str> = registered
        .iter()
        .map(|r| r["kind"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, ["formatting", "rangeFormatting", "codeActions"]);
    let id_of = |kind: &str| {
        registered.iter().find(|r| r["kind"] == kind).unwrap()["providerId"]
            .as_str()
            .unwrap()
            .to_string()
    };
    let formatting = e.request(
        "provider.invoke",
        json!({"providerId": id_of("formatting"), "kind": "formatting", "document": doc_info(1), "position": null, "extra": {"options": {"tabSize": 2, "insertSpaces": true}}}),
    );
    assert_eq!(
        formatting["result"],
        json!([{"range": {"startLine": 1, "startColumn": 1, "endLine": 1, "endColumn": 2}, "text": "#"}, {"range": {"startLine": 2, "startColumn": 1, "endLine": 2, "endColumn": 1}, "text": "  "}])
    );
    // A range formatting Yavin stops waiting for: the provider's token is cancelled.
    let invoke = json!({"type": "request", "requestId": "slow", "method": "provider.invoke", "params": {"providerId": id_of("rangeFormatting"), "kind": "rangeFormatting", "document": doc_info(1), "position": null, "extra": {"range": {"startLine": 1, "startColumn": 1, "endLine": 1, "endColumn": 2}, "options": {"tabSize": 4, "insertSpaces": true}, "token": "acme.core#token#7"}}});
    e.host.to(EXT, invoke);
    // The two answers may come in either order: the provider settles as soon as it is cancelled.
    e.host.to(EXT, json!({"type": "request", "requestId": "cancel", "method": "provider.cancel", "params": {"token": "acme.core#token#7"}}));
    let mut answers = Vec::new();
    while answers.len() < 2 {
        if let Some(answer) = e.pump_one(Some("*")) {
            answers.push(answer);
        }
    }
    let late = answers.iter().find(|a| a["requestId"] == "slow").unwrap();
    assert_eq!(late["result"], json!([]), "it answered once cancelled");
    assert_eq!(e.step("return T.cancelled === true;"), true);
    // Code actions: the extension's own diagnostic object in the context; the edit; the command.
    let actions = e.request(
        "provider.invoke",
        json!({"providerId": id_of("codeActions"), "kind": "codeActions", "document": doc_info(1), "position": null,
            "extra": {"range": {"startLine": 2, "startColumn": 1, "endLine": 2, "endColumn": 4}, "diagnostics": [{"range": {"startLine": 2, "startColumn": 1, "endLine": 2, "endColumn": 4}, "message": "bad", "severity": "error"}], "trigger": "invoke"}}),
    )["result"]
        .clone();
    assert_eq!(actions[0]["title"], "Fix it");
    assert_eq!(actions[0]["kind"], "quickfix");
    assert_eq!(
        actions[0]["edits"],
        json!([{"range": {"startLine": 2, "startColumn": 1, "endLine": 2, "endColumn": 4}, "text": "good"}])
    );
    assert_eq!(e.step("return [T.same, T.range];"), json!([true, [1, 3]]));
    let handle = actions[0]["command"].clone();
    assert!(handle.is_number());
    assert_eq!(
        e.request(
            "codeAction.run",
            json!({"providerId": id_of("codeActions"), "handle": handle})
        )["ok"],
        true
    );
    assert_eq!(e.step("return T.fixed;"), 5);
    assert_eq!(
        e.request("codeAction.run", json!({"handle": 123456}))["ok"],
        false,
        "an action never offered is refused"
    );
}

#[test]
fn save_events_selection_events_and_will_save_edits() {
    let mut e = Ext::start();
    e.step(
        r#"T.saved = []; T.sel = [];
        vscode.workspace.onDidSaveTextDocument((d) => T.saved.push(d.uri.toString()));
        vscode.window.onDidChangeTextEditorSelection((ev) => T.sel.push([ev.selections[0].anchor.character, ev.selections[0].active.character, ev.kind]));
        vscode.workspace.onWillSaveTextDocument((ev) => { T.reason = ev.reason; ev.waitUntil(Promise.resolve([vscode.TextEdit.insert(new vscode.Position(0, 0), "x"), "no"])); });
        vscode.workspace.onWillSaveTextDocument(() => { throw new Error("listener broke"); });"#,
    );
    let followed: Vec<String> = e
        .asked("events.subscribe")
        .iter()
        .map(|p| p["event"].as_str().unwrap().to_string())
        .collect();
    for event in ["documents.save", "editor.selection", "documents.willSave"] {
        assert!(
            followed.iter().any(|f| f == event),
            "{event} followed: {followed:?}"
        );
    }
    e.event("documents.save", doc_info(2));
    e.event(
        "editor.selection",
        json!({"uri": DOC_URI, "selections": [{"startLine": 1, "startColumn": 1, "endLine": 1, "endColumn": 3, "reversed": true}], "kind": "keyboard"}),
    );
    let answer = e.request(
        "documents.willSave",
        json!({"document": doc_info(2), "reason": "afterDelay"}),
    );
    assert_eq!(
        answer["result"],
        json!({"edits": [{"range": {"startLine": 1, "startColumn": 1, "endLine": 1, "endColumn": 1}, "text": "x"}]}),
        "the listener's edits; what is not an edit is dropped; a listener that throws is logged"
    );
    assert_eq!(
        e.step("return [T.saved, T.sel, T.reason];"),
        json!([["file:///c:/work/notes.md"], [[2, 0, 1]], 2])
    );
    assert!(e.window.logs.iter().any(|l| l.contains("listener broke")));
}

#[test]
fn file_watchers_follow_files_change_with_globs_relative_patterns_and_ignore_flags() {
    let mut e = Ext::start();
    e.step(
        r#"T.ev = [];
        const n = (u) => u.path.split("/").pop();
        const w = vscode.workspace.createFileSystemWatcher("**/.markdownlint{.json,.yaml,rc}");
        w.onDidCreate((u) => T.ev.push("create " + n(u))); w.onDidChange((u) => T.ev.push("change " + n(u))); w.onDidDelete((u) => T.ev.push("delete " + n(u)));
        const r = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file("C:/work/docs"), "**/*.md"), false, true, false);
        r.onDidCreate((u) => T.ev.push("rel create " + n(u))); r.onDidChange((u) => T.ev.push("rel change " + n(u))); r.onDidDelete((u) => T.ev.push("rel delete " + n(u)));"#,
    );
    assert!(e
        .asked("events.subscribe")
        .iter()
        .any(|p| p["event"] == "files.change"));
    e.event(
        "files.change",
        json!({"changes": [
            {"kind": "created", "uri": "file:///c%3A/work/.markdownlint.json"},
            {"kind": "modified", "uri": "file:///c%3A/work/sub/.markdownlintrc"},
            {"kind": "modified", "uri": "file:///c%3A/work/.markdownlint.yml"},
            {"kind": "created", "uri": "file:///c%3A/work/docs/a/b.md"},
            {"kind": "modified", "uri": "file:///c%3A/work/docs/b.md"},
            {"kind": "renamed", "uri": "file:///c%3A/work/docs/new.md", "from": "file:///c%3A/work/docs/old.md"},
            {"kind": "deleted", "uri": "file:///c%3A/work/docsx/z.md"},
            {"kind": "weird", "uri": "file:///c%3A/work/.markdownlint.json"},
            {"kind": "created", "uri": 42}
        ]}),
    );
    assert_eq!(
        e.step("return T.ev;"),
        json!([
            "create .markdownlint.json",
            "change .markdownlintrc",
            "rel create b.md",
            "rel delete old.md",
            "rel create new.md"
        ])
    );
}

#[test]
fn a_webview_panel_speaks_the_protocol_with_a_fresh_token_and_hears_its_own_events() {
    let mut e = Ext::start();
    e.step(
        r#"T.got = []; T.states = []; T.disposed = 0;
        T.p = vscode.window.createWebviewPanel("core.view", "Core view", vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.file("C:/ext/acme.core/extension/media"), vscode.Uri.file("C:/Windows")] });
        T.p.webview.onDidReceiveMessage((m) => T.got.push(m));
        T.p.onDidChangeViewState((ev) => T.states.push([ev.webviewPanel.visible, ev.webviewPanel.active]));
        T.p.onDidDispose(() => T.disposed++);
        T.p.webview.html = "<p>one</p>"; T.p.webview.html = "<p>two</p>"; T.p.title = "Renamed";
        T.uri = T.p.webview.asWebviewUri(vscode.Uri.file("C:/ext/acme.core/extension/media/a b.js")).toString();
        T.outside = T.p.webview.asWebviewUri(vscode.Uri.file("C:/Users/me/secret.txt")).toString();
        // The update waits for the panel to exist (the window's answer to webview.create).
        await new Promise((r) => setTimeout(r, 50));
        return null;"#,
    );
    let created = e.asked("webview.create");
    assert_eq!(created.len(), 1);
    let c = &created[0];
    assert!(c["id"].as_str().unwrap().starts_with("acme.core#webview#"));
    let token = c["token"].as_str().unwrap().to_string();
    assert!(
        token.len() == 32
            && token
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()),
        "{token}"
    );
    assert_eq!(c["viewType"], "core.view");
    assert_eq!(c["scripts"], true);
    assert_eq!(c["retain"], true);
    assert_eq!(
        c["roots"],
        json!(["extension/media"]),
        "the root outside the copy dropped"
    );
    // Changes in one turn are one request, the last HTML.
    let updates = e.asked("webview.update");
    assert_eq!(updates.len(), 1, "{updates:?}");
    assert_eq!(updates[0]["html"], "<p>two</p>");
    assert_eq!(updates[0]["title"], "Renamed");
    let [uri, outside]: [Value; 2] = e
        .step("return [T.uri, T.outside];")
        .as_array()
        .unwrap()
        .clone()
        .try_into()
        .unwrap();
    assert_eq!(
        uri,
        format!("https://yavin-webview.invalid/{token}/res/extension/media/a%20b.js")
    );
    assert_eq!(
        outside,
        format!("https://yavin-webview.invalid/{token}/outside")
    );
    assert!(e
        .window
        .logs
        .iter()
        .any(|l| l.contains("a resource root outside the extension serves nothing")));
    // Messages: to the panel (the window answers whether it was delivered), and from it.
    assert_eq!(
        e.step(r#"return await T.p.webview.postMessage({ a: 1 });"#),
        true
    );
    assert_eq!(
        e.asked("webview.postMessage")[0]["message"],
        json!({"a": 1})
    );
    let id = c["id"].clone();
    e.event(
        "webview.message",
        json!({"id": id, "message": {"from": "page"}}),
    );
    e.event(
        "webview.message",
        json!({"id": "acme.core#webview#999", "message": "not ours"}),
    );
    e.event(
        "webview.viewState",
        json!({"id": id, "visible": false, "active": false}),
    );
    assert_eq!(
        e.step("return [T.got, T.states, T.p.visible];"),
        json!([[{"from": "page"}], [[false, false]], false])
    );
    // Too large: refused in the extension, before any request.
    let error = e.step(
        r#"try { await T.p.webview.postMessage("x".repeat(1024 * 1024 + 1)); return "sent"; } catch (e) { return e.message; }"#,
    );
    assert!(
        error.as_str().unwrap().contains("at most 1024 KiB"),
        "{error}"
    );
    assert_eq!(e.asked("webview.postMessage").len(), 1);
    // The window closed its tab: disposed, heard once; then nothing more is sent.
    e.event("webview.disposed", json!({"id": id}));
    assert_eq!(
        e.step(r#"return [T.disposed, await T.p.webview.postMessage("late"), T.p.viewColumn === undefined];"#),
        json!([1, false, true])
    );
    assert_eq!(e.asked("webview.postMessage").len(), 1);
    // The extension's own dispose: the window is told, onDidDispose once.
    e.step(r#"T.q = vscode.window.createWebviewPanel("core.b", "B", 1, {}); T.qd = 0; T.q.onDidDispose(() => T.qd++); T.q.dispose(); T.q.dispose(); await new Promise((r) => setTimeout(r, 50));"#);
    assert_eq!(e.asked("webview.dispose").len(), 1);
    assert_eq!(e.step("return T.qd;"), 1);
    assert_eq!(
        e.asked("webview.create")[1]["scripts"],
        false,
        "scripts only when enabled"
    );
}

#[test]
fn console_has_debug_and_trace_as_extensions_call_them() {
    let mut e = Ext::start();
    e.step(r#"console.debug("dbg", 1); console.trace("here"); console.log("plain");"#);
    let logs = e.window.logs.join("\n");
    assert!(logs.contains("dbg 1"), "{logs}");
    assert!(logs.contains("here") && logs.contains("Trace"), "{logs}");
    assert!(logs.contains("plain"));
}
