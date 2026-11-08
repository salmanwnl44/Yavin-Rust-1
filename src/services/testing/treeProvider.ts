/**
 * The TestTreeProvider (WS5): projects a flat {@link TestReport} into the nested tree the Test
 * Explorer renders — file → suite(s) → case — and flattens it to the visible-row list a
 * virtualized list draws, honouring per-node expansion. Node ids are **stable** (derived from the
 * file path and the suite/case names, never from array position), so expansion state and the
 * selection survive a re-run that reorders or adds cases, exactly like the file Explorer.
 *
 * Pure projection: no process, file, or network access. The provider owns *shape and expansion*;
 * the controller owns running and the result store owns history.
 */
import { aggregateStatus } from "./model.ts";
import type { TestCase, TestReport, TestStatus } from "./model.ts";

export type TestNodeKind = "file" | "suite" | "case";

export interface TestTreeNode {
  readonly id: string;
  readonly kind: TestNodeKind;
  readonly label: string;
  readonly status: TestStatus;
  readonly depth: number;
  /** Present on case nodes: the file and, for a failure, the message, for navigation. */
  readonly file: string;
  readonly line?: number;
  readonly message?: string;
  readonly durationMs?: number;
  /** Passed only after a retry (Playwright flaky), for a case node. */
  readonly flaky?: boolean;
  readonly children: readonly TestTreeNode[];
  /** True for file/suite nodes (they can expand); false for leaf case nodes. */
  readonly expandable: boolean;
}

/** A node flattened for rendering, with whether it is currently expanded. */
export interface TestRow {
  readonly node: TestTreeNode;
  readonly expanded: boolean;
}

/** Stable id for a suite: its file plus the full ancestor path (NUL-separated, never positional). */
export function suiteId(file: string, ancestors: readonly string[]): string {
  return `${file}\u0000suite\u0000${ancestors.join("\u0000")}`;
}

/** Build the nested tree from a report. Cases are grouped under their `ancestors` suite path. */
export function buildTree(report: TestReport): readonly TestTreeNode[] {
  return report.files.map((file) => {
    const root = newSuiteGroup();
    for (const c of file.cases) insert(root, c, file.file);
    const children = materialize(root, file.file, [], 1);
    return {
      id: file.id,
      kind: "file" as const,
      label: file.label,
      status: file.status,
      depth: 0,
      file: file.file,
      children,
      expandable: children.length > 0,
    };
  });
}

interface SuiteGroup {
  readonly cases: TestCase[];
  readonly suites: Map<string, SuiteGroup>;
}
const newSuiteGroup = (): SuiteGroup => ({ cases: [], suites: new Map() });

function insert(group: SuiteGroup, c: TestCase, _file: string): void {
  let node = group;
  for (const name of c.ancestors) {
    let child = node.suites.get(name);
    if (!child) {
      child = newSuiteGroup();
      node.suites.set(name, child);
    }
    node = child;
  }
  node.cases.push(c);
}

/** Depth-first build: suites first (in first-seen order), then the group's own cases. */
function materialize(
  group: SuiteGroup,
  file: string,
  ancestors: readonly string[],
  depth: number,
): TestTreeNode[] {
  const out: TestTreeNode[] = [];
  for (const [name, child] of group.suites) {
    const childAncestors = [...ancestors, name];
    const children = materialize(child, file, childAncestors, depth + 1);
    out.push({
      id: suiteId(file, childAncestors),
      kind: "suite",
      label: name,
      status: aggregateStatus(collectStatuses(children)),
      depth,
      file,
      children,
      expandable: children.length > 0,
    });
  }
  for (const c of group.cases) {
    out.push({
      // The case's own stable id from its parser — not a recomputation from the label, which would
      // lose a framework's real identity (Cargo's `a::b::test`, a pytest node id, …).
      id: c.id,
      kind: "case",
      label: c.label,
      status: c.status,
      depth,
      file,
      line: c.location.line,
      message: c.message,
      durationMs: c.durationMs,
      flaky: c.flaky,
      children: [],
      expandable: false,
    });
  }
  return out;
}

function collectStatuses(nodes: readonly TestTreeNode[]): TestStatus[] {
  const out: TestStatus[] = [];
  for (const n of nodes) {
    if (n.kind === "case") out.push(n.status);
    else out.push(...collectStatuses(n.children));
  }
  return out;
}

/**
 * Flatten the tree to visible rows for a virtualized list. A node is drawn when all its ancestors
 * are expanded; `expanded` is read from the set (ids absent from the set use `defaultExpanded`).
 */
export function flattenVisible(
  roots: readonly TestTreeNode[],
  expandedIds: ReadonlySet<string>,
  defaultExpanded: (node: TestTreeNode) => boolean = (n) => n.kind === "file",
): TestRow[] {
  const rows: TestRow[] = [];
  const walk = (nodes: readonly TestTreeNode[]) => {
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

/** Toggle a node's expansion in an immutable set, honouring the default-expanded rule so the
 * first click on a default-open file correctly collapses it (stored as the negated marker). */
export function toggleExpansion(
  expandedIds: ReadonlySet<string>,
  node: TestTreeNode,
  defaultExpanded: (node: TestTreeNode) => boolean = (n) => n.kind === "file",
): Set<string> {
  const next = new Set(expandedIds);
  const open = next.has(node.id) || (!next.has(`!${node.id}`) && defaultExpanded(node));
  next.delete(node.id);
  next.delete(`!${node.id}`);
  if (open)
    next.add(`!${node.id}`); // now collapsed
  else next.add(node.id); // now expanded
  return next;
}
