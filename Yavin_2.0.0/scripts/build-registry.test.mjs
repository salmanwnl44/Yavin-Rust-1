// EXT-24: renewing the signed index, with a test key on a copy of the registry -- the production
// key and the repository's registry are never touched.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const app = fileURLToPath(new URL("..", import.meta.url));
const script = join(app, "scripts", "build-registry.mjs");
const DOMAIN = Buffer.from("Yavin.RegistryIndex.v1\0", "utf8");

// Each sandbox holds a throwaway test key: removed when the tests end.
const made = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** A copy of the registry and anchors pinning a fresh test key under the production key id. */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "yavin-registry-"));
  made.push(dir);
  const out = join(dir, "registry");
  cpSync(join(app, "registry"), out, { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const anchors = JSON.parse(
    readFileSync(join(app, "src-tauri", "src", "registry_anchors.json"), "utf8"),
  );
  const pem = publicKey.export({ type: "spki", format: "pem" });
  anchors.registries[0].keys[0].publicKey = pem;
  const anchorsFile = join(dir, "anchors.json");
  writeFileSync(anchorsFile, JSON.stringify(anchors));
  const keyFile = join(dir, "test-key.pem");
  writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }));
  const env = (key = keyFile) => ({
    ...process.env,
    YAVIN_REGISTRY_OUT: out,
    YAVIN_REGISTRY_ANCHORS: anchorsFile,
    YAVIN_REGISTRY_SIGNING_KEY: key,
  });
  return { dir, out, pem, env };
}

const run = (args, env) =>
  spawnSync(process.execPath, ["--experimental-strip-types", script, ...args], {
    env,
    encoding: "utf8",
  });

test("EXT-24 --renew signs the same content again: the next sequence, new dates, a signature over the exact bytes; --check then passes", () => {
  const repoIndex = readFileSync(join(app, "registry", "index.json"));
  const box = sandbox();
  const before = JSON.parse(readFileSync(join(box.out, "index.json"), "utf8"));
  const renewed = run(["--renew"], box.env());
  assert.equal(renewed.status, 0, renewed.stderr);
  const bytes = readFileSync(join(box.out, "index.json"));
  const after = JSON.parse(bytes);
  const sig = JSON.parse(readFileSync(join(box.out, "index.json.sig"), "utf8"));
  assert.equal(after.sequence, before.sequence + 1, "the next sequence, never a reused one");
  assert.equal(after.issuedAt, new Date().toISOString().slice(0, 10));
  assert.ok(after.expiresAt > before.expiresAt || before.expiresAt < after.issuedAt);
  const strip = ({ sequence, issuedAt, expiresAt, ...rest }) => rest;
  assert.deepEqual(strip(after), strip(before), "the content is unchanged");
  assert.deepEqual(
    [sig.registryId, sig.keyId, sig.algorithm],
    ["yavin-official", "yavin-registry-2026-10-19", "ed25519"],
  );
  assert.ok(
    verify(
      null,
      Buffer.concat([DOMAIN, bytes]),
      createPublicKey(box.pem),
      Buffer.from(sig.signature, "base64"),
    ),
  );
  // Renewed again: higher again.
  assert.equal(run(["--renew"], box.env()).status, 0);
  assert.equal(JSON.parse(readFileSync(join(box.out, "index.json"))).sequence, before.sequence + 2);
  const checked = run(["--check"], box.env());
  assert.equal(checked.status, 0, checked.stderr);
  assert.ok(
    readFileSync(join(app, "registry", "index.json")).equals(repoIndex),
    "repository untouched",
  );
});

test("EXT-24 a key that is not the pinned one signs nothing: the index is left as it was", () => {
  const box = sandbox();
  const before = readFileSync(join(box.out, "index.json"));
  const other = join(box.dir, "other-key.pem");
  writeFileSync(
    other,
    generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }),
  );
  const refused = run(["--renew"], box.env(other));
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /does not match the pinned key/);
  assert.ok(readFileSync(join(box.out, "index.json")).equals(before));
  // No key at all: refused too, saying where it looked -- never anything of a key.
  const missing = run(["--renew"], box.env(join(box.dir, "absent.pem")));
  assert.equal(missing.status, 1);
  assert.doesNotMatch(missing.stderr + missing.stdout, /PRIVATE KEY/);
});

test("EXT-24 --check fails ahead of expiry, with the lead time configured", () => {
  const box = sandbox();
  const near = run(["--check"], { ...box.env(), YAVIN_REGISTRY_WARN_DAYS: "100000" });
  assert.equal(near.status, 1);
  assert.match(near.stderr, /renew it/);
  assert.equal(run(["--check"], { ...box.env(), YAVIN_REGISTRY_WARN_DAYS: "1" }).status, 0);
  assert.equal(run(["--check", "--renew"], box.env()).status, 1);
  execFileSync("git", ["-C", app, "diff", "--quiet", "--", "registry"]);
});
