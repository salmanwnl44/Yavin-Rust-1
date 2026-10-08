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
 *
 * - **One execution of a task at a time.** Running a task that runs is refused; a dependency
 *   already running for another execution is waited for and its outcome used -- never started
 *   a second time (Run/Tasks Module 01).
 * - **A run ends when its output has been read.** The exit and the output arrive on separate
 *   channels, the exit possibly first: a run with matchers ends at its output channel's end,
 *   or `drainTimeoutMs` after the exit (`outputComplete: false`).
 * - **A task's terminal is the task's.** A dedicated terminal that outlived the last workspace
 *   context is found again (its profile id is `task.<id>`) rather than a second one opened, and
 *   its Restart in the terminal UI is `restart` -- trust, the one-execution rule, a record and
 *   the matchers -- never the command started again behind the service's back.
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
  /**
   * Whether its problem matchers read all of its output: `false` when the output could not be
   * read to its end (its output channel failed, or did not end in time after the exit), so
   * what it published may be missing problems. `null` before it ends, or without matchers.
   */
  readonly outputComplete: boolean | null;
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
    "open" | "get" | "list" | "subscribe" | "attach" | "write" | "kill" | "close" | "restart"
  >;
  /** The workspace's terminal UI; a task's terminal restarted from it runs the task again. */
  ui: Pick<TerminalUi, "activate" | "restart"> & Partial<Pick<TerminalUi, "interceptRestart">>;
  /** The workspace's terminal profiles; discovery (`registry.load`) is awaited before a run. */
  profiles: Pick<WorkspaceProfiles, "resolve"> & { registry: Pick<ProfileRegistry, "load"> };
  /** Whether the folder is trusted now (Workspace Trust; asked before every execution). */
  trusted(): Promise<boolean>;
  publish(owner: string, label: string, diagnostics: readonly Diagnostic[]): void;
  /** How long a cancelled task has to stop after Ctrl+C before its terminal is killed. */
  killAfterMs?: number;
  /**
   * How long, after its exit, a task's output may take to be read to its end. The exit and the
   * output travel on separate channels (`terminal_stream.rs`), and the exit can come first.
   */
  drainTimeoutMs?: number;
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
  /**
   * Runs a task again: a running execution of it is stopped first (as `cancel` stops it), then
   * it runs as `run` runs it -- trust, dependencies, its terminal, its matchers, its record.
   */
  restart(taskId: string): Promise<TaskRun>;
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
  /**
   * Its process ended: it finishes once its output has been read to the end (see
   * `drainTimeoutMs`); at once when it was stopped or nothing reads its output.
   */
  ended: (state: "succeeded" | "failed" | "cancelled", patch?: Partial<TaskRun>) => void;
  /** Ended, waiting for the rest of its output. */
  draining: boolean;
  /** How it ended, once it has. */
  done: Promise<TaskState>;
}

/** A task's terminal: the profile id TaskService gives it (`prepare`). */
const taskProfileId = (taskId: string) => `task.${taskId}`;
const taskOfProfile = (profileId: string | null): string | null =>
  profileId?.startsWith("task.") ? profileId.slice("task.".length) : null;

export function createTaskService(options: TaskServiceOptions): TaskService {
  const { terminals } = options;
  const killAfter = options.killAfterMs ?? 3000;
  const drainTimeout = options.drainTimeoutMs ?? 5000;
  const listeners = new Set<() => void>();
  /** What wakes a run waiting on another execution, when its own is stopped (by root id). */
  const wakers = new Map<string, Set<() => void>>();
  /** The terminal TaskService is restarting itself: not a Restart for it to claim. */
  let restartingOwn: TerminalId | null = null;
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
      if (!run.sessionId || watch.generation === null || watch.draining) continue;
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
        watch.ended(stopped ? "cancelled" : view.exitCode === 0 ? "succeeded" : "failed", {
          exitCode: view.exitCode,
          error: stopped
            ? "Stopped."
            : view.exitCode === 0
              ? null
              : `Exited with code ${view.exitCode}.`,
        });
      } else if (view.state === "Failed") {
        watch.ended("failed", { error: view.error ?? "Its terminal failed." });
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
        id: taskProfileId(task.id),
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
  ): Promise<TaskState> => {
    let resolveDone!: (state: TaskState) => void;
    const done = new Promise<TaskState>((resolve) => (resolveDone = resolve));
    let current = update(run.executionId, { state: "starting", startedAt: Date.now() }) ?? run;
    const matcher = new TaskOutputMatcher(task.problemMatcher);
    let detach = () => {};
    // The output channel's end: every byte of the generation has reached the matchers. Without
    // matchers there is nothing to wait for.
    let outputEnded = !matcher.active;
    let outputFailed = false;
    let drained: { state: "succeeded" | "failed" | "cancelled"; patch: Partial<TaskRun> } | null =
      null;
    let drainTimer: ReturnType<typeof setTimeout> | null = null;
    const watch: Active = {
      run: current,
      task,
      root,
      generation: null,
      draining: false,
      done,
      finish(state, patch = {}) {
        if (!active.has(current.executionId)) return;
        active.delete(current.executionId);
        if (drainTimer) {
          clearTimeout(drainTimer);
          timers.delete(drainTimer);
          drainTimer = null;
        }
        detach();
        // A stopped run proves nothing, so what it printed changes nothing.
        const read = matcher.active && state !== "cancelled";
        const ended = update(current.executionId, {
          ...patch,
          state,
          finishedAt: Date.now(),
          outputComplete: read ? outputEnded && !outputFailed : null,
        });
        // What the task's matchers found replaces what its last run found.
        if (read && !disposed) {
          const { diagnostics } = resolveTaskDiagnostics(
            matcher.finish(),
            prepared.cwd,
            options.folders,
          );
          options.publish(taskOwner(task.id), task.label, diagnostics);
        }
        if (state === "failed" && task.presentation.reveal === "silent" && ended?.sessionId)
          reveal(ended.sessionId);
        resolveDone(state);
      },
      ended(state, patch = {}) {
        if (!active.has(current.executionId) || watch.draining) return;
        if (outputEnded || state === "cancelled") {
          watch.finish(state, patch);
          return;
        }
        // The exit came first: the output still on its way is read before the run ends.
        watch.draining = true;
        drained = { state, patch };
        const timer = setTimeout(() => {
          timers.delete(timer);
          drainTimer = null;
          watch.finish(state, patch);
        }, drainTimeout);
        drainTimer = timer;
        timers.add(timer);
      },
    };
    active.set(current.executionId, watch);

    let sessionId: TerminalId;
    try {
      const reused = dedicatedSession(task, prepared);
      if (reused) {
        sessionId = reused;
        // Restarting is a new generation of the same terminal: the old output's views go.
        if (task.presentation.clear) {
          restartingOwn = sessionId;
          try {
            options.ui.restart(sessionId);
          } finally {
            restartingOwn = null;
          }
        } else terminals.restart(sessionId);
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
      return done;
    }
    current = update(current.executionId, { sessionId }) ?? current;
    watch.run = current;
    watch.generation = terminals.get(sessionId)?.generation ?? null;
    // The output, from the generation's start: to the matchers (the terminal shows it too).
    // Its end comes after all of it, on the same channel.
    if (matcher.active) {
      const attachment = terminals.attach(sessionId, {
        output: (chunk, accepted) => {
          matcher.push(chunk.bytes);
          accepted();
        },
        ended: (_message, failed) => {
          outputEnded = true;
          outputFailed = failed;
          if (drained) watch.finish(drained.state, drained.patch);
        },
      });
      detach = () => attachment.detach();
    }
    if (task.presentation.reveal === "always") reveal(sessionId);
    // Asked to stop while it was being started.
    if (cancelled.has(root)) stopActive(watch);
    return done;
  };

  /**
   * The dedicated terminal to run `task` in again, if its last one can be reused as it is: the
   * one this service opened, or -- the workspace opened again, its terminals having outlived
   * the last context -- the workspace's own task terminal for it that has ended.
   */
  const dedicatedSession = (
    task: ResolvedTask,
    prepared: { profile: TerminalProfile; cwd: string },
  ): TerminalId | null => {
    if (task.presentation.terminal !== "dedicated") return null;
    const id = dedicated.get(task.id) ?? surviving(task);
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
    if (same && (view.state === "Exited" || view.state === "Failed")) {
      dedicated.set(task.id, id);
      return id;
    }
    if (view.state === "Exited" || view.state === "Failed")
      void terminals.close(id).catch(() => {});
    dedicated.delete(task.id);
    return null;
  };

  /** This workspace's latest ended terminal of `task`, from before this service existed. */
  const surviving = (task: ResolvedTask): TerminalId | null =>
    terminals
      .list()
      .filter(
        (view) =>
          view.workspaceId === options.workspace &&
          view.profileId === taskProfileId(task.id) &&
          (view.state === "Exited" || view.state === "Failed"),
      )
      .at(-1)?.sessionId ?? null;

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

  /** The execution of `taskId` running now, whichever execution started it. */
  const runningOf = (taskId: string): Active | undefined =>
    [...active.values()].find((watch) => watch.task.id === taskId);

  /** Settles when the execution `root` is asked to stop (or the workspace goes). */
  const stopped = (root: string): Promise<"stopped"> =>
    new Promise((resolve) => {
      if (cancelled.has(root) || disposed) return resolve("stopped");
      let set = wakers.get(root);
      if (!set) wakers.set(root, (set = new Set()));
      set.add(() => resolve("stopped"));
    });

  /** A run that could not start, recorded with why: what the terminal's Restart shows. */
  const refused = (taskId: string, error: unknown) => {
    if (disposed) return;
    const now = Date.now();
    const task = tasks().find((one) => one.id === taskId);
    runs = [
      Object.freeze({
        executionId: `task-${++executions}`,
        taskId,
        label: task?.label ?? taskId,
        state: "failed" as TaskState,
        parent: null,
        startedAt: null,
        finishedAt: now,
        exitCode: null,
        sessionId: null,
        error: error instanceof Error ? error.message : String(error),
        outputComplete: null,
      }),
      ...runs,
    ];
    update(runs[0].executionId, {}); // keeps only the most recent finished runs
  };

  /**
   * A task's terminal restarted from the terminal UI is the task run again, through every check
   * a run has -- never a second way to start its command. Its profile names the task. One this
   * service is restarting itself (a dedicated terminal reused) is not claimed.
   */
  const restartTerminal = (id: TerminalId): boolean => {
    if (disposed || id === restartingOwn) return false;
    const view = terminals.get(id);
    const taskId = view && view.workspaceId === options.workspace && taskOfProfile(view.profileId);
    if (!taskId) return false;
    if (!tasks().some((task) => task.id === taskId)) {
      refused(taskId, new TaskError("UnknownTask", `There is no task "${taskId}" any more.`));
      return true;
    }
    void service.restart(taskId).catch((error) => refused(taskId, error));
    return true;
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
      // One execution of a task at a time. The task asked for is refused while it runs; a
      // dependency running for something else is waited for when its turn comes (below).
      const target = plan[plan.length - 1];
      if (runningOf(target.id))
        throw new TaskError(
          "AlreadyRunning",
          `Task "${target.label}" is already running. Stop it first, or wait for it to finish.`,
        );

      const root = `task-${++executions}`;
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
          outputComplete: null,
        }),
      );
      runs = [...planned.slice().reverse(), ...runs];
      publishSnapshot();

      // In order: each must succeed before the next starts.
      let failedAt: TaskRun | null = null;
      for (const [index, run] of planned.entries()) {
        if (disposed || cancelled.has(root)) break;
        const elsewhere = runningOf(run.taskId);
        let state: TaskState | "stopped";
        if (elsewhere) {
          // Already running for something else: that execution is this step -- it is waited
          // for, not started a second time, and this step's own record goes (one record per
          // execution). Stopping this execution stops the waiting, not that one.
          runs = runs.filter((one) => one.executionId !== run.executionId);
          publishSnapshot();
          state = await Promise.race([elsewhere.done, stopped(root)]);
        } else state = await launch(run, plan[index], root, prepared[index]);
        if (state === "stopped") break;
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
      wakers.delete(root);
      return runs.find((one) => one.executionId === root) ?? planned[planned.length - 1];
    },

    async restart(taskId) {
      const running = runningOf(taskId);
      if (running) {
        service.cancel(running.root);
        await running.done;
      }
      return service.run(taskId);
    },

    cancel(executionId) {
      const run = runs.find((one) => one.executionId === executionId);
      if (!run || isFinal(run.state)) return;
      const root = run.parent ?? run.executionId;
      cancelled.add(root);
      for (const watch of active.values()) if (watch.root === root) stopActive(watch);
      for (const wake of wakers.get(root) ?? []) wake();
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      stopWatching();
      stopSettings();
      stopRestarts();
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const wake of [...wakers.values()].flatMap((set) => [...set])) wake();
      wakers.clear();
      // The workspace is going: what its tasks are running is ended, now.
      for (const watch of [...active.values()]) {
        cancelled.add(watch.root);
        if (watch.run.sessionId) void terminals.kill(watch.run.sessionId).catch(() => {});
        watch.finish("cancelled", { error: "The workspace was closed." });
      }
      listeners.clear();
    },
  };
  const stopRestarts = options.ui.interceptRestart?.(restartTerminal) ?? (() => {});
  return service;
}
