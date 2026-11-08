import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeTestDebug,
  buildTestDebugConfiguration,
  buildCargoDebugConfiguration,
  testDebugSupport,
  TestDebugError,
  type TestDebugRequest,
} from "./debugRequest.ts";
import { DEBUG_ADAPTERS } from "../debug/adapters.ts";

const WS = "file://c:/work";

function request(over: Partial<TestDebugRequest> = {}): TestDebugRequest {
  return {
    adapterId: "pytest",
    caseId: "file\u0000test_adds",
    workspace: WS,
    file: "tests/test_math.py",
    fullName: "test_adds",
    ...over,
  };
}

test("support maps each framework to its registered DAP adapter (the capability)", () => {
  // JavaScript runners map to the registered `node` (js-debug) adapter; pytest to debugpy.
  assert.equal(testDebugSupport("vitest").dapAdapter, "node");
  assert.equal(testDebugSupport("vitest").supported, true);
  assert.equal(testDebugSupport("jest").dapAdapter, "node");
  assert.equal(testDebugSupport("playwright").dapAdapter, "node");
  assert.equal(testDebugSupport("pytest").dapAdapter, "debugpy");
  assert.equal(testDebugSupport("pytest").supported, true);
  assert.ok(DEBUG_ADAPTERS.some((a) => a.id === "node"));
  // Rust's adapter (lldb) is now registered (WS6 Part 3), so Cargo is a capability.
  assert.equal(testDebugSupport("cargo").dapAdapter, "lldb");
  assert.equal(testDebugSupport("cargo").supported, true);
  assert.ok(DEBUG_ADAPTERS.some((a) => a.id === "lldb"));
  // ...but availability-gated off until lldb-dap is installed.
  const cargoAbsent = testDebugSupport("cargo", new Set<string>());
  assert.equal(cargoAbsent.supported, false);
  assert.match(cargoAbsent.reason ?? "", /not installed/);
  assert.match(cargoAbsent.reason ?? "", /lldb-dap/);
  // An unknown framework is unsupported, not a crash.
  assert.equal(testDebugSupport("nope").supported, false);
});

test("the Cargo lldb debug config launches the resolved test executable, test as one opaque arg", () => {
  const request: TestDebugRequest = {
    adapterId: "cargo",
    caseId: "crate\u0000math::tests::adds",
    workspace: WS,
    file: "crate",
    fullName: "math::tests::adds",
  };
  const exe = "D:/w/target/debug/deps/crate-abc123.exe";
  const config = buildCargoDebugConfiguration(request, exe, new Set(["lldb"]));
  assert.equal(config.adapter, "lldb");
  assert.equal(config.program, exe, "the native-resolved executable, not a renderer path");
  assert.deepEqual(config.args, ["math::tests::adds", "--exact"], "only this test runs");
  // buildTestDebugConfiguration refuses Cargo (it needs the native executable).
  assert.throws(
    () => buildTestDebugConfiguration(request, new Set(["lldb"])),
    (e: Error) =>
      e instanceof TestDebugError && /resolves the compiled test executable/.test(e.message),
  );
});

test("a registered adapter is still unsupported until its binary is actually installed", () => {
  // The availability set gates on real installation: a framework is never enabled merely because
  // its adapter is registered.
  const none = new Set<string>();
  const vitestAbsent = testDebugSupport("vitest", none);
  assert.equal(vitestAbsent.supported, false);
  assert.match(vitestAbsent.reason ?? "", /not installed/);
  assert.match(vitestAbsent.reason ?? "", /js-debug/);
  // With the adapter present in the availability set, it is supported.
  assert.equal(testDebugSupport("vitest", new Set(["node"])).supported, true);
  // pytest needs debugpy present.
  assert.equal(testDebugSupport("pytest", none).supported, false);
  assert.equal(testDebugSupport("pytest", new Set(["debugpy"])).supported, true);
});

test("authorize accepts a valid request for a supported framework", () => {
  const ctx = { workspace: WS, currentCaseIds: new Set(["file\u0000test_adds"]) };
  assert.doesNotThrow(() => authorizeTestDebug(request(), ctx));
});

test("authorize rejects an unsupported framework with its reason", () => {
  const ctx = { workspace: WS, currentCaseIds: new Set(["c"]) };
  assert.throws(
    () => authorizeTestDebug(request({ adapterId: "mocha", caseId: "c" }), ctx),
    (e: Error) => e instanceof TestDebugError && /not available for "mocha"/.test(e.message),
  );
});

test("authorize rejects a workspace mismatch (renderer cannot aim at another workspace)", () => {
  const ctx = { workspace: WS, currentCaseIds: new Set(["file\u0000test_adds"]) };
  assert.throws(
    () => authorizeTestDebug(request({ workspace: "file://c:/evil" }), ctx),
    (e: Error) => e instanceof TestDebugError && /different workspace/.test(e.message),
  );
});

test("authorize rejects a stale or unknown test id", () => {
  const ctx = { workspace: WS, currentCaseIds: new Set(["file\u0000other"]) };
  assert.throws(
    () => authorizeTestDebug(request(), ctx),
    (e: Error) => e instanceof TestDebugError && /no longer in the latest results/.test(e.message),
  );
});

test("authorize rejects an empty/invalid selector", () => {
  const ctx = { workspace: WS, currentCaseIds: new Set(["file\u0000test_adds"]) };
  assert.throws(
    () => authorizeTestDebug(request({ fullName: "   " }), ctx),
    (e: Error) => e instanceof TestDebugError && /missing the file or name/.test(e.message),
  );
});

test("the pytest debug configuration launches via the pytest module with the node id", () => {
  const config = buildTestDebugConfiguration(request());
  // The adapter is one Yavin actually has — not an arbitrary path from the renderer.
  assert.ok(
    DEBUG_ADAPTERS.some((a) => a.id === config.adapter),
    "adapter is allow-listed",
  );
  assert.equal(config.adapter, "debugpy");
  assert.equal(config.request, "launch");
  // pytest runs as a module, so pytest's own machinery runs the selected node id.
  assert.equal(config.program, null);
  assert.equal(config.module, "pytest");
  assert.deepEqual(config.args, ["tests/test_math.py::test_adds"]);
  assert.equal(config.id, "test-debug:file\u0000test_adds");
});

test("a test name with shell metacharacters stays inside one argument", () => {
  const evil = 'evil"; rm -rf / #`$(whoami)';
  const config = buildTestDebugConfiguration(request({ fullName: evil }));
  // The dangerous name is carried inside exactly one argv element (the node id), never split.
  assert.equal(config.args.filter((a) => a.includes(evil)).length, 1);
  assert.ok(!config.args.some((a) => !a.includes(evil) && (a.includes(";") || a.includes("|"))));
});

test("the node (JS) debug config launches the runner with the test as opaque arguments", () => {
  const jest = buildTestDebugConfiguration(request({ adapterId: "jest", fullName: "math adds" }));
  assert.equal(jest.adapter, "node");
  assert.equal(jest.program, "node_modules/jest/bin/jest.js");
  assert.deepEqual(jest.args, ["--runInBand", "tests/test_math.py", "-t", "math adds"]);

  const pw = buildTestDebugConfiguration(
    request({ adapterId: "playwright", fullName: "loads [chromium]", file: "e2e/a.spec.ts" }),
  );
  assert.equal(pw.program, "node_modules/@playwright/test/cli.js");
  // The project is split out of the full name; the grep title stays one opaque argument.
  assert.deepEqual(pw.args, [
    "test",
    "e2e/a.spec.ts",
    "-g",
    "loads",
    "--workers=1",
    "--project",
    "chromium",
  ]);
});

test("building a configuration for an unsupported framework throws, never fabricates one", () => {
  // An unknown framework has no adapter mapping at all.
  assert.throws(() => buildTestDebugConfiguration(request({ adapterId: "mocha" })), TestDebugError);
  // A registered adapter that is not installed (empty availability) also refuses to build.
  assert.throws(
    () => buildTestDebugConfiguration(request({ adapterId: "jest" }), new Set<string>()),
    TestDebugError,
  );
});
