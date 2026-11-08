/**
 * The Testing Platform's data model (WS5).
 *
 * A projection of a test framework's results, not a store of framework truth: every fact comes
 * from a run, identities are stable across runs (a file by its path, a case by its file + full
 * name), and the tree the Test Explorer shows is derived from it. The platform runs frameworks
 * only through the existing authorized, allow-listed process runner (never an interpolated
 * shell command), exactly as the checkers subsystem does.
 */

export type TestStatus = "passed" | "failed" | "skipped" | "running" | "pending";

export interface TestLocation {
  /** Absolute file path as the framework reported it. */
  readonly file: string;
  readonly line?: number;
  readonly column?: number;
}

/** One assertion/`it`/`test`. */
export interface TestCase {
  /** Stable across runs: `${file}\u0000${fullName}`. */
  readonly id: string;
  readonly kind: "case";
  /** The test's own title (the last segment of its full name). */
  readonly label: string;
  /** The describe()/suite path above it. */
  readonly ancestors: readonly string[];
  readonly location: TestLocation;
  readonly status: TestStatus;
  readonly durationMs?: number;
  /** Failure message + stack, when failed. */
  readonly message?: string;
  /** The browser/project this case ran under, when the framework reports one (Playwright). */
  readonly project?: string;
  /** Passed only after a retry (Playwright flaky). */
  readonly flaky?: boolean;
}

/** One test file, holding its cases. */
export interface TestFile {
  /** Stable: the file's path (the Test Explorer re-keys subtrees by this). */
  readonly id: string;
  readonly kind: "file";
  readonly file: string;
  readonly label: string;
  readonly cases: readonly TestCase[];
  /** Aggregate: failed if any case failed, else passed if any passed, else skipped. */
  readonly status: TestStatus;
}

export interface TestSummary {
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly total: number;
  readonly durationMs?: number;
}

/**
 * A compiler diagnostic, kept **separate** from test-case results. Compiled runners (Cargo) can
 * fail to build before any test runs; that is a distinct state from a test assertion failing, and
 * the UI must not confuse the two. Runners that do not compile (Jest/Vitest) never set these.
 */
export interface TestDiagnostic {
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
}

/** A parsed run: the files and their cases, plus the totals. */
export interface TestReport {
  readonly files: readonly TestFile[];
  readonly summary: TestSummary;
  /**
   * Non-test errors that stopped the run — a Cargo compile error, a Playwright config/discovery
   * error. Kept **separate** from test-case results so a setup failure is never shown as an
   * assertion failure.
   */
  readonly diagnostics?: readonly TestDiagnostic[];
  /**
   * Whether the run's setup succeeded. `false` means a setup error (compilation for Cargo,
   * configuration/discovery for Playwright) stopped the run and **no tests ran** — a distinct state
   * from test failures. `undefined` for runners with no separate setup phase (Jest/Vitest).
   */
  readonly compiled?: boolean;
}

/** A stable id for a case, from its file and full name. */
export function caseId(file: string, fullName: string): string {
  return `${file}\u0000${fullName}`;
}

/** The aggregate status of a set of case statuses. */
export function aggregateStatus(statuses: readonly TestStatus[]): TestStatus {
  if (statuses.some((s) => s === "failed")) return "failed";
  if (statuses.some((s) => s === "running")) return "running";
  if (statuses.some((s) => s === "passed")) return "passed";
  if (statuses.some((s) => s === "pending")) return "pending";
  return "skipped";
}
