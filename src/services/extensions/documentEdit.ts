/**
 * An extension's edit to an open document (EXT-25 `documents.edit`; moved here from `App.tsx` at
 * EXT-27 so that it is tested): text edits with 1-based ranges, applied as one change through the
 * document service -- the same path a language server's edit takes, so the editor shows it as one
 * undoable step and the document is unsaved until the user saves it.
 *
 * Refused (false, nothing changed) when the document is not at `version` any more (null: any),
 * is a proposal, is read-only and not unlocked for editing, or when the edits overlap.
 */
import type { DocumentService, TextDocument } from "../documents.ts";
import { applyTextEdits } from "../lsp/positions.ts";
import type { ExtensionTextEdit } from "./window.ts";

export function applyExtensionEdit(
  documents: Pick<DocumentService, "edit">,
  doc: TextDocument | undefined,
  version: number | null,
  edits: readonly ExtensionTextEdit[],
  mayEditReadOnly: (doc: TextDocument) => boolean = () => false,
): boolean {
  if (!doc || doc.source.kind === "proposed") return false;
  if (version !== null && doc.version !== version) return false;
  if (doc.readOnly && !mayEditReadOnly(doc)) return false;
  let next: string;
  try {
    next = applyTextEdits(
      doc.text,
      edits.map((edit) => ({
        range: {
          start: { line: edit.range.startLine - 1, character: edit.range.startColumn - 1 },
          end: { line: edit.range.endLine - 1, character: edit.range.endColumn - 1 },
        },
        newText: edit.text,
      })),
    );
  } catch {
    return false; // overlapping edits
  }
  documents.edit(doc.key, next);
  return true;
}
