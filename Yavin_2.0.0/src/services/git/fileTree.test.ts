import assert from "node:assert/strict";
import test from "node:test";
import { buildFileTree, collectFiles, flattenVisible } from "./fileTree.ts";
import type { TreeNode } from "./fileTree.ts";

const byPath = (item: string) => item;

/** Renders a tree to nested strings for easy assertions: "folder/(child, child)" or "file". */
function shape(nodes: readonly TreeNode<string>[]): unknown[] {
  return nodes.map((n) => (n.kind === "file" ? n.name : { [n.name]: shape(n.children) }));
}

test("an empty list produces an empty tree", () => {
  assert.deepEqual(buildFileTree([], byPath), []);
});

test("a single top-level file with no folder is a leaf at the root", () => {
  const tree = buildFileTree(["README.md"], byPath);
  assert.deepEqual(shape(tree), ["README.md"]);
  assert.equal(tree[0].kind, "file");
  assert.equal(tree[0].path, "README.md");
});

test("files sharing a folder are grouped under one folder node", () => {
  const tree = buildFileTree(["src/a.ts", "src/b.ts"], byPath);
  assert.deepEqual(shape(tree), [{ src: ["a.ts", "b.ts"] }]);
});

test("a chain of single-child folders compacts into one row", () => {
  const tree = buildFileTree(["backend/app/yavin_core/reader_agent.py"], byPath);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].kind, "folder");
  assert.equal((tree[0] as { name: string }).name, "backend/app/yavin_core");
  assert.equal(tree[0].path, "backend/app/yavin_core");
  assert.deepEqual(shape(tree), [{ "backend/app/yavin_core": ["reader_agent.py"] }]);
});

test("compaction stops as soon as a folder has more than one child", () => {
  const tree = buildFileTree(
    ["backend/app/yavin_core/agents/orchestrator.py", "backend/app/yavin_core/message_bus.py"],
    byPath,
  );
  // "backend/app/yavin_core" compacts (each had exactly one child down to here), then splits
  // into a real "agents" folder and a loose file, matching the screenshot's tree exactly.
  assert.deepEqual(shape(tree), [
    { "backend/app/yavin_core": [{ agents: ["orchestrator.py"] }, "message_bus.py"] },
  ]);
});

test("folders sort before files, both alphabetically and case-insensitively, with natural number order", () => {
  const tree = buildFileTree(
    ["b.ts", "A.ts", "zdir/x.ts", "adir/file10.ts", "adir/file2.ts"],
    byPath,
  );
  assert.deepEqual(shape(tree), [
    { adir: ["file2.ts", "file10.ts"] },
    { zdir: ["x.ts"] },
    "A.ts",
    "b.ts",
  ]);
});

test("a leading slash is treated the same as no leading slash", () => {
  const withSlash = buildFileTree(["/work/src/a.ts"], byPath);
  const without = buildFileTree(["work/src/a.ts"], byPath);
  assert.deepEqual(shape(withSlash), shape(without));
});

test("each leaf keeps the original item, not a re-shaped copy", () => {
  interface Entry {
    path: string;
    status: string;
  }
  const entries: Entry[] = [{ path: "a.ts", status: "M" }];
  const tree = buildFileTree(entries, (e) => e.path);
  assert.equal(tree[0].kind, "file");
  assert.equal((tree[0] as { item: Entry }).item, entries[0]);
});

test("collectFiles returns every item, in the same order the fully-expanded tree shows them", () => {
  const tree = buildFileTree(["src/b.ts", "src/a.ts", "README.md", "src/sub/c.ts"], byPath);
  // Within "src", the folder ("sub") sorts before the files, which then sort alphabetically.
  assert.deepEqual(collectFiles(tree), ["src/sub/c.ts", "src/a.ts", "src/b.ts", "README.md"]);
});

test("flattenVisible expands everything by default, folders listed before files", () => {
  const tree = buildFileTree(["src/a.ts", "src/sub/b.ts", "README.md"], byPath);
  const rows = flattenVisible(tree, new Set());
  assert.deepEqual(
    rows.map((r) => [r.node.kind === "file" ? r.node.name : r.node.name, r.depth, r.expanded]),
    [
      ["src", 0, true],
      ["sub", 1, true],
      ["b.ts", 2, true],
      ["a.ts", 1, true],
      ["README.md", 0, true],
    ],
  );
});

test("flattenVisible hides everything under a collapsed folder, at any depth", () => {
  const tree = buildFileTree(["src/a.ts", "src/sub/deep/b.ts"], byPath);
  // "src" itself is not collapsible (compacted with nothing else -- wait, src has two children
  // here: "a.ts" and "sub", so no compaction). Collapse "src".
  const rows = flattenVisible(tree, new Set(["src"]));
  assert.deepEqual(
    rows.map((r) => r.node.name),
    ["src"],
  );
  assert.equal(rows[0].expanded, false);
});

test("flattenVisible collapsing a compacted multi-segment folder uses its combined path", () => {
  const tree = buildFileTree(["a/b/c/file.ts"], byPath);
  const folderPath = (tree[0] as { path: string }).path; // "a/b/c"
  assert.equal(folderPath, "a/b/c");
  const rows = flattenVisible(tree, new Set([folderPath]));
  assert.deepEqual(rows, [{ node: tree[0], depth: 0, expanded: false }]);
});

test("building the tree never mutates the input array or its items", () => {
  const items = ["b.ts", "a.ts"];
  const copy = [...items];
  buildFileTree(items, byPath);
  assert.deepEqual(items, copy);
});

test("a large, deeply mixed list builds and flattens quickly and completely", () => {
  const many = Array.from({ length: 5000 }, (_, i) => `dir${i % 40}/sub${i % 7}/file${i}.ts`);
  const started = Date.now();
  const tree = buildFileTree(many, byPath);
  const rows = flattenVisible(tree, new Set());
  assert.equal(collectFiles(tree).length, many.length);
  assert.equal(rows.filter((r) => r.node.kind === "file").length, many.length);
  assert.ok(Date.now() - started < 2000, "building and flattening 5,000 files should be fast");
});
