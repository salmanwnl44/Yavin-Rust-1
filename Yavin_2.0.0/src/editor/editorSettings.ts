import type { monaco } from "./monaco";
import { DEFAULT_MINIMAP } from "../services/minimapPreferences";
import type { MinimapPreferences } from "../services/minimapPreferences";

/**
 * The editor's settings, in one place: sensible defaults now, what a Settings module will
 * control later. Word wrap and zoom come from the window's View menu.
 */
export interface EditorSettings {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  tabSize: number;
  insertSpaces: boolean;
  /** Changed from the minimap's own right-click menu, and remembered. */
  minimap: MinimapPreferences;
  lineNumbers: "on" | "off" | "relative";
  bracketPairColorization: boolean;
  renderWhitespace: "none" | "boundary" | "selection" | "all";
  renderControlCharacters: boolean;
  cursorStyle: "line" | "block" | "underline";
  smoothScrolling: boolean;
  stickyScroll: boolean;
  folding: boolean;
  theme: "yavin-dark" | "yavin-light";
}

export const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
  fontFamily: "ui-monospace, 'Cascadia Code', 'JetBrains Mono', Consolas, monospace",
  fontSize: 13,
  lineHeight: 22,
  tabSize: 2,
  insertSpaces: true,
  minimap: DEFAULT_MINIMAP,
  lineNumbers: "on",
  bracketPairColorization: true,
  renderWhitespace: "selection",
  renderControlCharacters: true,
  cursorStyle: "line",
  smoothScrolling: true,
  stickyScroll: true,
  folding: true,
  theme: "yavin-dark",
};

/** Monaco's options for `settings`, with the window's word wrap and zoom. */
export function editorOptions(
  settings: EditorSettings,
  view: { wordWrap: boolean; zoom: number; readOnly: boolean; ariaLabel: string },
): monaco.editor.IStandaloneEditorConstructionOptions {
  return {
    ariaLabel: view.ariaLabel,
    readOnly: view.readOnly,
    theme: settings.theme,
    fontFamily: settings.fontFamily,
    fontSize: Math.round(settings.fontSize * view.zoom),
    lineHeight: Math.round(settings.lineHeight * view.zoom),
    tabSize: settings.tabSize,
    insertSpaces: settings.insertSpaces,
    wordWrap: view.wordWrap ? "on" : "off",
    minimap: {
      enabled: settings.minimap.enabled,
      renderCharacters: settings.minimap.renderCharacters,
      size: settings.minimap.size,
      showSlider: settings.minimap.showSlider,
    },
    lineNumbers: settings.lineNumbers,
    bracketPairColorization: { enabled: settings.bracketPairColorization },
    matchBrackets: "always",
    autoClosingBrackets: "languageDefined",
    autoIndent: "advanced",
    renderWhitespace: settings.renderWhitespace,
    renderControlCharacters: settings.renderControlCharacters,
    cursorStyle: settings.cursorStyle,
    smoothScrolling: settings.smoothScrolling,
    stickyScroll: { enabled: settings.stickyScroll },
    folding: settings.folding,
    // The window lays the editor out; Monaco follows its container's size.
    automaticLayout: true,
    // No language intelligence here (Module 10): word-based suggestions only would pretend.
    quickSuggestions: false,
    wordBasedSuggestions: "off",
    suggestOnTriggerCharacters: false,
    parameterHints: { enabled: false },
    hover: { enabled: "off" },
    // Monaco's editing menu, with the Command Palette added (see `CodeEditor`).
    contextmenu: true,
    scrollBeyondLastLine: false,
    fixedOverflowWidgets: true,
  };
}
