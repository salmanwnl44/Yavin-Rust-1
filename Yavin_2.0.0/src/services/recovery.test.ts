import assert from "node:assert/strict";
import test from "node:test";
import { asRecoveryReport, describeRecovery } from "./recovery.ts";

const item = (outcome: string, message = `${outcome} happened`) => ({
  version: 1,
  id: `i-${outcome}`,
  kind: "save",
  outcome,
  paths: ["C:/w/a.ts"],
  message,
  at: 1,
});

test("a report from the native side is read as the typed contract", () => {
  const report = asRecoveryReport({
    actions: [item("rolledForward"), item("completed")],
    unresolved: [item("conflict")],
  });
  assert.equal(report.actions.length, 2);
  assert.equal(report.actions[0].outcome, "rolledForward");
  assert.deepEqual(report.unresolved[0].paths, ["C:/w/a.ts"]);
});

test("malformed items are dropped, never guessed at", () => {
  const report = asRecoveryReport({
    actions: [item("teleported"), { id: "", outcome: "completed", message: "x" }, null, "x"],
    unresolved: "not a list",
  });
  assert.deepEqual(report, { actions: [], unresolved: [] });
  assert.deepEqual(asRecoveryReport(undefined), { actions: [], unresolved: [] });
});

test("settled work is logged quietly, and what needs the user is warned about once", () => {
  const report = asRecoveryReport({
    // Conflicts found this start are in both lists; they are reported once, as unresolved.
    actions: [item("rolledForward", "Finished an interrupted save of a.ts."), item("conflict")],
    unresolved: [item("conflict"), item("partial")],
  });
  const { lines, banner } = describeRecovery(report);
  assert.deepEqual(
    lines.map((line) => line.level),
    ["info", "warn", "warn"],
  );
  assert.equal(lines[0].text, "Finished an interrupted save of a.ts.");
  assert.match(banner ?? "", /^2 interrupted operations need attention/);
  assert.match(
    describeRecovery(asRecoveryReport({ actions: [], unresolved: [item("corrupt")] })).banner ?? "",
    /^1 interrupted operation needs attention/,
  );
  assert.equal(
    describeRecovery(asRecoveryReport({ actions: [item("completed")], unresolved: [] })).banner,
    null,
  );
});
