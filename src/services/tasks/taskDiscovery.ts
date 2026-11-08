/**
 * Live task rediscovery (WS7 Part 3): keep a workspace's discovered tasks current as its project
 * files change, using the **existing** filesystem watch (`onResourceChanges`) — no second watcher
 * and no polling loop. When a discovery file (`package.json`, `Cargo.toml`, a Makefile, or a
 * lockfile) is created, modified, deleted or renamed, discovery re-runs and the new list is handed
 * back; the TaskService is otherwise untouched.
 *
 * Correctness:
 * - **Debounced** — a burst of events (an editor save writes several times) coalesces into one
 *   re-discovery.
 * - **Stale-result protected** — each run takes a token; a slower run that finishes after a newer
 *   one started is dropped, so the newest file state always wins.
 * - **Workspace-isolated** — a batch is acted on only when its watched root is one of this
 *   coordinator's folders, so one workspace's changes never update another's tasks.
 * - **Read errors keep the last list** — a transient read failure does not wipe the tasks; only a
 *   successful re-discovery replaces them.
 */
import { samePathString } from "../resource.ts";
import type { ResourceChangeBatch } from "../resourceEvents.ts";
import {
  discoverWorkspaceTasks,
  isDiscoveryFile,
  type DirLister,
  type TaskFileReader,
} from "./discovery.ts";
import type { ResolvedTask } from "./model.ts";

export interface TaskDiscoveryOptions {
  readonly folders: readonly string[];
  readonly read: TaskFileReader;
  /** Lists a directory's children (the native, workspace-confined listing). When present, monorepo
   * sub-packages are discovered too; when absent, only the root folders are. */
  readonly listDir?: DirLister;
  /** Subscribe to filesystem change batches (the existing `onResourceChanges`); returns unsubscribe. */
  readonly subscribe: (handler: (batch: ResourceChangeBatch) => void) => () => void;
  /** Receives the latest discovered tasks whenever they change (updates the list + refreshes). */
  readonly onTasks: (tasks: readonly ResolvedTask[]) => void;
  readonly debounceMs?: number;
  /** Injectable timers, for deterministic tests. */
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

export interface TaskDiscovery {
  /** Re-run discovery now, bypassing the debounce. */
  refreshNow(): Promise<void>;
  dispose(): void;
}

export function createTaskDiscovery(options: TaskDiscoveryOptions): TaskDiscovery {
  const debounce = options.debounceMs ?? 400;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms) as unknown);
  const clearTimer =
    options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let disposed = false;
  /** Bumped by every run; a run applies its result only if it is still the latest. */
  let token = 0;
  let timer: unknown = null;

  const run = async (): Promise<void> => {
    const mine = ++token;
    let found: readonly ResolvedTask[];
    try {
      found = await discoverWorkspaceTasks(options.folders, options.read, options.listDir);
    } catch {
      return; // a read failure leaves the last valid list in place
    }
    if (disposed || mine !== token) return; // a newer run superseded this one
    options.onTasks(found);
  };

  const schedule = (): void => {
    if (disposed) return;
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      void run();
    }, debounce);
  };

  /** Whether a batch is for this workspace, and touches a file discovery reads. */
  const relevant = (batch: ResourceChangeBatch): boolean => {
    if (!options.folders.some((folder) => samePathString(batch.root, folder))) return false;
    if (batch.rescan.length > 0) return true; // lost events: re-read to be safe
    return batch.changes.some(
      (change) =>
        isDiscoveryFile(change.path) || (change.kind === "renamed" && isDiscoveryFile(change.from)),
    );
  };

  // Discover once immediately (not debounced), then watch for changes.
  void run();
  const unsubscribe = options.subscribe((batch) => {
    if (!disposed && relevant(batch)) schedule();
  });

  return {
    async refreshNow() {
      await run();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer !== null) clearTimer(timer);
      unsubscribe();
    },
  };
}
