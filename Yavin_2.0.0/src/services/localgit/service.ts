import type { OverlaySource, ReconcileOutcome } from "./overlays.ts";
import type {
  LocalGitBlobInfo,
  LocalGitCheckpointEntry,
  LocalGitCommit,
  LocalGitCreated,
  LocalGitDiff,
  LocalGitHeadInfo,
  LocalGitHistoryPage,
  LocalGitRestorePolicy,
  LocalGitRestoreResult,
  LocalGitSignature,
  LocalGitTreeItem,
  LocalGitFinding,
  LocalGitInfo,
  LocalGitOverlayRef,
  LocalGitProgress,
  LocalGitReflogRecord,
  LocalGitRefs,
  LocalGitSnapshot,
  LocalGitSnapshotMode,
  LocalGitStatus,
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
 * LG-01 gave it open, inspect and verify; LG-02 adds snapshots and status. Unsaved documents
 * come from the overlay source the window attaches (`attachOverlays`, see `overlays.ts`): each
 * document version is sent to the native pool once, and every snapshot names the versions it
 * uses. A newer status cancels the one in flight (it rejects with code `Cancelled`). Commits
 * and everything that builds on them arrive in later phases.
 */

/** The workspace context, as far as this service needs it. */
export interface LocalGitLifecycle {
  isActive(): boolean;
}

/** How native commands are called: `native()` in the app, a fake in tests. */
export type LocalGitInvoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;

/** Native events the service listens to: `onLocalGitProgress` in the app. */
export interface LocalGitEvents {
  onProgress(handler: (progress: LocalGitProgress) => void): () => void;
}

const NO_EVENTS: LocalGitEvents = { onProgress: () => () => {} };

/** How many status entries are asked for when the caller does not say. */
export const DEFAULT_STATUS_LIMIT = 5000;

/** Who commits, as far as the window knows (a later module names people properly). */
export interface LocalGitIdentity {
  name: string;
  id: string;
}

const LOCAL_USER: LocalGitIdentity = { name: "Local user", id: "local" };

function signature(identity: LocalGitIdentity, now = new Date()): LocalGitSignature {
  return {
    name: identity.name,
    id: identity.id,
    timeMs: now.getTime(),
    // JavaScript's offset is minutes *west* of UTC; commits record minutes east.
    tzOffsetMin: -now.getTimezoneOffset(),
  };
}

/** A restore, with how the window's documents ended up after it. */
export type LocalGitRestoreOutcome = LocalGitRestoreResult & {
  /** Present once the disk may have changed (completed, failed, or not verified). */
  documents: ReconcileOutcome | null;
  /** Everything held: the disk verified as the commit, and the documents reconciled. */
  succeeded: boolean;
};

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
  events: LocalGitEvents = NO_EVENTS,
  identity: () => LocalGitIdentity = () => LOCAL_USER,
) {
  let closed = false;
  let handle: string | null = null;
  let source: OverlaySource | null = null;
  // Document versions the native pool has, by key (named) and id (untitled).
  const sent = new Map<string, number>();
  const sentUntitled = new Map<string, number>();
  let jobs = 0;
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

  /** Sends the pool what it lacks; returns the versions a snapshot should name. */
  async function syncOverlays(includeUntitled: boolean) {
    const docs = source?.overlays() ?? [];
    const untitled = includeUntitled ? (source?.untitled() ?? []) : [];
    const put = docs
      .filter((doc) => sent.get(doc.key) !== doc.version)
      .map((doc) => ({
        key: doc.key,
        path: doc.path,
        text: doc.text(),
        encoding: doc.encoding,
        lineEnding: doc.lineEnding,
        version: doc.version,
      }));
    const putUntitled = untitled
      .filter((doc) => sentUntitled.get(doc.id) !== doc.version)
      .map((doc) => ({
        id: doc.id,
        text: doc.text(),
        encoding: doc.encoding,
        lineEnding: doc.lineEnding,
        version: doc.version,
      }));
    if (put.length || putUntitled.length)
      await call("localgit_put_overlays", { overlays: put, untitled: putUntitled });
    for (const doc of put) sent.set(doc.key, doc.version);
    for (const doc of putUntitled) sentUntitled.set(doc.id, doc.version);
    // The native side forgets what a snapshot no longer names; so does this.
    for (const key of [...sent.keys()]) if (!docs.some((doc) => doc.key === key)) sent.delete(key);
    if (includeUntitled)
      for (const id of [...sentUntitled.keys()])
        if (!untitled.some((doc) => doc.id === id)) sentUntitled.delete(id);
    const refs = (entries: [string, number][]): LocalGitOverlayRef[] =>
      entries.map(([key, version]) => ({ key, version }));
    return {
      overlays: refs(docs.map((doc) => [doc.key, doc.version])),
      untitled: refs(untitled.map((doc) => [doc.id, doc.version])),
    };
  }

  /** Runs a job that names overlays; once more, resending everything, if the pool lost any. */
  async function withOverlays<T>(
    includeUntitled: boolean,
    run: (refs: { overlays: LocalGitOverlayRef[]; untitled: LocalGitOverlayRef[] }) => Promise<T>,
  ): Promise<T> {
    try {
      return await run(await syncOverlays(includeUntitled));
    } catch (error) {
      if (!(error instanceof LocalGitError) || error.code !== "OverlayMissing") throw error;
      sent.clear();
      sentUntitled.clear();
      return run(await syncOverlays(includeUntitled));
    }
  }

  const nextJob = () => `job-${++jobs}`;

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

    /** Where unsaved documents come from; returns a detach. One source at a time. */
    attachOverlays(next: OverlaySource): () => void {
      source = next;
      return () => {
        if (source === next) source = null;
      };
    },

    /**
     * A snapshot of the workspace: `persist` writes it into the store (a later phase refers to
     * it); `includeUntitled` adds untitled documents (recovery snapshots only).
     */
    snapshot(
      options: { mode?: LocalGitSnapshotMode; persist?: boolean; includeUntitled?: boolean } = {},
      jobId: string = nextJob(),
    ): Promise<LocalGitSnapshot> {
      const { mode = "auto", persist = false, includeUntitled = false } = options;
      return withOverlays(includeUntitled, (refs) =>
        call<LocalGitSnapshot>("localgit_snapshot", { jobId, mode, persist, ...refs }),
      );
    },

    /** Status against Local HEAD, on disk and with the unsaved documents. */
    status(
      options: { mode?: LocalGitSnapshotMode; limit?: number } = {},
      jobId: string = nextJob(),
    ): Promise<{ snapshot: LocalGitSnapshot; status: LocalGitStatus }> {
      const { mode = "auto", limit = DEFAULT_STATUS_LIMIT } = options;
      return withOverlays(false, (refs) =>
        call<{ snapshot: LocalGitSnapshot; status: LocalGitStatus }>("localgit_status", {
          jobId,
          mode,
          overlays: refs.overlays,
          limit,
        }),
      );
    },

    /** Captures the workspace, unsaved documents included, without moving HEAD. */
    checkpoint(
      options: { message?: string; includeUntitled?: boolean } = {},
      jobId: string = nextJob(),
    ) {
      const { message = null, includeUntitled = false } = options;
      return withOverlays(includeUntitled, (refs) =>
        call<LocalGitCreated & { snapshot: LocalGitSnapshot }>("localgit_checkpoint", {
          jobId,
          message,
          ...refs,
          by: signature(identity()),
        }),
      );
    },

    /**
     * A commit on top of HEAD, which moves to it: of the workspace now (unsaved documents
     * included), or of a checkpoint already taken (`fromCheckpoint`: nothing is scanned).
     */
    commit(
      message: string,
      options: { fromCheckpoint?: string } = {},
      jobId: string = nextJob(),
    ): Promise<LocalGitCreated> {
      return withOverlays(false, (refs) =>
        call<LocalGitCreated>("localgit_commit", {
          jobId,
          message,
          fromCheckpoint: options.fromCheckpoint ?? null,
          overlays: refs.overlays,
          by: signature(identity()),
        }),
      );
    },

    head: () => call<LocalGitHeadInfo>("localgit_head"),
    /** Newest first, along first parents; pass `next` back as the cursor. */
    history: (options: { cursor?: string | null; limit?: number } = {}) =>
      call<LocalGitHistoryPage>("localgit_history", {
        cursor: options.cursor ?? null,
        limit: options.limit ?? 100,
      }),
    checkpoints: (limit = 100) =>
      call<LocalGitCheckpointEntry[]>("localgit_checkpoints", { limit }),
    tree: (commit: string, path = "", folderId: string | null = null) =>
      call<LocalGitTreeItem[]>("localgit_tree", { commit, folderId, path }),
    diffCommits: (from: string | null, to: string, options: { lineDiffs?: boolean } = {}) =>
      call<LocalGitDiff>("localgit_diff_commits", {
        from,
        to,
        lineDiffs: options.lineDiffs ?? true,
      }),
    /** A commit (or HEAD) against the workspace as the user has it. Saves nothing. */
    diffWorkspace(
      options: { from?: string | null; lineDiffs?: boolean } = {},
      jobId: string = nextJob(),
    ) {
      return withOverlays(false, (refs) =>
        call<{ snapshot: LocalGitSnapshot; diff: LocalGitDiff }>("localgit_diff_workspace", {
          jobId,
          from: options.from ?? null,
          overlays: refs.overlays,
          lineDiffs: options.lineDiffs ?? true,
        }),
      );
    },

    /**
     * Makes the workspace match a commit (or one path of it). Refused, untouched, when a
     * document with unsaved changes would be overwritten or deleted, unless `policy` is
     * `replaceDocument`. After the disk changes, the window's documents are reconciled through
     * DocumentService, and `succeeded` says whether everything held.
     */
    async restore(
      commit: string,
      options: {
        path?: string;
        folderId?: string;
        policy?: LocalGitRestorePolicy;
        dryRun?: boolean;
      } = {},
      jobId: string = nextJob(),
    ): Promise<LocalGitRestoreOutcome> {
      const { path = null, folderId = null, policy = "refuseIfDirty", dryRun = false } = options;
      const result = await withOverlays(false, (refs) =>
        call<LocalGitRestoreResult>("localgit_restore", {
          jobId,
          commit,
          folderId,
          path,
          policy,
          dryRun,
          overlays: refs.overlays,
          by: signature(identity()),
        }),
      );
      const changed =
        result.status === "completed" ||
        result.status === "failed" ||
        result.status === "verificationFailed";
      if (!changed || !source?.reconcileRestore)
        return { ...result, documents: null, succeeded: result.status === "completed" };
      const opened = await opening;
      const root = (folder: string) =>
        opened.folders.find((f) => f.folderId === folder)?.path ?? null;
      const absolute = (folder: string, rel: string) => {
        const base = root(folder);
        return base === null ? null : `${base.replace(/[\\/]+$/, "")}/${rel}`;
      };
      const done =
        result.status === "failed"
          ? result.plan.operations.slice(0, result.applied)
          : result.plan.operations;
      const changes = done.flatMap((op) => {
        const path = absolute(op.folderId, op.path);
        if (path === null || op.kind === "createDirectory" || op.kind === "removeDirectory")
          return [];
        const removed = op.kind === "removeFile" || op.kind === "removeLink";
        const kind: "created" | "modified" | "deleted" = removed
          ? "deleted"
          : op.expected.kind === "absent"
            ? "created"
            : "modified";
        return [{ kind, path }];
      });
      const replace = result.plan.documents.flatMap((doc) => {
        const path = absolute(doc.folderId, doc.path);
        return path === null ? [] : [{ path, action: doc.action }];
      });
      const documents = await source.reconcileRestore({ changes, replace });
      if (!live()) throw new LocalGitClosedError();
      return {
        ...result,
        documents,
        succeeded: result.status === "completed" && documents.ok,
      };
    },

    /** Stops a snapshot or status of this service (it rejects with code `Cancelled`). */
    cancel: (jobId: string) => call<void>("localgit_cancel", { jobId }),

    /** This service's jobs' progress, while its workspace is the active one. */
    onProgress(listener: (progress: LocalGitProgress) => void): () => void {
      return events.onProgress((progress) => {
        if (live() && handle !== null && progress.handle === handle) listener(progress);
      });
    },

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
