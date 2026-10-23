import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  declaredPermissions,
  describeCapability,
  grantable,
  needOfEvent,
  needOfRequest,
  type Need,
} from "./permissions.ts";
import { readManifest } from "./manifest.ts";

const cases = JSON.parse(
  readFileSync(new URL("./permissions.cases.json", import.meta.url), "utf8"),
) as {
  declarations: {
    about: string;
    manifest: Record<string, unknown>;
    ok: boolean;
    legacy?: boolean;
    requested?: string[];
  }[];
  requests: { method: string; params: Record<string, unknown>; need: string }[];
  events: { event: string; need: string }[];
};

const label = (need: Need) => (need.kind === "capability" ? need.capability : need.kind);

test("permissions: the same declarations as the native rules, case by case", () => {
  assert.ok(cases.declarations.length >= 20);
  for (const one of cases.declarations) {
    const got = declaredPermissions(one.manifest, "acme.hello");
    if (one.ok) {
      assert.ok(got.ok, `${one.about}: ${got.ok ? "" : got.error}`);
      assert.equal(got.value.legacy, one.legacy, one.about);
      assert.deepEqual(got.value.requested, one.requested, one.about);
    } else assert.equal(got.ok, false, one.about);
  }
});

test("permissions: what each request and event needs, as the native rules say", () => {
  for (const one of cases.requests)
    assert.equal(label(needOfRequest("acme.hello", one.method, one.params)), one.need, one.method);
  for (const one of cases.events) assert.equal(label(needOfEvent(one.event)), one.need, one.event);
});

test("permissions: every bridge method the host serves has a decision", () => {
  const host = readFileSync(new URL("./host.ts", import.meta.url), "utf8");
  const start = host.indexOf("const methods: Record<");
  const end = host.indexOf("\n  };\n", start);
  const methods = [...host.slice(start, end).matchAll(/^\s+(?:async )?"([a-zA-Z.]+)"\(/gm)].map(
    (match) => match[1],
  );
  // EXT-25: documents.edit, statusBar.set, statusBar.remove; EXT-27: window.state; EXT-29:
  // window.quickPick, window.inputBox, window.cancelPrompt, diagnostics.set, diagnostics.clear.
  assert.equal(methods.length, 35, methods.join(", "));
  for (const method of methods)
    assert.notEqual(needOfRequest("acme.hello", method, {}).kind, "unknown", method);
});

test("permissions: a manifest whose declaration is refused is not an extension", () => {
  const base = {
    publisher: "acme",
    name: "hello",
    version: "1.0.0",
    engines: { yavin: "^2.0.0" },
    main: "extension.js",
  };
  const good = readManifest({
    ...base,
    permissions: { version: 1, request: ["documents.read", "commands.execute:Acme.Other"] },
  });
  assert.ok(good.ok);
  assert.deepEqual(good.manifest.permissions, {
    legacy: false,
    requested: ["commands.execute:acme.other", "documents.read"],
  });
  const legacy = readManifest(base);
  assert.ok(legacy.ok);
  assert.deepEqual(legacy.manifest.permissions, {
    legacy: true,
    requested: ["documents.read", "editor.control", "workspace.fs.read"],
  });
  for (const permissions of [
    { version: 2, request: [] },
    { version: 1, request: ["network.fetch"] },
    { version: 1, request: [], grant: ["documents.read"] },
    null,
  ]) {
    const refused = readManifest({ ...base, permissions });
    assert.equal(refused.ok, false, JSON.stringify(permissions));
    if (!refused.ok)
      assert.ok(
        refused.problems.some((p) => p.field.startsWith("permissions")),
        JSON.stringify(refused.problems),
      );
  }
});

test("permissions: what can be granted, and how it is said", () => {
  assert.ok(grantable("acme.hello", "documents.read"));
  assert.ok(grantable("acme.hello", "commands.execute:acme.other"));
  assert.ok(!grantable("acme.hello", "commands.execute:acme.hello"));
  assert.ok(!grantable("acme.hello", "commands.execute:Acme.Other"));
  assert.ok(!grantable("acme.hello", "network.fetch"));
  for (const capability of [
    "workspace.fs.read",
    "documents.read",
    "editor.control",
    "commands.execute:acme.other",
  ]) {
    const said = describeCapability(capability);
    assert.ok(said.title.length > 5 && said.detail.length > 10, capability);
  }
  assert.match(describeCapability("commands.execute:acme.other").title, /acme\.other/);
});
