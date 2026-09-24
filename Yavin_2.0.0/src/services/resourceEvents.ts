import { samePathString } from "./resource.ts";

/**
 * What the filesystem watcher reports, on the UI side.
 *
 * The native watcher (`src-tauri/crates/ide-workspace/src/resource_events.rs`) turns operating
 * system notifications into batches of typed changes: created, modified, deleted, renamed --
 * already paired, coalesced, and credited to a Yavin operation where the disk shows it was one.
 * This module is the contract's shape on this side, the guard that stops a malformed payload
 * from reaching a consumer, and the check that drops batches from a watch that is no longer
 * the current one.
 *
 * It reports; it does not decide. Whether a change matters -- to the explorer, to Git, to an
 * open document -- is each consumer's call, so nothing here filters by folder name.
 */

export type ResourceChangeKind = "created" | "modified" | "deleted" | "renamed";

interface ChangeBase {
  /** The resource as it is now: for a rename, its new path. Cleaned (`/`, no `\\?\`). */
  path: string;
  /** The Yavin operation that made this change, when the disk shows it did. */
  operation?: number;
}

export type ResourceChange =
  | (ChangeBase & { kind: "created" | "modified" | "deleted" })
  | (ChangeBase & { kind: "renamed"; from: string });

export interface ResourceChangeBatch {
  /** The watch that produced this batch. Later watches have larger generations. */
  generation: number;
  /** The folder being watched. */
  root: string;
  /** In the order they happened, at most one per resource (a rename may be followed by a
   * modification of its new name). */
  changes: ResourceChange[];
  /**
   * Folders whose changes were not all observed -- notifications were lost, the batch was too
   * large to itemise, or the watch failed. State kept about anything inside them has to be
   * re-read rather than updated from `changes`.
   */
  rescan: string[];
}

export type WatcherState = "watching" | "failed";

export interface WatcherStatus {
  /** 0 when the watch could not be started at all. */
  generation: number;
  root: string;
  state: WatcherState;
  message?: string;
}

const KINDS: readonly string[] = ["created", "modified", "deleted", "renamed"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isGeneration = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function asChange(value: unknown): ResourceChange | null {
  if (!isRecord(value) || typeof value.path !== "string" || !value.path) return null;
  if (typeof value.kind !== "string" || !KINDS.includes(value.kind)) return null;
  const operation = isGeneration(value.operation) ? { operation: value.operation } : {};
  if (value.kind === "renamed") {
    if (typeof value.from !== "string" || !value.from) return null;
    return { kind: "renamed", path: value.path, from: value.from, ...operation };
  }
  return {
    kind: value.kind as "created" | "modified" | "deleted",
    path: value.path,
    ...operation,
  };
}

/**
 * A batch as consumers may use it, or null for a payload that is not one. A single malformed
 * change is dropped, and its folder queued for a rescan, rather than discarding the batch: the
 * rest of it is still true, and the folder is where the unknown change happened.
 */
export function asResourceChangeBatch(value: unknown): ResourceChangeBatch | null {
  if (!isRecord(value) || !isGeneration(value.generation) || typeof value.root !== "string")
    return null;
  if (!value.root || !Array.isArray(value.changes) || !Array.isArray(value.rescan)) return null;
  const changes: ResourceChange[] = [];
  const rescan = value.rescan.filter(
    (scope): scope is string => typeof scope === "string" && scope.length > 0,
  );
  for (const raw of value.changes) {
    const change = asChange(raw);
    if (change) changes.push(change);
    else if (!rescan.includes(value.root)) rescan.push(value.root);
  }
  return { generation: value.generation, root: value.root, changes, rescan };
}

export function asWatcherStatus(value: unknown): WatcherStatus | null {
  if (!isRecord(value) || !isGeneration(value.generation) || typeof value.root !== "string")
    return null;
  if (value.state !== "watching" && value.state !== "failed") return null;
  return {
    generation: value.generation,
    root: value.root,
    state: value.state,
    ...(typeof value.message === "string" ? { message: value.message } : {}),
  };
}

/**
 * Which watch is current, from what has been heard of each.
 *
 * Every watch the native side starts has a larger generation than the last, and it stops the
 * previous one before starting the next, so the newest generation seen is the live watch. A
 * batch is accepted only if it is for the folder open now and from that newest watch -- or a
 * newer one, whose "watching" status may simply not have arrived yet, since statuses and
 * batches are separate events.
 */
export function createWatchTracker() {
  let generation = 0;
  let status: WatcherStatus | null = null;
  return {
    /** Records a status; returns it if it is about the current watch, else null. */
    status(next: WatcherStatus): WatcherStatus | null {
      // Generation 0 is a watch that never started: it is about whichever folder it names.
      if (next.generation !== 0 && next.generation < generation) return null;
      if (next.generation > generation) generation = next.generation;
      status = next;
      return next;
    },
    /** Whether `batch` should be applied to the workspace open at `workspaceRoot`. */
    accept(batch: ResourceChangeBatch, workspaceRoot: string): boolean {
      if (!workspaceRoot || !samePathString(batch.root, workspaceRoot)) return false;
      if (batch.generation < generation) return false;
      generation = batch.generation;
      return true;
    },
    get generation() {
      return generation;
    },
    get current(): WatcherStatus | null {
      return status;
    },
  };
}

export type WatchTracker = ReturnType<typeof createWatchTracker>;
