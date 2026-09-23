import { AppDialog } from "./components/ui/AppDialog";
import type { DialogRequest } from "./components/ui/AppDialog";
import type { EditorHandle, EditorState, EditorAction } from "./components/layout/TextEditor";
import type { TextHistory } from "./services/editor";
import { matchesShortcut, shortcutLabel } from "./services/commands";
import type { AppCommand } from "./services/commands";
import React, { useState, useEffect, useCallback, useRef, Component, lazy, Suspense } from "react";
import { TitleBar } from "./components/layout/TitleBar";
import { ActivityBar } from "./components/layout/ActivityBar";
import { Sidebar } from "./components/layout/Sidebar";
import { EditorArea } from "./components/layout/EditorArea";
const TerminalPanel = lazy(() =>
  import("./components/layout/TerminalPanel").then((module) => ({
    default: module.TerminalPanel,
  })),
);
import { StatusBar } from "./components/layout/StatusBar";
import { CommandPalette } from "./components/command-palette/CommandPalette";
import { AIAssistantPanel } from "./components/ai/AIAssistantPanel";
import { SearchPanel } from "./components/layout/SearchPanel";
import type { Replacement } from "./components/layout/SearchPanel";
import { SourceControlPanel } from "./components/layout/SourceControlPanel";
import { DiffEditor } from "./components/layout/DiffEditor";
import type { DiffDocument } from "./components/layout/DiffEditor";
import { CommitGraphPanel } from "./components/git/CommitGraphPanel";
import { GitOutputPanel } from "./components/git/GitOutputPanel";
import type { SearchHit } from "./services/search";
import { recordEdit } from "./services/editor";
import { requestTerminal, onTerminalRequestObserved } from "./services/terminal";

import { isTauri } from "@tauri-apps/api/core";
import type { FileNode, EditorTab, RecentFile } from "./types";
import { native, onWorkspaceChanged } from "./services/native";
import {
  findNode,
  isWithin,
  loadedDirectories,
  nearestLoadedDirectory,
  remapPath,
  setChildren,
  validateEntryName,
} from "./services/workspace";
import {
  buildDecorations,
  gitRegistry,
  guardedAffecting,
  useActiveRepo,
  useGitRegistry,
  useRepoSnapshot,
  useTotalChanges,
} from "./services/git";
import type { Decorations } from "./services/git";
import { listFiles } from "./services/search";
// Error boundary to prevent white/black screen crashes
class ErrorBoundary extends Component<
  React.PropsWithChildren,
  { hasError: boolean; error: Error | null }
> {
  constructor(props: React.PropsWithChildren) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }
  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("Yavin UI Error:", error, errorInfo);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-screen w-screen flex-col items-center justify-center bg-[#000000] text-zinc-300 p-6 font-sans">
          <div className="max-w-md rounded-xl border border-red-900/50 bg-red-950/20 p-6 flex flex-col gap-3 text-center">
            <span className="text-3xl text-red-500">⚠</span>
            <h2 className="text-base font-semibold text-white">Yavin UI Runtime Notice</h2>
            <p className="text-xs text-zinc-400 font-mono text-left bg-black/60 p-3 rounded overflow-auto max-h-32">
              {this.state.error?.toString()}
            </p>
            <button
              onClick={() => this.setState({ hasError: false, error: null })}
              className="mt-2 rounded-lg bg-indigo-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
            >
              Recover UI
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const editorRef = useRef<EditorHandle>(null);
  const histories = useRef(new Map<string, TextHistory>());
  const savedContents = useRef<Record<string, string>>({});
  const [editorState, setEditorState] = useState<EditorState>({
    canUndo: false,
    canRedo: false,
    selected: false,
  });
  const [dialog, setDialog] = useState<DialogRequest | null>(null);
  const [wordWrap, setWordWrap] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [paletteMode, setPaletteMode] = useState<"files" | "commands">("files");
  const [workspacePath, setWorkspacePath] = useState("");
  const [fileTree, setFileTree] = useState<FileNode | null>(null);
  const treeRef = useRef<FileNode | null>(null);
  const treeRequests = useRef(new Map<string, number>());
  const [quickOpen, setQuickOpen] = useState<{ files: string[]; note: string } | null>(null);
  const [fileContents, setFileContents] = useState<Record<string, string>>({});
  const contentsRef = useRef(fileContents);
  const workspaceRevision = useRef(0);
  const [decorations, setDecorations] = useState<Decorations>({
    files: new Map(),
    folders: new Set(),
  });
  const [tabs, setTabs] = useState<EditorTab[]>([
    { id: "welcome", name: "Welcome", path: "welcome", dirty: false },
  ]);
  const [activeTabId, setActiveTabId] = useState("welcome");
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isTerminalOpen, setIsTerminalOpen] = useState(false);
  // Once opened, the panel stays mounted and is only hidden, so shells keep running.
  const [wasTerminalOpened, setWasTerminalOpened] = useState(false);

  /** Shows or hides the panel, mounting it the first time it is needed. */
  const showTerminal = useCallback((next: boolean | ((open: boolean) => boolean)) => {
    setIsTerminalOpen((open) => {
      const shown = typeof next === "function" ? next(open) : next;
      if (shown) setWasTerminalOpened(true);
      return shown;
    });
  }, []);
  const [isTerminalMaximized, setIsTerminalMaximized] = useState(false);

  // Any request for a new terminal reveals the panel. Observed rather than handled: the
  // panel itself is the handler, and it may not be mounted yet -- `requestTerminal` holds
  // the request until it is.
  useEffect(
    () =>
      onTerminalRequestObserved((request) => {
        if (request === "new" || (typeof request === "object" && request.name === "new"))
          showTerminal(true);
      }),
    [showTerminal],
  );
  const [isAIOpen, setIsAIOpen] = useState(false);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [activeActivityTab, setActiveActivityTab] = useState("explorer");
  const [diff, setDiff] = useState<DiffDocument | null>(null);
  const [showGraph, setShowGraph] = useState(false);
  const [showGitOutput, setShowGitOutput] = useState(false);
  const [searchFocus, setSearchFocus] = useState(0);
  const [gitRevision, setGitRevision] = useState(0);
  const [pendingHit, setPendingHit] = useState<SearchHit | null>(null);
  const hasUnsavedChanges = tabs.some((tab) => tab.dirty);
  const totalGitChanges = useTotalChanges();
  const activeRepo = useActiveRepo();
  const activeRepoSnapshot = useRepoSnapshot(activeRepo?.store);
  const activeRepoId = useGitRegistry().activeRepoId;

  // A diff view has no identity of its own tying it to the repository it came
  // from (DiffEditor is keyed only by diff content, never by repository -- see
  // the Git UI Architecture plan's Gap 1), so switching the active repository
  // without clearing it would leave a previous repository's diff -- including
  // its live, functioning hunk-staging buttons -- displayed and operable while
  // every other visible surface shows the newly-active repository.
  const lastActiveRepoIdRef = useRef(activeRepoId);
  useEffect(() => {
    if (lastActiveRepoIdRef.current !== activeRepoId) {
      lastActiveRepoIdRef.current = activeRepoId;
      setDiff(null);
    }
  }, [activeRepoId]);

  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    let disposed = false;
    let unlisten: (() => void) | undefined;
    if (isTauri()) {
      import("@tauri-apps/api/window")
        .then(({ getCurrentWindow }) =>
          getCurrentWindow().onCloseRequested((event) => {
            if (!window.confirm("Discard unsaved changes and close Yavin?")) event.preventDefault();
          }),
        )
        .then((stop) => {
          if (disposed) stop();
          else unlisten = stop;
        })
        .catch((reason: unknown) =>
          setError(`Could not register the unsaved-change guard: ${String(reason)}`),
        );
    }
    return () => {
      disposed = true;
      unlisten?.();
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [hasUnsavedChanges]);

  const reportError = useCallback((reason: unknown) => setError(String(reason)), []);
  const updateContents = (contents: Record<string, string>) => {
    contentsRef.current = contents;
    setFileContents(contents);
  };
  const run = async (operation: () => Promise<void>) => {
    try {
      await operation();
    } catch (reason) {
      reportError(reason);
    }
  };
  const applyTree = (tree: FileNode | null) => {
    treeRef.current = tree;
    setFileTree(tree);
  };
  // Lists one directory and patches it into the tree; stale responses are dropped.
  const loadDirectory = useCallback(async (path: string) => {
    const sequence = (treeRequests.current.get(path) ?? 0) + 1;
    treeRequests.current.set(path, sequence);
    const revision = workspaceRevision.current;
    const node = await native("list_workspace_files", { path, maxDepth: 1 });
    if (revision !== workspaceRevision.current || treeRequests.current.get(path) !== sequence)
      return;
    const current = treeRef.current;
    applyTree(
      current && isWithin(node.path, current.path)
        ? setChildren(current, node.path, node.children ?? [])
        : node,
    );
  }, []);
  const loadWorkspace = useCallback(
    async (target: string) => {
      await loadDirectory(target);
      setWorkspacePath(treeRef.current?.path ?? target);
      setQuickOpen(null);
      setGitRevision((value) => value + 1);
    },
    [loadDirectory],
  );
  // Re-lists every loaded folder: manual refresh, and after Git operations.
  const refreshTree = async () => {
    const tree = treeRef.current;
    if (!tree) return;
    for (const directory of loadedDirectories(tree)) {
      if (!treeRef.current || !findNode(treeRef.current, directory)) continue;
      try {
        await loadDirectory(directory);
      } catch (error) {
        reportError(`${directory}: ${String(error)}`);
      }
    }
    setQuickOpen(null);
    setGitRevision((value) => value + 1);
  };
  // Re-lists the loaded folders that hold `paths` after a file operation.
  const refreshAround = async (...paths: string[]) => {
    const tree = treeRef.current;
    if (!tree) return;
    for (const directory of new Set(paths.map((path) => nearestLoadedDirectory(tree, path))))
      await loadDirectory(directory);
    setQuickOpen(null);
    setGitRevision((value) => value + 1);
  };

  useEffect(() => {
    if (!isTauri()) return;
    native("get_default_workspace")
      .then((path) => (path ? loadWorkspace(path) : undefined))
      .catch(reportError);
  }, [loadWorkspace, reportError]);

  // Edits made outside the app (a checkout, a build, another editor) re-list the tree.
  const refreshTreeRef = useRef(refreshTree);
  refreshTreeRef.current = refreshTree;
  useEffect(
    () => onWorkspaceChanged(() => void refreshTreeRef.current().catch(reportError)),
    [reportError],
  );

  // Git decorations refresh on focus when the Source Control panel is not polling.
  useEffect(() => {
    if (isSidebarOpen && activeActivityTab === "git") return;
    const refresh = () => setGitRevision((value) => value + 1);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [isSidebarOpen, activeActivityTab]);

  const handleOpenFile = (path: string, name: string = path.split("/").pop() || path) =>
    run(async () => {
      setDiff(null);
      if (path === "welcome") {
        setActiveTabId(path);
        return;
      }
      if (contentsRef.current[path] === undefined) {
        const revision = workspaceRevision.current;
        const content = await native("read_file_content", { path });
        if (revision !== workspaceRevision.current) return;
        savedContents.current[path] = content;
        if (contentsRef.current[path] === undefined)
          updateContents({ ...contentsRef.current, [path]: content });
      }
      setTabs((prev) =>
        prev.some((tab) => tab.path === path)
          ? prev
          : [...prev, { id: path, path, name, dirty: false }],
      );
      setActiveTabId(path);
      setRecentFiles((prev) =>
        [{ name, path }, ...prev.filter((file) => file.path !== path)].slice(0, 10),
      );
    });

  const handleCloseTab = (id: string) => {
    if (saving.current.size) {
      reportError("Wait for saves to finish before closing editors.");
      return;
    }
    if (
      tabs.find((tab) => tab.id === id)?.dirty &&
      !window.confirm("Discard unsaved changes in this file?")
    )
      return;
    setTabs((prev) => prev.filter((tab) => tab.id !== id));
    const next = { ...contentsRef.current };
    delete next[id];
    histories.current.delete(id);
    delete savedContents.current[id];
    updateContents(next);
    if (activeTabId === id) setActiveTabId("welcome");
  };
  const handleContentChange = (path: string, text: string) => {
    updateContents({ ...contentsRef.current, [path]: text });
    setTabs((prev) =>
      prev.map((tab) =>
        tab.path === path ? { ...tab, dirty: text !== savedContents.current[path] } : tab,
      ),
    );
  };
  const saving = useRef(new Set<string>());
  const handleSaveFile = (path: string) =>
    run(async () => {
      const content = contentsRef.current[path];
      if (content === undefined || saving.current.has(path)) return;
      saving.current.add(path);
      try {
        await native("write_file_guarded", {
          path,
          expected: savedContents.current[path],
          content,
        });
        savedContents.current[path] = content;
        setTabs((prev) =>
          prev.map((tab) =>
            tab.path === path ? { ...tab, dirty: contentsRef.current[path] !== content } : tab,
          ),
        );
        setGitRevision((value) => value + 1);
      } finally {
        saving.current.delete(path);
      }
    });
  const handleOpenFolderDialog = () =>
    run(async () => {
      if (saving.current.size)
        throw new Error("Wait for file saves to finish before changing workspace.");
      if (
        tabs.some((tab) => tab.dirty) &&
        !window.confirm("Discard unsaved changes and open another workspace?")
      )
        return;
      const selected = await native("open_folder_dialog");
      if (!selected) return;
      workspaceRevision.current++;
      setDiff(null);
      setPendingHit(null);
      updateContents({});
      savedContents.current = {};
      histories.current.clear();
      setTabs([{ id: "welcome", name: "Welcome", path: "welcome", dirty: false }]);
      setActiveTabId("welcome");
      setRecentFiles([]);
      setWorkspacePath(selected);
      applyTree(null);
      setDecorations({ files: new Map(), folders: new Set() });
      await loadWorkspace(selected);
    });
  const handleCreateFile = (path: string) =>
    run(async () => {
      await native("create_file", { path });
      await refreshAround(path);
      await handleOpenFile(path);
    });
  const handleCreateFolder = (path: string) =>
    run(async () => {
      await native("create_directory", { path });
      await refreshAround(path);
    });
  const handleRename = (oldPath: string, newPath: string) =>
    run(async () => {
      if (saving.current.size)
        throw new Error("Wait for file saves to finish before renaming files.");
      await native("rename_path", { oldPath, newPath });
      const remap = (path: string) => remapPath(path, oldPath, newPath);
      setTabs((prev) =>
        prev.map((tab) => ({
          ...tab,
          id: remap(tab.id),
          path: remap(tab.path),
          name: remap(tab.path).split("/").pop() || tab.name,
        })),
      );
      setActiveTabId(remap);
      histories.current = new Map(
        [...histories.current].map(([path, history]) => [remap(path), history]),
      );
      savedContents.current = Object.fromEntries(
        Object.entries(savedContents.current).map(([path, text]) => [remap(path), text]),
      );
      updateContents(
        Object.fromEntries(
          Object.entries(contentsRef.current).map(([path, text]) => [remap(path), text]),
        ),
      );
      setRecentFiles((prev) =>
        prev.map((file) => ({
          path: remap(file.path),
          name: remap(file.path).split("/").pop() || file.name,
        })),
      );
      await refreshAround(oldPath, newPath);
    });
  // Deletes one entry or a whole Explorer selection behind a single confirmation.
  const handleDelete = (entries: { path: string; isDir: boolean }[]) => {
    if (!entries.length) return;
    if (saving.current.size) {
      reportError("Wait for file saves to finish before deleting files.");
      return;
    }
    const doomed = (path: string) => entries.some((entry) => isWithin(path, entry.path));
    const dirty = tabs.some((tab) => tab.dirty && doomed(tab.path));
    const [only] = entries;
    const subject =
      entries.length === 1
        ? `“${only.path.split("/").pop()}”${only.isDir ? " and everything inside it" : ""}`
        : `these ${entries.length} items and everything inside them`;
    setDialog({
      title: entries.length > 1 ? "Delete items" : only.isDir ? "Delete folder" : "Delete file",
      confirmLabel: "Delete",
      message:
        `Permanently delete ${subject}? This cannot be undone.` +
        (dirty ? "\n\nUnsaved changes in open editors will be discarded." : ""),
      submit: async () => {
        for (const entry of entries)
          await native("delete_path", { path: entry.path, recursive: entry.isDir });
        setTabs((prev) => prev.filter((tab) => !doomed(tab.path)));
        for (const key of histories.current.keys()) if (doomed(key)) histories.current.delete(key);
        savedContents.current = Object.fromEntries(
          Object.entries(savedContents.current).filter(([key]) => !doomed(key)),
        );
        if (doomed(activeTabId)) setActiveTabId("welcome");
        updateContents(
          Object.fromEntries(Object.entries(contentsRef.current).filter(([key]) => !doomed(key))),
        );
        setRecentFiles((prev) => prev.filter((file) => !doomed(file.path)));
        await refreshAround(...entries.map((entry) => entry.path));
      },
    });
  };
  const handleDuplicate = (path: string) =>
    run(async () => {
      const copy = await native("duplicate_path", { path });
      await refreshAround(copy);
    });
  const handleCopyPath = (src: string, dest: string) =>
    run(async () => {
      await native("copy_path", { src, dest });
      await refreshAround(dest);
    });
  const handleMovePath = (src: string, dest: string) =>
    handleRename(src, dest.replace(/\/$/, "") + "/" + src.split("/").pop());
  const handleReveal = (path: string) => run(() => native("reveal_in_explorer", { path }));

  const activeTab = tabs.find((t) => t.id === activeTabId);

  useEffect(() => {
    if (!pendingHit || activeTabId !== pendingHit.path || diff) return;
    const content = fileContents[pendingHit.path];
    if (content === undefined) return;
    const lines = content.split("\n");
    if (lines[pendingHit.line - 1] !== pendingHit.text.replace(/\n$/, "")) {
      reportError("This search result changed. Search again to locate it.");
    } else {
      const start =
        lines.slice(0, pendingHit.line - 1).reduce((n, line) => n + line.length + 1, 0) +
        pendingHit.start;
      editorRef.current?.revealRange(start, start + pendingHit.end - pendingHit.start);
    }
    setPendingHit(null);
  }, [activeTabId, fileContents, pendingHit, diff, reportError]);

  const applyReplacements = async (changes: Replacement[], saved = false) => {
    const applied: Replacement[] = [];
    const errors: string[] = [];
    const revision = workspaceRevision.current;
    for (const change of changes) {
      try {
        if (workspaceRevision.current !== revision)
          throw new Error("Workspace changed; remaining files skipped");
        if (saving.current.has(change.path)) throw new Error("File is being saved");
        const open = contentsRef.current[change.path];
        if (open !== undefined && open !== change.before)
          throw new Error("Editor changed; preview again");
        if (open === undefined || saved) {
          saving.current.add(change.path);
          try {
            await native("write_file_guarded", {
              path: change.path,
              expected: change.before,
              content: change.after,
            });
          } finally {
            saving.current.delete(change.path);
          }
          if (saved) savedContents.current[change.path] = change.after;
        }
        if (open !== undefined) {
          if (contentsRef.current[change.path] !== change.before)
            throw new Error("Editor changed during write; saved file updated, editor retained");
          const history = histories.current.get(change.path) ?? { past: [], future: [] };
          recordEdit(history, { text: open, start: 0, end: 0 });
          histories.current.set(change.path, history);
          handleContentChange(change.path, change.after);
        }
        applied.push(change);
      } catch (error) {
        errors.push(`${change.path}: ${String(error)}`);
      }
    }
    setGitRevision((value) => value + 1);
    return { applied, errors };
  };

  const reconcileWorkspace = async () => {
    const revision = workspaceRevision.current;
    for (const [path, before] of Object.entries(contentsRef.current)) {
      if (before !== savedContents.current[path]) continue;
      try {
        const content = await native("read_file_content", { path });
        if (revision !== workspaceRevision.current) return;
        if (contentsRef.current[path] !== before) continue;
        savedContents.current[path] = content;
        updateContents({ ...contentsRef.current, [path]: content });
      } catch (error) {
        reportError(`${path}: ${String(error)}`);
      }
    }
    await refreshTree();
  };

  const handleHunkAction = async (action: "stage" | "unstage" | "discard", hunkIndex: number) => {
    if (!diff?.repoId || !diff.kind) return;
    const entry = gitRegistry.getSnapshot().repos.find((r) => r.repoId === diff.repoId);
    if (!entry) return;
    const repo = entry.store.repository;
    const targetPath = diff.path;
    const targetKind = diff.kind;
    const targetText = diff.text;
    // A renamed file's diff needs both paths again on every reload, or Git shows it as a
    // whole new file.
    const targetOriginalPath = diff.originalPath;

    // Routed through the shared `guarded()` (same as commit/stage/pull/push) so a
    // hunk action sets the repo's busy flag, blocks conflicting concurrent
    // operations, and reports failures through the store's shared notice. The real
    // dirty flag is passed and `DIRTY_BLOCKED` decides which of the three kinds it
    // actually blocks -- only `discard-hunk` rewrites the file on disk, and it must be
    // blocked or a stale editor buffer's next save silently undoes the discard.
    const ok = await guardedAffecting(entry, `${action}-hunk`, hasUnsavedChanges, async () => {
      if (action === "stage") await repo.stageHunks(targetText, [hunkIndex]);
      else if (action === "unstage") await repo.unstageHunks(targetText, [hunkIndex]);
      else await repo.discardHunks(targetText, [hunkIndex]);
      return "Hunk updated.";
    });
    if (ok) {
      try {
        await reconcileWorkspace();
        setGitRevision((value) => value + 1);
      } catch (error) {
        entry.store.setNotice(String(error));
      }
    }

    // Re-fetch on both success and failure: a failed apply means the hunk
    // coordinates the user was looking at no longer matched the file (Git's own
    // context-line matching refuses a stale patch cleanly), so the diff view is
    // provably stale too and must not keep showing it as if nothing happened.
    try {
      const refreshed = await repo.diff(targetPath, targetKind === "staged", targetOriginalPath);
      setDiff(refreshed.trim() ? { ...diff, text: refreshed } : null);
    } catch (error) {
      entry.store.setNotice(String(error));
    }
  };

  const hasEditor = !!activeTab && activeTab.id !== "welcome";
  const desktop = isTauri();
  // Quick open lists the whole workspace through the packaged search tool, not the lazy tree.
  const loadQuickOpen = () => {
    if (!desktop || !workspacePath) return;
    const revision = workspaceRevision.current;
    setQuickOpen({ files: [], note: "Loading workspace files…" });
    listFiles(workspacePath)
      .then(({ files, truncated }) => {
        if (revision === workspaceRevision.current)
          setQuickOpen({ files, note: truncated ? "Some files could not be listed." : "" });
      })
      .catch((error) => setQuickOpen({ files: [], note: String(error) }));
  };
  const openPalette = (mode: "files" | "commands") => {
    if (!quickOpen?.files.length) loadQuickOpen();
    setPaletteMode(mode);
    setIsCommandPaletteOpen(true);
  };
  const newFile = () => {
    if (!desktop) {
      const path = "preview:" + crypto.randomUUID();
      const name = "Untitled.ts";
      savedContents.current[path] = "";
      updateContents({ ...contentsRef.current, [path]: "" });
      setTabs((prev) => [...prev, { id: path, path, name, dirty: false }]);
      setActiveTabId(path);
      return;
    }
    setDialog({
      title: "New file",
      afterClose: () => editorRef.current?.focus(),
      message: "Enter a path relative to the workspace. Existing files will not be overwritten.",
      input: "untitled.ts",
      submit: async (value) => {
        const relative = value.trim();
        const problem = validateEntryName(relative, true);
        if (problem) throw new Error(problem);
        const path = workspacePath.replace(/\/$/, "") + "/" + relative;
        await native("create_file", { path });
        await handleOpenFile(path);
        await refreshAround(path);
      },
    });
  };
  const closeAll = () => {
    if (saving.current.size) throw new Error("Wait for saves to finish before closing editors.");
    if (hasUnsavedChanges && !window.confirm("Discard all unsaved changes and close all editors?"))
      return;
    setTabs([{ id: "welcome", path: "welcome", name: "Welcome", dirty: false }]);
    setActiveTabId("welcome");
    updateContents({});
    histories.current.clear();
    savedContents.current = {};
  };
  const edit = (action: EditorAction) => editorRef.current?.execute(action);
  const navigateTab = (direction: number) => {
    if (!tabs.length) return;
    const index = tabs.findIndex((tab) => tab.id === activeTabId);
    setActiveTabId(tabs[(index + direction + tabs.length) % tabs.length].id);
  };
  const commands: AppCommand[] = [
    {
      id: "view.search",
      menu: "View",
      label: "Search in Files",
      shortcut: "Mod+Shift+f",
      run: () => {
        setActiveActivityTab("search");
        setIsSidebarOpen(true);
        setSearchFocus((v) => v + 1);
      },
    },
    {
      id: "view.replace",
      menu: "View",
      label: "Replace in Files",
      shortcut: "Mod+Shift+h",
      run: () => {
        setActiveActivityTab("search");
        setIsSidebarOpen(true);
        setSearchFocus((v) => v + 1);
      },
    },
    {
      id: "view.sourceControl",
      menu: "View",
      label: "Source Control",
      shortcut: "Mod+Shift+g",
      run: () => {
        setActiveActivityTab("git");
        setIsSidebarOpen(true);
      },
    },
    {
      id: "file.new",
      menu: "File",
      label: "New File…",
      shortcut: "Mod+n",
      disabled: desktop && !workspacePath,
      run: newFile,
    },
    {
      id: "file.open",
      menu: "File",
      label: "Open File…",
      shortcut: "Mod+o",
      disabled: !desktop || !workspacePath,
      reason: "Choose a file inside the current workspace",
      run: async () => {
        const selected = await native("open_file_dialog");
        if (selected) await handleOpenFile(selected);
      },
    },
    {
      id: "file.folder",
      menu: "File",
      label: "Open Folder…",
      shortcut: "Mod+Shift+o",
      disabled: !desktop,
      run: handleOpenFolderDialog,
    },
    {
      id: "file.save",
      menu: "File",
      label: "Save",
      shortcut: "Mod+s",
      disabled: !desktop || !hasEditor || !activeTab?.dirty,
      run: () => handleSaveFile(activeTabId),
    },
    {
      id: "file.saveAll",
      menu: "File",
      label: "Save All",
      shortcut: "Mod+Shift+s",
      disabled: !desktop || !hasUnsavedChanges,
      run: async () => {
        if (saving.current.size) throw new Error("A save is already in progress.");
        const dirtyTabs = tabs.filter((tab) => tab.dirty);
        for (const tab of dirtyTabs) {
          const content = contentsRef.current[tab.path];
          saving.current.add(tab.path);
          try {
            await native("write_file_guarded", {
              path: tab.path,
              expected: savedContents.current[tab.path],
              content,
            });
            savedContents.current[tab.path] = content;
            setTabs((prev) =>
              prev.map((item) =>
                item.path === tab.path
                  ? { ...item, dirty: contentsRef.current[tab.path] !== content }
                  : item,
              ),
            );
          } finally {
            saving.current.delete(tab.path);
          }
        }
        // Every other write path (single save, hunk reconcile, every Explorer
        // op) already bumps this once its own writes settle; Save All omitted
        // it, leaving Git status to fall back entirely on the ~300ms watcher
        // latency instead of the immediate trigger every other path gets.
        if (dirtyTabs.length) setGitRevision((value) => value + 1);
      },
    },
    {
      id: "file.close",
      menu: "File",
      label: "Close Editor",
      shortcut: "Mod+w",
      disabled: !hasEditor,
      run: () => handleCloseTab(activeTabId),
    },
    {
      id: "file.closeAll",
      menu: "File",
      label: "Close All Editors",
      disabled: !hasEditor && tabs.length <= 1,
      run: closeAll,
    },
    {
      id: "file.reveal",
      menu: "File",
      label: "Reveal in File Explorer",
      disabled: !desktop || !hasEditor,
      run: () => handleReveal(activeTabId),
    },
    {
      id: "file.exit",
      menu: "File",
      label: "Exit",
      disabled: !desktop,
      run: async () => {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().close();
      },
    },
    {
      id: "edit.undo",
      menu: "Edit",
      label: "Undo",
      shortcut: "Mod+z",
      disabled: !hasEditor || !editorState.canUndo,
      run: () => edit("undo"),
    },
    {
      id: "edit.redo",
      menu: "Edit",
      label: "Redo",
      shortcut: "Mod+Shift+z",
      disabled: !hasEditor || !editorState.canRedo,
      run: () => edit("redo"),
    },
    {
      id: "edit.cut",
      menu: "Edit",
      label: "Cut",
      shortcut: "Mod+x",
      disabled: !hasEditor || !editorState.selected,
      run: () => edit("cut"),
    },
    {
      id: "edit.copy",
      menu: "Edit",
      label: "Copy",
      shortcut: "Mod+c",
      disabled: !hasEditor || !editorState.selected,
      run: () => edit("copy"),
    },
    {
      id: "edit.paste",
      menu: "Edit",
      label: "Paste",
      shortcut: "Mod+v",
      disabled: !hasEditor,
      run: () => edit("paste"),
    },
    {
      id: "edit.find",
      menu: "Edit",
      label: "Find…",
      shortcut: "Mod+f",
      disabled: !hasEditor,
      run: () => edit("find"),
    },
    {
      id: "edit.replace",
      menu: "Edit",
      label: "Replace…",
      shortcut: "Mod+h",
      disabled: !hasEditor,
      run: () => edit("replace"),
    },
    {
      id: "selection.all",
      menu: "Selection",
      label: "Select All",
      shortcut: "Mod+a",
      disabled: !hasEditor,
      run: () => edit("selectAll"),
    },
    {
      id: "selection.line",
      menu: "Selection",
      label: "Select Line",
      shortcut: "Mod+l",
      disabled: !hasEditor,
      run: () => edit("selectLine"),
    },
    {
      id: "selection.duplicate",
      menu: "Selection",
      label: "Duplicate Selection or Line",
      shortcut: "Mod+Shift+d",
      disabled: !hasEditor,
      run: () => edit("duplicate"),
    },
    {
      id: "view.commands",
      menu: "View",
      label: "Command Palette…",
      shortcut: "Mod+Shift+p",
      run: () => openPalette("commands"),
    },
    {
      id: "view.sidebar",
      menu: "View",
      label: "Primary Sidebar",
      shortcut: "Mod+b",
      checked: isSidebarOpen,
      run: () => setIsSidebarOpen((prev) => !prev),
    },
    {
      id: "view.panel",
      menu: "View",
      label: "Bottom Panel",
      shortcut: "Mod+" + String.fromCharCode(96),
      checked: isTerminalOpen,
      run: () => showTerminal((prev) => !prev),
    },
    {
      id: "view.ai",
      menu: "View",
      label: "AI Assistant Panel",
      checked: isAIOpen,
      run: () => setIsAIOpen((prev) => !prev),
    },
    {
      id: "view.wrap",
      menu: "View",
      label: "Word Wrap",
      shortcut: "Alt+z",
      checked: wordWrap,
      run: () => setWordWrap((prev) => !prev),
    },
    {
      id: "view.zoomIn",
      menu: "View",
      label: "Zoom In",
      disabled: zoom >= 2,
      run: () => setZoom((prev) => Math.min(2, prev + 0.1)),
    },
    {
      id: "view.zoomOut",
      menu: "View",
      label: "Zoom Out",
      disabled: zoom <= 0.7,
      run: () => setZoom((prev) => Math.max(0.7, prev - 0.1)),
    },
    { id: "view.zoomReset", menu: "View", label: "Reset Zoom", run: () => setZoom(1) },
    {
      id: "go.file",
      menu: "Go",
      label: "Go to File…",
      shortcut: "Mod+p",
      run: () => openPalette("files"),
    },
    {
      id: "go.line",
      menu: "Go",
      label: "Go to Line…",
      shortcut: "Mod+g",
      disabled: !hasEditor,
      run: () =>
        setDialog({
          title: "Go to line",
          input: "1",
          afterClose: () => editorRef.current?.focus(),
          submit: (value) => {
            if (!/^\d+$/.test(value.trim())) throw new Error("Enter a positive whole line number.");
            editorRef.current?.goToLine(Number(value));
          },
        }),
    },
    {
      id: "go.previous",
      menu: "Go",
      label: "Previous Editor",
      shortcut: "Mod+PageUp",
      disabled: tabs.length < 2,
      run: () => navigateTab(-1),
    },
    {
      id: "go.next",
      menu: "Go",
      label: "Next Editor",
      shortcut: "Mod+PageDown",
      disabled: tabs.length < 2,
      run: () => navigateTab(1),
    },
    {
      id: "terminal.toggle",
      menu: "Terminal",
      label: "Show / Hide Panel",
      checked: isTerminalOpen,
      run: () => showTerminal((prev) => !prev),
    },
    {
      id: "terminal.new",
      menu: "Terminal",
      label: "New Terminal",
      shortcut: "Mod+Shift+" + String.fromCharCode(96),
      run: () => {
        showTerminal(true);
        requestTerminal("new");
      },
    },
    {
      id: "terminal.split",
      menu: "Terminal",
      label: "Split Terminal",
      run: () => {
        showTerminal(true);
        requestTerminal("split");
      },
    },
    {
      id: "terminal.clear",
      menu: "Terminal",
      label: "Clear Terminal",
      disabled: !isTerminalOpen,
      reason: "Show the panel first",
      run: () => requestTerminal("clear"),
    },
    {
      id: "terminal.find",
      menu: "Terminal",
      label: "Find in Terminal",
      disabled: !isTerminalOpen,
      reason: "Show the panel first",
      run: () => requestTerminal("find"),
    },
    {
      id: "terminal.kill",
      menu: "Terminal",
      label: "Close Terminal",
      disabled: !isTerminalOpen,
      reason: "Show the panel first",
      run: () => requestTerminal("kill"),
    },
    {
      id: "help.shortcuts",
      menu: "Help",
      label: "Keyboard Shortcuts",
      run: () =>
        setDialog({
          title: "Keyboard shortcuts",
          message: commands
            .filter((command) => command.shortcut)
            .map((command) => command.label + " — " + shortcutLabel(command.shortcut!))
            .join("\n"),
        }),
    },
    {
      id: "help.about",
      menu: "Help",
      label: "About Yavin",
      run: () =>
        setDialog({
          title: "About Yavin IDE",
          message:
            "Yavin IDE 2.0.0\nReact + TypeScript + Vite + Tauri\n\nBrowse and edit workspace files, and run a shell in the terminal panel. AI services and language servers are not connected.\n\nBrowser preview keeps edits only in memory; open the desktop application to save files.",
        }),
    },
  ];
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        dialog ||
        isCommandPaletteOpen
      )
        return;
      const command = commands.find(
        (item) => item.shortcut && matchesShortcut(event, item.shortcut),
      );
      if (!command) return;
      const target = event.target;
      const textControl =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable);
      const nativeTextCommand = [
        "edit.cut",
        "edit.copy",
        "edit.paste",
        "edit.undo",
        "edit.redo",
        "selection.all",
      ].includes(command.id);
      if (textControl && nativeTextCommand) return;
      event.preventDefault();
      if (!command.disabled)
        void run(async () => {
          await command.run();
        });
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  return (
    <ErrorBoundary>
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-[#000000] text-zinc-100 font-sans antialiased">
        {!isTauri() && (
          <div role="status" className="bg-zinc-900 px-4 py-2 text-xs">
            Browser preview. Open the desktop app to work with local files.
          </div>
        )}
        {error && (
          <div role="alert" className="bg-red-950 px-4 py-2 text-sm">
            {error}
            <button className="ml-4 underline" onClick={() => setError(null)}>
              Dismiss
            </button>
          </div>
        )}
        {/* Top TitleBar */}
        <TitleBar
          onToggleSidebar={() => setIsSidebarOpen((prev) => !prev)}
          onToggleTerminal={() => showTerminal((prev) => !prev)}
          onToggleAI={() => setIsAIOpen((prev) => !prev)}
          onOpenCommandPalette={() => openPalette("files")}
          isAIOpen={isAIOpen}
          commands={commands}
          onError={reportError}
        />

        {/* Main Workspace Area */}
        <div className="flex flex-1 min-h-0 w-full overflow-hidden">
          {/* Leftmost Activity Bar */}
          <ActivityBar
            activeTab={activeActivityTab}
            gitBadge={totalGitChanges > 0 ? String(totalGitChanges) : ""}
            onSelectTab={(tabId) => {
              if (activeActivityTab === tabId && isSidebarOpen) {
                setIsSidebarOpen(false);
              } else {
                setActiveActivityTab(tabId);
                setIsSidebarOpen(true);
              }
            }}
            onOpenSettings={() => openPalette("commands")}
          />

          {/* Dynamic File Tree Explorer */}
          <SearchPanel
            key={`search:${workspacePath}`}
            workspace={workspacePath}
            buffers={fileContents}
            visible={isSidebarOpen && activeActivityTab === "search"}
            focusRequest={searchFocus}
            onOpen={(hit) => {
              setPendingHit(hit);
              void handleOpenFile(hit.path);
            }}
            read={(path) =>
              contentsRef.current[path] !== undefined
                ? Promise.resolve(contentsRef.current[path])
                : native("read_file_content", { path })
            }
            apply={applyReplacements}
          />
          <SourceControlPanel
            key={`git:${workspacePath}`}
            workspace={workspacePath}
            buffers={fileContents}
            visible={isSidebarOpen && activeActivityTab === "git"}
            dirty={hasUnsavedChanges}
            revision={gitRevision}
            onDiff={setDiff}
            onChanged={reconcileWorkspace}
            apply={(changes) => applyReplacements(changes, true)}
            onEntries={(entries) => setDecorations(buildDecorations(entries, workspacePath))}
            activeDiffPath={diff?.path}
            onOpenGraph={() => {
              setDiff(null);
              setShowGraph(true);
            }}
            onShowOutput={() => {
              setDiff(null);
              setShowGraph(false);
              setShowGitOutput(true);
            }}
            onDialog={setDialog}
          />
          <Sidebar
            key={`explorer:${workspacePath}`}
            visible={isSidebarOpen && activeActivityTab !== "search" && activeActivityTab !== "git"}
            activeTab={activeActivityTab}
            workspacePath={workspacePath}
            fileTree={fileTree}
            decorations={decorations}
            onLoadDirectory={loadDirectory}
            onOpenFile={handleOpenFile}
            activeFile={activeTab?.path || ""}
            onRefresh={() => run(refreshTree)}
            onCreateFile={handleCreateFile}
            onCreateFolder={handleCreateFolder}
            onRename={handleRename}
            onDelete={handleDelete}
            onDuplicate={handleDuplicate}
            onCopyFile={handleCopyPath}
            onMoveFile={handleMovePath}
            onReveal={handleReveal}
            onOpenFolderDialog={handleOpenFolderDialog}
          />

          {/* Center: Editor + Bottom Terminal Panel */}
          <div className="flex flex-1 flex-col min-w-0 bg-[#000000]">
            {showGitOutput ? (
              <GitOutputPanel onClose={() => setShowGitOutput(false)} />
            ) : showGraph && activeRepo ? (
              <CommitGraphPanel
                key={activeRepo.repoId}
                repository={activeRepo.store.repository}
                onClose={() => setShowGraph(false)}
                onDiff={setDiff}
                onApplyCommit={(kind, commit) => {
                  const verb = kind === "cherryPick" ? "Cherry-pick" : "Revert";
                  setDialog({
                    title: `${verb} commit`,
                    message:
                      kind === "cherryPick"
                        ? `Apply "${commit.subject}" onto the current branch? It may stop on a conflict for you to resolve.`
                        : `Create a new commit undoing "${commit.subject}"? It may stop on a conflict for you to resolve.`,
                    confirmLabel: verb,
                    submit: () =>
                      void guardedAffecting(activeRepo, kind, hasUnsavedChanges, () =>
                        kind === "cherryPick"
                          ? activeRepo.store.repository.cherryPick(commit.fullHash)
                          : activeRepo.store.repository.revertCommit(commit.fullHash),
                      ),
                  });
                }}
              />
            ) : diff ? (
              <DiffEditor
                key={diff.path + diff.title + diff.text}
                document={diff}
                onClose={() => setDiff(null)}
                onOpen={() => void handleOpenFile(diff.path)}
                onStageHunk={
                  diff.repoId && diff.kind === "unstaged"
                    ? (i) => void handleHunkAction("stage", i)
                    : undefined
                }
                onUnstageHunk={
                  diff.repoId && diff.kind === "staged"
                    ? (i) => void handleHunkAction("unstage", i)
                    : undefined
                }
                onDiscardHunk={
                  diff.repoId && diff.kind === "unstaged"
                    ? (i) => void handleHunkAction("discard", i)
                    : undefined
                }
              />
            ) : (
              <EditorArea
                tabs={tabs}
                activeTabId={activeTabId}
                onSelectTab={(path, name) => handleOpenFile(path, name || path.split("/").pop())}
                onCloseTab={handleCloseTab}
                onNewFile={newFile}
                onOpenCommandPalette={() => openPalette("commands")}
                onOpenFolderDialog={handleOpenFolderDialog}
                fileContents={fileContents}
                onContentChange={handleContentChange}
                onSaveFile={handleSaveFile}
                recentFiles={recentFiles}
                editorRef={editorRef}
                histories={histories.current}
                onEditorState={setEditorState}
                wordWrap={wordWrap}
                zoom={zoom}
              />
            )}

            {wasTerminalOpened && (
              <Suspense fallback={null}>
                <TerminalPanel
                  hidden={!isTerminalOpen}
                  onClose={() => setIsTerminalOpen(false)}
                  isMaximized={isTerminalMaximized}
                  onToggleMaximize={() => setIsTerminalMaximized((prev) => !prev)}
                />
              </Suspense>
            )}
          </div>

          {/* Right AI Drawer */}
          {isAIOpen && <AIAssistantPanel onClose={() => setIsAIOpen(false)} />}
        </div>

        {/* Status Bar */}
        <StatusBar
          activeFile={activeTab?.path || ""}
          onToggleTerminal={() => showTerminal((prev) => !prev)}
          branch={activeRepoSnapshot?.branch}
        />

        {dialog && <AppDialog request={dialog} onClose={() => setDialog(null)} />}
        {/* Command Palette */}
        <CommandPalette
          commands={commands}
          mode={paletteMode}
          onError={reportError}
          files={quickOpen?.files ?? []}
          filesNote={
            quickOpen?.note ?? (desktop ? "" : "Open the desktop application to search files.")
          }
          isOpen={isCommandPaletteOpen}
          onClose={() => setIsCommandPaletteOpen(false)}
          onSelectFile={handleOpenFile}
        />
      </div>
    </ErrorBoundary>
  );
}
