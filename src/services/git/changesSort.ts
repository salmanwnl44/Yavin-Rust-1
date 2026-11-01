import type { GitEntry } from "./parsers/status.ts";

/**
 * The orders the "Sort Changes" menu offers -- exactly these three, matching Antigravity's own
 * "Sort Changes by Name/Path/Status":
 * - `path`: the full path, lexicographically (files in the same folder stay together);
 * - `name`: by file name alone, then by folder (files named alike sit together even across
 *   different folders);
 * - `status`: grouped by status letter (see `STATUS_ORDER`), then by path.
 */
export type ChangesSort = "path" | "name" | "status";

export const CHANGES_SORTS: readonly ChangesSort[] = ["path", "name", "status"];

/** The one letter the list shows for a file: conflict, untracked, else the working-tree state
 * if any remains, else the staged state. */
export function statusLetter(entry: GitEntry): string {
  if (entry.conflict) return "!";
  if (entry.untracked) return "U";
  return entry.worktree !== " " ? entry.worktree : entry.index;
}

/** Status groups in display order; any other letter sorts after these, alphabetically. */
const STATUS_ORDER = ["M", "A", "R", "D", "T", "C", "U"];

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const dirName = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

function statusRank(letter: string): number {
  const rank = STATUS_ORDER.indexOf(letter);
  return rank === -1 ? STATUS_ORDER.length : rank;
}

/**
 * Orders the changed files for display. Unresolved conflicts always come first, in every
 * mode -- they block committing and must not be sorted out of sight -- and the requested
 * order applies within the conflicts and within everything else. Never mutates `entries`.
 *
 * `path` compares the full path directly. `name` compares the file name without regard to
 * case or folder ("a.ts" in two folders sit together, "file2" before "file10"), then the
 * folder, then the full path as a final tiebreak. `status` groups by `statusLetter`, then by
 * path. A renamed file sorts by its new path in every mode. Ties fall back to Git's own order
 * (`Array.prototype.sort` is stable), so equal files never shuffle between refreshes.
 */
export function sortChanges(entries: readonly GitEntry[], order: ChangesSort): GitEntry[] {
  const conflicts = entries.filter((e) => e.conflict);
  const others = entries.filter((e) => !e.conflict);

  const byPath = (a: GitEntry, b: GitEntry) => collator.compare(a.path, b.path);
  const compare =
    order === "path"
      ? byPath
      : order === "name"
        ? (a: GitEntry, b: GitEntry) =>
            collator.compare(baseName(a.path), baseName(b.path)) ||
            collator.compare(dirName(a.path), dirName(b.path)) ||
            byPath(a, b)
        : (a: GitEntry, b: GitEntry) => {
            const la = statusLetter(a);
            const lb = statusLetter(b);
            return (
              statusRank(la) - statusRank(lb) ||
              (statusRank(la) === STATUS_ORDER.length ? la.localeCompare(lb) : 0) ||
              byPath(a, b)
            );
          };
  return [...conflicts.sort(compare), ...others.sort(compare)];
}

const STORAGE_KEY = "yavin.scm.changesSort";

/** The remembered choice, or `path` (Antigravity's own default) when nothing valid was saved. */
export function readChangesSort(): ChangesSort {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return CHANGES_SORTS.includes(saved as ChangesSort) ? (saved as ChangesSort) : "path";
  } catch {
    return "path";
  }
}

export function saveChangesSort(order: ChangesSort): void {
  try {
    localStorage.setItem(STORAGE_KEY, order);
  } catch {
    /* The choice simply is not remembered when storage is unavailable. */
  }
}

const VIEW_AS_TREE_KEY = "yavin.scm.changesViewAsTree";

/** Whether the Changes list is folder-grouped ("View as Tree") instead of flat. */
export function readChangesViewAsTree(): boolean {
  try {
    return localStorage.getItem(VIEW_AS_TREE_KEY) === "true";
  } catch {
    return false;
  }
}

export function saveChangesViewAsTree(asTree: boolean): void {
  try {
    localStorage.setItem(VIEW_AS_TREE_KEY, String(asTree));
  } catch {
    /* The choice simply is not remembered when storage is unavailable. */
  }
}
