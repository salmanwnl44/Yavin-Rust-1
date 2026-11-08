import assert from "node:assert/strict";
import test from "node:test";
import { createTestController } from "./controller.ts";
import type { TestRunner } from "./controller.ts";

/** A JSON report with the given per-case statuses in one file. */
function reportJson(
  file: string,
  cases: ReadonlyArray<{ name: string; status: string; ancestors?: string[] }>,
): string {
  return JSON.stringify({
    testResults: [
      {
        name: file,
        assertionResults: cases.map((c) => ({
          ancestorTitles: c.ancestors ?? [],
          title: c.name,
          fullName: [...(c.ancestors ?? []), c.name].join(" "),
          status: c.status,
        })),
      },
    ],
  });
}

/** A runner that returns a fixed output immediately, recording the commands it was asked to run. */
function fixedRunner(
  output: string,
  code = 0,
): { run: TestRunner; calls: { program: string; args: readonly string[] }[] } {
  const calls: { program: string; args: readonly string[] }[] = [];
  const run: TestRunner = async (command) => {
    calls.push({ program: command.program, args: command.args });
    return { output, code };
  };
  return { run, calls };
}

const VITEST = ["vitest.config.ts"];

test("with no detectable framework, a run fails with a clear message and never calls the runner", async () => {
  const { run, calls } = fixedRunner("");
  const controller = createTestController({ markerNames: ["package.json"], run });
  await controller.runAll();
  const state = controller.getState();
  assert.equal(state.adapter, null);
  assert.equal(state.phase, "failed");
  assert.match(state.error ?? "", /No test framework/);
  assert.equal(calls.length, 0, "the runner is never invoked without an adapter");
});

test("runAll on a passing report ends in phase done with the parsed report", async () => {
  const { run, calls } = fixedRunner(
    reportJson("/w/a.test.ts", [{ name: "ok", status: "passed" }]),
  );
  const controller = createTestController({ markerNames: VITEST, run });
  await controller.runAll();
  const state = controller.getState();
  assert.equal(state.adapter, "vitest");
  assert.equal(state.phase, "done");
  assert.equal(state.report?.summary.passed, 1);
  assert.deepEqual(calls[0]!.args, ["run", "--reporter=json"]);
});

test("a failing report ends in phase failed but still keeps the report", async () => {
  const { run } = fixedRunner(
    reportJson("/w/a.test.ts", [
      { name: "ok", status: "passed" },
      { name: "bad", status: "failed" },
    ]),
  );
  const controller = createTestController({ markerNames: VITEST, run });
  await controller.runAll();
  const state = controller.getState();
  assert.equal(state.phase, "failed");
  assert.equal(state.error, null, "a failing test suite is not a controller error");
  assert.equal(state.report?.summary.failed, 1);
});

test("unparseable runner output ends in phase failed with the error, not a crash", async () => {
  const { run } = fixedRunner("segfault: the runner died");
  const controller = createTestController({ markerNames: VITEST, run });
  await controller.runAll();
  const state = controller.getState();
  assert.equal(state.phase, "failed");
  assert.match(state.error ?? "", /TestParseError|JSON/);
});

test("runFile and runCase pass the right selector through to the adapter argv", async () => {
  const { run, calls } = fixedRunner(
    reportJson("/w/a.test.ts", [{ name: "ok", status: "passed" }]),
  );
  const controller = createTestController({ markerNames: VITEST, run });
  await controller.runFile("/w/a.test.ts");
  await controller.runCase("/w/a.test.ts", "math adds");
  assert.deepEqual(calls[0]!.args, ["run", "--reporter=json", "/w/a.test.ts"]);
  assert.deepEqual(calls[1]!.args, ["run", "--reporter=json", "-t", "math adds", "/w/a.test.ts"]);
});

test("cancel aborts the in-flight run and the state becomes cancelled", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const run: TestRunner = async (_command, signal) => {
    await gate;
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    return { output: "{}", code: 0 };
  };
  const controller = createTestController({ markerNames: VITEST, run });
  const done = controller.runAll();
  assert.equal(controller.getState().phase, "running");
  controller.cancel();
  release();
  await done;
  assert.equal(controller.getState().phase, "cancelled");
});

test("a superseded slow run never overwrites the newer run that replaced it", async () => {
  // Two runs: the first is slow, the second is fast. The first must not clobber the second's
  // result when it finally resolves — the generation guard drops it.
  const gates: Array<() => void> = [];
  const outputs = [
    reportJson("/w/a.test.ts", [{ name: "slow", status: "failed" }]),
    reportJson("/w/a.test.ts", [{ name: "fast", status: "passed" }]),
  ];
  let call = 0;
  const run: TestRunner = (_command) => {
    const i = call++;
    return new Promise((resolve) => {
      gates[i] = () => resolve({ output: outputs[i]!, code: 0 });
    });
  };
  const controller = createTestController({ markerNames: VITEST, run });
  const first = controller.runAll(); // generation 1 (slow, would fail)
  const second = controller.runAll(); // generation 2 (fast, passes) — supersedes the first
  gates[1]!(); // the second run resolves first
  await second;
  assert.equal(controller.getState().phase, "done", "the newer run wins");
  gates[0]!(); // the stale first run resolves late
  await first;
  const state = controller.getState();
  assert.equal(state.phase, "done", "the stale run did not overwrite the newer result");
  assert.equal(state.report?.summary.passed, 1);
  assert.equal(state.report?.summary.failed, 0);
});

test("reset abandons any run, clears the report and returns to idle", async () => {
  const { run } = fixedRunner(reportJson("/w/a.test.ts", [{ name: "ok", status: "passed" }]));
  const controller = createTestController({ markerNames: VITEST, run });
  await controller.runAll();
  assert.equal(controller.getState().phase, "done");
  controller.reset();
  const state = controller.getState();
  assert.equal(state.phase, "idle");
  assert.equal(state.report, null);
  assert.equal(state.error, null);
});

test("rerunFailed targets a single failed case, a single failed file, or all", async () => {
  // One failed case in one file -> rerun that case.
  const oneCase = fixedRunner(
    reportJson("/w/a.test.ts", [
      { name: "ok", status: "passed" },
      { name: "bad", status: "failed", ancestors: ["suite"] },
    ]),
  );
  const c1 = createTestController({ markerNames: VITEST, run: oneCase.run });
  await c1.runAll();
  await c1.rerunFailed();
  assert.deepEqual(
    oneCase.calls.at(-1)!.args,
    ["run", "--reporter=json", "-t", "suite bad", "/w/a.test.ts"],
    "a lone failure reruns by case full name",
  );

  // No failures -> rerunFailed is a no-op (does not invoke the runner again).
  const allPass = fixedRunner(reportJson("/w/a.test.ts", [{ name: "ok", status: "passed" }]));
  const c2 = createTestController({ markerNames: VITEST, run: allPass.run });
  await c2.runAll();
  const before = allPass.calls.length;
  await c2.rerunFailed();
  assert.equal(allPass.calls.length, before, "nothing failed, so nothing reruns");
});

test("a Cargo compile failure (compiled=false, zero failed) is a failed run, not done", async () => {
  // Build-finished success=false with no test events: the project did not compile.
  const cargoBuildFail = [
    `{"reason":"compiler-message","message":{"level":"error","rendered":"error[E0425]","spans":[]}}`,
    `{"reason":"build-finished","success":false}`,
  ].join("\n");
  const { run } = fixedRunner(cargoBuildFail);
  const controller = createTestController({ markerNames: ["Cargo.toml"], run });
  await controller.runAll();
  const state = controller.getState();
  assert.equal(state.adapter, "cargo");
  assert.equal(state.phase, "failed", "a build break is a failed run");
  assert.equal(state.report?.summary.failed, 0, "but not counted as a test failure");
  assert.equal(state.report?.compiled, false);
  assert.equal(state.report?.diagnostics?.length, 1);
});

test("subscribers are notified on every state transition", async () => {
  const { run } = fixedRunner(reportJson("/w/a.test.ts", [{ name: "ok", status: "passed" }]));
  const controller = createTestController({ markerNames: VITEST, run });
  let notifications = 0;
  const unsubscribe = controller.subscribe(() => notifications++);
  await controller.runAll(); // running + done = 2
  assert.ok(notifications >= 2, "running and completion both notify");
  unsubscribe();
  const after = notifications;
  await controller.runAll();
  assert.equal(notifications, after, "no notifications after unsubscribe");
});
