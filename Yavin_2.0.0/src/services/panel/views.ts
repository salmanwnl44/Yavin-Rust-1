/**
 * The bottom panel's view list.
 *
 * The panel used to be the terminal with four placeholder tabs bolted on: the tab list was a
 * bare array and each body was an inline `activeTab === "..."` branch, so a new view meant
 * editing the panel component in four places. This module owns the list, its order and which
 * view is showing, so the panel component only has to render whatever it is told about.
 *
 * Order matches VS Code and Antigravity: Problems, Output, Debug Console, Terminal, Ports.
 */

export type PanelViewId = "problems" | "output" | "debug" | "terminal" | "ports";

export interface PanelView {
  id: PanelViewId;
  /** Shown in the tab strip. */
  label: string;
  /**
   * Kept mounted while another view is showing, rather than unmounted. The terminal must be:
   * its shells live in the component, and unmounting would kill the user's running processes.
   * Everything else is cheap to rebuild and is unmounted so it holds no timers when unseen.
   */
  keepMounted?: boolean;
}

export const PANEL_VIEWS: readonly PanelView[] = [
  { id: "problems", label: "PROBLEMS" },
  { id: "output", label: "OUTPUT" },
  { id: "debug", label: "DEBUG CONSOLE" },
  { id: "terminal", label: "TERMINAL", keepMounted: true },
  { id: "ports", label: "PORTS" },
];

const STORAGE_KEY = "yavin.panel.view";

const isPanelViewId = (value: unknown): value is PanelViewId =>
  typeof value === "string" && PANEL_VIEWS.some((view) => view.id === value);

/**
 * The view to show on open. VS Code remembers this across restarts, and so does this: someone
 * who lives in the terminal should not land on Problems every launch.
 */
export function readActiveView(): PanelViewId {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isPanelViewId(saved)) return saved;
  } catch {
    /* Storage unavailable: fall through to the default. */
  }
  return "terminal";
}

export function saveActiveView(id: PanelViewId): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* The choice still applies for this session. */
  }
}

/** Next/previous view, wrapping -- `workbench.action.nextPanelView` and its counterpart. */
export function stepView(current: PanelViewId, delta: 1 | -1): PanelViewId {
  const index = PANEL_VIEWS.findIndex((view) => view.id === current);
  const from = index === -1 ? 0 : index;
  const next = (from + delta + PANEL_VIEWS.length) % PANEL_VIEWS.length;
  return PANEL_VIEWS[next].id;
}
