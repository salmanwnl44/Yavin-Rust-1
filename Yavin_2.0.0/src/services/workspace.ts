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
