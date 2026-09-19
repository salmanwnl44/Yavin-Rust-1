import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { gitRegistry } from "./registry.ts";
import type { RepoEntry } from "./registry.ts";
import type { RepoSnapshot, RepoStore } from "./store.ts";
import { GraphLoader } from "./graph/incremental.ts";
import type { GraphSnapshot } from "./graph/incremental.ts";
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
const sharedGraphLoaders = new Map<string, { loader: GraphLoader; refCount: number }>();

function graphLoaderKey(repository: Repository): string {
  return gitRegistry.repositoryFor(repository.repoId)?.repositoryId ?? repository.repoId;
}

function acquireGraphLoader(repository: Repository): GraphLoader {
  const key = graphLoaderKey(repository);
  const existing = sharedGraphLoaders.get(key);
  if (existing) {
    existing.refCount++;
    return existing.loader;
  }
  const loader = new GraphLoader(repository);
  sharedGraphLoaders.set(key, { loader, refCount: 1 });
  void loader.loadMore();
  return loader;
}

function releaseGraphLoader(repository: Repository): void {
  const key = graphLoaderKey(repository);
  const existing = sharedGraphLoaders.get(key);
  if (!existing) return;
  existing.refCount--;
  if (existing.refCount <= 0) {
    sharedGraphLoaders.delete(key);
    existing.loader.dispose();
  }
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
  sharedGraphLoaders.get(repositoryId)?.loader.reset();
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
} {
  const [loader, setLoader] = useState<GraphLoader | null>(null);

  useEffect(() => {
    if (!repository) {
      setLoader(null);
      return;
    }
    const shared = acquireGraphLoader(repository);
    setLoader(shared);
    return () => releaseGraphLoader(repository);
  }, [repository]);

  const subscribe = useMemo(() => loader?.subscribe ?? EMPTY_SUBSCRIBE, [loader]);
  const getSnapshot = useMemo(() => loader?.getSnapshot ?? NO_GRAPH_SNAPSHOT, [loader]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);

  return {
    snapshot,
    loadMore: () => void loader?.loadMore(),
    reset: () => void loader?.reset(),
  };
}
