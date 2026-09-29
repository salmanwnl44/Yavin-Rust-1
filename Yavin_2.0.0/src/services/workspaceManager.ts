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

/**
 * `opening` while its services are made, `active` once they are, `closing` while they are
 * disposed, `closed` after. There is no way back from `closing`: reopening the same folders
 * makes a new context with a new generation. (Suspending a workspace to resume it later is a
 * later module; today leaving a workspace closes it.)
 */
export type WorkspaceState = "opening" | "active" | "closing" | "closed";

export interface WorkspaceContext<S> {
  readonly id: WorkspaceId;
  /** Its folders, as the native side spells them. Empty for a window with none. */
  readonly folders: readonly string[];
  readonly state: WorkspaceState;
  /**
   * Which activation this is, increasing for the life of the window: A, then B, then A again
   * are three generations. Work captures it and checks it is still current before applying.
   */
  readonly generation: number;
  /** Whether this is still the window's workspace, `active`: late work checks this. */
  isActive(): boolean;
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
  let generations = 0;
  /** How long the last switch took: disposing the old workspace, making the new one. */
  let lastSwitch = { closeMs: 0, openMs: 0 };

  const create = (folders: readonly string[]) => {
    const controller = new AbortController();
    const cleanups: (() => void | Promise<void>)[] = [];
    let state: WorkspaceState = "opening";
    const generation = ++generations;
    /** The disposal, once started: everyone waiting on it waits for the same one. */
    let ending: Promise<void> | null = null;
    const id = workspaceIdOf(folders);
    const context: WorkspaceContext<S> & { end(): Promise<void> } = {
      id,
      folders: [...folders],
      get state() {
        return state;
      },
      generation,
      isActive: () => state === "active",
      // Made below, once the context exists; a factory that throws leaves no context.
      services: undefined as unknown as S,
      signal: controller.signal,
      own(dispose) {
        if (state === "opening" || state === "active") cleanups.push(dispose);
        // Owned after the workspace went: undone at once, never leaked.
        else void Promise.resolve().then(dispose);
      },
      end() {
        ending ??= (async () => {
          state = "closing";
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
          state = "closed";
        })();
        return ending;
      },
    };
    (context as { services: S }).services = factory.create(id, folders);
    state = "active";
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
    /** Timings of the last switch, for measurement. */
    lastSwitch: () => lastSwitch,
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
        const started = performance.now();
        await (current as ReturnType<typeof create>).end();
        const closed = performance.now();
        // A later open owns the window: this one answers with what that one makes.
        if (mine !== opening) return latest;
        try {
          current = create(folders);
        } catch (error) {
          // The workspace could not be made: the window is left with none, never with the
          // old one's services half-active next to the new one's UI.
          options.log?.(`Opening workspace ${id}: ${String(error)}`);
          try {
            current = create([]);
          } catch (fallback) {
            // Not even the empty workspace: the closed one stays, inactive, so every late
            // result still checks against a workspace that is not active and drops itself.
            options.log?.(`Opening the empty workspace: ${String(fallback)}`);
          }
          notify();
          throw error;
        }
        lastSwitch = { closeMs: closed - started, openMs: performance.now() - closed };
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
