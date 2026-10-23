/**
 * EXT-27: the window side of the VS Code compatibility layer, behaviourally -- a VS Code
 * extension (the probe) run by Yavin's real host (`host.ts`) through the real layer, against
 * Yavin's real stores and document service (`testing/vscodeHarness.ts`). Each test asserts what
 * the extension saw and what Yavin's own services now hold.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ID, PROBE, PROBE_CODE, VIEW, vscodeWorld } from "./testing/vscodeHarness.ts";
import { vscodeCompatibility } from "./vscodeCompatibility.ts";

const READ_EDIT = ["documents.read", "documents.edit", "editor.control"];

async function ready(grants: string[] = READ_EDIT) {
  const w = vscodeWorld();
  w.install();
  if (grants.length) await w.grant(grants);
  return w;
}

test("an extension's edit lands in the document service as one change; stale, read-only and overlapping edits are refused", async (t) => {
  const w = await ready();
  t.after(() => w.manager.dispose());
  const doc = await w.open("notes.txt", "alpha beta\n");
  const edited = await w.step(`
    const e = vscode.window.activeTextEditor;
    const ok = await e.edit((b) => b.replace(new vscode.Range(0, 0, 0, 5), "ALPHA"));
    return { ok, text: e.document.getText(), version: e.document.version };
  `);
  assert.deepEqual(edited, { ok: true, text: "ALPHA beta\n", version: 2 });
  const now = w.documents.all().find((d) => d.id === doc.id)!;
  assert.equal(now.text, "ALPHA beta\n", "Yavin's document holds the edit");
  assert.equal(now.dirty, true, "unsaved until the user saves it");
  // The user types meanwhile: an edit made on the old version is refused, nothing changes.
  const stale = await w.step(`
    const e = vscode.window.activeTextEditor;
    T.version = e.document.version;
    return true;
  `);
  assert.equal(stale, true);
  w.documents.edit(doc.key, "user typed\n");
  const refused = await w.step(`
    const e = vscode.window.activeTextEditor;
    return await vscode.workspace.applyEdit((() => { const x = new vscode.WorkspaceEdit(); x.insert(e.document.uri, new vscode.Position(0, 0), "!"); return x; })());
  `);
  assert.equal(refused, true, "applyEdit reads the current version first, so this one lands");
  assert.equal(w.documents.all().find((d) => d.id === doc.id)!.text, "!user typed\n");
  // Overlapping edits: refused as a whole.
  const overlap = await w.step(`
    return await vscode.window.activeTextEditor.edit((b) => { b.replace(new vscode.Range(0, 0, 0, 3), "a"); b.replace(new vscode.Range(0, 1, 0, 4), "b"); });
  `);
  assert.equal(overlap, false);
  assert.equal(w.documents.all().find((d) => d.id === doc.id)!.text, "!user typed\n");
});

test("a read-only document is not edited; without documents.edit the request is refused and said", async (t) => {
  const w = await ready(["documents.read"]);
  t.after(() => w.manager.dispose());
  await w.open("notes.txt", "x\n");
  await assert.rejects(
    w.step(
      `return await vscode.window.activeTextEditor.edit((b) => b.insert(new vscode.Position(0, 0), "y"));`,
    ),
    /documents\.edit/,
  );
  assert.equal(w.manager.getSnapshot().denied[ID]?.capability, "documents.edit");
  assert.equal(w.documents.all()[0].text, "x\n");
  // Granted, but the file is read-only on disk: refused (false).
  await w.grant(READ_EDIT);
  w.locked.add("C:/work/locked.txt");
  await w.open("locked.txt", "fixed\n");
  const readOnly = await w.step(
    `return await vscode.window.activeTextEditor.edit((b) => b.insert(new vscode.Position(0, 0), "y"));`,
  );
  assert.equal(readOnly, false);
});

test("status bar items appear in Yavin's store, owned, bounded, clickable; and go when the extension stops", async (t) => {
  const w = await ready();
  t.after(() => w.manager.dispose());
  await w.step(`
    T.clicks = 0;
    T.c = vscode.commands.registerCommand("probe.clicked", () => T.clicks++);
    T.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 5);
    T.item.text = "$(check) Ready\\u0007";
    T.item.command = "probe.clicked";
    T.item.show();
  `);
  await w.settle();
  const [entry] = w.statusBar.getSnapshot();
  assert.equal(entry.extensionId, ID);
  assert.equal(entry.text, "Ready", "codicons dropped, control characters not shown");
  assert.equal(entry.alignment, "left");
  assert.equal(entry.clickable, true);
  await w.manager.activateStatusItem(entry.id);
  assert.equal(await w.step("return T.clicks;"), 1);
  // At most 20 per extension: the 21st is refused, the 20 stay.
  const made = await w.step(`
    const errors = [];
    for (let i = 0; i < 20; i++) { const it = vscode.window.createStatusBarItem(); it.text = "n" + i; it.show(); }
    await new Promise((r) => setTimeout(r, 0));
    return "made";
  `);
  assert.equal(made, "made");
  await w.settle();
  assert.equal(w.statusBar.getSnapshot().filter((e) => e.extensionId === ID).length, 20);
  assert.ok(
    w.manager.getSnapshot() &&
      [...(w.logs.get(ID) ?? [])].some((line) => /20 status bar items/.test(line)),
    "the refusal is in its log",
  );
  // Another extension's id: refused by ownership, even when sent outright.
  w.host.deliverRaw(
    JSON.stringify({
      type: "request",
      requestId: "spoof",
      method: "statusBar.set",
      params: { id: "acme.other#status#1", text: "spoof" },
      extensionId: ID,
      workspaceId: "file://c:/work",
      hostGeneration: w.manager.getSnapshot().generation,
    }),
  );
  await w.settle();
  assert.ok(!w.statusBar.getSnapshot().some((e) => e.id === "acme.other#status#1"));
  // Disabled: its items go with it.
  await w.registry.setEnabled(ID, false);
  await w.manager.reconcile?.();
  await waitFor(() => w.statusBar.getSnapshot().length === 0, "items cleared on disable");
});

test("providers registered by the extension are in Yavin's provider registry, answer through the layer, and leave on dispose", async (t) => {
  const w = await ready();
  t.after(() => w.manager.dispose());
  const doc = await w.open("notes.txt", "alp\n");
  await w.step(`
    T.p = vscode.languages.registerCompletionItemProvider("plaintext", {
      provideCompletionItems(d, pos) {
        return [new vscode.CompletionItem("alpha:" + d.getText(new vscode.Range(pos.line, 0, pos.line, pos.character)))];
      },
    });
    T.h = vscode.languages.registerHoverProvider("plaintext", { provideHover: () => new vscode.Hover("**hi**") });
  `);
  const completion = w.providers.for("completion", "plaintext");
  assert.equal(completion.length, 1);
  assert.equal(completion[0].extensionId, ID);
  const info = (await import("./documentInfo.ts")).documentInfoOf(doc);
  const items = await completion[0].invoke(
    { document: info, position: { line: 1, column: 4 } },
    new AbortController().signal,
  );
  assert.deepEqual(items, [{ label: "alpha:alp" }]);
  const hover = await w.providers
    .for("hover", "plaintext")[0]
    .invoke({ document: info, position: { line: 1, column: 1 } }, new AbortController().signal);
  assert.deepEqual(hover, { contents: "**hi**" });
  await w.step("T.p.dispose(); T.h.dispose();");
  await w.settle();
  assert.equal(w.providers.for("completion", "plaintext").length, 0);
  assert.equal(w.providers.for("hover", "plaintext").length, 0);
});

// EXT-29: diagnostics are in the Problems view (Yavin's store, which also gives the editor its
// markers) -- no longer decorations of their own.
test("diagnostics are in Yavin's Problems store; cleared by the collection and by deactivation", async (t) => {
  const w = await ready();
  t.after(() => w.manager.dispose());
  await w.open("notes.txt", "bad word\n");
  await w.step(`
    T.d = vscode.languages.createDiagnosticCollection("probe");
    const e = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 3), "no", vscode.DiagnosticSeverity.Error);
    e.source = "probe-lint";
    e.code = "P1";
    T.d.set(vscode.window.activeTextEditor.document.uri, [e]);
  `);
  await w.settle();
  const [owned] = w.problems();
  assert.equal(owned.label, "probe", "labelled by the collection's name");
  assert.match(owned.owner, /^ext:\d+:acme\.probe#diagnostics#\d+:/);
  assert.deepEqual(owned.diagnostics, [
    {
      // The canonical path, as Yavin's language servers' problems have it (they group by file).
      file: "C:/work/notes.txt",
      line: 1,
      column: 1,
      endLine: 1,
      endColumn: 4,
      severity: "error",
      message: "no",
      code: "P1",
      origin: "probe-lint",
    },
  ]);
  assert.equal(w.decorations.getSnapshot().length, 0, "no decorations of their own any more");
  await w.step("T.d.clear();");
  await w.settle();
  assert.equal(w.problems().length, 0, "clear() empties its problems");
  await w.step(
    `T.d.set(vscode.window.activeTextEditor.document.uri, [new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), "again")]);`,
  );
  await w.settle();
  assert.equal(w.problems().length, 1);
  await w.manager.restart();
  assert.equal(w.problems().length, 0, "a stopped host's problems are cleared");
});

test("a tree view's rows are the window's view, refreshed when the extension says so", async (t) => {
  const w = await ready();
  t.after(() => w.manager.dispose());
  await w.step(`
    T.e = new vscode.EventEmitter(); T.n = 1;
    T.v = vscode.window.registerTreeDataProvider("probe.tree", {
      onDidChangeTreeData: T.e.event,
      getChildren: (el) => (el ? [] : Array.from({ length: T.n }, (_, i) => "row " + i)),
      getTreeItem: (el) => new vscode.TreeItem(el),
    });
  `);
  await w.manager.showView(VIEW);
  await waitFor(() => w.manager.getSnapshot().views[VIEW]?.length === 1, "rows shown");
  assert.deepEqual(w.manager.getSnapshot().views[VIEW], [{ label: "row 0" }]);
  await w.step("T.n = 3; T.e.fire();");
  await waitFor(() => w.manager.getSnapshot().views[VIEW]?.length === 3, "refreshed");
  await w.step("T.v.dispose();");
  await waitFor(() => !(VIEW in w.manager.getSnapshot().views), "its rows leave with it");
});

test("documents opened, changed and closed in Yavin reach the extension's listeners, in order", async (t) => {
  const w = await ready();
  t.after(() => w.manager.dispose());
  await w.open("first.txt", "1\n");
  await w.step(`
    vscode.workspace.onDidOpenTextDocument((d) => T.events.push(["open", d.fileName.split("\\\\").pop()]));
    vscode.workspace.onDidChangeTextDocument((e) => T.events.push(["change", e.document.getText()]));
    vscode.workspace.onDidCloseTextDocument((d) => T.events.push(["close", d.fileName.split("\\\\").pop()]));
    vscode.window.onDidChangeActiveTextEditor((e) => T.events.push(["active", e && e.document.fileName.split("\\\\").pop()]));
  `);
  await w.settle();
  const second = await w.open("second.txt", "2\n");
  await w.settle();
  w.documents.edit(second.key, "2, edited\n");
  await w.settle();
  w.documents.close(second.key, { discard: true });
  await w.settle();
  assert.deepEqual(await w.step("return T.events;"), [
    ["open", "second.txt"],
    ["active", "second.txt"],
    ["change", "2, edited\n"],
    ["close", "second.txt"],
  ]);
});

test("window.state is the window's real focus; onDidChangeWindowState fires once per change", async (t) => {
  const w = await ready([]);
  t.after(() => w.manager.dispose());
  await w.step("T.s = []; vscode.window.onDidChangeWindowState((s) => T.s.push(s.focused));");
  assert.equal(await w.step("return vscode.window.state.focused;"), true);
  w.blur();
  w.blur(); // a second blur is no change
  await w.settle();
  w.focus();
  await w.settle();
  assert.deepEqual(await w.step("return [T.s, vscode.window.state.focused];"), [
    [false, true],
    true,
  ]);
});

test("what an extension uses that Yavin lacks is recorded, and its verdict says so", async (t) => {
  const w = await ready([]);
  t.after(() => w.manager.dispose());
  const code = await w.step(
    `try { await vscode.window.showOpenDialog({}); } catch (e) { return e.code; }`,
  );
  assert.equal(code, "UnsupportedApi");
  await waitFor(() => (w.manager.getSnapshot().unsupported?.[ID] ?? []).length === 1, "recorded");
  assert.deepEqual(w.manager.getSnapshot().unsupported?.[ID], ["window.showOpenDialog"]);
  const entry = w.registry.get(ID)!;
  const verdict = vscodeCompatibility(
    entry.manifest.vsix!,
    w.manager.getSnapshot().statuses[ID],
    w.manager.getSnapshot().unsupported?.[ID],
  );
  assert.equal(verdict.verdict, "Compatible with limitations");
  assert.match(verdict.reasons.join(" "), /window\.showOpenDialog/);
});

test("a revoked permission holds at once: the editor and documents are no longer given", async (t) => {
  const w = await ready(["documents.read"]);
  t.after(() => w.manager.dispose());
  await w.open("notes.txt", "secret\n");
  assert.equal(
    await w.step("return vscode.window.activeTextEditor.document.getText();"),
    "secret\n",
  );
  await w.grant([]);
  const after = await w.step(
    "return [vscode.window.activeTextEditor === undefined, vscode.workspace.textDocuments.every((d) => d.getText() === 'secret\\n')];",
  );
  assert.equal((after as boolean[])[0], true, "no active editor without documents.read");
  assert.equal(w.manager.getSnapshot().denied[ID]?.capability, "documents.read");
});

test("state persists across a host restart; registrations do not", async (t) => {
  const w = await ready();
  t.after(() => w.manager.dispose());
  await w.step(
    `await context.globalState.update("count", 41); T.c = vscode.commands.registerCommand("probe.temp", () => 1);`,
  );
  await w.manager.restart();
  const after = await w.step(`
    const count = context.globalState.get("count");
    let temp;
    try { await vscode.commands.executeCommand("probe.temp"); temp = "still there"; } catch (e) { temp = e.code; }
    return { count, temp };
  `);
  assert.deepEqual(after, { count: 41, temp: "UnsupportedApi" });
  assert.equal(PROBE.startsWith(ID), true);
  void PROBE_CODE;
});

test("installed or enabled after the window started, an onStartupFinished extension activates then -- once, and not while held", async (t) => {
  const w = vscodeWorld();
  t.after(() => w.manager.dispose());
  const state = (id: string) => w.manager.getSnapshot().statuses[id]?.state;
  const HEAD = "exports.activate = function (context) {";
  assert.ok(PROBE_CODE.includes(HEAD));
  // The probe, counting its activations in its global state.
  const STARTS = PROBE_CODE.replace(
    HEAD,
    `${HEAD} context.globalState.update("starts", (context.globalState.get("starts") ?? 0) + 1);`,
  );
  // Before the window starts, an install activates nothing.
  w.install("acme.early", STARTS, ["onStartupFinished"]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(w.manager.getSnapshot().host, "idle", "no host before startup");
  await w.manager.fire({ kind: "startup" });
  await waitFor(() => state("acme.early") === "active", "the early one, at startup");
  // After it: the new one activates at once; one without a fired event does not.
  w.install("acme.late", STARTS, ["onStartupFinished"]);
  w.install("acme.lazy");
  await waitFor(() => state("acme.late") === "active", "the late one, on install");
  assert.equal(state("acme.lazy") ?? "not started", "not started", "no event of its fired");
  // One whose activation fails is not tried again by every registry change.
  w.install(
    "acme.broken",
    `const vscode = require("vscode"); exports.activate = () => { vscode.window.showInformationMessage("broken starts"); throw new Error("no"); };`,
    ["onStartupFinished"],
  );
  await waitFor(() => state("acme.broken") === "failed", "the broken one tried");
  // Unrelated registry changes start nothing twice.
  w.install("acme.other");
  await w.settle("acme.late");
  assert.equal(await w.step(`return context.globalState.get("starts");`, "acme.late"), 1);
  assert.equal(w.notes.filter(([, , m]) => m === "broken starts").length, 1, "tried once");
  // Disabled, then enabled again: it activates again (VS Code does).
  w.registry.setEnabled("acme.late", false);
  await waitFor(() => state("acme.late") !== "active", "stopped when disabled");
  w.registry.setEnabled("acme.late", true);
  await waitFor(() => state("acme.late") === "active", "again when enabled");
  assert.equal(await w.step(`return context.globalState.get("starts");`, "acme.late"), 2);
  // Held (the folder no longer trusted): an install runs nothing.
  await w.manager.setTrusted(false);
  w.install("acme.held", STARTS, ["onStartupFinished"]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state("acme.held") ?? "not started", "not started", "nothing runs while held");
  await w.manager.setTrusted(true);
  await waitFor(() => state("acme.held") === "active", "trusted again: its event reaches it");
});

async function waitFor(condition: () => boolean, what: string, ms = 3000) {
  const until = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > until) assert.fail(`timed out waiting: ${what}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("the window proxy forwards every member of the window to the one provided (EXT-25's edit was not)", async () => {
  const { createWindowProxy } = await import("./window.ts");
  const reached: string[] = [];
  const spy =
    (path: string, value: unknown = null) =>
    (...args: unknown[]) => {
      reached.push(path);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown)(...args) : value;
    };
  const focus = { focused: () => true, onChange: () => () => {} };
  const full = {
    documents: {
      all: spy("documents.all", []),
      get: spy("documents.get"),
      text: spy("documents.text"),
      subscribe: spy("documents.subscribe", () => () => {}),
      edit: spy("documents.edit", true),
    },
    editor: {
      active: spy("editor.active"),
      onActive: spy("editor.onActive", () => () => {}),
      openLocation: spy("editor.openLocation", async () => {}),
      setSelection: spy("editor.setSelection", true),
      revealRange: spy("editor.revealRange", true),
    },
    readFile: spy("readFile", async () => "text"),
    focus,
  };
  let current: typeof full | null = null;
  const proxy = createWindowProxy(() => current as never);
  // Before the window is provided: reads see nothing; actions are refused.
  assert.deepEqual(proxy.documents.all(), []);
  assert.equal(proxy.editor.active(), null);
  assert.equal(proxy.focus, undefined);
  assert.throws(() => proxy.documents.edit!("r" as never, 1, []), /not ready/);
  await assert.rejects(() => proxy.readFile("x"), /not ready/);
  current = full;
  // Every member, called through the proxy, reaches the window's own.
  proxy.documents.all();
  proxy.documents.get("r" as never);
  proxy.documents.text("r" as never);
  proxy.documents.subscribe(() => {});
  assert.equal(proxy.documents.edit!("r" as never, 1, []), true);
  proxy.editor.active();
  proxy.editor.onActive(() => {});
  await proxy.editor.openLocation("p", null);
  proxy.editor.setSelection({ startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 });
  proxy.editor.revealRange({ startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 });
  assert.equal(await proxy.readFile("x"), "text");
  assert.equal(proxy.focus, focus);
  const members = [
    ...Object.keys(full.documents).map((k) => `documents.${k}`),
    ...Object.keys(full.editor).map((k) => `editor.${k}`),
    "readFile",
  ];
  assert.deepEqual([...reached].sort(), members.sort(), "nothing left unforwarded");
});
