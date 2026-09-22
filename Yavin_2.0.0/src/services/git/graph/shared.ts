import type { GraphLoader } from "./incremental.ts";

/**
 * The ref-counted table of `GraphLoader`s shared per repository.
 *
 * It lives here, rather than beside `useCommitGraph` in `hooks.ts`, because three unrelated
 * layers need it: the hook (acquire/release), `sync.ts` (reset after a mutation) and
 * `registry.ts` (drop when a repository closes). `hooks.ts` already imports `registry.ts` to
 * resolve a worktree to its owning repository, so putting the table there and having the
 * registry reach back for it would make those two modules import each other. Keeping the
 * table in a leaf module that imports nothing but the loader type avoids the cycle -- callers
 * pass the key in, and only `hooks.ts` knows how a key is derived.
 */
const loaders = new Map<string, { loader: GraphLoader; refCount: number }>();

/**
 * Returns the existing loader for `key`, or builds one with `create`. The key must be the
 * same one used to release later: it is the caller's job to hold on to it rather than
 * recompute it, because the information a key is derived from (the registry's worktree
 * table) can change while the loader is held.
 */
export function acquireLoader(key: string, create: () => GraphLoader): GraphLoader {
  const existing = loaders.get(key);
  if (existing) {
    existing.refCount++;
    return existing.loader;
  }
  const loader = create();
  loaders.set(key, { loader, refCount: 1 });
  return loader;
}

export function releaseLoader(key: string): void {
  const existing = loaders.get(key);
  if (!existing) return;
  existing.refCount--;
  if (existing.refCount <= 0) {
    loaders.delete(key);
    existing.loader.dispose();
  }
}

/** A no-op when no view of this repository's history is currently mounted. */
export function resetLoader(key: string): void {
  loaders.get(key)?.loader.reset();
}

/**
 * Drops the loader outright, whatever its ref count -- for when the repository itself is
 * closed and the `Repository` the loader captured is closed with it. Guarantees a later
 * acquire builds a fresh loader rather than receiving one wrapping a dead native handle.
 */
export function dropLoader(key: string): void {
  const existing = loaders.get(key);
  if (!existing) return;
  loaders.delete(key);
  existing.loader.dispose();
}
