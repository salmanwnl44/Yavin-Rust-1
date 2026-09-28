import { useEffect, useImperativeHandle, useRef } from "react";
import type { Ref } from "react";
import { monaco } from "../../editor/monaco";
import { TEST_HOOKS } from "../../editor/testHooks";
import { monacoHost, monacoNaming, textModelOf } from "../../editor/monacoHost";
import { DEFAULT_EDITOR_SETTINGS, editorOptions } from "../../editor/editorSettings";
import { createEditorModelBridge } from "../../services/editorModelBridge";
import type { EditorModel, EditorModelBridge } from "../../services/editorModelBridge";
import type { DocumentService, TextDocument } from "../../services/documents";
import type { EditorViews } from "../../services/editorViews";
import type { EditorHandle, EditorState } from "../../editor/editorTypes";
import { createDiffView } from "../../editor/diff";
import type { EditorDecoration } from "../../services/editorModelBridge";

/**
 * The code editor: Monaco, showing the Document Model's documents.
 *
 * ```text
 * DocumentService ── EditorModelBridge ── Monaco TextModel (one per document)
 *                                              │ setModel
 *                                        this editor (one Monaco instance)
 * ```
 *
 * One Monaco editor lives for as long as this component; switching tabs swaps the document's
 * model into it and restores that document's view state (cursors, selections, scroll) from
 * `EditorViews`. Models are the bridge's, one per document, kept across tab switches -- so
 * each keeps its undo history -- and disposed when the document closes. Typing goes from the
 * model to `DocumentService.edit` through the bridge; React is not involved, so a keystroke
 * re-renders nothing. The component only mounts, binds and disposes.
 */

const bridges = new WeakMap<DocumentService, EditorModelBridge>();

/** The window's one bridge for its Document Model, made when an editor is first shown. */
export function bridgeFor(documents: DocumentService): EditorModelBridge {
  let bridge = bridges.get(documents);
  if (!bridge) {
    bridge = createEditorModelBridge(documents, monacoHost, monacoNaming);
    bridges.set(documents, bridge);
    // Leaving the window disposes every model and listener.
    const created = bridge;
    window.addEventListener("pagehide", () => created.dispose(), { once: true });
  }
  return bridge;
}

type Shown = { key: string; doc: TextDocument; model: EditorModel };

export default function CodeEditor({
  documentKey,
  documents,
  views,
  editorRef,
  onState,
  wordWrap,
  zoom,
  readOnly = false,
}: {
  documentKey: string;
  documents: DocumentService;
  views: EditorViews;
  editorRef: Ref<EditorHandle>;
  onState: (state: EditorState) => void;
  wordWrap: boolean;
  zoom: number;
  readOnly?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const shown = useRef<Shown | null>(null);
  /**
   * Whether the editor takes focus on coming to a document, decided once per arrival: React
   * runs effects twice in development, and a second decision would find the "moved" mark of a
   * rename already taken (see `EditorViews.takeFocus`).
   */
  const focusDecision = useRef<{ key: string; take: boolean } | null>(null);
  const bridge = bridgeFor(documents);
  const latest = useRef({ onState, readOnly, wordWrap, zoom });
  latest.current = { onState, readOnly, wordWrap, zoom };

  const published = useRef<EditorState | null>(null);
  const publish = () => {
    const instance = editor.current;
    const model = instance?.getModel();
    const next: EditorState = {
      canUndo: !!model?.canUndo(),
      canRedo: !!model?.canRedo(),
      selected: !!instance?.getSelections()?.some((selection) => !selection.isEmpty()),
    };
    const last = published.current;
    if (
      last &&
      last.canUndo === next.canUndo &&
      last.canRedo === next.canRedo &&
      last.selected === next.selected
    )
      return;
    published.current = next;
    latest.current.onState(next);
  };

  /** Leaves the document shown: its view state is kept, its model released. */
  const leave = () => {
    const instance = editor.current;
    const current = shown.current;
    if (!instance || !current) return;
    // Not for a document that has closed: there is nothing to come back to.
    if (documents.get(current.key)) views.setViewState(current.key, instance.saveViewState());
    instance.setModel(null);
    bridge.release(current.model);
    shown.current = null;
  };

  // The one Monaco editor.
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const { readOnly, wordWrap, zoom } = latest.current;
    const instance = monaco.editor.create(element, {
      ...editorOptions(DEFAULT_EDITOR_SETTINGS, { wordWrap, zoom, readOnly, ariaLabel: "" }),
      model: null,
    });
    editor.current = instance;
    const subscriptions = [
      instance.onDidChangeCursorSelection(publish),
      instance.onDidChangeModelContent(publish),
      instance.onDidFocusEditorText(() => {
        if (shown.current) views.setFocused(shown.current.key, true);
      }),
      instance.onDidBlurEditorText(() => {
        if (shown.current) views.setFocused(shown.current.key, false);
      }),
    ];
    // Development builds only: the UI tests read and drive the editor through this, since
    // Monaco's input element does not hold the document's text.
    if (TEST_HOOKS) installTestHook(instance, bridge, () => shown.current?.key ?? null);
    return () => {
      leave();
      for (const subscription of subscriptions) subscription.dispose();
      instance.dispose();
      editor.current = null;
      if (TEST_HOOKS) removeTestHook(instance);
    };
  }, []);

  // The document shown.
  useEffect(() => {
    const instance = editor.current;
    const doc = documents.get(documentKey);
    if (!instance || !doc) return;
    const current = shown.current;
    if (current?.doc === doc) {
      // The same document under a new key (a rename, Save As): the same model, nothing to
      // rebind. Focus stays where it is; the rename's mark is taken so a later switch focuses.
      current.key = documentKey;
      instance.updateOptions({ ariaLabel: doc.name });
      if (focusDecision.current?.key !== documentKey)
        focusDecision.current = { key: documentKey, take: views.takeFocus(documentKey) };
      return;
    }
    leave();
    const model = bridge.retain(documentKey);
    if (!model) return;
    instance.setModel(textModelOf(model));
    const state = views.getViewState(documentKey);
    if (state) instance.restoreViewState(state as monaco.editor.ICodeEditorViewState);
    instance.updateOptions({ ariaLabel: doc.name });
    shown.current = { key: documentKey, doc, model };
    if (focusDecision.current?.key !== documentKey)
      focusDecision.current = { key: documentKey, take: views.takeFocus(documentKey) };
    if (focusDecision.current.take) instance.focus();
    published.current = null;
    publish();
  }, [documentKey]);

  // The window's word wrap and zoom, and read-only documents.
  useEffect(() => {
    editor.current?.updateOptions(
      editorOptions(DEFAULT_EDITOR_SETTINGS, {
        wordWrap,
        zoom,
        readOnly,
        ariaLabel: documents.get(documentKey)?.name ?? "",
      }),
    );
  }, [wordWrap, zoom, readOnly]);

  useImperativeHandle(editorRef, () => ({
    focus: () => editor.current?.focus(),
    revealRange(start, end) {
      const instance = editor.current;
      const model = instance?.getModel();
      if (!instance || !model) return;
      const from = model.getPositionAt(start);
      const to = model.getPositionAt(end);
      const range = new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column);
      instance.setSelection(range);
      instance.revealRangeInCenter(range);
      instance.focus();
    },
    goToLine(line) {
      const instance = editor.current;
      const model = instance?.getModel();
      if (!instance || !model) return;
      if (!Number.isInteger(line) || line < 1)
        throw new Error("Enter a positive whole line number.");
      const lines = model.getLineCount();
      if (line > lines) throw new Error(`This document has ${lines} lines.`);
      instance.setPosition({ lineNumber: line, column: 1 });
      instance.revealLineInCenter(line);
      instance.focus();
    },
    async execute(action) {
      const instance = editor.current;
      const model = instance?.getModel();
      if (!instance || !model) return;
      switch (action) {
        case "undo":
        case "redo":
          instance.trigger("menu", action, null);
          break;
        case "selectAll":
          instance.setSelection(model.getFullModelRange());
          break;
        case "selectLine":
          instance.trigger("menu", "expandLineSelection", null);
          break;
        case "duplicate":
          instance.trigger("menu", "editor.action.duplicateSelection", null);
          break;
        case "find":
          await instance.getAction("actions.find")?.run();
          return;
        case "replace":
          await instance.getAction("editor.action.startFindReplaceAction")?.run();
          return;
        case "copy":
        case "cut": {
          const selections = instance.getSelections() ?? [];
          const text = selections.map((selection) => model.getValueInRange(selection)).join("\n");
          await navigator.clipboard.writeText(text);
          if (action === "cut" && editor.current === instance && instance.getModel() === model) {
            instance.executeEdits(
              "cut",
              selections.map((range) => ({ range, text: "" })),
            );
            instance.pushUndoStop();
          }
          break;
        }
        case "paste": {
          const text = await navigator.clipboard.readText();
          // The editor moved on while the clipboard was read: nothing is pasted elsewhere.
          if (editor.current !== instance || instance.getModel() !== model)
            throw new Error("The document changed while reading the clipboard. Paste again.");
          instance.executeEdits(
            "paste",
            (instance.getSelections() ?? []).map((range) => ({ range, text })),
          );
          instance.pushUndoStop();
          break;
        }
      }
      instance.focus();
      publish();
    },
  }));

  return <div ref={container} className="min-h-0 flex-1" data-editor="monaco" />;
}

// ---------------------------------------------------------------------------------------
// Development-only test hook
// ---------------------------------------------------------------------------------------

type Offsets = { start: number; end: number };

export interface EditorTestHook {
  value(): string;
  /** The text's length, without copying it out. */
  length(): number;
  /** Replaces the text as a user edit would: one undoable edit, through the bridge. */
  setValue(text: string): void;
  /** Types at the cursors: Monaco's own `type` command, what a keystroke becomes. */
  type(text: string): void;
  selections(): Offsets[];
  setSelections(selections: Offsets[]): void;
  scroll(): { top: number; left: number };
  setScroll(top: number, left: number): void;
  label(): string;
  hasFocus(): boolean;
  modelCount(): number;
  lineCount(): number;
  languageId(): string;
  /** Tokens on a line, as Monaco coloured them -- that syntax colouring really ran. */
  tokenTypes(line: number): string[];
  /** Word wrap and read-only, as the editor has them. */
  options(): { wordWrap: string; readOnly: boolean };
  setReadOnly(readOnly: boolean): void;
  /** Runs one of Monaco's own actions (fold, bracket jump...). */
  run(actionId: string): Promise<void>;
  /** How many lines are on screen or folded away: `[visible, total]`. */
  lines(): [number, number];
  /** An owner's decorations on the shown document, through the bridge. */
  decorate(owner: string, decorations: EditorDecoration[]): void;
  /** Opens a diff of `original` against the shown document; resolves to what it found. */
  diff(original: string): Promise<{ changes: number; originalReadOnly: boolean }>;
}

let hooked: monaco.editor.IStandaloneCodeEditor | null = null;

function installTestHook(
  instance: monaco.editor.IStandaloneCodeEditor,
  bridge: EditorModelBridge,
  key: () => string | null,
) {
  hooked = instance;
  const model = () => instance.getModel()!;
  const hook: EditorTestHook = {
    value: () => model().getValue(),
    length: () => model().getValueLength(),
    setValue(text) {
      instance.executeEdits("test", [{ range: model().getFullModelRange(), text }]);
      instance.pushUndoStop();
    },
    type(text) {
      instance.trigger("keyboard", "type", { text });
    },
    selections: () =>
      (instance.getSelections() ?? []).map((selection) => ({
        start: model().getOffsetAt(selection.getStartPosition()),
        end: model().getOffsetAt(selection.getEndPosition()),
      })),
    setSelections(selections) {
      instance.setSelections(
        selections.map(({ start, end }) => {
          const from = model().getPositionAt(start);
          const to = model().getPositionAt(end);
          return new monaco.Selection(from.lineNumber, from.column, to.lineNumber, to.column);
        }),
      );
    },
    scroll: () => ({ top: instance.getScrollTop(), left: instance.getScrollLeft() }),
    setScroll(top, left) {
      instance.setScrollPosition({ scrollTop: top, scrollLeft: left });
    },
    label: () => instance.getOption(monaco.editor.EditorOption.ariaLabel),
    hasFocus: () => instance.hasTextFocus(),
    modelCount: () => monaco.editor.getModels().length,
    lineCount: () => model().getLineCount(),
    languageId: () => model().getLanguageId(),
    setReadOnly(readOnly) {
      instance.updateOptions({ readOnly });
    },
    async run(actionId) {
      await instance.getAction(actionId)?.run();
    },
    lines() {
      const hidden = instance
        .getVisibleRanges()
        .reduce((sum, range) => sum + range.endLineNumber - range.startLineNumber + 1, 0);
      return [hidden, model().getLineCount()];
    },
    decorate(owner, decorations) {
      const shown = key();
      if (shown) bridge.setDecorations(shown, owner, decorations);
    },
    async diff(original) {
      const shown = key();
      const bridged = shown ? bridge.get(shown) : undefined;
      if (!bridged) throw new Error("No document is shown.");
      const host = document.createElement("div");
      host.style.cssText = "position:fixed;right:0;bottom:0;width:600px;height:300px;z-index:50";
      host.dataset.testDiff = "";
      document.body.append(host);
      const view = createDiffView(host, {
        original: { text: original, languageId: model().getLanguageId() },
        modified: bridged,
      });
      const changes = await view.ready();
      const originalReadOnly = view.editor
        .getOriginalEditor()
        .getOption(monaco.editor.EditorOption.readOnly);
      view.dispose();
      host.remove();
      return { changes: changes.length, originalReadOnly };
    },
    options: () => ({
      wordWrap: instance.getOption(monaco.editor.EditorOption.wordWrap),
      readOnly: instance.getOption(monaco.editor.EditorOption.readOnly),
    }),
    tokenTypes: (line) =>
      monaco.editor
        .tokenize(model().getLineContent(line), model().getLanguageId())[0]
        .map((token) => token.type),
  };
  (window as unknown as { __yavinEditor?: EditorTestHook }).__yavinEditor = hook;
}

function removeTestHook(instance: monaco.editor.IStandaloneCodeEditor) {
  if (hooked !== instance) return;
  hooked = null;
  delete (window as unknown as { __yavinEditor?: EditorTestHook }).__yavinEditor;
}
