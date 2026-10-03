import assert from "node:assert/strict";
import test from "node:test";
import { createCheckerService, describeCheckerStatus } from "./checkers.ts";
import {
  allProblems,
  clearProblems,
  groupByFile,
  publishProblems,
  resetProblems,
} from "./problems.ts";

const ROOT = "C:\\project";
const TSC_OUTPUT = [
  "src/app.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
  "src/bad file.ts(1,1): error TS1005: ';' expected.",
  "../shared/x.ts(2,2): error TS2304: Cannot find name 'y'.",
].join("\n");

/** The native side, answering each run when the test says. */
function fakeNative(available = [{ id: "tsc", label: "TypeScript" }]) {
  const runs: ((answer: unknown) => void)[] = [];
  const failures: ((reason: unknown) => void)[] = [];
  let cancels = 0;
  return {
    native: {
      available: async () => available,
      run: () =>
        new Promise<unknown>((resolve, reject) => {
          runs.push(resolve);
          failures.push(reject);
        }),
      cancel: async () => {
        cancels += 1;
      },
    },
    answer(index: number, value: unknown) {
      runs[index](value);
    },
    fail(index: number, reason: unknown) {
      failures[index](reason);
    },
    get cancels() {
      return cancels;
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const completed = (output: string, code = 2) => ({
  outcome: "completed",
  output,
  code,
  root: ROOT,
});

test("a run publishes its diagnostics with canonical paths, under its owner", async () => {
  resetProblems();
  const fake = fakeNative();
  const service = createCheckerService(fake.native, publishProblems);
  await service.refresh(true);
  assert.deepEqual(service.getSnapshot().available, [{ id: "tsc", label: "TypeScript" }]);
  const run = service.run("tsc");
  assert.equal(service.getSnapshot().status.kind, "running");
  fake.answer(0, completed(TSC_OUTPUT));
  await run;
  const files = groupByFile(allProblems()).map((file) => file.file);
  assert.deepEqual(files, ["C:/project/src/app.ts", "C:/project/src/bad file.ts"]);
  assert.deepEqual(service.getSnapshot().status, {
    kind: "done",
    label: "TypeScript",
    found: 2,
    outside: 1,
  });
  assert.match(describeCheckerStatus(service.getSnapshot().status), /1 result outside/);
  assert.equal(allProblems()[0].owner, "tsc");
});

test("Stop and a timeout are outcomes, said plainly, not failures", async () => {
  resetProblems();
  const fake = fakeNative();
  const service = createCheckerService(fake.native, publishProblems);
  await service.refresh(true);
  const first = service.run("tsc");
  service.stop();
  assert.equal(fake.cancels, 1);
  fake.answer(0, { outcome: "cancelled", output: "", code: -1, root: ROOT });
  await first;
  assert.deepEqual(service.getSnapshot().status, { kind: "cancelled", label: "TypeScript" });
  assert.equal(describeCheckerStatus(service.getSnapshot().status), "TypeScript was stopped.");
  const second = service.run("tsc");
  fake.answer(1, { outcome: "timedOut", output: "", code: -1, root: ROOT });
  await second;
  assert.equal(
    describeCheckerStatus(service.getSnapshot().status),
    "TypeScript timed out and was stopped.",
  );
  assert.doesNotMatch(describeCheckerStatus(service.getSnapshot().status), /Git/);
  // Neither published anything, nor cleared what was there.
  assert.equal(allProblems().length, 0);
  // Stop with nothing running asks the native side nothing.
  service.stop();
  assert.equal(fake.cancels, 1);
});

test("a checker that could not run is a failure, with its own words", async () => {
  resetProblems();
  const fake = fakeNative();
  const service = createCheckerService(fake.native, publishProblems);
  await service.refresh(true);
  const one = service.run("tsc");
  fake.answer(0, completed("\n  This is not the tsc command you are looking for\n", 1));
  await one;
  assert.deepEqual(service.getSnapshot().status, {
    kind: "failed",
    label: "TypeScript",
    message: "This is not the tsc command you are looking for",
  });
  const two = service.run("tsc");
  fake.fail(1, "Could not run npx: it was not found on PATH.");
  await two;
  assert.match(describeCheckerStatus(service.getSnapshot().status), /not found on PATH/);
  const three = service.run("tsc");
  fake.answer(2, { output: "", code: 0 }); // an answer from an older native side
  await three;
  assert.equal(service.getSnapshot().status.kind, "failed");
});

test("a replaced run's late answer changes nothing", async () => {
  resetProblems();
  const fake = fakeNative();
  const service = createCheckerService(fake.native, publishProblems);
  await service.refresh(true);
  const old = service.run("tsc");
  const current = service.run("tsc");
  fake.answer(1, completed("", 0));
  await current;
  // The first run, replaced (and cancelled natively), answers last with stale results.
  fake.answer(0, completed(TSC_OUTPUT));
  await old;
  assert.deepEqual(service.getSnapshot().status, {
    kind: "done",
    label: "TypeScript",
    found: 0,
    outside: 0,
  });
  assert.equal(groupByFile(allProblems()).length, 0);
});

test("after its workspace is disposed, nothing a run returns is published", async () => {
  resetProblems();
  const fake = fakeNative();
  const service = createCheckerService(fake.native, publishProblems);
  await service.refresh(true);
  let changes = 0;
  service.subscribe(() => changes++);
  const run = service.run("tsc");
  const before = changes;
  service.dispose();
  assert.equal(fake.cancels, 1, "the run still going is stopped");
  clearProblems();
  fake.answer(0, completed(TSC_OUTPUT));
  await run;
  assert.equal(allProblems().length, 0);
  assert.equal(changes, before);
  // And it starts nothing more.
  await service.run("tsc");
  await settle();
  assert.equal(allProblems().length, 0);
});

test("an untrusted folder is offered no checker", async () => {
  const fake = fakeNative();
  const service = createCheckerService(fake.native, publishProblems);
  await service.refresh(true);
  assert.equal(service.getSnapshot().available.length, 1);
  await service.refresh(false);
  assert.deepEqual(service.getSnapshot().available, []);
});
