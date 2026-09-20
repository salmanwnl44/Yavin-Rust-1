import type { Branch } from "../../services/git";
import { GitBranchIcon } from "../ui/Icons";

interface StatusBarProps {
  activeFile: string;
  onToggleTerminal: () => void;
  branch?: Branch;
}

export function StatusBar({ activeFile, onToggleTerminal, branch }: StatusBarProps) {
  const language = activeFile.endsWith(".tsx")
    ? "TypeScript React"
    : activeFile.endsWith(".ts")
      ? "TypeScript"
      : activeFile.endsWith(".rs")
        ? "Rust"
        : "Plain text";
  return (
    <footer className="flex h-6 items-center justify-between border-t border-[#151515] bg-black px-3 text-[11px] text-zinc-400">
      <div className="flex min-w-0 items-center gap-3">
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
        <span className="truncate">{activeFile || "Yavin IDE"}</span>
      </div>
      <div className="flex shrink-0 items-center gap-4">
        <span>UTF-8</span>
        <span>{language}</span>
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
