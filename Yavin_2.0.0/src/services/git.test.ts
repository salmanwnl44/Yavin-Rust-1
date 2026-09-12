import assert from "node:assert/strict";
import test from "node:test";
import { buildDecorations, parseGitEntries } from "./git.ts";

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
