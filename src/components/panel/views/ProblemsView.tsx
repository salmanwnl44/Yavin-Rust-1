import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useWorkspace } from "../../../services/workspaces";
import {
  PROBLEM_KINDS,
  allProblems,
  groupByFile,
  kindOf,
  problemsVersion,
  subscribeProblems,
  type ProblemKind,
} from "../../../services/panel/problems";
import { describeCheckerStatus } from "../../../services/panel/checkers";
import { EmptyView } from "./EmptyView";

const KIND_STYLE: Record<ProblemKind, string> = {
  error: "text-red-400",
  warning: "text-amber-400",
  info: "text-sky-400",
  hint: "text-zinc-400",
};
const KIND_MARK: Record<ProblemKind, string> = { error: "×", warning: "!", info: "i", hint: "…" };

/** What the view was showing last time it was mounted. See the comment where it is read. */
let kept: {
  filter: string;
  severities: ProblemKind[];
  activeOnly: boolean;
  collapsed: ReadonlySet<string>;
} = {
  filter: "",
  severities: [...PROBLEM_KINDS],
  activeOnly: false,
  collapsed: new Set(),
};

/**
 * Diagnostics for the workspace: what the language servers report for open files, and what
 * the project's own compiler or linter reports when one of its checkers is run (the same
 * mechanism VS Code uses for tasks). Each producer publishes under an owner, so one finishing
 * replaces its own findings and leaves the rest. Running a checker is the workspace's checker
 * service's (IDE-01); this view shows its state and asks it to run or stop.
 */
export function ProblemsView({
  trusted = true,
  onManageTrust,
  activeFile,
  onOpen,
}: {
  /** Running a checker starts the project's own build tooling, so it needs trust. */
  trusted?: boolean;
  onManageTrust?: () => void;
  /** The file in the editor (any spelling of it), for the "current file only" toggle. */
  activeFile?: string;
  /** Opens a file at a position (1-based line and column), for click-to-navigate. */
  onOpen?: (file: string, line: number, column: number) => void;
}) {
  // The version is a dependency of the grouping below, not just a re-render trigger:
  // without it the memo kept returning the list from before the checker published.
  const version = useSyncExternalStore(subscribeProblems, problemsVersion, problemsVersion);

  const service = useWorkspace().services.checkers;
  const { available: checkers, status } = useSyncExternalStore(
    service.subscribe,
    service.getSnapshot,
    service.getSnapshot,
  );
  const running = status.kind === "running" ? status.id : "";
  const notice = describeCheckerStatus(status);
  // Filters and collapse state outlive the component: it is unmounted whenever another view
  // shows, and losing a carefully typed filter on a trip to the terminal is infuriating.
  const [filter, setFilter] = useState(kept.filter);
  const [severities, setSeverities] = useState<ProblemKind[]>(kept.severities);
  const [activeOnly, setActiveOnly] = useState(kept.activeOnly);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(kept.collapsed);
  useEffect(() => {
    kept = { filter, severities, activeOnly, collapsed };
  }, [filter, severities, activeOnly, collapsed]);

  useEffect(() => {
    void service.refresh(trusted);
  }, [service, trusted]);

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
  /** Whether anything is actually narrowing the list, so "no match" is not blamed on
   * filters the user has not set. */
  const narrowed = !!filter.trim() || severities.length < PROBLEM_KINDS.length || activeOnly;

  const toggleSeverity = (severity: ProblemKind) =>
    setSeverities((current) =>
      current.includes(severity)
        ? current.filter((one) => one !== severity)
        : [...current, severity],
    );

  if (!trusted)
    return (
      <EmptyView
        label="Problems"
        message="This folder is open in Restricted Mode, so Yavin does not run its compiler or linter. Collecting diagnostics means running the project's own tools, and a project decides what those do."
        action={
          <button
            onClick={onManageTrust}
            className="rounded bg-indigo-600 px-3 py-1 text-[11px] font-medium text-white hover:bg-indigo-500"
          >
            Manage Workspace Trust
          </button>
        }
      />
    );

  if (!checkers.length && !everRan)
    return (
      <EmptyView
        label="Problems"
        message="No problems have been reported. Language servers report problems in the files you open; a whole-project check needs a checker, and none applies here — a tsconfig.json, Cargo.toml, eslint.config.js or pyproject.toml in the workspace root enables one."
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
        {PROBLEM_KINDS.map((severity) => (
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
              onClick={() => void service.run(checker.id)}
              disabled={!!running}
              title={`Run ${checker.label} and collect its diagnostics`}
              className="rounded bg-[#151515] px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-[#1d1d1d] disabled:opacity-40"
            >
              {running === checker.id ? `Running ${checker.label}…` : checker.label}
            </button>
          ))}
          {running && (
            <button
              onClick={() => service.stop()}
              title="Stop the checker that is running"
              className="rounded bg-[#151515] px-2 py-0.5 text-[11px] text-amber-300 hover:bg-[#1d1d1d]"
            >
              Stop
            </button>
          )}
        </div>
      </div>

      {notice &&
        (status.kind === "failed" ? (
          <p role="alert" className="shrink-0 px-3 py-1 text-[11px] text-red-400">
            {notice}
          </p>
        ) : (
          // Stopped, timed out, or results outside the workspace: said, but not as a failure.
          <p role="status" className="shrink-0 px-3 py-1 text-[11px] text-zinc-400">
            {notice}
          </p>
        ))}

      <div className="min-h-0 flex-1 overflow-auto py-1 text-[11px]">
        {total === 0 ? (
          <p className="px-3 py-2 text-zinc-500">
            {!everRan
              ? "Nothing has been reported yet. Open a file, or run a checker above."
              : narrowed
                ? "No problems match the current filters."
                : "No problems found."}
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
                      // Rebuilt from the files actually on screen, so paths that have been
                      // fixed or filtered away do not accumulate forever.
                      const shown = new Set(files.map((one) => one.file));
                      const next = new Set([...current].filter((path) => shown.has(path)));
                      if (current.has(file.file)) next.delete(file.file);
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
                        aria-label={kindOf(problem)}
                        className={`shrink-0 font-bold ${KIND_STYLE[kindOf(problem)]}`}
                      >
                        {KIND_MARK[kindOf(problem)]}
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
