import { monaco } from "./monaco";
import { textModelOf } from "./monacoHost";
import type { EditorModel } from "../services/editorModelBridge";

/**
 * The diff editor's foundation: some original text against a document's model, side by side.
 *
 * Git (against HEAD or the index), ChangeSets and AI proposals will each supply an original;
 * none is wired to this yet. The modified side is the document's own bridge model -- the one
 * its editor edits, shared safely by any number of views -- and the original is an in-memory
 * model this view owns and disposes, always read-only: it is a record, not a document.
 */
export interface DiffView {
  readonly editor: monaco.editor.IStandaloneDiffEditor;
  /** Resolves once the diff has been computed (by the editor worker). */
  ready(): Promise<readonly monaco.editor.ILineChange[]>;
  dispose(): void;
}

let originals = 0;

export function createDiffView(
  container: HTMLElement,
  options: {
    original: { text: string; languageId: string };
    modified: EditorModel;
    /** The modified side too, when the view is a review rather than an editor. */
    readOnly?: boolean;
    /**
     * A theme to switch to. Without one the diff shows in the theme already in use: Monaco's
     * theme is the whole window's, and it is the editor's theme setting (IDE-03).
     */
    theme?: string;
  },
): DiffView {
  const modified = textModelOf(options.modified);
  const original = monaco.editor.createModel(
    options.original.text,
    options.original.languageId,
    monaco.Uri.from({ scheme: "yavin-original", path: `/${++originals}` }),
  );
  const editor = monaco.editor.createDiffEditor(container, {
    automaticLayout: true,
    originalEditable: false,
    readOnly: options.readOnly ?? false,
    renderSideBySide: true,
    ...(options.theme ? { theme: options.theme } : {}),
  });
  editor.setModel({ original, modified });
  return {
    editor,
    ready: () =>
      new Promise((resolve) => {
        const changes = editor.getLineChanges();
        if (changes) return resolve(changes);
        const once = editor.onDidUpdateDiff(() => {
          once.dispose();
          resolve(editor.getLineChanges() ?? []);
        });
      }),
    dispose() {
      editor.setModel(null);
      editor.dispose();
      // The original is this view's; the modified model is the document's and stays.
      original.dispose();
    },
  };
}
