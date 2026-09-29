import assert from "node:assert/strict";
import test from "node:test";
import { createDocumentService } from "../documents.ts";
import type { DocumentIO } from "../documents.ts";
import { applyWorkspaceEdit } from "./workspaceEdit.ts";
import type { WorkspaceEditHost } from "./workspaceEdit.ts";

const at = (line: number, character: number) => ({ line, character });
const edit = (line: number, from: number, to: number, newText: string) => ({
  range: { start: at(line, from), end: at(line, to) },
  newText,
});

function setup(files: Record<string, string>, readOnly: string[] = []) {
  const disk = new Map(Object.entries(files));
  const writes: string[] = [];
  const io: DocumentIO = {
    async read(path) {
      const text = disk.get(path);
      if (text === undefined) throw new Error(`No file ${path}`);
      return text;
    },
    async write(path, _expected, content) {
      writes.push(path);
      disk.set(path, content);
    },
    async create(path, content) {
      writes.push(path);
      disk.set(path, content);
    },
  };
  const documents = createDocumentService(io);
  const operations: string[] = [];
  const revealed: string[] = [];
  const host: WorkspaceEditHost = {
    documents,
    canEdit: (doc) => !readOnly.includes(doc.path ?? ""),
    open: async (path) => (await documents.open(path))!,
    reveal: (docs) => revealed.push(...docs.map((doc) => doc.key)),
    createFile: async (path) => {
      operations.push(`create ${path}`);
      disk.set(path, "");
    },
    renameFile: async (from, to) => {
      operations.push(`rename ${from} ${to}`);
      disk.set(to, disk.get(from) ?? "");
      disk.delete(from);
      documents.moved(from, to);
    },
    deleteFile: async (path) => {
      operations.push(`delete ${path}`);
      disk.delete(path);
    },
  };
  return { documents, host, disk, writes, operations, revealed };
}

test("edits to several files land in their documents, unsaved, and nothing is written", async () => {
  const { documents, host, writes, revealed } = setup({
    "/w/a.ts": "const old = 1;\nold + old;\n",
    "/w/b.ts": "import { old } from './a';\n",
  });
  const a = (await documents.open("/w/a.ts"))!;
  documents.edit("/w/a.ts", "const old = 1;\nold + old;\n// dirty already\n");
  const result = await applyWorkspaceEdit(
    {
      documentChanges: [
        {
          textDocument: { uri: "file:///w/a.ts", version: documents.get("/w/a.ts")!.version },
          edits: [edit(0, 6, 9, "renamed"), edit(1, 0, 3, "renamed"), edit(1, 6, 9, "renamed")],
        },
        // Not open yet: opened for the edit, and left open (it is now unsaved).
        {
          textDocument: { uri: "file:///w/b.ts", version: null },
          edits: [edit(0, 9, 12, "renamed")],
        },
      ],
    },
    host,
  );
  assert.deepEqual(result, { applied: true, changed: ["/w/a.ts", "/w/b.ts"] });
  assert.equal(
    documents.get("/w/a.ts")!.text,
    "const renamed = 1;\nrenamed + renamed;\n// dirty already\n",
  );
  assert.equal(documents.get("/w/b.ts")!.text, "import { renamed } from './a';\n");
  assert.ok(documents.get("/w/b.ts")!.dirty);
  assert.deepEqual(writes, [], "nothing written: saving is the user's");
  assert.deepEqual(revealed, ["/w/a.ts", "/w/b.ts"]);
  assert.ok(a);
});

test("a stale version, a read-only file or overlapping edits refuse the whole edit", async () => {
  const { documents, host } = setup({ "/w/a.ts": "one\n", "/w/locked.ts": "two\n" });
  await documents.open("/w/a.ts");
  const version = documents.get("/w/a.ts")!.version;
  documents.edit("/w/a.ts", "one!\n");
  const stale = await applyWorkspaceEdit(
    {
      documentChanges: [
        { textDocument: { uri: "file:///w/a.ts", version }, edits: [edit(0, 0, 3, "ONE")] },
      ],
    },
    host,
  );
  assert.equal(stale.applied, false);
  assert.match(stale.failureReason!, /changed since the edit was made/);

  const readOnly = setup({ "/w/a.ts": "one\n", "/w/locked.ts": "two\n" }, ["/w/locked.ts"]);
  const refused = await applyWorkspaceEdit(
    {
      changes: {
        "file:///w/a.ts": [edit(0, 0, 3, "ONE")],
        "file:///w/locked.ts": [edit(0, 0, 3, "TWO")],
      },
    },
    readOnly.host,
  );
  assert.equal(refused.applied, false);
  assert.match(refused.failureReason!, /locked\.ts is read-only/);
  // Nothing was changed, not even the file that could have been.
  assert.equal(readOnly.documents.get("/w/a.ts"), undefined);

  const overlapping = await applyWorkspaceEdit(
    { changes: { "file:///w/a.ts": [edit(0, 0, 3, "x"), edit(0, 1, 4, "y")] } },
    host,
  );
  assert.equal(overlapping.applied, false);
  assert.match(overlapping.failureReason!, /overlap/);
  assert.equal(documents.get("/w/a.ts")!.text, "one!\n");
});

test("create, rename and delete go through the host's file operations, in order", async () => {
  const { documents, host, operations, disk } = setup({
    "/w/old.ts": "content\n",
    "/w/gone.ts": "bye\n",
  });
  const result = await applyWorkspaceEdit(
    {
      documentChanges: [
        { kind: "create", uri: "file:///w/new.ts" },
        {
          textDocument: { uri: "file:///w/new.ts", version: null },
          edits: [edit(0, 0, 0, "fresh\n")],
        },
        { kind: "rename", oldUri: "file:///w/old.ts", newUri: "file:///w/moved.ts" },
        { kind: "delete", uri: "file:///w/gone.ts" },
      ],
    },
    host,
  );
  assert.equal(result.applied, true, result.failureReason);
  assert.deepEqual(operations, [
    "create /w/new.ts",
    "rename /w/old.ts /w/moved.ts",
    "delete /w/gone.ts",
  ]);
  assert.equal(documents.get("/w/new.ts")?.text, "fresh\n");
  assert.equal(disk.has("/w/gone.ts"), false);

  // A document with unsaved changes is not deleted from under them.
  await documents.open("/w/moved.ts");
  documents.edit("/w/moved.ts", "edited\n");
  const refused = await applyWorkspaceEdit(
    { documentChanges: [{ kind: "delete", uri: "file:///w/moved.ts" }] },
    host,
  );
  assert.match(refused.failureReason!, /unsaved changes/);
});

test("a file operation failing part-way stops there and says what was done", async () => {
  const { documents, host } = setup({ "/w/a.ts": "a\n" });
  host.deleteFile = async () => {
    throw new Error("Access is denied.");
  };
  const result = await applyWorkspaceEdit(
    {
      documentChanges: [
        { textDocument: { uri: "file:///w/a.ts", version: null }, edits: [edit(0, 0, 1, "A")] },
        { kind: "delete", uri: "file:///w/other.ts" },
      ],
    },
    host,
  );
  assert.equal(result.applied, false);
  assert.match(
    result.failureReason!,
    /Stopped part-way \(1 file\(s\) already edited\): Access is denied/,
  );
  assert.equal(documents.get("/w/a.ts")!.text, "A\n");
});
