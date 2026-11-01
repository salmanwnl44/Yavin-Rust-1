import type { ExplorerCapabilities, ExplorerNodeId } from "../../services/explorerProvider";

/**
 * What the Explorer can be asked to do, and which provider capability each needs. The one
 * mapping the context menus, the keyboard and drag and drop all consult, so no path through
 * the UI can do something the provider says a node does not support.
 */
export type ExplorerAction =
  | "open"
  | "newFile"
  | "newFolder"
  | "rename"
  | "delete"
  | "cut"
  | "move"
  | "copy"
  | "duplicate"
  | "paste"
  | "refresh";

const NEEDS: Record<ExplorerAction, keyof ExplorerCapabilities> = {
  open: "canOpen",
  newFile: "canCreateFile",
  newFolder: "canCreateDirectory",
  rename: "canRename",
  delete: "canDelete",
  cut: "canMove",
  move: "canMove",
  copy: "canCopy",
  duplicate: "canCopy",
  // Pasting creates entries in the target folder.
  paste: "canCreateFile",
  refresh: "canRefresh",
};

/** Actions that act on a folder to put things in (the target's container), not the targets. */
export const INTO_FOLDER: ReadonlySet<ExplorerAction> = new Set(["newFile", "newFolder", "paste"]);

/** Whether every one of `ids` supports `action` -- false for none. */
export function allowed(
  capabilities: (id: ExplorerNodeId) => ExplorerCapabilities,
  ids: readonly (ExplorerNodeId | null | undefined)[],
  action: ExplorerAction,
): boolean {
  const need = NEEDS[action];
  return ids.length > 0 && ids.every((id) => !!id && capabilities(id)[need]);
}
