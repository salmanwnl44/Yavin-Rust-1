/** EXT-25: an installed VS Code extension's verdict comes from what is known, never guessed. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { vscodeCompatibility } from "./vscodeCompatibility.ts";
import type { VsixOrigin } from "./manifest.ts";

const origin = (over: Partial<VsixOrigin> = {}): VsixOrigin => ({
  publisher: "Acme",
  name: "x",
  vscode: "^1.80.0",
  code: false,
  runtime: null,
  supported: ['Colour theme "X"'],
  ignored: [],
  rejected: [],
  signature: "not verified",
  ...over,
});
const runtime = {
  entry: "main" as const,
  level: "1.90.0",
  commands: {},
  settings: {},
  views: {},
  defaults: {},
};
const code = (over: Partial<VsixOrigin> = {}) =>
  origin({
    code: true,
    runtime,
    supported: ["Its code (main: a.js) runs in Yavin's extension sandbox", "1 command"],
    ...over,
  });

test("declarative only: compatible when everything applies, with limitations when not", () => {
  assert.equal(vscodeCompatibility(origin(), null).verdict, "Compatible");
  assert.equal(
    vscodeCompatibility(origin({ ignored: ["iconThemes: not supported."] }), null).verdict,
    "Compatible with limitations",
  );
  assert.equal(
    vscodeCompatibility(origin(), null, [], ["Theme X: 3 scopes not applied"]).verdict,
    "Compatible with limitations",
  );
  const noCode = vscodeCompatibility(
    origin({ code: true, ignored: ["Its code does not run: an ES module."] }),
    null,
  );
  assert.equal(noCode.verdict, "Compatible with limitations");
  assert.equal(noCode.activation, "its code does not run");
});

test("with code: not verified until it activates; then what it did decides; install and activation are separate", () => {
  const before = vscodeCompatibility(code(), {
    state: "registered",
    reason: null,
    activationMs: null,
  });
  assert.equal(before.verdict, "Not verified");
  assert.equal(before.activation, "not activated yet");
  assert.match(before.installed, /sandbox/);
  assert.equal(
    vscodeCompatibility(code(), { state: "active", reason: null, activationMs: 3 }).verdict,
    "Compatible",
  );
  const limited = vscodeCompatibility(code(), { state: "active", reason: null, activationMs: 3 }, [
    "window.showQuickPick",
  ]);
  assert.equal(limited.verdict, "Compatible with limitations");
  assert.match(limited.reasons.join(" "), /window\.showQuickPick/);
  const failed = vscodeCompatibility(code(), {
    state: "failed",
    reason: "UnsupportedApi: debug.x",
    activationMs: null,
  });
  assert.equal(failed.verdict, "Incompatible", "nothing else of it is usable");
  assert.match(failed.activation, /^failed: UnsupportedApi/);
  const themed = vscodeCompatibility(
    code({ supported: ["Its code (main: a.js) runs", 'Colour theme "X"'] }),
    {
      state: "failed",
      reason: "x",
      activationMs: null,
    },
  );
  assert.equal(themed.verdict, "Compatible with limitations", "its theme still applies");
});
