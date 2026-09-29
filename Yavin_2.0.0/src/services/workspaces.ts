import { useSyncExternalStore } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { GitRegistry } from "./git/registry.ts";
import { native, onLocalGitProgress } from "./native.ts";
import { clearProblems } from "./panel/problems.ts";
import { createLocalGitService } from "./localgit/service.ts";
import type { LocalGitService } from "./localgit/service.ts";
import { EMPTY_WORKSPACE, createWorkspaceManager } from "./workspaceManager.ts";
import type { WorkspaceContext, WorkspaceId } from "./workspaceManager.ts";

/**
 * The window's workspaces (see `workspaceManager.ts`): the one application-level owner of
 * which workspace is open, and of the services that belong to it.
 *
 * Owned by the workspace, and ended by its disposal (not by any view unmounting): its Git
 * registry (repositories, their `.git` watchers and polling, which one is selected, the list
 * remembered for it), the checker it is running, its terminals' shells and its Problems. The
 * window's own per-workspace UI state -- documents, editor views, tabs, the Explorer -- is
 * reset by the window on the same switch (`App.tsx`, `enterWorkspace`); language servers
 * follow the Explorer's roots.
 */

export interface WorkspaceServices {
  git: GitRegistry;
  /** The workspace's Local Git (its own history store, never real Git); none without a folder. */
  localGit: LocalGitService | null;
}

/** Where a workspace's Git repositories are remembered. */
export const gitStorageKey = (id: WorkspaceId) => `yavin.git.repos:${id}`;
/** Where they were remembered for every folder at once, before workspaces had their own. */
const LEGACY_GIT_KEY = "yavin.git.repos";

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
      return { git, localGit };
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
        // Its shells end with it, whatever the terminal views are doing.
        await native("terminal_close_all").catch(() => undefined);
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
