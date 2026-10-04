import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps, ReactNode, Ref } from "react";
import type { EditorHandle, EditorState, LanguageFeatures } from "../../editor/editorTypes";
import type { DocumentService } from "../../services/documents";
import type { EditorViews } from "../../services/editorViews";
import type { CursorStatusStore } from "../../services/cursorStatus";
import type { MinimapPreferences } from "../../services/minimapPreferences";
import type { EditorSettings } from "../../editor/editorSettings";
import type { MarkdownLink } from "../../services/markdownLinks";
import type { MarkdownPreviewHandle } from "./MarkdownPreview";
import type { EditorTab, RecentFile } from "../../types";
import { FileIcon } from "../ui/FileIcons";
import { WelcomePage } from "../welcome/WelcomePage";
import { EditorBoundary } from "./EditorBoundary";
import { ContextMenu } from "../ui/ContextMenu";
import type { MenuItem } from "../ui/ContextMenu";
import type { WelcomeHint } from "../welcome/WelcomePage";

/**
 * The code editor (Monaco), loaded when an editor is first shown rather than with the window:
 * the engine is most of the application's code, and the welcome page does not need it.
 */
const loadCodeEditor = () => import("./CodeEditor");
/** The Markdown preview, with the editor's chunk: it colours code with the editor's theme. */
const MarkdownPreview = lazy(() => import("./MarkdownPreview"));

/** How a Markdown document is shown: its editor, its preview, or both side by side. */
export type MarkdownMode = "edit" | "preview" | "split";

/** A line above the editor about the document's state, with what can be done about it. */
export interface DocumentNotice {
  tone: "warning" | "error" | "info";
  text: string;
  actions?: { label: string; run: () => void }[];
}

/** What a tab's marker means, as its tooltip says it. */
function statusTitle(tab: EditorTab): string {
  switch (tab.status) {
    case "conflicted":
      return "Changed on disk while it had unsaved changes. Nothing was overwritten.";
    case "saveFailed":
      return "The last save failed. Unsaved changes (Ctrl+S to try again)";
    case "saving":
      return "Saving…";
    case "externallyChanged":
      return "Changed on disk: deleted, or no longer readable";
    case "neverSaved":
      return "Not saved yet (Ctrl+S to choose where)";
    case "proposed":
      return "Proposed content, not on disk";
    case "stale":
      return "Proposed content; the file changed since it was proposed";
    default:
      return "Unsaved changes (Ctrl+S to save)";
  }
}

export function EditorArea({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onNewFile,
  onOpenCommandPalette,
  onOpenFolderDialog,
  documents,
  views,
  notice,
  onSaveFile,
  recentFiles,
  workspacePath,
  recentFolders,
  hints,
  onOpenRecentFolder,
  onForgetRecentFolder,
  onCloneRepository,
  details,
  editorRef,
  onEditorState,
  wordWrap,
  zoom,
  cursorStatus,
  readOnly = false,
  minimap,
  editorSettings,
  debug,
  onMinimapChange,
  markdownMode,
  onMarkdownMode,
  onOpenLink,
  loadImage,
  onOpenCode,
  previewRef,
  languageFeatures,
  tabMenu,
  onMenuError,
  symbolCrumbs,
}: {
  tabs: EditorTab[];
  activeTabId: string;
  onSelectTab: (path: string, name?: string) => void;
  onCloseTab: (id: string) => void;
  onNewFile: () => void;
  onOpenCommandPalette: () => void;
  onOpenFolderDialog: () => void;
  /** The Document Model: the editor shows and edits its documents, and keeps no copy. */
  documents: DocumentService;
  /** The editor's own per-document state: undo history, selection, scroll. */
  views: EditorViews;
  /** What to say about the active document's state, if anything. */
  notice?: DocumentNotice;
  onSaveFile: (path: string) => void;
  recentFiles: RecentFile[];
  /** The open folder, or null in a window with none -- the welcome page says so. */
  workspacePath: string | null;
  /** Folders opened before, most recent first. */
  recentFolders: string[];
  /** Keyboard hints, taken from the real commands so they cannot drift. */
  hints: WelcomeHint[];
  onOpenRecentFolder: (folder: string) => void;
  onForgetRecentFolder: (folder: string) => void;
  onCloneRepository: () => void;
  /** The active document's encoding, line endings and language. */
  details?: string[];
  editorRef: Ref<EditorHandle>;
  onEditorState: (state: EditorState) => void;
  wordWrap: boolean;
  zoom: number;
  /** Where the editor tells the status bar about its cursor. */
  cursorStatus?: CursorStatusStore;
  /** The document in front cannot be typed into (a file read-only on disk). */
  readOnly?: boolean;
  minimap?: MinimapPreferences;
  /** The editor's settings as they resolve for the workspace (IDE-03). */
  editorSettings?: EditorSettings;
  /** The workspace's debugger: breakpoints and the paused line in the gutter (IDE-05). */
  debug?: ComponentProps<typeof import("./CodeEditor").default>["debug"];
  onMinimapChange?: (change: Partial<MinimapPreferences>) => void;
  /** Set for a Markdown document: how it is shown, and the buttons that change it. */
  markdownMode?: MarkdownMode;
  onMarkdownMode?: (mode: MarkdownMode) => void;
  /** A link followed in the preview. */
  onOpenLink?: (link: MarkdownLink) => void;
  /** An image in the workspace, for the preview, as a `data:` URL. */
  loadImage?: (path: string) => Promise<string>;
  /** "Open in Editor" on a code block in the preview. */
  onOpenCode?: (code: string, languageId: string | undefined) => void;
  previewRef?: Ref<MarkdownPreviewHandle>;
  /** Language servers, for the editor's language features. */
  languageFeatures?: LanguageFeatures;
  /** What a tab's context menu offers (close others, copy its path, ...). */
  tabMenu?: (id: string) => MenuItem[];
  onMenuError?: (error: unknown) => void;
  /** The symbols the cursor is in, after the file's path. */
  symbolCrumbs?: ReactNode;
}) {
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const strip = useRef<HTMLDivElement>(null);
  // The strip shows no scrollbar, so the tab in front is scrolled into view.
  useEffect(() => {
    document
      .getElementById(`tab-${activeTabId}`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTabId, tabs.length]);
  // A lazy component keeps a failed load for good, so each retry is a new one.
  const [attempt, setAttempt] = useState(0);
  const CodeEditor = useMemo(() => lazy(loadCodeEditor), [attempt]);

  const getBreadcrumbs = () => {
    if (!activeTab || activeTab.id === "welcome") return "Yavin IDE › Welcome";
    return activeTab.path.replace(/\\/g, "/").replace(/\//g, " › ");
  };

  return (
    <div className="flex flex-1 flex-col min-w-0 bg-[#000000] select-none text-[12px] overflow-hidden font-sans">
      {/* Tab Bar */}
      <div className="flex h-9 items-center border-b border-[#151515] bg-[#050505] pl-1 gap-0.5 shrink-0">
        {/* Only the tabs scroll; the actions to their right stay where they are. */}
        <div
          ref={strip}
          // A mouse wheel scrolls the tabs sideways, as the missing scrollbar would.
          onWheel={(event) => {
            if (strip.current && !event.deltaX) strip.current.scrollLeft += event.deltaY;
          }}
          className="flex h-full min-w-0 flex-1 overflow-x-auto no-scrollbar"
        >
          <div
            role="tablist"
            aria-label="Open editors"
            className="flex h-full items-center gap-0.5"
          >
            {tabs.map((tab) => {
              const isActive = tab.id === activeTabId;

              return (
                <div
                  key={tab.id}
                  role="tab"
                  id={`tab-${tab.id}`}
                  aria-controls="editor-panel"
                  aria-selected={isActive}
                  // One tab stop for the whole strip, with the arrows moving inside it: the
                  // pattern every tablist uses, and the reason a tab that is not selected is
                  // not separately tabbable.
                  tabIndex={isActive ? 0 : -1}
                  onClick={() => onSelectTab(tab.id)}
                  // The middle button closes a tab, as in a browser.
                  onAuxClick={(event) => {
                    if (event.button !== 1) return;
                    event.preventDefault();
                    onCloseTab(tab.id);
                  }}
                  onContextMenu={(event) => {
                    if (!tabMenu) return;
                    event.preventDefault();
                    setMenu({ x: event.clientX, y: event.clientY, id: tab.id });
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelectTab(tab.id);
                      return;
                    }
                    const step =
                      event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
                    if (!step && event.key !== "Home" && event.key !== "End") return;
                    event.preventDefault();
                    // The arrows move focus and Enter opens it -- the tabs pattern's manual
                    // activation. Selecting as focus moved would be the other half of the
                    // pattern, but opening a tab hands focus to its editor, which would end
                    // the walk along the strip after a single press.
                    const index = tabs.findIndex((one) => one.id === tab.id);
                    const next =
                      event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? tabs.length - 1
                          : (index + step + tabs.length) % tabs.length;
                    const target = tabs[next];
                    if (target) document.getElementById(`tab-${target.id}`)?.focus();
                  }}
                  className={`group relative flex h-full items-center gap-2 px-3 border-r border-[#141414] cursor-pointer transition-all ${
                    isActive
                      ? "bg-[#000000] text-zinc-100 font-medium"
                      : "bg-[#070707] text-zinc-400 hover:bg-[#0c0c0c] hover:text-zinc-200"
                  }`}
                >
                  {/* Active top line */}
                  {isActive && (
                    <span className="absolute top-0 left-0 right-0 h-[2px] bg-indigo-500 shadow-[0_0_8px_rgba(99,102,241,0.6)]" />
                  )}

                  {tab.id === "welcome" ? (
                    <span className="text-indigo-400 font-mono text-[11px]">✦</span>
                  ) : (
                    <FileIcon name={tab.name} className="size-3.5" />
                  )}

                  <span className="truncate max-w-[140px] text-[12px]">{tab.name}</span>

                  {/* The document's state: unsaved, saving, failed, or changed on disk. */}
                  {tab.dirty || tab.status === "externallyChanged" ? (
                    <span
                      title={statusTitle(tab)}
                      className={`size-2 rounded-full ${
                        tab.status === "conflicted" || tab.status === "saveFailed"
                          ? "bg-red-500"
                          : tab.status === "externallyChanged"
                            ? "bg-zinc-500"
                            : "bg-amber-400 hover:bg-amber-300"
                      }`}
                    />
                  ) : null}

                  {/* Every tab closes, the last one too: the window then shows Welcome. */}
                  <button
                    aria-label={`Close ${tab.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onCloseTab(tab.id);
                    }}
                    className={`rounded p-0.5 text-zinc-500 ${isActive ? "opacity-100" : "opacity-0"} group-hover:opacity-100 focus-visible:opacity-100 hover:bg-[#1a1a1a] hover:text-white transition-all ml-0.5`}
                  >
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                    >
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* Action icons */}
        <div className="flex shrink-0 items-center gap-1 text-zinc-500 pl-1 pr-2">
          {activeTab && activeTab.id !== "welcome" && activeTab.dirty && (
            <button
              onClick={() => onSaveFile(activeTab.path)}
              className="flex items-center gap-1 px-2 py-0.5 rounded bg-indigo-600/30 text-indigo-300 border border-indigo-500/40 hover:bg-indigo-600 hover:text-white text-[10.5px] font-mono transition-all mr-1"
              title="Save File (Ctrl+S)"
            >
              <span>Save</span>
              <kbd className="text-[9px] opacity-70">⌘S</kbd>
            </button>
          )}

          {markdownMode && onMarkdownMode && (
            // How a Markdown document is shown: its source, its preview, or both.
            <div
              role="group"
              aria-label="Markdown view"
              className="mr-1 flex items-center rounded border border-[#1f1f1f] p-px"
            >
              {(
                [
                  ["edit", "Edit", "Show the Markdown source"],
                  ["preview", "Preview", "Show the preview (Ctrl+Shift+V)"],
                  ["split", "Split", "Source and preview side by side"],
                ] as const
              ).map(([mode, label, title]) => (
                <button
                  key={mode}
                  onClick={() => onMarkdownMode(mode)}
                  aria-pressed={markdownMode === mode}
                  title={title}
                  className={`rounded-sm px-2 py-0.5 text-[11px] transition-colors ${
                    markdownMode === mode
                      ? "bg-[#1c1c36] text-indigo-200"
                      : "text-zinc-500 hover:text-zinc-200"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          <button
            onClick={onNewFile}
            className="p-1 rounded hover:bg-[#151515] hover:text-zinc-200 transition-colors"
            title="New File (Ctrl+N)"
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
          <button
            className="p-1 rounded hover:bg-[#151515] hover:text-zinc-200 transition-colors"
            title="Split editor is not implemented"
            disabled
            aria-disabled="true"
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="12" y1="3" x2="12" y2="21" />
            </svg>
          </button>
        </div>
      </div>

      {/* Breadcrumbs Bar */}
      <div className="flex h-6.5 items-center justify-between border-b border-[#121212] bg-[#020202] px-3 text-[11px] text-zinc-500 shrink-0">
        <div className="flex items-center gap-1 overflow-hidden truncate">
          {activeTab && activeTab.id !== "welcome" && (
            <FileIcon name={activeTab.name} className="size-3.5 mr-0.5" />
          )}
          <span className="text-zinc-300 truncate shrink">{getBreadcrumbs()}</span>
          {activeTab && activeTab.id !== "welcome" && symbolCrumbs}
        </div>
        <div className="flex items-center gap-3 shrink-0 text-zinc-500 font-mono text-[10px]">
          {details?.join(" • ")}
        </div>
      </div>

      {/* Main Content Area: the panel the tabs above control. */}
      <div
        id="editor-panel"
        role="tabpanel"
        aria-labelledby={activeTab ? `tab-${activeTab.id}` : undefined}
        className="flex min-h-0 flex-1 flex-col"
      >
        {!activeTab || activeTab.id === "welcome" ? (
          <WelcomePage
            workspace={workspacePath}
            recentFolders={recentFolders}
            recentFiles={recentFiles}
            hints={hints}
            onOpenFolder={onOpenFolderDialog}
            onOpenRecentFolder={onOpenRecentFolder}
            onForgetRecentFolder={onForgetRecentFolder}
            onCloneRepository={onCloneRepository}
            onNewFile={onNewFile}
            onOpenCommandPalette={onOpenCommandPalette}
            onOpenFile={(path, name) => onSelectTab(path, name)}
          />
        ) : (
          <>
            {notice && (
              <div
                role="note"
                aria-label="Document state"
                className={`flex flex-wrap items-center gap-3 border-b border-zinc-800 bg-zinc-950 px-3 py-1.5 text-xs ${
                  notice.tone === "error"
                    ? "text-red-300"
                    : notice.tone === "warning"
                      ? "text-amber-300"
                      : "text-zinc-300"
                }`}
              >
                <span className="min-w-0 flex-1">{notice.text}</span>
                {notice.actions?.map((action) => (
                  <button
                    key={action.label}
                    onClick={action.run}
                    className="rounded border border-zinc-700 px-2 py-0.5 text-zinc-200 hover:bg-zinc-800"
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            )}
            <EditorBoundary onRetry={() => setAttempt((n) => n + 1)}>
              <Suspense
                fallback={<div className="flex-1 p-3 text-xs text-zinc-500">Loading editor…</div>}
              >
                {/* One editor for every tab: it swaps documents rather than remounting. A
                    Markdown preview replaces it (kept, hidden: its view state and undo stay)
                    or sits beside it. */}
                <div
                  className={`flex min-h-0 flex-1 ${markdownMode === "split" ? "flex-row" : "flex-col"}`}
                >
                  <div
                    className={
                      markdownMode === "preview"
                        ? "hidden"
                        : `flex min-h-0 min-w-0 flex-1 flex-col ${markdownMode === "split" ? "border-r border-[#1f1f1f]" : ""}`
                    }
                  >
                    <CodeEditor
                      documentKey={activeTab.path}
                      documents={documents}
                      views={views}
                      editorRef={editorRef}
                      onState={onEditorState}
                      wordWrap={wordWrap}
                      zoom={zoom}
                      cursorStatus={cursorStatus}
                      readOnly={readOnly}
                      onCommandPalette={onOpenCommandPalette}
                      minimap={minimap}
                      editorSettings={editorSettings}
                      debug={debug}
                      onMinimapChange={onMinimapChange}
                      languageFeatures={languageFeatures}
                    />
                  </div>
                  {markdownMode && markdownMode !== "edit" && (
                    <Suspense
                      fallback={
                        <div className="flex-1 p-3 text-xs text-zinc-500">Loading preview…</div>
                      }
                    >
                      <MarkdownPreview
                        documents={documents}
                        documentKey={activeTab.path}
                        onOpenLink={(link) => onOpenLink?.(link)}
                        loadImage={(path) =>
                          loadImage ? loadImage(path) : Promise.reject(new Error("No images here."))
                        }
                        onOpenCode={(code, languageId) => onOpenCode?.(code, languageId)}
                        previewRef={previewRef}
                      />
                    </Suspense>
                  )}
                </div>
              </Suspense>
            </EditorBoundary>
          </>
        )}
      </div>
      {menu && tabMenu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label="Tab actions"
          items={tabMenu(menu.id)}
          onClose={() => setMenu(null)}
          onError={onMenuError}
        />
      )}
    </div>
  );
}
