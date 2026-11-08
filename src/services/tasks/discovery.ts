/**
 * Task discovery (WS7): read a workspace's project conventions and present them as runnable tasks,
 * **without executing anything** — package.json is parsed as JSON, a Cargo.toml's mere presence
 * offers the fixed `cargo` subcommands, and a Makefile's targets are read from its text. Discovery
 * never runs a build tool or a config script; it only reads files.
 *
 * Discovered tasks are ordinary {@link ResolvedTask}s with `scope: "discovered"`, so they flow
 * through the existing TaskService (dependencies, matchers, terminals, trust) and the existing Run
 * Task UI unchanged — a user or workspace task of the same id overrides a discovered one.
 *
 * Ids are **stable and deterministic**: `<source>:<name>` (e.g. `npm:build`, `cargo:test`,
 * `make:all`), prefixed with the folder when a multi-root workspace would otherwise collide
 * (`npm:web:build`). The command is a shell line exactly as typed at a prompt; a discovered task's
 * `args` are always empty (the command carries everything), so nothing is interpolated.
 */
import { DEFAULT_PRESENTATION, type ResolvedTask, type TaskGroup } from "./model.ts";
import { MATCHERS } from "../panel/problemMatchers.ts";
import { applyPackageDependencies } from "./packageGraph.ts";

/** One workspace folder's discovery inputs — the file contents (absent when the file is missing). */
export interface TaskSource {
  /**
   * A short, stable, **id-safe** key for this source, used to qualify ids so they never collide:
   * a root folder's basename (`web`), or, for a monorepo sub-package (WS7 Part 4), its
   * workspace-relative path with separators folded to `.` (`packages.web`). It is identity, not a
   * display name — it never changes when a package's declared `name` does.
   */
  readonly key: string;
  /** The folder path, used as a discovered task's cwd when its ids are qualified. */
  readonly folder: string;
  /**
   * Whether this source's ids, labels and cwd are **qualified** by its {@link key}. True for every
   * root of a multi-root workspace and for every monorepo sub-package; false for the sole root of a
   * single-root workspace (its ids stay bare, `npm:build`). The field name is historical — it means
   * "qualified", which a sub-package always is even inside one root.
   */
  readonly multiRoot: boolean;
  /** A monorepo sub-package's declared name (package.json `name`, or Cargo `[package] name`), for
   * display only — never used to build a command or an id. Absent for a plain root folder. */
  readonly packageName?: string;
  /** A monorepo sub-package's path relative to its workspace root (`packages/web`), for display. */
  readonly relPath?: string;
  /** The workspace **root** this source belongs to (its own folder for a root source; the owning
   * root for a sub-package). Used to keep a monorepo's dependency graph isolated per root — a
   * package never depends on a same-named package under a *different* root (WS7 Part 6). */
  readonly root?: string;
  readonly packageJson?: string;
  readonly cargoToml?: string;
  readonly makefile?: string;
  /** Lockfile presence, for package-manager detection (WS7 Part 3). */
  readonly packageLock?: boolean;
  readonly pnpmLock?: boolean;
  readonly yarnLock?: boolean;
  /** The package manager a monorepo sub-package inherits from its workspace root when it has no
   * signal of its own (WS7 Part 4) — a package inside a pnpm/yarn workspace rarely has a lockfile. */
  readonly inheritedManager?: PackageManager;
}

/** The package managers whose scripts Yavin runs, plus a baseline fallback. */
export type PackageManager = "npm" | "pnpm" | "yarn";

export interface PackageManagerChoice {
  readonly manager: PackageManager;
  /** How it was chosen: the `packageManager` field, a lockfile, inherited from a monorepo root, the
   * baseline, or an ambiguous fallback (conflicting lockfiles with no `packageManager` field). */
  readonly from: "packageManager" | "lockfile" | "inherited" | "default" | "ambiguous";
}

/**
 * Which package manager runs a folder's npm scripts — from the project's **files**, never from
 * whichever executable happens to be installed (WS7 Part 3). Deterministic precedence:
 * 1. the `packageManager` field in package.json (Corepack's explicit declaration),
 * 2. a single lockfile (`pnpm-lock.yaml`→pnpm, `yarn.lock`→yarn, `package-lock.json`→npm),
 * 3. no signal → the baseline `npm` (which runs any project's scripts),
 * 4. conflicting lockfiles with no field → `ambiguous`: Yavin does not guess pnpm vs yarn and
 *    falls back to the universal `npm` rather than inventing a command, exposing the state.
 */
export function detectPackageManager(source: TaskSource): PackageManagerChoice {
  const declared = packageManagerField(source.packageJson);
  if (declared) return { manager: declared, from: "packageManager" };
  const locks: PackageManager[] = [];
  if (source.pnpmLock) locks.push("pnpm");
  if (source.yarnLock) locks.push("yarn");
  if (source.packageLock) locks.push("npm");
  if (locks.length === 1) return { manager: locks[0]!, from: "lockfile" };
  // A sub-package with no signal of its own follows the workspace root it belongs to.
  if (source.inheritedManager) return { manager: source.inheritedManager, from: "inherited" };
  if (locks.length > 1) return { manager: "npm", from: "ambiguous" };
  return { manager: "npm", from: "default" };
}

/** The `packageManager` field (`"pnpm@8.1.0"`) when it names a manager Yavin runs, else null. */
function packageManagerField(packageJson: string | undefined): PackageManager | null {
  if (!packageJson) return null;
  try {
    const value = (JSON.parse(packageJson) as { packageManager?: unknown }).packageManager;
    if (typeof value !== "string") return null;
    const name = value.split("@")[0]!.trim().toLowerCase();
    return name === "npm" || name === "pnpm" || name === "yarn" ? name : null;
  } catch {
    return null;
  }
}

const base = (
  over: Partial<ResolvedTask> & Pick<ResolvedTask, "id" | "label" | "command">,
): ResolvedTask => ({
  args: [],
  cwd: null,
  env: {},
  profile: null,
  dependsOn: [],
  group: null,
  isDefault: false,
  problemMatcher: [],
  presentation: DEFAULT_PRESENTATION,
  scope: "discovered",
  ...over,
});

/**
 * `<source>:<name>`, folder-qualified for a multi-root workspace (or a sub-package) so ids never
 * collide — the **single source of truth** for a discovered task's id shape, reused by the
 * package-dependency graph (WS7 Part 6) so its edges name the exact same task ids.
 */
export function discoveredTaskId(
  source: Pick<TaskSource, "multiRoot" | "key">,
  kind: string,
  name: string,
): string {
  return source.multiRoot ? `${kind}:${source.key}:${name}` : `${kind}:${name}`;
}
const idFor = discoveredTaskId;

/** The cwd for a folder's tasks: its own folder when its ids are qualified, else the single root. */
const cwdFor = (source: TaskSource): string | null => (source.multiRoot ? source.folder : null);

/** The human-readable qualifier shown in a qualified task's label: a sub-package's declared name or
 * relative path when known, else the id-safe {@link TaskSource.key}. */
const labelPrefix = (source: TaskSource): string =>
  source.packageName ?? source.relPath ?? source.key;

/** A problem matcher inferred from a command line, when it clearly runs a known tool; else none. */
function matchersFor(command: string): string[] {
  const found: string[] = [];
  for (const id of ["tsc", "eslint", "cargo", "ruff"]) {
    // `tsc`/`eslint`/`cargo`/`ruff` as a whole word in the command.
    if (id in MATCHERS && new RegExp(`(^|[\\s/\\\\])${id}([\\s]|$)`).test(command)) found.push(id);
  }
  return found;
}

/** npm scripts from a package.json. Invalid JSON or no `scripts` yields nothing (not an error). */
export function parseNpmScripts(source: TaskSource): ResolvedTask[] {
  if (!source.packageJson) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.packageJson);
  } catch {
    return [];
  }
  const scripts =
    parsed && typeof parsed === "object" ? (parsed as { scripts?: unknown }).scripts : undefined;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) return [];
  // The detected package manager decides the command (`npm`/`pnpm`/`yarn run <name>`) and the
  // label; the task **id stays `npm:<name>`** regardless, so identity is stable across a manager
  // change (a lockfile added or swapped).
  const pm = detectPackageManager(source).manager;
  const out: ResolvedTask[] = [];
  // `Object.keys` preserves insertion order — discovery is deterministic for a given file.
  for (const name of Object.keys(scripts)) {
    const script = (scripts as Record<string, unknown>)[name];
    if (typeof script !== "string") continue;
    // A script name is only used in `<pm> run <name>`, which the manager itself validates; reject
    // control characters defensively so nothing odd reaches the shell line.
    if (/[\u0000-\u001f\u007f]/.test(name) || !name.trim()) continue;
    const command = `${pm} run ${name}`;
    const group: TaskGroup | null =
      name === "build" ? "build" : /(^|[:_-])(test|tests)([:_-]|$)/.test(name) ? "test" : null;
    out.push(
      base({
        id: idFor(source, "npm", name),
        label: source.multiRoot ? `${pm}: ${labelPrefix(source)}/${name}` : `${pm}: ${name}`,
        command,
        cwd: cwdFor(source),
        group,
        problemMatcher: matchersFor(script),
      }),
    );
  }
  return out;
}

/**
 * The fixed, safe Cargo subcommands offered when a **Cargo manifest** is present (nothing is
 * executed or deeply parsed). A real `Cargo.toml` always declares a `[package]` or a `[workspace]`;
 * requiring one of those avoids treating an unrelated or garbage file named `Cargo.toml` as a Rust
 * project. A manifest with those sections but errors elsewhere still offers the tasks, which
 * surface the real build error when run.
 */
export function parseCargoTasks(source: TaskSource): ResolvedTask[] {
  if (source.cargoToml === undefined || !/^\s*\[(package|workspace)\b/m.test(source.cargoToml))
    return [];
  const commands: { name: string; group: TaskGroup | null }[] = [
    { name: "build", group: "build" },
    { name: "test", group: "test" },
    { name: "check", group: "build" },
    { name: "clippy", group: null },
    { name: "run", group: null },
  ];
  return commands.map(({ name, group }) =>
    base({
      id: idFor(source, "cargo", name),
      label: source.multiRoot ? `cargo: ${labelPrefix(source)}/${name}` : `cargo: ${name}`,
      command: name === "clippy" ? "cargo clippy" : `cargo ${name}`,
      cwd: cwdFor(source),
      group,
      problemMatcher: ["cargo"],
    }),
  );
}

/**
 * Makefile targets, read from the file's text. A target is a line `name:` at column 0 where `name`
 * is an ordinary identifier (letters, digits, `_`, `.`, `-`) — not a variable assignment (`=`),
 * not a pattern rule (`%`), and not a dot-directive (`.PHONY`). First definition wins; duplicates
 * and special targets are skipped.
 */
export function parseMakefileTargets(source: TaskSource): ResolvedTask[] {
  if (source.makefile === undefined) return [];
  const seen = new Set<string>();
  const out: ResolvedTask[] = [];
  for (const line of source.makefile.split(/\r?\n/)) {
    // A rule begins at column 0 with an ordinary identifier name, then one or more colons (a
    // double-colon rule is real), then its prerequisites. The `^[A-Za-z0-9_]` anchor already
    // rejects recipe lines (tab-indented), comments (`#…`), pattern rules (`%.o:`) and
    // `.directives` (`.PHONY:`). Matching the whole colon run and checking what follows rejects
    // every colon assignment — `:=`, `::=` — robustly (a lookahead would backtrack on `::=`).
    const match = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)[\t ]*(:+)(.*)$/.exec(line);
    if (!match) continue;
    const [, name, , rest] = match;
    if (rest!.startsWith("=")) continue; // a colon assignment (`:=` / `::=`), not a target
    if (name!.startsWith(".") || seen.has(name!)) continue; // special target / duplicate
    seen.add(name!);
    out.push(
      base({
        id: idFor(source, "make", name!),
        label: source.multiRoot ? `make: ${labelPrefix(source)}/${name}` : `make: ${name}`,
        command: `make ${name}`,
        cwd: cwdFor(source),
      }),
    );
  }
  return out;
}

/**
 * All discovered tasks across a workspace's folders, de-duplicated by id (first wins), in a stable
 * order (npm, then Cargo, then Make, per folder). Pure: give it the file contents and it never
 * touches the filesystem or runs anything.
 */
export function discoverTasks(sources: readonly TaskSource[]): ResolvedTask[] {
  const byId = new Map<string, ResolvedTask>();
  for (const source of sources) {
    for (const task of [
      ...parseNpmScripts(source),
      ...parseCargoTasks(source),
      ...parseMakefileTargets(source),
    ]) {
      if (!byId.has(task.id)) byId.set(task.id, task);
    }
  }
  return [...byId.values()];
}

/** Reads a workspace-relative file's text, or resolves `null` when it is missing/unreadable. */
export type TaskFileReader = (path: string) => Promise<string | null>;

const basename = (folder: string): string =>
  folder
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() || folder;
const childPath = (folder: string, name: string): string =>
  `${folder.replace(/[\\/]+$/, "")}/${name}`;

/**
 * The exact files discovery reads per folder — fixed and known, never anything the renderer names
 * and never executed. The Makefile is matched case-by-name as make itself does (`GNUmakefile`,
 * then `makefile`, then `Makefile`); lockfiles are read only to know which package manager runs
 * the scripts (their contents are not parsed).
 */
export const DISCOVERY_FILES = [
  "package.json",
  "Cargo.toml",
  "GNUmakefile",
  "makefile",
  "Makefile",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  // A pnpm monorepo declares its members here; a change to it adds/removes sub-package tasks.
  "pnpm-workspace.yaml",
] as const;

/** Whether a changed file's path is one discovery reads (by basename) — the watch filter. */
export function isDiscoveryFile(path: string): boolean {
  const name = basename(path);
  return (DISCOVERY_FILES as readonly string[]).includes(name);
}

// ---------------------------------------------------------------------------------------------
// Monorepo and sub-package discovery (WS7 Part 4)
//
// A workspace root can declare sub-packages — npm/yarn `workspaces`, a `pnpm-workspace.yaml`, or a
// Cargo `[workspace] members`. We parse those **declarations only** (never executing a config),
// expand their directory globs against the real tree with a bounded, injected directory lister
// (which skips `node_modules`/`target`/`.git`), and discover each sub-package's tasks the same way
// a root's are discovered. A sub-package's ids and cwd are qualified by its workspace-relative path
// so two packages that both have a `build` script never collide, and each task runs in its own
// package directory — so the right package's scripts run **without interpolating the package's
// (untrusted) name into any command**.
// ---------------------------------------------------------------------------------------------

/** The include/exclude directory globs a workspace root declares (paths relative to the root). */
export interface WorkspaceGlobs {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

/** A directory entry from the injected lister — only the name and whether it is a directory. */
export interface DirEntry {
  readonly name: string;
  readonly isDir: boolean;
}

/** Lists a directory's immediate children, or resolves `null`/`[]` when it is missing/unreadable.
 * Injected so discovery stays testable and never touches the filesystem itself; in the app it is
 * backed by the native, workspace-confined listing. */
export type DirLister = (path: string) => Promise<readonly DirEntry[] | null>;

/** Strip a leading `./` and any trailing slashes from a declared glob. */
const normalizeGlob = (p: string): string =>
  p
    .trim()
    .replace(/^\.\//, "")
    .replace(/[\\/]+$/, "");

/** Split declared patterns into include/exclude (a leading `!` negates), normalizing each. */
function splitGlobPatterns(patterns: readonly string[]): WorkspaceGlobs {
  const include: string[] = [];
  const exclude: string[] = [];
  for (const raw of patterns) {
    const p = raw.trim();
    if (!p) continue;
    if (p.startsWith("!")) {
      const g = normalizeGlob(p.slice(1));
      if (g) exclude.push(g);
    } else {
      const g = normalizeGlob(p);
      if (g) include.push(g);
    }
  }
  return { include, exclude };
}

const unquote = (s: string): string => {
  const t = s.trim();
  return (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))
    ? t.slice(1, -1)
    : t;
};

/** Parse a flow-style list body (the text between `[` and `]`, or an inline YAML `[a, b]`). */
const splitFlowList = (inner: string): string[] =>
  inner
    .split(",")
    .map((s) => unquote(s))
    .filter((s) => s.length > 0);

/**
 * npm/yarn workspaces from a package.json: the `workspaces` field, either an array of globs or an
 * object `{ packages: [...] }` (Yarn's form). Returns `null` when there is no `workspaces` field
 * (not a monorepo); an empty-but-present field yields no members, which is still a monorepo.
 */
export function parseNpmWorkspaceGlobs(packageJson: string | undefined): WorkspaceGlobs | null {
  if (!packageJson) return null;
  let ws: unknown;
  try {
    ws = (JSON.parse(packageJson) as { workspaces?: unknown }).workspaces;
  } catch {
    return null;
  }
  const patterns = Array.isArray(ws)
    ? ws
    : ws && typeof ws === "object"
      ? (ws as { packages?: unknown }).packages
      : undefined;
  if (!Array.isArray(patterns)) return null;
  return splitGlobPatterns(patterns.filter((p): p is string => typeof p === "string"));
}

/**
 * pnpm workspace members from a `pnpm-workspace.yaml`: the `packages:` block sequence (or an inline
 * flow list). A minimal reader — enough for the one key we need — never a full YAML parser. Returns
 * `null` when the file is absent or has no `packages:` key.
 */
export function parsePnpmWorkspaceGlobs(yaml: string | undefined): WorkspaceGlobs | null {
  if (yaml === undefined) return null;
  const patterns: string[] = [];
  let inPackages = false;
  let found = false;
  for (const line of yaml.split(/\r?\n/)) {
    const inlineKey = /^packages\s*:(.*)$/.exec(line);
    if (inlineKey) {
      found = true;
      const rest = inlineKey[1]!.trim();
      const flow = /^\[(.*)\]$/.exec(rest);
      if (flow) {
        patterns.push(...splitFlowList(flow[1]!));
        inPackages = false;
      } else {
        inPackages = true; // a block sequence follows on subsequent lines
      }
      continue;
    }
    if (!inPackages) continue;
    const item = /^\s*-\s+(.+?)\s*$/.exec(line);
    if (item) {
      patterns.push(unquote(item[1]!.replace(/\s+#.*$/, "")));
      continue;
    }
    if (line.trim() === "" || line.trim().startsWith("#")) continue; // blank/comment stays in block
    inPackages = false; // any other line ends the packages block
  }
  return found ? splitGlobPatterns(patterns) : null;
}

/** A `[section]` table's `key = [ ... ]` string array, spanning lines; `null` if section/key absent. */
function tomlStringArray(toml: string, section: string, key: string): string[] | null {
  const lines = toml.split(/\r?\n/);
  let inSection = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.startsWith("[")) {
      inSection = line === `[${section}]`;
      continue;
    }
    if (!inSection) continue;
    const m = new RegExp(`^${key}\\s*=\\s*(.*)$`).exec(line);
    if (!m) continue;
    let text = m[1]!;
    while (!text.includes("]") && i + 1 < lines.length) text += `\n${lines[++i]}`;
    const inner = /\[([\s\S]*?)\]/.exec(text);
    return inner ? splitFlowList(inner[1]!) : [];
  }
  return null;
}

/** Cargo workspace members/excludes from a Cargo.toml `[workspace]` table. `null` if not a workspace. */
export function parseCargoWorkspaceGlobs(cargoToml: string | undefined): WorkspaceGlobs | null {
  if (cargoToml === undefined || !/^\s*\[workspace\]/m.test(cargoToml)) return null;
  const members = (tomlStringArray(cargoToml, "workspace", "members") ?? []).map(normalizeGlob);
  const exclude = (tomlStringArray(cargoToml, "workspace", "exclude") ?? []).map(normalizeGlob);
  return { include: members, exclude };
}

/** A package.json `name`, for display only (never used to build a command). */
function npmPackageName(packageJson: string | undefined): string | undefined {
  if (!packageJson) return undefined;
  try {
    const name = (JSON.parse(packageJson) as { name?: unknown }).name;
    return typeof name === "string" && name.trim() ? name : undefined;
  } catch {
    return undefined;
  }
}

/** A Cargo `[package] name`, for display only (never used to build a command). */
function cargoPackageName(cargoToml: string | undefined): string | undefined {
  if (!cargoToml) return undefined;
  let inPackage = false;
  for (const raw of cargoToml.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inPackage = line === "[package]";
      continue;
    }
    if (!inPackage) continue;
    const m = /^name\s*=\s*["']([^"']+)["']/.exec(line);
    if (m) return m[1];
  }
  return undefined;
}

/** Directories never traversed during wildcard expansion, however the glob is written. */
const HARD_IGNORED = new Set(["node_modules", "target", ".git"]);
/** During a `*`/`**` match, also skip dot-directories (`.git`, `.cache`, …). A literal segment may
 * still name one explicitly. */
const skipDuringWildcard = (name: string): boolean =>
  HARD_IGNORED.has(name) || name.startsWith(".");

/** Bounds so a pathological tree (deep, or a huge `**`) can never make discovery run away. */
const MAX_MEMBER_DIRS = 500;
const MAX_WALK_DEPTH = 8;

const normAbs = (p: string): string => p.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
const joinPath = (dir: string, name: string): string => `${dir.replace(/[\\/]+$/, "")}/${name}`;

/** Translate one path-segment glob (`*`, `?`, literals) to an anchored regex (no `/` crossing). */
function wildcardToRegExp(seg: string): RegExp {
  let re = "";
  for (const ch of seg) {
    if (ch === "*") re += "[^/\\\\]*";
    else if (ch === "?") re += "[^/\\\\]";
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

const listSubdirs = async (dir: string, listDir: DirLister): Promise<DirEntry[]> =>
  ((await listDir(dir)) ?? []).filter((e) => e.isDir);

/** All descendant directories of `dir` (not `dir` itself), bounded in depth and count, skipping the
 * ignored directories. Used to expand a `**` segment. */
async function descendants(
  dir: string,
  listDir: DirLister,
  budget: { n: number },
): Promise<string[]> {
  const out: string[] = [];
  const stack: Array<{ path: string; depth: number }> = [{ path: dir, depth: 0 }];
  while (stack.length && budget.n > 0) {
    const { path, depth } = stack.pop()!;
    if (depth >= MAX_WALK_DEPTH) continue;
    for (const e of await listSubdirs(path, listDir)) {
      if (skipDuringWildcard(e.name)) continue;
      const child = joinPath(path, e.name);
      out.push(child);
      if (--budget.n <= 0) break;
      stack.push({ path: child, depth: depth + 1 });
    }
  }
  return out;
}

/** Expand one declared glob (relative to `root`) to the set of matching directories. Supports
 * literal segments, `*`/`?` within a segment, and `**` (this directory and all descendants). */
async function expandGlob(
  root: string,
  pattern: string,
  listDir: DirLister,
  budget: { n: number },
): Promise<string[]> {
  const segments = pattern.split(/[\\/]+/).filter((s) => s.length > 0 && s !== ".");
  if (!segments.length) return [];
  let frontier: string[] = [root];
  for (const seg of segments) {
    const next: string[] = [];
    for (const dir of frontier) {
      if (budget.n <= 0) break;
      if (seg === "**") {
        next.push(dir, ...(await descendants(dir, listDir, budget)));
      } else if (/[*?]/.test(seg)) {
        const re = seg === "*" ? null : wildcardToRegExp(seg);
        for (const e of await listSubdirs(dir, listDir)) {
          if (skipDuringWildcard(e.name)) continue;
          if (re && !re.test(e.name)) continue;
          next.push(joinPath(dir, e.name));
        }
      } else if (!HARD_IGNORED.has(seg)) {
        if ((await listSubdirs(dir, listDir)).some((e) => e.name === seg))
          next.push(joinPath(dir, seg));
      }
    }
    frontier = [...new Set(next)];
  }
  return [...new Set(frontier)];
}

/** The directories that are a root's declared sub-packages (npm ∪ pnpm ∪ Cargo), minus excludes and
 * the root itself, bounded. Empty when the root declares no workspace. */
async function discoverMemberDirs(
  root: string,
  rootFiles: { packageJson?: string; cargoToml?: string; pnpmWorkspace?: string },
  listDir: DirLister,
): Promise<string[]> {
  const sets = [
    parseNpmWorkspaceGlobs(rootFiles.packageJson),
    parsePnpmWorkspaceGlobs(rootFiles.pnpmWorkspace),
    parseCargoWorkspaceGlobs(rootFiles.cargoToml),
  ].filter((g): g is WorkspaceGlobs => g !== null);
  if (!sets.length) return [];
  const budget = { n: MAX_MEMBER_DIRS * 8 };
  const include = new Set<string>();
  const exclude = new Set<string>();
  for (const g of sets) {
    for (const pat of g.include)
      for (const d of await expandGlob(root, pat, listDir, budget)) include.add(normAbs(d));
    for (const pat of g.exclude)
      for (const d of await expandGlob(root, pat, listDir, budget)) exclude.add(normAbs(d));
  }
  const rootAbs = normAbs(root);
  return [...include].filter((d) => !exclude.has(d) && d !== rootAbs).slice(0, MAX_MEMBER_DIRS);
}

/** A sub-package's stable id-safe key and its display relative path. The key folds separators to
 * `.` (ids allow no `/`) and, in a multi-root workspace, is prefixed by the root's key so packages
 * under different roots stay distinct. */
function memberIdentity(
  root: string,
  dir: string,
  multiRoot: boolean,
  rootKey: string,
): { key: string; relPath: string } {
  const rootAbs = normAbs(root);
  const dirAbs = normAbs(dir);
  const relPath = dirAbs.startsWith(`${rootAbs}/`) ? dirAbs.slice(rootAbs.length + 1) : dirAbs;
  const safe = relPath.replace(/[\\/]+/g, ".").replace(/[^A-Za-z0-9._-]/g, "-");
  return { key: multiRoot ? `${rootKey}.${safe}` : safe, relPath };
}

/** The exact convention files read in one folder (a root or a sub-package), as TaskSource fields. */
async function readConventionFiles(
  folder: string,
  read: TaskFileReader,
): Promise<
  Pick<
    TaskSource,
    "packageJson" | "cargoToml" | "makefile" | "packageLock" | "pnpmLock" | "yarnLock"
  >
> {
  const at = (name: string) => read(childPath(folder, name));
  const [
    packageJson,
    cargoToml,
    gnuMakefile,
    lowerMakefile,
    makefile,
    packageLock,
    pnpmLock,
    yarnLock,
  ] = await Promise.all([
    at("package.json"),
    at("Cargo.toml"),
    at("GNUmakefile"),
    at("makefile"),
    at("Makefile"),
    at("package-lock.json"),
    at("pnpm-lock.yaml"),
    at("yarn.lock"),
  ]);
  // make's own precedence: GNUmakefile, then makefile, then Makefile.
  const chosenMakefile = gnuMakefile ?? lowerMakefile ?? makefile;
  return {
    ...(packageJson !== null ? { packageJson } : {}),
    ...(cargoToml !== null ? { cargoToml } : {}),
    ...(chosenMakefile !== null ? { makefile: chosenMakefile } : {}),
    ...(packageLock !== null ? { packageLock: true } : {}),
    ...(pnpmLock !== null ? { pnpmLock: true } : {}),
    ...(yarnLock !== null ? { yarnLock: true } : {}),
  };
}

/**
 * Read each folder's convention files with the injected reader and build the {@link TaskSource}s.
 * Only {@link DISCOVERY_FILES} are read, never executed. When a {@link DirLister} is supplied, each
 * root is also checked for a workspace declaration (npm/pnpm/Cargo) and its sub-packages are
 * discovered as additional, path-qualified sources (WS7 Part 4). Testable with fakes; wired to the
 * native file reader and directory lister (both workspace-confined) in the app.
 */
export async function loadTaskSources(
  folders: readonly string[],
  read: TaskFileReader,
  listDir?: DirLister,
): Promise<TaskSource[]> {
  const multiRoot = folders.length > 1;
  const sources: TaskSource[] = [];
  const seen = new Set<string>(folders.map(normAbs)); // folders already represented (roots first)
  for (const folder of folders) {
    const files = await readConventionFiles(folder, read);
    const rootKey = basename(folder);
    const rootSource: TaskSource = { key: rootKey, folder, multiRoot, root: folder, ...files };
    sources.push(rootSource);
    if (!listDir) continue;
    // A pnpm monorepo's members live in a separate manifest; the npm/Cargo ones are in files above.
    const pnpmWorkspace = await read(childPath(folder, "pnpm-workspace.yaml"));
    // Members with no package-manager signal of their own follow the root: a `pnpm-workspace.yaml`
    // is itself a pnpm signal; otherwise the root's own detection (field/lockfile/default) decides.
    const inheritedManager: PackageManager =
      pnpmWorkspace !== null ? "pnpm" : detectPackageManager(rootSource).manager;
    const memberDirs = await discoverMemberDirs(
      folder,
      {
        ...(files.packageJson !== undefined ? { packageJson: files.packageJson } : {}),
        ...(files.cargoToml !== undefined ? { cargoToml: files.cargoToml } : {}),
        ...(pnpmWorkspace !== null ? { pnpmWorkspace } : {}),
      },
      listDir,
    );
    for (const dir of memberDirs) {
      const abs = normAbs(dir);
      if (seen.has(abs)) continue; // never shadow a declared root or a package matched twice
      seen.add(abs);
      const memberFiles = await readConventionFiles(dir, read);
      const { key, relPath } = memberIdentity(folder, dir, multiRoot, rootKey);
      const packageName =
        npmPackageName(memberFiles.packageJson) ?? cargoPackageName(memberFiles.cargoToml);
      sources.push({
        key,
        folder: dir,
        multiRoot: true, // a sub-package is always qualified, even inside a single root
        relPath,
        root: folder, // the workspace root this member belongs to (for graph isolation)
        inheritedManager,
        ...(packageName !== undefined ? { packageName } : {}),
        ...memberFiles,
      });
    }
  }
  return sources;
}

/** Discover a workspace's tasks: read the convention files (and, with a lister, its monorepo
 * sub-packages), parse them, then augment discovered build tasks with the package dependency
 * graph's ordering edges (WS7 Part 6) — a build depends on its local dependencies' builds. */
export async function discoverWorkspaceTasks(
  folders: readonly string[],
  read: TaskFileReader,
  listDir?: DirLister,
): Promise<ResolvedTask[]> {
  const sources = await loadTaskSources(folders, read, listDir);
  return applyPackageDependencies(discoverTasks(sources), sources);
}
