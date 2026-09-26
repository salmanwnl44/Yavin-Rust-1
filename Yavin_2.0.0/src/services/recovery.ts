import type { LogLevel } from "./panel/output.ts";

/**
 * What crash recovery found at startup, on the UI side.
 *
 * The native side settles operations a previous Yavin left in progress
 * (`src-tauri/crates/ide-workspace/src/recovery.rs`): it finishes or undoes an interrupted save
 * where the disk proves that safe, and keeps everything else -- a conflict, a half-finished
 * delete, an interrupted Git command -- as an unresolved item until the user dismisses it. This
 * module is the report's shape here, the guard that stops a malformed payload reaching the UI,
 * and the wording shown for it.
 */

export type RecoveryOutcome =
  | "completed"
  | "notApplied"
  | "rolledForward"
  | "rolledBack"
  | "conflict"
  | "partial"
  | "interrupted"
  | "corrupt";

export interface RecoveryItem {
  id: string;
  kind: string | null;
  outcome: RecoveryOutcome;
  paths: string[];
  message: string;
  at: number;
}

export interface RecoveryReport {
  /** What this start did. */
  actions: RecoveryItem[];
  /** Everything still waiting for the user, from this start or earlier ones. */
  unresolved: RecoveryItem[];
}

const OUTCOMES: readonly string[] = [
  "completed",
  "notApplied",
  "rolledForward",
  "rolledBack",
  "conflict",
  "partial",
  "interrupted",
  "corrupt",
];
const UNRESOLVED: readonly RecoveryOutcome[] = ["conflict", "partial", "interrupted", "corrupt"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function asItem(value: unknown): RecoveryItem | null {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id) return null;
  if (typeof value.outcome !== "string" || !OUTCOMES.includes(value.outcome)) return null;
  if (typeof value.message !== "string") return null;
  return {
    id: value.id,
    kind: typeof value.kind === "string" ? value.kind : null,
    outcome: value.outcome as RecoveryOutcome,
    paths: Array.isArray(value.paths)
      ? value.paths.filter((path): path is string => typeof path === "string")
      : [],
    message: value.message,
    at: typeof value.at === "number" ? value.at : 0,
  };
}

/** The report as the UI may use it. Anything malformed in it is dropped, never guessed at. */
export function asRecoveryReport(value: unknown): RecoveryReport {
  const list = (items: unknown) =>
    (Array.isArray(items) ? items : [])
      .map(asItem)
      .filter((item): item is RecoveryItem => item !== null);
  return isRecord(value)
    ? { actions: list(value.actions), unresolved: list(value.unresolved) }
    : { actions: [], unresolved: [] };
}

/**
 * The lines to log and the one-line banner to show, if any. What was settled quietly is
 * logged at info; what needs the user is logged as a warning, once, and summarised in the
 * banner.
 */
export function describeRecovery(report: RecoveryReport): {
  lines: { text: string; level: LogLevel }[];
  banner: string | null;
} {
  const lines = [
    ...report.actions
      .filter((item) => !UNRESOLVED.includes(item.outcome))
      .map((item) => ({ text: item.message, level: "info" as const })),
    ...report.unresolved.map((item) => ({
      text: `Needs attention: ${item.message}`,
      level: "warn" as const,
    })),
  ];
  const count = report.unresolved.length;
  const banner = count
    ? `${count} interrupted operation${count === 1 ? " needs" : "s need"} attention — see ` +
      "Output › Recovery. Run “Dismiss Recovery Items” once dealt with."
    : null;
  return { lines, banner };
}
