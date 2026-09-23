import { native } from "./native.ts";
import { folderKey } from "./paths.ts";

/**
 * The session on the UI side: which folder to reopen, what was open in it, and the recent
 * list the welcome page offers.
 *
 * The file itself is owned by the native side (`src-tauri/src/session.rs`), which is also
 * where the caps live. This module is the shape the UI works with, the guard that stops a
 * hand-edited file from reaching the components, and the writer that keeps a busy editor
 * from writing the file on every keystroke.
 */

export interface WorkspaceSession {
  folder: string;
  /** Open editor tabs, in tab order. */
  files: string[];
  /** The tab that was in front. Always one of `files`, or null. */
  active: string | null;
  /** Directories the explorer had unfolded. */
  expanded: string[];
  /** Where the explorer was scrolled, in pixels. */
  scroll: number;
}

export interface Session {
  /** Recently opened folders, most recent first. The head is the folder to reopen. */
  folders: string[];
  workspaces: WorkspaceSession[];
}

export const EMPTY_SESSION: Session = { folders: [], workspaces: [] };

/**
 * How many folders the recent list holds. The cap that matters is the native one
 * (`MAX_FOLDERS` in `src-tauri/src/session.rs`); this exists so that the list shown between
 * a folder being opened and the file being written cannot be longer than the list that
 * comes back next time.
 */
export const RECENT_FOLDERS = 15;

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

/**
 * The session as the UI may use it, from whatever was actually in the file.
 *
 * The file is in the user's config directory and is meant to be editable by hand, so it can
 * hold anything at all. Everything is filtered to the expected shape rather than trusted:
 * one bad entry drops out instead of breaking the window that reads it.
 */
export function asSession(value: unknown): Session {
  const raw = (value ?? {}) as Partial<Record<keyof Session, unknown>>;
  const folders = strings(raw.folders);
  const workspaces = (Array.isArray(raw.workspaces) ? raw.workspaces : [])
    .map((entry) => {
      const state = (entry ?? {}) as Partial<Record<keyof WorkspaceSession, unknown>>;
      if (typeof state.folder !== "string" || !state.folder) return null;
      const files = strings(state.files);
      const active = typeof state.active === "string" ? state.active : null;
      return {
        folder: state.folder,
        files,
        // A tab that is not open cannot be the one in front.
        active: active && files.includes(active) ? active : null,
        expanded: strings(state.expanded),
        scroll: typeof state.scroll === "number" && state.scroll >= 0 ? state.scroll : 0,
      } satisfies WorkspaceSession;
    })
    .filter((state): state is WorkspaceSession => state !== null);
  return { folders, workspaces };
}

/** What was open in `folder` last time, however either path is spelled. */
export function workspaceIn(session: Session, folder: string): WorkspaceSession | undefined {
  const key = folderKey(folder);
  return session.workspaces.find((state) => folderKey(state.folder) === key);
}

/** The folder to reopen: the most recent one, or null on a first run. */
export const lastFolder = (session: Session): string | null => session.folders[0] ?? null;

export const readSession = async (): Promise<Session> => asSession(await native("read_session"));

export const forgetFolder = async (folder: string): Promise<Session> =>
  asSession(await native("forget_workspace", { folder }));

/**
 * Coalesces saves so that typing, switching tabs and unfolding directories do not each write
 * the file. The last state within the window wins, because it is a snapshot of what is open
 * rather than a change to apply -- there is nothing to lose by dropping the ones before it.
 *
 * Built as a factory so the debouncing can be tested against a fake writer and a fake clock
 * instead of the real IPC.
 */
export function createSessionWriter(
  write: (state: WorkspaceSession) => Promise<unknown>,
  delay = 400,
) {
  let pending: WorkspaceSession | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = (): Promise<unknown> => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const state = pending;
    pending = null;
    if (!state) return Promise.resolve();
    // A failed save is not worth interrupting anyone over: the cost is reopening by hand.
    return write(state).catch(() => undefined);
  };

  return {
    save(state: WorkspaceSession) {
      pending = state;
      if (timer) return;
      timer = setTimeout(() => void flush(), delay);
    },
    /** Writes whatever is pending now, for the moment the window is going away. */
    flush,
    get pendingState() {
      return pending;
    },
  };
}

const writer = createSessionWriter((state) => native("save_workspace_session", { state }));

export const saveWorkspaceSession = (state: WorkspaceSession): void => writer.save(state);
export const flushWorkspaceSession = (): Promise<unknown> => writer.flush();

// The window closing is the one moment the debounce would lose a change that matters --
// `pagehide` fires for a closing webview where `beforeunload` is not guaranteed to.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => void writer.flush());
}
