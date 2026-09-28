import { relativePath } from "./resource.ts";
import type {
  Disposable,
  ExplorerNodeId,
  ExplorerProvider,
  ExplorerProviderEvent,
  ExplorerResourceNode,
} from "./explorerProvider.ts";

/**
 * The Explorer's UI state, and nothing else: which folders are expanded, what is selected,
 * where the selection's anchor and the keyboard focus are, and revealing a resource. Never
 * file contents, filesystem facts, Git status or documents -- those are their owners'.
 *
 * State is keyed by node identity (the provider's ResourceId-based ids), and each entry
 * remembers the path it was recorded under -- for the session, and so that state for a
 * folder not listed yet (a restored expansion) can be kept. It follows the provider: a
 * `renamed` node takes its state, and its subtree's, to the new identity, so a renamed folder
 * stays expanded and a moved file stays selected; a `deleted` node's state goes with it; a
 * `reset` clears selection and focus.
 */

export type ExplorerSetName = "expanded" | "selection";

type Keyed = Map<ExplorerNodeId, string>;
type IdSet = ReadonlySet<ExplorerNodeId>;
type SetUpdate = IdSet | ((previous: IdSet) => IdSet);

/** What the store needs of a provider. */
export type StoreProvider = Pick<ExplorerProvider, "subscribe" | "getNode"> & {
  idFor(path: string): ExplorerNodeId;
  loadChildren(id: ExplorerNodeId, signal?: AbortSignal): Promise<void>;
  ancestorsOf(path: string): { root: ExplorerNodeId; folders: string[] } | null;
};

export type ExplorerStore = ReturnType<typeof createExplorerStore>;

export function createExplorerStore(
  provider: StoreProvider,
  initial: {
    expanded?: readonly string[];
    selection?: readonly string[];
    focused?: string | null;
  } = {},
) {
  const keyed = (paths: Iterable<string>): Keyed => {
    const map: Keyed = new Map();
    for (const path of paths) map.set(provider.idFor(path), path);
    return map;
  };
  const sets: Record<ExplorerSetName, Keyed> = {
    expanded: keyed(initial.expanded ?? []),
    selection: keyed(initial.selection ?? []),
  };
  const at = (path: string | null | undefined) =>
    path ? { id: provider.idFor(path), path } : null;
  const values = { anchor: at(initial.focused), focused: at(initial.focused) };

  const listeners = new Set<() => void>();
  let revision = 0;
  /** Bumped by each reveal: an older one still loading gives way to a newer one. */
  let reveals = 0;
  /**
   * Each set's ids and paths as handed out: the same objects until that set itself changes --
   * not when another does -- so a view that recomputes from the expanded set (the tree's rows)
   * does not recompute because the selection moved. Every change replaces the set's Map, so
   * the Map is the cache key.
   */
  const views: Partial<Record<ExplorerSetName, { source: Keyed; ids: IdSet; paths: Set<string> }>> =
    {};
  const changed = () => {
    revision++;
    for (const listener of [...listeners]) listener();
  };

  /** The path an id stands for: the node's, or what it was recorded under. */
  const pathOf = (id: ExplorerNodeId, known?: Keyed): string | undefined =>
    provider.getNode(id)?.path ?? known?.get(id) ?? sets.expanded.get(id) ?? sets.selection.get(id);

  const view = (name: ExplorerSetName) => {
    let current = views[name];
    if (!current || current.source !== sets[name]) {
      current = {
        source: sets[name],
        ids: new Set(sets[name].keys()),
        paths: new Set(sets[name].values()),
      };
      views[name] = current;
    }
    return current;
  };

  const update = (name: ExplorerSetName, next: SetUpdate) => {
    const ids = typeof next === "function" ? next(view(name).ids) : next;
    const map: Keyed = new Map();
    for (const id of ids) {
      const path = pathOf(id, sets[name]);
      // An id the provider does not know and the store never recorded names nothing.
      if (path !== undefined) map.set(id, path);
    }
    const before = sets[name];
    if (map.size === before.size && [...map].every(([id, path]) => before.get(id) === path)) return;
    sets[name] = map;
    changed();
  };

  /** State at or under `from`, moved to the same place under `to` -- or dropped, without one. */
  const remap = (from: string, to: string | null) => {
    let any = false;
    const move = (path: string): { id: ExplorerNodeId; path: string } | null | undefined => {
      const rel = relativePath(from, path);
      if (rel === undefined) return undefined;
      any = true;
      if (to === null) return null;
      const moved = rel === "." ? to : `${to}/${rel}`;
      return { id: provider.idFor(moved), path: moved };
    };
    for (const name of ["expanded", "selection"] as const) {
      const next: Keyed = new Map();
      let touched = false;
      for (const [id, path] of sets[name]) {
        const moved = move(path);
        if (moved === undefined) next.set(id, path);
        else {
          touched = true;
          if (moved) next.set(moved.id, moved.path);
        }
      }
      // Replaced only if something in it moved: an untouched set keeps its identity.
      if (touched) sets[name] = next;
    }
    for (const name of ["anchor", "focused"] as const) {
      const value = values[name];
      if (!value) continue;
      const moved = move(value.path);
      if (moved !== undefined) values[name] = moved;
    }
    return any;
  };

  const onEvent = (event: ExplorerProviderEvent) => {
    if (event.type === "renamed") {
      if (remap(event.fromPath, event.toPath)) changed();
    } else if (event.type === "deleted") {
      if (remap(event.path, null)) changed();
    } else if (event.type === "reset") {
      if (sets.selection.size || values.anchor || values.focused) {
        sets.selection = new Map();
        values.anchor = null;
        values.focused = null;
        changed();
      }
    }
  };

  const valueSetter = (name: "anchor" | "focused") => (id: ExplorerNodeId | null) => {
    const current = values[name];
    if ((current?.id ?? null) === id) return;
    const path = id === null ? undefined : pathOf(id);
    values[name] = id === null || path === undefined ? null : { id, path };
    changed();
  };

  const store = {
    /** Starts following the provider; returns how to stop. */
    attach(): Disposable {
      return provider.subscribe(onEvent);
    },
    subscribe(listener: () => void): Disposable {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    revision: (): number => revision,

    /** The ids in a set: the same object until the set changes. */
    ids(name: ExplorerSetName): IdSet {
      return view(name).ids;
    },
    /** The set as the paths its entries were recorded under -- for the session. */
    paths(name: ExplorerSetName): Set<string> {
      return view(name).paths;
    },
    has(name: ExplorerSetName, id: ExplorerNodeId): boolean {
      return sets[name].has(id);
    },
    setExpanded: (next: SetUpdate) => update("expanded", next),
    setSelection: (next: SetUpdate) => update("selection", next),
    anchor: (): ExplorerNodeId | null => values.anchor?.id ?? null,
    focused: (): ExplorerNodeId | null => values.focused?.id ?? null,
    focusedPath: (): string | null => values.focused?.path ?? null,
    setAnchor: valueSetter("anchor"),
    setFocused: valueSetter("focused"),
    /** The path of a node or of a recorded entry, if known. */
    pathOf: (id: ExplorerNodeId): string | undefined => pathOf(id),

    /**
     * Shows the resource at `path`: expands its root and every folder above it, has the
     * provider list the ones not loaded yet (outermost first), then selects it and makes it
     * the focused row -- which the view scrolls to without taking keyboard focus from where it
     * is. The view does no traversal of its own. Resolves to whether it is shown; a later
     * reveal supersedes one still loading, which then changes nothing more.
     */
    async reveal(path: string): Promise<boolean> {
      const reveal = ++reveals;
      const where = provider.ancestorsOf(path);
      if (!where) return false;
      const root = provider.getNode(where.root) as ExplorerResourceNode | undefined;
      if (!root) return false;
      const chain = [root.path, ...where.folders];
      const expanded = new Map(sets.expanded);
      for (const folder of chain) expanded.set(provider.idFor(folder), folder);
      if (expanded.size !== sets.expanded.size) {
        sets.expanded = expanded;
        changed();
      }
      for (const folder of chain) {
        try {
          await provider.loadChildren(provider.idFor(folder));
        } catch {
          // The folder could not be listed: its row shows why. Nothing further to show.
          return false;
        }
        if (reveal !== reveals) return false;
      }
      const target = provider.idFor(path);
      const node = provider.getNode(target);
      if (!node) return false;
      sets.selection = new Map([[target, node.path]]);
      values.anchor = { id: target, path: node.path };
      values.focused = { id: target, path: node.path };
      changed();
      return true;
    },
  };
  return store;
}
