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
 * graph panel open at once -- so a reset() triggered from one (after Fetch/Pull/Push)
 * is seen by all of them, instead of each view holding its own stale copy.
 */
const sharedGraphLoaders = new Map<string, { loader: GraphLoader; refCount: number }>();

function acquireGraphLoader(repository: Repository): GraphLoader {
  const existing = sharedGraphLoaders.get(repository.repoId);
  if (existing) {
    existing.refCount++;
    return existing.loader;
  }
  const loader = new GraphLoader(repository);
  sharedGraphLoaders.set(repository.repoId, { loader, refCount: 1 });
  void loader.loadMore();
  return loader;
}

function releaseGraphLoader(repository: Repository): void {
  const existing = sharedGraphLoaders.get(repository.repoId);
  if (!existing) return;
  existing.refCount--;
  if (existing.refCount <= 0) {
    sharedGraphLoaders.delete(repository.repoId);
    existing.loader.dispose();
  }
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
