// Proves Yavin's security protections are tested (EXT-24): each protection in
// scripts/security-mutations.json is removed in turn, the tests named for it are run, and at least
// one must fail. The file is restored byte for byte after each, whatever happens.
//
//   node scripts/security-mutations.mjs [--only EXT-20] [--list]
//
// Fails (exit 1) if a protection is removed and every test still passes, if a mutation no longer
// compiles, or if its pattern no longer matches exactly once (the code moved: re-target it -- a
// mutation that silently matches nothing proves nothing). Slow: one test build per mutation.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const app = fileURLToPath(new URL("..", import.meta.url));
const crate = join(app, "src-tauri");
const { mutations } = JSON.parse(
  readFileSync(join(app, "scripts", "security-mutations.json"), "utf8"),
);
const only = process.argv.includes("--only")
  ? process.argv[process.argv.indexOf("--only") + 1]
  : null;
const chosen = mutations.filter((m) => !only || m.id.startsWith(only));

if (process.argv.includes("--list")) {
  for (const m of chosen) console.log(`${m.id}: ${m.what}`);
  process.exit(0);
}

// Whatever is mutated now, restored on any exit.
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

function cargo(args) {
  for (let attempt = 0; ; attempt++) {
    const run = spawnSync("cargo", ["test", "--locked", ...args], {
      cwd: crate,
      encoding: "utf8",
      maxBuffer: 1 << 28,
    });
    const out = `${run.stdout}${run.stderr}`;
    // Windows may refuse a freshly built test binary for a moment (Smart App Control): retried.
    if (out.includes("os error 4551") && attempt < 3) continue;
    return { status: run.status, out };
  }
}

const results = [];
for (const m of chosen) {
  const files = new Map();
  let drift = null;
  for (const edit of m.edits) {
    const file = join(crate, edit.file);
    const text = files.get(file) ?? readFileSync(file, "utf8");
    if (text.split(edit.from).length !== 2)
      drift = `${edit.file}: its pattern no longer matches exactly once`;
    files.set(file, text.replace(edit.from, edit.to));
  }
  if (drift) {
    results.push({ m, verdict: "DRIFTED", detail: drift });
    continue;
  }
  let verdict;
  let detail = "";
  try {
    for (const file of files.keys()) pending.set(file, readFileSync(file));
    for (const [file, text] of files) writeFileSync(file, text);
    const caught = [];
    let broken = false;
    let blocked = false;
    for (const args of [m.args, ...(m.also ?? [])]) {
      const { out } = cargo(args);
      if (/^error(\[E\d+\])?: /m.test(out) && !/test result/.test(out)) broken = true;
      // Smart App Control refused a test binary or the host it starts (4551): proves nothing.
      if (/os error 4551|code: 4551|Windows error 4551/.test(out)) blocked = true;
      caught.push(
        ...[...out.matchAll(/^---- (\S+) stdout/gm)].map((x) => x[1].replace(/^.*::/, "")),
      );
    }
    verdict = blocked ? "BROKEN" : caught.length ? "caught" : broken ? "BROKEN" : "NOT CAUGHT";
    detail = blocked
      ? "blocked by Smart App Control (4551)"
      : caught.length
        ? caught.slice(0, 3).join(", ")
        : broken
          ? "did not build or run"
          : "";
  } finally {
    const saved = new Map(pending);
    restore();
    for (const [file, bytes] of saved)
      if (!readFileSync(file).equals(bytes)) throw new Error(`${file} was not restored`);
  }
  results.push({ m, verdict, detail });
  console.log(`${m.id} ${m.what}: ${verdict}${detail ? ` (${detail})` : ""}`);
}

const failed = results.filter((r) => r.verdict !== "caught");
console.log(
  `\n${results.length - failed.length} of ${results.length} protections proven by their tests.`,
);
for (const r of failed)
  console.error(`${r.verdict}: ${r.m.id} ${r.m.what}${r.detail ? ` -- ${r.detail}` : ""}`);
process.exit(failed.length ? 1 : 0);
