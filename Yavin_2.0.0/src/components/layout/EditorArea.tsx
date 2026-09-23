import type { Ref } from "react";
import { TextEditor } from "./TextEditor";
import type { EditorHandle, EditorState } from "./TextEditor";
import type { TextHistory } from "../../services/editor";
import type { EditorTab, RecentFile } from "../../types";
import { FileIcon } from "../ui/FileIcons";
import { WelcomePage } from "../welcome/WelcomePage";
import type { WelcomeHint } from "../welcome/WelcomePage";

export function EditorArea({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onNewFile,
  onOpenCommandPalette,
  onOpenFolderDialog,
  fileContents,
  onContentChange,
  onSaveFile,
  recentFiles,
  workspacePath,
  recentFolders,
  hints,
  onOpenRecentFolder,
  onForgetRecentFolder,
  onCloneRepository,
  editorRef,
  histories,
  onEditorState,
  wordWrap,
  zoom,
}: {
  tabs: EditorTab[];
  activeTabId: string;
  onSelectTab: (path: string, name?: string) => void;
  onCloseTab: (id: string) => void;
  onNewFile: () => void;
  onOpenCommandPalette: () => void;
  onOpenFolderDialog: () => void;
  fileContents: Record<string, string>;
  onContentChange: (path: string, text: string) => void;
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
  editorRef: Ref<EditorHandle>;
  histories: Map<string, TextHistory>;
  onEditorState: (state: EditorState) => void;
  wordWrap: boolean;
  zoom: number;
}) {
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const currentContent = activeTab ? (fileContents[activeTab.path] ?? "") : "";

  const getBreadcrumbs = () => {
    if (!activeTab || activeTab.id === "welcome") return "Yavin IDE › Welcome";
    return activeTab.path.replace(/\\/g, "/").replace(/\//g, " › ");
  };

  return (
    <div className="flex flex-1 flex-col min-w-0 bg-[#000000] select-none text-[12px] overflow-hidden font-sans">
      {/* Tab Bar */}
      <div
        role="tablist"
        aria-label="Open editors"
        className="flex h-9 items-center border-b border-[#151515] bg-[#050505] px-1 overflow-x-auto no-scrollbar gap-0.5 shrink-0"
      >
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;

          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              onClick={() => onSelectTab(tab.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelectTab(tab.id);
                }
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

              {/* Dirty indicator dot */}
              {tab.dirty ? (
                <span
                  title="Unsaved changes (Ctrl+S to save)"
                  className="size-2 rounded-full bg-amber-400 hover:bg-amber-300"
                />
              ) : null}

              {tabs.length > 1 && (
                <button
                  aria-label={`Close ${tab.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(tab.id);
                  }}
                  className="rounded p-0.5 text-zinc-500 opacity-0 group-hover:opacity-100 hover:bg-[#1a1a1a] hover:text-white transition-all ml-0.5"
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
              )}
            </div>
          );
        })}

        {/* Action icons */}
        <div className="ml-auto flex items-center gap-1 text-zinc-500 pr-2">
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
          <span className="text-zinc-300 truncate">{getBreadcrumbs()}</span>
        </div>
        <div className="flex items-center gap-3 shrink-0 text-zinc-500 font-mono text-[10px]">
          <span>UTF-8</span>
          <span>•</span>
          <span>{activeTab?.name?.split(".").pop()?.toUpperCase() || "TEXT"}</span>
        </div>
      </div>

      {/* Main Content Area */}
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
        <TextEditor
          key={activeTab.path}
          path={activeTab.path}
          name={activeTab.name}
          content={currentContent}
          onChange={(text) => onContentChange(activeTab.path, text)}
          editorRef={editorRef}
          histories={histories}
          onState={onEditorState}
          wordWrap={wordWrap}
          zoom={zoom}
        />
      )}
    </div>
  );
}
