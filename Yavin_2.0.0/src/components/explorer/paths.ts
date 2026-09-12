/**
 * Strips Windows extended-length prefixes (`\?\`, `//?/`, `\??\`) and normalizes separators.
 * The backend already returns clean paths, so the common case exits without allocating.
 */
export function cleanPath(path: string): string {
  if (!path) return "";
  if (!path.includes("\\") && !path.startsWith("//?/") && !path.startsWith("/??/")) return path;
  const slashed = path.split("\\").join("/");
  if (slashed.startsWith("//?/UNC/")) return "//" + slashed.slice(8);
  if (slashed.startsWith("//?/") || slashed.startsWith("/??/")) return slashed.slice(4);
  return slashed;
}

/** Path relative to the workspace root, or the absolute path when it lies outside. */
export function getRelativePath(fullPath: string, workspacePath: string): string {
  if (!fullPath) return "";
  const full = cleanPath(fullPath);
  const root = cleanPath(workspacePath);
  if (!root || (full !== root && !full.startsWith(root + "/"))) return full;
  return full.slice(root.length).replace(/^\//, "") || ".";
}

/** The directory a node lives in: itself for a folder, its parent for a file. */
export function containingDir(path: string, isDir: boolean): string {
  const clean = cleanPath(path);
  return isDir ? clean : clean.slice(0, clean.lastIndexOf("/"));
}
