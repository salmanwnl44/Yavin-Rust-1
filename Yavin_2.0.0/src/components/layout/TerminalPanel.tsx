import { useCallback, useEffect, useRef, useState } from "react";
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

const PANEL_TABS = [
  { id: "terminal", label: "TERMINAL" },
  { id: "problems", label: "PROBLEMS" },
  { id: "output", label: "OUTPUT" },
  { id: "debug", label: "DEBUG CONSOLE" },
  { id: "ai", label: "AI LOGS" },
];

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
}: {
  hidden: boolean;
  onClose: () => void;
  isMaximized: boolean;
  onToggleMaximize: () => void;
}) {
  const [activeTab, setActiveTab] = useState("terminal");
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeId, setActiveId] = useState("");
  const [splitId, setSplitId] = useState<string | null>(null);
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

  const create = useCallback((shell: Shell | undefined, focus = true) => {
    const session: TerminalSession = {
      id: createTerminalId(),
      name: "",
      shell: shell?.path ?? "",
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
  }, []);

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
    split: () => {},
    clear: () => {},
    find: () => {},
    kill: () => {},
  });
  useEffect(() => onTerminalRequest((request) => actions.current[request]()), []);

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
    // The panel exists to show terminals; with none left there is nothing to show.
    if (!remaining.length) onClose();
    else if (id === activeId) setActiveId(remaining[remaining.length - 1].id);
  };

  // Showing the panel again after every terminal was closed starts a fresh one.
  useEffect(() => {
    if (hidden || missing || sessions.length || !shells.length) return;
    create(shells[0]);
  }, [hidden, missing, sessions.length, shells, create]);

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
    if (splitId) return setSplitId(null);
    const other = sessions.find((session) => session.id !== activeId);
    setSplitId(other ? other.id : create(shells[0], false).id);
  };

  const active = () => handles.current.get(activeId) ?? null;
  const shown = splitId ? [activeId, splitId] : [activeId];

  const openFind = () => {
    setActiveTab("terminal");
    setFinding(true);
    window.setTimeout(() => findInput.current?.select(), 0);
  };

  const runFind = (direction: "next" | "previous") => {
    active()?.search(find, direction, { caseSensitive, regex });
  };

  const zoom = (action: TerminalKeyAction) => setFontSize((size) => zoomFontSize(size, action));

  const shortcut = (action: TerminalKeyAction) => {
    if (action === "find") openFind();
    else if (action === "new") create(shells[0]);
    else if (action === "split") toggleSplit();
    else zoom(action);
  };

  actions.current = {
    new: () => {
      setActiveTab("terminal");
      create(shells[0]);
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
    { label: "Kill Terminal", run: () => closeSession(activeId), enabled: true },
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
        <div className="flex items-center gap-4 text-[11px] font-medium">
          {PANEL_TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`relative pb-1 transition-colors ${
                activeTab === tab.id
                  ? "font-semibold text-white"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              <span>{tab.label}</span>
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
          {sessions.map((session) => {
            const position = shown.indexOf(session.id);
            return (
              <div
                key={session.id}
                hidden={position === -1}
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
                  id={session.id}
                  shell={session.shell}
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
          <div className="flex h-full items-center justify-center text-zinc-500">
            Workspace diagnostics are not connected.
          </div>
        )}
        {activeTab === "output" && (
          <div className="h-full p-3 text-zinc-500">No output service is connected.</div>
        )}
        {activeTab === "debug" && (
          <div className="h-full p-3 text-zinc-500">No debug session is connected.</div>
        )}
        {activeTab === "ai" && (
          <div className="h-full p-3 text-[11.5px] text-zinc-400">
            No AI service is connected. No tasks have run.
          </div>
        )}
      </div>

      {menu && (
        <div
          role="menu"
          aria-label="Terminal actions"
          style={{ left: menu.x, top: menu.y }}
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
