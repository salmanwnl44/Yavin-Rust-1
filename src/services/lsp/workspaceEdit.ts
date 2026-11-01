import type { DocumentService, TextDocument } from "../documents.ts";
import { resourceId } from "../resource.ts";
import { applyTextEdits, OverlappingEditsError } from "./positions.ts";
import type { PositionEncoding } from "./positions.ts";
import type { CreateFile, DeleteFile, RenameFile, TextEdit, WorkspaceEdit } from "./protocol.ts";
import { fromLspUri, lspPath } from "./uris.ts";

/**
 * Applying a WorkspaceEdit -- a rename, a quick fix, a server's own `workspace/applyEdit`, and
 * later AI changes and refactorings -- the one way Yavin does it.
 *
 * ```text
 * WorkspaceEdit -> check everything -> DocumentService.edit (text)      -> Module 03/04 on save
 *                                    -> host create/rename/delete file   -> Module 03/04 operations
 * ```
 *
 * Nothing here writes a file. Text edits land in the documents -- opened for the purpose when
 * they were not open -- as ordinary edits: dirty until saved, and undoable in their editors.
 * Files are created, renamed and deleted through the host's operations, which are the same
 * guarded Module 03 operations the Explorer uses.
 *
 * Everything is checked before anything is changed: every target resolves, every versioned
 * document is still at that version, no target is read-only, no edits overlap. One failure
 * refuses the whole edit (the protocol's "abort" failure handling). A file operation that fails
 * after text edits were made stops there, and says what was done.
 */

export interface WorkspaceEditHost {
  documents: DocumentService;
  /** Whether a document may be edited (a file read-only on disk may not, unless unlocked). */
  canEdit(doc: TextDocument): boolean;
  /** The open document for a URI that is not a file (`untitled:`), if any. */
  documentForUri?(uri: string): TextDocument | undefined;
  /** Opens a file that is not open yet, as a document to edit. */
  open(path: string): Promise<TextDocument>;
  /** Documents this edit changed that are not shown, so they can be (they are now unsaved). */
  reveal?(docs: readonly TextDocument[]): void;
  createFile(path: string, options: CreateFile["options"]): Promise<void>;
  renameFile(from: string, to: string, options: RenameFile["options"]): Promise<void>;
  deleteFile(path: string, options: DeleteFile["options"]): Promise<void>;
}

export interface WorkspaceEditResult {
  applied: boolean;
  failureReason?: string;
  /** Documents whose text changed. */
  changed: string[];
}

type Operation =
  | { kind: "text"; uri: string; version: number | null; edits: TextEdit[] }
  | CreateFile
  | RenameFile
  | DeleteFile;

/** The edit as an ordered list of operations, however the server spelled it. */
function operationsOf(edit: WorkspaceEdit): Operation[] {
  if (edit.documentChanges)
    return edit.documentChanges.map((change) =>
      "kind" in change
        ? change
        : {
            kind: "text" as const,
            uri: change.textDocument.uri,
            version: change.textDocument.version,
            edits: change.edits,
          },
    );
  return Object.entries(edit.changes ?? {}).map(([uri, edits]) => ({
    kind: "text" as const,
    uri,
    version: null,
    edits,
  }));
}

export async function applyWorkspaceEdit(
  edit: WorkspaceEdit,
  host: WorkspaceEditHost,
  encoding: PositionEncoding = "utf-16",
): Promise<WorkspaceEditResult> {
  const operations = operationsOf(edit);
  /** Documents opened only to check this edit; a refusal closes them again. */
  const opened: TextDocument[] = [];
  const refuse = (failureReason: string): WorkspaceEditResult => {
    for (const doc of opened)
      if (host.documents.get(doc.key) && !doc.dirty) host.documents.close(doc.key);
    return { applied: false, failureReason, changed: [] };
  };
  const find = (uri: string) => {
    const resource = fromLspUri(uri);
    if (!resource) return host.documentForUri?.(uri);
    const id = resourceId(resource);
    return host.documents.all().find((doc) => doc.uri && resourceId(doc.uri) === id);
  };

  // Files an earlier operation of this edit creates or renames into need no text yet.
  const created = new Set<string>();
  for (const operation of operations) {
    if (operation.kind === "create") created.add(operation.uri);
    if (operation.kind === "rename") created.add(operation.newUri);
  }

  // --- Check everything --------------------------------------------------------------------
  const planned = new Map<
    string,
    { doc: TextDocument | null; path: string | null; text: string | null }
  >();
  for (const operation of operations) {
    if (operation.kind !== "text") {
      const uris =
        operation.kind === "rename" ? [operation.oldUri, operation.newUri] : [operation.uri];
      for (const uri of uris) if (!lspPath(uri)) return refuse(`Cannot change ${uri}: not a file.`);
      if (operation.kind !== "create") {
        const doc = find(operation.kind === "rename" ? operation.oldUri : operation.uri);
        if (doc && !host.canEdit(doc)) return refuse(`${doc.name} is read-only.`);
        if (doc?.dirty && operation.kind === "delete")
          return refuse(`${doc.name} has unsaved changes; it is not deleted.`);
      }
      continue;
    }
    if (created.has(operation.uri) && !find(operation.uri)) {
      // Text for a file this edit creates: applied once it exists (below).
      continue;
    }
    let doc = find(operation.uri) ?? null;
    if (!doc) {
      const path = lspPath(operation.uri);
      if (!path) return refuse(`${operation.uri} is not open, and is not a file.`);
      try {
        doc = await host.open(path);
        opened.push(doc);
      } catch (error) {
        return refuse(
          `Cannot open ${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (!host.canEdit(doc)) return refuse(`${doc.name} is read-only.`);
    if (doc.source.kind === "proposed")
      return refuse(`${doc.name} is a proposal, not an editable file.`);
    if (operation.version !== null && operation.version !== doc.version)
      return refuse(
        `${doc.name} changed since the edit was made (version ${operation.version}, now ${doc.version}).`,
      );
    const before = planned.get(doc.id)?.text ?? doc.text;
    try {
      // Several operations for one document apply in turn, each to the result of the last.
      planned.set(doc.id, {
        doc,
        path: doc.path,
        text: applyTextEdits(before, operation.edits, encoding),
      });
    } catch (error) {
      if (error instanceof OverlappingEditsError)
        return refuse(`The edits to ${doc.name} overlap.`);
      throw error;
    }
  }

  // --- Apply -------------------------------------------------------------------------------
  const changed: string[] = [];
  const touched: TextDocument[] = [];
  const done = new Set<string>();
  const editText = (doc: TextDocument, text: string) => {
    if (text === doc.text) return;
    host.documents.edit(doc.key, text);
    changed.push(doc.key);
    touched.push(doc);
  };
  try {
    for (const operation of operations) {
      if (operation.kind === "create") {
        await host.createFile(lspPath(operation.uri)!, operation.options);
      } else if (operation.kind === "rename") {
        await host.renameFile(
          lspPath(operation.oldUri)!,
          lspPath(operation.newUri)!,
          operation.options,
        );
      } else if (operation.kind === "delete") {
        await host.deleteFile(lspPath(operation.uri)!, operation.options);
      } else {
        const doc = find(operation.uri) ?? null;
        if (!doc) {
          // Created by this edit a moment ago: open it and apply its text now.
          const path = lspPath(operation.uri);
          if (!path) continue;
          const fresh = await host.open(path);
          editText(fresh, applyTextEdits(fresh.text, operation.edits, encoding));
          continue;
        }
        if (done.has(doc.id)) continue;
        done.add(doc.id);
        const plan = planned.get(doc.id);
        if (plan?.text !== null && plan?.text !== undefined) editText(doc, plan.text);
      }
    }
  } catch (error) {
    host.reveal?.(touched);
    return {
      applied: false,
      failureReason: `Stopped part-way${changed.length ? ` (${changed.length} file(s) already edited)` : ""}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      changed,
    };
  }
  // Opened for the edit but left unchanged: closed again.
  for (const doc of opened)
    if (!changed.includes(doc.key) && host.documents.get(doc.key) && !doc.dirty)
      host.documents.close(doc.key);
  host.reveal?.(touched);
  return { applied: true, changed };
}
