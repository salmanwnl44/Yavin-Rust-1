/**
 * The one extension id rule (EXT-02), the same as the native side's
 * (`crates/ide-workspace/src/extension_id.rs`; both are tested against `identity.cases.json`).
 *
 * An id is `publisher.name`; each part is 1 to 50 of `a-z`, `0-9` and `-`, not starting with
 * `-`. Ids compare case-insensitively: `canonicalId` folds ASCII upper case only. A manifest's
 * own id must already be canonical; ids Yavin is asked about are folded first.
 */

/** The longest part of an id. */
export const MAX_ID_PART = 50;
/** One part of an id: a publisher or a name. */
export const ID_PART = /^[a-z0-9][a-z0-9-]{0,49}$/;

/** Whether `id` is an id in its canonical (lower-case) form. */
export function isCanonicalId(id: string): boolean {
  const dot = id.indexOf(".");
  return dot > 0 && ID_PART.test(id.slice(0, dot)) && ID_PART.test(id.slice(dot + 1));
}

/** `raw` as a canonical id, or null when it is not an id. */
export function canonicalId(raw: string): string | null {
  const folded = raw.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  return isCanonicalId(folded) ? folded : null;
}
