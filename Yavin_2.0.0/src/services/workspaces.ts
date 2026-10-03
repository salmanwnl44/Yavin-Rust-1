import { useSyncExternalStore } from "react";
import { Channel, isTauri } from "@tauri-apps/api/core";
import { GitRegistry } from "./git/registry.ts";
import { native, onLocalGitProgress } from "./native.ts";
import { clearProblems } from "./panel/problems.ts";
import { createLocalGitService } from "./localgit/service.ts";
import type { LocalGitService } from "./localgit/service.ts";
import { EMPTY_WORKSPACE, createWorkspaceManager } from "./workspaceManager.ts";
import { createTerminalServices } from "./terminalService.ts";
import type { TerminalService } from "./terminalService.ts";
import { createTerminalUi } from "./terminalUi.ts";
import type { TerminalUi } from "./terminalUi.ts";
import { createProfileRegistry } from "./terminalProfiles.ts";
import { createTerminalSettings } from "./terminalSettings.ts";
import type { WorkspaceContext, WorkspaceId } from "./workspaceManager.ts";

/**
 * The window's workspaces (see `workspaceManager.ts`): the one application-level owner of
 * which workspace is open, and of the services that belong to it.
 *
 * Owned by the workspace, and ended by its disposal (not by any view unmounting): its Git
 * registry (repositories, their `.git` watchers and polling, which one is selected, the list
 * remembered for it), the checker it is running and its Problems. Its terminals are the
 * exception: they belong to the workspace but outlive a switch (`terminals` below). The
 * window's own per-workspace UI state -- documents, editor views, tabs, the Explorer -- is
 * reset by the window on the same switch (`App.tsx`, `enterWorkspace`); language servers
 * follow the Explorer's roots.
 */

export interface WorkspaceServices {
  git: GitRegistry;
  /** The workspace's Local Git (its own history store, never real Git); none without a folder. */
  localGit: LocalGitService | null;
  /**
   * The workspace's terminals (TERMINAL-03). Not disposed with the context: leaving the
   * workspace detaches their views and the shells go on, and opening it again finds them. They
   * end when the window does, or when they are closed.
   */
  terminals: TerminalService;
  /**
   * How the workspace's terminals are shown, and the commands on them (TERMINAL-04): panes,
   * split, focus, zoom, find, bells. View state only -- the sessions are `terminals`' -- and
   * kept with it, so a workspace's terminals come back laid out as they were left.
   */
  terminalUi: TerminalUi;
}

/**
 * Every workspace's terminals, for the life of the window: one service per WorkspaceId, each
 * subscription on its own channel.
 */
export const terminalServices = createTerminalServices({
  open: (args) => native("terminal_open", args as Parameters<typeof native<"terminal_open">>[1]),
  subscribe: (args) =>
    native("terminal_subscribe", args as Parameters<typeof native<"terminal_subscribe">>[1]),
  unsubscribe: (request) => native("terminal_unsubscribe", { request }),
  ack: (request) => native("terminal_ack", { request }),
  write: (request) => native("terminal_write", { request }),
  resize: (request) => native("terminal_resize", { request }),
  close: (request) => native("terminal_close", { request }),
  kill: (request) => native("terminal_kill", { request }),
  closeAll: () => native("terminal_close_all"),
  channel: (receive) => new Channel<unknown>(receive),
});

/** Where a workspace's Git repositories are remembered. */
export const gitStorageKey = (id: WorkspaceId) => `yavin.git.repos:${id}`;
/** Where they were remembered for every folder at once, before workspaces had their own. */
const LEGACY_GIT_KEY = "yavin.git.repos";

/**
 * What the terminal keeps across restarts (TERMINAL-07): profiles, defaults, the integration
 * setting and the layout -- never sessions or their output. Written as it changes; a layout
 * still settling is written when the page goes.
 */
export const terminalSettings = createTerminalSettings();
if (typeof window !== "undefined")
  window.addEventListener("pagehide", () => terminalSettings.flush());

/**
 * Terminal profiles (TERMINAL-05): built-in profiles from discovery (asked for once, for the
 * window), user profiles, and each workspace's own, kept by `terminalSettings`.
 */
export const terminalProfiles = createProfileRegistry(
  () => native("terminal_shells"),
  terminalSettings,
);

const terminalUis = new Map<WorkspaceId, TerminalUi>();
/**
 * A workspace's terminal UI, for the life of the window like its TerminalService. Declared
 * before `workspaces`, which makes the first (empty) workspace as soon as it is created.
 */
function terminalUiFor(id: WorkspaceId): TerminalUi {
  let ui = terminalUis.get(id);
  if (!ui) {
    ui = createTerminalUi(terminalServices.forWorkspace(id), terminalProfiles.forWorkspace(id), {
      // Its own layout, else the one last used anywhere, else the defaults.
      layout: terminalSettings.workspace(id).layout ?? terminalSettings.user().layout,
      saveLayout(layout) {
        terminalSettings.updateWorkspace(id, { layout });
        terminalSettings.updateUser({ layout });
      },
      shellIntegration: () => terminalSettings.shellIntegration(id),
    });
    terminalUis.set(id, ui);
  }
  return ui;
}

export const workspaces = createWorkspaceManager<WorkspaceServices>(
  {
    create(id, folders, lifecycle) {
      const git = new GitRegistry(
        id === EMPTY_WORKSPACE
          ? // No folder: repositories added by hand are kept for as long as the window is,
            // and remembered nowhere.
            { storageKey: null }
          : // The first folder opened after the upgrade adopts the old shared list, once.
            { storageKey: gitStorageKey(id), adoptFrom: LEGACY_GIT_KEY },
      );
      // The workspace's repositories: those remembered for it, and each of its folders' own.
      if (folders.length)
        void git
          .restore()
          .then(() => Promise.all(folders.map((folder) => git.open(folder, { silent: true }))));
      // Local Git opens the store of the workspace the native side has open (which these
      // folders must be); only in the app, where there is a native side.
      const localGit =
        folders.length && isTauri()
          ? createLocalGitService(
              folders,
              lifecycle,
              (command, args) =>
                (native as unknown as (c: string, a: unknown) => Promise<unknown>)(command, args),
              { onProgress: onLocalGitProgress },
            )
          : null;
      return {
        git,
        localGit,
        terminals: terminalServices.forWorkspace(id),
        terminalUi: terminalUiFor(id),
      };
    },
    async dispose(services) {
      services.git.dispose();
      // Its Local Git handle is given back (the store closes, releasing its writer lock, when
      // no handle is left); anything still in flight is refused.
      await services.localGit?.close();
      if (isTauri()) {
        // A checker still running in the folder left is stopped; its answer would be dropped
        // anyway (it checks the workspace it started in).
        await native("cancel_checker").catch(() => undefined);
        // Its terminals are not ended: their views detach (the panel is remounted per
        // workspace) and the workspace's TerminalService keeps them for its return.
      }
      // What it reported is about its files, not the next workspace's.
      clearProblems();
    },
  },
  { log: (message) => console.warn(message) },
);

/** The workspace in the window, re-rendering when another one is opened. */
export function useWorkspace(): WorkspaceContext<WorkspaceServices> {
  return useSyncExternalStore(workspaces.subscribe, workspaces.current);
}

/**
 * The Git registry of the workspace in the window, for code outside React that acts on the
 * workspace in front (a watcher event, a clone, a guarded operation). A registry held from an
 * earlier workspace is disposed and empty; it can never act on this one.
 */
export const currentGit = (): GitRegistry => workspaces.current().services.git;
