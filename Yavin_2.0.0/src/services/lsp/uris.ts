import { formatUri, fsPath, parseUri, resourceId } from "../resource.ts";
import type { ResourceId, ResourceUri } from "../resource.ts";

/**
 * The one place a Yavin resource becomes an LSP URI and back.
 *
 * ```text
 * ResourceUri (resource.ts) <-> LSP URI (here) ;  ResourceUri <-> Monaco URI (monacoHost.ts)
 * ```
 *
 * Yavin writes RFC 8089 URIs (`file:///C:/My%20Project/a.ts`). Servers answer in their own
 * spelling -- VS Code's libraries encode the drive's colon and lower its letter
 * (`file:///c%3A/My%20Project/a.ts`), others leave spaces or Unicode unencoded -- so a URI from a
 * server is always parsed back to a `ResourceUri` and compared by `ResourceId`, never as a
 * string. `resource.ts` would read `/c%3A/...` as a POSIX folder named `c:` (that is correct for
 * a POSIX path, and why the drive form is recognized here, where only a drive can mean it).
 */

/** The URI to send a server for a resource. */
export function toLspUri(uri: ResourceUri): string {
  return formatUri(uri);
}

/** The resource a server's URI names, or null for anything that is not a file. */
export function fromLspUri(text: string): ResourceUri | null {
  // An encoded drive colon, in the form VS Code's `vscode-uri` writes: `file:///c%3A/...`.
  const drive = /^file:\/\/\/([A-Za-z])%3[Aa](\/|$)/.exec(text);
  const spelled = drive
    ? `file:///${drive[1]}:${text.slice(drive[0].length - drive[2].length)}`
    : text;
  try {
    return parseUri(spelled);
  } catch {
    return null;
  }
}

/** The comparison key of a server's URI, or null when it is not a file. */
export function lspResourceId(text: string): ResourceId | null {
  const uri = fromLspUri(text);
  return uri ? resourceId(uri) : null;
}

/** The native path of a server's URI, for opening it; null when it is not a file. */
export function lspPath(text: string): string | null {
  const uri = fromLspUri(text);
  return uri ? fsPath(uri) : null;
}
