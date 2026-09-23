import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { native } from "../../../services/native";
import {
  allProblems,
  groupByFile,
  problemsVersion,
  publishProblems,
  subscribeProblems,
} from "../../../services/panel/problems";
import { MATCHERS, parseProblems } from "../../../services/panel/problemMatchers";
import type { Severity } from "../../../services/panel/problemMatchers";
import { EmptyView } from "./EmptyView";

const SEVERITY_STYLE: Record<Severity, string> = {
  error: "text-red-400",
  warning: "text-amber-400",
  info: "text-sky-400",
};
const SEVERITY_MARK: Record<Severity, string> = { error: "×", warning: "!", info: "i" };

/**
 * Diagnostics for the workspace.
 *
 * Yavin has no language server, so these come from running the project's own compiler or
 * linter and reading its output -- the same mechanism VS Code uses for tasks. Each tool
 * publishes under an owner, so one finishing replaces its own findings and leaves the rest.
 */
export function ProblemsView({
  activeFile,
  onOpen,
}: {
  /** Path of the file in the editor, for the "current file only" toggle. */
  activeFile?: string;
  /** Opens a file at a position, for click-to-navigate. */
  onOpen?: (file: string, line: number, column: number) => void;
}) {
  // The version is a dependency of the grouping below, not just a re-render trigger:
  // without it the memo kept returning the list from before the checker published.
  const version = useSyncExternalStore(subscribeProblems, problemsVersion, problemsVersion);

  const [checkers, setCheckers] = useState<{ id: string; label: string }[]>([]);
  const [running, setRunning] = useState("");
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [severities, setSeverities] = useState<Severity[]>(["error", "warning", "info"]);
  const [activeOnly, setActiveOnly] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    native("available_checkers")
      .then(setCheckers)
      // No workspace open yet is the common case, and not worth an error banner.
      .catch(() => setCheckers([]));
  }, []);

  const run = useCallback(async (id: string, label: string) => {
    setRunning(id);
    setError("");
    try {
      const output = await native("run_checker", { id });
      const matcher = MATCHERS[id];
      if (!matcher) throw new Error(`No matcher for ${id}.`);
      // Publishing an empty list is meaningful: it clears what this tool said last time.
      publishProblems(matcher.owner, label, parseProblems(matcher, output));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setRunning("");
    }
  }, []);

  const files = useMemo(
    () =>
      groupByFile(allProblems(), {
        severities,
        filter,
        ...(activeOnly && activeFile ? { file: activeFile } : {}),
      }),
    [severities, filter, activeOnly, activeFile, version],
  );
  const total = files.reduce((sum, file) => sum + file.problems.length, 0);
  const everRan = allProblems().length > 0;

  const toggleSeverity = (severity: Severity) =>
    setSeverities((current) =>
      current.includes(severity)
        ? current.filter((one) => one !== severity)
        : [...current, severity],
    );

  if (!checkers.length && !everRan)
    return (
      <EmptyView
        label="Problems"
        message="No checker was found for this project. Yavin collects diagnostics by running your project's own compiler or linter — a tsconfig.json, Cargo.toml, eslint.config.js or pyproject.toml in the workspace root enables one."
      />
    );

  return (
    <section aria-label="Problems" className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[#141414] px-3 py-1">
        <input
          aria-label="Filter problems"
          placeholder="Filter (text, *.ts, !node_modules)"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          className="w-56 rounded border border-[#222222] bg-[#0a0a0a] px-2 py-0.5 text-[11px] text-zinc-200 placeholder:text-zinc-600"
        />
        {(["error", "warning", "info"] as const).map((severity) => (
          <button
            key={severity}
            aria-pressed={severities.includes(severity)}
            onClick={() => toggleSeverity(severity)}
            className={`rounded px-2 py-0.5 text-[11px] capitalize ${
              severities.includes(severity)
                ? "bg-indigo-950/60 text-indigo-300"
                : "text-zinc-600 hover:text-zinc-300"
            }`}
          >
            {severity}s
          </button>
        ))}
        <button
          aria-pressed={activeOnly}
          onClick={() => setActiveOnly((on) => !on)}
          disabled={!activeFile}
          className={`rounded px-2 py-0.5 text-[11px] disabled:opacity-40 ${
            activeOnly ? "bg-indigo-950/60 text-indigo-300" : "text-zinc-600 hover:text-zinc-300"
          }`}
        >
          Current file
        </button>

        <div className="ml-auto flex items-center gap-1">
          {checkers.map((checker) => (
            <button
              key={checker.id}
              onClick={() => void run(checker.id, checker.label)}
              disabled={!!running}
              title={`Run ${checker.label} and collect its diagnostics`}
              className="rounded bg-[#151515] px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-[#1d1d1d] disabled:opacity-40"
            >
              {running === checker.id ? `Running ${checker.label}…` : checker.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <p role="alert" className="shrink-0 px-3 py-1 text-[11px] text-red-400">
          {error}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-auto py-1 text-[11px]">
        {total === 0 ? (
          <p className="px-3 py-2 text-zinc-500">
            {everRan
              ? "No problems match. Nothing was reported for the current filters."
              : "No checker has run yet. Choose one above to collect diagnostics."}
          </p>
        ) : (
          files.map((file) => {
            const open = !collapsed.has(file.file);
            return (
              <div key={file.file}>
                <button
                  aria-expanded={open}
                  onClick={() =>
                    setCollapsed((current) => {
                      const next = new Set(current);
                      if (next.has(file.file)) next.delete(file.file);
                      else next.add(file.file);
                      return next;
                    })
                  }
                  className="flex w-full items-center gap-1.5 px-3 py-0.5 text-left text-zinc-300 hover:bg-[#0c0c0c]"
                >
                  <span className="text-zinc-600">{open ? "▾" : "▸"}</span>
                  <span className="truncate font-medium">{file.file}</span>
                  <span className="text-zinc-600">{file.problems.length}</span>
                </button>
                {open &&
                  file.problems.map((problem, index) => (
                    <button
                      key={`${problem.line}:${problem.column}:${index}`}
                      onClick={() => onOpen?.(problem.file, problem.line, problem.column)}
                      className="flex w-full items-start gap-1.5 py-0.5 pr-3 pl-8 text-left hover:bg-[#0c0c0c]"
                    >
                      <span
                        aria-label={problem.severity}
                        className={`shrink-0 font-bold ${SEVERITY_STYLE[problem.severity]}`}
                      >
                        {SEVERITY_MARK[problem.severity]}
                      </span>
                      <span className="flex-1 text-zinc-300">{problem.message}</span>
                      <span className="shrink-0 text-zinc-600">
                        {problem.source}
                        {problem.code ? `(${problem.code})` : ""} [Ln {problem.line}, Col{" "}
                        {problem.column}]
                      </span>
                    </button>
                  ))}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
