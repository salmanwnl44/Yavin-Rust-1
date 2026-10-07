// The real extension host and marketplace, end to end in the installed application (IDE-08/09):
//
//   1. builds the release installer (MSI) with a test identifier, `com.yavin.ide.e2e`, so the
//      run has its own settings, session, trust and extensions -- never the user's
//      (`--skip-build` reuses the last one);
//   2. extracts it (`msiexec /a`: an administrative image -- the installed layout, nothing
//      registered on the machine);
//   3. runs `tests/real` (playwright.real.config.ts) against the extracted application.
//
//   node scripts/e2e-real-host.mjs [--skip-build] [playwright arguments...]
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") throw new Error("The packaged-host test runs on Windows (MSI).");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const skipBuild = args.includes("--skip-build");
const forward = args.filter((arg) => arg !== "--skip-build");
const run = (command, list, options = {}) =>
  execFileSync(command, list, { cwd: root, stdio: "inherit", shell: true, ...options });

if (!skipBuild)
  run("npx", [
    "tauri",
    "build",
    "--config",
    "src-tauri/tauri.e2e.conf.json",
    "--bundles",
    "msi",
    // The marketplace test's local registry (IDE-09): plain loopback HTTP, named by
    // YAVIN_TEST_REGISTRY. Never part of a normal build.
    "--features",
    "test-registry",
  ]);

const bundles = join(
  process.env.CARGO_TARGET_DIR ?? join(root, "src-tauri", "target"),
  "release",
  "bundle",
  "msi",
);
const msi = readdirSync(bundles).find((name) => name.endsWith(".msi"));
if (!msi) throw new Error(`No installer in ${bundles}`);
const install = join(tmpdir(), "yavin-e2e-install");
rmSync(install, { recursive: true, force: true });
execFileSync("msiexec", ["/a", join(bundles, msi), "/qn", `TARGETDIR=${install}`], {
  stdio: "inherit",
});
if (!existsSync(install)) throw new Error("The installer could not be extracted.");
console.log(`Extracted ${msi} into ${install}`);

try {
  run("npx", ["playwright", "test", "-c", "playwright.real.config.ts", ...forward], {
    env: { ...process.env, YAVIN_E2E_INSTALL: install },
  });
} finally {
  rmSync(install, { recursive: true, force: true });
}
