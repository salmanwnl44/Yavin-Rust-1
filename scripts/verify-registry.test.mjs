// EXT-24: the deployed-registry monitor, against test keys and indexes (never the production one).
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { check } from "./verify-registry.mjs";

const DOMAIN = Buffer.from("Yavin.RegistryIndex.v1\0", "utf8");
const BASE = "https://registry.example/";
const TODAY = Date.parse("2026-10-20T12:00:00Z");
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519").privateKey;

const anchors = (key = {}) => ({
  registries: [
    {
      id: "yavin-official",
      base: BASE,
      minSequence: 3,
      keys: [
        {
          keyId: "k",
          algorithm: "ed25519",
          publicKey: publicKey.export({ type: "spki", format: "pem" }),
          status: "active",
          notAfter: "2028-01-01",
          ...key,
        },
      ],
    },
  ],
});

function deployed({
  sequence = 4,
  expiresAt = "2027-06-01",
  registryId = "yavin-official",
  by = privateKey,
  sig = {},
} = {}) {
  const index = Buffer.from(
    JSON.stringify({
      schema: 1,
      registryId,
      sequence,
      issuedAt: "2026-10-01",
      expiresAt,
      extensions: [],
    }),
  );
  const signature = Buffer.from(
    JSON.stringify({
      schema: 1,
      registryId: "yavin-official",
      keyId: "k",
      algorithm: "ed25519",
      signature: sign(null, Buffer.concat([DOMAIN, index]), by).toString("base64"),
      ...sig,
    }),
  );
  return { index, signature };
}

const problems = (over = {}, served = deployed()) =>
  check({ anchors: anchors(), base: BASE, today: TODAY, warnDays: 90, ...served, ...over })
    .problems;

test("EXT-24 a correctly signed, fresh, published index passes", () => {
  const served = deployed();
  const result = check({
    anchors: anchors(),
    base: BASE,
    today: TODAY,
    warnDays: 90,
    local: served.index,
    ...served,
  });
  assert.deepEqual(result.problems, []);
  assert.equal(result.found.sequence, 4);
  assert.equal(result.found.daysLeft, 224);
});

test("EXT-24 what users would refuse, or soon refuse, is said", () => {
  const cases = [
    [{ index: null }, /index\.json is not served/],
    [{ signature: null }, /index\.json\.sig is not served/],
    [{}, /does not verify/, deployed({ by: other })],
    [
      { index: Buffer.from(deployed().index.toString().replace('"sequence":4', '"sequence":5')) },
      /does not verify/,
    ],
    [{}, /below the floor this release pins \(3\)/, deployed({ sequence: 2 })],
    [{}, /expired on 2026-10-19/, deployed({ expiresAt: "2026-10-19" })],
    [{}, /in 40 day\(s\) -- less than 90: renew it/, deployed({ expiresAt: "2026-11-29" })],
    [{}, /index\.json names registry other/, deployed({ registryId: "other" })],
    [{}, /not pinned/, deployed({ sig: { keyId: "unknown" } })],
    [{}, /must hold exactly/, deployed({ sig: { extra: 1 } })],
    [{ local: Buffer.from("{}") }, /not the repository's/],
    [{ base: "https://elsewhere.example/" }, /no registry is pinned/],
  ];
  for (const [over, expected, served] of cases)
    assert.match(problems(over, served).join(" | "), expected, String(expected));
  // A revoked key, or one past its notAfter.
  const revoked = check({
    anchors: anchors({ status: "revoked" }),
    base: BASE,
    today: TODAY,
    warnDays: 90,
    ...deployed(),
  });
  assert.match(revoked.problems.join(" "), /key k is revoked/);
  const ended = check({
    anchors: anchors({ notAfter: "2026-10-01" }),
    base: BASE,
    today: TODAY,
    warnDays: 90,
    ...deployed(),
  });
  assert.match(ended.problems.join(" "), /past its notAfter/);
});

test("EXT-24 the repository's anchors and registry pass the same checks offline", () => {
  const repo = new URL("..", import.meta.url);
  const pinned = JSON.parse(
    readFileSync(new URL("src-tauri/src/registry_anchors.json", repo), "utf8"),
  );
  const base = pinned.registries[0].base;
  const index = readFileSync(new URL("registry/index.json", repo));
  const signature = readFileSync(new URL("registry/index.json.sig", repo));
  const result = check({
    anchors: pinned,
    base,
    index,
    signature,
    today: Date.now(),
    warnDays: 0,
    local: index,
  });
  assert.deepEqual(result.problems, []);
});
