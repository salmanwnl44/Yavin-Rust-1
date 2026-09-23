import { useEffect, useRef, useState } from "react";
import {
  decideTrust,
  folderName,
  forgetTrustedFolder,
  listTrustedFolders,
  RESTRICTED_SUMMARY,
  STILL_WORKS_SUMMARY,
} from "../../services/trust";
import type { TrustState } from "../../services/trust";

/**
 * The Workspace Trust decision, and the place to change it later.
 *
 * Deliberately says what Restricted Mode does and does not stop. The failure mode of this
 * kind of prompt is that people learn to dismiss it, and the way to avoid that is for it to
 * be accurate about how little it blocks.
 */
export function WorkspaceTrustDialog({
  trust,
  mode,
  onDecided,
  onClose,
}: {
  trust: TrustState;
  /** "prompt" is the unavoidable first decision; "manage" can be dismissed. */
  mode: "prompt" | "manage";
  onDecided: (next: TrustState) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [alsoParent, setAlsoParent] = useState(false);
  const [folders, setFolders] = useState<string[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  useEffect(() => {
    if (mode === "manage")
      listTrustedFolders()
        .then(setFolders)
        .catch(() => setFolders([]));
  }, [mode, trust.trusted]);

  const decide = (trusted: boolean) => {
    decideTrust(trusted, alsoParent && trusted).then(
      (next) => {
        onDecided(next);
        ref.current?.close();
        onClose();
      },
      (reason) => setError(String(reason)),
    );
  };

  const name = folderName(trust.root);
  const parent = folderName(trust.parent);

  return (
    <dialog
      ref={ref}
      aria-labelledby="trust-title"
      onCancel={(event) => {
        event.preventDefault();
        // The first decision has no default: dismissing it would leave the window in a state
        // the user never chose. Manage can simply close.
        if (mode === "manage") {
          ref.current?.close();
          onClose();
        }
      }}
      className="m-auto max-h-[85vh] w-[min(560px,92vw)] overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-950 p-6 text-zinc-100 backdrop:bg-black/70"
    >
      <h2 id="trust-title" className="mb-2 text-lg font-semibold">
        {mode === "prompt"
          ? "Do you trust the authors of the files in this folder?"
          : "Workspace Trust"}
      </h2>

      <p className="mb-4 text-sm text-zinc-400">
        {trust.root ? (
          <>
            Some features run the project's own tools, and a project can decide what those tools do
            — a build script, a linter's configuration file, or a program inside the folder. Trust{" "}
            <span className="font-mono text-zinc-200">{name}</span> only if you would be comfortable
            running its code.
          </>
        ) : (
          "No folder is open, so there is nothing to trust."
        )}
      </p>

      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <section className="rounded border border-zinc-800 p-3">
          <h3 className="mb-1 text-[12px] font-semibold text-amber-400">Restricted Mode stops</h3>
          <ul className="list-disc space-y-1 pl-4 text-[11.5px] text-zinc-400">
            {RESTRICTED_SUMMARY.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
        <section className="rounded border border-zinc-800 p-3">
          <h3 className="mb-1 text-[12px] font-semibold text-emerald-400">Everything else works</h3>
          <ul className="list-disc space-y-1 pl-4 text-[11.5px] text-zinc-400">
            {STILL_WORKS_SUMMARY.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      </div>

      {trust.parent && (
        <label className="mb-4 flex items-start gap-2 text-[12px] text-zinc-300">
          <input
            type="checkbox"
            checked={alsoParent}
            onChange={(event) => setAlsoParent(event.target.checked)}
            className="mt-0.5"
          />
          <span>
            Trust every folder inside <span className="font-mono text-zinc-200">{parent}</span>
            <span className="block text-zinc-500">
              Covers projects you add there later, without asking again.
            </span>
          </span>
        </label>
      )}

      {error && (
        <p role="alert" className="mb-3 text-sm text-red-400">
          {error}
        </p>
      )}

      <div className="flex flex-wrap justify-end gap-3">
        {mode === "manage" && (
          <button
            type="button"
            onClick={() => {
              ref.current?.close();
              onClose();
            }}
            className="mr-auto text-sm text-zinc-400 hover:text-zinc-200"
          >
            Close
          </button>
        )}
        <button
          type="button"
          onClick={() => decide(false)}
          disabled={!trust.root}
          className="rounded border border-zinc-700 px-4 py-2 text-sm hover:bg-zinc-900 disabled:opacity-40"
        >
          {mode === "prompt" ? "No, browse in Restricted Mode" : "Restrict this folder"}
        </button>
        <button
          type="button"
          onClick={() => decide(true)}
          disabled={!trust.root}
          className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-40"
        >
          {mode === "prompt" ? "Yes, I trust the authors" : "Trust this folder"}
        </button>
      </div>

      {mode === "manage" && folders.length > 0 && (
        <section aria-label="Trusted folders" className="mt-5 border-t border-zinc-800 pt-4">
          <h3 className="mb-2 text-[12px] font-semibold text-zinc-300">Trusted folders</h3>
          <ul className="space-y-1">
            {folders.map((folder) => (
              <li key={folder} className="flex items-center gap-2 text-[11.5px]">
                <span className="flex-1 truncate font-mono text-zinc-400" title={folder}>
                  {folder}
                </span>
                <button
                  type="button"
                  aria-label={`Stop trusting ${folder}`}
                  onClick={() =>
                    forgetTrustedFolder(folder).then(
                      (next) => {
                        onDecided(next);
                        listTrustedFolders()
                          .then(setFolders)
                          .catch(() => undefined);
                      },
                      (reason) => setError(String(reason)),
                    )
                  }
                  className="rounded px-2 py-0.5 text-zinc-500 hover:bg-zinc-900 hover:text-red-400"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </dialog>
  );
}
