/**
 * The editor as the rest of the window drives it -- menus, the keyboard, search results --
 * without depending on the editing engine (which is loaded only when an editor is shown).
 */
export type EditorAction =
  | "undo"
  | "redo"
  | "cut"
  | "copy"
  | "paste"
  | "selectAll"
  | "selectLine"
  | "duplicate"
  | "moveLineUp"
  | "moveLineDown"
  | "copyLineUp"
  | "copyLineDown"
  | "deleteLine"
  | "toggleComment"
  | "indent"
  | "outdent"
  | "find"
  | "replace";

export interface EditorState {
  canUndo: boolean;
  canRedo: boolean;
  selected: boolean;
}

export interface EditorHandle {
  execute: (action: EditorAction) => Promise<void>;
  goToLine: (line: number) => void;
  /** Selects and shows the span between two offsets into the document's text. */
  revealRange: (start: number, end: number) => void;
  /** Selects and shows a range given in lines and columns (1-based, as the editor counts). */
  select: (range: EditorRange) => void;
  /** Runs one of the editing engine's own actions by id (Go to Definition, Rename...). */
  runAction: (id: string) => Promise<void>;
  focus: () => void;
}

export interface EditorRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

/** What the language servers give the editor: their manager, and the window's side of them. */
export interface LanguageFeatures {
  manager: import("../services/lsp/manager").LspManager;
  host: import("./lspMonaco").LanguageFeaturesHost;
}
