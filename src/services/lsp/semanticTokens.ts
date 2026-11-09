import type { LineIndex, PositionEncoding } from "./positions.ts";

/**
 * Semantic tokens as a server sends them -- five numbers per token, positions relative to the
 * token before, columns in the server's position encoding -- made into what the editor needs,
 * with the validation that keeps a bad server from corrupting the editor's state (WS16).
 *
 * A delta edits the server's previous array, so the previous array is kept: in the server's own
 * units, since that is what its edits address. The editor counts UTF-16 columns; a server that
 * uses UTF-8 or UTF-32 has its columns converted, which needs the whole (edited) array.
 */

/** Numbers per token in the LSP encoding: deltaLine, deltaStartChar, length, tokenType, tokenModifiers. */
export const TOKEN_STRIDE = 5;

/** The ceiling that survives the `Uint32Array` Monaco is handed; also a sane bound for positions. */
const MAX_TOKEN_VALUE = 0xffffffff;

const isTokenValue = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_TOKEN_VALUE;

/**
 * Whether `data` is a well-formed semantic-token array: a flat run of whole {@link TOKEN_STRIDE}-number
 * tokens, every value a non-negative 32-bit integer. A server that sends a short, ragged, negative,
 * fractional, NaN or over-large array would, passed straight to `new Uint32Array`, be silently coerced
 * (negatives wrap, NaN becomes 0, floats truncate) into *wrong* highlighting; rejecting it instead
 * leaves the editor on its native tokenizer, uncorrupted. (Unknown token types or modifiers are not
 * rejected here: the legend owns those, and Monaco falls back safely for an out-of-legend index.)
 */
export function isValidTokenData(data: unknown): data is number[] {
  if (!Array.isArray(data) || data.length % TOKEN_STRIDE !== 0) return false;
  for (const value of data) if (!isTokenValue(value)) return false;
  return true;
}

export interface SemanticTokensEdit {
  start: number;
  deleteCount: number;
  data?: number[];
}

/**
 * A delta that cannot be cleanly applied to the retained previous result. The caller catches this
 * and recovers with a full request rather than drawing corrupt highlighting.
 */
export class SemanticDeltaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SemanticDeltaError";
  }
}

/**
 * `previous` with a delta's edits applied (their offsets are all into `previous`). The edits are
 * validated against `previous`: an out-of-range, negative, fractional or overlapping edit, an edit
 * inserting an invalid token value, or a result that is not a whole number of tokens, throws
 * {@link SemanticDeltaError} rather than returning a corrupt array. (`previous` is trusted -- it is a
 * value this module already validated and retained.)
 */
export function applySemanticDelta(
  previous: readonly number[],
  edits: readonly SemanticTokensEdit[],
): number[] {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  const out: number[] = [];
  let at = 0;
  for (const edit of sorted) {
    if (
      !Number.isInteger(edit.start) ||
      !Number.isInteger(edit.deleteCount) ||
      edit.deleteCount < 0 ||
      edit.start < at || // before the cursor => out of order or overlapping a prior edit
      edit.start + edit.deleteCount > previous.length
    )
      throw new SemanticDeltaError(
        `edit {start:${edit.start}, deleteCount:${edit.deleteCount}} is out of range for ${previous.length} values`,
      );
    for (let i = at; i < edit.start; i++) out.push(previous[i]);
    for (const value of edit.data ?? []) {
      if (!isTokenValue(value))
        throw new SemanticDeltaError(`edit inserts an invalid token value ${value}`);
      out.push(value);
    }
    at = edit.start + edit.deleteCount;
  }
  for (let i = at; i < previous.length; i++) out.push(previous[i]);
  if (out.length % TOKEN_STRIDE !== 0)
    throw new SemanticDeltaError(
      `delta result has ${out.length} values, not a whole number of tokens`,
    );
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
