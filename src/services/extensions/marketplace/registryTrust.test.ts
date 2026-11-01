import assert from "node:assert/strict";
import test from "node:test";
import {
  createRegistryTrustStore,
  describeRegistryTrust,
  type IndexVerification,
} from "./registryTrust.ts";

const checked = (status: IndexVerification["status"], more: Partial<IndexVerification> = {}) => ({
  kind: "checked" as const,
  verification: {
    status,
    registryId: "yavin-official",
    keyId: "yavin-registry-2026-10-19",
    sequence: 1,
    issuedAt: "2026-10-19",
    expiresAt: "2027-10-19",
    sha256: "a".repeat(64),
    anchorsRevision: 1,
    ...more,
  },
});

test("EXT-20 a verified index says what it proves -- and not the publisher", () => {
  const said = describeRegistryTrust(checked("verified"))!;
  assert.equal(said.tone, "good");
  assert.equal(said.installsCode, true);
  assert.match(
    said.detail,
    /key yavin-registry-2026-10-19.*published 2026-10-19.*not who wrote them/,
  );
  assert.doesNotMatch(said.detail, /verified publisher|publisher is verified/i);
});

test("EXT-20 every failure is said, with why and what to do, and installs nothing", () => {
  const cases: [IndexVerification["status"], RegExp][] = [
    ["invalid", /changed after it was signed/],
    ["missing", /no signature/],
    ["unknownKey", /does not trust.*update Yavin/i],
    ["keyRevoked", /revoked/],
    ["keyExpired", /trust has ended/],
    ["wrongRegistry", /another registry.*Settings/],
    ["expired", /past its expiry date \(2027-10-19\)/],
    ["replay", /older index.*downgrade/],
    ["malformed", /unambiguously/],
    ["unavailable", /trust anchors/],
  ];
  for (const [status, why] of cases) {
    const said = describeRegistryTrust(checked(status))!;
    assert.equal(said.tone, "error", status);
    assert.equal(said.installsCode, false, status);
    assert.match(said.detail, why, status);
    assert.match(said.detail, /Nothing is installed or updated from it/, status);
  }
  const unpinned = describeRegistryTrust(checked("unanchored"))!;
  assert.equal(unpinned.tone, "warning");
  assert.match(
    unpinned.detail,
    /Themes and snippets can be installed from it; extensions with code cannot/,
  );
  const offline = describeRegistryTrust({
    kind: "unreachable",
    error: "MarketplaceUnavailable: offline",
  })!;
  assert.match(offline.detail, /could not reach the registry.*nothing is installed until/);
  assert.equal(describeRegistryTrust(null), null);
});

test("EXT-20 the store keeps each registry's last state, and the latest", () => {
  const store = createRegistryTrustStore();
  let heard = 0;
  store.subscribe(() => heard++);
  store.set("https://a/", checked("verified"));
  store.set("https://b/", checked("invalid"));
  assert.equal(store.get("https://a/")?.kind, "checked");
  assert.equal(
    (store.latest() as { verification: IndexVerification }).verification.status,
    "invalid",
  );
  assert.equal(heard, 2);
});
