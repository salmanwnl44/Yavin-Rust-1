/**
 * Debug Test contract (WS5.3): the typed request to debug one selected test through Yavin's
 * existing DAP subsystem, and the authorization that decides whether it may run and builds the
 * debug launch configuration.
 *
 * The seam is deliberately thin: Testing owns test identity and selection, the DAP subsystem owns
 * debug sessions, and the native allow-lists (`dap.rs`, `test_runner.rs`) own which executables
 * run. This module only *translates* a selected test into a {@link ResolvedDebugConfiguration}
 * the existing {@link DebugService} already knows how to launch — it never names a program, a DAP
 * adapter path, or shell arguments of its own.
 *
 * **Supported frameworks today:** none of the current test adapters. Yavin ships only the
 * `debugpy` (Python) debug adapter, so Jest/Vitest (JavaScript) and Cargo (Rust) tests map to a
 * debug adapter Yavin does not have and are reported **unsupported with a clear reason** — never
 * faked. The mechanism lights up for a Python test runner (pytest, WS5.5) the moment its test
 * adapter exists, and for JS/Rust when such a DAP adapter is added.
 */
import { DEBUG_ADAPTERS } from "../debug/adapters.ts";
import type { ResolvedDebugConfiguration } from "../debug/config.ts";

/** The information needed to identify and launch a single test under the debugger. */
export interface TestDebugRequest {
  /** The test framework adapter id (vitest / jest / cargo / …). */
  readonly adapterId: string;
  /** The stable test-case id, validated against the current results. */
  readonly caseId: string;
  /** The workspace the request belongs to; must match the platform's. */
  readonly workspace: string;
  /** The test's file (the launch program / selector context). */
  readonly file: string;
  /** The test's full name — an opaque selector, never inspected or split. */
  readonly fullName: string;
  /** Optional source line, for the UI. */
  readonly line?: number;
}

export interface TestDebugSupport {
  readonly supported: boolean;
  /** Why it is unsupported, when it is. */
  readonly reason?: string;
  /** The DAP adapter it would (or does) use. */
  readonly dapAdapter?: string;
}

export class TestDebugError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestDebugError";
  }
}

/**
 * Which DAP adapter each test framework debugs through, and the message to show when Yavin does
 * not have that adapter. This is the single source of truth for debuggability; a framework whose
 * `dapAdapter` is not in {@link DEBUG_ADAPTERS} is unsupported.
 */
const INTENDED_ADAPTER: Record<string, { dapAdapter: string; missing: string }> = {
  // JavaScript/TypeScript runners debug through js-debug (the `node` adapter, WS6).
  vitest: { dapAdapter: "node", missing: "" },
  jest: { dapAdapter: "node", missing: "" },
  // Playwright runs its tests in a Node.js worker, so it also uses the JavaScript adapter.
  // (Debugging the browser itself is a separate, out-of-scope concern.)
  playwright: { dapAdapter: "node", missing: "" },
  // Rust tests need a native debugger (LLDB), which Yavin does not register yet (WS6 Part 2).
  cargo: {
    dapAdapter: "lldb",
    missing:
      "Debugging Cargo tests needs a native (LLDB) debug adapter, which Yavin does not have yet.",
  },
  // Python runners debug through debugpy (WS5.5).
  pytest: { dapAdapter: "debugpy", missing: "" },
};

/**
 * Whether a test framework's individual tests can be debugged, and through which DAP adapter.
 *
 * Two distinct gates: the adapter must be **registered** (Yavin knows its protocol — the capability)
 * and, when `available` is given (the set of DAP adapters whose binaries actually resolve on this
 * machine, from the native probe), it must be **installed**. A registered-but-not-installed adapter
 * is reported unsupported with how to install it — a framework is never enabled merely because its
 * adapter is registered.
 */
export function testDebugSupport(
  adapterId: string,
  available?: ReadonlySet<string>,
): TestDebugSupport {
  const intended = INTENDED_ADAPTER[adapterId];
  if (!intended)
    return { supported: false, reason: `Debugging is not available for "${adapterId}" tests.` };
  const def = DEBUG_ADAPTERS.find((adapter) => adapter.id === intended.dapAdapter);
  if (!def) return { supported: false, reason: intended.missing, dapAdapter: intended.dapAdapter };
  if (available && !available.has(def.id))
    return {
      supported: false,
      reason: `The ${def.label} debug adapter is not installed. Install it with: ${def.install}.`,
      dapAdapter: def.id,
    };
  return { supported: true, dapAdapter: def.id };
}

/**
 * Authorize a debug request against the live platform state, rejecting anything the renderer must
 * not be trusted on. The returned request is safe to turn into a configuration; a rejection is a
 * {@link TestDebugError} with an actionable message.
 */
export function authorizeTestDebug(
  request: TestDebugRequest,
  context: { workspace: string; currentCaseIds: ReadonlySet<string> },
): TestDebugRequest {
  if (request.workspace !== context.workspace)
    throw new TestDebugError("This debug request is for a different workspace.");
  const support = testDebugSupport(request.adapterId);
  if (!support.supported)
    throw new TestDebugError(support.reason ?? `"${request.adapterId}" tests cannot be debugged.`);
  // Not a stale id from an old run: the test must be in the latest results.
  if (!context.currentCaseIds.has(request.caseId))
    throw new TestDebugError("This test is no longer in the latest results. Run the tests again.");
  if (!request.file.trim() || !request.fullName.trim())
    throw new TestDebugError("This test is missing the file or name needed to debug it.");
  return request;
}

/**
 * Build the debug launch configuration for a single authorized test. Only ever reached for a
 * supported framework (the UI and {@link authorizeTestDebug} gate it). The adapter is one of the
 * allow-listed {@link DEBUG_ADAPTERS} — never a renderer-chosen program — and the test's full name
 * is carried as **one opaque argument**, never a shell string. The program is the test's own file,
 * which the {@link DebugService} confines to the workspace root before launching.
 *
 * pytest launches as a **module** (`python -m pytest <node id>`) so pytest's own machinery runs
 * the selected test — the node id is one opaque argument. The debuggee runs in the workspace,
 * breakpoints bind through the normal DAP flow, and the interpreter is resolved by the native
 * debugpy adapter (a workspace venv first), never named by the renderer.
 */
export function buildTestDebugConfiguration(
  request: TestDebugRequest,
  available?: ReadonlySet<string>,
): ResolvedDebugConfiguration {
  const support = testDebugSupport(request.adapterId, available);
  if (!support.supported || !support.dapAdapter)
    throw new TestDebugError(support.reason ?? "This test cannot be debugged.");
  const base = {
    id: `test-debug:${request.caseId}`,
    name: `Debug Test: ${request.fullName}`,
    adapter: support.dapAdapter,
    request: "launch" as const,
    cwd: null,
    env: {},
    stopOnEntry: false,
    port: null,
    preLaunchTask: null,
    scope: "workspace" as const,
  };
  if (request.adapterId === "pytest") {
    // `python -m pytest <node id>`: the whole node id is one opaque argument.
    return {
      ...base,
      program: null,
      module: "pytest",
      args: [`${request.file}::${request.fullName}`],
    };
  }
  if (support.dapAdapter === "node") return buildNodeTestConfiguration(request, base);
  if (support.dapAdapter === "lldb")
    // Cargo's debug launch needs the compiled test executable, which only the native side can
    // resolve (`cargo test --no-run`); the renderer must use buildCargoDebugConfiguration with it.
    throw new TestDebugError(
      "Cargo test debugging resolves the compiled test executable natively; build it with buildCargoDebugConfiguration.",
    );
  // Other debugpy-backed runners: launch the test file, filtering by the opaque full name.
  return { ...base, program: request.file, args: ["-k", request.fullName] };
}

/**
 * The lldb-dap launch configuration for one Cargo test (WS6 Part 3). The `program` is the compiled
 * test executable the **native side** resolved from `cargo test --no-run` metadata (absolute, and
 * confined to the workspace there) — never a renderer path. Only the selected test runs: its full
 * node-id path is passed to the test binary as **one opaque argument** plus `--exact`, never a
 * shell string, so the whole suite is not run.
 */
export function buildCargoDebugConfiguration(
  request: TestDebugRequest,
  executable: string,
  available?: ReadonlySet<string>,
): ResolvedDebugConfiguration {
  const support = testDebugSupport(request.adapterId, available);
  if (!support.supported || support.dapAdapter !== "lldb")
    throw new TestDebugError(support.reason ?? "This test cannot be debugged with lldb-dap.");
  if (!executable.trim()) throw new TestDebugError("No compiled test executable was resolved.");
  return {
    id: `test-debug:${request.caseId}`,
    name: `Debug Test: ${request.fullName}`,
    adapter: "lldb",
    request: "launch",
    program: executable,
    cwd: null,
    env: {},
    // libtest: run exactly the selected test. The node-id path is one opaque argument.
    args: [request.fullName, "--exact"],
    stopOnEntry: false,
    port: null,
    preLaunchTask: null,
    scope: "workspace",
  };
}

/**
 * The launch configuration for a JavaScript test under js-debug (WS6). Each runner is launched as
 * a Node program (its workspace-local CLI, confined to the workspace by the DebugService) with the
 * selected test as **opaque arguments** — the file and the test name/title are never shell strings.
 * Only the one selected test runs (`--runInBand` / `run` / `--workers=1`), and source maps (set by
 * the `node` adapter) bind breakpoints in the original TypeScript.
 */
function buildNodeTestConfiguration(
  request: TestDebugRequest,
  base: Omit<ResolvedDebugConfiguration, "program" | "module" | "args">,
): ResolvedDebugConfiguration {
  switch (request.adapterId) {
    case "jest":
      return {
        ...base,
        program: "node_modules/jest/bin/jest.js",
        args: ["--runInBand", request.file, "-t", request.fullName],
      };
    case "vitest":
      return {
        ...base,
        program: "node_modules/vitest/vitest.mjs",
        args: ["run", request.file, "-t", request.fullName],
      };
    case "playwright": {
      // A Playwright full name may carry a `[project]` suffix; split it into a grep + a project.
      const match = request.fullName.match(/^(.*) \[([^\]]+)\]$/);
      const grep = match ? match[1]! : request.fullName;
      const project = match ? match[2]! : null;
      return {
        ...base,
        program: "node_modules/@playwright/test/cli.js",
        args: [
          "test",
          request.file,
          "-g",
          grep,
          "--workers=1",
          ...(project ? ["--project", project] : []),
        ],
      };
    }
    default:
      // A JavaScript framework with no specific launch recipe: run the file directly.
      return { ...base, program: request.file, args: [] };
  }
}
