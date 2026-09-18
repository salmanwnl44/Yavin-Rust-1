/** One persisted repository: a restore hint plus the worktree paths last known for it. */
export interface PersistedRepository {
  /** Best-effort last-known common-git-dir identity; used only as a restore hint. */
  commonDirHint: string;
  worktrees: string[];
  activeWorktree?: string;
}

export interface PersistedGitState {
  schemaVersion: 1;
  repositories: PersistedRepository[];
  activeRepository?: string;
}

const EMPTY_STATE: PersistedGitState = { schemaVersion: 1, repositories: [] };

/**
 * Parses this window's persisted Git registry, migrating the pre-worktree schema (a
 * plain array of repository root paths, from before `GitRegistry` knew about
 * worktrees) into the versioned repository/worktree shape on read. A malformed or
 * unrecognized value is treated as empty rather than thrown -- losing a stale
 * persisted list is safe; crashing on it on every subsequent launch is not.
 */
export function parsePersistedState(raw: string | null): PersistedGitState {
  if (!raw) return EMPTY_STATE;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_STATE;
  }
  if (Array.isArray(parsed)) {
    // Pre-worktree schema: a plain array of repository root paths, one worktree each.
    const roots = parsed.filter((p): p is string => typeof p === "string");
    return {
      schemaVersion: 1,
      repositories: roots.map((root) => ({ commonDirHint: root, worktrees: [root] })),
    };
  }
  if (
    parsed &&
    typeof parsed === "object" &&
    (parsed as { schemaVersion?: unknown }).schemaVersion === 1 &&
    Array.isArray((parsed as { repositories?: unknown }).repositories)
  ) {
    return parsed as PersistedGitState;
  }
  return EMPTY_STATE;
}
