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
  "abort",
  "continue",
  "skip",
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
  | "entries"
  | "branch"
  | "branches"
  | "remotes"
  | "stashes"
  | "operationInProgress";

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
 * always". `remotes` never appears here: nothing in the current Git API adds or
 * removes a remote, so nothing ever invalidates the name list. A `kind` with no
 * entry here (a future mutation this table hasn't been taught about yet) falls back
 * to a full refresh -- the safe default.
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
  commit: ["entries", "branch", "operationInProgress"],
  abort: ["entries", "branch", "operationInProgress"],
  continue: ["entries", "branch", "operationInProgress"],
  skip: ["entries", "branch", "operationInProgress"],
  stash: ["entries", "stashes"],
  stashApply: ["entries", "stashes"],
  stashPop: ["entries", "stashes"],
  stashDrop: ["stashes"],
  fetch: ["branch"],
  pull: ["entries", "branch", "operationInProgress"],
  pullRebase: ["entries", "branch", "operationInProgress"],
  pullMerge: ["entries", "branch", "operationInProgress"],
  push: ["branch"],
  publish: ["branch"],
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
  private snapshot: RepoSnapshot = initialSnapshot;
  private listeners = new Set<() => void>();
  private generation = 0;
  private inFlight = false;
  /**
   * The currently-running bare `refresh()` call (if any), and exactly which
   * fields it's fetching -- lets a second, overlapping `refresh()` call (e.g. a
   * watcher event landing right after the 5s poll fires) that asks for a subset
   * of what's already in flight share that same call instead of spawning
   * duplicate `git` processes for fields already being fetched. Not a
   * correctness mechanism (the existing `generation` guard already prevents a
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
  constructor(repository: Repository, onAnyChange?: () => void) {
    this.repository = repository;
    this.onAnyChange = onAnyChange;
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
    const current = ++this.generation;
    const wants = (field: RefreshField) => fields.includes(field);
    this.activeRefreshes++;
    this.patch({ loading: true });
    try {
      await this.fetchAndApply(current, wants);
    } finally {
      this.activeRefreshes--;
      // A superseded refresh discards its data, but must still hand `loading` back
      // once nothing newer is running (the newer one may already have finished).
      if (this.activeRefreshes === 0 && this.snapshot.loading) this.patch({ loading: false });
    }
  }

  private async fetchAndApply(
    current: number,
    wants: (field: RefreshField) => boolean,
  ): Promise<void> {
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
      if (this.generation !== current) return;
      const next: Partial<RepoSnapshot> = { stale: false };
      // A notice that only reported this store's own failed refresh is obsolete now.
      if (this.refreshError !== null && this.snapshot.notice === this.refreshError) {
        next.notice = "";
      }
      this.refreshError = null;
      if (status !== undefined) next.entries = parseGitEntries(status, this.repository.root);
      if (branchInfo !== undefined) next.branch = parseBranch(branchInfo);
      if (branches !== undefined) next.branches = branches;
      if (remotes !== undefined) next.remotes = remotes;
      if (stashList !== undefined) next.stashes = parseStashList(stashList);
      if (operationInProgress !== undefined) next.operationInProgress = operationInProgress;
      this.patch(next);
      this.lastRefreshedAt = Date.now();
    } catch (error) {
      if (this.generation !== current) return;
      this.refreshError = String(error);
      this.patch({ notice: this.refreshError, stale: true });
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
    this.generation++;
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
