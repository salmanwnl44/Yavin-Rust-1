import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { FileNode } from "../types";
import type { Shell } from "./terminal";
import type { Session, WorkspaceSession } from "./session";
import type { TrustState } from "./trust";
import { asResourceChangeBatch, asWatcherStatus } from "./resourceEvents.ts";
import type { ResourceChangeBatch, WatcherStatus } from "./resourceEvents.ts";

interface Commands {
  get_default_workspace: { args: undefined; result: string | null };
  list_workspace_files: { args: { path: string; maxDepth: number }; result: FileNode };
  read_file_content: { args: { path: string }; result: string };
  create_file: { args: { path: string }; result: void };
  create_directory: { args: { path: string }; result: void };
  rename_path: { args: { oldPath: string; newPath: string }; result: void };
  delete_path: { args: { path: string; recursive: boolean }; result: void };
  duplicate_path: { args: { path: string }; result: string };
  copy_path: { args: { src: string; dest: string }; result: void };
  reveal_in_explorer: { args: { path: string }; result: void };
  open_folder_dialog: { args: undefined; result: string | null };
  pick_folder_dialog: { args: undefined; result: string | null };
  open_file_dialog: { args: undefined; result: string | null };
  write_file_guarded: { args: { path: string; expected: string; content: string }; result: void };
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
    };
    result: string;
  };
  terminal_write: { args: { id: string; data: string }; result: void };
  terminal_resize: { args: { id: string; cols: number; rows: number }; result: void };
  terminal_close: { args: { id: string }; result: void };
  terminal_close_all: { args: undefined; result: void };
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
