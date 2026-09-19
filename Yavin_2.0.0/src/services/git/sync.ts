import { gitRegistry } from "./registry.ts";
import type { RepoEntry } from "./registry.ts";
import type { RefreshField } from "./store.ts";
import { resetSharedGraphLoader } from "./hooks.ts";

/**
 * Which of a *sibling* worktree's (same repository, different `RepoEntry`)
 * `RepoSnapshot` fields go stale when `kind` mutates repository-shared state --
 * see the Git State & Synchronization plan's Section E/L. Own-worktree
 * invalidation is unchanged and stays entirely inside `RepoStore.guarded()`
 * (Module 2's `INVALIDATES` table); this table only ever applies to worktrees
 * OTHER than the one that actually ran the mutation. A `kind` with no entry here
 * has no cross-worktree effect on any `RepoSnapshot` field (it may still affect
 * the commit graph -- see `GRAPH_RESETS` below, a separate table, since the graph
 * isn't part of `RepoSnapshot`).
 *
 * `switch`, `commit`, `abort`, `continue`, `push`, and `publish` are deliberately
 * absent: Git's own worktree-exclusivity guarantee means a `switch`/`commit`/
 * `abort`/`continue` can never affect a sibling's branch-name list (it moves an
 * existing ref, or moves HEAD to one, never creates/deletes one), and `push`/
 * `publish` only update this worktree's own remote-tracking refs to match what
 * was already pushed -- no sibling's `RepoSnapshot` field depends on that.
 *
 * `fetch`/`pull*` map to `"branch"`, not `"branches"`: fetch only ever writes
 * `refs/remotes/**`, never `refs/heads/**` (confirmed against `repository.ts` --
 * `branches()` is `for-each-ref refs/heads/`, which a fetch never touches; the
 * thing that actually changes is ahead/behind, computed from the remote-tracking
 * ref against HEAD's upstream, which lives in the `branch` field via
 * `branchInfo()`'s `status --porcelain=v2 --branch`). Only `branch` (create,
 * i.e. `switch -c`) genuinely adds a new name under `refs/heads/`, so it alone
 * invalidates siblings' `"branches"`.
 *
 * The stash family maps to `"stashes"` only, never `"entries"`: `refs/stash` is
 * repository-shared, but `stash push/apply/pop`'s *working-tree* effect (which is
 * what `entries` reflects) only ever touches the worktree the command actually ran
 * in -- a sibling's own index/working tree is untouched, so only the shared stash
 * list itself needs re-fetching on a sibling, exactly like `stashDrop`.
 */
export const SIBLING_INVALIDATES: Readonly<Record<string, readonly RefreshField[]>> = {
  branch: ["branches"],
  stash: ["stashes"],
  stashApply: ["stashes"],
  stashPop: ["stashes"],
  stashDrop: ["stashes"],
  fetch: ["branch"],
  pull: ["branch"],
  pullRebase: ["branch"],
  pullMerge: ["branch"],
};

/**
 * Which mutations can grow the repository's commit history (make a new commit
 * reachable from some branch or remote-tracking ref), and therefore require the
 * repository's shared `GraphLoader` (see `hooks.ts`) to reset and re-page from the
 * top. See the plan's Section S for the full per-mutation reasoning. Notably
 * narrower than the pre-Module-3 behavior, which reset on every one of Fetch/
 * Pull/Push regardless of which was actually clicked: `push`/`publish` never add
 * a commit (they only move a remote ref to match what's already local), so they
 * are correctly excluded here even though the pre-existing UI code reset on them.
 * `commit`, `switch` (-c or not), `abort`, and the stash family never appear here
 * for the same reason `SIBLING_INVALIDATES` excludes most of them -- extending
 * this table to cover them (and `continue`'s conditional case, which only resets
 * when it actually completes a merge/rebase/cherry-pick/revert) is Phase 6 of the
 * plan, not this phase.
 */
export const GRAPH_RESETS: ReadonlySet<string> = new Set(["fetch", "pull", "pullRebase", "pullMerge"]);

/**
 * Runs `entry.store.guarded(kind, dirty, operation)` exactly as before (own-worktree
 * behavior, including its refresh, is entirely Module 2's `RepoStore.guarded()`,
 * unchanged), then -- only on success, and only for a `kind` this module actually
 * knows affects something wider than one worktree -- propagates the two remaining
 * effects Module 2 correctly left out of scope:
 *
 * 1. Sibling worktrees of the same repository re-fetch whichever of their own
 *    fields `SIBLING_INVALIDATES[kind]` says can have gone stale (never a blanket
 *    full refresh of every sibling field).
 * 2. The repository's shared commit graph resets if `GRAPH_RESETS.has(kind)`.
 *
 * Deliberately a wrapper around `guarded()` from outside `RepoStore`, not a change
 * to `guarded()` itself: `RepoStore` has no knowledge of `GitRegistry`/sibling
 * worktrees (and must not gain any, to avoid a `store.ts` <-> `registry.ts` <->
 * `sync.ts` import cycle -- `registry.ts` already imports `RepoStore`). Sitting
 * above both, `sync.ts` can import from each without either importing it back.
 */
export async function guardedAffecting(
  entry: RepoEntry,
  kind: string,
  dirty: boolean,
  operation: () => Promise<string>,
): Promise<boolean> {
  const ok = await entry.store.guarded(kind, dirty, operation);
  if (!ok) return ok;

  const repository = gitRegistry.repositoryFor(entry.repoId);
  const siblingFields = SIBLING_INVALIDATES[kind];
  if (repository && siblingFields) {
    for (const sibling of repository.worktrees) {
      if (sibling !== entry) void sibling.store.refresh(siblingFields);
    }
  }
  if (repository && GRAPH_RESETS.has(kind)) {
    resetSharedGraphLoader(repository.repositoryId);
  }
  return ok;
}
