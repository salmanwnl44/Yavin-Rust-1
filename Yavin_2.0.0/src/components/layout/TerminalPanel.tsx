import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { native } from "../../services/native";
import { TerminalView } from "../terminal/TerminalView";
import type { TerminalHandle } from "../terminal/TerminalView";
import {
  createTerminalId,
  nextTerminalName,
  onTerminalRequest,
  zoomFontSize,
  DEFAULT_FONT_SIZE,
  type Shell,
  type TerminalKeyAction,
  type TerminalSession,
} from "../../services/terminal";
import { PANEL_VIEWS, readActiveView, saveActiveView, stepView } from "../../services/panel/views";
import type { PanelViewId } from "../../services/panel/views";
import { clampToViewport } from "../../services/panel/menuPosition";
import { ProblemsView } from "../panel/views/ProblemsView";
import { problemCounts, problemsVersion, subscribeProblems } from "../../services/panel/problems";
import { OutputView } from "../panel/views/OutputView";
import { DebugConsoleView } from "../panel/views/DebugConsoleView";
import { PortsView } from "../panel/views/PortsView";

const MIN_HEIGHT = 120;

const DEFAULT_HEIGHT = 260;

function Icon({ path, size = 12 }: { path: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}

const icons = {
  plus: "M12 5v14M5 12h14",
  split: "M3 3h18v18H3zM12 3v18",
  clear: "M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13",
  find: "M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4-4",
  close: "M18 6L6 18M6 6l12 12",
  chevron: "M6 9l6 6 6-6",
  up: "M18 15l-6-6-6 6",
  down: "M6 9l6 6 6-6",
  maximize: "M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7",
  restore: "M4 14h6v6M20 10h-6V4",
  terminal: "M4 17l6-5-6-5M12 19h8",
};

/** The panel's own toolbar buttons, kept uniform. */
function ToolButton({
  label,
  path,
  onClick,
  disabled,
  active,
}: {
  label: string;
  path: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`rounded p-1 transition-colors disabled:opacity-30 ${
        active ? "bg-indigo-950/60 text-indigo-300" : "hover:bg-[#151515] hover:text-zinc-200"
      }`}
    >
      <Icon path={path} />
    </button>
  );
}

export function TerminalPanel({
  hidden,
  onClose,
  isMaximized,
  onToggleMaximize,
  outputChannel,
  requestedView,
  activeFile,
  onOpenProblem,
}: {
  hidden: boolean;
  onClose: () => void;
  isMaximized: boolean;
  onToggleMaximize: () => void;
  /** Channel the Output view should show, when something asked for a specific one. */
  outputChannel?: string;
  /** A view something asked to see, e.g. the status bar's problem counts. */
  requestedView?: PanelViewId;
  /** The file in the editor, for the Problems view's "current file only" toggle. */
  activeFile?: string;
  /** Opens a file at a position, for clicking a problem. */
  onOpenProblem?: (file: string, line: number, column: number) => void;
}) {
  // Re-renders the tab strip as diagnostics change, so the badge stays accurate.
  useSyncExternalStore(subscribeProblems, problemsVersion, problemsVersion);
  const [activeTab, setActiveTabState] = useState<PanelViewId>(readActiveView);
  const setActiveTab = useCallback((id: PanelViewId) => {
    setActiveTabState(id);
    saveActiveView(id);
  }, []);
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeId, setActiveId] = useState("");
  const [splitId, setSplitId] = useState<string | null>(null);
  /** Which half of a split the user is working in; always "primary" when not split. */
  const [focusedPane, setFocusedPane] = useState<"primary" | "secondary">("primary");
  const [splitRatio, setSplitRatio] = useState(0.5);
  const [shells, setShells] = useState<Shell[]>([]);
  const [shellMenu, setShellMenu] = useState(false);
  const [status, setStatus] = useState("");
  const [find, setFind] = useState("");
  const [finding, setFinding] = useState(false);
  const [matches, setMatches] = useState({ index: -1, count: 0 });
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [missing, setMissing] = useState(false);
  const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState("");
  const [bells, setBells] = useState<Set<string>>(new Set());

  const handles = useRef(new Map<string, TerminalHandle | null>());
  const findInput = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLDivElement>(null);

  const create = useCallback(
    (shell: Shell | undefined, focus = true, extras: Partial<TerminalSession> = {}) => {
      const session: TerminalSession = {
        id: createTerminalId(),
        name: "",
        shell: shell?.path ?? "",
        ...extras,
      };
      setSessions((previous) => {
        session.name = nextTerminalName(
          previous.map((one) => one.name),
          shell?.name ?? "Terminal",
        );
        return [...previous, session];
      });
      if (focus) setActiveId(session.id);
      return session;
    },
    [],
  );

  // Detected shells decide what New Terminal can offer; the first one opens at once.
  useEffect(() => {
    let cancelled = false;
    void native("terminal_shells")
      .then((found) => {
        if (cancelled) return;
        setShells(found);
        setSessions((previous) => {
          if (previous.length) return previous;
          const first: TerminalSession = {
            id: createTerminalId(),
            name: found[0]?.name ?? "Terminal",
            shell: found[0]?.path ?? "",
          };
          setActiveId(first.id);
          return [first];
        });
      })
      .catch((error) => {
        if (cancelled) return;
        // The browser preview has no shell; the view explains that in place.
        setMissing(true);
        setStatus(String(error));
        setSessions((previous) => {
          if (previous.length) return previous;
          const first: TerminalSession = { id: createTerminalId(), name: "Terminal", shell: "" };
          setActiveId(first.id);
          return [first];
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The Terminal menu and the terminals themselves drive the panel through one
  // channel. The handlers are read from a ref so the subscription never has to be
  // torn down and rebuilt as sessions come and go.
  const actions = useRef({
    new: () => {},
    newIn: (_cwd: string) => {},
    split: () => {},
    clear: () => {},
    find: () => {},
    kill: () => {},
  });
  useEffect(
    () =>
      onTerminalRequest((request) => {
        // "Open in Integrated Terminal" carries the folder it wants; everything else is a
        // bare action name.
        if (typeof request === "object") actions.current.newIn(request.cwd);
        else actions.current[request]();
      }),
    [],
  );

  // "Show Git Output" and friends name a channel; showing it means showing the Output view.
  useEffect(() => {
    if (outputChannel) setActiveTab("output");
  }, [outputChannel, setActiveTab]);

  useEffect(() => {
    if (requestedView) setActiveTab(requestedView);
  }, [requestedView, setActiveTab]);

  // Closing anything that floats above the terminal when focus moves elsewhere.
  useEffect(() => {
    if (!menu && !shellMenu) return;
    const dismiss = () => {
      setMenu(null);
      setShellMenu(false);
    };
    window.addEventListener("mousedown", dismiss);
    window.addEventListener("keydown", dismiss);
    return () => {
      window.removeEventListener("mousedown", dismiss);
      window.removeEventListener("keydown", dismiss);
    };
  }, [menu, shellMenu]);

  const closeSession = (id: string) => {
    handles.current.delete(id);
    const remaining = sessions.filter((session) => session.id !== id);
    if (splitId === id) setSplitId(null);
    setSessions(remaining);
    // Closing the last terminal used to close the whole panel, which made sense when the
    // panel was only ever terminals. It now holds Problems, Output and Ports too, so closing
    // it would take away views that have nothing to do with the terminal that just exited.
    // The panel stays; the effect below starts a fresh terminal while the Terminal view is
    // the one on screen.
    if (remaining.length && id === activeId) setActiveId(remaining[remaining.length - 1].id);
  };

  /**
   * Opening the panel with no terminals starts one. Deliberately keyed on the panel becoming
   * visible rather than on the session count reaching zero: killing your last terminal should
   * leave the view empty with a way to start another, not immediately spawn the shell you
   * just asked to close. (The panel itself stays open either way -- it holds Problems, Output
   * and Ports too, and none of those should disappear because a terminal exited.)
   */
  const pendingAutoCreate = useRef(true);
  useEffect(() => {
    if (hidden) {
      pendingAutoCreate.current = true;
      return;
    }
    if (sessions.length) pendingAutoCreate.current = false;
    if (!pendingAutoCreate.current || missing || sessions.length || !shells.length) return;
    if (activeTab !== "terminal") return;
    pendingAutoCreate.current = false;
    create(shells[0]);
  }, [hidden, missing, sessions.length, shells, create, activeTab]);

  // A terminal that rang while it was not on screen is worth noticing.
  useEffect(() => {
    if (!bells.size) return;
    setBells((previous) => {
      const next = new Set(previous);
      next.delete(activeId);
      return next.size === previous.size ? previous : next;
    });
  }, [activeId, bells.size]);

  const toggleSplit = () => {
    setFocusedPane("primary");
    if (splitId) return setSplitId(null);
    const other = sessions.find((session) => session.id !== activeId);
    setSplitId(other ? other.id : create(shells[0], false).id);
  };

  /** The terminal the toolbar acts on: the focused half of a split, else the active one. */
  const focusedId = focusedPane === "secondary" && splitId ? splitId : activeId;
  const active = () => handles.current.get(focusedId) ?? null;
  const shown = splitId ? [activeId, splitId] : [activeId];

  /** Per-view tab counts. Only the terminal has something to count so far; Problems and
   * Ports fill these in as those views gain real data. */
  const counts = problemCounts();
  const badges: Record<PanelViewId, number> = {
    // Errors and warnings, matching VS Code's badge; informational entries are not counted.
    problems: counts.error + counts.warning,
    output: 0,
    debug: 0,
    terminal: sessions.length > 1 ? sessions.length : 0,
    ports: 0,
  };

  const openFind = () => {
    setActiveTab("terminal");
    setFinding(true);
    window.setTimeout(() => findInput.current?.select(), 0);
  };

  const runFind = (direction: "next" | "previous") => {
    active()?.search(find, direction, { caseSensitive, regex });
  };

  const zoom = (action: TerminalKeyAction) => setFontSize((size) => zoomFontSize(size, action));

  /**
   * Closes every terminal at once. Each session is unmounted, and `TerminalView`'s own
   * cleanup sends `terminal_close` for it, so no shell is left running.
   */
  const killAll = () => {
    handles.current.clear();
    setSplitId(null);
    setFocusedPane("primary");
    setSessions([]);
    setActiveId("");
  };

  /** Moves the focused terminal `delta` places through the tab order, wrapping. */
  const stepTerminal = (delta: 1 | -1) => {
    if (sessions.length < 2) return;
    const at = sessions.findIndex((session) => session.id === activeId);
    const next = sessions[((at === -1 ? 0 : at) + delta + sessions.length) % sessions.length];
    setActiveId(next.id);
    handles.current.get(next.id)?.focus();
  };

  /**
   * Moves between the two panes of a split. It cannot just reassign `activeId`: the panes
   * render in `[activeId, splitId]` order, so doing that would swap their positions on
   * screen. `focusedPane` says which of the two the user is working in, and the toolbar's
   * Clear/Find follow it -- before this they always acted on the left pane even while the
   * user was typing in the right one.
   */
  const stepPane = () => {
    if (!splitId) return;
    setFocusedPane((current) => {
      const next = current === "primary" ? "secondary" : "primary";
      handles.current.get(next === "primary" ? activeId : splitId)?.focus();
      return next;
    });
  };

  const shortcut = (action: TerminalKeyAction) => {
    if (action === "find") openFind();
    else if (action === "new") create(shells[0]);
    else if (action === "split") toggleSplit();
    else if (action === "next") stepTerminal(1);
    else if (action === "previous") stepTerminal(-1);
    else if (action === "pane-next" || action === "pane-previous") stepPane();
    else zoom(action);
  };

  actions.current = {
    new: () => {
      setActiveTab("terminal");
      create(shells[0]);
    },
    // "Open in Integrated Terminal": the same shell, started in the chosen folder.
    newIn: (cwd: string) => {
      setActiveTab("terminal");
      create(shells[0], true, { cwd });
    },
    split: toggleSplit,
    clear: () => active()?.clear(),
    find: openFind,
    kill: () => activeId && closeSession(activeId),
  };

  /** Drag the top edge of the panel, or the divider between split terminals. */
  const drag = (event: React.MouseEvent, mode: "panel" | "split") => {
    event.preventDefault();
    const startY = event.clientY;
    const startX = event.clientX;
    const startHeight = height;
    const width = body.current?.clientWidth ?? 1;
    const startRatio = splitRatio;
    const move = (moved: MouseEvent) => {
      if (mode === "panel") {
        const next = startHeight + (startY - moved.clientY);
        setHeight(Math.max(MIN_HEIGHT, Math.min(next, window.innerHeight - 160)));
      } else {
        const next = startRatio + (moved.clientX - startX) / width;
        setSplitRatio(Math.max(0.2, Math.min(next, 0.8)));
      }
    };
    const stop = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", stop);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
  };

  const menuItems = [
    { label: "Copy", run: () => active()?.copySelection(), enabled: !!active()?.hasSelection() },
    { label: "Paste", run: () => active()?.paste(), enabled: true },
    { label: "Select All", run: () => active()?.selectAll(), enabled: true },
    { label: "Clear", run: () => active()?.clear(), enabled: true },
    { label: "Find", run: openFind, enabled: true },
    { label: "Split Terminal", run: toggleSplit, enabled: !missing },
    {
      label: "Rename",
      run: () => setRenaming(activeId),
      enabled: true,
    },
    { label: "Kill Terminal", run: () => closeSession(focusedId), enabled: true },
    {
      label: "Kill All Terminals",
      run: killAll,
      enabled: sessions.length > 1,
    },
  ];

  return (
    <div
      hidden={hidden}
      style={{ height: isMaximized ? "85vh" : height }}
      className="flex shrink-0 flex-col border-t border-[#181818] bg-[#030303] text-[12px] select-none"
    >
      {/* Drag the top edge to resize */}
      <div
        role="separator"
        aria-label="Resize panel"
        onMouseDown={(event) => drag(event, "panel")}
        className="h-1 shrink-0 cursor-row-resize hover:bg-indigo-500/40"
      />

      {/* Panel tabs and actions */}
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-[#141414] bg-[#050505] px-3">
        <div
          role="tablist"
          aria-label="Panel views"
          className="flex items-center gap-4 text-[11px] font-medium"
        >
          {PANEL_VIEWS.map((tab) => (
            <button
              key={tab.id}
              role="tab"
              aria-selected={activeTab === tab.id}
              // Arrow keys move between views, as they must inside a tablist, and give the
              // next/previous-view commands somewhere to live.
              onKeyDown={(event) => {
                if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
                event.preventDefault();
                setActiveTab(stepView(activeTab, event.key === "ArrowRight" ? 1 : -1));
              }}
              onClick={() => setActiveTab(tab.id)}
              className={`relative flex items-center gap-1.5 pb-1 transition-colors ${
                activeTab === tab.id
                  ? "font-semibold text-white"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              <span>{tab.label}</span>
              {/* The count of what a view is holding, like VS Code's Problems badge. Views
                  with nothing to report show no badge at all rather than a zero. */}
              {badges[tab.id] > 0 && (
                <span
                  aria-label={`${badges[tab.id]} in ${tab.label}`}
                  className="rounded-full bg-indigo-600 px-1.5 text-[9.5px] leading-4 font-semibold text-white"
                >
                  {badges[tab.id]}
                </span>
              )}
              {activeTab === tab.id && (
                <span className="absolute right-0 bottom-0 left-0 h-[2px] rounded-full bg-indigo-500" />
              )}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1 text-zinc-500">
          {activeTab === "terminal" && (
            <>
              <ToolButton
                label="New Terminal"
                path={icons.plus}
                disabled={missing}
                onClick={() => create(shells[0])}
              />
              <div className="relative">
                <ToolButton
                  label="Choose a shell"
                  path={icons.chevron}
                  disabled={missing || shells.length < 2}
                  active={shellMenu}
                  onClick={() => setShellMenu((open) => !open)}
                />
                {shellMenu && (
                  <div
                    role="menu"
                    aria-label="Shells"
                    onMouseDown={(event) => event.stopPropagation()}
                    className="absolute right-0 bottom-full z-20 mb-1 min-w-[170px] rounded border border-[#222222] bg-[#0a0a0a] py-1 shadow-lg"
                  >
                    {shells.map((shell) => (
                      <button
                        key={shell.path}
                        role="menuitem"
                        title={shell.path}
                        onClick={() => {
                          setShellMenu(false);
                          create(shell);
                        }}
                        className="block w-full px-3 py-1 text-left text-[11px] text-zinc-300 hover:bg-[#161616] hover:text-white"
                      >
                        {shell.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <ToolButton
                label={splitId ? "Unsplit Terminal" : "Split Terminal"}
                path={icons.split}
                disabled={missing}
                active={!!splitId}
                onClick={toggleSplit}
              />
              <ToolButton
                label="Clear Terminal"
                path={icons.clear}
                disabled={missing}
                onClick={() => active()?.clear()}
              />
              <ToolButton
                label="Find in Terminal"
                path={icons.find}
                disabled={missing}
                active={finding}
                onClick={() => (finding ? setFinding(false) : openFind())}
              />
            </>
          )}
          <ToolButton
            label={isMaximized ? "Restore Panel" : "Maximize Panel"}
            path={isMaximized ? icons.restore : icons.maximize}
            onClick={onToggleMaximize}
          />
          <ToolButton label="Close Panel" path={icons.close} onClick={onClose} />
        </div>
      </div>

      {/* Terminal tabs */}
      {activeTab === "terminal" && sessions.length > 0 && (
        <div
          role="tablist"
          aria-label="Terminals"
          className="flex h-7 shrink-0 items-center gap-1 overflow-x-auto border-b border-[#141414] bg-[#040404] px-2"
        >
          {sessions.map((session) => (
            <div
              key={session.id}
              className={`group flex h-5 shrink-0 items-center gap-1.5 rounded px-2 text-[11px] transition-colors ${
                shown.includes(session.id)
                  ? "bg-[#161616] text-zinc-100"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              <Icon path={icons.terminal} size={10} />
              {renaming === session.id ? (
                <input
                  autoFocus
                  aria-label="Rename terminal"
                  defaultValue={session.name}
                  onBlur={(event) => {
                    const name = event.target.value.trim();
                    if (name)
                      setSessions((previous) =>
                        previous.map((one) => (one.id === session.id ? { ...one, name } : one)),
                      );
                    setRenaming("");
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                    if (event.key === "Escape") setRenaming("");
                  }}
                  className="w-24 rounded border border-indigo-500 bg-black px-1 text-[11px] text-zinc-100 outline-none"
                />
              ) : (
                <button
                  role="tab"
                  aria-selected={session.id === activeId}
                  onClick={() => setActiveId(session.id)}
                  onDoubleClick={() => setRenaming(session.id)}
                  className="max-w-[150px] truncate"
                >
                  {session.name}
                </button>
              )}
              {bells.has(session.id) && (
                <span title="This terminal rang" className="text-amber-400">
                  •
                </span>
              )}
              <button
                aria-label={`Close ${session.name}`}
                title={`Close ${session.name}`}
                onClick={() => closeSession(session.id)}
                className="text-zinc-600 opacity-0 group-hover:opacity-100 hover:text-zinc-200"
              >
                <Icon path={icons.close} size={9} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Find bar */}
      {activeTab === "terminal" && finding && (
        <div
          role="search"
          aria-label="Terminal search"
          className="flex h-8 shrink-0 items-center gap-1.5 border-b border-[#141414] bg-[#060606] px-3"
        >
          <input
            ref={findInput}
            aria-label="Find in terminal"
            placeholder="Find"
            value={find}
            onChange={(event) => {
              setFind(event.target.value);
              active()?.search(event.target.value, "next", { caseSensitive, regex });
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") runFind(event.shiftKey ? "previous" : "next");
              if (event.key === "Escape") {
                setFinding(false);
                active()?.endSearch();
                active()?.focus();
              }
            }}
            className="w-56 rounded border border-[#222222] bg-[#0a0a0a] px-2 py-0.5 text-[11px] text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none"
          />
          <button
            aria-label="Match case"
            title="Match case"
            aria-pressed={caseSensitive}
            onClick={() => {
              const next = !caseSensitive;
              setCaseSensitive(next);
              active()?.search(find, "next", { caseSensitive: next, regex });
            }}
            className={`rounded px-1.5 py-0.5 font-mono text-[11px] ${
              caseSensitive
                ? "bg-indigo-950/60 text-indigo-300"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            Aa
          </button>
          <button
            aria-label="Use regular expression"
            title="Use regular expression"
            aria-pressed={regex}
            onClick={() => {
              const next = !regex;
              setRegex(next);
              active()?.search(find, "next", { caseSensitive, regex: next });
            }}
            className={`rounded px-1.5 py-0.5 font-mono text-[11px] ${
              regex ? "bg-indigo-950/60 text-indigo-300" : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            .*
          </button>
          <span role="status" className="min-w-[80px] text-[11px] text-zinc-500">
            {!find ? "" : matches.count ? `${matches.index + 1} of ${matches.count}` : "No results"}
          </span>
          <button
            aria-label="Previous match"
            title="Previous match"
            onClick={() => runFind("previous")}
            className="rounded p-1 text-zinc-400 hover:bg-[#151515] hover:text-zinc-200"
          >
            <Icon path={icons.up} size={11} />
          </button>
          <button
            aria-label="Next match"
            title="Next match"
            onClick={() => runFind("next")}
            className="rounded p-1 text-zinc-400 hover:bg-[#151515] hover:text-zinc-200"
          >
            <Icon path={icons.down} size={11} />
          </button>
          <button
            aria-label="Close find"
            onClick={() => {
              setFinding(false);
              active()?.endSearch();
            }}
            className="ml-auto rounded p-1 text-zinc-500 hover:bg-[#151515] hover:text-zinc-200"
          >
            <Icon path={icons.close} size={10} />
          </button>
        </div>
      )}

      {/* Body */}
      <div ref={body} className="min-h-0 flex-1 bg-black">
        <div hidden={activeTab !== "terminal"} className="relative flex h-full min-h-0">
          {/* Every terminal closed. The panel stays (Problems, Output and Ports live here
              too), so this view needs its own way back rather than relying on the panel
              being torn down and rebuilt. */}
          {!sessions.length && !missing && (
            <section
              aria-label="No terminals"
              className="flex h-full flex-1 flex-col items-center justify-center gap-3"
            >
              <p className="text-[11.5px] text-zinc-500">No terminals are running.</p>
              <button
                onClick={() => create(shells[0])}
                disabled={!shells.length}
                className="rounded bg-indigo-600 px-3 py-1 text-[11px] font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
              >
                New Terminal
              </button>
            </section>
          )}
          {sessions.map((session) => {
            const position = shown.indexOf(session.id);
            return (
              <div
                key={session.id}
                hidden={position === -1}
                // Clicking or tabbing into a pane makes it the one the toolbar acts on,
                // so Clear and Find follow the pane the user is actually working in.
                onFocusCapture={() =>
                  position !== -1 && setFocusedPane(position === 0 ? "primary" : "secondary")
                }
                style={
                  splitId && position !== -1
                    ? { width: `${(position === 0 ? splitRatio : 1 - splitRatio) * 100}%` }
                    : undefined
                }
                className={`h-full min-h-0 min-w-0 ${splitId && position !== -1 ? "" : "flex-1"}`}
              >
                <TerminalView
                  ref={(handle) => {
                    handles.current.set(session.id, handle);
                  }}
                  session={session}
                  visible={!hidden && activeTab === "terminal" && position !== -1}
                  fontSize={fontSize}
                  onStatus={setStatus}
                  onBell={() =>
                    setBells((previous) =>
                      session.id === activeId ? previous : new Set(previous).add(session.id),
                    )
                  }
                  onShortcut={shortcut}
                  onContextMenu={(position) => {
                    setActiveId(session.id);
                    setMenu(position);
                  }}
                  onSearchResults={setMatches}
                />
              </div>
            );
          })}
          {splitId && (
            <div
              role="separator"
              aria-label="Resize split"
              onMouseDown={(event) => drag(event, "split")}
              style={{ left: `${splitRatio * 100}%` }}
              className="absolute top-0 bottom-0 -ml-[3px] w-[6px] cursor-col-resize bg-transparent hover:bg-indigo-500/40"
            />
          )}
        </div>
        {activeTab === "problems" && (
          <ProblemsView activeFile={activeFile} onOpen={onOpenProblem} />
        )}
        {activeTab === "output" && <OutputView initialChannel={outputChannel} />}
        {activeTab === "debug" && <DebugConsoleView />}
        {activeTab === "ports" && <PortsView />}
      </div>

      {menu && (
        <div
          role="menu"
          aria-label="Terminal actions"
          // Kept inside the window. The panel sits at the bottom of the screen, so a menu
          // placed at the pointer runs off the edge and its last items become unclickable --
          // which is exactly what happened when this menu gained one more entry.
          style={clampToViewport(menu, menuItems.length)}
          onMouseDown={(event) => event.stopPropagation()}
          className="fixed z-50 min-w-[160px] rounded border border-[#222222] bg-[#0a0a0a] py-1 shadow-xl"
        >
          {menuItems.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              disabled={!item.enabled}
              onClick={() => {
                setMenu(null);
                item.run();
              }}
              className="block w-full px-3 py-1 text-left text-[11px] text-zinc-300 hover:bg-[#161616] hover:text-white disabled:opacity-40 disabled:hover:bg-transparent"
            >
              {item.label}
            </button>
          ))}
        </div>
      )}

      {status && (
        <p
          role="status"
          aria-live="polite"
          className={`shrink-0 truncate border-t border-[#141414] bg-[#050505] px-3 py-1 text-[10.5px] ${
            status === "Running" ? "text-zinc-500" : "text-rose-300"
          }`}
        >
          {status}
        </p>
      )}
    </div>
  );
}
