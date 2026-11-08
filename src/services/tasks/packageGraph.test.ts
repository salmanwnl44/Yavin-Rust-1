/**
 * Monorepo package dependency graph (WS7 Part 6): the manifest dependency parsers, the pure local
 * graph projection (npm by name, Cargo by path / workspace inheritance; external excluded;
 * per-root isolation; ambiguity, missing and cycles handled), and the build→build task policy that
 * feeds the existing planner. Deterministic manifest fixtures; no execution.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_PRESENTATION, type ResolvedTask } from "./model.ts";
import type { TaskSource } from "./discovery.ts";
import {
  applyPackageDependencies,
  buildPackageGraph,
  packageTaskDependsOn,
  parseCargoManifest,
  parseJsManifest,
} from "./packageGraph.ts";
import { planTask } from "./plan.ts";

/** A member source: a sub-package (qualified) under `root`, with its manifest text. */
function pkg(over: Partial<TaskSource> & { key: string; folder: string }): TaskSource {
  return { multiRoot: true, root: "/w", ...over };
}
/** A discovered build task for a member keyed `key` (matches discovery's `npm:<key>:build`). */
function buildTask(kind: "npm" | "cargo", key: string, qualified = true): ResolvedTask {
  const id = qualified ? `${kind}:${key}:build` : `${kind}:build`;
  return {
    id,
    label: id,
    command: kind === "npm" ? "npm run build" : "cargo build",
    args: [],
    cwd: null,
    env: {},
    profile: null,
    dependsOn: [],
    group: "build",
    isDefault: false,
    problemMatcher: [],
    presentation: DEFAULT_PRESENTATION,
    scope: "discovered",
  };
}

// --- parsers -----------------------------------------------------------------------------------

test("parseJsManifest reads name and all four dependency sections", () => {
  const m = parseJsManifest(
    JSON.stringify({
      name: "@acme/app",
      dependencies: { "@acme/ui": "workspace:*", react: "^19" },
      devDependencies: { "@acme/tsconfig": "workspace:^" },
      optionalDependencies: { "@acme/native": "1.0.0" },
      peerDependencies: { "@acme/theme": "*" },
    }),
  );
  assert.equal(m?.name, "@acme/app");
  assert.deepEqual(m?.deps.map((d) => `${d.kind}:${d.name}`).sort(), [
    "dependencies:@acme/ui",
    "dependencies:react",
    "devDependencies:@acme/tsconfig",
    "optionalDependencies:@acme/native",
    "peerDependencies:@acme/theme",
  ]);
  assert.equal(parseJsManifest("not json"), null);
  assert.equal(parseJsManifest(undefined), null);
});

test("parseCargoManifest reads path deps, inline tables, sub-tables, targets and workspace inheritance", () => {
  const m = parseCargoManifest(
    [
      "[package]",
      'name = "cli"',
      "",
      "[dependencies]",
      'core = { path = "../core" }',
      'serde = "1.0"',
      "shared = { workspace = true }",
      "",
      "[dependencies.helper]",
      'path = "../helper"',
      "",
      "[dev-dependencies]",
      'testkit = { path = "../testkit" }',
      "",
      '[target."cfg(unix)".dependencies]',
      'nix_only = { path = "../nix" }',
    ].join("\n"),
  );
  assert.equal(m?.name, "cli");
  const byName = new Map(m!.deps.map((d) => [d.name, d]));
  assert.equal(byName.get("core")?.path, "../core");
  assert.equal(byName.get("helper")?.path, "../helper");
  assert.equal(byName.get("testkit")?.kind, "cargo-dev-dependencies");
  assert.equal(byName.get("nix_only")?.kind, "cargo-target-dependencies");
  assert.equal(byName.get("shared")?.workspace, true);
  assert.equal(byName.get("serde")?.path, undefined, "a version-only dep has no path (external)");
});

test("parseCargoManifest captures [workspace.dependencies] paths for inheritance", () => {
  const m = parseCargoManifest(
    [
      "[workspace]",
      "members = []",
      "",
      "[workspace.dependencies]",
      'shared = { path = "libs/shared" }',
      'serde = "1"',
    ].join("\n"),
  );
  assert.equal(m?.workspaceDeps.get("shared")?.path, "libs/shared");
  assert.ok(m?.workspaceDeps.has("serde"), "external workspace dep listed but without a path");
  assert.equal(m?.workspaceDeps.get("serde")?.path, undefined);
});

// --- graph: npm --------------------------------------------------------------------------------

test("npm: a dependency resolving to a local package by name becomes an edge; externals do not", () => {
  const sources = [
    pkg({
      key: "packages.app",
      folder: "/w/packages/app",
      packageJson: JSON.stringify({
        name: "@acme/app",
        dependencies: { "@acme/ui": "workspace:*", react: "^19" },
      }),
    }),
    pkg({
      key: "packages.ui",
      folder: "/w/packages/ui",
      packageJson: JSON.stringify({ name: "@acme/ui", scripts: { build: "tsup" } }),
    }),
  ];
  const graph = buildPackageGraph(sources);
  assert.deepEqual(
    graph.edges.map((e) => `${e.from} -> ${e.to}`),
    ["npm:packages.app:build -> npm:packages.ui:build"],
    "only the local @acme/ui edge; react (external) is excluded",
  );
});

test("npm: all four dependency sections produce edges", () => {
  const sources = [
    pkg({
      key: "a",
      folder: "/w/a",
      packageJson: JSON.stringify({
        name: "a",
        dependencies: { b: "workspace:*" },
        devDependencies: { c: "workspace:*" },
        peerDependencies: { d: "workspace:*" },
        optionalDependencies: { e: "workspace:*" },
      }),
    }),
    ...["b", "c", "d", "e"].map((n) =>
      pkg({ key: n, folder: `/w/${n}`, packageJson: JSON.stringify({ name: n }) }),
    ),
  ];
  const edges = buildPackageGraph(sources).edges.map((e) => e.to);
  assert.deepEqual(edges.sort(), ["npm:b:build", "npm:c:build", "npm:d:build", "npm:e:build"]);
});

// --- graph: cargo ------------------------------------------------------------------------------

test("cargo: path dependencies and [workspace.dependencies] inheritance resolve to members", () => {
  const sources = [
    pkg({
      key: "root",
      folder: "/w",
      multiRoot: false,
      cargoToml: [
        "[workspace]",
        "members=['crates/*']",
        "[workspace.dependencies]",
        'shared = { path = "crates/shared" }',
      ].join("\n"),
    }),
    pkg({
      key: "crates.cli",
      folder: "/w/crates/cli",
      cargoToml: [
        "[package]",
        'name="cli"',
        "[dependencies]",
        'core = { path = "../core" }',
        "shared = { workspace = true }",
        'serde = "1"',
      ].join("\n"),
    }),
    pkg({ key: "crates.core", folder: "/w/crates/core", cargoToml: '[package]\nname="core"' }),
    pkg({
      key: "crates.shared",
      folder: "/w/crates/shared",
      cargoToml: '[package]\nname="shared"',
    }),
  ];
  const edges = buildPackageGraph(sources)
    .edges.map((e) => `${e.from} -> ${e.to}`)
    .sort();
  assert.deepEqual(edges, [
    "cargo:crates.cli:build -> cargo:crates.core:build", // direct path dep
    "cargo:crates.cli:build -> cargo:crates.shared:build", // workspace-inherited path dep
  ]);
});

test("cargo: a version-only (registry) dependency never becomes an edge or a node", () => {
  const sources = [
    pkg({
      key: "crates.cli",
      folder: "/w/crates/cli",
      cargoToml:
        '[package]\nname="cli"\n[dependencies]\nserde = "1.0"\ntokio = { version = "1", features = ["full"] }',
    }),
  ];
  const graph = buildPackageGraph(sources);
  assert.equal(graph.edges.length, 0);
  assert.deepEqual(
    graph.nodes.map((n) => n.name),
    ["cli"],
    "no invented serde/tokio node",
  );
});

// --- isolation, ambiguity, missing -------------------------------------------------------------

test("cross-root isolation: same-named packages under different roots never link", () => {
  const sources = [
    pkg({
      key: "front.packages.app",
      folder: "/w/front/packages/app",
      root: "/w/front",
      packageJson: JSON.stringify({ name: "app", dependencies: { lib: "workspace:*" } }),
    }),
    pkg({
      key: "front.packages.lib",
      folder: "/w/front/packages/lib",
      root: "/w/front",
      packageJson: '{"name":"lib"}',
    }),
    // A different root also has a 'lib' — must not be linked from front/app.
    pkg({
      key: "back.packages.lib",
      folder: "/w/back/packages/lib",
      root: "/w/back",
      packageJson: '{"name":"lib"}',
    }),
  ];
  const edges = buildPackageGraph(sources).edges.map((e) => `${e.from} -> ${e.to}`);
  assert.deepEqual(edges, ["npm:front.packages.app:build -> npm:front.packages.lib:build"]);
});

test("ambiguous (duplicate) package names in one root are not guessed; missing deps are dropped", () => {
  const sources = [
    pkg({
      key: "a",
      folder: "/w/a",
      packageJson: JSON.stringify({ name: "a", dependencies: { dup: "*", gone: "*" } }),
    }),
    pkg({ key: "b", folder: "/w/b", packageJson: '{"name":"dup"}' }),
    pkg({ key: "c", folder: "/w/c", packageJson: '{"name":"dup"}' }), // duplicate name → ambiguous
  ];
  // `dup` is ambiguous (two packages) and `gone` is missing → no edges from `a`.
  assert.deepEqual(buildPackageGraph(sources).edges, []);
});

// --- policy → planner --------------------------------------------------------------------------

test("policy: build depends on local dependencies' builds; the planner orders them", () => {
  const sources = [
    pkg({
      key: "app",
      folder: "/w/app",
      packageJson: JSON.stringify({ name: "app", dependencies: { ui: "workspace:*" } }),
    }),
    pkg({
      key: "ui",
      folder: "/w/ui",
      packageJson: JSON.stringify({ name: "ui", dependencies: { core: "workspace:*" } }),
    }),
    pkg({ key: "core", folder: "/w/core", packageJson: '{"name":"core"}' }),
  ];
  const tasks = applyPackageDependencies(
    [buildTask("npm", "app"), buildTask("npm", "ui"), buildTask("npm", "core")],
    sources,
  );
  const appBuild = tasks.find((t) => t.id === "npm:app:build")!;
  assert.deepEqual(appBuild.dependsOn, ["npm:ui:build"], "app build depends on ui build");
  // The existing planner produces the full order: core, ui, app.
  const order = planTask(tasks, "npm:app:build").map((t) => t.id);
  assert.deepEqual(order, ["npm:core:build", "npm:ui:build", "npm:app:build"]);
});

test("policy wires only build tasks — a package's test/lint are left independent", () => {
  const sources = [
    pkg({
      key: "app",
      folder: "/w/app",
      packageJson: JSON.stringify({ name: "app", dependencies: { ui: "workspace:*" } }),
    }),
    pkg({ key: "ui", folder: "/w/ui", packageJson: '{"name":"ui"}' }),
  ];
  const test: ResolvedTask = { ...buildTask("npm", "app"), id: "npm:app:test", group: "test" };
  const tasks = applyPackageDependencies(
    [buildTask("npm", "app"), buildTask("npm", "ui"), test],
    sources,
  );
  assert.deepEqual(
    tasks.find((t) => t.id === "npm:app:test")!.dependsOn,
    [],
    "test is not auto-wired",
  );
});

test("an edge to a package without a build task is dropped (nothing to build)", () => {
  const sources = [
    pkg({
      key: "app",
      folder: "/w/app",
      packageJson: JSON.stringify({ name: "app", dependencies: { ui: "workspace:*" } }),
    }),
    pkg({ key: "ui", folder: "/w/ui", packageJson: '{"name":"ui"}' }), // ui has no build script/task
  ];
  // Only app has a build task.
  const tasks = applyPackageDependencies([buildTask("npm", "app")], sources);
  assert.deepEqual(tasks.find((t) => t.id === "npm:app:build")!.dependsOn, []);
});

test("explicit dependsOn is preserved and merged with package-derived edges", () => {
  const sources = [
    pkg({
      key: "app",
      folder: "/w/app",
      packageJson: JSON.stringify({ name: "app", dependencies: { ui: "workspace:*" } }),
    }),
    pkg({ key: "ui", folder: "/w/ui", packageJson: '{"name":"ui"}' }),
  ];
  const app = { ...buildTask("npm", "app"), dependsOn: ["custom:lint"] };
  const tasks = applyPackageDependencies([app, buildTask("npm", "ui")], sources);
  assert.deepEqual(
    tasks.find((t) => t.id === "npm:app:build")!.dependsOn,
    ["custom:lint", "npm:ui:build"],
    "user's explicit dependency kept, package edge appended",
  );
});

test("a dependency cycle is broken so builds stay runnable (planner never sees a cycle)", () => {
  // a → b → a (pathological). The graph edge that would close the cycle is dropped.
  const sources = [
    pkg({
      key: "a",
      folder: "/w/a",
      packageJson: JSON.stringify({ name: "a", dependencies: { b: "workspace:*" } }),
    }),
    pkg({
      key: "b",
      folder: "/w/b",
      packageJson: JSON.stringify({ name: "b", dependencies: { a: "workspace:*" } }),
    }),
  ];
  const taskIds = new Set(["npm:a:build", "npm:b:build"]);
  const { brokenCycles } = packageTaskDependsOn(buildPackageGraph(sources), taskIds);
  assert.ok(brokenCycles.length >= 1, "the cycle was detected and broken");
  const tasks = applyPackageDependencies([buildTask("npm", "a"), buildTask("npm", "b")], sources);
  // Neither build throws a cycle in the existing planner.
  assert.doesNotThrow(() => planTask(tasks, "npm:a:build"));
  assert.doesNotThrow(() => planTask(tasks, "npm:b:build"));
});

test("a shared dependency is planned once for a task that transitively needs it twice", () => {
  const sources = [
    pkg({
      key: "app",
      folder: "/w/app",
      packageJson: JSON.stringify({
        name: "app",
        dependencies: { x: "workspace:*", y: "workspace:*" },
      }),
    }),
    pkg({
      key: "x",
      folder: "/w/x",
      packageJson: JSON.stringify({ name: "x", dependencies: { shared: "workspace:*" } }),
    }),
    pkg({
      key: "y",
      folder: "/w/y",
      packageJson: JSON.stringify({ name: "y", dependencies: { shared: "workspace:*" } }),
    }),
    pkg({ key: "shared", folder: "/w/shared", packageJson: '{"name":"shared"}' }),
  ];
  const tasks = applyPackageDependencies(
    ["app", "x", "y", "shared"].map((k) => buildTask("npm", k)),
    sources,
  );
  const order = planTask(tasks, "npm:app:build").map((t) => t.id);
  assert.equal(
    order.filter((id) => id === "npm:shared:build").length,
    1,
    "shared built exactly once",
  );
  assert.ok(order.indexOf("npm:shared:build") < order.indexOf("npm:x:build"));
  assert.equal(order.at(-1), "npm:app:build");
});
