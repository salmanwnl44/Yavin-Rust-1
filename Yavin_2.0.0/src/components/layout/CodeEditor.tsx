import { useEffect, useImperativeHandle, useRef, useState } from "react";
import type { Ref } from "react";
import { monaco } from "../../editor/monaco";
import { TEST_HOOKS } from "../../editor/testHooks";
import { monacoHost, monacoNaming, textModelOf } from "../../editor/monacoHost";
import { DEFAULT_EDITOR_SETTINGS, editorOptions } from "../../editor/editorSettings";
import type { EditorSettings } from "../../editor/editorSettings";
import { createEditorModelBridge } from "../../services/editorModelBridge";
import type { EditorModel, EditorModelBridge } from "../../services/editorModelBridge";
import type { DocumentService, TextDocument } from "../../services/documents";
import type { EditorViews } from "../../services/editorViews";
import type { EditorHandle, EditorState, LanguageFeatures } from "../../editor/editorTypes";
import { addReferencesAction, installLanguageFeatures } from "../../editor/lspMonaco";
import { createDiffView } from "../../editor/diff";
import { attachDebugDecorations } from "../../editor/debugMonaco";
import type { Breakpoints } from "../../services/debug/breakpoints";
import type { DebugService } from "../../services/debug/service";
import type { ResourceUri } from "../../services/resource";
import type { EditorDecoration } from "../../services/editorModelBridge";
import type { CursorStatusStore } from "../../services/cursorStatus";
import type { MinimapPreferences } from "../../services/minimapPreferences";
import { ContextMenu } from "../ui/ContextMenu";
import type { MenuItem } from "../ui/ContextMenu";

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
/** Language features are connected to Monaco once per window (per manager). */
const featuresInstalled = new WeakSet<object>();

/** The window's line commands, by the Monaco action each one runs. */
const LINE_ACTIONS = {
  moveLineUp: "editor.action.moveLinesUpAction",
  moveLineDown: "editor.action.moveLinesDownAction",
  copyLineUp: "editor.action.copyLinesUpAction",
  copyLineDown: "editor.action.copyLinesDownAction",
  deleteLine: "editor.action.deleteLines",
  toggleComment: "editor.action.commentLine",
  indent: "editor.action.indentLines",
  outdent: "editor.action.outdentLines",
} as const;

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
  cursorStatus,
  onCommandPalette,
  minimap = DEFAULT_EDITOR_SETTINGS.minimap,
  onMinimapChange,
  languageFeatures,
  editorSettings = DEFAULT_EDITOR_SETTINGS,
  debug,
}: {
  documentKey: string;
  documents: DocumentService;
  views: EditorViews;
  editorRef: Ref<EditorHandle>;
  onState: (state: EditorState) => void;
  wordWrap: boolean;
  zoom: number;
  readOnly?: boolean;
  /** Where the status bar reads the cursor from; told on every move, apart from React. */
  cursorStatus?: CursorStatusStore;
  /** Opens the window's command palette: the last item of the editor's right-click menu. */
  onCommandPalette?: () => void;
  /** How the minimap looks: the window's, which remembers it and offers View › Minimap. */
  minimap?: MinimapPreferences;
  onMinimapChange?: (change: Partial<MinimapPreferences>) => void;
  /** Language servers: connected to the engine here, and nothing more (see `lspMonaco.ts`). */
  languageFeatures?: LanguageFeatures;
  /**
   * The editor's settings as they resolve for the workspace (IDE-03); applied in place when
   * they change -- the editor is never recreated for a setting.
   */
  editorSettings?: EditorSettings;
  /**
   * The workspace's debugger (IDE-05): breakpoints and the paused line shown in the glyph
   * margin, and a click there toggling a breakpoint of the document's file.
   */
  debug?: {
    breakpoints: Breakpoints | null;
    service: DebugService;
    onToggleBreakpoint: (uri: ResourceUri, line: number) => void;
  };
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
  const [minimapMenu, setMinimapMenu] = useState<{ x: number; y: number } | null>(null);
  const settings = { ...editorSettings, minimap };
  const latest = useRef({
    onState,
    readOnly,
    wordWrap,
    zoom,
    cursorStatus,
    onCommandPalette,
    settings,
    debug,
  });
  latest.current = {
    onState,
    readOnly,
    wordWrap,
    zoom,
    cursorStatus,
    onCommandPalette,
    settings,
    debug,
  };

  /** The cursor and indentation for the status bar; none while no document is shown. */
  const publishCursor = () => {
    const instance = editor.current;
    const model = instance?.getModel();
    const selections = instance?.getSelections();
    const primary = instance?.getSelection();
    if (!model || !selections?.length || !primary) {
      latest.current.cursorStatus?.set(null);
      return;
    }
    const options = model.getOptions();
    latest.current.cursorStatus?.set({
      line: primary.positionLineNumber,
      column: primary.positionColumn,
      // Offsets, not the selected text: selecting all of a large file stays cheap.
      selected: selections.reduce(
        (sum, range) =>
          sum +
          model.getOffsetAt(range.getEndPosition()) -
          model.getOffsetAt(range.getStartPosition()),
        0,
      ),
      cursors: selections.length,
      insertSpaces: options.insertSpaces,
      tabSize: options.tabSize,
    });
  };

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

  // The debugger's decorations, for the workspace's breakpoints and session (IDE-05).
  const debugService = debug?.service;
  const debugBreakpoints = debug?.breakpoints ?? null;
  useEffect(() => {
    if (!debugService) return;
    return attachDebugDecorations(bridge, debugBreakpoints, debugService);
  }, [bridge, debugService, debugBreakpoints]);

  // The one Monaco editor.
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const { readOnly, wordWrap, zoom, settings } = latest.current;
    const instance = monaco.editor.create(element, {
      ...editorOptions(settings, { wordWrap, zoom, readOnly, ariaLabel: "" }),
      model: null,
    });
    editor.current = instance;
    // The window's command palette, last in the right-click menu as in VS Code. Its key is
    // Monaco's too while the editor has the keyboard, so the palette opens once.
    const palette = instance.addAction({
      id: "yavin.commandPalette",
      label: "Command Palette…",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyP],
      contextMenuGroupId: "z_commands",
      run: () => latest.current.onCommandPalette?.(),
    });
    // Right-clicking the minimap opens its own menu instead of the editing one. Caught on the
    // way down, before Monaco sees the event.
    const minimapClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest(".minimap")) return;
      event.preventDefault();
      event.stopPropagation();
      setMinimapMenu({ x: event.clientX, y: event.clientY });
    };
    element.addEventListener("contextmenu", minimapClick, true);
    const subscriptions = [
      instance.onDidChangeCursorSelection(publish),
      instance.onDidChangeCursorSelection(publishCursor),
      instance.onDidChangeModelOptions(publishCursor),
      instance.onDidChangeModelContent(publish),
      instance.onDidFocusEditorText(() => {
        if (shown.current) views.setFocused(shown.current.key, true);
      }),
      instance.onDidBlurEditorText(() => {
        if (shown.current) views.setFocused(shown.current.key, false);
      }),
      // A click in the glyph margin toggles a breakpoint on that line of the document's file.
      instance.onMouseDown((event) => {
        if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
        const line = event.target.position?.lineNumber;
        const uri = shown.current?.doc.uri;
        if (!line || !uri) return;
        latest.current.debug?.onToggleBreakpoint(uri, line);
      }),
    ];
    // Development builds only: the UI tests read and drive the editor through this, since
    // Monaco's input element does not hold the document's text.
    if (languageFeatures) {
      if (!featuresInstalled.has(languageFeatures.manager)) {
        featuresInstalled.add(languageFeatures.manager);
        installLanguageFeatures({
          manager: languageFeatures.manager,
          bridge,
          host: languageFeatures.host,
          documents: () => documents.all(),
        });
      }
      subscriptions.push(addReferencesAction(instance));
    }
    if (TEST_HOOKS) installTestHook(instance, bridge, () => shown.current?.key ?? null);
    return () => {
      element.removeEventListener("contextmenu", minimapClick, true);
      palette.dispose();
      leave();
      latest.current.cursorStatus?.set(null);
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
    publishCursor();
  }, [documentKey]);

  // The settings (font, tabs, theme...), the window's word wrap and zoom, and read-only
  // documents: applied to the editor in place.
  useEffect(() => {
    editor.current?.updateOptions(
      editorOptions(settings, {
        wordWrap,
        zoom,
        readOnly,
        ariaLabel: documents.get(documentKey)?.name ?? "",
      }),
    );
  }, [wordWrap, zoom, readOnly, minimap, editorSettings]);

  const chooseMinimap = (change: Partial<MinimapPreferences>) => onMinimapChange?.(change);
  // VS Code's minimap menu; its two submenus are shown inline, each choice checked.
  const minimapItems = (): MenuItem[] => [
    {
      label: "Minimap",
      checked: minimap.enabled,
      onClick: () => chooseMinimap({ enabled: !minimap.enabled }),
    },
    { divider: true },
    {
      label: "Render Characters",
      checked: minimap.renderCharacters,
      onClick: () => chooseMinimap({ renderCharacters: !minimap.renderCharacters }),
    },
    { divider: true },
    ...(["proportional", "fill", "fit"] as const).map((size) => ({
      label: `Vertical Size: ${size[0].toUpperCase()}${size.slice(1)}`,
      checked: minimap.size === size,
      onClick: () => chooseMinimap({ size }),
    })),
    { divider: true },
    ...(
      [
        ["mouseover", "Slider: Mouse Over"],
        ["always", "Slider: Always"],
      ] as const
    ).map(([showSlider, label]) => ({
      label,
      checked: minimap.showSlider === showSlider,
      onClick: () => chooseMinimap({ showSlider }),
    })),
  ];

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
    select(range) {
      const instance = editor.current;
      const model = instance?.getModel();
      if (!instance || !model) return;
      // A location from a diagnostic or a search may be stale (the file changed since): it
      // lands on the nearest real position instead of an invalid selection.
      const valid = model.validateRange(range);
      instance.setSelection(valid);
      instance.revealRangeInCenter(valid);
      instance.focus();
    },
    async runAction(id) {
      const instance = editor.current;
      if (!instance?.getModel()) return;
      instance.focus();
      await instance.getAction(id)?.run();
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
        case "moveLineUp":
        case "moveLineDown":
        case "copyLineUp":
        case "copyLineDown":
        case "deleteLine":
        case "toggleComment":
        case "indent":
        case "outdent":
          // Monaco's own line commands, run as its keybindings would run them.
          instance.trigger("menu", LINE_ACTIONS[action], null);
          instance.focus();
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

  return (
    <>
      <div ref={container} className="min-h-0 flex-1" data-editor="monaco" />
      {minimapMenu && (
        <ContextMenu
          x={minimapMenu.x}
          y={minimapMenu.y}
          label="Minimap"
          items={minimapItems()}
          onClose={() => setMinimapMenu(null)}
        />
      )}
    </>
  );
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
