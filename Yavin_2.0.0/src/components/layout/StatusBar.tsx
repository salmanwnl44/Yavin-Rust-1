import { useSyncExternalStore } from "react";
import { useActiveRepo, useRepoSnapshot } from "../../services/git";
import { GitBranchIcon } from "../ui/Icons";
import { problemCounts, problemsVersion, subscribeProblems } from "../../services/panel/problems";
import { describeCursor } from "../../services/cursorStatus";
import type { CursorStatusStore } from "../../services/cursorStatus";

interface StatusBarProps {
  activeFile: string;
  /** The document in front: encoding, line endings, language. */
  details?: string[];
  onToggleTerminal: () => void;
  /** Opens the Problems view, as clicking the count does in VS Code. */
  onShowProblems?: () => void;
  /** Whether the open folder is in Restricted Mode. */
  restricted?: boolean;
  onManageTrust?: () => void;
  /** The editor's cursor, read by the items that show it (see `CursorItems`). */
  cursorStatus?: CursorStatusStore;
  /** Opens Go to Line, as clicking the position does in VS Code. */
  onGoToLine?: () => void;
  /** The language server of the file in front: its state, and what clicking does. */
  languageStatus?: {
    text: string;
    title: string;
    tone: "normal" | "busy" | "warning" | "error";
    onClick?: () => void;
  };
}

/**
 * The cursor's position, the selection and the indentation. Subscribed here, in a component of
 * their own, so that a keystroke redraws these few items and not the status bar or the window.
 */
function CursorItems({ store, onGoToLine }: { store: CursorStatusStore; onGoToLine?: () => void }) {
  const status = useSyncExternalStore(store.subscribe, store.get, store.get);
  if (!status) return null;
  const { position, selection, indentation } = describeCursor(status);
  return (
    <>
      <button onClick={onGoToLine} title="Go to Line (Ctrl+G)" className="hover:text-zinc-200">
        {position}
        {selection && <span className="ml-1">{selection}</span>}
      </button>
      <span title="The indentation this file uses">{indentation}</span>
    </>
  );
}

/**
 * Subscribed to the active repository here rather than in `App`.
 *
 * The branch is the only thing the root component wanted from the repository snapshot, and
 * that snapshot changes on every field of every refresh -- loading on, data in, loading off
 * -- so reading it at the root re-rendered the entire window several times per poll for a
 * branch name that had not changed.
 */
export function StatusBar({
  activeFile,
  details,
  onToggleTerminal,
  onShowProblems,
  restricted,
  onManageTrust,
  cursorStatus,
  onGoToLine,
  languageStatus,
}: StatusBarProps) {
  useSyncExternalStore(subscribeProblems, problemsVersion, problemsVersion);
  const branch = useRepoSnapshot(useActiveRepo()?.store)?.branch;
  const counts = problemCounts();
  return (
    <footer className="flex h-6 items-center justify-between border-t border-[#151515] bg-black px-3 text-[11px] text-zinc-400">
      <div className="flex min-w-0 items-center gap-3">
        {/* Present only while restricted, so a trusted window carries no permanent badge --
            and it is the way back to the decision. */}
        {restricted && (
          <button
            onClick={onManageTrust}
            title="This folder is open in Restricted Mode. Click to manage trust."
            className="flex shrink-0 items-center gap-1 rounded bg-amber-500/15 px-1.5 text-amber-300 hover:bg-amber-500/25"
          >
            Restricted Mode
          </button>
        )}
        {(branch?.name || branch?.detached) && (
          <span
            className="flex items-center gap-1 shrink-0"
            title={
              branch.detached
                ? "HEAD is detached (not on a branch)"
                : branch.upstream
                  ? `Tracking ${branch.upstream}`
                  : branch.name
            }
          >
            <GitBranchIcon size={12} />
            {branch.detached ? "Detached HEAD" : branch.name}
            {(branch.ahead > 0 || branch.behind > 0) && (
              <span className="font-mono">
                ↑{branch.ahead} ↓{branch.behind}
              </span>
            )}
          </span>
        )}
        {/* Errors and warnings, clicking through to the Problems view -- but only once a
            checker has run, so an empty bar does not imply a clean build that never happened. */}
        {(counts.error > 0 || counts.warning > 0) && (
          <button
            onClick={onShowProblems}
            title={`${counts.error} error${counts.error === 1 ? "" : "s"}, ${counts.warning} warning${counts.warning === 1 ? "" : "s"}`}
            className="flex shrink-0 items-center gap-1.5 hover:text-zinc-200"
          >
            <span className={counts.error ? "text-red-400" : ""}>× {counts.error}</span>
            <span className={counts.warning ? "text-amber-400" : ""}>! {counts.warning}</span>
          </button>
        )}
        <span className="truncate">{activeFile || "Yavin IDE"}</span>
      </div>
      <div className="flex shrink-0 items-center gap-4">
        {cursorStatus && <CursorItems store={cursorStatus} onGoToLine={onGoToLine} />}
        {languageStatus && (
          <button
            onClick={languageStatus.onClick}
            title={languageStatus.title}
            aria-label={`Language server: ${languageStatus.text}`}
            className={`flex items-center gap-1 hover:text-zinc-200 ${
              languageStatus.tone === "error"
                ? "text-red-400"
                : languageStatus.tone === "warning"
                  ? "text-amber-400"
                  : ""
            }`}
          >
            <span aria-hidden="true">
              {languageStatus.tone === "busy"
                ? "◌"
                : languageStatus.tone === "normal"
                  ? "{ }"
                  : "⚠"}
            </span>
            {languageStatus.text}
          </button>
        )}
        {details?.map((detail) => (
          <span key={detail}>{detail}</span>
        ))}
        <button
          onClick={onToggleTerminal}
          title="Show or hide the terminal panel"
          className="hover:text-zinc-200"
        >
          Terminal
        </button>
      </div>
    </footer>
  );
}
