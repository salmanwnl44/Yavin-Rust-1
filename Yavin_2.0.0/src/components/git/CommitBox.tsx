import { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from "react";
import { CheckIcon } from "../ui/Icons";

export interface CommitBoxHandle {
  clear: () => void;
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
    stagedCount: number;
    conflictCount: number;
    busy: boolean;
    loading: boolean;
    onCommit: (message: string) => Promise<boolean>;
    onChange: (message: string) => void;
  }
>(function CommitBox(
  { draftKey, stagedCount, conflictCount, busy, loading, onCommit, onChange },
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

  useImperativeHandle(ref, () => ({ clear: () => update("", draftKey) }), [update, draftKey]);

  const canCommit = text.trim().length > 0 && stagedCount > 0 && conflictCount === 0;

  const commit = () => {
    if (!canCommit) return;
    void onCommit(text).then((ok) => ok && update("", draftKey));
  };

  return (
    <>
      <textarea
        aria-label="Commit message"
        placeholder="Message (Ctrl+Enter to commit)"
        rows={3}
        value={text}
        onChange={(e) => update(e.target.value, draftKey)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            e.preventDefault();
            if (!busy && !loading) commit();
          }
        }}
        className="w-full rounded border border-[#222222] bg-[#0a0a0a] p-2 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none resize-none transition-colors"
      />

      <button
        disabled={!canCommit}
        onClick={commit}
        className="w-full rounded bg-indigo-600 hover:bg-indigo-500 py-1.5 px-3 text-xs font-medium text-white flex items-center justify-center gap-1.5 transition-colors shadow-sm disabled:opacity-40 disabled:hover:bg-indigo-600"
      >
        <CheckIcon size={13} />
        <span>Commit Staged ({stagedCount})</span>
      </button>
    </>
  );
});
