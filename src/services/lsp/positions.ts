import { changedSpan } from "../editorModelBridge.ts";
import type { Position, Range, TextEdit } from "./protocol.ts";

/**
 * Offsets in a document's text and LSP positions, in each direction.
 *
 * A JavaScript string index counts UTF-16 code units; an LSP `character` counts in the
 * encoding the client and server agreed on -- UTF-16 by default, but UTF-8 bytes or UTF-32
 * code points if the server asked for them. They differ as soon as a line holds anything
 * outside ASCII ("é" is one UTF-16 unit but two UTF-8 bytes; "😀" is two UTF-16 units but one
 * code point), so every conversion goes through here and nothing else does arithmetic on
 * positions.
 *
 * A document's text in Yavin always uses `\n` (`documents.ts`); `\r\n` and `\r` are still
 * understood as line breaks here, as the protocol defines them.
 */

export type PositionEncoding = "utf-16" | "utf-8" | "utf-32";

/** The encoding a server's `positionEncoding` names; UTF-16 for anything else, as specified. */
export function encodingOf(name: string | undefined): PositionEncoding {
  return name === "utf-8" || name === "utf-32" ? name : "utf-16";
}

/** How many units of `encoding` the UTF-16 string `text` is. */
function unitsOf(text: string, encoding: PositionEncoding): number {
  if (encoding === "utf-16") return text.length;
  let units = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const pair = code >= 0xd800 && code <= 0xdbff && i + 1 < text.length;
    if (encoding === "utf-32") units += 1;
    else units += code < 0x80 ? 1 : code < 0x800 ? 2 : pair ? 4 : 3;
    if (pair) i++;
  }
  return units;
}

/** The UTF-16 length of the prefix of `text` that is `units` long in `encoding`. */
function lengthOf(text: string, units: number, encoding: PositionEncoding): number {
  if (encoding === "utf-16") return Math.min(units, text.length);
  let counted = 0;
  let i = 0;
  while (i < text.length && counted < units) {
    const code = text.charCodeAt(i);
    const pair = code >= 0xd800 && code <= 0xdbff && i + 1 < text.length;
    const width = encoding === "utf-32" ? 1 : code < 0x80 ? 1 : code < 0x800 ? 2 : pair ? 4 : 3;
    // A position inside a character lands on its start: never half a surrogate pair.
    if (counted + width > units) break;
    counted += width;
    i += pair ? 2 : 1;
  }
  return i;
}

/** Line starts of a text, for converting between offsets and positions. */
export class LineIndex {
  readonly text: string;
  private readonly starts: number[];

  constructor(text: string) {
    this.text = text;
    const starts = [0];
    if (text.indexOf("\r") === -1) {
      // The usual case (a document's text is always `\n`): the native search finds each line
      // break far faster than looking at every character.
      for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1))
        starts.push(at + 1);
    } else
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code === 10) starts.push(i + 1);
        else if (code === 13) {
          if (text.charCodeAt(i + 1) === 10) i++;
          starts.push(i + 1);
        }
      }
    this.starts = starts;
  }

  get lineCount(): number {
    return this.starts.length;
  }

  /** Where line `line`'s text ends, before its line break. */
  private lineEnd(line: number): number {
    const next = this.starts[line + 1];
    if (next === undefined) return this.text.length;
    let end = next - 1;
    if (end > 0 && this.text.charCodeAt(end) === 10 && this.text.charCodeAt(end - 1) === 13) end--;
    return end;
  }

  lineText(line: number): string {
    return this.text.slice(this.starts[line], this.lineEnd(line));
  }

  /** The position of UTF-16 offset `offset`, clamped to the text. */
  positionAt(offset: number, encoding: PositionEncoding = "utf-16"): Position {
    const clamped = Math.max(0, Math.min(offset, this.text.length));
    let low = 0;
    let high = this.starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (this.starts[middle] <= clamped) low = middle;
      else high = middle - 1;
    }
    const start = this.starts[low];
    const within = Math.min(clamped, this.lineEnd(low)) - start;
    return { line: low, character: unitsOf(this.text.slice(start, start + within), encoding) };
  }

  /**
   * The UTF-16 offset of `position`. Out-of-range positions are clamped as the protocol says:
   * a line past the end is the end of the text, a character past the line's end its end.
   */
  offsetAt(position: Position, encoding: PositionEncoding = "utf-16"): number {
    if (position.line < 0) return 0;
    if (position.line >= this.starts.length) return this.text.length;
    const start = this.starts[position.line];
    const line = this.text.slice(start, this.lineEnd(position.line));
    return start + lengthOf(line, Math.max(0, position.character), encoding);
  }

  rangeOf(start: number, end: number, encoding: PositionEncoding = "utf-16"): Range {
    return { start: this.positionAt(start, encoding), end: this.positionAt(end, encoding) };
  }
}

/**
 * The one incremental change that turns `before` into `after`: the changed span, with the
 * common prefix and suffix left out. A multi-cursor edit is one span covering all its cursors,
 * which is still correct -- just not the smallest change possible.
 */
export function incrementalChange(
  before: string,
  after: string,
  encoding: PositionEncoding = "utf-16",
): { range: Range; text: string } | null {
  if (before === after) return null;
  const span = changedSpan(before, after);
  const index = new LineIndex(before);
  return {
    range: index.rangeOf(span.start, span.end, encoding),
    text: span.text,
  };
}

export class OverlappingEditsError extends Error {
  constructor() {
    super("The edits overlap.");
    this.name = "OverlappingEditsError";
  }
}

/**
 * `text` with `edits` applied. The edits' ranges are all in the original text, as the protocol
 * defines them; they are applied from the end so none moves another. Edits at the same position
 * keep their order. Overlapping edits are refused, not guessed at.
 */
export function applyTextEdits(
  text: string,
  edits: readonly TextEdit[],
  encoding: PositionEncoding = "utf-16",
): string {
  if (!edits.length) return text;
  const index = new LineIndex(text);
  const spans = edits
    .map((edit, order) => ({
      start: index.offsetAt(edit.range.start, encoding),
      end: index.offsetAt(edit.range.end, encoding),
      text: edit.newText,
      order,
    }))
    .map((span) => (span.end < span.start ? { ...span, end: span.start } : span))
    .sort((a, b) => a.start - b.start || a.order - b.order);
  for (let i = 1; i < spans.length; i++)
    if (spans[i].start < spans[i - 1].end) throw new OverlappingEditsError();
  let result = "";
  let at = 0;
  for (const span of spans) {
    result += text.slice(at, span.start) + span.text;
    at = span.end;
  }
  return result + text.slice(at);
}
