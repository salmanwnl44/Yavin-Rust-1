import { useEffect, useMemo, useRef, useState } from "react";

export interface DialogOption {
  value: string;
  label: string;
  description?: string;
}

export interface DialogRequest {
  title: string;
  message?: string;
  /** A free-text prompt (New File, Go to Line, …). Mutually exclusive with `options`. */
  input?: string;
  /**
   * A filterable, keyboard-navigable list of choices (pick a remote, a branch, a stash, …)
   * instead of free text. Choosing one calls `submit` with that option's `value` immediately --
   * there is no separate confirm step, matching a quick-pick rather than a form field.
   */
  options?: DialogOption[];
  submit?: (value: string) => void | Promise<void>;
  confirmLabel?: string;
  afterClose?: () => void;
}

export function AppDialog({ request, onClose }: { request: DialogRequest; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(request.input ?? "");
  const [filter, setFilter] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const filtered = useMemo(() => {
    if (!request.options) return [];
    const needle = filter.trim().toLowerCase();
    if (!needle) return request.options;
    return request.options.filter(
      (option) =>
        option.label.toLowerCase().includes(needle) ||
        option.description?.toLowerCase().includes(needle),
    );
  }, [request.options, filter]);
  // Keeps a valid selection as filtering narrows or widens the list, rather than pointing past
  // the end or silently freezing on an item that scrolled out of the filtered set.
  useEffect(() => {
    setActiveIndex((prev) => Math.min(prev, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  useEffect(() => {
    ref.current?.showModal();
    // Without a text input or a picker, Enter confirms and Escape cancels a plain message.
    if (request.input === undefined && !request.options) confirm.current?.focus();
    else if (request.options) filterRef.current?.focus();
  }, [request.input, request.options]);

  const choose = (chosen: string) => {
    if (busy) return;
    setBusy(true);
    setError("");
    Promise.resolve()
      .then(() => request.submit?.(chosen))
      .then(() => {
        ref.current?.close();
        onClose();
        request.afterClose?.();
      })
      .catch((reason) => setError(String(reason)))
      .finally(() => setBusy(false));
  };

  const activeOption = filtered[activeIndex];
  const activeId = activeOption ? `app-dialog-option-${activeIndex}` : undefined;

  return (
    <dialog
      ref={ref}
      aria-labelledby="app-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      // Clicking the backdrop dismisses, like every other modal in the app. The click lands
      // on the <dialog> itself only when it is outside the content box.
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
      className="m-auto max-h-[80vh] w-[min(480px,90vw)] overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-950 p-6 text-zinc-100 backdrop:bg-black/70"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!request.options) choose(value);
        }}
      >
        <h2 id="app-dialog-title" className="mb-3 text-lg">
          {request.title}
        </h2>
        {request.message && (
          <p className="mb-4 whitespace-pre-wrap text-sm text-zinc-400">{request.message}</p>
        )}
        {request.input !== undefined && !request.options && (
          <input
            aria-label={request.title}
            autoFocus
            value={value}
            onChange={(event) => setValue(event.target.value)}
            disabled={busy}
            className="mb-4 w-full rounded border border-zinc-600 bg-black p-2"
          />
        )}
        {request.options && (
          <div className="mb-4">
            <input
              ref={filterRef}
              role="combobox"
              aria-expanded
              aria-controls="app-dialog-options"
              aria-activedescendant={activeId}
              aria-label={request.title}
              placeholder="Type to filter…"
              value={filter}
              disabled={busy}
              onChange={(event) => setFilter(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setActiveIndex((i) => Math.max(i - 1, 0));
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  if (activeOption) choose(activeOption.value);
                }
              }}
              className="mb-2 w-full rounded border border-zinc-600 bg-black p-2"
            />
            <ul
              id="app-dialog-options"
              role="listbox"
              aria-label={request.title}
              className="max-h-[40vh] overflow-y-auto rounded border border-zinc-800"
            >
              {filtered.length === 0 && (
                <li className="px-3 py-2 text-sm text-zinc-500">No matches.</li>
              )}
              {filtered.map((option, index) => (
                <li key={option.value} role="presentation">
                  <button
                    id={`app-dialog-option-${index}`}
                    type="button"
                    role="option"
                    aria-selected={index === activeIndex}
                    disabled={busy}
                    // The filter input owns the keyboard here (arrows plus
                    // `aria-activedescendant`), so the options themselves are out of the tab
                    // order: leaving them in made a repository with 100 branches 100 tab
                    // stops between the filter and Cancel. They stay clickable.
                    tabIndex={-1}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => choose(option.value)}
                    className={`flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left text-sm ${
                      index === activeIndex ? "bg-indigo-600 text-white" : "text-zinc-100"
                    }`}
                  >
                    <span>{option.label}</span>
                    {option.description && (
                      <span
                        className={`text-xs ${index === activeIndex ? "text-indigo-200" : "text-zinc-500"}`}
                      >
                        {option.description}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {error && (
          <p role="alert" className="mb-3 text-sm text-red-400">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-3">
          {request.submit && (
            <button type="button" disabled={busy} onClick={onClose}>
              Cancel
            </button>
          )}
          {!request.options && (
            <button
              ref={confirm}
              type="submit"
              disabled={busy}
              className="rounded bg-indigo-600 px-4 py-2"
            >
              {busy ? "Working…" : request.submit ? (request.confirmLabel ?? "Continue") : "Close"}
            </button>
          )}
        </div>
      </form>
    </dialog>
  );
}
