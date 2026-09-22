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
 * `switch`, `commit`, `undoLastCommit`, `mergeBranch`, `rebaseOnto`, `abort`,
 * `continue`, `push`, `pushTo`, and `publish` are deliberately absent: Git's own
 * worktree-exclusivity guarantee means none of these can ever affect a sibling's
 * branch-name list (each moves an existing ref, or moves HEAD to one, never
 * creates/deletes one), and the push variants only update this worktree's own
 * remote-tracking refs to match what was already pushed -- no sibling's
 * `RepoSnapshot` field depends on that. `pushTags`/`deleteRemoteRef`/`createTag`/
 * `deleteTag` are likewise absent: none of them is part of `RepoSnapshot` at all.
 *
 * `addRemote`/`removeRemote` map to `"remotes"`: a remote lives in the shared
 * `.git/config`, not per-worktree, so every sibling's remote list goes stale too.
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
  renameBranch: ["branches"],
  stash: ["stashes"],
  stashApply: ["stashes"],
  stashPop: ["stashes"],
  stashDrop: ["stashes"],
  stashClear: ["stashes"],
  fetch: ["branch"],
  pull: ["branch"],
  pullFrom: ["branch"],
  pullRebase: ["branch"],
  pullMerge: ["branch"],
  // A remote is shared repository config (`.git/config`), not per-worktree.
  addRemote: ["remotes"],
  removeRemote: ["remotes"],
};

/**
 * Which mutations change what the repository's shared `GraphLoader` (see `hooks.ts`)
 * would show, and therefore require it to reset and re-page from the top. The graph is
 * `git log` with no revision (whatever HEAD reaches) plus each commit's `%D` ref
 * labels, so two things can make it stale: the history itself (a new commit becomes
 * reachable, or HEAD moves to a different history), and the *labels* on commits that
 * are already there (a branch or remote-tracking ref appearing, moving or vanishing).
 *
 * - History: `fetch`, `pull*`, `commit`, `undoLastCommit`, `mergeBranch`, `rebaseOnto`,
 *   `switch`, `abort`. `switch`/`abort`/`undoLastCommit` move HEAD; without a reset the
 *   graph kept showing the previous branch and "Load older" (`--skip N` against the new
 *   HEAD) spliced two histories together. `mergeBranch`/`rebaseOnto` add or rewrite commits
 *   the same way `pullMerge`/`pullRebase` already do.
 * - Labels: `push`/`pushTo`/`publish` move `origin/<branch>`, `branch`/`renameBranch`
 *   (create/rename) adds or moves a label at HEAD, `deleteBranch` removes one, and
 *   `createTag`/`deleteTag` add or remove a tag badge the same way. No commit is added,
 *   but the row's pills change. In the desktop app the `.git` watcher would report these
 *   too (`WATCHER_INVALIDATES`), but only after its debounce and only while the watcher is
 *   running, so Yavin's own mutations do not rely on it.
 * - `pushTags`/`deleteRemoteRef`/`addRemote`/`removeRemote` are absent: none of them moves
 *   a local ref or adds a local commit -- a remote-only deletion or a pushed tag doesn't
 *   change what this worktree's own `git log` shows until a later fetch/prune reflects it.
 *
 * `stage`/`unstage`/`discard`/hunk actions and the stash family are absent: none of them
 * touches a commit or a ref the graph shows (`refs/stash` is not in `%D` without
 * `--all`). `continue`/`skip` are conditional, not static entries: a `--continue` only
 * creates a commit when it actually completes the operation, so `guardedAffecting`
 * compares `operationInProgress` before and after (and see `PARTIAL_ON_FAILURE`).
 */
export const GRAPH_RESETS: ReadonlySet<string> = new Set([
  "fetch",
  "pull",
  "pullFrom",
  "pullRebase",
  "pullMerge",
  "commit",
  "undoLastCommit",
  "mergeBranch",
  "rebaseOnto",
  "switch",
  "abort",
  "push",
  "pushTo",
  "publish",
  "branch",
  "deleteBranch",
  "renameBranch",
  "createTag",
  "deleteTag",
  // `push <remote> --delete <branch>` also removes the local `refs/remotes/<remote>/<branch>`,
  // so the graph's `origin/foo` pill has to go with it -- without this the pill stayed on its
  // commit row until some unrelated operation happened to reset the graph.
  "deleteRemoteRef",
]);

/**
 * Operations that can change repository state even when they report failure, so a
 * failed run still has to propagate its sibling/graph effects. Git reports these
 * as an error exit after having done part of the work:
 *
 * - `fetch`: updates each ref independently; one rejected ref fails the command after
 *   the others were written.
 * - `pull`/`pullFrom`/`pullMerge`/`pullRebase`: fetch first, then merge or rebase. A
 *   conflict exits non-zero with the fetch done and HEAD/index possibly already moved.
 * - `publish`: `push` then `--set-upstream`; the ref can move before a later step fails.
 * - `mergeBranch`/`rebaseOnto`: the same conflict-after-partial-progress shape as
 *   `pullMerge`/`pullRebase`, just against an explicit branch instead of the upstream.
 * - `continue`/`skip`: a rebase or cherry-pick sequence can create commits and then stop
 *   on the next conflict, moving HEAD.
 *
 * Deliberately not listed: `push`/`pushTo` (a rejected push updates no ref),
 * `switch`/`branch`/`renameBranch` (Git checks out, creates or renames atomically),
 * `commit`, `undoLastCommit` (its own parent-exists check runs before the reset),
 * `stage`/`unstage`/`discard`, `deleteBranch`, `abort`, `createTag`/`deleteTag`,
 * `pushTags`/`deleteRemoteRef`/`addRemote`/`removeRemote` (each a single atomic Git
 * call) and the stash family (a stash pop that conflicts keeps the stash, so the
 * shared list is unchanged). The operation's own worktree is always refreshed by
 * `RepoStore.guarded()` whether or not it succeeded.
 */
export const PARTIAL_ON_FAILURE: ReadonlySet<string> = new Set([
  "fetch",
  "pull",
  "pullFrom",
  "pullRebase",
  "pullMerge",
  "mergeBranch",
  "rebaseOnto",
  "publish",
  "continue",
  "skip",
]);

export interface Propagation {
  /** Fields every sibling worktree must re-fetch, or `undefined` for none. */
  siblingFields: readonly RefreshField[] | undefined;
  graphReset: boolean;
}

/**
 * What a finished `guarded()` call must propagate beyond its own worktree. Pure so the
 * rules (success vs. partial failure vs. refused start) can be tested without a registry.
 * `operationBefore`/`operationAfter` are the `operationInProgress` values around a
 * `continue`/`skip`; both are ignored for every other kind.
 */
export function propagationFor(
  kind: string,
  ok: boolean,
  started: boolean,
  operationBefore: string,
  operationAfter: string,
): Propagation {
  if (!ok && !(started && PARTIAL_ON_FAILURE.has(kind))) {
    return { siblingFields: undefined, graphReset: false };
  }
  const sequenceStep = kind === "continue" || kind === "skip";
  const operationJustCompleted = sequenceStep && operationBefore !== "" && operationAfter === "";
  // A failed `continue`/`skip` may still have moved HEAD (commits created before the
  // next conflict), so it resets like a completed one.
  const failedButMoved = !ok && sequenceStep;
  return {
    siblingFields: SIBLING_INVALIDATES[kind],
    graphReset: GRAPH_RESETS.has(kind) || operationJustCompleted || failedButMoved,
  };
}

/**
 * Runs `entry.store.guarded(kind, dirty, operation)` exactly as before (own-worktree
 * behavior, including its refresh, is entirely Module 2's `RepoStore.guarded()`,
 * unchanged), then -- on success, or on failure for a `kind` in `PARTIAL_ON_FAILURE`
 * that actually started, and only for a `kind` this module knows affects something
 * wider than one worktree -- propagates the two remaining effects Module 2 correctly
 * left out of scope:
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
 * `continue`/`skip`'s graph reset is conditional, not a static `GRAPH_RESETS`
 * entry: captures `operationInProgress` before running, and resets the graph only
 * if it was non-empty before and empty afterward (`guarded()`'s own refresh
 * already includes `operationInProgress` for both, per Module 2's `INVALIDATES`,
 * so the post-call snapshot is already current by the time this checks it) -- a
 * `continue`/`skip` that still leaves conflicts (or more commits) remaining never
 * completes the operation, and must not reset the graph. `skip` needs the same
 * check as `continue`: during a multi-commit rebase/cherry-pick/revert, only the
 * FINAL completing call resets the graph (an intermediate continue that still
 * leaves commits remaining does not, so any commits it created stay unreflected
 * until completion) -- if that final call happens to be a skip rather than a
 * continue, the graph must still reset, or every commit created by the whole
 * sequence would stay stale indefinitely.
 */
export async function guardedAffecting(
  entry: RepoEntry,
  kind: string,
  dirty: boolean,
  operation: () => Promise<string>,
): Promise<boolean> {
  const operationBefore =
    kind === "continue" || kind === "skip" ? entry.store.getSnapshot().operationInProgress : "";
  // `guarded()` also returns false when it refuses to start (busy, dirty); nothing ran
  // then, so there is nothing to propagate.
  let started = false;
  const ok = await entry.store.guarded(kind, dirty, () => {
    started = true;
    return operation();
  });
  const effects = propagationFor(
    kind,
    ok,
    started,
    operationBefore,
    entry.store.getSnapshot().operationInProgress,
  );

  const repository = gitRegistry.repositoryFor(entry.repoId);
  if (repository && effects.siblingFields) {
    for (const sibling of repository.worktrees) {
      if (sibling !== entry) void sibling.store.refresh(effects.siblingFields);
    }
  }
  if (repository && effects.graphReset) resetSharedGraphLoader(repository.repositoryId);
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
  // HEAD moved (an external switch/checkout/reset): the HEAD-relative graph is stale.
  head: { fields: ["entries", "branch"], graphReset: true },
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
