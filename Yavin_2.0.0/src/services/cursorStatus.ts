/**
 * Where the cursor is in the editor in front, and how its document is indented -- what the
 * status bar shows on the right.
 *
 * Its own small store rather than React state in the window: the cursor moves with every
 * keystroke, and only the few status bar items that show it should redraw for that (the
 * window re-rendering per keystroke is exactly what the editor is built to avoid).
 */
export interface CursorStatus {
  /** 1-based, as shown. */
  line: number;
  column: number;
  /** Characters selected, across every cursor. */
  selected: number;
  /** How many cursors there are (multi-cursor editing). */
  cursors: number;
  /** The document's indentation, as Monaco detected or was told it. */
  insertSpaces: boolean;
  tabSize: number;
}

export function createCursorStatus() {
  let current: CursorStatus | null = null;
  const listeners = new Set<() => void>();
  const same = (a: CursorStatus | null, b: CursorStatus | null) =>
    a === b ||
    (!!a &&
      !!b &&
      a.line === b.line &&
      a.column === b.column &&
      a.selected === b.selected &&
      a.cursors === b.cursors &&
      a.insertSpaces === b.insertSpaces &&
      a.tabSize === b.tabSize);
  return {
    /** Null while no editor is showing a document. */
    get: (): CursorStatus | null => current,
    set(next: CursorStatus | null) {
      if (same(current, next)) return;
      current = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type CursorStatusStore = ReturnType<typeof createCursorStatus>;

/** The status bar's words for it, VS Code's: "Ln 12, Col 7", "(5 selected)", "Spaces: 2". */
export function describeCursor(status: CursorStatus): {
  position: string;
  selection: string;
  indentation: string;
} {
  return {
    position: `Ln ${status.line}, Col ${status.column}`,
    selection:
      status.cursors > 1
        ? `${status.cursors} selections${status.selected ? ` (${status.selected} characters selected)` : ""}`
        : status.selected
          ? `(${status.selected} selected)`
          : "",
    indentation: status.insertSpaces ? `Spaces: ${status.tabSize}` : `Tab Size: ${status.tabSize}`,
  };
}
