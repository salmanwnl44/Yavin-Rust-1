import { useSyncExternalStore } from "react";
import { Channel, isTauri } from "@tauri-apps/api/core";
import { GitRegistry } from "./git/registry.ts";
import { native, onLocalGitProgress } from "./native.ts";
import { clearProblems, publishProblems } from "./panel/problems.ts";
import { createCheckerService, type CheckerService } from "./panel/checkers.ts";
import { createLocalGitService } from "./localgit/service.ts";
import type { LocalGitService } from "./localgit/service.ts";
import { EMPTY_WORKSPACE, createWorkspaceManager } from "./workspaceManager.ts";
import { createTerminalServices } from "./terminalService.ts";
import type { TerminalService } from "./terminalService.ts";
import { createTerminalUi } from "./terminalUi.ts";
import type { TerminalUi } from "./terminalUi.ts";
import { createProfileRegistry } from "./terminalProfiles.ts";
import { createTerminalSettings } from "./terminalSettings.ts";
import { createSettingsRegistry } from "./settings/settings.ts";
import { EDITOR_SETTING_LIST } from "../editor/editorSettings.ts";
import { TASK_DEFINITIONS } from "./tasks/model.ts";
import { createTaskService, type TaskService } from "./tasks/service.ts";
import { readTrust } from "./trust.ts";
import { createBreakpointRegistry } from "./debug/breakpoints.ts";
import { DEBUG_SETTING_LIST } from "./debug/config.ts";
import { createNativeAdapterTransport } from "./debug/nativeTransport.ts";
import { createDebugService, type DebugService } from "./debug/service.ts";
import { createExtensionRegistry } from "./extensions/registry.ts";
import { createExtensionStorage } from "./extensions/storage.ts";
import { createExtensionHost, type ExtensionHost } from "./extensions/host.ts";
import { HELLO_WORLD_MANIFEST, helloWorld } from "../extensions/samples/helloWorld.ts";
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
  /**
   * The workspace's checkers (IDE-01): which apply, the run in progress, its outcome. Disposed
   * with the workspace: a run still going is stopped and its answer never published.
   */
  checkers: CheckerService;
  /**
   * The workspace's tasks (IDE-04): which there are and what each execution is doing. Tasks
   * run in the workspace's terminals; disposing the workspace stops what they are running.
   */
  tasks: TaskService;
  /**
   * The workspace's debugger (IDE-05): its debug session, over a debug adapter the native side
   * runs. Disposing the workspace ends the session, the adapter and the program it debugs.
   */
  debug: DebugService;
  /**
   * The workspace's extension host (IDE-07): the extensions activated for it. Disposing the
   * workspace deactivates them; nothing they do afterwards reaches the next workspace.
   */
  extensions: ExtensionHost;
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
 * The window's settings (IDE-03): user and per-workspace preferences, each defined by the
 * subsystem it belongs to and applied there. Only the editor's for now; the terminal keeps its
 * own (`terminalSettings`, below).
 */
export const settings = createSettingsRegistry([
  ...EDITOR_SETTING_LIST,
  TASK_DEFINITIONS,
  ...DEBUG_SETTING_LIST,
]);

/**
 * The window's breakpoints (IDE-05), one set per workspace by resource identity: kept while the
 * window lives, so switching file or workspace and back keeps them.
 */
export const breakpoints = createBreakpointRegistry();

/**
 * The window's extensions (IDE-07): which are known and enabled, and what they contribute
 * (`extensions/registry.ts`). Their settings go to `settings` above, which stays their owner.
 */
export const extensionRegistry = createExtensionRegistry({ settings });
/** Extensions' own state, per extension and scope (`extensions/storage.ts`). */
export const extensionStorage = createExtensionStorage(undefined, (id, message) =>
  console.warn(`${id}: ${message}`),
);
// The sample extension, in development and test-hook builds only: the release ships none.
const env = (import.meta as { env?: Record<string, unknown> }).env;
if (env?.DEV || env?.VITE_TEST_HOOKS === "1")
  extensionRegistry.add(HELLO_WORLD_MANIFEST, { kind: "bundled", module: helloWorld }, "bundled");

/** What extensions say to the user (`window.show*Message`), for the window to show. */
export type ExtensionMessage = {
  level: "info" | "warning" | "error";
  extensionId: string;
  text: string;
};
const extensionMessageListeners = new Set<(message: ExtensionMessage) => void>();
export function onExtensionMessage(listener: (message: ExtensionMessage) => void): () => void {
  extensionMessageListeners.add(listener);
  return () => {
    extensionMessageListeners.delete(listener);
  };
}

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
      const tasks = createTaskService({
        workspace: folders.length ? id : null,
        folders,
        settings,
        terminals: terminalServices.forWorkspace(id),
        ui: terminalUiFor(id),
        profiles: terminalProfiles.forWorkspace(id),
        // Workspace Trust, asked of the native side before every execution.
        trusted: () => readTrust().then((trust) => trust.trusted),
        publish: publishProblems,
      });
      return {
        git,
        localGit,
        terminals: terminalServices.forWorkspace(id),
        terminalUi: terminalUiFor(id),
        checkers: createCheckerService(
          {
            available: () => native("available_checkers"),
            run: (checker) => native("run_checker", { id: checker }),
            cancel: () => native("cancel_checker"),
          },
          publishProblems,
        ),
        tasks,
        extensions: createExtensionHost({
          registry: extensionRegistry,
          settings,
          storage: extensionStorage,
          workspace: folders.length ? id : null,
          folder: folders[0] ?? null,
          generation: lifecycle.generation,
          // Workspace Trust, asked before any extension code runs.
          trusted: () => readTrust().then((trust) => trust.trusted),
          notify: (level, extensionId, text) => {
            // Only the workspace in front speaks: a closed one's host is already inert.
            if (!lifecycle.isActive()) return;
            for (const listener of [...extensionMessageListeners])
              listener({ level, extensionId, text });
          },
        }),
        debug: createDebugService({
          workspace: folders.length ? id : null,
          folders,
          settings,
          breakpoints: folders.length ? breakpoints.forWorkspace(id) : null,
          transport: createNativeAdapterTransport(),
          // Workspace Trust, asked of the native side before every session.
          trusted: () => readTrust().then((trust) => trust.trusted),
          // A configuration's preLaunchTask runs as any task does (IDE-04), to its end.
          runTask: (taskId) =>
            tasks.run(taskId).then((run) => ({ state: run.state, error: run.error })),
        }),
      };
    },
    async dispose(services) {
      services.git.dispose();
      // Its Local Git handle is given back (the store closes, releasing its writer lock, when
      // no handle is left); anything still in flight is refused.
      await services.localGit?.close();
      // A checker still running in the folder left is stopped, and its answer never published.
      services.checkers.dispose();
      // What its tasks are running is ended: they ran for its folders.
      services.tasks.dispose();
      // Its debug session ends, and the adapter and the program it debugs with it.
      services.debug.dispose();
      // Its extensions are deactivated: their subscriptions disposed, nothing of them left.
      await services.extensions.dispose();
      if (isTauri()) {
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
