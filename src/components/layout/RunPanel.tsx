import { useEffect, useMemo, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import type { TaskRun, TaskService, TaskState } from "../../services/tasks/service";
import { isFinal } from "../../services/tasks/service";
import {
  buildTaskTree,
  filterOptions,
  filterTasks,
  flattenVisible,
  tasksSignature,
  toggleExpansion,
  type TaskFilters,
  type TaskPresentationGroup,
  type TaskRow,
  type TaskSourceFilter,
  type TaskTreeNode,
} from "../../services/tasks/taskTree";

const STATE_LABEL: Record<TaskState, string> = {
  pending: "Waiting",
  starting: "Starting",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Stopped",
};
const STATE_STYLE: Record<TaskState, string> = {
  pending: "text-zinc-500",
  starting: "text-indigo-300",
  running: "text-indigo-300",
  succeeded: "text-emerald-400",
  failed: "text-red-400",
  cancelled: "text-amber-300",
};
const GROUP_STYLE: Record<TaskPresentationGroup, string> = {
  build: "text-sky-300",
  test: "text-emerald-300",
  lint: "text-amber-300",
  typecheck: "text-violet-300",
  run: "text-indigo-300",
  other: "text-zinc-400",
};

/** The latest top-level run per task id (runs are newest-first), for inline status on a leaf. */
function latestRunByTask(runs: readonly TaskRun[]): Map<string, TaskRun> {
  const by = new Map<string, TaskRun>();
  for (const run of runs) if (run.parent === null && !by.has(run.taskId)) by.set(run.taskId, run);
  return by;
}

const durationOf = (run: TaskRun): string | null =>
  run.startedAt !== null && run.finishedAt !== null
    ? `${((run.finishedAt - run.startedAt) / 1000).toFixed(1)}s`
    : null;

/** One hierarchy row: a workspace/package/group disclosure header, or a task leaf. Task leaves keep
 * `role="group"` + a `Run {label}` button (the established contract the window's commands use). */
function Row({
  row,
  focused,
  run,
  depLabels,
  onToggle,
  onRun,
  onRerun,
  onShowTerminal,
  onFocusRow,
}: {
  row: TaskRow;
  focused: boolean;
  run: TaskRun | undefined;
  /** The labels of this task's dependency tasks (package-graph or configured), in run order. */
  depLabels: readonly string[];
  onToggle: (node: TaskTreeNode) => void;
  onRun: (taskId: string) => void;
  onRerun: (taskId: string) => void;
  onShowTerminal: (run: TaskRun) => void;
  onFocusRow: (id: string) => void;
}) {
  const { node, expanded } = row;
  const indent = 6 + node.depth * 12;
  const tabIndex = focused ? 0 : -1;

  if (node.kind !== "task") {
    const headerRole = node.kind === "group" ? `${node.label} tasks` : `${node.kind} ${node.label}`;
    return (
      <button
        type="button"
        data-row-id={node.id}
        aria-label={headerRole}
        aria-expanded={expanded}
        tabIndex={tabIndex}
        onFocus={() => onFocusRow(node.id)}
        onClick={() => onToggle(node)}
        className="flex w-full items-center gap-1 py-0.5 pr-2 text-left hover:bg-[#0c0c0c]"
        style={{ paddingLeft: indent }}
      >
        <span className="w-2 shrink-0 text-zinc-600">{expanded ? "▾" : "▸"}</span>
        <span
          className={`truncate ${
            node.kind === "group"
              ? `text-[10px] font-semibold tracking-wide uppercase ${GROUP_STYLE[node.group ?? "other"]}`
              : "text-[11px] font-medium text-zinc-300"
          }`}
        >
          {node.label}
        </span>
        <span className="ml-1 shrink-0 text-[10px] text-zinc-600">{node.taskCount}</span>
      </button>
    );
  }

  const running = run && !isFinal(run.state);
  return (
    <div
      role="group"
      aria-label={node.label}
      data-row-id={node.id}
      tabIndex={tabIndex}
      onFocus={() => onFocusRow(node.id)}
      className={`flex items-center gap-2 py-1 pr-1 ${focused ? "bg-[#161616]" : "hover:bg-[#0c0c0c]"}`}
      style={{ paddingLeft: indent }}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-zinc-200" title={node.command}>
          {node.label}
        </div>
        <div className="truncate text-[10px] text-zinc-600">
          {[
            node.isDefault ? "default" : null,
            node.scope === "discovered"
              ? "discovered"
              : node.scope === "workspace"
                ? "workspace"
                : "user",
            run ? STATE_LABEL[run.state] : null,
            run && durationOf(run) ? durationOf(run) : null,
            run && run.exitCode !== null && run.state !== "cancelled"
              ? `exit ${run.exitCode}`
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>
        {depLabels.length > 0 && (
          <div
            className="truncate text-[10px] text-zinc-500"
            title={`Builds after: ${depLabels.join(", ")}`}
          >
            ↳ after {depLabels.join(", ")}
          </div>
        )}
      </div>
      {run && run.sessionId && (
        <button
          aria-label={`Show terminal for ${node.label}`}
          onClick={() => onShowTerminal(run)}
          tabIndex={-1}
          className="shrink-0 text-[10px] text-zinc-500 underline hover:text-zinc-300"
        >
          Terminal
        </button>
      )}
      {run && isFinal(run.state) ? (
        <button
          aria-label={`Rerun ${node.label}`}
          onClick={() => onRerun(node.taskId!)}
          tabIndex={-1}
          className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-indigo-300 hover:bg-[#1c1c1c]"
        >
          Rerun
        </button>
      ) : null}
      <button
        aria-label={`Run ${node.label}`}
        onClick={() => onRun(node.taskId!)}
        tabIndex={-1}
        className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] hover:bg-[#1c1c1c] ${
          running ? "text-zinc-600" : "text-indigo-300"
        }`}
      >
        Run
      </button>
    </div>
  );
}

/**
 * The Run view (IDE-04, hierarchical in WS7 Part 5): the workspace's tasks projected as
 * Workspace → Package → Group → Task, with search and composable filters, and the executions —
 * running first — with their state, terminal and Stop. A **projection** over the workspace's
 * TaskService: running, stopping and showing a terminal are the window's commands (`onRun`, …),
 * which go through the service by the task's stable id. The hierarchy creates no task or execution
 * state; filtering never touches a running task.
 */
export function RunPanel({
  service,
  visible,
  hasWorkspace,
  onRun,
  onRerun,
  onRunGroup,
  onStop,
  onShowTerminal,
  onConfigure,
}: {
  service: TaskService;
  visible: boolean;
  hasWorkspace: boolean;
  onRun: (taskId: string) => void;
  onRerun: (taskId: string) => void;
  onRunGroup: (group: "build" | "test") => void;
  onStop: (executionId: string) => void;
  onShowTerminal: (run: TaskRun) => void;
  onConfigure: () => void;
}) {
  const { tasks, runs, folders } = useSyncSnapshot(service);

  const [search, setSearch] = useState("");
  const [group, setGroup] = useState<TaskPresentationGroup | "">("");
  const [source, setSource] = useState<TaskSourceFilter | "">("");
  const [workspace, setWorkspace] = useState<number | "">("");
  const [packageKey, setPackageKey] = useState<string>("");
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set());
  const [focusedId, setFocusedId] = useState<string | null>(null);

  const sig = tasksSignature(tasks);
  const foldersKey = folders.join("\u0000");
  const options = useMemo(() => filterOptions(tasks, folders), [sig, foldersKey]);
  const labelById = useMemo(() => new Map(tasks.map((t) => [t.id, t.label])), [sig]);

  const filters: TaskFilters = useMemo(
    () => ({
      search,
      group: group || null,
      source: source || null,
      workspace: workspace === "" ? null : workspace,
      packageKey: packageKey || null,
    }),
    [search, group, source, workspace, packageKey],
  );

  const tree = useMemo(
    () => buildTaskTree(filterTasks(tasks, folders, filters), folders),
    // The tree depends on task identity (sig) and the filters — never on run ticks, which change
    // no task identity, so an execution state change does not rebuild it.
    [sig, foldersKey, filters],
  );
  const rows = useMemo(() => flattenVisible(tree, expandedIds), [tree, expandedIds]);
  const runByTask = useMemo(() => latestRunByTask(runs), [runs]);

  // Keep the keyboard focus on a row that still exists; otherwise fall back to the first row.
  useEffect(() => {
    if (focusedId && rows.some((r) => r.node.id === focusedId)) return;
    setFocusedId(rows[0]?.node.id ?? null);
  }, [rows, focusedId]);

  const toggle = (node: TaskTreeNode) => setExpandedIds((ids) => toggleExpansion(ids, node));

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = rows.findIndex((r) => r.node.id === focusedId);
    const focus = (i: number) => {
      const id = rows[i]?.node.id;
      if (!id) return;
      setFocusedId(id);
      const el = event.currentTarget.querySelector<HTMLElement>(`[data-row-id="${cssEscape(id)}"]`);
      el?.focus();
      event.preventDefault();
    };
    const current = rows[index];
    switch (event.key) {
      case "ArrowDown":
        focus(Math.min(rows.length - 1, index + 1));
        break;
      case "ArrowUp":
        focus(Math.max(0, index - 1));
        break;
      case "ArrowRight":
        if (current && current.node.expandable && !current.expanded) toggle(current.node);
        break;
      case "ArrowLeft":
        if (current && current.node.expandable && current.expanded) toggle(current.node);
        break;
      case "Enter":
      case " ":
        if (current?.node.kind === "task" && current.node.taskId) {
          onRun(current.node.taskId);
          event.preventDefault();
        }
        break;
    }
  };

  const clearFilters = () => {
    setSearch("");
    setGroup("");
    setSource("");
    setWorkspace("");
    setPackageKey("");
  };
  const filtered = !!search || !!group || !!source || workspace !== "" || !!packageKey;

  return (
    <aside
      hidden={!visible}
      aria-label="Run"
      className="flex w-[260px] shrink-0 flex-col border-r border-[#141414] bg-black text-[12px] text-zinc-300"
    >
      <div className="flex h-9 items-center justify-between border-b border-[#101010] px-3">
        <span className="text-[11px] font-semibold tracking-wider uppercase">Run</span>
        <button onClick={onConfigure} className="text-[11px] text-zinc-500 hover:text-zinc-200">
          Configure Tasks
        </button>
      </div>
      {!hasWorkspace ? (
        <p className="p-3 text-zinc-500">Open a folder to run its tasks.</p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex gap-1 p-2">
            <button
              onClick={() => onRunGroup("build")}
              className="flex-1 rounded bg-[#151515] px-2 py-1 text-[11px] hover:bg-[#1d1d1d]"
            >
              Run Build Task
            </button>
            <button
              onClick={() => onRunGroup("test")}
              className="flex-1 rounded bg-[#151515] px-2 py-1 text-[11px] hover:bg-[#1d1d1d]"
            >
              Run Test Task
            </button>
          </div>

          {tasks.length > 0 && (
            <div className="flex flex-col gap-1 px-2 pb-1">
              <input
                type="search"
                aria-label="Search tasks"
                placeholder="Filter tasks"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded bg-[#101010] px-2 py-1 text-[11px] text-zinc-200 placeholder:text-zinc-600 focus:outline focus:outline-indigo-500"
              />
              <div className="flex flex-wrap gap-1">
                {options.workspaces.length > 1 && (
                  <select
                    aria-label="Filter by workspace"
                    value={workspace}
                    onChange={(e) =>
                      setWorkspace(e.target.value === "" ? "" : Number(e.target.value))
                    }
                    className="rounded bg-[#101010] px-1 py-0.5 text-[10px] text-zinc-300"
                  >
                    <option value="">All folders</option>
                    {options.workspaces.map((w) => (
                      <option key={w.index} value={w.index}>
                        {w.label}
                      </option>
                    ))}
                  </select>
                )}
                {options.packages.length > 1 && (
                  <select
                    aria-label="Filter by package"
                    value={packageKey}
                    onChange={(e) => setPackageKey(e.target.value)}
                    className="max-w-[110px] rounded bg-[#101010] px-1 py-0.5 text-[10px] text-zinc-300"
                  >
                    <option value="">All packages</option>
                    {options.packages.map((p) => (
                      <option key={p.key} value={p.key}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                )}
                {options.groups.length > 1 && (
                  <select
                    aria-label="Filter by group"
                    value={group}
                    onChange={(e) => setGroup(e.target.value as TaskPresentationGroup | "")}
                    className="rounded bg-[#101010] px-1 py-0.5 text-[10px] text-zinc-300"
                  >
                    <option value="">All groups</option>
                    {options.groups.map((g) => (
                      <option key={g} value={g}>
                        {g}
                      </option>
                    ))}
                  </select>
                )}
                {options.sources.length > 1 && (
                  <select
                    aria-label="Filter by source"
                    value={source}
                    onChange={(e) => setSource(e.target.value as TaskSourceFilter | "")}
                    className="rounded bg-[#101010] px-1 py-0.5 text-[10px] text-zinc-300"
                  >
                    <option value="">All sources</option>
                    <option value="configured">Configured</option>
                    <option value="discovered">Discovered</option>
                  </select>
                )}
                {filtered && (
                  <button
                    onClick={clearFilters}
                    className="rounded px-1 py-0.5 text-[10px] text-zinc-500 hover:text-zinc-200"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto">
            <section aria-label="Tasks" className="pb-2">
              {!tasks.length ? (
                <p className="px-3 py-1 text-[11px] text-zinc-500">
                  No tasks yet. Configure Tasks adds them, for you or for this workspace.
                </p>
              ) : rows.length === 0 ? (
                <p className="px-3 py-1 text-[11px] text-zinc-500">
                  No tasks match these filters.{" "}
                  <button onClick={clearFilters} className="underline hover:text-zinc-300">
                    Clear filters
                  </button>
                </p>
              ) : (
                <div onKeyDown={onKeyDown}>
                  {rows.map((row) => (
                    <Row
                      key={row.node.id}
                      row={row}
                      focused={row.node.id === focusedId}
                      run={row.node.taskId ? runByTask.get(row.node.taskId) : undefined}
                      depLabels={(row.node.dependsOn ?? []).map((id) => labelById.get(id) ?? id)}
                      onToggle={toggle}
                      onRun={onRun}
                      onRerun={onRerun}
                      onShowTerminal={onShowTerminal}
                      onFocusRow={setFocusedId}
                    />
                  ))}
                </div>
              )}
            </section>

            {runs.length > 0 && (
              <section aria-label="Running tasks" className="px-2 pb-2">
                <h2 className="px-1 py-1 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
                  Executions
                </h2>
                {runs.map((run) => (
                  <div
                    key={run.executionId}
                    role="group"
                    aria-label={`Execution of ${run.label}`}
                    className="rounded px-1 py-1 hover:bg-[#0c0c0c]"
                  >
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-zinc-200">{run.label}</span>
                      <span
                        data-testid="task-state"
                        className={`text-[10px] ${STATE_STYLE[run.state]}`}
                      >
                        {STATE_LABEL[run.state]}
                        {run.exitCode !== null && run.state !== "cancelled"
                          ? ` (${run.exitCode})`
                          : ""}
                      </span>
                    </div>
                    {run.parent && (
                      <div className="text-[10px] text-zinc-600">
                        before {runs.find((r) => r.executionId === run.parent)?.label}
                      </div>
                    )}
                    {run.error && run.state !== "succeeded" && (
                      <div className="text-[10px] text-zinc-500">{run.error}</div>
                    )}
                    <div className="mt-0.5 flex gap-2">
                      {run.sessionId && (
                        <button
                          onClick={() => onShowTerminal(run)}
                          className="text-[10px] text-zinc-400 underline hover:text-zinc-200"
                        >
                          Show terminal
                        </button>
                      )}
                      {!isFinal(run.state) && (
                        <button
                          aria-label={`Stop ${run.label}`}
                          onClick={() => onStop(run.executionId)}
                          className="text-[10px] text-amber-300 underline hover:text-amber-200"
                        >
                          Stop
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </section>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}

/** A minimal CSS.escape for the `data-row-id` selector (ids hold NUL and `!`, never quotes). */
const cssEscape = (s: string): string =>
  typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s.replace(/["\\\n]/g, "\\$&");

function useSyncSnapshot(service: TaskService) {
  return useSyncExternalStore(service.subscribe, service.getSnapshot, service.getSnapshot);
}
