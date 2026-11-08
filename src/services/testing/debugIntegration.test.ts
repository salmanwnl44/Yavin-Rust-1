/**
 * WS5.3 DAP integration: a Debug Test configuration drives a *real* debug session through the
 * existing DebugService, proven deterministically with the fake DAP adapter (no real debugger).
 * This is the mechanism the Testing Platform uses — it does not re-test the whole DAP lifecycle
 * (debug.test.ts owns that), only that a test-debug config launches, binds breakpoints, steps and
 * cleans up through the one existing session manager.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createSettingsRegistry } from "../settings/settings.ts";
import type { WorkspaceId } from "../terminalProtocol.ts";
import { createBreakpoints } from "../debug/breakpoints.ts";
import { DEBUG_SETTING_LIST } from "../debug/config.ts";
import { FakeAdapter } from "../debug/fakeAdapter.ts";
import { createDebugService, type DebugService } from "../debug/service.ts";
import { fileUri } from "../resource.ts";
import { buildTestDebugConfiguration, type TestDebugRequest } from "./debugRequest.ts";

const WS = "file://c:/work" as WorkspaceId;
const FILE = "C:\\work\\main.py";

async function until(check: () => boolean, what = "condition") {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail(`timed out waiting for ${what}`);
}

function harness(options: { trusted?: boolean; runsForever?: boolean } = {}) {
  const settings = createSettingsRegistry([...DEBUG_SETTING_LIST], null);
  const adapter = new FakeAdapter({ file: FILE, runsForever: options.runsForever });
  const breakpoints = createBreakpoints(WS);
  let trusted = options.trusted ?? true;
  const service = createDebugService({
    workspace: WS,
    folders: ["C:/work"],
    settings,
    breakpoints,
    transport: adapter,
    trusted: async () => trusted,
    stopTimeoutMs: 50,
    // Short so the success-path start timer (which DebugService leaves pending) does not keep the
    // test event loop alive; the fake adapter answers in microtasks, so this is never hit.
    startTimeoutMs: 500,
  });
  return { service, adapter, breakpoints, setTrusted: (v: boolean) => (trusted = v) };
}

/** A pytest-style request (the one framework whose DAP adapter, debugpy, Yavin has). */
function pyRequest(over: Partial<TestDebugRequest> = {}): TestDebugRequest {
  return {
    adapterId: "pytest",
    caseId: `${FILE}\u0000test_adds`,
    workspace: WS,
    file: FILE,
    fullName: "test_adds",
    ...over,
  };
}

const stopped = (service: DebugService) => service.getSnapshot().session?.state === "stopped";

test("a Debug Test config launches the session through the existing DAP service", async () => {
  const t = harness();
  const config = buildTestDebugConfiguration(pyRequest());
  await t.service.start(config);
  // The existing manager started the allow-listed adapter, not a renderer-named program.
  assert.deepEqual(t.adapter.starts, [{ adapter: "debugpy", root: "C:/work", python: null }]);
  // pytest launches as a module, with the node id as a single structured argument.
  const launch = t.adapter.requests("launch")[0]!;
  assert.equal((launch.arguments as { module?: string }).module, "pytest");
  assert.deepEqual((launch.arguments as { args: string[] }).args, [`${FILE}::test_adds`]);
  assert.equal(
    t.service.getSnapshot().session?.configuration.id,
    `test-debug:${FILE}\u0000test_adds`,
  );
  await t.service.stop();
});

test("a breakpoint in the test file binds, the program stops there, and stepping works", async () => {
  const t = harness();
  t.breakpoints.add(fileUri(FILE), 4);
  await t.service.start(buildTestDebugConfiguration(pyRequest()));
  await until(() => stopped(t.service), "stopped at the breakpoint");
  assert.equal(t.service.getSnapshot().frames[0]?.line, 4, "stopped on the breakpoint line");
  // The breakpoint was verified by the adapter.
  assert.ok(t.breakpoints.getSnapshot().some((b) => b.verified));
  await t.service.stepOver();
  await until(() => t.service.getSnapshot().frames[0]?.line === 5, "stepped to the next line");
  await t.service.stop();
  await until(() => t.service.getSnapshot().session?.state === "terminated", "cleaned up");
});

test("stopping a debug session does not disturb a second, independent service", async () => {
  // Two separate services (as two workspaces have) each own their session; stopping one leaves
  // the other running — no shared debugger or registry.
  const a = harness({ runsForever: true });
  const b = harness({ runsForever: true });
  await a.service.start(buildTestDebugConfiguration(pyRequest()));
  await b.service.start(buildTestDebugConfiguration(pyRequest()));
  await until(() => b.service.getSnapshot().session?.state === "running", "b running");
  await a.service.stop();
  await until(() => a.service.getSnapshot().session?.state === "terminated", "a stopped");
  assert.equal(
    b.service.getSnapshot().session?.state,
    "running",
    "b is untouched and still running",
  );
  await b.service.stop();
});

test("an untrusted workspace refuses to debug a test", async () => {
  const t = harness({ trusted: false });
  await assert.rejects(t.service.start(buildTestDebugConfiguration(pyRequest())), (e: Error) =>
    /not trusted/.test(e.message),
  );
  assert.deepEqual(t.adapter.starts, [], "the adapter was never started");
});

test("an unknown adapter in a (forged) config is rejected before anything starts", async () => {
  const t = harness();
  const bad = { ...buildTestDebugConfiguration(pyRequest()), adapter: "not-an-adapter" };
  await assert.rejects(t.service.start(bad), (e: Error) => /Unknown debug adapter/.test(e.message));
  assert.deepEqual(t.adapter.starts, []);
});
