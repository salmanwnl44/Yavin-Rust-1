import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * Reading and driving the code editor in UI tests.
 *
 * Monaco draws the document itself; its input element holds only what is around the caret, so
 * a textbox's value is not the document. Tests read and set the text through the editor's
 * development-only hook (`window.__yavinEditor`, see `CodeEditor.tsx`) -- which reads Monaco's
 * own model and edits it the way typing does -- and keep using the textbox, which Monaco
 * labels with the document's name, for which document is shown, focus and real typing.
 */

type Hook = {
  type(text: string): void;
  value(): string;
  length(): number;
  setValue(text: string): void;
  selections(): { start: number; end: number }[];
  setSelections(selections: { start: number; end: number }[]): void;
  scroll(): { top: number; left: number };
  setScroll(top: number, left: number): void;
  label(): string;
  hasFocus(): boolean;
  modelCount(): number;
  lineCount(): number;
  languageId(): string;
  tokenTypes(line: number): string[];
  options(): { wordWrap: string; readOnly: boolean };
};

/** Calls the hook in the page; null while no editor is shown. */
export const withEditor = <T>(page: Page, run: string, arg?: unknown): Promise<T | null> =>
  page.evaluate(
    ([body, value]) => {
      const hook = (window as unknown as { __yavinEditor?: Hook }).__yavinEditor;
      if (!hook) return null;
      return new Function("editor", "arg", `return (${body})(editor, arg);`)(hook, value);
    },
    [run, arg] as const,
  );

/** The shown document's text, as the editor holds it. */
export const editorText = (page: Page) => withEditor<string>(page, "(editor) => editor.value()");

/** Waits until the editor shows the document called `name` holding exactly `text`. */
export async function expectEditor(page: Page, name: string, text: string) {
  await expect(page.getByRole("textbox", { name, exact: true })).toBeAttached();
  await expect.poll(() => editorText(page)).toBe(text);
}

/** Waits until the shown document holds exactly `text`. */
export const expectText = (page: Page, text: string) =>
  expect.poll(() => editorText(page)).toBe(text);

export const editorOptions = (page: Page) =>
  withEditor<{ wordWrap: string; readOnly: boolean }>(page, "(editor) => editor.options()");

/** Replaces the shown document's text as one user edit (undoable, through the model bridge). */
export async function fillEditor(page: Page, text: string) {
  await expect.poll(() => withEditor(page, "(editor) => true")).toBe(true);
  await withEditor(page, "(editor, text) => editor.setValue(text)", text);
}

export const editorLength = (page: Page) => withEditor<number>(page, "(editor) => editor.length()");

export const editorSelections = (page: Page) =>
  withEditor<{ start: number; end: number }[]>(page, "(editor) => editor.selections()");

export const setEditorSelections = (page: Page, selections: { start: number; end: number }[]) =>
  withEditor(page, "(editor, s) => editor.setSelections(s)", selections);

export const editorScroll = (page: Page) =>
  withEditor<{ top: number; left: number }>(page, "(editor) => editor.scroll()");

export const setEditorScroll = (page: Page, top: number, left = 0) =>
  withEditor(page, "(editor, s) => editor.setScroll(s[0], s[1])", [top, left]);

export const editorModelCount = (page: Page) =>
  withEditor<number>(page, "(editor) => editor.modelCount()");

export const editorLanguage = (page: Page) =>
  withEditor<string>(page, "(editor) => editor.languageId()");

export const editorTokenTypes = (page: Page, line: number) =>
  withEditor<string[]>(page, "(editor, line) => editor.tokenTypes(line)", line);

/** The editor's input element for the document called `name`: focus and real typing. */
export const editorInput = (page: Page, name: string) =>
  page.getByRole("textbox", { name, exact: true });

/**
 * Yavin's own alerts (the error banner, inline errors). Monaco keeps empty live regions with
 * `role="alert"` for screen-reader announcements; they are not the application's alerts.
 */
export const appAlert = (page: Page) =>
  page.getByRole("alert").and(page.locator(":not(.monaco-alert)"));
