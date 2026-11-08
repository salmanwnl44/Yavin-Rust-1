import assert from "node:assert/strict";
import test from "node:test";
import { createResultStore } from "./resultStore.ts";
import { caseId } from "./model.ts";
import type { TestReport, TestStatus } from "./model.ts";

/** Build a one-file report where each case has the given status. */
function report(
  file: string,
  cases: ReadonlyArray<{ name: string; status: TestStatus }>,
): TestReport {
  const built = cases.map((c) => ({
    id: caseId(file, c.name),
    kind: "case" as const,
    label: c.name,
    ancestors: [] as string[],
    location: { file },
    status: c.status,
  }));
  const passed = cases.filter((c) => c.status === "passed").length;
  const failed = cases.filter((c) => c.status === "failed").length;
  const skipped = cases.length - passed - failed;
  return {
    files: [
      {
        id: file,
        kind: "file",
        file,
        label: file,
        cases: built,
        status: failed ? "failed" : "passed",
      },
    ],
    summary: { passed, failed, skipped, total: cases.length },
  };
}

const ID = (name: string) => caseId("/w/a.test.ts", name);

test("current() is null until a run is recorded, then returns the latest", () => {
  const store = createResultStore();
  assert.equal(store.current(), null);
  store.record(report("/w/a.test.ts", [{ name: "ok", status: "passed" }]));
  assert.equal(store.current()?.summary.passed, 1);
  store.record(report("/w/a.test.ts", [{ name: "ok", status: "failed" }]));
  assert.equal(store.current()?.summary.failed, 1, "the most recent run wins");
});

test("history is bounded to the limit, evicting the oldest runs", () => {
  const store = createResultStore({ limit: 2 });
  store.record(report("/w/a.test.ts", [{ name: "one", status: "passed" }]));
  store.record(report("/w/a.test.ts", [{ name: "two", status: "passed" }]));
  store.record(report("/w/a.test.ts", [{ name: "three", status: "passed" }]));
  assert.equal(store.history().length, 2, "only the two newest runs are retained");
  assert.equal(store.history()[0]!.report.files[0]!.cases[0]!.label, "two");
  assert.equal(store.history()[1]!.report.files[0]!.cases[0]!.label, "three");
});

test("caseHistory tracks a case's status trend and flags flakiness", () => {
  const store = createResultStore();
  store.record(report("/w/a.test.ts", [{ name: "t", status: "passed" }]));
  store.record(report("/w/a.test.ts", [{ name: "t", status: "failed" }]));
  store.record(report("/w/a.test.ts", [{ name: "t", status: "passed" }]));
  const h = store.caseHistory(ID("t"));
  assert.deepEqual(h.statuses, ["passed", "failed", "passed"], "trend is oldest-first");
  assert.equal(h.flaky, true, "both a pass and a failure were seen");
});

test("a case that only ever passes is not flaky; an unknown id is empty", () => {
  const store = createResultStore();
  store.record(report("/w/a.test.ts", [{ name: "steady", status: "passed" }]));
  store.record(report("/w/a.test.ts", [{ name: "steady", status: "passed" }]));
  assert.equal(store.caseHistory(ID("steady")).flaky, false);
  assert.deepEqual(store.caseHistory(ID("nope")).statuses, []);
});

test("newlyFailed reports cases that passed before and fail now, not pre-existing failures", () => {
  const store = createResultStore();
  store.record(
    report("/w/a.test.ts", [
      { name: "regressed", status: "passed" },
      { name: "alreadyBroken", status: "failed" },
    ]),
  );
  store.record(
    report("/w/a.test.ts", [
      { name: "regressed", status: "failed" },
      { name: "alreadyBroken", status: "failed" },
    ]),
  );
  assert.deepEqual(
    store.newlyFailed(),
    [ID("regressed")],
    "only the newly-broken case is reported",
  );
});

test("newlyFailed is empty with fewer than two runs", () => {
  const store = createResultStore();
  assert.deepEqual(store.newlyFailed(), []);
  store.record(report("/w/a.test.ts", [{ name: "t", status: "failed" }]));
  assert.deepEqual(store.newlyFailed(), [], "a first failing run is not a regression");
});

test("subscribers are notified on record and clear; clear drops history", () => {
  const store = createResultStore();
  let n = 0;
  const off = store.subscribe(() => n++);
  store.record(report("/w/a.test.ts", [{ name: "t", status: "passed" }]));
  assert.equal(n, 1);
  store.clear();
  assert.equal(n, 2);
  assert.equal(store.current(), null);
  assert.equal(store.history().length, 0);
  off();
  store.record(report("/w/a.test.ts", [{ name: "t", status: "passed" }]));
  assert.equal(n, 2, "no notification after unsubscribe");
});
