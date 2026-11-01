import type { RepoEntry } from "../git/registry.ts";
import type { RepoSnapshot } from "../git/store.ts";
import type { RawCommit } from "../git/parsers/log.ts";

export const BASELINE_RECENT_COMMITS = 5;

/**
 * The small, always-cheap slice of Git state handed to an agent up front. Derived
 * entirely from a `RepoStore` snapshot already in memory (and, optionally, an
 * already-loaded page of history) -- building it never spawns a Git process.
 * Everything else (diffs, file lists, full branch lists) is an on-demand tool call.
 */
export interface GitBaselineContext {
  repoId: string;
  root: string;
  branch: { name: string; detached: boolean; upstream: string; ahead: number; behind: number };
  changeSummary: { staged: number; unstaged: number; conflicts: number; untracked: number };
  operationInProgress: RepoSnapshot["operationInProgress"];
  stashCount: number;
  busy: boolean;
  stale: boolean;
  recentCommitSubjects: string[];
}

export function getGitContext(
  entry: Pick<RepoEntry, "repoId" | "root" | "store">,
  recentCommits: readonly RawCommit[] = [],
): GitBaselineContext {
  const s = entry.store.getSnapshot();
  let staged = 0;
  let unstaged = 0;
  let conflicts = 0;
  let untracked = 0;
  for (const e of s.entries) {
    if (e.conflict) conflicts++;
    else if (e.untracked) untracked++;
    else {
      if (e.index !== " ") staged++;
      if (e.worktree !== " ") unstaged++;
    }
  }
  return {
    repoId: entry.repoId,
    root: entry.root,
    branch: {
      name: s.branch.name,
      detached: s.branch.detached,
      upstream: s.branch.upstream,
      ahead: s.branch.ahead,
      behind: s.branch.behind,
    },
    changeSummary: { staged, unstaged, conflicts, untracked },
    operationInProgress: s.operationInProgress,
    stashCount: s.stashes.length,
    busy: s.busy,
    stale: s.stale,
    recentCommitSubjects: recentCommits.slice(0, BASELINE_RECENT_COMMITS).map((c) => c.subject),
  };
}
