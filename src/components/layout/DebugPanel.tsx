import { useEffect, useState, useSyncExternalStore } from "react";
import type { Breakpoints } from "../../services/debug/breakpoints";
import type {
  DebugControls,
  DebugService,
  DebugState,
  VariableView,
} from "../../services/debug/service";
import { basename, fileUri, fsPath, type ResourceUri } from "../../services/resource";

const STATE_LABEL: Record<DebugState, string> = {
  created: "Starting",
  starting: "Starting",
  initializing: "Starting",
  running: "Running",
  stopped: "Paused",
  terminating: "Stopping",
  terminated: "Ended",
  failed: "Failed",
};

/** No workspace, no breakpoints: one empty list, the same every time (a snapshot must be stable). */
const NONE: ReturnType<Breakpoints["getSnapshot"]> = [];
const NO_BREAKPOINTS: Breakpoints["getSnapshot"] = () => NONE;
const noSubscribe = () => () => {};

/**
 * The Debug view (IDE-05): start a configuration, the stepping controls, the paused program's
 * call stack and variables, and the workspace's breakpoints. A view of the workspace's
 * DebugService and breakpoints; every action is the window's command or the service's, and
 * nothing here speaks DAP.
 */
export function DebugPanel({
  service,
  breakpoints,
  visible,
  hasWorkspace,
  onStart,
  onCommand,
  onConfigure,
  onOpenBreakpoint,
  onError,
}: {
  service: DebugService;
  breakpoints: Breakpoints | null;
  visible: boolean;
  hasWorkspace: boolean;
  onStart: (configurationId?: string) => void;
  onCommand: (command: keyof Omit<DebugControls, "start" | "evaluate">) => void;
  onConfigure: () => void;
  onOpenBreakpoint: (path: string, line: number) => void;
  onError: (error: unknown) => void;
}) {
  const snapshot = useSyncExternalStore(
    service.subscribe,
    service.getSnapshot,
    service.getSnapshot,
  );
  const marks = useSyncExternalStore(
    breakpoints?.subscribe ?? noSubscribe,
    breakpoints?.getSnapshot ?? NO_BREAKPOINTS,
    breakpoints?.getSnapshot ?? NO_BREAKPOINTS,
  );
  const controls = service.controls();
  const { session, configurations } = snapshot;
  const [chosen, setChosen] = useState<string>("");
  const configuration = configurations.find((one) => one.id === chosen) ?? configurations[0];
  const live = session && session.state !== "terminated" && session.state !== "failed";

  const button = (
    command: keyof Omit<DebugControls, "start" | "evaluate">,
    label: string,
    glyph: string,
    key: string,
  ) =>
    (command !== "restart" || session?.capabilities.supportsRestartRequest) && (
      <button
        key={command}
        aria-label={label}
        title={`${label} (${key})`}
        disabled={!controls[command]}
        onClick={() => onCommand(command)}
        className="rounded px-1.5 py-0.5 text-[13px] text-zinc-300 hover:bg-[#1d1d1d] disabled:opacity-30"
      >
        {glyph}
      </button>
    );

  return (
    <aside
      hidden={!visible}
      aria-label="Debug"
      className="flex w-[280px] shrink-0 flex-col border-r border-[#141414] bg-black text-[12px] text-zinc-300"
    >
      <div className="flex h-9 items-center justify-between border-b border-[#101010] px-3">
        <span className="text-[11px] font-semibold tracking-wider uppercase">Run and Debug</span>
        <button onClick={onConfigure} className="text-[11px] text-zinc-500 hover:text-zinc-200">
          Configure Debugging
        </button>
      </div>
      {!hasWorkspace ? (
        <p className="p-3 text-zinc-500">Open a folder to debug its programs.</p>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex items-center gap-1 p-2">
            {configurations.length > 1 && (
              <select
                aria-label="Debug configuration"
                value={configuration?.id ?? ""}
                onChange={(event) => setChosen(event.target.value)}
                className="min-w-0 flex-1 rounded border border-[#2a2a2a] bg-[#111111] px-1 py-0.5"
              >
                {configurations.map((one) => (
                  <option key={one.id} value={one.id}>
                    {one.name}
                  </option>
                ))}
              </select>
            )}
            <button
              onClick={() => onStart(configuration?.id)}
              disabled={!controls.start}
              className="flex-1 rounded bg-[#15301d] px-2 py-1 text-[11px] text-emerald-200 hover:bg-[#1b3d25] disabled:opacity-40"
            >
              {configuration ? `Start Debugging: ${configuration.name}` : "Start Debugging"}
            </button>
          </div>
          {!configurations.length && (
            <p className="px-3 pb-2 text-[11px] text-zinc-500">
              No debug configurations yet. Configure Debugging adds one (debugpy runs Python).
            </p>
          )}

          <div role="toolbar" aria-label="Debug controls" className="flex flex-wrap gap-0.5 px-2">
            {button("continue", "Continue", "▶", "F5")}
            {button("pause", "Pause", "⏸", "F6")}
            {button("stepOver", "Step Over", "↷", "F10")}
            {button("stepInto", "Step Into", "↓", "F11")}
            {button("stepOut", "Step Out", "↑", "Shift+F11")}
            {button("restart", "Restart", "↻", "Ctrl+Shift+F5")}
            {button("stop", "Stop", "■", "Shift+F5")}
          </div>
          {session && (
            <p data-testid="debug-status" className="px-3 py-1 text-[11px] text-zinc-400">
              <span
                className={
                  live
                    ? "text-amber-300"
                    : session.state === "failed"
                      ? "text-red-400"
                      : "text-zinc-500"
                }
              >
                {STATE_LABEL[session.state]}
              </span>
              {session.state === "stopped" && session.stoppedReason
                ? ` on ${session.stoppedReason}`
                : ""}
              {!live && session.terminationReason ? `: ${session.terminationReason}` : ""}
            </p>
          )}

          <section aria-label="Call Stack" className="px-2 pb-2">
            <h2 className="px-1 py-1 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
              Call Stack
            </h2>
            {snapshot.threads.length > 1 &&
              snapshot.threads.map((thread) => (
                <button
                  key={thread.id}
                  aria-pressed={thread.id === snapshot.selectedThreadId}
                  disabled={session?.state !== "stopped"}
                  onClick={() => void service.selectThread(thread.id).catch(onError)}
                  className="block w-full truncate rounded px-1 text-left text-[11px] text-zinc-400 aria-pressed:text-zinc-100"
                >
                  {thread.name} <span className="text-zinc-600">{thread.state}</span>
                </button>
              ))}
            {snapshot.frames.map((frame) => (
              <button
                key={frame.id}
                aria-label={`Frame ${frame.name}${frame.path ? ` ${basename(fileUriSafe(frame.path))}:${frame.line}` : ""}`}
                aria-current={frame.id === snapshot.selectedFrameId ? "true" : undefined}
                onClick={() => void service.selectFrame(frame.id).catch(onError)}
                className={`flex w-full gap-2 rounded px-1 py-0.5 text-left hover:bg-[#0c0c0c] aria-[current=true]:bg-[#16213a] ${frame.subtle ? "text-zinc-600" : ""}`}
              >
                <span className="min-w-0 flex-1 truncate">{frame.name}</span>
                <span className="shrink-0 text-[10px] text-zinc-500">
                  {frame.path
                    ? `${frame.sourceName ?? basename(fileUriSafe(frame.path))}:${frame.line}`
                    : "no source"}
                </span>
              </button>
            ))}
            {session?.state === "running" && (
              <p className="px-1 text-[11px] text-zinc-600">Running</p>
            )}
          </section>

          <section aria-label="Variables" className="px-2 pb-2">
            <h2 className="px-1 py-1 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
              Variables
            </h2>
            {snapshot.scopes.map((scope) => (
              <VariableNode
                key={`${snapshot.selectedFrameId}:${scope.name}`}
                service={service}
                name={scope.name}
                value=""
                reference={scope.variablesReference}
                cached={snapshot.variables}
                depth={0}
                initiallyOpen={!scope.expensive}
                onError={onError}
              />
            ))}
          </section>

          <section aria-label="Breakpoints" className="px-2 pb-2">
            <div className="flex items-center justify-between px-1 py-1">
              <h2 className="text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
                Breakpoints
              </h2>
              {marks.length > 0 && (
                <button
                  onClick={() => breakpoints?.clear()}
                  className="text-[10px] text-zinc-500 hover:text-zinc-200"
                >
                  Remove All
                </button>
              )}
            </div>
            {marks.map((mark) => {
              const name = `${basename(mark.uri)}:${mark.line}`;
              return (
                <div
                  key={mark.id}
                  role="group"
                  aria-label={`Breakpoint ${name}`}
                  className="flex items-center gap-1.5 px-1"
                >
                  <input
                    type="checkbox"
                    aria-label={`Enable ${name}`}
                    checked={mark.enabled}
                    onChange={(event) => breakpoints?.setEnabled(mark.id, event.target.checked)}
                  />
                  <button
                    onClick={() => onOpenBreakpoint(fsPath(mark.uri), mark.line)}
                    title={mark.verified === false ? (mark.message ?? "Not set") : undefined}
                    className={`min-w-0 flex-1 truncate text-left ${mark.verified === false ? "text-zinc-500 italic" : ""}`}
                  >
                    {name}
                    {mark.verified === false ? " (not set)" : ""}
                  </button>
                  <button
                    aria-label={`Remove ${name}`}
                    onClick={() => breakpoints?.remove(mark.id)}
                    className="text-zinc-600 hover:text-zinc-200"
                  >
                    ✕
                  </button>
                </div>
              );
            })}
            {!marks.length && (
              <p className="px-1 text-[11px] text-zinc-600">
                Click left of a line number in the editor, or press F9.
              </p>
            )}
          </section>
        </div>
      )}
    </aside>
  );
}

/** The resource a frame's path names, for its file name; a path that is not one stays as is. */
function fileUriSafe(path: string): ResourceUri {
  try {
    return fileUri(path);
  } catch {
    return { scheme: "file", authority: "", path: path.replace(/\\/g, "/") };
  }
}

/** A scope or variable; its children are fetched (once per stop) only when it is opened. */
function VariableNode({
  service,
  name,
  value,
  type,
  reference,
  cached,
  depth,
  initiallyOpen = false,
  onError,
}: {
  service: DebugService;
  name: string;
  value: string;
  type?: string | null;
  reference: number;
  cached: ReadonlyMap<number, readonly VariableView[]>;
  depth: number;
  initiallyOpen?: boolean;
  onError: (error: unknown) => void;
}) {
  const [open, setOpen] = useState(initiallyOpen && reference > 0);
  const children = cached.get(reference);
  useEffect(() => {
    if (open && reference > 0 && !children) void service.expand(reference).catch(onError);
  }, [open, reference, children, service, onError]);
  const expandable = reference > 0;
  return (
    <div role="treeitem" aria-label={name} aria-expanded={expandable ? open : undefined}>
      <button
        onClick={() => expandable && setOpen(!open)}
        style={{ paddingLeft: depth * 12 + 4 }}
        className="flex w-full gap-1 rounded py-0.5 text-left hover:bg-[#0c0c0c]"
      >
        <span className="w-3 shrink-0 text-zinc-600">{expandable ? (open ? "▾" : "▸") : ""}</span>
        <span className={depth === 0 ? "text-zinc-300" : "text-sky-300"}>{name}</span>
        {value && (
          <span
            className="min-w-0 truncate text-zinc-400"
            title={type ? `${type}: ${value}` : value}
          >
            {value}
          </span>
        )}
      </button>
      {open &&
        children?.map((child) => (
          <VariableNode
            key={child.name}
            service={service}
            name={child.name}
            value={child.value}
            type={child.type}
            reference={child.variablesReference}
            cached={cached}
            depth={depth + 1}
            onError={onError}
          />
        ))}
    </div>
  );
}
