// Tests for the pure helpers in validate-artifact.mjs (WS23). No build, no network, no disk writes
// beyond a throwaway temp tree; deterministic so it runs in `npm test` on CI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  expectedInstallerName,
  missingResources,
  scanForSecrets,
  validateInstaller,
  locateInstaller,
} from "./validate-artifact.mjs";

test("expectedInstallerName encodes version and x64", () => {
  assert.equal(expectedInstallerName("2.2.0"), "Yavin IDE_2.2.0_x64_en-US.msi");
});

test("missingResources flags an absent file, an empty glob folder, and a host that is only the placeholder", () => {
  const dir = mkdtempSync(join(tmpdir(), "yavin-res-"));
  try {
    const conf = {
      bundle: {
        resources: [
          "resources/search/rg.exe",
          "resources/search/VERSION.txt",
          "resources/extension-host/*",
        ],
      },
    };
    // Nothing on disk yet.
    let problems = missingResources(conf, dir, "win32");
    assert.ok(problems.some((p) => p.includes("rg.exe")));
    assert.ok(problems.some((p) => p.includes("VERSION.txt")));
    assert.ok(problems.some((p) => p.includes("extension host")));

    // Create the two plain files and only the README placeholder for the host → host still missing.
    mkdirSync(join(dir, "resources/search"), { recursive: true });
    writeFileSync(join(dir, "resources/search/rg.exe"), "x");
    writeFileSync(join(dir, "resources/search/VERSION.txt"), "15.2.0");
    mkdirSync(join(dir, "resources/extension-host"), { recursive: true });
    writeFileSync(join(dir, "resources/extension-host/README.md"), "placeholder");
    problems = missingResources(conf, dir, "win32");
    assert.equal(problems.length, 1);
    assert.ok(problems[0].includes("extension host"));

    // Add the real host binary → clean.
    writeFileSync(join(dir, "resources/extension-host/yavin-extension-host.exe"), "MZ");
    assert.deepEqual(missingResources(conf, dir, "win32"), []);

    // The non-Windows host name differs.
    const unixProblems = missingResources(conf, dir, "linux");
    assert.ok(unixProblems.some((p) => p.includes("yavin-extension-host")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scanForSecrets catches a private key, the test-registry hook, and the e2e identifier; passes clean files", () => {
  const dir = mkdtempSync(join(tmpdir(), "yavin-sec-"));
  try {
    const key = join(dir, "leak.js");
    writeFileSync(
      key,
      "const k = `-----BEGIN PRIVATE KEY-----\\nAAA\\n-----END PRIVATE KEY-----`;",
    );
    const reg = join(dir, "reg.js");
    writeFileSync(reg, "fetch(process.env.YAVIN_TEST_REGISTRY)");
    const e2e = join(dir, "id.json");
    writeFileSync(e2e, '{"identifier":"com.yavin.ide.e2e"}');
    const clean = join(dir, "ok.js");
    writeFileSync(clean, "export const APP_VERSION = '2.2.0';");

    const problems = scanForSecrets([key, reg, e2e, clean]);
    assert.equal(problems.length, 3);
    assert.ok(problems.some((p) => p.includes("private key")));
    assert.ok(problems.some((p) => p.includes("test-registry")));
    assert.ok(problems.some((p) => p.includes("end-to-end test identifier")));
    assert.ok(!problems.some((p) => p.includes("ok.js")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInstaller checks name and size and reports a SHA-256", () => {
  const dir = mkdtempSync(join(tmpdir(), "yavin-msi-"));
  try {
    const good = join(dir, "Yavin IDE_2.2.0_x64_en-US.msi");
    writeFileSync(good, Buffer.alloc(6_000_000, 7));
    const ok = validateInstaller(good, "2.2.0");
    assert.deepEqual(ok.problems, []);
    assert.equal(ok.size, 6_000_000);
    assert.match(ok.sha256, /^[0-9A-F]{64}$/);

    // Wrong name (version/arch) and too small.
    const bad = join(dir, "Yavin IDE_2.2.0_x86_en-US.msi");
    writeFileSync(bad, Buffer.alloc(10, 1));
    const res = validateInstaller(bad, "2.2.0");
    assert.ok(res.problems.some((p) => p.includes("expected")));
    assert.ok(res.problems.some((p) => p.includes("implausibly small")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("locateInstaller finds the version's installer and ignores others", () => {
  const dir = mkdtempSync(join(tmpdir(), "yavin-loc-"));
  try {
    assert.equal(locateInstaller(join(dir, "nope"), "2.2.0"), null);
    writeFileSync(join(dir, "Yavin IDE_2.1.0_x64_en-US.msi"), "old");
    assert.equal(locateInstaller(dir, "2.2.0"), null);
    writeFileSync(join(dir, "Yavin IDE_2.2.0_x64_en-US.msi"), "new");
    assert.equal(locateInstaller(dir, "2.2.0"), join(dir, "Yavin IDE_2.2.0_x64_en-US.msi"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
