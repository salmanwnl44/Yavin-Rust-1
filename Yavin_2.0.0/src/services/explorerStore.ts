import { relativePath } from "./resource.ts";
import type {
  Disposable,
  ExplorerNodeId,
  ExplorerProvider,
  ExplorerProviderEvent,
} from "./explorerProvider.ts";

/**
 * The Explorer's UI state, and nothing else: which folders are expanded, what is selected,
 * where the selection's anchor and the keyboard focus are. Never file contents, filesystem
 * facts, Git status or documents -- those are their owners'.
 *
 * State is keyed by node identity (the provider's ResourceId-based ids) and remembers the
 * path each was recorded under, which is what the tree view works in. It follows the
 * provider: a `renamed` node takes its state -- and its subtree's -- to the new identity, so
 * a renamed folder stays expanded and a renamed file stays selected; a `deleted` node's state
 * goes with it; a `reset` clears selection and focus.
 *
 * For the existing tree view, `paths(...)` gives the familiar `Set<string>` of paths and
 * `setter(...)` the familiar setter (a value, or a function of the previous one), so the view
 * reads and writes this store exactly as it read and wrote its own state before.
 */

export type ExplorerSetName = "expanded" | "selection";
export type ExplorerValueName = "anchor" | "focused";

type Keyed = Map<ExplorerNodeId, string>;

export type ExplorerStore = ReturnType<typeof createExplorerStore>;

export function createExplorerStore(
  provider: Pick<ExplorerProvider, "subscribe"> & { idFor(path: string): ExplorerNodeId },
  initial: { expanded?: readonly string[] } = {},
) {
  const sets: Record<ExplorerSetName, Keyed> = { expanded: new Map(), selection: new Map() };
  const values: Record<ExplorerValueName, { id: ExplorerNodeId; path: string } | null> = {
    anchor: null,
    focused: null,
  };
  for (const path of initial.expanded ?? []) sets.expanded.set(provider.idFor(path), path);

  const listeners = new Set<() => void>();
  let revision = 0;
  const views: Partial<Record<ExplorerSetName, { revision: number; paths: Set<string> }>> = {};
  const changed = () => {
    revision++;
    for (const listener of [...listeners]) listener();
  };

  const keyed = (paths: Iterable<string>): Keyed => {
    const map: Keyed = new Map();
    for (const path of paths) map.set(provider.idFor(path), path);
    return map;
  };
  const sameKeys = (a: Keyed, b: Keyed) => {
    if (a.size !== b.size) return false;
    for (const [id, path] of a) if (b.get(id) !== path) return false;
    return true;
  };

  /** State at or under `path`, moved to the same place under `to` -- or dropped, without one. */
  const remap = (from: string, to: string | null) => {
    let any = false;
    for (const name of ["expanded", "selection"] as const) {
      const next: Keyed = new Map();
      for (const [id, path] of sets[name]) {
        const rel = relativePath(from, path);
        if (rel === undefined) {
          next.set(id, path);
          continue;
        }
        any = true;
        if (to === null) continue;
        const moved = rel === "." ? to : `${to}/${rel}`;
        next.set(provider.idFor(moved), moved);
      }
      sets[name] = next;
    }
    for (const name of ["anchor", "focused"] as const) {
      const value = values[name];
      const rel = value && relativePath(from, value.path);
      if (!value || rel === undefined || rel === null) continue;
      any = true;
      if (to === null) values[name] = null;
      else {
        const moved = rel === "." ? to : `${to}/${rel}`;
        values[name] = { id: provider.idFor(moved), path: moved };
      }
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

  const setters: Partial<Record<ExplorerSetName | ExplorerValueName, unknown>> = {};

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

    has(name: ExplorerSetName, id: ExplorerNodeId): boolean {
      return sets[name].has(id);
    },
    ids(name: ExplorerSetName): ExplorerNodeId[] {
      return [...sets[name].keys()];
    },
    /** The set as paths, the same object until it changes. */
    paths(name: ExplorerSetName): Set<string> {
      const view = views[name];
      if (view && view.revision === revision) return view.paths;
      const paths = new Set(sets[name].values());
      views[name] = { revision, paths };
      return paths;
    },
    /** A stable setter taking paths, or a function of the previous paths. */
    setter(
      name: ExplorerSetName,
    ): (next: Set<string> | ((previous: Set<string>) => Set<string>)) => void {
      return (setters[name] ??= (next: Set<string> | ((previous: Set<string>) => Set<string>)) => {
        const paths = typeof next === "function" ? next(store.paths(name)) : next;
        const map = keyed(paths);
        if (sameKeys(map, sets[name])) return;
        sets[name] = map;
        changed();
      }) as (next: Set<string> | ((previous: Set<string>) => Set<string>)) => void;
    },
    value(name: ExplorerValueName): string | null {
      return values[name]?.path ?? null;
    },
    valueSetter(name: ExplorerValueName): (next: string | null) => void {
      return (setters[name] ??= (next: string | null) => {
        const current = values[name];
        if ((current?.path ?? null) === next) return;
        values[name] = next === null ? null : { id: provider.idFor(next), path: next };
        changed();
      }) as (next: string | null) => void;
    },
  };
  return store;
}
