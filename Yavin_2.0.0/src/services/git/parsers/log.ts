export interface CommitFileChange {
  path: string;
  status: string; // 'A' | 'M' | 'D' | 'B' (best-effort: numstat has no rename/copy letter)
  insertions?: number;
  deletions?: number;
  binary: boolean;
}

export interface CommitDetailedInfo {
  hash: string;
  summary: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: CommitFileChange[];
}

/**
 * Parses `git show --numstat --pretty=format:%H\x1f%s <hash>` -- machine-readable
 * tab-separated per-file line counts, replacing an earlier version that scraped
 * `--stat`'s human-formatted text with regexes (fragile, and never actually matched
 * binary-file lines -- see the `--stat`-era test that caught it).
 */
export function parseCommitDetails(output: string): CommitDetailedInfo {
  const lines = output.split("\n");
  const headerSep = (lines[0] ?? "").indexOf("\x1f");
  const hash = headerSep === -1 ? (lines[0] ?? "") : lines[0].slice(0, headerSep);
  const summary = headerSep === -1 ? "" : lines[0].slice(headerSep + 1);

  let insertions = 0;
  let deletions = 0;
  const files: CommitFileChange[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const [addedRaw, deletedRaw, path] = line.split("\t");
    if (path === undefined) continue;
    const binary = addedRaw === "-" || deletedRaw === "-";
    const added = binary ? 0 : parseInt(addedRaw, 10) || 0;
    const deleted = binary ? 0 : parseInt(deletedRaw, 10) || 0;
    insertions += added;
    deletions += deleted;
    files.push({
      path,
      status: binary
        ? "B"
        : added > 0 && deleted === 0
          ? "A"
          : deleted > 0 && added === 0
            ? "D"
            : "M",
      insertions: binary ? undefined : added,
      deletions: binary ? undefined : deleted,
      binary,
    });
  }

  return { hash, summary, filesChanged: files.length, insertions, deletions, files };
}

export type RefKind = "head" | "branch" | "tag" | "remote";

export interface RefLabel {
  name: string;
  kind: RefKind;
}

/** Splits one `%D` decoration string (e.g. `"HEAD -> main, origin/main, tag: v1"`). */
export function parseRefLabels(decorations: string): RefLabel[] {
  if (!decorations.trim()) return [];
  const labels: RefLabel[] = [];
  for (const raw of decorations.split(",")) {
    const token = raw.trim();
    if (!token) continue;
    if (token.includes(" -> ")) {
      const [head, branch] = token.split(" -> ");
      labels.push({ name: head.trim(), kind: "head" });
      labels.push({ name: branch.trim(), kind: "branch" });
    } else if (token.startsWith("tag: ")) {
      labels.push({ name: token.slice(5).trim(), kind: "tag" });
    } else if (token === "HEAD") {
      labels.push({ name: token, kind: "head" });
    } else if (token.includes("/")) {
      labels.push({ name: token, kind: "remote" });
    } else {
      labels.push({ name: token, kind: "branch" });
    }
  }
  return labels;
}

export interface RawCommit {
  fullHash: string;
  hash: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  date: string;
  relativeTime: string;
  subject: string;
  refs: RefLabel[];
}

/**
 * Parses the graph's log format:
 * `%H\x1f%h\x1f%P\x1f%an\x1f%ae\x1f%ad\x1f%cr\x1f%s\x1f%D`. `%P` (full parent hashes,
 * space-separated) is what the lane-assignment algorithm in `graph/model.ts` needs;
 * `--parents` is deliberately not used since it injects fields outside the `\x1f`
 * scheme instead of being controllable through the format string.
 */
export function parseGraphLog(output: string): RawCommit[] {
  if (!output.trim()) return [];
  const commits: RawCommit[] = [];
  for (const line of output.split("\n")) {
    if (!line) continue;
    const parts = line.split("\x1f");
    if (parts.length < 8) continue;
    const [fullHash, hash, parents, authorName, authorEmail, date, relativeTime, subject, refs] =
      parts;
    commits.push({
      fullHash,
      hash,
      parents: parents.trim() ? parents.trim().split(/\s+/) : [],
      authorName,
      authorEmail,
      date,
      relativeTime,
      subject,
      refs: parseRefLabels(refs ?? ""),
    });
  }
  return commits;
}
