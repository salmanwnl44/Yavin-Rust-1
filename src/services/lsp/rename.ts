/**
 * Basic request-safety validation of a new symbol name, before a `textDocument/rename` request is
 * sent (WS18).
 *
 * Yavin does not invent language-specific naming rules -- the language server is the authority on
 * what a valid identifier is in its language, and it rejects a bad one. But a name that is empty,
 * only whitespace, or spans lines is never a valid rename in any language, so Yavin refuses it
 * here rather than issuing a request that cannot succeed: no server sees a hopeless request, and
 * the document is left untouched.
 */
export function isValidRenameName(name: unknown): name is string {
  if (typeof name !== "string") return false;
  if (name.trim().length === 0) return false;
  if (/[\r\n]/.test(name)) return false;
  return true;
}
