/**
 * EXT-29: VS Code's pickers, file watchers, save and selection events, diagnostics in the
 * Problems view, and formatting and code-action providers -- behaviourally, on the window side:
 * the probe extension runs in Yavin's real host (`host.ts`) through the real layer (`vscode.js`),
 * against Yavin's real prompt service, Problems store, provider registry and document service
 * (`testing/vscodeHarness.ts`). Each test asserts what the extension saw and what Yavin now holds.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ID, PROBE_CODE, vscodeWorld } from "./testing/vscodeHarness.ts";
import { documentInfoOf } from "./documentInfo.ts";

const READ_EDIT = ["documents.read", "documents.edit", "editor.control"];
const OTHER = "acme.other";

async function ready(grants: string[] = READ_EDIT) {
  const w = vscodeWorld();
  w.install();
  if (grants.length) await w.grant(grants);
  return w;
}

async function waitFor(condition: () => boolean, what: string, ms = 3000) {
  const until = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > until) assert.fail(`timed out waiting: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test("showQuickPick: items in Yavin's picker, named for the extension; the item chosen, several, or undefined", async (t) => {
  const w = await ready([]);
  t.after(() => w.manager.dispose());
  const pick = w.step(
    `return await vscode.window.showQuickPick(["one", { label: "two", description: "2nd", detail: "more" }, { label: "group", kind: vscode.QuickPickItemKind.Separator }, "three"], { placeHolder: "Pick one", title: "Probe pick", matchOnDescription: true });`,
  );
  await waitFor(() => !!w.prompts.getSnapshot(), "the picker");
  const shown = w.prompts.getSnapshot()!;
  assert.equal(shown.request.kind, "quickPick");
  assert.equal(shown.request.extensionId, ID);
  assert.equal(shown.request.extensionName, "Probe probe");
  assert.equal(shown.request.title, "Probe pick");
  assert.equal(shown.request.placeHolder, "Pick one");
  assert.deepEqual(shown.request.kind === "quickPick" && shown.request.items, [
    { label: "one" },
    { label: "two", description: "2nd", detail: "more" },
    { label: "group", separator: true },
    { label: "three" },
  ]);
  assert.equal(shown.request.kind === "quickPick" && shown.request.matchOnDescription, true);
  w.prompts.answer(shown.id, 1);
  assert.deepEqual(await pick, { label: "two", description: "2nd", detail: "more" });
  assert.equal(w.prompts.getSnapshot(), null, "answered: gone");

  // A separator, or an index that is no item, is not an answer.
  const bad = w.step(
    `return (await vscode.window.showQuickPick(["a", { label: "s", kind: vscode.QuickPickItemKind.Separator }])) ?? "nothing";`,
  );
  await waitFor(() => !!w.prompts.getSnapshot(), "the second picker");
  w.prompts.answer(w.prompts.getSnapshot()!.id, 1);
  assert.equal(await bad, "nothing");

  // Several: the items checked (picked ones checked at first).
  const many = w.step(
    `return await vscode.window.showQuickPick([{ label: "a", picked: true }, "b", "c"], { canPickMany: true });`,
  );
  await waitFor(() => !!w.prompts.getSnapshot(), "the multi-picker");
  const multi = w.prompts.getSnapshot()!;
  assert.equal(multi.request.kind === "quickPick" && multi.request.canPickMany, true);
  w.prompts.answer(multi.id, [0, 2, 99]);
  assert.deepEqual(await many, [{ label: "a", picked: true }, "c"]);

  // Cancelled by the user: undefined.
  const cancelled = w.step(`return (await vscode.window.showQuickPick(["a"])) ?? "cancelled";`);
  await waitFor(() => !!w.prompts.getSnapshot(), "the picker to cancel");
  w.prompts.answer(w.prompts.getSnapshot()!.id, null);
  assert.equal(await cancelled, "cancelled");
});

test("a prompt closes when its token is cancelled, when its extension stops, and when the window closes", async (t) => {
  const w = await ready([]);
  t.after(() => w.manager.dispose());
  await w.step(
    `T.source = new vscode.CancellationTokenSource(); T.pick = vscode.window.showQuickPick(["a"], {}, T.source.token);`,
  );
  await waitFor(() => !!w.prompts.getSnapshot(), "the picker");
  assert.equal(
    await w.step(`T.source.cancel(); return (await T.pick) ?? "cancelled";`),
    "cancelled",
  );
  assert.equal(w.prompts.getSnapshot(), null, "the window's prompt is gone");

  // The extension stops (a restart of its host): its prompt is answered, and gone.
  await w.step(`T.box = vscode.window.showInputBox({ prompt: "never answered" });`);
  await waitFor(() => !!w.prompts.getSnapshot(), "the input box");
  await w.manager.restart();
  await waitFor(() => w.prompts.getSnapshot() === null, "gone with its extension");

  // The window closes: every prompt is answered (cancelled).
  const last = w.step(`return (await vscode.window.showInputBox({})) ?? "closed";`);
  await waitFor(() => !!w.prompts.getSnapshot(), "the last input box");
  w.prompts.cancelAll();
  assert.equal(await last, "closed");
});

test("prompts of two extensions wait their turn; an extension's new prompt replaces its own", async (t) => {
  const w = await ready([]);
  w.install(OTHER, PROBE_CODE);
  t.after(() => w.manager.dispose());
  // Both loaded first: the in-process double shares one realm (the probe's T) between them.
  await w.step("return 1;", OTHER);
  await w.step(`T.first = vscode.window.showQuickPick(["mine"]);`);
  await waitFor(() => !!w.prompts.getSnapshot(), "the first extension's picker");
  const first = w.prompts.getSnapshot()!;
  await w.step(`T.other = vscode.window.showInputBox({ prompt: "other" });`, OTHER);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(w.prompts.getSnapshot()!.id, first.id, "the other extension's prompt waits");
  w.prompts.answer(first.id, 0);
  assert.equal(await w.step(`return await T.first;`), "mine");
  await waitFor(() => w.prompts.getSnapshot()?.request.extensionId === OTHER, "then the other's");
  w.prompts.answer(w.prompts.getSnapshot()!.id, "typed");
  assert.equal(await w.step(`return await T.other;`, OTHER), "typed");

  // Its own second prompt replaces its first (answered undefined), as in VS Code.
  await w.step(`T.a = vscode.window.showQuickPick(["a"]);`);
  await waitFor(() => !!w.prompts.getSnapshot(), "a");
  await w.step(`T.b = vscode.window.showQuickPick(["b"]);`);
  assert.equal(await w.step(`return (await T.a) ?? "replaced";`), "replaced");
  await waitFor(() => {
    const shown = w.prompts.getSnapshot();
    return shown?.request.kind === "quickPick" && shown.request.items[0]?.label === "b";
  }, "b shown");
  w.prompts.answer(w.prompts.getSnapshot()!.id, 0);
  assert.equal(await w.step(`return await T.b;`), "b");
});

test("showInputBox: its value, selection and password field; validateInput asked of the extension", async (t) => {
  const w = await ready([]);
  t.after(() => w.manager.dispose());
  const box = w.step(`return await vscode.window.showInputBox({
    value: "abc", valueSelection: [1, 2], password: true, prompt: "Name", placeHolder: "type it", title: "Probe input",
    validateInput: (v) => v.length < 3 ? { message: "too short", severity: vscode.InputBoxValidationSeverity.Warning } : v === "bad" ? "no" : null,
  });`);
  await waitFor(() => !!w.prompts.getSnapshot(), "the input box");
  const shown = w.prompts.getSnapshot()!;
  assert.equal(shown.request.kind, "inputBox");
  if (shown.request.kind !== "inputBox") return;
  assert.equal(shown.request.value, "abc");
  assert.deepEqual(shown.request.valueSelection, [1, 2]);
  assert.equal(shown.request.password, true);
  assert.equal(shown.request.prompt, "Name");
  assert.equal(shown.request.placeHolder, "type it");
  assert.ok(shown.request.validate, "its validation is offered");
  assert.deepEqual(await shown.request.validate!("ab"), {
    message: "too short",
    severity: "warning",
  });
  assert.deepEqual(await shown.request.validate!("bad"), { message: "no", severity: "error" });
  assert.equal(await shown.request.validate!("good"), null);
  w.prompts.answer(shown.id, "good");
  assert.equal(await box, "good");
});

test("diagnostics in the Problems view: severities, hints, tags and related places; the workspace's files only; each collection its own", async (t) => {
  const w = await ready();
  w.install(OTHER, PROBE_CODE);
  t.after(() => w.manager.dispose());
  await w.step("return 1;", OTHER);
  const doc = await w.open("notes.txt", "one two\n");
  await w.open("other.txt", "x\n", false);
  await w.step(`
    T.d = vscode.languages.createDiagnosticCollection("lint");
    const hint = new vscode.Diagnostic(new vscode.Range(0, 4, 0, 7), "maybe", vscode.DiagnosticSeverity.Hint);
    hint.tags = [vscode.DiagnosticTag.Unnecessary];
    hint.code = { value: 7, target: vscode.Uri.parse("https://example.com/rule7") };
    hint.relatedInformation = [new vscode.DiagnosticRelatedInformation(new vscode.Location(vscode.Uri.file("C:/work/other.txt"), new vscode.Range(0, 0, 0, 1)), "see here")];
    const warn = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 3), "careful", vscode.DiagnosticSeverity.Warning);
    T.d.set([[vscode.window.activeTextEditor.document.uri, [hint]], [vscode.window.activeTextEditor.document.uri, [warn]], [vscode.Uri.file("C:/work/other.txt"), [new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), "x")]]]);
  `);
  await w.settle();
  const mine = w.problems().filter((p) => p.label === "lint");
  assert.equal(mine.length, 2, "one owner per file");
  const notes = mine.find((p) => p.diagnostics[0].file.endsWith("notes.txt"))!;
  assert.deepEqual(notes.diagnostics, [
    {
      file: "C:/work/notes.txt",
      line: 1,
      column: 5,
      endLine: 1,
      endColumn: 8,
      severity: "info",
      hint: true,
      message: "maybe",
      code: "7",
      tags: ["unnecessary"],
      related: [{ file: "C:/work/other.txt", line: 1, column: 1, message: "see here" }],
    },
    {
      file: "C:/work/notes.txt",
      line: 1,
      column: 1,
      endLine: 1,
      endColumn: 4,
      severity: "warning",
      message: "careful",
    },
  ]);
  assert.deepEqual(
    await w.step(
      `return [T.d.get(vscode.window.activeTextEditor.document.uri).length, T.d.has(vscode.Uri.file("C:/work/other.txt"))];`,
    ),
    [2, true],
  );

  // Outside the workspace: refused (said in its output), nothing shown; untitled: left out.
  await w.step(
    `T.d.set(vscode.Uri.file("C:/elsewhere/x.txt"), [new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), "far")]);`,
  );
  await w.settle();
  assert.equal(w.problems().filter((p) => p.label === "lint").length, 2);
  assert.ok(
    (w.logs.get(ID) ?? []).some((line) => /not in this workspace/.test(line)),
    "said",
  );

  // Another extension's collection never clears this one's.
  await w.step(
    `const other = vscode.languages.createDiagnosticCollection("lint2"); other.set(vscode.Uri.file("C:/work/notes.txt"), [new vscode.Diagnostic(new vscode.Range(0,0,0,1), "o")]); other.clear();`,
    OTHER,
  );
  await w.settle(OTHER);
  assert.equal(w.problems().filter((p) => p.label === "lint").length, 2, "untouched");
  assert.equal(w.problems().filter((p) => p.label === "lint2").length, 0);

  // delete(uri) removes one file; dispose() removes the rest.
  await w.step(`T.d.delete(vscode.Uri.file("C:/work/other.txt"));`);
  await w.settle();
  assert.equal(w.problems().filter((p) => p.label === "lint").length, 1);
  await w.step(
    `T.d.dispose(); T.d.set(vscode.window.activeTextEditor.document.uri, [new vscode.Diagnostic(new vscode.Range(0,0,0,1), "late")]);`,
  );
  await w.settle();
  assert.equal(
    w.problems().filter((p) => p.label === "lint").length,
    0,
    "disposed: nothing, not even later sets",
  );
  // Its own second collection's clear() leaves this one; a stopped host's problems leave the
  // Problems view.
  await w.step(
    `T.e = vscode.languages.createDiagnosticCollection("lint3"); T.e.set(vscode.Uri.file("C:/work/notes.txt"), [new vscode.Diagnostic(new vscode.Range(0,0,0,1), "kept until stop")]);
    const f = vscode.languages.createDiagnosticCollection("lint4"); f.set(vscode.Uri.file("C:/work/notes.txt"), [new vscode.Diagnostic(new vscode.Range(0,0,0,1), "f")]);
    await new Promise((r) => setTimeout(r, 0)); f.clear();`,
  );
  await w.settle();
  assert.equal(w.problems().filter((p) => p.label === "lint4").length, 0);
  assert.equal(w.problems().filter((p) => p.label === "lint3").length, 1, "the other kept");
  await w.manager.restart();
  assert.equal(w.problems().length, 0, "stopped: none of its problems are left");
  void doc;
});

test("formatting providers: asked with the editor's options, answer edits; a cancelled request cancels the provider's token", async (t) => {
  const w = await ready();
  t.after(() => w.manager.dispose());
  const doc = await w.open("notes.txt", "bad\n");
  const info = documentInfoOf(doc);
  await w.step(`
    T.f = vscode.languages.registerDocumentFormattingEditProvider("${info.languageId}", {
      provideDocumentFormattingEdits(document, options) { T.options = options; return [vscode.TextEdit.replace(new vscode.Range(0, 0, 0, 3), "BAD"), "not an edit"]; },
    });
    T.r = vscode.languages.registerDocumentRangeFormattingEditProvider("${info.languageId}", {
      provideDocumentRangeFormattingEdits(document, range, options, token) {
        T.range = [range.start.line, range.start.character, range.end.line, range.end.character];
        return new Promise((resolve) => token.onCancellationRequested(() => { T.cancelled = true; resolve([]); }));
      },
    });
  `);
  const [format] = w.providers.for("formatting", info.languageId);
  const edits = await format.invoke(
    { document: info, position: null, extra: { options: { tabSize: 2, insertSpaces: false } } },
    new AbortController().signal,
  );
  assert.deepEqual(edits, [
    { range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 4 }, text: "BAD" },
  ]);
  assert.deepEqual(await w.step(`return T.options;`), { tabSize: 2, insertSpaces: false });

  const [range] = w.providers.for("rangeFormatting", info.languageId);
  const controller = new AbortController();
  const asked = range.invoke(
    {
      document: info,
      position: null,
      extra: {
        range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 },
        options: { tabSize: 4, insertSpaces: true },
      },
    },
    controller.signal,
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  await assert.rejects(asked, /cancelled/);
  await waitFor(() => true, "");
  await w.settle();
  assert.deepEqual(await w.step(`return [T.range, T.cancelled === true];`), [[0, 0, 0, 1], true]);

  await w.step(`T.f.dispose(); T.r.dispose();`);
  await w.settle();
  assert.equal(w.providers.for("formatting", info.languageId).length, 0);
  assert.equal(w.providers.for("rangeFormatting", info.languageId).length, 0);
});

test("code actions: their edits to the document asked about, their command run in their extension, their own diagnostics in the context", async (t) => {
  const w = await ready();
  t.after(() => w.manager.dispose());
  const doc = await w.open("notes.txt", "bad word\n");
  const info = documentInfoOf(doc);
  await w.step(`
    T.coll = vscode.languages.createDiagnosticCollection("probe");
    T.diag = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 3), "bad", vscode.DiagnosticSeverity.Error);
    T.coll.set(vscode.window.activeTextEditor.document.uri, [T.diag]);
    context.subscriptions.push(vscode.commands.registerCommand("probe.fixed", (n) => { T.fixed = n; }));
    T.p = vscode.languages.registerCodeActionsProvider("${info.languageId}", {
      provideCodeActions(document, range, ctx) {
        T.sameDiagnostic = ctx.diagnostics[0] === T.diag;
        T.only = ctx.only && ctx.only.value;
        const fix = new vscode.CodeAction("Fix", vscode.CodeActionKind.QuickFix);
        fix.edit = new vscode.WorkspaceEdit();
        fix.edit.replace(document.uri, new vscode.Range(0, 0, 0, 3), "good");
        fix.command = { command: "probe.fixed", title: "fixed", arguments: [42] };
        fix.isPreferred = true;
        fix.diagnostics = [T.diag];
        const elsewhere = new vscode.CodeAction("Elsewhere", vscode.CodeActionKind.Refactor);
        elsewhere.edit = new vscode.WorkspaceEdit();
        elsewhere.edit.replace(vscode.Uri.file("C:/work/other.txt"), new vscode.Range(0, 0, 0, 0), "x");
        const off = new vscode.CodeAction("Off");
        off.disabled = { reason: "not now" };
        return [fix, elsewhere, off, { title: "Just a command", command: "probe.fixed", arguments: [7] }, null, { nope: true }];
      },
    });
  `);
  const [actions] = w.providers.for("codeActions", info.languageId);
  const answer = (await actions.invoke(
    {
      document: info,
      position: null,
      extra: {
        range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 4 },
        diagnostics: [
          {
            range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 4 },
            message: "bad",
            severity: "error",
          },
        ],
        only: "quickfix",
        trigger: "invoke",
      },
    },
    new AbortController().signal,
  )) as Record<string, unknown>[];
  assert.equal(answer.length, 4, "malformed entries are left out");
  assert.equal(answer[0].title, "Fix");
  assert.equal(answer[0].kind, "quickfix");
  assert.equal(answer[0].isPreferred, true);
  assert.deepEqual(answer[0].edits, [
    { range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 4 }, text: "good" },
  ]);
  assert.equal(typeof answer[0].command, "number");
  assert.equal(answer[1].unsupported, "it edits other files", "other files: not applied by Yavin");
  assert.deepEqual(answer[1].edits, []);
  assert.equal(answer[2].disabled, "not now");
  assert.equal(typeof answer[3].command, "number", "a Command is an action with a command");
  assert.deepEqual(await w.step(`return [T.sameDiagnostic, T.only];`), [true, "quickfix"]);
  // The chosen action's command runs in its extension, with its arguments.
  await actions.runAction!(answer[0].command as number);
  assert.equal(await w.step(`return T.fixed;`), 42);
  await assert.rejects(actions.runAction!(999_999), "an action no longer offered");
});

test("save events: did-save after a save; will-save edits are saved, at their version, only while the listener runs, with documents.edit", async (t) => {
  const w = await ready();
  t.after(() => w.manager.dispose());
  const doc = await w.open("notes.txt", "hello\n");
  await w.step(`
    T.saved = [];
    vscode.workspace.onDidSaveTextDocument((d) => T.saved.push(d.getText()));
    vscode.workspace.onWillSaveTextDocument((e) => {
      T.reason = e.reason;
      e.waitUntil(Promise.resolve([vscode.TextEdit.insert(new vscode.Position(0, 0), "# ")]));
      T.late = () => { try { e.waitUntil(Promise.resolve([])); return "accepted"; } catch (err) { return err.message; } };
    });
  `);
  w.documents.edit(doc.key, "hello world\n");
  await w.documents.save(doc.key);
  assert.equal(
    w.disk.get("C:/work/notes.txt"),
    "# hello world\n",
    "its edits are part of the save",
  );
  await w.settle();
  assert.deepEqual(await w.step(`return [T.saved, T.reason, T.late()];`), [
    ["# hello world\n"],
    1,
    "waitUntil can only be called synchronously",
  ]);
  assert.equal(w.documents.get(doc.key)?.dirty, false, "saved, not dirty");
});

test("will-save: without documents.edit its edits are refused and said; a listener that never finishes does not hold the save past 1.5 s", async (t) => {
  const w = await ready(["documents.read"]);
  t.after(() => w.manager.dispose());
  const doc = await w.open("notes.txt", "plain\n");
  await w.step(`
    vscode.workspace.onWillSaveTextDocument((e) => e.waitUntil(Promise.resolve([vscode.TextEdit.insert(new vscode.Position(0, 0), "X")])));
  `);
  w.documents.edit(doc.key, "plain text\n");
  await w.documents.save(doc.key);
  assert.equal(w.disk.get("C:/work/notes.txt"), "plain text\n", "not edited");
  assert.equal(w.manager.getSnapshot().denied[ID]?.capability, "documents.edit");

  await w.grant(READ_EDIT);
  await w.step(
    `vscode.workspace.onWillSaveTextDocument((e) => e.waitUntil(new Promise(() => {})));`,
  );
  w.documents.edit(doc.key, "again\n");
  const started = Date.now();
  await w.documents.save(doc.key);
  const took = Date.now() - started;
  assert.ok(took < 2500, `the save waited ${took} ms`);
  assert.match(w.disk.get("C:/work/notes.txt") ?? "", /again/);
});

test("selection events: the active editor's selections, their direction and what moved them; another document's are not its", async (t) => {
  const w = await ready();
  t.after(() => w.manager.dispose());
  const doc = await w.open("notes.txt", "abcdef\nsecond\n");
  const info = documentInfoOf(doc);
  await w.step(`
    T.sel = [];
    vscode.window.onDidChangeTextEditorSelection((e) => T.sel.push([
      e.selections.map((s) => [s.anchor.line, s.anchor.character, s.active.line, s.active.character]),
      e.kind,
      e.textEditor.document.uri.toString() === vscode.window.activeTextEditor.document.uri.toString(),
    ]));
  `);
  w.select({
    resource: info.resourceId,
    selections: [
      { startLine: 1, startColumn: 1, endLine: 1, endColumn: 4, reversed: true },
      { startLine: 2, startColumn: 2, endLine: 2, endColumn: 3, reversed: false },
    ],
    kind: "mouse",
  });
  w.select({
    resource: "file:///c:/work/elsewhere.txt" as never,
    selections: [{ startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 }],
    kind: "keyboard",
  });
  await w.settle();
  assert.deepEqual(
    await w.step(`return [T.sel, vscode.window.activeTextEditor.selection.isReversed];`),
    [
      [
        [
          [
            [0, 3, 0, 0],
            [1, 1, 1, 2],
          ],
          2,
          true,
        ],
      ],
      true,
    ],
  );
});

test("file watchers: globs and RelativePattern, ignore flags, renames as delete and create, disposal, the workspace only", async (t) => {
  const w = await ready(["workspace.fs.read"]);
  t.after(() => w.manager.dispose());
  await w.step(`
    T.ev = [];
    const name = (u) => u.path.split("/").pop();
    T.w1 = vscode.workspace.createFileSystemWatcher("**/*.toml");
    T.w1.onDidCreate((u) => T.ev.push("w1 create " + name(u)));
    T.w1.onDidChange((u) => T.ev.push("w1 change " + name(u)));
    T.w1.onDidDelete((u) => T.ev.push("w1 delete " + name(u)));
    T.w2 = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.workspace.workspaceFolders[0], "src/*.{md,txt}"), true);
    T.w2.onDidCreate((u) => T.ev.push("w2 create " + name(u)));
    T.w2.onDidChange((u) => T.ev.push("w2 change " + name(u)));
    T.w2.onDidDelete((u) => T.ev.push("w2 delete " + name(u)));
    return [T.w2.ignoreCreateEvents, T.w2.ignoreChangeEvents];
  `);
  w.changeFiles([
    { kind: "created", path: "C:/work/a.toml" },
    { kind: "modified", path: "C:/work/deep/B.TOML" },
    { kind: "created", path: "C:/work/src/x.md" },
    { kind: "modified", path: "C:/work/src/x.md" },
    { kind: "modified", path: "C:/work/src/sub/y.md" },
    { kind: "renamed", path: "C:/work/c.toml", from: "C:/work/src/c.txt" },
    { kind: "deleted", path: "C:/elsewhere/z.toml" },
  ]);
  await w.settle();
  assert.deepEqual(await w.step(`return T.ev;`), [
    "w1 create a.toml",
    "w1 change B.TOML",
    "w2 change x.md",
    "w2 delete c.txt",
    "w1 create c.toml",
  ]);
  await w.step(`T.ev = []; T.w1.dispose();`);
  w.changeFiles([
    { kind: "deleted", path: "C:/work/a.toml" },
    { kind: "deleted", path: "C:/work/src/x.md" },
  ]);
  await w.settle();
  assert.deepEqual(
    await w.step(`return T.ev;`),
    ["w2 delete x.md"],
    "a disposed watcher hears nothing",
  );
  assert.match(
    String(
      await w.step(
        `try { for (let i = 0; i < 600; i++) vscode.workspace.createFileSystemWatcher("*.x"); return "made"; } catch (e) { return e.name + ": " + e.message; }`,
      ),
    ),
    /^RangeError: An extension may have at most 500/,
  );
});

test("file watchers need workspace.fs.read: without it, no file event reaches the extension", async (t) => {
  const w = await ready(["documents.read"]);
  t.after(() => w.manager.dispose());
  await w.step(
    `T.ev = []; vscode.workspace.createFileSystemWatcher("**/*").onDidCreate((u) => T.ev.push(u.path));`,
  );
  w.changeFiles([{ kind: "created", path: "C:/work/secret.env" }]);
  await w.settle();
  assert.deepEqual(await w.step(`return T.ev;`), []);
});
