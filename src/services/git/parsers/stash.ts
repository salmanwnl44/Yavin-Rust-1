export interface StashEntry {
  /** Position in `stash@{N}`, also the index `stash apply`/`drop`/`pop` take. */
  index: number;
  /** The branch it was taken from, when Git recorded one. */
  branch: string;
  message: string;
}

/**
 * Reads `git stash list`'s default one-line-per-stash format:
 * `stash@{0}: WIP on main: 1a2b3c4 subject` (auto message) or
 * `stash@{1}: On main: a custom message` (`git stash push -m`).
 */
export function parseStashList(output: string): StashEntry[] {
  const entries: StashEntry[] = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^stash@\{(\d+)\}:\s*(?:(?:WIP on|On) ([^:]+):\s*)?(.*)$/);
    if (!match) continue;
    entries.push({ index: Number(match[1]), branch: match[2] ?? "", message: match[3] });
  }
  return entries;
}
