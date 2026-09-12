import assert from "node:assert/strict";
import test from "node:test";
import type { FileNode } from "../types.ts";
import {
  findNode,
  isWithin,
  loadedDirectories,
  nearestLoadedDirectory,
  parentOf,
  parseGitStatus,
  remapPath,
  setChildren,
  validateEntryName,
} from "./workspace.ts";

test("folder rename remaps descendants without matching sibling prefixes", () => {
  assert.equal(remapPath("/work/src/a.ts", "/work/src", "/work/lib"), "/work/lib/a.ts");
  assert.equal(remapPath("/work/src-old/a.ts", "/work/src", "/work/lib"), "/work/src-old/a.ts");
  assert.equal(remapPath("/work/src", "/work/src", "/work/lib"), "/work/lib");
  assert.equal(isWithin("/work/src-old", "/work/src"), false);
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

test("a new listing keeps the children of folders that were already loaded", () => {
  const tree: FileNode = {
    name: "work",
    path: "/work",
    is_dir: true,
    children: [
      {
        name: "src",
        path: "/work/src",
        is_dir: true,
        children: [{ name: "a.ts", path: "/work/src/a.ts", is_dir: false }],
      },
      { name: "gone", path: "/work/gone", is_dir: true, children: null },
    ],
  };
  const listed = setChildren(tree, "/work", [
    { name: "new", path: "/work/new", is_dir: true, children: null },
    { name: "src", path: "/work/src", is_dir: true, children: null },
  ]);
  assert.deepEqual(
    listed.children?.map((child) => child.name),
    ["new", "src"],
  );
  assert.deepEqual(
    findNode(listed, "/work/src")?.children?.map((child) => child.path),
    ["/work/src/a.ts"],
  );

  const deeper = setChildren(listed, "/work/src", [
    { name: "b.ts", path: "/work/src/b.ts", is_dir: false },
  ]);
  assert.deepEqual(
    findNode(deeper, "/work/src")?.children?.map((child) => child.name),
    ["b.ts"],
  );
  assert.equal(findNode(deeper, "/work/new")?.children, null);
  assert.equal(findNode(deeper, "/work/missing"), null);
  assert.deepEqual(loadedDirectories(deeper), ["/work", "/work/src"]);
  assert.equal(parentOf("/work/src/b.ts"), "/work/src");
  assert.equal(nearestLoadedDirectory(deeper, "/work/src/b.ts"), "/work/src");
  assert.equal(nearestLoadedDirectory(deeper, "/work/new/deep/c.ts"), "/work");
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
