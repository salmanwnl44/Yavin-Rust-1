import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { FileNode } from "../types";
import type { Shell } from "./terminal";
import type { Session, WorkspaceSession } from "./session";
import type { TrustState } from "./trust";
import type {
  LocalGitBlobInfo,
  LocalGitBranch,
  LocalGitOperationResult,
  LocalGitOperationState,
  LocalGitResetResult,
  LocalGitRevertResult,
  LocalGitStashApplyResult,
  LocalGitStashList,
  LocalGitStashPushResult,
  LocalGitCheckpointEntry,
  LocalGitIndexInfo,
  LocalGitPath,
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
  LocalGitOverlayArg,
  LocalGitOverlayRef,
  LocalGitProgress,
  LocalGitReflogRecord,
  LocalGitRefs,
  LocalGitSnapshot,
  LocalGitSnapshotMode,
  LocalGitStatus,
  LocalGitTreeEntry,
  LocalGitUntitledArg,
} from "./localgit/types";
import { asResourceChangeBatch, asWatcherStatus } from "./resourceEvents.ts";
import type { ResourceChangeBatch, WatcherStatus } from "./resourceEvents.ts";

interface Commands {
  get_default_workspace: { args: undefined; result: string | null };
  list_workspace_files: { args: { path: string; maxDepth: number }; result: FileNode };
  read_file_content: { args: { path: string }; result: string };
  is_read_only: { args: { path: string }; result: boolean };
  read_image_file: { args: { path: string }; result: ArrayBuffer };
  lsp_servers: {
    args: Record<string, never>;
    result: {
      trusted: boolean;
      servers: { id: string; label: string; program: string | null }[];
    };
  };
  lsp_start: {
    args: { server: string; root: string };
    result: { session: number; program: string };
  };
  lsp_send: { args: { session: number; message: string }; result: void };
  lsp_stop: { args: { session: number }; result: void };
  lsp_stop_all: { args: Record<string, never>; result: void };
  create_file: { args: { path: string }; result: void };
  /** Exclusive: fails if anything is there. Resolves to the operation's id (Module 03). */
  create_file_with_content: { args: { path: string; content: string }; result: number };
  create_directory: { args: { path: string }; result: void };
  rename_path: { args: { oldPath: string; newPath: string }; result: void };
  delete_path: { args: { path: string; recursive: boolean }; result: void };
  duplicate_path: { args: { path: string }; result: string };
  copy_path: { args: { src: string; dest: string }; result: void };
  reveal_in_explorer: { args: { path: string }; result: void };
  open_folder_dialog: { args: undefined; result: string | null };
  pick_folder_dialog: { args: undefined; result: string | null };
  open_file_dialog: { args: undefined; result: string | null };
  save_file_dialog: { args: { defaultName?: string }; result: string | null };
  /** Resolves to the operation's id, which the watcher credits the write to (Module 03). */
  write_file_guarded: {
    args: { path: string; expected: string; content: string };
    result: number;
  };
  search_project: {
    args: { workspace: string; id: string; options: SearchOptions };
    result: ToolOutput;
  };
  cancel_search: { args: { id: string }; result: void };
  git_open_repo: { args: { path: string }; result: { repoId: string; root: string } };
  git_init_repo: { args: { path: string }; result: { repoId: string; root: string } };
  git_clone_repo: {
    args: { parent: string; url: string; folder: string };
    result: { repoId: string; root: string };
  };
  git_close_repo: { args: { repoId: string }; result: void };
  git_probe_worktree: { args: { repoId: string }; result: "ready" | "missing" | "invalid" };
  open_external_url: { args: { url: string }; result: void };
  list_listening_ports: { args: undefined; result: ListeningPort[] };
  available_checkers: { args: undefined; result: { id: string; label: string }[] };
  run_checker: { args: { id: string }; result: { output: string; code: number } };
  cancel_checker: { args: undefined; result: void };
  open_workspace: { args: { path: string }; result: string };
  read_session: { args: undefined; result: Session };
  save_workspace_session: { args: { state: WorkspaceSession }; result: void };
  forget_workspace: { args: { folder: string }; result: Session };
  workspace_trust: { args: undefined; result: TrustState };
  set_workspace_trust: { args: { trusted: boolean; parent: boolean }; result: TrustState };
  trusted_folders: { args: undefined; result: string[] };
  forget_trusted_folder: { args: { folder: string }; result: TrustState };
  // Read through `asRecoveryReport` (services/recovery.ts), never trusted as typed.
  recovery_report: { args: undefined; result: unknown };
  recovery_dismiss: { args: { ids: string[] }; result: unknown };
  stop_listening_process: { args: { port: number; pid: number }; result: void };
  git_exec: {
    args: { repoId: string; args: string[]; id: string; input?: string };
    result: ToolOutput;
  };
  git_cancel_repo: { args: { repoId: string }; result: void };
  git_repo_state: { args: { repoId: string }; result: string };
  git_watch_repo: {
    args: { repositoryId: string; worktreeRepoIds: string[] };
    result: void;
  };
  git_unwatch_repo: { args: { repositoryId: string }; result: void };
  terminal_shells: { args: undefined; result: Shell[] };
  terminal_open: {
    args: {
      id: string;
      shell?: string;
      cols: number;
      rows: number;
      /** Extra arguments from a terminal profile, e.g. `-NoLogo`. */
      args?: string[];
      /** Profile environment, as pairs so ordering is preserved on the native side. */
      env?: [string, string][];
      /** Where the shell starts; the workspace root when omitted. */
      cwd?: string;
      /** Which launch of this terminal it is; its events carry it back. */
      generation?: number;
    };
    result: string;
  };
  terminal_write: { args: { id: string; data: string }; result: void };
  terminal_resize: { args: { id: string; cols: number; rows: number }; result: void };
  terminal_close: { args: { id: string; generation?: number }; result: void };
  terminal_close_all: { args: undefined; result: void };
  /** Local Git (`services/localgit`): by handle and object id only, never by path. */
  localgit_open: { args: { folders: string[] }; result: LocalGitInfo };
  localgit_close: { args: { handle: string }; result: void };
  localgit_info: { args: { handle: string }; result: LocalGitInfo };
  localgit_verify: { args: { handle: string; full: boolean }; result: LocalGitFinding[] };
  localgit_refs: { args: { handle: string }; result: LocalGitRefs };
  localgit_reflog: { args: { handle: string; limit: number }; result: LocalGitReflogRecord[] };
  localgit_read_commit: { args: { handle: string; id: string }; result: LocalGitCommit };
  localgit_read_tree: { args: { handle: string; id: string }; result: LocalGitTreeEntry[] };
  localgit_blob_info: { args: { handle: string; id: string }; result: LocalGitBlobInfo };
  localgit_read_blob: {
    args: { handle: string; id: string; maxBytes: number };
    result: ArrayBuffer;
  };
  localgit_put_overlays: {
    args: { handle: string; overlays: LocalGitOverlayArg[]; untitled: LocalGitUntitledArg[] };
    result: void;
  };
  localgit_snapshot: {
    args: {
      handle: string;
      jobId: string;
      mode: LocalGitSnapshotMode;
      persist: boolean;
      overlays: LocalGitOverlayRef[];
      untitled: LocalGitOverlayRef[];
    };
    result: LocalGitSnapshot;
  };
  localgit_status: {
    args: {
      handle: string;
      jobId: string;
      mode: LocalGitSnapshotMode;
      overlays: LocalGitOverlayRef[];
      limit: number;
    };
    result: { snapshot: LocalGitSnapshot; status: LocalGitStatus };
  };
  localgit_cancel: { args: { handle: string; jobId: string }; result: void };
  localgit_checkpoint: {
    args: {
      handle: string;
      jobId: string;
      message: string | null;
      overlays: LocalGitOverlayRef[];
      untitled: LocalGitOverlayRef[];
      by: LocalGitSignature;
    };
    result: LocalGitCreated & { snapshot: LocalGitSnapshot };
  };
  localgit_commit: {
    args: {
      handle: string;
      message: string;
      fromCheckpoint: string | null;
      by: LocalGitSignature;
    };
    result: LocalGitCreated;
  };
  localgit_index: { args: { handle: string }; result: LocalGitIndexInfo };
  localgit_stage: {
    args: {
      handle: string;
      jobId: string;
      paths: LocalGitPath[];
      all: boolean;
      overlays: LocalGitOverlayRef[];
    };
    result: LocalGitStageResult;
  };
  localgit_unstage: {
    args: { handle: string; paths: LocalGitPath[]; all: boolean };
    result: LocalGitStageResult;
  };
  localgit_stage_hunks: {
    args: {
      handle: string;
      jobId: string;
      folderId: string | null;
      path: string;
      hunks: number[];
      expectedIndex: string | null;
      expectedWorking: string | null;
      overlays: LocalGitOverlayRef[];
    };
    result: LocalGitStageResult;
  };
  localgit_branches: { args: { handle: string }; result: LocalGitBranch[] };
  localgit_create_branch: {
    args: { handle: string; name: string; start: string | null };
    result: LocalGitBranch;
  };
  localgit_delete_branch: { args: { handle: string; name: string }; result: void };
  localgit_tags: { args: { handle: string }; result: LocalGitTag[] };
  localgit_get_tag: { args: { handle: string; name: string }; result: LocalGitTag };
  localgit_create_tag: {
    args: { handle: string; name: string; target: string | null };
    result: LocalGitTag;
  };
  localgit_delete_tag: { args: { handle: string; name: string }; result: void };
  localgit_reset: {
    args: {
      handle: string;
      jobId: string;
      target: { kind: "commit" | "branch" | "tag"; value: string };
      mode: "soft" | "mixed" | "hard";
      policy: "refuseIfDirty" | "allowDestructive";
      dryRun: boolean;
      overlays: LocalGitOverlayRef[];
    };
    result: LocalGitResetResult;
  };
  localgit_revert: {
    args: {
      handle: string;
      jobId: string;
      commit: string;
      message: string | null;
      overlays: LocalGitOverlayRef[];
      by: LocalGitSignature;
    };
    result: LocalGitRevertResult;
  };
  localgit_stash_push: {
    args: {
      handle: string;
      jobId: string;
      message: string | null;
      includeUntracked: boolean;
      overlays: LocalGitOverlayRef[];
      by: LocalGitSignature;
    };
    result: LocalGitStashPushResult;
  };
  localgit_stash_list: { args: { handle: string; limit: number }; result: LocalGitStashList };
  localgit_stash_apply: {
    args: {
      handle: string;
      jobId: string;
      id: string;
      pop: boolean;
      overlays: LocalGitOverlayRef[];
    };
    result: LocalGitStashApplyResult;
  };
  localgit_stash_drop: { args: { handle: string; id: string }; result: void };
  localgit_merge: {
    args: {
      handle: string;
      jobId: string;
      target: { kind: "commit" | "branch" | "tag"; value: string };
      message: string | null;
      dryRun: boolean;
      overlays: LocalGitOverlayRef[];
      by: LocalGitSignature;
    };
    result: LocalGitOperationResult;
  };
  localgit_cherry_pick: {
    args: {
      handle: string;
      jobId: string;
      commit: string;
      dryRun: boolean;
      overlays: LocalGitOverlayRef[];
      by: LocalGitSignature;
    };
    result: LocalGitOperationResult;
  };
  localgit_operation: { args: { handle: string }; result: LocalGitOperationState | null };
  localgit_resolve: {
    args: {
      handle: string;
      jobId: string;
      folderId: string | null;
      path: string;
      resolution: "takeOurs" | "takeTheirs" | "delete" | "manual" | "markResolved";
      policy: "refuseIfDirty" | "allowDestructive";
      overlays: LocalGitOverlayRef[];
    };
    result: LocalGitOperationResult;
  };
  localgit_continue: {
    args: {
      handle: string;
      jobId: string;
      message: string | null;
      overlays: LocalGitOverlayRef[];
      by: LocalGitSignature;
    };
    result: LocalGitOperationResult;
  };
  localgit_abort: {
    args: {
      handle: string;
      jobId: string;
      policy: "refuseIfDirty" | "allowDestructive";
      overlays: LocalGitOverlayRef[];
    };
    result: LocalGitOperationResult;
  };
  localgit_switch: {
    args: {
      handle: string;
      jobId: string;
      branch: string | null;
      commit: string | null;
      dryRun: boolean;
      overlays: LocalGitOverlayRef[];
    };
    result: LocalGitSwitchResult;
  };
  localgit_head: { args: { handle: string }; result: LocalGitHeadInfo };
  localgit_history: {
    args: { handle: string; cursor: string | null; limit: number };
    result: LocalGitHistoryPage;
  };
  localgit_checkpoints: {
    args: { handle: string; limit: number };
    result: LocalGitCheckpointEntry[];
  };
  localgit_tree: {
    args: { handle: string; commit: string; folderId: string | null; path: string };
    result: LocalGitTreeItem[];
  };
  localgit_diff_commits: {
    args: { handle: string; from: string | null; to: string; lineDiffs: boolean };
    result: LocalGitDiff;
  };
  localgit_diff_workspace: {
    args: {
      handle: string;
      jobId: string;
      from: string | null;
      overlays: LocalGitOverlayRef[];
      lineDiffs: boolean;
    };
    result: { snapshot: LocalGitSnapshot; diff: LocalGitDiff };
  };
  localgit_restore: {
    args: {
      handle: string;
      jobId: string;
      commit: string;
      folderId: string | null;
      path: string | null;
      policy: LocalGitRestorePolicy;
      dryRun: boolean;
      overlays: LocalGitOverlayRef[];
      by: LocalGitSignature;
    };
    result: LocalGitRestoreResult;
  };
}

/** A local TCP port something is listening on, as the Ports view shows it. */
export interface ListeningPort {
  port: number;
  /** The interface it listens on, e.g. `127.0.0.1` or `0.0.0.0` (any). */
  address: string;
  pid: number;
  /** Empty when the owning process could not be named -- normal for system-owned ports. */
  process: string;
}

export interface ToolOutput {
  stdout: string;
  stderr: string;
  code: number;
  truncated: boolean;
}
export interface SearchOptions {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  hidden: boolean;
  ignored: boolean;
  include: string[];
  exclude: string[];
  folder: string;
  buffer: string | null;
  filesOnly: boolean;
}

/**
 * Subscribes to a native event whose payload `parse` checks, dropping any that do not parse.
 * Returns an unsubscribe function that is safe to call before the listener has finished
 * registering.
 */
function onNativeEvent<T>(
  name: string,
  parse: (payload: unknown) => T | null,
  handler: (value: T) => void,
): () => void {
  if (!isTauri()) return () => {};
  let cancelled = false;
  const pending = listen(name, (event) => {
    if (cancelled) return;
    const value = parse(event.payload);
    if (value) handler(value);
  }).catch(() => undefined);
  return () => {
    cancelled = true;
    void pending.then((unlisten) => unlisten?.());
  };
}

/** Changes under the watched folder, as the native watcher batches them. */
export const onResourceChanges = (handler: (batch: ResourceChangeBatch) => void) =>
  onNativeEvent("resource-changes", asResourceChangeBatch, handler);

/** The watcher starting, or failing to keep watching. */
export const onWatcherStatus = (handler: (status: WatcherStatus) => void) =>
  onNativeEvent("watcher-status", asWatcherStatus, handler);

const asLocalGitProgress = (payload: unknown): LocalGitProgress | null =>
  payload && typeof payload === "object" && typeof (payload as LocalGitProgress).jobId === "string"
    ? (payload as LocalGitProgress)
    : null;

/** A Local Git snapshot's progress (at most 10 a second), for every handle's jobs. */
export const onLocalGitProgress = (handler: (progress: LocalGitProgress) => void) =>
  onNativeEvent("localgit-progress", asLocalGitProgress, handler);

/** The payload `git_watch_repo`'s Rust-side watcher emits -- see the Git State &
 * Synchronization plan's Section H/Z. `worktreeRoot` is only present for the two
 * per-worktree kinds; the three repository-shared kinds apply to every worktree. */
export interface GitChangeEvent {
  repositoryId: string;
  kind: "head" | "operation-state" | "refs" | "remotes" | "stash";
  worktreeRoot?: string;
}

/**
 * Subscribes to external Git ref changes reported by the per-repository `.git`
 * watcher (see `backend.ts`'s `watchRepo`/`unwatchRepo`). Returns an unsubscribe
 * function that is safe to call before the listener has finished registering.
 */
export function onGitChanged(handler: (event: GitChangeEvent) => void): () => void {
  if (!isTauri()) return () => {};
  let cancelled = false;
  const pending = listen<GitChangeEvent>("git-changed", (event) => {
    if (!cancelled) handler(event.payload);
  }).catch(() => undefined);
  return () => {
    cancelled = true;
    void pending.then((unlisten) => unlisten?.());
  };
}

export function native<K extends keyof Commands>(
  command: K,
  ...parameters: Commands[K]["args"] extends undefined ? [] : [Commands[K]["args"]]
): Promise<Commands[K]["result"]> {
  if (!isTauri())
    return Promise.reject(new Error("Open the desktop application to access local files."));
  return invoke<Commands[K]["result"]>(command, parameters[0]);
}
