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
 * Keeps only well-formed entries of an already-versioned value, so one damaged record (a
 * hand-edited or half-written value) drops that record instead of throwing while the registry
 * restores on every launch.
 */
function sanitize(state: PersistedGitState): PersistedGitState {
  const repositories: PersistedRepository[] = [];
  for (const candidate of state.repositories as unknown[]) {
    if (!candidate || typeof candidate !== "object") continue;
    const record = candidate as Partial<PersistedRepository>;
    if (typeof record.commonDirHint !== "string" || !Array.isArray(record.worktrees)) continue;
    const worktrees = record.worktrees.filter((w): w is string => typeof w === "string" && !!w);
    if (worktrees.length === 0) continue;
    repositories.push({
      commonDirHint: record.commonDirHint,
      worktrees,
      ...(typeof record.activeWorktree === "string"
        ? { activeWorktree: record.activeWorktree }
        : {}),
    });
  }
  return {
    schemaVersion: 1,
    repositories,
    ...(typeof state.activeRepository === "string"
      ? { activeRepository: state.activeRepository }
      : {}),
  };
}

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
    return sanitize(parsed as PersistedGitState);
  }
  return EMPTY_STATE;
}
