import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import { isTauri } from "@tauri-apps/api/core";
import { native } from "../../services/native";
import {
  describeExit,
  onTerminalExit,
  onTerminalOutput,
  terminalKeyAction,
  usableSize,
  type TerminalKeyAction,
} from "../../services/terminal";

export interface SearchSettings {
  caseSensitive: boolean;
  regex: boolean;
}

export interface TerminalHandle {
  focus(): void;
  clear(): void;
  restart(): void;
  search(query: string, direction: "next" | "previous", settings: SearchSettings): void;
  endSearch(): void;
  copySelection(): void;
  paste(): void;
  selectAll(): void;
  hasSelection(): boolean;
}

/** How much output a terminal keeps. Beyond this the oldest lines are dropped. */
const SCROLLBACK = 5000;

/** Matches are tinted rather than inverted, so colored output stays readable. */
const DECORATIONS = {
  matchBackground: "#3f3f19",
  matchBorder: "#6b6b2c",
  matchOverviewRuler: "#eab308",
  activeMatchBackground: "#a16207",
  activeMatchBorder: "#facc15",
  activeMatchColorOverviewRuler: "#facc15",
};

export const TerminalView = forwardRef<
  TerminalHandle,
  {
    id: string;
    shell: string;
    visible: boolean;
    fontSize: number;
    onStatus: (message: string) => void;
    onBell: () => void;
    onShortcut: (action: TerminalKeyAction) => void;
    onContextMenu: (position: { x: number; y: number }) => void;
    onSearchResults: (results: { index: number; count: number }) => void;
  }
>(function TerminalView(
  { id, shell, visible, fontSize, onStatus, onBell, onShortcut, onContextMenu, onSearchResults },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<{ term: XTerm; fit: FitAddon; search: SearchAddon } | null>(null);
  /** True only while a shell is attached, so nothing is sent into the void. */
  const running = useRef(false);
  const [exited, setExited] = useState("");

  // Kept in refs so the effect below never re-runs and restarts the shell.
  const report = useRef({ onStatus, onBell, onShortcut, onContextMenu, onSearchResults });
  report.current = { onStatus, onBell, onShortcut, onContextMenu, onSearchResults };
  const start = useRef<(clear: boolean) => void>(() => {});

  useEffect(() => {
    const container = host.current;
    if (!container) return;

    const term = new XTerm({
      fontFamily: 'ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: SCROLLBACK,
      scrollOnUserInput: true,
      allowProposedApi: true,
      theme: {
        background: "#000000",
        foreground: "#d4d4d8",
        cursor: "#a5b4fc",
        cursorAccent: "#000000",
        selectionBackground: "#312e81",
      },
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.open(container);
    // The panel may still be laying out; measuring on the next frame avoids
    // starting the shell at a size that is about to change.
    const firstFit = requestAnimationFrame(() => fit.fit());
    view.current = { term, fit, search };

    const results = search.onDidChangeResults((found) =>
      report.current.onSearchResults({ index: found.resultIndex, count: found.resultCount }),
    );
    const bell = term.onBell(() => report.current.onBell());

    if (!isTauri()) {
      term.writeln("\x1b[38;5;244mOpen the desktop application to run a shell.\x1b[0m");
      return () => {
        cancelAnimationFrame(firstFit);
        results.dispose();
        bell.dispose();
        view.current = null;
        term.dispose();
      };
    }

    const open = (clear: boolean) => {
      if (clear) term.clear();
      setExited("");
      const size = usableSize(term.cols, term.rows);
      void native("terminal_open", { id, shell, ...size })
        .then(() => {
          running.current = true;
          report.current.onStatus("Running");
        })
        .catch((error) => {
          running.current = false;
          setExited(String(error));
          report.current.onStatus(String(error));
          term.writeln(`\x1b[38;5;203m${String(error)}\x1b[0m`);
        });
    };
    start.current = open;

    // Keystrokes go to the shell as bytes; the shell decides what they mean.
    const typed = term.onData((data) => {
      if (!running.current) return;
      void native("terminal_write", { id, data }).catch((error) =>
        report.current.onStatus(String(error)),
      );
    });
    const stopOutput = onTerminalOutput((output) => {
      if (output.id === id) term.write(output.data);
    });
    const stopExit = onTerminalExit((exit) => {
      if (exit.id !== id) return;
      running.current = false;
      const message = describeExit(exit.code);
      setExited(message);
      report.current.onStatus("");
      term.writeln(`\r\n\x1b[38;5;244m[${message}]\x1b[0m`);
    });

    open(false);

    // Keep the shell's idea of the window the same as what is drawn. Dragging the
    // panel fires continuously, so only the size it settles on is sent.
    let pending: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      if (!view.current || !container.clientHeight) return;
      fit.fit();
      if (!running.current) return;
      clearTimeout(pending);
      pending = setTimeout(() => {
        const next = usableSize(term.cols, term.rows);
        void native("terminal_resize", { id, ...next }).catch(() => undefined);
      }, 100);
    });
    observer.observe(container);

    return () => {
      cancelAnimationFrame(firstFit);
      clearTimeout(pending);
      running.current = false;
      observer.disconnect();
      results.dispose();
      bell.dispose();
      typed.dispose();
      stopOutput();
      stopExit();
      view.current = null;
      term.dispose();
      void native("terminal_close", { id }).catch(() => undefined);
    };
  }, [id, shell]);

  // Only a laid-out terminal can be measured, so it is fitted when it becomes visible.
  useEffect(() => {
    if (!visible || !view.current) return;
    view.current.fit.fit();
    view.current.term.focus();
    if (!running.current) return;
    const size = usableSize(view.current.term.cols, view.current.term.rows);
    void native("terminal_resize", { id, ...size }).catch(() => undefined);
  }, [visible, id]);

  useEffect(() => {
    const current = view.current;
    if (!current) return;
    current.term.options.fontSize = fontSize;
    current.fit.fit();
  }, [fontSize]);

  const copySelection = () => {
    const selection = view.current?.term.getSelection();
    if (!selection) return;
    void navigator.clipboard
      .writeText(selection)
      .catch(() => report.current.onStatus("The clipboard is not available."));
  };

  const paste = () => {
    void navigator.clipboard
      .readText()
      .then((text) => {
        if (text && running.current) return native("terminal_write", { id, data: text });
      })
      .catch(() => report.current.onStatus("The clipboard is not available."));
  };

  useImperativeHandle(ref, () => ({
    focus: () => view.current?.term.focus(),
    clear: () => view.current?.term.clear(),
    restart: () => start.current(true),
    search: (query, direction, settings) => {
      if (!view.current) return;
      const options = { ...settings, decorations: DECORATIONS };
      if (!query) {
        view.current.search.clearDecorations();
        return;
      }
      // The addon caches highlighting by term and options together, but its cache
      // update runs before it compares the new options against the cached ones, so
      // a changed case/regex setting on the same term would otherwise be silently
      // ignored. Clearing first forces a full recount.
      view.current.search.clearDecorations();
      if (direction === "next") view.current.search.findNext(query, options);
      else view.current.search.findPrevious(query, options);
    },
    endSearch: () => view.current?.search.clearDecorations(),
    copySelection,
    paste,
    selectAll: () => view.current?.term.selectAll(),
    hasSelection: () => !!view.current?.term.hasSelection(),
  }));

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col bg-black">
      <div
        ref={host}
        aria-label={`Terminal ${id}`}
        className="min-h-0 flex-1 overflow-hidden pt-1 pl-2"
        onKeyDown={(event) => {
          const action = terminalKeyAction(event.nativeEvent, !!view.current?.term.hasSelection());
          if (!action) return;
          event.preventDefault();
          event.stopPropagation();
          if (action === "copy") copySelection();
          else if (action === "paste") paste();
          else report.current.onShortcut(action);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          report.current.onContextMenu({ x: event.clientX, y: event.clientY });
        }}
      />
      {exited && (
        <div className="flex shrink-0 items-center gap-2 border-t border-[#181818] bg-[#080808] px-3 py-1">
          <span className="truncate text-[11px] text-zinc-400">{exited}</span>
          <button
            onClick={() => start.current(true)}
            className="rounded bg-[#1a1a1a] px-2 py-0.5 text-[11px] text-zinc-200 transition-colors hover:bg-[#252525]"
          >
            Restart
          </button>
        </div>
      )}
    </div>
  );
});
