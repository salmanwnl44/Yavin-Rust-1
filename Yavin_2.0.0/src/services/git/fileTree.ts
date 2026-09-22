/**
 * Groups a flat list of paths into a folder tree for the "View as Tree" toggles (the Changes
 * list, and a selected commit's changed files). Single-child folder chains are compacted into
 * one row (`app/yavin_core` instead of `app` containing only `yavin_core`), matching the
 * compact-folders behavior every VS Code-family Explorer/Source Control tree already has.
 *
 * `T` is whatever the caller already has per file (a `GitEntry`, a `CommitFileChange`, …); this
 * module never re-shapes that data, it only groups it by `pathOf(item)`, so a caller building a
 * tree from `GitEntry[]` still gets `GitEntry` at each leaf, unchanged.
 */

export interface TreeFolder<T> {
  kind: "folder";
  /** May combine several path segments when they nest with nothing else alongside them. */
  name: string;
  /** The full path through the innermost segment folded into this row. */
  path: string;
  children: TreeNode<T>[];
}

export interface TreeFile<T> {
  kind: "file";
  name: string;
  path: string;
  item: T;
}

export type TreeNode<T> = TreeFolder<T> | TreeFile<T>;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function sortChildren<T>(nodes: TreeNode<T>[]): void {
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
    return collator.compare(a.name, b.name);
  });
  for (const node of nodes) if (node.kind === "folder") sortChildren(node.children);
}

/** Merges a folder into its one-and-only child folder, repeatedly, until that's no longer true. */
function compact<T>(node: TreeFolder<T>): TreeFolder<T> {
  let name = node.name;
  let path = node.path;
  let children = node.children;
  while (children.length === 1 && children[0].kind === "folder") {
    const only = children[0];
    name = `${name}/${only.name}`;
    path = only.path;
    children = only.children;
  }
  return { kind: "folder", name, path, children: children.map(compactNode) };
}

function compactNode<T>(node: TreeNode<T>): TreeNode<T> {
  return node.kind === "folder" ? compact(node) : node;
}

/**
 * Builds the tree. `pathOf` must return a `/`-separated, non-empty path (this codebase's own
 * convention throughout `src/services/git`); a leading `/` is treated as the root and stripped
 * from segment splitting, so both repo-relative and absolute paths group the same way.
 */
export function buildFileTree<T>(items: readonly T[], pathOf: (item: T) => string): TreeNode<T>[] {
  const root: TreeFolder<T> = { kind: "folder", name: "", path: "", children: [] };
  const foldersByPath = new Map<string, TreeFolder<T>>([["", root]]);

  for (const item of items) {
    const full = pathOf(item);
    const segments = full.split("/").filter(Boolean);
    if (segments.length === 0) continue;
    let parent = root;
    let builtPath = "";
    for (let i = 0; i < segments.length - 1; i++) {
      builtPath = builtPath ? `${builtPath}/${segments[i]}` : segments[i];
      let folder = foldersByPath.get(builtPath);
      if (!folder) {
        folder = { kind: "folder", name: segments[i], path: builtPath, children: [] };
        foldersByPath.set(builtPath, folder);
        parent.children.push(folder);
      }
      parent = folder;
    }
    const name = segments[segments.length - 1];
    parent.children.push({ kind: "file", name, path: full, item });
  }

  const compacted = root.children.map(compactNode);
  sortChildren(compacted);
  return compacted;
}

/** One row of a rendered tree: the node, its indentation depth, and whether it's expanded
 * (always `true` for a file -- only folders can be collapsed). */
export interface VisibleTreeRow<T> {
  node: TreeNode<T>;
  depth: number;
  expanded: boolean;
}

/**
 * Flattens a tree into the rows a virtualized or plain list actually renders, skipping the
 * children of any folder whose `path` is in `collapsed`. A folder not mentioned in `collapsed`
 * is expanded by default, matching how the Changes list and commit-detail tree both want to
 * start (everything open until the user folds something).
 */
export function flattenVisible<T>(
  nodes: readonly TreeNode<T>[],
  collapsed: ReadonlySet<string>,
  depth = 0,
): VisibleTreeRow<T>[] {
  const rows: VisibleTreeRow<T>[] = [];
  for (const node of nodes) {
    if (node.kind === "file") {
      rows.push({ node, depth, expanded: true });
      continue;
    }
    const expanded = !collapsed.has(node.path);
    rows.push({ node, depth, expanded });
    if (expanded) rows.push(...flattenVisible(node.children, collapsed, depth + 1));
  }
  return rows;
}

/** Every file `item` in the tree, in the same order `flattenVisible` would show them fully
 * expanded -- for bulk actions ("Stage All" on a folder) that must act on every descendant. */
export function collectFiles<T>(nodes: readonly TreeNode<T>[]): T[] {
  const items: T[] = [];
  for (const node of nodes) {
    if (node.kind === "file") items.push(node.item);
    else items.push(...collectFiles(node.children));
  }
  return items;
}
