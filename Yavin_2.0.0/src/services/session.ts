import { native } from "./native.ts";
import { folderKey } from "./paths.ts";
import {
  createSessionCoordinator,
  snapshotSession,
  type SessionParts,
} from "./workspaceSession.ts";

/**
 * The session on the UI side: which folder to reopen, what was open in it, and the recent
 * list the welcome page offers.
 *
 * The file itself is owned by the native side (`src-tauri/src/session.rs`), which is also
 * where the caps live. This module is the shape the UI works with, the guard that stops a
 * hand-edited file from reaching the components, and the writer that keeps a busy editor
 * from writing the file on every keystroke.
 */

/**
 * Where the editor was in one open file (IDE-06): the cursor, the selection's anchor and the
 * scroll position -- plain numbers, never the engine's object. 1-based lines and columns.
 */
export interface FileView {
  file: string;
  line: number;
  column: number;
  /** Where the selection starts, when there is one; the cursor is its other end. */
  anchorLine?: number;
  anchorColumn?: number;
  /** The first line in view, and how far (px) the view is scrolled past its top. */
  topLine: number;
  topDelta: number;
  scrollLeft: number;
}

/** How the window was laid out around the editor: which side view, and whether each part showed. */
export interface WindowLayout {
  /** The Activity Bar view in the side bar ("explorer", "search", "git", "run", "debug"...). */
  sidebarView: string;
  sidebarOpen: boolean;
  /** The bottom panel (its view is the panel's own, `yavin.panel.view`). */
  panelOpen: boolean;
}

export interface WorkspaceSession {
  folder: string;
  /**
   * The workspace it belongs to (`workspaceIdOf`), written since IDE-06. A record whose id is
   * not the folder's own is someone else's and is not restored.
   */
  workspaceId?: string;
  /** Open editor tabs, in tab order. */
  files: string[];
  /** The tab that was in front. Always one of `files`, or null. */
  active: string | null;
  /** Directories the explorer had unfolded. */
  expanded: string[];
  /** Where the explorer was scrolled, in pixels. */
  scroll: number;
  /** What the explorer had selected. Missing from sessions written before it was kept. */
  selected?: string[];
  /** The explorer entry that had keyboard focus. */
  focused?: string | null;
  /** Where the editor was in each open file, for those it had shown (IDE-06). */
  views?: FileView[];
  /** The side bar and panel (IDE-06). */
  layout?: WindowLayout | null;
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

const position = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 10_000_000;
const offset = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/** One file's view, or null when it is not one (a hand-edited or damaged entry). */
function asFileView(value: unknown, files: readonly string[]): FileView | null {
  const raw = (value ?? {}) as Partial<Record<keyof FileView, unknown>>;
  if (typeof raw.file !== "string" || !files.includes(raw.file)) return null;
  if (!position(raw.line) || !position(raw.column)) return null;
  const view: FileView = {
    file: raw.file,
    line: raw.line,
    column: raw.column,
    topLine: position(raw.topLine) ? raw.topLine : raw.line,
    topDelta: typeof raw.topDelta === "number" && Number.isFinite(raw.topDelta) ? raw.topDelta : 0,
    scrollLeft: offset(raw.scrollLeft) ? raw.scrollLeft : 0,
  };
  if (position(raw.anchorLine) && position(raw.anchorColumn)) {
    view.anchorLine = raw.anchorLine;
    view.anchorColumn = raw.anchorColumn;
  }
  return view;
}

function asLayout(value: unknown): WindowLayout | null {
  const raw = value as Partial<Record<keyof WindowLayout, unknown>> | null | undefined;
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.sidebarView !== "string" || !/^[a-z-]{1,32}$/.test(raw.sidebarView)) return null;
  return {
    sidebarView: raw.sidebarView,
    sidebarOpen: raw.sidebarOpen !== false,
    panelOpen: raw.panelOpen === true,
  };
}

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
      const result: WorkspaceSession = {
        folder: state.folder,
        files,
        // A tab that is not open cannot be the one in front.
        active: active && files.includes(active) ? active : null,
        expanded: strings(state.expanded),
        scroll: typeof state.scroll === "number" && state.scroll >= 0 ? state.scroll : 0,
        selected: strings(state.selected),
        focused: typeof state.focused === "string" ? state.focused : null,
        views: (Array.isArray(state.views) ? state.views : [])
          .map((view) => asFileView(view, files))
          .filter((view): view is FileView => view !== null),
        layout: asLayout(state.layout),
      };
      if (typeof state.workspaceId === "string" && state.workspaceId)
        result.workspaceId = state.workspaceId;
      return result;
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
 * The window's sessions (IDE-06, `workspaceSession.ts`): one at a time, saved -- debounced, the
 * last state within the window winning -- to the native session file. The window reports what
 * it holds through `provideSessionParts`; nothing in React reads or writes the file.
 */
let parts: (() => SessionParts) | null = null;
let written: ((state: WorkspaceSession) => void) | null = null;
export const provideSessionParts = (
  provider: () => SessionParts,
  onRecord?: (state: WorkspaceSession) => void,
) => {
  parts = provider;
  written = onRecord ?? null;
};
export const windowSessions = createSessionCoordinator({
  write: (state) => native("save_workspace_session", { state }),
  written: (state) => written?.(state),
  snapshot: (owner) => {
    if (!parts) throw new Error("The window has not said what it holds.");
    return snapshotSession(owner, parts());
  },
});

// The window closing is the one moment the debounce would lose a change that matters --
// `pagehide` fires for a closing webview where `beforeunload` is not guaranteed to.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    // The cursor and scroll move without marking anything: taken now, as the window goes.
    windowSessions.current()?.markDirty();
    void windowSessions.flush();
  });
}
