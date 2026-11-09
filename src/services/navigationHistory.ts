/**
 * Back / Forward navigation history (WS25): the editor's cross-document "where was I" trail,
 * the one the Back and Forward commands walk -- what VS Code binds to Alt+Left / Alt+Right.
 *
 * Monaco keeps a soft in-file cursor-undo, and the window keeps tab order and view state, but
 * nothing remembered the *jumps* between places: Go to Definition, Find References, a search
 * hit, a breadcrumb, a terminal link. This does, and only those -- ordinary cursor moves and
 * typing never enter it, so Back is a jump back to a place the user went, not the last key they
 * pressed.
 *
 * It owns a list of locations and a cursor into it. A new navigation (`record`) drops anything
 * ahead of the cursor -- the forward branch a back-then-elsewhere abandons -- and appends; Back
 * and Forward only move the cursor and hand back where to go. It stores document *keys* (the
 * same identity the Document Model and EditorViews use), never a second copy of the document,
 * and it follows a document through Save As / rename (`rename`) and forgets one that is gone
 * (`forget`), so it never points at a document that no longer exists under that key.
 *
 * It holds no React state and touches no editor: the window reads a location from it and reveals
 * that location the same way every other navigation does (`openLocation`), which is what keeps
 * Back and a Go to Definition landing in exactly the same place.
 */
import type { EditorRange } from "../editor/editorTypes.ts";

/** A place the user went: a document (by key) and, when known, where in it. */
export interface NavLocation {
  /** The document key -- a path for a file, the id for an untitled or proposed document. */
  readonly key: string;
  /** Where in the document, 1-based; absent for a jump to a document without a known spot. */
  readonly range?: EditorRange;
}

export type NavigationHistory = ReturnType<typeof createNavigationHistory>;

/** The most places Back remembers; the oldest fall off the far end. */
const DEFAULT_LIMIT = 50;

/**
 * Two locations are "the same place" when they are the same document and the same line: a jump
 * that lands on a line already at the top of the trail updates it in place rather than stacking
 * a near-duplicate, as repeatedly chasing a definition to one spot should not fill the history.
 * The column is not part of it -- two clicks on the same line are the same place to come back to.
 */
const samePlace = (a: NavLocation, b: NavLocation): boolean =>
  a.key === b.key && (a.range?.startLineNumber ?? 0) === (b.range?.startLineNumber ?? 0);

export function createNavigationHistory(options: { limit?: number } = {}) {
  const limit = Math.max(1, options.limit ?? DEFAULT_LIMIT);
  let entries: NavLocation[] = [];
  /** The cursor into `entries`: the location currently shown. -1 when there is no history. */
  let index = -1;
  const listeners = new Set<() => void>();

  const changed = () => {
    for (const listener of [...listeners]) listener();
  };

  /**
   * Puts `loc` at the cursor: a same-place top is replaced (keeping the newer, more precise
   * range), otherwise anything ahead of the cursor is dropped and `loc` appended. Caps the list
   * at `limit`, dropping the oldest and moving the cursor with them.
   */
  const append = (loc: NavLocation): void => {
    const top = index >= 0 ? entries[index] : undefined;
    if (top && samePlace(top, loc)) {
      entries[index] = loc;
      return;
    }
    if (index < entries.length - 1) entries = entries.slice(0, index + 1);
    entries.push(loc);
    index = entries.length - 1;
    if (entries.length > limit) {
      const drop = entries.length - limit;
      entries = entries.slice(drop);
      index -= drop;
    }
  };

  return {
    /**
     * A navigation happened: the user went to `to`. `from` is where they were when they left --
     * the active editor's position a moment before -- so that Back returns to exactly that spot
     * and not merely to the document's start. `from` of the same document as the current top
     * updates that top (the user moved within the document since arriving); a `from` in another
     * document, or the very first navigation, becomes its own entry before `to`.
     *
     * Call it only for real jumps (Go to Definition, a reference, a search hit, a breadcrumb),
     * never for ordinary cursor movement or typing.
     */
    record(to: NavLocation, from?: NavLocation | null): void {
      const before = { index, length: entries.length };
      if (from) {
        const top = index >= 0 ? entries[index] : undefined;
        if (top && top.key === from.key) entries[index] = from;
        else append(from);
      }
      append(to);
      if (before.index !== index || before.length !== entries.length) changed();
    },

    /** Whether there is somewhere to go Back to. */
    canGoBack(): boolean {
      return index > 0;
    },
    /** Whether there is somewhere to go Forward to. */
    canGoForward(): boolean {
      return index >= 0 && index < entries.length - 1;
    },

    /** Steps back one place and hands it back, or null when already at the oldest. */
    back(): NavLocation | null {
      if (index <= 0) return null;
      index--;
      changed();
      return entries[index];
    },
    /** Steps forward one place and hands it back, or null when already at the newest. */
    forward(): NavLocation | null {
      if (index < 0 || index >= entries.length - 1) return null;
      index++;
      changed();
      return entries[index];
    },

    /** Where the trail currently sits, or null when empty. */
    current(): NavLocation | null {
      return index >= 0 ? entries[index] : null;
    },

    /**
     * A document took a new key (Save As, a rename): every entry for it follows, so Back still
     * finds it under the name it has now. The cursor is unmoved.
     */
    rename(previousKey: string, key: string): void {
      if (previousKey === key) return;
      let touched = false;
      entries = entries.map((entry) => {
        if (entry.key !== previousKey) return entry;
        touched = true;
        return { key, range: entry.range };
      });
      if (touched) changed();
    },

    /**
     * A document is gone for good (deleted, or an untitled buffer closed): its entries leave the
     * trail, and the cursor moves with whatever fell away before it so it still points at the
     * same place. A disk file merely closed is *not* forgotten -- Back reopens it.
     */
    forget(key: string): void {
      if (!entries.some((entry) => entry.key === key)) return;
      const kept: NavLocation[] = [];
      let next = index;
      entries.forEach((entry, at) => {
        if (entry.key === key) {
          if (at <= index) next--;
        } else kept.push(entry);
      });
      entries = kept;
      index = Math.min(Math.max(next, entries.length ? 0 : -1), entries.length - 1);
      changed();
    },

    /** The whole trail leaves (a change of workspace): histories never mix across folders. */
    clear(): void {
      if (!entries.length && index === -1) return;
      entries = [];
      index = -1;
      changed();
    },

    /** The trail, oldest first -- for a Recent Locations picker and for tests. */
    entries(): readonly NavLocation[] {
      return entries;
    },
    /** Where the cursor sits in `entries`. */
    position(): number {
      return index;
    },
    /**
     * A value that changes whenever Back or Forward becomes (un)available -- for
     * `useSyncExternalStore`, so the Back/Forward commands' enabled state follows the trail.
     */
    snapshot(): string {
      return `${index}:${entries.length}`;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
