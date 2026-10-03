/**
 * How a workspace's terminals are shown (TERMINAL-04): the renderer's view state, apart from
 * the sessions themselves.
 *
 * ```text
 * TerminalService (sessions: identity, state, lifecycle)    <- the canonical owner
 *        ^ reads, commands
 * TerminalUi (view state: panes, focus, split, zoom, find,  <- this module, one per workspace
 *             bells, notices, matches; mounted views)
 *        ^ renders
 * TerminalPanel (tabs, layout) / TerminalView (one xterm)
 * ```
 *
 * It holds no session state of its own -- which sessions exist, and how they are, is always the
 * service's -- only which of them are on screen and how. Whenever the service's sessions change,
 * the panes are reconciled, so a pane never names a session that does not exist and the two
 * panes of a split never name the same one. It outlives the panel (one per workspace, for the
 * window), so leaving a workspace and coming back finds its terminals laid out as they were.
 *
 * The menus, the Explorer and the panel act on terminals through it -- explicitly, on this
 * workspace's terminals -- rather than through a window-wide message channel.
 */
import {
  DEFAULT_FONT_SIZE,
  nextTerminalName,
  zoomFontSize,
  type TerminalKeyAction,
} from "./terminal.ts";
import type { TerminalId } from "./terminalProtocol.ts";
import type { TerminalService } from "./terminalService.ts";
import type { WorkspaceProfiles } from "./terminalProfiles.ts";
import { TerminalError } from "./terminalProtocol.ts";
import {
  describeShell,
  shellIntegrationHint,
  type ShellIntegrationHint,
  type TerminalShellState,
} from "./terminalShell.ts";

export type Pane = "primary" | "secondary";

/** What a mounted terminal view lets the panel and the menus do to it. */
export interface TerminalViewHandle {
  focus(): void;
  clear(): void;
  search(
    query: string,
    direction: "next" | "previous",
    settings: { caseSensitive: boolean; regex: boolean },
  ): void;
  endSearch(): void;
  copySelection(): void;
  paste(): void;
  selectAll(): void;
  hasSelection(): boolean;
}

export interface TerminalUiState {
  /** The session in the left (or only) pane. */
  readonly primary: TerminalId | null;
  /** The session in the right pane, when split; never the same as `primary`. */
  readonly secondary: TerminalId | null;
  /** Which pane the user is working in; always "primary" when not split. */
  readonly focused: Pane;
  readonly splitRatio: number;
  readonly fontSize: number;
  /** The find bar is open; `findRequest` changes each time it is asked for. */
  readonly finding: boolean;
  readonly findRequest: number;
  /** Terminals that rang while not on screen. */
  readonly bells: ReadonlySet<TerminalId>;
  /** A message about one terminal (the clipboard refused, input failed); never another's. */
  readonly notices: ReadonlyMap<TerminalId, string>;
  /** Each terminal's own search results. */
  readonly matches: ReadonlyMap<TerminalId, { index: number; count: number }>;

  /** Why no shell can be offered (no desktop application, detection failed). */
}

export interface TerminalUi {
  readonly service: TerminalService;
  getSnapshot(): TerminalUiState;
  subscribe(listener: () => void): () => void;
  /** The terminal the user is working in: the focused pane's. */
  focusedId(): TerminalId | null;
  /** The workspace's profiles (TERMINAL-05): how its terminals can be started. */
  readonly profiles: WorkspaceProfiles;
  /** Learns the machine's shells (discovery), once. */
  loadProfiles(): void;

  /** Starts a terminal (the first shell unless one is named) and shows it in the focused pane. */
  /**
   * Starts a terminal with a profile -- the one named, else the default chain (see
   * `WorkspaceProfiles.resolve`) -- and shows it in the focused pane. A profile asked for by
   * name that cannot launch throws its `TerminalError`; nothing is started.
   */
  newTerminal(options?: { profileId?: string; cwd?: string; show?: boolean }): TerminalId;
  /** Shows `id` -- focusing its pane if it is on screen, else in the focused pane. */
  activate(id: TerminalId): void;
  focusPane(pane: Pane): void;
  /** Moves the focused pane through the terminals, skipping the one in the other pane. */
  stepTerminal(delta: 1 | -1): void;
  stepPane(): void;
  /** Splits (a second terminal beside the first) or, if split, collapses to one pane. */
  toggleSplit(): void;
  setSplitRatio(ratio: number): void;
  close(id: TerminalId): void;
  closeAll(): void;
  rename(id: TerminalId, title: string): void;
  restart(id: TerminalId): void;
  zoom(action: TerminalKeyAction): void;
  openFind(): void;
  closeFind(): void;
  setMatches(id: TerminalId, matches: { index: number; count: number }): void;
  ring(id: TerminalId): void;
  notice(id: TerminalId, message: string | null): void;

  /** A mounted view; the returned function unregisters it (only if it is still that view). */
  registerView(id: TerminalId, handle: TerminalViewHandle): () => void;
  viewOf(id: TerminalId): TerminalViewHandle | undefined;
}

export function createTerminalUi(
  service: TerminalService,
  profiles: WorkspaceProfiles,
): TerminalUi {
  const listeners = new Set<() => void>();
  const views = new Map<TerminalId, TerminalViewHandle>();
  let state: TerminalUiState = Object.freeze({
    primary: null,
    secondary: null,
    focused: "primary" as Pane,
    splitRatio: 0.5,
    fontSize: DEFAULT_FONT_SIZE,
    finding: false,
    findRequest: 0,
    bells: new Set<TerminalId>(),
    notices: new Map<TerminalId, string>(),
    matches: new Map<TerminalId, { index: number; count: number }>(),
  });

  const sessionIds = () => service.getSnapshot().sessions.map((session) => session.sessionId);

  /** The panes made consistent with the sessions that exist. */
  const reconcile = (next: TerminalUiState): TerminalUiState => {
    const ids = sessionIds();
    const exists = (id: TerminalId | null): id is TerminalId => id !== null && ids.includes(id);
    let primary = exists(next.primary) ? next.primary : null;
    let secondary = exists(next.secondary) && next.secondary !== primary ? next.secondary : null;
    // The left pane went: the right one takes its place, and the split collapses.
    if (primary === null && secondary !== null) {
      primary = secondary;
      secondary = null;
    }
    if (primary === null) primary = ids.at(-1) ?? null;
    const focused: Pane = secondary === null ? "primary" : next.focused;
    const keep = <V>(map: ReadonlyMap<TerminalId, V>) =>
      [...map.keys()].every((id) => ids.includes(id))
        ? map
        : new Map([...map].filter(([id]) => ids.includes(id)));
    const bells = [...next.bells].every((id) => ids.includes(id))
      ? next.bells
      : new Set([...next.bells].filter((id) => ids.includes(id)));
    return {
      ...next,
      primary,
      secondary,
      focused,
      bells,
      notices: keep(next.notices),
      matches: keep(next.matches),
    };
  };

  const set = (patch: Partial<TerminalUiState>) => {
    const next = reconcile({ ...state, ...patch });
    const same = (Object.keys(next) as (keyof TerminalUiState)[]).every(
      (key) => next[key] === state[key],
    );
    if (same) return;
    state = Object.freeze(next);
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        /* One listener's failure is not the others'. */
      }
    }
  };

  // Sessions come and go in the service (closed here, exited, another view's action): the
  // panes follow.
  service.subscribe(() => set({}));

  const focusedId = () => (state.focused === "secondary" ? state.secondary : state.primary);

  /** Puts `id` in the focused pane (never making the two panes the same session). */
  const show = (id: TerminalId) => {
    if (id === state.primary) return set({ focused: "primary" });
    if (id === state.secondary) return set({ focused: "secondary" });
    if (state.focused === "secondary" && state.secondary !== null) set({ secondary: id });
    else set({ primary: id });
  };

  const unring = (id: TerminalId | null) => {
    if (id === null || !state.bells.has(id)) return;
    const bells = new Set(state.bells);
    bells.delete(id);
    set({ bells });
  };

  const ui: TerminalUi = {
    service,
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    focusedId,

    profiles,
    loadProfiles() {
      profiles.load();
    },

    newTerminal(options = {}) {
      let profile = null;
      let integration: ShellIntegrationHint | undefined;
      try {
        const entry = profiles.resolve(options.profileId);
        profile = entry.profile;
        integration = shellIntegrationHint(entry.kind, entry.profile.executable);
      } catch (error) {
        // A profile asked for by name is never swapped for another.
        if (options.profileId !== undefined) throw error;
        // With none asked for and none launchable (no shell found, or no native side at all),
        // the terminal still opens: the native side says why, in its own typed error.
        if (!(error instanceof TerminalError)) throw error;
      }
      const id = service.open({
        title: nextTerminalName(
          service.getSnapshot().sessions.map((session) => session.title),
          profile?.name ?? "Terminal",
        ),
        profile,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(integration ? { integration } : {}),
      });
      if (options.show !== false) show(id);
      else set({});
      return id;
    },

    activate(id) {
      show(id);
      unring(id);
    },
    focusPane(pane) {
      if (pane === "secondary" && state.secondary === null) return;
      set({ focused: pane });
      unring(focusedId());
    },
    stepTerminal(delta) {
      const other = state.focused === "secondary" ? state.primary : state.secondary;
      const ids = sessionIds().filter((id) => id !== other);
      if (ids.length < 2) return;
      const at = ids.indexOf(focusedId() as TerminalId);
      ui.activate(ids[((at === -1 ? 0 : at) + delta + ids.length) % ids.length]);
      views.get(focusedId() as TerminalId)?.focus();
    },
    stepPane() {
      if (state.secondary === null) return;
      ui.focusPane(state.focused === "primary" ? "secondary" : "primary");
      views.get(focusedId() as TerminalId)?.focus();
    },
    toggleSplit() {
      if (state.secondary !== null) return set({ secondary: null, focused: "primary" });
      if (state.primary === null) ui.newTerminal();
      const other =
        sessionIds()
          .filter((id) => id !== state.primary)
          .at(-1) ?? ui.newTerminal({ show: false });
      set({ secondary: other, focused: "primary" });
    },
    setSplitRatio(ratio) {
      set({ splitRatio: Math.max(0.2, Math.min(ratio, 0.8)) });
    },
    close(id) {
      views.delete(id);
      void service.close(id).catch(() => undefined);
    },
    closeAll() {
      for (const id of sessionIds()) ui.close(id);
    },
    rename(id, title) {
      service.rename(id, title);
    },
    restart(id) {
      views.get(id)?.clear();
      service.restart(id);
    },
    zoom(action) {
      set({ fontSize: zoomFontSize(state.fontSize, action) });
    },
    openFind() {
      set({ finding: true, findRequest: state.findRequest + 1 });
    },
    closeFind() {
      set({ finding: false });
    },
    setMatches(id, matches) {
      const current = state.matches.get(id);
      if (current && current.index === matches.index && current.count === matches.count) return;
      set({ matches: new Map(state.matches).set(id, matches) });
    },
    ring(id) {
      // Only a terminal that is not in front is worth marking.
      if (id === focusedId() || state.bells.has(id)) return;
      set({ bells: new Set(state.bells).add(id) });
    },
    notice(id, message) {
      if ((state.notices.get(id) ?? null) === message) return;
      const notices = new Map(state.notices);
      if (message === null) notices.delete(id);
      else notices.set(id, message);
      set({ notices });
    },

    registerView(id, handle) {
      views.set(id, handle);
      return () => {
        if (views.get(id) === handle) views.delete(id);
      };
    },
    viewOf: (id) => views.get(id),
  };
  return ui;
}

/** The status line's message for one terminal: its own notice, else its state. */
export function statusOf(
  ui: TerminalUiState,
  session:
    | {
        sessionId: TerminalId;
        state: string;
        error: string | null;
        shell?: TerminalShellState;
      }
    | undefined,
): string {
  if (!session) return "";
  const notice = ui.notices.get(session.sessionId);
  if (notice) return notice;
  if (session.state === "Running") {
    // What the shell itself reported (TERMINAL-05A), when it reports anything.
    const shell = session.shell && describeShell(session.shell);
    return shell ? `Running · ${shell}` : "Running";
  }
  if (session.state === "Failed") return session.error ?? "The terminal failed.";
  return "";
}
