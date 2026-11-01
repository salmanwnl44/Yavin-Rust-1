import type { LineIndex, PositionEncoding } from "./positions.ts";

/**
 * Semantic tokens as a server sends them -- five numbers per token, positions relative to the
 * token before, columns in the server's position encoding -- made into what the editor needs.
 *
 * A delta edits the server's previous array, so the previous array is kept: in the server's own
 * units, since that is what its edits address. The editor counts UTF-16 columns; a server that
 * uses UTF-8 or UTF-32 has its columns converted, which needs the whole (edited) array.
 */

export interface SemanticTokensEdit {
  start: number;
  deleteCount: number;
  data?: number[];
}

/** `previous` with a delta's edits applied (their offsets are all into `previous`). */
export function applySemanticDelta(
  previous: readonly number[],
  edits: readonly SemanticTokensEdit[],
): number[] {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  const out: number[] = [];
  let at = 0;
  for (const edit of sorted) {
    for (let i = at; i < edit.start; i++) out.push(previous[i]);
    out.push(...(edit.data ?? []));
    at = edit.start + edit.deleteCount;
  }
  for (let i = at; i < previous.length; i++) out.push(previous[i]);
  return out;
}

/**
 * Tokens with UTF-8 or UTF-32 columns re-encoded to UTF-16, for `index` (the document's text).
 * UTF-16 tokens are returned as they are.
 */
export function toUtf16Tokens(
  data: readonly number[],
  index: LineIndex,
  encoding: PositionEncoding,
): number[] {
  if (encoding === "utf-16") return [...data];
  const out: number[] = [];
  let line = 0;
  let character = 0;
  let previousLine = 0;
  let previousCharacter = 0;
  for (let i = 0; i + 4 < data.length; i += 5) {
    const [deltaLine, deltaStart, length, type, modifiers] = data.slice(i, i + 5);
    line += deltaLine;
    character = deltaLine ? deltaStart : character + deltaStart;
    const start = index.offsetAt({ line, character }, encoding);
    const end = index.offsetAt({ line, character: character + length }, encoding);
    const at = index.positionAt(start);
    const relativeLine = at.line - previousLine;
    out.push(
      relativeLine,
      relativeLine ? at.character : at.character - previousCharacter,
      end - start,
      type,
      modifiers,
    );
    previousLine = at.line;
    previousCharacter = at.character;
  }
  return out;
}
