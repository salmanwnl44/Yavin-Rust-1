import { useCallback, useEffect, useState } from "react";
import {
  CATEGORY_LABEL,
  type DiagnosticsIo,
  type ExtensionDiagnostic,
} from "../../services/extensions/diagnostics";

/**
 * Extension diagnostics (EXT-14), in the Extensions view: what happened recently -- refused on
 * purpose, or broken -- with what to do next, a redacted report to copy, a clear, a way to
 * disable an extension that keeps failing, and safe mode. Everything shown is the native
 * side's: its classification, its redaction, this window's records and the application's.
 * Nothing here can turn a check off.
 */
export function ExtensionDiagnostics({
  io,
  isEnabled,
  onDisable,
  onSafeModeChanged,
}: {
  io: DiagnosticsIo;
  /** Whether an extension is enabled now (the registry: the one source of its state). */
  isEnabled: (id: string) => boolean;
  onDisable: (id: string) => void;
  /** After safe mode changes: extensions are reloaded. */
  onSafeModeChanged: () => Promise<unknown>;
}) {
  const [records, setRecords] = useState<ExtensionDiagnostic[] | null>(null);
  const [safe, setSafe] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setRecords(await io.list());
      setSafe(await io.safeMode());
      setError(null);
    } catch (failure) {
      setError(String((failure as Error)?.message ?? failure).replace(/^[A-Za-z]+: /, ""));
    }
  }, [io]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const act = async (work: () => Promise<unknown>, done?: string) => {
    setNotice(null);
    setError(null);
    try {
      await work();
      if (done) setNotice(done);
    } catch (failure) {
      setError(String((failure as Error)?.message ?? failure).replace(/^[A-Za-z]+: /, ""));
    }
    await refresh();
  };
  return (
    <section
      aria-label="Extension diagnostics"
      className="mx-3 mt-3 rounded border border-zinc-800 px-2 py-1.5 text-[11px] text-zinc-400"
    >
      <div className="mb-1 flex items-center gap-2">
        <span className="flex-1 text-[10.5px] font-semibold tracking-wider text-zinc-500 uppercase">
          Extension diagnostics
        </span>
        <button className="hover:text-zinc-200" onClick={() => void refresh()}>
          Refresh
        </button>
        <button
          className="hover:text-zinc-200"
          onClick={() =>
            void act(async () => {
              const report = await io.report();
              await navigator.clipboard.writeText(report);
            }, "A redacted report was copied.")
          }
        >
          Copy report
        </button>
        <button
          className="hover:text-zinc-200"
          onClick={() => void act(() => io.clear(), "Diagnostics cleared.")}
        >
          Clear
        </button>
      </div>
      <label className="mb-1.5 flex items-center gap-1.5">
        <input
          type="checkbox"
          checked={safe}
          onChange={(event) => {
            const on = event.target.checked;
            void act(async () => {
              await io.safeMode(on);
              await onSafeModeChanged();
            });
          }}
        />
        Safe mode: no extension code runs (until Yavin restarts or this is turned off)
      </label>
      {records !== null && records.length === 0 && (
        <p className="text-zinc-500">Nothing to report.</p>
      )}
      <ul>
        {(records ?? []).map((record, index) => (
          <li
            key={`${record.at}:${record.code}:${record.extension}:${index}`}
            className="border-t border-[#141414] py-1"
            data-code={record.code}
            data-refusal={record.refusal}
          >
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className={record.refusal ? "text-amber-300" : "text-red-300"}>
                {record.refusal ? "Refused" : "Failed"}
              </span>
              <span className="text-zinc-300">
                {CATEGORY_LABEL[record.category] ?? record.category}
              </span>
              <code className="text-zinc-500">{record.code}</code>
              {record.extension && (
                <span className="text-zinc-300">
                  {record.extension}
                  {record.version ? ` ${record.version}` : ""}
                </span>
              )}
              {record.count > 1 && <span className="text-zinc-500">×{record.count}</span>}
              <time
                className="ml-auto text-zinc-600"
                dateTime={new Date(record.at * 1000).toISOString()}
              >
                {new Date(record.at * 1000).toLocaleTimeString()}
              </time>
            </div>
            <div className="text-zinc-300">{record.summary}</div>
            {record.remedy && <div>Next: {record.remedy}</div>}
            {record.detail && (
              <details>
                <summary className="cursor-pointer select-none text-zinc-500">Details</summary>
                <div className="break-words text-zinc-500">{record.detail}</div>
              </details>
            )}
            {record.extension &&
              !record.refusal &&
              isEnabled(record.extension) &&
              ["crash", "timeout", "resource"].includes(record.category) && (
                <button
                  className="hover:text-zinc-200"
                  aria-label={`Disable ${record.extension}`}
                  onClick={() => {
                    onDisable(record.extension!);
                    setNotice(`${record.extension} was disabled.`);
                  }}
                >
                  Disable {record.extension}
                </button>
              )}
          </li>
        ))}
      </ul>
      {notice && (
        <p data-testid="diagnostics-notice" className="mt-1 text-zinc-300">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-1 text-red-400/90">
          {error}
        </p>
      )}
    </section>
  );
}
