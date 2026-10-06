/**
 * The extension host manager (IDE-08): one per workspace (`WorkspaceServices.extensions`),
 * owning which host generation is current for it. It is not a global object: the workspace
 * owns it, and disposing the workspace disposes it.
 *
 * - **Lazily started.** No process runs until an extension needs to activate.
 * - **Generations.** Every host it makes has a new generation (workspace generation × 1000 + n):
 *   a message from a host it replaced is rejected by identity, never applied.
 * - **Crashes.** A crashed host is finished; the next activation makes a new one. More than
 *   `CRASH_LIMIT` crashes within `CRASH_WINDOW_MS` stop that: extensions stay off until Restart.
 * - **Restart / Reload.** Restart ends the host and starts lazily again -- at once only if a view
 *   of an extension is on screen, to fill it; Reload also re-discovers the installed extensions
 *   first. Neither duplicates anything: contributions are the registry's
 *   (by id) and the old host's run-time contributions are removed with it.
 * - **Trust.** Revoking trust ends the host at once (no extension code keeps running in a folder
 *   no longer trusted); trusting it again lets extensions activate on their next event.
 */
import type { ActivationEvent } from "./manifest.ts";
import { ExtensionError } from "./errors.ts";
import {
  createExtensionHost,
  type ExtensionHost,
  type ExtensionHostOptions,
  type HostSnapshot,
} from "./host.ts";

export const CRASH_LIMIT = 3;
export const CRASH_WINDOW_MS = 60_000;

export interface ManagerSnapshot extends HostSnapshot {
  /** Restarts made by crashes within the window; at the limit the host is not restarted. */
  crashes: number;
  /** Why extensions are held off (trust revoked, crashed repeatedly), if they are. */
  held: string | null;
}

export type ManagerOptions = Omit<ExtensionHostOptions, "generation" | "onCrash"> & {
  /** The workspace context's generation: host generations are derived from it. */
  workspaceGeneration: number;
  /** Re-discovers installed extensions (Reload). */
  rediscover?(): Promise<unknown>;
  now?(): number;
};

export function createExtensionHostManager(options: ManagerOptions) {
  const now = options.now ?? (() => Date.now());
  const listeners = new Set<() => void>();
  let count = 0;
  let host: ExtensionHost | null = null;
  let stopHost: (() => void) | null = null;
  let crashes: number[] = [];
  let held: string | null = null;
  let disposed = false;
  let lastHost: HostSnapshot | null = null;
  const events: ActivationEvent[] = [];
  /** Extensions' views on screen: a new host fills them. */
  const shown = new Set<string>();

  const empty = (): HostSnapshot => ({
    workspace: options.workspace,
    generation: options.workspaceGeneration * 1000 + count,
    host: "idle",
    hostReason: null,
    statuses: {},
    views: {},
  });
  let snapshot: ManagerSnapshot = { ...empty(), crashes: 0, held: null };
  const publish = () => {
    const base = host?.getSnapshot() ?? lastHost ?? empty();
    snapshot = { ...base, crashes: crashes.length, held };
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        /* One listener's failure is not the others'. */
      }
    }
  };

  /** The live host, made when first needed (and after a crash). */
  const current = (asking?: string): ExtensionHost => {
    if (disposed) throw new ExtensionError("HostDisposed", null, "The workspace was closed.");
    if (held)
      throw new ExtensionError(
        /trust/i.test(held) ? "TrustRequired" : "HostCrashedRepeatedly",
        null,
        held,
      );
    if (host && !host.finished) return host;
    count++;
    const made = createExtensionHost({
      ...options,
      generation: options.workspaceGeneration * 1000 + count,
      onCrash: (reason) => {
        const at = now();
        crashes = [...crashes.filter((when) => at - when < CRASH_WINDOW_MS), at];
        if (crashes.length >= CRASH_LIMIT)
          held = `The extension host crashed ${crashes.length} times in a minute (last: ${reason}). Restart it from the Extensions view.`;
        lastHost = made.getSnapshot();
        publish();
      },
    });
    stopHost?.();
    stopHost = made.subscribe(publish);
    host = made;
    publish();
    // The window's one-shot events reach a new host too, so its extensions can activate on them.
    for (const event of events) void made.fire(event);
    for (const view of shown) if (view !== asking) void made.showView(view).catch(() => undefined);
    return made;
  };

  /** An event reaches a host only if an extension waits for it, or one is already running. */
  const fireEvent = async (event: ActivationEvent): Promise<void> => {
    if (disposed || held) return;
    const waiting = options.registry
      .getSnapshot()
      .extensions.some(
        (entry) =>
          entry.enabled &&
          entry.manifest.main &&
          entry.manifest.activationEvents.some((wanted) => wanted.kind === event.kind),
      );
    if (!waiting && !host) return;
    await current().fire(event);
  };
  /** After a restart, a reload or trust granted: views on screen are filled; events, lazily. */
  const resume = () => {
    if (disposed || held) return;
    if (shown.size) current();
    for (const event of events) void fireEvent(event).catch(() => undefined);
  };

  const end = async (reason: string) => {
    const ending = host;
    host = null;
    if (ending) {
      await ending.dispose();
      lastHost = { ...ending.getSnapshot(), hostReason: reason };
    }
    stopHost?.();
    stopHost = null;
    publish();
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    // Async throughout: a held or closed manager rejects; it never throws at the caller.
    activate: async (id: string) => current().activate(id),
    /**
     * An activation event. Startup and the workspace opening are remembered: a host made later
     * (after a crash, a restart, a reload) hears them too.
     */
    async fire(event: ActivationEvent): Promise<void> {
      if (
        (event.kind === "startup" || event.kind === "workspace") &&
        !events.some((e) => e.kind === event.kind)
      )
        events.push(event);
      await fireEvent(event);
    },
    executeCommand: async (command: string, ...args: unknown[]) =>
      current().executeCommand(command, ...args),
    showView: async (view: string) => {
      // Remembered even while held: trust granted or a restart fills it.
      shown.add(view);
      return current(view).showView(view);
    },
    hideView: (view: string) => {
      shown.delete(view);
      host?.hideView(view);
    },
    /** Ends the host; extensions activate again, lazily, in a new one. Clears a crash hold. */
    async restart(): Promise<void> {
      crashes = [];
      held = held && /trust/i.test(held) ? held : null;
      await end("Restarted.");
      resume();
    },
    /** Ends the host, re-discovers the installed extensions, and starts lazily again. */
    async reload(): Promise<void> {
      await end("Reloaded.");
      await options.rediscover?.();
      crashes = [];
      held = held && /trust/i.test(held) ? held : null;
      publish();
      resume();
    },
    /** Workspace Trust changed. Revoked: the host ends now. Granted: extensions may activate. */
    async setTrusted(trusted: boolean): Promise<void> {
      if (!trusted) {
        // Revocation is said as such only when there was something to stop.
        held =
          host && !host.finished
            ? "This folder is no longer trusted: its extensions were stopped. Trust it again to run them."
            : "This folder is not trusted, so its extensions' code does not run. Trust it from File › Manage Workspace Trust.";
        await end("Trust was revoked.");
        return;
      }
      if (held && /trust/i.test(held)) {
        held = null;
        publish();
        resume();
      }
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await end("The workspace was closed.");
      listeners.clear();
    },
  };
}

export type ExtensionHostManager = ReturnType<typeof createExtensionHostManager>;
