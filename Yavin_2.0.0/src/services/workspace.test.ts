import assert from "node:assert/strict";
import test from "node:test";
import type { FileNode } from "../types.ts";
import {
  findNode,
  isWithin,
  loadedDirectories,
  mergeChildren,
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

const file = (path: string, extra: Partial<FileNode> = {}): FileNode => ({
  name: path.slice(path.lastIndexOf("/") + 1),
  path,
  is_dir: false,
  size: 10,
  modified: 1000,
  ...extra,
});
const dir = (path: string, children?: FileNode[] | null): FileNode => ({
  ...file(path, { is_dir: true, size: 0 }),
  children: children ?? null,
});

test("re-listing a directory hands back the entries that did not change", () => {
  // The explorer memoizes a row on the node it renders, so an equal copy costs a re-render
  // of every row in the directory -- and a refresh walks every loaded directory.
  const previous = [file("/work/a.ts"), file("/work/b.ts")];
  const merged = mergeChildren(previous, [file("/work/a.ts"), file("/work/b.ts")]);
  assert.equal(merged[0], previous[0]);
  assert.equal(merged[1], previous[1]);
});

test("an entry that changed on disk is a new object, and its neighbours are not", () => {
  const previous = [file("/work/a.ts"), file("/work/b.ts")];
  const merged = mergeChildren(previous, [
    file("/work/a.ts", { size: 20, modified: 2000 }),
    file("/work/b.ts"),
  ]);
  assert.notEqual(merged[0], previous[0], "the edited file is not the old object");
  assert.equal(merged[0].size, 20);
  assert.equal(merged[1], previous[1], "its neighbour is untouched");
});

test("a folder that was loaded keeps both its children and its identity", () => {
  const inner = [file("/work/src/inner.ts")];
  const previous = [dir("/work/src", inner)];
  const merged = mergeChildren(previous, [dir("/work/src", null)]);
  assert.equal(merged[0], previous[0], "same object, so the row stays memoized");
  assert.equal(merged[0].children, inner);
});

test("a new entry appears without disturbing the ones already there", () => {
  const previous = [file("/work/a.ts")];
  const merged = mergeChildren(previous, [file("/work/a.ts"), file("/work/new.ts")]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0], previous[0]);
  assert.equal(merged[1].path, "/work/new.ts");
});

test("a listing that changes nothing leaves the whole tree as it was", () => {
  // Nothing above the directory re-renders either, so a refresh that finds no changes is
  // free to apply rather than rebuilding every ancestor.
  const tree = dir("/work", [dir("/work/src", [file("/work/src/inner.ts")]), file("/work/a.ts")]);
  const next = setChildren(tree, "/work/src", [file("/work/src/inner.ts")]);
  assert.equal(next, tree);
});

test("a listing that changes something rebuilds the path to it, and nothing else", () => {
  const sibling = file("/work/a.ts");
  const tree = dir("/work", [dir("/work/src", [file("/work/src/inner.ts")]), sibling]);
  const next = setChildren(tree, "/work/src", [file("/work/src/inner.ts", { modified: 2000 })]);
  assert.notEqual(next, tree, "the root is new, so React sees the change");
  assert.equal(next.children![1], sibling, "the untouched sibling is the same object");
});
