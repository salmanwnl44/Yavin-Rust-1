/**
 * The TestResultStore (WS5): keeps the current {@link TestReport} and a bounded history of past
 * runs, and answers per-case history questions — the last status a test had, and whether it has
 * been flaky (seen both passing and failing) across retained runs. The Test Explorer uses it to
 * show a case's trend and to surface newly-broken tests; the controller owns *running*, the store
 * owns *remembering*.
 *
 * It is a plain in-memory store with no process, file, or network access, so it is cheap to unit
 * test and cannot run anything.
 */
import { caseId } from "./model.ts";
import type { TestReport, TestStatus } from "./model.ts";

export interface RunRecord {
  readonly report: TestReport;
  /** When the run finished (ms since epoch, from the injected clock). */
  readonly at: number;
}

/** The status trend of one test case across retained runs, newest run last. */
export interface CaseHistory {
  readonly id: string;
  readonly statuses: readonly TestStatus[];
  /** Seen both a pass and a failure in the retained window. */
  readonly flaky: boolean;
}

const DEFAULT_LIMIT = 50;

export function createResultStore(options?: { limit?: number; now?: () => number }) {
  const limit = Math.max(1, options?.limit ?? DEFAULT_LIMIT);
  const now = options?.now ?? (() => Date.now());
  // Oldest first; the last element is the current run. Bounded to `limit`.
  const runs: RunRecord[] = [];
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  /** Every retained status for one case id, oldest run first. A run that did not include the
   * case contributes nothing (so a filtered single-file run does not erase other files' trend). */
  function statusesFor(id: string): TestStatus[] {
    const out: TestStatus[] = [];
    for (const run of runs) {
      for (const file of run.report.files) {
        for (const c of file.cases) {
          if (caseId(file.file, c.ancestors.concat(c.label).join(" ")) === id) out.push(c.status);
        }
      }
    }
    return out;
  }

  return {
    /** The most recent run, or null before any run completes. */
    current(): TestReport | null {
      return runs.length ? runs[runs.length - 1]!.report : null;
    },

    /** All retained runs, oldest first. */
    history(): readonly RunRecord[] {
      return runs;
    },

    /** Record a completed run as the new current report, evicting the oldest past the limit. */
    record(report: TestReport): void {
      runs.push({ report, at: now() });
      while (runs.length > limit) runs.shift();
      notify();
    },

    /** The status trend for one case across retained runs (newest last), and whether it is flaky. */
    caseHistory(id: string): CaseHistory {
      const statuses = statusesFor(id);
      const sawPass = statuses.includes("passed");
      const sawFail = statuses.includes("failed");
      return { id, statuses, flaky: sawPass && sawFail };
    },

    /** Cases that were passing in the previous retained run but are failing in the current one. */
    newlyFailed(): readonly string[] {
      if (runs.length < 2) return [];
      const prev = statusByIdIn(runs[runs.length - 2]!.report);
      const curr = runs[runs.length - 1]!.report;
      const out: string[] = [];
      for (const file of curr.files) {
        for (const c of file.cases) {
          const id = caseId(file.file, c.ancestors.concat(c.label).join(" "));
          if (c.status === "failed" && prev.get(id) === "passed") out.push(id);
        }
      }
      return out;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    /** Drop all history — for a workspace switch. */
    clear(): void {
      runs.length = 0;
      notify();
    },
  };
}

function statusByIdIn(report: TestReport): Map<string, TestStatus> {
  const map = new Map<string, TestStatus>();
  for (const file of report.files) {
    for (const c of file.cases) {
      map.set(caseId(file.file, c.ancestors.concat(c.label).join(" ")), c.status);
    }
  }
  return map;
}

export type TestResultStore = ReturnType<typeof createResultStore>;
