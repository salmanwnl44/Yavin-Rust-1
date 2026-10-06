/**
 * Extension storage (IDE-07): one record per extension and scope, never shared.
 *
 *   global     yavin.extensions.global:<extensionId>                       {version: 1, values}
 *   workspace  yavin.extensions.workspace:<WorkspaceId>:<extensionId>      same shape
 *
 * The rules are IDE-03's, for its settings records: an unreadable record is copied to
 * `<key>.corrupt` before anything is written over it and starts empty; a record from a newer
 * Yavin is read but never written over (updates are refused); values must be JSON and the
 * record is bounded. It is not a settings system -- settings stay in the SettingsRegistry --
 * only an extension's own state, which the extension alone can reach through its context.
 */
import type { WorkspaceId } from "../terminalProtocol.ts";
import type { ExtensionMemento } from "./api.ts";
import { ExtensionError } from "./errors.ts";

export const STORAGE_VERSION = 1;
/** The most one extension may keep in one scope, as JSON. */
export const STORAGE_LIMIT = 64 * 1024;

export const globalStorageKey = (extensionId: string) => `yavin.extensions.global:${extensionId}`;
export const workspaceStorageKey = (workspace: WorkspaceId, extensionId: string) =>
  `yavin.extensions.workspace:${workspace}:${extensionId}`;

function defaultStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** A JSON value, or `undefined` when `value` is not one (a function, a cycle, a symbol...). */
function asJson(value: unknown): unknown {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function createExtensionStorage(
  storage: Storage | null = defaultStorage(),
  report: (extensionId: string, message: string) => void = () => {},
) {
  const open = (extensionId: string, key: string): ExtensionMemento => {
    let values = new Map<string, unknown>();
    let frozen = false;
    const raw = (() => {
      try {
        return storage?.getItem(key) ?? null;
      } catch {
        return null;
      }
    })();
    if (raw !== null) {
      let parsed: { version?: unknown; values?: unknown } | null = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      if (
        !parsed ||
        typeof parsed !== "object" ||
        typeof parsed.version !== "number" ||
        !parsed.values ||
        typeof parsed.values !== "object" ||
        Array.isArray(parsed.values)
      ) {
        try {
          storage?.setItem(`${key}.corrupt`, raw);
        } catch {
          /* Kept where it is, then: it is not written over below until something is stored. */
        }
        report(
          extensionId,
          `Its stored state could not be read; it starts empty (kept as ${key}.corrupt).`,
        );
      } else {
        values = new Map(Object.entries(parsed.values as Record<string, unknown>));
        if (parsed.version > STORAGE_VERSION) {
          frozen = true;
          report(extensionId, "Its stored state is from a newer Yavin: it is read, not changed.");
        }
      }
    }
    const write = () => {
      const text = JSON.stringify({ version: STORAGE_VERSION, values: Object.fromEntries(values) });
      if (text.length > STORAGE_LIMIT) return false;
      try {
        storage?.setItem(key, text);
      } catch {
        /* Storage full or blocked: the values hold for the window. */
      }
      return true;
    };
    return {
      get: <T>(name: string) => values.get(name) as T | undefined,
      keys: () => [...values.keys()],
      async update(name, value) {
        if (frozen)
          throw new ExtensionError(
            "StorageReadOnly",
            extensionId,
            "This state was written by a newer Yavin and is not changed.",
          );
        if (typeof name !== "string" || !name || name.length > 200)
          throw new ExtensionError(
            "StorageLimit",
            extensionId,
            "A key is a string of 1-200 characters.",
          );
        const previous = values.has(name) ? { value: values.get(name) } : null;
        if (value === undefined) values.delete(name);
        else {
          const json = asJson(value);
          if (json === undefined)
            throw new ExtensionError("StorageLimit", extensionId, `"${name}" is not a JSON value.`);
          values.set(name, json);
        }
        if (!write()) {
          if (previous) values.set(name, previous.value);
          else values.delete(name);
          throw new ExtensionError(
            "StorageLimit",
            extensionId,
            `Storing "${name}" would exceed ${STORAGE_LIMIT / 1024} KiB for this extension.`,
          );
        }
      },
    };
  };

  const opened = new Map<string, ExtensionMemento>();
  const memento = (extensionId: string, key: string) => {
    let found = opened.get(key);
    if (!found) opened.set(key, (found = open(extensionId, key)));
    return found;
  };
  return {
    global: (extensionId: string) => memento(extensionId, globalStorageKey(extensionId)),
    workspace: (workspace: WorkspaceId, extensionId: string) =>
      memento(extensionId, workspaceStorageKey(workspace, extensionId)),
  };
}

export type ExtensionStorage = ReturnType<typeof createExtensionStorage>;
