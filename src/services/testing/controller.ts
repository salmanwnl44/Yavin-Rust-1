/**
 * The TestController (WS5): owns the test lifecycle and state for one workspace. It selects the
 * workspace's adapter, runs a selector (all / a file / a case / the previously-failed) through an
 * **injected authorized runner** (the checker-style allow-listed process service — never an
 * arbitrary command), and keeps the latest report. Runs are generation-guarded so a stale or
 * superseded run never overwrites a newer one, and `reset()` (a workspace switch) abandons any
 * in-flight run.
 */
import { selectAdapter } from "./adapters.ts";
import type { TestAdapter, TestCommand, TestSelector } from "./adapters.ts";
import type { TestReport } from "./model.ts";

/** Runs a command as argv, captures stdout, returns it with the exit code. The host injects the
 * authorized, allow-listed runner; the controller never spawns anything itself. */
export type TestRunner = (
  command: TestCommand,
  signal: AbortSignal,
) => Promise<{ output: string; code: number }>;

export type TestPhase = "idle" | "running" | "done" | "failed" | "cancelled";

export interface TestState {
  /** The detected adapter's id, or null if none fits this workspace. */
  readonly adapter: string | null;
  readonly phase: TestPhase;
  readonly report: TestReport | null;
  readonly error: string | null;
  /** Bumped by every run/reset; a completing run applies its result only if it is still current. */
  readonly generation: number;
}

export function createTestController(options: {
  markerNames: readonly string[];
  run: TestRunner;
  adapters?: readonly TestAdapter[];
  now?: () => number;
}) {
  const adapter = selectAdapter(options.markerNames, options.adapters);
  const now = options.now ?? (() => performance.now());
  let state: TestState = {
    adapter: adapter?.id ?? null,
    phase: "idle",
    report: null,
    error: null,
    generation: 0,
  };
  const listeners = new Set<() => void>();
  let inFlight: AbortController | null = null;

  const emit = (next: Partial<TestState>) => {
    state = { ...state, ...next };
    for (const listener of [...listeners]) listener();
  };

  async function runSelector(selector: TestSelector): Promise<void> {
    if (!adapter) {
      emit({ phase: "failed", error: "No test framework detected in this workspace." });
      return;
    }
    inFlight?.abort(); // supersede any run in progress
    const myGen = state.generation + 1;
    const controller = new AbortController();
    inFlight = controller;
    emit({ phase: "running", error: null, generation: myGen });
    const started = now();
    try {
      const { output } = await options.run(adapter.command(selector), controller.signal);
      if (myGen !== state.generation) return; // a newer run/reset superseded this one
      const report = adapter.parse(output, now() - started);
      // A compile failure (Cargo) means no tests ran — a failed run, distinct from test failures,
      // and not a "done" state even though `summary.failed` is 0.
      const failed = report.summary.failed > 0 || report.compiled === false;
      emit({ phase: failed ? "failed" : "done", report, error: null });
    } catch (reason) {
      if (controller.signal.aborted) {
        if (myGen === state.generation) emit({ phase: "cancelled" });
        return;
      }
      if (myGen !== state.generation) return;
      emit({ phase: "failed", error: String(reason) });
    }
  }

  return {
    getState: (): TestState => state,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    adapter: (): TestAdapter | null => adapter,
    runAll: () => runSelector({ kind: "all" }),
    runFile: (file: string) => runSelector({ kind: "file", file }),
    runCase: (file: string, fullName: string) => runSelector({ kind: "case", file, fullName }),

    /** Re-runs the previously-failed tests: one case, or one file, or all when failures span files. */
    rerunFailed(): Promise<void> {
      const failed = (state.report?.files ?? []).flatMap((f) =>
        f.cases
          .filter((c) => c.status === "failed")
          .map((c) => ({ file: f.file, name: c.ancestors.concat(c.label).join(" "), full: c })),
      );
      if (failed.length === 0) return Promise.resolve();
      const files = new Set(failed.map((f) => f.file));
      if (failed.length === 1)
        return runSelector({
          kind: "case",
          file: failed[0]!.file,
          fullName: failedFullName(failed[0]!.full),
        });
      if (files.size === 1) return runSelector({ kind: "file", file: [...files][0]! });
      return runSelector({ kind: "all" });
    },

    /** Cancels an in-flight run; its state becomes `cancelled`. */
    cancel(): void {
      inFlight?.abort();
    },

    /** Abandons any run and clears results — for a workspace switch. */
    reset(): void {
      inFlight?.abort();
      emit({ phase: "idle", report: null, error: null, generation: state.generation + 1 });
    },
  };
}

function failedFullName(c: { ancestors: readonly string[]; label: string }): string {
  return c.ancestors.concat(c.label).join(" ");
}

export type TestController = ReturnType<typeof createTestController>;
