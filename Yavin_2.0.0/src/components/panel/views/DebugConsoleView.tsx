import { EmptyView } from "./EmptyView";

/**
 * A debug console shows one thing: the output and evaluation results of a running debug
 * session, delivered by a debug adapter. Yavin has no debug adapter, so there is nothing
 * honest to put here -- VS Code's own console is likewise empty outside a session.
 *
 * The view exists so the panel's shape matches the reference and so a future adapter has an
 * obvious home, and it says plainly that the capability is absent rather than implying a
 * connection that failed.
 */
export function DebugConsoleView() {
  return (
    <EmptyView
      label="Debug Console"
      message="Yavin does not run a debugger yet, so there is no debug session to report. This view will show a session's output and evaluate expressions once one can be started."
    />
  );
}
