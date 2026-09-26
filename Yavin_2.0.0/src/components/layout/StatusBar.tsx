import { useSyncExternalStore } from "react";
import { useActiveRepo, useRepoSnapshot } from "../../services/git";
import { GitBranchIcon } from "../ui/Icons";
import { problemCounts, problemsVersion, subscribeProblems } from "../../services/panel/problems";

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
