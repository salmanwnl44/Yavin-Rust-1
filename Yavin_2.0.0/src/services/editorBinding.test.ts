import assert from "node:assert/strict";
import test from "node:test";
import { mapOffset, showDocumentText } from "./editorBinding.ts";
import type { TextSurface } from "./editorBinding.ts";
import { createEditorViews } from "./editorViews.ts";
import { createDocumentService, documentStatus } from "./documents.ts";
import type { DocumentIO } from "./documents.ts";
import { recordEdit, stepHistory } from "./editor.ts";

/** A textarea as the binding sees it, counting every write. */
function surface(value: string, start = 0, end = start): TextSurface & { writes: number } {
  let selection = [start, end];
  let text = value;
  const fake = {
    writes: 0,
    scrollTop: 0,
    get value() {
      return text;
    },
    set value(next: string) {
      text = next;
      fake.writes++;
      // A real textarea puts the caret at the end when its value is replaced.
      selection = [next.length, next.length];
    },
    get selectionStart() {
      return selection[0];
    },
    get selectionEnd() {
      return selection[1];
    },
    setSelectionRange(a: number, b: number) {
      selection = [a, b];
    },
  };
  return fake;
}

function disk(files: Record<string, string>) {
  const store = new Map(Object.entries(files));
  let operation = 0;
  let gate: Promise<void> | null = null;
  const io: DocumentIO = {
    async read(path) {
      const text = store.get(path);
      if (text === undefined) throw new Error("The system cannot find the file specified.");
      return text;
    },
    async write(path, expected, content) {
      if (gate) await gate;
      if (store.get(path) !== expected) throw new Error("File changed on disk.");
      store.set(path, content);
      return ++operation;
    },
    async create(path, content) {
      if (gate) await gate;
      if (store.has(path)) throw new Error("File already exists");
      store.set(path, content);
      return ++operation;
    },
  };
  const hold = () => {
    let release!: () => void;
    gate = new Promise((resolve) => (release = resolve));
    return () => {
      gate = null;
      release();
    };
  };
  return { io, store, hold };
}

/**
 * The editor's two paths as `TextEditor` wires them: input goes into the document; the
 * document's text is shown only when it is not the version the surface already shows.
 */
function bind(documents: ReturnType<typeof createDocumentService>, key: string, view: TextSurface) {
  let shown = documents.get(key)!.version;
  let renders = 0;
  const render = () => {
    renders++;
    const doc = documents.get(key);
    if (!doc || doc.version === shown) return;
    shown = doc.version;
    showDocumentText(view, doc.text);
  };
  const stop = documents.subscribe(render);
  return {
    type(text: string) {
      view.value = text; // what the browser does to the textarea
      shown = documents.edit(key, text).version;
    },
    stop,
    get renders() {
      return renders;
    },
  };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("offsets keep their place across an edit elsewhere in the text", () => {
  // Before the change: unchanged. After it: moved with the text. Inside it: to its end.
  assert.equal(mapOffset("hello world", "hello brave world", 2), 2);
  assert.equal(mapOffset("hello world", "hello brave world", 8), 14);
  assert.equal(mapOffset("abcdef", "abXYZef", 3), 5);
  assert.equal(mapOffset("abc", "", 2), 0);
  assert.equal(mapOffset("", "abc", 0), 0);
  // Ambiguous: the longest prefix puts the insertion at the end, and a caret exactly at an
  // insertion point stays before it.
  assert.equal(mapOffset("aaa", "aaaa", 3), 3);
});

test("the document's text is written only when the surface does not already show it", () => {
  const view = surface("one two", 4, 7);
  assert.equal(showDocumentText(view, "one two"), false);
  assert.equal(view.writes, 0, "the user's own edit is never written back");
  assert.equal(showDocumentText(view, "zero one two"), true);
  assert.equal(view.writes, 1);
  assert.deepEqual([view.selectionStart, view.selectionEnd], [9, 12], "selection moved with it");
});

test("typing into the editor updates the document without a write back or a loop", async () => {
  const { io } = disk({ "/w/a.ts": "a" });
  const documents = createDocumentService(io);
  const doc = (await documents.open("/w/a.ts"))!;
  const view = surface("a", 1);
  const binding = bind(documents, "/w/a.ts", view);
  binding.type("ab");
  binding.type("abc");
  assert.equal(doc.text, "abc");
  assert.equal(doc.version, 3);
  assert.equal(view.writes, 2, "only the two keystrokes themselves");
  assert.equal(binding.renders, 2, "one notification per edit, and no further edit from it");
  assert.equal(documentStatus(doc), "dirty");
  binding.stop();
});

test("a reload from disk reaches the editor, keeping the caret, and is not an edit", async () => {
  const { io, store } = disk({ "/w/a.ts": "line one\nline two\n" });
  const documents = createDocumentService(io);
  const doc = (await documents.open("/w/a.ts"))!;
  const view = surface(doc.text, 14); // in "line two"
  const binding = bind(documents, "/w/a.ts", view);
  const edits: number[] = [];
  documents.subscribe((event) => event.type === "changed" && edits.push(event.version));
  store.set("/w/a.ts", "line zero\nline one\nline two\n");
  await documents.applyResourceChanges([{ kind: "modified", path: "/w/a.ts" }]);
  assert.equal(view.value, "line zero\nline one\nline two\n");
  assert.equal(view.selectionStart, 24, "still in 'line two'");
  assert.deepEqual(edits, [], "no fake user edit came back from showing it");
  assert.equal(doc.dirty, false);
  binding.stop();
});

test("a conflict leaves the editor showing the user's text", async () => {
  const { io, store } = disk({ "/w/a.ts": "base" });
  const documents = createDocumentService(io);
  const doc = (await documents.open("/w/a.ts"))!;
  const view = surface("base");
  const binding = bind(documents, "/w/a.ts", view);
  binding.type("mine");
  store.set("/w/a.ts", "theirs");
  await documents.applyResourceChanges([{ kind: "modified", path: "/w/a.ts" }]);
  assert.equal(documentStatus(doc), "conflicted");
  assert.equal(view.value, "mine");
  // Revert: the document takes the disk's text, and the editor follows it.
  await documents.reload("/w/a.ts", { discard: true });
  assert.equal(view.value, "theirs");
  binding.stop();
});

test("an older save completing shows a newer edit as still dirty", async () => {
  const { io, hold } = disk({ "/w/a.ts": "v1" });
  const documents = createDocumentService(io);
  const doc = (await documents.open("/w/a.ts"))!;
  const view = surface("v1");
  const binding = bind(documents, "/w/a.ts", view);
  binding.type("v2");
  const release = hold();
  const saving = documents.save("/w/a.ts");
  await flush();
  binding.type("v3");
  release();
  await saving;
  assert.equal(doc.dirty, true);
  assert.equal(view.value, "v3", "the save did not bring back the text it wrote");
  binding.stop();
});

test("the window is not told about typing that changes nothing it shows", async () => {
  const { io } = disk({ "/w/a.ts": "a", "/w/b.ts": "b" });
  const documents = createDocumentService(io);
  await documents.open("/w/a.ts");
  await documents.open("/w/b.ts");
  const state = documents.stateRevision();
  const b = documents.documentRevision("/w/b.ts");
  documents.edit("/w/a.ts", "a1"); // clean -> dirty: the tab's marker changes
  assert.ok(documents.stateRevision() > state);
  const dirty = documents.stateRevision();
  const a = documents.documentRevision("/w/a.ts");
  documents.edit("/w/a.ts", "a12"); // still dirty: only this document's editor cares
  documents.edit("/w/a.ts", "a123");
  assert.equal(documents.stateRevision(), dirty);
  assert.ok(documents.documentRevision("/w/a.ts") > a);
  assert.equal(documents.documentRevision("/w/b.ts"), b, "another document's editor is not told");
  documents.edit("/w/a.ts", "a"); // back to the saved text: clean again
  assert.ok(documents.stateRevision() > dirty);
  assert.equal(documents.documentRevision("/w/none.ts"), -1);
});

test("editor view state belongs to the editor and follows the document's key", () => {
  const views = createEditorViews();
  const history = views.history("untitled:1");
  recordEdit(history, { text: "", start: 0, end: 0 });
  views.setViewState("untitled:1", {
    selectionStart: 3,
    selectionEnd: 5,
    scrollTop: 40,
    scrollLeft: 0,
  });
  views.rename("untitled:1", "/w/notes.md"); // Save As
  assert.equal(views.history("/w/notes.md"), history, "undo history comes along");
  assert.equal(views.getViewState("/w/notes.md")?.selectionEnd, 5);
  assert.equal(views.has("untitled:1"), false);
  const undone = stepHistory(views.history("/w/notes.md"), { text: "x", start: 1, end: 1 }, "undo");
  assert.equal(undone?.text, "");
  views.forget("/w/notes.md"); // closed
  assert.equal(views.getViewState("/w/notes.md"), null);
  assert.equal(views.history("/w/notes.md").past.length, 0, "a reopened document starts fresh");
});

test("a proposal is shown and edited through the same binding, and never saved", async () => {
  const { io, store } = disk({ "/w/a.ts": "base" });
  const documents = createDocumentService(io);
  const proposal = await documents.propose("/w/a.ts", "proposed");
  const view = surface(proposal.text);
  const binding = bind(documents, proposal.key, view);
  binding.type("proposed, edited");
  assert.equal(proposal.text, "proposed, edited");
  assert.equal(documentStatus(proposal), "proposed");
  await assert.rejects(documents.save(proposal.key), /proposal/);
  assert.equal(store.get("/w/a.ts"), "base");
  binding.stop();
});
