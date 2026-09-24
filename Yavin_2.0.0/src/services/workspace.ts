import type { FileNode } from "../types.ts";
import { containsPath, relativePath } from "./resource.ts";

/** Whether `path` is `parent` itself or lies inside it, by the rules in `resource.ts`. */
export function isWithin(path: string, parent: string): boolean {
  return containsPath(parent, path);
}

export function remapPath(path: string, oldPath: string, newPath: string): string {
  const rel = relativePath(oldPath, path);
  if (rel === undefined) return path;
  return rel === "." ? newPath : `${newPath.replace(/\/+$/, "")}/${rel}`;
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

/**
 * Everything about an entry that a fresh listing could have changed. `children` is compared
 * by identity, which is what makes the reuse below propagate up a subtree rather than
 * stopping at the first directory.
 */
function sameEntry(a: FileNode, b: FileNode): boolean {
  return (
    a.name === b.name &&
    a.is_dir === b.is_dir &&
    a.size === b.size &&
    a.modified === b.modified &&
    a.readonly === b.readonly &&
    a.children === b.children
  );
}

function sameNodes(a: FileNode[] | null | undefined, b: FileNode[]): boolean {
  if (!a || a.length !== b.length) return false;
  return a.every((node, index) => node === b[index]);
}

/**
 * A fresh listing replaces a directory's children; subfolders that were already loaded keep
 * theirs.
 *
 * An entry that has not changed is handed back as the object it already was, rather than as
 * an equal copy. The explorer's rows are memoized on the node they render, so re-listing a
 * directory used to re-render every row inside it -- and a refresh walks every loaded
 * directory, so that was the whole visible tree, on every settled burst of filesystem events.
 */
export function mergeChildren(previous: FileNode[] | null | undefined, listed: FileNode[]) {
  const before = new Map((previous ?? []).map((node) => [node.path, node]));
  return listed.map((node) => {
    const existing = before.get(node.path);
    // A listing of the parent says nothing about what is inside a subfolder, so one that was
    // already loaded keeps the children it had.
    const children =
      node.is_dir && !node.children && existing?.is_dir && existing.children
        ? existing.children
        : node.children;
    const merged = children === node.children ? node : { ...node, children };
    return existing && sameEntry(existing, merged) ? existing : merged;
  });
}

export function setChildren(tree: FileNode, dir: string, listed: FileNode[]): FileNode {
  if (tree.path === dir) {
    const children = mergeChildren(tree.children, listed);
    // Unchanged all the way down: hand back the same tree, so nothing above re-renders
    // either. A refresh that finds nothing new then costs nothing to apply.
    return sameNodes(tree.children, children) ? tree : { ...tree, children };
  }
  if (!tree.children || !isWithin(dir, tree.path)) return tree;
  const children = tree.children.map((child) =>
    isWithin(dir, child.path) ? setChildren(child, dir, listed) : child,
  );
  return sameNodes(tree.children, children) ? tree : { ...tree, children };
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
