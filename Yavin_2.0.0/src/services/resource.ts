/**
 * Resource identity: which file or folder a path refers to, and whether two paths refer to
 * the same one.
 *
 * Paths reach the UI spelled several ways -- `C:\Work\a.ts` from a dialog, `C:/Work/a.ts`
 * from the native tree, `c:/work/a.ts` from Git or a typed path, `\\?\C:\Work\a.ts` from
 * anything that went through Rust's `canonicalize`. A path is an input; a `ResourceUri` is
 * the canonical form and a `ResourceId` the comparison key. Everything that decides "is this
 * the same resource" or "is this inside that folder" should come through here rather than
 * through its own `toLowerCase()` and `startsWith`, which is how the helpers this replaced
 * came to disagree with each other.
 *
 * Everything here is lexical: nothing touches the filesystem. Physical identity -- following
 * symlinks and junctions, expanding 8.3 short names, finding the on-disk case -- is the native
 * side's job, done once when a path enters the workspace (`WorkspaceManager::validate_path`).
 * A link and its target are therefore different resources here, deliberately: the Explorer
 * shows them as different entries and Git tracks them as different paths.
 *
 * Case: a path shaped like Windows (a drive letter or a UNC share) compares case-insensitively;
 * any other path compares exactly. That is decided from the path alone so that it never needs
 * I/O and never changes between calls. It treats macOS paths as case-sensitive, which can only
 * ever keep two spellings apart, never merge two real files into one.
 */

export type ResourceErrorCode =
  "invalid-path" | "missing-base" | "unsupported-scheme" | "invalid-uri" | "outside-folder";

export class ResourceError extends Error {
  readonly code: ResourceErrorCode;
  constructor(code: ResourceErrorCode, message: string) {
    super(message);
    this.name = "ResourceError";
    this.code = code;
  }
}

/**
 * A resource, canonically spelled. Only the `file` scheme exists today.
 *
 * `authority` is the server of a UNC path (`\\server\share\a` has authority `server` and path
 * `/share/a`) and empty otherwise. `path` uses `/`, keeps the case it was given apart from an
 * uppercased drive letter, has no `.`/`..` segments and no trailing separator except at a root.
 */
export interface ResourceUri {
  readonly scheme: "file";
  readonly authority: string;
  readonly path: string;
}

/** The comparison key for a resource. Equal ids are the same resource. */
export type ResourceId = string & { readonly __resourceId: unique symbol };

const DRIVE = /^[A-Za-z]:/;

/** Whether a path is spelled the Windows way, and so compares case-insensitively. */
function windowsShaped(path: string): boolean {
  return DRIVE.test(path) || path.startsWith("//");
}

/** Separators to `/` and the extended-length prefixes removed (`\\?\C:\`, `\\?\UNC\s\sh`). */
export function unprefixed(path: string): string {
  const slashed = path.includes("\\") ? path.replace(/\\/g, "/") : path;
  if (slashed.startsWith("//?/UNC/")) return "//" + slashed.slice(8);
  if (slashed.startsWith("//?/") || slashed.startsWith("/??/")) return slashed.slice(4);
  return slashed;
}

// ---------------------------------------------------------------------------------------
// String-level comparison, for paths that are already absolute and clean.
//
// The tree, the Git decorations and the rename remapping compare paths many times per update,
// and every one of those paths came from the native side already canonical. Parsing each into
// a `ResourceUri` first would be wasted work, so these take strings. They tolerate the
// spellings that actually occur (either separator, a trailing separator, an extended-length
// prefix) but do not resolve `..`: a path with `..` in it is not a clean path, and should go
// through `fileUri` first.
// ---------------------------------------------------------------------------------------

/** The path as segments, with no trailing empty segment (`/` is `[""]`, `C:/` is `["C:"]`). */
function segments(path: string): string[] {
  const parts = unprefixed(path).split("/");
  while (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/**
 * `child` relative to `parent`: `"."` when they are the same resource, `a/b` when `child` is
 * inside, `undefined` when it is not. Compared segment by segment, so `/work/src2` is not
 * inside `/work/src`.
 */
export function relativePath(parent: string, child: string): string | undefined {
  if (!parent || !child) return undefined;
  const above = segments(parent);
  const below = segments(child);
  if (below.length < above.length) return undefined;
  const fold = windowsShaped(unprefixed(child));
  for (let index = 0; index < above.length; index++) {
    const a = above[index];
    const b = below[index];
    if (a === b) continue;
    if (!fold || a.toLowerCase() !== b.toLowerCase()) return undefined;
  }
  return below.length === above.length ? "." : below.slice(above.length).join("/");
}

/** Whether `child` is `parent` itself or lies inside it. */
export function containsPath(parent: string, child: string): boolean {
  return relativePath(parent, child) !== undefined;
}

/** Whether two clean absolute paths are the same resource. */
export function samePathString(a: string, b: string): boolean {
  return relativePath(a, b) === ".";
}

// ---------------------------------------------------------------------------------------
// ResourceUri
// ---------------------------------------------------------------------------------------

/**
 * Canonical absolute path for `input`: separators, extended-length prefix, drive-letter case,
 * repeated separators, `.` and `..` all settled. A relative `input` needs `base`; without one
 * it has no meaning, and guessing (the current directory, the workspace) is how two parts of
 * an app end up disagreeing about which file a path names.
 */
function canonicalPath(input: string, base: string | undefined): string {
  if (!input) throw new ResourceError("invalid-path", "A path is required.");
  if (input.includes("\0")) throw new ResourceError("invalid-path", "A path cannot contain NUL.");
  let path = unprefixed(input);
  if (path.startsWith("//./") || path.startsWith("//?/")) {
    throw new ResourceError("invalid-path", `Device paths are not supported: ${input}`);
  }

  let root: string;
  let rest: string;
  if (DRIVE.test(path)) {
    if (path.length > 2 && path[2] !== "/") {
      // `C:foo` means "foo in the current directory of drive C", which has no fixed meaning.
      throw new ResourceError("invalid-path", `A drive-relative path is ambiguous: ${input}`);
    }
    root = path[0].toUpperCase() + ":/";
    rest = path.slice(2);
  } else if (path.startsWith("//")) {
    const [server, share, ...tail] = path.slice(2).split("/");
    if (!server || !share) {
      throw new ResourceError("invalid-path", `A UNC path needs a server and a share: ${input}`);
    }
    root = `//${server}/${share}`;
    rest = tail.join("/");
  } else if (path.startsWith("/")) {
    root = "/";
    rest = path;
  } else {
    if (base === undefined) {
      throw new ResourceError("missing-base", `A relative path needs a base: ${input}`);
    }
    // A root base (`/`, `C:/`) already ends in a separator; adding another would turn
    // `/` + `a` into `//a`, which is a UNC path.
    return canonicalPath(base.endsWith("/") ? base + path : `${base}/${path}`, undefined);
  }

  const resolved: string[] = [];
  for (const segment of rest.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!resolved.length) {
        throw new ResourceError("invalid-path", `The path goes above its root: ${input}`);
      }
      resolved.pop();
    } else resolved.push(segment);
  }
  if (!resolved.length) return root;
  return root.endsWith("/") ? root + resolved.join("/") : `${root}/${resolved.join("/")}`;
}

function fromCanonical(path: string): ResourceUri {
  if (path.startsWith("//")) {
    const cut = path.indexOf("/", 2);
    return { scheme: "file", authority: path.slice(2, cut), path: path.slice(cut) };
  }
  return { scheme: "file", authority: "", path };
}

/**
 * The resource a filesystem path names. A relative `path` is resolved against `base`, and
 * throws `missing-base` without one. `..` is resolved lexically and may leave `base`; use
 * `resolveWithin` where leaving it must be refused.
 */
export function fileUri(path: string, base?: ResourceUri): ResourceUri {
  return fromCanonical(canonicalPath(path, base && fsPath(base)));
}

/**
 * The filesystem path, as the native side sends and accepts it: `/` separators, no
 * extended-length prefix (`C:/Work/a.ts`, `//server/share/a.ts`, `/home/me/a.ts`). This is
 * the form for IPC, persistence and anything else that already holds a path string.
 */
export function fsPath(uri: ResourceUri): string {
  return uri.authority ? `//${uri.authority}${uri.path}` : uri.path;
}

/** Whether this resource compares case-insensitively (a Windows drive or UNC path). */
export function isCaseInsensitive(uri: ResourceUri): boolean {
  return Boolean(uri.authority) || DRIVE.test(uri.path);
}

export function resourceId(uri: ResourceUri): ResourceId {
  const path = isCaseInsensitive(uri) ? uri.path.toLowerCase() : uri.path;
  return `${uri.scheme}://${uri.authority.toLowerCase()}${path}` as ResourceId;
}

export function isEqual(a: ResourceUri, b: ResourceUri): boolean {
  return resourceId(a) === resourceId(b);
}

/** `to` relative to `from`: `"."` for the same resource, `a/b` inside it, `undefined` outside. */
export function relative(from: ResourceUri, to: ResourceUri): string | undefined {
  return relativePath(fsPath(from), fsPath(to));
}

/** Whether `parent` strictly contains `child`. A resource is never its own ancestor. */
export function isAncestor(parent: ResourceUri, child: ResourceUri): boolean {
  const rel = relative(parent, child);
  return rel !== undefined && rel !== ".";
}

export function isEqualOrAncestor(parent: ResourceUri, child: ResourceUri): boolean {
  return relative(parent, child) !== undefined;
}

/** `uri` with relative `segments` appended. A segment that is itself absolute is refused. */
export function joinPath(uri: ResourceUri, ...segments: string[]): ResourceUri {
  for (const segment of segments) {
    const slashed = unprefixed(segment);
    if (slashed.startsWith("/") || DRIVE.test(slashed)) {
      throw new ResourceError("invalid-path", `Cannot join an absolute path: ${segment}`);
    }
  }
  return segments.length ? fileUri(segments.join("/"), uri) : uri;
}

/** The containing folder. A root is its own dirname. */
export function dirname(uri: ResourceUri): ResourceUri {
  const cut = uri.path.lastIndexOf("/");
  if (uri.authority) {
    // `/share` is the root of a UNC path; nothing above it is addressable.
    return cut <= 0 ? uri : { ...uri, path: uri.path.slice(0, cut) };
  }
  if (DRIVE.test(uri.path)) {
    return cut <= 2
      ? { ...uri, path: uri.path.slice(0, 3) }
      : { ...uri, path: uri.path.slice(0, cut) };
  }
  return cut <= 0 ? { ...uri, path: "/" } : { ...uri, path: uri.path.slice(0, cut) };
}

/** The last segment, or `""` for a root. */
export function basename(uri: ResourceUri): string {
  if (dirname(uri).path === uri.path) return "";
  return uri.path.slice(uri.path.lastIndexOf("/") + 1);
}

/**
 * `path` resolved against `folder`, refusing anything that would land outside it -- including
 * an absolute path elsewhere and a `..` that climbs out. Being outside some folder is not an
 * error in general (see `fileUri`); it is here, because the caller asked for a folder's child.
 */
export function resolveWithin(folder: ResourceUri, path: string): ResourceUri {
  const resolved = fileUri(path, folder);
  if (!isEqualOrAncestor(folder, resolved)) {
    throw new ResourceError("outside-folder", `${path} is outside ${fsPath(folder)}`);
  }
  return resolved;
}

// ---------------------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------------------

/** RFC 8089 form: `file:///C:/a%20b.ts`, `file://server/share/a.ts`, `file:///home/a.ts`. */
export function formatUri(uri: ResourceUri): string {
  const drive = !uri.authority && DRIVE.test(uri.path);
  const encoded = uri.path
    .split("/")
    // The drive keeps its colon, and only the drive: a POSIX folder called `a:` is encoded,
    // so that it cannot parse back as drive A.
    .map((segment, index) => (drive && index === 0 ? segment : encodeURIComponent(segment)))
    .join("/");
  return `file://${uri.authority}${drive ? "/" : ""}${encoded}`;
}

/** The inverse of `formatUri`. The result is canonical, whatever spelling it was given. */
export function parseUri(text: string): ResourceUri {
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(text);
  // A drive letter is not a one-letter scheme: `C:/a` is a path, and belongs in `fileUri`.
  if (!scheme || scheme[1].length === 1) {
    throw new ResourceError("invalid-uri", `Not a URI: ${text}`);
  }
  if (scheme[1].toLowerCase() !== "file") {
    throw new ResourceError("unsupported-scheme", `Only file: resources are supported: ${text}`);
  }
  if (!text.slice(scheme[0].length).startsWith("//")) {
    throw new ResourceError("invalid-uri", `A file URI needs an authority section: ${text}`);
  }
  const rest = text.slice(scheme[0].length + 2);
  const cut = rest.indexOf("/");
  const authority = cut === -1 ? rest : rest.slice(0, cut);
  const raw = cut === -1 ? "/" : rest.slice(cut);
  let path: string;
  try {
    path = decodeURIComponent(raw);
  } catch {
    throw new ResourceError("invalid-uri", `The URI has invalid percent-encoding: ${text}`);
  }
  // Tested before decoding: an encoded `%3A` is a POSIX name containing a colon, not a drive.
  if (/^\/[A-Za-z]:(\/|$)/.test(raw)) path = path.slice(1);
  const host = authority.toLowerCase() === "localhost" ? "" : authority;
  return fileUri(host ? `//${host}${path}` : path);
}

// ---------------------------------------------------------------------------------------
// Workspace folders
// ---------------------------------------------------------------------------------------

/**
 * One root of a workspace. There can be several: nothing here assumes a single root, even
 * though the window currently opens one.
 */
export interface WorkspaceFolder {
  readonly uri: ResourceUri;
  readonly name: string;
  readonly index: number;
}

/** The folder `uri` belongs to: the innermost one containing it, when folders nest. */
export function folderFor(
  uri: ResourceUri,
  folders: readonly WorkspaceFolder[],
): WorkspaceFolder | undefined {
  let best: WorkspaceFolder | undefined;
  for (const folder of folders) {
    if (!isEqualOrAncestor(folder.uri, uri)) continue;
    if (!best || isAncestor(best.uri, folder.uri)) best = folder;
  }
  return best;
}

/** `uri` relative to the folder it belongs to, or `undefined` when it is in none of them. */
export function relativeToFolders(
  uri: ResourceUri,
  folders: readonly WorkspaceFolder[],
): { folder: WorkspaceFolder; path: string } | undefined {
  const folder = folderFor(uri, folders);
  if (!folder) return undefined;
  return { folder, path: relative(folder.uri, uri) ?? "." };
}
