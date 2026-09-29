import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { ReactNode } from "react";
import { CheckIcon } from "../ui/Icons";

export interface CommitBoxHandle {
  clear: () => void;
  /** Commits with the current message, exactly as the Commit button would. */
  commit: () => void;
}

export interface CommitOptions {
  /** Replace the last commit (its message, and whatever is staged) instead of adding one. */
  amend: boolean;
  /** Add a `Signed-off-by` trailer. */
  signoff: boolean;
}

const draftStorageKey = (key: string) => `yavin.commit:${key}`;
/** The tallest the message box grows before it scrolls, in lines. */
const MAX_LINES = 10;

/**
 * The commit message and the Commit button. Its text lives here, not in
 * `SourceControlPanel`: with the draft in the panel, every keystroke re-rendered every changed
 * file row (measured 50 ms per keystroke at 1,000 files, 394 ms at 10,000). The panel only
 * hears `onChange` and keeps a boolean plus a ref, so typing re-renders this component alone.
 *
 * The button says what it will do -- "Commit 2 staged", "Commit all 5", "Amend last commit" --
 * and the two options people reach for most, Amend and Sign off, are checkboxes beside it
 * rather than items three levels into a menu. The draft is kept per repository.
 */
export const CommitComposer = forwardRef<
  CommitBoxHandle,
  {
    /** Repository root the draft is stored under; `null` while none is active. */
    draftKey: string | null;
    /** Current branch name, shown in the placeholder. */
    branchName?: string;
    stagedCount: number;
    /** Tracked files with working-tree changes: what a commit with nothing staged takes (`-a`). */
    modifiedCount: number;
    conflictCount: number;
    busy: boolean;
    loading: boolean;
    onCommit: (message: string, options: CommitOptions) => Promise<boolean>;
    onChange: (message: string) => void;
    /** A dropdown trigger rendered attached to the right of the Commit button. */
    menu?: ReactNode;
  }
>(function CommitComposer(
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
  const [options, setOptions] = useState<CommitOptions>({ amend: false, signoff: false });
  const box = useRef<HTMLTextAreaElement>(null);

  const update = useCallback(
    (next: string, persistUnder: string | null) => {
      setText(next);
      onChange(next);
      if (!persistUnder) return;
      try {
        // An empty draft is removed rather than stored as "": committing clears the box, and
        // every repository ever opened would otherwise leave an empty key behind.
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
    setOptions({ amend: false, signoff: false });
  }, [draftKey, onChange]);

  // The box grows with the message, up to a limit, then scrolls.
  useEffect(() => {
    const element = box.current;
    // A hidden panel has nothing to measure: its first real layout measures it instead.
    if (!element || !element.offsetParent) return;
    element.style.height = "auto";
    const line = parseFloat(getComputedStyle(element).lineHeight) || 16;
    const padding = 16;
    const height = Math.min(
      Math.max(element.scrollHeight, line * 2 + padding),
      line * MAX_LINES + padding,
    );
    element.style.height = `${height}px`;
  }, [text]);

  // With nothing staged, a commit takes every tracked change (`-a`), as the dropdown's Commit
  // does. Amending needs nothing staged at all: it can change the message alone.
  const willCommitAll = stagedCount === 0;
  const commitCount = willCommitAll ? modifiedCount : stagedCount;
  const canCommit =
    text.trim().length > 0 && conflictCount === 0 && (options.amend || commitCount > 0);

  const commit = () => {
    if (!canCommit) return;
    void onCommit(text, options).then((ok) => {
      if (!ok) return;
      update("", draftKey);
      setOptions((current) => ({ ...current, amend: false }));
    });
  };

  useImperativeHandle(
    ref,
    () => ({ clear: () => update("", draftKey), commit }),
    // `commit` closes over the current text, options and counts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [update, draftKey, text, options, stagedCount, modifiedCount, conflictCount],
  );

  const label = options.amend
    ? "Amend last commit"
    : commitCount === 0
      ? "Commit"
      : willCommitAll
        ? `Commit all ${commitCount}`
        : `Commit ${commitCount} staged`;
  const reason =
    conflictCount > 0
      ? "Resolve conflicts first"
      : !options.amend && commitCount === 0
        ? "Nothing to commit"
        : !text.trim()
          ? "Enter a commit message"
          : options.amend
            ? "Replace the last commit with this message and whatever is staged"
            : willCommitAll
              ? `Commit all ${commitCount} changed file${commitCount === 1 ? "" : "s"} (nothing is staged)`
              : `Commit ${commitCount} staged file${commitCount === 1 ? "" : "s"}`;
  const hint = branchName ? ` on "${branchName}"` : "";

  return (
    <div className="space-y-1.5">
      <textarea
        ref={box}
        aria-label="Commit message"
        placeholder={`Message (Ctrl+Enter to commit${hint})`}
        rows={2}
        value={text}
        onChange={(event) => update(event.target.value, draftKey)}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            if (!busy && !loading) commit();
          }
        }}
        className="block w-full resize-none rounded-md border border-border-strong bg-surface px-2.5 py-2 text-xs leading-4 text-ink placeholder:text-ink-3 transition-colors focus:border-accent focus:outline-none"
      />

      <div className="flex">
        <button
          disabled={!canCommit}
          onClick={commit}
          title={reason}
          className={`flex min-w-0 flex-1 items-center justify-center gap-1.5 bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-40 disabled:hover:bg-accent ${
            menu ? "rounded-l-md" : "rounded-md"
          }`}
        >
          <CheckIcon size={13} className="shrink-0" />
          <span className="truncate">{label}</span>
        </button>
        {menu && (
          <div className="flex border-l border-white/20 [&>div>button]:h-full [&>div>button]:rounded-l-none [&>div>button]:rounded-r-md [&>div>button]:bg-accent [&>div>button]:px-1.5 [&>div>button]:text-white [&>div>button:hover]:bg-accent-hover">
            {menu}
          </div>
        )}
      </div>

      <div className="flex items-center gap-3 px-0.5 text-[11px] text-ink-3">
        {(
          [
            ["amend", "Amend", "Replace the last commit instead of adding a new one"],
            ["signoff", "Sign off", "Add a Signed-off-by line with your name and email"],
          ] as const
        ).map(([key, text, title]) => (
          <label
            key={key}
            title={title}
            className="flex cursor-pointer items-center gap-1.5 hover:text-ink-2"
          >
            <input
              type="checkbox"
              checked={options[key]}
              onChange={(event) =>
                setOptions((current) => ({ ...current, [key]: event.target.checked }))
              }
              className="size-3 accent-[var(--color-accent)]"
            />
            {text}
          </label>
        ))}
      </div>
    </div>
  );
});
