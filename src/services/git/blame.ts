/**
 * Inline Git blame (WS9): parse `git blame --porcelain` into per-line commit annotations, and a
 * small, correctly-invalidated cache so moving the cursor between lines never re-runs Git. Pure —
 * no process, DOM or native access; the `Repository.blame` call supplies the porcelain text and the
 * editor binding (`blameMonaco.ts`) draws it. Blame is **read-only** and workspace-confined (the
 * native allow-list pins `blame --porcelain -- <path>` to a single repo-relative path).
 */

export interface BlameCommit {
  /** The 40-hex commit sha; all-zero for a line not yet committed. */
  readonly sha: string;
  readonly author: string;
  /** Author email without the surrounding `<>`. */
  readonly authorMail: string;
  /** Author time, epoch **seconds** (as Git reports it). */
  readonly authorTime: number;
  readonly summary: string;
}

export interface BlameLine extends BlameCommit {
  /** The line's number in the current (final) file, 1-based. */
  readonly line: number;
  /** True when the line is not committed (Git's all-zero sha) — a new/edited line on disk. */
  readonly uncommitted: boolean;
}

const ZERO_SHA = "0".repeat(40);

/**
 * Parse `git blame --porcelain` output. Each line group starts with a header
 * `<sha> <origLine> <finalLine> [<groupSize>]`; the first time a sha appears it is followed by its
 * `author`/`author-mail`/`author-time`/`summary` metadata (cached for the sha's later groups), and
 * every source line is the `\t`-prefixed content line. Lines are returned sorted by final line.
 */
export function parseBlamePorcelain(output: string): BlameLine[] {
  const commits = new Map<
    string,
    { author: string; authorMail: string; authorTime: number; summary: string }
  >();
  const lines: BlameLine[] = [];
  let sha = "";
  let final = 0;
  for (const raw of output.split("\n")) {
    const header = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/.exec(raw);
    if (header) {
      sha = header[1]!;
      final = Number(header[2]);
      if (!commits.has(sha))
        commits.set(sha, { author: "", authorMail: "", authorTime: 0, summary: "" });
      continue;
    }
    if (!sha) continue;
    const commit = commits.get(sha)!;
    if (raw.startsWith("author ")) commit.author = raw.slice("author ".length);
    else if (raw.startsWith("author-mail "))
      commit.authorMail = raw.slice("author-mail ".length).replace(/^<|>$/g, "");
    else if (raw.startsWith("author-time "))
      commit.authorTime = Number(raw.slice("author-time ".length)) || 0;
    else if (raw.startsWith("summary ")) commit.summary = raw.slice("summary ".length);
    else if (raw.startsWith("\t")) {
      lines.push({
        line: final,
        sha,
        author: commit.author,
        authorMail: commit.authorMail,
        authorTime: commit.authorTime,
        summary: commit.summary,
        uncommitted: sha === ZERO_SHA,
      });
    }
  }
  lines.sort((a, b) => a.line - b.line);
  return lines;
}

/** A compact "n units ago", matching Git's own `--date=relative` feel (no external dependency). */
export function relativeTime(epochMs: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - epochMs) / 1000));
  const units: [string, number][] = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["week", 604_800],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  for (const [name, secs] of units) {
    const n = Math.floor(seconds / secs);
    if (n >= 1) return `${n} ${name}${n > 1 ? "s" : ""} ago`;
  }
  return "just now";
}

/** The one-line annotation shown after the current line: author · when · summary. */
export function describeBlameLine(line: BlameLine | undefined, now: number = Date.now()): string {
  if (!line || line.uncommitted || line.sha === ZERO_SHA) return "You · Uncommitted changes";
  const when = line.authorTime ? relativeTime(line.authorTime * 1000, now) : "";
  return (
    [line.author, when].filter(Boolean).join(", ") + (line.summary ? ` • ${line.summary}` : "")
  );
}

/**
 * A per-file blame cache keyed by an opaque **token** (see {@link blameToken}) that folds in the
 * repo revision and the document version: a cursor move reuses the cached blame, while a commit,
 * HEAD move or edit changes the token and triggers one refetch. A failed fetch is not cached, so a
 * transient error is retried rather than remembered. Bounded (LRU) so a long session can't grow it
 * without limit.
 */
export interface BlameCache {
  get(path: string, token: string): Promise<BlameLine[]>;
  invalidate(path?: string): void;
  size(): number;
}

export function createBlameCache(
  fetch: (path: string) => Promise<string>,
  options: { max?: number } = {},
): BlameCache {
  const max = options.max ?? 64;
  const cache = new Map<string, { token: string; lines: Promise<BlameLine[]> }>();
  return {
    get(path, token) {
      const hit = cache.get(path);
      if (hit && hit.token === token) {
        cache.delete(path); // refresh LRU recency
        cache.set(path, hit);
        return hit.lines;
      }
      const lines = fetch(path).then(parseBlamePorcelain);
      // Don't poison the cache with a rejected promise — drop it so the next look-up retries.
      void lines.catch(() => {
        if (cache.get(path)?.lines === lines) cache.delete(path);
      });
      cache.set(path, { token, lines });
      while (cache.size > max) {
        const oldest = cache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
      return lines;
    },
    invalidate(path) {
      if (path) cache.delete(path);
      else cache.clear();
    },
    size: () => cache.size,
  };
}

/** The cache token for a file: its git revision and document version. A change in either (a commit,
 * HEAD move, save or edit) produces a new token and so a fresh blame. */
export const blameToken = (gitRevision: number, docVersion: number): string =>
  `${gitRevision}:${docVersion}`;

/** O(1) current-line lookup over a sorted blame list. */
export function blameAt(lines: readonly BlameLine[], line: number): BlameLine | undefined {
  // Lines are 1-based and (usually) contiguous from 1; a direct index is the common fast path.
  const guess = lines[line - 1];
  if (guess && guess.line === line) return guess;
  return lines.find((l) => l.line === line);
}
