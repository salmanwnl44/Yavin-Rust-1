import assert from "node:assert/strict";
import test from "node:test";
import { buildTree, flattenVisible, toggleExpansion, suiteId } from "./treeProvider.ts";
import { parseJestJson } from "./jestJson.ts";
import type { TestTreeNode } from "./treeProvider.ts";

// Two files; one has a nested suite (math > edge) plus a top-level case.
const REPORT = parseJestJson(
  JSON.stringify({
    testResults: [
      {
        name: "/w/src/math.test.ts",
        assertionResults: [
          { ancestorTitles: ["math"], title: "adds", fullName: "math adds", status: "passed" },
          {
            ancestorTitles: ["math", "edge"],
            title: "zero",
            fullName: "math edge zero",
            status: "failed",
            failureMessages: ["boom"],
            location: { line: 9 },
          },
          { ancestorTitles: [], title: "top", fullName: "top", status: "passed" },
        ],
      },
      {
        name: "/w/src/str.test.ts",
        assertionResults: [{ title: "trims", fullName: "trims", status: "skipped" }],
      },
    ],
  }),
);

function byId(nodes: readonly TestTreeNode[], id: string): TestTreeNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    const found = byId(n.children, id);
    if (found) return found;
  }
  return undefined;
}

test("buildTree nests cases under their suite path with a file root", () => {
  const tree = buildTree(REPORT);
  assert.equal(tree.length, 2, "one node per file");
  const math = tree[0]!;
  assert.equal(math.kind, "file");
  assert.equal(math.label, "math.test.ts");
  // math.test.ts -> suite "math" (adds, suite "edge" (zero)), case "top"
  const mathSuite = math.children.find((c) => c.label === "math")!;
  assert.equal(mathSuite.kind, "suite");
  assert.equal(mathSuite.depth, 1);
  const edge = mathSuite.children.find((c) => c.label === "edge")!;
  assert.equal(edge.kind, "suite");
  assert.equal(edge.children[0]!.label, "zero");
  assert.equal(edge.children[0]!.depth, 3, "case nested two suites deep");
  assert.ok(math.children.some((c) => c.kind === "case" && c.label === "top"));
});

test("suite and file status aggregate from their descendant cases", () => {
  const tree = buildTree(REPORT);
  const math = tree[0]!;
  assert.equal(math.status, "failed", "a failing descendant makes the file failed");
  const edge = byId(tree, suiteId("/w/src/math.test.ts", ["math", "edge"]))!;
  assert.equal(edge.status, "failed");
  const mathSuite = byId(tree, suiteId("/w/src/math.test.ts", ["math"]))!;
  assert.equal(mathSuite.status, "failed", "aggregates through nested suites");
});

test("a case node carries its flaky flag through the projection", () => {
  const report = parseJestJson(
    JSON.stringify({
      testResults: [
        {
          name: "/w/a.test.ts",
          assertionResults: [{ title: "x", fullName: "x", status: "passed" }],
        },
      ],
    }),
  );
  // Inject flaky on the model case and re-project.
  const flakyReport = {
    ...report,
    files: report.files.map((f) => ({
      ...f,
      cases: f.cases.map((c) => ({ ...c, flaky: true })),
    })),
  };
  const node = buildTree(flakyReport)[0]!.children[0]!;
  assert.equal(node.flaky, true);
});

test("case nodes carry navigation data: file, line, and failure message", () => {
  const tree = buildTree(REPORT);
  const zero = byId(tree, "/w/src/math.test.ts\u0000math edge zero")!;
  assert.equal(zero.kind, "case");
  assert.equal(zero.file, "/w/src/math.test.ts");
  assert.equal(zero.line, 9);
  assert.equal(zero.message, "boom");
  assert.equal(zero.expandable, false);
});

test("node ids are stable across a re-run that reorders cases", () => {
  const reordered = parseJestJson(
    JSON.stringify({
      testResults: [
        {
          name: "/w/src/math.test.ts",
          assertionResults: [
            { ancestorTitles: [], title: "top", fullName: "top", status: "passed" },
            { ancestorTitles: ["math"], title: "adds", fullName: "math adds", status: "passed" },
          ],
        },
      ],
    }),
  );
  const a = buildTree(REPORT)[0]!;
  const b = buildTree(reordered)[0]!;
  assert.equal(a.id, b.id, "file id is the path, independent of order");
  // "math adds" keeps the same id in both trees despite moving position.
  const idA = "/w/src/math.test.ts\u0000math adds";
  assert.ok(byId([a], idA) && byId([b], idA), "the case id survives reordering");
});

test("flattenVisible shows files expanded by default and hides collapsed subtrees", () => {
  const tree = buildTree(REPORT);
  // Default: files expanded, so we see files + their direct children + nested (suites default-open? no).
  const rows = flattenVisible(tree, new Set());
  const labels = rows.map((r) => r.node.label);
  assert.ok(labels.includes("math.test.ts"));
  assert.ok(
    labels.includes("math"),
    "a file's direct suite child is visible when the file is open",
  );
  // suites are not default-expanded, so nested cases under them are hidden until toggled
  assert.ok(!labels.includes("zero"), "a case under a collapsed suite is hidden");
});

test("toggleExpansion opens a collapsed suite and re-collapses it", () => {
  const tree = buildTree(REPORT);
  const mathSuite = byId(tree, suiteId("/w/src/math.test.ts", ["math"]))!;
  let expanded = toggleExpansion(new Set(), mathSuite); // open the suite
  let labels = flattenVisible(tree, expanded).map((r) => r.node.label);
  assert.ok(labels.includes("edge"), "opening the suite reveals its child suite");
  assert.ok(labels.includes("adds"), "opening the suite reveals its direct case");

  expanded = toggleExpansion(expanded, mathSuite); // collapse again
  labels = flattenVisible(tree, expanded).map((r) => r.node.label);
  assert.ok(!labels.includes("adds"), "collapsing the suite hides its cases again");
});

test("toggleExpansion collapses a default-expanded file on the first click", () => {
  const tree = buildTree(REPORT);
  const math = tree[0]!;
  const expanded = toggleExpansion(new Set(), math); // first click collapses a default-open file
  const rows = flattenVisible(tree, expanded);
  const row = rows.find((r) => r.node.id === math.id)!;
  assert.equal(row.expanded, false, "the file is now collapsed");
  assert.ok(!rows.some((r) => r.node.label === "math"), "its children are hidden");
});
