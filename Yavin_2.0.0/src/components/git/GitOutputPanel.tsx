import { useSyncExternalStore, useState } from "react";
import {
  clearGitLog,
  formatGitLogEntry,
  gitLogSnapshot,
  subscribeGitLog,
} from "../../services/git/outputLog";
import type { GitLogEntry } from "../../services/git/outputLog";
import { CloseIcon, CopyIcon, TrashIcon } from "../ui/Icons";

/** Failures are what anyone opens this view for, so they can be isolated from the noise. */
function isFailure(entry: GitLogEntry): boolean {
  return entry.code !== undefined && entry.code !== 0;
}

export function GitOutputPanel({ onClose }: { onClose: () => void }) {
  const entries = useSyncExternalStore(subscribeGitLog, gitLogSnapshot, gitLogSnapshot);
  const [failuresOnly, setFailuresOnly] = useState(false);
  const [copied, setCopied] = useState(false);

  const shown = failuresOnly ? entries.filter(isFailure) : entries;
  const failureCount = entries.filter(isFailure).length;

  const copyAll = () => {
    const text = shown
      .map((entry) => formatGitLogEntry(entry) + (entry.stderr ? `\n  ${entry.stderr}` : ""))
      .join("\n");
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      // Clipboard access is refused outside a secure context; say so rather than
      // appearing to have copied.
      () => setCopied(false),
    );
  };

  return (
    <section aria-label="Git Output" className="flex h-full flex-col bg-black min-w-0">
      <div className="flex items-center gap-2 border-b border-border px-3 h-9 shrink-0">
        <h2 className="text-[12px] font-semibold text-ink">Git Output</h2>
        <span className="text-[11px] text-ink-3">
          {entries.length} command{entries.length === 1 ? "" : "s"}
          {failureCount > 0 && `, ${failureCount} failed`}
        </span>
        <div className="flex-1" />
        <button
          onClick={() => setFailuresOnly((v) => !v)}
          aria-pressed={failuresOnly}
          className={`rounded px-2 py-0.5 text-[11px] ${
            failuresOnly
              ? "bg-accent text-white"
              : "text-ink-3 hover:bg-surface-hover hover:text-ink"
          }`}
        >
          Failures only
        </button>
        <button
          onClick={copyAll}
          title="Copy the shown commands to the clipboard"
          className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-ink-3 hover:bg-surface-hover hover:text-ink"
        >
          <CopyIcon size={11} />
          {copied ? "Copied" : "Copy"}
        </button>
        <button
          onClick={() => clearGitLog()}
          title="Clear the Git output log"
          className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-ink-3 hover:bg-surface-hover hover:text-ink"
        >
          <TrashIcon size={11} />
          Clear
        </button>
        <button
          onClick={onClose}
          title="Close Git Output"
          aria-label="Close Git Output"
          className="rounded p-1 text-ink-3 hover:bg-surface-hover hover:text-ink"
        >
          <CloseIcon size={12} />
        </button>
      </div>

      <div className="flex-1 overflow-auto p-2 font-mono text-[11px] leading-relaxed">
        {shown.length === 0 ? (
          <p className="p-3 text-ink-3">
            {entries.length === 0
              ? "No Git commands have run yet."
              : "No failed Git commands. Every command so far exited cleanly."}
          </p>
        ) : (
          <ul>
            {shown.map((entry) => (
              <li key={entry.id} className="whitespace-pre-wrap break-all py-0.5">
                <span className={isFailure(entry) ? "text-red-400" : "text-ink-2"}>
                  {formatGitLogEntry(entry)}
                </span>
                {entry.inputBytes > 0 && (
                  <span className="text-ink-3"> · {entry.inputBytes} bytes on stdin</span>
                )}
                {entry.stderr && <div className="pl-4 text-amber-400/80">{entry.stderr}</div>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
