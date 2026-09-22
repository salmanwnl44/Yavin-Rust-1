import type { Repository } from "./repository.ts";
import type { GitOperation } from "./backend.ts";
import type { Branch } from "./parsers/branch.ts";
import { parseBranch } from "./parsers/branch.ts";
import type { GitEntry } from "./parsers/status.ts";
import { parseGitEntries } from "./parsers/status.ts";
import type { StashEntry } from "./parsers/stash.ts";
import { parseStashList } from "./parsers/stash.ts";

const EMPTY_BRANCH: Branch = { name: "", detached: false, upstream: "", ahead: 0, behind: 0 };

// Actions that rewrite the working tree or HEAD are refused while an editor has
// unsaved changes -- otherwise those edits could be silently overwritten or orphaned.
export const DIRTY_BLOCKED = new Set([
  "switch",
  "branch",
  "pull",
  "pullRebase",
  "pullMerge",
  "pullFrom",
  "mergeBranch",
  "rebaseOnto",
  // Both write the commit's content into the working tree, and can stop mid-way on a
  // conflict, exactly like a merge.
  "cherryPick",
  "revertCommit",
  "undoLastCommit",
  "abort",
  "continue",
  "skip",
  // The stash family rewrites tracked files on disk exactly like a pull does. Without
  // these, stashing with an unsaved editor open reverted the file on disk while the stale
  // buffer survived, so the next save wrote the stashed-away content straight back -- the
  // change then existed both in the stash and in the working tree.
  "stash",
  "stashApply",
  "stashPop",
  // `git apply -R` against the working-tree file, for the same reason. (`stage-hunk` and
  // `unstage-hunk` are deliberately absent: they only ever touch the index.)
  "discard-hunk",
]);

export interface RepoSnapshot {
  entries: GitEntry[];
  branch: Branch;
  branches: string[];
  remotes: string[];
  stashes: StashEntry[];
  operationInProgress: GitOperation;
  loading: boolean;
  busy: boolean;
  notice: string;
  /** Set when `notice` is the current operation being cancelled, not a real
   * failure -- the UI renders this distinctly (informational, not an error). */
  cancelled: boolean;
  /**
   * Set when the most recent `refresh()` failed, so every field above is
   * last-known-good rather than freshly confirmed -- never cleared to `[]`/empty
   * on failure (see `refresh()`'s `catch`, which never touches the data fields on
   * error), only flagged. Cleared on the next successful `refresh()`.
   */
  stale: boolean;
}

/** One of `refresh()`'s independently-fetchable pieces of worktree state. */
export type RefreshField =
  "entries" | "branch" | "branches" | "remotes" | "stashes" | "operationInProgress";

const ALL_REFRESH_FIELDS: readonly RefreshField[] = [
  "entries",
  "branch",
  "branches",
  "remotes",
  "stashes",
  "operationInProgress",
];

/**
 * Which of `refresh()`'s six independent fetches can actually go stale after each
 * `kind` of mutation -- derived from the Git Operation Engine plan's Section H
 * matrix (which ref category each operation actually touches), not "run everything,
 * always". A `kind` with no entry here (a future mutation this table hasn't been
 * taught about yet) falls back to a full refresh -- the safe default.
 *
 * `pushTags`/`deleteRemoteRef`/`createTag`/`deleteTag` invalidate nothing here: a
 * tag isn't part of `RepoSnapshot`, and a remote-only deletion doesn't change this
 * worktree's own entries/branch/branches until a later fetch/prune reflects it.
 */
const INVALIDATES: Readonly<Record<string, readonly RefreshField[]>> = {
  stage: ["entries"],
  unstage: ["entries"],
  discard: ["entries"],
  "stage-hunk": ["entries"],
  "unstage-hunk": ["entries"],
  "discard-hunk": ["entries"],
  switch: ["entries", "branch"],
  branch: ["entries", "branch", "branches"],
  deleteBranch: ["branches"],
  renameBranch: ["branch", "branches"],
  commit: ["entries", "branch", "operationInProgress"],
  undoLastCommit: ["entries", "branch", "operationInProgress"],
  mergeBranch: ["entries", "branch", "operationInProgress"],
  rebaseOnto: ["entries", "branch", "operationInProgress"],
  cherryPick: ["entries", "branch", "operationInProgress"],
  revertCommit: ["entries", "branch", "operationInProgress"],
  abort: ["entries", "branch", "operationInProgress"],
  continue: ["entries", "branch", "operationInProgress"],
  skip: ["entries", "branch", "operationInProgress"],
  stash: ["entries", "stashes"],
  stashApply: ["entries", "stashes"],
  stashPop: ["entries", "stashes"],
  stashDrop: ["stashes"],
  stashClear: ["stashes"],
  pushTags: [],
  deleteRemoteRef: [],
  createTag: [],
  deleteTag: [],
  fetch: ["branch"],
  pull: ["entries", "branch", "operationInProgress"],
  pullFrom: ["entries", "branch", "operationInProgress"],
  pullRebase: ["entries", "branch", "operationInProgress"],
  pullMerge: ["entries", "branch", "operationInProgress"],
  push: ["branch"],
  pushTo: ["branch"],
  publish: ["branch"],
  addRemote: ["remotes"],
  removeRemote: ["remotes"],
};

function isSubsetOf<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

const initialSnapshot: RepoSnapshot = {
  entries: [],
  branch: EMPTY_BRANCH,
  branches: [],
  remotes: [],
  stashes: [],
  operationInProgress: "",
  loading: false,
  busy: false,
  notice: "",
  cancelled: false,
  stale: false,
};

/**
 * The reactive state for one open repository, shared by everything that displays it
 * (the active Source Control panel, the repo switcher's badge count, the status bar).
 * `subscribe`/`getSnapshot` are shaped for `useSyncExternalStore`.
 */
export class RepoStore {
  readonly repository: Repository;
  private readonly onAnyChange?: () => void;
  private readonly onRefreshOutcome?: (ok: boolean) => void;
  private snapshot: RepoSnapshot = initialSnapshot;
  private listeners = new Set<() => void>();
  /**
   * One generation per field, not per store. A refresh claims the fields it fetches and may
   * only apply a field while nobody newer has claimed it. With a single store-wide counter,
   * two overlapping refreshes of *different* fields (a watcher's `refs` event refreshing the
   * branch list at the same instant its `head` event refreshes status and branch) made the
   * later one supersede the earlier, throwing away a perfectly good, unrelated result -- the
   * branch dropdown then stayed stale until the next 5-second poll.
   */
  private fieldGeneration: Record<RefreshField, number> = {
    entries: 0,
    branch: 0,
    branches: 0,
    remotes: 0,
    stashes: 0,
    operationInProgress: 0,
  };
  private inFlight = false;
  /**
   * The currently-running bare `refresh()` call (if any), and exactly which
   * fields it's fetching -- lets a second, overlapping `refresh()` call (e.g. a
   * watcher event landing right after the 5s poll fires) that asks for a subset
   * of what's already in flight share that same call instead of spawning
   * duplicate `git` processes for fields already being fetched. Not a
   * correctness mechanism (the per-field generation guard already prevents a
   * stale result from ever being applied) -- purely avoids wasted process spawns
   * for the specific overlapping-refresh race the Git State & Synchronization
   * plan's Section N/Race 2 identifies. A request that isn't fully covered by
   * what's in flight (e.g. a full refresh while only `["entries"]` is pending)
   * simply runs as its own independent call, same as today.
   */
  private inFlightRefresh: {
    fields: ReadonlySet<RefreshField>;
    promise: Promise<void>;
    epoch: number;
  } | null = null;
  /**
   * Bumped when a mutation starts and again when it finishes. A refresh may only be
   * shared with an in-flight one from the same epoch: one that began before (or during)
   * a mutation can have read pre-mutation state, so adopting it as the post-mutation
   * refresh would leave the snapshot stale (reads run lock-free, so this overlap is real).
   */
  private mutationEpoch = 0;
  /** Refreshes currently running; `loading` stays true until the last one settles, even
   * when an older one is superseded and its result discarded. */
  private activeRefreshes = 0;
  /** The `notice` text a failed refresh produced, so a later success can clear exactly
   * that text without wiping an operation's own message. */
  private refreshError: string | null = null;
  /** Set on every successful `refresh()` completion, whatever triggered it --
   * read by `SourceControlPanel.tsx` to skip a redundant refresh right after
   * switching to a worktree whose cached snapshot is already fresh enough. */
  lastRefreshedAt = 0;

  // Not a parameter-property shorthand -- see the matching note in repository.ts.
  constructor(
    repository: Repository,
    onAnyChange?: () => void,
    onRefreshOutcome?: (ok: boolean) => void,
  ) {
    this.repository = repository;
    this.onAnyChange = onAnyChange;
    this.onRefreshOutcome = onRefreshOutcome;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): RepoSnapshot => this.snapshot;

  private patch(next: Partial<RepoSnapshot>) {
    this.snapshot = { ...this.snapshot, ...next };
    for (const listener of this.listeners) listener();
    // Lets the registry re-notify its own subscribers (the repo switcher's badge
    // counts, the aggregated activity-bar total) without them each subscribing to
    // every open repo individually.
    this.onAnyChange?.();
  }

  /**
   * Re-fetches only `fields` (everything, by default -- used for the initial load
   * and the panel's periodic/focus-triggered poll). `guarded()` passes the narrower
   * set `INVALIDATES` implies for its `kind`, so e.g. staging one file spawns one
   * `git` process here instead of five.
   */
  async refresh(fields: readonly RefreshField[] = ALL_REFRESH_FIELDS): Promise<void> {
    const requested = new Set(fields);
    const inFlight = this.inFlightRefresh;
    if (
      inFlight &&
      inFlight.epoch === this.mutationEpoch &&
      isSubsetOf(requested, inFlight.fields)
    ) {
      return inFlight.promise;
    }
    const promise = this.doRefresh(fields);
    this.inFlightRefresh = { fields: requested, promise, epoch: this.mutationEpoch };
    try {
      await promise;
    } finally {
      if (this.inFlightRefresh?.promise === promise) this.inFlightRefresh = null;
    }
  }

  private async doRefresh(fields: readonly RefreshField[]): Promise<void> {
    const claimed = new Map<RefreshField, number>();
    for (const field of fields) claimed.set(field, ++this.fieldGeneration[field]);
    this.activeRefreshes++;
    this.patch({ loading: true });
    try {
      await this.fetchAndApply(claimed);
    } finally {
      this.activeRefreshes--;
      // A superseded refresh discards its data, but must still hand `loading` back
      // once nothing newer is running (the newer one may already have finished).
      if (this.activeRefreshes === 0 && this.snapshot.loading) this.patch({ loading: false });
    }
  }

  private async fetchAndApply(claimed: ReadonlyMap<RefreshField, number>): Promise<void> {
    const wants = (field: RefreshField) => claimed.has(field);
    // Still ours: no newer refresh (or mutation) has claimed this field since.
    const live = (field: RefreshField) => this.fieldGeneration[field] === claimed.get(field);
    try {
      const [status, branchInfo, branches, remotes, stashList, operationInProgress] =
        await Promise.all([
          wants("entries") ? this.repository.status() : undefined,
          wants("branch") ? this.repository.branchInfo() : undefined,
          wants("branches") ? this.repository.branches() : undefined,
          wants("remotes") ? this.repository.remotes() : undefined,
          wants("stashes") ? this.repository.stashList() : undefined,
          wants("operationInProgress") ? this.repository.state() : undefined,
        ]);
      const next: Partial<RepoSnapshot> = {};
      if (status !== undefined && live("entries"))
        next.entries = parseGitEntries(status, this.repository.root);
      if (branchInfo !== undefined && live("branch")) next.branch = parseBranch(branchInfo);
      if (branches !== undefined && live("branches")) next.branches = branches;
      if (remotes !== undefined && live("remotes")) next.remotes = remotes;
      if (stashList !== undefined && live("stashes")) next.stashes = parseStashList(stashList);
      if (operationInProgress !== undefined && live("operationInProgress"))
        next.operationInProgress = operationInProgress;
      // Everything this call fetched was superseded: nothing of it is worth applying.
      if (Object.keys(next).length === 0) return;
      next.stale = false;
      // A notice that only reported this store's own failed refresh is obsolete now.
      if (this.refreshError !== null && this.snapshot.notice === this.refreshError) {
        next.notice = "";
      }
      this.refreshError = null;
      this.patch(next);
      this.lastRefreshedAt = Date.now();
      this.onRefreshOutcome?.(true);
    } catch (error) {
      // Only report a failure the current state still depends on.
      if (![...claimed.keys()].some(live)) return;
      this.refreshError = String(error);
      this.patch({ notice: this.refreshError, stale: true });
      this.onRefreshOutcome?.(false);
    }
  }

  /**
   * Runs one mutating Git operation with the shared busy/dirty/error handling and
   * refreshes afterward. Returns whether it succeeded, so callers can clear
   * UI-local-only state (a commit message draft, a new-branch input) on success only.
   */
  async guarded(kind: string, dirty: boolean, operation: () => Promise<string>): Promise<boolean> {
    if (this.inFlight) {
      // Previously a silent no-op (see the Git Operation Engine plan's error
      // model, Section G) -- a second click while busy looked like nothing
      // happened at all, rather than telling the user why it was refused.
      this.patch({
        notice: "Another Git operation is already running for this worktree.",
        cancelled: false,
      });
      return false;
    }
    if (DIRTY_BLOCKED.has(kind) && dirty) {
      this.patch({ notice: "Save or close unsaved editors before changing the working tree." });
      return false;
    }
    this.inFlight = true;
    this.patch({ busy: true, notice: "", cancelled: false });
    for (const field of Object.keys(this.fieldGeneration) as RefreshField[])
      this.fieldGeneration[field]++;
    this.mutationEpoch++;
    let ok = false;
    try {
      const output = await operation();
      this.patch({ notice: output.trim() || "Operation completed." });
      ok = true;
    } catch (error) {
      // Rust's cancellation path (see the Git Operation Engine plan) reports this
      // exact string, never wrapped in Git's own stderr phrasing -- distinguishing
      // it lets the UI show "Cancelled" as informational rather than as a failure.
      const message = String(error);
      this.patch({ notice: message, cancelled: message === "Cancelled" });
    } finally {
      this.inFlight = false;
      this.mutationEpoch++;
      this.patch({ busy: false });
      await this.refresh(INVALIDATES[kind] ?? ALL_REFRESH_FIELDS);
    }
    return ok;
  }

  /**
   * Stops whatever operation `guarded()` currently has running or lock-queued for
   * this worktree. Since only one can ever be in flight per store (`inFlight`
   * above), there is never more than one candidate to address -- no operation id
   * needs to be tracked here at all; `Repository.cancel()` addresses it by
   * repository on the Rust side instead (see the Git Operation Engine plan).
   */
  cancel(): void {
    if (!this.inFlight) return;
    void this.repository.cancel().catch((error) => this.setNotice(String(error)));
  }

  setNotice(notice: string): void {
    this.patch({ notice, cancelled: false });
  }

  dispose(): void {
    this.listeners.clear();
  }
}
