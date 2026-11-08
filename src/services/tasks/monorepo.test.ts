/**
 * Monorepo and sub-package discovery (WS7 Part 4). These exercise the workspace-declaration parsers
 * (npm/yarn `workspaces`, `pnpm-workspace.yaml`, Cargo `[workspace]`), the bounded glob expansion
 * over an injected directory lister, and the end-to-end sub-package discovery: path-qualified ids
 * that never collide, per-package cwd (so no untrusted name is interpolated into a command), and
 * the inherited package manager.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  discoverWorkspaceTasks,
  loadTaskSources,
  parseCargoWorkspaceGlobs,
  parseNpmWorkspaceGlobs,
  parsePnpmWorkspaceGlobs,
  type DirEntry,
} from "./discovery.ts";

/** A fake filesystem: `files` backs `read`, `dirs` backs `listDir` (children by directory path). */
function fakeFs(files: Record<string, string>, dirs: Record<string, DirEntry[]>) {
  return {
    read: async (p: string): Promise<string | null> => files[p] ?? null,
    listDir: async (p: string): Promise<readonly DirEntry[] | null> => dirs[p] ?? null,
  };
}

const dir = (name: string): DirEntry => ({ name, isDir: true });
const fileEntry = (name: string): DirEntry => ({ name, isDir: false });

// --- declaration parsers -----------------------------------------------------------------------

test("parseNpmWorkspaceGlobs: array, { packages } object, negation, and absence", () => {
  assert.deepEqual(
    parseNpmWorkspaceGlobs(JSON.stringify({ workspaces: ["packages/*", "apps/*"] })),
    {
      include: ["packages/*", "apps/*"],
      exclude: [],
    },
  );
  // Yarn's object form, with an exclusion.
  assert.deepEqual(
    parseNpmWorkspaceGlobs(
      JSON.stringify({ workspaces: { packages: ["packages/*", "!packages/x"] } }),
    ),
    { include: ["packages/*"], exclude: ["packages/x"] },
  );
  // Leading `./` and trailing `/` normalized.
  assert.deepEqual(parseNpmWorkspaceGlobs('{"workspaces":["./libs/"]}'), {
    include: ["libs"],
    exclude: [],
  });
  assert.equal(
    parseNpmWorkspaceGlobs('{"scripts":{"b":"x"}}'),
    null,
    "no workspaces field -> null",
  );
  assert.equal(parseNpmWorkspaceGlobs("not json"), null);
  assert.equal(parseNpmWorkspaceGlobs(undefined), null);
  assert.deepEqual(parseNpmWorkspaceGlobs('{"workspaces":[]}'), { include: [], exclude: [] });
});

test("parsePnpmWorkspaceGlobs: block sequence, inline flow, comments, negation, absence", () => {
  const yaml = "packages:\n  - 'packages/*'\n  - \"tools/*\"  # helpers\n  - '!packages/ignored'\n";
  assert.deepEqual(parsePnpmWorkspaceGlobs(yaml), {
    include: ["packages/*", "tools/*"],
    exclude: ["packages/ignored"],
  });
  assert.deepEqual(parsePnpmWorkspaceGlobs("packages: ['a/*', 'b/*']"), {
    include: ["a/*", "b/*"],
    exclude: [],
  });
  // A following top-level key ends the block.
  const withMore = "packages:\n  - 'packages/*'\ncatalog:\n  react: ^19\n";
  assert.deepEqual(parsePnpmWorkspaceGlobs(withMore)!.include, ["packages/*"]);
  assert.equal(
    parsePnpmWorkspaceGlobs("catalog:\n  react: ^19\n"),
    null,
    "no packages key -> null",
  );
  assert.equal(parsePnpmWorkspaceGlobs(undefined), null);
});

test("parseCargoWorkspaceGlobs: members, exclude, multi-line arrays, and non-workspace manifests", () => {
  assert.deepEqual(
    parseCargoWorkspaceGlobs(
      '[workspace]\nmembers = ["crates/*", "tools/cli"]\nexclude = ["crates/old"]',
    ),
    { include: ["crates/*", "tools/cli"], exclude: ["crates/old"] },
  );
  // members spanning several lines.
  const multi = "[workspace]\nmembers = [\n  'a',\n  'b',\n]\n";
  assert.deepEqual(parseCargoWorkspaceGlobs(multi), { include: ["a", "b"], exclude: [] });
  // A plain package manifest is not a workspace.
  assert.equal(parseCargoWorkspaceGlobs("[package]\nname='x'"), null);
  // `[workspace.metadata]` is a sub-table, not the workspace table's members.
  assert.deepEqual(parseCargoWorkspaceGlobs("[workspace]\n[workspace.metadata]\nmembers=['x']"), {
    include: [],
    exclude: [],
  });
});

// --- end-to-end expansion + discovery ----------------------------------------------------------

test("npm workspaces: each sub-package's scripts become path-qualified tasks that never collide", async () => {
  const { read, listDir } = fakeFs(
    {
      "/w/package.json": JSON.stringify({
        workspaces: ["packages/*"],
        scripts: { build: "turbo run build" },
      }),
      "/w/packages/web/package.json": JSON.stringify({
        name: "@acme/web",
        scripts: { build: "vite build", test: "vitest" },
      }),
      "/w/packages/api/package.json": JSON.stringify({
        name: "@acme/api",
        scripts: { build: "tsc", test: "vitest" },
      }),
    },
    {
      "/w": [dir("packages"), dir("node_modules")],
      "/w/packages": [dir("web"), dir("api"), dir("node_modules")],
    },
  );
  const tasks = await discoverWorkspaceTasks(["/w"], read, listDir);
  const byId = new Map(tasks.map((t) => [t.id, t]));

  // The root's own script stays unqualified.
  assert.equal(byId.get("npm:build")?.command, "npm run build");
  assert.equal(byId.get("npm:build")?.cwd, null);

  // Each package's `build` is a distinct id — no collision between two `build` scripts.
  const web = byId.get("npm:packages.web:build");
  const api = byId.get("npm:packages.api:build");
  assert.ok(web && api, "both packages' build tasks exist");
  assert.equal(web!.command, "npm run build", "no package name interpolated into the command");
  assert.equal(web!.cwd, "/w/packages/web", "runs in its own package directory");
  assert.equal(api!.cwd, "/w/packages/api");
  assert.equal(web!.label, "npm: @acme/web/build", "label shows the declared package name");
  assert.ok(byId.has("npm:packages.web:test") && byId.has("npm:packages.api:test"));
  // node_modules was never descended into.
  assert.ok(!tasks.some((t) => t.id.includes("node_modules")));
});

test("pnpm workspace: members inherit pnpm as their package manager", async () => {
  const { read, listDir } = fakeFs(
    {
      "/w/pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
      "/w/packages/ui/package.json": JSON.stringify({ name: "ui", scripts: { build: "tsup" } }),
    },
    { "/w": [dir("packages")], "/w/packages": [dir("ui")] },
  );
  const tasks = await discoverWorkspaceTasks(["/w"], read, listDir);
  const ui = tasks.find((t) => t.id === "npm:packages.ui:build");
  assert.ok(ui, "the pnpm member was discovered");
  assert.equal(ui!.command, "pnpm run build", "a package in a pnpm workspace runs via pnpm");
  assert.equal(ui!.label, "pnpm: ui/build");
});

test("yarn workspace: members inherit yarn from the root's lockfile", async () => {
  const { read, listDir } = fakeFs(
    {
      "/w/package.json": JSON.stringify({ workspaces: ["pkgs/*"] }),
      "/w/yarn.lock": "# yarn lockfile",
      "/w/pkgs/core/package.json": JSON.stringify({ name: "core", scripts: { lint: "eslint ." } }),
    },
    { "/w": [dir("pkgs")], "/w/pkgs": [dir("core")] },
  );
  const tasks = await discoverWorkspaceTasks(["/w"], read, listDir);
  assert.equal(
    tasks.find((t) => t.id === "npm:pkgs.core:lint")?.command,
    "yarn run lint",
    "members follow the root's yarn lockfile",
  );
});

test("a member may pin its own package manager, overriding the inherited one", async () => {
  const { read, listDir } = fakeFs(
    {
      "/w/pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
      "/w/packages/legacy/package.json": JSON.stringify({
        name: "legacy",
        packageManager: "yarn@1.22.0",
        scripts: { build: "gulp" },
      }),
    },
    { "/w": [dir("packages")], "/w/packages": [dir("legacy")] },
  );
  const tasks = await discoverWorkspaceTasks(["/w"], read, listDir);
  assert.equal(
    tasks.find((t) => t.id === "npm:packages.legacy:build")?.command,
    "yarn run build",
    "the member's own packageManager field wins over the inherited pnpm",
  );
});

test("Cargo workspace: each member crate offers cargo tasks that build in its own directory", async () => {
  const { read, listDir } = fakeFs(
    {
      "/w/Cargo.toml": "[workspace]\nmembers = ['crates/*']\nexclude = ['crates/scratch']",
      "/w/crates/core/Cargo.toml": "[package]\nname = 'core'",
      "/w/crates/cli/Cargo.toml": '[package]\nname = "cli"',
      "/w/crates/scratch/Cargo.toml": "[package]\nname = 'scratch'",
    },
    {
      "/w": [dir("crates")],
      "/w/crates": [dir("core"), dir("cli"), dir("scratch"), dir("target")],
    },
  );
  const tasks = await discoverWorkspaceTasks(["/w"], read, listDir);
  const ids = tasks.map((t) => t.id);
  // The virtual root builds the whole workspace; each member builds itself.
  assert.ok(ids.includes("cargo:build"), "the workspace root offers cargo tasks");
  const core = tasks.find((t) => t.id === "cargo:crates.core:build");
  assert.ok(core, "the core crate's build task");
  assert.equal(core!.cwd, "/w/crates/core", "builds in the crate's own directory");
  assert.equal(core!.label, "cargo: core/build", "label shows the crate name");
  assert.ok(ids.includes("cargo:crates.cli:build"));
  // The excluded crate contributes nothing.
  assert.ok(!ids.some((id) => id.includes("scratch")), "excluded member is skipped");
});

test("nested and literal members; target/.git are never traversed", async () => {
  const { read, listDir } = fakeFs(
    {
      "/w/package.json": JSON.stringify({ workspaces: ["apps/*/pkg", "tools/cli"] }),
      "/w/apps/one/pkg/package.json": JSON.stringify({ name: "one", scripts: { build: "x" } }),
      "/w/tools/cli/package.json": JSON.stringify({ name: "cli", scripts: { build: "y" } }),
    },
    {
      "/w": [dir("apps"), dir("tools"), dir(".git"), dir("target")],
      "/w/apps": [dir("one"), dir("two")],
      "/w/apps/one": [dir("pkg")],
      "/w/apps/two": [], // no pkg -> matches nothing
      "/w/tools": [dir("cli")],
    },
  );
  const tasks = await discoverWorkspaceTasks(["/w"], read, listDir);
  const ids = tasks.map((t) => t.id);
  assert.ok(ids.includes("npm:apps.one.pkg:build"), "a deep nested member resolves");
  assert.ok(ids.includes("npm:tools.cli:build"), "a literal member path resolves");
  assert.ok(!ids.some((id) => id.includes("git") || id.includes("target")));
});

test("multi-root monorepos: member keys are prefixed by their root so they stay distinct", async () => {
  const { read, listDir } = fakeFs(
    {
      "/w/front/package.json": JSON.stringify({ workspaces: ["packages/*"] }),
      "/w/front/packages/ui/package.json": JSON.stringify({ name: "ui", scripts: { build: "a" } }),
      "/w/back/package.json": JSON.stringify({ workspaces: ["packages/*"] }),
      "/w/back/packages/ui/package.json": JSON.stringify({ name: "ui", scripts: { build: "b" } }),
    },
    {
      "/w/front": [dir("packages")],
      "/w/front/packages": [dir("ui")],
      "/w/back": [dir("packages")],
      "/w/back/packages": [dir("ui")],
    },
  );
  const tasks = await discoverWorkspaceTasks(["/w/front", "/w/back"], read, listDir);
  const ids = tasks.map((t) => t.id);
  // Two packages both named `ui` under different roots must not collide.
  assert.ok(ids.includes("npm:front.packages.ui:build"));
  assert.ok(ids.includes("npm:back.packages.ui:build"));
  assert.equal(new Set(ids).size, ids.length, "all ids are unique");
});

test("a member that coincides with a declared root is not discovered twice", async () => {
  const { read, listDir } = fakeFs(
    {
      "/w/package.json": JSON.stringify({ workspaces: ["packages/*"] }),
      "/w/packages/web/package.json": JSON.stringify({ name: "web", scripts: { build: "x" } }),
    },
    { "/w": [dir("packages")], "/w/packages": [dir("web")] },
  );
  // The same package is also opened as its own root folder.
  const sources = await loadTaskSources(["/w", "/w/packages/web"], read, listDir);
  const webSources = sources.filter((s) => s.folder === "/w/packages/web");
  assert.equal(webSources.length, 1, "the explicit root wins; the member is not added again");
});

test("without a directory lister, discovery stays at the root (no monorepo expansion)", async () => {
  const { read } = fakeFs(
    {
      "/w/package.json": JSON.stringify({ workspaces: ["packages/*"], scripts: { build: "x" } }),
      "/w/packages/web/package.json": JSON.stringify({ name: "web", scripts: { build: "y" } }),
    },
    {},
  );
  const tasks = await discoverWorkspaceTasks(["/w"], read); // no listDir
  assert.deepEqual(
    tasks.map((t) => t.id),
    ["npm:build"],
    "only the root's own scripts, no sub-packages",
  );
});

test("expansion is bounded and tolerates a listing that returns files and ignored dirs", async () => {
  // A wildcard directory whose entries mix files and an ignored dir; only real subdirs match.
  const { read, listDir } = fakeFs(
    {
      "/w/package.json": JSON.stringify({ workspaces: ["packages/*"] }),
      "/w/packages/a/package.json": JSON.stringify({ name: "a", scripts: { build: "x" } }),
    },
    {
      "/w": [dir("packages")],
      "/w/packages": [dir("a"), fileEntry("README.md"), dir("node_modules")],
    },
  );
  const tasks = await discoverWorkspaceTasks(["/w"], read, listDir);
  const ids = tasks.map((t) => t.id);
  assert.deepEqual(ids, ["npm:packages.a:build"], "only the real sub-package directory matched");
});
