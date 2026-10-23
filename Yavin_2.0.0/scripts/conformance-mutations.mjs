// Proves the VS Code conformance tests test behaviour (EXT-27): each behaviour in
// scripts/conformance-mutations.json is broken in turn, the tests named for it are run, and at
// least one must fail. The file is restored byte for byte after each, whatever happens. The same
// rules as scripts/security-mutations.mjs: a pattern must match exactly once; a mutation that
// does not build proves nothing and fails the run.
//
//   node scripts/conformance-mutations.mjs [--only EXT-27 B1] [--list]
//
// A mutation names its test run: `cargo` (arguments to `cargo test --locked`, in src-tauri),
// `node` (test files, run with --experimental-strip-types --test), or `playwright` (arguments).
// File paths are relative to the application folder.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const app = fileURLToPath(new URL("..", import.meta.url));
const { mutations } = JSON.parse(
  readFileSync(join(app, "scripts", "conformance-mutations.json"), "utf8"),
);
const only = process.argv.includes("--only")
  ? process.argv[process.argv.indexOf("--only") + 1]
  : null;
const chosen = mutations.filter((m) => !only || m.id.startsWith(only));
if (process.argv.includes("--list")) {
  for (const m of chosen) console.log(`${m.id}: ${m.what}`);
  process.exit(0);
}

let pending = new Map();
const restore = () => {
  for (const [file, bytes] of pending) writeFileSync(file, bytes);
  pending = new Map();
};
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    restore();
    process.exit(130);
  });

/** A run Smart App Control interfered with: a test binary, or the host it starts, refused (4551). */
const blocked = (out) => /os error 4551|code: 4551|Windows error 4551/.test(out);

/** Runs a mutation's tests: whether they ran, and whether any failed. */
function run(m) {
  const exec = (command, args, cwd) => {
    for (let attempt = 0; ; attempt++) {
      const r = spawnSync(command, args, {
        cwd,
        encoding: "utf8",
        maxBuffer: 1 << 28,
        shell: process.platform === "win32",
      });
      const out = `${r.stdout}${r.stderr}`;
      // Windows may refuse a freshly built test binary for a moment (Smart App Control): retried.
      if (out.includes("os error 4551") && attempt < 3) continue;
      return { status: r.status, out };
    }
  };
  if (m.cargo) {
    const { out } = exec("cargo", ["test", "--locked", ...m.cargo], join(app, "src-tauri"));
    const ran = /test result/.test(out);
    return { ran, failed: /test result: FAILED/.test(out), out, broken: !ran };
  }
  if (m.node) {
    const { out } = exec("node", ["--experimental-strip-types", "--test", ...m.node], app);
    const fail = /ℹ fail (\d+)/.exec(out);
    return { ran: !!fail, failed: !!fail && Number(fail[1]) > 0, out, broken: !fail };
  }
  const { out } = exec("npx", ["playwright", "test", ...m.playwright, "--reporter=line"], app);
  const ran = /(\d+) (passed|failed)/.test(out);
  return { ran, failed: /\d+ failed/.test(out), out, broken: !ran };
}

const results = [];
for (const m of chosen) {
  const files = new Map();
  let drift = null;
  for (const edit of m.edits) {
    const file = join(app, edit.file);
    const text = files.get(file) ?? readFileSync(file, "utf8");
    if (text.split(edit.from).length !== 2)
      drift = `${edit.file}: its pattern no longer matches exactly once`;
    files.set(file, text.replace(edit.from, edit.to));
  }
  if (drift) {
    results.push({ m, verdict: "DRIFTED", detail: drift });
    console.log(`${m.id} ${m.what}: DRIFTED (${drift})`);
    continue;
  }
  let verdict;
  try {
    for (const file of files.keys()) pending.set(file, readFileSync(file));
    for (const [file, text] of files) writeFileSync(file, text);
    const r = run(m);
    // A blocked run proves nothing either way: a host that never started fails every test.
    verdict = blocked(r.out) ? "BROKEN" : r.failed ? "caught" : r.broken ? "BROKEN" : "NOT CAUGHT";
  } finally {
    restore();
  }
  results.push({ m, verdict });
  console.log(`${m.id} ${m.what}: ${verdict}`);
}
const proven = results.filter((r) => r.verdict === "caught").length;
console.log(`\n${proven} of ${results.length} behaviours proven by their tests.`);
process.exit(proven === results.length ? 0 : 1);
