import { EmptyView } from "./EmptyView";

/**
 * Diagnostics for the workspace.
 *
 * Yavin has no language server, so these will come the way VS Code's non-LSP diagnostics do:
 * by running a compiler or linter as a process and parsing its output into diagnostics keyed
 * by an owner. Until that runner exists this view has nothing to show, and says so.
 */
export function ProblemsView() {
  return (
    <EmptyView
      label="Problems"
      message="No problems have been reported. Yavin collects diagnostics by running your project's compiler or linter and reading its output; no such tool has run yet."
    />
  );
}
