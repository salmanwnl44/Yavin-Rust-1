import assert from "node:assert/strict";
import test from "node:test";
import { createTestingPlatform, type TestDebugDependency } from "./platform.ts";
import type { TestRunner } from "./controller.ts";
import type { TestAdapter } from "./adapters.ts";
import { parseJestJson } from "./jestJson.ts";
import type { ResolvedDebugConfiguration } from "../debug/config.ts";

const VITEST = ["vitest.config.ts"];

function runnerFor(json: string): TestRunner {
  return async () => ({ output: json, code: 0 });
}

/** A test-only adapter whose id ("pytest") maps to debugpy, so the supported debug path is
 * exercisable without the real pytest adapter (WS5.5). It parses the shared jest/vitest JSON. */
const pytestAdapter: TestAdapter = {
  id: "pytest",
  label: "pytest",
  detect: (names) => names.includes("pytest.ini"),
  command: () => ({ program: "pytest", args: [] }),
  parse: parseJestJson,
};

const ONE_PY_TEST = JSON.stringify({
  testResults: [
    {
      name: "/w/test_math.py",
      assertionResults: [
        { title: "test_adds", fullName: "test_adds", status: "passed", ancestorTitles: [] },
      ],
    },
  ],
});

const TWO_FILES = JSON.stringify({
  testResults: [
    {
      name: "/w/a.test.ts",
      assertionResults: [
        { ancestorTitles: ["g"], title: "ok", fullName: "g ok", status: "passed" },
        {
          ancestorTitles: ["g"],
          title: "bad",
          fullName: "g bad",
          status: "failed",
          location: { line: 4 },
        },
      ],
    },
    {
      name: "/w/b.test.ts",
      assertionResults: [{ title: "fine", fullName: "fine", status: "passed", ancestorTitles: [] }],
    },
  ],
});

test("before any run the view-state is idle with no rows and knows its adapter", () => {
  const platform = createTestingPlatform({ markerNames: VITEST, run: runnerFor("{}") });
  const view = platform.getViewState();
  assert.equal(view.adapterLabel, "Vitest");
  assert.equal(view.phase, "idle");
  assert.equal(view.hasReport, false);
  assert.deepEqual(view.rows, []);
  assert.deepEqual(view.diagnostics, []);
  assert.equal(view.compiled, null);
});

test("a Cargo compile failure surfaces diagnostics and compiled=false, no tree rows", async () => {
  const buildFail = [
    `{"reason":"compiler-message","message":{"level":"error","rendered":"error[E0425]: cannot find value","spans":[{"file_name":"src/lib.rs","line_start":10,"column_start":5,"is_primary":true}]}}`,
    `{"reason":"build-finished","success":false}`,
  ].join("\n");
  const platform = createTestingPlatform({
    markerNames: ["Cargo.toml"],
    run: runnerFor(buildFail),
  });
  await platform.runAll();
  const view = platform.getViewState();
  assert.equal(view.adapterLabel, "Cargo");
  assert.equal(view.phase, "failed");
  assert.equal(view.compiled, false);
  assert.equal(view.summary?.failed, 0, "a build break is not a test failure");
  assert.deepEqual(view.rows, [], "no tree when nothing compiled");
  assert.equal(view.diagnostics.length, 1);
  assert.equal(view.diagnostics[0]!.file, "src/lib.rs");
});

test("runAll produces visible rows (files expanded by default) and a summary", async () => {
  const platform = createTestingPlatform({ markerNames: VITEST, run: runnerFor(TWO_FILES) });
  await platform.runAll();
  const view = platform.getViewState();
  assert.equal(view.phase, "failed", "a failing case makes the run failed");
  assert.deepEqual(view.summary, {
    passed: 2,
    failed: 1,
    skipped: 0,
    total: 3,
    durationMs: view.summary!.durationMs,
  });
  const labels = view.rows.map((r) => r.node.label);
  assert.ok(labels.includes("a.test.ts") && labels.includes("b.test.ts"), "both files show");
  assert.ok(labels.includes("g"), "the suite under an expanded file shows");
  assert.ok(!labels.includes("bad"), "a case under a collapsed suite is hidden until toggled");
});

test("toggling a suite reveals its cases, and the rows reference is stable when nothing changes", async () => {
  const platform = createTestingPlatform({ markerNames: VITEST, run: runnerFor(TWO_FILES) });
  await platform.runAll();
  const before = platform.getViewState().rows;
  assert.equal(platform.getViewState().rows, before, "same rows reference when unchanged (cached)");

  const suite = before.find((r) => r.node.label === "g")!.node;
  platform.toggle(suite);
  const after = platform.getViewState().rows;
  assert.notEqual(after, before, "rows recompute after a toggle");
  assert.ok(after.map((r) => r.node.label).includes("bad"), "the failing case is now visible");
});

test("runNode on a case runs that case by its full name through the controller", async () => {
  const commands: string[][] = [];
  const run: TestRunner = async (command) => {
    commands.push([...command.args]);
    return { output: TWO_FILES, code: 0 };
  };
  const platform = createTestingPlatform({ markerNames: VITEST, run });
  await platform.runAll();
  const suite = platform.getViewState().rows.find((r) => r.node.label === "g")!.node;
  platform.toggle(suite);
  const badCase = platform.getViewState().rows.find((r) => r.node.label === "bad")!.node;
  await platform.runNode(badCase);
  assert.deepEqual(commands.at(-1), ["run", "--reporter=json", "-t", "g bad", "/w/a.test.ts"]);
});

test("each completed run is recorded in the result store for history", async () => {
  const platform = createTestingPlatform({ markerNames: VITEST, run: runnerFor(TWO_FILES) });
  await platform.runAll();
  await platform.runAll();
  assert.equal(platform.resultStore.history().length, 2, "two runs are retained");
  assert.equal(platform.resultStore.current()?.summary.failed, 1);
});

test("select stores the focused id; reset clears everything back to idle", async () => {
  const platform = createTestingPlatform({ markerNames: VITEST, run: runnerFor(TWO_FILES) });
  await platform.runAll();
  platform.select("/w/a.test.ts\u0000g bad");
  assert.equal(platform.getViewState().selectedId, "/w/a.test.ts\u0000g bad");
  platform.reset();
  const view = platform.getViewState();
  assert.equal(view.phase, "idle");
  assert.equal(view.selectedId, null);
  assert.equal(view.hasReport, false);
  assert.equal(platform.resultStore.history().length, 0);
});

test("with no adapter, runAll reports the clear failure and lists no rows", async () => {
  const platform = createTestingPlatform({ markerNames: ["package.json"], run: runnerFor("{}") });
  await platform.runAll();
  const view = platform.getViewState();
  assert.equal(view.adapterLabel, null);
  assert.equal(view.phase, "failed");
  assert.match(view.error ?? "", /No test framework/);
  assert.deepEqual(view.rows, []);
});

test("getViewState returns a stable reference until something changes (no render loop)", async () => {
  // React's useSyncExternalStore loops forever if the snapshot getter returns a fresh object each
  // call, so the view-state must be reference-stable between changes.
  const platform = createTestingPlatform({ markerNames: VITEST, run: runnerFor(TWO_FILES) });
  const a = platform.getViewState();
  assert.equal(platform.getViewState(), a, "same reference when nothing changed");
  await platform.runAll();
  const b = platform.getViewState();
  assert.notEqual(b, a, "a new reference after a run");
  assert.equal(platform.getViewState(), b, "stable again until the next change");
  platform.select("x");
  assert.notEqual(platform.getViewState(), b, "a new reference after select");
});

test("subscribers are notified when a run completes and when a node toggles", async () => {
  const platform = createTestingPlatform({ markerNames: VITEST, run: runnerFor(TWO_FILES) });
  let n = 0;
  platform.subscribe(() => n++);
  await platform.runAll();
  assert.ok(n >= 1, "the run notifies");
  const suite = platform.getViewState().rows.find((r) => r.node.label === "g")!.node;
  const before = n;
  platform.toggle(suite);
  assert.ok(n > before, "the toggle notifies");
});

// --- WS5.3 Debug Test -------------------------------------------------------------------------

function fakeDebug(
  available: Iterable<string> = [],
): TestDebugDependency & { started: ResolvedDebugConfiguration[] } {
  const started: ResolvedDebugConfiguration[] = [];
  return {
    workspace: "file://c:/work",
    availableAdapters: new Set(available),
    started,
    start: async (config) => void started.push(config),
  };
}

test("debug is reported unsupported when the mapped adapter is not installed", async () => {
  // Vitest maps to the registered `node` adapter, but it is not in the availability set.
  const platform = createTestingPlatform({
    markerNames: VITEST,
    run: runnerFor(TWO_FILES),
    debug: fakeDebug(),
  });
  await platform.runAll();
  const view = platform.getViewState();
  assert.equal(view.debug.supported, false);
  assert.match(view.debug.reason ?? "", /not installed/);
  assert.match(view.debug.reason ?? "", /js-debug/);
  const caseNode = (() => {
    const suite = platform.getViewState().rows.find((r) => r.node.label === "g")!.node;
    platform.toggle(suite);
    return platform.getViewState().rows.find((r) => r.node.label === "bad")!.node;
  })();
  assert.equal(platform.canDebugNode(caseNode).supported, false);
  await assert.rejects(platform.debugNode(caseNode), /not installed/);
});

test("debug is unsupported when no debugger is wired, even for a supported framework", async () => {
  const platform = createTestingPlatform({
    markerNames: ["pytest.ini"],
    run: runnerFor(ONE_PY_TEST),
    adapters: [pytestAdapter],
    // no `debug` dependency
  });
  await platform.runAll();
  assert.equal(platform.getViewState().debug.supported, false);
  assert.match(platform.getViewState().debug.reason ?? "", /not available in this window/);
});

test("debugNode launches the authorized configuration for a supported, installed framework", async () => {
  const debug = fakeDebug(["debugpy"]);
  const platform = createTestingPlatform({
    markerNames: ["pytest.ini"],
    run: runnerFor(ONE_PY_TEST),
    adapters: [pytestAdapter],
    debug,
  });
  await platform.runAll();
  assert.equal(platform.getViewState().debug.supported, true);
  const caseNode = platform.getViewState().rows.find((r) => r.node.label === "test_adds")!.node;
  assert.equal(platform.canDebugNode(caseNode).supported, true);
  await platform.debugNode(caseNode);
  assert.equal(debug.started.length, 1, "the debug session was launched once");
  const config = debug.started[0]!;
  assert.equal(config.adapter, "debugpy");
  // pytest debugs as a module launch with the reconstructed node id.
  assert.equal(config.module, "pytest");
  assert.deepEqual(config.args, ["/w/test_math.py::test_adds"]);
});

test("debugNode rejects a stale node id that is not in the current results", async () => {
  const debug = fakeDebug();
  const platform = createTestingPlatform({
    markerNames: ["pytest.ini"],
    run: runnerFor(ONE_PY_TEST),
    adapters: [pytestAdapter],
    debug,
  });
  await platform.runAll();
  const real = platform.getViewState().rows.find((r) => r.node.label === "test_adds")!.node;
  const stale = { ...real, id: "/w/test_math.py\u0000test_removed" };
  await assert.rejects(platform.debugNode(stale), /no longer in the latest results/);
  assert.equal(debug.started.length, 0, "nothing launched for a stale test");
});

test("debugNode refuses a non-case node (only individual tests debug)", async () => {
  const debug = fakeDebug();
  const platform = createTestingPlatform({
    markerNames: ["pytest.ini"],
    run: runnerFor(ONE_PY_TEST),
    adapters: [pytestAdapter],
    debug,
  });
  await platform.runAll();
  const fileNode = platform.getViewState().rows.find((r) => r.node.kind === "file")!.node;
  assert.equal(platform.canDebugNode(fileNode).supported, false);
  await assert.rejects(platform.debugNode(fileNode), /individual test/);
});
