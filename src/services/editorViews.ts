/**
 * What an editor keeps about each document it shows, and nothing the document owns.
 *
 * The Document Model owns text, versions and persistence state; the editing engine's model
 * (one per document, `editorModelBridge.ts`) owns the undo history. This owns the view: the
 * engine's saved view state for each document -- cursors, selections, scroll position -- so
 * switching tabs and coming back finds the document as it was left, and whether the editor
 * showing it had keyboard focus. Keyed by document key, which follows the document through
 * Save As and renames (`rename`).
 */

/** The engine's own record of a view (Monaco's `ICodeEditorViewState`); opaque here. */
export type EditorViewState = unknown;

interface EditorView {
  view: EditorViewState | null;
  /** Whether the editor showing this document has keyboard focus. */
  focused: boolean;
  /** Set by `rename`, taken by the editor that shows the document under its new key. */
  moved: boolean;
}

export type EditorViews = ReturnType<typeof createEditorViews>;

export function createEditorViews() {
  const views = new Map<string, EditorView>();
  const entry = (key: string): EditorView => {
    let view = views.get(key);
    if (!view) {
      view = { view: null, focused: false, moved: false };
      views.set(key, view);
    }
    return view;
  };
  return {
    /** Where the editor was in the document when it last left it; null the first time. */
    getViewState(key: string): EditorViewState | null {
      return views.get(key)?.view ?? null;
    },
    setViewState(key: string, view: EditorViewState | null): void {
      entry(key).view = view;
    },
    /** The document now has another key (Save As, a rename): its view state goes with it. */
    rename(previousKey: string, key: string): void {
      const view = views.get(previousKey);
      if (!view || previousKey === key) return;
      views.delete(previousKey);
      view.moved = true;
      views.set(key, view);
    },
    /** The editor showing the document gained or lost keyboard focus. */
    setFocused(key: string, focused: boolean): void {
      entry(key).focused = focused;
    },
    /**
     * Whether an editor coming to show `key` should take keyboard focus: yes when the document
     * is being shown (a tab opened or switched to); after it only changed key (a rename, Save
     * As), only if its editor had focus -- a rename in the Explorer leaves focus there.
     */
    takeFocus(key: string): boolean {
      const view = views.get(key);
      if (!view?.moved) return true;
      view.moved = false;
      return view.focused;
    },
    /** The document was closed: its view state goes too. */
    forget(key: string): void {
      views.delete(key);
    },
    clear(): void {
      views.clear();
    },
    has(key: string): boolean {
      return views.has(key);
    },
  };
}
