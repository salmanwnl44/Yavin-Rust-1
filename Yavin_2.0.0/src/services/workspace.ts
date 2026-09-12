import type { FileNode } from "../types.ts";

export function isWithin(path: string, parent: string): boolean {
  return path === parent || path.startsWith(parent + "/");
}

export function remapPath(path: string, oldPath: string, newPath: string): string {
  return isWithin(path, oldPath) ? newPath + path.slice(oldPath.length) : path;
}

export function parentOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : path;
}

export function findNode(tree: FileNode, path: string): FileNode | null {
  if (tree.path === path) return tree;
  if (!isWithin(path, tree.path)) return null;
  for (const child of tree.children ?? []) {
    const found = findNode(child, path);
    if (found) return found;
  }
  return null;
}

// A fresh listing replaces a directory's children; subfolders that were already loaded keep theirs.
export function mergeChildren(previous: FileNode[] | null | undefined, listed: FileNode[]) {
  const loaded = new Map(
    (previous ?? []).filter((node) => node.is_dir && node.children).map((n) => [n.path, n]),
  );
  return listed.map((node) =>
    node.is_dir && !node.children && loaded.has(node.path)
      ? { ...node, children: loaded.get(node.path)!.children }
      : node,
  );
}

export function setChildren(tree: FileNode, dir: string, listed: FileNode[]): FileNode {
  if (tree.path === dir) return { ...tree, children: mergeChildren(tree.children, listed) };
  if (!tree.children || !isWithin(dir, tree.path)) return tree;
  return {
    ...tree,
    children: tree.children.map((child) =>
      isWithin(dir, child.path) ? setChildren(child, dir, listed) : child,
    ),
  };
}

/** Directories whose children are loaded, parents before their descendants. */
export function loadedDirectories(tree: FileNode): string[] {
  if (!tree.is_dir || !tree.children) return [];
  return [tree.path, ...tree.children.flatMap(loadedDirectories)];
}

/** The closest loaded folder containing `path`; refreshing it shows a change to `path`. */
export function nearestLoadedDirectory(tree: FileNode, path: string): string {
  for (
    let dir = parentOf(path);
    isWithin(dir, tree.path) && dir !== tree.path;
    dir = parentOf(dir)
  ) {
    if (findNode(tree, dir)?.children) return dir;
  }
  return tree.path;
}

const reservedName = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Returns a message for a file or folder name that is invalid on any supported platform. */
export function validateEntryName(name: string, allowNested = false): string | null {
  if (!name.trim()) return "Enter a name.";
  if (!allowNested && name.includes("/")) return "A name cannot contain /.";
  for (const part of allowNested ? name.split("/") : [name]) {
    if (!part) return "Remove the empty folder name (//, or a leading or trailing /).";
    if (part === "." || part === "..") return `“${part}” is not a valid name.`;
    if (/[\\:*?"<>|\x00-\x1f]/.test(part))
      return 'A name cannot contain \\ : * ? " < > | or control characters.';
    if (/[. ]$/.test(part)) return "A name cannot end with a space or a period.";
    if (reservedName.test(part)) return `“${part}” is a reserved name on Windows.`;
  }
  return null;
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
