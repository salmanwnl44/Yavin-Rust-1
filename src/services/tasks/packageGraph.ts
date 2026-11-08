/**
 * Monorepo package dependency graph (WS7 Part 6): a **pure projection** over the manifests
 * discovery already read, turning *declared* package relationships into validated task-ordering
 * edges that feed the **existing** dependency planner (`plan.ts`). It builds no scheduler of its
 * own and executes nothing.
 *
 * What becomes an edge is deliberately narrow and safe:
 *  - **JavaScript** (npm/pnpm/Yarn): a `dependencies`/`devDependencies`/`optionalDependencies`/
 *    `peerDependencies` entry whose **name** matches another discovered workspace package **in the
 *    same root** (workspaces resolve by name; a `workspace:` protocol or `file:` ref is one such
 *    entry). Names are matched, never directory names.
 *  - **Cargo**: a `dependencies`/`dev-dependencies`/`build-dependencies`/`target.*.dependencies`
 *    entry that is a **path dependency** resolving to a discovered workspace member's directory, or
 *    a `workspace = true` entry whose `[workspace.dependencies]` declaration carries such a path.
 *
 * Registry (external) dependencies never become nodes or edges. Packages are **isolated per
 * workspace root** — a name or path never links packages under different roots. Cycles are detected
 * and broken deterministically so a pathological manifest never makes a build un-runnable.
 *
 * The **policy** that turns package edges into task edges is intentionally small and documented in
 * {@link packageTaskDependsOn}: a package's **build** task depends on the **build** tasks of its
 * local dependencies — nothing else is wired automatically. Explicit `dependsOn` configuration
 * always wins (configured tasks override discovered ones in the TaskService, above this layer).
 */
import { discoveredTaskId, type TaskSource } from "./discovery.ts";
import type { ResolvedTask } from "./model.ts";

/** Which manifest section a declared dependency came from (kept for provenance/UI, not for policy). */
export type DepKind =
  | "dependencies"
  | "devDependencies"
  | "optionalDependencies"
  | "peerDependencies"
  | "cargo-dependencies"
  | "cargo-dev-dependencies"
  | "cargo-build-dependencies"
  | "cargo-target-dependencies";

export type Ecosystem = "npm" | "cargo";

/** A discovered package in the graph. `id` is its **build task id** (the single source of truth
 * from discovery) whether or not it actually has a build task — edges are validated against the
 * real task list later. */
export interface PackageNode {
  readonly id: string;
  readonly ecosystem: Ecosystem;
  readonly name: string | null;
  readonly dir: string;
  readonly root: string;
}

/** A directed, local, resolved dependency edge: `from` (dependent) → `to` (dependency). */
export interface PackageEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: DepKind;
}

export interface PackageGraph {
  readonly nodes: readonly PackageNode[];
  readonly edges: readonly PackageEdge[];
}

const normAbs = (p: string): string => p.replace(/[\\/]+/g, "/").replace(/\/+$/, "");

/** Resolve a (possibly `../`) relative path against a base directory, collapsing `.`/`..`. */
function resolvePath(baseDir: string, rel: string): string {
  const parts = normAbs(baseDir).split("/");
  for (const seg of rel.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

// --- JavaScript manifests ----------------------------------------------------------------------

const JS_SECTIONS: readonly DepKind[] = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

export interface JsManifest {
  readonly name: string | null;
  readonly deps: readonly { name: string; kind: DepKind }[];
}

/** Parse a package.json's name and its four dependency maps. Invalid JSON → null. */
export function parseJsManifest(packageJson: string | undefined): JsManifest | null {
  if (!packageJson) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const name = typeof obj.name === "string" && obj.name.trim() ? obj.name : null;
  const deps: { name: string; kind: DepKind }[] = [];
  for (const section of JS_SECTIONS) {
    const map = obj[section];
    if (!map || typeof map !== "object" || Array.isArray(map)) continue;
    for (const depName of Object.keys(map as Record<string, unknown>)) {
      // The spec (`workspace:*`, `^1`, `file:../x`) does not matter: a workspace resolves a
      // dependency to a local package purely by name, so the name is all we need.
      if (depName.trim()) deps.push({ name: depName, kind: section });
    }
  }
  return { name, deps };
}

// --- Cargo manifests ---------------------------------------------------------------------------

export interface CargoDep {
  readonly name: string;
  readonly kind: DepKind;
  /** A `path = "…"` (relative to the package dir), when present. */
  readonly path?: string;
  /** `workspace = true` — inherit from the root's `[workspace.dependencies]`. */
  readonly workspace?: boolean;
}

export interface CargoManifest {
  readonly name: string | null;
  readonly deps: readonly CargoDep[];
  /** The root's `[workspace.dependencies]` paths by name (for `workspace = true` inheritance). */
  readonly workspaceDeps: ReadonlyMap<string, { path?: string }>;
}

const stripComment = (line: string): string => {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "#") return line.slice(0, i);
  }
  return line;
};

const CARGO_SECTION: Record<string, DepKind> = {
  dependencies: "cargo-dependencies",
  "dev-dependencies": "cargo-dev-dependencies",
  "build-dependencies": "cargo-build-dependencies",
};

type HeaderClass =
  | { kind: "package" }
  | { kind: "workspace-deps"; depName?: string }
  | { kind: DepKind; depName?: string }
  | { kind: "other" };

function classifyHeader(header: string): HeaderClass {
  const h = header.trim();
  if (h === "package") return { kind: "package" };
  if (h === "workspace.dependencies") return { kind: "workspace-deps" };
  const wsDep = /^workspace\.dependencies\.(.+)$/.exec(h);
  if (wsDep) return { kind: "workspace-deps", depName: unquoteKey(wsDep[1]!) };
  for (const [section, kind] of Object.entries(CARGO_SECTION)) {
    if (h === section) return { kind };
    const sub = new RegExp(`^${section}\\.(.+)$`).exec(h);
    if (sub) return { kind, depName: unquoteKey(sub[1]!) };
  }
  const target =
    /^target\.(.+?)\.(dependencies|dev-dependencies|build-dependencies)(?:\.(.+))?$/.exec(h);
  if (target) {
    const base: HeaderClass = { kind: "cargo-target-dependencies" };
    return target[3] ? { ...base, depName: unquoteKey(target[3]) } : base;
  }
  return { kind: "other" };
}

const unquoteKey = (k: string): string => k.replace(/^["']|["']$/g, "");
const matchPathIn = (s: string): string | undefined =>
  /(?:^|[\s,{])path\s*=\s*["']([^"']+)["']/.exec(s)?.[1];
const hasWorkspaceTrue = (s: string): boolean => /(?:^|[\s,{])workspace\s*=\s*true\b/.test(s);

/** Parse one `name = <value>` dependency line (string, inline table, or a single dotted key). */
function parseDepLine(line: string): { name: string; path?: string; workspace?: boolean } | null {
  const dotted = /^(?:"([^"]+)"|([A-Za-z0-9_-]+))\.([A-Za-z_-]+)\s*=\s*(.+)$/.exec(line);
  if (dotted) {
    const name = dotted[1] ?? dotted[2]!;
    const key = dotted[3]!;
    const val = dotted[4]!.trim();
    if (key === "path") return { name, path: val.replace(/^["']|["']$/g, "") };
    if (key === "workspace" && /^true\b/.test(val)) return { name, workspace: true };
    return { name };
  }
  const assign = /^(?:"([^"]+)"|([A-Za-z0-9_-]+))\s*=\s*(.+)$/.exec(line);
  if (!assign) return null;
  const name = assign[1] ?? assign[2]!;
  const value = assign[3]!.trim();
  if (value.startsWith("{")) {
    const result: { name: string; path?: string; workspace?: boolean } = { name };
    const p = matchPathIn(value);
    if (p !== undefined) result.path = p;
    if (hasWorkspaceTrue(value)) result.workspace = true;
    return result;
  }
  return { name }; // a bare version string → external
}

/** Parse a Cargo.toml: package name, its dependency declarations (all sections), and the root's
 * `[workspace.dependencies]` paths. A minimal reader for exactly these fields — never a full TOML
 * parser, and it executes nothing. */
export function parseCargoManifest(cargoToml: string | undefined): CargoManifest | null {
  if (!cargoToml) return null;
  let name: string | null = null;
  const depMap = new Map<string, CargoDep & { path?: string; workspace?: boolean }>();
  const workspaceDeps = new Map<string, { path?: string }>();
  let cur: HeaderClass = { kind: "other" };

  const depKey = (kind: DepKind, depName: string) => `${kind}\u0000${depName}`;
  const upsertDep = (kind: DepKind, depName: string) => {
    const k = depKey(kind, depName);
    let d = depMap.get(k);
    if (!d) depMap.set(k, (d = { name: depName, kind }));
    return d;
  };

  for (const raw of cargoToml.split(/\r?\n/)) {
    const line = stripComment(raw).trim();
    if (!line) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      cur = classifyHeader(header[1]!.trim());
      continue;
    }
    if (cur.kind === "package") {
      const m = /^name\s*=\s*["']([^"']+)["']/.exec(line);
      if (m) name = m[1]!;
      continue;
    }
    if (cur.kind === "workspace-deps") {
      if (cur.depName) {
        // Inside a `[workspace.dependencies.<name>]` sub-table: a `path = "…"` makes it local.
        const p = matchPathIn(line);
        if (p !== undefined) workspaceDeps.set(cur.depName, { path: p });
        else if (!workspaceDeps.has(cur.depName)) workspaceDeps.set(cur.depName, {});
      } else {
        const d = parseDepLine(line);
        if (d) workspaceDeps.set(d.name, d.path !== undefined ? { path: d.path } : {});
      }
      continue;
    }
    if (isCargoDepSection(cur)) {
      if (cur.depName) {
        // Inside a `[dependencies.<name>]` (or dev-/build-/target-) sub-table.
        const d = upsertDep(cur.kind, cur.depName);
        const p = matchPathIn(line);
        if (p !== undefined) d.path = p;
        if (hasWorkspaceTrue(line)) d.workspace = true;
      } else {
        const parsed = parseDepLine(line);
        if (parsed) {
          const d = upsertDep(cur.kind, parsed.name);
          if (parsed.path !== undefined) d.path = parsed.path;
          if (parsed.workspace) d.workspace = true;
        }
      }
    }
  }
  return { name, deps: [...depMap.values()], workspaceDeps };
}

const isCargoDepSection = (c: HeaderClass): c is { kind: DepKind; depName?: string } =>
  c.kind === "cargo-dependencies" ||
  c.kind === "cargo-dev-dependencies" ||
  c.kind === "cargo-build-dependencies" ||
  c.kind === "cargo-target-dependencies";

// --- graph ------------------------------------------------------------------------------------

/** The build-task id discovery would assign this source in a given ecosystem (its node id). */
const buildId = (source: TaskSource, ecosystem: Ecosystem): string =>
  discoveredTaskId(source, ecosystem, "build");

/**
 * Build the local package dependency graph from the discovered sources. Pure: it reads only the
 * manifests already in hand. Edges are resolved, local, de-duplicated and isolated per workspace
 * root; external and unresolved dependencies are dropped.
 */
export function buildPackageGraph(sources: readonly TaskSource[]): PackageGraph {
  const nodes: PackageNode[] = [];
  // Per-root indices for resolution.
  const npmByName = new Map<string, PackageNode>(); // `${root}\0${name}` → node (unique)
  const npmNameCount = new Map<string, number>(); // detect ambiguous (duplicate) names per root
  const cargoByDir = new Map<string, PackageNode>(); // `${root}\0${dirAbs}` → node
  const cargoWorkspaceDeps = new Map<string, ReadonlyMap<string, { path?: string }>>(); // root → wsDeps
  // Keep each source's parsed manifest alongside its node(s) for the edge pass.
  const parsed: {
    source: TaskSource;
    root: string;
    js: JsManifest | null;
    cargo: CargoManifest | null;
  }[] = [];

  for (const source of sources) {
    const root = normAbs(source.root ?? source.folder);
    const dir = normAbs(source.folder);
    const js = parseJsManifest(source.packageJson);
    const cargo = parseCargoManifest(source.cargoToml);
    parsed.push({ source, root, js, cargo });

    if (js) {
      const node: PackageNode = {
        id: buildId(source, "npm"),
        ecosystem: "npm",
        name: js.name,
        dir,
        root,
      };
      nodes.push(node);
      if (js.name) {
        const key = `${root}\u0000${js.name}`;
        npmNameCount.set(key, (npmNameCount.get(key) ?? 0) + 1);
        npmByName.set(key, node);
      }
    }
    // A real crate manifest (has `[package]` → a name, or path-resolvable) participates as a node.
    if (cargo && (source.cargoToml?.match(/^\s*\[package\]/m) || cargo.name)) {
      const node: PackageNode = {
        id: buildId(source, "cargo"),
        ecosystem: "cargo",
        name: cargo.name,
        dir,
        root,
      };
      nodes.push(node);
      cargoByDir.set(`${root}\u0000${dir}`, node);
    }
    if (cargo && cargo.workspaceDeps.size > 0) cargoWorkspaceDeps.set(root, cargo.workspaceDeps);
  }

  const edges: PackageEdge[] = [];
  const seenEdge = new Set<string>();
  const addEdge = (from: string, to: string, kind: DepKind) => {
    if (from === to) return;
    const k = `${from}\u0000${to}`;
    if (seenEdge.has(k)) return;
    seenEdge.add(k);
    edges.push({ from, to, kind });
  };

  for (const { source, root, js, cargo } of parsed) {
    if (js) {
      const from = buildId(source, "npm");
      for (const dep of js.deps) {
        const key = `${root}\u0000${dep.name}`;
        if ((npmNameCount.get(key) ?? 0) !== 1) continue; // missing, or ambiguous → do not guess
        const target = npmByName.get(key);
        if (target) addEdge(from, target.id, dep.kind);
      }
    }
    if (cargo) {
      const from = buildId(source, "cargo");
      const dir = normAbs(source.folder);
      for (const dep of cargo.deps) {
        let path = dep.path;
        if (path === undefined && dep.workspace)
          path = cargoWorkspaceDeps.get(root)?.get(dep.name)?.path;
        if (path === undefined) continue; // version-only / external → excluded
        // A package dep's path is relative to the package; an inherited one to the workspace root.
        const base = dep.path !== undefined ? dir : root;
        const targetDir = resolvePath(base, path);
        const target = cargoByDir.get(`${root}\u0000${targetDir}`);
        if (target) addEdge(from, target.id, dep.kind);
      }
    }
  }

  return { nodes, edges };
}

// --- policy → task dependsOn ------------------------------------------------------------------

export interface TaskEdgeResult {
  /** `taskId → [dependency task ids]`, acyclic, de-duplicated. */
  readonly dependsOn: ReadonlyMap<string, readonly string[]>;
  /** Package-graph cycles that were broken (each a list of build-task ids), for surfacing/logging. */
  readonly brokenCycles: readonly (readonly string[])[];
}

/**
 * The task-ordering **policy** (WS7 Part 6): a package's **build** task depends on the **build**
 * tasks of its local dependencies — and nothing else is wired automatically (test/lint/run stay
 * independent unless the user configures `dependsOn`). Only edges between build tasks that actually
 * exist in `taskIds` are kept; cycles are broken deterministically so builds stay runnable.
 */
export function packageTaskDependsOn(
  graph: PackageGraph,
  taskIds: ReadonlySet<string>,
): TaskEdgeResult {
  // Both endpoints are build-task ids by construction; keep only those that are real tasks.
  const adj = new Map<string, string[]>();
  const edges = [...graph.edges]
    .filter((e) => taskIds.has(e.from) && taskIds.has(e.to))
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  for (const e of edges) (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e.to);

  // Deterministic DFS that drops any edge which would close a cycle (keeps the graph acyclic).
  const dependsOn = new Map<string, string[]>();
  const brokenCycles: string[][] = [];
  const state = new Map<string, 0 | 1 | 2>(); // 0/undefined=unseen, 1=on-stack, 2=done
  const stack: string[] = [];
  const nodesInOrder = [...new Set(edges.flatMap((e) => [e.from, e.to]))].sort();

  const visit = (node: string) => {
    state.set(node, 1);
    stack.push(node);
    for (const next of adj.get(node) ?? []) {
      if (state.get(next) === 1) {
        // Back edge → would create a cycle; drop it and record the cycle for surfacing.
        brokenCycles.push([...stack.slice(stack.indexOf(next)), next]);
        continue;
      }
      // Keep the edge (node depends on next).
      (dependsOn.get(node) ?? dependsOn.set(node, []).get(node)!).push(next);
      if (state.get(next) !== 2) visit(next);
    }
    stack.pop();
    state.set(node, 2);
  };
  for (const node of nodesInOrder) if (state.get(node) !== 2) visit(node);

  // De-duplicate each list (a node reached by two retained edges keeps one).
  const deduped = new Map<string, readonly string[]>();
  for (const [from, list] of dependsOn) deduped.set(from, [...new Set(list)]);
  return { dependsOn: deduped, brokenCycles };
}

/**
 * Augment discovered tasks with package-derived `dependsOn` edges (build → local dependency build),
 * per {@link packageTaskDependsOn}. Only discovered build tasks that actually exist are touched;
 * a task's existing `dependsOn` is preserved and merged. Configured tasks override discovered ones
 * in the TaskService above this layer, so explicit user `dependsOn` stays authoritative.
 */
export function applyPackageDependencies(
  tasks: readonly ResolvedTask[],
  sources: readonly TaskSource[],
): ResolvedTask[] {
  const taskIds = new Set(tasks.map((t) => t.id));
  const { dependsOn } = packageTaskDependsOn(buildPackageGraph(sources), taskIds);
  if (dependsOn.size === 0) return tasks as ResolvedTask[];
  return tasks.map((task) => {
    const extra = dependsOn.get(task.id);
    if (!extra || extra.length === 0) return task;
    const merged = [...new Set([...task.dependsOn, ...extra])];
    return { ...task, dependsOn: merged };
  });
}
