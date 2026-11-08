/**
 * Hierarchical Tasks projection (WS7 Part 5): the pure Workspace → Package → Group → Task tree, its
 * grouping, composable filters, search, flatten/expansion, stable identity, and a large-collection
 * performance check. Deterministic fixtures; no DOM, process or filesystem.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_PRESENTATION, type ResolvedTask } from "./model.ts";
import {
  buildTaskTree,
  filterOptions,
  filterTasks,
  flattenVisible,
  packageKeyFor,
  presentationGroup,
  tasksSignature,
  toggleExpansion,
  type TaskTreeNode,
} from "./taskTree.ts";

function task(over: Partial<ResolvedTask> & { id: string }): ResolvedTask {
  return {
    label: over.id,
    command: "echo",
    args: [],
    cwd: null,
    env: {},
    profile: null,
    dependsOn: [],
    group: null,
    isDefault: false,
    problemMatcher: [],
    presentation: DEFAULT_PRESENTATION,
    scope: "discovered",
    ...over,
  };
}

/** Collect every task-leaf node, in flattened order. */
function leaves(roots: readonly TaskTreeNode[]): TaskTreeNode[] {
  return flattenVisible(roots, new Set())
    .map((r) => r.node)
    .filter((n) => n.kind === "task");
}
const kinds = (roots: readonly TaskTreeNode[]): string[] =>
  flattenVisible(roots, new Set()).map(
    (r) => `${"  ".repeat(r.node.depth)}${r.node.kind}:${r.node.label}`,
  );

// --- grouping ----------------------------------------------------------------------------------

test("presentationGroup: explicit metadata wins; conventions only fill the gap", () => {
  assert.equal(presentationGroup(task({ id: "npm:build", group: "build" })), "build");
  assert.equal(presentationGroup(task({ id: "npm:test", group: "test" })), "test");
  // A task explicitly in the build group named "lint" stays build — a name never overrides metadata.
  assert.equal(presentationGroup(task({ id: "x:lint", group: "build" })), "build");
  // Problem-matcher metadata.
  assert.equal(presentationGroup(task({ id: "npm:a", problemMatcher: ["eslint"] })), "lint");
  assert.equal(presentationGroup(task({ id: "npm:a", problemMatcher: ["ruff"] })), "lint");
  assert.equal(presentationGroup(task({ id: "npm:a", problemMatcher: ["tsc"] })), "typecheck");
  // Conventions (no metadata).
  assert.equal(presentationGroup(task({ id: "cargo:clippy", command: "cargo clippy" })), "lint");
  assert.equal(presentationGroup(task({ id: "npm:lint", command: "npm run lint" })), "lint");
  assert.equal(
    presentationGroup(task({ id: "npm:typecheck", command: "npm run typecheck" })),
    "typecheck",
  );
  assert.equal(presentationGroup(task({ id: "npm:dev", command: "npm run dev" })), "run");
  assert.equal(presentationGroup(task({ id: "cargo:run", command: "cargo run" })), "run");
  assert.equal(presentationGroup(task({ id: "make:deploy", command: "make deploy" })), "other");
});

test("single-root plain project: no workspace, no package node — groups then tasks", () => {
  const tree = buildTaskTree(
    [
      task({ id: "npm:build", label: "npm: build", group: "build" }),
      task({ id: "npm:test", label: "npm: test", group: "test" }),
      task({ id: "npm:lint", label: "npm: lint", command: "npm run lint" }),
    ],
    ["/w"],
  );
  assert.deepEqual(kinds(tree), [
    "group:Build",
    "  task:npm: build",
    "group:Test",
    "  task:npm: test",
    "group:Lint",
    "  task:npm: lint",
  ]);
});

test("monorepo single root: a package node per sub-package, root package first", () => {
  const tree = buildTaskTree(
    [
      task({ id: "npm:build", label: "root build", group: "build" }), // root package
      task({
        id: "npm:packages.web:build",
        label: "web build",
        group: "build",
        cwd: "/w/packages/web",
      }),
      task({
        id: "npm:packages.api:build",
        label: "api build",
        group: "build",
        cwd: "/w/packages/api",
      }),
    ],
    ["/w"],
  );
  const packages = flattenVisible(tree, new Set())
    .map((r) => r.node)
    .filter((n) => n.kind === "package");
  assert.deepEqual(
    packages.map((p) => p.label),
    ["w", "packages/api", "packages/web"],
    "root package (folder basename) first, then sub-packages by path",
  );
  // The web package groups its build task beneath it.
  assert.ok(leaves(tree).some((n) => n.taskId === "npm:packages.web:build"));
});

test("multi-root workspaces get a workspace level", () => {
  const tree = buildTaskTree(
    [
      task({ id: "npm:build", label: "front build", group: "build", cwd: "/w/front" }),
      task({ id: "cargo:build", label: "api build", group: "build", cwd: "/w/api" }),
    ],
    ["/w/front", "/w/api"],
  );
  const ws = tree.map((n) => ({ kind: n.kind, label: n.label }));
  assert.deepEqual(ws, [
    { kind: "workspace", label: "front" },
    { kind: "workspace", label: "api" },
  ]);
});

test("duplicate display names stay distinct leaves with distinct ids", () => {
  const tree = buildTaskTree(
    [
      task({
        id: "npm:packages.web:build",
        label: "build",
        group: "build",
        cwd: "/w/packages/web",
      }),
      task({
        id: "npm:packages.api:build",
        label: "build",
        group: "build",
        cwd: "/w/packages/api",
      }),
    ],
    ["/w"],
  );
  const ls = leaves(tree);
  assert.equal(ls.length, 2);
  assert.deepEqual(
    ls.map((n) => n.id).sort(),
    ["npm:packages.api:build", "npm:packages.web:build"],
    "two 'build' tasks under different packages are separate nodes",
  );
});

test("node ids are stable across task reordering (identity preserved)", () => {
  const a = [
    task({ id: "npm:packages.web:build", group: "build", cwd: "/w/packages/web" }),
    task({ id: "npm:packages.api:test", group: "test", cwd: "/w/packages/api" }),
  ];
  const ids = (ts: ResolvedTask[]) =>
    flattenVisible(buildTaskTree(ts, ["/w"]), new Set())
      .map((r) => r.node.id)
      .sort();
  assert.deepEqual(ids(a), ids([...a].reverse()), "the same tasks produce the same node ids");
});

// --- filters -----------------------------------------------------------------------------------

const sample = (): ResolvedTask[] => [
  task({
    id: "npm:build",
    label: "web build",
    group: "build",
    cwd: "/w/packages/web",
    scope: "discovered",
  }),
  task({
    id: "npm:packages.web:lint",
    label: "web lint",
    command: "npm run lint",
    cwd: "/w/packages/web",
  }),
  task({ id: "npm:packages.api:test", label: "api test", group: "test", cwd: "/w/packages/api" }),
  task({ id: "deploy", label: "deploy", command: "make deploy", scope: "workspace" }),
];

test("filters are composable (group ∧ source ∧ package ∧ search)", () => {
  const tasks = sample();
  assert.deepEqual(
    filterTasks(tasks, ["/w"], { group: "build" }).map((t) => t.id),
    ["npm:build"],
  );
  assert.deepEqual(
    filterTasks(tasks, ["/w"], { source: "configured" }).map((t) => t.id),
    ["deploy"],
    "configured = user/workspace only",
  );
  assert.deepEqual(
    filterTasks(tasks, ["/w"], { packageKey: packageKeyFor(0, "packages/web") }).map((t) => t.id),
    ["npm:build", "npm:packages.web:lint"],
  );
  // Composition: discovered ∧ lint ∧ search "web".
  assert.deepEqual(
    filterTasks(tasks, ["/w"], { source: "discovered", group: "lint", search: "web" }).map(
      (t) => t.id,
    ),
    ["npm:packages.web:lint"],
  );
});

test("search matches label, id and command, case-insensitively", () => {
  const tasks = sample();
  assert.deepEqual(
    filterTasks(tasks, ["/w"], { search: "DEPLOY" }).map((t) => t.id),
    ["deploy"],
  );
  assert.deepEqual(
    filterTasks(tasks, ["/w"], { search: "run lint" }).map((t) => t.id),
    ["npm:packages.web:lint"],
    "matched by command text",
  );
  assert.equal(filterTasks(tasks, ["/w"], { search: "nothing-here" }).length, 0);
});

test("filterOptions enumerates the workspaces, packages, groups and sources present", () => {
  const opts = filterOptions(sample(), ["/w"]);
  assert.deepEqual(
    opts.groups,
    ["build", "test", "lint", "other"],
    "in canonical order, only those present",
  );
  assert.deepEqual(opts.sources.sort(), ["configured", "discovered"]);
  assert.ok(opts.packages.some((p) => p.label === "packages/web"));
  assert.ok(
    opts.packages.some((p) => p.label === "w"),
    "the root package for 'deploy' (null cwd)",
  );
});

// --- flatten / expansion -----------------------------------------------------------------------

test("flattenVisible hides a collapsed node's descendants; toggleExpansion collapses a default-open node", () => {
  const tree = buildTaskTree(
    [task({ id: "npm:build", group: "build" }), task({ id: "npm:test", group: "test" })],
    ["/w"],
  );
  const build = tree.find((n) => n.label === "Build")!;
  // All expanded by default → the build task is visible.
  assert.ok(flattenVisible(tree, new Set()).some((r) => r.node.taskId === "npm:build"));
  // Collapse the Build group.
  const collapsed = toggleExpansion(new Set(), build);
  const rows = flattenVisible(tree, collapsed);
  assert.ok(
    !rows.some((r) => r.node.taskId === "npm:build"),
    "the collapsed group's task is hidden",
  );
  assert.ok(
    rows.some((r) => r.node.taskId === "npm:test"),
    "a sibling group stays open",
  );
  // Toggling again re-opens it.
  assert.ok(
    flattenVisible(tree, toggleExpansion(collapsed, build)).some(
      (r) => r.node.taskId === "npm:build",
    ),
  );
});

// --- identity signature ------------------------------------------------------------------------

test("tasksSignature ignores run state but changes when the task set changes", () => {
  const a = [task({ id: "npm:build", group: "build" })];
  assert.equal(tasksSignature(a), tasksSignature([task({ id: "npm:build", group: "build" })]));
  assert.notEqual(
    tasksSignature(a),
    tasksSignature([...a, task({ id: "npm:test", group: "test" })]),
  );
  assert.notEqual(
    tasksSignature(a),
    tasksSignature([task({ id: "npm:build", group: "build", label: "renamed" })]),
    "a label change is a tree-affecting change",
  );
});

// --- performance -------------------------------------------------------------------------------

test("large monorepos: projection stays fast at 100 / 1000 / 5000 tasks", () => {
  const measurements: string[] = [];
  for (const n of [100, 1000, 5000]) {
    const tasks: ResolvedTask[] = [];
    const pkgCount = Math.max(1, Math.floor(n / 10));
    for (let i = 0; i < n; i++) {
      const p = i % pkgCount;
      tasks.push(
        task({
          id: `npm:packages.p${p}:task${i}`,
          label: `p${p} task ${i}`,
          group: i % 2 === 0 ? "build" : "test",
          cwd: `/w/packages/p${p}`,
        }),
      );
    }
    const t0 = performance.now();
    const tree = buildTaskTree(filterTasks(tasks, ["/w"], { search: "task" }), ["/w"]);
    const rows = flattenVisible(tree, new Set());
    const ms = performance.now() - t0;
    assert.equal(rows.filter((r) => r.node.kind === "task").length, n, `all ${n} tasks projected`);
    measurements.push(`${n}: ${ms.toFixed(1)}ms, ${rows.length} rows`);
    assert.ok(ms < 1000, `projection of ${n} tasks should be well under a second (was ${ms}ms)`);
  }
  console.log(`   [perf] filter+build+flatten → ${measurements.join(" | ")}`);
});
