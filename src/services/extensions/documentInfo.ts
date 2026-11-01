/**
 * A document as extensions are told about it (IDE-08): its URI and canonical resource, its
 * language, version, where it comes from and whether it is dirty -- never its object. Text is
 * asked for separately (`documents.getText`), bounded.
 */
import type { TextDocument } from "../documents.ts";
import { formatUri, resourceId, type ResourceId } from "../resource.ts";
import type { DocumentInfo } from "./window.ts";

export function documentInfoOf(doc: TextDocument): DocumentInfo {
  return {
    uri: doc.uri ? formatUri(doc.uri) : doc.id,
    resourceId: doc.uri ? resourceId(doc.uri) : (doc.id as unknown as ResourceId),
    languageId: doc.languageId,
    version: doc.version,
    source: doc.source.kind,
    dirty: doc.dirty,
  };
}
