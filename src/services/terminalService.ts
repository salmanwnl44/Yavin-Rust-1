/**
 * The workspace's terminals (TERMINAL-03): the one owner of a workspace's terminal sessions.
 *
 * ```text
 * WorkspaceManager ── WorkspaceId ──> TerminalService (one per WorkspaceId, per window)
 *                                       ├─ Map<TerminalId, session record>   (state, metadata)
 *                                       │    └─ its lifecycle subscription   (state only)
 *                                       └─ attachments (views)             (output, replay, ACKs)
 *                                            └─ native session (T01) + output stream (T02)
 * ```
 *
 * - **Sessions belong to exactly one workspace.** A service holds only its own; an id from
 *   another workspace is refused (`InvalidWorkspace`), never looked up by id alone.
 * - **State and output are separate.** The service keeps each session's state through its own
 *   lifecycle subscription -- `Running`, `Exiting`, the end -- whether or not any view is
 *   attached, and tells listeners when state changes, never per byte. Output goes to each
 *   attached view on that view's own channel (T02), replayed first when it attaches, and is
 *   acknowledged by the view once its terminal has parsed it.
 * - **A view is not the session.** Detaching a view (unmounting it, switching workspace)
 *   leaves the shell running; attaching again replays its recent output, then continues live.
 *   A session ends only when it is closed or killed, or when its workspace's terminals are
 *   disposed (the window's lifetime, see `TerminalServices`).
 * - **Every message is validated** before it changes anything: the session must be this
 *   service's, the generation current, the sequence in order, the step one the state machine
 *   allows (`applyEvent` of the contract). Anything else is dropped.
 *
 * - **Shell integration is read here, once** (TERMINAL-05A). The `shell` messages of the
 *   lifecycle subscription -- the native side found them in the output -- become each session's
 *   `shell` state (`terminalShell.ts`): its folder, its command boundaries. Views never parse
 *   them; a view that attaches later reads the state, and old signals are never replayed. A
 *   restart starts the state again.
 *
 * This module knows nothing of React or Tauri: the native side is passed in (`TerminalNative`),
 * and React reads the service through `useSyncExternalStore`.
 */
import {
  closeLeftoverShells,
  createSubscriptionId,
  createTerminalId,
  describeExit,
  nextGeneration,
  openRequestFor,
  usableSize,
} from "./terminal.ts";
import {
  TerminalError,
  applyEvent as applyProtocol,
  asTerminalError,
  chunkInput,
  openStream,
  parseTerminalMessage,
  type Generation,
  type SubscriptionId,
  type TerminalAckRequest,
  type TerminalCloseRequest,
  type TerminalDimensions,
  type TerminalId,
  type TerminalKillRequest,
  type TerminalOpenRequest,
  type TerminalOutputChunk,
  type TerminalProfile,
  type TerminalResizeRequest,
  type TerminalState,
  type TerminalStream,
  type TerminalSubscribeRequest,
  type TerminalUnsubscribeRequest,
  type TerminalWriteRequest,
  type WorkspaceId,
} from "./terminalProtocol.ts";
import {
  initialShellState,
  reduceShell,
  type ShellIntegrationHint,
  type TerminalShellState,
} from "./terminalShell.ts";

/** The native side, as the service needs it. The application passes its `native` calls. */
export interface TerminalNative {
  open(args: {
    request: TerminalOpenRequest;
    subscriptionId: SubscriptionId;
    events: unknown;
  }): Promise<unknown>;
  subscribe(args: { request: TerminalSubscribeRequest; events: unknown }): Promise<unknown>;
  unsubscribe(request: TerminalUnsubscribeRequest): Promise<unknown>;
  ack(request: TerminalAckRequest): Promise<unknown>;
  write(request: TerminalWriteRequest): Promise<unknown>;
  resize(request: TerminalResizeRequest): Promise<unknown>;
  close(request: TerminalCloseRequest): Promise<unknown>;
  kill(request: TerminalKillRequest): Promise<unknown>;
  closeAll(): Promise<unknown>;
  /** A channel delivering one subscription's messages to `receive` (a Tauri `Channel`). */
  channel(receive: (message: unknown) => void): unknown;
}

/** What a terminal is started as. */
export interface TerminalSpec {
  /** Shown on its tab. */
  title: string;
  /**
   * How it starts: a profile already resolved and validated by the workspace's profiles
   * (`terminalProfiles.ts`); `null` for the native default shell. The service keeps an
   * immutable copy, which a restart launches again.
   */
  profile: TerminalProfile | null;
  /** Where it starts, overriding the profile's folder ("Open in Integrated Terminal"). */
  cwd?: string;
  dimensions?: TerminalDimensions;
  /** What its shell is expected to report (TERMINAL-05A); unsupported when not said. */
  integration?: ShellIntegrationHint;
}

/** One session as the service shows it: immutable, replaced whenever its state changes. */
export interface TerminalSessionView {
  readonly sessionId: TerminalId;
  readonly workspaceId: WorkspaceId;
  readonly generation: Generation;
  readonly state: TerminalState;
  readonly title: string;
  /** The profile it was started with (immutable); `null` for the native default shell. */
  readonly profile: Readonly<TerminalProfile> | null;
  readonly profileId: string | null;
  readonly profileName: string | null;
  /** Where it was started (a restart starts there again); see `shell` for where it is now. */
  readonly cwd: string | null;
  /** What the shell reported about itself this generation (TERMINAL-05A). */
  readonly shell: TerminalShellState;
  readonly pid: number | null;
  readonly dimensions: TerminalDimensions;
  /** Set when it exited. */
  readonly exitCode: number | null;
  /** Set when it failed: why, fit to show. */
  readonly error: string | null;
  readonly createdAt: number;
  /** How many views are attached. */
  readonly attached: number;
}

export interface TerminalServiceSnapshot {
  readonly workspaceId: WorkspaceId;
  readonly disposed: boolean;
  /** In the order they were opened. */
  readonly sessions: readonly TerminalSessionView[];
}

/** What a view does with the output of the session it attached to. */
export interface TerminalViewHandlers {
  /**
   * The next output -- replayed first, then live -- in order. Call `accepted` once the
   * terminal has parsed the bytes: that is the acknowledgement that lets more be sent.
   */
  output(chunk: TerminalOutputChunk, accepted: () => void): void;
  /**
   * The generation's end, after all of its output: a sentence to show. `failed` for an error
   * (or for this view being detached), not for an exit.
   */
  ended(message: string, failed: boolean): void;
}

export interface TerminalAttachment {
  readonly subscriptionId: SubscriptionId;
  /** Stops this view's delivery; the session goes on. Idempotent. */
  detach(): void;
}

export interface TerminalService {
  readonly workspaceId: WorkspaceId;
  getSnapshot(): TerminalServiceSnapshot;
  /** State changes only -- never output. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  get(id: TerminalId): TerminalSessionView | undefined;
  list(): readonly TerminalSessionView[];
  /** Creates a session and starts it; answers its id at once (it is `Spawning`). */
  open(spec: TerminalSpec): TerminalId;
  /** Attaches a view: replay, then live output, on its own channel. */
  attach(id: TerminalId, handlers: TerminalViewHandlers): TerminalAttachment;
  write(id: TerminalId, data: string): Promise<void>;
  resize(id: TerminalId, dimensions: TerminalDimensions): Promise<void>;
  rename(id: TerminalId, title: string): void;
  /** Starts the session again as a new generation; its views attach to that one. */
  restart(id: TerminalId, dimensions?: TerminalDimensions): void;
  /** Ends a session gently and forgets it. */
  close(id: TerminalId): Promise<void>;
  /** Ends a session and everything it started, now, and forgets it. */
  kill(id: TerminalId): Promise<void>;
  /**
   * Applies one message from a session's lifecycle subscription. `false` when it was dropped:
   * not this workspace's, a stale generation, out of order, or not a step the state machine
   * allows. Exposed so the validation can be tested directly.
   */
  applyEvent(message: unknown): boolean;
  /** Ends every session and refuses everything from now on. */
  dispose(): Promise<void>;
}

const DEFAULT_DIMENSIONS: TerminalDimensions = { cols: 80, rows: 24 };

interface Attachment {
  readonly subscriptionId: SubscriptionId;
  readonly generation: Generation;
  readonly handlers: TerminalViewHandlers;
  stream: TerminalStream;
  subscribed: boolean;
  detached: boolean;
  ended: boolean;
}

interface SessionRecord {
  view: TerminalSessionView;
  /** The lifecycle subscription's view of the current generation. */
  lifecycle: TerminalStream;
  /** The current generation has a native session (its open succeeded). */
  spawned: boolean;
  /** The current generation's open, while it is in flight. */
  opening: Promise<void> | null;
  closed: boolean;
  attachments: Set<Attachment>;
  /** What its shell is expected to report: each generation's shell state starts from it. */
  integration: ShellIntegrationHint | undefined;
}

export function createTerminalService(
  workspaceId: WorkspaceId,
  native: TerminalNative,
  options: {
    /** Whether `id` is a session of another workspace (for an exact error). */
    isForeign?: (id: TerminalId) => boolean;
  } = {},
): TerminalService {
  const sessions = new Map<TerminalId, SessionRecord>();
  const listeners = new Set<() => void>();
  let disposed = false;
  let snapshot: TerminalServiceSnapshot = Object.freeze({
    workspaceId,
    disposed,
    sessions: Object.freeze([]),
  });

  const changed = () => {
    snapshot = Object.freeze({
      workspaceId,
      disposed,
      sessions: Object.freeze([...sessions.values()].map((record) => record.view)),
    });
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        /* One listener's failure is not the service's. */
      }
    }
  };

  const update = (record: SessionRecord, patch: Partial<TerminalSessionView>) => {
    record.view = Object.freeze({ ...record.view, ...patch });
    if (sessions.get(record.view.sessionId) === record) changed();
  };

  const recordOf = (id: TerminalId): SessionRecord => {
    if (disposed)
      throw new TerminalError("InvalidWorkspace", "This workspace's terminals have been closed.");
    const record = sessions.get(id);
    if (record) return record;
    if (options.isForeign?.(id))
      throw new TerminalError("InvalidWorkspace", "That terminal belongs to another workspace.");
    throw new TerminalError("InvalidSession", "There is no such terminal.");
  };

  /** The sentence for how a session's current generation ended, from its record. */
  const endOf = (view: TerminalSessionView): [string, boolean] =>
    view.state === "Failed"
      ? [view.error ?? "The terminal failed.", true]
      : [describeExit(view.exitCode), false];

  const report = (attachment: Attachment, message: string, failed: boolean) => {
    if (attachment.ended || attachment.detached) return;
    attachment.ended = true;
    try {
      attachment.handlers.ended(message, failed);
    } catch {
      /* A view's failure is not the stream's. */
    }
  };

  const unsubscribe = (attachment: Attachment) => {
    attachment.detached = true;
    if (attachment.subscribed)
      void native.unsubscribe({ subscriptionId: attachment.subscriptionId }).catch(() => undefined);
  };

  /** One view's channel: validated against its own stream, then handed to the view. */
  const receive = (record: SessionRecord, attachment: Attachment, message: unknown) => {
    if (attachment.detached || disposed) return;
    const event = parseTerminalMessage(message);
    if (
      !event ||
      event.sessionId !== record.view.sessionId ||
      event.generation !== attachment.generation
    )
      return;
    const verdict = applyProtocol(attachment.stream, event);
    if (!verdict.accepted) return;
    attachment.stream = verdict.stream;
    try {
      if (event.kind === "output") {
        let acknowledged = false;
        attachment.handlers.output(event, () => {
          // An acknowledgement after detaching is stale: the subscription is gone.
          if (acknowledged || attachment.detached) return;
          acknowledged = true;
          void native
            .ack({
              subscriptionId: attachment.subscriptionId,
              sessionId: event.sessionId,
              generation: event.generation,
              seq: event.seq,
            })
            .catch(() => undefined);
        });
      } else if (event.kind === "exit") report(attachment, describeExit(event.exitCode), false);
      else if (event.kind === "error" || event.kind === "detached")
        report(attachment, event.error.message, true);
    } catch {
      /* A view's failure is not the stream's. */
    }
  };

  /** Subscribes an attachment natively, once its generation has a native session. */
  const begin = (record: SessionRecord, attachment: Attachment) => {
    if (attachment.subscribed || attachment.detached || disposed || record.closed) return;
    if (record.view.generation !== attachment.generation) return;
    if (!record.spawned) {
      // It never started: nothing to replay, only why.
      if (record.view.state === "Failed") report(attachment, ...endOf(record.view));
      return;
    }
    attachment.subscribed = true;
    const events = native.channel((message) => receive(record, attachment, message));
    native
      .subscribe({
        request: {
          subscriptionId: attachment.subscriptionId,
          sessionId: record.view.sessionId,
          generation: attachment.generation,
        },
        events,
      })
      .catch(() => {
        // Gone natively (closed, or released): the record still says how it ended.
        if (record.view.state === "Exited" || record.view.state === "Failed")
          report(attachment, ...endOf(record.view));
      });
  };

  /** Starts generation after generation of one session. */
  const launch = (record: SessionRecord, dimensions: TerminalDimensions) => {
    const id = record.view.sessionId;
    const generation = nextGeneration();
    const subscriptionId = createSubscriptionId(`${id}-service`);
    record.lifecycle = openStream(id, generation, { joined: true });
    record.spawned = false;
    update(record, {
      generation,
      state: "Spawning",
      pid: null,
      exitCode: null,
      error: null,
      dimensions,
      // A new shell: nothing it reported before is true of this one. Command ids go on.
      shell: initialShellState(record.integration, record.view.shell.nextCommand),
    });
    const current = () => !disposed && !record.closed && record.view.generation === generation;
    const request = openRequestFor(
      id,
      record.view.profile,
      record.view.cwd,
      dimensions,
      generation,
      workspaceId,
    );
    const opening = closeLeftoverShells(() => native.closeAll())
      .then(() =>
        native.open({
          request,
          subscriptionId,
          events: native.channel((message) => applyEvent(message)),
        }),
      )
      .then(
        (answer) => {
          if (!current()) {
            // Started after it was closed, restarted or its workspace disposed: nobody would
            // ever end it.
            void native.kill({ sessionId: id, generation }).catch(() => undefined);
            return;
          }
          record.spawned = true;
          // Resized while it was starting: it opened at the old size, so it is told the new one.
          const wanted = record.view.dimensions;
          if (wanted.cols !== dimensions.cols || wanted.rows !== dimensions.rows)
            void native
              .resize({ sessionId: id, generation, dimensions: wanted })
              .catch(() => undefined);
          // The answer says it runs; its `Running` message may already have said so.
          if (record.lifecycle.state === "Spawning") {
            record.lifecycle = { ...record.lifecycle, state: "Running" };
            const pid = (answer as { pid?: unknown } | null)?.pid;
            update(record, {
              state: "Running",
              pid: typeof pid === "number" ? pid : null,
            });
          }
        },
        (error) => {
          if (!current()) return;
          record.lifecycle = { ...record.lifecycle, state: "Failed" };
          update(record, { state: "Failed", error: asTerminalError(error).message });
        },
      )
      .then(() => {
        if (record.opening === opening) record.opening = null;
        for (const attachment of record.attachments) begin(record, attachment);
      });
    record.opening = opening;
  };

  function applyEvent(message: unknown): boolean {
    if (disposed) return false;
    const event = parseTerminalMessage(message);
    if (!event) return false;
    const record = sessions.get(event.sessionId as TerminalId);
    // Not this workspace's (or closed): the id alone never makes a session ours.
    if (!record || record.view.workspaceId !== workspaceId) return false;
    if (event.generation !== record.view.generation) return false;
    // The service's subscription is a lifecycle one: output never belongs here.
    if (event.kind === "output" || event.kind === "detached") return false;
    const verdict = applyProtocol(record.lifecycle, event);
    if (!verdict.accepted) return false;
    record.lifecycle = verdict.stream;
    if (event.kind === "shell") {
      const shell = reduceShell(record.view.shell, event);
      if (shell !== record.view.shell) update(record, { shell });
    } else if (event.kind === "state") {
      update(
        record,
        event.state === "Running"
          ? { state: "Running", pid: event.pid ?? null }
          : { state: "Exiting" },
      );
    } else if (event.kind === "exit") {
      update(record, { state: "Exited", exitCode: event.exitCode });
    } else {
      update(record, { state: "Failed", error: event.error.message });
    }
    return true;
  }

  /** Ends a session natively and forgets it; its views are detached. */
  const end = async (id: TerminalId, how: "close" | "kill") => {
    const record = recordOf(id);
    record.closed = true;
    sessions.delete(id);
    for (const attachment of record.attachments) unsubscribe(attachment);
    record.attachments.clear();
    changed();
    const request = { sessionId: id, generation: record.view.generation };
    // Still starting: the open's own answer ends it (see `launch`).
    if (!record.spawned) return;
    await (how === "close" ? native.close(request) : native.kill(request)).catch(() => undefined);
  };

  return {
    workspaceId,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get: (id) => sessions.get(id)?.view,
    list: () => snapshot.sessions,

    open(spec) {
      if (disposed)
        throw new TerminalError("InvalidWorkspace", "This workspace's terminals have been closed.");
      const id = createTerminalId() as TerminalId;
      const record: SessionRecord = {
        view: Object.freeze({
          sessionId: id,
          workspaceId,
          generation: 0 as Generation,
          state: "Spawning" as TerminalState,
          title: spec.title,
          profile: spec.profile
            ? Object.freeze({
                ...spec.profile,
                args: [...spec.profile.args],
                env: spec.profile.env.map(([k, v]) => [k, v] as [string, string]),
              })
            : null,
          profileId: spec.profile?.id ?? null,
          profileName: spec.profile?.name ?? null,
          cwd: spec.cwd || null,
          shell: initialShellState(spec.integration),
          pid: null,
          dimensions: DEFAULT_DIMENSIONS,
          exitCode: null,
          error: null,
          createdAt: Date.now(),
          attached: 0,
        }),
        lifecycle: openStream(id, 0 as Generation, { joined: true }),
        spawned: false,
        opening: null,
        closed: false,
        attachments: new Set(),
        integration: spec.integration,
      };
      sessions.set(id, record);
      const dimensions = spec.dimensions ?? DEFAULT_DIMENSIONS;
      launch(record, usableSize(dimensions.cols, dimensions.rows));
      return id;
    },

    attach(id, handlers) {
      const record = recordOf(id);
      const attachment: Attachment = {
        subscriptionId: createSubscriptionId(id),
        generation: record.view.generation,
        handlers,
        stream: openStream(id, record.view.generation, { joined: true }),
        subscribed: false,
        detached: false,
        ended: false,
      };
      record.attachments.add(attachment);
      update(record, { attached: record.attachments.size });
      // While its generation is starting, the open's own completion begins it (see `launch`).
      if (!record.opening) begin(record, attachment);
      return {
        subscriptionId: attachment.subscriptionId,
        detach() {
          if (attachment.detached) return;
          unsubscribe(attachment);
          record.attachments.delete(attachment);
          if (!record.closed) update(record, { attached: record.attachments.size });
        },
      };
    },

    async write(id, data) {
      const record = recordOf(id);
      if (record.view.state === "Spawning")
        throw new TerminalError("ProtocolError", "That terminal is still starting.");
      if (record.view.state !== "Running")
        throw new TerminalError("SessionEnded", "That terminal has ended.");
      const generation = record.view.generation;
      // In order: the native side runs writes in the order they arrive.
      await Promise.all(
        chunkInput(data).map((piece) => native.write({ sessionId: id, generation, data: piece })),
      ).catch((error) => {
        throw asTerminalError(error);
      });
    },

    async resize(id, dimensions) {
      const record = recordOf(id);
      const size = usableSize(dimensions.cols, dimensions.rows);
      if (size.cols === record.view.dimensions.cols && size.rows === record.view.dimensions.rows)
        return;
      update(record, { dimensions: size });
      if (record.view.state !== "Running") return;
      await native
        .resize({ sessionId: id, generation: record.view.generation, dimensions: size })
        .catch((error) => {
          throw asTerminalError(error);
        });
    },

    rename(id, title) {
      const record = recordOf(id);
      if (title.trim()) update(record, { title: title.trim() });
    },

    restart(id, dimensions) {
      const record = recordOf(id);
      // The views of the generation being replaced are let go; they attach to the new one.
      for (const attachment of record.attachments) unsubscribe(attachment);
      record.attachments.clear();
      const size = dimensions ?? record.view.dimensions;
      launch(record, usableSize(size.cols, size.rows));
      update(record, { attached: 0 });
    },

    close: (id) => end(id, "close"),
    kill: (id) => end(id, "kill"),
    applyEvent,

    async dispose() {
      if (disposed) return;
      const all = [...sessions.values()];
      disposed = true;
      sessions.clear();
      for (const record of all) {
        record.closed = true;
        for (const attachment of record.attachments) unsubscribe(attachment);
        record.attachments.clear();
      }
      changed();
      listeners.clear();
      await Promise.allSettled(
        all
          .filter((record) => record.spawned)
          .map((record) =>
            native.kill({ sessionId: record.view.sessionId, generation: record.view.generation }),
          ),
      );
    },
  };
}

/**
 * The window's terminal services: one per WorkspaceId, kept across switches.
 *
 * Switching workspace disposes the workspace's *context* but not its terminals: its views
 * detach, its shells go on, and opening the workspace again finds them here. They end when the
 * window does (reload or exit, natively) or when `dispose` is called for the workspace.
 */
export interface TerminalServices {
  forWorkspace(id: WorkspaceId): TerminalService;
  dispose(id: WorkspaceId): Promise<void>;
  disposeAll(): Promise<void>;
  workspaces(): WorkspaceId[];
}

export function createTerminalServices(native: TerminalNative): TerminalServices {
  const services = new Map<WorkspaceId, TerminalService>();
  return {
    forWorkspace(id) {
      let service = services.get(id);
      if (!service) {
        const own = createTerminalService(id, native, {
          isForeign: (terminal) =>
            [...services.values()].some((other) => other !== own && !!other.get(terminal)),
        });
        service = own;
        services.set(id, own);
      }
      return service;
    },
    async dispose(id) {
      const service = services.get(id);
      if (!service) return;
      services.delete(id);
      await service.dispose();
    },
    async disposeAll() {
      const all = [...services.values()];
      services.clear();
      await Promise.allSettled(all.map((service) => service.dispose()));
    },
    workspaces: () => [...services.keys()],
  };
}
