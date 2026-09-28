import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

/** The browser's wording for a script module that could not be fetched. */
const LOAD_FAILURE =
  /dynamically imported module|Importing a module script failed|Unable to preload CSS/i;

/**
 * Contains a failure of the code editor -- its code failing to load, or Monaco failing to
 * start -- to the editor area.
 *
 * Without it the failure reached the window's own boundary, which replaces the whole window:
 * the tabs, the menus and Save with it, while documents with unsaved edits were still open.
 * Here everything around the editor keeps working (Save and Save All do not need the editor).
 *
 * The two failures recover differently. Monaco failing to start is retried by starting it
 * again. Code that failed to load cannot be: the browser keeps the failed module and fails
 * every later import of it at once, so only reloading the window loads it -- after saving,
 * because a reload drops what is only in memory.
 */
export class EditorBoundary extends Component<
  { children: ReactNode; onRetry: () => void },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("The editor failed:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const notLoaded = LOAD_FAILURE.test(error.message);
    const button = "rounded bg-indigo-600 px-3 py-1 text-white hover:bg-indigo-500";
    return (
      <div
        role="alert"
        className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-xs text-zinc-400"
      >
        <p className="text-sm text-zinc-200">
          {notLoaded ? "The editor's code could not be loaded." : "The editor could not start."}
        </p>
        <p className="max-w-md font-mono text-[11px] text-zinc-500">{error.message}</p>
        <p className="max-w-md">
          {notLoaded
            ? "Open documents and their unsaved changes are kept. Save them (File › Save All), then reload the window to load the editor again."
            : "Open documents and their unsaved changes are kept; File › Save still saves them."}
        </p>
        {notLoaded ? (
          <button onClick={() => window.location.reload()} className={button}>
            Reload Window
          </button>
        ) : (
          <button
            onClick={() => {
              this.setState({ error: null });
              this.props.onRetry();
            }}
            className={button}
          >
            Retry
          </button>
        )}
      </div>
    );
  }
}
