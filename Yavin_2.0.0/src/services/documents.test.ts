import assert from "node:assert/strict";
import test from "node:test";
import {
  createDocumentService,
  decode,
  documentStatus,
  DocumentError,
  encode,
  fingerprint,
} from "./documents.ts";
import type { DocumentEvent, DocumentIO } from "./documents.ts";
import { languageFor, languageLabel } from "./language.ts";

/**
 * A disk for the Document Model to work against: files by exact path, guarded writes that
 * behave like `write_file_guarded` (refused unless the file still holds `expected`), exclusive
 * creates, operation ids, and gates that hold a write or read open so interleavings can be
 * arranged exactly -- no timers anywhere.
 */
function fakeDisk(files: Record<string, string> = {}) {
  const disk = new Map(Object.entries(files));
  let operations = 0;
  const calls: string[] = [];
  const failures = { write: null as string | null, read: new Set<string>() };
  let writeGate: Promise<void> | null = null;
  let readGate: Promise<void> | null = null;
  const hold = (which: "write" | "read") => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    if (which === "write") writeGate = gate;
    else readGate = gate;
    return () => {
      if (which === "write") writeGate = null;
      else readGate = null;
      release();
    };
  };
  const io: DocumentIO = {
    async read(path) {
      calls.push(`read ${path}`);
      if (readGate) await readGate;
      if (failures.read.has(path)) throw new Error("The file is locked");
      const text = disk.get(path);
      if (text === undefined) throw new Error("The system cannot find the file specified.");
      return text;
    },
    async write(path, expected, content) {
      calls.push(`write ${path}`);
      if (writeGate) await writeGate;
      if (failures.write) throw new Error(failures.write);
      if (disk.get(path) !== expected)
        throw new Error("File changed on disk. Reopen or review its current contents.");
      disk.set(path, content);
      return ++operations;
    },
    async create(path, content) {
      calls.push(`create ${path}`);
      if (writeGate) await writeGate;
      if (failures.write) throw new Error(failures.write);
      if (disk.has(path)) throw new Error(`File already exists: ${path}`);
      disk.set(path, content);
      return ++operations;
    },
  };
  return {
    io,
    disk,
    calls,
    failures,
    hold,
    get lastOperation() {
      return operations;
    },
  };
}

function setup(files: Record<string, string> = {}, base: string | null = null) {
  const fake = fakeDisk(files);
  const docs = createDocumentService(fake.io, { base: () => base });
  const events: DocumentEvent[] = [];
  docs.subscribe((event) => events.push(event));
  const types = () => events.map((event) => event.type);
  // Not spread: that would copy `lastOperation`'s value instead of its getter.
  return Object.assign(fake, { docs, events, types });
}

/** Lets pending promise callbacks run. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

// ---------------------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------------------

test("every spelling of one resource opens the same document", async () => {
  const { docs, calls } = setup({ "C:/Work/a.ts": "a" }, "C:/Work");
  const first = await docs.open("C:/Work/a.ts");
  for (const spelling of [
    "C:\\Work\\a.ts",
    "c:/work/A.ts",
    "\\\\?\\C:\\Work\\a.ts",
    "file:///C:/Work/a.ts",
    "./a.ts",
    "C:/Work/src/../a.ts",
  ])
    assert.equal(await docs.open(spelling), first, spelling);
  assert.equal(docs.all().length, 1);
  assert.equal(calls.filter((call) => call.startsWith("read")).length, 1, "read once");
  assert.equal(docs.get("c:\\WORK\\a.ts"), first);
});

test("concurrent opens of one resource share a single read", async () => {
  const { docs, calls, hold } = setup({ "/w/a.ts": "a" });
  const release = hold("read");
  const one = docs.open("/w/a.ts");
  const two = docs.open("/w//a.ts");
  release();
  assert.equal(await one, await two);
  assert.equal(calls.length, 1);
});

test("POSIX paths are case-sensitive, and each root's files are their own", async () => {
  const { docs } = setup({ "/w/a.ts": "lower", "/w/A.ts": "upper", "/v/a.ts": "other" });
  const lower = await docs.open("/w/a.ts");
  const upper = await docs.open("/w/A.ts");
  const other = await docs.open("/v/a.ts");
  assert.notEqual(lower, upper);
  assert.notEqual(lower, other);
  assert.equal(lower?.text, "lower");
  assert.equal(other?.text, "other");
});

// ---------------------------------------------------------------------------------------
// Loading: encodings and line endings
// ---------------------------------------------------------------------------------------

test("loading keeps the disk text as the base and presents it normalized", async () => {
  const { docs } = setup({
    "/w/lf.ts": "a\nb\n",
    "/w/crlf.ts": "a\r\nb\r\n",
    "/w/bom.ts": "\uFEFFa\r\nb",
    "/w/empty.ts": "",
    "/w/utf8.md": "héllo — ✓ 🚀",
  });
  const lf = (await docs.open("/w/lf.ts"))!;
  assert.deepEqual([lf.text, lf.lineEnding, lf.encoding], ["a\nb\n", "lf", "utf8"]);
  const crlf = (await docs.open("/w/crlf.ts"))!;
  assert.deepEqual([crlf.text, crlf.lineEnding], ["a\nb\n", "crlf"]);
  assert.equal(crlf.base?.raw, "a\r\nb\r\n", "the exact disk text is what a save guards on");
  const bom = (await docs.open("/w/bom.ts"))!;
  assert.deepEqual([bom.text, bom.encoding, bom.lineEnding], ["a\nb", "utf8bom", "crlf"]);
  const empty = (await docs.open("/w/empty.ts"))!;
  assert.deepEqual([empty.text, empty.dirty, documentStatus(empty)], ["", false, "clean"]);
  const utf8 = (await docs.open("/w/utf8.md"))!;
  assert.equal(utf8.text, "héllo — ✓ 🚀");
  assert.equal(utf8.languageId, "markdown");
  for (const doc of [lf, crlf, bom, empty, utf8]) assert.equal(doc.version, 1);
});

test("a file that cannot be loaded opens no document and is left alone", async () => {
  const { docs, disk, failures } = setup({ "/w/locked.ts": "keep" });
  failures.read.add("/w/locked.ts");
  await assert.rejects(docs.open("/w/missing.ts"), /cannot find/);
  // Binary and oversized files are refused natively by the same read (`read_file_content`).
  await assert.rejects(docs.open("/w/locked.ts"), /locked/);
  assert.equal(docs.all().length, 0);
  assert.equal(disk.get("/w/locked.ts"), "keep");
  // A failed open can be retried: nothing is cached.
  failures.read.clear();
  assert.equal((await docs.open("/w/locked.ts"))?.text, "keep");
});

test("decode and encode round-trip, and mixed endings take the majority", () => {
  for (const raw of ["", "a", "a\nb", "a\r\nb\r\n", "\uFEFF", "\uFEFFx\r\ny"]) {
    const decoded = decode(raw);
    assert.equal(encode(decoded.text, decoded.encoding, decoded.lineEnding), raw, raw);
  }
  assert.equal(decode("a\r\nb\r\nc\n").lineEnding, "crlf");
  assert.equal(decode("a\nb\nc\r\n").lineEnding, "lf");
  assert.equal(decode("a\rb").text, "a\nb", "a lone CR is a line break, as a textarea has it");
});

test("fingerprints differ for same-length contents and include the length", () => {
  assert.notEqual(fingerprint("abc"), fingerprint("abd"));
  assert.equal(fingerprint("abc"), fingerprint("abc"));
  assert.match(fingerprint("abc"), /^3:[0-9a-f]{16}$/);
});

test("the language comes from the name", () => {
  assert.equal(languageFor("/w/App.tsx"), "typescriptreact");
  assert.equal(languageFor("C:\\w\\lib.RS"), "rust");
  assert.equal(languageFor("Dockerfile"), "dockerfile");
  assert.equal(languageFor(".gitignore"), "ignore");
  assert.equal(languageFor(".env"), "plaintext");
  assert.equal(languageFor("notes"), "plaintext");
  assert.equal(languageLabel("typescript"), "TypeScript");
  assert.equal(languageLabel("unknown-id"), "unknown-id");
});

// ---------------------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------------------

test("edits advance the version and dirty follows the persisted text", async () => {
  const { docs, types } = setup({ "/w/a.ts": "one" });
  const doc = (await docs.open("/w/a.ts"))!;
  docs.edit("/w/a.ts", "one!");
  assert.deepEqual([doc.version, doc.dirty, documentStatus(doc)], [2, true, "dirty"]);
  docs.edit("/w/a.ts", "one!!");
  assert.equal(doc.version, 3);
  docs.edit("/w/a.ts", "one!!");
  assert.equal(doc.version, 3, "no change, no new version");
  docs.edit("/w/a.ts", "one");
  assert.deepEqual([doc.version, doc.dirty], [4, false], "back to what is on disk is clean");
  assert.deepEqual(types(), ["opened", "changed", "changed", "changed"]);
  assert.equal(docs.buffers()["/w/a.ts"], "one", "the one copy editors read");
});

test("text reaching the model with CR line endings is normalized", async () => {
  const { docs } = setup({ "/w/a.ts": "x\r\ny" });
  const doc = (await docs.open("/w/a.ts"))!;
  docs.edit("/w/a.ts", "x\r\ny");
  assert.equal(doc.version, 1, "the same text as loaded");
  assert.equal(doc.dirty, false);
});

// ---------------------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------------------

test("a save goes through the guarded write and keeps the file's own format", async () => {
  const { docs, disk, types } = setup({ "/w/a.ts": "\uFEFFa\r\nb\r\n" });
  const doc = (await docs.open("/w/a.ts"))!;
  docs.edit("/w/a.ts", "a\nb\nc\n");
  const saving = docs.save("/w/a.ts");
  assert.equal(documentStatus(doc), "saving");
  assert.equal(doc.dirty, true, "not clean before the write completes");
  await saving;
  assert.equal(disk.get("/w/a.ts"), "\uFEFFa\r\nb\r\nc\r\n", "BOM and CRLF kept");
  assert.deepEqual([doc.dirty, documentStatus(doc)], [false, "clean"]);
  assert.equal(doc.base?.raw, "\uFEFFa\r\nb\r\nc\r\n");
  assert.deepEqual(types(), ["opened", "changed", "saving", "saved"]);
});

test("an LF file stays LF, and a mixed file is saved in its majority style when edited", async () => {
  const { docs, disk } = setup({ "/w/lf.ts": "a\nb\n", "/w/mixed.ts": "a\r\nb\r\nc\n" });
  await docs.open("/w/lf.ts");
  docs.edit("/w/lf.ts", "a\nb\nc\n");
  await docs.save("/w/lf.ts");
  assert.equal(disk.get("/w/lf.ts"), "a\nb\nc\n");
  const mixed = (await docs.open("/w/mixed.ts"))!;
  assert.equal(mixed.lineEnding, "crlf");
  // Unedited, it is never written, so its mix survives.
  await docs.save("/w/mixed.ts");
  assert.equal(disk.get("/w/mixed.ts"), "a\r\nb\r\nc\n");
  docs.edit("/w/mixed.ts", "a\nb\nc\nd\n");
  await docs.save("/w/mixed.ts");
  assert.equal(disk.get("/w/mixed.ts"), "a\r\nb\r\nc\r\nd\r\n", "documented policy");
});

test("a file that stops being UTF-8 text while open is neither reloaded nor written over", async () => {
  // `read_file_content` refuses anything that is not UTF-8 text; the fake's read failure and
  // changed bytes stand in for a file rewritten as Latin-1 by another program.
  const { docs, disk, failures } = setup({ "/w/a.ts": "caf\u00e9" });
  const doc = (await docs.open("/w/a.ts"))!;
  docs.edit("/w/a.ts", "mine");
  disk.set("/w/a.ts", "<latin-1 bytes>");
  failures.read.add("/w/a.ts");
  await docs.applyResourceChanges([{ kind: "modified", path: "/w/a.ts" }]);
  assert.equal(doc.external?.kind, "unreadable");
  assert.equal(doc.text, "mine");
  // A save is tried and refused by the guard (the native side cannot even read it): nothing
  // is written, and the document is not clean.
  await assert.rejects(docs.save("/w/a.ts"));
  assert.equal(disk.get("/w/a.ts"), "<latin-1 bytes>");
  assert.equal(doc.dirty, true);
});

test("opening and saving without edits rewrites nothing", async () => {
  const { docs, calls } = setup({ "/w/a.ts": "a\r\nb" });
  await docs.open("/w/a.ts");
  await docs.save("/w/a.ts");
  assert.ok(!calls.some((call) => call.startsWith("write")));
});

test("a failed save leaves the document dirty and says why", async () => {
  const { docs, disk, failures, types } = setup({ "/w/a.ts": "a" });
  const doc = (await docs.open("/w/a.ts"))!;
  docs.edit("/w/a.ts", "b");
  failures.write = "Disk write denied";
  await assert.rejects(docs.save("/w/a.ts"), /Disk write denied/);
  assert.equal(disk.get("/w/a.ts"), "a");
  assert.deepEqual([doc.dirty, documentStatus(doc)], [true, "saveFailed"]);
  assert.ok(types().includes("saveFailed"));
  // It is retried as an ordinary save.
  failures.write = null;
  await docs.save("/w/a.ts");
  assert.deepEqual([disk.get("/w/a.ts"), doc.dirty, documentStatus(doc)], ["b", false, "clean"]);
});

test("a save refused because the file changed puts the document in conflict", async () => {
  const { docs, disk, types } = setup({ "/w/a.ts": "base" });
  const doc = (await docs.open("/w/a.ts"))!;
  docs.edit("/w/a.ts", "mine");
  disk.set("/w/a.ts", "theirs"); // changed by another program, not yet reported
  await assert.rejects(docs.save("/w/a.ts"), /changed on disk/);
  assert.equal(disk.get("/w/a.ts"), "theirs", "never overwritten");
  assert.equal(doc.text, "mine", "never lost");
  assert.equal(documentStatus(doc), "conflicted");
  assert.ok(types().includes("conflict"));
  await assert.rejects(docs.save("/w/a.ts"), (error: unknown) => {
    return error instanceof DocumentError && error.code === "conflict";
  });
});

test("an operation that could not be recorded changes nothing and leaves the document dirty", async () => {
  // `write_file_guarded` refuses before touching the disk when Module 04 cannot record the
  // intent; to the Document Model that is a failed write like any other.
  const { docs, disk, failures } = setup({ "/w/a.ts": "a" });
  const doc = (await docs.open("/w/a.ts"))!;
  docs.edit("/w/a.ts", "b");
  failures.write = "Cannot record this operation for crash recovery: disk full";
  await assert.rejects(docs.save("/w/a.ts"), /crash recovery/);
  assert.equal(disk.get("/w/a.ts"), "a");
  assert.equal(doc.dirty, true);
});

test("an older save completing never marks a newer version clean", async () => {
  const { docs, disk, hold } = setup({ "/w/a.ts": "v1" });
  const doc = (await docs.open("/w/a.ts"))!;
  for (let n = 2; n <= 10; n++) docs.edit("/w/a.ts", `v${n}`);
  assert.equal(doc.version, 10);
  const release = hold("write");
  const saving = docs.save("/w/a.ts"); // writes version 10
  await flush();
  docs.edit("/w/a.ts", "v11"); // typed while it is on its way
  release();
  await saving;
  assert.equal(disk.get("/w/a.ts"), "v10");
  assert.equal(doc.version, 11);
  assert.equal(doc.dirty, true, "version 11 has not been persisted");
  assert.equal(documentStatus(doc), "dirty");
  // The next save persists it, guarded on what the first one wrote.
  await docs.save("/w/a.ts");
  assert.deepEqual([disk.get("/w/a.ts"), doc.dirty], ["v11", false]);
});

test("typing back to the saved text while a save is in flight ends clean", async () => {
  const { docs, hold } = setup({ "/w/a.ts": "a" });
  const doc = (await docs.open("/w/a.ts"))!;
  docs.edit("/w/a.ts", "b");
  const release = hold("write");
  const saving = docs.save("/w/a.ts");
  await flush();
  docs.edit("/w/a.ts", "bc");
  docs.edit("/w/a.ts", "b");
  release();
  await saving;
  assert.equal(doc.dirty, false, "what is in memory is exactly what was written");
});

test("a second save while one is in flight does not start another write", async () => {
  const { docs, calls, hold } = setup({ "/w/a.ts": "a" });
  await docs.open("/w/a.ts");
  docs.edit("/w/a.ts", "b");
  const release = hold("write");
  const first = docs.save("/w/a.ts");
  await docs.save("/w/a.ts");
  release();
  await first;
  assert.equal(calls.filter((call) => call.startsWith("write")).length, 1);
});

// ---------------------------------------------------------------------------------------
// External changes
// ---------------------------------------------------------------------------------------

test("a clean document follows an external change, as a new version", async () => {
  const { docs, disk, types } = setup({ "/w/a.ts": "old" });
  const doc = (await docs.open("/w/a.ts"))!;
  disk.set("/w/a.ts", "new\r\n");
  await docs.applyResourceChanges([{ kind: "modified", path: "/w/a.ts" }]);
  assert.deepEqual([doc.text, doc.version, doc.dirty], ["new\n", 2, false]);
  assert.equal(doc.lineEnding, "crlf");
  assert.equal(doc.base?.raw, "new\r\n");
  assert.equal(documentStatus(doc), "clean");
  assert.deepEqual(types(), ["opened", "reloaded"]);
});

test("a dirty document is never overwritten by an external change", async () => {
  const { docs, disk, types } = setup({ "/w/a.ts": "base" });
  const doc = (await docs.open("/w/a.ts"))!;
  docs.edit("/w/a.ts", "mine");
  disk.set("/w/a.ts", "theirs");
  await docs.applyResourceChanges([{ kind: "modified", path: "/w/a.ts" }]);
  assert.equal(doc.text, "mine");
  assert.equal(disk.get("/w/a.ts"), "theirs");
  assert.equal(documentStatus(doc), "conflicted");
  assert.deepEqual(types().slice(-2), ["externallyChanged", "conflict"]);
  // Reported again, it is still one conflict.
  await docs.applyResourceChanges([{ kind: "modified", path: "/w/a.ts" }]);
  assert.equal(types().filter((type) => type === "conflict").length, 1);
});

test("a same-size external change is seen by content, not size or time", async () => {
  const { docs, disk } = setup({ "/w/a.ts": "aaaa" });
  const doc = (await docs.open("/w/a.ts"))!;
  disk.set("/w/a.ts", "bbbb");
  await docs.applyResourceChanges([{ kind: "modified", path: "/w/a.ts" }]);
  assert.equal(doc.text, "bbbb");
  // A reported change that left the same text (a touch) is nothing.
  await docs.applyResourceChanges([{ kind: "modified", path: "/w/a.ts" }]);
  assert.equal(doc.version, 2);
});

test("a change the watcher credits to the document's own save needs nothing", async () => {
  const fake = setup({ "/w/a.ts": "a" });
  const { docs, calls } = fake;
  const doc = (await docs.open("/w/a.ts"))!;
  docs.edit("/w/a.ts", "b");
  await docs.save("/w/a.ts");
  const reads = calls.length;
  await docs.applyResourceChanges([
    { kind: "modified", path: "/w/a.ts", operation: fake.lastOperation },
  ]);
  assert.equal(calls.length, reads, "not even re-read");
  assert.deepEqual([doc.text, doc.version, doc.dirty], ["b", 2, false]);
});

test("the own save's change arriving before the write returns is still recognised", async () => {
  const { docs, calls, hold } = setup({ "/w/a.ts": "a" });
  const doc = (await docs.open("/w/a.ts"))!;
  docs.edit("/w/a.ts", "b");
  const release = hold("write");
  const saving = docs.save("/w/a.ts");
  await flush();
  // The watcher is faster than the IPC reply: the event names operation 1, which the save
  // has not been told yet.
  await docs.applyResourceChanges([{ kind: "modified", path: "/w/a.ts", operation: 1 }]);
  release();
  await saving;
  assert.equal(calls.filter((call) => call.startsWith("read")).length, 1, "the open only");
  assert.deepEqual([doc.dirty, documentStatus(doc)], [false, "clean"]);
});

test("an external change during a save is checked once the save ends", async () => {
  const { docs, disk, hold } = setup({ "/w/a.ts": "a" });
  const doc = (await docs.open("/w/a.ts"))!;
  docs.edit("/w/a.ts", "b");
  const release = hold("write");
  const saving = docs.save("/w/a.ts");
  await flush();
  await docs.applyResourceChanges([{ kind: "modified", path: "/w/a.ts" }]);
  release();
  await saving;
  // The save won (the guarded write ran against "a"), and the check found its own text.
  assert.equal(disk.get("/w/a.ts"), "b");
  assert.equal(documentStatus(doc), "clean");
  // An external write after the save is an external change like any other.
  disk.set("/w/a.ts", "c");
  await docs.applyResourceChanges([{ kind: "modified", path: "/w/a.ts" }]);
  assert.equal(doc.text, "c");
});

test("a change by another Yavin operation (Git, say) is checked, not trusted", async () => {
  const { docs, disk } = setup({ "/w/a.ts": "a" });
  const doc = (await docs.open("/w/a.ts"))!;
  disk.set("/w/a.ts", "discarded by git");
  await docs.applyResourceChanges([{ kind: "modified", path: "/w/a.ts", operation: 99 }]);
  assert.equal(doc.text, "discarded by git");
});

test("a deleted file keeps its document, and saving recreates it", async () => {
  const { docs, disk, calls } = setup({ "/w/a.ts": "a" });
  const doc = (await docs.open("/w/a.ts"))!;
  disk.delete("/w/a.ts");
  await docs.applyResourceChanges([{ kind: "deleted", path: "/w/a.ts" }]);
  assert.equal(doc.text, "a");
  assert.deepEqual(doc.external, { kind: "deleted" });
  assert.equal(documentStatus(doc), "externallyChanged");
  await docs.save("/w/a.ts");
  assert.ok(calls.includes("create /w/a.ts"), "created, never written over something");
  assert.equal(disk.get("/w/a.ts"), "a");
  assert.equal(doc.external, null);
});

test("a deleted file's text, held only in memory, is never replaced by a new file there", async () => {
  const { docs, disk } = setup({ "/w/a.ts": "only copy" });
  const doc = (await docs.open("/w/a.ts"))!;
  disk.delete("/w/a.ts");
  await docs.applyResourceChanges([{ kind: "deleted", path: "/w/a.ts" }]);
  // Nothing on disk holds it any more: closing it would lose it, so it is not clean.
  assert.equal(doc.dirty, true);
  assert.throws(() => docs.close("/w/a.ts"), /unsaved/);
  disk.set("/w/a.ts", "someone else's new file");
  await docs.applyResourceChanges([{ kind: "created", path: "/w/a.ts" }]);
  assert.equal(doc.text, "only copy", "not reloaded");
  assert.equal(documentStatus(doc), "conflicted");
  assert.equal(disk.get("/w/a.ts"), "someone else's new file");
});

test("recreating a deleted file never replaces a file created there meanwhile", async () => {
  const { docs, disk } = setup({ "/w/a.ts": "only copy" });
  const doc = (await docs.open("/w/a.ts"))!;
  disk.delete("/w/a.ts");
  await docs.applyResourceChanges([{ kind: "deleted", path: "/w/a.ts" }]);
  disk.set("/w/a.ts", "created meanwhile"); // not reported yet
  await assert.rejects(docs.save("/w/a.ts"), /already exists/);
  assert.equal(disk.get("/w/a.ts"), "created meanwhile");
  assert.equal(doc.text, "only copy", "kept, not replaced by what was found");
  assert.equal(documentStatus(doc), "conflicted");
});

test("a deleted file restored to its contents is back in step", async () => {
  const { docs, disk } = setup({ "/w/a.ts": "a" });
  const doc = (await docs.open("/w/a.ts"))!;
  disk.delete("/w/a.ts");
  await docs.applyResourceChanges([{ kind: "deleted", path: "/w/a.ts" }]);
  disk.set("/w/a.ts", "a");
  await docs.applyResourceChanges([{ kind: "created", path: "/w/a.ts" }]);
  assert.equal(doc.external, null);
  assert.equal(doc.version, 1);
  assert.equal(doc.dirty, false, "on disk again");
});

test("an external rename away is a deletion of the open file", async () => {
  const { docs, disk } = setup({ "/w/a.ts": "a" });
  const doc = (await docs.open("/w/a.ts"))!;
  disk.set("/w/b.ts", "a");
  disk.delete("/w/a.ts");
  await docs.applyResourceChanges([{ kind: "renamed", from: "/w/a.ts", path: "/w/b.ts" }]);
  assert.deepEqual(doc.external, { kind: "deleted" });
  assert.equal(docs.get("/w/b.ts"), undefined, "no document appears for the new name");
});

test("lost notifications re-check the documents under the rescanned folder", async () => {
  const { docs, disk } = setup({ "/w/src/a.ts": "a", "/w/b.ts": "b" });
  const inside = (await docs.open("/w/src/a.ts"))!;
  const outside = (await docs.open("/w/b.ts"))!;
  disk.set("/w/src/a.ts", "a2");
  disk.set("/w/b.ts", "b2");
  await docs.applyResourceChanges([], ["/w/src"]);
  assert.equal(inside.text, "a2");
  assert.equal(outside.text, "b", "outside the scope: not re-read");
});

test("revalidate re-checks every open file", async () => {
  const { docs, disk } = setup({ "/w/a.ts": "a", "/w/b.ts": "b" });
  const a = (await docs.open("/w/a.ts"))!;
  const b = (await docs.open("/w/b.ts"))!;
  docs.edit("/w/b.ts", "b-mine");
  disk.set("/w/a.ts", "a2");
  disk.set("/w/b.ts", "b2");
  await docs.revalidate();
  assert.equal(a.text, "a2");
  assert.equal(documentStatus(b), "conflicted");
  assert.equal(b.text, "b-mine");
});

test("a file that cannot be read after a change is reported, not treated as gone", async () => {
  const { docs, failures } = setup({ "/w/a.ts": "a" });
  const doc = (await docs.open("/w/a.ts"))!;
  failures.read.add("/w/a.ts");
  await docs.applyResourceChanges([{ kind: "modified", path: "/w/a.ts" }]);
  assert.equal(doc.external?.kind, "unreadable");
  assert.equal(doc.text, "a");
  failures.read.clear();
  await docs.applyResourceChanges([{ kind: "modified", path: "/w/a.ts" }]);
  assert.equal(doc.external, null, "readable again, and unchanged");
});

// ---------------------------------------------------------------------------------------
// Reload and conflict resolution
// ---------------------------------------------------------------------------------------

test("reload replaces a clean document with a new version", async () => {
  const { docs, disk } = setup({ "/w/a.ts": "a" });
  const doc = (await docs.open("/w/a.ts"))!;
  disk.set("/w/a.ts", "b");
  await docs.reload("/w/a.ts");
  assert.deepEqual([doc.text, doc.version, doc.dirty], ["b", 2, false]);
});

test("reload never silently discards edits", async () => {
  const { docs, disk } = setup({ "/w/a.ts": "a" });
  const doc = (await docs.open("/w/a.ts"))!;
  docs.edit("/w/a.ts", "mine");
  disk.set("/w/a.ts", "theirs");
  await assert.rejects(docs.reload("/w/a.ts"), (error: unknown) => {
    return error instanceof DocumentError && error.code === "dirty";
  });
  assert.equal(doc.text, "mine");
  await docs.reload("/w/a.ts", { discard: true });
  assert.deepEqual([doc.text, doc.dirty, doc.external, doc.version], ["theirs", false, null, 3]);
});

test("edits typed while a reload reads are kept", async () => {
  const { docs, disk, hold } = setup({ "/w/a.ts": "a" });
  const doc = (await docs.open("/w/a.ts"))!;
  disk.set("/w/a.ts", "theirs");
  const release = hold("read");
  const reloading = docs.reload("/w/a.ts");
  docs.edit("/w/a.ts", "typed");
  release();
  await reloading;
  assert.equal(doc.text, "typed");
  assert.equal(documentStatus(doc), "conflicted");
});

test("a failed reload changes nothing", async () => {
  const { docs, disk } = setup({ "/w/a.ts": "a" });
  const doc = (await docs.open("/w/a.ts"))!;
  disk.delete("/w/a.ts");
  await assert.rejects(docs.reload("/w/a.ts"));
  assert.deepEqual([doc.text, doc.version, doc.dirty], ["a", 1, false]);
});

test("keeping the local version makes the next save replace the new disk text", async () => {
  const { docs, disk } = setup({ "/w/a.ts": "base" });
  const doc = (await docs.open("/w/a.ts"))!;
  docs.edit("/w/a.ts", "mine");
  disk.set("/w/a.ts", "theirs");
  await docs.applyResourceChanges([{ kind: "modified", path: "/w/a.ts" }]);
  await docs.keepLocal("/w/a.ts");
  assert.equal(doc.external, null);
  assert.equal(doc.dirty, true);
  assert.equal(disk.get("/w/a.ts"), "theirs", "nothing written by choosing");
  await docs.save("/w/a.ts");
  assert.equal(disk.get("/w/a.ts"), "mine");
});

// ---------------------------------------------------------------------------------------
// Untitled
// ---------------------------------------------------------------------------------------

test("an untitled document is edited in memory and becomes a file by Save As", async () => {
  const { docs, disk, events } = setup({}, "/w");
  const doc = docs.createUntitled();
  assert.equal(doc.name, "Untitled-1");
  assert.deepEqual([doc.source.kind, doc.path, doc.dirty], ["untitled", null, false]);
  assert.equal(documentStatus(doc), "neverSaved");
  docs.edit(doc.key, "hello\n");
  assert.equal(doc.dirty, true);
  await assert.rejects(docs.save(doc.key), (error: unknown) => {
    return error instanceof DocumentError && error.code === "untitled";
  });
  const previousKey = doc.key;
  await docs.saveAs(previousKey, "/w/hello.md");
  assert.equal(disk.get("/w/hello.md"), "hello\n");
  assert.deepEqual(
    [doc.source.kind, doc.path, doc.key, doc.name],
    ["disk", "/w/hello.md", "/w/hello.md", "hello.md"],
  );
  assert.equal(doc.languageId, "markdown");
  assert.equal(doc.dirty, false);
  assert.equal(docs.get(previousKey), undefined);
  assert.equal(docs.get("/w/hello.md"), doc);
  assert.deepEqual(events.at(-1), {
    type: "sourceChanged",
    id: doc.id,
    key: "/w/hello.md",
    previousId: "untitled:1",
    previousKey: "untitled:1",
  });
});

test("Save As never replaces a file that changed after it was read", async () => {
  const { docs, disk, hold, calls } = setup({ "/w/taken.ts": "existing" });
  const doc = docs.createUntitled({ text: "new" });
  const release = hold("write");
  const saving = docs.saveAs(doc.key, "/w/taken.ts");
  await flush();
  assert.ok(calls.includes("write /w/taken.ts"), "a guarded replace of what was read");
  disk.set("/w/taken.ts", "changed meanwhile");
  release();
  await assert.rejects(saving, /changed on disk/);
  assert.equal(disk.get("/w/taken.ts"), "changed meanwhile");
  assert.equal(doc.source.kind, "untitled", "still untitled, content kept");
  assert.equal(doc.text, "new");
});

test("Save As onto a file open in another editor is refused", async () => {
  const { docs } = setup({ "/w/a.ts": "a" });
  await docs.open("/w/a.ts");
  const doc = docs.createUntitled({ text: "x" });
  await assert.rejects(docs.saveAs(doc.key, "/w/A.ts".toLowerCase()), (error: unknown) => {
    return error instanceof DocumentError && error.code === "open";
  });
});

test("an edit during Save As leaves the new file's document dirty", async () => {
  const { docs, disk, hold } = setup({});
  const doc = docs.createUntitled({ text: "v1" });
  const release = hold("write");
  const saving = docs.saveAs(doc.key, "/w/new.ts");
  await flush();
  docs.edit(doc.key, "v2");
  release();
  await saving;
  assert.equal(disk.get("/w/new.ts"), "v1");
  assert.equal(doc.dirty, true);
});

// ---------------------------------------------------------------------------------------
// Proposed
// ---------------------------------------------------------------------------------------

test("a proposal is a document beside its file, never saved over it", async () => {
  const { docs, disk } = setup({ "/w/a.ts": "base\r\n" });
  const file = (await docs.open("/w/a.ts"))!;
  const proposal = await docs.propose("/w/a.ts", "proposed\n");
  assert.notEqual(proposal, file);
  assert.equal(proposal.source.kind, "proposed");
  assert.equal(docs.get("/w/a.ts"), file, "the file's document is still the file's");
  assert.equal(proposal.lineEnding, "crlf", "written like the file it proposes for");
  const { baseHash, proposedHash } = docs.proposal(proposal.key);
  assert.equal(baseHash, fingerprint("base\r\n"));
  assert.equal(proposedHash, fingerprint("proposed\r\n"));
  docs.edit(proposal.key, "proposed, edited\n");
  assert.equal(proposal.version, 2);
  assert.equal(documentStatus(proposal), "proposed");
  await assert.rejects(docs.save(proposal.key), (error: unknown) => {
    return error instanceof DocumentError && error.code === "proposed";
  });
  assert.equal(disk.get("/w/a.ts"), "base\r\n");
  assert.equal(docs.buffers()[proposal.key], undefined, "not an editor buffer");
});

test("a proposal goes stale when its file changes, and only then", async () => {
  const { docs, disk } = setup({ "/w/a.ts": "base" });
  const proposal = await docs.propose("/w/a.ts", "proposed");
  assert.equal(await docs.isStale(proposal.key), false);
  disk.set("/w/a.ts", "edited elsewhere");
  await docs.applyResourceChanges([{ kind: "modified", path: "/w/a.ts" }]);
  assert.equal(documentStatus(proposal), "stale");
  assert.equal(proposal.text, "proposed", "its content is not replaced");
  disk.set("/w/a.ts", "base");
  assert.equal(await docs.isStale(proposal.key), false, "back to its base");
});

test("a proposal for a new file is stale once something is created there", async () => {
  const { docs, disk } = setup({});
  const proposal = await docs.propose("/w/new.ts", "content");
  assert.equal(docs.proposal(proposal.key).baseHash, null);
  disk.set("/w/new.ts", "someone else's");
  assert.equal(await docs.isStale(proposal.key), true);
});

// ---------------------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------------------

test("closing: clean closes, dirty is refused unless discarded, saving is refused", async () => {
  const { docs, hold } = setup({ "/w/a.ts": "a", "/w/b.ts": "b" });
  await docs.open("/w/a.ts");
  docs.close("/w/a.ts");
  assert.equal(docs.get("/w/a.ts"), undefined);
  await docs.open("/w/b.ts");
  docs.edit("/w/b.ts", "b!");
  assert.throws(() => docs.close("/w/b.ts"), /unsaved/);
  const release = hold("write");
  const saving = docs.save("/w/b.ts");
  assert.throws(() => docs.close("/w/b.ts", { discard: true }), /being saved/);
  release();
  await saving;
  docs.close("/w/b.ts");
  assert.equal(docs.all().length, 0);
});

test("reopening after close reads the file again as a new document", async () => {
  const { docs, disk } = setup({ "/w/a.ts": "a" });
  const first = await docs.open("/w/a.ts");
  docs.close("/w/a.ts");
  disk.set("/w/a.ts", "a2");
  const second = await docs.open("/w/a.ts");
  assert.notEqual(second, first);
  assert.equal(second?.text, "a2");
});

test("a reset drops documents, and loads that were in flight stay dropped", async () => {
  const { docs, hold } = setup({ "/w/a.ts": "a", "/w/b.ts": "b" });
  await docs.open("/w/a.ts");
  const release = hold("read");
  const late = docs.open("/w/b.ts");
  docs.reset();
  release();
  assert.equal(await late, null);
  assert.equal(docs.all().length, 0);
});

test("a check still reading when the document closes changes nothing", async () => {
  const { docs, disk, hold } = setup({ "/w/a.ts": "a" });
  const doc = (await docs.open("/w/a.ts"))!;
  disk.set("/w/a.ts", "b");
  const release = hold("read");
  const checking = docs.applyResourceChanges([{ kind: "modified", path: "/w/a.ts" }]);
  docs.close("/w/a.ts");
  release();
  await checking;
  assert.equal(doc.text, "a");
});

test("a rename by Yavin moves the documents under it to their new identity", async () => {
  const { docs } = setup({ "C:/w/src/a.ts": "a", "C:/w/src/deep/b.rs": "b", "C:/w/c.ts": "c" });
  const a = (await docs.open("C:/w/src/a.ts"))!;
  const b = (await docs.open("C:/w/src/deep/b.rs"))!;
  const c = (await docs.open("C:/w/c.ts"))!;
  docs.edit(a.key, "a!");
  const moves = docs.moved("c:/w/SRC", "C:/w/lib");
  assert.deepEqual(moves, [
    { previousKey: "C:/w/src/a.ts", key: "C:/w/lib/a.ts" },
    { previousKey: "C:/w/src/deep/b.rs", key: "C:/w/lib/deep/b.rs" },
  ]);
  assert.equal(docs.get("C:/w/lib/a.ts"), a);
  assert.equal(docs.get("C:/w/src/a.ts"), undefined);
  assert.equal(a.text, "a!", "edits go with it");
  assert.equal(b.languageId, "rust");
  assert.equal(c.path, "C:/w/c.ts");
});

test("a Yavin rename the watcher reported before it returned leaves the file in step", async () => {
  const { docs, disk } = setup({ "/w/a.ts": "a" });
  const doc = (await docs.open("/w/a.ts"))!;
  disk.set("/w/b.ts", "a");
  disk.delete("/w/a.ts");
  // The event first, the rename's reply second: the old path is checked and found empty.
  await docs.applyResourceChanges([
    { kind: "renamed", from: "/w/a.ts", path: "/w/b.ts", operation: 7 },
  ]);
  assert.deepEqual(doc.external, { kind: "deleted" });
  docs.moved("/w/a.ts", "/w/b.ts");
  await flush();
  assert.equal(doc.external, null);
  assert.equal(documentStatus(doc), "clean");
});

test("a delete by Yavin closes the documents under it", async () => {
  const { docs } = setup({ "/w/src/a.ts": "a", "/w/b.ts": "b" });
  await docs.open("/w/src/a.ts");
  await docs.open("/w/b.ts");
  docs.edit("/w/src/a.ts", "dirty");
  assert.deepEqual(docs.removed("/w/src"), ["/w/src/a.ts"]);
  assert.deepEqual(
    docs.all().map((doc) => doc.key),
    ["/w/b.ts"],
  );
});

test("listeners are told what changed and one failing listener does not stop the rest", async () => {
  const { docs } = setup({ "/w/a.ts": "a" });
  const seen: string[] = [];
  docs.subscribe(() => {
    throw new Error("broken listener");
  });
  const stop = docs.subscribe((event) => seen.push(event.type));
  const before = docs.revision();
  const original = console.error;
  console.error = () => {};
  try {
    await docs.open("/w/a.ts");
    docs.edit("/w/a.ts", "b");
    stop();
    docs.edit("/w/a.ts", "c");
  } finally {
    console.error = original;
  }
  assert.deepEqual(seen, ["opened", "changed"]);
  assert.ok(docs.revision() > before);
});
