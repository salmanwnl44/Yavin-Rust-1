/**
 * Extension permissions (EXT-07): the capabilities an extension may ask for, what each request
 * it makes needs, and what a manifest declares -- the native side's rules
 * (`src-tauri/src/extension_permissions.rs`; both are tested against `permissions.cases.json`).
 *
 * The native side is the boundary: every request an extension makes passes its check before
 * this window sees it, against grants only it keeps. The window applies the same rules to what
 * it runs (the in-process host of the browser preview and the tests), and to explain them.
 *
 * - **Mandatory** (every extension, scoped by ownership): its own commands, views, language
 *   providers, decorations, storage and settings; messages; its configuration events.
 * - **Optional** (declared in `permissions.request`, then allowed by the user, per installed
 *   copy): `workspace.fs.read`, `documents.read`, `editor.control`, `commands.execute:<id>`.
 * - A manifest without `permissions` (made before EXT-07) is taken to request `LEGACY` when it
 *   has code, nothing when it does not -- and is allowed nothing until the user allows it.
 */
import { canonicalId, isCanonicalId } from "./identity.ts";

export const PERMISSIONS_VERSION = 1;
export const MAX_REQUESTED = 16;

export const FS_READ = "workspace.fs.read";
export const DOCUMENTS_READ = "documents.read";
export const EDITOR_CONTROL = "editor.control";
export const COMMANDS_EXECUTE = "commands.execute:";
/** What a manifest without `permissions` is taken to request (when it has code). */
export const LEGACY: readonly string[] = [DOCUMENTS_READ, EDITOR_CONTROL, FS_READ];

/** `raw` as a capability in its canonical spelling, or null. `owner` is the extension asking. */
export function capabilityOf(raw: string, owner: string): string | null {
  if (raw === FS_READ || raw === DOCUMENTS_READ || raw === EDITOR_CONTROL) return raw;
  if (!raw.startsWith(COMMANDS_EXECUTE)) return null;
  const target = canonicalId(raw.slice(COMMANDS_EXECUTE.length));
  return target && target !== owner ? `${COMMANDS_EXECUTE}${target}` : null;
}

/** Whether `capability` could have been requested by (and so granted to) extension `id`. */
export const grantable = (id: string, capability: string) =>
  isCanonicalId(id) && capabilityOf(capability, id) === capability;

export interface DeclaredPermissions {
  /** No `permissions` field: requests `LEGACY` (with code). */
  legacy: boolean;
  /** Sorted, canonical. */
  requested: string[];
}

/** A manifest's request, or why it is refused (a refused declaration rejects the extension). */
export function declaredPermissions(
  manifest: Record<string, unknown>,
  owner: string,
): { ok: true; value: DeclaredPermissions } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error });
  if (!("permissions" in manifest)) {
    const code = manifest.main !== undefined && manifest.main !== null;
    return { ok: true, value: { legacy: true, requested: code ? [...LEGACY] : [] } };
  }
  const raw = manifest.permissions;
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return fail('"permissions" must be an object: {"version": 1, "request": [...]}');
  const object = raw as Record<string, unknown>;
  const unknown = Object.keys(object).find((key) => key !== "version" && key !== "request");
  if (unknown !== undefined)
    return fail(`"permissions.${unknown}" is not part of the permission model`);
  const version = object.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0)
    return fail('"permissions.version" must be 1');
  if (version !== PERMISSIONS_VERSION)
    return fail(
      `permission model version ${version} is not supported (this Yavin reads version ${PERMISSIONS_VERSION})`,
    );
  const list = object.request;
  if (!Array.isArray(list)) return fail('"permissions.request" must be a list');
  if (list.length > MAX_REQUESTED)
    return fail(`at most ${MAX_REQUESTED} capabilities may be requested`);
  const requested = new Set<string>();
  for (const item of list) {
    if (typeof item !== "string") return fail("each requested capability is a string");
    const one = capabilityOf(item, owner);
    if (one === null) return fail(`"${item}" is not a capability this Yavin offers`);
    if (requested.has(one)) return fail(`"${item}" is requested twice`);
    requested.add(one);
  }
  // Sorted as the native side's (a byte-wise order: the capabilities are ASCII).
  return { ok: true, value: { legacy: false, requested: [...requested].sort() } };
}

export type Need =
  | { kind: "none" }
  | { kind: "capability"; capability: string }
  | { kind: "notOwned"; reason: string }
  | { kind: "invalid"; reason: string }
  | { kind: "unknown" };

const none: Need = { kind: "none" };
const needs = (capability: string): Need => ({ kind: "capability", capability });

/** The extension that owns command (or view) `id`: `<publisher>.<name>.<rest>`. */
function ownerOf(id: string): string | null {
  const first = id.indexOf(".");
  const second = first < 0 ? -1 : id.indexOf(".", first + 1);
  if (second < 0 || second === id.length - 1) return null;
  return canonicalId(id.slice(0, second));
}

function owned(
  params: Record<string, unknown>,
  name: string,
  caller: string,
  separator: string,
): Need {
  const value = params[name];
  if (typeof value !== "string") return { kind: "invalid", reason: `"${name}" must be a string` };
  return value.startsWith(`${caller}${separator}`)
    ? none
    : { kind: "notOwned", reason: `"${value}" is not ${caller}'s own` };
}

/** What receiving event `event` needs. */
export function needOfEvent(event: string): Need {
  switch (event) {
    case "configuration.changed":
      return none;
    case "documents.open":
    case "documents.change":
    case "documents.close":
    case "editor.active":
      return needs(DOCUMENTS_READ);
    default:
      return { kind: "invalid", reason: `"${event}" is not an event an extension can follow` };
  }
}

/** What request `method` from extension `caller` needs. Default deny: unlisted is `unknown`. */
export function needOfRequest(
  caller: string,
  method: string,
  params: Record<string, unknown>,
): Need {
  switch (method) {
    case "commands.register":
    case "commands.unregister":
    case "views.register":
    case "views.refresh":
    case "views.unregister":
      return owned(params, "id", caller, ".");
    case "languages.register":
    case "languages.unregister":
      return owned(params, "providerId", caller, "#");
    case "window.showMessage":
    case "storage.update":
    case "editor.setDecorations":
      return none;
    // Following an event is mandatory; receiving one is checked when it is sent (`needOfEvent`).
    case "events.subscribe": {
      if (typeof params.event !== "string")
        return { kind: "invalid", reason: '"event" must be a string' };
      const need = needOfEvent(params.event);
      return need.kind === "invalid" ? need : none;
    }
    case "commands.execute": {
      if (typeof params.id !== "string")
        return { kind: "invalid", reason: '"id" must be a string' };
      const owner = ownerOf(params.id);
      if (!owner)
        return { kind: "invalid", reason: `"${params.id}" is not an extension's command` };
      return owner === caller ? none : needs(`${COMMANDS_EXECUTE}${owner}`);
    }
    case "documents.all":
    case "documents.get":
    case "documents.getText":
    case "editor.active":
      return needs(DOCUMENTS_READ);
    case "editor.openLocation":
    case "editor.setSelection":
    case "editor.revealRange":
      return needs(EDITOR_CONTROL);
    case "fs.readFile":
    case "fs.exists":
      return needs(FS_READ);
    default:
      return { kind: "unknown" };
  }
}

/** What a capability lets an extension do, said for the user. */
export function describeCapability(capability: string): { title: string; detail: string } {
  switch (capability) {
    case FS_READ:
      return {
        title: "Read files in this workspace",
        detail: "Any file inside the open folder, such as source, configuration or .env files.",
      };
    case DOCUMENTS_READ:
      return {
        title: "Read your open documents",
        detail:
          "The text of every open document, including unsaved changes, and which documents are open.",
      };
    case EDITOR_CONTROL:
      return {
        title: "Control the editor",
        detail: "Open files, move the selection and scroll the editor.",
      };
    default:
      if (capability.startsWith(COMMANDS_EXECUTE)) {
        const target = capability.slice(COMMANDS_EXECUTE.length);
        return {
          title: `Run ${target}'s commands`,
          detail: `Run the commands of the extension ${target}, which then act with its permissions.`,
        };
      }
      return { title: capability, detail: "A capability this Yavin does not know." };
  }
}
