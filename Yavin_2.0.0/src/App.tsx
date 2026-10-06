import { AppDialog } from "./components/ui/AppDialog";
import type { MenuItem } from "./components/ui/ContextMenu";
import type { DocumentNotice, MarkdownMode } from "./components/layout/EditorArea";
import type { MarkdownLink } from "./services/markdownLinks";
import type { MarkdownPreviewHandle } from "./components/layout/MarkdownPreview";
import type { DialogRequest } from "./components/ui/AppDialog";
import type { EditorHandle, EditorState, EditorAction } from "./editor/editorTypes";
import { createEditorViews } from "./services/editorViews";
import { matchesShortcut, shortcutLabel } from "./services/commands";
import type { AppCommand } from "./services/commands";
import { useTerminalUiState } from "./services/terminalHooks";
import { terminalFolder } from "./services/terminalShell";
import {
  editorTerminalCwd,
  revealableFolder,
  resolvePathLink,
  terminalCwdFor,
  watchFinishedCommands,
} from "./services/terminalIde";
import type { TerminalId } from "./services/terminalProtocol";
import type { TerminalSessionView } from "./services/terminalService";
import React, {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  useSyncExternalStore,
  Component,
  lazy,
  Suspense,
} from "react";
import { TitleBar } from "./components/layout/TitleBar";
import { ActivityBar } from "./components/layout/ActivityBar";
import { LocalHistoryPanel } from "./components/localgit/LocalHistoryPanel"; // LG-08
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
import type { SearchHit } from "./services/search";
import type { PanelViewId } from "./services/panel/views";
import { folderKey } from "./services/paths";
import {
  EMPTY_SESSION,
  forgetFolder,
  lastFolder,
  provideSessionParts,
  readSession,
  RECENT_FOLDERS,
  windowSessions,
  workspaceIn,
} from "./services/session";
import { savedFor, viewStateOf } from "./services/workspaceSession";
import { workspaceIdOf } from "./services/workspaceManager";
import type { Session, WorkspaceSession } from "./services/session";
import { cloneRepository } from "./services/git/clone";
import { readTrust, UNKNOWN_TRUST } from "./services/trust";
import type { TrustState } from "./services/trust";
import { WorkspaceTrustDialog } from "./components/trust/WorkspaceTrustDialog";

import { isTauri } from "@tauri-apps/api/core";
import type { EditorTab, OpenTab, RecentFile } from "./types";
import { createDocumentService, DocumentError, documentStatus } from "./services/documents";
import type { DocumentIO, DocumentService, TextDocument } from "./services/documents";
import { languageLabel } from "./services/language";
import { native, onResourceChanges, onWatcherStatus } from "./services/native";
import { createWatchTracker } from "./services/resourceEvents";
import { asRecoveryReport, describeRecovery } from "./services/recovery";
import { createOutputChannel } from "./services/panel/output";
import { isWithin, remapPath, validateEntryName } from "./services/workspace";
import { createFileSystemExplorerProvider } from "./services/explorerProvider";
import type { FileSystemExplorerProvider } from "./services/explorerProvider";
import { createExplorerStore } from "./services/explorerStore";
import {
  buildDecorations,
  bumpGitRevision,
  guardedAffecting,
  sameDecorations,
  useActiveRepoId,
  useTotalChanges,
} from "./services/git";
import type { Decorations } from "./services/git";
import { hitOffset, listFiles } from "./services/search";
import { createCursorStatus } from "./services/cursorStatus";
import { createLspManager } from "./services/lsp/manager";
import { describeStatus } from "./services/lsp/manager";
import { createNativeTransport, nativeAvailability } from "./services/lsp/nativeTransport";
import { applyWorkspaceEdit } from "./services/lsp/workspaceEdit";
import type { WorkspaceEditHost } from "./services/lsp/workspaceEdit";
import { flattenSymbols } from "./services/lsp/symbols";
import { createOutlineStore, toOutline } from "./services/lsp/outline";
import { OutlineSection, SymbolCrumbs } from "./components/layout/Outline";
import type { DocumentSymbol, SymbolInformation } from "./services/lsp/protocol";
import { LineIndex } from "./services/lsp/positions";
import type { LanguageFeaturesHost } from "./editor/lspMonaco";
import type { EditorRange } from "./editor/editorTypes";
import type { PaletteSymbol, SymbolScope } from "./components/command-palette/CommandPalette";
import { clearProblems, publishProblems } from "./services/panel/problems";
import {
  breakpoints,
  currentGit,
  extensionRegistry,
  onExtensionMessage,
  settings,
  terminalSettings,
  terminalProfiles,
  useWorkspace,
  workspaces,
} from "./services/workspaces";
import { EDITOR_SETTINGS } from "./editor/editorSettings";
import { useEditorSettings } from "./editor/useEditorSettings";
import type { SettingDefinition } from "./services/settings/settings";
import { SettingsView } from "./components/settings/SettingsView";
import { RunPanel } from "./components/layout/RunPanel";
import { DebugPanel } from "./components/layout/DebugPanel";
import { ExtensionsPanel } from "./components/layout/ExtensionsPanel";
import { ExtensionError } from "./services/extensions/errors";
import { discoverInstalledOnce, rediscoverExtensions } from "./services/extensions/discovery";
import { resolveKeybindings } from "./services/extensions/contributions";
import { DebugError } from "./services/debug/errors";
import type { ResourceUri } from "./services/resource";
import { TaskError } from "./services/tasks/errors";
import { isFinal, type TaskRun } from "./services/tasks/service";
import { createOverlayTracker } from "./services/localgit/overlays";
import { fileUri, resourceId } from "./services/resource";
import { loadMinimapPreferences, saveMinimapPreferences } from "./services/minimapPreferences";
import type { MinimapPreferences } from "./services/minimapPreferences";

/**
 * The Document Model's disk: the guarded native commands, each one a Module 03 operation with
 * its Module 04 recovery intent. The only way an open document reaches a file.
 */
const documentIO: DocumentIO = {
  read: (path) => native("read_file_content", { path }),
  write: (path, expected, content) => native("write_file_guarded", { path, expected, content }),
  create: (path, content) => native("create_file_with_content", { path, content }),
  readOnly: (path) => native("is_read_only", { path }),
};

const WELCOME_TAB: OpenTab = { id: "welcome", name: "Welcome", path: "welcome" };
/** Numbers dialog requests, so each gets its own dialog element (see `dialogKey`). */
let dialogCount = 0;

/** What the session keeps of the Explorer. */
interface ExplorerSessionState {
  expanded: string[];
  scroll: number;
  selected: string[];
  focused: string | null;
}
const NO_EXPLORER_STATE: ExplorerSessionState = {
  expanded: [],
  scroll: 0,
  selected: [],
  focused: null,
};
const explorerStateOf = (state: WorkspaceSession): ExplorerSessionState => ({
  expanded: state.expanded,
  scroll: state.scroll,
  selected: state.selected ?? [],
  focused: state.focused ?? null,
});
const NO_ROOTS: never[] = [];
/** What a Markdown preview's images are, by extension (`read_image_file` allows only these). */
const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
};
/**
 * Commands that act on the editor's text. From the keyboard they run only while the editor
 * has it; elsewhere the key is the focused control's (see the window's key handler).
 */
const EDITOR_KEY_COMMANDS = [
  "selection.line",
  "selection.duplicate",
  "selection.copyLineUp",
  "selection.copyLineDown",
  "selection.moveLineUp",
  "selection.moveLineDown",
  "edit.deleteLine",
  "edit.toggleComment",
  "edit.indent",
  "edit.outdent",
  // Language features: F2 in the Explorer renames a file, not a symbol.
  "lsp.definition",
  "lsp.references",
  "lsp.rename",
  "lsp.format",
  "lsp.quickFix",
  "lsp.suggest",
  "lsp.nextProblem",
];
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
  const previewRef = useRef<MarkdownPreviewHandle>(null);
  /** The editor's cursor for the status bar, outside React state (see `cursorStatus.ts`). */
  const cursorStatus = useRef(createCursorStatus()).current;
  /**
   * The editor's own state per document -- undo history, selection, scroll -- which is not the
   * document's (see `services/editorViews.ts`).
   */
  const views = useRef(createEditorViews()).current;
  const [editorState, setEditorState] = useState<EditorState>({
    canUndo: false,
    canRedo: false,
    selected: false,
  });
  const [dialog, setDialog] = useState<DialogRequest | null>(null);
  /**
   * One dialog element per request. A dialog's `submit` may open the next one (pick a remote,
   * then name the branch): that one must not be closed, or cleared, by the first as it closes
   * itself -- which is what a shared element and an unconditional clear did.
   */
  const dialogKeys = useRef(new WeakMap<DialogRequest, number>());
  const dialogKey = (request: DialogRequest) => {
    let key = dialogKeys.current.get(request);
    if (key === undefined) {
      key = ++dialogCount;
      dialogKeys.current.set(request, key);
    }
    return key;
  };
  /** The Settings view (IDE-03) is shown in the editor's place. */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteMode, setPaletteMode] = useState<
    "files" | "commands" | "symbols" | "workspaceSymbols"
  >("files");
  const [workspacePath, setWorkspacePath] = useState("");
  /**
   * The Explorer Provider (`services/explorerProvider.ts`): what the Explorer shows, as a
   * projection of the filesystem -- listings, per-folder state, watcher changes applied where
   * they show. The window keeps no tree of its own; it renders the provider's projection.
   */
  const explorerProviderRef = useRef<FileSystemExplorerProvider | null>(null);
  explorerProviderRef.current ??= createFileSystemExplorerProvider({
    list: (path) => native("list_workspace_files", { path, maxDepth: 1 }),
  });
  const explorer = explorerProviderRef.current;
  const explorerRevision = useSyncExternalStore(explorer.subscribe, explorer.revision);
  // Every root, the same array for as long as nothing in any of them changed.
  const explorerRoots = useMemo(() => explorer.projections(), [explorer, explorerRevision]);
  /** The open folder as the Explorer's root has it -- the listing's own spelling. */
  const rootPath = useCallback(() => explorer.getRootNodes()[0]?.path ?? null, [explorer]);
  const [quickOpen, setQuickOpen] = useState<{ files: string[]; note: string } | null>(null);
  /**
   * The Document Model (`services/documents.ts`): the one owner of open files' contents, their
   * versions, whether they are saved and what happened to them on disk. The editor, search and
   * Source Control read its text through `buffers()`; nothing here keeps a copy of its own.
   */
  const documentsRef = useRef<DocumentService | null>(null);
  documentsRef.current ??= createDocumentService(documentIO, {
    base: () => (explorerProviderRef.current?.projection() ? rootPath() : null),
  });
  const documents = documentsRef.current;
  // The window redraws when what it shows about documents changes -- a tab's dirty marker, a
  // status, a document opened or closed -- not for every keystroke: the editor showing the
  // document subscribes to its text on its own (`CodeEditor`).
  const documentState = useSyncExternalStore(documents.subscribe, documents.stateRevision);
  /** The open documents' text, read when it is needed rather than passed down as it changes. */
  const readBuffers = useCallback(() => documents.buffers(), [documents]);
  /** Whether the file's open document has edits its file does not hold; false when not open. */
  const hasUnsavedEdits = useCallback(
    (path: string) => documents.get(path)?.dirty ?? false,
    [documents],
  );
  const workspaceRevision = useRef(0);
  const [decorations, setDecorations] = useState<Decorations>({
    files: new Map(),
    folders: new Set(),
  });
  const [openTabs, setTabs] = useState<OpenTab[]>([WELCOME_TAB]);
  // What each tab shows about its document is read from the document, never stored twice.
  const tabs: EditorTab[] = openTabs.map((tab) => {
    const doc = tab.id === "welcome" ? undefined : documents.get(tab.path);
    return doc
      ? { ...tab, name: doc.name, dirty: doc.dirty, status: documentStatus(doc) }
      : { ...tab, dirty: false };
  });
  const [activeTabId, setActiveTabId] = useState("welcome");
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([]);
  /** The folders opened before, and what each looked like. See `services/session.ts`. */
  const [session, setSession] = useState<Session>(EMPTY_SESSION);
  /** What the explorer looks like now, kept out of render: it changes on every scroll. */
  const explorerRef = useRef<ExplorerSessionState>(NO_EXPLORER_STATE);
  /**
   * The session as it stands now, which is not the same as `session`: that is React state for
   * the recent list, updated only when the list itself changes, while this tracks every save
   * so that reopening a folder restores what it had a moment ago rather than at startup.
   */
  const sessionRef = useRef<Session>(EMPTY_SESSION);
  /** Kept in step with `session`, so both the list and the lookups see the same thing. */
  const rememberSession = useCallback((next: Session) => {
    sessionRef.current = next;
    setSession(next);
  }, []);
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

  const [isAIOpen, setIsAIOpen] = useState(false);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [activeActivityTab, setActiveActivityTab] = useState("explorer");
  const [diff, setDiff] = useState<DiffDocument | null>(null);
  /**
   * What the panel has been asked to show, if anything.
   *
   * Carries a `nonce` because the value alone is not enough: asking for the same channel or
   * view twice in a row set identical state, React bailed out, the prop never changed and the
   * panel's effect never re-ran -- so "Show Git Output" worked once per session and did
   * nothing afterwards.
   */
  const [panelRequest, setPanelRequest] = useState<{
    nonce: number;
    view?: PanelViewId;
    channel?: string;
  }>({ nonce: 0 });

  /** Workspace Trust: owned natively, mirrored here so the UI can reflect and change it. */
  const [trust, setTrust] = useState<TrustState>(UNKNOWN_TRUST);
  const [trustDialog, setTrustDialog] = useState<"prompt" | "manage" | null>(null);
  // Re-read whenever the open folder changes: the decision is per folder.
  useEffect(() => {
    let cancelled = false;
    readTrust()
      .then((next) => {
        if (cancelled) return;
        setTrust(next);
        // An undecided folder is the only thing that raises the prompt unbidden.
        if (!next.decided) setTrustDialog("prompt");
      })
      // No desktop backend (the browser preview) runs nothing, so there is nothing to gate.
      .catch(() => !cancelled && setTrust({ ...UNKNOWN_TRUST, trusted: true }));
    return () => {
      cancelled = true;
    };
  }, [workspacePath]);

  const showPanelView = useCallback((view: PanelViewId, channel?: string) => {
    setPanelRequest((previous) => ({ nonce: previous.nonce + 1, view, channel }));
  }, []);
  /** Shows the panel on its terminals. */
  const revealTerminals = useCallback(() => {
    showTerminal(true);
    showPanelView("terminal");
  }, [showTerminal, showPanelView]);
  /**
   * Starts a terminal in the workspace in front -- through its TerminalUi, never a window-wide
   * channel -- and shows it, optionally in a folder ("Open in Integrated Terminal").
   */
  const openTerminal = useCallback(
    (cwd?: string) => {
      revealTerminals();
      workspaces.current().services.terminalUi.newTerminal(cwd ? { cwd } : {});
    },
    [revealTerminals],
  );
  /**
   * A terminal in `cwd` for an IDE action (Explorer, editor): one already there is shown again,
   * else one starts there (`TerminalUi.openIn`).
   */
  const openTerminalIn = useCallback(
    (cwd: string) => {
      revealTerminals();
      workspaces.current().services.terminalUi.openIn(cwd);
    },
    [revealTerminals],
  );
  const [searchFocus, setSearchFocus] = useState(0);
  const [replaceRequest, setReplaceRequest] = useState(0);
  /** How the editor's minimap looks: its right-click menu and View › Minimap change it. */
  const [minimap, setMinimap] = useState<MinimapPreferences>(loadMinimapPreferences);
  const changeMinimap = useCallback((change: Partial<MinimapPreferences>) => {
    setMinimap((previous) => {
      const next = { ...previous, ...change };
      saveMinimapPreferences(next);
      return next;
    });
  }, []);
  /** How each Markdown document is shown (editor, preview, both), by document id. */
  const [markdownModes, setMarkdownModes] = useState<ReadonlyMap<string, MarkdownMode>>(new Map());
  /** Read-only files the user chose to edit anyway, by document id: the choice lasts while open. */
  const [editAnyway, setEditAnyway] = useState<ReadonlySet<string>>(new Set());
  const [pendingHit, setPendingHit] = useState<SearchHit | null>(null);
  const hasUnsavedChanges = tabs.some((tab) => tab.dirty);
  const totalGitChanges = useTotalChanges();
  const activeRepoId = useActiveRepoId();

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
  const run = async (operation: () => Promise<void>) => {
    try {
      await operation();
    } catch (reason) {
      reportError(reason);
    }
  };
  /** Lists a folder the Explorer is showing; abandoned (the folder collapsed) with `signal`. */
  const loadDirectory = useCallback(
    (path: string, signal?: AbortSignal) => explorer.loadChildren(explorer.idFor(path), signal),
    [explorer],
  );
  const loadWorkspace = useCallback(
    async (target: string) => {
      const revision = workspaceRevision.current;
      // The workspace itself first: the one left is disposed -- its Git repositories closed,
      // their watchers and polling stopped -- before anything of the new one exists.
      await workspaces.open([target]);
      if (revision !== workspaceRevision.current) return;
      // Local Git's snapshots see this workspace's unsaved documents (read, never changed),
      // for as long as the workspace is open.
      const context = workspaces.current();
      const localGit = context.services.localGit;
      if (localGit) {
        const tracker = createOverlayTracker(documents, context.folders);
        context.own(localGit.attachOverlays(tracker));
        context.own(tracker.dispose);
      }
      explorer.setRoots([target]);
      await explorer.loadChildren(explorer.idFor(target));
      // A folder opened while this listing was in flight owns the window now. Setting the
      // path here would aim the explorer, Source Control and the trust check at the folder
      // that has just been left, while the tree and the native side show the new one.
      if (revision !== workspaceRevision.current) return;
      setWorkspacePath(rootPath() ?? target);
      setQuickOpen(null);
      bumpGitRevision();
    },
    [explorer, rootPath],
  );
  /**
   * Re-lists every loaded folder: manual refresh, and after Git operations. The provider lists
   * them together and reconciles each answer in one pass; a newer listing of a folder always
   * wins over an older one still in flight, so overlapping refreshes need no queue.
   */
  const refreshTree = async () => {
    if (!explorer.projection()) return;
    const revision = workspaceRevision.current;
    const errors = await explorer.refresh();
    if (revision !== workspaceRevision.current) return;
    for (const error of errors) reportError(error);
    setQuickOpen(null);
    bumpGitRevision();
  };
  // Re-lists the loaded folders that hold `paths` after a file operation.
  const refreshAround = async (...paths: string[]) => {
    if (!explorer.projection()) return;
    const errors = await explorer.refreshAround(paths);
    setQuickOpen(null);
    bumpGitRevision();
    if (errors.length) throw new Error(errors.join("\n"));
  };

  /**
   * Reopens the tabs a folder had when it was last closed.
   *
   * A file that has been deleted, renamed or moved since is simply not reopened: a restore
   * that reported four errors for four files someone deleted on purpose would be worse than
   * one that quietly opens what is still there.
   */
  const restoreTabs = useCallback(
    async (state: WorkspaceSession, live: () => boolean = () => true) => {
      const revision = workspaceRevision.current;
      // Opened together rather than one after another: this is startup, and fifty files read
      // in series is fifty round trips the window waits through before it is usable.
      // `Promise.all` keeps the results in tab order.
      const read = await Promise.all(
        state.files.map((path) =>
          // Gone since last time; nothing to reopen and nothing worth saying.
          documents.open(path).catch(() => null),
        ),
      );
      // Another workspace (or another restore) owns the window now: nothing of this one is applied.
      if (revision !== workspaceRevision.current || !live()) return;

      // One tab per resource, however the session spelled its path.
      const identity = (path: string) => {
        try {
          return resourceId(fileUri(path));
        } catch {
          return path;
        }
      };
      const opened: OpenTab[] = [];
      const seen = new Set<string>();
      for (const doc of read) {
        if (!doc || seen.has(identity(doc.key))) continue;
        seen.add(identity(doc.key));
        opened.push({ id: doc.key, path: doc.key, name: doc.name });
      }
      if (!opened.length) return;
      // Where the editor was in each file: given to EditorViews, from which the editor restores
      // a document's view when it shows it. The session never touches the editor itself.
      for (const view of state.views ?? []) {
        const doc = opened.find((tab) => identity(tab.path) === identity(view.file));
        if (doc && !views.has(doc.id)) views.setViewState(doc.id, viewStateOf(view));
      }
      setTabs((previous) => [
        ...previous,
        ...opened.filter((tab) => !previous.some((existing) => existing.path === tab.path)),
      ]);
      setRecentFiles(opened.map((tab) => ({ name: tab.name, path: tab.path })).reverse());
      const active = state.active
        ? opened.find((tab) => identity(tab.path) === identity(state.active!))
        : undefined;
      if (active) setActiveTabId(active.id);
    },
    [documents, views],
  );

  /**
   * Records what this folder looks like now. Called from the effect below and from the
   * explorer, which reports scrolling and unfolding outside render -- the writer coalesces
   * the bursts, so calling it often is cheap.
   */
  // The stored tabs, not the drawn ones: those are rebuilt on every render, and the session
  // would be rewritten on every keystroke.
  const sessionState = useRef({
    tabs: openTabs,
    activeTabId,
    activeActivityTab,
    isSidebarOpen,
    isTerminalOpen,
  });
  sessionState.current = {
    tabs: openTabs,
    activeTabId,
    activeActivityTab,
    isSidebarOpen,
    isTerminalOpen,
  };
  // What the window holds, for the session's snapshot (IDE-06, `workspaceSession.ts`): read when
  // a snapshot is taken, never kept. Files only -- an untitled document has nothing on disk to
  // reopen, and its content is DocumentService's (there is no hot exit yet).
  useEffect(() => {
    provideSessionParts(
      () => {
        const now = sessionState.current;
        return {
          tabs: now.tabs
            .filter((tab) => tab.id !== "welcome")
            .map((tab) => ({
              key: tab.id,
              path: tab.path,
              disk: documents.get(tab.path)?.source.kind === "disk",
            })),
          active: now.activeTabId,
          explorer: explorerRef.current,
          // The document in front is asked of the editor itself: it saves its view state only
          // when it leaves a document.
          viewState: (key) =>
            key === now.activeTabId && editorRef.current
              ? editorRef.current.viewState()
              : views.getViewState(key),
          layout: {
            sidebarView: now.activeActivityTab,
            sidebarOpen: now.isSidebarOpen,
            panelOpen: now.isTerminalOpen,
          },
        };
      },
      // Kept in memory as well as written: a folder reopened later in the run restores from
      // this, not from the startup snapshot.
      (record) => {
        sessionRef.current = {
          folders: sessionRef.current.folders,
          workspaces: [
            ...sessionRef.current.workspaces.filter(
              (one) => folderKey(one.folder) !== folderKey(record.folder),
            ),
            record,
          ],
        };
      },
    );
  }, [documents, views]);
  /**
   * Something the session remembers changed. Saved (debounced) once the workspace's session
   * has finished restoring -- the empty window it passes through on the way is never saved.
   */
  const writeSession = useCallback(() => {
    if (isTauri()) windowSessions.current()?.markDirty();
  }, []);
  useEffect(writeSession, [
    workspacePath,
    openTabs,
    activeTabId,
    activeActivityTab,
    isSidebarOpen,
    isTerminalOpen,
    writeSession,
  ]);
  /** The side bar and panel as the session left them. */
  const restoreLayout = useCallback(
    (state: WorkspaceSession) => {
      const layout = state.layout;
      if (!layout) return;
      setActiveActivityTab(layout.sidebarView);
      setIsSidebarOpen(layout.sidebarOpen);
      // The panel is shown as it was; what it shows, and its terminals, are its own.
      if (layout.panelOpen) showTerminal(true);
    },
    [showTerminal],
  );

  /** The explorer reporting what it has unfolded and selected, and where it is scrolled. */
  const rememberExplorer = useCallback(
    (next: ExplorerSessionState) => {
      explorerRef.current = next;
      writeSession();
    },
    [writeSession],
  );
  /**
   * The Explorer's UI state (`services/explorerStore.ts`), one per workspace: expansion,
   * selection, focus and reveal, following the provider's renames and deletions. Made when the
   * window takes a folder, from what the session says it looked like -- by then the provider
   * knows the folder's root, so the saved paths resolve to nodes.
   */
  const explorerStore = useMemo(
    () =>
      createExplorerStore(explorer, {
        expanded: explorerRef.current.expanded,
        selection: explorerRef.current.selected,
        focused: explorerRef.current.focused,
      }),
    // A new workspace, a new store: `explorerRef` has been seeded for it by then.
    [explorer, workspacePath],
  );
  useEffect(() => explorerStore.attach(), [explorerStore]);

  // Startup: reopen the folder from last time, with what was open in it. A folder that has
  // since been moved or deleted falls back to opening no folder rather than failing to start.
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    // Opening a folder by hand while this is still running takes precedence: the revision
    // it bumps is what tells the restore its work is no longer wanted.
    const revision = workspaceRevision.current;
    const superseded = () => cancelled || revision !== workspaceRevision.current;
    void (async () => {
      const saved = await readSession().catch(() => EMPTY_SESSION);
      if (superseded()) return;
      rememberSession(saved);
      const target = lastFolder(saved);
      if (target) {
        try {
          const root = await native("open_workspace", { path: target });
          if (superseded()) return;
          const workspaceId = workspaceIdOf([root]);
          // The session (IDE-06): created for the workspace, restored, then active -- nothing is
          // saved before that, and nothing of it applies once another workspace is opened.
          const session = windowSessions.begin({
            folder: root,
            workspaceId,
            saved: savedFor(saved, target, workspaceId),
          });
          const state = session.saved;
          if (state) explorerRef.current = explorerStateOf(state);
          const restored = await session.restore(async (live) => {
            // The tree listing and the files' contents are independent once the folder is
            // open, so they are fetched at the same time rather than one behind the other.
            await Promise.all([loadWorkspace(root), state ? restoreTabs(state, live) : undefined]);
            if (state && live()) restoreLayout(state);
          });
          if (restored) writeSession();
          return;
        } catch (reason) {
          // Moved, deleted, on a drive that is not mounted, or unreadable. Worth saying:
          // otherwise the project someone closed the window on is simply gone, with the
          // welcome page offering no hint as to why.
          if (!superseded()) reportError(`Could not reopen ${target}: ${String(reason)}`);
        }
      }
      if (superseded()) return;
      // Development builds open the directory Yavin was started from; release builds open
      // nothing, which is what puts the welcome page in front of a first run.
      const fallback = await native("get_default_workspace").catch(() => null);
      if (superseded() || !fallback) return;
      // A session like any other workspace's: restored, then saved as it changes.
      const workspaceId = workspaceIdOf([fallback]);
      const session = windowSessions.begin({
        folder: fallback,
        workspaceId,
        saved: savedFor(sessionRef.current, fallback, workspaceId),
      });
      const state = session.saved;
      if (state) explorerRef.current = explorerStateOf(state);
      try {
        const restored = await session.restore(async (live) => {
          await loadWorkspace(fallback);
          if (state && live()) {
            await restoreTabs(state, live);
            if (live()) restoreLayout(state);
          }
        });
        if (restored) writeSession();
      } catch (reason) {
        reportError(reason);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadWorkspace, restoreTabs, restoreLayout, rememberSession, reportError, writeSession]);

  // Changes on disk reach the Explorer through its provider, which re-lists only the loaded
  // folders they touched. Changes the watcher credits to one of Yavin's own operations are
  // skipped: each operation already re-lists what it changed as it finishes (`refreshAround`).
  // What crash recovery did at startup, and what still needs the user (see recovery.ts). Once:
  // the native side settled everything before this window could exist.
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    native("recovery_report")
      .then((payload) => {
        if (cancelled) return;
        const { lines, banner } = describeRecovery(asRecoveryReport(payload));
        if (!lines.length) return;
        const log = createOutputChannel("Recovery");
        for (const line of lines) log.appendLine(line.text, line.level);
        if (banner) reportError(banner);
      })
      .catch(reportError);
    return () => {
      cancelled = true;
    };
  }, [reportError]);

  const watchTracker = useRef(createWatchTracker());
  /** The language servers (set once they exist, below); the watcher tells them about files. */
  const lspRef = useRef<ReturnType<typeof createLspManager> | null>(null);
  useEffect(() => {
    const log = createOutputChannel("Workspace");
    const stopChanges = onResourceChanges((batch) => {
      const root = explorer.projection() ? rootPath() : null;
      if (!root || !watchTracker.current.accept(batch, root)) return;
      for (const scope of batch.rescan)
        log.appendLine(`Changes under ${scope} were not all reported; re-reading it.`, "info");
      // Open documents check every change to their files, their own saves excepted.
      void documents.applyResourceChanges(batch.changes, batch.rescan).catch(reportError);
      // Language servers hear about the files they registered for, whoever changed them.
      lspRef.current?.filesChanged(batch.changes);
      const external = batch.changes.filter((change) => change.operation === undefined);
      void explorer
        .applyResourceChanges(external, batch.rescan)
        .then(({ relisted, errors }) => {
          for (const error of errors) reportError(error);
          if (relisted) setQuickOpen(null);
          if (relisted || external.length) bumpGitRevision();
        })
        .catch(reportError);
    });
    const stopStatus = onWatcherStatus((status) => {
      const current = watchTracker.current.status(status);
      if (!current) return;
      if (current.state === "watching") log.appendLine(`Watching ${current.root}.`, "info");
      else
        log.appendLine(
          `Stopped watching ${current.root}: ${current.message ?? "unknown error"}. Changes ` +
            "made outside Yavin will not appear until the explorer is refreshed.",
          "warn",
        );
    });
    return () => {
      stopChanges();
      stopStatus();
    };
  }, [documents, explorer, reportError, rootPath]);

  // What the Document Model decides, the editors follow: a document that became another file
  // (Save As, or a rename) takes its tab and undo history with it; a conflict is said once.
  useEffect(
    () =>
      documents.subscribe((event) => {
        if (event.type === "sourceChanged") {
          const { previousKey, key } = event;
          const doc = documents.get(key);
          setTabs((previous) =>
            previous.map((tab) =>
              tab.path === previousKey ? { id: key, path: key, name: doc?.name ?? tab.name } : tab,
            ),
          );
          setActiveTabId((active) => (active === previousKey ? key : active));
          views.rename(previousKey, key);
        } else if (event.type === "conflict") {
          const doc = documents.all().find((one) => one.id === event.id);
          reportError(
            `“${doc?.name ?? "A file"}” changed on disk while it had unsaved changes. Nothing ` +
              "was overwritten and your changes are kept: use File › Revert File to take the " +
              "version on disk, or File › Keep My Version to replace it on the next save.",
          );
        }
      }),
    [documents, reportError, views],
  );

  // Development builds only, and only for the UI tests: opens a proposal in the editor. Nothing
  // in the product creates one yet -- that arrives with ChangeSets -- and production builds drop
  // this entirely.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const hook = window as unknown as {
      __yavinPropose?: (path: string, text: string) => Promise<void>;
    };
    hook.__yavinPropose = async (path, text) => {
      const doc = await documents.propose(path, text);
      setTabs((previous) => [...previous, { id: doc.key, path: doc.key, name: doc.name }]);
      setActiveTabId(doc.key);
    };
    return () => {
      delete hook.__yavinPropose;
    };
  }, [documents]);
  // Development builds only, and only for the UI tests: shows several roots. The native side
  // opens one folder per window, so nothing in the product adds a second root yet.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const hook = window as unknown as { __yavinSetRoots?: (paths: string[]) => Promise<void> };
    hook.__yavinSetRoots = async (paths) => {
      explorer.setRoots(paths);
      await Promise.all(paths.map((path) => explorer.loadChildren(explorer.idFor(path))));
    };
    return () => {
      delete hook.__yavinSetRoots;
    };
  }, [explorer]);

  // Git decorations refresh on focus when the Source Control panel is not polling.
  useEffect(() => {
    if (isSidebarOpen && activeActivityTab === "git") return;
    const refresh = () => bumpGitRevision();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [isSidebarOpen, activeActivityTab]);

  // The name a caller passes is not needed: the document knows its own.
  const handleOpenFile = (path: string) =>
    run(async () => {
      setDiff(null);
      setSettingsOpen(false);
      if (path === "welcome") {
        // Its tab may have been closed -- Help > Welcome is how it comes back -- and
        // selecting a tab that is not there leaves the strip with nothing selected.
        setTabs((previous) =>
          previous.some((tab) => tab.id === "welcome") ? previous : [WELCOME_TAB, ...previous],
        );
        setActiveTabId(path);
        return;
      }
      // However the path is spelled, one resource is one document and one tab: the tab is
      // keyed by the document's key, not by the spelling that asked for it.
      const doc = documents.get(path) ?? (await documents.open(path));
      // Null: the workspace changed while it was loading.
      if (!doc) return;
      const key = doc.key;
      setTabs((prev) =>
        prev.some((tab) => tab.path === key)
          ? prev
          : [...prev, { id: key, path: key, name: doc.name }],
      );
      setActiveTabId(key);
      if (doc.source.kind === "disk")
        setRecentFiles((prev) =>
          [{ name: doc.name, path: key }, ...prev.filter((file) => file.path !== key)].slice(0, 10),
        );
    });

  /** Files closed in this folder, the latest last: what Reopen Closed Editor brings back. */
  const closedFiles = useRef<string[]>([]);
  const rememberClosed = (paths: string[]) => {
    const kept = closedFiles.current.filter((path) => !paths.includes(path));
    closedFiles.current = [...kept, ...paths].slice(-20);
  };

  /**
   * Closes several tabs at once (Close Others, Close to the Right, Close Saved), asking once
   * for all the unsaved changes that would be lost. Nothing closes while one of them saves.
   */
  const closeTabs = (ids: string[]) => {
    const closing = new Set(ids);
    const docs = ids.flatMap((id) => (id === "welcome" ? [] : (documents.get(id) ?? [])));
    if (docs.some((doc) => doc.save.kind === "saving")) {
      reportError(
        ids.length === 1
          ? "Wait for the file to finish saving before closing it."
          : "Wait for saves to finish before closing these editors.",
      );
      return;
    }
    const unsaved = docs.filter((doc) => doc.dirty);
    // "This file" only for the one in front; any other is named.
    const question =
      ids.length === 1 && ids[0] === activeTabId
        ? "Discard unsaved changes in this file?"
        : unsaved.length === 1
          ? `Discard unsaved changes in ${unsaved[0].name}?`
          : `Discard unsaved changes in ${unsaved.length} files?`;
    if (unsaved.length && !window.confirm(question)) return;
    rememberClosed(docs.flatMap((doc) => (doc.path ? [doc.path] : [])));
    for (const doc of docs) {
      documents.close(doc.key, { discard: true });
      views.forget(doc.key);
    }
    setTabs((prev) => prev.filter((tab) => !closing.has(tab.id)));
    if (closing.has(activeTabId)) {
      // The tab beside it comes forward, as in a browser: the nearest one to the right that
      // stays open, else to the left.
      const index = tabs.findIndex((tab) => tab.id === activeTabId);
      const next =
        tabs.slice(index + 1).find((tab) => !closing.has(tab.id)) ??
        tabs
          .slice(0, index)
          .reverse()
          .find((tab) => !closing.has(tab.id));
      setActiveTabId(next?.id ?? "welcome");
    }
  };
  const handleCloseTab = (id: string) => closeTabs([id]);
  /** The tab's neighbours for Close Others and Close to the Right. */
  const otherTabs = (id: string) => tabs.filter((tab) => tab.id !== id).map((tab) => tab.id);
  const tabsRightOf = (id: string) =>
    tabs.slice(tabs.findIndex((tab) => tab.id === id) + 1).map((tab) => tab.id);
  const savedTabs = () =>
    tabs
      .filter((tab) => {
        const doc = tab.id === "welcome" ? undefined : documents.get(tab.id);
        return !doc || (!doc.dirty && doc.save.kind !== "saving");
      })
      .map((tab) => tab.id);
  const reopenClosed = () => {
    const path = closedFiles.current.pop();
    if (path) void handleOpenFile(path);
  };
  /** Save As: a new file for any open document, and how an untitled one reaches the disk. */
  const saveAs = async (key: string) => {
    const doc = documents.get(key);
    if (!doc || doc.source.kind === "proposed") return;
    const target = await native("save_file_dialog", { defaultName: doc.name });
    if (!target) return;
    // The tab and its history follow the document (`sourceChanged`, above).
    await documents.saveAs(key, target);
    await refreshAround(target);
  };
  const handleSaveFile = (key: string) =>
    run(async () => {
      const doc = documents.get(key);
      if (!doc) return;
      if (doc.source.kind === "untitled") return saveAs(key);
      try {
        await documents.save(key);
      } catch (error) {
        // Refused because the file changed on disk: the conflict has been announced, in words
        // more useful than the write's own.
        if (!(error instanceof DocumentError) && documentStatus(doc) === "conflicted") return;
        throw error;
      }
      bumpGitRevision();
    });
  /**
   * Everything that has to happen when the window changes folder, whichever way the folder
   * was chosen. `restore` reopens what that folder had open last time.
   */
  const enterWorkspace = async (selected: string, restore?: WorkspaceSession) => {
    workspaceRevision.current++;
    // The session left is saved as it is now -- before anything of it is cleared -- and ended;
    // the new one restores, and is saved only once it has (IDE-06, `workspaceSession.ts`).
    const workspaceId = workspaceIdOf([selected]);
    const session = windowSessions.begin({ folder: selected, workspaceId, saved: restore ?? null });
    restore = session.saved ?? undefined;
    setDiff(null);
    setPendingHit(null);
    documents.reset();
    views.clear();
    setTabs([WELCOME_TAB]);
    setActiveTabId("welcome");
    setRecentFiles([]);
    closedFiles.current = [];
    setWorkspacePath(selected);
    explorer.setRoots([]);
    setDecorations({ files: new Map(), folders: new Set() });
    // Seeded before the explorer mounts for the new folder, so it unfolds where it was.
    explorerRef.current = restore ? explorerStateOf(restore) : NO_EXPLORER_STATE;
    // Optimistic, so the recent list is in the right order before the file is written.
    rememberSession({
      ...sessionRef.current,
      folders: [
        selected,
        ...sessionRef.current.folders.filter((folder) => folderKey(folder) !== folderKey(selected)),
      ].slice(0, RECENT_FOLDERS),
    });
    const restored = await session.restore(async (live) => {
      await loadWorkspace(selected);
      if (restore && live()) {
        await restoreTabs(restore, live);
        if (live()) restoreLayout(restore);
      }
    });
    // Written once the folder is actually open, so a folder that failed to list is not
    // recorded as the one to reopen next time.
    if (restored) writeSession();
  };

  /** Refuses to leave a folder while saves are in flight, and asks about unsaved edits. */
  const canLeaveWorkspace = () => {
    if (documents.anySaving())
      throw new Error("Wait for file saves to finish before changing workspace.");
    return (
      !tabs.some((tab) => tab.dirty) ||
      window.confirm("Discard unsaved changes and open another workspace?")
    );
  };

  const handleOpenFolderDialog = () =>
    run(async () => {
      if (!canLeaveWorkspace()) return;
      const selected = await native("open_folder_dialog");
      if (!selected) return;
      // A folder picked from the dialog restores what it had open just as one picked from
      // the recent list does: how the folder was chosen should not change what comes back.
      await enterWorkspace(selected, workspaceIn(sessionRef.current, selected));
    });

  /** Opening a folder from the recent list: the same thing, without the dialog. */
  const handleOpenRecentFolder = (folder: string) =>
    run(async () => {
      if (!canLeaveWorkspace()) return;
      let root: string;
      try {
        root = await native("open_workspace", { path: folder });
      } catch (reason) {
        // The entry is kept. A folder can fail to open because it is gone, but just as
        // easily because a drive is not mounted or a VPN is down, and silently deleting
        // someone's project from the list -- along with its tabs -- over a transient
        // failure is not a trade worth making. Removing it is one click away.
        throw new Error(`Cannot open ${folder}: ${String(reason)}`);
      }
      await enterWorkspace(root, workspaceIn(sessionRef.current, folder));
    });

  const handleForgetRecentFolder = (folder: string) =>
    run(async () => rememberSession(await forgetFolder(folder)));
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
    run(() => renameEntry(oldPath, newPath));
  /** A rename, as the Explorer and a language server's edits both make one (Module 03). */
  const renameEntry = async (oldPath: string, newPath: string) => {
    {
      if (documents.anySaving())
        throw new Error("Wait for file saves to finish before renaming files.");
      await native("rename_path", { oldPath, newPath });
      // What the Explorer knows moves with it, and its expansion and selection follow.
      explorer.moved(oldPath, newPath);
      const remap = (path: string) => remapPath(path, oldPath, newPath);
      // Open documents under it move to their new identity; their tabs, histories and the
      // active editor follow (`sourceChanged`).
      documents.moved(oldPath, newPath);
      setRecentFiles((prev) =>
        prev.map((file) => ({
          path: remap(file.path),
          name: remap(file.path).split("/").pop() || file.name,
        })),
      );
      await refreshAround(oldPath, newPath);
    }
  };
  /** Deletes entries (Module 03 operations), closing what was open inside them. */
  const deleteEntries = async (entries: { path: string; isDir: boolean }[]) => {
    const doomed = (path: string) => entries.some((entry) => isWithin(path, entry.path));
    for (const entry of entries) {
      await native("delete_path", { path: entry.path, recursive: entry.isDir });
      explorer.removed(entry.path);
      documents.removed(entry.path);
    }
    setTabs((prev) => prev.filter((tab) => !doomed(tab.path)));
    for (const tab of openTabs) if (doomed(tab.path)) views.forget(tab.path);
    if (doomed(activeTabId)) setActiveTabId("welcome");
    setRecentFiles((prev) => prev.filter((file) => !doomed(file.path)));
    await refreshAround(...entries.map((entry) => entry.path));
  };

  // --- Language servers (Module 10) ------------------------------------------------------
  /**
   * The window's language servers: which one serves each document, what it is told, what it
   * says. Created once; it follows the Document Model on its own, and the folder and trust
   * below decide what may run.
   */
  const lspOutput = useRef(createOutputChannel("Language Servers")).current;
  const latestForLsp = useRef({ workspacePath, editAnyway });
  latestForLsp.current = { workspacePath, editAnyway };
  /** Where a server's edit goes: the WorkspaceEdit engine, through the Document Model. */
  const workspaceEditHost = useRef<WorkspaceEditHost | null>(null);
  workspaceEditHost.current = {
    documents,
    canEdit: (doc) => !doc.readOnly || latestForLsp.current.editAnyway.has(doc.id),
    documentForUri: (uri) =>
      uri.startsWith("untitled:")
        ? documents.all().find((doc) => `untitled:${encodeURIComponent(doc.name)}` === uri)
        : undefined,
    open: async (path) => {
      const doc = await documents.open(path);
      if (!doc) throw new Error(`${path} could not be opened.`);
      return doc;
    },
    // Edited by a server but not shown: now unsaved, so they get tabs (not brought forward).
    reveal: (docs) =>
      setTabs((prev) => [
        ...prev,
        ...docs
          .filter((doc) => !prev.some((tab) => tab.id === doc.key))
          .map((doc) => ({ id: doc.key, path: doc.key, name: doc.name })),
      ]),
    createFile: async (path, options) => {
      try {
        await native("create_file", { path });
      } catch (error) {
        if (!options?.ignoreIfExists) throw error;
      }
      await refreshAround(path);
    },
    renameFile: (from, to) => renameEntry(from, to),
    deleteFile: async (path, options) => {
      try {
        await deleteEntries([{ path, isDir: Boolean(options?.recursive) }]);
      } catch (error) {
        if (!options?.ignoreIfNotExists) throw error;
      }
    },
  };
  const lsp = useRef(
    (() => {
      const manager = createLspManager({
        documents,
        transport: createNativeTransport((serverId, line) =>
          lspOutput.appendLine(`[${serverId}] ${line}`, "debug"),
        ),
        folders: () => {
          const roots = explorer.getRootNodes().map((node) => node.path);
          const paths = roots.length
            ? roots
            : latestForLsp.current.workspacePath
              ? [latestForLsp.current.workspacePath]
              : [];
          return paths.map((path, index) => ({
            uri: fileUri(path),
            name: path.split("/").pop() || path,
            index,
          }));
        },
        availability: () =>
          isTauri()
            ? nativeAvailability()
            : Promise.resolve({ trusted: false, installed: new Set<string>() }),
        problems: { publish: publishProblems, clear: clearProblems },
        applyEdit: (edit, encoding) =>
          workspaceEditHost.current
            ? applyWorkspaceEdit(edit, workspaceEditHost.current, encoding)
            : Promise.resolve({ applied: false, failureReason: "Not ready" }),
        log: (server, text, level) =>
          lspOutput.appendLine(
            `[${server}] ${text}`,
            level === "error" ? "error" : level === "warning" ? "warn" : "info",
          ),
      });
      return manager;
    })(),
  ).current;
  lspRef.current = lsp;
  const lspRevision = useSyncExternalStore(lsp.subscribe, lsp.revision);
  /** The workspace in the window (`services/workspaces.ts`): what its services belong to. */
  const workspace = useWorkspace();
  // The workspace's terminals (TERMINAL-06): the commands read which exist and which has the
  // keyboard; both are the workspace's TerminalService's and TerminalUi's, never the window's.
  const terminalUi = workspace.services.terminalUi;
  const terminalView = useTerminalUiState(terminalUi);
  // A command that finished in a terminal may have changed the repository in ways the file
  // watcher does not report (Git's own files): Git's existing refresh is asked, once per
  // finished command -- never per output.
  useEffect(
    () => watchFinishedCommands(workspace.services.terminals, bumpGitRevision),
    [workspace],
  );
  // The editor's settings as they resolve in this workspace (IDE-03): word wrap and zoom
  // included, so there is one store for each, not window state beside a setting.
  const settingsWorkspace = workspace.folders.length ? workspace.id : null;
  const editorView = useEditorSettings(settings, settingsWorkspace, minimap);
  const { wordWrap, zoom } = editorView;
  /** A View-menu toggle writes where the value comes from: this workspace if it set one. */
  const changeSetting = <T,>(definition: SettingDefinition<T>, value: T) => {
    const scope =
      settingsWorkspace !== null &&
      definition.scopes.includes("workspace") &&
      settings.inspect(definition, settingsWorkspace).workspace !== undefined
        ? "workspace"
        : "user";
    settings.set(definition, scope, value, settingsWorkspace);
  };
  // Settings that could not be read (corrupt, invalid, from a newer Yavin) are said once.
  useEffect(() => {
    const show = () => {
      const problems = settings.takeProblems();
      if (problems.length) reportError(problems.join(" "));
    };
    show();
    return settings.onProblems(show);
  }, [reportError]);
  // --- Tasks (IDE-04): the window's commands on the workspace's TaskService -----------------------
  const tasks = workspace.services.tasks;
  const taskSnapshot = useSyncExternalStore(tasks.subscribe, tasks.getSnapshot, tasks.getSnapshot);
  /** Says why a task did not run; an untrusted folder offers the trust decision itself. */
  const reportTaskError = useCallback(
    (error: unknown) => {
      if (error instanceof TaskError && error.code === "TrustDenied") setTrustDialog("manage");
      reportError(error instanceof Error ? error.message : String(error));
    },
    [reportError],
  );
  const runTask = (taskId: string) => {
    void tasks.run(taskId).catch(reportTaskError);
  };
  /** A list to choose from, when there is more than one (never an arbitrary pick). */
  const chooseTask = (
    title: string,
    choices: readonly { id: string; label: string; detail: string }[],
    then: (id: string) => void,
  ) =>
    setDialog({
      title,
      options: choices.map((choice) => ({
        value: choice.id,
        label: choice.label,
        description: choice.detail,
      })),
      submit: (value) => then(value),
    });
  const runGroup = (group: "build" | "test") => {
    if (!taskSnapshot.workspace) {
      reportError("Open a folder to run its tasks.");
      return;
    }
    const { task, candidates } = tasks.defaultTask(group);
    if (task) runTask(task.id);
    else if (!candidates.length)
      reportError(
        `There is no ${group} task. Configure Tasks adds one ("group": "${group}", "isDefault": true).`,
      );
    else
      chooseTask(
        `Run ${group === "build" ? "Build" : "Test"} Task`,
        candidates.map((one) => ({ id: one.id, label: one.label, detail: one.command })),
        runTask,
      );
  };
  const activeRuns = taskSnapshot.runs.filter((run) => !isFinal(run.state) && run.parent === null);
  const showTaskTerminal = (run: TaskRun) => {
    if (!run.sessionId || !workspace.services.terminals.get(run.sessionId)) {
      reportError(`The terminal of "${run.label}" is no longer open.`);
      return;
    }
    revealTerminals();
    workspace.services.terminalUi.activate(run.sessionId);
  };
  const [settingsQuery, setSettingsQuery] = useState("");
  const configureTasks = () => {
    setSettingsQuery("Tasks");
    setSettingsOpen(true);
  };
  // A task that asks to be shown: the panel shows its terminal.
  const taskReveal = useRef(taskSnapshot.revealRequest);
  useEffect(() => {
    if (taskSnapshot.revealRequest === taskReveal.current) return;
    taskReveal.current = taskSnapshot.revealRequest;
    revealTerminals();
  }, [taskSnapshot.revealRequest, revealTerminals]);
  // --- Extensions (IDE-07): the registry's contributions, run by the workspace's host ------------
  const extensionHost = workspace.services.extensions;
  const extensionSnapshot = useSyncExternalStore(
    extensionRegistry.subscribe,
    extensionRegistry.getSnapshot,
    extensionRegistry.getSnapshot,
  );
  /** What an extension said (`window.show*Message`), shown until dismissed. */
  const [extensionNote, setExtensionNote] = useState<{ level: string; text: string } | null>(null);
  useEffect(
    () =>
      onExtensionMessage((message) => {
        const name =
          extensionRegistry.get(message.extensionId)?.manifest.displayName ?? message.extensionId;
        setExtensionNote({ level: message.level, text: `${name}: ${message.text}` });
      }),
    [],
  );
  /** Says why an extension's command did not run; an untrusted folder offers the trust decision. */
  const reportExtensionError = useCallback(
    (error: unknown) => {
      if (error instanceof ExtensionError && error.code === "TrustRequired")
        setTrustDialog("manage");
      reportError(error instanceof Error ? error.message : String(error));
    },
    [reportError],
  );
  const runExtensionCommand = (command: string) => {
    void extensionHost.executeCommand(command).catch(reportExtensionError);
  };
  // Installed extensions' manifests, read once (the desktop app only; nothing of theirs runs).
  useEffect(() => {
    if (isTauri()) void discoverInstalledOnce(extensionRegistry).catch(() => undefined);
  }, []);
  // Activation events: the window started (for this workspace), and its folder opened.
  useEffect(() => {
    void extensionHost.fire({ kind: "startup" });
    if (workspace.folders.length) void extensionHost.fire({ kind: "workspace" });
  }, [extensionHost, workspace]);
  // --- Debugging (IDE-05): the window's commands on the workspace's DebugService ------------------
  const debug = workspace.services.debug;
  const debugSnapshot = useSyncExternalStore(debug.subscribe, debug.getSnapshot, debug.getSnapshot);
  const debugControls = debug.controls();
  const workspaceBreakpoints = useMemo(
    () => (workspace.folders.length ? breakpoints.forWorkspace(workspace.id) : null),
    [workspace],
  );
  /** Says why debugging did not happen; an untrusted folder offers the trust decision. */
  const reportDebugError = useCallback(
    (error: unknown) => {
      if (error instanceof DebugError && error.code === "TrustDenied") setTrustDialog("manage");
      reportError(error instanceof Error ? error.message : String(error));
    },
    [reportError],
  );
  const configureDebugging = () => {
    setSettingsQuery("Debug");
    setSettingsOpen(true);
  };
  const showDebugView = () => {
    setActiveActivityTab("debug");
    setIsSidebarOpen(true);
  };
  const startDebugging = (configurationId?: string) => {
    if (!debugSnapshot.workspace) {
      reportError("Open a folder to debug its programs.");
      return;
    }
    const configs = debugSnapshot.configurations;
    if (!configs.length) {
      reportError("There is no debug configuration yet. Run › Configure Debugging adds one.");
      configureDebugging();
      return;
    }
    const go = (id: string) => {
      showDebugView();
      // The session's output and the console are in the panel.
      showTerminal(true);
      showPanelView("debug");
      void debug.start(id).catch(reportDebugError);
    };
    if (configurationId) go(configurationId);
    else if (configs.length === 1) go(configs[0].id);
    else
      chooseTask(
        "Start Debugging",
        configs.map((one) => ({
          id: one.id,
          label: one.name,
          detail: one.program ?? `attach to port ${one.port}`,
        })),
        go,
      );
  };
  const debugCommand = (
    command: "continue" | "pause" | "stepOver" | "stepInto" | "stepOut" | "restart" | "stop",
  ) => {
    void debug[command]().catch(reportDebugError);
  };
  const toggleBreakpointAt = (uri: ResourceUri, line: number) => {
    if (!workspaceBreakpoints) {
      reportError("Open a folder to set breakpoints.");
      return;
    }
    workspaceBreakpoints.toggle(uri, line);
  };
  const editorDebug = useMemo(
    () => ({
      breakpoints: workspaceBreakpoints,
      service: debug,
      onToggleBreakpoint: (uri: ResourceUri, line: number) =>
        toggleBreakpointAtRef.current(uri, line),
    }),
    [workspaceBreakpoints, debug],
  );
  const toggleBreakpointAtRef = useRef(toggleBreakpointAt);
  toggleBreakpointAtRef.current = toggleBreakpointAt;
  // The paused frame (or a frame chosen in the call stack) is shown in the editor, through the
  // editor's own navigation -- once per request.
  const debugFocus = useRef(debugSnapshot.focus?.nonce ?? 0);
  useEffect(() => {
    const focus = debugSnapshot.focus;
    if (!focus || focus.nonce === debugFocus.current) return;
    debugFocus.current = focus.nonce;
    openLocationRef.current(focus.path, {
      startLineNumber: focus.line,
      startColumn: focus.column,
      endLineNumber: focus.line,
      endColumn: focus.column,
    });
  }, [debugSnapshot.focus]);
  // What went wrong keeping the terminal's settings (TERMINAL-07) -- unreadable, written by a
  // newer Yavin, not saved -- is said once; the terminal works on with what could be read.
  useEffect(() => {
    const show = () => {
      const problems = terminalSettings.takeProblems();
      if (problems.length) reportError(problems.join(" "));
    };
    show();
    return terminalSettings.subscribe(show);
  }, [reportError]);
  /**
   * The symbols of the document in front, for the Outline and the breadcrumbs: asked of its
   * server when it comes to the front, and again a moment after each edit.
   */
  const outline = useRef(
    createOutlineStore({
      fetch: async (key, signal) => {
        const context = lsp.context(key);
        if (!context || !lsp.capabilities(key)?.documentSymbolProvider) return null;
        const result = await lsp.request<(DocumentSymbol | SymbolInformation)[]>(
          key,
          "textDocument/documentSymbol",
          { textDocument: { uri: context.uri } },
          signal,
        );
        return toOutline(result, documents.get(key)?.text ?? null, context.encoding);
      },
    }),
  ).current;
  useEffect(
    () =>
      documents.subscribe((event) => {
        if (event.type !== "changed" && event.type !== "reloaded") return;
        const key = documents.all().find((doc) => doc.id === event.id)?.key;
        if (key) outline.refresh(key);
      }),
    [documents, outline],
  );
  const revealSymbol = useCallback((range: EditorRange) => editorRef.current?.select(range), []);
  // Development builds only: the UI tests read the servers' state.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const hook = window as unknown as { __yavinLsp?: unknown };
    hook.__yavinLsp = lsp;
    return () => {
      delete hook.__yavinLsp;
    };
  }, [lsp]);
  // Development builds only: the UI tests read the workspace's lifecycle and switch timings.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const hook = window as unknown as { __yavinWorkspaces?: unknown };
    hook.__yavinWorkspaces = workspaces;
    return () => {
      delete hook.__yavinWorkspaces;
    };
  }, []);
  // Servers run only once the folder is trusted; a change of trust stops them all and starts
  // what applies now. Safe to run twice (React runs effects twice in development): `start` does
  // nothing once started, and only a real change reconsiders.
  const lspTrusted = useRef<boolean | null>(null);
  useEffect(() => {
    lsp.start();
    if (lspTrusted.current !== null && lspTrusted.current !== trust.trusted) void lsp.reconsider();
    lspTrusted.current = trust.trusted;
    if (!workspacePath) void lsp.stopAll();
  }, [lsp, workspacePath, trust.trusted]);
  // A folder opened, closed or added: servers that follow folders are told; only a removed
  // folder's servers stop.
  useEffect(
    () =>
      explorer.subscribe((event) => {
        if (event.type === "reset") void lsp.foldersChanged();
      }),
    [explorer, lsp],
  );
  // Leaving the window shuts the servers down (and the native side ends whatever is left).
  useEffect(() => {
    const leave = () => void lsp.dispose();
    window.addEventListener("pagehide", leave, { once: true });
    return () => window.removeEventListener("pagehide", leave);
  }, [lsp]);

  /** A place to go once its file is in front: set by navigation, taken by the effect below. */
  const [pendingLocation, setPendingLocation] = useState<{
    key: string;
    range?: EditorRange;
  } | null>(null);
  const openLocation = (path: string, range?: EditorRange) => {
    const key = documents.get(path)?.key ?? path;
    setPendingLocation({ key, range });
    void handleOpenFile(path).then(() => {
      // Opened: wait for the tab the document is actually keyed by (another spelling of the
      // path, once it loaded). Not opened (the failure is already reported): nothing waits.
      const opened = documents.get(path)?.key;
      setPendingLocation((pending) =>
        pending?.key !== key ? pending : opened ? { key: opened, range } : null,
      );
    });
  };
  useEffect(() => {
    if (!pendingLocation || activeTabId !== pendingLocation.key || diff) return;
    // The first document opened loads the editor itself; it reports its state once it shows it.
    if (!editorRef.current) return;
    if (pendingLocation.range) editorRef.current.select(pendingLocation.range);
    else editorRef.current.focus();
    setPendingLocation(null);
  }, [activeTabId, documentState, pendingLocation, diff, editorState]);

  /** A list of places to go (references, several definitions), as a picker. */
  const showLocations = (
    title: string,
    locations: { path: string; range: EditorRange; preview?: string }[],
  ) => {
    if (!locations.length) {
      reportError(`${title}: nothing found.`);
      return;
    }
    if (locations.length === 1) {
      openLocation(locations[0].path, locations[0].range);
      return;
    }
    setDialog({
      title: `${title} (${locations.length})`,
      options: locations.map((location, index) => ({
        value: String(index),
        label: `${location.path.split("/").pop()}:${location.range.startLineNumber}:${location.range.startColumn}`,
        description: location.preview ?? location.path,
      })),
      submit: (value) => {
        const chosen = locations[Number(value)];
        if (chosen) openLocation(chosen.path, chosen.range);
      },
    });
  };
  const languageFeaturesHost = useRef<LanguageFeaturesHost>({
    openLocation: (path, range) => openLocationRef.current(path, range),
    showLocations: (title, locations) => showLocationsRef.current(title, locations),
    applyWorkspaceEdit: (edit, encoding) =>
      workspaceEditHost.current
        ? applyWorkspaceEdit(edit, workspaceEditHost.current, encoding)
        : Promise.resolve({ applied: false, failureReason: "Not ready" }),
    report: (message) => reportError(message),
    openExternal: (url) => void native("open_external_url", { url }).catch(reportError),
  }).current;
  const openLocationRef = useRef(openLocation);
  openLocationRef.current = openLocation;
  const showLocationsRef = useRef(showLocations);
  showLocationsRef.current = showLocations;
  const languageFeatures = useMemo(
    () => ({ manager: lsp, host: languageFeaturesHost }),
    [lsp, languageFeaturesHost],
  );

  /** Symbols for the palette: `@` the file in front, `#` every server's workspace. */
  const paletteSymbols = useCallback(
    async (query: string, scope: SymbolScope, signal: AbortSignal): Promise<PaletteSymbol[]> => {
      const toRange = (
        index: LineIndex | null,
        range: {
          start: { line: number; character: number };
          end: { line: number; character: number };
        },
        encoding: "utf-16" | "utf-8" | "utf-32",
      ): EditorRange => {
        if (!index)
          return {
            startLineNumber: range.start.line + 1,
            startColumn: range.start.character + 1,
            endLineNumber: range.end.line + 1,
            endColumn: range.end.character + 1,
          };
        const start = index.positionAt(index.offsetAt(range.start, encoding));
        const end = index.positionAt(index.offsetAt(range.end, encoding));
        return {
          startLineNumber: start.line + 1,
          startColumn: start.character + 1,
          endLineNumber: end.line + 1,
          endColumn: end.character + 1,
        };
      };
      if (scope === "document") {
        const key = activeKeyRef.current;
        const context = key ? lsp.context(key) : null;
        if (!key || !context) throw new Error("No language server is ready for this file.");
        const result = await lsp.request<(DocumentSymbol | SymbolInformation)[]>(
          key,
          "textDocument/documentSymbol",
          { textDocument: { uri: context.uri } },
          signal,
        );
        return flattenSymbols(result ?? []).map((symbol) => ({
          name: symbol.name,
          detail: symbol.detail,
          open: () =>
            openLocation(
              key,
              symbol.range ? toRange(context.index, symbol.range, context.encoding) : undefined,
            ),
        }));
      }
      const answers = await lsp.requestAll<SymbolInformation[]>(
        "workspace/symbol",
        { query },
        signal,
      );
      return answers.flatMap((answer) =>
        flattenSymbols(answer.result ?? []).flatMap((symbol) =>
          symbol.path
            ? [
                {
                  name: symbol.name,
                  detail: `${symbol.detail} · ${symbol.path.split("/").pop()}`,
                  open: () =>
                    openLocation(
                      symbol.path!,
                      symbol.range ? toRange(null, symbol.range, answer.encoding) : undefined,
                    ),
                },
              ]
            : [],
        ),
      );
    },
    [lsp],
  );
  const activeKeyRef = useRef<string | null>(null);

  // Deletes one entry or a whole Explorer selection behind a single confirmation.
  const handleDelete = (entries: { path: string; isDir: boolean }[]) => {
    if (!entries.length) return;
    if (documents.anySaving()) {
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
      // The user agreed to lose their edits in the confirmation.
      submit: () => deleteEntries(entries),
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

  /** A tab's context menu. Read when it opens, so it reflects the tabs as they are then. */
  const tabMenu = (id: string): MenuItem[] => {
    const path = id === "welcome" ? undefined : documents.get(id)?.path;
    return [
      { label: "Close", shortcut: shortcutLabel("Mod+w"), onClick: () => closeTabs([id]) },
      {
        label: "Close Others",
        disabled: tabs.length <= 1,
        onClick: () => closeTabs(otherTabs(id)),
      },
      {
        label: "Close to the Right",
        disabled: !tabsRightOf(id).length,
        onClick: () => closeTabs(tabsRightOf(id)),
      },
      {
        label: "Close Saved",
        disabled: !savedTabs().length,
        onClick: () => closeTabs(savedTabs()),
      },
      { label: "Close All", onClick: closeAll },
      { divider: true },
      {
        label: "Copy Path",
        disabled: !path,
        onClick: () => path && navigator.clipboard.writeText(path),
      },
      {
        label: "Reveal in Explorer View",
        disabled: !path,
        onClick: () => {
          if (!path) return;
          setActiveActivityTab("explorer");
          setIsSidebarOpen(true);
          void explorerStore.reveal(path);
        },
      },
      ...(isTauri()
        ? [
            {
              label: "Reveal in File Explorer",
              disabled: !path,
              onClick: () => path && handleReveal(path),
            },
          ]
        : []),
    ];
  };

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const activeDocument: TextDocument | undefined =
    activeTab && activeTab.id !== "welcome" ? documents.get(activeTab.path) : undefined;
  // A file of a language coming to the front activates extensions waiting for it (IDE-07).
  const activeLanguage = activeDocument?.languageId;
  useEffect(() => {
    if (activeLanguage) void extensionHost.fire({ kind: "language", id: activeLanguage });
  }, [activeLanguage, extensionHost]);
  /** Revert File: the file as it is on disk, after asking when that loses unsaved changes. */
  const revertActive = () =>
    run(async () => {
      const doc = activeDocument;
      if (!doc) return;
      if (doc.dirty && !window.confirm("Discard unsaved changes and reload the file from disk?"))
        return;
      await documents.reload(doc.key, { discard: true });
    });
  /** Keep My Version: the other way out of a conflict; the next save replaces the disk's. */
  const keepMine = () =>
    run(async () => {
      if (activeDocument) await documents.keepLocal(activeDocument.key);
    });
  /** What the editor says about the document in front, from the document's own state. */
  const notice = ((): DocumentNotice | undefined => {
    const doc = activeDocument;
    if (!doc) return undefined;
    const status = documentStatus(doc);
    if (status === "conflicted")
      return {
        tone: "error",
        text: "This file changed on disk while it had unsaved changes. Nothing was overwritten; both versions are kept.",
        actions: [
          { label: "Revert File", run: () => void revertActive() },
          { label: "Keep My Version", run: () => void keepMine() },
        ],
      };
    if (status === "externallyChanged")
      return doc.external?.kind === "deleted"
        ? {
            tone: "warning",
            text: "This file was deleted on disk. Your text is kept here; saving recreates the file.",
          }
        : doc.external?.kind === "unreadable"
          ? {
              tone: "warning",
              text: `This file can no longer be read from disk (${doc.external.message}). Your text is kept here.`,
            }
          : {
              tone: "warning",
              text: "This file changed on disk.",
              actions: [{ label: "Revert File", run: () => void revertActive() }],
            };
    if (status === "saveFailed" && doc.save.kind === "failed")
      return {
        tone: "error",
        text: `The last save failed: ${doc.save.message} Your changes are kept.`,
      };
    if (status === "proposed")
      return {
        tone: "info",
        text: "Proposed content, not on disk. It is never saved over the file; accepting proposals is not available yet.",
      };
    if (status === "stale")
      return {
        tone: "warning",
        text: "Proposed content, and the file has changed since it was proposed.",
      };
    if (doc.readOnly && !editAnyway.has(doc.id))
      return {
        tone: "info",
        text: "This file is read-only on disk. Saving it here would fail; Save As keeps a copy.",
        actions: [
          {
            label: "Edit Anyway",
            run: () => setEditAnyway((previous) => new Set(previous).add(doc.id)),
          },
        ],
      };
    return undefined;
  })();
  /** Set for a Markdown document in front: how it is shown. */
  const markdownMode: MarkdownMode | undefined =
    activeDocument?.languageId === "markdown"
      ? (markdownModes.get(activeDocument.id) ?? "edit")
      : undefined;
  const showMarkdown = (mode: MarkdownMode) => {
    if (!activeDocument) return;
    const id = activeDocument.id;
    setMarkdownModes((previous) => new Map(previous).set(id, mode));
    // Back to the editor, the keyboard goes with it.
    if (mode !== "preview") requestAnimationFrame(() => editorRef.current?.focus());
  };
  /** An image in the workspace for a Markdown preview: its bytes, from the native side. */
  const loadImage = async (path: string): Promise<string> => {
    const bytes: unknown = await native("read_image_file", { path });
    // Raw bytes, or nothing is shown.
    if (!(bytes instanceof ArrayBuffer)) throw new Error("The image could not be read.");
    const type = IMAGE_TYPES[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? "image/png";
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(new Blob([bytes], { type }));
    });
  };
  /** "Open in Editor" on a code block: a new, untitled document holding the code. */
  const openCode = (code: string, languageId: string | undefined) => {
    const doc = documents.createUntitled({ text: code, languageId });
    setTabs((prev) => [...prev, { id: doc.key, path: doc.key, name: doc.name }]);
    setActiveTabId(doc.key);
  };
  /** A link followed in a Markdown preview: a workspace file opens, a web page goes to the browser. */
  const openMarkdownLink = (link: MarkdownLink) => {
    if (link.kind === "file") void handleOpenFile(link.path);
    else if (link.kind === "web") void run(() => native("open_external_url", { url: link.url }));
  };
  /** The editor refuses typing into a read-only file until the user chooses to edit it. */
  const editorReadOnly = !!activeDocument?.readOnly && !editAnyway.has(activeDocument.id);
  /** Encoding, line endings and language of the document in front, for the status bars. */
  const documentDetails = activeDocument
    ? [
        activeDocument.encoding === "utf8bom" ? "UTF-8 with BOM" : "UTF-8",
        activeDocument.lineEnding === "crlf" ? "CRLF" : "LF",
        languageLabel(activeDocument.languageId),
      ]
    : undefined;

  useEffect(() => {
    // The hit's file by identity: the tab is keyed by its document's key, which may be another
    // spelling of the path ripgrep reported (`documents.get` resolves any spelling).
    const doc = pendingHit ? documents.get(pendingHit.path) : undefined;
    if (!pendingHit || !doc || activeTabId !== doc.key || diff) return;
    const content = doc.text;
    if (content === undefined) return;
    // The first document opened loads the editor itself: until it is there, the hit waits.
    // Showing the document reports the editor's state, which runs this again.
    if (!editorRef.current) return;
    const start = hitOffset(content, pendingHit);
    if (start === null) reportError("This search result changed. Search again to locate it.");
    else editorRef.current.revealRange(start, start + pendingHit.end - pendingHit.start);
    setPendingHit(null);
  }, [activeTabId, documentState, documents, pendingHit, diff, reportError, editorState]);

  const applyReplacements = async (changes: Replacement[], saved = false) => {
    const applied: Replacement[] = [];
    const errors: string[] = [];
    const revision = workspaceRevision.current;
    for (const change of changes) {
      try {
        if (workspaceRevision.current !== revision)
          throw new Error("Workspace changed; remaining files skipped");
        const doc = documents.get(change.path);
        if (doc) {
          // An open file is changed in its document -- an undoable edit -- and, for `saved`,
          // saved from there, so the document's base and the disk never disagree.
          if (doc.save.kind === "saving") throw new Error("File is being saved");
          if (doc.text !== change.before) throw new Error("Editor changed; preview again");
          if (saved && doc.dirty)
            throw new Error("The editor has unsaved changes; save or revert it first");
          // The document's edit reaches its editor as one undoable step (the model bridge).
          documents.edit(doc.key, change.after);
          if (saved) await documents.save(doc.key);
        } else {
          await native("write_file_guarded", {
            path: change.path,
            expected: change.before,
            content: change.after,
          });
        }
        applied.push(change);
      } catch (error) {
        errors.push(`${change.path}: ${String(error)}`);
      }
    }
    bumpGitRevision();
    return { applied, errors };
  };

  /**
   * After a Git command that may have rewritten open files: each is checked against the disk.
   * One with no unsaved edits follows it; one with edits is put in conflict, never overwritten.
   */
  const reconcileWorkspace = async () => {
    await documents.revalidate();
    await refreshTree();
  };

  const handleHunkAction = async (action: "stage" | "unstage" | "discard", hunkIndex: number) => {
    if (!diff?.repoId || !diff.kind) return;
    const entry = currentGit()
      .getSnapshot()
      .repos.find((r) => r.repoId === diff.repoId);
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
        bumpGitRevision();
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
  activeKeyRef.current = hasEditor && activeTab ? activeTab.path : null;
  const activeKey = activeKeyRef.current;
  // The Outline and the symbol breadcrumbs follow the document in front.
  useEffect(() => outline.show(activeKey), [outline, activeKey]);
  useEffect(() => {
    if (activeKey) outline.refresh(activeKey);
  }, [outline, activeKey, lspRevision]);
  /** The language server of the file in front, as the status bar shows it. */
  const languageStatus = (() => {
    void lspRevision;
    const status = activeKeyRef.current ? lsp.statusFor(activeKeyRef.current) : null;
    if (!status || status.state === "stopped" || status.state === "stopping") return undefined;
    const described = describeStatus(status);
    return {
      ...described,
      onClick: () => {
        if (
          status.state === "failed" ||
          status.state === "crashed" ||
          status.state === "unavailable"
        )
          void lsp.restart(activeKeyRef.current ?? undefined);
        else {
          showTerminal(true);
          showPanelView("output", "language servers");
        }
      },
    };
  })();
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
  /**
   * The terminal that had the keyboard when the palette opened: opening the palette takes the
   * keyboard, and a command chosen there (Copy, Paste in the terminal) is about where the user
   * was, as in any editor.
   */
  const paletteTerminal = useRef<TerminalId | null>(null);
  const openPalette = (mode: "files" | "commands" | "symbols" | "workspaceSymbols") => {
    paletteTerminal.current = terminalUi.getSnapshot().keyboard;
    if (!quickOpen?.files.length) loadQuickOpen();
    setPaletteMode(mode);
    setIsCommandPaletteOpen(true);
  };
  /** An untitled document in a new tab: edited in memory, saved with Save As. */
  const newUntitled = (name?: string) => {
    const doc = documents.createUntitled({ name });
    setTabs((prev) => [...prev, { id: doc.key, path: doc.key, name: doc.name }]);
    setActiveTabId(doc.key);
  };
  const newFile = () => {
    if (!desktop) {
      // The browser preview has no disk, so a new file is an untitled document.
      newUntitled("Untitled.ts");
      return;
    }
    if (!workspacePath) {
      // Reachable from the welcome page, which is precisely the window with no folder in it.
      // The dialog would have asked for a path relative to a workspace that is not open, and
      // the save would have failed with "Open a workspace first" after the typing was done.
      handleOpenFolderDialog();
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
    if (documents.anySaving()) throw new Error("Wait for saves to finish before closing editors.");
    if (hasUnsavedChanges && !window.confirm("Discard all unsaved changes and close all editors?"))
      return;
    rememberClosed(tabs.flatMap((tab) => documents.get(tab.id)?.path ?? []));
    setTabs([WELCOME_TAB]);
    setActiveTabId("welcome");
    documents.reset();
    views.clear();
  };
  const edit = (action: EditorAction) => editorRef.current?.execute(action);
  const navigateTab = (direction: number) => {
    if (!tabs.length) return;
    const index = tabs.findIndex((tab) => tab.id === activeTabId);
    setActiveTabId(tabs[(index + direction + tabs.length) % tabs.length].id);
  };
  // --- The terminal as part of the IDE (TERMINAL-06) -----------------------------------------
  /** The terminal in front of the panel: what most terminal commands act on. */
  const frontTerminal = terminalUi.focusedId();
  /** The terminal with the keyboard (or that had it when the palette opened). */
  const keyboardTerminal = isCommandPaletteOpen ? paletteTerminal.current : terminalView.keyboard;
  /**
   * Shows `id`'s folder in the Explorer: the one its shell reported, when that is a local folder
   * of this workspace. Otherwise says why, and shows nothing -- a guess would be worse.
   */
  const revealTerminalFolder = (id: TerminalId) => {
    const session = terminalUi.service.get(id);
    if (!session) return;
    const folder = revealableFolder(session.shell, workspace.folders);
    if (!folder.ok) {
      reportError(folder.reason);
      return;
    }
    setActiveActivityTab("explorer");
    setIsSidebarOpen(true);
    void explorerStore.reveal(folder.path).then((shown) => {
      if (!shown) reportError(`${folder.path} could not be shown in the Explorer.`);
    });
  };
  /** The IDE's side of the terminals, for the panel and its views. */
  const terminalIde = {
    resolve: (link: Parameters<typeof resolvePathLink>[0], session: TerminalSessionView) =>
      resolvePathLink(link, {
        // A relative path is relative to where the shell is; a shell that never reported a
        // folder and was started in the workspace root is still there as far as anyone knows.
        base:
          terminalFolder(session) ??
          (session.shell.reported || session.profile?.cwd ? null : (workspace.folders[0] ?? null)),
        folders: workspace.folders,
        msys: session.shell.pathStyle === "msys",
      }),
    open: (target: unknown) => {
      const { path, line, column } = target as { path: string; line?: number; column?: number };
      const at = column ?? 1;
      openLocation(
        path,
        line
          ? { startLineNumber: line, startColumn: at, endLineNumber: line, endColumn: at }
          : undefined,
      );
    },
    skipShell: (event: KeyboardEvent) =>
      keyContext.current.commands.some(
        (command) =>
          command.skipShell && command.shortcut && matchesShortcut(event, command.shortcut),
      ),
    revealFolder: revealTerminalFolder,
  };

  const builtInCommands: AppCommand[] = [
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
        setReplaceRequest((v) => v + 1);
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
      id: "file.newText",
      menu: "File",
      label: "New Text File",
      shortcut: "Mod+Alt+n",
      run: () => newUntitled(),
    },
    {
      id: "file.save",
      menu: "File",
      label: "Save",
      shortcut: "Mod+s",
      // A file deleted on disk can be saved without edits: that recreates it.
      disabled:
        !desktop ||
        !activeDocument ||
        !(activeDocument.dirty || activeDocument.external?.kind === "deleted"),
      run: () => handleSaveFile(activeTabId),
    },
    {
      id: "file.saveAs",
      menu: "File",
      label: "Save As…",
      disabled: !desktop || !activeDocument || activeDocument.source.kind === "proposed",
      run: () => run(() => saveAs(activeTabId)),
    },
    {
      id: "file.saveAll",
      menu: "File",
      label: "Save All",
      shortcut: "Mod+Shift+s",
      disabled: !desktop || !hasUnsavedChanges,
      run: async () => {
        if (documents.anySaving()) throw new Error("A save is already in progress.");
        const dirtyTabs = tabs.filter((tab) => tab.dirty);
        // Files first, in tab order; then each untitled document asks where it goes.
        for (const tab of dirtyTabs)
          if (documents.get(tab.path)?.source.kind === "disk") await documents.save(tab.path);
        for (const tab of dirtyTabs)
          if (documents.get(tab.path)?.source.kind === "untitled") await saveAs(tab.path);
        // Every other write path (single save, hunk reconcile, every Explorer
        // op) already bumps this once its own writes settle; Save All omitted
        // it, leaving Git status to fall back entirely on the ~300ms watcher
        // latency instead of the immediate trigger every other path gets.
        if (dirtyTabs.length) bumpGitRevision();
      },
    },
    {
      // Takes the file as it is on disk -- after asking, when that loses unsaved changes.
      id: "file.revert",
      menu: "File",
      label: "Revert File",
      disabled: !desktop || activeDocument?.source.kind !== "disk",
      run: revertActive,
    },
    {
      // The other way out of a conflict: keep the editor's version, to replace the disk's on
      // the next save.
      id: "file.keepMine",
      menu: "File",
      label: "Keep My Version",
      disabled: !activeDocument || documentStatus(activeDocument) !== "conflicted",
      reason: "Only for a file that changed on disk while it had unsaved changes",
      run: keepMine,
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
      id: "file.closeOthers",
      menu: "File",
      label: "Close Other Editors",
      disabled: tabs.length <= 1,
      run: () => closeTabs(otherTabs(activeTabId)),
    },
    {
      id: "file.closeSaved",
      menu: "File",
      label: "Close Saved Editors",
      disabled: !savedTabs().length,
      run: () => closeTabs(savedTabs()),
    },
    {
      id: "file.closeAll",
      menu: "File",
      label: "Close All Editors",
      disabled: !hasEditor && tabs.length <= 1,
      run: closeAll,
    },
    {
      id: "file.reopenClosed",
      menu: "File",
      label: "Reopen Closed Editor",
      shortcut: "Mod+Shift+t",
      disabled: !closedFiles.current.length,
      reason: "No editor has been closed",
      run: reopenClosed,
    },
    {
      // Shown in Yavin's own Explorer, by its store: ancestors expanded and listed, selected.
      id: "view.revealInExplorer",
      menu: "View",
      label: "Reveal Active File in Explorer",
      disabled: !activeDocument?.path,
      reason: "Open a file first",
      run: () => {
        if (!activeDocument?.path) return;
        setActiveActivityTab("explorer");
        setIsSidebarOpen(true);
        void explorerStore.reveal(activeDocument.path);
      },
    },
    {
      id: "file.reveal",
      menu: "File",
      label: "Reveal in File Explorer",
      disabled: !desktop || !hasEditor,
      run: () => handleReveal(activeTabId),
    },
    {
      id: "file.settings",
      menu: "File",
      label: "Settings",
      shortcut: "Mod+,",
      run: () => setSettingsOpen(true),
    },
    {
      // The status bar only carries a trust entry point while restricted, so this is the way
      // back to the decision once a folder is trusted -- otherwise trust could never be revoked.
      id: "file.trust",
      menu: "File",
      label: "Manage Workspace Trust",
      disabled: !desktop,
      run: () => setTrustDialog("manage"),
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
      // With a Markdown preview in place of its editor, Find searches the preview.
      run: () => (markdownMode === "preview" ? previewRef.current?.find() : edit("find")),
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
    // Monaco's own line commands, which its keybindings already run in the editor; listed
    // here so the menus and the shortcut help show them.
    ...(
      [
        ["selection.copyLineUp", "Copy Line Up", "Shift+Alt+ArrowUp", "copyLineUp"],
        ["selection.copyLineDown", "Copy Line Down", "Shift+Alt+ArrowDown", "copyLineDown"],
        ["selection.moveLineUp", "Move Line Up", "Alt+ArrowUp", "moveLineUp"],
        ["selection.moveLineDown", "Move Line Down", "Alt+ArrowDown", "moveLineDown"],
        ["edit.deleteLine", "Delete Line", "Mod+Shift+k", "deleteLine"],
        ["edit.toggleComment", "Toggle Line Comment", "Mod+/", "toggleComment"],
        ["edit.indent", "Indent Line", "Mod+]", "indent"],
        ["edit.outdent", "Outdent Line", "Mod+[", "outdent"],
      ] as const
    ).map(([id, label, shortcut, action]) => ({
      id,
      menu: id.startsWith("edit.") ? "Edit" : "Selection",
      label,
      shortcut,
      disabled: !hasEditor,
      run: () => edit(action),
    })),
    {
      id: "view.commands",
      menu: "View",
      label: "Command Palette…",
      shortcut: "Mod+Shift+p",
      skipShell: true,
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
      skipShell: true,
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
      run: () => changeSetting(EDITOR_SETTINGS.wordWrap, !wordWrap),
    },
    {
      id: "view.markdownPreview",
      menu: "View",
      label: "Toggle Markdown Preview",
      shortcut: "Mod+Shift+v",
      disabled: !markdownMode,
      reason: "Open a Markdown file first",
      run: () => showMarkdown(markdownMode === "preview" ? "edit" : "preview"),
    },
    {
      id: "view.markdownPreviewSide",
      menu: "View",
      label: "Open Markdown Preview to the Side",
      disabled: !markdownMode,
      reason: "Open a Markdown file first",
      run: () => showMarkdown(markdownMode === "split" ? "edit" : "split"),
    },
    {
      // The way back to a minimap turned off from its own menu, as in VS Code.
      id: "view.minimap",
      menu: "View",
      label: "Minimap",
      checked: minimap.enabled,
      run: () => changeMinimap({ enabled: !minimap.enabled }),
    },
    {
      id: "view.zoomIn",
      menu: "View",
      label: "Zoom In",
      shortcut: "Mod+=",
      disabled: zoom >= 2,
      run: () => changeSetting(EDITOR_SETTINGS.zoom, Math.min(2, Math.round(zoom * 10 + 1) / 10)),
    },
    {
      id: "view.zoomOut",
      menu: "View",
      label: "Zoom Out",
      shortcut: "Mod+-",
      disabled: zoom <= 0.7,
      run: () => changeSetting(EDITOR_SETTINGS.zoom, Math.max(0.7, Math.round(zoom * 10 - 1) / 10)),
    },
    {
      id: "view.zoomReset",
      menu: "View",
      label: "Reset Zoom",
      shortcut: "Mod+0",
      run: () => changeSetting(EDITOR_SETTINGS.zoom, 1),
    },
    {
      id: "run.task",
      menu: "Run",
      label: "Run Task…",
      disabled: !taskSnapshot.workspace,
      reason: "Open a folder first",
      run: () => {
        if (!taskSnapshot.tasks.length) {
          reportError("There are no tasks yet. Run › Configure Tasks adds them.");
          return;
        }
        chooseTask(
          "Run Task",
          taskSnapshot.tasks.map((task) => ({
            id: task.id,
            label: task.label,
            detail: `${task.command}${task.scope === "workspace" ? " (workspace)" : ""}`,
          })),
          runTask,
        );
      },
    },
    {
      id: "run.build",
      menu: "Run",
      label: "Run Build Task",
      shortcut: "Mod+Shift+b",
      disabled: !taskSnapshot.workspace,
      reason: "Open a folder first",
      run: () => runGroup("build"),
    },
    {
      id: "run.test",
      menu: "Run",
      label: "Run Test Task",
      disabled: !taskSnapshot.workspace,
      reason: "Open a folder first",
      run: () => runGroup("test"),
    },
    {
      id: "run.showRunning",
      menu: "Run",
      label: "Show Running Tasks",
      run: () => {
        setActiveActivityTab("run");
        setIsSidebarOpen(true);
      },
    },
    {
      id: "run.stop",
      menu: "Run",
      label: "Stop Task",
      disabled: !activeRuns.length,
      reason: "No task is running",
      run: () => {
        if (activeRuns.length === 1) tasks.cancel(activeRuns[0].executionId);
        else
          chooseTask(
            "Stop Task",
            activeRuns.map((run) => ({ id: run.executionId, label: run.label, detail: run.state })),
            (id) => tasks.cancel(id),
          );
      },
    },
    {
      id: "run.configure",
      menu: "Run",
      label: "Configure Tasks",
      run: configureTasks,
    },
    // Debugging (IDE-05). F5 starts a session, or continues a paused one.
    {
      id: "debug.start",
      menu: "Run",
      label: "Start Debugging",
      shortcut: "F5",
      disabled: !(debugControls.start || debugControls.continue),
      reason: debugSnapshot.workspace ? "A debug session is running" : "Open a folder first",
      run: () => (debugControls.continue ? debugCommand("continue") : startDebugging()),
    },
    {
      id: "debug.stop",
      menu: "Run",
      label: "Stop Debugging",
      shortcut: "Shift+F5",
      disabled: !debugControls.stop,
      reason: "No debug session",
      run: () => debugCommand("stop"),
    },
    {
      id: "debug.restart",
      menu: "Run",
      label: "Restart Debugging",
      shortcut: "Mod+Shift+F5",
      disabled: !debugControls.restart,
      reason: debugSnapshot.session
        ? "This debug adapter cannot restart a session"
        : "No debug session",
      run: () => debugCommand("restart"),
    },
    {
      id: "debug.continue",
      menu: "Run",
      label: "Continue",
      disabled: !debugControls.continue,
      reason: "The program is not paused",
      run: () => debugCommand("continue"),
    },
    {
      id: "debug.pause",
      menu: "Run",
      label: "Pause",
      shortcut: "F6",
      disabled: !debugControls.pause,
      reason: "No program is running",
      run: () => debugCommand("pause"),
    },
    {
      id: "debug.stepOver",
      menu: "Run",
      label: "Step Over",
      shortcut: "F10",
      disabled: !debugControls.stepOver,
      reason: "The program is not paused",
      run: () => debugCommand("stepOver"),
    },
    {
      id: "debug.stepInto",
      menu: "Run",
      label: "Step Into",
      shortcut: "F11",
      disabled: !debugControls.stepInto,
      reason: "The program is not paused",
      run: () => debugCommand("stepInto"),
    },
    {
      id: "debug.stepOut",
      menu: "Run",
      label: "Step Out",
      shortcut: "Shift+F11",
      disabled: !debugControls.stepOut,
      reason: "The program is not paused",
      run: () => debugCommand("stepOut"),
    },
    {
      id: "debug.toggleBreakpoint",
      menu: "Run",
      label: "Toggle Breakpoint",
      shortcut: "F9",
      disabled: !workspaceBreakpoints || !activeTab?.path,
      reason: "Open a file of the workspace",
      run: () => {
        const uri = activeTab?.path ? documents.get(activeTab.path)?.uri : undefined;
        const line = cursorStatus.get()?.line;
        if (!uri || !line) {
          reportError("Put the cursor on a line of a file to toggle its breakpoint.");
          return;
        }
        toggleBreakpointAt(uri, line);
      },
    },
    {
      id: "debug.removeAllBreakpoints",
      menu: "Run",
      label: "Remove All Breakpoints",
      disabled: !workspaceBreakpoints,
      reason: "Open a folder first",
      run: () => workspaceBreakpoints?.clear(),
    },
    {
      id: "debug.configure",
      menu: "Run",
      label: "Configure Debugging",
      run: configureDebugging,
    },
    {
      id: "go.file",
      menu: "Go",
      label: "Go to File…",
      shortcut: "Mod+p",
      run: () => openPalette("files"),
    },
    // Language features: each needs a server that offers it for the file in front.
    ...(() => {
      void lspRevision;
      const key = hasEditor && activeTab ? activeTab.path : null;
      const capabilities = key ? lsp.capabilities(key) : null;
      const action = (
        id: string,
        menu: string,
        label: string,
        actionId: string,
        available: unknown,
        shortcut?: string,
      ): AppCommand => ({
        id,
        menu,
        label,
        shortcut,
        disabled: !available,
        reason: "No language server offers this for the file in front",
        run: () => editorRef.current?.runAction(actionId),
      });
      return [
        action(
          "lsp.definition",
          "Go",
          "Go to Definition",
          "editor.action.revealDefinition",
          capabilities?.definitionProvider,
          "F12",
        ),
        action(
          "lsp.declaration",
          "Go",
          "Go to Declaration",
          "editor.action.revealDeclaration",
          capabilities?.declarationProvider,
        ),
        action(
          "lsp.typeDefinition",
          "Go",
          "Go to Type Definition",
          "editor.action.goToTypeDefinition",
          capabilities?.typeDefinitionProvider,
        ),
        action(
          "lsp.implementation",
          "Go",
          "Go to Implementations",
          "editor.action.goToImplementation",
          capabilities?.implementationProvider,
        ),
        action(
          "lsp.references",
          "Go",
          "Find All References",
          "yavin.lsp.findReferences",
          capabilities?.referencesProvider,
          "Shift+F12",
        ),
        {
          id: "lsp.documentSymbol",
          menu: "Go",
          label: "Go to Symbol in Editor…",
          disabled: !capabilities?.documentSymbolProvider,
          reason: "No language server offers symbols for the file in front",
          run: () => openPalette("symbols"),
        },
        {
          id: "lsp.workspaceSymbol",
          menu: "Go",
          label: "Go to Symbol in Workspace…",
          shortcut: "Mod+t",
          disabled: !lsp
            .readyServers()
            .some((server) => server.capabilities.workspaceSymbolProvider),
          reason: "No language server offers workspace symbols",
          run: () => openPalette("workspaceSymbols"),
        },
        action(
          "lsp.nextProblem",
          "Go",
          "Next Problem",
          "editor.action.marker.next",
          hasEditor,
          "F8",
        ),
        action(
          "lsp.rename",
          "Edit",
          "Rename Symbol",
          "editor.action.rename",
          capabilities?.renameProvider,
          "F2",
        ),
        action(
          "lsp.format",
          "Edit",
          "Format Document",
          "editor.action.formatDocument",
          capabilities?.documentFormattingProvider,
          "Shift+Alt+f",
        ),
        action(
          "lsp.quickFix",
          "Edit",
          "Quick Fix…",
          "editor.action.quickFix",
          capabilities?.codeActionProvider,
          "Mod+.",
        ),
        action(
          "lsp.suggest",
          "Edit",
          "Trigger Suggest",
          "editor.action.triggerSuggest",
          capabilities?.completionProvider,
        ),
        {
          id: "lsp.restart",
          menu: "View",
          label: "Restart Language Servers",
          disabled: !desktop,
          reason: "Available in the desktop app",
          run: () => lsp.restart(),
        },
        {
          id: "lsp.output",
          menu: "View",
          label: "Show Language Server Output",
          run: () => {
            showTerminal(true);
            showPanelView("output", "language servers");
          },
        },
      ];
    })(),
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
      run: () => openTerminal(),
    },
    {
      // In the folder of the file in the editor; an untitled or proposed document has none,
      // so the workspace root.
      id: "terminal.openHere",
      menu: "Terminal",
      label: "Open Integrated Terminal Here",
      disabled: !hasEditor,
      reason: "Open a file first",
      run: () => {
        const cwd = editorTerminalCwd(activeDocument, workspace.folders[0] ?? null);
        if (cwd) openTerminalIn(cwd);
        else openTerminal();
      },
    },
    {
      id: "terminal.focus",
      menu: "Terminal",
      label: "Focus Terminal",
      run: () => {
        revealTerminals();
        if (!frontTerminal) workspaces.current().services.terminalUi.newTerminal();
        workspaces.current().services.terminalUi.requestFocus();
      },
    },
    {
      id: "terminal.split",
      menu: "Terminal",
      label: "Split Terminal",
      run: () => {
        revealTerminals();
        workspaces.current().services.terminalUi.toggleSplit();
      },
    },
    {
      id: "terminal.revealFolder",
      menu: "Terminal",
      label: "Reveal Current Folder in Explorer",
      disabled: !frontTerminal,
      reason: "No terminal is open",
      run: () => {
        if (frontTerminal) revealTerminalFolder(frontTerminal);
      },
    },
    {
      id: "terminal.clear",
      menu: "Terminal",
      label: "Clear Terminal",
      disabled: !isTerminalOpen || !frontTerminal,
      reason: "Show a terminal first",
      run: () => {
        if (frontTerminal) terminalUi.viewOf(frontTerminal)?.clear();
      },
    },
    {
      id: "terminal.find",
      menu: "Terminal",
      label: "Find in Terminal",
      shortcut: "Mod+Shift+f",
      scope: "terminal",
      disabled: !isTerminalOpen || !frontTerminal,
      reason: "Show a terminal first",
      run: () => {
        revealTerminals();
        terminalUi.openFind();
      },
    },
    {
      id: "terminal.copy",
      menu: "Terminal",
      label: "Copy Selection",
      shortcut: "Mod+Shift+c",
      scope: "terminal",
      disabled: !keyboardTerminal,
      reason: "Focus a terminal first",
      run: () => {
        if (keyboardTerminal) terminalUi.viewOf(keyboardTerminal)?.copySelection();
      },
    },
    {
      id: "terminal.paste",
      menu: "Terminal",
      label: "Paste into Terminal",
      shortcut: "Mod+Shift+v",
      scope: "terminal",
      disabled: !keyboardTerminal,
      reason: "Focus a terminal first",
      run: () => {
        if (keyboardTerminal) terminalUi.viewOf(keyboardTerminal)?.paste();
      },
    },
    {
      id: "terminal.selectAll",
      menu: "Terminal",
      label: "Select All in Terminal",
      disabled: !keyboardTerminal,
      reason: "Focus a terminal first",
      run: () => {
        if (keyboardTerminal) terminalUi.viewOf(keyboardTerminal)?.selectAll();
      },
    },
    {
      id: "terminal.rename",
      menu: "Terminal",
      label: "Rename Terminal…",
      disabled: !frontTerminal,
      reason: "No terminal is open",
      run: () => {
        const id = frontTerminal;
        if (!id) return;
        setDialog({
          title: "Rename terminal",
          input: terminalUi.service.get(id)?.title ?? "",
          submit: (value) => {
            if (!value.trim()) throw new Error("Enter a name.");
            terminalUi.rename(id, value);
          },
        });
      },
    },
    {
      id: "terminal.restart",
      menu: "Terminal",
      label: "Restart Terminal",
      disabled: !frontTerminal,
      reason: "No terminal is open",
      run: () => {
        if (frontTerminal) terminalUi.restart(frontTerminal);
      },
    },
    {
      // Ends the shell the way closing its window would, and forgets the terminal.
      id: "terminal.close",
      menu: "Terminal",
      label: "Close Terminal",
      disabled: !frontTerminal,
      reason: "No terminal is open",
      run: () => {
        if (frontTerminal) terminalUi.close(frontTerminal);
      },
    },
    {
      // Ends the shell and everything it started, now.
      id: "terminal.kill",
      menu: "Terminal",
      label: "Kill Terminal",
      disabled: !frontTerminal,
      reason: "No terminal is open",
      run: () => {
        if (frontTerminal) terminalUi.kill(frontTerminal);
      },
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
      // Unresolved recovery items are kept until the user says they have dealt with them.
      id: "help.dismissRecovery",
      menu: "Help",
      label: "Dismiss Recovery Items",
      disabled: !desktop,
      reason: "Available in the desktop app",
      run: () =>
        run(async () => {
          const { unresolved } = asRecoveryReport(await native("recovery_report"));
          await native("recovery_dismiss", { ids: unresolved.map((item) => item.id) });
          createOutputChannel("Recovery").appendLine(
            unresolved.length
              ? `Dismissed ${unresolved.length} recovery item${unresolved.length === 1 ? "" : "s"}.`
              : "There were no recovery items to dismiss.",
            "info",
          );
        }),
    },
    {
      // The welcome page holds the recent folders, so there has to be a way back to it once
      // its tab has been closed.
      id: "help.welcome",
      menu: "Help",
      label: "Welcome",
      run: () => void handleOpenFile("welcome"),
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
  // Extensions' commands (IDE-07), after Yavin's own: in the palette under their category, run
  // by the workspace's extension host (activating their extension first). A contributed
  // shortcut applies only if no command of Yavin's has it.
  const extensionKeys = resolveKeybindings(
    extensionSnapshot.commands,
    builtInCommands.flatMap((command) => (command.shortcut ? [command.shortcut] : [])),
  );
  const commands: AppCommand[] = [
    ...builtInCommands,
    ...extensionSnapshot.commands.map((command) => ({
      id: command.command,
      menu:
        command.category ??
        extensionRegistry.get(command.extensionId)?.manifest.displayName ??
        command.extensionId,
      label: command.title,
      shortcut: extensionKeys.shortcuts.get(command.command),
      palette: command.palette,
      run: () => runExtensionCommand(command.command),
    })),
  ];

  /**
   * The keyboard hints the welcome page shows, taken from the commands themselves so the
   * page cannot end up teaching a shortcut that has since changed.
   */
  const welcomeHints = ["file.folder", "file.new", "view.commands", "go.file"]
    .map((id) => commands.find((command) => command.id === id))
    .filter((command): command is AppCommand => !!command)
    .map((command) => ({
      label: command.label.replace(/[.…]+$/, ""),
      shortcut: command.shortcut ? shortcutLabel(command.shortcut) : undefined,
    }));

  /**
   * The keyboard handler reads the commands, the open dialog and the palette through a ref.
   *
   * All three change identity on most renders, so an effect that closed over them had to be
   * listed without a dependency array -- which removed and re-added a window listener on
   * every single render of the application, several times a second while Git polls.
   */
  const keyContext = useRef({ commands, dialog, isCommandPaletteOpen, run });
  keyContext.current = { commands, dialog, isCommandPaletteOpen, run };
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const { commands, dialog, isCommandPaletteOpen, run } = keyContext.current;
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        dialog ||
        isCommandPaletteOpen
      )
        return;
      const command = commands.find(
        (item) =>
          item.shortcut && item.scope !== "terminal" && matchesShortcut(event, item.shortcut),
      );
      if (!command) return;
      const target = event.target;
      // Monaco's input is neither a textarea nor contentEditable (it uses EditContext), but it
      // is a text control: its own clipboard handling copies a whole line when nothing is
      // selected, which the menu's commands do not.
      const inEditor = target instanceof Element && !!target.closest("[data-editor=monaco]");
      const textControl =
        inEditor ||
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
      // Editing keys belong to whatever has the keyboard. Outside the editor they never reach
      // into it: Ctrl+A in the Explorer does not select the editor's text, nor Ctrl+Z undo it.
      // (The menus still run these commands on the editor.)
      const editorCommand = nativeTextCommand || EDITOR_KEY_COMMANDS.includes(command.id);
      if (editorCommand && !inEditor) {
        // Without this, Ctrl+A would select the whole window's text.
        if (command.id === "selection.all" && !textControl) event.preventDefault();
        return;
      }
      event.preventDefault();
      if (!command.disabled)
        void run(async () => {
          await command.run();
        });
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <ErrorBoundary>
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-[#000000] text-zinc-100 font-sans antialiased">
        {!isTauri() && (
          <div role="status" className="bg-zinc-900 px-4 py-2 text-xs">
            Browser preview. Open the desktop app to work with local files.
          </div>
        )}
        {extensionNote && (
          <div
            role="status"
            aria-label="Extension message"
            className={`px-4 py-2 text-sm ${
              extensionNote.level === "error"
                ? "bg-red-950"
                : extensionNote.level === "warning"
                  ? "bg-amber-950"
                  : "bg-[#10213a]"
            }`}
          >
            {extensionNote.text}
            <button className="ml-4 underline" onClick={() => setExtensionNote(null)}>
              Dismiss
            </button>
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
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenAccounts={() => openPalette("commands")}
          />

          {/* Dynamic File Tree Explorer */}
          <SearchPanel
            key={`search:${workspacePath}`}
            workspace={workspacePath}
            buffers={readBuffers}
            visible={isSidebarOpen && activeActivityTab === "search"}
            focusRequest={searchFocus}
            replaceRequest={replaceRequest}
            onOpen={(hit) => {
              setPendingHit(hit);
              // Not opened (the failure is reported once): nothing is left waiting to jump.
              void handleOpenFile(hit.path).then(() => {
                if (!documents.get(hit.path))
                  setPendingHit((pending) => (pending === hit ? null : pending));
              });
            }}
            modified={(path) => documents.get(path)?.dirty ?? true}
            read={(path) => {
              const doc = documents.get(path);
              return doc ? Promise.resolve(doc.text) : native("read_file_content", { path });
            }}
            apply={applyReplacements}
          />
          <SourceControlPanel
            key={`git:${workspacePath}`}
            workspace={workspacePath}
            hasUnsavedEdits={hasUnsavedEdits}
            visible={isSidebarOpen && activeActivityTab === "git"}
            dirty={hasUnsavedChanges}
            onDiff={setDiff}
            onChanged={reconcileWorkspace}
            apply={(changes) => applyReplacements(changes, true)}
            onEntries={(entries) => {
              // Kept when it says the same thing: the explorer takes these as a prop, and a
              // rebuilt-but-identical map re-rendered the whole tree for nothing.
              const next = buildDecorations(entries, workspacePath);
              setDecorations((previous) => (sameDecorations(previous, next) ? previous : next));
            }}
            activeDiffPath={diff?.path}
            onShowOutput={() => {
              // The Output view in the bottom panel, with Git selected -- where VS Code
              // shows it, rather than a second, Git-only view of the same log.
              showTerminal(true);
              showPanelView("output", "git");
            }}
            onDialog={setDialog}
            onOpenFile={(path) => void handleOpenFile(path)}
            onReveal={handleReveal}
          />
          {/* LG-08: Local History, from the workspace's Local Git service. */}
          {/* IDE-04: the workspace's tasks and their executions. */}
          <RunPanel
            key={`run:${workspacePath}`}
            service={tasks}
            visible={isSidebarOpen && activeActivityTab === "run"}
            hasWorkspace={!!taskSnapshot.workspace}
            onRun={runTask}
            onRunGroup={runGroup}
            onStop={(id) => tasks.cancel(id)}
            onShowTerminal={showTaskTerminal}
            onConfigure={configureTasks}
          />
          {/* IDE-07: the extensions, their state here, and the views they contribute. */}
          <ExtensionsPanel
            key={`extensions:${workspacePath}`}
            registry={extensionRegistry}
            host={extensionHost}
            visible={isSidebarOpen && activeActivityTab === "extensions"}
            conflicts={extensionKeys.conflicts}
            onRunCommand={runExtensionCommand}
            onReload={() =>
              void rediscoverExtensions(extensionRegistry).catch((error: unknown) =>
                reportError(`Could not read the installed extensions: ${String(error)}`),
              )
            }
          />
          {/* IDE-05: the workspace's debug session and breakpoints. */}
          <DebugPanel
            key={`debug:${workspacePath}`}
            service={debug}
            breakpoints={workspaceBreakpoints}
            visible={isSidebarOpen && activeActivityTab === "debug"}
            hasWorkspace={!!debugSnapshot.workspace}
            onStart={startDebugging}
            onCommand={debugCommand}
            onConfigure={configureDebugging}
            onOpenBreakpoint={(path, line) =>
              openLocation(path, {
                startLineNumber: line,
                startColumn: 1,
                endLineNumber: line,
                endColumn: 1,
              })
            }
            onError={reportDebugError}
          />
          <LocalHistoryPanel
            key={`history:${workspacePath}`}
            service={workspace.services.localGit}
            visible={isSidebarOpen && activeActivityTab === "history"}
            onDiff={setDiff}
            onChanged={reconcileWorkspace}
          />
          <Sidebar
            key={`explorer:${workspacePath}`}
            visible={
              isSidebarOpen &&
              activeActivityTab !== "search" &&
              activeActivityTab !== "git" &&
              activeActivityTab !== "history" && // LG-08
              activeActivityTab !== "run" && // IDE-04
              activeActivityTab !== "debug" && // IDE-05
              activeActivityTab !== "extensions" // IDE-07
            }
            activeTab={activeActivityTab}
            workspacePath={workspacePath}
            // Only once the window has taken the folder: the provider's tree arrives through a
            // synchronous store update, a render before the workspace path does, and an
            // explorer shown it then -- keyed to no folder -- reported its own fresh state over
            // the session's before the real one mounted.
            roots={workspacePath ? explorerRoots : NO_ROOTS}
            decorations={decorations}
            provider={explorer}
            store={explorerStore}
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
            onOpenTerminal={(target) => {
              const cwd = terminalCwdFor(target);
              if (cwd) openTerminalIn(cwd);
              else reportError(`${target.path} cannot be opened in a terminal.`);
            }}
            initialScroll={explorerRef.current.scroll}
            onExplorerState={rememberExplorer}
            outline={
              <OutlineSection store={outline} cursor={cursorStatus} onReveal={revealSymbol} />
            }
          />

          {/* Center: Editor + Bottom Terminal Panel */}
          <div className="flex flex-1 flex-col min-w-0 bg-[#000000]">
            {settingsOpen ? (
              <SettingsView
                registry={settings}
                workspace={settingsWorkspace}
                workspaceName={workspacePath.split(/[\\/]/).filter(Boolean).pop()}
                terminal={{
                  settings: terminalSettings,
                  profiles: terminalProfiles.forWorkspace(workspace.id),
                }}
                initialQuery={settingsQuery}
                onClose={() => {
                  setSettingsOpen(false);
                  setSettingsQuery("");
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
                onSelectTab={(path) => handleOpenFile(path)}
                onCloseTab={handleCloseTab}
                onNewFile={newFile}
                onOpenCommandPalette={() => openPalette("commands")}
                onOpenFolderDialog={handleOpenFolderDialog}
                documents={documents}
                views={views}
                cursorStatus={cursorStatus}
                readOnly={editorReadOnly}
                minimap={minimap}
                onMinimapChange={changeMinimap}
                markdownMode={markdownMode}
                onMarkdownMode={showMarkdown}
                onOpenLink={openMarkdownLink}
                loadImage={loadImage}
                onOpenCode={openCode}
                previewRef={previewRef}
                languageFeatures={languageFeatures}
                symbolCrumbs={
                  <SymbolCrumbs
                    store={outline}
                    cursor={cursorStatus}
                    activeKey={activeKey}
                    onReveal={revealSymbol}
                  />
                }
                tabMenu={tabMenu}
                onMenuError={reportError}
                notice={notice}
                onSaveFile={handleSaveFile}
                recentFiles={recentFiles}
                workspacePath={workspacePath || null}
                recentFolders={session.folders}
                hints={welcomeHints}
                onOpenRecentFolder={handleOpenRecentFolder}
                onForgetRecentFolder={handleForgetRecentFolder}
                onCloneRepository={() =>
                  cloneRepository(setDialog, (root) => {
                    // From the welcome page there is no folder open, so the point of
                    // cloning is to work in what was cloned.
                    if (!workspacePath) void handleOpenRecentFolder(root);
                  })
                }
                details={documentDetails}
                editorRef={editorRef}
                onEditorState={setEditorState}
                wordWrap={wordWrap}
                zoom={zoom}
                editorSettings={editorView.settings}
                debug={editorDebug}
              />
            )}

            {wasTerminalOpened && (
              <Suspense fallback={null}>
                <TerminalPanel
                  // One panel per workspace: leaving a folder detaches its views (its shells
                  // keep running in its TerminalService, TERMINAL-03); coming back attaches again.
                  key={workspace.id}
                  hidden={!isTerminalOpen}
                  onClose={() => setIsTerminalOpen(false)}
                  isMaximized={isTerminalMaximized}
                  onToggleMaximize={() => setIsTerminalMaximized((prev) => !prev)}
                  request={panelRequest}
                  trusted={trust.trusted}
                  onManageTrust={() => setTrustDialog("manage")}
                  activeFile={activeTab?.path}
                  ide={terminalIde}
                  debugService={debug}
                  onOpenProblem={(file, line, column) =>
                    // The editor's own navigation: it waits for the file to be in front, then
                    // selects the exact line and column (the editor clamps a stale location).
                    openLocation(file, {
                      startLineNumber: line,
                      startColumn: column,
                      endLineNumber: line,
                      endColumn: column,
                    })
                  }
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
          details={documentDetails}
          onToggleTerminal={() => showTerminal((prev) => !prev)}
          restricted={!trust.trusted}
          onManageTrust={() => setTrustDialog("manage")}
          cursorStatus={cursorStatus}
          languageStatus={languageStatus}
          onGoToLine={() => {
            const goToLine = commands.find((command) => command.id === "go.line");
            if (goToLine && !goToLine.disabled) void run(async () => goToLine.run());
          }}
          onShowProblems={() => {
            showTerminal(true);
            showPanelView("problems");
          }}
        />

        {trustDialog && (
          <WorkspaceTrustDialog
            trust={trust}
            mode={trustDialog}
            onDecided={setTrust}
            onClose={() => setTrustDialog(null)}
          />
        )}
        {dialog && (
          <AppDialog
            key={dialogKey(dialog)}
            request={dialog}
            onClose={() => setDialog((current) => (current === dialog ? null : current))}
          />
        )}
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
          symbols={paletteSymbols}
        />
      </div>
    </ErrorBoundary>
  );
}
