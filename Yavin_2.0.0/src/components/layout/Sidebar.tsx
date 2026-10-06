import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Decorations } from "../../services/git";
import { relativePath, samePathString } from "../../services/resource";
import { parentOf, validateEntryName } from "../../services/workspace";
import type {
  ExplorerNodeId,
  FileSystemExplorerProvider,
  ProjectedNode,
} from "../../services/explorerProvider";
import type { ExplorerStore } from "../../services/explorerStore";
import { ContextMenu } from "../ui/ContextMenu";
import { ChevronIcon } from "../ui/FileIcons";
import { CollapseIcon, MoreIcon, PlusIcon, FolderPlusIcon, RefreshIcon } from "../ui/Icons";
import { allowed, INTO_FOLDER, type ExplorerAction } from "../explorer/actions";
import {
  buildExplorerMenu,
  pathsToCopy,
  type Clipboard,
  type ExtensionMenuItem,
  type MenuActions,
} from "../explorer/menu";
import { cleanPath, containingDir } from "../explorer/paths";
import { CreateRow, ROW_HEIGHT, StatusRow, TreeRow, type RowApi } from "../explorer/TreeRow";

export { cleanPath, getRelativePath } from "../explorer/paths";

/** Extra rows rendered above and below the viewport so scrolling never shows a gap. */
const OVERSCAN = 10;

type Id = ExplorerNodeId;

/**
 * One visible row. Identity is the node's: `id` for state (selection, expansion), `key` --
 * the provider's view key, kept through renames and moves -- for React, so a renamed row is
 * the same element.
 */
type NodeRow = {
  kind: "node";
  key: string;
  id: Id;
  path: string;
  depth: number;
  node: ProjectedNode;
  expanded: boolean;
  /** A workspace root shown as a row (several roots). */
  isRoot: boolean;
};
type Row =
  | NodeRow
  | { kind: "create"; key: string; depth: number }
  /** Under a folder: its listing is loading, or failed (with its error). */
  | { kind: "status"; key: string; depth: number; id: Id; error?: string };

export interface DeleteTarget {
  path: string;
  isDir: boolean;
}

interface SidebarProps {
  visible: boolean;
  activeTab: string;
  workspacePath: string;
  /** Every workspace root, as the provider projects it (see `services/explorerProvider.ts`). */
  roots: ProjectedNode[];
  decorations: Decorations;
  /** Where the tree comes from: capabilities, retries, parents. */
  provider: FileSystemExplorerProvider;
  /** The Explorer's UI state: expansion, selection, anchor, focus, reveal. */
  store: ExplorerStore;
  /** Lists a folder; the listing is abandoned when `signal` aborts (the folder collapsed). */
  onLoadDirectory: (path: string, signal?: AbortSignal) => Promise<void>;
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
  /** Starts a terminal in a folder ("Open in Integrated Terminal"). */
  onOpenTerminal?: (target: { path: string; isDir: boolean }) => void;
  /** Where the explorer was scrolled last time. */
  initialScroll?: number;
  /** Reports the explorer's state as it changes, so the session can be written. */
  onExplorerState?: (state: {
    expanded: string[];
    selected: string[];
    focused: string | null;
    scroll: number;
  }) => void;
  /** The Outline section, under the tree. */
  outline?: React.ReactNode;
  /** Extensions' Explorer context-menu items (IDE-08). */
  extensionMenuItems?: readonly ExtensionMenuItem[];
}

export function Sidebar(props: SidebarProps) {
  const {
    visible,
    activeTab,
    workspacePath,
    roots,
    decorations,
    onLoadDirectory,
    provider,
    store,
  } = props;

  // The Explorer's UI state lives in its store (App owns it, one per workspace), keyed by node
  // identity and following the provider's renames and deletions.
  const storeRevision = useSyncExternalStore(store.subscribe, store.revision);
  const expanded = store.ids("expanded");
  const selection = store.ids("selection");
  const anchor = store.anchor();
  const focused = store.focused();
  const { setExpanded, setSelection, setAnchor, setFocused } = store;

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    node: ProjectedNode | null;
    /** The menu for a root: a root row, or the background of the root it belongs to. */
    isRoot: boolean;
  } | null>(null);
  const [renaming, setRenaming] = useState<{
    id: Id;
    path: string;
    name: string;
    value: string;
  } | null>(null);
  const [creating, setCreating] = useState<{ parent: string; type: "file" | "folder" } | null>(
    null,
  );
  const [newName, setNewName] = useState("");
  const [inlineError, setInlineError] = useState("");
  const [clipboard, setClipboard] = useState<Clipboard>(null);
  const [dragged, setDragged] = useState<ProjectedNode[]>([]);
  const [dropTarget, setDropTarget] = useState<Id | null>(null);
  /** The "No Folder Opened" section's own disclosure. */
  const [noFolderOpen, setNoFolderOpen] = useState(true);

  /** Listings in flight, by folder; aborted when the folder is collapsed before they answer. */
  const loads = useRef(new Map<Id, AbortController>());
  const createInputRef = useRef<HTMLInputElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  /** Set when the tree itself moves focus, so revealing a file never steals it from the editor. */
  const pendingFocus = useRef<Id | null>(null);

  const multiRoot = roots.length > 1;
  const firstRoot = roots[0] ?? null;
  const rootPath = cleanPath(firstRoot?.path || workspacePath);
  const rootExpanded = !!firstRoot && expanded.has(firstRoot.id);
  const capabilities = useCallback((id: Id) => provider.capabilities(id), [provider]);
  /** The folder things are created in when acting on `node`: itself, or the one holding it. */
  const containerOf = (node: ProjectedNode): Id | null =>
    node.is_dir ? node.id : (provider.getNode(node.id)?.parentId ?? null);
  /** The root a node belongs to (or the first one). */
  const rootOf = (id: Id | null): ProjectedNode | null => {
    const path = id ? store.pathOf(id) : undefined;
    return (path && roots.find((root) => relativePath(root.path, path) !== undefined)) || firstRoot;
  };

  // --- Tree flattening -----------------------------------------------------
  // One pass turns the projection into the exact list of visible rows plus the lookup tables
  // navigation needs, and collects the folders still awaiting a listing.
  const { rows, nodeRows, rowIndex, navIndex, nodes, pending } = useMemo(() => {
    const rows: Row[] = [];
    const nodeRows: NodeRow[] = [];
    const rowIndex = new Map<Id, number>();
    const navIndex = new Map<Id, number>();
    const nodes = new Map<Id, ProjectedNode>();
    const pending: { id: Id; path: string }[] = [];

    const emitCreate = (parent: string, depth: number) => {
      if (creating && samePathString(creating.parent, parent))
        rows.push({ kind: "create", key: "@create", depth });
    };
    const push = (node: ProjectedNode, depth: number, isRoot: boolean) => {
      const isExpanded = node.is_dir && expanded.has(node.id);
      const row: NodeRow = {
        kind: "node",
        key: node.key,
        id: node.id,
        path: cleanPath(node.path),
        depth,
        node,
        expanded: isExpanded,
        isRoot,
      };
      rowIndex.set(node.id, rows.length);
      navIndex.set(node.id, nodeRows.length);
      nodes.set(node.id, node);
      rows.push(row);
      nodeRows.push(row);
      return isExpanded;
    };
    /** A folder's contents: its children, or where they would be -- loading, or failed. */
    const contents = (folder: ProjectedNode, depth: number) => {
      if (!folder.children) {
        rows.push({
          kind: "status",
          key: folder.key + "@status",
          depth,
          id: folder.id,
          error: folder.loadError,
        });
        // A failed listing is the folder's state until retried, not something to re-ask.
        if (!folder.loadError) pending.push({ id: folder.id, path: cleanPath(folder.path) });
        return;
      }
      // Listed before, but its last refresh failed: said above what is still known of it.
      if (folder.loadError)
        rows.push({
          kind: "status",
          key: folder.key + "@error",
          depth,
          id: folder.id,
          error: folder.loadError,
        });
      walk(folder.children, depth);
    };
    const walk = (children: ProjectedNode[], depth: number) => {
      for (const node of children) {
        const isExpanded = push(node, depth, false);
        if (node.is_dir) emitCreate(node.path, depth + 1);
        if (isExpanded) contents(node, depth + 1);
      }
    };

    if (multiRoot) {
      // Each root is a row of its own, never folded into one tree with the others.
      for (const root of roots) {
        const isExpanded = push(root, 0, true);
        emitCreate(root.path, 1);
        if (isExpanded) contents(root, 1);
      }
    } else if (firstRoot) {
      // One root: its header above the tree is the root, and its entries start at the left.
      emitCreate(firstRoot.path, 0);
      if (expanded.has(firstRoot.id)) contents(firstRoot, 0);
    }
    return { rows, nodeRows, rowIndex, navIndex, nodes, pending };
  }, [roots, multiRoot, firstRoot, expanded, creating]);

  // An expanded folder whose children are not loaded yet is listed on demand. One that is
  // collapsed again before its listing answers has the listing abandoned: the provider drops
  // the answer rather than applying it to a folder nobody is looking at.
  useEffect(() => {
    const wanted = new Set(pending.map((folder) => folder.id));
    for (const [id, controller] of loads.current)
      if (!wanted.has(id)) {
        controller.abort();
        loads.current.delete(id);
      }
    for (const { id, path } of pending) {
      // An abandoned listing is no listing: expanding again before it has settled lists anew,
      // rather than waiting on an answer that will be dropped.
      if (loads.current.get(id)?.signal.aborted === false) continue;
      const controller = new AbortController();
      loads.current.set(id, controller);
      onLoadDirectory(path, controller.signal)
        // A failure is kept as the folder's state by the provider and shown in its row.
        .catch(() => undefined)
        .finally(() => {
          if (loads.current.get(id) === controller) loads.current.delete(id);
        });
    }
  }, [pending, onLoadDirectory]);
  useEffect(() => {
    const current = loads.current;
    return () => {
      for (const controller of current.values()) controller.abort();
      current.clear();
    };
  }, []);

  // A root appearing for the first time is shown open, as a folder opened in the window is.
  const seenRoots = useRef(new Set<Id>());
  useEffect(() => {
    const fresh = roots.filter((root) => !seenRoots.current.has(root.id));
    if (!fresh.length) return;
    for (const root of fresh) seenRoots.current.add(root.id);
    setExpanded((previous) => new Set([...previous, ...fresh.map((root) => root.id)]));
  }, [roots, setExpanded]);

  useEffect(() => {
    if (creating) createInputRef.current?.focus();
  }, [creating]);

  // --- Windowing -----------------------------------------------------------
  // Rows are a fixed height, so the visible slice is arithmetic rather than measurement.
  const [view, setView] = useState({ top: 0, height: 720 });

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const measure = () => {
      // Hidden (another view is showing): it measures nothing, and the last real view stands
      // -- otherwise a hidden tree would draw only a few rows and report scrolling to the top.
      if (!element.clientHeight) return;
      setView((previous) =>
        previous.top === element.scrollTop && previous.height === element.clientHeight
          ? previous
          : { top: element.scrollTop, height: element.clientHeight },
      );
    };
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
   * empty. So the target is captured once at mount -- never re-read from the prop, which the
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

  const reportState = props.onExplorerState;
  const report = useCallback(() => {
    // Nothing is reported until the restore has settled: a report before then says the
    // explorer is at the top, which is exactly what would overwrite the offset being
    // restored -- and it is written back to the session, losing it for good.
    if (!reportState || !restored.current) return;
    reportState({
      expanded: [...store.paths("expanded")],
      selected: [...store.paths("selection")],
      focused: store.focusedPath(),
      // Rounded because sub-pixel scroll is meaningless to restore, and a whole number is
      // what someone reading the session file by hand expects to find.
      scroll: Math.round(viewportRef.current?.scrollTop ?? 0),
    });
  }, [reportState, store]);

  // Unfolding, selecting and focusing are reported as they happen; each is a deliberate act.
  useEffect(report, [storeRevision, report]);
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
      `[data-id="${CSS.escape(wanted)}"]`,
    );
    if (!row) return;
    pendingFocus.current = null;
    if (document.activeElement !== row) row.focus();
  });

  // --- Reveal the active editor file ---------------------------------------
  // The store does the work -- ancestors expanded and listed, the file selected and focused --
  // and the focused row is scrolled to above, without taking focus from the editor.
  const revealed = useRef("");
  useEffect(() => {
    const path = cleanPath(props.activeFile);
    if (!path || path === revealed.current) return;
    revealed.current = path;
    void store.reveal(path);
  }, [props.activeFile, store]);

  // --- Capabilities --------------------------------------------------------
  /** The entries an action applies to: the whole selection when the target is part of it. */
  const targetsFor = (node: ProjectedNode): ProjectedNode[] => {
    if (selection.size > 1 && selection.has(node.id))
      return nodeRows.filter((row) => selection.has(row.id)).map((row) => row.node);
    return [node];
  };
  /** Whether `action` is supported for `node` (its targets, or its folder for creating). */
  const can = (action: ExplorerAction, node: ProjectedNode | null): boolean => {
    if (!node) return allowed(capabilities, [firstRoot?.id], action);
    if (INTO_FOLDER.has(action)) return allowed(capabilities, [containerOf(node)], action);
    return allowed(
      capabilities,
      targetsFor(node).map((target) => target.id),
      action,
    );
  };

  // --- Selection -----------------------------------------------------------
  const selectRange = (from: Id, to: Id) => {
    const a = navIndex.get(from);
    const b = navIndex.get(to);
    if (a === undefined || b === undefined) return false;
    const [low, high] = a < b ? [a, b] : [b, a];
    setSelection(new Set(nodeRows.slice(low, high + 1).map((row) => row.id)));
    return true;
  };

  /** Moves the roving focus, optionally extending the selection from the anchor. */
  const moveFocus = (id: Id, extend = false) => {
    pendingFocus.current = id;
    setFocused(id);
    if (extend && anchor && selectRange(anchor, id)) return;
    setSelection(new Set([id]));
    setAnchor(id);
  };

  // --- Expansion -----------------------------------------------------------
  const expand = (id: Id | null) => {
    if (id) setExpanded((previous) => new Set([...previous, id]));
  };
  const expandPath = (path: string) => expand(provider.idFor(path));

  const toggleExpand = (id: Id) =>
    setExpanded((previous) => {
      const next = new Set(previous);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const openNode = (node: ProjectedNode) => {
    if (node.is_dir) toggleExpand(node.id);
    else if (can("open", node)) props.onOpenFile(node.path, node.name);
  };

  // --- Editing -------------------------------------------------------------
  const cancelEdit = () => {
    setRenaming(null);
    setCreating(null);
    setNewName("");
    setInlineError("");
  };

  const startCreate = (parent: string, type: "file" | "folder") => {
    const folder = cleanPath(parent || rootPath);
    if (!allowed(capabilities, [provider.idFor(folder)], type === "file" ? "newFile" : "newFolder"))
      return;
    setRenaming(null);
    setNewName("");
    setInlineError("");
    setCreating({ parent: folder, type });
    expandPath(folder);
  };

  const submitCreate = () => {
    const name = newName.trim();
    if (creating && name) {
      const problem = validateEntryName(name, true);
      if (problem) return setInlineError(problem);
      const path = `${creating.parent}/${name}`;
      if (creating.type === "file") props.onCreateFile(path);
      else props.onCreateFolder(path);
      expandPath(creating.parent);
    }
    cancelEdit();
  };

  const submitRename = () => {
    const name = renaming?.value.trim();
    if (renaming && name && name !== renaming.name) {
      const problem = validateEntryName(name);
      if (problem) return setInlineError(problem);
      const target = `${parentOf(renaming.path)}/${name}`;
      props.onRename(renaming.path, target);
      // Keyboard focus comes back to the renamed row -- the same element, under its new id.
      pendingFocus.current = provider.idFor(target);
    } else if (renaming) {
      pendingFocus.current = renaming.id;
    }
    cancelEdit();
  };

  const paste = (targetDir: string) => {
    if (!clipboard) return;
    const dir = cleanPath(targetDir || rootPath);
    if (!allowed(capabilities, [provider.idFor(dir)], "paste")) return;
    for (const node of clipboard.nodes) {
      const source = cleanPath(node.path);
      const dest = `${dir}/${node.name}`;
      if (clipboard.op === "cut") {
        if (!samePathString(source, dest)) props.onRename(node.path, dest);
      } else if (samePathString(source, dest)) {
        props.onDuplicate(node.path);
      } else {
        props.onCopyFile(node.path, dest);
      }
    }
    if (clipboard.op === "cut") setClipboard(null);
    expandPath(dir);
  };

  // --- Drag and drop -------------------------------------------------------
  // A move is refused into the dragged item itself, its own subtree, or its current parent,
  // and into a folder that cannot take entries. Roots are compared as resources, so a drop
  // across roots is a move like any other.
  const dropDirFor = (node: ProjectedNode | null): string =>
    node ? containingDir(node.path, node.is_dir) : rootPath;

  const moveAllowed = (source: ProjectedNode, dir: string) => {
    const path = cleanPath(source.path);
    return (
      relativePath(path, dir) === undefined &&
      !samePathString(parentOf(path), dir) &&
      allowed(capabilities, [provider.idFor(dir)], "paste")
    );
  };

  const dragOver = (event: React.DragEvent, node: ProjectedNode | null) => {
    event.preventDefault();
    event.stopPropagation();
    if (!dragged.length) return;
    const dir = dropDirFor(node);
    if (!dragged.some((source) => moveAllowed(source, dir))) return;
    event.dataTransfer.dropEffect = "move";
    setDropTarget(provider.idFor(dir));
  };

  const drop = (event: React.DragEvent, node: ProjectedNode | null) => {
    event.preventDefault();
    event.stopPropagation();
    const dir = dropDirFor(node);
    let moved = false;
    for (const source of dragged)
      if (moveAllowed(source, dir)) {
        props.onMoveFile(source.path, dir);
        moved = true;
      }
    if (moved) expandPath(dir);
    setDragged([]);
    setDropTarget(null);
  };

  // --- Actions shared by the menus and the keyboard ------------------------
  // Each checks the provider's capabilities, whichever way it was asked for.
  const menuActions: MenuActions = {
    newFile: (parent) => startCreate(parent, "file"),
    newFolder: (parent) => startCreate(parent, "folder"),
    paste,
    cut: (file) => {
      const node = file as ProjectedNode;
      if (can("cut", node)) setClipboard({ nodes: targetsFor(node), op: "cut" });
    },
    copy: (file) => {
      const node = file as ProjectedNode;
      if (can("copy", node)) setClipboard({ nodes: targetsFor(node), op: "copy" });
    },
    copyPath: (file, relative) => {
      const node = file as ProjectedNode;
      void navigator.clipboard.writeText(
        pathsToCopy(targetsFor(node), rootOf(node.id)?.path ?? rootPath, relative),
      );
    },
    rename: (file) => {
      const node = file as ProjectedNode;
      if (!can("rename", node) || targetsFor(node).length > 1) return;
      setCreating(null);
      setInlineError("");
      setRenaming({ id: node.id, path: cleanPath(node.path), name: node.name, value: node.name });
    },
    duplicate: (file) => {
      const node = file as ProjectedNode;
      if (can("duplicate", node))
        targetsFor(node).forEach((target) => props.onDuplicate(target.path));
    },
    remove: (file) => {
      const node = file as ProjectedNode;
      if (can("delete", node))
        props.onDelete(
          targetsFor(node).map((target) => ({ path: target.path, isDir: target.is_dir })),
        );
    },
    reveal: props.onReveal,
    openFile: (file) => {
      if (can("open", file as ProjectedNode)) props.onOpenFile(file.path, file.name);
    },
    openFolderDialog: props.onOpenFolderDialog,
    refresh: props.onRefresh,
    collapseAll: () => setExpanded(new Set(multiRoot ? [] : firstRoot ? [firstRoot.id] : [])),
    // The window starts it in the workspace's terminals; the explorer stays unaware of how
    // terminals are tracked.
    openTerminal: (target) => props.onOpenTerminal?.(target),
  };

  // --- Keyboard ------------------------------------------------------------
  // One handler for the whole tree; the focused row is identified by `data-id`.
  // Every handled key stops propagation so the window-level shortcuts (which bind
  // Ctrl+X/C/V/N to editor commands) do not also fire.
  const onTreeKeyDown = (event: React.KeyboardEvent) => {
    const id = (event.target as HTMLElement).dataset?.id as Id | undefined;
    const node = id ? nodes.get(id) : undefined;
    if (!id || !node) return;
    const row = nodeRows[navIndex.get(id) ?? 0];

    const index = navIndex.get(id) ?? 0;
    const modifier = event.ctrlKey || event.metaKey;
    const letter = event.key.length === 1 ? event.key.toLowerCase() : "";
    const stop = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    const focusAt = (target: number, extend = false) => {
      const next = nodeRows[Math.max(0, Math.min(nodeRows.length - 1, target))];
      if (next) moveFocus(next.id, extend);
    };

    if ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") {
      stop();
      const bounds = (event.target as HTMLElement).getBoundingClientRect();
      setContextMenu({ x: bounds.left + 16, y: bounds.bottom, node, isRoot: !!row?.isRoot });
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
        if (node.is_dir && !expanded.has(id)) expand(id);
        else if (node.is_dir) focusAt(index + 1);
        return;
      case "ArrowLeft": {
        stop();
        if (node.is_dir && expanded.has(id)) return toggleExpand(id);
        const parent = provider.getNode(id)?.parentId;
        if (parent && navIndex.has(parent)) moveFocus(parent);
        return;
      }
      case "Enter":
        stop();
        return openNode(node);
      case " ":
        stop();
        return setSelection((previous) => {
          const next = new Set(previous);
          if (!next.delete(id)) next.add(id);
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

    // Type-to-find, wrapping around from the focused row, over the rows that are shown.
    if (letter && !event.altKey) {
      const order = [...nodeRows.slice(index + 1), ...nodeRows.slice(0, index + 1)];
      const hit = order.find((candidate) => candidate.node.name.toLowerCase().startsWith(letter));
      if (hit) {
        stop();
        moveFocus(hit.id);
      }
    }
  };

  // --- Stable row callbacks ------------------------------------------------
  // Rows are memoized, so `api` must never change identity; the ref keeps the
  // bodies current without invalidating it.
  const latest = useRef<RowApi>(null!);
  latest.current = {
    click: (event, file) => {
      const node = file as ProjectedNode;
      pendingFocus.current = node.id;
      setFocused(node.id);
      if (event.shiftKey && anchor && selectRange(anchor, node.id)) return;
      if (event.ctrlKey || event.metaKey) {
        setSelection((previous) => {
          const next = new Set(previous);
          if (!next.delete(node.id)) next.add(node.id);
          return next;
        });
        setAnchor(node.id);
        return;
      }
      setSelection(new Set([node.id]));
      setAnchor(node.id);
      openNode(node);
    },
    toggle: (file) => toggleExpand((file as ProjectedNode).id),
    menu: (x, y, file) => {
      const node = file as ProjectedNode;
      if (!selection.has(node.id)) {
        setSelection(new Set([node.id]));
        setAnchor(node.id);
        setFocused(node.id);
      }
      const row = nodeRows[navIndex.get(node.id) ?? -1];
      setContextMenu({ x, y, node, isRoot: !!row?.isRoot });
    },
    dragStart: (event, file) => {
      event.stopPropagation();
      const node = file as ProjectedNode;
      // Only what can be moved is dragged at all.
      if (!can("move", node)) {
        event.preventDefault();
        return;
      }
      const sources = targetsFor(node);
      setDragged(sources);
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", sources.map((source) => source.path).join("\n"));
    },
    dragOver: (event, file) => dragOver(event, file as ProjectedNode),
    dragLeave: (event) => {
      event.stopPropagation();
      setDropTarget(null);
    },
    drop: (event, file) => drop(event, file as ProjectedNode),
    dragEnd: () => {
      setDragged([]);
      setDropTarget(null);
    },
    renameChange: (value) => {
      setRenaming((previous) => (previous ? { ...previous, value } : previous));
      setInlineError(validateEntryName(value.trim()) ?? "");
    },
    renameSubmit: () => (inlineError ? cancelEdit() : submitRename()),
    renameCancel: () => {
      if (renaming) pendingFocus.current = renaming.id;
      cancelEdit();
    },
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
    setContextMenu({ x: event.clientX, y: event.clientY, node: firstRoot, isRoot: true });
  };

  // Ids computed once per render, not once per row.
  const activeId = useMemo(() => {
    const path = cleanPath(props.activeFile);
    try {
      return path ? provider.idFor(path) : null;
    } catch {
      // Not a path (an untitled document): nothing in the tree is active.
      return null;
    }
  }, [props.activeFile, provider]);
  const cutIds = useMemo(
    () =>
      new Set(
        clipboard?.op === "cut" ? clipboard.nodes.map((node) => (node as ProjectedNode).id) : [],
      ),
    [clipboard],
  );
  const draggedIds = useMemo(() => new Set(dragged.map((node) => node.id)), [dragged]);

  // Another view's placeholder is shown beside the tree, which stays mounted and hidden: the
  // windowing observes the tree's scroll container, and a remount would leave it observing a
  // detached one -- the tree then drew only a few rows -- and would lose the scroll position.
  const explorerShown = activeTab === "explorer";
  const placeholder = !explorerShown && (
    <aside
      hidden={!visible}
      className="w-64 shrink-0 border-r border-[#181818] bg-[#050505] p-4 text-xs text-zinc-400"
    >
      <p>{activeTab === "git" ? "Source control actions" : activeTab} are not connected yet.</p>
      <p className="mt-2">Use Explorer to browse files and view Git status badges.</p>
    </aside>
  );

  const headerRoot = multiRoot ? rootOf(focused) : firstRoot;
  const rootName = multiRoot
    ? "Workspace"
    : firstRoot?.name || rootPath.split("/").pop() || "WORKSPACE";
  // Exactly one row is tabbable, so Tab enters and leaves the tree in one step.
  const tabbable = focused !== null && navIndex.has(focused) ? focused : nodeRows[0]?.id;
  const rootDropId = firstRoot && !multiRoot ? firstRoot.id : null;

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
    <>
      {placeholder}
      <aside
        hidden={!visible || !explorerShown}
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

        {firstRoot && (
          <div
            onContextMenu={openRootMenu}
            onClick={() => !multiRoot && toggleExpand(firstRoot.id)}
            onDragOver={(event) => dragOver(event, null)}
            onDragLeave={api.dragLeave}
            onDrop={(event) => drop(event, null)}
            className={`flex h-7 items-center justify-between px-2 border-b transition-colors cursor-pointer text-[11.5px] font-semibold ${
              rootDropId && dropTarget === rootDropId
                ? "bg-indigo-900/40 border-indigo-500 text-white"
                : "bg-[#050505] border-[#121212] text-zinc-200 hover:bg-[#0a0a0a]"
            }`}
          >
            <div className="flex items-center gap-1.5 min-w-0">
              {!multiRoot && <ChevronIcon isExpanded={rootExpanded} />}
              <span className="truncate text-white">{rootName}</span>
            </div>
            <div className="flex items-center gap-1">
              {headerRoot &&
                allowed(capabilities, [headerRoot.id], "newFile") &&
                headerButton(
                  "New File",
                  () => startCreate(headerRoot.path, "file"),
                  <PlusIcon size={13} />,
                )}
              {headerRoot &&
                allowed(capabilities, [headerRoot.id], "newFolder") &&
                headerButton(
                  "New Folder",
                  () => startCreate(headerRoot.path, "folder"),
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

        {!firstRoot && (
          // No folder: what VS Code shows -- a collapsible section saying so, and the way to
          // open one. Outside the tree, which only ever holds the tree's own rows.
          <section aria-label="No Folder Opened" className="shrink-0 border-b border-[#101010]">
            <button
              onClick={() => setNoFolderOpen((open) => !open)}
              aria-expanded={noFolderOpen}
              className="flex h-6 w-full items-center gap-1 px-1.5 text-left text-[11px] font-semibold text-zinc-200 hover:bg-[#0a0a0a]"
            >
              <ChevronIcon isExpanded={noFolderOpen} />
              No Folder Opened
            </button>
            {noFolderOpen && (
              <div className="flex flex-col gap-3 px-4 pt-1.5 pb-4">
                <p className="text-[12.5px] text-zinc-300">You have not yet opened a folder.</p>
                <button
                  onClick={props.onOpenFolderDialog}
                  className="w-full rounded-sm bg-[#0e639c] py-1.5 text-[12.5px] text-white hover:bg-[#1177bb] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-[#1177bb]"
                >
                  Open Folder
                </button>
              </div>
            )}
          </section>
        )}

        <div
          ref={viewportRef}
          role="tree"
          // Kept mounted with no folder open -- the windowing measures it from its first render
          // -- but not shown: there is no tree.
          hidden={!firstRoot}
          aria-label="Files"
          aria-multiselectable="true"
          onKeyDown={onTreeKeyDown}
          onContextMenu={openRootMenu}
          onDragOver={(event) => dragOver(event, null)}
          onDragLeave={api.dragLeave}
          onDrop={(event) => drop(event, null)}
          className={`flex-1 overflow-y-auto py-1 min-h-0 transition-colors ${
            rootDropId && dropTarget === rootDropId
              ? "ring-2 ring-indigo-500/50 bg-indigo-950/20"
              : ""
          }`}
        >
          {firstRoot ? (
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
                      error={row.error}
                      // Retried by the provider: listed if never listed, re-listed if a refresh
                      // failed. The row changes when the provider's state does.
                      onRetry={() => void provider.retry(row.id)}
                    />
                  ) : (
                    <TreeRow
                      key={row.key}
                      id={row.id}
                      node={row.node}
                      path={row.path}
                      depth={row.depth}
                      isRoot={row.isRoot}
                      expanded={row.expanded}
                      selected={selection.has(row.id)}
                      active={activeId === row.id}
                      cut={cutIds.has(row.id)}
                      dragging={draggedIds.has(row.id)}
                      dropTarget={dropTarget === row.id}
                      // Git's own state, looked up by the resource's path: the Git store owns it.
                      status={row.isRoot ? undefined : decorations.files.get(row.path)}
                      folderDirty={
                        row.node.is_dir && !row.expanded && decorations.folders.has(row.path)
                      }
                      renameValue={renaming?.id === row.id ? renaming.value : undefined}
                      tabIndex={tabbable === row.id ? 0 : -1}
                      api={api}
                    />
                  ),
                )}
              </div>
            </div>
          ) : null}
        </div>

        {props.outline}

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
              workspacePath: contextMenu.node?.path ?? rootPath,
              clipboard,
              count: contextMenu.node ? targetsFor(contextMenu.node).length : 1,
              can: (action) => can(action, contextMenu.node),
              actions: menuActions,
              extensionItems: props.extensionMenuItems,
            })}
          />
        )}
      </aside>
    </>
  );
}
