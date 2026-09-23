/**
 * Naming and comparing folders, on the UI side.
 *
 * Two spellings of the same folder reach Yavin all the time -- one typed with backslashes,
 * one handed back by a dialog -- and anything that remembers something per folder has to
 * treat those as one folder. The native side folds the same way (`src-tauri/src/paths.rs`),
 * so what the UI considers "the same folder" cannot drift from what the session file does.
 */

/** A comparison key for a folder: lowercased, `/` separators, no trailing separator. */
export function folderKey(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** The last segment, for naming a folder without showing its whole path. */
export function folderName(path: string | null | undefined): string {
  if (!path) return "";
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Everything above the last segment, shown next to the name so two "src"s can be told apart. */
export function parentPath(path: string | null | undefined): string {
  if (!path) return "";
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut > 0 ? trimmed.slice(0, cut) : "";
}
