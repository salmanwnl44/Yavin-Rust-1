/**
 * The terminal as an IDE subsystem (TERMINAL-06): how the Explorer, the editor, Git and the
 * commands meet the workspace's terminals, without any of them owning another's state.
 *
 * ```text
 * Explorer / editor ──(a resource)──> terminalCwdFor / editorTerminalCwd ──> TerminalUi.openIn
 * focused terminal ──(view.shell, T05A)──> revealableFolder ──> ExplorerStore.reveal
 * terminal output ──(a clicked line)──> findPathLinks -> resolvePathLink ──> the editor's open
 * TerminalService ──(a command finished, T05A)──> watchFinishedCommands ──> Git's refresh
 * ```
 *
 * Everything here is pure: paths go through `resource.ts` (never assembled from strings), and
 * terminal output -- untrusted -- only ever becomes a candidate that must resolve, inside the
 * workspace, before anything is opened, and then only on the user's click.
 */
import { containsPath, dirname, fileUri, fsPath } from "./resource.ts";
import { msysDrivePath, type TerminalShellState } from "./terminalShell.ts";
import type { TerminalService } from "./terminalService.ts";

// --- Explorer and editor -> terminal ------------------------------------------------------------

/**
 * Where a terminal opened "here" starts: a folder is itself, a file is the folder holding it.
 * `null` when the path cannot be read as a resource.
 */
export function terminalCwdFor(target: { path: string; isDir: boolean }): string | null {
  try {
    const uri = fileUri(target.path);
    return fsPath(target.isDir ? uri : dirname(uri));
  } catch {
    return null;
  }
}

/**
 * Where "Open Integrated Terminal Here" starts for the document in the editor: a file on disk
 * is in its folder. An untitled or proposed document has no folder of its own (a proposed
 * file's folder may not exist yet): the workspace root, or the native default without one.
 */
export function editorTerminalCwd(
  document: { source: { kind: string }; path: string | null } | undefined,
  root: string | null,
): string | null {
  if (document?.source.kind === "disk" && document.path)
    return terminalCwdFor({ path: document.path, isDir: false }) ?? root;
  return root;
}

// --- Terminal -> Explorer -----------------------------------------------------------------------

export type RevealFolder = { ok: true; path: string } | { ok: false; reason: string };

/**
 * The folder "Reveal Current Folder in Explorer" shows: the one the shell itself reported
 * (OSC 7), when it is local and inside the workspace. Never the folder the terminal started in
 * -- the shell may have left it, and saying so would be a guess -- and never a remote or
 * unmapped one made local.
 */
export function revealableFolder(
  shell: TerminalShellState,
  folders: readonly string[],
): RevealFolder {
  const reported = shell.reported;
  if (!reported)
    return {
      ok: false,
      reason:
        shell.integration === "active"
          ? "The terminal's shell has not reported its folder yet."
          : "The terminal's shell does not report its folder (shell integration, OSC 7, is not set up in it).",
    };
  if (reported.kind === "remote")
    return {
      ok: false,
      reason: `The terminal's folder is on another machine (${reported.host}), not in this workspace.`,
    };
  if (reported.kind === "unmapped")
    return { ok: false, reason: "The terminal's folder has no Windows path Yavin can show." };
  if (!folders.some((folder) => containsPath(folder, reported.path)))
    return { ok: false, reason: `${reported.path} is outside the workspace.` };
  return { ok: true, path: reported.path };
}

// --- Terminal output -> editor ------------------------------------------------------------------

/** A path-looking piece of one line of terminal output: a candidate, not yet a resource. */
export interface PathLink {
  /** Offsets in the line, `end` exclusive. */
  start: number;
  end: number;
  /** The whole match, `:line:column` included. */
  text: string;
  /** The path as printed. */
  path: string;
  line?: number;
  column?: number;
}

/** Runs of text that may hold a path: broken at whitespace, quotes, brackets and the like. */
const RUN = /[^\s"'`<>|*?()[\]{},;]+/g;
/** `path`, `path:line`, `path:line:column`; the drive's own colon is part of the path. */
const SHAPE = /^((?:[A-Za-z]:[\\/])?[^:]+?)(?::(\d+)(?::(\d+))?)?$/;
/**
 * The last segment has an extension starting with a letter: a bare `src/components` is a
 * folder, or not a path, and `100/200.5` is arithmetic.
 */
const FILE = /(?:^|[\\/])[^\\/]*[^\\/.]\.[A-Za-z][A-Za-z0-9]{0,11}$/;

/**
 * The file paths in one line of output that are unambiguous enough to offer:
 * - absolute (`C:\work\a.ts`, `/home/me/a.ts`), or relative with a separator (`src/a.ts`,
 *   `./a.ts`, `../lib/a.rs`) -- a bare `a.ts` could be anything and is left alone;
 * - naming a file (with an extension);
 * - optionally `:line` or `:line:column` right after, nothing else (`(12,5)`, `line 12` and
 *   other compilers' forms are not read: that is a diagnostics parser, not this);
 * - never a URL (the web-link addon has those) or a UNC path (opening one from output could
 *   reach a remote host).
 */
export function findPathLinks(line: string): PathLink[] {
  const links: PathLink[] = [];
  for (const run of line.matchAll(RUN)) {
    // Sentence punctuation after a path is not part of it.
    const text = run[0].replace(/[.:]+$/, "");
    if (!text || text.includes("://") || /^(\\\\|\/\/)/.test(text)) continue;
    const shape = SHAPE.exec(text);
    if (!shape) continue;
    const [, path, line, column] = shape;
    const absolute = /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("/");
    const relative = /^\.{1,2}[\\/]/.test(path) || /[\\/]/.test(path);
    if (!absolute && !relative) continue;
    if (!FILE.test(path)) continue;
    const start = run.index;
    links.push({
      start,
      end: start + text.length,
      text,
      path,
      ...(line ? { line: Number(line) } : {}),
      ...(column ? { column: Number(column) } : {}),
    });
  }
  return links;
}

/**
 * The workspace file a link names, or `null`: resolved with the resource rules (a relative
 * path against the terminal's folder, MSYS spellings mapped), and only inside one of the
 * workspace's folders. Whether the file exists is for the open to find out.
 */
export function resolvePathLink(
  link: PathLink,
  options: {
    /** The terminal's folder (`terminalFolder`): what a relative path is relative to. */
    base: string | null;
    folders: readonly string[];
    /** The shell writes MSYS paths (Git Bash): `/c/x` is `C:/x`. */
    msys?: boolean;
  },
): { path: string; line?: number; column?: number } | null {
  let printed = link.path;
  if (options.msys && printed.startsWith("/")) {
    const mapped = msysDrivePath(printed);
    if (!mapped) return null;
    printed = mapped;
  }
  const absolute = /^[A-Za-z]:[\\/]/.test(printed) || printed.startsWith("/");
  let path: string;
  try {
    if (absolute) path = fsPath(fileUri(printed));
    else if (options.base) path = fsPath(fileUri(printed, fileUri(options.base)));
    else return null;
  } catch {
    return null;
  }
  if (!options.folders.some((folder) => containsPath(folder, path))) return null;
  if ((link.line !== undefined && link.line < 1) || (link.column !== undefined && link.column < 1))
    return null;
  return {
    path,
    ...(link.line !== undefined ? { line: link.line } : {}),
    ...(link.column !== undefined ? { column: link.column } : {}),
  };
}

// --- Terminal -> Git ----------------------------------------------------------------------------

/**
 * Calls `finished` when a command run in one of the service's terminals finishes (OSC 133,
 * T05A): the moment files or the repository may have changed in ways the watcher does not
 * report (Git's own files). Once per change of the service's state, never per output chunk; a
 * shell without integration never calls it, and the watcher still covers the files.
 */
export function watchFinishedCommands(
  service: Pick<TerminalService, "getSnapshot" | "subscribe">,
  finished: () => void,
): () => void {
  const seen = new Map<string, number>();
  const read = () => {
    let any = false;
    const present = new Set<string>();
    for (const session of service.getSnapshot().sessions) {
      present.add(session.sessionId);
      const last = session.shell.last?.id ?? 0;
      const before = seen.get(session.sessionId);
      if (before !== undefined && last > before) any = true;
      seen.set(session.sessionId, last);
    }
    for (const id of [...seen.keys()]) if (!present.has(id)) seen.delete(id);
    return any;
  };
  read();
  return service.subscribe(() => {
    if (read()) finished();
  });
}
