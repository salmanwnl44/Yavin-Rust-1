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
    /** Tracked files with working-tree changes. With nothing staged, these are what a commit
     * would stage itself (`-a`), which is what makes the button usable in that state. */
    modifiedCount: number;
    conflictCount: number;
    busy: boolean;
    loading: boolean;
    onCommit: (message: string) => Promise<boolean>;
    onChange: (message: string) => void;
    /** A dropdown trigger rendered attached to the right of the Commit button. */
    menu?: ReactNode;
  }
>(function CommitBox(
  {
    draftKey,
    branchName,
    stagedCount,
    modifiedCount,
    conflictCount,
    busy,
    loading,
    onCommit,
    onChange,
    menu,
  },
  ref,
) {
  const [text, setText] = useState("");

  const update = useCallback(
    (next: string, persistUnder: string | null) => {
      setText(next);
      onChange(next);
      if (!persistUnder) return;
      try {
        // An empty draft is removed rather than stored as "". Every repository ever opened
        // otherwise left a permanent empty key behind, and the common case -- commit, which
        // clears the box -- is exactly when the entry stops being worth anything.
        if (next) localStorage.setItem(draftStorageKey(persistUnder), next);
        else localStorage.removeItem(draftStorageKey(persistUnder));
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

  // With nothing staged, a commit stages every tracked change itself (`-a`) -- the same thing
  // this button's own dropdown "Commit" does, and what VS Code's does. Requiring something
  // staged first meant the button and the dropdown item beside it, both labelled "Commit",
  // disagreed about whether the action was available at all.
  const willCommitAll = stagedCount === 0;
  const commitCount = willCommitAll ? modifiedCount : stagedCount;
  const canCommit = text.trim().length > 0 && commitCount > 0 && conflictCount === 0;

  const commit = () => {
    if (!canCommit) return;
    void onCommit(text).then((ok) => ok && update("", draftKey));
  };

  useImperativeHandle(
    ref,
    () => ({ clear: () => update("", draftKey), commit }),
    // `commit` closes over the current text and counts -- `modifiedCount` included, since
    // that is what decides whether a commit is possible with nothing staged.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [update, draftKey, text, stagedCount, modifiedCount, conflictCount],
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
            conflictCount > 0
              ? "Resolve conflicts first"
              : commitCount === 0
                ? "Nothing to commit"
                : !text.trim()
                  ? "Enter a commit message"
                  : willCommitAll
                    ? `Commit all ${commitCount} changed file${commitCount === 1 ? "" : "s"} (nothing is staged)`
                    : `Commit ${commitCount} staged file${commitCount === 1 ? "" : "s"}`
          }
          className={`flex-1 min-w-0 py-1.5 px-3 text-xs font-medium text-white flex items-center justify-center gap-1.5 bg-accent hover:bg-accent-hover transition-colors disabled:opacity-40 disabled:hover:bg-accent ${
            menu ? "rounded-l" : "rounded"
          }`}
        >
          <CheckIcon size={13} />
          <span>{willCommitAll && commitCount > 0 ? "Commit All" : "Commit"}</span>
          {commitCount > 0 && (
            <span className="rounded-full bg-white/20 px-1.5 text-[10px] leading-4">
              {commitCount}
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
