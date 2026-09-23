import assert from "node:assert/strict";
import test from "node:test";
import { buildDecorations, parseGitEntries, sameDecorations } from "./status.ts";

test("decorations cover every status, use workspace casing and mark ancestor folders", () => {
  const entries = parseGitEntries(
    " M src/a.ts\0R  src/new.ts\0src/old.ts\0UU c.ts\0?? n.ts\0A  d/e.ts\0 T t\0",
    "c:/work",
  );
  const { files, folders } = buildDecorations(entries, "C:/Work");
  assert.deepEqual(
    [...files],
    [
      ["C:/Work/src/a.ts", "M"],
      ["C:/Work/src/new.ts", "R"],
      ["C:/Work/c.ts", "!"],
      ["C:/Work/n.ts", "U"],
      ["C:/Work/d/e.ts", "A"],
      ["C:/Work/t", "T"],
    ],
  );
  assert.deepEqual([...folders].sort(), ["C:/Work/d", "C:/Work/src"]);
  assert.equal(files.has("C:/Work/SRC/a.ts"), false);
});

test("a copy record consumes its source path, just like a rename", () => {
  const entries = parseGitEntries("C  new.ts\0old.ts\0", "/work");
  assert.deepEqual(entries, [
    {
      path: "/work/new.ts",
      originalPath: "/work/old.ts",
      index: "C",
      worktree: " ",
      untracked: false,
      conflict: false,
    },
  ]);
});

test("a plain deletion has no original path and is not a conflict", () => {
  const entries = parseGitEntries(" D gone.ts\0", "/work");
  assert.deepEqual(entries, [
    {
      path: "/work/gone.ts",
      index: " ",
      worktree: "D",
      untracked: false,
      conflict: false,
    },
  ]);
});

test("a malformed record without the porcelain separator is rejected", () => {
  assert.throws(() => parseGitEntries("MMa.ts\0", "/work"), /Invalid Git status record/);
});

test("a truncated rename record with no following path is rejected", () => {
  assert.throws(() => parseGitEntries("R  new.ts\0", "/work"), /Incomplete Git rename record/);
});

test("non-ASCII filenames pass through untouched, needing no escaping logic", () => {
  const entries = parseGitEntries(" M \u00e9\u00e9\u00e9.ts\0?? \u65e5\u672c\u8a9e.ts\0", "/work");
  assert.deepEqual(
    entries.map((e) => e.path),
    ["/work/\u00e9\u00e9\u00e9.ts", "/work/\u65e5\u672c\u8a9e.ts"],
  );
});

test("decorations that say the same thing compare equal", () => {
  // The explorer takes them as a prop, so a rebuilt-but-identical map re-rendered the tree.
  const entries = parseGitEntries(" M src/a.ts\0?? b.ts\0", "C:/Work");
  const first = buildDecorations(entries, "C:/Work");
  const second = buildDecorations(entries, "C:/Work");
  assert.notEqual(first, second, "they really are different objects");
  assert.equal(sameDecorations(first, second), true);
});

test("a changed mark, a new file and a lost folder all compare unequal", () => {
  const base = buildDecorations(parseGitEntries(" M src/a.ts\0", "C:/Work"), "C:/Work");
  const changedMark = buildDecorations(parseGitEntries("?? src/a.ts\0", "C:/Work"), "C:/Work");
  const extraFile = buildDecorations(
    parseGitEntries(" M src/a.ts\0 M b.ts\0", "C:/Work"),
    "C:/Work",
  );
  const noFolder = buildDecorations(parseGitEntries(" M a.ts\0", "C:/Work"), "C:/Work");

  assert.equal(sameDecorations(base, changedMark), false, "the mark changed");
  assert.equal(sameDecorations(base, extraFile), false, "a file was added");
  assert.equal(sameDecorations(base, noFolder), false, "a marked folder went away");
});
