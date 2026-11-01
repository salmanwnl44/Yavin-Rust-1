/**
 * The workspace session (IDE-06): how the user left a workspace -- its open editors, the one in
 * front, where each editor was, the Explorer's snapshot and the window's layout -- and the
 * lifecycle that restores and saves it.
 *
 * ```text
 * window (one: "main")
 *   └─ SessionCoordinator          one session at a time, the window's
 *        └─ WorkspaceSessionHandle  created → restoring → active ⇄ saving → disposing → disposed
 *             │ remembers (serializable, `session.ts` WorkspaceSession):
 *             │   files, active, views (cursor/selection/scroll), explorer snapshot, layout
 *             ▼
 *        native session.rs          the one session file: atomic, versioned, set aside if unreadable
 * ```
 *
 * A session remembers UI arrangement; it does not own subsystem runtime state. It never holds
 * document content (DocumentService), terminal sessions or their layout (TerminalService,
 * `terminalSettings`), tasks, debug sessions, Problems, Git, language servers, settings or
 * trust. Restoring goes through those owners: files are opened by DocumentService, the editor
 * restores its own view state from `EditorViews`, the Explorer store is seeded with the
 * snapshot. Nothing here touches Monaco, React or a native handle.
 *
 * Every session has a generation. Restore work runs with a guard that turns false the moment
 * another session begins or this one is disposed, so a late answer from workspace A's restore
 * changes nothing in B; and nothing is saved until a restore has finished, so the empty state a
 * window passes through on its way to restoring is never written over the real one.
 */
import { fileUri, resourceId, type ResourceId } from "./resource.ts";
import { folderKey } from "./paths.ts";
import type { FileView, Session, WindowLayout, WorkspaceSession } from "./session.ts";
import type { WorkspaceId } from "./workspaceManager.ts";

export type SessionState = "created" | "restoring" | "active" | "saving" | "disposing" | "disposed";

const NEXT: Record<SessionState, readonly SessionState[]> = {
  created: ["restoring", "disposing"],
  restoring: ["active", "disposing"],
  active: ["saving", "disposing"],
  saving: ["active", "disposing"],
  disposing: ["disposed"],
  disposed: [],
};

export const canMoveSession = (from: SessionState, to: SessionState) => NEXT[from].includes(to);

export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionError";
  }
}

/** What the window holds now, from which a snapshot is made (nothing live is kept). */
export interface SessionParts {
  /** Open editor tabs, in order: the document key, its file, and whether it is a file on disk. */
  tabs: readonly { key: string; path: string; disk: boolean }[];
  /** The key of the tab in front. */
  active: string | null;
  explorer: { expanded: string[]; scroll: number; selected: string[]; focused: string | null };
  /** Where the editor was in a document, as the engine saved it (opaque, plain data). */
  viewState(key: string): unknown;
  layout: WindowLayout;
}

/** The most a session holds, matching the native caps (`session.rs`). */
export const MAX_SESSION_FILES = 50;

const identity = (path: string): ResourceId | null => {
  try {
    return resourceId(fileUri(path));
  } catch {
    return null;
  }
};

/**
 * The engine's view state (Monaco's `ICodeEditorViewState`, plain JSON) as a file view, or
 * null when it is not one. Only numbers are kept.
 */
export function fileViewOf(file: string, state: unknown): FileView | null {
  const raw = state as {
    cursorState?: {
      position?: { lineNumber?: unknown; column?: unknown };
      selectionStart?: { lineNumber?: unknown; column?: unknown };
      inSelectionMode?: unknown;
    }[];
    viewState?: {
      scrollLeft?: unknown;
      firstPosition?: { lineNumber?: unknown };
      firstPositionDeltaTop?: unknown;
    };
  } | null;
  const cursor = raw?.cursorState?.[0];
  const line = cursor?.position?.lineNumber;
  const column = cursor?.position?.column;
  const whole = (value: unknown): value is number =>
    typeof value === "number" && Number.isInteger(value) && value >= 1;
  if (!whole(line) || !whole(column)) return null;
  const view: FileView = {
    file,
    line,
    column,
    topLine: whole(raw?.viewState?.firstPosition?.lineNumber)
      ? raw.viewState.firstPosition.lineNumber
      : line,
    topDelta:
      typeof raw?.viewState?.firstPositionDeltaTop === "number"
        ? raw.viewState.firstPositionDeltaTop
        : 0,
    scrollLeft:
      typeof raw?.viewState?.scrollLeft === "number" && raw.viewState.scrollLeft >= 0
        ? raw.viewState.scrollLeft
        : 0,
  };
  const anchor = cursor?.selectionStart;
  if (
    whole(anchor?.lineNumber) &&
    whole(anchor?.column) &&
    (anchor.lineNumber !== line || anchor.column !== column)
  ) {
    view.anchorLine = anchor.lineNumber;
    view.anchorColumn = anchor.column;
  }
  return view;
}

/** A file view as the engine's view state, for the editor to restore when it shows the file. */
export function viewStateOf(view: FileView): unknown {
  const anchor = {
    lineNumber: view.anchorLine ?? view.line,
    column: view.anchorColumn ?? view.column,
  };
  return {
    cursorState: [
      {
        inSelectionMode: view.anchorLine !== undefined,
        selectionStart: anchor,
        position: { lineNumber: view.line, column: view.column },
      },
    ],
    viewState: {
      scrollLeft: view.scrollLeft,
      firstPosition: { lineNumber: view.topLine, column: 1 },
      firstPositionDeltaTop: view.topDelta,
    },
    contributionsState: {},
  };
}

/**
 * What to remember of the window now: serializable data only. Files are the open tabs that
 * are files on disk -- an untitled or proposed document has nothing to reopen, and its text
 * is DocumentService's -- one per resource however its path is spelled, in tab order.
 */
export function snapshotSession(
  owner: { folder: string; workspaceId: WorkspaceId },
  parts: SessionParts,
): WorkspaceSession {
  const seen = new Set<ResourceId>();
  const files: string[] = [];
  const keys = new Map<string, string>();
  for (const tab of parts.tabs) {
    if (!tab.disk) continue;
    const id = identity(tab.path);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    files.push(tab.path);
    keys.set(tab.path, tab.key);
    if (files.length >= MAX_SESSION_FILES) break;
  }
  const activeTab = parts.tabs.find((tab) => tab.key === parts.active);
  const activeId = activeTab ? identity(activeTab.path) : null;
  const active = activeId ? (files.find((file) => identity(file) === activeId) ?? null) : null;
  const views = files
    .map((file) => fileViewOf(file, parts.viewState(keys.get(file)!)))
    .filter((view): view is FileView => view !== null);
  return {
    folder: owner.folder,
    workspaceId: owner.workspaceId,
    files,
    active,
    expanded: [...parts.explorer.expanded],
    scroll: Number.isFinite(parts.explorer.scroll) ? Math.max(0, parts.explorer.scroll) : 0,
    selected: [...parts.explorer.selected],
    focused: parts.explorer.focused,
    views,
    layout: { ...parts.layout },
  };
}

/**
 * What to restore for a workspace: the saved record of its folder, if it is really this
 * workspace's (a record written for another workspace id is not), else nothing.
 */
export function savedFor(
  session: Session,
  folder: string,
  workspaceId: WorkspaceId,
): WorkspaceSession | null {
  const key = folderKey(folder);
  const saved = session.workspaces.find((state) => folderKey(state.folder) === key);
  if (!saved) return null;
  if (saved.workspaceId && saved.workspaceId !== workspaceId) return null;
  return saved;
}

export interface WorkspaceSessionHandle {
  readonly sessionId: string;
  readonly workspaceId: WorkspaceId;
  readonly folder: string;
  readonly generation: number;
  /** What was saved last time for this workspace; null for a first visit. */
  readonly saved: WorkspaceSession | null;
  state(): SessionState;
  /** Still the window's session, and not disposed. */
  isCurrent(): boolean;
  /**
   * Runs the restore. `live()` says whether its results may still be applied: false once
   * another session began or this one was disposed. Resolves to whether it completed as the
   * window's session (and is now active).
   */
  restore(work: (live: () => boolean) => Promise<void>): Promise<boolean>;
  /** Something the session remembers changed: saved (debounced) once the session is active. */
  markDirty(): void;
  /** Writes what is pending now. */
  flush(): Promise<void>;
  /** Saves what is pending and ends the session; nothing of it is applied or saved after. */
  dispose(): Promise<void>;
}

export interface SessionCoordinatorOptions {
  /** Persists one workspace's record (`save_workspace_session`). */
  write(state: WorkspaceSession): Promise<unknown>;
  /** The snapshot of the window now, for the session being saved. */
  snapshot(owner: { folder: string; workspaceId: WorkspaceId }): WorkspaceSession;
  /**
   * Told of every record as it is made (before the write), to keep the window's in-memory
   * session in step: a folder reopened later in the run comes back as it was a moment ago.
   */
  written?(state: WorkspaceSession): void;
  /** Debounce for saves (default 400 ms). */
  delay?: number;
}

/** The window's sessions: one at a time, the newest current. */
export function createSessionCoordinator(options: SessionCoordinatorOptions) {
  const delay = options.delay ?? 400;
  let generation = 0;
  let current: WorkspaceSessionHandle | null = null;

  function begin(input: {
    folder: string;
    workspaceId: WorkspaceId;
    saved: WorkspaceSession | null;
  }): WorkspaceSessionHandle {
    const previous = current;
    // The session left is saved as it was and ended before the new one exists.
    if (previous) void previous.dispose();
    const mine = ++generation;
    let state: SessionState = "created";
    let timer: ReturnType<typeof setTimeout> | null = null;
    let dirty = false;
    let writing: Promise<void> = Promise.resolve();
    const owner = { folder: input.folder, workspaceId: input.workspaceId };
    const saved =
      input.saved && (!input.saved.workspaceId || input.saved.workspaceId === input.workspaceId)
        ? input.saved
        : null;

    const move = (to: SessionState) => {
      if (!canMoveSession(state, to))
        throw new SessionError(`A session cannot go from ${state} to ${to}.`);
      state = to;
    };
    const live = () =>
      current === handle && mine === generation && state !== "disposing" && state !== "disposed";

    const write = (): Promise<void> => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (!dirty || (state !== "active" && state !== "disposing")) return writing;
      dirty = false;
      const record = options.snapshot(owner);
      options.written?.(record);
      const ending = state === "disposing";
      if (!ending) move("saving");
      writing = writing
        .then(() => options.write(record))
        // A failed save is not worth interrupting anyone over: the cost is reopening by hand.
        .then(
          () => undefined,
          () => undefined,
        )
        .finally(() => {
          if (state === "saving") move("active");
        });
      return writing;
    };

    const handle: WorkspaceSessionHandle = {
      sessionId: `session-${mine}`,
      workspaceId: input.workspaceId,
      folder: input.folder,
      generation: mine,
      saved,
      state: () => state,
      isCurrent: live,
      async restore(work) {
        if (state !== "created")
          throw new SessionError(`A session is restored once (it is ${state}).`);
        move("restoring");
        // Read through a call: the state moves under the awaits below.
        const now = (): SessionState => state;
        try {
          await work(() => live() && now() === "restoring");
        } finally {
          if (live() && now() === "restoring") move("active");
        }
        return now() === "active" && live();
      },
      markDirty() {
        if (state === "disposing" || state === "disposed") return;
        dirty = true;
        // Not while restoring: the window's state is half-built and must not replace the record.
        if (state !== "active" && state !== "saving") return;
        if (!timer) timer = setTimeout(() => void write(), delay);
      },
      flush: () => write(),
      async dispose() {
        if (state === "disposing" || state === "disposed") return writing;
        // Only a session that finished restoring has a state worth keeping.
        const keep = state === "active" || state === "saving";
        if (!keep) dirty = false;
        move("disposing");
        if (current === handle) current = null;
        await write();
        move("disposed");
      },
    };
    current = handle;
    return handle;
  }

  return {
    begin,
    current: () => current,
    /** Writes the current session's pending state (the window is going away). */
    flush: () => current?.flush() ?? Promise.resolve(),
  };
}

export type SessionCoordinator = ReturnType<typeof createSessionCoordinator>;
