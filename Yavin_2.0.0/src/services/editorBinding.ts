/**
 * The editor binding: how an editor shows a document it does not own.
 *
 * The Document Model (`documents.ts`) owns the text. An editor is a view of it and a way to
 * change it, and the two directions are kept apart so that neither can feed the other:
 *
 * ```text
 * user input ──> surface.value ──> DocumentService.edit(key, value) ──> new version
 *                                                                          │
 * document event ──> showDocumentText(surface, doc.text) <─────────────────┘
 *                     (writes only if the surface does not already show that text)
 * ```
 *
 * An edit the user made is already on the surface, so when the document reports it back the
 * texts are equal and nothing is written: no second input, no loop, no timer. Anything else
 * that changed the document -- a reload from disk, a replace-in-files, Revert -- differs from
 * the surface, and is written with the caret and scroll position carried across the change.
 *
 * This file has no React in it, so both rules are tested directly.
 */

/** The part of a `<textarea>` the binding uses. */
export interface TextSurface {
  value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  scrollTop: number;
  setSelectionRange(start: number, end: number): void;
}

/**
 * Where an offset in `before` lands in `after`: unchanged before the edited span, moved with
 * the text after it, and at the end of the replacement if it was inside it. The span is the
 * part between the longest common prefix and suffix -- one pass over each end, only for a
 * change the user did not type.
 */
export function mapOffset(before: string, after: string, offset: number): number {
  const shorter = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < shorter && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (
    suffix < shorter - prefix &&
    before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  )
    suffix++;
  if (offset <= prefix) return offset;
  if (offset >= before.length - suffix) return after.length - (before.length - offset);
  return after.length - suffix;
}

/**
 * Shows `text` -- the document's -- on `surface`, if it is not already what the surface holds.
 * Returns whether it wrote. The selection and scroll position are kept across the change.
 */
export function showDocumentText(surface: TextSurface, text: string): boolean {
  const before = surface.value;
  if (before === text) return false;
  const { selectionStart, selectionEnd, scrollTop } = surface;
  surface.value = text;
  surface.setSelectionRange(
    mapOffset(before, text, selectionStart),
    mapOffset(before, text, selectionEnd),
  );
  surface.scrollTop = scrollTop;
  return true;
}
