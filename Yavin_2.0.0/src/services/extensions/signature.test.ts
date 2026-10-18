import assert from "node:assert/strict";
import { test } from "node:test";
import type { NativeSignature } from "../native.ts";
import { describeSignature } from "./signature.ts";

const record = (over: Partial<NativeSignature>): NativeSignature => ({
  status: "registrySigned",
  registry: "https://open-vsx.org",
  keyId: "14ccb407-4e79-41ed-be5a-6d608325c45a",
  namespace: "redhat",
  sha256: "ab".repeat(32),
  storeRevision: 1,
  ...over,
});

test("a registry signature says the registry, and that the publisher is not verified", () => {
  const said = describeSignature(record({}));
  assert.equal(said.signed, true);
  assert.equal(said.label, "Signed by open-vsx.org");
  assert.match(said.detail, /does not verify the publisher's identity/);
  assert.doesNotMatch(said.label, /verified/i);
});

test("a checksum alone is never called verified or signed", () => {
  for (const registry of ["file", "https://registry.yavin.dev"]) {
    const said = describeSignature(record({ status: "missing", registry, keyId: null }));
    assert.equal(said.signed, false);
    assert.equal(said.label, "Unsigned");
    assert.doesNotMatch(`${said.label} ${said.detail}`, /\bverified\b|signed by/i);
  }
});

test("no record, or a failed one, is not trusted", () => {
  assert.equal(describeSignature(null).signed, false);
  assert.equal(describeSignature(undefined).label, "Not recorded");
  for (const status of ["invalid", "unknownKey", "keyRevoked", "malformed"] as const) {
    const said = describeSignature(record({ status }));
    assert.equal(said.signed, false, status);
    assert.equal(said.label, "Not trusted", status);
  }
});
