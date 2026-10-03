import {
  MAX_COLS,
  MAX_ROWS,
  type Generation,
  type SubscriptionId,
  type TerminalDimensions,
  type TerminalId,
  type TerminalOpenRequest,
  type TerminalProfile,
  type WorkspaceId,
} from "./terminalProtocol.ts";

/** What kind of shell a program is: what decides its login flag (see `terminalProfiles.ts`). */
export type ShellKind = "cmd" | "powershell" | "pwsh" | "bash" | "zsh" | "fish" | "sh" | "other";

/**
 * A shell discovery knows of (TERMINAL-05): found on this machine or not (and why not), and
 * whether it is the platform's default. Discovery says what there is; profiles say how to
 * launch it.
 */
export interface Shell {
  /** A display name to suggest. */
  name: string;
  path: string;
  kind: ShellKind;
  platform: "windows" | "unix";
  available: boolean;
  reason: string | null;
  isDefault: boolean;
}

let launches = 0;
/**
 * A new launch's generation (see the Terminal contract): newer than every earlier one for as
 * long as the window runs, so each id's generations only ever increase.
 */
export const nextGeneration = (): Generation => ++launches as Generation;

/**
 * The `terminal_open` request for a launch of session `id`: the profile it starts with (`null`
 * for the native default shell) and the folder asked for, which overrides the profile's.
 */
export function openRequestFor(
  id: string,
  profile: TerminalProfile | null,
  cwd: string | null,
  dimensions: TerminalDimensions,
  generation: Generation,
  workspaceId: WorkspaceId,
): TerminalOpenRequest {
  return {
    sessionId: id as TerminalId,
    workspaceId,
    generation,
    profile: profile ? { ...profile, args: [...profile.args], env: [...profile.env] } : null,
    cwd: cwd || null,
    dimensions,
  };
}

let subscriptions = 0;

/** A subscription id for one launch: unique for the life of the window. */
export function createSubscriptionId(sessionId: string): SubscriptionId {
  subscriptions += 1;
  return `${sessionId}-view-${subscriptions}` as SubscriptionId;
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
