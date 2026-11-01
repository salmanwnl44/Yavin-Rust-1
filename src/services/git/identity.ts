import type { RepoEntry, RepositoryEntry } from "./registry.ts";

/**
 * Best-effort normalization of `git rev-parse --git-common-dir`'s raw stdout into a
 * value usable for identity comparison. Git prints a path relative to the queried
 * worktree when the common dir sits directly under it (the main worktree's own
 * `.git`); a linked worktree's common dir is normally already absolute. This does
 * not resolve `..`/symlinks the way Rust's `discover_common_dir` does -- see the
 * Repository & Worktree Architecture plan's Windows/path open questions -- but is
 * sufficient to correctly group worktrees of one repository in the common case.
 */
export function normalizeCommonDir(root: string, raw: string): string {
  const trimmed = raw.trim().replace(/\\/g, "/");
  if (!trimmed) return root;
  const isAbsolute = /^[a-zA-Z]:\//.test(trimmed) || trimmed.startsWith("/");
  return isAbsolute ? trimmed : `${root.replace(/\/$/, "")}/${trimmed}`;
}

/**
 * Attaches `worktree` to the existing `RepositoryEntry` sharing `repositoryId`, or
 * creates a new one -- the actual fix the identity re-keying makes: a second
 * worktree of an already-tracked repository (Git's own `--git-common-dir` says so)
 * is never registered as an unrelated, independent repository.
 */
export function attachWorktree(
  repositories: RepositoryEntry[],
  repositoryId: string,
  worktree: RepoEntry,
): RepositoryEntry[] {
  const existing = repositories.find((r) => r.repositoryId === repositoryId);
  if (!existing)
    return [...repositories, { repositoryId, worktrees: [worktree], knownWorktrees: [] }];
  return repositories.map((r) =>
    r === existing ? { ...r, worktrees: [...r.worktrees, worktree] } : r,
  );
}
