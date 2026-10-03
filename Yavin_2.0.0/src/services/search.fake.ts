/**
 * A stand-in for the native search (`search_project`) over files held in memory, answering
 * as ripgrep does: `--json` records (`match` with byte offsets, `summary`), or `--files
 * --null` for a listing, relative to the folder searched, with Windows separators. Enough of
 * ripgrep for Yavin's own logic to be tested end to end -- parsing, the unsaved-buffer
 * overlay, limits, replacement -- in node and in the browser (it is self-contained, so a UI
 * test can ship its source into the page).
 *
 * Supported: literal or regex, case, whole word, include/exclude globs of the forms `*.ext`
 * and `dir/**`, a buffer on stdin. Not supported, and not needed by those tests: ignore
 * files, hidden files, binary detection -- the native tests check ripgrep for those.
 */
export interface FakeSearchRequest {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  include: string[];
  exclude: string[];
  folder: string;
  buffer: string | null;
  filesOnly: boolean;
}

export function fakeRipgrep(
  disk: Record<string, string>,
  options: FakeSearchRequest,
): { stdout: string; stderr: string; code: number; truncated: boolean } {
  const folder = options.folder.replace(/\/$/, "");
  const glob = (pattern: string, path: string) => {
    if (pattern.startsWith("*.")) return path.endsWith(pattern.slice(1));
    if (pattern.endsWith("/**")) return path.startsWith(`${pattern.slice(0, -3)}/`);
    return path === pattern;
  };
  // A Windows path is the same file whatever its case.
  const windows = /^[A-Za-z]:/.test(folder);
  const under = (path: string) =>
    windows
      ? path.toLowerCase().startsWith(`${folder.toLowerCase()}/`)
      : path.startsWith(`${folder}/`);
  const texts = new Map<string, string>();
  for (const [path, text] of Object.entries(disk))
    if (under(path)) texts.set(path.slice(folder.length + 1), text);
  const relative = [...texts.keys()]
    .filter((path) => !options.include.length || options.include.some((g) => glob(g, path)))
    .filter((path) => !options.exclude.some((g) => glob(g, path)))
    .sort();
  if (options.filesOnly)
    return {
      stdout: relative.map((path) => `.\\${path.replace(/\//g, "\\")}\0`).join(""),
      stderr: "",
      code: 0,
      truncated: false,
    };
  const escaped = options.regex
    ? options.query
    : options.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    options.wholeWord ? `\\b(?:${escaped})\\b` : escaped,
    options.caseSensitive ? "g" : "gi",
  );
  const encoder = new TextEncoder();
  const records: string[] = [];
  const scan = (text: string, path: { text: string } | undefined) => {
    const lines = text.split(/(?<=\n)/);
    lines.forEach((line, index) => {
      const submatches = [...line.replace(/\r?\n$/, "").matchAll(pattern)].map((match) => ({
        match: { text: match[0] },
        start: encoder.encode(line.slice(0, match.index)).length,
        end: encoder.encode(line.slice(0, match.index + match[0].length)).length,
      }));
      if (submatches.length)
        records.push(
          JSON.stringify({
            type: "match",
            data: {
              ...(path ? { path } : {}),
              lines: { text: line },
              line_number: index + 1,
              submatches,
            },
          }),
        );
    });
  };
  if (options.buffer !== null) scan(options.buffer, undefined);
  else
    for (const path of relative)
      scan(texts.get(path)!, { text: `.\\${path.replace(/\//g, "\\")}` });
  records.push(JSON.stringify({ type: "summary", data: {} }));
  return {
    stdout: `${records.join("\n")}\n`,
    stderr: "",
    code: records.length > 1 ? 0 : 1,
    truncated: false,
  };
}
