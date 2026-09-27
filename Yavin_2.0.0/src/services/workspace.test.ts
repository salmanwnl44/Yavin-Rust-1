import assert from "node:assert/strict";
import test from "node:test";
import { isWithin, parentOf, parseGitStatus, remapPath, validateEntryName } from "./workspace.ts";

test("folder rename remaps descendants without matching sibling prefixes", () => {
  assert.equal(parentOf("/work/src/b.ts"), "/work/src");
  assert.equal(remapPath("/work/src/a.ts", "/work/src", "/work/lib"), "/work/lib/a.ts");
  assert.equal(remapPath("/work/src-old/a.ts", "/work/src", "/work/lib"), "/work/src-old/a.ts");
  assert.equal(remapPath("/work/src", "/work/src", "/work/lib"), "/work/lib");
  assert.equal(isWithin("/work/src-old", "/work/src"), false);
});

test("Windows paths are within and remapped whatever their case and separators", () => {
  assert.equal(isWithin("c:/work/src/a.ts", "C:/Work/src"), true);
  assert.equal(isWithin("C:\\Work\\src\\a.ts", "C:/Work/src"), true);
  assert.equal(isWithin("C:/Work/src/a.ts", "C:/Work/src/"), true);
  assert.equal(isWithin("C:/Work/src-old/a.ts", "C:/Work/src"), false);
  // POSIX paths still compare exactly: `/Work` and `/work` can be two real folders.
  assert.equal(isWithin("/work/src", "/Work"), false);
  assert.equal(isWithin("/a", ""), false);
  assert.equal(remapPath("c:/work/src/a.ts", "C:/Work/src", "C:/Work/lib"), "C:/Work/lib/a.ts");
  assert.equal(remapPath("C:/Work/src", "C:/Work/src/", "C:/Work/lib"), "C:/Work/lib");
  assert.equal(remapPath("C:/Work/srcx/a.ts", "C:/Work/src", "C:/Work/lib"), "C:/Work/srcx/a.ts");
});

test("Git status preserves special filenames and consumes rename source records", () => {
  const result = parseGitStatus(
    ' M file with spaces.ts\0?? quote"name.ts\0R  new.ts\0old.ts\0 M line\nbreak.ts\0',
    "/work",
  );
  assert.deepEqual(result, {
    "/work/file with spaces.ts": "M",
    '/work/quote"name.ts': "U",
    "/work/new.ts": "R",
    "/work/line\nbreak.ts": "M",
  });
});

test("Git conflicts are distinct from untracked files", () => {
  assert.deepEqual(parseGitStatus("UU conflict.ts\0AA added.ts\0 D removed.ts\0", "/work/"), {
    "/work/conflict.ts": "CONFLICT",
    "/work/added.ts": "CONFLICT",
    "/work/removed.ts": "D",
  });
  assert.deepEqual(parseGitStatus("", "/work"), {});
});

test("entry names are rejected when they are invalid on any supported platform", () => {
  for (const name of [
    "",
    "  ",
    ".",
    "..",
    "a:b",
    "a\\b",
    "a*",
    "name.",
    "name ",
    "CON",
    "com1.txt",
  ])
    assert.notEqual(validateEntryName(name), null, name);
  assert.notEqual(validateEntryName("a/b.ts"), null);
  assert.equal(validateEntryName("a/b.ts", true), null);
  assert.notEqual(validateEntryName("a//b.ts", true), null);
  assert.notEqual(validateEntryName("../b.ts", true), null);
  assert.equal(validateEntryName(".gitignore"), null);
  assert.equal(validateEntryName("console.ts"), null);
});
