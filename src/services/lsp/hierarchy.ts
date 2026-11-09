/**
 * Generic LSP hierarchy model (WS14 call hierarchy, WS15 type hierarchy): a lazy, cycle-safe tree
 * of related symbols along a chosen **direction** (callers/callees, or supertypes/subtypes). Pure
 * and testable — the children of a node load only when it is expanded, through an injected `load`
 * function, so the LSP manager keeps ownership of the requests and server identity. A node whose
 * symbol already appears on the path from the root is marked **cyclic** and not expanded again, so
 * recursion/inheritance loops stay finite. A per-expansion token drops a slow response a newer
 * action (direction switch, dispose) superseded; `getRows` returns a cached snapshot stable for
 * `useSyncExternalStore`.
 *
 * Symbol identity (for cycle detection and node ids) is **uri + selection-range start + name +
 * kind** — not the name alone, so two distinct symbols that happen to share a name (in different
 * files, or an overload) are not falsely treated as a cycle, while a genuine repeat of the same
 * symbol at a deeper level is. (Items from different servers carry different uris/ranges, so they
 * never collide.) It cannot distinguish two symbols a server reports at the identical uri, range,
 * name and kind — a case real servers do not produce.
 */
import type { Range } from "./protocol.ts";

/** The common shape of a `CallHierarchyItem`/`TypeHierarchyItem` the tree needs. */
export interface HierarchyItem {
  readonly name: string;
  readonly kind: number;
  readonly tags?: number[];
  readonly detail?: string;
  readonly uri: string;
  readonly range: Range;
  readonly selectionRange: Range;
  readonly data?: unknown;
}

/** A child produced by expanding a node: the related item, and (call hierarchy) its call-site ranges. */
export interface HierarchyChild {
  readonly item: HierarchyItem;
  readonly fromRanges?: readonly Range[];
}

export interface HierarchyNode {
  /** Stable id: the `\u0000`-joined item keys from the root, so expansion/selection survive. */
  readonly id: string;
  readonly item: HierarchyItem;
  readonly depth: number;
  readonly fromRanges: readonly Range[];
  /** This item already appears on the path to the root — a cycle; not expanded further. */
  readonly cyclic: boolean;
  children: HierarchyNode[] | null; // null = not loaded yet
  loading: boolean;
  error: string | null;
  expanded: boolean;
}

export interface HierarchyRow {
  readonly node: HierarchyNode;
}

export interface HierarchyDeps {
  /** The direction to start in (one of `directions`). */
  readonly initial: string;
  /** The available directions, in display order. */
  readonly directions: readonly string[];
  readonly root: HierarchyItem;
  /** Load a node's children in a direction (callers/callees/supertypes/subtypes); null → none. */
  readonly load: (direction: string, item: HierarchyItem) => Promise<HierarchyChild[] | null>;
}

export interface Hierarchy {
  getRows(): readonly HierarchyRow[];
  direction(): string;
  directions(): readonly string[];
  rootItem(): HierarchyItem;
  subscribe(listener: () => void): () => void;
  /** Expand (loading children on first open) or collapse a node. */
  toggle(node: HierarchyNode): Promise<void>;
  /** Switch direction, rebuilding from the root (old-direction children are not retained). */
  setDirection(direction: string): void;
  dispose(): void;
}

/** Stable identity: file, selection start, name and kind — robust to name collisions across files. */
export const itemKey = (item: HierarchyItem): string =>
  `${item.uri}\u0000${item.selectionRange.start.line}:${item.selectionRange.start.character}\u0000${item.kind}\u0000${item.name}`;

export function createHierarchy(deps: HierarchyDeps): Hierarchy {
  let disposed = false;
  let direction = deps.initial;
  let token = 0;
  const listeners = new Set<() => void>();
  // A stable rows snapshot for `useSyncExternalStore`: invalidated on every mutation (via `emit`).
  let rowsCache: readonly HierarchyRow[] | null = null;

  const emit = () => {
    rowsCache = null;
    for (const listener of [...listeners])
      try {
        listener();
      } catch {
        /* a listener's failure is not the model's */
      }
  };

  const parentOf = new WeakMap<HierarchyNode, HierarchyNode | null>();

  const makeNode = (
    item: HierarchyItem,
    parent: HierarchyNode | null,
    fromRanges: readonly Range[],
    ancestors: ReadonlySet<string>,
  ): HierarchyNode => {
    const cyclic = ancestors.has(itemKey(item));
    const node: HierarchyNode = {
      id: parent ? `${parent.id}\u0000${itemKey(item)}` : itemKey(item),
      item,
      depth: parent ? parent.depth + 1 : 0,
      fromRanges,
      cyclic,
      children: cyclic ? [] : null, // a cycle has nothing further to load
      loading: false,
      error: null,
      expanded: false,
    };
    parentOf.set(node, parent);
    return node;
  };

  let root = makeNode(deps.root, null, [], new Set());

  const pathKeys = (node: HierarchyNode): Set<string> => {
    const keys = new Set<string>();
    let cur: HierarchyNode | null = node;
    while (cur) {
      keys.add(itemKey(cur.item));
      cur = parentOf.get(cur) ?? null;
    }
    return keys;
  };

  const load = async (node: HierarchyNode): Promise<void> => {
    if (node.cyclic || node.children !== null) return;
    const mine = ++token;
    const activeDirection = direction;
    node.loading = true;
    node.error = null;
    emit();
    try {
      const ancestors = pathKeys(node);
      const children = ((await deps.load(activeDirection, node.item)) ?? []).map((child) =>
        makeNode(child.item, node, child.fromRanges ?? [], ancestors),
      );
      if (disposed || mine !== token) return;
      node.children = children;
    } catch (error) {
      if (disposed || mine !== token) return;
      node.children = [];
      node.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (!disposed && mine === token) node.loading = false;
      emit();
    }
  };

  const flatten = (): HierarchyRow[] => {
    const rows: HierarchyRow[] = [];
    const walk = (node: HierarchyNode) => {
      rows.push({ node });
      if (node.expanded && node.children) for (const child of node.children) walk(child);
    };
    walk(root);
    return rows;
  };

  return {
    getRows: () => (rowsCache ??= flatten()),
    direction: () => direction,
    directions: () => deps.directions,
    rootItem: () => root.item,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async toggle(node) {
      if (node.cyclic) return;
      if (node.children === null) await load(node);
      if (disposed) return;
      node.expanded = !node.expanded;
      emit();
    },
    setDirection(next) {
      if (next === direction || !deps.directions.includes(next)) return;
      direction = next;
      token++; // drop any in-flight load from the old direction
      root = makeNode(deps.root, null, [], new Set());
      emit();
    },
    dispose() {
      disposed = true;
      token++;
      listeners.clear();
    },
  };
}
