import assert from "node:assert/strict";
import test from "node:test";
import {
  DISCOVERY_FILES,
  detectPackageManager,
  discoverTasks,
  discoverWorkspaceTasks,
  isDiscoveryFile,
  loadTaskSources,
  parseCargoTasks,
  parseMakefileTargets,
  parseNpmScripts,
  type TaskSource,
} from "./discovery.ts";

function source(over: Partial<TaskSource>): TaskSource {
  return { key: "root", folder: "/w", multiRoot: false, ...over };
}

test("npm scripts become discovered tasks with stable ids and inferred groups", () => {
  const tasks = parseNpmScripts(
    source({
      packageJson: JSON.stringify({
        scripts: { build: "tsc -p .", test: "vitest run", start: "node ." },
      }),
    }),
  );
  assert.deepEqual(
    tasks.map((t) => t.id),
    ["npm:build", "npm:test", "npm:start"],
    "ids are deterministic and script-ordered",
  );
  const build = tasks.find((t) => t.id === "npm:build")!;
  assert.equal(build.command, "npm run build");
  assert.equal(build.scope, "discovered");
  assert.equal(build.group, "build");
  assert.deepEqual(build.args, [], "a discovered task has no separate args to interpolate");
  assert.deepEqual(build.problemMatcher, ["tsc"], "tsc inferred from the script command");
  assert.equal(tasks.find((t) => t.id === "npm:test")!.group, "test");
  assert.equal(tasks.find((t) => t.id === "npm:start")!.group, null);
});

test("invalid or empty package.json yields no tasks, never an error", () => {
  assert.deepEqual(parseNpmScripts(source({ packageJson: "not json" })), []);
  assert.deepEqual(parseNpmScripts(source({ packageJson: "{}" })), []);
  assert.deepEqual(parseNpmScripts(source({ packageJson: JSON.stringify({ scripts: [] }) })), []);
  assert.deepEqual(parseNpmScripts(source({})), [], "no package.json -> nothing");
  // A non-string script value is skipped.
  const mixed = parseNpmScripts(
    source({ packageJson: JSON.stringify({ scripts: { ok: "echo hi", bad: 5 } }) }),
  );
  assert.deepEqual(
    mixed.map((t) => t.id),
    ["npm:ok"],
  );
});

test("cargo presence offers the fixed safe subcommands (nothing executed)", () => {
  const tasks = parseCargoTasks(source({ cargoToml: "[package]\nname='x'" }));
  assert.deepEqual(
    tasks.map((t) => t.id),
    ["cargo:build", "cargo:test", "cargo:check", "cargo:clippy", "cargo:run"],
  );
  assert.equal(tasks.find((t) => t.id === "cargo:test")!.command, "cargo test");
  assert.equal(tasks.find((t) => t.id === "cargo:clippy")!.command, "cargo clippy");
  assert.deepEqual(tasks[0]!.problemMatcher, ["cargo"]);
  assert.deepEqual(parseCargoTasks(source({})), [], "no Cargo.toml -> nothing");
});

test("Makefile targets are parsed from text; variables, patterns and .directives are skipped", () => {
  const makefile = [
    "CC = gcc", // variable, not a target
    "build: deps", // a real target (with a prereq)
    "\tgcc -o app", // recipe line (tab) — ignored
    "test:", // a real target
    ".PHONY: build test", // dot-directive — skipped
    "%.o: %.c", // pattern rule — skipped",
    "build: again", // duplicate — first wins
  ].join("\n");
  const tasks = parseMakefileTargets(source({ makefile }));
  assert.deepEqual(
    tasks.map((t) => t.id),
    ["make:build", "make:test"],
  );
  assert.equal(tasks[0]!.command, "make build");
  assert.deepEqual(parseMakefileTargets(source({})), []);
});

test("multi-root workspaces get folder-qualified ids, labels and cwds", () => {
  const tasks = parseNpmScripts(
    source({
      key: "web",
      folder: "/w/web",
      multiRoot: true,
      packageJson: JSON.stringify({ scripts: { build: "tsc" } }),
    }),
  );
  assert.equal(tasks[0]!.id, "npm:web:build", "id is folder-qualified so roots never collide");
  assert.equal(tasks[0]!.label, "npm: web/build");
  assert.equal(tasks[0]!.cwd, "/w/web", "runs in its own folder");
});

test("discoverTasks merges sources, de-duplicates by id, in a stable order", () => {
  const tasks = discoverTasks([
    source({
      packageJson: JSON.stringify({ scripts: { build: "tsc" } }),
      cargoToml: "[package]",
      makefile: "all:\n\techo",
    }),
  ]);
  const ids = tasks.map((t) => t.id);
  assert.ok(ids.includes("npm:build") && ids.includes("cargo:build") && ids.includes("make:all"));
  // npm before cargo before make, per folder.
  assert.ok(ids.indexOf("npm:build") < ids.indexOf("cargo:build"));
  assert.ok(ids.indexOf("cargo:build") < ids.indexOf("make:all"));
  // Idempotent / deterministic.
  assert.deepEqual(
    discoverTasks([source({ cargoToml: "[package]" })]).map((t) => t.id),
    ["cargo:build", "cargo:test", "cargo:check", "cargo:clippy", "cargo:run"],
  );
});

test("the loader reads only the fixed convention files and discovers across roots", async () => {
  const files: Record<string, string> = {
    "/w/web/package.json": JSON.stringify({ scripts: { build: "tsc" } }),
    "/w/api/Cargo.toml": "[package]",
    "/w/api/Makefile": "deploy:\n\techo",
  };
  const read = async (path: string): Promise<string | null> => files[path] ?? null;
  // Only the fixed discovery files (manifests, Makefile variants, lockfiles) are ever requested.
  const requested: string[] = [];
  const tracking = async (path: string) => {
    requested.push(path);
    return read(path);
  };
  const sources = await loadTaskSources(["/w/web", "/w/api"], tracking);
  assert.ok(
    requested.every((p) => (DISCOVERY_FILES as readonly string[]).includes(p.split("/").pop()!)),
    "only the fixed discovery files are read, nothing else",
  );
  assert.equal(sources.length, 2);
  assert.ok(
    sources.every((s) => s.multiRoot),
    "two roots -> multiRoot",
  );

  const tasks = await discoverWorkspaceTasks(["/w/web", "/w/api"], read);
  const ids = tasks.map((t) => t.id);
  assert.ok(ids.includes("npm:web:build"), "web's script, folder-qualified");
  assert.ok(ids.includes("cargo:api:build") && ids.includes("make:api:deploy"), "api's tasks");
});

test("a script name with control characters is refused (nothing odd reaches the shell line)", () => {
  const tasks = parseNpmScripts(
    source({ packageJson: JSON.stringify({ scripts: { ok: "echo", "ba\nd": "echo" } }) }),
  );
  assert.deepEqual(
    tasks.map((t) => t.id),
    ["npm:ok"],
  );
});

// --- WS7 Part 2: hardening + edge-case coverage ------------------------------------------------

test("Makefile: colon assignments (:=, ::=) and other assignments are not targets", () => {
  const makefile = [
    "VAR := value", // simple-expanded assignment
    "OTHER ::= value", // GNU ::= assignment — must not become a target
    "COND ?= value", // conditional assignment (no colon)
    "APPEND += value", // append (no colon)
    "SHELLVAR != echo hi", // shell assignment (no colon)
    "real: dep", // a genuine target
  ].join("\n");
  assert.deepEqual(
    parseMakefileTargets(source({ makefile })).map((t) => t.id),
    ["make:real"],
  );
});

test("Makefile: double-colon rules are targets; pattern and special targets are not", () => {
  const makefile = [
    "clean:: ", // a double-colon rule — a real target
    "%.o: %.c", // pattern rule — skipped
    ".PHONY: clean", // dot-directive — skipped
    ".DEFAULT_GOAL := all", // dot-directive assignment — skipped
    "\tbuild-recipe-line:", // tab-indented recipe — skipped",
  ].join("\n");
  assert.deepEqual(
    parseMakefileTargets(source({ makefile })).map((t) => t.id),
    ["make:clean"],
  );
});

test("Makefile: comments and inline comments are handled", () => {
  const makefile = [
    "# build: this is a comment, not a target",
    "build: ## help: build the project", // inline comment after a real target
  ].join("\n");
  assert.deepEqual(
    parseMakefileTargets(source({ makefile })).map((t) => t.id),
    ["make:build"],
  );
});

test("Makefile: empty or targetless files yield nothing", () => {
  assert.deepEqual(parseMakefileTargets(source({ makefile: "" })), []);
  assert.deepEqual(parseMakefileTargets(source({ makefile: "CC = gcc\n.PHONY: all\n" })), []);
});

test("discovery is stable: repeated runs produce identical ids in identical order", () => {
  const s = source({
    packageJson: JSON.stringify({ scripts: { lint: "eslint .", build: "tsc" } }),
    cargoToml: "[package]",
    makefile: "deploy:\n\techo\npackage:\n\techo",
  });
  const a = discoverTasks([s]).map((t) => t.id);
  const b = discoverTasks([s]).map((t) => t.id);
  assert.deepEqual(a, b, "deterministic across runs");
  // The documented order: npm (script order), then cargo, then make (file order).
  assert.deepEqual(a.slice(0, 2), ["npm:lint", "npm:build"]);
  assert.ok(a.indexOf("cargo:build") < a.indexOf("make:deploy"));
  assert.ok(a.indexOf("make:deploy") < a.indexOf("make:package"), "make targets keep file order");
});

test("same task name from different sources does not collide (distinct ids)", () => {
  // npm `build`, cargo `build`, make `build` all coexist as npm:build / cargo:build / make:build.
  const tasks = discoverTasks([
    source({
      packageJson: JSON.stringify({ scripts: { build: "tsc" } }),
      cargoToml: "[package]",
      makefile: "build:\n\techo",
    }),
  ]);
  const builds = tasks.filter((t) => t.id.endsWith(":build")).map((t) => t.id);
  assert.deepEqual(builds.sort(), ["cargo:build", "make:build", "npm:build"]);
});

test("a Cargo manifest with [package]/[workspace] offers tasks even when otherwise malformed", () => {
  // Discovery never runs Cargo.toml; a manifest declaring a package, even with errors elsewhere,
  // still offers `cargo build` etc. (which surface the real error when run) — no execution.
  const tasks = parseCargoTasks(source({ cargoToml: "[package]\nname = this is not valid {{{" }));
  assert.equal(tasks.length, 5);
  assert.equal(tasks[0]!.id, "cargo:build");
  // A virtual workspace manifest counts too.
  assert.equal(parseCargoTasks(source({ cargoToml: "[workspace]\nmembers=[]" })).length, 5);
});

test("a file named Cargo.toml that is not a manifest offers nothing", () => {
  // Robust against a read that returns unrelated content (a stray file, or a mock): no `[package]`
  // or `[workspace]` means it is not treated as a Rust project.
  assert.deepEqual(parseCargoTasks(source({ cargoToml: "line 1\nline 2\nline 3" })), []);
  assert.deepEqual(parseCargoTasks(source({ cargoToml: "" })), []);
});

test("duplicate script names within one package.json: last definition wins (JSON semantics)", () => {
  // JSON objects cannot have duplicate keys meaningfully; JSON.parse keeps the last. Discovery is
  // deterministic regardless.
  const tasks = parseNpmScripts(source({ packageJson: '{"scripts":{"t":"a","t":"b"}}' }));
  assert.deepEqual(
    tasks.map((t) => t.id),
    ["npm:t"],
  );
  assert.equal(tasks[0]!.command, "npm run t");
});

// --- WS7 Part 3: package-manager detection -----------------------------------------------------

const pkg = (scripts: Record<string, string>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ scripts, ...extra });

test("package-manager precedence: packageManager field wins over lockfiles", () => {
  const s = source({
    packageJson: pkg({ build: "tsc" }, { packageManager: "pnpm@8.1.0" }),
    yarnLock: true,
    packageLock: true,
  });
  const choice = detectPackageManager(s);
  assert.equal(choice.manager, "pnpm");
  assert.equal(choice.from, "packageManager");
  // The command reflects the manager; the id stays stable (`npm:build`).
  const build = parseNpmScripts(s).find((t) => t.id === "npm:build")!;
  assert.equal(build.command, "pnpm run build");
  assert.equal(build.label, "pnpm: build");
  assert.equal(build.id, "npm:build", "id is independent of the package manager");
});

test("package-manager from a single lockfile", () => {
  assert.equal(detectPackageManager(source({ pnpmLock: true })).manager, "pnpm");
  assert.equal(detectPackageManager(source({ yarnLock: true })).manager, "yarn");
  assert.equal(detectPackageManager(source({ packageLock: true })).manager, "npm");
  assert.equal(detectPackageManager(source({ packageLock: true })).from, "lockfile");
  assert.equal(
    parseNpmScripts(source({ packageJson: pkg({ dev: "vite" }), yarnLock: true }))[0]!.command,
    "yarn run dev",
  );
});

test("no signal defaults to npm; conflicting lockfiles are ambiguous (npm fallback, no guess)", () => {
  assert.deepEqual(detectPackageManager(source({})), { manager: "npm", from: "default" });
  // Two lockfiles, no packageManager field: Yavin does not guess pnpm vs yarn — it falls back to
  // the universal npm and reports the ambiguity rather than inventing a command.
  const ambiguous = detectPackageManager(source({ pnpmLock: true, yarnLock: true }));
  assert.equal(ambiguous.manager, "npm");
  assert.equal(ambiguous.from, "ambiguous");
});

test("an unknown packageManager value is ignored, falling through to lockfiles", () => {
  const s = source({ packageJson: pkg({ b: "x" }, { packageManager: "bun@1.0" }), pnpmLock: true });
  assert.equal(detectPackageManager(s).manager, "pnpm", "unknown field ignored, lockfile used");
});

test("task ids are stable across a package-manager change (only the command changes)", () => {
  const scripts = { build: "tsc", test: "vitest" };
  const npm = parseNpmScripts(source({ packageJson: pkg(scripts), packageLock: true }));
  const pnpm = parseNpmScripts(source({ packageJson: pkg(scripts), pnpmLock: true }));
  assert.deepEqual(
    npm.map((t) => t.id),
    pnpm.map((t) => t.id),
    "ids identical across managers",
  );
  assert.equal(npm[0]!.command, "npm run build");
  assert.equal(pnpm[0]!.command, "pnpm run build");
});

test("isDiscoveryFile recognises manifests, Makefile variants and lockfiles by basename", () => {
  for (const name of DISCOVERY_FILES) assert.ok(isDiscoveryFile(`/w/some/${name}`), name);
  // The native watcher delivers forward-slash paths; backslash is handled defensively.
  const bs = String.fromCharCode(92);
  assert.ok(isDiscoveryFile(`C:${bs}w${bs}package.json`), "handles backslash paths");
  assert.ok(!isDiscoveryFile("/w/src/index.ts"), "an unrelated file is not a discovery file");
  assert.ok(!isDiscoveryFile("/w/package.json.bak"));
});

test("Makefile variant precedence: GNUmakefile, then makefile, then Makefile", async () => {
  const files: Record<string, string> = {
    "/w/GNUmakefile": "gnu:\n\techo",
    "/w/makefile": "lower:\n\techo",
    "/w/Makefile": "upper:\n\techo",
  };
  const tasks = await discoverWorkspaceTasks(["/w"], async (p) => files[p] ?? null);
  assert.deepEqual(
    tasks.map((t) => t.id),
    ["make:gnu"],
    "GNUmakefile wins, as make itself chooses",
  );
});
