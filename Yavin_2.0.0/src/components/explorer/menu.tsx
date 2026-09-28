import type { FileNode } from "../../types";
import type { MenuItem } from "../ui/ContextMenu";
import { FileIcon, FolderClosedIcon, FolderOpenIcon } from "../ui/FileIcons";
import {
  CollapseIcon,
  CopyIcon,
  CutIcon,
  FilePlusIcon,
  FolderPlusIcon,
  LinkIcon,
  PasteIcon,
  PencilIcon,
  PlusIcon,
  RefreshIcon,
  RelativePathIcon,
  TerminalIcon,
  TrashIcon,
} from "../ui/Icons";
import { cleanPath, containingDir, getRelativePath } from "./paths";
import type { ExplorerAction } from "./actions";

/** A menu entry, present only if the provider supports what it does (`undefined` drops it). */
type Maybe = MenuItem | undefined;

export type Clipboard = { nodes: FileNode[]; op: "copy" | "cut" } | null;

/** Everything the explorer menus can do; supplied by the Sidebar. */
export interface MenuActions {
  newFile(parentPath: string): void;
  newFolder(parentPath: string): void;
  paste(targetDir: string): void;
  cut(node: FileNode): void;
  copy(node: FileNode): void;
  copyPath(node: FileNode, relative: boolean): void;
  rename(node: FileNode): void;
  duplicate(node: FileNode): void;
  remove(node: FileNode): void;
  reveal(path: string): void;
  openFile(node: FileNode): void;
  openFolderDialog(): void;
  refresh(): void;
  collapseAll(): void;
  /** Starts a terminal in `directory` -- "Open in Integrated Terminal". */
  openTerminal(directory: string): void;
}

const divider: MenuItem = { divider: true };

/** "File" / "Folder" for a single target, "3 Items" when a selection is being acted on. */
function subject(node: FileNode, count: number) {
  return count > 1 ? `${count} Items` : node.is_dir ? "Folder" : "File";
}

/** Cut / Copy / Paste — identical for files and folders, only the paste target differs. */
function clipboardItems(
  node: FileNode,
  clipboard: Clipboard,
  actions: MenuActions,
  can: (action: ExplorerAction) => boolean,
): Maybe[] {
  return [
    can("cut")
      ? {
          icon: <CutIcon className="text-zinc-400" />,
          label: "Cut",
          shortcut: "Ctrl+X",
          onClick: () => actions.cut(node),
        }
      : undefined,
    can("copy")
      ? {
          icon: <CopyIcon className="text-zinc-400" />,
          label: "Copy",
          shortcut: "Ctrl+C",
          onClick: () => actions.copy(node),
        }
      : undefined,
    can("paste") ? pasteItem(containingDir(node.path, node.is_dir), clipboard, actions) : undefined,
  ];
}

function pasteItem(targetDir: string, clipboard: Clipboard, actions: MenuActions): MenuItem {
  const held = clipboard
    ? clipboard.nodes.length === 1
      ? clipboard.nodes[0].name
      : `${clipboard.nodes.length} items`
    : "";
  return {
    icon: <PasteIcon className={clipboard ? "text-emerald-400" : "text-zinc-500"} />,
    label: clipboard ? `Paste (${held})` : "Paste",
    shortcut: "Ctrl+V",
    disabled: !clipboard,
    onClick: () => actions.paste(targetDir),
  };
}

/** Copy Path / Copy Relative Path / Reveal — identical for files and folders. */
function pathItems(node: FileNode, actions: MenuActions): MenuItem[] {
  return [
    {
      icon: <LinkIcon className="text-zinc-400" />,
      label: "Copy Path",
      shortcut: "Shift+Alt+C",
      onClick: () => actions.copyPath(node, false),
    },
    {
      icon: <RelativePathIcon className="text-zinc-400" />,
      label: "Copy Relative Path",
      onClick: () => actions.copyPath(node, true),
    },
    {
      icon: <FolderOpenIcon name={node.name} className="size-4" />,
      label: "Reveal in File Explorer",
      onClick: () => actions.reveal(node.path),
    },
    {
      icon: <TerminalIcon className="text-zinc-400" />,
      label: "Open in Integrated Terminal",
      // A file opens a terminal in the folder holding it, which is what VS Code does and
      // what anyone asking for a terminal "here" means.
      onClick: () =>
        actions.openTerminal(node.is_dir ? node.path : node.path.replace(/[\\/][^\\/]*$/, "")),
    },
  ];
}

/** Rename / Duplicate / Delete — the wording follows how many entries are targeted. */
function editItems(
  node: FileNode,
  count: number,
  actions: MenuActions,
  can: (action: ExplorerAction) => boolean,
): Maybe[] {
  return [
    can("rename")
      ? {
          icon: <PencilIcon className="text-amber-400" />,
          label: "Rename...",
          shortcut: "F2",
          disabled: count > 1,
          reason: count > 1 ? "Rename works on one entry at a time." : undefined,
          onClick: () => actions.rename(node),
        }
      : undefined,
    can("duplicate")
      ? {
          icon: <CopyIcon className="text-zinc-400" />,
          label: `Duplicate ${subject(node, count)}`,
          shortcut: count > 1 ? undefined : node.is_dir ? undefined : "Ctrl+D",
          onClick: () => actions.duplicate(node),
        }
      : undefined,
    divider,
    can("delete")
      ? {
          icon: <TrashIcon className="text-red-400" />,
          label: `Delete ${subject(node, count)}...`,
          danger: true,
          shortcut: "Delete",
          onClick: () => actions.remove(node),
        }
      : undefined,
  ];
}

/**
 * The entries that survive, without dividers that would now start or end the menu or sit
 * next to each other -- what is left when a provider does not support a section's actions.
 */
function tidy(items: Maybe[]): MenuItem[] {
  const kept = items.filter((item): item is MenuItem => item !== undefined);
  const out: MenuItem[] = [];
  for (const item of kept) {
    const isDivider = "divider" in item && item.divider;
    const last = out[out.length - 1];
    if (isDivider && (!last || ("divider" in last && last.divider))) continue;
    out.push(item);
  }
  while (out.length) {
    const last = out[out.length - 1];
    if (!("divider" in last && last.divider)) break;
    out.pop();
  }
  return out;
}

/**
 * Builds the right-click menu for a root (a root row, or the background of the tree), a
 * folder, or a file. Every entry is offered only if `can` says the provider supports it for
 * what the menu is about -- the targets, or the folder things would be created in.
 */
export function buildExplorerMenu({
  node,
  isRoot,
  workspacePath,
  clipboard,
  count,
  can,
  actions,
}: {
  node: FileNode | null;
  isRoot: boolean;
  /** The root the menu is for: where New File and Paste put things. */
  workspacePath: string;
  clipboard: Clipboard;
  /** How many entries the destructive items will act on (1 unless a selection is targeted). */
  count: number;
  can: (action: ExplorerAction) => boolean;
  actions: MenuActions;
}): MenuItem[] {
  if (isRoot || !node) {
    return tidy([
      can("newFile")
        ? {
            icon: <PlusIcon className="text-indigo-400" />,
            label: "New File",
            shortcut: "Ctrl+N",
            onClick: () => actions.newFile(workspacePath),
          }
        : undefined,
      can("newFolder")
        ? {
            icon: <FolderClosedIcon className="size-4" />,
            label: "New Folder",
            onClick: () => actions.newFolder(workspacePath),
          }
        : undefined,
      divider,
      can("paste") ? pasteItem(workspacePath, clipboard, actions) : undefined,
      divider,
      {
        icon: <FolderPlusIcon className="text-blue-400" />,
        label: "Open Folder...",
        shortcut: "Ctrl+Shift+O",
        onClick: actions.openFolderDialog,
      },
      can("refresh")
        ? {
            icon: <RefreshIcon className="text-zinc-400" />,
            label: "Refresh Explorer",
            onClick: actions.refresh,
          }
        : undefined,
      {
        icon: <CollapseIcon className="text-zinc-400" />,
        label: "Collapse All Folders",
        onClick: actions.collapseAll,
      },
    ]);
  }

  if (node.is_dir) {
    return tidy([
      can("newFile")
        ? {
            icon: <PlusIcon className="text-indigo-400" />,
            label: "New File...",
            shortcut: "Ctrl+N",
            onClick: () => actions.newFile(node.path),
          }
        : undefined,
      can("newFolder")
        ? {
            icon: <FolderClosedIcon name={node.name} className="size-4" />,
            label: "New Folder...",
            onClick: () => actions.newFolder(node.path),
          }
        : undefined,
      divider,
      ...clipboardItems(node, clipboard, actions, can),
      divider,
      ...pathItems(node, actions),
      divider,
      ...editItems(node, count, actions, can),
    ]);
  }

  return tidy([
    can("open")
      ? {
          icon: <FileIcon name={node.name} className="size-4" />,
          label: "Open File",
          onClick: () => actions.openFile(node),
        }
      : undefined,
    can("newFile")
      ? {
          icon: <FilePlusIcon className="text-indigo-400" />,
          label: "New File in Directory",
          onClick: () => actions.newFile(containingDir(node.path, false)),
        }
      : undefined,
    divider,
    ...clipboardItems(node, clipboard, actions, can),
    divider,
    ...pathItems(node, actions),
    divider,
    ...editItems(node, count, actions, can),
  ]);
}

/** Text put on the clipboard by Copy Path / Copy Relative Path, one entry per line. */
export function pathsToCopy(nodes: FileNode[], workspacePath: string, relative: boolean) {
  return nodes
    .map((node) => (relative ? getRelativePath(node.path, workspacePath) : cleanPath(node.path)))
    .join("\n");
}
