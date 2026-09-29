import type { GitEntry } from "./parsers/status.ts";
import { sortChanges } from "./changesSort.ts";
import type { ChangesSort } from "./changesSort.ts";

/**
 * How Source Control shows the changed files: grouped into Conflicts, Staged and Unstaged (a
 * partly staged file is in both, each row showing its own half), or as one list where a
 * checkbox says whether each file is staged. Either way, filtered by what is typed in the
 * filter box. Pure: the panel draws what this returns.
 */

/** Whether the index holds a staged change for this entry (conflicts are never "staged"). */
export const hasStagedPart = (e: GitEntry) => !e.conflict && !e.untracked && e.index !== " ";
/** Whether the working tree still has changes the index does not (untracked counts). */
export const hasUnstagedPart = (e: GitEntry) => !e.conflict && (e.untracked || e.worktree !== " ");
/** What "Discard" restores: tracked files modified in the working tree. Untracked, deleted,
 * added, renamed-only, staged-only and conflicted files are never touched by it. */
export const isDiscardable = (e: GitEntry) => e.worktree === "M" && !e.conflict;

export type ChangeGroup = "conflicts" | "staged" | "unstaged" | "all";

export interface GroupedChanges {
  conflicts: GitEntry[];
  staged: GitEntry[];
  unstaged: GitEntry[];
  /** Every entry once, conflicts first: the single-list view. */
  all: GitEntry[];
}

/** Whether `entry` matches `filter`: every word of it appears in its repo-relative path. */
export function matchesFilter(relativePath: string, filter: string): boolean {
  const words = filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = relativePath.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

export function groupChanges(
  entries: readonly GitEntry[],
  order: ChangesSort,
  filter = "",
  relativePath: (path: string) => string = (path) => path,
): GroupedChanges {
  const shown = entries.filter((entry) => matchesFilter(relativePath(entry.path), filter));
  const all = sortChanges(shown, order);
  return {
    all,
    conflicts: all.filter((entry) => entry.conflict),
    staged: all.filter(hasStagedPart),
    unstaged: all.filter(hasUnstagedPart),
  };
}

/** Which diff a row opens: a Staged row its staged change, an Unstaged row what is left. */
export function opensStagedDiff(entry: GitEntry, group: ChangeGroup): boolean {
  if (group === "staged") return true;
  if (group === "unstaged" || group === "conflicts") return false;
  // The single list: a fully staged file shows its staged change; anything else what is left.
  return hasStagedPart(entry) && !hasUnstagedPart(entry);
}
