// Checks Yavin's version against what was released before (EXT-24).
//
//   node scripts/release-version.mjs              every build: the version is a valid installer
//                                                 version, never below a released one, and spelled
//                                                 out nowhere but tauri.conf.json
//   node scripts/release-version.mjs --release    a release (a pushed tag): also the tag is exactly
//   node scripts/release-version.mjs --release=v2.2.0   v<version>, and the version is above every
//                                                 other release tag
//
// The installer's downgrade refusal compares this version (EXT-23): a release that reuses or
// lowers it would replace a newer Yavin, or be replaced by an older one, without a word.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const app = fileURLToPath(new URL("..", import.meta.url));

/** `MAJOR.MINOR.PATCH`, as Windows Installer reads it: numbers only, within its limits. */
export function parseVersion(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (!match) return null;
  const [major, minor, patch] = match.slice(1).map(Number);
  if (major > 255 || minor > 255 || patch > 65535) return null;
  return [major, minor, patch];
}

export function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/** Release tags (`v1.2.3`) and their versions; anything else is not a release tag. */
export function releaseTags(tags) {
  return tags
    .map((tag) => ({ tag, version: tag.startsWith("v") ? parseVersion(tag.slice(1)) : null }))
    .filter((one) => one.version);
}

/**
 * What is wrong with \`version\` against the release \`tags\` (problems) or worth saying (notes).
 * \`release\`: the tag being released, if this is a release.
 */
export function check(version, tags, release = null) {
  const problems = [];
  const notes = [];
  const parsed = parseVersion(version);
  if (!parsed) {
    problems.push(
      `"${version}" is not an installer version (MAJOR.MINOR.PATCH, numbers only; major and minor at most 255, patch at most 65535).`,
    );
    return { problems, notes };
  }
  const released = releaseTags(tags).filter((one) => one.tag !== release);
  const latest = released.reduce(
    (top, one) => (!top || compare(one.version, top.version) > 0 ? one : top),
    null,
  );
  if (latest && compare(parsed, latest.version) < 0)
    problems.push(
      `${version} is below the released ${latest.tag}: an installer of it would downgrade (or be refused).`,
    );
  if (release !== null) {
    if (release !== `v${version}`) problems.push(`the release tag ${release} is not v${version}.`);
    const same = released.find((one) => compare(one.version, parsed) === 0);
    if (same)
      problems.push(
        `${version} was already released as ${same.tag}: every release needs a new, higher version.`,
      );
  } else if (latest && compare(parsed, latest.version) === 0)
    notes.push(
      `${version} is the released ${latest.tag}: raise the version before the next release.`,
    );
  return { problems, notes };
}

/**
 * What in the production configuration only a test build may have (EXT-24): a remote debugging
 * port (the packaged tests' own config, tauri.e2e.conf.json, opens one), or the test registry
 * (`test-registry`: a loopback registry and a key from the environment) on by default.
 */
export function productionProblems(tauriConf, cargoToml) {
  const problems = [];
  for (const window of tauriConf.app?.windows ?? [])
    if (/remote-debugging/.test(window.additionalBrowserArgs ?? ""))
      problems.push("tauri.conf.json opens a remote debugging port: only the test config may.");
  const defaults = /^default\s*=\s*\[([^\]]*)\]/m.exec(cargoToml)?.[1] ?? "";
  if (defaults.includes("test-registry"))
    problems.push("Cargo.toml enables test-registry by default: only test builds may.");
  if (tauriConf.identifier !== "com.yavin.ide")
    problems.push(`the identifier is ${tauriConf.identifier}, not com.yavin.ide.`);
  return problems;
}

/** Files under \`dir\` (recursively) with these extensions, test files and the version module excluded. */
function sources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && name !== "appVersion.ts")
      out.push(path);
  }
  return out;
}

/** Where the version is spelled out in the window's code (it must come from tauri.conf.json). */
export function hardcoded(version, files) {
  const pattern = new RegExp(`["'\`v]${version.replaceAll(".", "\\.")}["'\`\\s<]`);
  return files.filter((file) => pattern.test(readFileSync(file, "utf8")));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const version = JSON.parse(
    readFileSync(join(app, "src-tauri", "tauri.conf.json"), "utf8"),
  ).version;
  const tags = execFileSync("git", ["tag", "--list"], { cwd: app, encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean);
  const flag = process.argv.find((arg) => arg.startsWith("--release"));
  const release = flag ? (flag.split("=")[1] ?? process.env.GITHUB_REF_NAME ?? "") : null;
  const { problems, notes } = check(version, tags, release);
  problems.push(
    ...productionProblems(
      JSON.parse(readFileSync(join(app, "src-tauri", "tauri.conf.json"), "utf8")),
      readFileSync(join(app, "src-tauri", "Cargo.toml"), "utf8"),
    ),
  );
  for (const file of hardcoded(version, sources(join(app, "src"))))
    problems.push(`${file.slice(app.length)} spells out ${version}: read it from appVersion.ts.`);
  for (const note of notes) console.log(`note: ${note}`);
  if (problems.length) {
    for (const problem of problems) console.error(`version: ${problem}`);
    process.exit(1);
  }
  console.log(
    `version ${version} is valid${release ? ` for release ${release}` : ""} (release tags: ${
      releaseTags(tags)
        .map((t) => t.tag)
        .join(", ") || "none"
    }).`,
  );
}
