import assert from "node:assert/strict";
import test from "node:test";
import { check, parseVersion, releaseTags } from "./release-version.mjs";

test("EXT-24 an installer version is MAJOR.MINOR.PATCH, numbers only, within Windows Installer's limits", () => {
  assert.deepEqual(parseVersion("2.2.0"), [2, 2, 0]);
  for (const bad of [
    "2.2",
    "2.2.0-rc.1",
    "v2.2.0",
    "256.0.0",
    "1.256.0",
    "1.0.65536",
    "02.x.0",
    "",
  ])
    assert.equal(parseVersion(bad), null, bad);
  assert.deepEqual(
    releaseTags(["v2.1.0", "nightly", "v2.0", "v3.0.0-rc1"]).map((t) => t.tag),
    ["v2.1.0"],
  );
});

test("EXT-24 every build: never below a released version; still the released one is said", () => {
  assert.deepEqual(check("2.2.0", ["v2.1.0"]), { problems: [], notes: [] });
  assert.match(check("2.0.0", ["v2.1.0"]).problems[0], /below the released v2\.1\.0/);
  assert.match(check("2.1.0", ["v2.1.0"]).notes[0], /raise the version before the next release/);
  assert.equal(check("2.1.0", ["v2.1.0"]).problems.length, 0);
  assert.match(check("2.2.0-rc.1", []).problems[0], /not an installer version/);
});

test("EXT-24 a release: the tag is v<version>, and the version is above every other release", () => {
  assert.deepEqual(check("2.2.0", ["v2.1.0", "v2.2.0"], "v2.2.0").problems, []);
  assert.match(
    check("2.2.0", ["v2.1.0"], "v2.2.1").problems.join(" "),
    /tag v2\.2\.1 is not v2\.2\.0/,
  );
  // Re-releasing a version under another tag, or below one already out.
  assert.match(
    check("2.1.0", ["v2.1.0", "v2.1.0-again"], "v2.1.0-again").problems.join(" "),
    /already released as v2\.1\.0/,
  );
  assert.match(
    check("2.0.5", ["v2.1.0", "v2.0.5"], "v2.0.5").problems.join(" "),
    /below the released v2\.1\.0/,
  );
});

test("EXT-24 the window's code spells the version out nowhere: it reads it from appVersion.ts", async () => {
  const { hardcoded } = await import("./release-version.mjs");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "yavin-version-"));
  const files = ["title.tsx", "lsp.ts", "other.ts"].map((name) => join(dir, name));
  writeFileSync(files[0], "<span>v2.2.0</span>");
  writeFileSync(files[1], 'clientInfo: { version: "2.2.0" }');
  writeFileSync(files[2], 'const api = "^2.0.0"; const read = APP_VERSION;');
  assert.deepEqual(hardcoded("2.2.0", files), files.slice(0, 2));
});

test("EXT-24 the production configuration has nothing only a test build may have", async () => {
  const { productionProblems } = await import("./release-version.mjs");
  const window = { title: "Yavin IDE" };
  const conf = (extra = {}, id = "com.yavin.ide") => ({
    identifier: id,
    app: { windows: [{ ...window, ...extra }] },
  });
  assert.deepEqual(productionProblems(conf(), "[features]\ntest-registry = []\n"), []);
  assert.match(
    productionProblems(conf({ additionalBrowserArgs: "--remote-debugging-port=9339" }), "").join(),
    /remote debugging port/,
  );
  assert.match(
    productionProblems(
      conf(),
      '[features]\ndefault = ["test-registry"]\ntest-registry = []\n',
    ).join(),
    /test-registry by default/,
  );
  assert.match(
    productionProblems(conf({}, "com.yavin.ide.e2e"), "").join(),
    /identifier is com\.yavin\.ide\.e2e/,
  );
});
