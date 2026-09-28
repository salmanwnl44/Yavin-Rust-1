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
  focus: () => void;
}
