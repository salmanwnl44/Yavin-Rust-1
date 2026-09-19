/** One token of a word-level diff between two lines. */
export interface WordSegment {
  type: "same" | "add" | "del";
  text: string;
}

export interface WordDiff {
  old: WordSegment[];
  new: WordSegment[];
}

/** Splits a line into words, runs of whitespace, and individual punctuation characters. */
function tokenize(line: string): string[] {
  return line.match(/[\p{L}\p{N}_]+|\s+|[^\s]/gu) ?? [];
}

/**
 * Token-level diff between a deleted and its replacement line, via the same longest
 * common subsequence approach `git diff --word-diff` uses. Kept as two aligned
 * segment lists -- one per line -- so the caller renders each side independently.
 */
export function diffWords(oldLine: string, newLine: string): WordDiff {
  const a = tokenize(oldLine);
  const b = tokenize(newLine);
  const n = a.length;
  const m = b.length;

  const lengths: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lengths[i][j] =
        a[i] === b[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }

  const old: WordSegment[] = [];
  const next: WordSegment[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      old.push({ type: "same", text: a[i] });
      next.push({ type: "same", text: b[j] });
      i++;
      j++;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      old.push({ type: "del", text: a[i] });
      i++;
    } else {
      next.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) old.push({ type: "del", text: a[i++] });
  while (j < m) next.push({ type: "add", text: b[j++] });

  return { old, new: next };
}
