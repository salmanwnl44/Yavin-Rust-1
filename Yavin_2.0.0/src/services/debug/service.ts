/**
 * The workspace's debugger (IDE-05): one DebugService per workspace, orchestrating at most one
 * debug session at a time over the Debug Adapter Protocol.
 *
 * ```text
 * Run › Start Debugging / Debug view
 *        ▼
 * DebugService ── configurations   debug.configurations (IDE-03 settings, user + workspace)
 *        │      ── breakpoints      the workspace's set, by ResourceId (breakpoints.ts)
 *        │      ── trust            Workspace Trust, before anything starts
 *        │      ── preLaunchTask    TaskService.run (IDE-04), when the configuration names one
 *        ▼
 * DapConnection (connection.ts) ── requests / responses / events, by seq
 *        ▼
 * AdapterTransport ── native dap.rs on the shared process host (framing, Job Object)
 *        ▼
 * debug adapter (debugpy) ── debuggee
 * ```
 *
 * It owns the session's state and the model the Debug view shows: threads, the selected
 * thread's stack, the selected frame's scopes, variables fetched one level at a time, and the
 * Debug Console. It does not own processes (the native host does), terminals, tasks,
 * diagnostics, editor models or decorations, workspace identity or settings persistence. It
 * never polls: everything follows a DAP event or a user action, and a stack, scopes and
 * variables are asked for only while stopped -- answers that arrive after the program moved
 * on are dropped (`epoch`).
 */
import {
  basename,
  fileUri,
  fsPath,
  resolveWithin,
  resourceId,
  type ResourceId,
} from "../resource.ts";
import type { SettingsRegistry } from "../settings/settings.ts";
import type { WorkspaceId } from "../terminalProtocol.ts";
import { adapterById } from "./adapters.ts";
import type { BreakpointEntry, Breakpoints } from "./breakpoints.ts";
import {
  configuredDebugConfigurations,
  DEBUG_CONFIGURATIONS,
  DEBUG_PYTHON,
  type ResolvedDebugConfiguration,
} from "./config.ts";
import { DapConnection, type AdapterTransport, type ConnectionEnd } from "./connection.ts";
import { DebugError, nativeDebugError } from "./errors.ts";
import type {
  Breakpoint,
  BreakpointEventBody,
  Capabilities,
  ContinuedEventBody,
  EvaluateResponseBody,
  Event,
  ExitedEventBody,
  OutputEventBody,
  Scope,
  StackFrame,
  StoppedEventBody,
  Thread,
  ThreadEventBody,
  Variable,
} from "./protocol.ts";

export type DebugState =
  | "created"
  | "starting"
  | "initializing"
  | "running"
  | "stopped"
  | "terminating"
  | "terminated"
  | "failed";

const NEXT: Record<DebugState, readonly DebugState[]> = {
  created: ["starting", "terminated", "failed"],
  starting: ["initializing", "terminating", "terminated", "failed"],
  // A program may stop before `launch` is answered (stopOnEntry).
  initializing: ["running", "stopped", "terminating", "terminated", "failed"],
  running: ["stopped", "terminating", "terminated", "failed"],
  stopped: ["running", "terminating", "terminated", "failed"],
  terminating: ["terminated", "failed"],
  terminated: [],
  failed: [],
};

export const canMove = (from: DebugState, to: DebugState) => NEXT[from].includes(to);
export const isFinal = (state: DebugState) => state === "terminated" || state === "failed";

export interface DebugSessionInfo {
  sessionId: string;
  workspace: WorkspaceId;
  state: DebugState;
  adapter: string;
  configuration: ResolvedDebugConfiguration;
  capabilities: Capabilities;
  startedAt: number;
  /** When it last stopped; `null` while it has not, or runs again. */
  stoppedAt: number | null;
  endedAt: number | null;
  stoppedReason: string | null;
  /** Why it ended, in words. */
  terminationReason: string | null;
  exitCode: number | null;
  error: { code: DebugError["code"]; message: string } | null;
}

export interface ThreadView {
  id: number;
  name: string;
  state: "running" | "stopped";
}

export interface FrameView {
  id: number;
  name: string;
  line: number;
  column: number;
  /** The file it is in, when the adapter gave a path. */
  path: string | null;
  resource: ResourceId | null;
  sourceName: string | null;
  module: string | null;
  /** Deemphasized by the adapter (library code). */
  subtle: boolean;
}

export interface ScopeView {
  name: string;
  variablesReference: number;
  expensive: boolean;
}

export interface VariableView {
  name: string;
  value: string;
  type: string | null;
  /** Non-zero: it has children, fetched (once per stop) by `expand`. */
  variablesReference: number;
}

export interface ConsoleEntry {
  id: number;
  kind: "input" | "result" | "error" | "stdout" | "stderr" | "console";
  text: string;
}

export interface DebugSnapshot {
  workspace: WorkspaceId | null;
  configurations: readonly ResolvedDebugConfiguration[];
  session: DebugSessionInfo | null;
  threads: readonly ThreadView[];
  selectedThreadId: number | null;
  frames: readonly FrameView[];
  selectedFrameId: number | null;
  scopes: readonly ScopeView[];
  /** Variables fetched this stop, by `variablesReference`. */
  variables: ReadonlyMap<number, readonly VariableView[]>;
  console: readonly ConsoleEntry[];
  /** Where the editor should go: the selected frame, once per selection (`nonce`). */
  focus: { path: string; line: number; column: number; nonce: number } | null;
}

/** What a step command can do now, by the session's state and the adapter's capabilities. */
export interface DebugControls {
  start: boolean;
  continue: boolean;
  pause: boolean;
  stepOver: boolean;
  stepInto: boolean;
  stepOut: boolean;
  restart: boolean;
  stop: boolean;
  evaluate: boolean;
}

export interface DebugServiceOptions {
  workspace: WorkspaceId | null;
  folders: readonly string[];
  settings: SettingsRegistry;
  breakpoints: Breakpoints | null;
  transport: AdapterTransport;
  /** Whether the folder is trusted now (Workspace Trust; asked before every session). */
  trusted(): Promise<boolean>;
  /** Runs a task (IDE-04) and resolves to how it ended: a configuration's `preLaunchTask`. */
  runTask?: (taskId: string) => Promise<{ state: string; error: string | null }>;
  /** How long a stopping adapter has to answer `terminate` / `disconnect`. */
  stopTimeoutMs?: number;
  /** How long an adapter has to send `initialized`, and answer `launch` / `attach`. */
  startTimeoutMs?: number;
}

export interface DebugService {
  getSnapshot(): DebugSnapshot;
  subscribe(listener: () => void): () => void;
  controls(): DebugControls;
  /** Starts configuration `configId` (the only one, when there is one). */
  start(configId?: string): Promise<void>;
  stop(): Promise<void>;
  continue(): Promise<void>;
  pause(): Promise<void>;
  stepOver(): Promise<void>;
  stepInto(): Promise<void>;
  stepOut(): Promise<void>;
  restart(): Promise<void>;
  selectThread(threadId: number): Promise<void>;
  selectFrame(frameId: number): Promise<void>;
  /** A variable's (or scope's) children, fetched once per stop; `null` when the stop is over. */
  expand(variablesReference: number): Promise<readonly VariableView[] | null>;
  evaluate(expression: string): Promise<void>;
  clearConsole(): void;
  dispose(): void;
}

const MAX_CONSOLE = 2_000;

/** A live session: the protocol connection and what was learned since it started. */
interface Live {
  info: DebugSessionInfo;
  connection: DapConnection | null;
  launchArgs: Record<string, unknown> | null;
  /** Breakpoints may be sent: the adapter said `initialized`. */
  configured: boolean;
  /** Per file, the latest `setBreakpoints` sent: an older answer is ignored. */
  sent: Map<ResourceId, number>;
  /** Asked to stop by the user (or the workspace): its end is not a failure. */
  stopping: boolean;
}

export function createDebugService(options: DebugServiceOptions): DebugService {
  const listeners = new Set<() => void>();
  const stopTimeout = options.stopTimeoutMs ?? 3_000;
  const startTimeout = options.startTimeoutMs ?? 30_000;
  let disposed = false;
  let generation = 0;
  let live: Live | null = null;
  /** Bumped whenever the program stops or runs again: older answers are stale. */
  let epoch = 0;
  /** Bumped whenever another frame is selected: older scopes are stale. */
  let frameEpoch = 0;
  let consoleId = 0;
  /** `variables` requests on their way, by stop and reference. */
  const fetching = new Map<string, Promise<{ variables?: Variable[] }>>();
  let focusNonce = 0;
  let state = {
    threads: [] as ThreadView[],
    selectedThreadId: null as number | null,
    frames: [] as FrameView[],
    selectedFrameId: null as number | null,
    scopes: [] as ScopeView[],
    variables: new Map<number, readonly VariableView[]>(),
    console: [] as ConsoleEntry[],
    focus: null as DebugSnapshot["focus"],
  };

  const configurations = () =>
    options.workspace === null
      ? []
      : configuredDebugConfigurations(options.settings, options.workspace);

  const build = (): DebugSnapshot => ({
    workspace: options.workspace,
    configurations: configurations(),
    session: live ? { ...live.info } : null,
    threads: state.threads,
    selectedThreadId: state.selectedThreadId,
    frames: state.frames,
    selectedFrameId: state.selectedFrameId,
    scopes: state.scopes,
    variables: state.variables,
    console: state.console,
    focus: state.focus,
  });
  let snapshot = build();
  const publish = () => {
    snapshot = build();
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        /* One listener's failure is not the others'. */
      }
    }
  };

  /** The program's output line still being written (no newline yet), by its stream. */
  let openLine: ConsoleEntry["kind"] | null = null;
  const say = (kind: ConsoleEntry["kind"], text: string) => {
    openLine = null;
    const next = [...state.console, { id: ++consoleId, kind, text }];
    state = { ...state, console: next.length > MAX_CONSOLE ? next.slice(-MAX_CONSOLE) : next };
  };
  /**
   * Output is a stream: a line may come in pieces ("result", " 3", "\n"), and one event may
   * hold several lines. A piece continues its stream's unfinished line; each newline ends one.
   */
  const write = (kind: ConsoleEntry["kind"], output: string) => {
    const lines = output.replace(/\r\n/g, "\n").split("\n");
    const ended = output.endsWith("\n");
    if (ended) lines.pop();
    lines.forEach((line, index) => {
      const last = state.console.at(-1);
      if (index === 0 && openLine === kind && last?.kind === kind)
        state = {
          ...state,
          console: [...state.console.slice(0, -1), { ...last, text: last.text + line }],
        };
      else say(kind, line);
      openLine = kind;
    });
    if (ended) openLine = null;
  };

  /** The program runs again (or ended): nothing of the last stop is current. */
  const forgetStop = () => {
    epoch++;
    frameEpoch++;
    state = {
      ...state,
      threads: state.threads.map((thread) => ({ ...thread, state: "running" })),
      frames: [],
      selectedFrameId: null,
      scopes: [],
      variables: new Map(),
      focus: null,
    };
  };

  const move = (session: Live, to: DebugState) => {
    if (session.info.state === to) return;
    if (!canMove(session.info.state, to))
      throw new DebugError(
        "StaleSession",
        `A debug session cannot go from ${session.info.state} to ${to}.`,
      );
    session.info = { ...session.info, state: to };
    if (to !== "stopped") session.info.stoppedAt = null;
  };

  const isCurrent = (session: Live) => live === session && !disposed;

  /** The session is over: its adapter is ended and nothing it says is listened to again. */
  const finish = (
    session: Live,
    to: "terminated" | "failed",
    reason: string,
    error?: DebugError,
  ) => {
    if (isFinal(session.info.state)) return;
    session.info = {
      ...session.info,
      state: to,
      endedAt: Date.now(),
      stoppedAt: null,
      terminationReason: reason,
      error: error ? { code: error.code, message: error.message } : session.info.error,
    };
    const connection = session.connection;
    session.connection = null;
    if (connection && !connection.isClosed) void connection.stop(reason);
    if (live === session) {
      forgetStop();
      state = { ...state, threads: [], selectedThreadId: null };
      options.breakpoints?.forgetVerification();
      say(to === "failed" ? "error" : "console", reason);
      publish();
    }
  };

  const fail = (session: Live, error: DebugError): never => {
    finish(session, "failed", error.message, error);
    throw error;
  };

  // --- Breakpoints -------------------------------------------------------------------------

  const sendBreakpoints = async (session: Live, resource: ResourceId) => {
    const connection = session.connection;
    const set = options.breakpoints;
    if (!connection || !set || !session.configured) return;
    const entries = set.forResource(resource).filter((entry) => entry.enabled);
    const uri = set.getSnapshot().find((entry) => entry.resource === resource)?.uri;
    // Every breakpoint of the file is gone: the adapter is told the file has none.
    const known = uri ?? lastUris.get(resource);
    if (!known) return;
    lastUris.set(resource, known);
    const sequence = (session.sent.get(resource) ?? 0) + 1;
    session.sent.set(resource, sequence);
    let answer: { breakpoints?: Breakpoint[] };
    try {
      answer = await connection.request("setBreakpoints", {
        source: { path: fsPath(known), name: basename(known) },
        breakpoints: entries.map((entry) => ({
          line: entry.line,
          ...(entry.column ? { column: entry.column } : {}),
        })),
        lines: entries.map((entry) => entry.line),
        sourceModified: false,
      });
    } catch (error) {
      if (!isCurrent(session) || session.sent.get(resource) !== sequence) return;
      for (const entry of entries)
        set.verify(entry.id, {
          verified: false,
          message: error instanceof Error ? error.message : String(error),
        });
      return;
    }
    // A newer request for this file was sent meanwhile, or the session is over.
    if (!isCurrent(session) || session.sent.get(resource) !== sequence) return;
    const results = answer?.breakpoints ?? [];
    entries.forEach((entry, index) => {
      const result = results[index];
      set.verify(entry.id, {
        verified: result?.verified ?? false,
        message: result?.message ?? (result ? null : "The debug adapter did not report it."),
        adapterId: result?.id ?? null,
      });
    });
  };
  /** The file of each resource ever sent, to clear its last breakpoint. */
  const lastUris = new Map<ResourceId, BreakpointEntry["uri"]>();

  const stopBreakpoints =
    options.breakpoints?.subscribe((change) => {
      if (change.verification) return;
      for (const entry of options.breakpoints!.getSnapshot())
        lastUris.set(entry.resource, entry.uri);
      const session = live;
      if (!session || isFinal(session.info.state) || !session.configured) return;
      for (const resource of change.resources) void sendBreakpoints(session, resource);
    }) ?? (() => {});

  // --- Stopped state -----------------------------------------------------------------------

  const frameView = (frame: StackFrame): FrameView => {
    let resource: ResourceId | null = null;
    const path = frame.source?.path ?? null;
    if (path)
      try {
        resource = resourceId(fileUri(path));
      } catch {
        resource = null;
      }
    return {
      id: frame.id,
      name: frame.name,
      line: frame.line,
      column: frame.column,
      path,
      resource,
      sourceName: frame.source?.name ?? null,
      module: frame.moduleId !== undefined ? String(frame.moduleId) : null,
      subtle:
        frame.presentationHint === "subtle" || frame.source?.presentationHint === "deemphasize",
    };
  };

  const loadScopes = async (session: Live, frameId: number, navigate: boolean) => {
    const connection = session.connection;
    if (!connection) return;
    const mine = ++frameEpoch;
    const atEpoch = epoch;
    const frame = state.frames.find((one) => one.id === frameId);
    state = { ...state, selectedFrameId: frameId, scopes: [] };
    if (navigate && frame?.path)
      state = {
        ...state,
        focus: { path: frame.path, line: frame.line, column: frame.column, nonce: ++focusNonce },
      };
    publish();
    let answer: { scopes?: Scope[] };
    try {
      answer = await connection.request("scopes", { frameId });
    } catch {
      return;
    }
    if (!isCurrent(session) || mine !== frameEpoch || atEpoch !== epoch) return;
    const scopes = (answer?.scopes ?? []).map((scope) => ({
      name: scope.name,
      variablesReference: scope.variablesReference,
      expensive: scope.expensive,
    }));
    state = { ...state, scopes };
    publish();
    // The first inexpensive scope (the locals) is opened: one level, nothing deeper.
    const first = scopes.find((scope) => !scope.expensive && scope.variablesReference > 0);
    if (first) void service.expand(first.variablesReference);
  };

  const loadStack = async (session: Live, threadId: number) => {
    const connection = session.connection;
    if (!connection) return;
    const atEpoch = epoch;
    let answer: { stackFrames?: StackFrame[] };
    try {
      answer = await connection.request("stackTrace", { threadId, startFrame: 0, levels: 50 });
    } catch (error) {
      if (isCurrent(session) && atEpoch === epoch) {
        say("error", `The call stack could not be read: ${(error as Error).message}`);
        publish();
      }
      return;
    }
    if (!isCurrent(session) || atEpoch !== epoch) return;
    const frames = (answer?.stackFrames ?? []).map(frameView);
    state = { ...state, selectedThreadId: threadId, frames, scopes: [] };
    publish();
    const top = frames.find((frame) => frame.path && !frame.subtle) ?? frames[0];
    if (top) await loadScopes(session, top.id, true);
  };

  const onStopped = async (session: Live, body: StoppedEventBody) => {
    epoch++;
    frameEpoch++;
    const atEpoch = epoch;
    move(session, "stopped");
    session.info = {
      ...session.info,
      stoppedAt: Date.now(),
      stoppedReason: body.description ?? body.reason,
    };
    state = { ...state, frames: [], scopes: [], variables: new Map(), selectedFrameId: null };
    publish();
    let threads: Thread[] = [];
    try {
      threads =
        ((await session.connection?.request("threads")) as { threads?: Thread[] })?.threads ?? [];
    } catch {
      threads = [];
    }
    if (!isCurrent(session) || atEpoch !== epoch) return;
    const stoppedIds = new Set(
      body.allThreadsStopped || body.threadId === undefined
        ? threads.map((thread) => thread.id)
        : [body.threadId],
    );
    const selected =
      body.threadId ??
      (state.selectedThreadId !== null && threads.some((t) => t.id === state.selectedThreadId)
        ? state.selectedThreadId
        : (threads[0]?.id ?? null));
    state = {
      ...state,
      threads: threads.map((thread) => ({
        id: thread.id,
        name: thread.name,
        state: stoppedIds.has(thread.id) ? "stopped" : "running",
      })),
      selectedThreadId: selected,
    };
    publish();
    if (selected !== null) await loadStack(session, selected);
  };

  const onEvent = (session: Live, event: Event) => {
    // An event of a session that is not the current one any more changes nothing.
    if (!isCurrent(session) || isFinal(session.info.state)) return;
    switch (event.event) {
      case "stopped":
        if (session.info.state === "terminating") return;
        void onStopped(session, event.body as StoppedEventBody);
        return;
      case "continued": {
        const body = event.body as ContinuedEventBody;
        if (session.info.state !== "stopped") return;
        if (body.allThreadsContinued === false && body.threadId !== state.selectedThreadId) {
          state = {
            ...state,
            threads: state.threads.map((t) =>
              t.id === body.threadId ? { ...t, state: "running" } : t,
            ),
          };
          publish();
          return;
        }
        forgetStop();
        move(session, "running");
        publish();
        return;
      }
      case "thread": {
        const body = event.body as ThreadEventBody;
        if (body.reason === "exited")
          state = { ...state, threads: state.threads.filter((t) => t.id !== body.threadId) };
        else if (body.reason === "started" && !state.threads.some((t) => t.id === body.threadId))
          state = {
            ...state,
            threads: [
              ...state.threads,
              { id: body.threadId, name: `Thread ${body.threadId}`, state: "running" },
            ],
          };
        publish();
        return;
      }
      case "output": {
        const body = event.body as OutputEventBody;
        if (!body?.output || body.category === "telemetry") return;
        const kind =
          body.category === "stdout" ? "stdout" : body.category === "stderr" ? "stderr" : "console";
        write(kind, body.output);
        publish();
        return;
      }
      case "breakpoint": {
        const body = event.body as BreakpointEventBody;
        const id = body.breakpoint?.id;
        if (id === undefined) return;
        const entry = options.breakpoints?.byAdapterId(id);
        if (entry && body.reason !== "removed")
          options.breakpoints!.verify(entry.id, {
            verified: body.breakpoint.verified,
            message: body.breakpoint.message ?? null,
            adapterId: id,
          });
        return;
      }
      case "exited":
        session.info = { ...session.info, exitCode: (event.body as ExitedEventBody).exitCode };
        publish();
        return;
      case "terminated":
        if (session.stopping) return;
        void endSession(
          session,
          session.info.exitCode === null
            ? "The program ended."
            : `The program exited with code ${session.info.exitCode}.`,
          false,
        );
        return;
      default:
        return;
    }
  };

  /** Asks the adapter to let go (and end what it launched), then ends its process. */
  const endSession = async (session: Live, reason: string, terminate = true) => {
    if (isFinal(session.info.state) || session.info.state === "terminating") return;
    session.stopping = true;
    // Kept now: the adapter's own exit, which follows `disconnect`, is not the reason.
    session.info = { ...session.info, terminationReason: session.info.terminationReason ?? reason };
    const connection = session.connection;
    if (!connection || session.info.state === "created" || session.info.state === "starting") {
      finish(session, "terminated", reason);
      return;
    }
    move(session, "terminating");
    publish();
    const launched = session.info.configuration.request === "launch";
    if (launched && terminate && session.info.capabilities.supportsTerminateRequest)
      await connection.request("terminate", {}, { timeoutMs: stopTimeout }).catch(() => {});
    await connection
      .request(
        "disconnect",
        { restart: false, terminateDebuggee: launched },
        { timeoutMs: stopTimeout },
      )
      .catch(() => {});
    finish(session, "terminated", reason);
  };

  const onClose = (session: Live, end: ConnectionEnd) => {
    if (isFinal(session.info.state)) return;
    if (session.stopping || session.info.state === "terminating" || !end.error) {
      finish(
        session,
        "terminated",
        session.stopping ? (session.info.terminationReason ?? end.reason) : end.reason,
      );
      return;
    }
    finish(
      session,
      "failed",
      end.reason,
      new DebugError(end.malformed ? "MalformedMessage" : "SessionTerminated", end.reason),
    );
  };

  // --- Commands -----------------------------------------------------------------------------

  const active = (): Live => {
    if (!live || isFinal(live.info.state))
      throw new DebugError("SessionTerminated", "No debug session is running.");
    return live;
  };
  const stoppedThread = (command: string): { session: Live; threadId: number } => {
    const session = active();
    if (session.info.state !== "stopped" || state.selectedThreadId === null)
      throw new DebugError("NotStopped", `${command} needs the program to be paused.`);
    return { session, threadId: state.selectedThreadId };
  };
  /** Continue or a step: the program runs again once the adapter agrees. */
  const resume = async (command: string, label: string) => {
    const { session, threadId } = stoppedThread(label);
    const atEpoch = epoch;
    await session.connection!.request(command, { threadId }).catch((error: unknown) => {
      throw new DebugError(
        "RequestFailed",
        `${label} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    // Unless it stopped again already (a fast step), it is running.
    if (isCurrent(session) && atEpoch === epoch && session.info.state === "stopped") {
      forgetStop();
      move(session, "running");
      publish();
    }
  };

  const resolvedPaths = (config: ResolvedDebugConfiguration) => {
    const root = options.folders[0];
    if (!root) throw new DebugError("NoWorkspace", "Open a folder to debug its programs.");
    const inside = (path: string, what: string) => {
      try {
        return fsPath(resolveWithin(fileUri(root), path));
      } catch {
        throw new DebugError(
          "InvalidConfiguration",
          `"${config.name}": its ${what} "${path}" is not inside this workspace.`,
        );
      }
    };
    return {
      root,
      cwd: inside(config.cwd ?? ".", "cwd"),
      program: config.program === null ? null : inside(config.program, "program"),
    };
  };

  const service: DebugService = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    controls() {
      const session = live && !isFinal(live.info.state) ? live : null;
      const stopped = session?.info.state === "stopped" && state.selectedThreadId !== null;
      return {
        start: !session && options.workspace !== null && !disposed,
        continue: stopped,
        // DAP's continue, next, stepIn, stepOut and pause are base requests: every adapter has
        // them. Restart and terminate are capabilities.
        pause: session?.info.state === "running",
        stepOver: stopped,
        stepInto: stopped,
        stepOut: stopped,
        restart:
          !!session &&
          (session.info.state === "running" || session.info.state === "stopped") &&
          !!session.info.capabilities.supportsRestartRequest,
        stop: !!session && session.info.state !== "terminating",
        // Evaluated in the selected frame: only while paused.
        evaluate: stopped && state.selectedFrameId !== null,
      };
    },

    async start(configId) {
      if (disposed || options.workspace === null || !options.folders.length)
        throw new DebugError("NoWorkspace", "Open a folder to debug its programs.");
      if (live && !isFinal(live.info.state))
        throw new DebugError(
          "AlreadyRunning",
          "A debug session is already running. Stop it first.",
        );
      const all = configurations();
      const config =
        configId === undefined
          ? all.length === 1
            ? all[0]
            : undefined
          : all.find((one) => one.id === configId);
      if (!config)
        throw new DebugError(
          "InvalidConfiguration",
          configId === undefined
            ? all.length
              ? "Choose which debug configuration to start."
              : "There is no debug configuration. Run › Configure Debugging adds one."
            : `There is no debug configuration "${configId}".`,
        );
      const adapter = adapterById(config.adapter);
      if (!adapter)
        throw new DebugError("InvalidConfiguration", `Unknown debug adapter "${config.adapter}".`);
      const paths = resolvedPaths(config);
      // Trust first: nothing -- no task, no adapter, no program -- runs in an untrusted folder.
      if (!(await options.trusted().catch(() => false)))
        throw new DebugError(
          "TrustDenied",
          "This folder is not trusted, so Yavin does not debug its programs. Trust it from File › Manage Workspace Trust to debug them.",
        );
      if (disposed) throw new DebugError("NoWorkspace", "The workspace was closed.");
      if (live && !isFinal(live.info.state))
        throw new DebugError(
          "AlreadyRunning",
          "A debug session is already running. Stop it first.",
        );

      const id = ++generation;
      const session: Live = {
        info: {
          sessionId: `debug-${id}`,
          workspace: options.workspace,
          state: "created",
          adapter: adapter.id,
          configuration: config,
          capabilities: {},
          startedAt: Date.now(),
          stoppedAt: null,
          endedAt: null,
          stoppedReason: null,
          terminationReason: null,
          exitCode: null,
          error: null,
        },
        connection: null,
        launchArgs: null,
        configured: false,
        sent: new Map(),
        stopping: false,
      };
      live = session;
      forgetStop();
      state = { ...state, threads: [], selectedThreadId: null, console: [] };
      say("console", `Starting "${config.name}"…`);
      publish();

      if (config.preLaunchTask) {
        if (!options.runTask)
          fail(session, new DebugError("InvalidConfiguration", "Tasks cannot be run here."));
        let run: { state: string; error: string | null };
        try {
          run = await options.runTask!(config.preLaunchTask);
        } catch (error) {
          return fail(
            session,
            new DebugError(
              "PreLaunchTaskFailed",
              `The task "${config.preLaunchTask}" did not run: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
        }
        if (!isCurrent(session) || isFinal(session.info.state)) return;
        if (run.state !== "succeeded")
          fail(
            session,
            new DebugError(
              "PreLaunchTaskFailed",
              `The task "${config.preLaunchTask}" did not succeed (${run.state}), so "${config.name}" was not started.`,
            ),
          );
      }

      move(session, "starting");
      publish();
      const python = options.settings.inspect(DEBUG_PYTHON, options.workspace).value || null;
      let channel;
      try {
        channel = await options.transport.start(adapter.id, paths.root, python);
      } catch (error) {
        if (!isCurrent(session) || isFinal(session.info.state)) return;
        return fail(session, nativeDebugError(error, "AdapterFailedToStart"));
      }
      if (!isCurrent(session) || isFinal(session.info.state)) {
        // Stopped (or the workspace closed) while the adapter was starting.
        void channel.stop();
        return;
      }
      const connection = new DapConnection(channel);
      session.connection = connection;
      let initialized!: () => void;
      const initializedEvent = new Promise<void>((resolve) => (initialized = resolve));
      connection.onEvent((event) => {
        if (event.event === "initialized") initialized();
        else onEvent(session, event);
      });
      connection.onClose((end) => onClose(session, end));
      move(session, "initializing");
      publish();

      let capabilities: Capabilities;
      try {
        capabilities =
          (await connection.request<Capabilities>(
            "initialize",
            {
              clientID: "yavin",
              clientName: "Yavin",
              adapterID: adapter.adapterID,
              locale: "en",
              linesStartAt1: true,
              columnsStartAt1: true,
              pathFormat: "path",
              supportsVariableType: true,
              supportsVariablePaging: false,
              supportsRunInTerminalRequest: false,
              supportsProgressReporting: false,
              supportsStartDebuggingRequest: false,
            },
            { timeoutMs: startTimeout },
          )) ?? {};
      } catch (error) {
        if (!isCurrent(session) || isFinal(session.info.state)) return;
        return fail(
          session,
          new DebugError(
            "InitializeFailed",
            `The ${adapter.label} debug adapter did not initialize: ${(error as Error).message}`,
          ),
        );
      }
      if (!isCurrent(session) || isFinal(session.info.state)) return;
      connection.supportsCancel = !!capabilities.supportsCancelRequest;
      session.info = { ...session.info, capabilities };
      publish();

      const launching = config.request === "launch";
      session.launchArgs = launching
        ? adapter.launchArguments(config, { program: paths.program!, cwd: paths.cwd })
        : adapter.attachArguments(config, { cwd: paths.cwd });
      // The launch (or attach) is answered when the adapter is ready -- for many adapters only
      // after configurationDone -- so it is sent now and awaited last.
      const started = connection.request(config.request, session.launchArgs, {
        timeoutMs: startTimeout,
      });
      const startFailure = (error: unknown) =>
        new DebugError(
          launching ? "LaunchFailed" : "AttachFailed",
          `"${config.name}" could not be ${launching ? "launched" : "attached to"}: ${error instanceof Error ? error.message : String(error)}`,
        );
      try {
        await Promise.race([
          initializedEvent,
          started.then(() => initializedEvent),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error(`no "initialized" event within ${startTimeout / 1000} s`)),
              startTimeout,
            ),
          ),
        ]);
      } catch (error) {
        if (!isCurrent(session) || isFinal(session.info.state)) return;
        return fail(session, startFailure(error));
      }
      if (!isCurrent(session) || isFinal(session.info.state)) return;

      // Configuration: every breakpoint, the exception filters (none chosen), then done.
      session.configured = true;
      const resources = [
        ...new Set(
          (options.breakpoints?.getSnapshot() ?? [])
            .filter((entry) => entry.enabled)
            .map((entry) => entry.resource),
        ),
      ];
      await Promise.all(resources.map((resource) => sendBreakpoints(session, resource)));
      if (capabilities.exceptionBreakpointFilters?.length)
        await connection.request("setExceptionBreakpoints", { filters: [] }).catch(() => {});
      if (capabilities.supportsConfigurationDoneRequest)
        await connection.request("configurationDone").catch(() => {});
      try {
        await started;
      } catch (error) {
        if (!isCurrent(session) || isFinal(session.info.state)) return;
        return fail(session, startFailure(error));
      }
      if (!isCurrent(session) || isFinal(session.info.state)) return;
      if (session.info.state === "initializing") move(session, "running");
      publish();
    },

    async stop() {
      const session = live;
      if (!session || isFinal(session.info.state)) return;
      session.info = { ...session.info, terminationReason: "Stopped." };
      await endSession(session, "Stopped.");
    },

    continue: () => resume("continue", "Continue"),
    stepOver: () => resume("next", "Step Over"),
    stepInto: () => resume("stepIn", "Step Into"),
    stepOut: () => resume("stepOut", "Step Out"),

    async pause() {
      const session = active();
      if (session.info.state !== "running")
        throw new DebugError("NotStopped", "Pause needs a running program.");
      const threadId = state.selectedThreadId ?? state.threads[0]?.id ?? 0;
      await session.connection!.request("pause", { threadId });
      // The adapter answers with a `stopped` event; that is what changes the state.
    },

    async restart() {
      const session = active();
      if (!session.info.capabilities.supportsRestartRequest)
        throw new DebugError(
          "UnsupportedCapability",
          `The ${session.info.adapter} debug adapter cannot restart a session.`,
        );
      forgetStop();
      if (session.info.state === "stopped") move(session, "running");
      publish();
      await session.connection!.request("restart", { arguments: session.launchArgs ?? {} });
    },

    async selectThread(threadId) {
      const { session } = stoppedThread("Choosing a thread");
      if (!state.threads.some((thread) => thread.id === threadId)) return;
      frameEpoch++;
      state = {
        ...state,
        selectedThreadId: threadId,
        frames: [],
        scopes: [],
        selectedFrameId: null,
      };
      publish();
      await loadStack(session, threadId);
    },

    async selectFrame(frameId) {
      const session = active();
      if (session.info.state !== "stopped") return;
      if (!state.frames.some((frame) => frame.id === frameId)) return;
      await loadScopes(session, frameId, true);
    },

    async expand(variablesReference) {
      const session = live;
      if (!session || session.info.state !== "stopped" || !session.connection) return null;
      if (variablesReference <= 0) return [];
      const cached = state.variables.get(variablesReference);
      if (cached) return cached;
      const atEpoch = epoch;
      // Asked again before the first answer (the view and the service, say): one request.
      const key = `${atEpoch}:${variablesReference}`;
      let asked = fetching.get(key);
      if (!asked) {
        asked = session.connection.request<{ variables?: Variable[] }>("variables", {
          variablesReference,
        });
        fetching.set(key, asked);
        void asked.catch(() => {}).finally(() => fetching.delete(key));
      }
      let answer: { variables?: Variable[] };
      try {
        answer = await asked;
      } catch {
        return null;
      }
      const already = state.variables.get(variablesReference);
      if (already && atEpoch === epoch) return already;
      // The program moved on (or another session started): these belong to no current frame.
      if (!isCurrent(session) || atEpoch !== epoch || session.info.state !== "stopped") return null;
      const variables = (answer?.variables ?? []).map((variable) => ({
        name: variable.name,
        value: variable.value,
        type: variable.type ?? null,
        variablesReference: variable.variablesReference,
      }));
      const next = new Map(state.variables);
      next.set(variablesReference, variables);
      state = { ...state, variables: next };
      publish();
      return variables;
    },

    async evaluate(expression) {
      const text = expression.trim();
      if (!text) return;
      const session = active();
      if (session.info.state !== "stopped" || state.selectedFrameId === null) {
        say("error", "Expressions are evaluated in a paused program's selected frame.");
        publish();
        throw new DebugError(
          "NotStopped",
          "Expressions are evaluated while the program is paused.",
        );
      }
      const atEpoch = epoch;
      say("input", text);
      publish();
      try {
        const answer = await session.connection!.request<EvaluateResponseBody>("evaluate", {
          expression: text,
          frameId: state.selectedFrameId,
          context: "repl",
        });
        if (!isCurrent(session)) return;
        say("result", answer?.result ?? "");
        // A result that changed program state (an assignment) makes fetched variables stale.
        if (atEpoch === epoch) state = { ...state, variables: new Map() };
        publish();
        if (atEpoch === epoch) {
          const first = state.scopes.find(
            (scope) => !scope.expensive && scope.variablesReference > 0,
          );
          if (first) void service.expand(first.variablesReference);
        }
      } catch (error) {
        if (!isCurrent(session)) return;
        const message = error instanceof Error ? error.message : String(error);
        say("error", message);
        publish();
        throw new DebugError("EvaluateFailed", message);
      }
    },

    clearConsole() {
      state = { ...state, console: [] };
      publish();
    },

    dispose() {
      if (disposed) return;
      const session = live;
      disposed = true;
      stopBreakpoints();
      stopSettings();
      if (session && !isFinal(session.info.state)) {
        session.stopping = true;
        const connection = session.connection;
        // Asked to let go, briefly; its process (and the debuggee) is ended regardless.
        if (connection && !connection.isClosed)
          void connection
            .request("disconnect", { restart: false, terminateDebuggee: true }, { timeoutMs: 500 })
            .catch(() => {})
            .finally(() => void connection.stop("The workspace was closed."));
        session.connection = null;
        finishDisposed(session);
      }
      publish();
      listeners.clear();
    },
  };

  /** The session of a workspace being closed: ended, without waiting for its adapter. */
  const finishDisposed = (session: Live) => {
    session.info = {
      ...session.info,
      state: "terminated",
      endedAt: Date.now(),
      stoppedAt: null,
      terminationReason: "The workspace was closed.",
    };
    forgetStop();
    state = { ...state, threads: [], selectedThreadId: null };
    options.breakpoints?.forgetVerification();
  };

  // Configurations are settings: when they change for this workspace, the list does.
  const stopSettings =
    options.workspace === null
      ? () => {}
      : options.settings.subscribe(options.workspace, (change) => {
          if (change.id === DEBUG_CONFIGURATIONS.id && !disposed) publish();
        });

  return service;
}
