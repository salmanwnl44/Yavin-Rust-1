import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FileNode } from "../../types";
import type { Decorations } from "../../services/git";
import { folderName, parentPath } from "../../services/paths";
import { isWithin, parentOf, validateEntryName } from "../../services/workspace";
import { requestTerminal } from "../../services/terminal";
import { ContextMenu } from "../ui/ContextMenu";
import { FolderClosedIcon, ChevronIcon } from "../ui/FileIcons";
import { CollapseIcon, MoreIcon, PlusIcon, FolderPlusIcon, RefreshIcon } from "../ui/Icons";
import { buildExplorerMenu, pathsToCopy, type Clipboard, type MenuActions } from "../explorer/menu";
import { cleanPath, containingDir } from "../explorer/paths";
import { CreateRow, ROW_HEIGHT, StatusRow, TreeRow, type RowApi } from "../explorer/TreeRow";

export { cleanPath, getRelativePath } from "../explorer/paths";

/** Extra rows rendered above and below the viewport so scrolling never shows a gap. */
const OVERSCAN = 10;

type NodeRow = {
  kind: "node";
  key: string;
  path: string;
  depth: number;
  node: FileNode;
  expanded: boolean;
};
type Row =
  | NodeRow
  | { kind: "create"; key: string; depth: number }
  | { kind: "status"; key: string; depth: number; path: string };

export interface DeleteTarget {
  path: string;
  isDir: boolean;
}

interface SidebarProps {
  visible: boolean;
  activeTab: string;
  workspacePath: string;
  fileTree: FileNode | null;
  decorations: Decorations;
  onLoadDirectory: (path: string) => Promise<void>;
  onOpenFile: (path: string, name: string) => void;
  activeFile: string;
  onRefresh: () => void;
  onCreateFile: (path: string) => void;
  onCreateFolder: (path: string) => void;
  onRename: (oldPath: string, newPath: string) => void;
  onDelete: (targets: DeleteTarget[]) => void;
  onDuplicate: (path: string) => void;
  onCopyFile: (src: string, dest: string) => void;
  onMoveFile: (src: string, dest: string) => void;
  onReveal: (path: string) => void;
  onOpenFolderDialog: () => void;
  /** Folders opened before, offered when there is no folder open. */
  recentFolders?: string[];
  onOpenRecentFolder?: (folder: string) => void;
  /** What this folder had unfolded last time, and where it was scrolled. */
  initialExpanded?: string[];
  initialScroll?: number;
  /** Reports unfolding and scrolling, so the session can be written. */
  onExplorerState?: (state: { expanded: string[]; scroll: number }) => void;
}

export function Sidebar(props: SidebarProps) {
  const { visible, activeTab, workspacePath, fileTree, decorations, onLoadDirectory } = props;

  // Seeded from the session, so a reopened folder is unfolded the way it was left. Folders
  // whose children are not loaded yet are listed on demand, exactly as an unfold does.
  const [expandedPaths, setExpandedPaths] = useState(() => new Set<string>(props.initialExpanded));
  const [selection, setSelection] = useState(() => new Set<string>());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    node: FileNode | null;
    isRoot: boolean;
  } | null>(null);
  const [renaming, setRenaming] = useState<{ path: string; name: string; value: string } | null>(
    null,
  );
  const [creating, setCreating] = useState<{ parent: string; type: "file" | "folder" } | null>(
    null,
  );
  const [newName, setNewName] = useState("");
  const [inlineError, setInlineError] = useState("");
  const [loadErrors, setLoadErrors] = useState<Record<string, string>>({});
  const [clipboard, setClipboard] = useState<Clipboard>(null);
  const [dragged, setDragged] = useState<FileNode[]>([]);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const inFlight = useRef(new Set<string>());
  const loadAttempts = useRef(new Map<string, number>());
  const createInputRef = useRef<HTMLInputElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  /** Set when the tree itself moves focus, so revealing a file never steals it from the editor. */
  const pendingFocus = useRef<string | null>(null);

  const rootPath = cleanPath(fileTree?.path || workspacePath);
  const rootExpanded = expandedPaths.has(rootPath);

  // --- Tree flattening -----------------------------------------------------
  // One pass turns the tree into the exact list of visible rows plus the lookup
  // tables navigation needs, and collects the folders still awaiting a listing.
  const { rows, nodeRows, rowIndex, navIndex, nodes, pending } = useMemo(() => {
    const rows: Row[] = [];
    const nodeRows: NodeRow[] = [];
    const rowIndex = new Map<string, number>();
    const navIndex = new Map<string, number>();
    const nodes = new Map<string, FileNode>();
    const pending: string[] = [];
    if (!fileTree) return { rows, nodeRows, rowIndex, navIndex, nodes, pending };

    const emitCreate = (parent: string, depth: number) => {
      if (creating && creating.parent === parent)
        rows.push({ kind: "create", key: "@create", depth });
    };

    const walk = (children: FileNode[], depth: number) => {
      for (const node of children) {
        const path = cleanPath(node.path);
        const expanded = node.is_dir && expandedPaths.has(path);
        const row: NodeRow = { kind: "node", key: path, path, depth, node, expanded };
        rowIndex.set(path, rows.length);
        navIndex.set(path, nodeRows.length);
        nodes.set(path, node);
        rows.push(row);
        nodeRows.push(row);
        if (node.is_dir) emitCreate(path, depth + 1);
        if (!expanded) continue;
        if (node.children) {
          walk(node.children, depth + 1);
        } else {
          rows.push({ kind: "status", key: path + "@status", depth: depth + 1, path });
          pending.push(path);
        }
      }
    };

    emitCreate(rootPath, 0);
    if (rootExpanded) walk(fileTree.children ?? [], 0);
    return { rows, nodeRows, rowIndex, navIndex, nodes, pending };
  }, [fileTree, expandedPaths, creating, rootPath, rootExpanded]);

  // An expanded folder whose children are not loaded yet is listed on demand.
  useEffect(() => {
    // A folder that left `pending` has its children, so its attempt count is spent.
    for (const path of loadAttempts.current.keys())
      if (!pending.includes(path)) loadAttempts.current.delete(path);

    for (const path of pending) {
      if (inFlight.current.has(path) || loadErrors[path]) continue;
      const attempts = (loadAttempts.current.get(path) ?? 0) + 1;
      loadAttempts.current.set(path, attempts);
      if (attempts > 2) {
        setLoadErrors((previous) => ({ ...previous, [path]: "This folder could not be loaded." }));
        continue;
      }
      inFlight.current.add(path);
      onLoadDirectory(path)
        .catch((error) => setLoadErrors((previous) => ({ ...previous, [path]: String(error) })))
        .finally(() => inFlight.current.delete(path));
    }
  }, [pending, loadErrors, onLoadDirectory]);

  useEffect(() => {
    if (rootPath) setExpandedPaths((previous) => new Set([...previous, rootPath]));
  }, [rootPath]);

  useEffect(() => {
    if (creating) createInputRef.current?.focus();
  }, [creating]);

  // --- Windowing -----------------------------------------------------------
  // Rows are a fixed height, so the visible slice is arithmetic rather than measurement.
  const [view, setView] = useState({ top: 0, height: 720 });

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const measure = () =>
      setView((previous) =>
        previous.top === element.scrollTop && previous.height === element.clientHeight
          ? previous
          : { top: element.scrollTop, height: element.clientHeight },
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    element.addEventListener("scroll", measure, { passive: true });
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", measure);
    };
  }, []);

  /**
   * Restoring the saved scroll offset.
   *
   * Two things make this harder than one assignment. The tree arrives a directory at a time,
   * so a viewport that is still short silently clamps the offset to what little it can
   * scroll; and this component remounts on every folder change, when the tree is momentarily
   * null. So the target is captured once at mount -- never re-read from the prop, which the
   * reporting below would otherwise have overwritten with the current zero -- and reapplied
   * as rows arrive until the offset actually sticks.
   */
  const wantedScroll = useRef(props.initialScroll ?? 0);
  const restored = useRef(wantedScroll.current === 0);
  const attempts = useRef(0);
  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (restored.current || !element || !rows.length) return;
    element.scrollTop = wantedScroll.current;
    // Give up after a few tries so that an offset into rows that no longer exist -- files
    // deleted since -- cannot stop the explorer reporting its state forever.
    attempts.current += 1;
    if (element.scrollTop >= wantedScroll.current - 1 || attempts.current > 10)
      restored.current = true;
  }, [rows.length]);

  const expandedRef = useRef(expandedPaths);
  expandedRef.current = expandedPaths;
  const reportState = props.onExplorerState;
  const report = useCallback(() => {
    // Nothing is reported until the restore has settled: a report before then says the
    // explorer is at the top, which is exactly what would overwrite the offset being
    // restored -- and it is written back to the session, losing it for good.
    if (!reportState || !restored.current) return;
    reportState({
      expanded: [...expandedRef.current],
      // Rounded because sub-pixel scroll is meaningless to restore, and a whole number is
      // what someone reading the session file by hand expects to find.
      scroll: Math.round(viewportRef.current?.scrollTop ?? 0),
    });
  }, [reportState]);

  // Unfolding is reported as it happens; it is a deliberate act and there is one of them.
  useEffect(report, [expandedPaths, report]);
  // Scrolling is reported once it settles. Reporting every frame wrote the session file
  // every 400ms for as long as a drag lasted, for a value that was about to change again.
  useEffect(() => {
    const timer = setTimeout(report, 600);
    return () => clearTimeout(timer);
  }, [view.top, report]);

  const first = Math.max(0, Math.floor(view.top / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((view.top + view.height) / ROW_HEIGHT) + OVERSCAN);

  // Keep the focused row on screen; scrolling re-renders the window around it.
  useLayoutEffect(() => {
    const element = viewportRef.current;
    const index = focused === null ? undefined : rowIndex.get(focused);
    if (!element || index === undefined) return;
    const top = index * ROW_HEIGHT;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight)
      element.scrollTop = top + ROW_HEIGHT - element.clientHeight;
  }, [focused, rowIndex]);

  // Move real focus only once the row exists in the DOM, which may be a render later.
  useEffect(() => {
    const wanted = pendingFocus.current;
    if (!wanted) return;
    const row = viewportRef.current?.querySelector<HTMLElement>(
      `[data-path="${CSS.escape(wanted)}"]`,
    );
    if (!row) return;
    pendingFocus.current = null;
    if (document.activeElement !== row) row.focus();
  });

  // --- Reveal the active editor file ---------------------------------------
  const revealed = useRef("");
  useEffect(() => {
    const path = cleanPath(props.activeFile);
    if (!path || path === revealed.current) return;
    revealed.current = path;
    if (!rootPath || !isWithin(path, rootPath) || path === rootPath) return;
    const ancestors = [rootPath];
    for (let dir = parentOf(path); dir !== rootPath && isWithin(dir, rootPath);) {
      ancestors.push(dir);
      const next = parentOf(dir);
      if (next === dir) break;
      dir = next;
    }
    setExpandedPaths((previous) => new Set([...previous, ...ancestors]));
    setSelection(new Set([path]));
    setAnchor(path);
    // Scrolls into view without taking focus away from the editor.
    setFocused(path);
  }, [props.activeFile, rootPath]);

  // --- Selection -----------------------------------------------------------
  /** The entries an action applies to: the whole selection when the target is part of it. */
  const targetsFor = (node: FileNode): FileNode[] => {
    const path = cleanPath(node.path);
    if (selection.size > 1 && selection.has(path))
      return nodeRows.filter((row) => selection.has(row.path)).map((row) => row.node);
    return [node];
  };

  const selectRange = (from: string, to: string) => {
    const a = navIndex.get(from);
    const b = navIndex.get(to);
    if (a === undefined || b === undefined) return false;
    const [low, high] = a < b ? [a, b] : [b, a];
    setSelection(new Set(nodeRows.slice(low, high + 1).map((row) => row.path)));
    return true;
  };

  /** Moves the roving focus, optionally extending the selection from the anchor. */
  const moveFocus = (path: string, extend = false) => {
    pendingFocus.current = path;
    setFocused(path);
    if (extend && anchor && selectRange(anchor, path)) return;
    setSelection(new Set([path]));
    setAnchor(path);
  };

  // --- Expansion -----------------------------------------------------------
  const expand = (path: string) =>
    setExpandedPaths((previous) => new Set([...previous, cleanPath(path)]));

  const toggleExpand = (path: string) =>
    setExpandedPaths((previous) => {
      const next = new Set(previous);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  const openNode = (node: FileNode) => {
    if (node.is_dir) toggleExpand(cleanPath(node.path));
    else props.onOpenFile(node.path, node.name);
  };

  // --- Editing -------------------------------------------------------------
  const cancelEdit = () => {
    setRenaming(null);
    setCreating(null);
    setNewName("");
    setInlineError("");
  };

  const startCreate = (parent: string, type: "file" | "folder") => {
    setRenaming(null);
    setNewName("");
    setInlineError("");
    setCreating({ parent: cleanPath(parent || workspacePath), type });
    expand(parent || workspacePath);
  };

  const submitCreate = () => {
    const name = newName.trim();
    if (creating && name) {
      const problem = validateEntryName(name, true);
      if (problem) return setInlineError(problem);
      const path = `${creating.parent}/${name}`;
      if (creating.type === "file") props.onCreateFile(path);
      else props.onCreateFolder(path);
      expand(creating.parent);
    }
    cancelEdit();
  };

  const submitRename = () => {
    const name = renaming?.value.trim();
    if (renaming && name && name !== renaming.name) {
      const problem = validateEntryName(name);
      if (problem) return setInlineError(problem);
      props.onRename(renaming.path, `${parentOf(renaming.path)}/${name}`);
    }
    cancelEdit();
  };

  const paste = (targetDir: string) => {
    if (!clipboard) return;
    const dir = cleanPath(targetDir || workspacePath);
    for (const node of clipboard.nodes) {
      const source = cleanPath(node.path);
      const dest = `${dir}/${node.name}`;
      if (clipboard.op === "cut") {
        if (source !== dest) props.onRename(node.path, dest);
      } else if (source === dest) {
        props.onDuplicate(node.path);
      } else {
        props.onCopyFile(node.path, dest);
      }
    }
    if (clipboard.op === "cut") setClipboard(null);
    expand(dir);
  };

  // --- Drag and drop -------------------------------------------------------
  // A move is refused into the dragged item itself, its own subtree, or its current parent.
  const dropDirFor = (node: FileNode | null) =>
    node ? containingDir(node.path, node.is_dir) : rootPath;

  const moveAllowed = (source: FileNode, dir: string) => {
    const path = cleanPath(source.path);
    return path !== dir && !dir.startsWith(path + "/") && parentOf(path) !== dir;
  };

  const dragOver = (event: React.DragEvent, node: FileNode | null) => {
    event.preventDefault();
    event.stopPropagation();
    if (!dragged.length) return;
    const dir = dropDirFor(node);
    if (!dragged.some((source) => moveAllowed(source, dir))) return;
    event.dataTransfer.dropEffect = "move";
    setDropTarget(dir);
  };

  const drop = (event: React.DragEvent, node: FileNode | null) => {
    event.preventDefault();
    event.stopPropagation();
    const dir = dropDirFor(node);
    let moved = false;
    for (const source of dragged)
      if (moveAllowed(source, dir)) {
        props.onMoveFile(source.path, dir);
        moved = true;
      }
    if (moved) expand(dir);
    setDragged([]);
    setDropTarget(null);
  };

  // --- Actions shared by the menus and the keyboard ------------------------
  const menuActions: MenuActions = {
    newFile: (parent) => startCreate(parent, "file"),
    newFolder: (parent) => startCreate(parent, "folder"),
    paste,
    cut: (node) => setClipboard({ nodes: targetsFor(node), op: "cut" }),
    copy: (node) => setClipboard({ nodes: targetsFor(node), op: "copy" }),
    copyPath: (node, relative) =>
      void navigator.clipboard.writeText(pathsToCopy(targetsFor(node), rootPath, relative)),
    rename: (node) => {
      setCreating(null);
      setInlineError("");
      setRenaming({ path: cleanPath(node.path), name: node.name, value: node.name });
    },
    duplicate: (node) => targetsFor(node).forEach((target) => props.onDuplicate(target.path)),
    remove: (node) =>
      props.onDelete(
        targetsFor(node).map((target) => ({ path: target.path, isDir: target.is_dir })),
      ),
    reveal: props.onReveal,
    openFile: (node) => props.onOpenFile(node.path, node.name),
    openFolderDialog: props.onOpenFolderDialog,
    refresh: props.onRefresh,
    collapseAll: () => setExpandedPaths(new Set(rootPath ? [rootPath] : [])),
    // Goes through the panel's own request channel, so the explorer stays unaware of how
    // terminals are tracked.
    openTerminal: (directory) => requestTerminal({ name: "new", cwd: directory }),
  };

  // --- Keyboard ------------------------------------------------------------
  // One handler for the whole tree; the focused row is identified by `data-path`.
  // Every handled key stops propagation so the window-level shortcuts (which bind
  // Ctrl+X/C/V/N to editor commands) do not also fire.
  const onTreeKeyDown = (event: React.KeyboardEvent) => {
    const path = (event.target as HTMLElement).dataset?.path;
    const node = path ? nodes.get(path) : undefined;
    if (!path || !node) return;

    const index = navIndex.get(path) ?? 0;
    const modifier = event.ctrlKey || event.metaKey;
    const letter = event.key.length === 1 ? event.key.toLowerCase() : "";
    const stop = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    const focusAt = (target: number, extend = false) => {
      const row = nodeRows[Math.max(0, Math.min(nodeRows.length - 1, target))];
      if (row) moveFocus(row.path, extend);
    };

    if ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") {
      stop();
      const bounds = (event.target as HTMLElement).getBoundingClientRect();
      setContextMenu({ x: bounds.left + 16, y: bounds.bottom, node, isRoot: false });
      return;
    }
    if (event.shiftKey && event.altKey && letter === "c") {
      stop();
      menuActions.copyPath(node, false);
      return;
    }

    switch (event.key) {
      case "ArrowDown":
        stop();
        return focusAt(index + 1, event.shiftKey);
      case "ArrowUp":
        stop();
        return focusAt(index - 1, event.shiftKey);
      case "Home":
        stop();
        return focusAt(0, event.shiftKey);
      case "End":
        stop();
        return focusAt(nodeRows.length - 1, event.shiftKey);
      case "ArrowRight":
        stop();
        if (node.is_dir && !expandedPaths.has(path)) expand(path);
        else if (node.is_dir) focusAt(index + 1);
        return;
      case "ArrowLeft": {
        stop();
        if (node.is_dir && expandedPaths.has(path)) return toggleExpand(path);
        const parent = parentOf(path);
        if (navIndex.has(parent)) moveFocus(parent);
        return;
      }
      case "Enter":
        stop();
        return openNode(node);
      case " ":
        stop();
        return setSelection((previous) => {
          const next = new Set(previous);
          if (!next.delete(path)) next.add(path);
          return next;
        });
      case "F2":
        stop();
        return menuActions.rename(node);
      case "Delete":
        stop();
        return menuActions.remove(node);
    }

    if (modifier) {
      const action: Record<string, () => void> = {
        x: () => menuActions.cut(node),
        c: () => menuActions.copy(node),
        v: () => paste(containingDir(node.path, node.is_dir)),
        d: () => menuActions.duplicate(node),
        n: () => menuActions.newFile(containingDir(node.path, node.is_dir)),
      };
      if (action[letter] && !event.altKey) {
        stop();
        action[letter]();
      }
      return;
    }

    // Type-to-find, wrapping around from the focused row.
    if (letter && !event.altKey) {
      const order = [...nodeRows.slice(index + 1), ...nodeRows.slice(0, index + 1)];
      const hit = order.find((row) => row.node.name.toLowerCase().startsWith(letter));
      if (hit) {
        stop();
        moveFocus(hit.path);
      }
    }
  };

  // --- Stable row callbacks ------------------------------------------------
  // Rows are memoized, so `api` must never change identity; the ref keeps the
  // bodies current without invalidating it.
  const latest = useRef<RowApi>(null!);
  latest.current = {
    click: (event, node) => {
      const path = cleanPath(node.path);
      pendingFocus.current = path;
      setFocused(path);
      if (event.shiftKey && anchor && selectRange(anchor, path)) return;
      if (event.ctrlKey || event.metaKey) {
        setSelection((previous) => {
          const next = new Set(previous);
          if (!next.delete(path)) next.add(path);
          return next;
        });
        setAnchor(path);
        return;
      }
      setSelection(new Set([path]));
      setAnchor(path);
      openNode(node);
    },
    toggle: (node) => toggleExpand(cleanPath(node.path)),
    menu: (x, y, node) => {
      const path = cleanPath(node.path);
      if (!selection.has(path)) {
        setSelection(new Set([path]));
        setAnchor(path);
        setFocused(path);
      }
      setContextMenu({ x, y, node, isRoot: false });
    },
    dragStart: (event, node) => {
      event.stopPropagation();
      const sources = targetsFor(node);
      setDragged(sources);
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", sources.map((source) => source.path).join("\n"));
    },
    dragOver,
    dragLeave: (event) => {
      event.stopPropagation();
      setDropTarget(null);
    },
    drop,
    dragEnd: () => {
      setDragged([]);
      setDropTarget(null);
    },
    renameChange: (value) => {
      setRenaming((previous) => (previous ? { ...previous, value } : previous));
      setInlineError(validateEntryName(value.trim()) ?? "");
    },
    renameSubmit: () => (inlineError ? cancelEdit() : submitRename()),
    renameCancel: cancelEdit,
  };
  const api = useMemo<RowApi>(
    () => ({
      click: (event, node) => latest.current.click(event, node),
      toggle: (node) => latest.current.toggle(node),
      menu: (x, y, node) => latest.current.menu(x, y, node),
      dragStart: (event, node) => latest.current.dragStart(event, node),
      dragOver: (event, node) => latest.current.dragOver(event, node),
      dragLeave: (event) => latest.current.dragLeave(event),
      drop: (event, node) => latest.current.drop(event, node),
      dragEnd: () => latest.current.dragEnd(),
      renameChange: (value) => latest.current.renameChange(value),
      renameSubmit: () => latest.current.renameSubmit(),
      renameCancel: () => latest.current.renameCancel(),
    }),
    [],
  );

  const openRootMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: event.clientX, y: event.clientY, node: fileTree, isRoot: true });
  };

  if (activeTab !== "explorer") {
    return (
      <aside
        hidden={!visible}
        className="w-64 shrink-0 border-r border-[#181818] bg-[#050505] p-4 text-xs text-zinc-400"
      >
        <p>{activeTab === "git" ? "Source control actions" : activeTab} are not connected yet.</p>
        <p className="mt-2">Use Explorer to browse files and view Git status badges.</p>
      </aside>
    );
  }

  const rootName = fileTree?.name || rootPath.split("/").pop() || "WORKSPACE";
  const activePath = cleanPath(props.activeFile);
  const cutPaths = clipboard?.op === "cut" ? clipboard.nodes.map((n) => cleanPath(n.path)) : [];
  const draggedPaths = dragged.map((node) => cleanPath(node.path));
  // Exactly one row is tabbable, so Tab enters and leaves the tree in one step.
  const tabbable = focused !== null && navIndex.has(focused) ? focused : nodeRows[0]?.path;

  const headerButton = (title: string, onClick: () => void, icon: React.ReactNode) => (
    <button
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      title={title}
      className="p-0.5 rounded text-zinc-500 hover:text-white transition-colors"
    >
      {icon}
    </button>
  );

  return (
    <aside
      hidden={!visible}
      onContextMenu={openRootMenu}
      className="flex w-[260px] flex-col border-r border-[#141414] bg-black select-none text-[12px] shrink-0 font-sans"
    >
      <div className="flex h-9 items-center justify-between px-3 border-b border-[#101010] text-zinc-300">
        <span className="text-[11px] font-semibold uppercase tracking-wider">Explorer</span>
        <button
          onClick={props.onOpenFolderDialog}
          title="Open Folder"
          className="text-zinc-500 hover:text-zinc-200 p-1 rounded hover:bg-[#121212] transition-colors"
        >
          <MoreIcon />
        </button>
      </div>

      {fileTree && (
        <div
          onContextMenu={openRootMenu}
          onClick={() => toggleExpand(rootPath)}
          onDragOver={(event) => dragOver(event, null)}
          onDragLeave={api.dragLeave}
          onDrop={(event) => drop(event, null)}
          className={`flex h-7 items-center justify-between px-2 border-b transition-colors cursor-pointer text-[11.5px] font-semibold ${
            dropTarget === rootPath
              ? "bg-indigo-900/40 border-indigo-500 text-white"
              : "bg-[#050505] border-[#121212] text-zinc-200 hover:bg-[#0a0a0a]"
          }`}
        >
          <div className="flex items-center gap-1.5 min-w-0">
            <ChevronIcon isExpanded={rootExpanded} />
            <span className="truncate text-white">{rootName}</span>
          </div>
          <div className="flex items-center gap-1">
            {headerButton("New File", () => startCreate(rootPath, "file"), <PlusIcon size={13} />)}
            {headerButton(
              "New Folder",
              () => startCreate(rootPath, "folder"),
              <FolderPlusIcon size={13} />,
            )}
            {headerButton("Refresh Explorer", props.onRefresh, <RefreshIcon size={13} />)}
            {headerButton(
              "Collapse Folders in Explorer",
              menuActions.collapseAll,
              <CollapseIcon size={13} />,
            )}
          </div>
        </div>
      )}

      <div
        ref={viewportRef}
        role="tree"
        aria-label="Files"
        aria-multiselectable="true"
        onKeyDown={onTreeKeyDown}
        onContextMenu={openRootMenu}
        onDragOver={(event) => dragOver(event, null)}
        onDragLeave={api.dragLeave}
        onDrop={(event) => drop(event, null)}
        className={`flex-1 overflow-y-auto py-1 min-h-0 transition-colors ${
          dropTarget === rootPath ? "ring-2 ring-indigo-500/50 bg-indigo-950/20" : ""
        }`}
      >
        {fileTree ? (
          <div style={{ height: rows.length * ROW_HEIGHT }}>
            <div style={{ transform: `translateY(${first * ROW_HEIGHT}px)` }}>
              {rows.slice(first, last).map((row) =>
                row.kind === "create" ? (
                  <CreateRow
                    key={row.key}
                    depth={row.depth}
                    type={creating!.type}
                    value={newName}
                    invalid={Boolean(inlineError)}
                    inputRef={createInputRef}
                    onChange={(value) => {
                      setNewName(value);
                      setInlineError(
                        value.trim() ? (validateEntryName(value.trim(), true) ?? "") : "",
                      );
                    }}
                    onSubmit={submitCreate}
                    onCancel={cancelEdit}
                  />
                ) : row.kind === "status" ? (
                  <StatusRow
                    key={row.key}
                    depth={row.depth}
                    error={loadErrors[row.path]}
                    onRetry={() => {
                      loadAttempts.current.delete(row.path);
                      setLoadErrors(({ [row.path]: _removed, ...rest }) => rest);
                    }}
                  />
                ) : (
                  <TreeRow
                    key={row.key}
                    node={row.node}
                    path={row.path}
                    depth={row.depth}
                    expanded={row.expanded}
                    selected={selection.has(row.path)}
                    active={activePath === row.path}
                    cut={cutPaths.includes(row.path)}
                    dragging={draggedPaths.includes(row.path)}
                    dropTarget={dropTarget === row.path}
                    status={decorations.files.get(row.path)}
                    folderDirty={
                      row.node.is_dir && !row.expanded && decorations.folders.has(row.path)
                    }
                    renameValue={renaming?.path === row.path ? renaming.value : undefined}
                    tabIndex={tabbable === row.path ? 0 : -1}
                    api={api}
                  />
                ),
              )}
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center p-6 text-center text-zinc-500 gap-3">
            <FolderClosedIcon className="size-10" />
            <p className="text-xs">No workspace opened</p>
            <button
              onClick={props.onOpenFolderDialog}
              className="rounded-lg bg-indigo-600 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-indigo-500 transition-colors"
            >
              Open Folder
            </button>
            {/* The folders opened before, here as well as on the welcome page: this is where
                someone looks when the explorer is the empty thing in front of them. */}
            {!!props.recentFolders?.length && props.onOpenRecentFolder && (
              <nav aria-label="Recent folders" className="w-full text-left">
                <h3 className="mb-1 px-1 text-[10px] font-semibold tracking-wider text-zinc-600 uppercase">
                  Recent
                </h3>
                {props.recentFolders.slice(0, 5).map((folder) => (
                  <button
                    key={folder}
                    onClick={() => props.onOpenRecentFolder?.(folder)}
                    title={folder}
                    className="block w-full truncate rounded px-1.5 py-1 text-left text-[11.5px] text-zinc-400 hover:bg-[#121212] hover:text-zinc-100"
                  >
                    {folderName(folder)}
                    <span className="ml-1.5 font-mono text-[9.5px] text-zinc-600">
                      {parentPath(folder)}
                    </span>
                  </button>
                ))}
              </nav>
            )}
          </div>
        )}
      </div>

      {inlineError && (
        <p
          role="alert"
          className="shrink-0 truncate border-t border-[#121212] bg-[#160c0c] px-3 py-1 text-[11px] text-red-400"
          title={inlineError}
        >
          {inlineError}
        </p>
      )}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          items={buildExplorerMenu({
            node: contextMenu.node,
            isRoot: contextMenu.isRoot,
            workspacePath: rootPath || workspacePath,
            clipboard,
            count: contextMenu.node ? targetsFor(contextMenu.node).length : 1,
            actions: menuActions,
          })}
        />
      )}
    </aside>
  );
}
