export interface WorktreeInfo {
  path: string;
  headHash: string;
  /** The branch checked out here (short name), or "" when detached. */
  branch: string;
  detached: boolean;
  locked: boolean;
  /** Present only when `git worktree lock` was given a reason. */
  lockedReason: string;
  /** True when Git considers this worktree safe to `git worktree prune`. */
  prunable: boolean;
  prunableReason: string;
  /** The first entry `git worktree list` reports is always the main worktree. */
  isMain: boolean;
}

/**
 * Parses `git worktree list --porcelain`: one blank-line-separated block per
 * worktree, each a `key[ value]` line per line -- documented in `git-worktree(1)`.
 * Using this machine-readable form (rather than scanning directories for `.git`
 * files) is what lets Yavin distinguish a linked worktree from an unrelated
 * repository and surface locked/prunable state Git itself already tracks.
 */
export function parseWorktreeList(porcelain: string): WorktreeInfo[] {
  const blocks = porcelain
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  return blocks.map((block, index) => {
    const info: WorktreeInfo = {
      path: "",
      headHash: "",
      branch: "",
      detached: false,
      locked: false,
      lockedReason: "",
      prunable: false,
      prunableReason: "",
      isMain: index === 0,
    };
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) info.path = line.slice("worktree ".length);
      else if (line.startsWith("HEAD ")) info.headHash = line.slice("HEAD ".length);
      else if (line.startsWith("branch "))
        info.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
      else if (line === "detached") info.detached = true;
      else if (line === "locked") info.locked = true;
      else if (line.startsWith("locked ")) {
        info.locked = true;
        info.lockedReason = line.slice("locked ".length);
      } else if (line === "prunable") info.prunable = true;
      else if (line.startsWith("prunable ")) {
        info.prunable = true;
        info.prunableReason = line.slice("prunable ".length);
      }
    }
    return info;
  });
}
