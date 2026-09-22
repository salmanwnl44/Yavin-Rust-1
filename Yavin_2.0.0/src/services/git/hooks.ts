import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { gitRegistry } from "./registry.ts";
import type { RepoEntry } from "./registry.ts";
import type { RepoSnapshot, RepoStore } from "./store.ts";
import { GraphLoader } from "./graph/incremental.ts";
import type { GraphScope, GraphSnapshot } from "./graph/incremental.ts";
import { acquireLoader, releaseLoader, resetLoader } from "./graph/shared.ts";
import type { Repository } from "./repository.ts";

const EMPTY_SUBSCRIBE = () => () => {};
const NO_SNAPSHOT = () => null;

export function useGitRegistry() {
  return useSyncExternalStore(gitRegistry.subscribe, gitRegistry.getSnapshot);
}

export function useActiveRepo(): RepoEntry | null {
  const snapshot = useGitRegistry();
  return snapshot.repos.find((r) => r.repoId === snapshot.activeRepoId) ?? null;
}

/** Subscribes to one repo store's live status/branch data; `null` while there is none. */
export function useRepoSnapshot(store: RepoStore | null | undefined): RepoSnapshot | null {
  const subscribe = useMemo(() => store?.subscribe ?? EMPTY_SUBSCRIBE, [store]);
  const getSnapshot = useMemo(() => store?.getSnapshot ?? NO_SNAPSHOT, [store]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

/**
 * The total changed-file count across every open repository, for the activity bar's
 * badge. Reads each store's snapshot directly (not via a hook per repo, which would
 * call a variable number of hooks) -- the registry re-renders this whenever any
 * tracked repo's status changes, via the store-to-registry change bridge.
 */
export function useTotalChanges(): number {
  const snapshot = useGitRegistry();
  return snapshot.repos.reduce((sum, entry) => sum + entry.store.getSnapshot().entries.length, 0);
}

const EMPTY_GRAPH_SNAPSHOT: GraphSnapshot = {
  commits: [],
  layout: { nodes: [], edges: [], laneCount: 0 },
  loading: false,
  hasMore: false,
  notice: "",
  shallow: false,
  scope: "auto",
};
const NO_GRAPH_SNAPSHOT = () => EMPTY_GRAPH_SNAPSHOT;

/**
 * One `GraphLoader` per repository, shared (ref-counted) across every mounted view of
 * that repository's history -- e.g. the sidebar's inline graph and the full commit
 * graph panel open at once, and (per the Git State & Synchronization plan) every
 * linked worktree of the same repository too -- so a reset() triggered from any of
 * them (after Fetch/Pull/Push/commit, or an external ref change) is seen by all of
 * them, instead of each view or worktree holding its own stale, independently-paged
 * copy of the same repository-shared commit history.
 *
 * Keyed by the owning repository's identity (`RegistryEntry.repositoryId`, the
 * canonicalized common-git-dir), not `repository.repoId` (the worktree's own root) --
 * two worktrees of one repository resolve to the same key here even though their
 * `Repository` instances are different objects. Falls back to `repository.repoId`
 * itself if the registry doesn't (yet) know this worktree, so a graph view never
 * throws or goes unshared; it just doesn't share with anything until the registry
 * catches up (this only matters for the brief window before `GitRegistry.openNew()`
 * finishes attaching a newly-opened worktree to its `RepositoryEntry`).
 */
function graphLoaderKey(repository: Repository): string {
  return gitRegistry.repositoryFor(repository.repoId)?.repositoryId ?? repository.repoId;
}

/**
 * Returns the key alongside the loader so the caller can release under the SAME key it
 * acquired with. Recomputing the key at release time was a leak: `graphLoaderKey` consults
 * the registry, and closing the repository removes the entry it reads, so the release
 * computed the `repository.repoId` fallback instead, missed the table, and returned without
 * decrementing. The loader then stayed forever -- and, worse, was handed back out when the
 * same repository was reopened, by which point `GitRegistry.close()` had already called
 * `close()` on the `Repository` inside it, so every later `graphLog` failed against a dead
 * native handle while the view showed the pre-close commit list.
 */
function acquireGraphLoader(repository: Repository): { loader: GraphLoader; key: string } {
  const key = graphLoaderKey(repository);
  let created: GraphLoader | null = null;
  const loader = acquireLoader(key, () => {
    created = new GraphLoader(repository);
    return created;
  });
  // Only the view that actually created the loader kicks off the first page; a second
  // view acquiring the same one must not re-fetch what is already loading.
  if (created) void loader.loadMore();
  return { loader, key };
}

/**
 * Resets the shared `GraphLoader` for `repositoryId`, if one currently exists (i.e.
 * some mounted view is actually showing this repository's graph right now). A no-op
 * otherwise -- there is nothing to reset for a repository with no graph view open,
 * and creating one just to reset it would defeat the whole point of lazy loading.
 * Called from `sync.ts`'s `guardedAffecting`, outside of React, which is why this is
 * a plain function rather than something threaded through `useCommitGraph`.
 */
export function resetSharedGraphLoader(repositoryId: string): void {
  resetLoader(repositoryId);
}

/**
 * Subscribes to the shared `GraphLoader` for `repository`, acquiring it (and loading
 * its first page) on mount and releasing it on unmount. A different loader is used
 * whenever `repository` changes (a different repo, or none).
 */
export function useCommitGraph(repository: Repository | null | undefined): {
  snapshot: GraphSnapshot;
  loadMore: () => void;
  reset: () => void;
  setScope: (scope: GraphScope) => void;
} {
  const [loader, setLoader] = useState<GraphLoader | null>(null);

  useEffect(() => {
    if (!repository) {
      setLoader(null);
      return;
    }
    const { loader: shared, key } = acquireGraphLoader(repository);
    setLoader(shared);
    return () => releaseLoader(key);
  }, [repository]);

  const subscribe = useMemo(() => loader?.subscribe ?? EMPTY_SUBSCRIBE, [loader]);
  const getSnapshot = useMemo(() => loader?.getSnapshot ?? NO_GRAPH_SNAPSHOT, [loader]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);

  return {
    snapshot,
    loadMore: () => void loader?.loadMore(),
    reset: () => void loader?.reset(),
    setScope: (scope) => void loader?.setScope(scope),
  };
}
