/**
 * Parser for Cargo's JSON test output (WS5.2). Unlike Jest/Vitest, Cargo emits **two interleaved
 * JSON protocols**, one object per line:
 *
 * 1. Cargo build messages (`cargo test --message-format json`): `{ "reason": "compiler-message",
 *    "message": { ... rustc diagnostic ... } }`, `{ "reason": "compiler-artifact", ... }`,
 *    `{ "reason": "build-finished", "success": bool }`. These are **compilation** facts.
 * 2. libtest events (the test binary, `-- -Z unstable-options --format json`): `{ "type": "suite"
 *    | "test", "event": "started" | "ok" | "failed" | "ignored", "name": "module::test", ... }`.
 *    These are **test-case** facts.
 *
 * The two are kept strictly apart: a compilation error is a {@link TestReport.diagnostics} entry
 * and sets `compiled = false`, never a failed test case, so a build break is never mistaken for an
 * assertion failure. A test's source location is not in its event; it is recovered from the panic
 * line in the failure output (`thread '...' panicked at src/lib.rs:12:5`).
 *
 * The parser is tolerant: non-JSON lines (a stray `-Z` warning, a human summary) and blank lines
 * are skipped, so interleaving and noise do not break it. Truncated output simply yields the
 * events that did parse. Entirely empty or test-event-free output with no build failure is an
 * empty report, not an error.
 */
import { aggregateStatus, caseId } from "./model.ts";
import type { TestCase, TestDiagnostic, TestFile, TestReport, TestStatus } from "./model.ts";

/** libtest reports a test by its module path, e.g. `math::tests::adds` or `tests::it_works`. */
interface LibtestEvent {
  type?: string;
  event?: string;
  name?: string;
  exec_time?: number;
  stdout?: string;
}

interface CargoMessage {
  reason?: string;
  success?: boolean;
  message?: {
    level?: string;
    rendered?: string;
    message?: string;
    spans?: Array<{
      file_name?: string;
      line_start?: number;
      column_start?: number;
      is_primary?: boolean;
    }>;
  };
}

/** Pull `file:line:col` out of a libtest panic line, when present. */
function locationFromOutput(output: string | undefined): {
  file?: string;
  line?: number;
  column?: number;
} {
  if (!output) return {};
  // `thread 'tests::foo' panicked at src/lib.rs:12:5:` (Rust 1.73+) or `... panicked at 'msg',
  // src/lib.rs:12:5` (older). Match the first `path:line:col` that looks like a source location.
  const match = output.match(/([A-Za-z0-9_./\\-]+\.rs):(\d+):(\d+)/);
  if (!match) return {};
  return { file: match[1], line: Number(match[2]), column: Number(match[3]) };
}

/** libtest `event` -> our status. `ok` passes, `failed` fails, `ignored` is skipped. */
function statusOf(event: string | undefined): TestStatus | null {
  switch (event) {
    case "ok":
      return "passed";
    case "failed":
      return "failed";
    case "ignored":
      return "skipped";
    default:
      // "started", "timeout", suite-level events: not a terminal per-case result.
      return null;
  }
}

/**
 * Split a Cargo test's full path into a module ancestry and a leaf label, and choose the "file"
 * the Test Explorer groups it under: the top-level module (the crate's test root), which is the
 * closest stable analogue Cargo offers to a test file.
 */
function partsOf(name: string): { file: string; ancestors: string[]; label: string } {
  const segments = name.split("::").filter((s) => s.length > 0);
  if (segments.length === 0) return { file: "(tests)", ancestors: [], label: name };
  const label = segments[segments.length - 1]!;
  const ancestors = segments.slice(0, -1);
  const file = ancestors[0] ?? label;
  return { file, ancestors, label };
}

export function parseCargoJson(output: string, totalDurationMs?: number): TestReport {
  const diagnostics: TestDiagnostic[] = [];
  let buildFailed = false;
  let sawBuildFinished = false;

  // Collect cases grouped by their "file" (top module), preserving first-seen order.
  const byFile = new Map<string, TestCase[]>();
  const order: string[] = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] !== "{") continue; // human lines, blanks, `-Z` warnings
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // a truncated final line, say
    }
    if (!parsed || typeof parsed !== "object") continue;

    // --- Cargo build protocol ---------------------------------------------------------------
    const msg = parsed as CargoMessage;
    if (typeof msg.reason === "string") {
      if (msg.reason === "build-finished") {
        sawBuildFinished = true;
        if (msg.success === false) buildFailed = true;
      } else if (msg.reason === "compiler-message" && msg.message) {
        const level = msg.message.level;
        if (level === "error" || level === "warning") {
          const primary = msg.message.spans?.find((s) => s.is_primary) ?? msg.message.spans?.[0];
          diagnostics.push({
            message: msg.message.rendered ?? msg.message.message ?? "(compiler message)",
            file: primary?.file_name,
            line: primary?.line_start,
            column: primary?.column_start,
          });
          if (level === "error") buildFailed = true;
        }
      }
      continue; // a cargo message is never a test case
    }

    // --- libtest protocol -------------------------------------------------------------------
    const ev = parsed as LibtestEvent;
    if (ev.type !== "test") continue; // suite summaries, bench events: ignored
    const status = statusOf(ev.event);
    if (status === null) continue; // "started" and the like
    const name = ev.name ?? "(unnamed test)";
    const { file, ancestors, label } = partsOf(name);
    const location = locationFromOutput(ev.stdout);
    if (status === "passed") passed++;
    else if (status === "failed") failed++;
    else skipped++;
    const testCase: TestCase = {
      id: caseId(file, name),
      kind: "case",
      label,
      ancestors,
      location: { file: location.file ?? file, line: location.line, column: location.column },
      status,
      durationMs: typeof ev.exec_time === "number" ? ev.exec_time * 1000 : undefined,
      message: status === "failed" ? (ev.stdout ?? "test failed").trim() : undefined,
    };
    if (!byFile.has(file)) {
      byFile.set(file, []);
      order.push(file);
    }
    byFile.get(file)!.push(testCase);
  }

  const files: TestFile[] = order.map((file) => {
    const cases = byFile.get(file)!;
    return {
      id: file,
      kind: "file",
      file,
      label: file,
      cases,
      status: aggregateStatus(cases.map((c) => c.status)),
    };
  });

  // `compiled` is only meaningful once we have seen a build-finished message (or a hard error).
  const compiled = buildFailed ? false : sawBuildFinished ? true : undefined;

  return {
    files,
    summary: {
      passed,
      failed,
      skipped,
      total: passed + failed + skipped,
      durationMs: totalDurationMs,
    },
    diagnostics: diagnostics.length ? diagnostics : undefined,
    compiled,
  };
}
