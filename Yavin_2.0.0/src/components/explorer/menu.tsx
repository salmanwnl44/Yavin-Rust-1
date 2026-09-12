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
  TrashIcon,
} from "../ui/Icons";
import { cleanPath, containingDir, getRelativePath } from "./paths";

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
}

const divider: MenuItem = { divider: true };

/** "File" / "Folder" for a single target, "3 Items" when a selection is being acted on. */
function subject(node: FileNode, count: number) {
  return count > 1 ? `${count} Items` : node.is_dir ? "Folder" : "File";
}

/** Cut / Copy / Paste — identical for files and folders, only the paste target differs. */
function clipboardItems(node: FileNode, clipboard: Clipboard, actions: MenuActions): MenuItem[] {
  return [
    {
      icon: <CutIcon className="text-zinc-400" />,
      label: "Cut",
      shortcut: "Ctrl+X",
      onClick: () => actions.cut(node),
    },
    {
      icon: <CopyIcon className="text-zinc-400" />,
      label: "Copy",
      shortcut: "Ctrl+C",
      onClick: () => actions.copy(node),
    },
    pasteItem(containingDir(node.path, node.is_dir), clipboard, actions),
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
  ];
}

/** Rename / Duplicate / Delete — the wording follows how many entries are targeted. */
function editItems(node: FileNode, count: number, actions: MenuActions): MenuItem[] {
  return [
    {
      icon: <PencilIcon className="text-amber-400" />,
      label: "Rename...",
      shortcut: "F2",
      disabled: count > 1,
      reason: count > 1 ? "Rename works on one entry at a time." : undefined,
      onClick: () => actions.rename(node),
    },
    {
      icon: <CopyIcon className="text-zinc-400" />,
      label: `Duplicate ${subject(node, count)}`,
      shortcut: count > 1 ? undefined : node.is_dir ? undefined : "Ctrl+D",
      onClick: () => actions.duplicate(node),
    },
    divider,
    {
      icon: <TrashIcon className="text-red-400" />,
      label: `Delete ${subject(node, count)}...`,
      danger: true,
      shortcut: "Delete",
      onClick: () => actions.remove(node),
    },
  ];
}

/** Builds the right-click menu for the workspace background, a folder, or a file. */
export function buildExplorerMenu({
  node,
  isRoot,
  workspacePath,
  clipboard,
  count,
  actions,
}: {
  node: FileNode | null;
  isRoot: boolean;
  workspacePath: string;
  clipboard: Clipboard;
  /** How many entries the destructive items will act on (1 unless a selection is targeted). */
  count: number;
  actions: MenuActions;
}): MenuItem[] {
  if (isRoot || !node) {
    return [
      {
        icon: <PlusIcon className="text-indigo-400" />,
        label: "New File",
        shortcut: "Ctrl+N",
        onClick: () => actions.newFile(workspacePath),
      },
      {
        icon: <FolderClosedIcon className="size-4" />,
        label: "New Folder",
        onClick: () => actions.newFolder(workspacePath),
      },
      divider,
      pasteItem(workspacePath, clipboard, actions),
      divider,
      {
        icon: <FolderPlusIcon className="text-blue-400" />,
        label: "Open Folder...",
        shortcut: "Ctrl+Shift+O",
        onClick: actions.openFolderDialog,
      },
      {
        icon: <RefreshIcon className="text-zinc-400" />,
        label: "Refresh Explorer",
        onClick: actions.refresh,
      },
      {
        icon: <CollapseIcon className="text-zinc-400" />,
        label: "Collapse All Folders",
        onClick: actions.collapseAll,
      },
    ];
  }

  if (node.is_dir) {
    return [
      {
        icon: <PlusIcon className="text-indigo-400" />,
        label: "New File...",
        shortcut: "Ctrl+N",
        onClick: () => actions.newFile(node.path),
      },
      {
        icon: <FolderClosedIcon name={node.name} className="size-4" />,
        label: "New Folder...",
        onClick: () => actions.newFolder(node.path),
      },
      divider,
      ...clipboardItems(node, clipboard, actions),
      divider,
      ...pathItems(node, actions),
      divider,
      ...editItems(node, count, actions),
    ];
  }

  return [
    {
      icon: <FileIcon name={node.name} className="size-4" />,
      label: "Open File",
      onClick: () => actions.openFile(node),
    },
    {
      icon: <FilePlusIcon className="text-indigo-400" />,
      label: "New File in Directory",
      onClick: () => actions.newFile(containingDir(node.path, false)),
    },
    divider,
    ...clipboardItems(node, clipboard, actions),
    divider,
    ...pathItems(node, actions),
    divider,
    ...editItems(node, count, actions),
  ];
}

/** Text put on the clipboard by Copy Path / Copy Relative Path, one entry per line. */
export function pathsToCopy(nodes: FileNode[], workspacePath: string, relative: boolean) {
  return nodes
    .map((node) => (relative ? getRelativePath(node.path, workspacePath) : cleanPath(node.path)))
    .join("\n");
}
