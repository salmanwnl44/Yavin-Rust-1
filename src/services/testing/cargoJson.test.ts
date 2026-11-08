import assert from "node:assert/strict";
import test from "node:test";
import { parseCargoJson } from "./cargoJson.ts";

// A realistic interleaved Cargo run: compiler artifacts, a build-finished, then libtest events
// from the test binary (a pass, a fail with a panic location, an ignored test).
const RUN = [
  `{"reason":"compiler-artifact","target":{"name":"ide-workspace"},"fresh":true}`,
  `{"reason":"build-finished","success":true}`,
  `{ "type": "suite", "event": "started", "test_count": 3 }`,
  `{ "type": "test", "event": "started", "name": "math::tests::adds" }`,
  `{ "type": "test", "name": "math::tests::adds", "event": "ok", "exec_time": 0.002 }`,
  `{ "type": "test", "event": "started", "name": "math::tests::divides" }`,
  `{ "type": "test", "name": "math::tests::divides", "event": "failed", "stdout": "thread 'math::tests::divides' panicked at src/math.rs:42:9:\\nassertion failed: left == right" }`,
  `{ "type": "test", "name": "tests::slow", "event": "ignored" }`,
  `{ "type": "suite", "event": "failed", "passed": 1, "failed": 1, "ignored": 1 }`,
].join("\n");

test("parses libtest pass/fail/ignored into the shared model with counts", () => {
  const report = parseCargoJson(RUN, 120);
  assert.equal(report.compiled, true, "the build succeeded");
  assert.deepEqual(report.summary, {
    passed: 1,
    failed: 1,
    skipped: 1,
    total: 3,
    durationMs: 120,
  });
  // Grouped under their top module: `math` holds adds+divides, `tests` holds slow.
  const math = report.files.find((f) => f.file === "math")!;
  assert.equal(math.status, "failed");
  const adds = math.cases.find((c) => c.label === "adds")!;
  assert.equal(adds.status, "passed");
  assert.equal(adds.durationMs, 2, "exec_time seconds -> ms");
  assert.deepEqual(adds.ancestors, ["math", "tests"]);
  assert.equal(adds.id, "math\u0000math::tests::adds", "stable id = file + full path");
});

test("a failure recovers its source location from the panic line", () => {
  const report = parseCargoJson(RUN);
  const divides = report.files.flatMap((f) => f.cases).find((c) => c.label === "divides")!;
  assert.equal(divides.status, "failed");
  assert.equal(divides.location.file, "src/math.rs");
  assert.equal(divides.location.line, 42);
  assert.equal(divides.location.column, 9);
  assert.match(divides.message ?? "", /assertion failed/);
});

test("an ignored test is skipped, not failed", () => {
  const report = parseCargoJson(RUN);
  const slow = report.files.flatMap((f) => f.cases).find((c) => c.label === "slow")!;
  assert.equal(slow.status, "skipped");
});

test("a compilation failure is a diagnostic and compiled=false, never a failed test", () => {
  const run = [
    `{"reason":"compiler-message","message":{"level":"error","rendered":"error[E0425]: cannot find value \`x\`","message":"cannot find value","spans":[{"file_name":"src/lib.rs","line_start":10,"column_start":5,"is_primary":true}]}}`,
    `{"reason":"build-finished","success":false}`,
  ].join("\n");
  const report = parseCargoJson(run);
  assert.equal(report.compiled, false, "the build failed");
  assert.equal(report.summary.failed, 0, "a build break is NOT an assertion failure");
  assert.equal(report.summary.total, 0, "no tests ran");
  assert.equal(report.files.length, 0);
  assert.equal(report.diagnostics?.length, 1);
  assert.match(report.diagnostics![0]!.message, /cannot find value/);
  assert.equal(report.diagnostics![0]!.file, "src/lib.rs");
  assert.equal(report.diagnostics![0]!.line, 10);
});

test("compiler warnings are kept as diagnostics but do not fail the build", () => {
  const run = [
    `{"reason":"compiler-message","message":{"level":"warning","rendered":"warning: unused variable","spans":[{"file_name":"src/a.rs","line_start":3,"column_start":1,"is_primary":true}]}}`,
    `{"reason":"build-finished","success":true}`,
    `{ "type": "test", "name": "tests::ok", "event": "ok" }`,
  ].join("\n");
  const report = parseCargoJson(run);
  assert.equal(report.compiled, true);
  assert.equal(report.summary.passed, 1);
  assert.equal(report.diagnostics?.length, 1, "the warning is retained, separately");
});

test("interleaved compiler messages between test events do not corrupt parsing", () => {
  const run = [
    `{ "type": "test", "name": "tests::a", "event": "ok" }`,
    `{"reason":"compiler-message","message":{"level":"warning","rendered":"warning: later","spans":[]}}`,
    `{ "type": "test", "name": "tests::b", "event": "ok" }`,
    `{"reason":"build-finished","success":true}`,
  ].join("\n");
  const report = parseCargoJson(run);
  assert.equal(report.summary.passed, 2);
  assert.equal(report.diagnostics?.length, 1);
});

test("non-JSON noise, blank lines, and a truncated final line are tolerated", () => {
  const run = [
    `   Compiling ide-workspace v0.1.0`,
    ``,
    `warning: the -Z flag is only accepted on the nightly channel`,
    `{ "type": "test", "name": "tests::ok", "event": "ok" }`,
    `{ "type": "test", "name": "tests::half`, // truncated JSON
  ].join("\n");
  const report = parseCargoJson(run);
  assert.equal(report.summary.passed, 1, "the one complete event parsed; the rest was skipped");
});

test("empty output with no build failure is an empty report, not an error", () => {
  const report = parseCargoJson("");
  assert.equal(report.summary.total, 0);
  assert.equal(report.files.length, 0);
  assert.equal(report.compiled, undefined, "no build-finished seen -> unknown, not failed");
  assert.equal(report.diagnostics, undefined);
});

test("a test with no module path still groups and ids stably", () => {
  const report = parseCargoJson(`{ "type": "test", "name": "it_works", "event": "ok" }`);
  const c = report.files[0]!.cases[0]!;
  assert.equal(c.label, "it_works");
  assert.deepEqual(c.ancestors, []);
  assert.equal(c.id, "it_works\u0000it_works");
});
