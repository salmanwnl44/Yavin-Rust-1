import assert from "node:assert/strict";
import test from "node:test";
import { parsePytestJson } from "./pytestJson.ts";
import { TestParseError } from "./jestJson.ts";

// A realistic pytest-json-report: a module function, a class method, a parameterized test, a
// failure with a traceback, a skip, an xfail, and an xpass.
const REPORT = JSON.stringify({
  duration: 0.5,
  summary: { passed: 3, failed: 1, skipped: 2, total: 6 },
  collectors: [{ nodeid: "", outcome: "passed", result: [] }],
  tests: [
    {
      nodeid: "tests/test_math.py::test_adds",
      lineno: 2,
      outcome: "passed",
      call: { duration: 0.001, outcome: "passed" },
    },
    {
      nodeid: "tests/test_math.py::TestDivide::test_by_zero",
      lineno: 9,
      outcome: "failed",
      call: {
        duration: 0.002,
        outcome: "failed",
        crash: {
          path: "tests/test_math.py",
          lineno: 11,
          message: "ZeroDivisionError: division by zero",
        },
        longrepr: "def test_by_zero():\n>   1/0\nE   ZeroDivisionError: division by zero",
      },
    },
    {
      nodeid: "tests/test_math.py::test_param[2-3]",
      lineno: 15,
      outcome: "passed",
      call: { duration: 0.001, outcome: "passed" },
    },
    {
      nodeid: "tests/test_math.py::test_param[0-0]",
      lineno: 15,
      outcome: "passed",
      call: { duration: 0.001, outcome: "passed" },
    },
    {
      nodeid: "tests/test_math.py::test_slow",
      lineno: 20,
      outcome: "skipped",
      setup: { duration: 0, outcome: "skipped" },
    },
    {
      nodeid: "tests/test_math.py::test_known_bug",
      lineno: 25,
      outcome: "xfailed",
      call: { duration: 0.001, outcome: "skipped" },
    },
  ],
});

test("parses module/class hierarchy, statuses, durations, and counts", () => {
  const report = parsePytestJson(REPORT, 500);
  assert.equal(report.compiled, undefined);
  assert.equal(report.files.length, 1);
  const file = report.files[0]!;
  assert.equal(file.file, "tests/test_math.py");
  assert.equal(file.label, "test_math.py");
  assert.equal(file.cases.length, 6);
  assert.deepEqual(report.summary, { passed: 3, failed: 1, skipped: 2, total: 6, durationMs: 500 });

  const adds = file.cases.find((c) => c.label === "test_adds")!;
  assert.deepEqual(adds.ancestors, [], "a module-level function has no class ancestor");
  assert.equal(adds.id, "tests/test_math.py\u0000test_adds", "id = file + node-id tail");
  assert.equal(adds.durationMs, 1, "seconds -> ms");

  const method = file.cases.find((c) => c.label === "test_by_zero")!;
  assert.deepEqual(method.ancestors, ["TestDivide"], "the class is an ancestor");
  assert.equal(method.id, "tests/test_math.py\u0000TestDivide::test_by_zero");
});

test("a failure carries its traceback and the crash location", () => {
  const report = parsePytestJson(REPORT);
  const fail = report.files[0]!.cases.find((c) => c.label === "test_by_zero")!;
  assert.equal(fail.status, "failed");
  assert.match(fail.message ?? "", /ZeroDivisionError/);
  assert.equal(fail.location.line, 11, "the crash line, not the definition line");
});

test("parameterized tests are distinct cases keyed by their [param] identity", () => {
  const report = parsePytestJson(REPORT);
  const params = report.files[0]!.cases.filter((c) => c.label.startsWith("test_param"));
  assert.equal(params.length, 2);
  assert.equal(params[0]!.label, "test_param[2-3]");
  assert.equal(params[1]!.label, "test_param[0-0]");
  assert.notEqual(params[0]!.id, params[1]!.id, "each parameterization is its own stable id");
});

test("xfailed counts as skipped, xpassed as passed, skipped as skipped", () => {
  const report = parsePytestJson(REPORT);
  const xfail = report.files[0]!.cases.find((c) => c.label === "test_known_bug")!;
  assert.equal(xfail.status, "skipped", "xfailed (expected failure) is not a failure");
  const skip = report.files[0]!.cases.find((c) => c.label === "test_slow")!;
  assert.equal(skip.status, "skipped");

  const xp = parsePytestJson(
    JSON.stringify({
      tests: [{ nodeid: "a.py::t", outcome: "xpassed", call: { outcome: "passed", duration: 0 } }],
    }),
  );
  assert.equal(xp.files[0]!.cases[0]!.status, "passed", "xpassed counts as passed");
});

test("ids are stable across runs", () => {
  const a = parsePytestJson(REPORT);
  const b = parsePytestJson(REPORT);
  assert.equal(a.files[0]!.cases[1]!.id, b.files[0]!.cases[1]!.id);
});

test("a collection/import error is a diagnostic and compiled=false, not a failed test", () => {
  const run = JSON.stringify({
    tests: [],
    collectors: [
      {
        nodeid: "tests/test_bad.py",
        outcome: "failed",
        longrepr: "ImportError: No module named 'nonexistent'",
      },
    ],
  });
  const report = parsePytestJson(run);
  assert.equal(report.compiled, false);
  assert.equal(report.summary.total, 0);
  assert.equal(report.summary.failed, 0, "an import error is not an assertion failure");
  assert.equal(report.diagnostics?.length, 1);
  assert.match(report.diagnostics![0]!.message, /ImportError/);
  assert.equal(report.diagnostics![0]!.file, "tests/test_bad.py");
});

test("a collection error alongside real tests stays a diagnostic without hiding them", () => {
  const run = JSON.stringify({
    tests: [{ nodeid: "a.py::t", outcome: "passed", call: { outcome: "passed", duration: 0 } }],
    collectors: [{ nodeid: "b.py", outcome: "failed", longrepr: "SyntaxError" }],
  });
  const report = parsePytestJson(run);
  assert.equal(report.summary.passed, 1);
  assert.equal(report.compiled, undefined, "something ran, so not a setup failure");
  assert.equal(report.diagnostics?.length, 1);
});

test("banner noise is tolerated; malformed, empty and plugin-less output throw TestParseError", () => {
  assert.equal(parsePytestJson(`some warning\n${REPORT}`).files.length, 1);
  assert.throws(() => parsePytestJson("not json"), TestParseError);
  assert.throws(() => parsePytestJson(""), TestParseError);
  // No `tests` key: the common shape when the json-report plugin is not installed.
  assert.throws(() => parsePytestJson('{"exitcode":4}'), TestParseError);
});
