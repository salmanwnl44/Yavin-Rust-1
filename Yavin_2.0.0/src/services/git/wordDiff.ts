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
 * The LCS table is (n+1)*(m+1) cells, so cost grows with the *product* of the two
 * lines' token counts: measured ~1 s and ~385 MB for one 8,000-character line, 3.7 s
 * and 1.5 GB at 16,000. A pair over this budget (~500 tokens per side, ~30 ms) is
 * reported as a wholly changed line instead of running the LCS.
 */
export const WORD_DIFF_MAX_CELLS = 250_000;

/** LCS table size a pair would need -- lets callers budget a whole diff up front. */
export function wordDiffCells(oldLine: string, newLine: string): number {
  return (tokenize(oldLine).length + 1) * (tokenize(newLine).length + 1);
}

/**
 * Token-level diff between a deleted and its replacement line, via the same longest
 * common subsequence approach `git diff --word-diff` uses. Kept as two aligned
 * segment lists -- one per line -- so the caller renders each side independently.
 * Over-budget pairs come back as one wholly deleted / wholly added segment (the line
 * itself is never truncated).
 */
export function diffWords(oldLine: string, newLine: string): WordDiff {
  const a = tokenize(oldLine);
  const b = tokenize(newLine);
  const n = a.length;
  const m = b.length;
  if ((n + 1) * (m + 1) > WORD_DIFF_MAX_CELLS) {
    return {
      old: oldLine ? [{ type: "del", text: oldLine }] : [],
      new: newLine ? [{ type: "add", text: newLine }] : [],
    };
  }

  const width = m + 1;
  const lengths = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lengths[i * width + j] =
        a[i] === b[j]
          ? lengths[(i + 1) * width + j + 1] + 1
          : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
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
    } else if (lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) {
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
