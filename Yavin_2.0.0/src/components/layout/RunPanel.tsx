import { useSyncExternalStore } from "react";
import type { TaskRun, TaskService, TaskState } from "../../services/tasks/service";
import { isFinal } from "../../services/tasks/service";

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

/**
 * The Run view (IDE-04): the workspace's tasks, each with Run, and its executions -- running ones
 * first -- with their state, their terminal, and Stop. A view of the workspace's TaskService;
 * running, stopping and showing a terminal are the window's commands (`onRun`, ...), which go
 * through the service.
 */
export function RunPanel({
  service,
  visible,
  hasWorkspace,
  onRun,
  onRunGroup,
  onStop,
  onShowTerminal,
  onConfigure,
}: {
  service: TaskService;
  visible: boolean;
  hasWorkspace: boolean;
  onRun: (taskId: string) => void;
  onRunGroup: (group: "build" | "test") => void;
  onStop: (executionId: string) => void;
  onShowTerminal: (run: TaskRun) => void;
  onConfigure: () => void;
}) {
  const { tasks, runs } = useSyncExternalStore(
    service.subscribe,
    service.getSnapshot,
    service.getSnapshot,
  );
  const labelOf = (executionId: string) =>
    runs.find((run) => run.executionId === executionId)?.label;
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
        <div className="min-h-0 flex-1 overflow-y-auto">
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

          <section aria-label="Tasks" className="px-2 pb-2">
            <h2 className="px-1 py-1 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
              Tasks
            </h2>
            {!tasks.length && (
              <p className="px-1 text-[11px] text-zinc-500">
                No tasks yet. Configure Tasks adds them, for you or for this workspace.
              </p>
            )}
            {tasks.map((task) => (
              <div
                key={task.id}
                role="group"
                aria-label={task.label}
                className="flex items-center gap-2 rounded px-1 py-1 hover:bg-[#0c0c0c]"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-zinc-200" title={task.command}>
                    {task.label}
                  </div>
                  <div className="truncate text-[10px] text-zinc-600">
                    {[
                      task.group,
                      task.isDefault ? "default" : null,
                      task.scope === "workspace" ? "workspace" : "user",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                </div>
                <button
                  aria-label={`Run ${task.label}`}
                  onClick={() => onRun(task.id)}
                  className="rounded px-1.5 py-0.5 text-[11px] text-indigo-300 hover:bg-[#1c1c1c]"
                >
                  Run
                </button>
              </div>
            ))}
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
                    <div className="text-[10px] text-zinc-600">before {labelOf(run.parent)}</div>
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
      )}
    </aside>
  );
}
