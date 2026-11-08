import assert from "node:assert/strict";
import test from "node:test";
import { createTestRunner, TestRunTimeoutError } from "./runService.ts";
import type { TestRunNative, TestRunAnswer } from "./runService.ts";
import { createTestController } from "./controller.ts";
import type { TestCommand } from "./adapters.ts";

/** A native seam that returns a fixed answer and records what it was asked to run and cancel. */
function fakeNative(answer: TestRunAnswer | unknown): {
  native: TestRunNative;
  commands: TestCommand[];
  cancels: number;
} {
  const commands: TestCommand[] = [];
  let cancels = 0;
  const native: TestRunNative = {
    run: async (command) => {
      commands.push(command);
      return answer;
    },
    cancel: async () => {
      cancels++;
    },
  };
  return {
    native,
    commands,
    get cancels() {
      return cancels;
    },
  };
}

const PASS: TestRunAnswer = {
  outcome: "completed",
  output: '{"testResults":[]}',
  code: 0,
  root: "/w",
};
const CMD: TestCommand = { program: "vitest", args: ["run", "--reporter=json"] };

test("a completed run returns its output and exit code and forwards the exact argv", async () => {
  const { native, commands } = fakeNative(PASS);
  const run = createTestRunner(native);
  const result = await run(CMD, new AbortController().signal);
  assert.deepEqual(result, { output: PASS.output, code: 0 });
  assert.deepEqual(commands[0], CMD, "the program + args cross the seam structurally, unjoined");
});

test("a cancelled outcome surfaces as an AbortError", async () => {
  const { native } = fakeNative({ ...PASS, outcome: "cancelled" });
  const run = createTestRunner(native);
  await assert.rejects(
    run(CMD, new AbortController().signal),
    (e: Error) => e.name === "AbortError",
  );
});

test("a timed-out outcome surfaces as TestRunTimeoutError", async () => {
  const { native } = fakeNative({ ...PASS, outcome: "timedOut" });
  const run = createTestRunner(native);
  await assert.rejects(run(CMD, new AbortController().signal), TestRunTimeoutError);
});

test("an unreadable answer is a clear error, not a crash", async () => {
  const { native } = fakeNative({ nonsense: true });
  const run = createTestRunner(native);
  await assert.rejects(run(CMD, new AbortController().signal), /cannot read/);
});

test("an already-aborted signal refuses to run anything", async () => {
  const { native, commands } = fakeNative(PASS);
  const run = createTestRunner(native);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(run(CMD, ac.signal), (e: Error) => e.name === "AbortError");
  assert.equal(commands.length, 0, "the native runner is never invoked for an aborted signal");
});

test("aborting mid-run asks the native side to cancel the real process", async () => {
  let resolveRun!: (a: TestRunAnswer) => void;
  let cancels = 0;
  const native: TestRunNative = {
    run: () => new Promise<TestRunAnswer>((resolve) => (resolveRun = resolve)),
    cancel: async () => void cancels++,
  };
  const run = createTestRunner(native);
  const ac = new AbortController();
  const pending = run(CMD, ac.signal);
  ac.abort(); // the controller's cancel() reaches the process
  assert.equal(cancels, 1, "the native cancel is called when the signal aborts");
  resolveRun({ ...PASS, outcome: "cancelled" });
  await assert.rejects(pending, (e: Error) => e.name === "AbortError");
});

test("end to end: the controller runs through the runService seam and parses the report", async () => {
  // The whole WS5 execution path with no real process: adapter argv -> runService -> native ->
  // RunAnswer -> adapter.parse -> controller state.
  const answer: TestRunAnswer = {
    outcome: "completed",
    output: JSON.stringify({
      testResults: [
        {
          name: "/w/a.test.ts",
          assertionResults: [
            { title: "ok", fullName: "ok", status: "passed", ancestorTitles: [] },
            { title: "bad", fullName: "bad", status: "failed", ancestorTitles: [] },
          ],
        },
      ],
    }),
    code: 1,
    root: "/w",
  };
  const { native, commands } = fakeNative(answer);
  const controller = createTestController({
    markerNames: ["vitest.config.ts"],
    run: createTestRunner(native),
  });
  await controller.runAll();
  const state = controller.getState();
  assert.equal(state.phase, "failed", "a failing suite ends in failed");
  assert.equal(state.report?.summary.passed, 1);
  assert.equal(state.report?.summary.failed, 1);
  assert.deepEqual(commands[0], { program: "vitest", args: ["run", "--reporter=json"] });
});
