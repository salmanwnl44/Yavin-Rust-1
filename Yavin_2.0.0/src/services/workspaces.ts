import { useSyncExternalStore } from "react";
import { GitRegistry } from "./git/registry.ts";
import { EMPTY_WORKSPACE, createWorkspaceManager } from "./workspaceManager.ts";
import type { WorkspaceContext, WorkspaceId } from "./workspaceManager.ts";

/**
 * The window's workspaces (see `workspaceManager.ts`): the one application-level owner of
 * which workspace is open, and of the services that belong to it.
 *
 * Workspace-scoped today: Git (repositories, their `.git` watchers and polling, which one is
 * selected, and the list remembered for the folder). The window's own per-workspace state --
 * documents, editor views, tabs, the Explorer, terminals, Problems -- is reset or remounted by
 * the window on the same switch (`App.tsx`, `enterWorkspace`).
 */

export interface WorkspaceServices {
  git: GitRegistry;
}

/** Where a workspace's Git repositories are remembered. */
export const gitStorageKey = (id: WorkspaceId) => `yavin.git.repos:${id}`;
/** Where they were remembered for every folder at once, before workspaces had their own. */
const LEGACY_GIT_KEY = "yavin.git.repos";

export const workspaces = createWorkspaceManager<WorkspaceServices>(
  {
    create(id, folders) {
      const git = new GitRegistry(
        id === EMPTY_WORKSPACE
          ? // No folder: repositories added by hand are kept for as long as the window is,
            // and remembered nowhere.
            { storageKey: null }
          : // The first folder opened after the upgrade adopts the old shared list, once.
            { storageKey: gitStorageKey(id), adoptFrom: LEGACY_GIT_KEY },
      );
      // The workspace's repositories: those remembered for it, and its own folder's.
      if (folders.length) void git.restore().then(() => git.open(folders[0], { silent: true }));
      return { git };
    },
    dispose: (services) => services.git.dispose(),
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
