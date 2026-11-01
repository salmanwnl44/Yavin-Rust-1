/**
 * Where a diagnostic is (IDE-01): every diagnostic in the Problems store names its file the
 * way the rest of Yavin does -- one resource, one identity -- whichever tool reported it.
 *
 * Language servers already report absolute paths (from their `file:` URIs). A checker prints
 * paths as it pleases: relative to the folder it ran in (`tsc`, `cargo`, `ruff`), absolute
 * (`eslint`), with either separator. Before a checker's diagnostics are published they are
 * resolved here, against the folder the checker actually ran in, with the workspace's own
 * resource rules (`resource.ts`) -- never by gluing strings into a URI. A path that resolves
 * outside that folder is not one of the workspace's files and is not published.
 *
 * The store keeps the canonical path (`fsPath`) as text; anything that compares files -- the
 * editor's markers, grouping, the current-file filter -- compares `problemResourceId`, so
 * `C:\a\b.ts`, `c:/a/b.ts`, `\\?\C:\a\b.ts` and `file:///C:/a/b.ts` are one file.
 */
import {
  fileUri,
  fsPath,
  parseUri,
  resolveWithin,
  resourceId,
  type ResourceId,
  type ResourceUri,
} from "../resource.ts";
import type { Diagnostic } from "./problemMatchers.ts";

/** The resource an absolute path or `file:` URI names; `null` for anything else. */
export function problemResource(file: string): ResourceUri | null {
  try {
    if (/^file:/i.test(file)) return parseUri(file);
    return fileUri(file);
  } catch {
    // Relative (no base to resolve against here) or not a path at all.
    return null;
  }
}

/** The identity to compare a diagnostic's file by; `null` when it names no local file. */
export function problemResourceId(file: string): ResourceId | null {
  const uri = problemResource(file);
  return uri ? resourceId(uri) : null;
}

/**
 * A path a checker printed, as the canonical path of the workspace file it means: relative
 * paths against `root` (the folder it ran in), absolute paths and `file:` URIs as they are.
 * `null` when it is not inside `root`.
 */
export function resolveCheckerPath(file: string, root: string): string | null {
  const printed = file.trim();
  if (!printed) return null;
  try {
    const folder = fileUri(root);
    const path = /^file:/i.test(printed) ? fsPath(parseUri(printed)) : printed;
    return fsPath(resolveWithin(folder, path));
  } catch {
    return null;
  }
}

/**
 * A checker's diagnostics with every file resolved (`resolveCheckerPath`), and how many named
 * no file of the workspace -- those are left out rather than shown under a path nothing else
 * would recognise.
 */
export function resolveCheckerDiagnostics(
  diagnostics: readonly Diagnostic[],
  root: string,
): { diagnostics: Diagnostic[]; outside: number } {
  const resolved: Diagnostic[] = [];
  let outside = 0;
  for (const diagnostic of diagnostics) {
    const file = resolveCheckerPath(diagnostic.file, root);
    if (!file) {
      outside += 1;
      continue;
    }
    resolved.push({
      ...diagnostic,
      file,
      ...(diagnostic.related
        ? {
            related: diagnostic.related.flatMap((related) => {
              const at = resolveCheckerPath(related.file, root);
              return at ? [{ ...related, file: at }] : [];
            }),
          }
        : {}),
    });
  }
  return { diagnostics: resolved, outside };
}

/**
 * A task's diagnostics (IDE-04): printed paths resolved against the folder the task ran in,
 * and published only when they name a file inside one of the workspace's folders (a task may
 * run in a subfolder and report `../lib/a.ts`). Same resource rules as a checker's.
 */
export function resolveTaskDiagnostics(
  diagnostics: readonly Diagnostic[],
  cwd: string,
  folders: readonly string[],
): { diagnostics: Diagnostic[]; outside: number } {
  const inside = (path: string) =>
    folders.some((folder) => {
      try {
        resolveWithin(fileUri(folder), path);
        return true;
      } catch {
        return false;
      }
    });
  const resolve = (file: string): string | null => {
    const printed = file.trim();
    if (!printed) return null;
    try {
      const uri = /^file:/i.test(printed) ? parseUri(printed) : fileUri(printed, fileUri(cwd));
      const path = fsPath(uri);
      return inside(path) ? path : null;
    } catch {
      return null;
    }
  };
  const resolved: Diagnostic[] = [];
  let outside = 0;
  for (const diagnostic of diagnostics) {
    const file = resolve(diagnostic.file);
    if (!file) {
      outside += 1;
      continue;
    }
    resolved.push({
      ...diagnostic,
      file,
      ...(diagnostic.related
        ? {
            related: diagnostic.related.flatMap((related) => {
              const at = resolve(related.file);
              return at ? [{ ...related, file: at }] : [];
            }),
          }
        : {}),
    });
  }
  return { diagnostics: resolved, outside };
}
