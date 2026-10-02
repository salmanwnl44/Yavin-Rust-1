import { Channel } from "@tauri-apps/api/core";
import {
  MAX_COLS,
  MAX_ROWS,
  parseTerminalMessage,
  type Generation,
  type Sequence,
  type SubscriptionId,
  type TerminalAckRequest,
  type TerminalDetached,
  type TerminalDimensions,
  type TerminalErrorEvent,
  type TerminalExit,
  type TerminalId,
  type TerminalOpenRequest,
  type TerminalOutputChunk,
  type TerminalSession as NativeTerminalSession,
  type WorkspaceId,
} from "./terminalProtocol.ts";

/** A shell the native side found on this machine and is willing to start. */
export interface Shell {
  name: string;
  path: string;
}

let launches = 0;
/**
 * A new launch's generation (see the Terminal contract): newer than every earlier one for as
 * long as the window runs, so each id's generations only ever increase.
 */
export const nextGeneration = (): Generation => ++launches as Generation;

// A launch profile is a contract type: `TerminalProfile` in `terminalProtocol.ts`.

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
 * The `terminal_open` request for a launch of `session`. A shell picked in the panel is sent as
 * a profile of that shell (with the session's arguments and environment, as ordered pairs: a
 * variable may be written in terms of an earlier one); with none picked -- detection failed --
 * the native side starts its default shell.
 */
export function openRequestFor(
  session: TerminalSession,
  dimensions: TerminalDimensions,
  generation: Generation,
  workspaceId: WorkspaceId,
): TerminalOpenRequest {
  return {
    sessionId: session.id as TerminalId,
    workspaceId,
    generation,
    profile: session.shell
      ? {
          id: session.shell,
          name: session.name,
          executable: session.shell,
          args: session.args ?? [],
          cwd: null,
          env: session.env ? Object.entries(session.env) : [],
        }
      : null,
    cwd: session.cwd || null,
    dimensions,
  };
}

/** What a terminal view does with its launch's stream (TERMINAL-02). */
export interface TerminalStreamHandlers {
  /**
   * The next output, in order. Call `accepted` once the terminal has consumed the bytes (xterm's
   * write callback): that is the acknowledgement that lets more be sent, and, past the bound,
   * lets the shell's output be read again.
   */
  output(chunk: TerminalOutputChunk, accepted: () => void): void;
  exit(exit: TerminalExit): void;
  error(event: TerminalErrorEvent): void;
  /** This view was detached from a session that goes on: it will be sent nothing more. */
  detached(event: TerminalDetached): void;
}

/**
 * One subscriber's handling of its channel: each message parsed against the contract, anything
 * not of its own launch dropped, the rest handed on in the order it arrived. A handler that
 * throws stops neither the stream nor the window.
 */
export function streamReceiver(
  launch: { sessionId: string; generation: number },
  acknowledge: (seq: Sequence) => void,
  handlers: TerminalStreamHandlers,
): (message: unknown) => void {
  return (message) => {
    const event = parseTerminalMessage(message);
    if (!event || event.sessionId !== launch.sessionId || event.generation !== launch.generation)
      return;
    try {
      if (event.kind === "output") {
        let acknowledged = false;
        handlers.output(event, () => {
          if (acknowledged) return;
          acknowledged = true;
          acknowledge(event.seq);
        });
      } else if (event.kind === "exit") handlers.exit(event);
      else if (event.kind === "error") handlers.error(event);
      else if (event.kind === "detached") handlers.detached(event);
    } catch {
      /* One handler's failure is not the stream's. */
    }
  };
}

/** How a launch reaches the native side; the application passes its `native` calls. */
export interface TerminalTransport {
  open(args: {
    request: TerminalOpenRequest;
    subscriptionId: SubscriptionId;
    events: Channel<unknown>;
  }): Promise<NativeTerminalSession>;
  ack(request: TerminalAckRequest): Promise<unknown>;
}

let subscriptions = 0;

/** A subscription id for one launch: unique for the life of the window. */
export function createSubscriptionId(sessionId: string): SubscriptionId {
  subscriptions += 1;
  return `${sessionId}-view-${subscriptions}` as SubscriptionId;
}

/**
 * Opens a launch with a channel of its own: its output and lifecycle arrive there, for this
 * view alone, and each chunk is acknowledged once `handlers.output` says it was consumed.
 */
export function openTerminal(
  request: TerminalOpenRequest,
  handlers: TerminalStreamHandlers,
  transport: TerminalTransport,
): Promise<NativeTerminalSession> {
  const subscriptionId = createSubscriptionId(request.sessionId);
  const acknowledge = (seq: Sequence) =>
    void transport
      .ack({
        subscriptionId,
        sessionId: request.sessionId,
        generation: request.generation,
        seq,
      })
      .catch(() => undefined);
  const events = new Channel<unknown>(streamReceiver(request, acknowledge, handlers));
  return transport.open({ request, subscriptionId, events });
}

/**
 * The terminal size in whole cells. xterm reports 0 before it has been laid out,
 * which the shell would take literally, so a sane minimum is enforced here.
 */
export function usableSize(cols: number, rows: number): TerminalDimensions {
  const cells = (value: number, fallback: number, max: number) =>
    Math.min(max, Math.max(1, Math.floor(value) || fallback));
  return { cols: cells(cols, 80, MAX_COLS), rows: cells(rows, 24, MAX_ROWS) };
}

let created = 0;

/**
 * Closes every shell an earlier page left running, once, before this page opens its first.
 * Reloading the window replaces the page without its terminal views getting to close their
 * shells (an IPC call cannot finish during unload), and the native side kept them running.
 * Only this window has terminals, so whatever is running when a page starts is an earlier
 * page's.
 */
let leftoversClosed: Promise<void> | null = null;
export const closeLeftoverShells = (close: () => Promise<unknown>): Promise<void> =>
  (leftoversClosed ??= close().then(
    () => undefined,
    () => undefined,
  ));

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
