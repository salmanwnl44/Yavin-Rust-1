/**
 * The TestingPlatform (WS5): the single view-model the Test Explorer UI binds to. It composes the
 * pieces that already have their own tests — the {@link createTestController controller} (running),
 * the {@link createResultStore result store} (history), the {@link buildTree tree projection} and
 * its expansion state — behind one `subscribe` / `getViewState` surface, so the React view stays a
 * thin renderer with no logic of its own.
 *
 * Deliberately DOM-free and process-free: the controller's runner is injected, so this whole
 * view-model is unit-tested without a browser or a real test run.
 */
import { createTestController } from "./controller.ts";
import type { TestController, TestPhase, TestRunner } from "./controller.ts";
import { createResultStore } from "./resultStore.ts";
import type { TestResultStore } from "./resultStore.ts";
import { buildTree, flattenVisible, toggleExpansion } from "./treeProvider.ts";
import type { TestRow, TestTreeNode } from "./treeProvider.ts";
import type { TestAdapter } from "./adapters.ts";
import type { TestDiagnostic, TestSummary } from "./model.ts";
import {
  authorizeTestDebug,
  buildTestDebugConfiguration,
  testDebugSupport,
  TestDebugError,
  type TestDebugSupport,
} from "./debugRequest.ts";
import type { ResolvedDebugConfiguration } from "../debug/config.ts";

export interface TestingViewState {
  readonly adapterLabel: string | null;
  readonly phase: TestPhase;
  readonly running: boolean;
  readonly summary: TestSummary | null;
  readonly rows: readonly TestRow[];
  readonly error: string | null;
  readonly selectedId: string | null;
  /** True once at least one run has produced a report. */
  readonly hasReport: boolean;
  /** Compiler diagnostics (Cargo), kept separate from test results. */
  readonly diagnostics: readonly TestDiagnostic[];
  /** False when the last run failed to compile (no tests ran); null/undefined otherwise. */
  readonly compiled: boolean | null;
  /** Whether this framework's tests can be debugged, and why not when they cannot (WS5.3). */
  readonly debug: TestDebugSupport;
}

/** The DAP seam the platform needs to debug a test: the workspace it runs in, how to launch, and
 * which DAP adapters are actually installed (so a framework is enabled only when its adapter is). */
export interface TestDebugDependency {
  readonly workspace: string;
  /** The DAP adapter ids whose binaries actually resolve on this machine (the native probe). */
  readonly availableAdapters: ReadonlySet<string>;
  /** Launches the ad-hoc debug configuration through the existing DebugService. */
  start(config: ResolvedDebugConfiguration): Promise<void>;
}

export interface TestingPlatform {
  getViewState(): TestingViewState;
  subscribe(listener: () => void): () => void;
  runAll(): Promise<void>;
  runFile(file: string): Promise<void>;
  /** Run a single case node (a leaf); a no-op for suite/file nodes, which use runFile/runAll. */
  runNode(node: TestTreeNode): Promise<void>;
  rerunFailed(): Promise<void>;
  cancel(): void;
  toggle(node: TestTreeNode): void;
  select(id: string | null): void;
  reset(): void;
  /** Whether a given node can be debugged (a supported framework, and a case leaf). */
  canDebugNode(node: TestTreeNode): TestDebugSupport;
  /**
   * Debug one test case through the existing DAP subsystem (WS5.3): authorize against the current
   * results, build the launch configuration, and start the session. Rejects with a clear message
   * when the framework is unsupported, the test is stale, or no debugger is wired.
   */
  debugNode(node: TestTreeNode): Promise<void>;
  /** Exposed for the UI's status line / tests; the controller owns the authoritative state. */
  controller: TestController;
  resultStore: TestResultStore;
}

export function createTestingPlatform(options: {
  markerNames: readonly string[];
  run: TestRunner;
  adapters?: readonly TestAdapter[];
  now?: () => number;
  historyLimit?: number;
  /** The DAP seam; when absent, debugging is reported unsupported ("no debugger here"). */
  debug?: TestDebugDependency;
}): TestingPlatform {
  const controller = createTestController({
    markerNames: options.markerNames,
    run: options.run,
    adapters: options.adapters,
    now: options.now,
  });
  const resultStore = createResultStore({ limit: options.historyLimit, now: options.now });
  const adapter = controller.adapter();

  const listeners = new Set<() => void>();
  let expanded: ReadonlySet<string> = new Set();
  let selectedId: string | null = null;

  // Cache the derived tree+rows so getViewState is cheap and row identities are stable between
  // renders when neither the report nor the expansion changed (same discipline as the Explorer).
  let cacheReportRef: unknown = Symbol("none");
  let cacheExpandedRef: ReadonlySet<string> | null = null;
  let cachedRows: readonly TestRow[] = [];
  // The view-state object itself must be reference-stable between changes: React's
  // `useSyncExternalStore` calls the snapshot getter on every render and loops forever if it
  // returns a fresh object each time. It is rebuilt only after a `notify`.
  let cachedView: TestingViewState | null = null;

  const notify = () => {
    cachedView = null;
    for (const listener of [...listeners]) listener();
  };

  // When a run completes with a report, remember it in the history store.
  let lastRecordedReport: unknown = null;
  controller.subscribe(() => {
    const report = controller.getState().report;
    if (report && report !== lastRecordedReport) {
      lastRecordedReport = report;
      resultStore.record(report);
    }
    notify();
  });

  function rows(): readonly TestRow[] {
    const report = controller.getState().report;
    if (report === cacheReportRef && expanded === cacheExpandedRef) return cachedRows;
    cacheReportRef = report;
    cacheExpandedRef = expanded;
    cachedRows = report ? flattenVisible(buildTree(report), expanded) : [];
    return cachedRows;
  }

  /** Whether this workspace's framework can be debugged: a detected adapter, a wired debugger, and
   * the mapped DAP adapter actually installed (availability-gated, not merely registered). */
  const debugSupport = (): TestDebugSupport => {
    if (!adapter) return { supported: false, reason: "No test framework is detected." };
    if (!options.debug)
      return { supported: false, reason: "Debugging is not available in this window." };
    return testDebugSupport(adapter.id, options.debug.availableAdapters);
  };

  return {
    controller,
    resultStore,

    getViewState(): TestingViewState {
      if (cachedView) return cachedView;
      const state = controller.getState();
      cachedView = {
        adapterLabel: adapter?.label ?? null,
        phase: state.phase,
        running: state.phase === "running",
        summary: state.report?.summary ?? null,
        rows: rows(),
        error: state.error,
        selectedId,
        hasReport: state.report !== null,
        diagnostics: state.report?.diagnostics ?? [],
        compiled: state.report?.compiled ?? null,
        debug: debugSupport(),
      };
      return cachedView;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    runAll: () => controller.runAll(),
    runFile: (file) => controller.runFile(file),
    runNode: (node) =>
      node.kind === "case"
        ? controller.runCase(node.file, caseFullName(node))
        : node.kind === "file"
          ? controller.runFile(node.file)
          : Promise.resolve(),
    rerunFailed: () => controller.rerunFailed(),
    cancel: () => controller.cancel(),

    toggle(node) {
      expanded = toggleExpansion(expanded, node);
      notify();
    },

    select(id) {
      selectedId = id;
      notify();
    },

    reset() {
      controller.reset();
      resultStore.clear();
      expanded = new Set();
      selectedId = null;
      lastRecordedReport = null;
      notify();
    },

    canDebugNode(node) {
      if (node.kind !== "case")
        return { supported: false, reason: "Only an individual test can be debugged." };
      return debugSupport();
    },

    async debugNode(node) {
      if (node.kind !== "case")
        throw new TestDebugError("Only an individual test can be debugged.");
      if (!adapter) throw new TestDebugError("No test framework is detected.");
      if (!options.debug) throw new TestDebugError("Debugging is not available in this window.");
      const request = {
        adapterId: adapter.id,
        caseId: node.id,
        workspace: options.debug.workspace,
        file: node.file,
        fullName: caseFullName(node),
        line: node.line,
      };
      // Authorize against the *current* results (not a stale id) and the owning workspace, then
      // build the launch configuration and hand it to the existing DebugService.
      authorizeTestDebug(request, {
        workspace: options.debug.workspace,
        currentCaseIds: allCaseIds(controller.getState().report),
      });
      // Build with the availability set, so a registered-but-not-installed adapter is refused here
      // too (not only hidden in the UI), with the install hint.
      await options.debug.start(
        buildTestDebugConfiguration(request, options.debug.availableAdapters),
      );
    },
  };
}

/** A case node's full name is its file-relative suite path plus its label — the id we run by. */
function caseFullName(node: TestTreeNode): string {
  // The case node's id is `${file}\u0000${fullName}`; recover the full name after the separator.
  const sep = node.id.indexOf("\u0000");
  return sep === -1 ? node.label : node.id.slice(sep + 1);
}

/** Every case node id in the current report, matching the ids the tree assigns — so a debug
 * request's id can be checked for being current, whatever the framework's grouping. */
function allCaseIds(report: ReturnType<TestController["getState"]>["report"]): ReadonlySet<string> {
  const ids = new Set<string>();
  if (!report) return ids;
  const walk = (nodes: readonly TestTreeNode[]) => {
    for (const node of nodes) {
      if (node.kind === "case") ids.add(node.id);
      else walk(node.children);
    }
  };
  walk(buildTree(report));
  return ids;
}
