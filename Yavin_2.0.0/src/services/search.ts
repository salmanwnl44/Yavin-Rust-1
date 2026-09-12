import { native } from "./native.ts";
import type { SearchOptions, ToolOutput } from "./native";

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
  truncated: boolean;
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
    warning: [
      output.stderr.trim(),
      skipped ? `${skipped} binary or unsupported records skipped.` : "",
    ]
      .filter(Boolean)
      .join(" "),
  };
}

export async function searchWorkspace(
  workspace: string,
  options: SearchOptions,
  buffers: Record<string, string>,
  openOnly: boolean,
  signal: AbortSignal,
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
  let result: SearchResult = { hits: [], warning: "", truncated: false };
  if (!openOnly) result = parseSearch(await call(options), options.folder);
  const paths = Object.keys(buffers);
  if (paths.length) {
    const listed = await call({ ...options, filesOnly: true });
    if (listed.truncated || (listed.code > 1 && !listed.stdout))
      throw new Error(listed.stderr || "File list is incomplete; narrow search scope");
    if (listed.code > 1) result.truncated = true;
    const allowed = new Set(
      listed.stdout
        .split("\0")
        .filter(Boolean)
        .map((p) => joinSearchPath(options.folder, p)),
    );
    result.hits = result.hits.filter((hit) => buffers[hit.path] === undefined);
    for (const path of paths) {
      if (!allowed.has(path)) continue;
      const overlay = parseSearch(
        await call({ ...options, include: [], exclude: [], buffer: buffers[path] }),
        options.folder,
        path,
      );
      result.hits.push(...overlay.hits);
      result.warning = [result.warning, overlay.warning].filter(Boolean).join(" ");
      result.truncated ||= overlay.truncated;
    }
  }
  result.hits.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.start - b.start);
  if (result.hits.length > 10000) {
    result.hits.length = 10000;
    result.truncated = true;
  }
  return result;
}

export function replaceHits(content: string, hits: SearchHit[], replacement: string): string {
  const lines = content.split("\n");
  const offsets = [0];
  for (let i = 0; i < lines.length - 1; i++) offsets.push(offsets[i] + lines[i].length + 1);
  const ranges = hits
    .map((hit) => {
      const line = lines[hit.line - 1];
      if (line === undefined || line !== hit.text.replace(/\n$/, ""))
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
