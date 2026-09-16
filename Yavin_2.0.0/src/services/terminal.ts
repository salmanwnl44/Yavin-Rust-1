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

/** One terminal in the panel. The id is what every native call is keyed by. */
export interface TerminalSession {
  id: string;
  name: string;
  shell: string;
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

/** Bytes a shell has produced, already decoded as UTF-8 by the native side. */
export function onTerminalOutput(handler: (output: TerminalOutput) => void): () => void {
  return subscribe<TerminalOutput>("terminal-output", handler);
}

/** A shell has ended, whether by `exit`, a signal, or a crash. */
export function onTerminalExit(handler: (exit: TerminalExit) => void): () => void {
  return subscribe<TerminalExit>("terminal-exit", handler);
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
  "copy" | "paste" | "find" | "zoom-in" | "zoom-out" | "zoom-reset" | "new" | "split" | null;

/**
 * Which editing action a key press means, or null to send the keys to the shell.
 *
 * A terminal cannot use plain Ctrl+C for copy, because that is how a running program
 * is interrupted. Ctrl+Shift+C/V are the terminal conventions, and Ctrl+C copies only
 * when there is a selection to copy, matching what other terminals do.
 */
export function terminalKeyAction(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "metaKey" | "type">,
  hasSelection: boolean,
): TerminalKeyAction {
  if (event.type !== "keydown") return null;
  const key = event.key.toLowerCase();
  const command = event.metaKey && !event.ctrlKey;
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
export type TerminalRequest = "new" | "split" | "clear" | "find" | "kill";

const REQUEST = "yavin.terminal.request";

/**
 * Asks the panel to do something. A message keeps the menu in `App` independent of
 * how the panel tracks its sessions, which is the panel's own business.
 */
export function requestTerminal(request: TerminalRequest): void {
  window.dispatchEvent(new CustomEvent(REQUEST, { detail: request }));
}

export function onTerminalRequest(handler: (request: TerminalRequest) => void): () => void {
  const listener = (event: Event) => handler((event as CustomEvent<TerminalRequest>).detail);
  window.addEventListener(REQUEST, listener);
  return () => window.removeEventListener(REQUEST, listener);
}
