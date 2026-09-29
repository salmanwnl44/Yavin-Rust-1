import assert from "node:assert/strict";
import test from "node:test";
import { changedSpan, createEditorModelBridge } from "./editorModelBridge.ts";
import type { EditorDecoration, EditorModel, EditorModelHost } from "./editorModelBridge.ts";
import { createDocumentService, documentStatus } from "./documents.ts";
import type { DocumentIO } from "./documents.ts";
import { languageFor } from "./language.ts";
import { createEditorViews } from "./editorViews.ts";

/** A model as Monaco behaves: content changes fire synchronously, for typing and for edits. */
class FakeModel implements EditorModel {
  value: string;
  language: string;
  uri: string;
  disposed = false;
  externals = 0;
  decorations = new Map<string, readonly EditorDecoration[]>();
  private listeners = new Set<() => void>();
  constructor(text: string, language: string, uri: string) {
    this.value = text;
    this.language = language;
    this.uri = uri;
  }
  getValue() {
    return this.value;
  }
  applyExternal(text: string) {
    this.externals++;
    this.value = text;
    this.fire();
  }
  /** The user typing. */
  type(text: string) {
    this.value = text;
    this.fire();
  }
  onDidChangeContent(listener: () => void) {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  }
  setLanguage(language: string) {
    this.language = language;
  }
  stops = 0;
  pushUndoStop() {
    this.stops++;
  }
  setDecorations(owner: string, decorations: readonly EditorDecoration[]) {
    this.decorations.set(owner, decorations);
  }
  dispose() {
    this.disposed = true;
    this.listeners.clear();
  }
  listenerCount() {
    return this.listeners.size;
  }
  private fire() {
    for (const listener of [...this.listeners]) listener();
  }
}

function setup(files: Record<string, string>) {
  const disk = new Map(Object.entries(files));
  let operation = 0;
  let gate: Promise<void> | null = null;
  const io: DocumentIO = {
    async read(path) {
      const text = disk.get(path);
      if (text === undefined) throw new Error("not found");
      return text;
    },
    async write(path, expected, content) {
      if (gate) await gate;
      if (disk.get(path) !== expected) throw new Error("File changed on disk.");
      disk.set(path, content);
      return ++operation;
    },
    async create(path, content) {
      if (disk.has(path)) throw new Error("File already exists");
      disk.set(path, content);
      return ++operation;
    },
  };
  const documents = createDocumentService(io);
  const created: FakeModel[] = [];
  const host: EditorModelHost = {
    create(text, language, uri) {
      const model = new FakeModel(text, language, uri);
      created.push(model);
      return model;
    },
  };
  const bridge = createEditorModelBridge(documents, host, {
    languageOf: (doc) => languageFor(doc.name),
    uriOf: (doc) => (doc.uri ? `file://${doc.uri.path}` : `${doc.id}`),
  });
  const hold = () => {
    let release!: () => void;
    gate = new Promise((resolve) => (release = resolve));
    return () => {
      gate = null;
      release();
    };
  };
  return { disk, documents, bridge, created, hold };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("a model is created from the document's own text, once per document", async () => {
  const { documents, bridge, created } = setup({ "/w/a.ts": "a\r\nb" });
  await documents.open("/w/a.ts");
  const model = bridge.open("/w/a.ts") as FakeModel;
  assert.equal(model.value, "a\nb", "the document's text, not the disk's");
  assert.equal(model.language, "typescript");
  assert.equal(model.uri, "file:///w/a.ts");
  assert.equal(bridge.open("/w/a.ts"), model, "reused, not recreated");
  assert.equal(bridge.open("/w/A.ts".toLowerCase()), model);
  assert.equal(created.length, 1);
  assert.equal(bridge.open("/w/missing.ts"), undefined, "no document, no model");
});

test("typing reaches the document once, and is never written back to the model", async () => {
  const { documents, bridge } = setup({ "/w/a.ts": "a" });
  const doc = (await documents.open("/w/a.ts"))!;
  const model = bridge.open("/w/a.ts") as FakeModel;
  const versions: number[] = [];
  documents.subscribe((event) => event.type === "changed" && versions.push(event.version));
  model.type("ab");
  model.type("abc");
  assert.equal(doc.text, "abc");
  assert.deepEqual(versions, [2, 3], "one document edit per model change");
  assert.equal(model.externals, 0, "nothing echoed back into the model");
  assert.equal(documentStatus(doc), "dirty");
  model.type("a");
  assert.equal(doc.dirty, false, "undoing to the saved text is clean -- the document decides");
});

test("the document's own changes reach the model, and are not taken for edits", async () => {
  const { disk, documents, bridge } = setup({ "/w/a.ts": "one\ntwo\n" });
  const doc = (await documents.open("/w/a.ts"))!;
  const model = bridge.open("/w/a.ts") as FakeModel;
  const edits: number[] = [];
  documents.subscribe((event) => event.type === "changed" && edits.push(event.version));
  disk.set("/w/a.ts", "zero\none\ntwo\n");
  await documents.applyResourceChanges([{ kind: "modified", path: "/w/a.ts" }]);
  assert.equal(model.value, "zero\none\ntwo\n", "a clean document's reload is shown");
  assert.equal(model.externals, 1);
  assert.deepEqual(edits, [], "no fake user edit came back");
  assert.equal(doc.dirty, false);
  // Replace-in-files and the like: an edit the document makes.
  documents.edit("/w/a.ts", "replaced\n");
  assert.equal(model.value, "replaced\n");
});

test("a dirty document's conflict leaves the model with the user's text", async () => {
  const { disk, documents, bridge } = setup({ "/w/a.ts": "base" });
  const doc = (await documents.open("/w/a.ts"))!;
  const model = bridge.open("/w/a.ts") as FakeModel;
  model.type("mine");
  disk.set("/w/a.ts", "theirs");
  await documents.applyResourceChanges([{ kind: "modified", path: "/w/a.ts" }]);
  assert.equal(documentStatus(doc), "conflicted");
  assert.equal(model.value, "mine");
  await documents.reload("/w/a.ts", { discard: true });
  assert.equal(model.value, "theirs", "Revert: the model follows the document");
});

test("an older save completing leaves the newer typing, and the document dirty", async () => {
  const { documents, bridge, hold } = setup({ "/w/a.ts": "v1" });
  const doc = (await documents.open("/w/a.ts"))!;
  const model = bridge.open("/w/a.ts") as FakeModel;
  model.type("v2");
  const release = hold();
  const saving = documents.save("/w/a.ts");
  await flush();
  model.type("v3");
  release();
  await saving;
  assert.equal(doc.dirty, true);
  assert.equal(model.value, "v3", "the save did not bring back the text it wrote");
  assert.equal(model.externals, 0);
});

test("a save is an undo stop in the document's model", async () => {
  const { documents, bridge } = setup({ "/w/a.ts": "a" });
  await documents.open("/w/a.ts");
  const model = bridge.open("/w/a.ts") as FakeModel;
  model.type("ab");
  await documents.save("/w/a.ts");
  assert.equal(model.stops, 1, "typing after the save starts a new undo group");
});

test("a rename or Save As keeps the document's model; its language follows the name", async () => {
  const { documents, bridge, created } = setup({ "/w/a.ts": "a" });
  await documents.open("/w/a.ts");
  const model = bridge.open("/w/a.ts") as FakeModel;
  documents.moved("/w/a.ts", "/w/a.md");
  assert.equal(bridge.open("/w/a.md"), model, "the same model, undo history and all");
  assert.equal(model.language, "markdown");
  assert.equal(bridge.documentOf(model)?.key, "/w/a.md");
  const untitled = documents.createUntitled({ text: "x" });
  const draft = bridge.open(untitled.key) as FakeModel;
  await documents.saveAs(untitled.key, "/w/new.rs");
  assert.equal(bridge.open("/w/new.rs"), draft);
  assert.equal(draft.language, "rust");
  assert.equal(created.length, 2);
});

test("closing a document disposes its model, unless a view still shows it", async () => {
  const { documents, bridge } = setup({ "/w/a.ts": "a", "/w/b.ts": "b" });
  await documents.open("/w/a.ts");
  await documents.open("/w/b.ts");
  const a = bridge.open("/w/a.ts") as FakeModel;
  const b = bridge.retain("/w/b.ts") as FakeModel;
  documents.close("/w/a.ts");
  assert.equal(a.disposed, true);
  assert.equal(a.listenerCount(), 0, "no listener left behind");
  documents.close("/w/b.ts");
  assert.equal(b.disposed, false, "still shown");
  bridge.release(b);
  assert.equal(b.disposed, true);
  assert.equal(bridge.size(), 0);
});

test("a workspace switch disposes every model", async () => {
  const { documents, bridge, created } = setup({ "/w/a.ts": "a", "/w/b.ts": "b" });
  await documents.open("/w/a.ts");
  await documents.open("/w/b.ts");
  bridge.open("/w/a.ts");
  bridge.open("/w/b.ts");
  documents.reset();
  assert.ok(created.every((model) => model.disposed));
  assert.equal(bridge.size(), 0);
});

test("a proposal's model edits the proposal, which is never saved over its file", async () => {
  const { disk, documents, bridge } = setup({ "/w/a.ts": "base" });
  const proposal = await documents.propose("/w/a.ts", "proposed");
  const model = bridge.open(proposal.key) as FakeModel;
  assert.equal(model.value, "proposed");
  model.type("proposed, edited");
  assert.equal(proposal.text, "proposed, edited");
  await assert.rejects(documents.save(proposal.key), /proposal/);
  assert.equal(disk.get("/w/a.ts"), "base");
});

test("decorations are kept per owner", async () => {
  const { documents, bridge } = setup({ "/w/a.ts": "abc" });
  await documents.open("/w/a.ts");
  const model = bridge.open("/w/a.ts") as FakeModel;
  bridge.setDecorations("/w/a.ts", "search", [{ start: 0, end: 1, className: "match" }]);
  bridge.setDecorations("/w/a.ts", "git", [{ start: 0, end: 3, wholeLine: true }]);
  bridge.clearDecorations("/w/a.ts", "search");
  assert.deepEqual(model.decorations.get("search"), []);
  assert.equal(model.decorations.get("git")?.length, 1, "another owner's are untouched");
});

test("the changed span is what lies between the common prefix and suffix", () => {
  assert.deepEqual(changedSpan("hello world", "hello brave world"), {
    start: 6,
    end: 6,
    text: "brave ",
  });
  assert.deepEqual(changedSpan("abcdef", "abXYZef"), { start: 2, end: 4, text: "XYZ" });
  assert.deepEqual(changedSpan("same", "same"), { start: 4, end: 4, text: "" });
  assert.deepEqual(changedSpan("abc", ""), { start: 0, end: 3, text: "" });
});

// ---------------------------------------------------------------------------------------
// The window's side: what typing redraws, and what the editor keeps per document
// ---------------------------------------------------------------------------------------

test("the window is not told about typing that changes nothing it shows", async () => {
  const { documents, bridge } = setup({ "/w/a.ts": "a", "/w/b.ts": "b" });
  await documents.open("/w/a.ts");
  await documents.open("/w/b.ts");
  const model = bridge.open("/w/a.ts") as FakeModel;
  const state = documents.stateRevision();
  const b = documents.documentRevision("/w/b.ts");
  model.type("a1"); // clean -> dirty: the tab's marker changes
  assert.ok(documents.stateRevision() > state);
  const dirty = documents.stateRevision();
  model.type("a12"); // still dirty: nothing the window shows changed
  model.type("a123");
  assert.equal(documents.stateRevision(), dirty);
  assert.equal(documents.documentRevision("/w/b.ts"), b, "another document is not touched");
  model.type("a"); // back to the saved text: clean again
  assert.ok(documents.stateRevision() > dirty);
});

test("editor view state belongs to the editor and follows the document's key", () => {
  const views = createEditorViews();
  const state = { cursorState: [{ position: { lineNumber: 3, column: 5 } }], scrollTop: 40 };
  views.setViewState("untitled:1", state);
  views.rename("untitled:1", "/w/notes.md"); // Save As
  assert.equal(views.getViewState("/w/notes.md"), state, "comes along, untouched");
  assert.equal(views.has("untitled:1"), false);
  views.forget("/w/notes.md"); // closed
  assert.equal(views.getViewState("/w/notes.md"), null, "a reopened document starts fresh");
});

test("an editor following its document to a new key takes focus only if it had it", () => {
  const views = createEditorViews();
  assert.equal(views.takeFocus("/w/a.ts"), true, "opening a document focuses its editor");
  views.setFocused("/w/a.ts", false); // the Explorer took focus, then renamed the file
  views.rename("/w/a.ts", "/w/b.ts");
  assert.equal(views.takeFocus("/w/b.ts"), false, "the rename leaves focus where it was");
  assert.equal(views.takeFocus("/w/b.ts"), true, "switching to it later focuses it again");
  views.setFocused("/w/b.ts", true); // typing in it, then Save As
  views.rename("/w/b.ts", "/w/c.ts");
  assert.equal(views.takeFocus("/w/c.ts"), true, "Save As from the editor keeps the editor");
});

test("changedSpan finds the same span as a character-by-character comparison, at any size", () => {
  const naive = (before: string, after: string) => {
    const shorter = Math.min(before.length, after.length);
    let prefix = 0;
    while (prefix < shorter && before[prefix] === after[prefix]) prefix++;
    let suffix = 0;
    while (
      suffix < shorter - prefix &&
      before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
    )
      suffix++;
    return {
      start: prefix,
      end: before.length - suffix,
      text: after.slice(prefix, after.length - suffix),
    };
  };
  let seed = 7;
  const random = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const alphabet = "ab\né😀";
  const make = (length: number) =>
    Array.from({ length }, () => alphabet[random(alphabet.length)]).join("");
  for (let i = 0; i < 400; i++) {
    const base = make(random(3) === 0 ? 5000 + random(5000) : random(40));
    const at = random(base.length + 1);
    const removed = random(Math.min(20, base.length - at) + 1);
    const after = base.slice(0, at) + make(random(8)) + base.slice(at + removed);
    assert.deepEqual(changedSpan(base, after), naive(base, after), `case ${i}`);
  }
  assert.deepEqual(changedSpan("same", "same"), { start: 4, end: 4, text: "" });
  assert.deepEqual(changedSpan("", "new"), { start: 0, end: 0, text: "new" });
});
