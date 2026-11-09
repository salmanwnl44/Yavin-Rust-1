/**
 * Inline Git blame in the editor (WS9): an unobtrusive annotation after the **current line** —
 * "author, 3 days ago • summary" — drawn with a Monaco injected-text ("after") decoration. Only
 * the cursor's line is annotated, so no per-line Git work happens; the annotation follows the
 * cursor and refreshes when the file's blame may have changed (a commit, HEAD move, save or edit),
 * all through the injected {@link BlameAnnotationSource} so this module owns no Git or document
 * state and never becomes a second editor-state owner.
 */
import { monaco } from "./monaco";
import { editorModelOf } from "./monacoHost";
import type { EditorModelBridge } from "../services/editorModelBridge";
import { fsPath } from "../services/resource";
import { blameAt, describeBlameLine, type BlameLine } from "../services/git/blame";

export interface BlameAnnotationSource {
  /**
   * Blame lines for a file at the current revision/version, or `null` when blame should not show
   * here (no repository contains the file, or the document has unsaved edits so disk blame would
   * be misleading). Caching and invalidation live behind this.
   */
  linesFor(path: string): Promise<readonly BlameLine[]> | null;
  /** Fires when the current annotation may have changed (git revision bump, or a document edit). */
  subscribe(listener: () => void): () => void;
}

export function attachBlameDecorations(
  editor: monaco.editor.ICodeEditor,
  bridge: EditorModelBridge,
  source: BlameAnnotationSource,
): () => void {
  let ids: string[] = [];
  const clear = () => {
    ids = editor.deltaDecorations(ids, []);
  };

  const pathOf = (model: monaco.editor.ITextModel): string | null => {
    const bridged = editorModelOf(model);
    const doc = bridged ? bridge.documentOf(bridged) : undefined;
    return doc?.uri ? fsPath(doc.uri) : null;
  };

  // Each paint takes a token; a slower one that resolves after a newer paint started is dropped,
  // so the annotation never flickers to a stale line's blame.
  let seq = 0;
  const paint = async (): Promise<void> => {
    const model = editor.getModel();
    const position = editor.getPosition();
    if (!model || !position) return clear();
    const path = pathOf(model);
    if (!path) return clear();
    const line = position.lineNumber;
    const pending = source.linesFor(path);
    if (!pending) return clear();
    const mine = ++seq;
    let lines: readonly BlameLine[];
    try {
      lines = await pending;
    } catch {
      if (mine === seq) clear();
      return;
    }
    // Superseded, or the cursor/model moved while we waited.
    if (
      mine !== seq ||
      editor.getModel() !== model ||
      editor.getPosition()?.lineNumber !== line ||
      line > model.getLineCount()
    )
      return;
    const text = describeBlameLine(blameAt(lines, line));
    const column = model.getLineMaxColumn(line);
    ids = editor.deltaDecorations(ids, [
      {
        range: new monaco.Range(line, column, line, column),
        options: {
          after: { content: ` ${text}`, inlineClassName: "yavin-blame-annotation" },
          showIfCollapsed: true,
        },
      },
    ]);
  };

  const run = () => void paint();
  const disposables = [
    editor.onDidChangeCursorPosition(run),
    editor.onDidChangeModel(run),
    { dispose: source.subscribe(run) },
  ];
  run();
  return () => {
    for (const disposable of disposables) disposable.dispose();
    clear();
  };
}
