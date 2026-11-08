/**
 * The TestRunService (WS5): turns an adapter's safe argv into the {@link TestRunner} the
 * controller consumes, by delegating to the **existing authorized process runner** — the same
 * trust-gated, allow-listed native seam the checkers subsystem uses (`run_checker` /
 * `cancel_checker`). It never spawns a process itself and never builds a shell string: the
 * `program` and `args` cross the boundary structurally, so a test name or path carrying shell
 * metacharacters is one argument, never something a shell parses.
 *
 * The native side is injected (a {@link TestRunNative}) so this is a pure, unit-testable seam.
 * In the Tauri host, {@link TestRunNative.run} is `invoke("run_test", { program, args })`, which
 * the backend authorizes exactly like `run_checker` — the program must be an allow-listed project
 * tool resolved inside the trusted workspace, or the call is refused. A completed run returns the
 * same `{ outcome, output, code, root }` shape the checker runner returns.
 *
 * Reuse, not duplication: this adds no process, PTY, task, or diagnostics infrastructure — it
 * routes a test run through the one the IDE already has.
 */
import type { TestCommand } from "./adapters.ts";
import type { TestRunner } from "./controller.ts";

/** A completed run, mirroring the checker runner's answer. */
export interface TestRunAnswer {
  readonly outcome: "completed" | "cancelled" | "timedOut";
  readonly output: string;
  readonly code: number;
  /** The directory the run executed in, for resolving relative paths in output. */
  readonly root: string;
}

/** The native process seam, as the service needs it — the same shape as the checker seam. */
export interface TestRunNative {
  /** Run the argv through the authorized, allow-listed runner; resolves with a {@link TestRunAnswer}. */
  run(command: TestCommand): Promise<unknown>;
  /** Cancel the run in progress. */
  cancel(): Promise<unknown>;
}

/** Thrown when the runner reports the run timed out (distinct from a cancellation). */
export class TestRunTimeoutError extends Error {
  constructor() {
    super("The test run timed out and was stopped.");
    this.name = "TestRunTimeoutError";
  }
}

function parseAnswer(value: unknown): TestRunAnswer | null {
  const v = value as Partial<TestRunAnswer> | null;
  if (!v || typeof v !== "object") return null;
  if (v.outcome !== "completed" && v.outcome !== "cancelled" && v.outcome !== "timedOut")
    return null;
  if (typeof v.output !== "string" || typeof v.code !== "number" || typeof v.root !== "string")
    return null;
  return v as TestRunAnswer;
}

/**
 * Build the controller's {@link TestRunner} from a native seam. The returned function:
 * - asks the native side to cancel if the caller's {@link AbortSignal} fires (so the controller's
 *   `cancel()` reaches the real process);
 * - translates a `cancelled` outcome into an `AbortError`, which the controller reads as the
 *   `cancelled` phase;
 * - throws {@link TestRunTimeoutError} on a timeout, which the controller reports as `failed`;
 * - otherwise returns the run's `{ output, code }` for the adapter to parse.
 */
export function createTestRunner(native: TestRunNative): TestRunner {
  return async (command: TestCommand, signal: AbortSignal) => {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const onAbort = () => void native.cancel().catch(() => undefined);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const answer = parseAnswer(await native.run(command));
      if (!answer) throw new Error("The test runner returned an answer Yavin cannot read.");
      if (answer.outcome === "cancelled") throw new DOMException("Aborted", "AbortError");
      if (answer.outcome === "timedOut") throw new TestRunTimeoutError();
      return { output: answer.output, code: answer.code };
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  };
}
