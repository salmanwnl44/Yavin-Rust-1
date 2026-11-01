/**
 * A single `@@ ... @@` hunk from a unified diff, kept as raw lines (each still
 * prefixed with its leading ' '/'+'/'-'/'\' marker) so it can be fed back to
 * `git apply` byte-for-byte unchanged -- see `buildPatch`.
 */
export interface DiffHunk {
  header: string;
  lines: string[];
  additions: number;
  deletions: number;
}

export interface ParsedDiff {
  /** `diff --git`/`index`/`---`/`+++` lines that precede the first hunk. */
  headerLines: string[];
  hunks: DiffHunk[];
}

/**
 * Splits one file's unified diff (as returned by `git diff -- <file>`) into its
 * leading header block and each `@@ ... @@` hunk. Pure and lossless: re-joining
 * every hunk's header + lines reproduces the hunk's original text exactly, which is
 * what lets `buildPatch` construct a valid sub-patch from a chosen subset.
 */
export function parseUnifiedDiff(text: string): ParsedDiff {
  const lines = text.split("\n");
  const headerLines: string[] = [];
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      if (current) hunks.push(current);
      current = { header: line, lines: [], additions: 0, deletions: 0 };
      continue;
    }
    if (!current) {
      headerLines.push(line);
      continue;
    }
    current.lines.push(line);
    if (line.startsWith("+") && !line.startsWith("+++")) current.additions++;
    else if (line.startsWith("-") && !line.startsWith("---")) current.deletions++;
  }
  if (current) hunks.push(current);

  return { headerLines, hunks };
}

/**
 * Rebuilds a valid patch containing only the selected hunks (by index into
 * `parsed.hunks`), keeping every other hunk's header/lines untouched. This mirrors
 * how `git add -p`/`git checkout -p` themselves select hunks: each hunk's own
 * `@@ -a,b +c,d @@` line already describes its position self-sufficiently, and `git
 * apply` locates it via context lines, so omitting other hunks needs no rewriting.
 */
export function buildPatch(parsed: ParsedDiff, selected: ReadonlySet<number>): string {
  if (selected.size === 0) return "";
  const parts = [...parsed.headerLines];
  parsed.hunks.forEach((hunk, index) => {
    if (!selected.has(index)) return;
    parts.push(hunk.header, ...hunk.lines);
  });
  // `parseUnifiedDiff` kept the trailing "" element `split("\n")` leaves for a
  // string ending in a newline, so `join` alone reconstructs the original text
  // exactly *when the last hunk is selected*. When it isn't, that trailing marker
  // is missing and the patch would end without a newline -- which `git apply`
  // rejects outright as corrupt. Always ensure exactly one trailing newline.
  const body = parts.join("\n");
  return body.endsWith("\n") ? body : `${body}\n`;
}
