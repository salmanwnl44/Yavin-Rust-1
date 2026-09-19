import type { Repository } from "./repository.ts";
import type { GitOperation } from "./backend.ts";
import type { Branch } from "./parsers/branch.ts";
import { parseBranch } from "./parsers/branch.ts";
import type { GitEntry } from "./parsers/status.ts";
import { parseGitEntries } from "./parsers/status.ts";
import type { StashEntry } from "./parsers/stash.ts";
import { parseStashList } from "./parsers/stash.ts";

const EMPTY_BRANCH: Branch = { name: "", upstream: "", ahead: 0, behind: 0 };

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
}

/** One of `refresh()`'s independently-fetchable pieces of worktree state. */
type RefreshField = "entries" | "branch" | "branches" | "remotes" | "stashes" | "operationInProgress";

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
  commit: ["entries", "branch", "operationInProgress"],
  abort: ["entries", "branch", "operationInProgress"],
  continue: ["entries", "branch", "operationInProgress"],
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
    const current = ++this.generation;
    const wants = (field: RefreshField) => fields.includes(field);
    this.patch({ loading: true });
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
      const next: Partial<RepoSnapshot> = { loading: false };
      if (status !== undefined) next.entries = parseGitEntries(status, this.repository.root);
      if (branchInfo !== undefined) next.branch = parseBranch(branchInfo);
      if (branches !== undefined) next.branches = branches;
      if (remotes !== undefined) next.remotes = remotes;
      if (stashList !== undefined) next.stashes = parseStashList(stashList);
      if (operationInProgress !== undefined) next.operationInProgress = operationInProgress;
      this.patch(next);
    } catch (error) {
      if (this.generation !== current) return;
      this.patch({ notice: String(error), loading: false });
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
