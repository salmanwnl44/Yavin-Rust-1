import type { FileNode } from "../../types";
import type { MenuItem } from "../ui/ContextMenu";
import React, { useState, useEffect, useRef } from "react";
import { ContextMenu } from "../ui/ContextMenu";
import { FileIcon, ChevronIcon, FolderClosedIcon, FolderOpenIcon } from "../ui/FileIcons";

// Helper to clean Windows extended path prefixes like //?/D:/... and backslashes
export function cleanPath(p: string) {
  return p
    .replace(/\\/g, "/")
    .replace(/^\/\/\?\/UNC\//, "//")
    .replace(/^\/\/\?\//, "")
    .replace(/^\/\?\?\//, "");
}

// Helper to compute relative path from workspace root
export function getRelativePath(fullPath: string, workspacePath: string) {
  if (!fullPath) return "";
  const cleanFull = cleanPath(fullPath);
  const cleanRoot = cleanPath(workspacePath);

  if (cleanRoot && (cleanFull === cleanRoot || cleanFull.startsWith(cleanRoot + "/"))) {
    let rel = cleanFull.slice(cleanRoot.length);
    if (rel.startsWith("/")) rel = rel.slice(1);
    return rel || ".";
  }
  return cleanFull;
}

export function Sidebar({
  activeTab,
  workspacePath,
  fileTree,
  gitStatus = {},
  onOpenFile,
  activeFile,
  onRefresh,
  onCreateFile,
  onCreateFolder,
  onRename,
  onDelete,
  onDuplicate,
  onCopyFile,
  onMoveFile,
  onReveal,
  onOpenFolderDialog,
}: {
  activeTab: string;
  workspacePath: string;
  fileTree: FileNode;
  gitStatus: Record<string, string>;
  onOpenFile: (path: string, name: string) => void;
  activeFile: string;
  onRefresh: () => void;
  onCreateFile: (path: string) => void;
  onCreateFolder: (path: string) => void;
  onRename: (oldPath: string, newPath: string) => void;
  onDelete: (path: string, isDir: boolean) => void;
  onDuplicate: (path: string) => void;
  onCopyFile: (src: string, dest: string) => void;
  onMoveFile: (src: string, dest: string) => void;
  onReveal: (path: string) => void;
  onOpenFolderDialog: () => void;
}) {
  const [expandedPaths, setExpandedPaths] = useState(new Set<string>());
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    node: FileNode;
    isRoot: boolean;
  } | null>(null); // { x, y, node, isRoot }
  const [renamingNode, setRenamingNode] = useState<FileNode | null>(null); // node being renamed
  const [renameValue, setRenameValue] = useState("");
  const [creatingUnder, setCreatingUnder] = useState<{
    parentPath: string;
    type: "file" | "folder";
  } | null>(null); // { parentPath, type: 'file'|'folder' }
  const [newEntryName, setNewEntryName] = useState("");
  const [deleteConfirmNode, setDeleteConfirmNode] = useState<FileNode | null>(null);
  const [clipboard, setClipboard] = useState<{ node: FileNode; op: "copy" | "cut" } | null>(null); // { node: FileNode, op: 'copy'|'cut' }
  const [draggedNode, setDraggedNode] = useState<FileNode | null>(null);
  const [dragOverTarget, setDragOverTarget] = useState<string | null>(null);

  const renameInputRef = useRef<HTMLInputElement>(null);
  const createInputRef = useRef<HTMLInputElement>(null);

  const cleanRootPath = cleanPath(fileTree?.path || workspacePath);

  // Look up git status for a specific node
  const getNodeGitStatus = (node: FileNode) => {
    if (!gitStatus || typeof gitStatus !== "object") return null;
    const clean = cleanPath(node.path);

    // Direct match
    if (gitStatus[clean]) return gitStatus[clean];

    // Case-insensitive / normalized lookup fallback
    for (const [p, st] of Object.entries(gitStatus)) {
      if (p.toLowerCase() === clean.toLowerCase()) {
        return st;
      }
    }

    // For folders: check if any child inside is modified/untracked
    if (node.is_dir) {
      const prefix = clean.toLowerCase() + "/";
      const hasChildren = Object.keys(gitStatus).some((p) => p.toLowerCase().startsWith(prefix));
      if (hasChildren) return "DIR_MODIFIED";
    }

    return null;
  };

  // Drag and Drop Event Handlers
  const handleDragStart = (e: React.DragEvent, node: FileNode) => {
    e.stopPropagation();
    setDraggedNode(node);
    e.dataTransfer.setData(
      "application/json",
      JSON.stringify({ path: node.path, name: node.name, is_dir: node.is_dir }),
    );
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragOver = (e: React.DragEvent, targetNode: FileNode | null, isRoot = false) => {
    e.preventDefault();
    e.stopPropagation();
    if (!draggedNode) return;

    if (isRoot) {
      if (cleanPath(draggedNode.path) === cleanRootPath) return;
      e.dataTransfer.dropEffect = "move";
      setDragOverTarget(cleanRootPath);
      return;
    }

    if (!targetNode) return;
    if (cleanPath(draggedNode.path) === cleanPath(targetNode.path)) return;

    // Prevent dragging directory into itself or its subtree
    if (
      draggedNode.is_dir &&
      cleanPath(targetNode.path).startsWith(cleanPath(draggedNode.path) + "/")
    ) {
      return;
    }

    const targetDir = targetNode.is_dir
      ? targetNode.path
      : cleanPath(targetNode.path).substring(0, cleanPath(targetNode.path).lastIndexOf("/"));

    const currentParent = cleanPath(draggedNode.path).substring(
      0,
      cleanPath(draggedNode.path).lastIndexOf("/"),
    );
    if (cleanPath(targetDir) === currentParent) return;

    e.dataTransfer.dropEffect = "move";
    setDragOverTarget(targetNode.is_dir ? targetNode.path : targetDir);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.stopPropagation();
    setDragOverTarget(null);
  };

  const handleDrop = (e: React.DragEvent, targetNode: FileNode | null, isRoot = false) => {
    e.preventDefault();
    e.stopPropagation();
    if (!draggedNode) {
      setDragOverTarget(null);
      return;
    }

    let destDir = workspacePath;
    if (!isRoot && targetNode) {
      if (targetNode.is_dir) {
        destDir = targetNode.path;
      } else {
        destDir = cleanPath(targetNode.path).substring(
          0,
          cleanPath(targetNode.path).lastIndexOf("/"),
        );
      }
    }

    const cleanDest = cleanPath(destDir);
    const currentParent = cleanPath(draggedNode.path).substring(
      0,
      cleanPath(draggedNode.path).lastIndexOf("/"),
    );

    if (
      cleanPath(draggedNode.path) !== cleanDest &&
      !cleanDest.startsWith(cleanPath(draggedNode.path) + "/") &&
      currentParent !== cleanDest
    ) {
      if (onMoveFile) {
        onMoveFile(draggedNode.path, cleanDest);
      } else {
        const newPath = `${cleanDest}/${draggedNode.name}`;
        onRename(draggedNode.path, newPath);
      }
      setExpandedPaths((prev) => new Set([...prev, cleanDest]));
    }

    setDraggedNode(null);
    setDragOverTarget(null);
  };

  const handleDragEnd = () => {
    setDraggedNode(null);
    setDragOverTarget(null);
  };

  useEffect(() => {
    if (cleanRootPath) {
      setExpandedPaths((prev) => new Set([...prev, cleanRootPath]));
    }
  }, [cleanRootPath]);

  useEffect(() => {
    if (renamingNode && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingNode]);

  useEffect(() => {
    if (creatingUnder && createInputRef.current) {
      createInputRef.current.focus();
    }
  }, [creatingUnder]);

  const toggleExpand = (path: string) => {
    const clean = cleanPath(path);
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(clean)) {
        next.delete(clean);
      } else {
        next.add(clean);
      }
      return next;
    });
  };

  const collapseAll = () => {
    setExpandedPaths(new Set());
  };

  const handleContextMenu = (e: React.MouseEvent, node: FileNode | null, isRoot = false) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      node: node || fileTree,
      isRoot,
    });
  };

  const submitRename = () => {
    if (renamingNode && renameValue.trim() && renameValue !== renamingNode.name) {
      const parent = cleanPath(renamingNode.path).substring(
        0,
        cleanPath(renamingNode.path).lastIndexOf("/"),
      );
      const newPath = `${parent}/${renameValue.trim()}`;
      onRename(renamingNode.path, newPath);
    }
    setRenamingNode(null);
    setRenameValue("");
  };

  const submitCreate = () => {
    if (creatingUnder && newEntryName.trim()) {
      const parent = creatingUnder.parentPath || workspacePath;
      const targetPath = `${cleanPath(parent)}/${newEntryName.trim()}`;
      if (creatingUnder.type === "file") {
        onCreateFile(targetPath);
      } else {
        onCreateFolder(targetPath);
      }
      setExpandedPaths((prev) => new Set([...prev, cleanPath(parent)]));
    }
    setCreatingUnder(null);
    setNewEntryName("");
  };

  const handlePaste = (targetDir: string) => {
    if (!clipboard || !clipboard.node) return;
    const destDir = cleanPath(targetDir || workspacePath);
    const destPath = `${destDir}/${clipboard.node.name}`;

    if (clipboard.op === "cut") {
      if (cleanPath(clipboard.node.path) !== destPath) {
        onRename(clipboard.node.path, destPath);
      }
      setClipboard(null);
    } else if (clipboard.op === "copy") {
      if (cleanPath(clipboard.node.path) === destPath) {
        onDuplicate(clipboard.node.path);
      } else if (onCopyFile) {
        onCopyFile(clipboard.node.path, destPath);
      }
    }
    setExpandedPaths((prev) => new Set([...prev, destDir]));
  };

  // Build items for right-click context menu
  const getContextMenuItems = (): MenuItem[] => {
    if (!contextMenu) return [];
    const { node, isRoot } = contextMenu;

    // 1. Root / Empty Space Context Menu
    if (isRoot || !node) {
      return [
        {
          icon: (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-indigo-400"
            >
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          ),
          label: "New File",
          shortcut: "Ctrl+N",
          onClick: () => setCreatingUnder({ parentPath: workspacePath, type: "file" }),
        },
        {
          icon: <FolderClosedIcon className="size-4" />,
          label: "New Folder",
          onClick: () => setCreatingUnder({ parentPath: workspacePath, type: "folder" }),
        },
        { divider: true },
        {
          icon: (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className={clipboard ? "text-emerald-400" : "text-zinc-500"}
            >
              <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
              <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
            </svg>
          ),
          label: clipboard ? `Paste (${clipboard.node.name})` : "Paste",
          shortcut: "Ctrl+V",
          disabled: !clipboard,
          onClick: () => handlePaste(workspacePath),
        },
        { divider: true },
        {
          icon: (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="text-blue-400"
            >
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          ),
          label: "Open Folder...",
          shortcut: "Ctrl+Shift+O",
          onClick: onOpenFolderDialog,
        },
        {
          icon: (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="text-zinc-400"
            >
              <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
              <path d="M21 3v5h-5" />
            </svg>
          ),
          label: "Refresh Explorer",
          onClick: onRefresh,
        },
        {
          icon: (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="text-zinc-400"
            >
              <polyline points="4 14 10 14 10 20" />
              <polyline points="20 10 14 10 14 4" />
              <line x1="14" y1="10" x2="21" y2="10" />
              <line x1="3" y1="14" x2="10" y2="14" />
            </svg>
          ),
          label: "Collapse All Folders",
          onClick: collapseAll,
        },
      ];
    }

    // 2. Folder Context Menu
    if (node.is_dir) {
      return [
        {
          icon: (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-indigo-400"
            >
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          ),
          label: "New File...",
          shortcut: "Ctrl+N",
          onClick: () => {
            setCreatingUnder({ parentPath: node.path, type: "file" });
            setExpandedPaths((prev) => new Set([...prev, cleanPath(node.path)]));
          },
        },
        {
          icon: <FolderClosedIcon name={node.name} className="size-4" />,
          label: "New Folder...",
          onClick: () => {
            setCreatingUnder({ parentPath: node.path, type: "folder" });
            setExpandedPaths((prev) => new Set([...prev, cleanPath(node.path)]));
          },
        },
        { divider: true },
        {
          icon: (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="text-zinc-400"
            >
              <circle cx="6" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <line x1="20" y1="4" x2="8.12" y2="15.88" />
              <line x1="14.47" y1="14.48" x2="20" y2="20" />
              <line x1="8.12" y1="8.12" x2="12" y2="12" />
            </svg>
          ),
          label: "Cut",
          shortcut: "Ctrl+X",
          onClick: () => setClipboard({ node, op: "cut" }),
        },
        {
          icon: (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="text-zinc-400"
            >
              <rect width="14" height="14" x="8" y="8" rx="2" />
              <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
            </svg>
          ),
          label: "Copy",
          shortcut: "Ctrl+C",
          onClick: () => setClipboard({ node, op: "copy" }),
        },
        {
          icon: (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className={clipboard ? "text-emerald-400" : "text-zinc-500"}
            >
              <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
              <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
            </svg>
          ),
          label: clipboard ? `Paste (${clipboard.node.name})` : "Paste",
          shortcut: "Ctrl+V",
          disabled: !clipboard,
          onClick: () => handlePaste(node.path),
        },
        { divider: true },
        {
          icon: (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="text-zinc-400"
            >
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
          ),
          label: "Copy Path",
          shortcut: "Shift+Alt+C",
          onClick: () => navigator.clipboard.writeText(cleanPath(node.path)),
        },
        {
          icon: (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="text-zinc-400"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          ),
          label: "Copy Relative Path",
          onClick: () => navigator.clipboard.writeText(getRelativePath(node.path, workspacePath)),
        },
        {
          icon: <FolderOpenIcon name={node.name} className="size-4" />,
          label: "Reveal in File Explorer",
          onClick: () => onReveal(node.path),
        },
        { divider: true },
        {
          icon: (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="text-amber-400"
            >
              <path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
            </svg>
          ),
          label: "Rename...",
          shortcut: "F2",
          onClick: () => {
            setRenamingNode(node);
            setRenameValue(node.name);
          },
        },
        {
          icon: (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="text-zinc-400"
            >
              <rect width="14" height="14" x="8" y="8" rx="2" />
              <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
            </svg>
          ),
          label: "Duplicate Folder",
          onClick: () => onDuplicate(node.path),
        },
        { divider: true },
        {
          icon: (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="text-red-400"
            >
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          ),
          label: "Delete Folder...",
          danger: true,
          shortcut: "Delete",
          onClick: () => setDeleteConfirmNode(node),
        },
      ];
    }

    // 3. File Context Menu
    const fileParent = cleanPath(node.path).substring(0, cleanPath(node.path).lastIndexOf("/"));
    return [
      {
        icon: <FileIcon name={node.name} className="size-4" />,
        label: "Open File",
        onClick: () => onOpenFile(node.path, node.name),
      },
      {
        icon: (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="text-indigo-400"
          >
            <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="12" y1="18" x2="12" y2="12" />
            <line x1="9" y1="15" x2="15" y2="15" />
          </svg>
        ),
        label: "New File in Directory",
        onClick: () => {
          setCreatingUnder({ parentPath: fileParent, type: "file" });
          setExpandedPaths((prev) => new Set([...prev, fileParent]));
        },
      },
      { divider: true },
      {
        icon: (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="text-zinc-400"
          >
            <circle cx="6" cy="6" r="3" />
            <circle cx="6" cy="18" r="3" />
            <line x1="20" y1="4" x2="8.12" y2="15.88" />
            <line x1="14.47" y1="14.48" x2="20" y2="20" />
            <line x1="8.12" y1="8.12" x2="12" y2="12" />
          </svg>
        ),
        label: "Cut",
        shortcut: "Ctrl+X",
        onClick: () => setClipboard({ node, op: "cut" }),
      },
      {
        icon: (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="text-zinc-400"
          >
            <rect width="14" height="14" x="8" y="8" rx="2" />
            <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
          </svg>
        ),
        label: "Copy",
        shortcut: "Ctrl+C",
        onClick: () => setClipboard({ node, op: "copy" }),
      },
      {
        icon: (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className={clipboard ? "text-emerald-400" : "text-zinc-500"}
          >
            <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
            <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
          </svg>
        ),
        label: clipboard ? `Paste (${clipboard.node.name})` : "Paste",
        shortcut: "Ctrl+V",
        disabled: !clipboard,
        onClick: () => handlePaste(fileParent),
      },
      { divider: true },
      {
        icon: (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="text-zinc-400"
          >
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          </svg>
        ),
        label: "Copy Path",
        shortcut: "Shift+Alt+C",
        onClick: () => navigator.clipboard.writeText(cleanPath(node.path)),
      },
      {
        icon: (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="text-zinc-400"
          >
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        ),
        label: "Copy Relative Path",
        onClick: () => navigator.clipboard.writeText(getRelativePath(node.path, workspacePath)),
      },
      {
        icon: <FolderOpenIcon name={node.name} className="size-4" />,
        label: "Reveal in File Explorer",
        onClick: () => onReveal(node.path),
      },
      { divider: true },
      {
        icon: (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="text-amber-400"
          >
            <path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
          </svg>
        ),
        label: "Rename...",
        shortcut: "F2",
        onClick: () => {
          setRenamingNode(node);
          setRenameValue(node.name);
        },
      },
      {
        icon: (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="text-zinc-400"
          >
            <rect width="14" height="14" x="8" y="8" rx="2" />
            <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
          </svg>
        ),
        label: "Duplicate File",
        shortcut: "Ctrl+D",
        onClick: () => onDuplicate(node.path),
      },
      { divider: true },
      {
        icon: (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="text-red-400"
          >
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        ),
        label: "Delete File...",
        danger: true,
        shortcut: "Delete",
        onClick: () => setDeleteConfirmNode(node),
      },
    ];
  };

  const renderTree = (node: FileNode, depth = 0): React.ReactNode => {
    if (!node) return null;
    const isExpanded = expandedPaths.has(cleanPath(node.path));
    const isSelected = cleanPath(activeFile) === cleanPath(node.path);
    const isRenaming = renamingNode && cleanPath(renamingNode.path) === cleanPath(node.path);
    const isCreatingHere =
      creatingUnder && cleanPath(creatingUnder.parentPath) === cleanPath(node.path);
    const isCut =
      clipboard &&
      clipboard.op === "cut" &&
      cleanPath(clipboard.node.path) === cleanPath(node.path);

    const isDragTarget = dragOverTarget && cleanPath(dragOverTarget) === cleanPath(node.path);
    const isBeingDragged = draggedNode && cleanPath(draggedNode.path) === cleanPath(node.path);

    const status = getNodeGitStatus(node);
    let statusBadge = null;
    let statusTextColor = "";

    if (status === "M") {
      statusTextColor = "text-amber-300";
      statusBadge = (
        <span className="ml-auto mr-1 shrink-0 rounded px-1 py-0.2 text-[8.5px] font-bold font-mono bg-amber-500/15 text-amber-400 border border-amber-500/30">
          M
        </span>
      );
    } else if (status === "U") {
      statusTextColor = "text-emerald-400";
      statusBadge = (
        <span className="ml-auto mr-1 shrink-0 rounded px-1 py-0.2 text-[8.5px] font-bold font-mono bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
          U
        </span>
      );
    } else if (status === "A") {
      statusTextColor = "text-cyan-300";
      statusBadge = (
        <span className="ml-auto mr-1 shrink-0 rounded px-1 py-0.2 text-[8.5px] font-bold font-mono bg-cyan-500/15 text-cyan-400 border border-cyan-500/30">
          A
        </span>
      );
    } else if (status === "D") {
      statusTextColor = "text-rose-400 line-through";
      statusBadge = (
        <span className="ml-auto mr-1 shrink-0 rounded px-1 py-0.2 text-[8.5px] font-bold font-mono bg-rose-500/15 text-rose-400 border border-rose-500/30">
          D
        </span>
      );
    } else if (status === "DIR_MODIFIED" && !isExpanded) {
      statusBadge = (
        <span
          title="Folder contains modified files"
          className="ml-auto mr-1.5 size-1.5 rounded-full bg-amber-400 shrink-0 shadow-[0_0_4px_rgba(251,191,36,0.7)]"
        />
      );
    }

    return (
      <div
        key={node.path}
        className={`group/folder relative flex flex-col ${isCut ? "opacity-40" : ""}`}
      >
        {/* Node Row */}
        <div
          tabIndex={0}
          aria-label={node.name}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") {
              event.preventDefault();
              event.stopPropagation();
              const bounds = event.currentTarget.getBoundingClientRect();
              setContextMenu({ x: bounds.left + 16, y: bounds.bottom, node, isRoot: false });
            } else if (event.key === "Enter") {
              event.preventDefault();
              if (node.is_dir) toggleExpand(node.path);
              else onOpenFile(node.path, node.name);
            }
          }}
          draggable={!renamingNode && !creatingUnder}
          onDragStart={(e) => handleDragStart(e, node)}
          onDragOver={(e) => handleDragOver(e, node, false)}
          onDragLeave={handleDragLeave}
          onDrop={(e) => handleDrop(e, node, false)}
          onDragEnd={handleDragEnd}
          onContextMenu={(e) => handleContextMenu(e, node, false)}
          onClick={() => {
            if (node.is_dir) {
              toggleExpand(node.path);
            } else {
              onOpenFile(node.path, node.name);
            }
          }}
          style={{ paddingLeft: `${depth * 14 + 10}px` }}
          className={`group relative flex h-6.5 items-center gap-1.5 pr-2 cursor-pointer transition-colors ${
            isBeingDragged
              ? "opacity-30 bg-zinc-900 border-dashed border border-zinc-700"
              : isDragTarget
                ? "bg-indigo-600/30 ring-1 ring-indigo-400 text-white font-medium rounded-sm"
                : isSelected
                  ? "bg-[#0f0f18] text-white font-medium border-l-2 border-indigo-500"
                  : "text-zinc-300 hover:bg-[#080808] hover:text-white"
          }`}
        >
          {/* SVG Chevron for folders */}
          {node.is_dir ? (
            <span
              onClick={(e) => {
                e.stopPropagation();
                toggleExpand(node.path);
              }}
              className="flex size-3.5 items-center justify-center shrink-0"
            >
              <ChevronIcon isExpanded={isExpanded} />
            </span>
          ) : (
            <span className="size-3.5 shrink-0" />
          )}

          {/* Premium Colorful SVG File/Folder Icon */}
          <FileIcon name={node.name} isDir={node.is_dir} isExpanded={isExpanded} />

          {/* Label / Inline Rename Input */}
          {isRenaming ? (
            <input
              ref={renameInputRef}
              type="text"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={submitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitRename();
                if (e.key === "Escape") setRenamingNode(null);
              }}
              onClick={(e) => e.stopPropagation()}
              className="h-5 flex-1 rounded bg-[#161616] border border-indigo-500 px-1 text-[11.5px] text-white outline-none"
            />
          ) : (
            <span
              className={`truncate text-[12px] leading-tight group-hover:text-white ${statusTextColor || "text-zinc-300"}`}
            >
              {node.name}
            </span>
          )}

          {/* Git Status Badge */}
          {statusBadge}

          {/* Quick Hover Actions */}
          <div className="hidden group-hover:flex items-center gap-1 text-zinc-500 shrink-0 ml-auto">
            {node.is_dir && (
              <>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setCreatingUnder({ parentPath: node.path, type: "file" });
                    setExpandedPaths((prev) => new Set([...prev, cleanPath(node.path)]));
                  }}
                  title="New File in folder"
                  className="hover:text-zinc-200 p-0.5"
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setCreatingUnder({ parentPath: node.path, type: "folder" });
                    setExpandedPaths((prev) => new Set([...prev, cleanPath(node.path)]));
                  }}
                  title="New Folder in folder"
                  className="hover:text-zinc-200 p-0.5"
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  </svg>
                </button>
              </>
            )}
          </div>
        </div>

        {/* Inline Input when creating inside this directory */}
        {isCreatingHere && (
          <div
            style={{ paddingLeft: `${(depth + 1) * 14 + 10}px` }}
            className="flex h-6.5 items-center gap-1.5 pr-2 bg-[#0c0c10]"
          >
            <span className="size-3.5 shrink-0" />
            <FileIcon
              name={creatingUnder.type === "folder" ? "dir" : "newfile.rs"}
              isDir={creatingUnder.type === "folder"}
            />
            <input
              ref={createInputRef}
              type="text"
              value={newEntryName}
              onChange={(e) => setNewEntryName(e.target.value)}
              placeholder={`new ${creatingUnder.type}...`}
              onBlur={submitCreate}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitCreate();
                if (e.key === "Escape") setCreatingUnder(null);
              }}
              className="h-5 flex-1 rounded bg-[#161616] border border-indigo-500 px-1 text-[11.5px] text-white outline-none"
            />
          </div>
        )}

        {/* Children render if expanded */}
        {node.is_dir && isExpanded && node.children && (
          <div className="relative flex flex-col">
            {/* Folder coverage / indent guide line */}
            <div
              className="absolute top-0 bottom-0 w-[1px] bg-transparent group-hover/folder:bg-white/[0.12] transition-colors duration-150 pointer-events-none z-10"
              style={{ left: `${depth * 14 + 17}px` }}
            />
            {node.children.map((child) => renderTree(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  const rootName = fileTree?.name || cleanRootPath.split("/").pop() || "WORKSPACE";
  const isRootExpanded = expandedPaths.has(cleanRootPath);

  if (activeTab !== "explorer") {
    return (
      <aside className="w-64 shrink-0 border-r border-[#181818] bg-[#050505] p-4 text-xs text-zinc-400">
        <p>{activeTab === "git" ? "Source control actions" : activeTab} are not connected yet.</p>
        <p className="mt-2">Use Explorer to browse files and view Git status badges.</p>
      </aside>
    );
  }

  return (
    <aside
      onContextMenu={(e) => handleContextMenu(e, fileTree, true)}
      className="flex w-[260px] flex-col border-r border-[#141414] bg-[#000000] select-none text-[12px] shrink-0 font-sans"
    >
      {/* 1. Top Section Title: Explorer */}
      <div className="flex h-9 items-center justify-between px-3 border-b border-[#101010] bg-[#000000] text-zinc-300">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-300">
          Explorer
        </span>
        <button
          onClick={onOpenFolderDialog}
          title="Open Folder"
          className="text-zinc-500 hover:text-zinc-200 p-1 rounded hover:bg-[#121212] transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="5" cy="12" r="2" />
            <circle cx="12" cy="12" r="2" />
            <circle cx="19" cy="12" r="2" />
          </svg>
        </button>
      </div>

      {/* 2. Collapsible Workspace Root Header Row */}
      <div
        onContextMenu={(e) => handleContextMenu(e, fileTree, false)}
        onClick={() => toggleExpand(cleanRootPath)}
        onDragOver={(e) => handleDragOver(e, null, true)}
        onDragLeave={handleDragLeave}
        onDrop={(e) => handleDrop(e, null, true)}
        className={`flex h-7 items-center justify-between px-2 border-b transition-colors cursor-pointer group text-zinc-200 font-semibold text-[11.5px] ${
          dragOverTarget === cleanRootPath
            ? "bg-indigo-900/40 border-indigo-500 text-white"
            : "bg-[#050505] border-[#121212] hover:bg-[#0a0a0a]"
        }`}
      >
        <div className="flex items-center gap-1.5 min-w-0 truncate">
          <ChevronIcon isExpanded={isRootExpanded} />
          <span className="truncate font-medium text-white">{rootName}</span>
        </div>

        {/* Action icons on workspace header row */}
        <div className="flex items-center gap-1 text-zinc-500 group-hover:text-zinc-300">
          {/* New File */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              setCreatingUnder({ parentPath: workspacePath, type: "file" });
              setExpandedPaths((prev) => new Set([...prev, cleanRootPath]));
            }}
            className="p-0.5 rounded hover:text-white transition-colors"
            title="New File"
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>

          {/* New Folder */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              setCreatingUnder({ parentPath: workspacePath, type: "folder" });
              setExpandedPaths((prev) => new Set([...prev, cleanRootPath]));
            }}
            className="p-0.5 rounded hover:text-white transition-colors"
            title="New Folder"
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          </button>

          {/* Refresh */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRefresh();
            }}
            className="p-0.5 rounded hover:text-white transition-colors"
            title="Refresh Explorer"
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
              <path d="M21 3v5h-5" />
            </svg>
          </button>

          {/* Collapse All */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              collapseAll();
            }}
            className="p-0.5 rounded hover:text-white transition-colors"
            title="Collapse Folders in Explorer"
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <polyline points="4 14 10 14 10 20" />
              <polyline points="20 10 14 10 14 4" />
              <line x1="14" y1="10" x2="21" y2="10" />
              <line x1="3" y1="14" x2="10" y2="14" />
            </svg>
          </button>
        </div>
      </div>

      {/* 3. Main File Tree Area */}
      <div
        onContextMenu={(e) => handleContextMenu(e, fileTree, true)}
        onDragOver={(e) => handleDragOver(e, null, true)}
        onDragLeave={handleDragLeave}
        onDrop={(e) => handleDrop(e, null, true)}
        className={`flex-1 overflow-y-auto py-1 min-h-0 bg-[#000000] transition-colors ${
          dragOverTarget === cleanRootPath ? "ring-2 ring-indigo-500/50 bg-indigo-950/20" : ""
        }`}
      >
        {fileTree ? (
          <div>
            {creatingUnder && cleanPath(creatingUnder.parentPath) === cleanRootPath && (
              <div className="flex h-6.5 items-center gap-1.5 px-3 bg-[#0c0c10]">
                <span className="size-3.5 shrink-0" />
                <FileIcon
                  name={creatingUnder.type === "folder" ? "dir" : "newfile.rs"}
                  isDir={creatingUnder.type === "folder"}
                />
                <input
                  ref={createInputRef}
                  type="text"
                  value={newEntryName}
                  onChange={(e) => setNewEntryName(e.target.value)}
                  placeholder={`new ${creatingUnder.type}...`}
                  onBlur={submitCreate}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submitCreate();
                    if (e.key === "Escape") setCreatingUnder(null);
                  }}
                  className="h-5 flex-1 rounded bg-[#161616] border border-indigo-500 px-1 text-[11.5px] text-white outline-none"
                />
              </div>
            )}
            {isRootExpanded && fileTree.children
              ? fileTree.children.map((child) => renderTree(child, 0))
              : null}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center p-6 text-center text-zinc-500 gap-3">
            <FolderClosedIcon className="size-10" />
            <p className="text-xs">No workspace opened</p>
            <button
              onClick={onOpenFolderDialog}
              className="rounded-lg bg-indigo-600 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-indigo-500 transition-colors shadow-sm"
            >
              Open Folder
            </button>
          </div>
        )}
      </div>

      {/* Floating Dynamic Context Menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          items={getContextMenuItems()}
        />
      )}

      {/* Delete Confirmation Modal */}
      {deleteConfirmNode && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4 select-none">
          <div className="flex w-full max-w-[380px] flex-col rounded-xl border border-[#262626] bg-[#0c0c0c] p-4.5 shadow-2xl gap-3">
            <div className="flex items-center gap-2.5 text-amber-400 font-semibold text-[13px]">
              <span className="text-lg">⚠</span>
              <span>Confirm Deletion</span>
            </div>
            <p className="text-[12px] text-zinc-300">
              Are you sure you want to permanently delete{" "}
              <strong className="text-white font-mono">'{deleteConfirmNode.name}'</strong>
              {deleteConfirmNode.is_dir ? " and all of its contents" : ""}?
            </p>
            <div className="flex items-center justify-end gap-2 pt-2 border-t border-[#181818]">
              <button
                onClick={() => setDeleteConfirmNode(null)}
                className="rounded-lg bg-[#181818] px-3 py-1.5 text-xs text-zinc-300 hover:bg-[#222] hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  onDelete(deleteConfirmNode.path, deleteConfirmNode.is_dir);
                  setDeleteConfirmNode(null);
                }}
                className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500 transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
