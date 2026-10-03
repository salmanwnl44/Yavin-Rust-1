/**
 * React's view of the workspace's terminals (TERMINAL-04). The service and the UI are the
 * workspace's -- made once per WorkspaceId, never by a component -- and these hooks only
 * subscribe to their state. Terminal output never passes through here: it goes from a session
 * straight to its view's xterm.
 */
import { useSyncExternalStore } from "react";
import { useWorkspace } from "./workspaces.ts";
import type { TerminalService, TerminalSessionView } from "./terminalService.ts";
import type { TerminalUi, TerminalUiState } from "./terminalUi.ts";
import type { TerminalId } from "./terminalProtocol.ts";

/** The TerminalService of the workspace in the window. */
export function useTerminalService(): TerminalService {
  return useWorkspace().services.terminals;
}

/** The terminal UI (view state and commands) of the workspace in the window. */
export function useTerminalUi(): TerminalUi {
  return useWorkspace().services.terminalUi;
}

/** The workspace's sessions, re-rendering only when one of them changes state. */
export function useTerminalSessions(service: TerminalService): readonly TerminalSessionView[] {
  const snapshot = () => service.getSnapshot().sessions;
  return useSyncExternalStore(service.subscribe, snapshot, snapshot);
}

/** One session, or `undefined` once it is gone. */
export function useTerminalSession(
  service: TerminalService,
  id: TerminalId | null,
): TerminalSessionView | undefined {
  const snapshot = () => (id === null ? undefined : service.get(id));
  return useSyncExternalStore(service.subscribe, snapshot, snapshot);
}

/** The terminal UI's view state. */
export function useTerminalUiState(ui: TerminalUi): TerminalUiState {
  return useSyncExternalStore(ui.subscribe, ui.getSnapshot, ui.getSnapshot);
}
