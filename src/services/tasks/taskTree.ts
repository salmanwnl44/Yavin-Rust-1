/**
 * Hierarchical Tasks projection (WS7 Part 5): projects the flat {@link ResolvedTask} list the
 * TaskService already owns into a **presentation hierarchy** — Workspace → Package → Group → Task —
 * and flattens it to the visible-row list the Run panel draws, honouring per-node expansion. This
 * is a *projection*: it creates **no** task records and **no** execution state; a task leaf carries
 * the task's own stable id (`node.taskId`), so running, stopping and selection all go through the
 * existing service by that id, and identity survives a re-projection that reorders or regroups.
 *
 * Nothing here runs a process, reads a file, or watches anything — the live list comes from the
 * existing discovery + lifecycle subscriptions; this only reshapes what is already in hand. Node
 * ids are **stable** (derived from the folder index, the package's relative path and the group,
 * never from array position), so expansion and selection survive discovery and lifecycle changes.
 */
import type { ResolvedTask } from "./model.ts";

/** A presentation group. `build`/`test` come from the task's explicit `group` metadata; the rest
 * are a conservative, convention-based reading used **only** when no explicit metadata decides. */
export type TaskPresentationGroup = "build" | "test" | "lint" | "typecheck" | "run" | "other";

/** Where a task comes from, collapsed to the two buckets the source filter offers. */
export type TaskSourceFilter = "configured" | "discovered";

export type TaskNodeKind = "workspace" | "package" | "group" | "task";

export interface TaskTreeNode {
  readonly id: string;
  readonly kind: TaskNodeKind;
  readonly label: string;
  readonly depth: number;
  readonly children: readonly TaskTreeNode[];
  readonly expandable: boolean;
  /** Number of task leaves at or under this node (for a count badge and the empty state). */
  readonly taskCount: number;
  // --- task leaves -----------------------------------------------------------------------------
  /** The task's own stable id — what `run`/`cancel`/selection use. Present on task leaves only. */
  readonly taskId?: string;
  readonly command?: string;
  readonly scope?: ResolvedTask["scope"];
  readonly isDefault?: boolean;
  /** The task's dependency task ids (configured and/or package-graph-derived — WS7 Part 6), so the
   * view can show what runs first. Present on task leaves. */
  readonly dependsOn?: readonly string[];
  /** The presentation group — on both group nodes and task leaves. */
  readonly group?: TaskPresentationGroup;
  // --- package nodes ---------------------------------------------------------------------------
  readonly packageKey?: string;
  readonly relPath?: string;
}

/** A node flattened for rendering, with whether it is currently expanded. */
export interface TaskRow {
  readonly node: TaskTreeNode;
  readonly expanded: boolean;
}

export const GROUP_ORDER: readonly TaskPresentationGroup[] = [
  "build",
  "test",
  "lint",
  "typecheck",
  "run",
  "other",
];

export const GROUP_LABEL: Record<TaskPresentationGroup, string> = {
  build: "Build",
  test: "Test",
  lint: "Lint",
  typecheck: "Typecheck",
  run: "Run",
  other: "Other",
};

/** A task's source bucket: a `discovered` task vs. a configured (`user`/`workspace`) one. */
export const sourceOf = (task: ResolvedTask): TaskSourceFilter =>
  task.scope === "discovered" ? "discovered" : "configured";

/** The task's short name — the last `:`-segment of its id (`npm:packages.web:lint` → `lint`). */
const taskName = (task: ResolvedTask): string => {
  const i = task.id.lastIndexOf(":");
  return i >= 0 ? task.id.slice(i + 1) : task.id;
};

/**
 * A task's presentation group. **Explicit metadata wins and is never overridden by a name:**
 * `task.group` (`build`/`test`) first, then problem-matcher metadata (`eslint`/`ruff` → lint,
 * `tsc` → typecheck). Only when neither decides is a conservative, convention-based reading of the
 * command/name used (clippy/lint → lint, tsc/typecheck → typecheck, run/start/serve/dev → run);
 * anything unrecognised is `other`.
 */
export function presentationGroup(task: ResolvedTask): TaskPresentationGroup {
  if (task.group === "build") return "build";
  if (task.group === "test") return "test";
  const matchers = task.problemMatcher ?? [];
  if (matchers.includes("eslint") || matchers.includes("ruff")) return "lint";
  if (matchers.includes("tsc")) return "typecheck";
  const name = taskName(task).toLowerCase();
  const cmd = (task.command ?? "").toLowerCase();
  if (/\bclippy\b/.test(cmd) || /\beslint\b/.test(cmd) || /(^|[:_ -])lint([:_ -]|$)/.test(name))
    return "lint";
  if (/\btsc\b/.test(cmd) || /(^|[:_ -])(typecheck|type-check)([:_ -]|$)/.test(name))
    return "typecheck";
  if (/(^|[:_ -])(run|start|serve|dev|preview|watch)([:_ -]|$)/.test(name)) return "run";
  return "other";
}

const normAbs = (p: string): string => p.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
const basename = (folder: string): string => normAbs(folder).split("/").pop() || folder;
const isAbsolute = (p: string): boolean => /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(p);

/** Which workspace folder a task belongs to, and its path within that folder. A `null`/empty cwd
 * is the primary root; an absolute cwd is matched to the longest folder prefix; a relative cwd is a
 * sub-path of the primary root. An absolute cwd outside every folder falls back to the primary root. */
function locate(
  task: ResolvedTask,
  normFolders: readonly string[],
): { folderIndex: number; relPath: string } {
  const cwd = task.cwd;
  if (cwd === null || cwd === "") return { folderIndex: 0, relPath: "" };
  if (isAbsolute(cwd)) {
    const c = normAbs(cwd);
    let best = -1;
    let bestLen = -1;
    normFolders.forEach((f, i) => {
      if ((c === f || c.startsWith(`${f}/`)) && f.length > bestLen) {
        best = i;
        bestLen = f.length;
      }
    });
    if (best >= 0) {
      const f = normFolders[best]!;
      return { folderIndex: best, relPath: c === f ? "" : c.slice(f.length + 1) };
    }
    return { folderIndex: 0, relPath: "" };
  }
  return { folderIndex: 0, relPath: normAbs(cwd) };
}

export const packageKeyFor = (folderIndex: number, relPath: string): string =>
  `${folderIndex}\u0000${relPath}`;

// --- filtering ---------------------------------------------------------------------------------

export interface TaskFilters {
  /** Workspace folder index, or null for all. */
  readonly workspace?: number | null;
  /** Package key (`packageKeyFor`), or null for all. */
  readonly packageKey?: string | null;
  readonly group?: TaskPresentationGroup | null;
  readonly source?: TaskSourceFilter | null;
  /** Case-insensitive substring over label, id and command. */
  readonly search?: string;
}

const EMPTY_FILTERS: TaskFilters = {};

/** Apply the composable filters (all AND-ed) to the task list. Pure and order-preserving. */
export function filterTasks(
  tasks: readonly ResolvedTask[],
  folders: readonly string[],
  filters: TaskFilters = EMPTY_FILTERS,
): ResolvedTask[] {
  const normFolders = folders.map(normAbs);
  const search = filters.search?.trim().toLowerCase() ?? "";
  return tasks.filter((task) => {
    if (filters.source && sourceOf(task) !== filters.source) return false;
    if (filters.group && presentationGroup(task) !== filters.group) return false;
    if (filters.workspace != null || filters.packageKey != null) {
      const loc = locate(task, normFolders);
      if (filters.workspace != null && loc.folderIndex !== filters.workspace) return false;
      if (
        filters.packageKey != null &&
        packageKeyFor(loc.folderIndex, loc.relPath) !== filters.packageKey
      )
        return false;
    }
    if (search) {
      const hay = `${task.label}\u0000${task.id}\u0000${task.command}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });
}

/** The filter options actually present in a task list — for populating the UI's dropdowns. */
export function filterOptions(
  tasks: readonly ResolvedTask[],
  folders: readonly string[],
): {
  workspaces: { index: number; label: string }[];
  packages: { key: string; label: string; folderIndex: number }[];
  groups: TaskPresentationGroup[];
  sources: TaskSourceFilter[];
} {
  const normFolders = folders.map(normAbs);
  const workspaces = new Map<number, string>();
  const packages = new Map<string, { label: string; folderIndex: number }>();
  const groups = new Set<TaskPresentationGroup>();
  const sources = new Set<TaskSourceFilter>();
  for (const task of tasks) {
    const loc = locate(task, normFolders);
    workspaces.set(loc.folderIndex, folderLabel(normFolders, loc.folderIndex));
    const key = packageKeyFor(loc.folderIndex, loc.relPath);
    if (!packages.has(key))
      packages.set(key, { label: packageLabel(normFolders, loc), folderIndex: loc.folderIndex });
    groups.add(presentationGroup(task));
    sources.add(sourceOf(task));
  }
  return {
    workspaces: [...workspaces]
      .sort((a, b) => a[0] - b[0])
      .map(([index, label]) => ({ index, label })),
    packages: [...packages]
      .map(([key, v]) => ({ key, ...v }))
      .sort((a, b) => a.folderIndex - b.folderIndex || a.label.localeCompare(b.label)),
    groups: GROUP_ORDER.filter((g) => groups.has(g)),
    sources: (["configured", "discovered"] as const).filter((s) => sources.has(s)),
  };
}

const folderLabel = (normFolders: readonly string[], folderIndex: number): string =>
  normFolders[folderIndex] ? basename(normFolders[folderIndex]!) : "workspace";

const packageLabel = (
  normFolders: readonly string[],
  loc: { folderIndex: number; relPath: string },
): string => (loc.relPath === "" ? folderLabel(normFolders, loc.folderIndex) : loc.relPath);

// --- tree building -----------------------------------------------------------------------------

interface Grouped {
  // folderIndex -> relPath -> group -> tasks
  readonly folders: Map<number, Map<string, Map<TaskPresentationGroup, ResolvedTask[]>>>;
}

function group(tasks: readonly ResolvedTask[], normFolders: readonly string[]): Grouped {
  const folders = new Map<number, Map<string, Map<TaskPresentationGroup, ResolvedTask[]>>>();
  for (const task of tasks) {
    const loc = locate(task, normFolders);
    let pkgs = folders.get(loc.folderIndex);
    if (!pkgs) folders.set(loc.folderIndex, (pkgs = new Map()));
    let groups = pkgs.get(loc.relPath);
    if (!groups) pkgs.set(loc.relPath, (groups = new Map()));
    const g = presentationGroup(task);
    let list = groups.get(g);
    if (!list) groups.set(g, (list = []));
    list.push(task);
  }
  return { folders };
}

const byLabelThenId = (a: ResolvedTask, b: ResolvedTask): number =>
  a.label.localeCompare(b.label) || a.id.localeCompare(b.id);

function groupNodes(
  groups: Map<TaskPresentationGroup, ResolvedTask[]>,
  folderIndex: number,
  relPath: string,
  depth: number,
): TaskTreeNode[] {
  const out: TaskTreeNode[] = [];
  for (const g of GROUP_ORDER) {
    const list = groups.get(g);
    if (!list || list.length === 0) continue;
    const leaves = [...list].sort(byLabelThenId).map((task): TaskTreeNode => ({
      id: task.id,
      kind: "task",
      label: task.label,
      depth: depth + 1,
      children: [],
      expandable: false,
      taskCount: 1,
      taskId: task.id,
      command: task.command,
      scope: task.scope,
      isDefault: task.isDefault,
      ...(task.dependsOn.length > 0 ? { dependsOn: task.dependsOn } : {}),
      group: g,
    }));
    out.push({
      id: `grp\u0000${folderIndex}\u0000${relPath}\u0000${g}`,
      kind: "group",
      label: GROUP_LABEL[g],
      depth,
      children: leaves,
      expandable: true,
      taskCount: leaves.length,
      group: g,
    });
  }
  return out;
}

/** Order packages: the root package (`""`) first, then the rest by path. */
const sortPackageKeys = (relPaths: Iterable<string>): string[] =>
  [...relPaths].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));

const sumCount = (nodes: readonly TaskTreeNode[]): number =>
  nodes.reduce((n, c) => n + c.taskCount, 0);

/** The children to place under a workspace (or at the top): a package node per package, or — when
 * the workspace's only package is its root — that root's groups directly, so a plain project is not
 * wrapped in a redundant package node. */
function workspaceChildren(
  folderIndex: number,
  pkgs: Map<string, Map<TaskPresentationGroup, ResolvedTask[]>>,
  normFolders: readonly string[],
  childDepth: number,
): TaskTreeNode[] {
  const relPaths = sortPackageKeys(pkgs.keys());
  const emitPackages = relPaths.length > 1 || (relPaths[0] !== undefined && relPaths[0] !== "");
  if (!emitPackages) {
    return groupNodes(
      pkgs.get(relPaths[0] ?? "") ?? new Map(),
      folderIndex,
      relPaths[0] ?? "",
      childDepth,
    );
  }
  return relPaths.map((relPath): TaskTreeNode => {
    const children = groupNodes(pkgs.get(relPath)!, folderIndex, relPath, childDepth + 1);
    return {
      id: `pkg\u0000${folderIndex}\u0000${relPath}`,
      kind: "package",
      label: packageLabel(normFolders, { folderIndex, relPath }),
      depth: childDepth,
      children,
      expandable: true,
      taskCount: sumCount(children),
      packageKey: packageKeyFor(folderIndex, relPath),
      relPath,
    };
  });
}

/**
 * Build the Workspace → Package → Group → Task tree from a (pre-filtered) task list. The workspace
 * level appears only in a multi-root workspace; the package level is omitted for a plain
 * single-package root. Everything is sorted deterministically, so the tree is stable for a given
 * input.
 */
export function buildTaskTree(
  tasks: readonly ResolvedTask[],
  folders: readonly string[],
): TaskTreeNode[] {
  const normFolders = folders.map(normAbs);
  const grouped = group(tasks, normFolders);
  const showWorkspace = folders.length > 1;
  const folderIndices = [...grouped.folders.keys()].sort((a, b) => a - b);

  if (!showWorkspace) {
    const only = folderIndices[0] ?? 0;
    return workspaceChildren(only, grouped.folders.get(only) ?? new Map(), normFolders, 0);
  }

  const out: TaskTreeNode[] = [];
  for (const folderIndex of folderIndices) {
    const children = workspaceChildren(
      folderIndex,
      grouped.folders.get(folderIndex)!,
      normFolders,
      1,
    );
    if (children.length === 0) continue;
    out.push({
      id: `ws\u0000${folderIndex}`,
      kind: "workspace",
      label: folderLabel(normFolders, folderIndex),
      depth: 0,
      children,
      expandable: true,
      taskCount: sumCount(children),
    });
  }
  return out;
}

// --- flatten / expansion (same contract as the Test Explorer's tree) ---------------------------

/** Default-expanded: everything, so a freshly opened panel shows its tasks (as the flat list did);
 * a user collapses what they do not need and that choice is remembered. */
const DEFAULT_EXPANDED = (): boolean => true;

/**
 * Flatten the tree to visible rows. A node is drawn when all its ancestors are expanded; a node's
 * own expansion is read from the set (`id` present → expanded, `!id` present → collapsed, else the
 * default).
 */
export function flattenVisible(
  roots: readonly TaskTreeNode[],
  expandedIds: ReadonlySet<string>,
  defaultExpanded: (node: TaskTreeNode) => boolean = DEFAULT_EXPANDED,
): TaskRow[] {
  const rows: TaskRow[] = [];
  const walk = (nodes: readonly TaskTreeNode[]): void => {
    for (const node of nodes) {
      const expanded = node.expandable
        ? expandedIds.has(node.id)
          ? true
          : expandedIds.has(`!${node.id}`)
            ? false
            : defaultExpanded(node)
        : false;
      rows.push({ node, expanded });
      if (node.expandable && expanded) walk(node.children);
    }
  };
  walk(roots);
  return rows;
}

/** Toggle a node's expansion immutably, honouring the default so the first click on a
 * default-open node collapses it (stored as the negated marker). */
export function toggleExpansion(
  expandedIds: ReadonlySet<string>,
  node: TaskTreeNode,
  defaultExpanded: (node: TaskTreeNode) => boolean = DEFAULT_EXPANDED,
): Set<string> {
  const next = new Set(expandedIds);
  const open = next.has(node.id) || (!next.has(`!${node.id}`) && defaultExpanded(node));
  next.delete(node.id);
  next.delete(`!${node.id}`);
  if (open) next.add(`!${node.id}`);
  else next.add(node.id);
  return next;
}

/** A compact signature of a task list's **identity** (not its run state): the tree need rebuild
 * only when this changes, so run ticks (which change no task identity) never rebuild it. */
export function tasksSignature(tasks: readonly ResolvedTask[]): string {
  let s = "";
  for (const t of tasks)
    s += `${t.id}\u0001${t.label}\u0001${t.group ?? ""}\u0001${t.scope}\u0001${t.cwd ?? ""}\u0001${t.isDefault ? 1 : 0}\u0001${t.dependsOn.join(",")}\u0002`;
  return s;
}
