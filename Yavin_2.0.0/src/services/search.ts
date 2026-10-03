import { native } from "./native.ts";
import type { SearchOptions, ToolOutput } from "./native";
import { fileUri, resourceId } from "./resource.ts";

export interface SearchHit {
  path: string;
  line: number;
  text: string;
  start: number;
  end: number;
}
export interface SearchResult {
  hits: SearchHit[];
  warning: string;
  /** Some results are missing, for any of the reasons below. */
  truncated: boolean;
  /**
   * Why the list stopped short, if it did: `hits`, the first `MAX_HITS` are shown; `output`,
   * ripgrep's output passed what is read (very long lines, very many matches).
   */
  limit?: "hits" | "output" | null;
  /** Some files could not be searched (locked, unreadable); the rest were. */
  unreadable?: boolean;
}

/** How many matches a search lists. */
export const MAX_HITS = 10000;

export const EMPTY_RESULT: SearchResult = { hits: [], warning: "", truncated: false };

/**
 * One identity per file, as the rest of Yavin compares them (`resource.ts`): ripgrep spells a
 * path one way, the editor's document may be keyed by another spelling of the same file.
 */
function fileKey(path: string): string {
  try {
    return resourceId(fileUri(path));
  } catch {
    return path;
  }
}

/** The status line for a finished search: how many, and -- exactly -- why any are missing. */
export function describeSearchResult(result: SearchResult): string {
  if (!result.hits.length)
    return result.unreadable
      ? "No matches found in the files that could be searched"
      : result.limit === "output"
        ? "No matches found before the search output limit"
        : "No matches found";
  const files = new Set(result.hits.map((hit) => fileKey(hit.path))).size;
  const notes = [
    result.limit === "hits" ? `first ${MAX_HITS.toLocaleString("en-US")} shown` : "",
    result.limit === "output" ? "output limit reached; results incomplete" : "",
    result.unreadable ? "some files could not be searched" : "",
  ].filter(Boolean);
  return `${result.hits.length} matches in ${files} files${notes.length ? ` (${notes.join("; ")})` : ""}`;
}
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

/** Joins a ripgrep path (relative to `folder`) onto the folder with forward slashes. */
export function joinSearchPath(folder: string, relative: string): string {
  return `${folder.replace(/\/$/, "")}/${relative.replace(/\\/g, "/").replace(/^\.\//, "")}`;
}

export function parseFileList(
  output: ToolOutput,
  folder: string,
): { files: string[]; truncated: boolean } {
  if (output.code > 1 && !output.stdout)
    throw new Error(output.stderr || "Cannot list workspace files");
  const names = output.stdout.split("\0").filter(Boolean);
  if (output.truncated) names.pop(); // The last name may be cut off.
  return {
    files: names.map((name) => joinSearchPath(folder, name)).sort(),
    truncated: output.truncated || output.code > 1,
  };
}

/** Every workspace file for quick open: full depth, .gitignore aware, dotfiles included. */
export async function listFiles(workspace: string) {
  const output = await native("search_project", {
    workspace,
    id: crypto.randomUUID(),
    options: {
      query: "",
      caseSensitive: false,
      wholeWord: false,
      regex: false,
      hidden: true,
      ignored: false,
      include: [],
      exclude: [],
      folder: workspace,
      buffer: null,
      filesOnly: true,
    },
  });
  return parseFileList(output, workspace);
}

export function byteToColumn(text: string, byte: number): number {
  return decoder.decode(encoder.encode(text).slice(0, byte)).length;
}
export function parseSearch(output: ToolOutput, folder: string, bufferPath?: string): SearchResult {
  const hits: SearchHit[] = [];
  let skipped = 0;
  let completed = false;
  for (const record of output.stdout.split("\n")) {
    if (!record.trim()) continue;
    let event;
    try {
      event = JSON.parse(record);
    } catch {
      if (output.truncated) break;
      throw new Error("Invalid search output");
    }
    if (event.type === "summary") completed = true;
    if (event.type === "end" && event.data.binary_offset != null) skipped++;
    if (event.type !== "match") continue;
    const data = event.data;
    if (
      typeof data.lines?.text !== "string" ||
      (!bufferPath && typeof data.path?.text !== "string")
    ) {
      skipped++;
      continue;
    }
    const text: string = data.lines.text;
    const path = bufferPath ?? joinSearchPath(folder, data.path.text);
    for (const match of data.submatches) {
      hits.push({
        path,
        line: data.line_number,
        text,
        start: byteToColumn(text, match.start),
        end: byteToColumn(text, match.end),
      });
    }
  }
  // Exit code 2 with a summary means some paths failed (e.g. locked files); without one, rg stopped early.
  if (output.code > 1 && !completed && !output.truncated)
    throw new Error(output.stderr || "Search failed");
  return {
    hits,
    truncated: output.truncated || output.code > 1,
    limit: output.truncated ? "output" : null,
    unreadable: output.code > 1,
    warning: [
      output.stderr.trim(),
      skipped ? `${skipped} binary or unsupported records skipped.` : "",
    ]
      .filter(Boolean)
      .join(" "),
  };
}

/** How many unsaved buffers are searched at once (each is a ripgrep process). */
const BUFFER_SEARCHES = 4;

/**
 * Searches the workspace (`openOnly`: only the open documents), with every open document that
 * differs from its file searched as the editor holds it.
 *
 * - `buffers`: the open documents' text, by path (`DocumentService.buffers`).
 * - `modified`: which of them differ from the disk (unsaved edits). Only those need their own
 *   text searched -- a clean document's file says the same, so its disk results stand -- unless
 *   `openOnly`, which searches every open document. Without it, every buffer counts as modified.
 *
 * Files are matched by resource identity, so a document opened under another spelling of its
 * path still replaces its file's results.
 */
export async function searchWorkspace(
  workspace: string,
  options: SearchOptions,
  buffers: Record<string, string>,
  openOnly: boolean,
  signal: AbortSignal,
  modified: (path: string) => boolean = () => true,
): Promise<SearchResult> {
  const call = async (request: SearchOptions) => {
    if (signal.aborted) throw new Error("Cancelled");
    const id = crypto.randomUUID();
    const cancel = () => {
      void native("cancel_search", { id }).catch(() => {});
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const result = await native("search_project", { workspace, id, options: request });
      if (signal.aborted) throw new Error("Cancelled");
      return result;
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  };
  const paths = Object.keys(buffers).filter((path) => openOnly || modified(path));
  // The scope's own search and, when buffers are searched, its file list (which of them are
  // in scope -- folder, globs, ignore rules) run side by side.
  const [disk, listed] = await Promise.all([
    openOnly ? null : call(options),
    paths.length ? call({ ...options, filesOnly: true }) : null,
  ]);
  let result: SearchResult = disk
    ? parseSearch(disk, options.folder)
    : { ...EMPTY_RESULT, limit: null, unreadable: false };
  if (listed) {
    if (listed.truncated || (listed.code > 1 && !listed.stdout))
      throw new Error(listed.stderr || "File list is incomplete; narrow search scope");
    if (listed.code > 1) {
      result.truncated = true;
      result.unreadable = true;
    }
    const allowed = new Set(
      listed.stdout
        .split("\0")
        .filter(Boolean)
        .map((p) => fileKey(joinSearchPath(options.folder, p))),
    );
    const searched = new Set(paths.map(fileKey));
    result.hits = result.hits.filter((hit) => !searched.has(fileKey(hit.path)));
    const inScope = paths.filter((path) => allowed.has(fileKey(path)));
    for (let at = 0; at < inScope.length; at += BUFFER_SEARCHES) {
      const batch = inScope.slice(at, at + BUFFER_SEARCHES);
      const overlays = await Promise.all(
        batch.map(async (path) =>
          parseSearch(
            await call({ ...options, include: [], exclude: [], buffer: buffers[path] }),
            options.folder,
            path,
          ),
        ),
      );
      for (const overlay of overlays) {
        result.hits.push(...overlay.hits);
        result.warning = [result.warning, overlay.warning].filter(Boolean).join(" ");
        result.truncated ||= overlay.truncated;
        if (overlay.limit) result.limit = overlay.limit;
      }
    }
  }
  result.hits.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.start - b.start);
  if (result.hits.length > MAX_HITS) {
    result.hits.length = MAX_HITS;
    result.truncated = true;
    // Cut here, unless ripgrep's output limit already cut it short (that one says more).
    if (result.limit !== "output") result.limit = "hits";
  }
  return result;
}

/**
 * A search result's line as it reads without its line ending: ripgrep reports a line from disk
 * with its own ending (`\n` or `\r\n`), the editor holds documents with `\n` only, and a CRLF
 * file's text read from disk keeps the `\r` on each line. The same line, however it ended.
 */
function lineBody(text: string): string {
  return text.replace(/\n$/, "").replace(/\r$/, "");
}

/**
 * Where a hit is in a document's text (always `\n` line endings), or null when that line no
 * longer reads as it did. A hit found on disk in a CRLF file carries its `\r\n`.
 */
export function hitOffset(content: string, hit: SearchHit): number | null {
  const lines = content.split("\n");
  const line = lines[hit.line - 1];
  if (line === undefined || lineBody(line) !== lineBody(hit.text)) return null;
  return lines.slice(0, hit.line - 1).reduce((n, line) => n + line.length + 1, 0) + hit.start;
}

export function replaceHits(content: string, hits: SearchHit[], replacement: string): string {
  const lines = content.split("\n");
  const offsets = [0];
  for (let i = 0; i < lines.length - 1; i++) offsets.push(offsets[i] + lines[i].length + 1);
  const ranges = hits
    .map((hit) => {
      const line = lines[hit.line - 1];
      // The line must read as it did when it was found -- its ending aside: a CRLF file's
      // results replace in its open (LF) document, and in its own CRLF text on disk.
      if (line === undefined || lineBody(line) !== lineBody(hit.text))
        throw new Error("Search results are stale. Search again before replacing.");
      return { start: offsets[hit.line - 1] + hit.start, end: offsets[hit.line - 1] + hit.end };
    })
    .sort((a, b) => b.start - a.start);
  let previous = content.length + 1;
  for (const range of ranges) {
    if (range.end > previous) throw new Error("Overlapping search matches");
    content = content.slice(0, range.start) + replacement + content.slice(range.end);
    previous = range.start;
  }
  return content;
}
