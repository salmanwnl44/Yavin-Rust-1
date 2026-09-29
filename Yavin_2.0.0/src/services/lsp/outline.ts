import type { PositionEncoding } from "./positions.ts";
import { LineIndex } from "./positions.ts";
import type { DocumentSymbol, Range, SymbolInformation } from "./protocol.ts";

/**
 * The symbols of the document in front, as the Outline view and the breadcrumbs show them: a
 * tree, in the editor's own positions (1-based, UTF-16), asked of the document's language
 * server again a moment after each change. The server's answer is the only source; nothing
 * here reads or parses the document.
 */

/** A range as Monaco numbers it: 1-based lines and UTF-16 columns. */
export interface EditorRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

export interface OutlineSymbol {
  /** Stable while the symbol keeps its place among its siblings: `0/2/1`. */
  id: string;
  name: string;
  kind: number;
  detail?: string;
  /** All of it: the cursor is "in" the symbol anywhere inside. */
  range: EditorRange;
  /** Its name: where revealing it puts the cursor. */
  selection: EditorRange;
  children: OutlineSymbol[];
}

const toEditorRange = (
  range: Range,
  index: LineIndex | null,
  encoding: PositionEncoding,
): EditorRange => {
  if (!index || encoding === "utf-16")
    return {
      startLineNumber: range.start.line + 1,
      startColumn: range.start.character + 1,
      endLineNumber: range.end.line + 1,
      endColumn: range.end.character + 1,
    };
  const start = index.positionAt(index.offsetAt(range.start, encoding));
  const end = index.positionAt(index.offsetAt(range.end, encoding));
  return {
    startLineNumber: start.line + 1,
    startColumn: start.character + 1,
    endLineNumber: end.line + 1,
    endColumn: end.character + 1,
  };
};

const before = (a: EditorRange, b: EditorRange) =>
  a.startLineNumber - b.startLineNumber || a.startColumn - b.startColumn;

/** Whether `inner` lies within `outer`. */
const within = (inner: EditorRange, outer: EditorRange) =>
  (inner.startLineNumber > outer.startLineNumber ||
    (inner.startLineNumber === outer.startLineNumber && inner.startColumn >= outer.startColumn)) &&
  (inner.endLineNumber < outer.endLineNumber ||
    (inner.endLineNumber === outer.endLineNumber && inner.endColumn <= outer.endColumn));

/**
 * The server's answer as a tree, in document order. A tree of `DocumentSymbol`s is kept as it
 * is; a flat list of `SymbolInformation`s (older servers) is nested by containment -- a symbol
 * inside another's range is its child -- so both read the same in the Outline.
 */
export function toOutline(
  symbols: readonly (DocumentSymbol | SymbolInformation)[] | null | undefined,
  text: string | null,
  encoding: PositionEncoding,
): OutlineSymbol[] {
  if (!symbols?.length) return [];
  const index = text === null || encoding === "utf-16" ? null : new LineIndex(text);
  const tree = (list: readonly DocumentSymbol[], parent: string): OutlineSymbol[] =>
    list
      .map((symbol) => ({
        symbol,
        range: toEditorRange(symbol.range, index, encoding),
      }))
      .sort((a, b) => before(a.range, b.range))
      .map(({ symbol, range }, position) => {
        const id = parent ? `${parent}/${position}` : String(position);
        return {
          id,
          name: symbol.name,
          kind: symbol.kind,
          detail: symbol.detail || undefined,
          range,
          selection: toEditorRange(symbol.selectionRange ?? symbol.range, index, encoding),
          children: tree(symbol.children ?? [], id),
        };
      });
  if ("range" in symbols[0] && "selectionRange" in symbols[0])
    return tree(symbols as DocumentSymbol[], "");

  // Flat: sorted by start, and by size (largest first) where two start together, each goes
  // into the innermost earlier symbol that contains it.
  const flat = (symbols as SymbolInformation[])
    .flatMap((symbol) =>
      symbol.location && "range" in symbol.location
        ? [{ symbol, range: toEditorRange(symbol.location.range, index, encoding) }]
        : [],
    )
    .sort(
      (a, b) =>
        before(a.range, b.range) ||
        b.range.endLineNumber - a.range.endLineNumber ||
        b.range.endColumn - a.range.endColumn,
    );
  const roots: OutlineSymbol[] = [];
  const open: OutlineSymbol[] = [];
  for (const { symbol, range } of flat) {
    while (open.length && !within(range, open[open.length - 1].range)) open.pop();
    const siblings = open.length ? open[open.length - 1].children : roots;
    const parent = open[open.length - 1]?.id ?? "";
    const node: OutlineSymbol = {
      id: parent ? `${parent}/${siblings.length}` : String(siblings.length),
      name: symbol.name,
      kind: symbol.kind,
      range,
      selection: range,
      children: [],
    };
    siblings.push(node);
    open.push(node);
  }
  return roots;
}

/** The symbols containing a position, outermost first: what the breadcrumbs show. */
export function symbolPath(
  symbols: readonly OutlineSymbol[],
  line: number,
  column: number,
): OutlineSymbol[] {
  const at: EditorRange = {
    startLineNumber: line,
    startColumn: column,
    endLineNumber: line,
    endColumn: column,
  };
  const path: OutlineSymbol[] = [];
  let level = symbols;
  for (;;) {
    // The innermost wins; of siblings that both contain it (overlapping ranges), the last.
    const inside = level.filter((symbol) => within(at, symbol.range)).pop();
    if (!inside) return path;
    path.push(inside);
    level = inside.children;
  }
}

export type OutlineState =
  /** No document in front, or its language has no server. */
  | { state: "none"; key: string | null; message: string }
  | { state: "loading"; key: string; symbols: OutlineSymbol[] }
  | { state: "ready"; key: string; symbols: OutlineSymbol[] };

export interface OutlineSource {
  /**
   * The symbols of the document at `key`, from its server; null when no server is ready for
   * it (or the server has no document symbols). Throws when the document changed before the
   * answer came (the answer is dropped).
   */
  fetch(key: string, signal: AbortSignal): Promise<OutlineSymbol[] | null>;
}

/**
 * The Outline of the document in front: fetched when it comes to the front, and again
 * `delay` ms after it last changed; an answer that comes after another request started, or
 * for a document no longer in front, is dropped.
 */
export function createOutlineStore(source: OutlineSource, delay = 300) {
  let current: OutlineState = { state: "none", key: null, message: "No editor is open." };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: AbortController | null = null;
  const listeners = new Set<() => void>();
  const set = (next: OutlineState) => {
    current = next;
    for (const listener of listeners) listener();
  };

  const run = async (key: string) => {
    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;
    try {
      const symbols = await source.fetch(key, controller.signal);
      if (controller.signal.aborted || current.key !== key) return;
      set(
        symbols === null
          ? {
              state: "none",
              key,
              message: "The active editor cannot provide outline information.",
            }
          : { state: "ready", key, symbols },
      );
    } catch {
      // A newer text or document: the next request answers for it. A failure keeps what was
      // shown, which is better than an empty Outline flickering while typing.
      if (!controller.signal.aborted && current.key === key && current.state === "loading")
        set({ state: "ready", key, symbols: current.symbols });
    } finally {
      if (inFlight === controller) inFlight = null;
    }
  };

  return {
    get: (): OutlineState => current,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** The document in front changed to `key` (null: none). */
    show(key: string | null) {
      clearTimeout(timer);
      if (key === current.key && current.state !== "none") return;
      inFlight?.abort();
      if (key === null) {
        set({ state: "none", key: null, message: "No editor is open." });
        return;
      }
      set({ state: "loading", key, symbols: [] });
      void run(key);
    },
    /** The document at `key` changed, or its server became ready: ask again shortly. */
    refresh(key: string) {
      if (key !== current.key) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (current.key !== key) return;
        if (current.state === "none") set({ state: "loading", key, symbols: [] });
        void run(key);
      }, delay);
    },
    dispose() {
      clearTimeout(timer);
      inFlight?.abort();
      listeners.clear();
    },
  };
}

export type OutlineStore = ReturnType<typeof createOutlineStore>;
