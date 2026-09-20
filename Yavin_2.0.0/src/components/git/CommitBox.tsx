import { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from "react";
import type { ReactNode } from "react";
import { CheckIcon } from "../ui/Icons";

export interface CommitBoxHandle {
  clear: () => void;
  /** Commits with the current message, exactly as the Commit button would. */
  commit: () => void;
}

const draftStorageKey = (key: string) => `yavin.commit:${key}`;

/**
 * The commit-message editor and Commit button. Its text lives here, not in
 * `SourceControlPanel`: with the draft in the panel, every keystroke re-rendered
 * every changed-file row (measured 50 ms per keystroke at 1,000 files and 394 ms at
 * 10,000 in a production build). The panel only hears `onChange` and keeps a boolean
 * plus a ref, so typing re-renders this component alone.
 */
export const CommitBox = forwardRef<
  CommitBoxHandle,
  {
    /** Repository root the draft is stored under; `null` while none is active. */
    draftKey: string | null;
    /** Current branch name, shown in the placeholder like a VS Code-style SCM input. */
    branchName?: string;
    stagedCount: number;
    conflictCount: number;
    busy: boolean;
    loading: boolean;
    onCommit: (message: string) => Promise<boolean>;
    onChange: (message: string) => void;
    /** A dropdown trigger rendered attached to the right of the Commit button. */
    menu?: ReactNode;
  }
>(function CommitBox(
  { draftKey, branchName, stagedCount, conflictCount, busy, loading, onCommit, onChange, menu },
  ref,
) {
  const [text, setText] = useState("");

  const update = useCallback(
    (next: string, persistUnder: string | null) => {
      setText(next);
      onChange(next);
      if (!persistUnder) return;
      try {
        localStorage.setItem(draftStorageKey(persistUnder), next);
      } catch {
        /* The draft stays in memory when storage is unavailable. */
      }
    },
    [onChange],
  );

  // Switching repository swaps in that repository's own saved draft.
  useEffect(() => {
    if (!draftKey) return;
    let saved = "";
    try {
      saved = localStorage.getItem(draftStorageKey(draftKey)) ?? "";
    } catch {
      /* No saved draft is readable. */
    }
    setText(saved);
    onChange(saved);
  }, [draftKey, onChange]);

  const canCommit = text.trim().length > 0 && stagedCount > 0 && conflictCount === 0;

  const commit = () => {
    if (!canCommit) return;
    void onCommit(text).then((ok) => ok && update("", draftKey));
  };

  useImperativeHandle(
    ref,
    () => ({ clear: () => update("", draftKey), commit }),
    // `commit` closes over the current text and counts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [update, draftKey, text, stagedCount, conflictCount],
  );

  const hint = branchName ? ` on "${branchName}"` : "";

  return (
    <div className="space-y-1.5">
      <textarea
        aria-label="Commit message"
        placeholder={`Message (Ctrl+Enter to commit${hint})`}
        rows={2}
        value={text}
        onChange={(e) => update(e.target.value, draftKey)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            e.preventDefault();
            if (!busy && !loading) commit();
          }
        }}
        className="w-full rounded border border-border-strong bg-surface p-2 text-xs text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none resize-none transition-colors"
      />

      <div className="flex">
        <button
          disabled={!canCommit}
          onClick={commit}
          title={
            stagedCount === 0
              ? "Tick the files you want to include first"
              : conflictCount > 0
                ? "Resolve conflicts first"
                : text.trim()
                  ? `Commit ${stagedCount} staged file${stagedCount === 1 ? "" : "s"}`
                  : "Enter a commit message"
          }
          className={`flex-1 min-w-0 py-1.5 px-3 text-xs font-medium text-white flex items-center justify-center gap-1.5 bg-accent hover:bg-accent-hover transition-colors disabled:opacity-40 disabled:hover:bg-accent ${
            menu ? "rounded-l" : "rounded"
          }`}
        >
          <CheckIcon size={13} />
          <span>Commit</span>
          {stagedCount > 0 && (
            <span className="rounded-full bg-white/20 px-1.5 text-[10px] leading-4">
              {stagedCount}
            </span>
          )}
        </button>
        {menu && (
          <div className="flex border-l border-white/20 [&>div>button]:h-full [&>div>button]:rounded-l-none [&>div>button]:rounded-r [&>div>button]:px-1.5 [&>div>button]:bg-accent [&>div>button:hover]:bg-accent-hover [&>div>button]:text-white">
            {menu}
          </div>
        )}
      </div>
    </div>
  );
});
