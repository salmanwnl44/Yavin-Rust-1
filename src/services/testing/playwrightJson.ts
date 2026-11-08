/**
 * Parser for Playwright's official JSON reporter (`--reporter=json`), a shape distinct from the
 * Jest/Vitest schema, so it has its own parser (WS5.4).
 *
 * Playwright nests suites (`suites[].suites[]`) with the file as the outermost suite; each spec
 * (`specs[]`) runs once per configured **project/browser** (`tests[]`), and each project runs its
 * attempts (`results[]`, one per retry). A spec's status is `expected` / `unexpected` / `flaky` /
 * `skipped`; a result's status is `passed` / `failed` / `timedOut` / `skipped` / `interrupted`.
 *
 * It keeps **configuration/discovery errors separate from test failures**: top-level `errors[]`
 * with no tests parsed becomes {@link TestReport.diagnostics} with `compiled = false` (a setup
 * failure, not an assertion failure). A case's identity is stable across runs (file + full title +
 * project), and the parser tolerates banner noise, truncation, and empty output.
 */
import { aggregateStatus, caseId } from "./model.ts";
import type { TestCase, TestDiagnostic, TestFile, TestReport, TestStatus } from "./model.ts";
import { TestParseError } from "./jestJson.ts";

interface RawResult {
  status?: string;
  duration?: number;
  retry?: number;
  error?: { message?: string; stack?: string };
  errors?: Array<{ message?: string }>;
  errorLocation?: { file?: string; line?: number; column?: number };
}
interface RawTest {
  projectName?: string;
  status?: string; // skipped | expected | unexpected | flaky
  results?: RawResult[];
}
interface RawSpec {
  title?: string;
  id?: string;
  file?: string;
  line?: number;
  column?: number;
  tests?: RawTest[];
}
interface RawSuite {
  title?: string;
  file?: string;
  specs?: RawSpec[];
  suites?: RawSuite[];
}
interface RawReport {
  suites?: RawSuite[];
  errors?: Array<{
    message?: string;
    location?: { file?: string; line?: number; column?: number };
  }>;
  stats?: { duration?: number };
}

/** Playwright's spec-level status -> ours. `flaky` passed after a retry; `skipped` did not run. */
function statusOf(raw: string | undefined): TestStatus {
  switch (raw) {
    case "expected":
    case "flaky":
      return "passed";
    case "unexpected":
      return "failed";
    default:
      return "skipped"; // "skipped" | undefined
  }
}

/** Pull out the JSON object even if a dotenv/banner line precedes it (same tactic as jestJson). */
function extractJson(output: string): unknown {
  const trimmed = output.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end <= start)
      throw new TestParseError("no JSON object found in Playwright's output.");
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch (reason) {
      throw new TestParseError(`Playwright's JSON could not be parsed: ${String(reason)}`);
    }
  }
}

export function parsePlaywrightJson(output: string, totalDurationMs?: number): TestReport {
  const parsed = extractJson(output) as RawReport;
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.suites))
    throw new TestParseError("Playwright's output has no `suites`.");

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  // Group cases by file, first-seen order.
  const byFile = new Map<string, TestCase[]>();
  const order: string[] = [];

  const addCase = (file: string, c: TestCase) => {
    if (!byFile.has(file)) {
      byFile.set(file, []);
      order.push(file);
    }
    byFile.get(file)!.push(c);
  };

  /** Walk a suite, accumulating describe titles (the file-level suite title is dropped). */
  const walk = (suite: RawSuite, file: string, ancestors: readonly string[]) => {
    const here = suite.file ?? file;
    for (const spec of suite.specs ?? []) {
      const specFile = spec.file ?? here;
      for (const test of spec.tests ?? []) {
        const status = statusOf(test.status);
        const project = test.projectName || undefined;
        const title = spec.title ?? "(unnamed test)";
        // Full name includes the project so multi-project specs are distinct and stable.
        const fullName = [...ancestors, title].join(" ") + (project ? ` [${project}]` : "");
        if (status === "passed") passed++;
        else if (status === "failed") failed++;
        else skipped++;
        const results = test.results ?? [];
        const last = results.reduce<RawResult | undefined>(
          (acc, r) => (acc === undefined || (r.retry ?? 0) >= (acc.retry ?? 0) ? r : acc),
          undefined,
        );
        const message =
          status === "failed"
            ? (last?.error?.stack ??
              last?.error?.message ??
              last?.errors?.map((e) => e.message).join("\n") ??
              "Test failed.")
            : undefined;
        addCase(specFile, {
          id: caseId(specFile, fullName),
          kind: "case",
          label: project ? `${title} [${project}]` : title,
          ancestors,
          location: { file: specFile, line: spec.line, column: spec.column },
          status,
          durationMs: last?.duration,
          message,
          project,
          flaky: test.status === "flaky" || undefined,
        });
      }
    }
    for (const child of suite.suites ?? [])
      walk(child, here, child.title ? [...ancestors, child.title] : ancestors);
  };

  for (const suite of parsed.suites) walk(suite, suite.file ?? "(unknown)", []);

  const files: TestFile[] = order.map((file) => {
    const cases = byFile.get(file)!;
    return {
      id: file,
      kind: "file",
      file,
      label: file.slice(Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")) + 1),
      cases,
      status: aggregateStatus(cases.map((c) => c.status)),
    };
  });

  const total = passed + failed + skipped;
  const errors = parsed.errors ?? [];
  const diagnostics: TestDiagnostic[] = errors.map((e) => ({
    message: e.message ?? "(Playwright error)",
    file: e.location?.file,
    line: e.location?.line,
    column: e.location?.column,
  }));

  // A top-level error with nothing that ran is a configuration/discovery failure, not an empty
  // suite — kept distinct, and surfaced as such.
  const setupFailed = total === 0 && diagnostics.length > 0;

  return {
    files,
    summary: {
      passed,
      failed,
      skipped,
      total,
      durationMs: totalDurationMs ?? parsed.stats?.duration,
    },
    diagnostics: diagnostics.length ? diagnostics : undefined,
    compiled: setupFailed ? false : undefined,
  };
}
