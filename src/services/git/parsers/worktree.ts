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
 * Splits `git worktree list --porcelain` output into one array of `key[ value]`
 * attributes per worktree. Handles both spellings Git produces:
 * - `-z` (Git 2.36+): every attribute is NUL-terminated and a worktree ends with an extra
 *   NUL. This is the reliable form: a path (or a lock reason) may contain a newline, which
 *   the line-based form cannot represent unambiguously.
 * - the plain line form: one line per attribute, a blank line between worktrees.
 */
function porcelainBlocks(output: string): string[][] {
  if (output.includes("\0")) {
    const blocks: string[][] = [];
    let current: string[] = [];
    for (const attribute of output.split("\0")) {
      if (attribute === "") {
        if (current.length) blocks.push(current);
        current = [];
      } else current.push(attribute);
    }
    if (current.length) blocks.push(current);
    return blocks;
  }
  return output
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => block.split("\n"));
}

/**
 * Parses `git worktree list --porcelain` (with or without `-z`): one block per
 * worktree, each a `key[ value]` attribute -- documented in `git-worktree(1)`.
 * Using this machine-readable form (rather than scanning directories for `.git`
 * files) is what lets Yavin distinguish a linked worktree from an unrelated
 * repository and surface locked/prunable state Git itself already tracks.
 */
export function parseWorktreeList(porcelain: string): WorktreeInfo[] {
  return porcelainBlocks(porcelain).map((block, index) => {
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
    for (const line of block) {
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
