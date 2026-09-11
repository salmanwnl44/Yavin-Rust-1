import { useEffect, useRef, useState } from "react";

export interface DialogRequest {
  title: string;
  message?: string;
  input?: string;
  submit?: (value: string) => void | Promise<void>;
  afterClose?: () => void;
}

export function AppDialog({ request, onClose }: { request: DialogRequest; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState(request.input ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby="app-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      className="m-auto max-h-[80vh] w-[min(480px,90vw)] overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-950 p-6 text-zinc-100 backdrop:bg-black/70"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          setError("");
          Promise.resolve()
            .then(() => request.submit?.(value))
            .then(() => {
              ref.current?.close();
              onClose();
              request.afterClose?.();
            })
            .catch((reason) => setError(String(reason)))
            .finally(() => setBusy(false));
        }}
      >
        <h2 id="app-dialog-title" className="mb-3 text-lg">
          {request.title}
        </h2>
        {request.message && (
          <p className="mb-4 whitespace-pre-wrap text-sm text-zinc-400">{request.message}</p>
        )}
        {request.input !== undefined && (
          <input
            aria-label={request.title}
            autoFocus
            value={value}
            onChange={(event) => setValue(event.target.value)}
            disabled={busy}
            className="mb-4 w-full rounded border border-zinc-600 bg-black p-2"
          />
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
          <button type="submit" disabled={busy} className="rounded bg-indigo-600 px-4 py-2">
            {busy ? "Working…" : request.submit ? "Continue" : "Close"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
