export interface GitEntry {
  path: string; originalPath?: string; index: string; worktree: string;
  untracked: boolean; conflict: boolean;
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
    const entry: GitEntry = { path: full(record.slice(3)), index: code[0], worktree: code[1], untracked: code === "??", conflict: ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(code) };
    if (/[RC]/.test(code)) {
      const original = records[++i];
      if (!original) throw new Error("Incomplete Git rename record");
      entry.originalPath = full(original);
    }
    entries.push(entry);
  }
  return entries;
}
export function parseBranch(output: string): { name: string; upstream: string; ahead: number; behind: number } {
  const field = (name: string) => output.split("\n").find(l => l.startsWith(`# branch.${name} `))?.slice(name.length + 10) ?? "";
  const ab = field("ab").match(/\+(\d+) -(\d+)/);
  return { name: field("head"), upstream: field("upstream"), ahead: Number(ab?.[1] ?? 0), behind: Number(ab?.[2] ?? 0) };
}
