import type { monaco } from "./monaco";
import { DEFAULT_MINIMAP } from "../services/minimapPreferences.ts";
import type { MinimapPreferences } from "../services/minimapPreferences.ts";
import {
  booleanSetting,
  enumSetting,
  numberSetting,
  stringSetting,
  type SettingDefinition,
  type SettingsRegistry,
} from "../services/settings/settings.ts";
import type { WorkspaceId } from "../services/terminalProtocol.ts";

/**
 * The editor's settings, in one place. The ones a user chooses are settings (IDE-03, below),
 * kept and resolved by the settings registry and applied here; the rest are the editor's own
 * fixed choices. The minimap is remembered by its own menu (`minimapPreferences.ts`).
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

// --- Settings (IDE-03) --------------------------------------------------------------------------

const SECTION = "Editor";

/** The editor's user-facing settings: the editor defines them, and applies what they resolve to. */
export const EDITOR_SETTINGS = {
  fontFamily: stringSetting({
    id: "editor.fontFamily",
    title: "Font family",
    description: "The editor's font, as a CSS font-family list.",
    section: SECTION,
    default: DEFAULT_EDITOR_SETTINGS.fontFamily,
    maxLength: 300,
  }),
  fontSize: numberSetting({
    id: "editor.fontSize",
    title: "Font size",
    description: "In pixels, before zoom. Lines grow with it.",
    section: SECTION,
    default: DEFAULT_EDITOR_SETTINGS.fontSize,
    min: 6,
    max: 48,
    integer: true,
  }),
  tabSize: numberSetting({
    id: "editor.tabSize",
    title: "Tab size",
    description: "How many columns a tab takes.",
    section: SECTION,
    default: DEFAULT_EDITOR_SETTINGS.tabSize,
    min: 1,
    max: 16,
    integer: true,
  }),
  insertSpaces: booleanSetting({
    id: "editor.insertSpaces",
    title: "Insert spaces",
    description: "Pressing Tab inserts spaces instead of a tab character.",
    section: SECTION,
    default: DEFAULT_EDITOR_SETTINGS.insertSpaces,
  }),
  lineNumbers: enumSetting({
    id: "editor.lineNumbers",
    title: "Line numbers",
    description: "How lines are numbered in the gutter.",
    section: SECTION,
    default: DEFAULT_EDITOR_SETTINGS.lineNumbers,
    options: [
      { value: "on", label: "On" },
      { value: "relative", label: "Relative" },
      { value: "off", label: "Off" },
    ],
  }),
  wordWrap: booleanSetting({
    id: "editor.wordWrap",
    title: "Word wrap",
    description: "Long lines wrap at the editor's width (View › Word Wrap).",
    section: SECTION,
    default: false,
  }),
  theme: enumSetting({
    id: "editor.theme",
    title: "Theme",
    description: "The editor's colour theme.",
    section: SECTION,
    default: DEFAULT_EDITOR_SETTINGS.theme,
    options: [
      { value: "yavin-dark", label: "Yavin Dark" },
      { value: "yavin-light", label: "Yavin Light" },
    ],
  }),
  zoom: numberSetting({
    id: "editor.zoom",
    title: "Zoom",
    description: "Scales the editor's text (View › Zoom In / Zoom Out / Reset Zoom).",
    section: SECTION,
    default: 1,
    min: 0.7,
    max: 2,
    step: 0.1,
    // The window's zoom: one for the user, not one per folder.
    scopes: ["user"],
  }),
};

/** Every editor setting, for the registry. */
export const EDITOR_SETTING_LIST: readonly SettingDefinition<unknown>[] =
  Object.values(EDITOR_SETTINGS);

/** Lines are this much taller than the font, as the original 13 px / 22 px pairing was. */
const LINE_HEIGHT_RATIO = 22 / 13;

/** What the editor shows, as the settings resolve for `workspace`. */
export interface ResolvedEditorSettings {
  settings: EditorSettings;
  wordWrap: boolean;
  zoom: number;
}

export function resolveEditorSettings(
  registry: SettingsRegistry,
  workspace: WorkspaceId | null,
  minimap: MinimapPreferences = DEFAULT_MINIMAP,
): ResolvedEditorSettings {
  const get = <T>(definition: SettingDefinition<T>) => registry.get(definition, workspace);
  const fontSize = get(EDITOR_SETTINGS.fontSize);
  return {
    settings: {
      ...DEFAULT_EDITOR_SETTINGS,
      fontFamily: get(EDITOR_SETTINGS.fontFamily),
      fontSize,
      lineHeight: Math.round(fontSize * LINE_HEIGHT_RATIO),
      tabSize: get(EDITOR_SETTINGS.tabSize),
      insertSpaces: get(EDITOR_SETTINGS.insertSpaces),
      lineNumbers: get(EDITOR_SETTINGS.lineNumbers),
      theme: get(EDITOR_SETTINGS.theme),
      minimap,
    },
    wordWrap: get(EDITOR_SETTINGS.wordWrap),
    zoom: get(EDITOR_SETTINGS.zoom),
  };
}

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
    // Language intelligence comes from language servers (`lspMonaco.ts`); with none for a
    // document these show nothing. Word-based suggestions would pretend to be one, so no.
    quickSuggestions: { other: true, comments: false, strings: false },
    wordBasedSuggestions: "off",
    suggestOnTriggerCharacters: true,
    parameterHints: { enabled: true },
    hover: { enabled: "on", delay: 300 },
    formatOnType: true,
    // Problems show in read-only files too (Monaco's default hides them there).
    renderValidationDecorations: "on",
    inlayHints: { enabled: "on" },
    codeLens: true,
    links: true,
    "semanticHighlighting.enabled": true,
    lightbulb: { enabled: "on" as never },
    // Several definitions: go to the first; the peek view cannot show files that are not open.
    gotoLocation: { multiple: "goto", multipleReferences: "goto" },
    // Monaco's editing menu, with the Command Palette added (see `CodeEditor`).
    contextmenu: true,
    scrollBeyondLastLine: false,
    fixedOverflowWidgets: true,
  };
}
