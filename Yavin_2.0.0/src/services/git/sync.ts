import { gitRegistry } from "./registry.ts";
import type { RepoEntry, RepositoryEntry } from "./registry.ts";
import type { RefreshField } from "./store.ts";
import { resetSharedGraphLoader } from "./hooks.ts";
import { onGitChanged } from "../native.ts";
import type { GitChangeEvent } from "../native.ts";

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
 *
 * `deleteBranch` maps to `"branches"` only, the mirror image of `branch` (create):
 * it removes a name under `refs/heads/`, repository-shared and visible from every
 * worktree, but (like creation) never touches a sibling's own `entries`/`branch`/
 * `operationInProgress` -- Git's own worktree-exclusivity guarantee means the
 * deleted branch could never have been checked out in a sibling to begin with.
 */
export const SIBLING_INVALIDATES: Readonly<Record<string, readonly RefreshField[]>> = {
  branch: ["branches"],
  deleteBranch: ["branches"],
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
 * `switch` (-c or not), `abort`, `deleteBranch`, and the stash family never appear
 * here: `switch` moves HEAD to an *existing* commit already in the graph; `branch`
 * (`switch -c`) creates a ref at an existing commit; `abort` restores pre-operation
 * state; `deleteBranch` removes a ref, never a commit object (its commits may
 * become unreachable from any remaining ref, but the graph view only ever walks
 * from currently-existing refs, so nothing needs evicting) -- none of these make a
 * new commit reachable. `commit` does (this worktree's own
 * branch grows by one). `continue`'s case is genuinely conditional -- a
 * `merge`/`rebase`/`cherry-pick --continue` (or `revert --continue`) only creates
 * a commit when it actually *completes* the operation, not on a call that still
 * leaves conflicts remaining -- so it isn't a static table entry; see
 * `guardedAffecting`'s own before/after `operationInProgress` check below.
 */
export const GRAPH_RESETS: ReadonlySet<string> = new Set([
  "fetch",
  "pull",
  "pullRebase",
  "pullMerge",
  "commit",
]);

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
 *
 * `continue`'s graph reset is conditional, not a static `GRAPH_RESETS` entry:
 * captures `operationInProgress` before running, and resets the graph only if it
 * was non-empty before and empty afterward (`guarded()`'s own refresh already
 * includes `operationInProgress` for `continue`, per Module 2's `INVALIDATES`, so
 * the post-call snapshot is already current by the time this checks it) -- a
 * `continue` that still leaves conflicts remaining never creates a commit, and
 * must not reset the graph.
 */
export async function guardedAffecting(
  entry: RepoEntry,
  kind: string,
  dirty: boolean,
  operation: () => Promise<string>,
): Promise<boolean> {
  const operationBefore =
    kind === "continue" ? entry.store.getSnapshot().operationInProgress : "";
  const ok = await entry.store.guarded(kind, dirty, operation);
  if (!ok) return ok;

  const repository = gitRegistry.repositoryFor(entry.repoId);
  const siblingFields = SIBLING_INVALIDATES[kind];
  if (repository && siblingFields) {
    for (const sibling of repository.worktrees) {
      if (sibling !== entry) void sibling.store.refresh(siblingFields);
    }
  }
  const operationJustCompleted =
    kind === "continue" &&
    operationBefore !== "" &&
    entry.store.getSnapshot().operationInProgress === "";
  if (repository && (GRAPH_RESETS.has(kind) || operationJustCompleted)) {
    resetSharedGraphLoader(repository.repositoryId);
  }
  return ok;
}

/**
 * Which `RepoSnapshot` fields go stale for each `.git`-watcher event kind, and
 * whether it's per-worktree (only the worktree named by `worktreeRoot`) or
 * repository-shared (every worktree of the repository) -- see the Git State &
 * Synchronization plan's Section H. An *external* ref change invalidates exactly
 * the same Yavin-side state a Yavin-caused one touching that same ref category
 * would (Git doesn't know or care who moved the ref), so this table's shape
 * mirrors `SIBLING_INVALIDATES`/Module 2's `INVALIDATES`, not a new taxonomy.
 *
 * `operation-state` deliberately has no graph-reset entry here: distinguishing a
 * merge/rebase/cherry-pick/revert *completing* (which can add a commit) from one
 * merely *starting* (which never does) needs the before/after `repo_state()`
 * comparison the plan's Section S scopes to Phase 6, not this phase.
 */
export const WATCHER_INVALIDATES: Readonly<
  Record<GitChangeEvent["kind"], { fields: readonly RefreshField[]; graphReset: boolean }>
> = {
  head: { fields: ["entries", "branch"], graphReset: false },
  "operation-state": {
    fields: ["entries", "branch", "operationInProgress"],
    graphReset: false,
  },
  refs: { fields: ["branches"], graphReset: true },
  remotes: { fields: ["branch"], graphReset: true },
  stash: { fields: ["entries", "stashes"], graphReset: false },
};

const PER_WORKTREE_KINDS: ReadonlySet<GitChangeEvent["kind"]> = new Set([
  "head",
  "operation-state",
]);

/**
 * Applies one `git-changed` event to an already-resolved `RepositoryEntry`:
 * refreshes exactly the worktree(s) and fields `WATCHER_INVALIDATES` says can
 * have gone stale, and resets the repository's shared graph if warranted. Split
 * out from `handleGitChangeEvent` (which resolves `event.repositoryId` against
 * the real `gitRegistry` singleton) purely so this routing logic -- given a
 * `RepositoryEntry`, do the right thing -- can be exercised directly in a test
 * with duck-typed fake worktrees, the same convention `store.test.ts` already
 * uses for a fake `Repository`, without needing the real registry populated.
 */
export function applyGitChangeEvent(repository: RepositoryEntry, event: GitChangeEvent): void {
  const spec = WATCHER_INVALIDATES[event.kind];

  if (PER_WORKTREE_KINDS.has(event.kind)) {
    const worktree = repository.worktrees.find((w) => w.root === event.worktreeRoot);
    void worktree?.store.refresh(spec.fields);
  } else {
    for (const worktree of repository.worktrees) void worktree.store.refresh(spec.fields);
  }
  if (spec.graphReset) resetSharedGraphLoader(repository.repositoryId);
}

/**
 * Routes one `git-changed` event (an external Git ref change the new `.git`
 * watcher detected -- see `backend.ts`'s `watchRepo`) to the repository it
 * belongs to. A repository the registry no longer tracks (closed between the
 * event firing and this handler running) is a silent no-op -- the watcher itself
 * is torn down on close, so this is only a narrow, harmless race window, never a
 * routing bug. A `worktreeRoot` that no longer resolves to a tracked worktree is
 * likewise a silent no-op, handled inside `applyGitChangeEvent`.
 */
export function handleGitChangeEvent(event: GitChangeEvent): void {
  const repository = gitRegistry.repositoryById(event.repositoryId);
  if (repository) applyGitChangeEvent(repository, event);
}

// Subscribed once, at module load: `sync.ts` is the single home for every piece
// of watcher-driven synchronization policy (mirrors how `guardedAffecting` above
// is where Yavin's own mutations' cross-worktree/graph effects live), so nothing
// else needs to remember to wire this up. A no-op outside Tauri (`onGitChanged`'s
// own guard) and while no repository is being watched (`handleGitChangeEvent`'s
// own no-op above).
onGitChanged(handleGitChangeEvent);
