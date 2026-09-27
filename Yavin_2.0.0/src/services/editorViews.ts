import type { TextHistory } from "./editor.ts";

/**
 * What an editor keeps about each document it shows, and nothing the document owns.
 *
 * The Document Model owns text, versions and persistence state. This owns the view: the undo
 * history (editor-local by design until a later module), where the caret and selection were,
 * and how far the view was scrolled -- so switching tabs and coming back finds the document as
 * it was left. Keyed by document key, which follows the document through Save As and renames
 * (`rename`).
 */

export interface EditorViewState {
  selectionStart: number;
  selectionEnd: number;
  scrollTop: number;
  scrollLeft: number;
}

interface EditorView {
  history: TextHistory;
  view: EditorViewState | null;
}

export type EditorViews = ReturnType<typeof createEditorViews>;

export function createEditorViews() {
  const views = new Map<string, EditorView>();
  const entry = (key: string): EditorView => {
    let view = views.get(key);
    if (!view) {
      view = { history: { past: [], future: [] }, view: null };
      views.set(key, view);
    }
    return view;
  };
  return {
    /** The document's undo history in this editor, created empty the first time. */
    history(key: string): TextHistory {
      return entry(key).history;
    },
    /** Where the editor was in the document when it last left it; null the first time. */
    getViewState(key: string): EditorViewState | null {
      return views.get(key)?.view ?? null;
    },
    /** Updates what is given; the rest stays as it was. */
    setViewState(key: string, view: Partial<EditorViewState>): void {
      const current = entry(key);
      current.view = {
        ...(current.view ?? { selectionStart: 0, selectionEnd: 0, scrollTop: 0, scrollLeft: 0 }),
        ...view,
      };
    },
    /** The document now has another key (Save As, a rename): its view state goes with it. */
    rename(previousKey: string, key: string): void {
      const view = views.get(previousKey);
      if (!view || previousKey === key) return;
      views.delete(previousKey);
      views.set(key, view);
    },
    /** The document was closed: its history and view state go too. */
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
