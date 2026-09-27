import type { FileNode } from "../types.ts";
import { basename, fileUri, relativePath, resourceId, unprefixed } from "./resource.ts";
import type { ResourceUri } from "./resource.ts";
import type { ResourceChange } from "./resourceEvents.ts";

/**
 * The Explorer Provider Platform: the hierarchy of resources the Explorer shows, as a
 * projection of the filesystem -- never a store of filesystem truth.
 *
 * ```text
 * Filesystem ── list_workspace_files ─┐        ┌── resource-changes (Module 02)
 *                                     v        v
 *                          ExplorerProvider (this file)
 *                     typed nodes, ResourceId identity, per-folder state
 *                                     │ provider events (created, renamed, ...)
 *                                     v
 *                  ExplorerStore (UI state)  +  projection() for the tree view
 * ```
 *
 * The provider holds what has been listed and nothing more: which folders are loaded, what
 * they held when last listed, which listing failed and why. Every fact comes from a listing
 * of the native side; every change is reconciled against the next listing. A folder that is
 * not loaded costs nothing, and a change inside it is not even looked at.
 *
 * Snapshots are synchronous (`getRootNodes`, `getChildren`, `projection`): the view reads what
 * is known. Only listing is asynchronous (`loadChildren`, `refresh`), and every listing
 * carries a generation, so an older answer never overwrites a newer one.
 *
 * Identity: a resource node's id is its Module 01 `ResourceId`, so it is the same across
 * refreshes, re-renders and unrelated changes, and every spelling of a path (case on Windows,
 * `\\?\`, slashes) is one node. A rename is a move: the node and its loaded subtree take the
 * new identity, and a `renamed` event lets the UI state follow them.
 */

export type ExplorerNodeId = string & { readonly __explorerNodeId: unique symbol };

export type ExplorerNodeKind = "workspace" | "directory" | "file" | "error";

interface ResourceNodeBase {
  readonly id: ExplorerNodeId;
  readonly resource: ResourceUri;
  /** The path as the native side spells it, for commands and display. */
  readonly path: string;
  readonly parentId: ExplorerNodeId | null;
  readonly name: string;
  readonly size?: number;
  readonly modified?: number | null;
  readonly readonly?: boolean;
}
/** A workspace root: a folder at the top of the Explorer, one per root in a multi-root window. */
export interface ExplorerWorkspaceNode extends ResourceNodeBase {
  readonly kind: "workspace";
  readonly parentId: null;
}
export interface ExplorerDirectoryNode extends ResourceNodeBase {
  readonly kind: "directory";
}
export interface ExplorerFileNode extends ResourceNodeBase {
  readonly kind: "file";
}
/** A folder whose listing failed, in place of its children: the failure, never "empty". */
export interface ExplorerErrorNode {
  readonly kind: "error";
  readonly id: ExplorerNodeId;
  readonly parentId: ExplorerNodeId;
  readonly message: string;
}
export type ExplorerResourceNode = ExplorerWorkspaceNode | ExplorerDirectoryNode | ExplorerFileNode;
export type ExplorerNode = ExplorerResourceNode | ExplorerErrorNode;

/** What a folder's children are known to be. */
export type ExplorerChildrenState =
  | { readonly status: "unloaded" }
  | { readonly status: "loading" }
  | { readonly status: "loaded" }
  /** Never listed successfully: the listing's error. */
  | { readonly status: "failed"; readonly message: string };

/** What can be done with a node, so the UI need not guess from what kind of provider it is. */
export interface ExplorerCapabilities {
  readonly canOpen: boolean;
  readonly canCreateFile: boolean;
  readonly canCreateDirectory: boolean;
  readonly canRename: boolean;
  readonly canDelete: boolean;
  readonly canMove: boolean;
  readonly canCopy: boolean;
  readonly canRefresh: boolean;
}

export type ExplorerProviderEvent =
  | { readonly type: "created"; readonly node: ExplorerResourceNode }
  /** Its metadata changed (size, time, read-only); same identity. */
  | { readonly type: "changed"; readonly node: ExplorerResourceNode }
  /** Gone, with everything below it. */
  | { readonly type: "deleted"; readonly id: ExplorerNodeId; readonly path: string }
  /** Moved or renamed, with everything below it: state keyed by `from` belongs to `to` now. */
  | {
      readonly type: "renamed";
      readonly from: ExplorerNodeId;
      readonly to: ExplorerNodeId;
      readonly fromPath: string;
      readonly toPath: string;
    }
  /** Which children a folder has, or its loading state, changed. */
  | { readonly type: "childrenChanged"; readonly parentId: ExplorerNodeId }
  /** The roots changed: everything before is gone. */
  | { readonly type: "reset" }
  | { readonly type: "error"; readonly id: ExplorerNodeId; readonly message: string };

export type ExplorerProviderListener = (event: ExplorerProviderEvent) => void;
export type Disposable = () => void;

/** The provider contract: what a view and a store can rely on, whatever the resources are. */
export interface ExplorerProvider {
  getRootNodes(): ExplorerResourceNode[];
  getNode(id: ExplorerNodeId): ExplorerResourceNode | undefined;
  /** Known children: the listed ones, an error node for a failed listing, none if unloaded. */
  getChildren(id: ExplorerNodeId): ExplorerNode[];
  childrenState(id: ExplorerNodeId): ExplorerChildrenState;
  capabilities(id: ExplorerNodeId): ExplorerCapabilities;
  loadChildren?(id: ExplorerNodeId, signal?: AbortSignal): Promise<void>;
  subscribe(listener: ExplorerProviderListener): Disposable;
}

/** One level of a folder, as the native `list_workspace_files` returns it. */
export interface ExplorerIO {
  list(path: string): Promise<FileNode>;
}

/** The FileNode the existing tree view renders, plus what the provider knows of a folder. */
export type ProjectedNode = FileNode & {
  /** The node's identity (its ResourceId). */
  id?: string;
  /** Set on a folder whose listing failed and which has no children to show. */
  loadError?: string;
  children?: ProjectedNode[] | null;
};

// ---------------------------------------------------------------------------------------

interface Entry {
  node: ExplorerResourceNode;
  /** Child ids in listing order; null until the folder has been listed. */
  children: ExplorerNodeId[] | null;
  /** The last listing's error: the whole state if never listed, beside the children if it was. */
  error: string | null;
  /** The generation of the latest listing asked for; answers to older ones are dropped. */
  requested: number;
  /** A listing is in flight (the generation it is for), or 0. */
  loading: number;
  /**
   * Who is waiting on the listing in flight: each caller's signal, or undefined for one that
   * cannot be abandoned (a refresh). Its answer is dropped only if every one of them aborted.
   */
  interest: (AbortSignal | undefined)[];
  /** Bumped with every change to this node or anything below it: the projection's cache key. */
  version: number;
}

const NOTHING: ExplorerCapabilities = {
  canOpen: false,
  canCreateFile: false,
  canCreateDirectory: false,
  canRename: false,
  canDelete: false,
  canMove: false,
  canCopy: false,
  canRefresh: false,
};

const parentPathOf = (path: string): string => {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : path;
};

export type FileSystemExplorerProvider = ReturnType<typeof createFileSystemExplorerProvider>;

/**
 * The filesystem provider: workspace roots and what `list_workspace_files` says is in them.
 * Future providers (virtual, remote, archive) implement `ExplorerProvider` the same way.
 */
export function createFileSystemExplorerProvider(io: ExplorerIO) {
  const entries = new Map<ExplorerNodeId, Entry>();
  let roots: ExplorerNodeId[] = [];
  const listeners = new Set<ExplorerProviderListener>();
  let revision = 0;
  let counter = 0;
  let generation = 0;
  const projections = new Map<ExplorerNodeId, { version: number; node: ProjectedNode }>();

  const emit = (event: ExplorerProviderEvent) => {
    revision++;
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        console.error("Explorer listener failed:", error);
      }
    }
  };

  const idFor = (path: string): ExplorerNodeId =>
    resourceId(fileUri(path)) as string as ExplorerNodeId;

  /** A change here: this node and every ancestor get a new version (O(depth)). */
  const touch = (id: ExplorerNodeId | null) => {
    for (let at = id; at; at = entries.get(at)?.node.parentId ?? null) {
      const entry = entries.get(at);
      if (!entry) break;
      entry.version = ++counter;
    }
  };

  const nodeFrom = (
    listed: FileNode,
    parentId: ExplorerNodeId | null,
    id = idFor(listed.path),
  ): ExplorerResourceNode => {
    const path = unprefixed(listed.path);
    const resource = fileUri(path);
    const base = {
      id,
      resource,
      path,
      parentId,
      name: listed.name || basename(resource) || path,
      size: listed.size,
      modified: listed.modified,
      readonly: listed.readonly,
    };
    if (parentId === null) return { ...base, kind: "workspace", parentId: null };
    return listed.is_dir ? { ...base, kind: "directory" } : { ...base, kind: "file" };
  };

  const sameNode = (a: ExplorerResourceNode, b: ExplorerResourceNode) =>
    a.kind === b.kind &&
    a.path === b.path &&
    a.name === b.name &&
    a.size === b.size &&
    a.modified === b.modified &&
    a.readonly === b.readonly;

  const isContainer = (entry: Entry) => entry.node.kind !== "file";

  /** Removes a node and everything under it from what is known. */
  const forget = (id: ExplorerNodeId) => {
    const entry = entries.get(id);
    if (!entry) return;
    for (const child of entry.children ?? []) forget(child);
    entries.delete(id);
    projections.delete(id);
  };

  /**
   * A listing, reconciled into what is known of `entry`: children that are still there keep
   * their node (and their own loaded children), changed ones get new metadata under the same
   * identity, new ones are added, missing ones are removed with their subtrees. Nothing
   * outside this folder is touched.
   */
  const reconcile = (entry: Entry, listed: FileNode) => {
    const parentId = entry.node.id;
    const before = new Set(entry.children ?? []);
    const next: ExplorerNodeId[] = [];
    const seen = new Set<ExplorerNodeId>();
    let membership = entry.children === null;
    for (const child of listed.children ?? []) {
      const id = idFor(child.path);
      if (seen.has(id)) continue;
      seen.add(id);
      next.push(id);
      const existing = entries.get(id);
      const fresh = nodeFrom(child, parentId, id);
      if (!existing) {
        entries.set(id, {
          node: fresh,
          children: null,
          error: null,
          requested: 0,
          loading: 0,
          interest: [],
          version: ++counter,
        });
        membership = true;
        emit({ type: "created", node: fresh });
        continue;
      }
      if (existing.node.kind !== fresh.kind) {
        // A file became a folder or the other way round: a different thing now.
        forget(id);
        entries.set(id, {
          node: fresh,
          children: null,
          error: null,
          requested: 0,
          loading: 0,
          interest: [],
          version: ++counter,
        });
        membership = true;
        emit({ type: "created", node: fresh });
        continue;
      }
      if (!sameNode(existing.node, fresh) || existing.node.parentId !== parentId) {
        existing.node = fresh;
        existing.version = ++counter;
        emit({ type: "changed", node: fresh });
      }
      before.delete(id);
    }
    for (const gone of before) {
      const path = entries.get(gone)?.node.path ?? "";
      forget(gone);
      membership = true;
      emit({ type: "deleted", id: gone, path });
    }
    const order =
      membership ||
      entry.children === null ||
      entry.children.length !== next.length ||
      entry.children.some((id, index) => id !== next[index]);
    entry.children = next;
    entry.error = null;
    // A root listed under another spelling of itself takes the spelling the listing uses.
    if (entry.node.kind === "workspace" && unprefixed(listed.path) !== entry.node.path)
      entry.node = nodeFrom(listed, null, entry.node.id);
    touch(parentId);
    if (order) emit({ type: "childrenChanged", parentId });
  };

  /**
   * Lists the folders `ids` together and reconciles each answer that is still the newest for
   * its folder, parents before children. Returns the errors of listings that failed.
   */
  const relist = async (ids: ExplorerNodeId[], signal?: AbortSignal): Promise<string[]> => {
    const requests = ids
      .map((id) => entries.get(id))
      .filter((entry): entry is Entry => !!entry && isContainer(entry))
      .map((entry) => {
        const gen = ++generation;
        entry.requested = gen;
        entry.loading = gen;
        entry.interest = [signal];
        return { id: entry.node.id, path: entry.node.path, gen, entry };
      });
    if (!requests.length) return [];
    for (const request of requests)
      if (entries.get(request.id)!.children === null)
        emit({ type: "childrenChanged", parentId: request.id });
    const answers = await Promise.all(
      requests.map((request) =>
        io.list(request.path).then(
          (listed) => ({ ...request, listed, error: null as string | null }),
          (error: unknown) => ({ ...request, listed: null, error: String(error) }),
        ),
      ),
    );
    const errors: string[] = [];
    // Parents first: a listing that removes a folder goes before the folder's own answer,
    // which is then dropped rather than grafted back on.
    answers.sort((a, b) => a.path.length - b.path.length);
    for (const answer of answers) {
      // The folder asked about, still known under the id it had (it was not forgotten, or
      // moved, or replaced by another workspace's folder of the same name), and no newer
      // listing asked for since: otherwise the answer is not the newest word on it.
      const entry = answer.entry;
      if (entries.get(entry.node.id) !== entry || entry.requested !== answer.gen) {
        if (entry.loading === answer.gen) entry.loading = 0;
        continue;
      }
      entry.loading = 0;
      const abandoned =
        entry.interest.length > 0 && entry.interest.every((waiting) => waiting?.aborted);
      entry.interest = [];
      if (abandoned) {
        // Everyone waiting gave up (the folder was collapsed): what was known stays as it was.
        touch(entry.node.id);
        emit({ type: "childrenChanged", parentId: entry.node.id });
        continue;
      }
      if (answer.listed) {
        reconcile(entry, answer.listed);
        continue;
      }
      entry.error = answer.error;
      errors.push(`${answer.path}: ${answer.error}`);
      touch(entry.node.id);
      emit({ type: "error", id: entry.node.id, message: answer.error! });
      emit({ type: "childrenChanged", parentId: entry.node.id });
    }
    return errors;
  };

  const loadedContainers = () =>
    [...entries.values()].filter((entry) => isContainer(entry) && entry.children !== null);

  const nearestLoaded = (path: string): ExplorerNodeId | null => {
    for (let dir = parentPathOf(path); ;) {
      const entry = entries.get(idFor(dir));
      if (entry && isContainer(entry) && entry.children !== null) return entry.node.id;
      const up = parentPathOf(dir);
      if (up === dir) return null;
      dir = up;
    }
  };

  /**
   * Moves what is known at `fromPath` to `toPath`, re-keying its loaded subtree. Returns
   * whether there was anything known there to move.
   */
  const move = (fromPath: string, toPath: string): boolean => {
    const from = idFor(fromPath);
    const entry = entries.get(from);
    if (!entry || entry.node.parentId === null) return false;
    const to = idFor(toPath);
    // Read before re-keying below rewrites the entry's node.
    const oldPath = entry.node.path;
    if (to === from && oldPath === unprefixed(toPath)) return false;
    const oldParent = entries.get(entry.node.parentId);
    const newParentId = idFor(parentPathOf(toPath));
    const newParent = entries.get(newParentId);
    if (oldParent?.children) {
      oldParent.children = oldParent.children.filter((id) => id !== from);
      touch(oldParent.node.id);
    }
    const target = unprefixed(toPath);
    const rekey = (id: ExplorerNodeId, parentId: ExplorerNodeId): ExplorerNodeId => {
      const moving = entries.get(id)!;
      const rel = relativePath(fromPath, moving.node.path);
      const path = rel === "." || rel === undefined ? target : `${target}/${rel}`;
      const newId = idFor(path);
      entries.delete(id);
      projections.delete(id);
      const resource = fileUri(path);
      moving.node = {
        ...moving.node,
        id: newId,
        path,
        resource,
        parentId,
        name: basename(resource) || path,
      } as ExplorerResourceNode;
      moving.version = ++counter;
      // A listing in flight is of the old path: its answer must not land on the new one.
      moving.requested = ++generation;
      moving.loading = 0;
      moving.interest = [];
      // A folder moving onto a known one replaces it: the listing will say what is there.
      if (entries.has(newId) && newId !== id) forget(newId);
      entries.set(newId, moving);
      moving.children = moving.children?.map((child) => rekey(child, newId)) ?? null;
      return newId;
    };
    if (newParent && isContainer(newParent) && newParent.children) {
      const moved = rekey(from, newParentId);
      if (!newParent.children.includes(moved)) newParent.children = [...newParent.children, moved];
      touch(newParentId);
    } else {
      // Moved somewhere not loaded: nothing to show there until it is listed.
      forget(from);
    }
    emit({ type: "renamed", from, to, fromPath: oldPath, toPath: target });
    if (oldParent) emit({ type: "childrenChanged", parentId: oldParent.node.id });
    if (newParent) emit({ type: "childrenChanged", parentId: newParentId });
    return true;
  };

  const project = (id: ExplorerNodeId): ProjectedNode | null => {
    const entry = entries.get(id);
    if (!entry) return null;
    const cached = projections.get(id);
    if (cached && cached.version === entry.version) return cached.node;
    const { node } = entry;
    let children: ProjectedNode[] | null = null;
    if (isContainer(entry) && entry.children) {
      children = [];
      for (const child of entry.children) {
        const projected = project(child);
        if (projected) children.push(projected);
      }
      // Unchanged children: the previous array, so nothing that renders it sees a change.
      const previous = cached?.node.children;
      if (
        previous &&
        previous.length === children.length &&
        previous.every((child, index) => child === children![index])
      )
        children = previous;
    }
    const loadError = entry.children === null && entry.error ? entry.error : undefined;
    const projected: ProjectedNode = {
      id: node.id,
      name: node.name,
      path: node.path,
      is_dir: node.kind !== "file",
      size: node.size,
      modified: node.modified,
      readonly: node.readonly,
      children: node.kind === "file" ? undefined : children,
      ...(loadError ? { loadError } : {}),
    };
    const same =
      cached &&
      cached.node.children === projected.children &&
      cached.node.name === projected.name &&
      cached.node.path === projected.path &&
      cached.node.size === projected.size &&
      cached.node.modified === projected.modified &&
      cached.node.readonly === projected.readonly &&
      cached.node.loadError === projected.loadError;
    const result = same ? cached.node : projected;
    projections.set(id, { version: entry.version, node: result });
    return result;
  };

  const provider = {
    // --- Snapshots (synchronous) ----------------------------------------------------------
    getRootNodes(): ExplorerResourceNode[] {
      return roots.map((id) => entries.get(id)?.node).filter((node) => !!node);
    },
    getNode(id: ExplorerNodeId): ExplorerResourceNode | undefined {
      return entries.get(id)?.node;
    },
    getChildren(id: ExplorerNodeId): ExplorerNode[] {
      const entry = entries.get(id);
      if (!entry) return [];
      if (entry.children === null) {
        return entry.error
          ? [
              {
                kind: "error",
                id: `${id}#error` as ExplorerNodeId,
                parentId: id,
                message: entry.error,
              },
            ]
          : [];
      }
      return entry.children.map((child) => entries.get(child)!.node);
    },
    childrenState(id: ExplorerNodeId): ExplorerChildrenState {
      const entry = entries.get(id);
      if (!entry || entry.children === null) {
        if (entry?.loading) return { status: "loading" };
        if (entry?.error) return { status: "failed", message: entry.error };
        return { status: "unloaded" };
      }
      return entry.loading ? { status: "loading" } : { status: "loaded" };
    },
    capabilities(id: ExplorerNodeId): ExplorerCapabilities {
      const node = entries.get(id)?.node;
      if (!node) return NOTHING;
      if (node.kind === "workspace")
        return { ...NOTHING, canCreateFile: true, canCreateDirectory: true, canRefresh: true };
      if (node.kind === "directory")
        return {
          canOpen: false,
          canCreateFile: true,
          canCreateDirectory: true,
          canRename: true,
          canDelete: true,
          canMove: true,
          canCopy: true,
          canRefresh: true,
        };
      return {
        ...NOTHING,
        canOpen: true,
        canRename: true,
        canDelete: true,
        canMove: true,
        canCopy: true,
      };
    },
    /** The id of the resource at `path` (a known node or not): its ResourceId. */
    idFor,
    subscribe(listener: ExplorerProviderListener): Disposable {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /** Changes whenever anything the provider knows does. */
    revision: (): number => revision,
    /** How many nodes are known -- for tests and measurements. */
    size: (): number => entries.size,

    // --- Roots ----------------------------------------------------------------------------
    /**
     * The workspace roots, in order. A root that stays keeps everything known under it; one
     * that goes is forgotten; a new one starts unloaded. Listings in flight for a workspace
     * that is no longer open are dropped.
     */
    setRoots(paths: readonly string[]): void {
      const next: ExplorerNodeId[] = [];
      for (const path of paths) {
        const id = idFor(path);
        if (next.includes(id)) continue;
        next.push(id);
        if (!entries.has(id)) {
          const clean = unprefixed(path);
          entries.set(id, {
            node: nodeFrom({ name: "", path: clean, is_dir: true }, null, id),
            children: null,
            error: null,
            requested: 0,
            loading: 0,
            interest: [],
            version: ++counter,
          });
        }
      }
      const kept = new Set(next);
      const removed = roots.filter((id) => !kept.has(id));
      for (const id of removed) forget(id);
      const changed = removed.length > 0 || next.some((id, index) => roots[index] !== id);
      roots = next;
      if (changed) emit({ type: "reset" });
    },
    rootIds: (): ExplorerNodeId[] => [...roots],

    // --- Loading and refreshing (asynchronous) ---------------------------------------------
    /**
     * Lists a folder that is not loaded yet. Concurrent calls share one listing. Resolves once
     * it is reconciled; rejects with the listing's error, which is also kept as the folder's
     * state (`failed`) -- never turned into an empty folder. With `signal` aborted before the
     * answer, this caller stops caring; the answer is dropped only if every caller waiting on
     * the listing did, and the folder is then as it was.
     */
    async loadChildren(id: ExplorerNodeId, signal?: AbortSignal): Promise<void> {
      const entry = entries.get(id);
      if (!entry || !isContainer(entry)) return;
      if (entry.children !== null && !entry.loading) return;
      if (entry.loading) {
        entry.interest.push(signal);
        await waitFor(id, entry.loading);
      } else {
        await relist([id], signal);
      }
      const after = entries.get(id);
      if (after?.children === null && after.error && !signal?.aborted) throw new Error(after.error);
    },
    /**
     * Re-lists loaded folders and reconciles them: everything loaded (no argument), or the
     * given folders and every loaded folder inside them. Resolves to the listing errors.
     */
    refresh(ids?: readonly ExplorerNodeId[]): Promise<string[]> {
      if (!ids) return relist(loadedContainers().map((entry) => entry.node.id));
      const scopes = ids.map((id) => entries.get(id)?.node.path).filter((path) => !!path);
      return relist(
        loadedContainers()
          .filter((entry) =>
            scopes.some((scope) => relativePath(scope!, entry.node.path) !== undefined),
          )
          .map((entry) => entry.node.id),
      );
    },
    /** Re-lists the loaded folders closest to `paths` -- after one of Yavin's own operations. */
    refreshAround(paths: readonly string[]): Promise<string[]> {
      const ids = new Set<ExplorerNodeId>();
      for (const path of paths) {
        const id = nearestLoaded(path);
        if (id) ids.add(id);
      }
      return relist([...ids]);
    },
    /** Yavin renamed or moved `from` to `to`: known state moves with it (`renamed`). */
    moved(from: string, to: string): void {
      move(from, to);
    },
    /** Yavin deleted `path`: it and what is known below it are gone (`deleted`). */
    removed(path: string): void {
      const id = idFor(path);
      const entry = entries.get(id);
      if (!entry || entry.node.parentId === null) return;
      const parent = entries.get(entry.node.parentId);
      if (parent?.children) parent.children = parent.children.filter((child) => child !== id);
      forget(id);
      touch(parent?.node.id ?? null);
      emit({ type: "deleted", id, path: entry.node.path });
      if (parent) emit({ type: "childrenChanged", parentId: parent.node.id });
    },

    /**
     * What the watcher reported (Module 02), applied where it shows. A change is visible only
     * as an entry of its folder, so only a loaded parent is re-listed -- found by id, without
     * walking the tree; a change inside a folder that is not loaded costs nothing. A rename
     * moves the known node at once (its UI state follows it), then both folders are re-listed
     * to confirm. A folder in `rescan` had changes nobody itemised: every loaded folder inside
     * it is re-listed, and its parent. Resolves to how many folders were re-listed, and the
     * listing errors.
     */
    async applyResourceChanges(
      changes: readonly ResourceChange[],
      rescan: readonly string[] = [],
    ): Promise<{ relisted: number; errors: string[] }> {
      const folders = new Set<ExplorerNodeId>();
      const parentOf = (path: string) => {
        const parent = parentPathOf(path);
        if (parent === path) return;
        const id = idFor(parent);
        const entry = entries.get(id);
        if (entry && isContainer(entry) && entry.children !== null) folders.add(id);
      };
      for (const change of changes) {
        if (change.kind === "renamed") {
          move(change.from, change.path);
          parentOf(change.from);
        }
        parentOf(change.path);
      }
      if (rescan.length) {
        for (const entry of loadedContainers())
          if (rescan.some((scope) => relativePath(scope, entry.node.path) !== undefined))
            folders.add(entry.node.id);
        for (const scope of rescan) parentOf(scope);
      }
      if (!folders.size) return { relisted: 0, errors: [] };
      const errors = await relist([...folders]);
      return { relisted: folders.size, errors };
    },

    // --- The tree view's projection ----------------------------------------------------------
    /**
     * The first root as the `FileNode` tree the existing Explorer view renders, or null until
     * it has been listed. Built from a cache: a node unchanged since the last call is the same
     * object, so a change in one folder rebuilds only it and its ancestors, and every row the
     * view memoizes on an unchanged node stays as it was.
     */
    projection(rootIndex = 0): ProjectedNode | null {
      const id = roots[rootIndex];
      const entry = id ? entries.get(id) : undefined;
      if (!entry || entry.children === null) return null;
      return project(id);
    },
  };

  /** Waits for the listing of `id` with generation `gen` to settle. */
  const waitFor = (id: ExplorerNodeId, gen: number) =>
    new Promise<void>((resolve) => {
      const check = () => {
        const entry = entries.get(id);
        if (!entry || entry.loading !== gen) {
          stop();
          resolve();
        }
      };
      const stop = provider.subscribe(check);
    });

  return provider;
}
