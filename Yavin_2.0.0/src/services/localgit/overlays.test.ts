import assert from "node:assert/strict";
import test from "node:test";
import { createDocumentService } from "../documents.ts";
import type { DocumentIO } from "../documents.ts";
import { createOverlayTracker } from "./overlays.ts";

/** A disk DocumentService reads from; every write is recorded (there must be none). */
function disk(files: Record<string, string>) {
  const content = new Map(Object.entries(files));
  const writes: string[] = [];
  const io: DocumentIO = {
    async read(path) {
      const text = content.get(path);
      if (text === undefined) throw new Error("The system cannot find the file specified.");
      return text;
    },
    async write(path) {
      writes.push(path);
      return 0;
    },
    async create(path) {
      writes.push(path);
      return 0;
    },
  } as DocumentIO;
  return { io, writes, content };
}

const ROOT = "/work/project";

test("only unsaved named documents inside the workspace take part", async () => {
  const d = disk({
    [`${ROOT}/a.ts`]: "a\n",
    [`${ROOT}/clean.ts`]: "clean\n",
    [`${ROOT}/src/deep.ts`]: "deep\n",
    ["/work/other/outside.ts"]: "outside\n",
    ["/work/project-sibling/x.ts"]: "sibling\n",
  });
  const documents = createDocumentService(d.io);
  await documents.open(`${ROOT}/a.ts`);
  await documents.open(`${ROOT}/clean.ts`);
  await documents.open(`${ROOT}/src/deep.ts`);
  await documents.open("/work/other/outside.ts");
  await documents.open("/work/project-sibling/x.ts");
  documents.edit(`${ROOT}/a.ts`, "a, edited\n");
  documents.edit(`${ROOT}/src/deep.ts`, "deep, edited\n");
  documents.edit("/work/other/outside.ts", "never\n");
  documents.edit("/work/project-sibling/x.ts", "never either\n");
  const untitled = documents.createUntitled({ text: "scratch" });
  await documents.propose(`${ROOT}/a.ts`, "an AI proposal\n");

  const tracker = createOverlayTracker(documents, [ROOT]);
  const overlays = tracker.overlays();
  assert.deepEqual(overlays.map((o) => o.path).sort(), [`${ROOT}/a.ts`, `${ROOT}/src/deep.ts`]);
  assert.equal(overlays.find((o) => o.path.endsWith("a.ts"))!.text(), "a, edited\n");
  // Untitled documents only when asked for, and never among the named overlays.
  assert.deepEqual(
    tracker.untitled().map((u) => u.id),
    [untitled.id],
  );
  assert.equal(tracker.untitled()[0].text(), "scratch");
  // Reading them wrote nothing and changed nothing.
  assert.deepEqual(d.writes, []);
  assert.equal(documents.get(`${ROOT}/a.ts`)!.dirty, true);
  tracker.dispose();
});

test("the overlay is what saving would write: line endings and byte order mark kept", async () => {
  const d = disk({ [`${ROOT}/crlf.txt`]: "﻿one\r\ntwo\r\n" });
  const documents = createDocumentService(d.io);
  const doc = (await documents.open(`${ROOT}/crlf.txt`))!;
  assert.equal(doc.text, "one\ntwo\n");
  documents.edit(`${ROOT}/crlf.txt`, "one\ntwo\nthree\n");
  const tracker = createOverlayTracker(documents, [ROOT]);
  const [overlay] = tracker.overlays();
  assert.equal(overlay.encoding, "utf8bom");
  assert.equal(overlay.lineEnding, "crlf");
  assert.equal(overlay.text(), "﻿one\r\ntwo\r\nthree\r\n");
  // A later version is a new overlay; the same version is the same one.
  const first = overlay.version;
  documents.edit(`${ROOT}/crlf.txt`, "changed\n");
  const [later] = tracker.overlays();
  assert.ok(later.version > first);
  assert.equal(later.text(), "﻿changed\r\n");
  assert.deepEqual(d.writes, []);
});

test("a dirty document whose file was deleted still takes part", async () => {
  const d = disk({ [`${ROOT}/gone.ts`]: "saved\n" });
  const documents = createDocumentService(d.io);
  await documents.open(`${ROOT}/gone.ts`);
  documents.edit(`${ROOT}/gone.ts`, "unsaved\n");
  d.content.delete(`${ROOT}/gone.ts`);
  await documents.applyResourceChanges([{ kind: "deleted", path: `${ROOT}/gone.ts` }]);
  const doc = documents.get(`${ROOT}/gone.ts`)!;
  assert.equal(doc.external?.kind, "deleted");
  const tracker = createOverlayTracker(documents, [ROOT]);
  assert.deepEqual(
    tracker.overlays().map((o) => [o.path, o.text()]),
    [[`${ROOT}/gone.ts`, "unsaved\n"]],
  );
});

test("a clean document, a saved one and a closed one do not take part", async () => {
  const d = disk({ [`${ROOT}/a.ts`]: "a\n" });
  const documents = createDocumentService(d.io);
  await documents.open(`${ROOT}/a.ts`);
  const tracker = createOverlayTracker(documents, [ROOT]);
  assert.deepEqual(tracker.overlays(), []);
  documents.edit(`${ROOT}/a.ts`, "b\n");
  assert.equal(tracker.overlays().length, 1);
  // Edited back to what is on disk: no longer unsaved.
  documents.edit(`${ROOT}/a.ts`, "a\n");
  assert.deepEqual(tracker.overlays(), []);
  documents.edit(`${ROOT}/a.ts`, "c\n");
  documents.close(`${ROOT}/a.ts`, { discard: true });
  assert.deepEqual(tracker.overlays(), []);
});
