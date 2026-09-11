import type { Ref } from "react";
import { TextEditor } from "./TextEditor";
import type { EditorHandle, EditorState } from "./TextEditor";
import type { TextHistory } from "../../services/editor";
import type { EditorTab, RecentFile } from "../../types";
import { FileIcon } from "../ui/FileIcons";

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
      <div className="flex h-9 items-center border-b border-[#151515] bg-[#050505] px-1 overflow-x-auto no-scrollbar gap-0.5 shrink-0">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;

          return (
            <div
              key={tab.id}
              onClick={() => onSelectTab(tab.id)}
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
        /* Welcome Screen */
        <div className="flex-1 overflow-y-auto p-8 flex flex-col items-center justify-center bg-[#000000]">
          <div className="w-full max-w-[720px] flex flex-col gap-8">
            <div className="flex flex-col items-center text-center gap-2.5">
              <div className="relative flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 via-purple-600 to-pink-500 p-0.5 shadow-[0_0_30px_rgba(99,102,241,0.35)]">
                <div className="flex size-full items-center justify-center rounded-[14px] bg-black">
                  <span className="font-mono text-2xl font-black text-white">Y</span>
                </div>
              </div>
              <h1 className="text-2xl font-bold tracking-tight text-white mt-1">Yavin IDE</h1>
              <p className="text-[13px] text-zinc-400 max-w-[420px]">
                Open a workspace to browse, edit, and save your files.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Start Card */}
              <div className="flex flex-col gap-2 rounded-xl border border-[#181818] bg-[#070707] p-4.5 hover:border-[#282828] transition-all">
                <div className="flex items-center gap-2 text-zinc-300 font-semibold text-[12px] uppercase tracking-wider mb-1">
                  <span className="text-indigo-400">✦</span> Start
                </div>
                <button
                  onClick={onNewFile}
                  className="flex items-center justify-between rounded-lg p-2 text-left hover:bg-[#121212] transition-colors group"
                >
                  <div className="flex items-center gap-2.5">
                    <FileIcon name="newfile.rs" className="size-4" />
                    <div>
                      <div className="text-[12.5px] font-medium text-zinc-200 group-hover:text-white">
                        New File
                      </div>
                      <div className="text-[11px] text-zinc-500">Create a file in workspace</div>
                    </div>
                  </div>
                  <kbd className="font-mono text-[10px] text-zinc-500">Ctrl+N</kbd>
                </button>
                <button
                  onClick={onOpenFolderDialog}
                  className="flex items-center justify-between rounded-lg p-2 text-left hover:bg-[#121212] transition-colors group"
                >
                  <div className="flex items-center gap-2.5">
                    <FileIcon name="folder" isDir={true} className="size-4" />
                    <div>
                      <div className="text-[12.5px] font-medium text-zinc-200 group-hover:text-white">
                        Open Workspace Folder
                      </div>
                      <div className="text-[11px] text-zinc-500">Open local project folder</div>
                    </div>
                  </div>
                  <kbd className="font-mono text-[10px] text-zinc-500">Ctrl+Shift+O</kbd>
                </button>
                <button
                  onClick={onOpenCommandPalette}
                  className="flex items-center justify-between rounded-lg p-2 text-left hover:bg-[#121212] transition-colors group"
                >
                  <div className="flex items-center gap-2.5">
                    <span className="text-indigo-400 group-hover:text-indigo-300">⚡</span>
                    <div>
                      <div className="text-[12.5px] font-medium text-indigo-300 group-hover:text-indigo-200">
                        Command Palette
                      </div>
                      <div className="text-[11px] text-zinc-500">Search files and commands</div>
                    </div>
                  </div>
                  <kbd className="font-mono text-[10px] text-indigo-400/80">Ctrl+Shift+P</kbd>
                </button>
              </div>

              {/* Recent Files */}
              <div className="flex flex-col gap-2 rounded-xl border border-[#181818] bg-[#070707] p-4.5 hover:border-[#282828] transition-all">
                <div className="flex items-center justify-between text-zinc-300 font-semibold text-[12px] uppercase tracking-wider mb-1">
                  <div className="flex items-center gap-2">
                    <span className="text-emerald-400">🕒</span> Quick Open
                  </div>
                  <span className="text-[10px] font-normal text-zinc-500 font-mono">Workspace</span>
                </div>
                {recentFiles && recentFiles.length > 0 ? (
                  recentFiles.slice(0, 4).map((item) => (
                    <button
                      key={item.path}
                      onClick={() => onSelectTab(item.path, item.name)}
                      className="flex items-center justify-between rounded-lg p-2 text-left hover:bg-[#121212] transition-colors group"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <FileIcon name={item.name} className="size-3.5" />
                        <span className="text-[12px] font-medium text-zinc-300 group-hover:text-white truncate">
                          {item.name}
                        </span>
                      </div>
                      <span className="font-mono text-[9.5px] text-zinc-600 shrink-0 truncate max-w-[120px]">
                        {item.path}
                      </span>
                    </button>
                  ))
                ) : (
                  <p className="text-zinc-500 text-xs p-2">
                    Open files from the explorer to see them here.
                  </p>
                )}
              </div>
            </div>

            {/* Architecture Status */}
            <div className="flex items-center justify-between rounded-xl border border-[#161616] bg-[#040404] px-4 py-3 text-[11.5px]">
              <div className="flex items-center gap-3">
                <div className="flex size-2 rounded-full bg-emerald-500 animate-pulse" />
                <span className="text-zinc-300 font-medium">Open a folder to start editing</span>
                <span className="text-zinc-600 font-mono text-[10px]"></span>
              </div>
              <span className="font-mono text-[10.5px] text-zinc-500">Save with Ctrl+S</span>
            </div>
          </div>
        </div>
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
