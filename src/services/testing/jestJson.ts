/**
 * Parses the JSON that Jest (`--json`) and Vitest (`--reporter=json`) both emit — they share
 * one schema — into the Testing Platform's {@link TestReport}. This is the reusable core both
 * the Vitest and Jest adapters use; a new framework needs only its own argv + detection if it
 * can emit this shape, or its own parser otherwise.
 */
import { aggregateStatus, caseId } from "./model.ts";
import type { TestCase, TestFile, TestReport, TestStatus } from "./model.ts";

export class TestParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestParseError";
  }
}

interface RawAssertion {
  ancestorTitles?: string[];
  title?: string;
  fullName?: string;
  status?: string;
  duration?: number | null;
  failureMessages?: string[];
  location?: { line?: number; column?: number } | null;
}
interface RawFile {
  name?: string;
  assertionResults?: RawAssertion[];
}
interface RawReport {
  testResults?: RawFile[];
}

/** jest/vitest statuses -> ours. Anything not run counts as skipped. */
function toStatus(raw: string | undefined): TestStatus {
  switch (raw) {
    case "passed":
      return "passed";
    case "failed":
      return "failed";
    default:
      // "skipped" | "pending" | "todo" | "disabled" | undefined
      return "skipped";
  }
}

/**
 * Frameworks sometimes print a banner or progress before the JSON object. Pull out the JSON:
 * the first `{` to the last `}`. Parsing still validates it, so a stray brace fails cleanly.
 */
function extractJson(output: string): unknown {
  const trimmed = output.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end <= start)
      throw new TestParseError("no JSON object found in the test runner's output.");
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch (reason) {
      throw new TestParseError(`the test runner's JSON could not be parsed: ${String(reason)}`);
    }
  }
}

export function parseJestJson(output: string, totalDurationMs?: number): TestReport {
  const parsed = extractJson(output) as RawReport;
  if (!parsed || !Array.isArray(parsed.testResults))
    throw new TestParseError("the test runner's output has no `testResults`.");

  let passed = 0;
  let failed = 0;
  let skipped = 0;

  const files: TestFile[] = parsed.testResults.map((rawFile): TestFile => {
    const file = rawFile.name ?? "(unknown)";
    const cases: TestCase[] = (rawFile.assertionResults ?? []).map((a): TestCase => {
      const status = toStatus(a.status);
      if (status === "passed") passed++;
      else if (status === "failed") failed++;
      else skipped++;
      const ancestors = a.ancestorTitles ?? [];
      const title = a.title ?? "(unnamed test)";
      const fullName = a.fullName ?? [...ancestors, title].join(" ");
      return {
        id: caseId(file, fullName),
        kind: "case",
        label: title,
        ancestors,
        location: {
          file,
          line: a.location?.line ?? undefined,
          column: a.location?.column ?? undefined,
        },
        status,
        durationMs: a.duration ?? undefined,
        message: a.failureMessages?.length ? a.failureMessages.join("\n") : undefined,
      };
    });
    return {
      id: file,
      kind: "file",
      file,
      label: file.slice(Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")) + 1),
      cases,
      status: aggregateStatus(cases.map((c) => c.status)),
    };
  });

  return {
    files,
    summary: {
      passed,
      failed,
      skipped,
      total: passed + failed + skipped,
      durationMs: totalDurationMs,
    },
  };
}
