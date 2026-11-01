/**
 * The extension protocol, Yavin's side (IDE-08): what the extension host process sends, as
 * Yavin accepts it. The host's side is `src-tauri/crates/ide-plugin-host` (`protocol.rs`,
 * `bootstrap.js`). Every message is a JSON object, at most `MAX_MESSAGE`, and every message
 * about an extension carries the extension's id, the workspace and the host generation -- a
 * message for another workspace or an earlier host is rejected here, never applied.
 *
 * Yavin → host: `init`, `load`, `unload`, `request` (activate, deactivate, command.run,
 * view.items, provider.invoke), `response` (answers to the host's requests), `event`, `shutdown`.
 * Host → Yavin: `ready`, `loaded`, `unloaded`, `request` (API calls), `response`, `log`, `error`.
 */

export const MAX_MESSAGE = 1024 * 1024;

export interface HostIdentity {
  workspaceId: string;
  hostGeneration: number;
}

export interface ProtocolError {
  code: string;
  message: string;
}

export type HostMessage =
  | { type: "ready" }
  | { type: "loaded" | "unloaded"; extensionId: string }
  | {
      type: "request";
      extensionId: string;
      requestId: string;
      method: string;
      params: unknown;
    }
  | {
      type: "response";
      extensionId: string;
      requestId: string;
      ok: boolean;
      result?: unknown;
      error?: ProtocolError;
    }
  | { type: "log"; extensionId: string; level: "info" | "warn" | "error"; text: string }
  | { type: "error"; extensionId: string | null; error: ProtocolError };

const EXTENSION_ID = /^[a-z0-9][a-z0-9-]{0,49}\.[a-z0-9][a-z0-9-]{0,49}$/;
export const isExtensionId = (value: unknown): value is string =>
  typeof value === "string" && EXTENSION_ID.test(value);

const protocolError = (value: unknown): ProtocolError => {
  const raw = (value ?? {}) as Record<string, unknown>;
  return {
    code: typeof raw.code === "string" ? raw.code.slice(0, 60) : "HostError",
    message:
      typeof raw.message === "string" ? raw.message.slice(0, 2000) : "The host reported an error.",
  };
};

/**
 * A host message, or why it is refused: not JSON, too large, of an unknown type, or about
 * another workspace or host generation (stale).
 */
export function readHostMessage(
  text: string,
  identity: HostIdentity,
): { ok: true; message: HostMessage } | { ok: false; reason: string; stale?: boolean } {
  if (text.length > MAX_MESSAGE) return { ok: false, reason: `a message of ${text.length} bytes` };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "not JSON" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { ok: false, reason: "not an object" };
  const type = raw.type;
  if (type === "ready") return { ok: true, message: { type: "ready" } };
  // Errors not about one extension (a malformed message, a stale one) carry no identity.
  if (type === "error" && raw.extensionId === undefined)
    return {
      ok: true,
      message: { type: "error", extensionId: null, error: protocolError(raw.error) },
    };
  if (raw.workspaceId !== identity.workspaceId || raw.hostGeneration !== identity.hostGeneration)
    return { ok: false, reason: "for another workspace or host generation", stale: true };
  if (!isExtensionId(raw.extensionId)) return { ok: false, reason: "no valid extension id" };
  const extensionId = raw.extensionId;
  switch (type) {
    case "loaded":
    case "unloaded":
      return { ok: true, message: { type, extensionId } };
    case "request":
      if (typeof raw.requestId !== "string" || raw.requestId.length > 40)
        return { ok: false, reason: "a request without an id" };
      if (typeof raw.method !== "string" || raw.method.length > 60)
        return { ok: false, reason: "a request without a method" };
      return {
        ok: true,
        message: {
          type,
          extensionId,
          requestId: raw.requestId,
          method: raw.method,
          params: raw.params ?? null,
        },
      };
    case "response":
      if (typeof raw.requestId !== "string")
        return { ok: false, reason: "a response without an id" };
      return {
        ok: true,
        message: {
          type,
          extensionId,
          requestId: raw.requestId,
          ok: raw.ok === true,
          result: raw.result,
          error: raw.ok === true ? undefined : protocolError(raw.error),
        },
      };
    case "log":
      return {
        ok: true,
        message: {
          type,
          extensionId,
          level: raw.level === "warn" || raw.level === "error" ? raw.level : "info",
          text: typeof raw.text === "string" ? raw.text.slice(0, 4000) : "",
        },
      };
    case "error":
      return { ok: true, message: { type, extensionId, error: protocolError(raw.error) } };
    default:
      return { ok: false, reason: `an unknown message type ${JSON.stringify(type).slice(0, 40)}` };
  }
}

/** A message to the host, refused here when it is too large (the host enforces the same). */
export function writeHostMessage(message: Record<string, unknown>): string {
  const text = JSON.stringify(message);
  if (text.length > MAX_MESSAGE)
    throw Object.assign(new Error(`A message of ${text.length} bytes is over the limit.`), {
      code: "MessageTooLarge",
    });
  return text;
}
