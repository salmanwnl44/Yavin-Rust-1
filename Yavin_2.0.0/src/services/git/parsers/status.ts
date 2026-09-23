import { isWithin, parentOf } from "../../workspace.ts";

export interface GitEntry {
  path: string;
  originalPath?: string;
  index: string;
  worktree: string;
  untracked: boolean;
  conflict: boolean;
}

export function parseGitEntries(output: string, root: string): GitEntry[] {
  const records = output.split("\0");
  const entries: GitEntry[] = [];
  const full = (path: string) => root.replace(/\/$/, "") + "/" + path;
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    if (record.length < 4 || record[2] !== " ") throw new Error("Invalid Git status record");
    const code = record.slice(0, 2);
    const entry: GitEntry = {
      path: full(record.slice(3)),
      index: code[0],
      worktree: code[1],
      untracked: code === "??",
      conflict: ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(code),
    };
    if (/[RC]/.test(code)) {
      const original = records[++i];
      if (!original) throw new Error("Incomplete Git rename record");
      entry.originalPath = full(original);
    }
    entries.push(entry);
  }
  return entries;
}

export interface Decorations {
  files: Map<string, string>;
  folders: Set<string>;
}

/** Explorer badges keyed by path, plus the folders that contain changes. Built once per status refresh. */
/**
 * Whether two sets of decorations say the same thing.
 *
 * Rebuilding them produces equal maps with new identities, and the explorer takes them as a
 * prop -- so a rebuild that changed nothing still re-rendered the tree. Comparing is O(n) in
 * the number of changed files, which is the small number here; rendering is not.
 */
export function sameDecorations(a: Decorations, b: Decorations): boolean {
  if (a.files.size !== b.files.size || a.folders.size !== b.folders.size) return false;
  for (const [path, mark] of a.files) if (b.files.get(path) !== mark) return false;
  for (const folder of a.folders) if (!b.folders.has(folder)) return false;
  return true;
}

export function buildDecorations(entries: GitEntry[], workspace: string): Decorations {
  const files = new Map<string, string>();
  const folders = new Set<string>();
  const root = workspace.toLowerCase();
  for (const entry of entries) {
    // Git spells paths from its own root; use the workspace's canonical casing for that prefix only.
    const lower = entry.path.toLowerCase();
    const path =
      lower === root || lower.startsWith(root + "/")
        ? workspace + entry.path.slice(workspace.length)
        : entry.path;
    files.set(
      path,
      entry.conflict
        ? "!"
        : entry.untracked
          ? "U"
          : entry.index !== " "
            ? entry.index
            : entry.worktree,
    );
    for (
      let dir = parentOf(path);
      isWithin(dir, workspace) && dir !== workspace;
      dir = parentOf(dir)
    )
      folders.add(dir);
  }
  return { files, folders };
}
