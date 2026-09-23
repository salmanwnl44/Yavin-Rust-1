import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** A shell the native side found on this machine and is willing to start. */
export interface Shell {
  name: string;
  path: string;
}

export interface TerminalOutput {
  id: string;
  data: string;
}

export interface TerminalExit {
  id: string;
  code: number | null;
}

/**
 * How a terminal is launched. A profile is a shell plus the extras VS Code lets a profile
 * carry -- arguments, environment and a starting folder. None of these widen what a terminal
 * can do (anyone who can open one can type any command into it); they just save typing the
 * same setup every time.
 */
export interface TerminalProfile {
  /** Shown on the tab and in the New Terminal menu. */
  name: string;
  /** Absolute path to the shell. Must be one the native side detected. */
  shell: string;
  args?: string[];
  env?: Record<string, string>;
  /** Where the shell starts. The workspace root when omitted. */
  cwd?: string;
}

/** One terminal in the panel. The id is what every native call is keyed by. */
export interface TerminalSession {
  id: string;
  name: string;
  shell: string;
  /** Present when the terminal was started from a profile with extras. */
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/**
 * The arguments `terminal_open` takes for a session. Environment is sent as pairs rather than
 * an object so the native side keeps the author's ordering, which matters when one variable
 * is written in terms of another.
 */
export function openArgsFor(
  session: TerminalSession,
  size: { cols: number; rows: number },
): {
  id: string;
  shell: string;
  cols: number;
  rows: number;
  args?: string[];
  env?: [string, string][];
  cwd?: string;
} {
  const env = session.env ? Object.entries(session.env) : undefined;
  return {
    id: session.id,
    shell: session.shell,
    ...size,
    ...(session.args?.length ? { args: session.args } : {}),
    ...(env?.length ? { env } : {}),
    ...(session.cwd ? { cwd: session.cwd } : {}),
  };
}

/**
 * Subscribes to one terminal event. Returns an unsubscribe function that is safe to
 * call before the listener has finished registering.
 */
function subscribe<T>(event: string, handler: (payload: T) => void): () => void {
  if (!isTauri()) return () => {};
  let cancelled = false;
  const pending = listen<T>(event, (message) => {
    if (!cancelled) handler(message.payload);
  }).catch(() => undefined);
  return () => {
    cancelled = true;
    void pending.then((unlisten) => unlisten?.());
  };
}

/**
 * Routes native terminal events to the one terminal they belong to.
 *
 * The native side broadcasts `terminal-output` globally, so every open terminal used to
 * receive every other terminal's bytes and discard the ones whose id did not match -- work
 * proportional to the number of open terminals for every chunk of output, on the hot path of
 * a build scrolling past. The router subscribes once and dispatches by id, so a chunk costs
 * one map lookup no matter how many terminals are open.
 */
interface Router<T> {
  handlers: Map<string, Set<(payload: T) => void>>;
  stop: (() => void) | null;
}

const outputRouter: Router<TerminalOutput> = { handlers: new Map(), stop: null };
const exitRouter: Router<TerminalExit> = { handlers: new Map(), stop: null };

/**
 * Hands a payload to the terminal it belongs to. A copy of the set, and one try per listener:
 * a handler that throws must not swallow the chunk for every other terminal, nor escape into
 * the native event callback.
 */
function dispatch<T extends { id: string }>(router: Router<T>, payload: T): void {
  const listeners = router.handlers.get(payload.id);
  if (!listeners) return;
  for (const listener of [...listeners]) {
    try {
      listener(payload);
    } catch {
      /* One terminal's failure is not the others' problem. */
    }
  }
}

function route<T extends { id: string }>(
  router: Router<T>,
  event: string,
  id: string,
  handler: (payload: T) => void,
): () => void {
  let forId = router.handlers.get(id);
  if (!forId) {
    forId = new Set();
    router.handlers.set(id, forId);
  }
  forId.add(handler);
  router.stop ??= subscribe<T>(event, (payload) => dispatch(router, payload));

  const registered = forId;
  return () => {
    // Only tear down what this subscription actually owns. Calling an unsubscribe twice
    // would otherwise delete the set a *later* subscription for the same id had installed,
    // silently stopping that terminal's output and dropping the native listener with it.
    if (router.handlers.get(id) !== registered) return;
    registered.delete(handler);
    if (registered.size > 0) return;
    router.handlers.delete(id);
    // Nothing is listening any more, so nothing should stay subscribed either.
    if (router.handlers.size === 0) {
      router.stop?.();
      router.stop = null;
    }
  };
}

/**
 * Test seam: delivers a payload exactly as the native event would. The routers subscribe
 * through `listen`, which is inert outside Tauri, so without this the routing rules -- which
 * is where the bugs were -- could only be checked in a browser test.
 */
export function deliverForTest(
  event: "terminal-output" | "terminal-exit",
  payload: { id: string; data?: string; code?: number | null },
): void {
  // Goes through the same `dispatch` the native subscription uses, so what the tests check
  // is the real routing rather than a re-implementation of it.
  if (event === "terminal-output") dispatch(outputRouter, payload as TerminalOutput);
  else dispatch(exitRouter, payload as TerminalExit);
}

/** This terminal's output only. */
export function onOutputFor(id: string, handler: (data: string) => void): () => void {
  return route(outputRouter, "terminal-output", id, (payload) => handler(payload.data));
}

/** This terminal's exit only. */
export function onExitFor(id: string, handler: (code: number | null) => void): () => void {
  return route(exitRouter, "terminal-exit", id, (payload) => handler(payload.code));
}

/**
 * The terminal size in whole cells. xterm reports 0 before it has been laid out,
 * which the shell would take literally, so a sane minimum is enforced here.
 */
export function usableSize(cols: number, rows: number): { cols: number; rows: number } {
  return { cols: Math.max(1, Math.floor(cols) || 80), rows: Math.max(1, Math.floor(rows) || 24) };
}

let created = 0;

/** Identifies a session for the life of the window; never reused after a close. */
export function createTerminalId(): string {
  created += 1;
  return `terminal-${Date.now().toString(36)}-${created}`;
}

/** A shell's name, numbered when more than one of the same shell is open. */
export function nextTerminalName(existing: readonly string[], shell: string): string {
  if (!existing.includes(shell)) return shell;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${shell} (${suffix})`;
    if (!existing.includes(candidate)) return candidate;
  }
}

/** How a finished shell is described, distinguishing a clean exit from a failure. */
export function describeExit(code: number | null): string {
  if (code === null) return "The shell ended unexpectedly.";
  if (code === 0) return "The shell exited.";
  return `The shell exited with code ${code}.`;
}

export type TerminalKeyAction =
  | "copy"
  | "paste"
  | "find"
  | "zoom-in"
  | "zoom-out"
  | "zoom-reset"
  | "new"
  | "split"
  | "next"
  | "previous"
  | "pane-next"
  | "pane-previous"
  | "scroll-page-up"
  | "scroll-page-down"
  | "scroll-top"
  | "scroll-bottom"
  | null;

/**
 * Which editing action a key press means, or null to send the keys to the shell.
 *
 * A terminal cannot use plain Ctrl+C for copy, because that is how a running program
 * is interrupted. Ctrl+Shift+C/V are the terminal conventions, and Ctrl+C copies only
 * when there is a selection to copy, matching what other terminals do.
 */
export function terminalKeyAction(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "metaKey" | "type"> & {
    altKey?: boolean;
  },
  hasSelection: boolean,
  /** Whether a split is open. Alt+Arrow is only claimed when there is a second pane to move
   * to: on macOS Option+Arrow is readline's move-by-word and several shells bind Alt+Arrow to
   * history, so taking it unconditionally broke line editing for everyone not using splits. */
  hasSplit = false,
): TerminalKeyAction {
  if (event.type !== "keydown") return null;
  const key = event.key.toLowerCase();
  const command = event.metaKey && !event.ctrlKey;

  // Scrolling the buffer. Shift+PageUp/PageDown and Ctrl+Home/End are what every terminal
  // uses, and no shell wants them, so they are handled before the Ctrl/Cmd gate below.
  if (event.shiftKey && !event.ctrlKey && !event.altKey) {
    if (key === "pageup") return "scroll-page-up";
    if (key === "pagedown") return "scroll-page-down";
  }
  if (event.ctrlKey && !event.shiftKey && !event.altKey) {
    if (key === "home") return "scroll-top";
    if (key === "end") return "scroll-bottom";
    // Moving between terminals, matching VS Code.
    if (key === "pagedown") return "next";
    if (key === "pageup") return "previous";
  }
  // Moving between the panes of a split. Alt alone is otherwise unused here.
  if (event.altKey && !event.ctrlKey && !event.shiftKey && !event.metaKey) {
    if (!hasSplit) return null;
    if (key === "arrowright") return "pane-next";
    if (key === "arrowleft") return "pane-previous";
    return null;
  }

  if (!event.ctrlKey && !command) return null;

  // Font size follows the same keys the rest of the application uses.
  if (!event.shiftKey) {
    if (key === "=" || key === "+") return "zoom-in";
    if (key === "-" || key === "_") return "zoom-out";
    if (key === "0") return "zoom-reset";
  }

  if (command) {
    // macOS keeps the familiar Command shortcuts, which no shell claims.
    if (key === "c") return hasSelection ? "copy" : null;
    if (key === "v") return "paste";
    if (key === "f") return "find";
    return null;
  }
  if (event.shiftKey) {
    if (key === "c") return "copy";
    if (key === "v") return "paste";
    if (key === "f") return "find";
    if (key === "`" || key === "~") return "new";
    if (key === "5" || key === "%") return "split";
    return null;
  }
  // Plain Ctrl+C interrupts unless the user has selected something to copy.
  if (key === "c" && hasSelection) return "copy";
  return null;
}

/** Font sizes the terminal will zoom between, in CSS pixels. */
export const DEFAULT_FONT_SIZE = 12;

export function zoomFontSize(current: number, action: TerminalKeyAction): number {
  if (action === "zoom-in") return Math.min(current + 1, 32);
  if (action === "zoom-out") return Math.max(current - 1, 6);
  if (action === "zoom-reset") return DEFAULT_FONT_SIZE;
  return current;
}

/** Panel actions that the Terminal menu and the terminal itself can ask for. */
export type TerminalRequestName = "new" | "split" | "clear" | "find" | "kill";

/** A request, optionally carrying the folder a new terminal should start in. */
export type TerminalRequest = TerminalRequestName | { name: "new"; cwd: string };

const REQUEST = "yavin.terminal.request";

/** How many panels are currently listening, and requests that arrived while none were. */
let panelListeners = 0;
const undelivered: TerminalRequest[] = [];

/**
 * Asks the panel to do something. A message keeps the menu in `App` independent of
 * how the panel tracks its sessions, which is the panel's own business.
 *
 * The panel is mounted lazily, so the first request of a session -- "Open in Integrated
 * Terminal" from the explorer, say -- is sent before there is anything to receive it. Rather
 * than drop it, it is held and delivered as soon as a panel subscribes.
 */
export function requestTerminal(request: TerminalRequest): void {
  // Dispatched first and unconditionally, so observers -- the app shell, which reveals the
  // panel -- always see it. Only then is it held for a panel that has yet to mount.
  window.dispatchEvent(new CustomEvent(REQUEST, { detail: request }));
  // A queue, not one slot: opening two folders in a terminal before the panel exists should
  // open two terminals, not silently drop the first.
  if (panelListeners === 0) undelivered.push(request);
}

/** Subscribes the panel. Only the panel should use this: it is what "delivered" means. */
export function onTerminalRequest(handler: (request: TerminalRequest) => void): () => void {
  const listener = (event: Event) => handler((event as CustomEvent<TerminalRequest>).detail);
  window.addEventListener(REQUEST, listener);
  panelListeners += 1;
  let live = true;
  if (undelivered.length) {
    // Drained inside the callback, not before it: development StrictMode subscribes,
    // unsubscribes and subscribes again, so taking the queue up front threw the request away
    // on the discarded first mount and nothing ever delivered it.
    queueMicrotask(() => {
      if (!live) return;
      for (const request of undelivered.splice(0, undelivered.length)) handler(request);
    });
  }
  return () => {
    live = false;
    panelListeners -= 1;
    window.removeEventListener(REQUEST, listener);
  };
}

/**
 * Watches requests without counting as the panel's handler, so the app shell can reveal the
 * panel for a request the panel does not exist yet to receive.
 */
export function onTerminalRequestObserved(handler: (request: TerminalRequest) => void): () => void {
  const listener = (event: Event) => handler((event as CustomEvent<TerminalRequest>).detail);
  window.addEventListener(REQUEST, listener);
  return () => window.removeEventListener(REQUEST, listener);
}
