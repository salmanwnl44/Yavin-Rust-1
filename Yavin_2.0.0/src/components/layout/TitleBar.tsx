import { MenuBar } from "./MenuBar";
import type { AppCommand } from "../../services/commands";
import { isTauri } from "@tauri-apps/api/core";
import { useState, useEffect } from "react";

export function TitleBar({
  onToggleSidebar,
  onToggleTerminal,
  onToggleAI,
  onOpenCommandPalette,
  isAIOpen,
  commands,
  onError,
}: {
  onToggleSidebar: () => void;
  onToggleTerminal: () => void;
  onToggleAI: () => void;
  onOpenCommandPalette: () => void;
  isAIOpen: boolean;
  commands: AppCommand[];
  onError: (error: unknown) => void;
}) {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const checkMaximized = async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const appWindow = getCurrentWindow();
        setIsMaximized(await appWindow.isMaximized());
        const stop = await appWindow.onResized(async () => {
          setIsMaximized(await appWindow.isMaximized());
        });
        if (disposed) stop();
        else unlisten = stop;
      } catch (e) {
        console.error("Window state unavailable", e);
      }
    };
    checkMaximized();
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, []);

  const handleMinimize = async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().minimize();
    } catch (e) {
      onError(e);
    }
  };

  const handleMaximize = async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().toggleMaximize();
      setIsMaximized((prev) => !prev);
    } catch (e) {
      onError(e);
    }
  };

  const handleClose = async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().close();
    } catch (e) {
      onError(e);
    }
  };

  return (
    <header className="flex min-h-9 flex-wrap w-full items-center justify-between border-b border-[#181818] bg-[#020202] px-2 select-none text-[12px] shrink-0 z-30 font-sans">
      {/* Left: Window Branding & Menu Items */}
      <div className="flex items-center gap-2.5" data-tauri-drag-region>
        {/* App Logo */}
        <div className="flex items-center gap-2 pl-1" data-tauri-drag-region>
          <div className="flex size-4.5 items-center justify-center rounded bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 shadow-[0_0_8px_rgba(99,102,241,0.6)] pointer-events-none">
            <span className="font-mono text-[9.5px] font-black text-white">Y</span>
          </div>
          <span className="font-bold text-white tracking-wider text-[11.5px] pointer-events-none">
            YAVIN
          </span>
          <span className="rounded bg-[#121212] border border-[#222] px-1.5 py-0.2 text-[9.5px] font-mono text-zinc-500 pointer-events-none">
            v2.0.0
          </span>
        </div>

        {/* Custom Application Menus */}
        <MenuBar commands={commands} onError={onError} />
      </div>

      {/* Center: Command Palette / Quick Search Bar */}
      <div className="flex-1 max-w-[440px] mx-2" data-tauri-drag-region>
        <button
          onClick={onOpenCommandPalette}
          className="flex h-6.5 w-full items-center justify-between rounded-md border border-[#1f1f1f] bg-[#090909] px-2.5 text-[11.5px] text-zinc-400 hover:border-[#383838] hover:text-zinc-200 hover:bg-[#121212] transition-all shadow-inner group"
        >
          <div className="flex items-center gap-2 min-w-0">
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="text-zinc-500 group-hover:text-zinc-300 shrink-0"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <span className="truncate text-zinc-400">Search workspace files...</span>
          </div>
          <kbd className="hidden sm:inline-flex items-center gap-0.5 rounded bg-[#161616] border border-[#262626] px-1.5 py-0.2 font-mono text-[9.5px] text-zinc-500 shrink-0">
            <span>Ctrl</span>
            <span>P</span>
          </kbd>
        </button>
      </div>

      {/* Right: Layout Actions & Custom Native Window Controls */}
      <div className="flex items-center gap-1.5" data-tauri-drag-region>
        {/* AI Assistant Pill Toggle */}
        <button
          onClick={onToggleAI}
          className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium border transition-all ${
            isAIOpen
              ? "border-indigo-500/60 bg-indigo-950/50 text-indigo-200 shadow-[0_0_12px_rgba(99,102,241,0.3)]"
              : "border-[#202020] bg-[#0c0c0c] text-zinc-300 hover:border-[#383838] hover:text-white"
          }`}
          title="Toggle Yavin AI Assistant"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className={isAIOpen ? "text-indigo-400" : "text-zinc-400"}
          >
            <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3L12 3z" />
          </svg>
          <span className="hidden sm:inline">AI Assistant</span>
        </button>

        {/* Layout Toggles */}
        <button
          onClick={onToggleSidebar}
          className="flex size-7 items-center justify-center rounded text-zinc-400 hover:bg-[#161616] hover:text-white transition-colors"
          title="Toggle Primary Sidebar (Ctrl+B)"
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <rect width="18" height="18" x="3" y="3" rx="2" />
            <path d="M9 3v18" />
          </svg>
        </button>

        <button
          onClick={onToggleTerminal}
          className="flex size-7 items-center justify-center rounded text-zinc-400 hover:bg-[#161616] hover:text-white transition-colors"
          title="Toggle Terminal Panel (Ctrl+`)"
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <rect width="18" height="18" x="3" y="3" rx="2" />
            <path d="M3 15h18" />
          </svg>
        </button>

        <div className="h-4 w-px bg-[#202020] mx-0.5" />

        {/* Custom Window Controls (Minimize, Maximize/Restore, Close) */}
        <div className="flex items-center -mr-1">
          <button
            onClick={handleMinimize}
            className="flex size-7.5 items-center justify-center text-zinc-400 hover:bg-[#1a1a1a] hover:text-white transition-colors"
            title="Minimize"
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <line x1="4" y1="12" x2="20" y2="12" />
            </svg>
          </button>

          <button
            onClick={handleMaximize}
            className="flex size-7.5 items-center justify-center text-zinc-400 hover:bg-[#1a1a1a] hover:text-white transition-colors"
            title={isMaximized ? "Restore" : "Maximize"}
          >
            {isMaximized ? (
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M4 14h6v6M20 10h-6V4" />
                <rect width="10" height="10" x="4" y="4" rx="1" />
              </svg>
            ) : (
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <rect width="16" height="16" x="4" y="4" rx="2" />
              </svg>
            )}
          </button>

          <button
            onClick={handleClose}
            className="flex size-7.5 items-center justify-center text-zinc-400 hover:bg-red-600 hover:text-white transition-colors"
            title="Close"
          >
            <svg
              width="11"
              height="11"
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
      </div>
    </header>
  );
}
