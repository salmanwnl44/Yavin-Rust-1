import { useSyncExternalStore } from "react";

/**
 * "Something happened that Git should be asked about again."
 *
 * Saving a file, refreshing the tree, a watcher event, the window regaining focus: each means
 * the repository may have moved under us, and each is raised from a different corner of the
 * application. This is a subscription rather than state on the root component because that is
 * what it was before -- and a counter held at the root re-rendered the entire window every
 * time anything bumped it, including the file saves that happen while typing.
 *
 * Only what actually asks Git anything subscribes. Everything else is unaffected by a bump.
 */
let revision = 0;
const listeners = new Set<() => void>();

export function bumpGitRevision(): void {
  revision += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const snapshot = () => revision;

export function useGitRevision(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Test seam: forgets the count and its subscribers. */
export function resetGitRevision(): void {
  revision = 0;
  listeners.clear();
}
