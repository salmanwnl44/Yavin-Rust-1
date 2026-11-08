import assert from "node:assert/strict";
import test from "node:test";
import { parseJestJson, TestParseError } from "./jestJson.ts";

// A realistic Jest/Vitest `--json` report: one file, nested suites, a pass, a failure with a
// stack, and a todo.
const REPORT = JSON.stringify({
  numTotalTests: 3,
  testResults: [
    {
      name: "/w/src/math.test.ts",
      status: "failed",
      assertionResults: [
        {
          ancestorTitles: ["math"],
          title: "adds",
          fullName: "math adds",
          status: "passed",
          duration: 2.1,
          location: { line: 3, column: 1 },
        },
        {
          ancestorTitles: ["math", "edge"],
          title: "handles zero",
          fullName: "math edge handles zero",
          status: "failed",
          duration: 1,
          failureMessages: ["Error: expected 1 to be 0\n    at /w/src/math.test.ts:9:20"],
          location: { line: 8, column: 3 },
        },
        {
          ancestorTitles: ["math"],
          title: "later",
          fullName: "math later",
          status: "todo",
          duration: null,
          location: { line: 12, column: 1 },
        },
      ],
    },
  ],
});

test("parses files, nested suites, statuses, durations, locations and messages", () => {
  const report = parseJestJson(REPORT, 42);
  assert.equal(report.files.length, 1);
  const file = report.files[0]!;
  assert.equal(file.file, "/w/src/math.test.ts");
  assert.equal(file.label, "math.test.ts", "label is the basename");
  assert.equal(file.status, "failed", "a file with a failing case is failed");
  assert.equal(file.cases.length, 3);

  const [adds, zero, later] = file.cases;
  assert.equal(adds!.status, "passed");
  assert.equal(adds!.durationMs, 2.1);
  assert.equal(adds!.location.line, 3);
  assert.deepEqual(adds!.ancestors, ["math"]);
  assert.equal(adds!.id, "/w/src/math.test.ts\u0000math adds", "stable id = file + full name");

  assert.equal(zero!.status, "failed");
  assert.equal(zero!.location.line, 8);
  assert.match(zero!.message ?? "", /expected 1 to be 0/);
  assert.deepEqual(zero!.ancestors, ["math", "edge"]);

  assert.equal(later!.status, "skipped", "todo counts as skipped");
  assert.equal(later!.durationMs, undefined);
});

test("summary counts passed/failed/skipped and carries the total duration", () => {
  const report = parseJestJson(REPORT, 42);
  assert.deepEqual(report.summary, { passed: 1, failed: 1, skipped: 1, total: 3, durationMs: 42 });
});

test("a file with only passing cases is passed", () => {
  const report = parseJestJson(
    JSON.stringify({
      testResults: [
        {
          name: "/w/a.test.ts",
          assertionResults: [{ title: "ok", fullName: "ok", status: "passed", ancestorTitles: [] }],
        },
      ],
    }),
  );
  assert.equal(report.files[0]!.status, "passed");
});

test("JSON preceded by a runner banner is still parsed", () => {
  const noisy = `stderr: deprecation warning\n\n RUN  v1.6.0\n\n${REPORT}\n`;
  const report = parseJestJson(noisy);
  assert.equal(report.files.length, 1);
  assert.equal(report.summary.total, 3);
});

test("malformed output throws a typed TestParseError, not a crash", () => {
  assert.throws(() => parseJestJson("not json at all"), TestParseError);
  assert.throws(() => parseJestJson(""), TestParseError);
});

test("output without testResults is a typed TestParseError", () => {
  assert.throws(() => parseJestJson('{"numTotalTests":0}'), TestParseError);
});
