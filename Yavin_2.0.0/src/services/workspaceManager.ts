import { fileUri, resourceId } from "./resource.ts";

/**
 * The owner of workspace lifecycle and scope. A workspace is the folder (or folders) a window
 * has open, and everything that belongs to it -- its Git repositories and their watchers,
 * polling and selection -- lives in one `WorkspaceContext`. Opening another folder disposes
 * the context of the one left before the next is created, so nothing of it can stay active:
 * there is no global "current repository" to forget to reset.
 *
 * ```text
 * WorkspaceManager ── open(folders) ──> WorkspaceContext { id, folders, services, signal }
 *        │                                     │ disposed (services, then owned cleanups)
 *        └── the previous context ─────────────┘ before the next one exists
 * ```
 *
 * Services are made by the factory the manager is given, so the manager knows nothing of
 * Git (and the tests give it fakes). Work of an old workspace that finishes late checks the
 * context's `signal` (or `state`) and drops its result.
 */

/** A workspace's identity: its folders' `ResourceId`s, so every spelling of a path is one. */
export type WorkspaceId = string & { readonly __workspaceId: unique symbol };

/** The window with no folder open is a workspace too, with nothing in it. */
export const EMPTY_WORKSPACE = "empty:" as WorkspaceId;

export function workspaceIdOf(folders: readonly string[]): WorkspaceId {
  if (!folders.length) return EMPTY_WORKSPACE;
  return folders
    .map((folder) => resourceId(fileUri(folder)))
    .sort()
    .join("|") as WorkspaceId;
}

export type WorkspaceState = "active" | "disposing" | "disposed";

export interface WorkspaceContext<S> {
  readonly id: WorkspaceId;
  /** Its folders, as the native side spells them. Empty for a window with none. */
  readonly folders: readonly string[];
  readonly state: WorkspaceState;
  readonly services: S;
  /** Aborted when the workspace is disposed: its late work checks this and stops. */
  readonly signal: AbortSignal;
  /** Something to undo when the workspace goes (a subscription, a timer, a process). */
  own(dispose: () => void | Promise<void>): void;
}

export interface WorkspaceServiceFactory<S> {
  create(id: WorkspaceId, folders: readonly string[]): S;
  /** Ends every service of a workspace: watchers, polling, subscriptions, processes. */
  dispose(services: S): void | Promise<void>;
}

export function createWorkspaceManager<S>(
  factory: WorkspaceServiceFactory<S>,
  options: { log?: (message: string) => void } = {},
) {
  const listeners = new Set<() => void>();

  const create = (folders: readonly string[]) => {
    const controller = new AbortController();
    const cleanups: (() => void | Promise<void>)[] = [];
    let state: WorkspaceState = "active";
    /** The disposal, once started: everyone waiting on it waits for the same one. */
    let ending: Promise<void> | null = null;
    const id = workspaceIdOf(folders);
    const context: WorkspaceContext<S> & { end(): Promise<void> } = {
      id,
      folders: [...folders],
      get state() {
        return state;
      },
      services: factory.create(id, folders),
      signal: controller.signal,
      own(dispose) {
        if (state === "active") cleanups.push(dispose);
        // Owned after the workspace went: undone at once, never leaked.
        else void Promise.resolve().then(dispose);
      },
      end() {
        ending ??= (async () => {
          state = "disposing";
          controller.abort();
          // Services first (they may still use what the cleanups tear down), then everything
          // owned, newest first. One failure never keeps the rest from being disposed.
          const steps = [() => factory.dispose(context.services), ...cleanups.reverse()];
          for (const step of steps) {
            try {
              await step();
            } catch (error) {
              options.log?.(`Disposing workspace ${id}: ${String(error)}`);
            }
          }
          state = "disposed";
        })();
        return ending;
      },
    };
    return context;
  };

  let current = create([]);
  /** The latest `open`: an older one that finishes later does not replace it. */
  let opening = 0;
  let latest: Promise<WorkspaceContext<S>> = Promise.resolve(current);

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  return {
    /** The workspace in the window. Always one: with no folder open, the empty workspace. */
    current: (): WorkspaceContext<S> => current,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    /**
     * Makes `folders` the window's workspace. The same folders again keep the workspace as it
     * is; other folders dispose the current workspace completely first, then create theirs.
     * When a later `open` starts before this one finished, the later one wins.
     */
    open(folders: readonly string[]): Promise<WorkspaceContext<S>> {
      const id = workspaceIdOf(folders);
      const mine = ++opening;
      const task = (async (): Promise<WorkspaceContext<S>> => {
        if (id === current.id && current.state === "active") return current;
        await (current as ReturnType<typeof create>).end();
        // A later open owns the window: this one answers with what that one makes.
        if (mine !== opening) return latest;
        current = create(folders);
        notify();
        return current;
      })();
      latest = task;
      return task;
    },

    /** Closes the workspace: the window is left with no folder. */
    close(): Promise<WorkspaceContext<S>> {
      return this.open([]);
    },

    /** The window is going: the workspace is disposed and nothing replaces it. */
    async dispose() {
      opening++;
      await (current as ReturnType<typeof create>).end();
      listeners.clear();
    },
  };
}

export type WorkspaceManager<S> = ReturnType<typeof createWorkspaceManager<S>>;
