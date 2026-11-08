/**
 * Parser for pytest's JSON output via the `pytest-json-report` plugin (WS5.5) — a shape distinct
 * from Jest/Vitest, Cargo and Playwright, so it has its own parser.
 *
 * The plugin emits `{ tests[], collectors[], summary, duration }`. Each `test` carries its **node
 * id** (`path::Class::test[param]` — the stable identity pytest itself uses to run one test), a
 * 0-based `lineno`, an `outcome` (passed / failed / skipped / xfailed / xpassed / error), and
 * `setup`/`call`/`teardown` phases with durations and, on failure, a `crash` and `longrepr`
 * traceback. A node id splits into the file, the class hierarchy (ancestors) and the test name
 * (including any `[param]`, which is the parameterized identity).
 *
 * **Collection/import errors are kept distinct from test failures:** a `collectors[]` entry with
 * `outcome: "failed"` is a discovery error → {@link TestReport.diagnostics}; when nothing ran it
 * sets `compiled = false` (a setup failure, not an assertion failure). The parser tolerates banner
 * noise, truncation and empty output (typed {@link TestParseError}).
 */
import { aggregateStatus, caseId } from "./model.ts";
import type { TestCase, TestDiagnostic, TestFile, TestReport, TestStatus } from "./model.ts";
import { TestParseError } from "./jestJson.ts";

interface RawPhase {
  duration?: number;
  outcome?: string;
  crash?: { path?: string; lineno?: number; message?: string };
  longrepr?: string;
}
interface RawTest {
  nodeid?: string;
  lineno?: number;
  outcome?: string;
  setup?: RawPhase;
  call?: RawPhase;
  teardown?: RawPhase;
}
interface RawCollector {
  nodeid?: string;
  outcome?: string;
  longrepr?: string;
}
interface RawReport {
  tests?: RawTest[];
  collectors?: RawCollector[];
  summary?: Record<string, number>;
  duration?: number;
}

/** pytest outcome -> ours. xfailed (expected failure) counts skipped; xpassed counts passed. */
function statusOf(outcome: string | undefined): TestStatus {
  switch (outcome) {
    case "passed":
    case "xpassed":
      return "passed";
    case "failed":
    case "error":
      return "failed";
    default:
      // "skipped" | "xfailed" | undefined
      return "skipped";
  }
}

/** Split a pytest node id into its file, class ancestry, and leaf name (kept with its `[param]`). */
function partsOf(nodeid: string): {
  file: string;
  ancestors: string[];
  label: string;
  rest: string;
} {
  const segments = nodeid.split("::");
  const file = segments[0] ?? nodeid;
  const tail = segments.slice(1);
  if (tail.length === 0) return { file, ancestors: [], label: file, rest: file };
  const label = tail[tail.length - 1]!;
  const ancestors = tail.slice(0, -1);
  return { file, ancestors, label, rest: tail.join("::") };
}

function extractJson(output: string): unknown {
  const trimmed = output.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end <= start)
      throw new TestParseError("no JSON object found in pytest's output.");
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch (reason) {
      throw new TestParseError(`pytest's JSON could not be parsed: ${String(reason)}`);
    }
  }
}

/** The failure phase of a test (call, then setup, then teardown), when it failed. */
function failedPhase(test: RawTest): RawPhase | undefined {
  for (const phase of [test.call, test.setup, test.teardown])
    if (phase && (phase.outcome === "failed" || phase.outcome === "error")) return phase;
  return undefined;
}

export function parsePytestJson(output: string, totalDurationMs?: number): TestReport {
  // A clear dependency state: the run was asked for JSON but the plugin is not installed.
  if (/(unrecognized arguments:|no such option:?)[^\n]*json-report/i.test(output))
    throw new TestParseError(
      "The pytest-json-report plugin is not installed. Install it with `pip install pytest-json-report`.",
    );
  const parsed = extractJson(output) as RawReport;
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.tests))
    throw new TestParseError("pytest's output has no `tests` (is pytest-json-report installed?).");

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const byFile = new Map<string, TestCase[]>();
  const order: string[] = [];

  for (const test of parsed.tests) {
    const nodeid = test.nodeid ?? "(unknown)";
    const { file, ancestors, label, rest } = partsOf(nodeid);
    const status = statusOf(test.outcome);
    if (status === "passed") passed++;
    else if (status === "failed") failed++;
    else skipped++;
    const duration =
      (test.setup?.duration ?? 0) + (test.call?.duration ?? 0) + (test.teardown?.duration ?? 0);
    const phase = failedPhase(test);
    const message =
      status === "failed"
        ? (phase?.longrepr ?? phase?.crash?.message ?? "Test failed.")
        : undefined;
    // The failure's own line (1-based from pytest's crash), else the test's definition line
    // (pytest `lineno` is 0-based).
    const line =
      phase?.crash?.lineno ?? (typeof test.lineno === "number" ? test.lineno + 1 : undefined);
    const caseItem: TestCase = {
      id: caseId(file, rest), // the node id (minus file) — the stable identity used to run it
      kind: "case",
      label,
      ancestors,
      location: { file: phase?.crash?.path ?? file, line },
      status,
      durationMs: duration > 0 ? duration * 1000 : undefined,
      message,
    };
    if (!byFile.has(file)) {
      byFile.set(file, []);
      order.push(file);
    }
    byFile.get(file)!.push(caseItem);
  }

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

  // Collection/import errors: a collector that failed is a discovery error, kept separate.
  const diagnostics: TestDiagnostic[] = (parsed.collectors ?? [])
    .filter((collector) => collector.outcome === "failed")
    .map((collector) => ({
      message: collector.longrepr ?? "Collection error.",
      file: collector.nodeid || undefined,
    }));

  const total = passed + failed + skipped;
  const setupFailed = total === 0 && diagnostics.length > 0;

  return {
    files,
    summary: {
      passed,
      failed,
      skipped,
      total,
      durationMs: totalDurationMs ?? (parsed.duration ? parsed.duration * 1000 : undefined),
    },
    diagnostics: diagnostics.length ? diagnostics : undefined,
    compiled: setupFailed ? false : undefined,
  };
}
