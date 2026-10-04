/**
 * The workspace's tasks (IDE-04): which tasks there are, running one with its dependencies, and
 * what each execution is doing -- never running anything itself.
 *
 * ```text
 * Run command ──> TaskService (one per workspace)
 *                   ├─ tasks: configuredTasks(settings)       (IDE-03 settings, user + workspace)
 *                   ├─ planTask: dependencies in order, cycles refused before anything runs
 *                   ├─ Workspace Trust: checked before any process starts
 *                   ├─ per task: shell + launch args (shell.ts), folder, environment
 *                   └─ TerminalService.open / restart ── a terminal session runs the command
 *                         ├─ output ──> TerminalView (as any terminal)
 *                         ├─ output ──> TaskOutputMatcher ──> publishProblems (one Problems store)
 *                         └─ state: Running / Exited(code) / Failed ──> the execution's state
 * ```
 *
 * TaskService does **not** own: PTYs or processes (the terminal's), output or scrollback (the
 * terminal's views), diagnostics or markers (Problems), the workspace (WorkspaceManager), or
 * where tasks are kept (the settings registry).
 *
 * An execution's states: `pending` -> `starting` -> `running` -> `succeeded` | `failed` |
 * `cancelled`; a pending one can also end `failed` (a dependency failed) or `cancelled`. Nothing
 * leaves a final state. Only the session an execution launched -- that session, that
 * generation -- moves it.
 */
import type { SettingsRegistry } from "../settings/settings.ts";
import type { TerminalService } from "../terminalService.ts";
import type { TerminalUi } from "../terminalUi.ts";
import type { ProfileRegistry, WorkspaceProfiles } from "../terminalProfiles.ts";
import type { Diagnostic } from "../panel/problemMatchers.ts";
import {
  TerminalError,
  type Generation,
  type TerminalId,
  type TerminalProfile,
  type WorkspaceId,
} from "../terminalProtocol.ts";
import { fileUri, fsPath, resolveWithin } from "../resource.ts";
import { TaskError } from "./errors.ts";
import { TASK_DEFINITIONS, configuredTasks, type ResolvedTask, type TaskGroup } from "./model.ts";
import { planTask } from "./plan.ts";
import { taskShellArgs } from "./shell.ts";
import { TaskOutputMatcher, resolveTaskDiagnostics } from "./matching.ts";

export type TaskState = "pending" | "starting" | "running" | "succeeded" | "failed" | "cancelled";

const NEXT: Record<TaskState, readonly TaskState[]> = {
  pending: ["starting", "failed", "cancelled"],
  starting: ["running", "failed", "cancelled"],
  running: ["succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

/** Whether an execution may move from `from` to `to`. */
export const canMove = (from: TaskState, to: TaskState): boolean => NEXT[from].includes(to);
export const isFinal = (state: TaskState): boolean => NEXT[state].length === 0;

/** One task's execution: runtime state only, never configuration. */
export interface TaskRun {
  readonly executionId: string;
  readonly taskId: string;
  readonly label: string;
  readonly state: TaskState;
  /** The execution this one runs before, when it is a dependency; `null` for the one asked for. */
  readonly parent: string | null;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  readonly exitCode: number | null;
  /** The terminal it runs in, once there is one. */
  readonly sessionId: TerminalId | null;
  /** Why it failed or was cancelled, fit to show. */
  readonly error: string | null;
}

export interface TaskSnapshot {
  readonly workspace: WorkspaceId | null;
  readonly tasks: readonly ResolvedTask[];
  /** Newest first: what is running, then what finished recently. */
  readonly runs: readonly TaskRun[];
  /** Changes when a task asks for its terminal to be shown (the window shows the panel). */
  readonly revealRequest: number;
}

export interface TaskServiceOptions {
  workspace: WorkspaceId | null;
  /** The workspace's folders: where tasks run, and which files their diagnostics may name. */
  folders: readonly string[];
  settings: SettingsRegistry;
  terminals: Pick<
    TerminalService,
    "open" | "get" | "subscribe" | "attach" | "write" | "kill" | "close" | "restart"
  >;
  ui: Pick<TerminalUi, "activate" | "restart">;
  /** The workspace's terminal profiles; discovery (`registry.load`) is awaited before a run. */
  profiles: Pick<WorkspaceProfiles, "resolve"> & { registry: Pick<ProfileRegistry, "load"> };
  /** Whether the folder is trusted now (Workspace Trust; asked before every execution). */
  trusted(): Promise<boolean>;
  publish(owner: string, label: string, diagnostics: readonly Diagnostic[]): void;
  /** How long a cancelled task has to stop after Ctrl+C before its terminal is killed. */
  killAfterMs?: number;
}

export interface TaskService {
  getSnapshot(): TaskSnapshot;
  subscribe(listener: () => void): () => void;
  /** The tasks of `group` that could be its default, and the one that is, if exactly one. */
  defaultTask(group: TaskGroup): { task: ResolvedTask | null; candidates: ResolvedTask[] };
  /**
   * Runs a task and its dependencies; resolves with the task's own execution once everything
   * has ended. Rejects with a `TaskError`, starting nothing, when it cannot run at all.
   */
  run(taskId: string): Promise<TaskRun>;
  /** Stops an execution (its dependencies too): Ctrl+C, then its terminal killed if need be. */
  cancel(executionId: string): void;
  dispose(): void;
}

/** The problem matchers' owner in the Problems store, per task: a new run replaces the last. */
export const taskOwner = (taskId: string) => `task:${taskId}`;
const MAX_FINISHED = 20;
let executions = 0;

interface Active {
  run: TaskRun;
  task: ResolvedTask;
  /** The top-level execution it belongs to. */
  root: string;
  generation: Generation | null;
  finish: (state: "succeeded" | "failed" | "cancelled", patch?: Partial<TaskRun>) => void;
}

export function createTaskService(options: TaskServiceOptions): TaskService {
  const { terminals } = options;
  const killAfter = options.killAfterMs ?? 3000;
  const listeners = new Set<() => void>();
  let disposed = false;
  let runs: TaskRun[] = [];
  let snapshot: TaskSnapshot;
  let revealRequest = 0;
  /** Each running task's session watch, by execution id. */
  const active = new Map<string, Active>();
  /** Executions asked to stop, by top-level id. */
  const cancelled = new Set<string>();
  /** The terminal each dedicated task reuses. */
  const dedicated = new Map<string, TerminalId>();
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const tasks = () => configuredTasks(options.settings, options.workspace);
  const publishSnapshot = () => {
    snapshot = Object.freeze({
      workspace: options.workspace,
      tasks: Object.freeze(tasks()),
      runs: Object.freeze([...runs]),
      revealRequest,
    });
    for (const listener of [...listeners])
      try {
        listener();
      } catch {
        /* A listener's failure is not the service's. */
      }
  };
  publishSnapshot();

  const update = (executionId: string, patch: Partial<TaskRun>): TaskRun | null => {
    const at = runs.findIndex((run) => run.executionId === executionId);
    if (at === -1) return null;
    const current = runs[at];
    if (patch.state && patch.state !== current.state && !canMove(current.state, patch.state))
      return null; // a final execution never moves again
    const next = Object.freeze({ ...current, ...patch });
    runs = [...runs.slice(0, at), next, ...runs.slice(at + 1)];
    // Only the most recent finished executions are kept.
    const finished = runs.filter((run) => isFinal(run.state));
    if (finished.length > MAX_FINISHED) {
      const drop = new Set(finished.slice(MAX_FINISHED).map((run) => run.executionId));
      runs = runs.filter((run) => !drop.has(run.executionId));
    }
    // Even once disposed: the snapshot says how its executions ended (no listeners are left).
    publishSnapshot();
    return next;
  };
  const reveal = (sessionId: TerminalId) => {
    options.ui.activate(sessionId);
    revealRequest += 1;
    publishSnapshot();
  };

  // One watch for every running task: each execution is moved only by its own session and
  // generation; a session that went (killed, closed) ends it.
  const stopWatching = terminals.subscribe(() => {
    for (const watch of [...active.values()]) {
      const { run } = watch;
      if (!run.sessionId || watch.generation === null) continue;
      const view = terminals.get(run.sessionId);
      if (!view) {
        watch.finish(cancelled.has(watch.root) ? "cancelled" : "failed", {
          error: cancelled.has(watch.root) ? "Stopped." : "Its terminal was closed.",
        });
        continue;
      }
      if (view.generation !== watch.generation) {
        watch.finish("failed", { error: "Its terminal was restarted." });
        continue;
      }
      if (view.state === "Running" && run.state === "starting") {
        watch.run = update(run.executionId, { state: "running" }) ?? run;
      } else if (view.state === "Exited") {
        const stopped = cancelled.has(watch.root);
        watch.finish(stopped ? "cancelled" : view.exitCode === 0 ? "succeeded" : "failed", {
          exitCode: view.exitCode,
          error: stopped
            ? "Stopped."
            : view.exitCode === 0
              ? null
              : `Exited with code ${view.exitCode}.`,
        });
      } else if (view.state === "Failed") {
        watch.finish("failed", { error: view.error ?? "Its terminal failed." });
      }
    }
  });
  // Tasks are settings: when they change for this workspace, the list does.
  const stopSettings = options.settings.subscribe(options.workspace, (change) => {
    if (change.id === TASK_DEFINITIONS.id && !disposed) publishSnapshot();
  });

  /** Where a task runs: inside the workspace, or it does not run. */
  const folderOf = (task: ResolvedTask): string => {
    const root = options.folders[0];
    if (!root) throw new TaskError("NoWorkspace", "Open a folder to run tasks.");
    try {
      return fsPath(resolveWithin(fileUri(root), task.cwd ?? "."));
    } catch {
      throw new TaskError(
        "InvalidCwd",
        `Task "${task.label}" runs in "${task.cwd}", which is not a folder of this workspace.`,
      );
    }
  };

  /** Everything a task needs to start, checked before any task of the plan starts. */
  const prepare = (task: ResolvedTask): { profile: TerminalProfile; cwd: string } => {
    let entry;
    try {
      entry = options.profiles.resolve(task.profile ?? undefined);
    } catch (error) {
      throw new TaskError(
        "ShellUnavailable",
        `Task "${task.label}" cannot start: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const args = taskShellArgs(entry.kind, entry.profile.name, task.command, task.args);
    const cwd = folderOf(task);
    return {
      cwd,
      profile: {
        id: `task.${task.id}`,
        name: task.label,
        executable: entry.profile.executable,
        args,
        cwd: null,
        env: [
          ...entry.profile.env.map(([k, v]) => [k, v] as [string, string]),
          ...Object.entries(task.env),
        ],
        ...(entry.profile.login ? { login: true } : {}),
      },
    };
  };

  /** Starts one task of an execution in its terminal; resolves with how it ended. */
  const launch = (
    run: TaskRun,
    task: ResolvedTask,
    root: string,
    prepared: { profile: TerminalProfile; cwd: string },
  ): Promise<TaskState> =>
    new Promise((resolve) => {
      let current = update(run.executionId, { state: "starting", startedAt: Date.now() }) ?? run;
      const matcher = new TaskOutputMatcher(task.problemMatcher);
      let detach = () => {};
      const watch: Active = {
        run: current,
        task,
        root,
        generation: null,
        finish(state, patch = {}) {
          if (!active.has(current.executionId)) return;
          active.delete(current.executionId);
          detach();
          const ended = update(current.executionId, {
            ...patch,
            state,
            finishedAt: Date.now(),
          });
          // What the task's matchers found replaces what its last run found; a stopped run
          // proves nothing, so it changes nothing.
          if (state !== "cancelled" && matcher.active && !disposed) {
            const { diagnostics } = resolveTaskDiagnostics(
              matcher.finish(),
              prepared.cwd,
              options.folders,
            );
            options.publish(taskOwner(task.id), task.label, diagnostics);
          }
          if (state === "failed" && task.presentation.reveal === "silent" && ended?.sessionId)
            reveal(ended.sessionId);
          resolve(state);
        },
      };
      active.set(current.executionId, watch);

      let sessionId: TerminalId;
      try {
        const reused = dedicatedSession(task, prepared);
        if (reused) {
          sessionId = reused;
          // Restarting is a new generation of the same terminal: the old output's views go.
          if (task.presentation.clear) options.ui.restart(sessionId);
          else terminals.restart(sessionId);
        } else {
          sessionId = terminals.open({
            title: `Task: ${task.label}`,
            profile: prepared.profile,
            cwd: prepared.cwd,
          });
          if (task.presentation.terminal === "dedicated") dedicated.set(task.id, sessionId);
        }
      } catch (error) {
        watch.finish("failed", {
          error:
            error instanceof TerminalError || error instanceof Error
              ? `Its terminal could not start: ${error.message}`
              : "Its terminal could not start.",
        });
        return;
      }
      current = update(current.executionId, { sessionId }) ?? current;
      watch.run = current;
      watch.generation = terminals.get(sessionId)?.generation ?? null;
      // The output, from the generation's start: to the matchers (the terminal shows it too).
      if (matcher.active) {
        const attachment = terminals.attach(sessionId, {
          output: (chunk, accepted) => {
            matcher.push(chunk.bytes);
            accepted();
          },
          ended: () => {},
        });
        detach = () => attachment.detach();
      }
      if (task.presentation.reveal === "always") reveal(sessionId);
      // Asked to stop while it was being started.
      if (cancelled.has(root)) stopActive(watch);
    });

  /** The dedicated terminal to run `task` in again, if its last one can be reused as it is. */
  const dedicatedSession = (
    task: ResolvedTask,
    prepared: { profile: TerminalProfile; cwd: string },
  ): TerminalId | null => {
    if (task.presentation.terminal !== "dedicated") return null;
    const id = dedicated.get(task.id);
    if (!id) return null;
    const view = terminals.get(id);
    if (!view) {
      dedicated.delete(task.id);
      return null;
    }
    // The same command, shell and folder: a restart runs it again. Otherwise the old terminal,
    // which ran something else, is let go and a new one opens.
    const same =
      JSON.stringify(view.profile) === JSON.stringify(prepared.profile) &&
      view.cwd === prepared.cwd;
    if (same && (view.state === "Exited" || view.state === "Failed")) return id;
    if (view.state === "Exited" || view.state === "Failed")
      void terminals.close(id).catch(() => {});
    dedicated.delete(task.id);
    return null;
  };

  /** Stops one running task: Ctrl+C first; if it is still there after a moment, its tree is killed. */
  const stopActive = (watch: Active) => {
    const id = watch.run.sessionId;
    if (!id) return;
    const view = terminals.get(id);
    if (!view) return;
    if (view.state !== "Running") {
      void terminals.kill(id).catch(() => {});
      return;
    }
    void terminals.write(id, "\u0003").catch(() => {});
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (active.has(watch.run.executionId)) void terminals.kill(id).catch(() => {});
    }, killAfter);
    timers.add(timer);
  };

  const service: TaskService = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    defaultTask(group) {
      const candidates = tasks().filter((task) => task.group === group);
      const defaults = candidates.filter((task) => task.isDefault);
      if (defaults.length === 1) return { task: defaults[0], candidates };
      if (defaults.length === 0 && candidates.length === 1)
        return { task: candidates[0], candidates };
      return { task: null, candidates: defaults.length > 1 ? defaults : candidates };
    },

    async run(taskId) {
      if (disposed || options.workspace === null || !options.folders.length)
        throw new TaskError("NoWorkspace", "Open a folder to run its tasks.");
      // The whole plan is checked before anything runs: unknown tasks, cycles, shells, folders.
      const plan = planTask(tasks(), taskId);
      if (!(await options.trusted().catch(() => false)))
        throw new TaskError(
          "TrustDenied",
          "This folder is not trusted, so Yavin does not run its tasks. Trust it from File › Manage Workspace Trust to run them.",
        );
      // The shells are discovered once, when a terminal first needs them -- which may be now,
      // before the panel was ever opened. Discovery settles either way (never rejects).
      await options.profiles.registry.load();
      if (disposed) throw new TaskError("NoWorkspace", "The workspace was closed.");
      const prepared = plan.map((task) => prepare(task));
      const busy = plan.find((task) =>
        [...active.values()].some((watch) => watch.task.id === task.id),
      );
      if (busy)
        throw new TaskError(
          "AlreadyRunning",
          `Task "${busy.label}" is already running. Stop it first, or wait for it to finish.`,
        );

      const root = `task-${++executions}`;
      const target = plan[plan.length - 1];
      const planned: TaskRun[] = plan.map((task, index) =>
        Object.freeze({
          executionId: task === target ? root : `${root}.${index}`,
          taskId: task.id,
          label: task.label,
          state: "pending" as TaskState,
          parent: task === target ? null : root,
          startedAt: null,
          finishedAt: null,
          exitCode: null,
          sessionId: null,
          error: null,
        }),
      );
      runs = [...planned.slice().reverse(), ...runs];
      publishSnapshot();

      // In order: each must succeed before the next starts.
      let failedAt: TaskRun | null = null;
      for (const [index, run] of planned.entries()) {
        if (disposed || cancelled.has(root)) break;
        const state = await launch(run, plan[index], root, prepared[index]);
        if (state !== "succeeded") {
          failedAt = run;
          break;
        }
      }
      // What did not start: cancelled with the execution, or failed because one before it did.
      for (const run of planned) {
        const now = runs.find((one) => one.executionId === run.executionId);
        if (now?.state !== "pending") continue;
        if (cancelled.has(root) || disposed)
          update(run.executionId, { state: "cancelled", error: "Stopped." });
        else
          update(run.executionId, {
            state: "failed",
            error: `Not run: "${failedAt?.label}" before it did not succeed.`,
          });
      }
      cancelled.delete(root);
      return runs.find((one) => one.executionId === root) ?? planned[planned.length - 1];
    },

    cancel(executionId) {
      const run = runs.find((one) => one.executionId === executionId);
      if (!run || isFinal(run.state)) return;
      const root = run.parent ?? run.executionId;
      cancelled.add(root);
      for (const watch of active.values()) if (watch.root === root) stopActive(watch);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      stopWatching();
      stopSettings();
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      // The workspace is going: what its tasks are running is ended, now.
      for (const watch of [...active.values()]) {
        cancelled.add(watch.root);
        if (watch.run.sessionId) void terminals.kill(watch.run.sessionId).catch(() => {});
        watch.finish("cancelled", { error: "The workspace was closed." });
      }
      listeners.clear();
    },
  };
  return service;
}
