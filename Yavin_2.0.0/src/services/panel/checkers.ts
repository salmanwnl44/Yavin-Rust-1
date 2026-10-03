/**
 * The workspace's checkers (IDE-01): running a project's own compiler or linter and
 * publishing what it reports into the Problems store.
 *
 * ```text
 * ProblemsView (buttons, status line)  -- reads the snapshot, calls run / stop
 *        │
 * CheckerService (one per workspace)   -- which checkers apply, the run in progress, its outcome
 *        │  run_checker / cancel_checker / available_checkers (native allow-list, trust-gated)
 *        ▼
 * matcher (problemMatchers.ts) -> paths resolved against the folder it ran in
 *        (problemLocations.ts) -> publishProblems(owner, ...)
 * ```
 *
 * - **One run at a time.** Starting a run replaces the one in progress (the native side
 *   cancels it); the replaced run's answer, whenever it comes, changes nothing.
 * - **The workspace's alone.** Once the workspace is disposed nothing it started is
 *   published, and a run still going is stopped.
 * - **Stopped and timed out are outcomes, not failures.** Only a checker that could not run,
 *   or that exited non-zero with nothing to show, is a failure.
 */
import { MATCHERS, parseProblems, type Diagnostic } from "./problemMatchers.ts";
import { resolveCheckerDiagnostics } from "./problemLocations.ts";

export interface CheckerInfo {
  id: string;
  label: string;
}

export type CheckerStatus =
  | { kind: "idle" }
  | { kind: "running"; id: string; label: string }
  /** `outside`: diagnostics naming no file of the workspace, not published. */
  | { kind: "done"; label: string; found: number; outside: number }
  | { kind: "cancelled"; label: string }
  | { kind: "timedOut"; label: string }
  | { kind: "failed"; label: string; message: string };

export interface CheckerSnapshot {
  readonly available: readonly CheckerInfo[];
  readonly status: CheckerStatus;
}

/** The native side, as the service needs it. */
export interface CheckerNative {
  available(): Promise<unknown>;
  run(id: string): Promise<unknown>;
  cancel(): Promise<unknown>;
}

export interface CheckerService {
  getSnapshot(): CheckerSnapshot;
  subscribe(listener: () => void): () => void;
  /** Learns which checkers apply; none while the folder is not trusted. */
  refresh(trusted: boolean): Promise<void>;
  run(id: string): Promise<void>;
  stop(): void;
  dispose(): void;
}

interface RunAnswer {
  outcome: "completed" | "cancelled" | "timedOut";
  output: string;
  code: number;
  root: string;
}

function parseAnswer(value: unknown): RunAnswer | null {
  const v = value as Partial<RunAnswer> | null;
  if (!v || typeof v !== "object") return null;
  if (v.outcome !== "completed" && v.outcome !== "cancelled" && v.outcome !== "timedOut")
    return null;
  if (typeof v.output !== "string" || typeof v.code !== "number" || typeof v.root !== "string")
    return null;
  return v as RunAnswer;
}

/** The first line with anything on it, which is where a tool says why it could not run. */
const firstLine = (text: string): string =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? "";

export function createCheckerService(
  native: CheckerNative,
  publish: (owner: string, label: string, diagnostics: readonly Diagnostic[]) => void,
): CheckerService {
  const listeners = new Set<() => void>();
  let snapshot: CheckerSnapshot = Object.freeze({
    available: [],
    status: { kind: "idle" } as CheckerStatus,
  });
  let disposed = false;
  /** Bumped by every run and every dispose: an answer for an older one is dropped. */
  let runs = 0;
  let refreshes = 0;

  const set = (patch: Partial<CheckerSnapshot>) => {
    if (disposed) return;
    snapshot = Object.freeze({ ...snapshot, ...patch });
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        /* One listener's failure is not the service's. */
      }
    }
  };

  const service: CheckerService = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async refresh(trusted) {
      const mine = ++refreshes;
      if (!trusted) {
        set({ available: [] });
        return;
      }
      let available: CheckerInfo[] = [];
      try {
        const answer = await native.available();
        if (Array.isArray(answer))
          available = answer.filter(
            (one): one is CheckerInfo =>
              !!one && typeof one.id === "string" && typeof one.label === "string",
          );
      } catch {
        // No workspace open yet is the common case, and not worth an error.
      }
      if (mine === refreshes) set({ available });
    },

    async run(id) {
      if (disposed) return;
      const label = snapshot.available.find((one) => one.id === id)?.label ?? id;
      const mine = ++runs;
      set({ status: { kind: "running", id, label } });
      const current = () => !disposed && mine === runs;
      let status: CheckerStatus;
      try {
        const answer = parseAnswer(await native.run(id));
        if (!current()) return;
        if (!answer) throw new Error(`${label} gave an answer Yavin cannot read.`);
        if (answer.outcome === "cancelled") status = { kind: "cancelled", label };
        else if (answer.outcome === "timedOut") status = { kind: "timedOut", label };
        else {
          const matcher = MATCHERS[id];
          if (!matcher) throw new Error(`No matcher for ${id}.`);
          const found = parseProblems(matcher, answer.output);
          // A checker that finds problems exits nonzero, so a nonzero exit on its own means
          // nothing. A nonzero exit with nothing to show, however, is a tool that did not run
          // -- `npx --no-install tsc` with no local TypeScript, a broken config -- and
          // reporting that as "No problems found" is the most misleading thing to say.
          if (answer.code !== 0 && found.length === 0)
            throw new Error(
              firstLine(answer.output) || `${label} exited with code ${answer.code}.`,
            );
          const { diagnostics, outside } = resolveCheckerDiagnostics(found, answer.root);
          // Publishing an empty list is meaningful: it clears what this tool said last time.
          publish(matcher.owner, label, diagnostics);
          status = { kind: "done", label, found: diagnostics.length, outside };
        }
      } catch (reason) {
        if (!current()) return;
        status = {
          kind: "failed",
          label,
          message: reason instanceof Error ? reason.message : String(reason),
        };
      }
      set({ status });
    },

    stop() {
      if (snapshot.status.kind !== "running") return;
      void native.cancel().catch(() => undefined);
    },

    dispose() {
      if (disposed) return;
      const running = snapshot.status.kind === "running";
      disposed = true;
      runs += 1;
      listeners.clear();
      // Whatever is still running was started for this workspace's files.
      if (running) void native.cancel().catch(() => undefined);
    },
  };
  return service;
}

/** The status line's sentence for a run's outcome; `""` when there is nothing to say. */
export function describeCheckerStatus(status: CheckerStatus): string {
  switch (status.kind) {
    case "idle":
    case "running":
      return "";
    case "done":
      return status.outside
        ? `${status.label}: ${status.outside} result${status.outside === 1 ? "" : "s"} outside the workspace not shown.`
        : "";
    case "cancelled":
      return `${status.label} was stopped.`;
    case "timedOut":
      return `${status.label} timed out and was stopped.`;
    case "failed":
      return `${status.label}: ${status.message}`;
  }
}
