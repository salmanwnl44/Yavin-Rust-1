import assert from "node:assert/strict";
import test from "node:test";
import { parsePlaywrightJson } from "./playwrightJson.ts";
import { TestParseError } from "./jestJson.ts";

// A realistic report: one file, a nested describe, two projects (chromium/firefox), a pass, a
// failure with a stack, a flaky (passed on retry), and a skip.
const REPORT = JSON.stringify({
  stats: { duration: 1234, expected: 2, unexpected: 1, flaky: 1, skipped: 1 },
  suites: [
    {
      title: "example.spec.ts",
      file: "e2e/example.spec.ts",
      specs: [
        {
          title: "loads",
          id: "spec-loads",
          file: "e2e/example.spec.ts",
          line: 3,
          column: 1,
          tests: [
            {
              projectName: "chromium",
              status: "expected",
              results: [{ status: "passed", duration: 50, retry: 0 }],
            },
            {
              projectName: "firefox",
              status: "expected",
              results: [{ status: "passed", duration: 60, retry: 0 }],
            },
          ],
        },
      ],
      suites: [
        {
          title: "forms",
          file: "e2e/example.spec.ts",
          specs: [
            {
              title: "submits",
              id: "spec-submits",
              file: "e2e/example.spec.ts",
              line: 10,
              column: 3,
              tests: [
                {
                  projectName: "chromium",
                  status: "unexpected",
                  results: [
                    {
                      status: "failed",
                      duration: 20,
                      retry: 0,
                      error: {
                        message: "boom",
                        stack: "Error: boom\n at e2e/example.spec.ts:11:5",
                      },
                    },
                  ],
                },
              ],
            },
            {
              title: "retries",
              id: "spec-retries",
              file: "e2e/example.spec.ts",
              line: 20,
              column: 3,
              tests: [
                {
                  projectName: "chromium",
                  status: "flaky",
                  results: [
                    { status: "failed", duration: 15, retry: 0 },
                    { status: "passed", duration: 18, retry: 1 },
                  ],
                },
              ],
            },
            {
              title: "later",
              id: "spec-later",
              file: "e2e/example.spec.ts",
              line: 30,
              column: 3,
              tests: [{ projectName: "chromium", status: "skipped", results: [] }],
            },
          ],
        },
      ],
    },
  ],
  errors: [],
});

test("parses suites, projects, statuses, durations, and locations", () => {
  const report = parsePlaywrightJson(REPORT, 1234);
  assert.equal(report.compiled, undefined, "no setup error");
  assert.equal(report.files.length, 1);
  const file = report.files[0]!;
  assert.equal(file.file, "e2e/example.spec.ts");
  assert.equal(file.label, "example.spec.ts");
  // loads×2 (chromium/firefox) + submits + retries + later = 5 cases.
  assert.equal(file.cases.length, 5);
  assert.deepEqual(report.summary, {
    passed: 3, // loads chromium + loads firefox + retries (flaky counts passed)
    failed: 1, // submits chromium
    skipped: 1, // later
    total: 5,
    durationMs: 1234,
  });
});

test("multi-project specs become distinct, stably-identified cases carrying the project", () => {
  const report = parsePlaywrightJson(REPORT);
  const loads = report.files[0]!.cases.filter((c) => c.label.startsWith("loads"));
  assert.equal(loads.length, 2);
  const chromium = loads.find((c) => c.project === "chromium")!;
  const firefox = loads.find((c) => c.project === "firefox")!;
  assert.notEqual(chromium.id, firefox.id, "two projects -> two ids");
  // `loads` is a top-level spec of the file, so it has no describe ancestor.
  assert.equal(chromium.id, "e2e/example.spec.ts\u0000loads [chromium]");
  assert.equal(firefox.id, "e2e/example.spec.ts\u0000loads [firefox]");
  assert.deepEqual(chromium.ancestors, []);
});

test("case ids are stable across runs and include the suite path and project", () => {
  const a = parsePlaywrightJson(REPORT);
  const b = parsePlaywrightJson(REPORT);
  const submitsA = a.files[0]!.cases.find((c) => c.label.startsWith("submits"))!;
  const submitsB = b.files[0]!.cases.find((c) => c.label.startsWith("submits"))!;
  assert.equal(submitsA.id, submitsB.id, "same id across runs");
  assert.equal(submitsA.id, "e2e/example.spec.ts\u0000forms submits [chromium]");
  assert.deepEqual(
    submitsA.ancestors,
    ["forms"],
    "nested describe is an ancestor; the file is not",
  );
});

test("a failure carries its message/stack and location", () => {
  const report = parsePlaywrightJson(REPORT);
  const submits = report.files[0]!.cases.find((c) => c.label.startsWith("submits"))!;
  assert.equal(submits.status, "failed");
  assert.match(submits.message ?? "", /boom/);
  assert.equal(submits.location.line, 10);
});

test("a flaky test is passed, flagged flaky, with the final attempt's duration", () => {
  const report = parsePlaywrightJson(REPORT);
  const retries = report.files[0]!.cases.find((c) => c.label.startsWith("retries"))!;
  assert.equal(retries.status, "passed");
  assert.equal(retries.flaky, true);
  assert.equal(retries.durationMs, 18, "the last retry's duration");
});

test("a skipped test is skipped", () => {
  const report = parsePlaywrightJson(REPORT);
  const later = report.files[0]!.cases.find((c) => c.label.startsWith("later"))!;
  assert.equal(later.status, "skipped");
});

test("a config/discovery error with no tests is compiled=false, not an empty suite", () => {
  const run = JSON.stringify({
    suites: [],
    errors: [
      {
        message: "No tests found. Make sure that arguments are test files.",
        location: { file: "playwright.config.ts", line: 1 },
      },
    ],
  });
  const report = parsePlaywrightJson(run);
  assert.equal(report.compiled, false);
  assert.equal(report.summary.total, 0);
  assert.equal(report.diagnostics?.length, 1);
  assert.match(report.diagnostics![0]!.message, /No tests found/);
});

test("errors alongside real results are kept as diagnostics without hiding the tests", () => {
  const run = JSON.stringify({
    suites: [
      {
        title: "a.spec.ts",
        file: "a.spec.ts",
        specs: [
          {
            title: "ok",
            id: "x",
            file: "a.spec.ts",
            line: 1,
            tests: [
              {
                projectName: "chromium",
                status: "expected",
                results: [{ status: "passed", duration: 1 }],
              },
            ],
          },
        ],
      },
    ],
    errors: [{ message: "a worker warning" }],
  });
  const report = parsePlaywrightJson(run);
  assert.equal(report.summary.passed, 1);
  assert.equal(report.compiled, undefined, "tests ran, so not a setup failure");
  assert.equal(report.diagnostics?.length, 1);
});

test("banner noise before the JSON is tolerated; malformed and empty throw TestParseError", () => {
  const noisy = `[dotenv] injecting env\n${REPORT}`;
  assert.equal(parsePlaywrightJson(noisy).files.length, 1);
  assert.throws(() => parsePlaywrightJson("not json"), TestParseError);
  assert.throws(() => parsePlaywrightJson(""), TestParseError);
  assert.throws(() => parsePlaywrightJson('{"stats":{}}'), TestParseError); // no suites
});
