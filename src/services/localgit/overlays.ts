import { encode } from "../documents.ts";
import type { DocumentEvent, TextDocument } from "../documents.ts";
import { fileUri, isAncestor, isEqual } from "../resource.ts";
import type { ResourceChange } from "../resourceEvents.ts";

/**
 * Which unsaved documents a Local Git snapshot applies over the disk (its "effective root").
 *
 * It reads DocumentService and never changes it: nothing here saves, writes or edits. A
 * document takes part when it is a named file (`source: disk`) inside one of the workspace's
 * folders and has unsaved changes -- including one whose file was deleted on disk. Proposed
 * (AI) documents never do, nor do documents outside the workspace. Untitled documents take part
 * only in recovery snapshots, which ask for them.
 *
 * What a snapshot receives is the document as saving would write it: DocumentService's own
 * `encode` (its line endings and byte order mark), encoded once per document version however
 * many snapshots use it.
 */

/** What the tracker needs of DocumentService (its public API; nothing else). */
export interface OverlayDocuments {
  all(): TextDocument[];
  subscribe(listener: (event: DocumentEvent) => void): () => void;
  /** Replaces a document with its file; `discard` only by the user's explicit choice. */
  reload?(key: string, options?: { discard?: boolean }): Promise<unknown>;
  close?(key: string, options?: { discard?: boolean }): void;
  /** What changed on disk, checked against every open document. */
  applyResourceChanges?(changes: readonly ResourceChange[]): Promise<void>;
}

/** What a restore changed on disk and which documents it was told to replace (absolute paths). */
export interface RestoredPaths {
  changes: ResourceChange[];
  /** Documents whose unsaved changes the user chose to discard (policy `replaceDocument`). */
  replace: { path: string; action: "overwrite" | "delete" }[];
}

/** How the window's documents ended up after a restore. */
export interface ReconcileOutcome {
  /** Every document the restore touched now shows the disk. */
  ok: boolean;
  reloaded: string[];
  closed: string[];
  failed: { path: string; error: string }[];
}

export interface OverlayDocument {
  /** DocumentService's key: the document's identity for the native overlay pool. */
  key: string;
  path: string;
  version: number;
  encoding: string;
  lineEnding: string;
  /** The text saving would write; computed on first use. */
  text(): string;
}

export interface UntitledDocument {
  id: string;
  version: number;
  encoding: string;
  lineEnding: string;
  text(): string;
}

export interface OverlaySource {
  /** The unsaved named documents inside the workspace, now. */
  overlays(): OverlayDocument[];
  /** Every untitled document, now (for recovery snapshots only). */
  untitled(): UntitledDocument[];
  /** After a restore: brings the documents in line with the disk, through DocumentService. */
  reconcileRestore?(restored: RestoredPaths): Promise<ReconcileOutcome>;
}

export interface OverlayTracker extends OverlaySource {
  dispose(): void;
}

export function createOverlayTracker(
  documents: OverlayDocuments,
  folders: readonly string[],
): OverlayTracker {
  const roots = folders.map((folder) => fileUri(folder));
  const inWorkspace = (doc: TextDocument) =>
    doc.uri !== null && roots.some((root) => isAncestor(root, doc.uri!));
  const encoded = new Map<string, { version: number; text: string }>();
  const encodedOnce = (key: string, doc: TextDocument) => {
    const known = encoded.get(key);
    if (known?.version === doc.version) return known.text;
    const text = encode(doc.text, doc.encoding, doc.lineEnding);
    encoded.set(key, { version: doc.version, text });
    return text;
  };
  // A closed or renamed document's encodings are no longer anyone's.
  const unsubscribe = documents.subscribe((event) => {
    if (event.type === "closed") encoded.delete(event.key);
    if (event.type === "sourceChanged") encoded.delete(event.previousKey);
  });

  return {
    overlays: () =>
      documents
        .all()
        .filter(
          (doc) => doc.source.kind === "disk" && doc.path !== null && doc.dirty && inWorkspace(doc),
        )
        .map((doc) => ({
          key: doc.key,
          path: doc.path!,
          version: doc.version,
          encoding: doc.encoding,
          lineEnding: doc.lineEnding,
          text: () => encodedOnce(doc.key, doc),
        })),
    untitled: () =>
      documents
        .all()
        .filter((doc) => doc.source.kind === "untitled")
        .map((doc) => ({
          id: doc.id,
          version: doc.version,
          encoding: doc.encoding,
          lineEnding: doc.lineEnding,
          text: () => encodedOnce(doc.id, doc),
        })),
    async reconcileRestore(restored) {
      const outcome: ReconcileOutcome = { ok: true, reloaded: [], closed: [], failed: [] };
      const open = (path: string) =>
        documents.all().find((doc) => doc.uri !== null && isEqual(doc.uri, fileUri(path)));
      const fail = (path: string, error: unknown) => {
        outcome.ok = false;
        outcome.failed.push({
          path,
          error: String(error instanceof Error ? error.message : error),
        });
      };
      // First what the user chose to replace: their unsaved changes go, by that choice.
      for (const { path, action } of restored.replace) {
        const doc = open(path);
        if (!doc) continue;
        try {
          if (action === "delete") {
            documents.close?.(doc.key, { discard: true });
            outcome.closed.push(path);
          } else {
            await documents.reload?.(doc.key, { discard: true });
            outcome.reloaded.push(path);
          }
        } catch (error) {
          fail(path, error);
        }
      }
      // Then every change, checked against every open document (clean ones follow the disk).
      try {
        await documents.applyResourceChanges?.(restored.changes);
      } catch (error) {
        fail("", error);
      }
      // Confirmed, not assumed: a restored file's open document shows the disk now.
      for (const change of restored.changes) {
        const doc = open(change.path);
        if (!doc || change.kind === "deleted") continue;
        if (doc.dirty || doc.external)
          fail(change.path, "the open document does not show the restored file");
      }
      return outcome;
    },
    dispose: unsubscribe,
  };
}
