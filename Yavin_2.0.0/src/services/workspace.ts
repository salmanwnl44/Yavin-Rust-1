import type { FileNode } from "../types.ts";

export function isWithin(path: string, parent: string): boolean {
  return path === parent || path.startsWith(parent + "/");
}

export function remapPath(path: string, oldPath: string, newPath: string): string {
  return isWithin(path, oldPath) ? newPath + path.slice(oldPath.length) : path;
}

export function flattenFiles(tree: FileNode): { title: string; subtitle: string; type: "file" }[] {
  if (!tree.is_dir) return [{ title: tree.name, subtitle: tree.path, type: "file" }];
  return (tree.children ?? []).flatMap(flattenFiles);
}

// NUL-delimited porcelain preserves spaces, quotes and newlines in filenames.
export function parseGitStatus(output: string, root: string): Record<string, string> {
  const records = output.split("\0");
  const status: Record<string, string> = {};
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.length < 4) continue;
    const code = record.slice(0, 2);
    const name = record.slice(3);
    status[`${root.replace(/\/$/, "")}/${name}`] =
      code === "??"
        ? "U"
        : code.includes("U") || code === "AA" || code === "DD"
          ? "CONFLICT"
          : code.includes("R")
            ? "R"
            : code.includes("D")
              ? "D"
              : code.includes("A")
                ? "A"
                : "M";
    if (code.includes("R") || code.includes("C")) i++;
  }
  return status;
}
