// Release artifact & security validation (WS23).
//
// A production build is release-ready only when the shipped bundle is well-formed and carries
// nothing that only a dev or test build may: no test identifier, no `test-registry` default, no
// dev secrets, and every required native resource present. This gate makes that check one command,
// before and after the actual packaging, so a release is validated by evidence, not by eye. It
// adds NO new build system and changes no runtime behaviour -- it only reads what the build
// produced. The version/production-config rules are reused from release-version.mjs (one source of
// truth), never re-implemented here.
//
//   node scripts/validate-artifact.mjs                 pre-build gate: the production config is
//                                                      clean, the version is valid, the frontend
//                                                      dist (if present) carries no leaked secret,
//                                                      and every required bundle resource is on disk
//   node scripts/validate-artifact.mjs --installer auto   also validate the installer tauri just
//                                                      built (release/bundle/msi): expected name
//                                                      (version + x64), a sane size, and its SHA-256
//   node scripts/validate-artifact.mjs --installer <path.msi>   validate a specific installer file
//
// Exit 0 only when every check passed; exit 1 with a `validate:` line per problem otherwise.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parseVersion, productionProblems } from "./release-version.mjs";

const app = fileURLToPath(new URL("..", import.meta.url));

/** The production installer's file name for a version, as Tauri's WiX bundle writes it (x64, MSI). */
export function expectedInstallerName(version) {
  return `Yavin IDE_${version}_x64_en-US.msi`;
}

/**
 * Bundle resources (tauri.conf.json `bundle.resources`) that must exist on disk before packaging,
 * resolved under `src-tauri`. A glob (`dir/*`) is satisfied by the directory holding at least one
 * non-placeholder file, so a build never silently ships an empty resource folder. Returns the list
 * of problems (missing or empty resources).
 */
export function missingResources(tauriConf, tauriDir, platform = process.platform) {
  const problems = [];
  const hostBin = platform === "win32" ? "yavin-extension-host.exe" : "yavin-extension-host";
  for (const entry of tauriConf.bundle?.resources ?? []) {
    if (entry.endsWith("/*")) {
      const dir = join(tauriDir, entry.slice(0, -2));
      // The extension host is built by scripts/build-extension-host.mjs into this folder; the
      // README placeholder alone is not a packaged host.
      const real = existsSync(dir)
        ? readdirSync(dir).filter((f) => f !== "README.md" && !f.startsWith("."))
        : [];
      if (entry.includes("extension-host") && !real.includes(hostBin))
        problems.push(
          `the extension host (${hostBin}) is not built into ${entry.slice(0, -2)} -- run scripts/build-extension-host.mjs --release.`,
        );
      else if (!real.length) problems.push(`${entry} has no packaged file.`);
    } else {
      const path = join(tauriDir, entry);
      if (!existsSync(path)) problems.push(`the bundle resource ${entry} is missing (${path}).`);
    }
  }
  return problems;
}

/**
 * Secret/credential markers that must never reach the shipped frontend or production config. These
 * are leak shapes (a private key block, a registry key from the environment, a bearer/token
 * literal), not a password dictionary -- the aim is to catch an accidental commit, not to audit
 * cryptography. Returns one problem per file that matches.
 */
const SECRET_MARKERS = [
  { re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, what: "a private key" },
  { re: /YAVIN_TEST_REGISTRY/, what: "the test-registry environment hook" },
  { re: /com\.yavin\.ide\.e2e/, what: "the end-to-end test identifier" },
  { re: /xox[baprs]-[0-9A-Za-z-]{10,}/, what: "a Slack token" },
  { re: /AKIA[0-9A-Z]{16}/, what: "an AWS access key id" },
  { re: /ghp_[0-9A-Za-z]{36}/, what: "a GitHub token" },
];

/** Text files directly under `dir` (recursively) that a scan should read; binaries are skipped. */
function textFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) textFiles(path, out);
    else if (/\.(js|mjs|cjs|css|html|json|map|svg|txt)$/.test(name)) out.push(path);
  }
  return out;
}

/** Secret markers found across the given files. Returns one problem per (file, marker). */
export function scanForSecrets(files) {
  const problems = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const { re, what } of SECRET_MARKERS)
      if (re.test(text)) problems.push(`${file} contains ${what}.`);
  }
  return problems;
}

/** A built installer's problems (name, size), plus its SHA-256 and size for the record. */
export function validateInstaller(path, version, { minBytes = 5e6, maxBytes = 500e6 } = {}) {
  const problems = [];
  const name = basename(path);
  const expected = expectedInstallerName(version);
  if (name !== expected)
    problems.push(`the installer is "${name}", not the expected "${expected}" (version + x64).`);
  const size = statSync(path).size;
  if (size < minBytes)
    problems.push(`the installer is ${size} bytes: implausibly small for a packaged app.`);
  if (size > maxBytes)
    problems.push(`the installer is ${size} bytes: larger than the ${maxBytes}-byte ceiling.`);
  const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex").toUpperCase();
  return { problems, size, sha256 };
}

/** The installer Tauri built for this version under the given bundle folder, or null. */
export function locateInstaller(bundleDir, version) {
  if (!existsSync(bundleDir)) return null;
  const name = expectedInstallerName(version);
  return readdirSync(bundleDir).includes(name) ? join(bundleDir, name) : null;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const tauriDir = join(app, "src-tauri");
  const tauriConf = JSON.parse(readFileSync(join(tauriDir, "tauri.conf.json"), "utf8"));
  const version = tauriConf.version;
  const problems = [];
  const notes = [];

  // 1. Version + production-config rules (reused from release-version.mjs, one source of truth).
  // The against-released-tags comparison stays in release-version.mjs (it owns git); here we gate
  // the shape and the production-vs-test config of exactly what is about to be packaged.
  if (!parseVersion(version)) problems.push(`"${version}" is not an installer version.`);
  problems.push(
    ...productionProblems(tauriConf, readFileSync(join(tauriDir, "Cargo.toml"), "utf8")),
  );

  // 2. Required bundle resources present (missing ones fail the build, not the user).
  problems.push(...missingResources(tauriConf, tauriDir));

  // 3. No secret leaked into the shipped frontend (dist/) or the production config.
  const dist = join(app, "dist");
  if (existsSync(dist)) problems.push(...scanForSecrets(textFiles(dist)));
  else notes.push("dist/ is absent: run the frontend build before a full artifact validation.");
  problems.push(...scanForSecrets([join(tauriDir, "tauri.conf.json")]));

  // 4. The built installer, if asked for.
  const flag = process.argv.find((a) => a.startsWith("--installer"));
  if (flag) {
    const value = flag.includes("=")
      ? flag.split("=")[1]
      : process.argv[process.argv.indexOf(flag) + 1];
    let path = value && value !== "auto" ? resolve(value) : null;
    if (!path) {
      const bundleDir = join(
        process.env.CARGO_TARGET_DIR ?? join(tauriDir, "target"),
        "release",
        "bundle",
        "msi",
      );
      path = locateInstaller(bundleDir, version);
      if (!path)
        problems.push(`no ${expectedInstallerName(version)} under ${bundleDir} -- build first.`);
    }
    if (path && existsSync(path)) {
      const { problems: installerProblems, size, sha256 } = validateInstaller(path, version);
      problems.push(...installerProblems);
      notes.push(`installer ${basename(path)}: ${(size / 1e6).toFixed(1)} MB, SHA-256 ${sha256}.`);
    } else if (path) {
      problems.push(`the installer ${path} does not exist.`);
    }
  }

  for (const note of notes) console.log(`note: ${note}`);
  if (problems.length) {
    for (const problem of problems) console.error(`validate: ${problem}`);
    process.exit(1);
  }
  console.log(`artifact validation passed for version ${version}.`);
}
