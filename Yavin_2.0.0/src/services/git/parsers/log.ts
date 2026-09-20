export interface CommitFileChange {
  /** Repo-relative path exactly as Git reports it (the new path for a rename). */
  path: string;
  /** For a rename, the path the file had in the commit's first parent. */
  oldPath?: string;
  status: string; // 'A' | 'M' | 'D' | 'R' | 'B' (best-effort: numstat has no status letter)
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
 * Parses `git show --numstat -z -M --pretty=format:%H\x1f%s <hash>`.
 *
 * `-z` is what makes paths reliable. Without it Git C-quotes unusual names
 * (`"caf\303\251.txt"`) and prints renames as `old => new` or `dir/{a => b}/f`, none of
 * which can be handed back to Git as a pathspec. With `-z` the header line ends at the
 * first newline and every file is a NUL-terminated record: `added<TAB>deleted<TAB>path`,
 * or for a rename `added<TAB>deleted<TAB>` then NUL, the old path, NUL, the new path.
 */
export function parseCommitDetails(output: string): CommitDetailedInfo {
  const newline = output.indexOf("\n");
  const header = newline === -1 ? output : output.slice(0, newline);
  const body = newline === -1 ? "" : output.slice(newline + 1);
  const headerSep = header.indexOf("\x1f");
  const hash = headerSep === -1 ? header : header.slice(0, headerSep);
  const summary = headerSep === -1 ? "" : header.slice(headerSep + 1);

  let insertions = 0;
  let deletions = 0;
  const files: CommitFileChange[] = [];

  const fields = body.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const record = fields[i];
    // Only the first two tabs are column separators: a path may itself contain tabs.
    const first = record.indexOf("\t");
    const second = first === -1 ? -1 : record.indexOf("\t", first + 1);
    if (second === -1) continue;
    const addedRaw = record.slice(0, first);
    const deletedRaw = record.slice(first + 1, second);
    let path = record.slice(second + 1);
    let oldPath: string | undefined;
    if (path === "") {
      oldPath = fields[++i];
      path = fields[++i];
      if (oldPath === undefined || path === undefined) break;
    }
    const binary = addedRaw === "-" || deletedRaw === "-";
    const added = binary ? 0 : parseInt(addedRaw, 10) || 0;
    const deleted = binary ? 0 : parseInt(deletedRaw, 10) || 0;
    insertions += added;
    deletions += deleted;
    files.push({
      path,
      ...(oldPath === undefined ? {} : { oldPath }),
      status: binary
        ? "B"
        : oldPath !== undefined
          ? "R"
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
