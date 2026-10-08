/**
 * A task's terminal output as the lines a person reads in it (Run/Tasks Module 01), for the
 * problem matchers. Not a terminal emulator: one line at a time, kept the way the terminal
 * would show it, and ended where the terminal would start another.
 *
 * What the real output looks like (`fixtures/pty/README.md`, captured through ConPTY):
 *
 * - Lines are often separated by cursor moves, not line breaks. tsc's diagnostic is followed
 *   by `ESC[4;1H`, not `\r\n`. A move to a row (CUP, VPA, CNL, CPL, HVP, cursor home) ends
 *   the line, as does clearing the screen (ED 2/3, RIS).
 * - Runs of spaces become `ESC[nX` (erase characters) and `ESC[nC` (cursor forward).
 * - Progress is drawn over itself with a lone `\r`: cargo's `Building [ ]` bar is erased and
 *   then overwritten by the diagnostic. A `\r` goes back to the line's start, and what is
 *   written next replaces what was there.
 * - A long line arrives as one run of text whatever the width: the terminal wraps it, the
 *   stream does not. Nothing here depends on the terminal's width.
 *
 * Deterministic and streaming: bytes may be split anywhere, including inside an escape
 * sequence, and the same text gives the same lines however it is split.
 */

/** A line longer than this is not a diagnostic; it is cut, not kept growing. */
export const MAX_LINE = 8192;

const ESC = "\u001b";
const BEL = "\u0007";

export class TerminalText {
  /** The line being written, one cell per character. */
  private cells: string[] = [];
  private column = 0;
  /** An escape sequence not yet complete, from a previous chunk. */
  private pending = "";
  private readonly lines: string[] = [];

  /** Output text, in order, split anywhere. Returns the lines it completed. */
  push(text: string): string[] {
    const input = this.pending + text;
    this.pending = "";
    let i = 0;
    while (i < input.length) {
      const char = input[i];
      if (char === ESC) {
        const length = sequenceLength(input, i);
        if (length === 0) {
          // Incomplete: wait for the rest.
          this.pending = input.slice(i);
          break;
        }
        this.escape(input.slice(i, i + length));
        i += length;
        continue;
      }
      if (char === "\n") this.endLine();
      else if (char === "\r") this.column = 0;
      else if (char === "\b") this.column = Math.max(0, this.column - 1);
      else if (char === "\t") this.moveTo(this.column + (8 - (this.column % 8)));
      else if (char >= " " && char !== "\u007f") this.write(char);
      // Other control characters (BEL, NUL...) draw nothing.
      i += 1;
    }
    return this.lines.splice(0);
  }

  /** The output ended: the last line, if it had no line break, is complete too. */
  end(): string[] {
    this.pending = "";
    this.endLine();
    return this.lines.splice(0);
  }

  private write(char: string): void {
    if (this.column >= MAX_LINE) return;
    while (this.cells.length < this.column) this.cells.push(" ");
    this.cells[this.column] = char;
    this.column += 1;
  }

  private moveTo(column: number): void {
    this.column = Math.max(0, Math.min(column, MAX_LINE));
  }

  private endLine(): void {
    const line = this.cells.join("").trimEnd();
    this.cells = [];
    this.column = 0;
    if (line) this.lines.push(line);
  }

  private escape(sequence: string): void {
    const kind = sequence[1];
    if (kind === "]" || kind === "P" || kind === "_" || kind === "^") return; // OSC/DCS/APC/PM
    if (kind === "c") return this.endLine(); // RIS: the screen is reset
    if (kind === "E") return this.endLine(); // NEL
    if (kind !== "[") return; // ESC 7, ESC 8, ESC =, charset selection...
    const final = sequence[sequence.length - 1];
    const body = sequence.slice(2, -1);
    if (/^[?>=!<]/.test(body)) return; // private modes (?25h, ?9001h...)
    const numbers = body.split(";").map((part) => Number.parseInt(part, 10));
    const n = Number.isFinite(numbers[0]) && numbers[0] > 0 ? numbers[0] : 1;
    switch (final) {
      case "H": // CUP: a row and column
      case "f": // HVP
      case "d": // VPA: a row
      case "E": // CNL
      case "F": // CPL
      case "A": // CUU: another row
      case "B": // CUD
        this.endLine();
        if (final === "H" || final === "f") {
          const column = numbers[1];
          this.moveTo(Number.isFinite(column) && column > 1 ? column - 1 : 0);
        }
        return;
      case "J": // ED: clearing the screen, or below/above the cursor
        if (numbers[0] === 2 || numbers[0] === 3) this.endLine();
        return;
      case "G": // CHA: a column on this row
      case "`": // HPA
        this.moveTo(n - 1);
        return;
      case "C": // CUF: forward, over what is there
        this.moveTo(this.column + n);
        return;
      case "D": // CUB
        this.moveTo(this.column - n);
        return;
      case "X": // ECH: blank n cells from the cursor, which stays
        for (let at = this.column; at < Math.min(this.column + n, this.cells.length); at++)
          this.cells[at] = " ";
        return;
      case "K": {
        // EL: 0 to the end of the line, 1 to its start, 2 all of it.
        const mode = Number.isFinite(numbers[0]) ? numbers[0] : 0;
        if (mode === 0) this.cells.length = Math.min(this.cells.length, this.column);
        else if (mode === 1)
          for (let at = 0; at <= this.column && at < this.cells.length; at++) this.cells[at] = " ";
        else this.cells = [];
        return;
      }
      default:
        return; // SGR (colours) and everything else draw nothing
    }
  }
}

/**
 * How long the escape sequence at `start` is, or 0 when the text ends before it does.
 * CSI: `ESC [` parameters, intermediates, one final byte. OSC, DCS, APC, PM: up to BEL or
 * `ESC \`. Anything else: ESC and one character (plus one more for charset selection).
 */
function sequenceLength(text: string, start: number): number {
  const kind = text[start + 1];
  if (kind === undefined) return 0;
  if (kind === "[") {
    for (let i = start + 2; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code >= 0x40 && code <= 0x7e) return i - start + 1; // the final byte
      if (code >= 0x20 && code <= 0x3f) continue; // parameters and intermediates
      return Math.max(2, i - start); // malformed: dropped up to what cannot belong to it
    }
    return 0;
  }
  if (kind === "]" || kind === "P" || kind === "_" || kind === "^") {
    for (let i = start + 2; i < text.length; i++) {
      if (text[i] === BEL) return i - start + 1;
      if (text[i] === ESC) {
        if (i + 1 >= text.length) return 0;
        // ST ends it; any other escape ends it too, and is read on its own.
        return text[i + 1] === "\\" ? i - start + 2 : i - start;
      }
    }
    return 0;
  }
  if (kind === "(" || kind === ")" || kind === "*" || kind === "+")
    return start + 2 < text.length ? 3 : 0;
  return 2;
}
