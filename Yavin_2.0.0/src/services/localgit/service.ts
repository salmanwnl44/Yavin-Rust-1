import type {
  LocalGitBlobInfo,
  LocalGitCommit,
  LocalGitFinding,
  LocalGitInfo,
  LocalGitReflogRecord,
  LocalGitRefs,
  LocalGitTreeEntry,
} from "./types.ts";

/**
 * The window's side of Local Git for one workspace (the store itself is native:
 * `crates/ide-localgit`, reached through `src-tauri/src/localgit.rs`).
 *
 * It belongs to its `WorkspaceContext` (see `services/workspaces.ts`): opened when the workspace
 * is made, closed when it is disposed, and never used after. Every request checks, before it
 * goes and again when it answers, that its workspace is still the active one -- a late answer
 * from workspace A is dropped (`LocalGitClosedError`) rather than reaching B, and the second A
 * of A → B → A is another context with another service, which never sees the first one's work.
 *
 * LG-01 is read-only from here: open, inspect, verify. Snapshots, commits and everything that
 * writes arrive in later phases.
 */

/** The workspace context, as far as this service needs it. */
export interface LocalGitLifecycle {
  isActive(): boolean;
}

/** How native commands are called: `native()` in the app, a fake in tests. */
export type LocalGitInvoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;

/** The workspace the service belonged to was left (or the service closed). */
export class LocalGitClosedError extends Error {
  constructor() {
    super("Local Git for this workspace is closed.");
    this.name = "LocalGitClosedError";
  }
}

/** A structured native failure: `code` is the store's own (`ReadOnly`, `CorruptObject`, ...). */
export class LocalGitError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "LocalGitError";
  }
}

/** `"Code: message"`, as the native side reports failures. */
export function asLocalGitError(error: unknown): LocalGitError {
  const text = String(error);
  const match = /^([A-Za-z]+): (.*)$/s.exec(text);
  return match ? new LocalGitError(match[1], match[2]) : new LocalGitError("Unknown", text);
}

export function createLocalGitService(
  folders: readonly string[],
  lifecycle: LocalGitLifecycle,
  invoke: LocalGitInvoke,
) {
  let closed = false;
  let handle: string | null = null;
  const live = () => !closed && lifecycle.isActive();

  const opening: Promise<LocalGitInfo> = (async () => {
    if (!live()) throw new LocalGitClosedError();
    let info: LocalGitInfo;
    try {
      info = (await invoke("localgit_open", { folders: [...folders] })) as LocalGitInfo;
    } catch (error) {
      throw asLocalGitError(error);
    }
    if (!live()) {
      // Opened for a workspace that has gone: give the handle straight back.
      void invoke("localgit_close", { handle: info.handle }).catch(() => undefined);
      throw new LocalGitClosedError();
    }
    handle = info.handle;
    return info;
  })();
  // Callers see the failure through `ready` or their own calls; never an unhandled rejection.
  opening.catch(() => undefined);

  async function call<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    if (!live()) throw new LocalGitClosedError();
    await opening;
    if (!live() || !handle) throw new LocalGitClosedError();
    let result: unknown;
    try {
      result = await invoke(command, { handle, ...args });
    } catch (error) {
      if (!live()) throw new LocalGitClosedError();
      throw asLocalGitError(error);
    }
    if (!live()) throw new LocalGitClosedError();
    return result as T;
  }

  return {
    /** Resolves once the store is open (writer or read-only), with what it found on opening. */
    ready: opening,
    isClosed: () => !live(),
    info: () => call<LocalGitInfo>("localgit_info"),
    verify: (full: boolean) => call<LocalGitFinding[]>("localgit_verify", { full }),
    refs: () => call<LocalGitRefs>("localgit_refs"),
    reflog: (limit = 200) => call<LocalGitReflogRecord[]>("localgit_reflog", { limit }),
    readCommit: (id: string) => call<LocalGitCommit>("localgit_read_commit", { id }),
    readTree: (id: string) => call<LocalGitTreeEntry[]>("localgit_read_tree", { id }),
    blobInfo: (id: string) => call<LocalGitBlobInfo>("localgit_blob_info", { id }),
    readBlob: (id: string, maxBytes: number) =>
      call<ArrayBuffer>("localgit_read_blob", { id, maxBytes }),

    /** Ends the service with its workspace: pending and later calls are refused. */
    async close() {
      if (closed) return;
      closed = true;
      const open = handle ?? (await opening.then((info) => info.handle).catch(() => null));
      if (open) await invoke("localgit_close", { handle: open }).catch(() => undefined);
    },
  };
}

export type LocalGitService = ReturnType<typeof createLocalGitService>;
