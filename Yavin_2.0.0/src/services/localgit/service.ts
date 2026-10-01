import type { OverlaySource, ReconcileOutcome } from "./overlays.ts";
import type {
  LocalGitBlobInfo,
  LocalGitBranch,
  LocalGitAiCommitResult,
  LocalGitAiPath,
  LocalGitAiRun,
  LocalGitAiUndoResult,
  LocalGitOperationResult,
  LocalGitOperationState,
  LocalGitResolveChoice,
  LocalGitResetMode,
  LocalGitResetPolicy,
  LocalGitResetResult,
  LocalGitRevertResult,
  LocalGitStashApplyResult,
  LocalGitStashList,
  LocalGitStashPushResult,
  LocalGitTarget,
  LocalGitCheckpointEntry,
  LocalGitIndexInfo,
  LocalGitPath,
  LocalGitRestorePlan,
  LocalGitStageResult,
  LocalGitSwitchResult,
  LocalGitTag,
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

/** An operation that may have changed the disk, with how the documents ended up after it. */
export type WithDocuments<T> = T & {
  documents: ReconcileOutcome | null;
  /** Everything held: the disk verified, the refs moved, the documents reconciled. */
  succeeded: boolean;
};

/** A switch, with how the window's documents ended up after it. */
export type LocalGitSwitchOutcome = LocalGitSwitchResult & {
  documents: ReconcileOutcome | null;
  /** The disk verified, HEAD and the index moved, and the documents reconciled. */
  succeeded: boolean;
};

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

  const normalPath = (p: LocalGitPath) => ({ folderId: p.folderId ?? null, path: p.path });

  const report = (
    agentRunId: string,
    event: "started" | "validated" | "failed" | "cancelled",
    detail: { passed?: boolean; reference?: string; note?: string } = {},
  ) =>
    call<LocalGitAiRun>("localgit_ai_report", {
      agentRunId,
      event,
      passed: detail.passed ?? null,
      reference: detail.reference ?? null,
      note: detail.note ?? null,
    });

  const targetArg = (target: LocalGitTarget) =>
    "commit" in target
      ? { kind: "commit" as const, value: target.commit }
      : "branch" in target
        ? { kind: "branch" as const, value: target.branch }
        : { kind: "tag" as const, value: target.tag };

  /** Reconciles the documents after an operation that may have changed the disk. */
  async function afterDisk<T extends { status: string; applied: number }>(
    result: T,
    plan: LocalGitRestorePlan | null,
  ): Promise<WithDocuments<T>> {
    const changed =
      plan !== null &&
      plan.operations.length + plan.documents.length > 0 &&
      (result.status === "completed" ||
        result.status === "failed" ||
        result.status === "verificationFailed");
    if (!changed || !source?.reconcileRestore)
      return { ...result, documents: null, succeeded: result.status === "completed" };
    const documents = await reconcile(plan!, result.status === "failed" ? result.applied : null);
    return { ...result, documents, succeeded: result.status === "completed" && documents.ok };
  }

  async function applyStash(id: string, pop: boolean, jobId: string) {
    const result = await withOverlays(false, (refs) =>
      call<LocalGitStashApplyResult>("localgit_stash_apply", {
        jobId,
        id,
        pop,
        overlays: refs.overlays,
      }),
    );
    return afterDisk(result, result.plan.restore);
  }

  /**
   * After the disk changed (a restore or a switch): the window's documents brought in line
   * through DocumentService (`OverlaySource.reconcileRestore`). `applied` limits it to the
   * operations that were done, when the change stopped partway.
   */
  async function reconcile(plan: LocalGitRestorePlan, applied: number | null) {
    const opened = await opening;
    const root = (folder: string) =>
      opened.folders.find((f) => f.folderId === folder)?.path ?? null;
    const absolute = (folder: string, rel: string) => {
      const base = root(folder);
      return base === null ? null : `${base.replace(/[\\/]+$/, "")}/${rel}`;
    };
    const done = applied === null ? plan.operations : plan.operations.slice(0, applied);
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
    const replace = plan.documents.flatMap((doc) => {
      const path = absolute(doc.folderId, doc.path);
      return path === null ? [] : [{ path, action: doc.action }];
    });
    const documents = await source!.reconcileRestore!({ changes, replace });
    if (!live()) throw new LocalGitClosedError();
    return documents;
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
    commit(message: string, options: { fromCheckpoint?: string } = {}): Promise<LocalGitCreated> {
      return call<LocalGitCreated>("localgit_commit", {
        message,
        fromCheckpoint: options.fromCheckpoint ?? null,
        by: signature(identity()),
      });
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
      const documents = await reconcile(
        result.plan,
        result.status === "failed" ? result.applied : null,
      );
      return {
        ...result,
        documents,
        succeeded: result.status === "completed" && documents.ok,
      };
    },

    /** The Local Index: what the next commit will have. */
    index: () => call<LocalGitIndexInfo>("localgit_index"),

    /** Stages paths as the workspace has them (unsaved documents included; nothing is saved). */
    stage(paths: LocalGitPath[], jobId: string = nextJob()) {
      return withOverlays(false, (refs) =>
        call<LocalGitStageResult>("localgit_stage", {
          jobId,
          paths: paths.map(normalPath),
          all: false,
          overlays: refs.overlays,
        }),
      );
    },
    stageAll(jobId: string = nextJob()) {
      return withOverlays(false, (refs) =>
        call<LocalGitStageResult>("localgit_stage", {
          jobId,
          paths: [],
          all: true,
          overlays: refs.overlays,
        }),
      );
    },
    /** Unstages paths: their index entries become HEAD's. Nothing on disk changes. */
    unstage: (paths: LocalGitPath[]) =>
      call<LocalGitStageResult>("localgit_unstage", {
        paths: paths.map(normalPath),
        all: false,
      }),
    unstageAll: () => call<LocalGitStageResult>("localgit_unstage", { paths: [], all: true }),
    /**
     * Stages chosen hunks of one file's index-to-workspace diff (`diffWorkspace` from the
     * index); `expected` are that diff's blob ids, so a stale selection is refused.
     */
    stageHunks(
      file: LocalGitPath,
      hunks: number[],
      expected: { index: string | null; working: string | null },
      jobId: string = nextJob(),
    ) {
      return withOverlays(false, (refs) =>
        call<LocalGitStageResult>("localgit_stage_hunks", {
          jobId,
          folderId: file.folderId ?? null,
          path: file.path,
          hunks,
          expectedIndex: expected.index,
          expectedWorking: expected.working,
          overlays: refs.overlays,
        }),
      );
    },

    branches: () => call<LocalGitBranch[]>("localgit_branches"),
    /** A new branch at `start` (HEAD's commit by default); HEAD does not move. */
    createBranch: (name: string, start: string | null = null) =>
      call<LocalGitBranch>("localgit_create_branch", { name, start }),
    deleteBranch: (name: string) => call<void>("localgit_delete_branch", { name }),
    tags: () => call<LocalGitTag[]>("localgit_tags"),
    tag: (name: string) => call<LocalGitTag>("localgit_get_tag", { name }),
    createTag: (name: string, target: string | null = null) =>
      call<LocalGitTag>("localgit_create_tag", { name, target }),
    deleteTag: (name: string) => call<void>("localgit_delete_tag", { name }),

    /**
     * Resets HEAD (its branch, or HEAD itself when detached) to a target. `soft` keeps the
     * index and the working tree; `mixed` keeps the working tree; `hard` changes all three and
     * is refused, with every conflict, when local work would be lost -- unless `policy` is
     * `allowDestructive`, the caller's explicit choice.
     */
    async reset(
      target: LocalGitTarget,
      mode: LocalGitResetMode,
      options: { policy?: LocalGitResetPolicy; dryRun?: boolean } = {},
      jobId: string = nextJob(),
    ): Promise<WithDocuments<LocalGitResetResult>> {
      const [kind, value] =
        "commit" in target
          ? (["commit", target.commit] as const)
          : "branch" in target
            ? (["branch", target.branch] as const)
            : (["tag", target.tag] as const);
      const result = await withOverlays(false, (refs) =>
        call<LocalGitResetResult>("localgit_reset", {
          jobId,
          target: { kind, value },
          mode,
          policy: options.policy ?? "refuseIfDirty",
          dryRun: options.dryRun ?? false,
          overlays: refs.overlays,
        }),
      );
      return afterDisk(result, result.plan?.restore ?? null);
    },

    /** A new commit that undoes `commit`, made from the index; the working tree is untouched. */
    revert(commit: string, options: { message?: string } = {}, jobId: string = nextJob()) {
      return withOverlays(false, (refs) =>
        call<LocalGitRevertResult>("localgit_revert", {
          jobId,
          commit,
          message: options.message ?? null,
          overlays: refs.overlays,
          by: signature(identity()),
        }),
      );
    },

    /**
     * Puts the workspace's changes aside -- staged and unstaged apart, unsaved documents
     * included, untracked files only when asked -- and cleans the workspace back to HEAD.
     */
    async stashPush(
      options: { message?: string; includeUntracked?: boolean } = {},
      jobId: string = nextJob(),
    ): Promise<WithDocuments<LocalGitStashPushResult>> {
      const result = await withOverlays(false, (refs) =>
        call<LocalGitStashPushResult>("localgit_stash_push", {
          jobId,
          message: options.message ?? null,
          includeUntracked: options.includeUntracked ?? false,
          overlays: refs.overlays,
          by: signature(identity()),
        }),
      );
      return afterDisk(result, result.plan.restore);
    },
    stashList: (limit = 100) => call<LocalGitStashList>("localgit_stash_list", { limit }),
    stashApply: (id: string, jobId: string = nextJob()) => applyStash(id, false, jobId),
    /** Applies the stash and removes it -- only once everything succeeded. */
    stashPop: (id: string, jobId: string = nextJob()) => applyStash(id, true, jobId),
    stashDrop: (id: string) => call<void>("localgit_stash_drop", { id }),

    /**
     * Switches to a branch, or detaches HEAD at a commit. Refused, untouched, when staged
     * work, local changes or unsaved documents would be lost; there is no forced switch.
     */
    async switchTo(
      target: { branch: string } | { commit: string },
      options: { dryRun?: boolean } = {},
      jobId: string = nextJob(),
    ): Promise<LocalGitSwitchOutcome> {
      const result = await withOverlays(false, (refs) =>
        call<LocalGitSwitchResult>("localgit_switch", {
          jobId,
          branch: "branch" in target ? target.branch : null,
          commit: "commit" in target ? target.commit : null,
          dryRun: options.dryRun ?? false,
          overlays: refs.overlays,
        }),
      );
      const changed =
        (result.status === "completed" ||
          result.status === "failed" ||
          result.status === "verificationFailed") &&
        result.plan.restore.operations.length > 0;
      if (!changed || !source?.reconcileRestore)
        return { ...result, documents: null, succeeded: result.status === "completed" };
      const documents = await reconcile(
        result.plan.restore,
        result.status === "failed" ? result.applied : null,
      );
      return { ...result, documents, succeeded: result.status === "completed" && documents.ok };
    },

    /**
     * Merges a commit, branch or tag into HEAD: a fast-forward when it can be, a merge commit
     * when conflict-free, and otherwise stopped with conflicts to resolve (`operation()`), then
     * continue or abort. Refused, untouched, when staged work, local changes, untracked files or
     * unsaved documents are in the way.
     */
    async merge(
      target: LocalGitTarget,
      options: { message?: string; dryRun?: boolean } = {},
      jobId: string = nextJob(),
    ): Promise<WithDocuments<LocalGitOperationResult>> {
      const result = await withOverlays(false, (refs) =>
        call<LocalGitOperationResult>("localgit_merge", {
          jobId,
          target: targetArg(target),
          message: options.message ?? null,
          dryRun: options.dryRun ?? false,
          overlays: refs.overlays,
          by: signature(identity()),
        }),
      );
      return afterDisk(result, result.restore);
    },

    /** Applies one commit's change to HEAD as a new commit; the commit itself is untouched. */
    async cherryPick(
      commit: string,
      options: { dryRun?: boolean } = {},
      jobId: string = nextJob(),
    ): Promise<WithDocuments<LocalGitOperationResult>> {
      const result = await withOverlays(false, (refs) =>
        call<LocalGitOperationResult>("localgit_cherry_pick", {
          jobId,
          commit,
          dryRun: options.dryRun ?? false,
          overlays: refs.overlays,
          by: signature(identity()),
        }),
      );
      return afterDisk(result, result.restore);
    },

    /** The merge or cherry-pick in progress, with its conflicts (null: none). */
    operation: () => call<LocalGitOperationState | null>("localgit_operation"),

    /**
     * Resolves one conflict. `takeOurs`, `takeTheirs` and `delete` also set the file on disk --
     * refused over edits or unsaved text unless `policy` is `allowDestructive`; `manual` takes
     * the document's current text (unsaved changes included); `markResolved` the file as it is.
     */
    async resolve(
      path: LocalGitPath,
      choice: LocalGitResolveChoice,
      options: { policy?: LocalGitResetPolicy } = {},
      jobId: string = nextJob(),
    ): Promise<WithDocuments<LocalGitOperationResult>> {
      const result = await withOverlays(false, (refs) =>
        call<LocalGitOperationResult>("localgit_resolve", {
          jobId,
          folderId: path.folderId ?? null,
          path: path.path,
          resolution: choice,
          policy: options.policy ?? "refuseIfDirty",
          overlays: refs.overlays,
        }),
      );
      return afterDisk(result, result.restore);
    },

    /**
     * Continues the operation in progress: once every conflict is resolved, its commit is made
     * and HEAD moves; after a stop while the disk was changing, the disk is finished first.
     */
    async continueOperation(
      options: { message?: string } = {},
      jobId: string = nextJob(),
    ): Promise<WithDocuments<LocalGitOperationResult>> {
      const result = await withOverlays(false, (refs) =>
        call<LocalGitOperationResult>("localgit_continue", {
          jobId,
          message: options.message ?? null,
          overlays: refs.overlays,
          by: signature(identity()),
        }),
      );
      return afterDisk(result, result.restore);
    },

    /** Aborts the operation in progress: the disk and the index back as they were. */
    async abortOperation(
      options: { policy?: LocalGitResetPolicy } = {},
      jobId: string = nextJob(),
    ): Promise<WithDocuments<LocalGitOperationResult>> {
      const result = await withOverlays(false, (refs) =>
        call<LocalGitOperationResult>("localgit_abort", {
          jobId,
          policy: options.policy ?? "refuseIfDirty",
          overlays: refs.overlays,
        }),
      );
      return afterDisk(result, result.restore);
    },

    /**
     * AI runs (LG-07). The AI layer runs the AI and owns its lifecycle and ChangeSets; Local Git
     * records what it is told, by the AI layer's ids, and owns the checkpoint, the attribution,
     * the AI commit and the undo.
     */
    ai: {
      /**
       * The checkpoint of a run that has not changed anything yet: the workspace as the user has
       * it, unsaved documents included. HEAD and the index do not move. If this rejects, the AI
       * must not begin.
       */
      checkpoint(
        run: {
          agentRunId: string;
          taskId?: string;
          changeSetId?: string;
          changeSetRevision?: string;
          reason: string;
          model?: string;
        },
        jobId: string = nextJob(),
      ) {
        return withOverlays(false, (refs) =>
          call<LocalGitAiRun>("localgit_ai_checkpoint", {
            jobId,
            agentRunId: run.agentRunId,
            taskId: run.taskId ?? null,
            changeSetId: run.changeSetId ?? null,
            changeSetRevision: run.changeSetRevision ?? null,
            reason: run.reason,
            model: run.model ?? null,
            overlays: refs.overlays,
            by: signature(identity()),
          }),
        );
      },
      run: (agentRunId: string) => call<LocalGitAiRun>("localgit_ai_run", { agentRunId }),
      /** Newest first, with what became of each run. */
      history: (limit = 100) =>
        call<{ items: LocalGitAiRun[]; total: number }>("localgit_ai_runs", { limit }),
      started: (agentRunId: string) => report(agentRunId, "started"),
      validated: (agentRunId: string, passed: boolean, reference?: string) =>
        report(agentRunId, "validated", { passed, reference }),
      /** Recorded only: the run's changes stay, for the user to keep or undo. */
      failed: (agentRunId: string, note?: string) => report(agentRunId, "failed", { note }),
      cancelled: (agentRunId: string, note?: string) => report(agentRunId, "cancelled", { note }),
      associateChangeSet: (agentRunId: string, changeSetId: string, revision?: string) =>
        call<LocalGitAiRun>("localgit_ai_associate", {
          agentRunId,
          changeSetId,
          revision: revision ?? null,
        }),
      /** The paths the AI changed; everything else changed since is recorded as not the AI's. */
      recordChanges(agentRunId: string, paths: LocalGitAiPath[], jobId: string = nextJob()) {
        return withOverlays(false, (refs) =>
          call<LocalGitAiRun>("localgit_ai_record_changes", {
            jobId,
            agentRunId,
            paths: paths.map((p) => ({
              folderId: p.folderId ?? null,
              path: p.path,
              expected: p.expected ?? null,
              deleted: p.deleted ?? false,
            })),
            overlays: refs.overlays,
          }),
        );
      },
      /** Exactly the AI's changes on HEAD -- or every reason not, with nothing changed. */
      commit(
        agentRunId: string,
        options: { message?: string; changeSetRevision?: string } = {},
        jobId: string = nextJob(),
      ) {
        return withOverlays(false, (refs) =>
          call<LocalGitAiCommitResult>("localgit_ai_commit", {
            jobId,
            agentRunId,
            message: options.message ?? null,
            changeSetRevision: options.changeSetRevision ?? null,
            overlays: refs.overlays,
            by: signature(identity()),
          }),
        );
      },
      /** Takes out exactly the AI's changes; never a reset. `dryRun` says whether it can. */
      async undo(
        agentRunId: string,
        options: { dryRun?: boolean } = {},
        jobId: string = nextJob(),
      ): Promise<WithDocuments<LocalGitAiUndoResult>> {
        const result = await withOverlays(false, (refs) =>
          call<LocalGitAiUndoResult>("localgit_ai_undo", {
            jobId,
            agentRunId,
            dryRun: options.dryRun ?? false,
            overlays: refs.overlays,
          }),
        );
        return afterDisk(result, result.plan.restore);
      },
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
