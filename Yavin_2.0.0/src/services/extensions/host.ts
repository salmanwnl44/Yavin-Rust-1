/**
 * The extension host, Yavin's side (IDE-08): one host process generation for one workspace.
 *
 * ```text
 * ExtensionHostManager (workspace) ── creates, restarts, reloads, revokes on trust ──┐
 *                                                                                    ▼
 * ExtensionHost (this; one generation) ── protocol ──► yavin-extension-host process (QuickJS)
 *        │ capabilities: every request an extension makes is checked here (ownership,
 *        │ bounds, the workspace boundary) and turned into a call on a window contract
 *        ▼
 * CommandRegistry · views · ProviderRegistry · DecorationStore · storage · settings · ExtensionWindow
 * ```
 *
 * Per extension: registered → activating → active, or → failed; active → deactivating →
 * disposed. Activation is lazy and at most once, dependencies first, never in an untrusted
 * folder (unless the manifest declares it safe there). The host process starts on the first
 * activation. A message for another workspace or generation is rejected; a malformed one is
 * logged and dropped. When the process crashes, every running extension is marked failed,
 * every pending request rejected and everything they contributed -- command handlers, view
 * rows, language providers, decorations, event subscriptions -- removed; this host is then
 * finished and the manager makes the next one.
 *
 * Extensions never receive Yavin objects: no service, React, Monaco, IPC, process or path
 * outside the workspace crosses the protocol.
 *
 * Permissions (EXT-07, `permissions.ts`): the native side refuses a request whose capability
 * is not granted before it gets here (`ext-host-denied` says so). This host applies the same
 * rule to what reaches it -- the in-process host has no native side -- and to the events it
 * sends; a refusal of either kind is kept in `denied` (the extension's last one), for the
 * Extensions view, until what it needed is allowed.
 */
import { createOutputChannel, type OutputChannel } from "../panel/output.ts";
import {
  fileUri,
  fsPath,
  isEqualOrAncestor,
  parseUri,
  resolveWithin,
  resourceId,
  type ResourceUri,
} from "../resource.ts";
import type { SettingsRegistry } from "../settings/settings.ts";
import type { WorkspaceId } from "../terminalProtocol.ts";
import { ExtensionError } from "./errors.ts";
import { EXTENSION_API, type ActivationEvent } from "./manifest.ts";
import { needOfEvent, needOfRequest } from "./permissions.ts";
import { MAX_MESSAGE, readHostMessage, writeHostMessage, type HostMessage } from "./protocol.ts";
import type { ExtensionRegistry, RegisteredExtension } from "./registry.ts";
import type { ExtensionStorage } from "./storage.ts";
import type { HostChannel, HostDenial, HostTransport } from "./transport.ts";
import {
  DECORATION_STYLES,
  type DecorationStore,
  type DocumentInfo,
  type ExtensionDecoration,
  type ExtensionRange,
  type ExtensionWindow,
  type ProviderKind,
  type ProviderRegistry,
} from "./window.ts";

export type ExtensionState =
  "registered" | "activating" | "active" | "failed" | "deactivating" | "disposed";

const NEXT: Record<ExtensionState, readonly ExtensionState[]> = {
  registered: ["activating", "disposed"],
  activating: ["active", "failed", "deactivating"],
  active: ["deactivating", "failed"],
  failed: ["disposed"],
  deactivating: ["disposed"],
  disposed: [],
};
export const canMoveExtension = (from: ExtensionState, to: ExtensionState) =>
  NEXT[from].includes(to);

export type HostState = "idle" | "starting" | "running" | "crashed" | "stopped";

export interface ExtensionStatus {
  state: ExtensionState;
  reason: string | null;
  activationMs: number | null;
}

/** One row of a contributed view (a tree, at most three levels deep). */
export interface ViewRow {
  label: string;
  description?: string;
  tooltip?: string;
  command?: string;
  children?: ViewRow[];
}

export interface HostSnapshot {
  workspace: WorkspaceId | null;
  generation: number;
  host: HostState;
  hostReason: string | null;
  statuses: Readonly<Record<string, ExtensionStatus>>;
  views: Readonly<Record<string, readonly ViewRow[]>>;
  /** Each extension's last refused request (EXT-07), until what it needed is allowed. */
  denied: Readonly<Record<string, Omit<HostDenial, "extensionId">>>;
}

export interface HostTimeouts {
  start: number;
  load: number;
  activate: number;
  deactivate: number;
  command: number;
  view: number;
  provider: number;
}

export const DEFAULT_TIMEOUTS: HostTimeouts = {
  start: 10_000,
  load: 10_000,
  activate: 10_000,
  deactivate: 3_000,
  command: 30_000,
  view: 5_000,
  provider: 1_500,
};

export interface ExtensionHostOptions {
  /** Tells the native diagnostics what only the window saw (EXT-14); best effort. */
  report?: (code: string, extensionId: string) => void;
  /** The active extension profile's setting values (EXT-13), per extension. */
  profileSettings?: () => Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** Hears that the active profile's setting values changed (EXT-18); returns the unsubscribe. */
  onProfileSettings?: (listener: () => void) => () => void;
  registry: ExtensionRegistry;
  settings: SettingsRegistry;
  storage: ExtensionStorage;
  workspace: WorkspaceId | null;
  folder: string | null;
  generation: number;
  transport: HostTransport;
  trusted(): Promise<boolean>;
  window: ExtensionWindow | null;
  decorations: DecorationStore;
  providers: ProviderRegistry;
  notify(level: "info" | "warning" | "error", extensionId: string, message: string): void;
  channel?(extensionId: string, name: string): Pick<OutputChannel, "appendLine">;
  timeouts?: Partial<HostTimeouts>;
  /** The process crashed (not stopped by Yavin). */
  onCrash?(reason: string): void;
}

const MESSAGE_LIMIT = 20;
const LOG_LIMIT = 500;
const MAX_PENDING = 256;
const MALFORMED_LIMIT = 100;
const EVENTS = new Set([
  "configuration.changed",
  "documents.open",
  "documents.change",
  "documents.close",
  "editor.active",
]);
const KEY = /^[A-Za-z0-9._-]{1,40}$/;
const LANGUAGE = /^[a-z0-9][a-z0-9+#._-]{0,49}$/i;

interface Running {
  entry: RegisteredExtension;
  status: ExtensionStatus;
  activation: Promise<void> | null;
  loaded: boolean;
  messages: number;
  logged: number;
  log: Pick<OutputChannel, "appendLine"> | null;
  events: Set<string>;
}

interface Pending {
  extensionId: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export function createExtensionHost(options: ExtensionHostOptions) {
  const timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
  const identity = { workspaceId: options.workspace ?? "none", hostGeneration: options.generation };
  const listeners = new Set<() => void>();
  const running = new Map<string, Running>();
  const pending = new Map<string, Pending>();
  const waiters = new Map<string, { resolve(): void; reject(error: Error): void }>();
  /** Command id → the extension whose handler is registered in the host. */
  const handlers = new Map<string, string>();
  /** View id → the extension providing it. */
  const viewProviders = new Map<string, string>();
  const shownViews = new Set<string>();
  const viewVersions = new Map<string, number>();
  let views: Record<string, readonly ViewRow[]> = {};
  let denied: Record<string, Omit<HostDenial, "extensionId">> = {};
  let hostState: HostState = "idle";
  let hostReason: string | null = null;
  let channel: HostChannel | null = null;
  let starting: Promise<HostChannel> | null = null;
  let finished = false;
  let nextRequest = 1;
  let malformed = 0;
  const fired = new Set<string>();
  const stops: (() => void)[] = [];
  let windowStops: (() => void)[] | null = null;
  let hostLog: Pick<OutputChannel, "appendLine"> | null = null;

  let snapshot: HostSnapshot = build();
  function build(): HostSnapshot {
    const statuses: Record<string, ExtensionStatus> = {};
    for (const [id, one] of running) statuses[id] = { ...one.status };
    return {
      workspace: options.workspace,
      generation: options.generation,
      host: hostState,
      hostReason,
      statuses,
      views,
      denied,
    };
  }
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

  // --- Logging -----------------------------------------------------------------------------------

  const channelFor = (one: Running) =>
    (one.log ??= options.channel
      ? options.channel(one.entry.id, one.entry.manifest.displayName)
      : createOutputChannel(`Extension: ${one.entry.manifest.displayName}`));
  const log = (one: Running, level: "info" | "warn" | "error", message: string) => {
    if (one.logged > LOG_LIMIT) return;
    one.logged++;
    const text =
      one.logged > LOG_LIMIT
        ? `(more than ${LOG_LIMIT} lines from this extension in this host; the rest are not shown)`
        : `[${level}] ${message.slice(0, 4000)}`;
    try {
      channelFor(one).appendLine(text);
    } catch {
      /* Logging never breaks the IDE. */
    }
  };
  const logHost = (message: string) => {
    try {
      hostLog ??= options.channel
        ? options.channel("yavin.extension-host", "Extension Host")
        : createOutputChannel("Extension Host");
      hostLog.appendLine(`[generation ${options.generation}] ${message}`);
    } catch {
      /* Logging never breaks the IDE. */
    }
  };

  const runningOf = (id: string): Running => {
    let one = running.get(id);
    const entry = options.registry.get(id);
    if (!entry) throw new ExtensionError("UnknownExtension", id, `There is no extension "${id}".`);
    if (!one) {
      one = {
        entry,
        status: { state: "registered", reason: null, activationMs: null },
        activation: null,
        loaded: false,
        messages: 0,
        logged: 0,
        log: null,
        events: new Set(),
      };
      running.set(id, one);
    }
    return one;
  };
  const move = (one: Running, to: ExtensionState, reason: string | null = one.status.reason) => {
    if (!canMoveExtension(one.status.state, to)) return false;
    one.status = { ...one.status, state: to, reason };
    return true;
  };

  // --- The process ---------------------------------------------------------------------------------

  const send = async (message: Record<string, unknown>) => {
    if (!channel || finished)
      throw new ExtensionError("HostDisposed", null, "The extension host is not running.");
    await channel.send(writeHostMessage({ ...message, ...identity }));
  };
  const wait = (key: string, ms: number, what: string) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(key);
        reject(
          new ExtensionError(
            "ActivationFailed",
            null,
            `The extension host did not ${what} within ${ms / 1000} s.`,
          ),
        );
      }, ms);
      waiters.set(key, {
        resolve: () => {
          clearTimeout(timer);
          waiters.delete(key);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          waiters.delete(key);
          reject(error);
        },
      });
    });

  const ensureHost = (): Promise<HostChannel> => {
    if (finished)
      return Promise.reject(
        new ExtensionError("HostDisposed", null, "This extension host has ended."),
      );
    starting ??= (async () => {
      hostState = "starting";
      publish();
      let started: HostChannel;
      try {
        started = await options.transport.start();
      } catch (error) {
        hostState = "crashed";
        hostReason = (error as Error)?.message ?? String(error);
        starting = null;
        publish();
        // The native refusal's code, at the start of the message (never the host's output).
        const code = /^([A-Za-z]+): /.exec(hostReason)?.[1];
        throw new ExtensionError(
          code === "TrustRequired" ||
            code === "SandboxUnavailable" ||
            code === "HostCrashedRepeatedly"
            ? code
            : "HostUnavailable",
          null,
          hostReason.replace(/^[A-Za-z]+: /, ""),
        );
      }
      if (finished) {
        await started.stop();
        throw new ExtensionError("HostDisposed", null, "The workspace was closed.");
      }
      channel = started;
      stops.push(started.onMessage(receive), started.onExit(onExit));
      // What the host process writes to stderr (a panic, a runtime error): to the Extension Host
      // channel, and the last of it into a crash's reason (EXT-05).
      if (started.onLog)
        stops.push(
          started.onLog((line) => {
            lastOutput = line;
            logHost(`host: ${line}`);
          }),
        );
      // What the native side refused (EXT-07): the extension was answered there.
      if (started.onDenied)
        stops.push(
          started.onDenied(({ extensionId, ...refusal }) => {
            if (running.has(extensionId)) refuse(extensionId, refusal);
          }),
        );
      const ready = wait("ready", timeouts.start, "start");
      await send({
        type: "init",
        apiVersion: EXTENSION_API,
        workspaceFolder: options.folder,
        limits: {},
      });
      await ready;
      hostState = "running";
      publish();
      return started;
    })();
    return starting;
  };

  /** Asks an extension something; the answer is its result, or a typed error. */
  const ask = (
    extensionId: string,
    method: string,
    params: unknown,
    ms: number,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    if (pending.size >= MAX_PENDING)
      return Promise.reject(
        new ExtensionError(
          "CommandFailed",
          extensionId,
          "The extension host is busy (too many requests).",
        ),
      );
    const requestId = `y${nextRequest++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(
          new ExtensionError(
            "Timeout",
            extensionId,
            `${method} did not answer within ${ms / 1000} s.`,
          ),
        );
      }, ms);
      pending.set(requestId, { extensionId, resolve, reject, timer });
      signal?.addEventListener(
        "abort",
        () => {
          // The host cannot stop a promise in an extension: Yavin stops waiting; a late answer is dropped.
          if (!pending.has(requestId)) return;
          clearTimeout(timer);
          pending.delete(requestId);
          reject(new ExtensionError("Cancelled", extensionId, `${method} was cancelled.`));
        },
        { once: true },
      );
      send({ type: "request", extensionId, requestId, method, params }).catch((error) => {
        clearTimeout(timer);
        pending.delete(requestId);
        reject(error);
      });
    });
  };

  const respond = (
    message: Extract<HostMessage, { type: "request" }>,
    result: { ok: true; value: unknown } | { ok: false; code: string; text: string },
  ) =>
    send(
      result.ok
        ? {
            type: "response",
            extensionId: message.extensionId,
            requestId: message.requestId,
            ok: true,
            result: result.value ?? null,
          }
        : {
            type: "response",
            extensionId: message.extensionId,
            requestId: message.requestId,
            ok: false,
            error: { code: result.code, message: result.text },
          },
    ).catch(() => undefined);

  function receive(text: string) {
    if (finished) return;
    const read = readHostMessage(text, identity);
    if (!read.ok) {
      malformed++;
      logHost(`Refused a message: ${read.reason}.`);
      if (malformed > MALFORMED_LIMIT && !read.stale)
        void crash("The extension host sent too many malformed messages.", true);
      return;
    }
    const message = read.message;
    switch (message.type) {
      case "ready":
        waiters.get("ready")?.resolve();
        return;
      case "loaded":
        waiters.get(`load:${message.extensionId}`)?.resolve();
        return;
      case "unloaded":
        waiters.get(`unload:${message.extensionId}`)?.resolve();
        return;
      case "log": {
        const one = running.get(message.extensionId);
        if (one) log(one, message.level, message.text);
        return;
      }
      case "error": {
        const id = message.extensionId;
        if (id === null) {
          logHost(`${message.error.code}: ${message.error.message}`);
          return;
        }
        const waiter = waiters.get(`load:${id}`);
        if (waiter) {
          waiter.reject(new ExtensionError("ActivationFailed", id, message.error.message));
          return;
        }
        const one = running.get(id);
        if (one) log(one, "error", `${message.error.code}: ${message.error.message}`);
        return;
      }
      case "response": {
        const waiting = pending.get(message.requestId);
        // Only the extension asked may answer: another's response is ignored.
        if (!waiting || waiting.extensionId !== message.extensionId) return;
        pending.delete(message.requestId);
        clearTimeout(waiting.timer);
        if (message.ok) waiting.resolve(message.result);
        else
          waiting.reject(
            new ExtensionError(
              message.error?.code === "ExtensionFailed" ? "CommandFailed" : "CommandFailed",
              message.extensionId,
              message.error?.message ?? "The extension failed.",
            ),
          );
        return;
      }
      case "request":
        void handle(message);
        return;
    }
  }

  /** The host process's last line of output, for a crash's reason. */
  let lastOutput: string | null = null;
  function onExit(end: { reason: string; crashed: boolean }) {
    if (finished) return;
    const reason =
      end.crashed && lastOutput ? `${end.reason} Its last output: ${lastOutput}` : end.reason;
    void crash(end.crashed ? reason : "The extension host stopped.", end.crashed);
  }

  /** The process is gone: everything of this host ends, bounded and once. */
  const crash = async (reason: string, crashed: boolean) => {
    if (finished) return;
    finished = true;
    hostState = crashed ? "crashed" : "stopped";
    hostReason = reason;
    logHost(reason);
    for (const [id, waiting] of pending) {
      clearTimeout(waiting.timer);
      waiting.reject(new ExtensionError("HostCrashed", waiting.extensionId, reason));
      pending.delete(id);
    }
    for (const waiter of [...waiters.values()])
      waiter.reject(new ExtensionError("HostCrashed", null, reason));
    for (const one of running.values()) {
      if (one.status.state === "active" || one.status.state === "activating") {
        one.status = {
          ...one.status,
          state: "failed",
          reason: `The extension host stopped: ${reason}`,
        };
        log(one, "error", `The extension host stopped: ${reason}`);
      }
      clearContributions(one.entry.id);
    }
    endWindowListeners();
    for (const stop of stops.splice(0)) stop();
    await channel?.stop().catch(() => undefined);
    channel = null;
    publish();
    if (crashed) options.onCrash?.(reason);
  };

  /** What an extension contributed at run time, removed (handlers, rows, providers, decorations). */
  const clearContributions = (extensionId: string) => {
    for (const [command, owner] of handlers) if (owner === extensionId) handlers.delete(command);
    for (const [view, owner] of viewProviders)
      if (owner === extensionId) {
        viewProviders.delete(view);
        const { [view]: _gone, ...rest } = views;
        views = rest;
      }
    // Only this host's: a host that ended never removes what its replacement registered.
    options.providers.clearExtension(extensionId, options.generation);
    options.decorations.clearExtension(extensionId, options.generation);
    running.get(extensionId)?.events.clear();
  };

  // --- Capabilities: what an extension may ask of Yavin ------------------------------------------

  const owned = (one: Running, name: string) => name.startsWith(`${one.entry.id}.`);
  /** Whether `capability` is requested by, and granted to, the copy registered (EXT-07). */
  const allowed = (one: Running, capability: string) => {
    const entry = options.registry.get(one.entry.id) ?? one.entry;
    return (
      entry.manifest.permissions.requested.includes(capability) &&
      entry.grants.granted.includes(capability)
    );
  };
  /** A refusal, kept for the Extensions view and said in the extension's output. */
  const refuse = (id: string, refusal: Omit<HostDenial, "extensionId">) => {
    const one = running.get(id);
    if (one) log(one, "warn", `${refusal.method} refused: ${refusal.code}: ${refusal.message}`);
    const last = denied[id];
    // A repeat changes nothing shown: no new snapshot for it.
    if (
      last &&
      last.method === refusal.method &&
      last.capability === refusal.capability &&
      last.code === refusal.code
    )
      return;
    denied = { ...denied, [id]: refusal };
    publish();
  };
  /** Refusals that no longer hold (it was allowed what it needed since) are forgotten. */
  const forgetAllowed = () => {
    let changed = false;
    const next: typeof denied = {};
    for (const [id, refusal] of Object.entries(denied)) {
      const one = running.get(id);
      if (one && refusal.capability && allowed(one, refusal.capability)) changed = true;
      else next[id] = refusal;
    }
    if (changed) {
      denied = next;
      publish();
    }
  };
  const fail = (code: string, text: string): never => {
    throw Object.assign(new Error(text), { code });
  };
  const stringParam = (params: Record<string, unknown>, name: string, max = 1000) => {
    const value = params[name];
    if (typeof value !== "string" || !value || value.length > max)
      fail("InvalidRequest", `"${name}" must be a string.`);
    return value as string;
  };
  const rangeParam = (value: unknown): ExtensionRange => {
    const raw = (value ?? {}) as Record<string, unknown>;
    const n = (name: string) => {
      const v = raw[name];
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 10_000_000)
        fail("InvalidRequest", `A range needs a whole ${name} ≥ 1.`);
      return v as number;
    };
    return {
      startLine: n("startLine"),
      startColumn: n("startColumn"),
      endLine: n("endLine"),
      endColumn: n("endColumn"),
    };
  };
  const folderUri = (): ResourceUri | null => (options.folder ? fileUri(options.folder) : null);
  /** A document URI from an extension, as a resource -- only within this workspace (or untitled). */
  const resourceOf = (uri: string) => {
    if (uri.startsWith("untitled:")) return uri as unknown as ReturnType<typeof resourceId>;
    let parsed: ResourceUri;
    try {
      parsed = parseUri(uri);
    } catch {
      return fail("InvalidRequest", `"${uri}" is not a file URI.`);
    }
    const root = folderUri();
    if (!root || !isEqualOrAncestor(root, parsed))
      return fail("OutsideWorkspace", `"${uri}" is not in this workspace.`);
    return resourceId(parsed);
  };
  const windowOf = () =>
    options.window ?? fail("Unavailable", "This window offers no documents or editor.");
  /**
   * An extension's own settings, as it sees them (EXT-13): a value set for this workspace, else
   * the active profile's (if valid for the setting), else the user's, else the default.
   */
  const configurationOf = (one: Running) => {
    const values: Record<string, unknown> = {};
    const profiled = options.profileSettings?.()[one.entry.id] ?? {};
    for (const setting of one.entry.manifest.contributes.settings) {
      const definition = options.registry.settingDefinition(setting.id);
      if (!definition) continue;
      const seen = options.settings.inspect(definition, options.workspace);
      const fromProfile =
        setting.id in profiled ? definition.parse(profiled[setting.id]) : undefined;
      values[setting.id] =
        seen.source === "workspace" || fromProfile === undefined ? seen.value : fromProfile;
    }
    return values;
  };
  const stateOf = (memento: { keys(): string[]; get(key: string): unknown } | null) => {
    if (!memento) return null;
    const values: Record<string, unknown> = {};
    for (const key of memento.keys()) values[key] = memento.get(key);
    return values;
  };

  /** Events to subscribed extensions only; the window's listeners are added once, when first needed. */
  const emit = (event: string, payload: unknown, only?: string) => {
    const need = needOfEvent(event);
    for (const one of running.values()) {
      // Its own settings' changes reach it whether or not it follows them (EXT-18): they also
      // refresh what its getConfiguration answers, which would otherwise stay as it was at
      // activation. Listeners are called only if it has any (the bootstrap).
      const delivered = one.events.has(event) || event === "configuration.changed";
      if (one.status.state !== "active" || !delivered) continue;
      if (only && one.entry.id !== only) continue;
      // Allowed when it subscribed is not enough: allowed now (EXT-07).
      if (need.kind === "capability" && !allowed(one, need.capability)) continue;
      void send({ type: "event", extensionId: one.entry.id, event, payload }).catch(
        () => undefined,
      );
    }
  };
  const startWindowListeners = () => {
    if (windowStops) return;
    windowStops = [];
    if (options.window) {
      windowStops.push(
        options.window.documents.subscribe((kind, document) => emit(`documents.${kind}`, document)),
        options.window.editor.onActive(() =>
          emit("editor.active", options.window?.editor.active() ?? null),
        ),
      );
    }
    // EXT-18: a change of the active profile's values reaches the extensions it is theirs, as a
    // user or workspace change does -- for each of their keys whose profile value changed.
    if (options.onProfileSettings) {
      let before = options.profileSettings?.() ?? {};
      windowStops.push(
        options.onProfileSettings(() => {
          const after = options.profileSettings?.() ?? {};
          const was = before;
          before = after;
          for (const one of running.values()) {
            const old = was[one.entry.id] ?? {};
            const now = after[one.entry.id] ?? {};
            for (const key of new Set([...Object.keys(old), ...Object.keys(now)]))
              if (JSON.stringify(old[key]) !== JSON.stringify(now[key]))
                emit(
                  "configuration.changed",
                  { key: key.slice(one.entry.id.length + 1), values: configurationOf(one) },
                  one.entry.id,
                );
          }
        }),
      );
    }
    windowStops.push(
      options.settings.subscribe(options.workspace, (change) => {
        for (const one of running.values())
          if (owned(one, change.id))
            emit(
              "configuration.changed",
              { key: change.id.slice(one.entry.id.length + 1), values: configurationOf(one) },
              one.entry.id,
            );
      }),
    );
  };
  const endWindowListeners = () => {
    for (const stop of windowStops ?? []) stop();
    windowStops = null;
  };

  const methods: Record<string, (one: Running, params: Record<string, unknown>) => unknown> = {
    "commands.register"(one, params) {
      const id = stringParam(params, "id", 200);
      if (!one.entry.manifest.contributes.commands.some((c) => c.command === id))
        fail("NotOwned", `"${id}" is not one of the commands ${one.entry.id} contributes.`);
      if (handlers.has(id)) fail("DuplicateCommand", `"${id}" already has a handler.`);
      handlers.set(id, one.entry.id);
      return null;
    },
    "commands.unregister"(one, params) {
      const id = stringParam(params, "id", 200);
      if (handlers.get(id) === one.entry.id) handlers.delete(id);
      return null;
    },
    "commands.execute"(_one, params) {
      const id = stringParam(params, "id", 200);
      const args = Array.isArray(params.args) ? params.args : [];
      return api.executeCommand(id, ...args);
    },
    "window.showMessage"(one, params) {
      const level = params.level === "warning" || params.level === "error" ? params.level : "info";
      const text = String(params.message ?? "").slice(0, 500);
      one.messages++;
      if (one.messages > MESSAGE_LIMIT) {
        if (one.messages === MESSAGE_LIMIT + 1)
          log(one, "warn", "Too many messages; the rest are only logged.");
        log(one, level === "warning" ? "warn" : level, text);
        return null;
      }
      options.notify(level, one.entry.id, text);
      return null;
    },
    async "storage.update"(one, params) {
      const scope = params.scope === "workspace" ? "workspace" : "global";
      const memento =
        scope === "global"
          ? options.storage.global(one.entry.id)
          : options.workspace
            ? options.storage.workspace(options.workspace, one.entry.id)
            : fail("Unavailable", "There is no workspace to keep state in.");
      try {
        await memento.update(stringParam(params, "key", 200), params.value);
      } catch (error) {
        fail((error as ExtensionError).code ?? "StorageLimit", (error as Error).message);
      }
      return null;
    },
    "events.subscribe"(one, params) {
      const event = stringParam(params, "event", 60);
      if (!EVENTS.has(event))
        fail("InvalidRequest", `"${event}" is not an event an extension can follow.`);
      one.events.add(event);
      startWindowListeners();
      return null;
    },
    "views.register"(one, params) {
      const id = stringParam(params, "id", 200);
      if (!one.entry.manifest.contributes.views.some((v) => v.id === id))
        fail("NotOwned", `"${id}" is not one of the views ${one.entry.id} contributes.`);
      if (viewProviders.has(id)) fail("DuplicateView", `"${id}" already has a provider.`);
      viewProviders.set(id, one.entry.id);
      if (shownViews.has(id)) void loadView(id);
      return null;
    },
    "views.refresh"(one, params) {
      const id = stringParam(params, "id", 200);
      if (viewProviders.get(id) !== one.entry.id)
        fail("NotOwned", `"${id}" is not ${one.entry.id}'s view.`);
      if (shownViews.has(id)) void loadView(id);
      return null;
    },
    "views.unregister"(one, params) {
      const id = stringParam(params, "id", 200);
      if (viewProviders.get(id) !== one.entry.id) return null;
      viewProviders.delete(id);
      const { [id]: _gone, ...rest } = views;
      views = rest;
      publish();
      return null;
    },
    "documents.all"() {
      return windowOf().documents.all();
    },
    "documents.get"(_one, params) {
      return windowOf().documents.get(resourceOf(stringParam(params, "uri", 4000)));
    },
    "documents.getText"(_one, params) {
      const text = windowOf().documents.text(resourceOf(stringParam(params, "uri", 4000)));
      if (text !== null && text.length > MAX_MESSAGE / 2)
        fail("TooLarge", "The document is too large to send to an extension.");
      return text;
    },
    "editor.active"() {
      return windowOf().editor.active();
    },
    async "editor.openLocation"(_one, params) {
      const uri = stringParam(params, "uri", 4000);
      resourceOf(uri);
      await windowOf().editor.openLocation(
        fsPath(parseUri(uri)),
        params.range ? rangeParam(params.range) : null,
      );
      return null;
    },
    "editor.setSelection"(_one, params) {
      return windowOf().editor.setSelection(rangeParam(params.range));
    },
    "editor.revealRange"(_one, params) {
      return windowOf().editor.revealRange(rangeParam(params.range));
    },
    "editor.setDecorations"(one, params) {
      const resource = resourceOf(stringParam(params, "uri", 4000));
      const key = stringParam(params, "key", 40);
      if (!KEY.test(key))
        fail("InvalidRequest", "A decoration key is letters, digits, '.', '_' or '-'.");
      const raw = Array.isArray(params.decorations)
        ? params.decorations
        : fail("InvalidRequest", "Decorations are a list.");
      if (raw.length > 1000) fail("TooLarge", "At most 1000 decorations per key.");
      const decorations: ExtensionDecoration[] = raw.map((entry) => {
        const item = (entry ?? {}) as Record<string, unknown>;
        if (!DECORATION_STYLES.includes(item.style as never))
          fail("InvalidRequest", `A decoration's style is one of ${DECORATION_STYLES.join(", ")}.`);
        return {
          range: rangeParam(item.range),
          style: item.style as ExtensionDecoration["style"],
          hover: typeof item.hover === "string" ? item.hover.slice(0, 500) : null,
        };
      });
      options.decorations.set({
        owner: `${one.entry.id}:${key}`,
        extensionId: one.entry.id,
        generation: options.generation,
        resource,
        decorations,
      });
      return null;
    },
    "languages.register"(one, params) {
      const kind = stringParam(params, "kind", 20) as ProviderKind;
      if (!["completion", "hover", "definition", "references", "symbols"].includes(kind))
        fail("InvalidRequest", `"${kind}" is not a provider kind.`);
      const providerId = stringParam(params, "providerId", 200);
      if (!providerId.startsWith(`${one.entry.id}#${kind}#`))
        fail("NotOwned", "A provider id is the extension's own.");
      const language = stringParam(params, "language", 50);
      if (!LANGUAGE.test(language)) fail("InvalidRequest", `"${language}" is not a language id.`);
      if (
        options.providers
          .getSnapshot()
          .some((p) => p.providerId === providerId && p.generation === options.generation)
      )
        fail("DuplicateProvider", `"${providerId}" is already registered.`);
      const extensionId = one.entry.id;
      options.providers.add({
        providerId,
        extensionId,
        generation: options.generation,
        kind,
        language,
        invoke: (request, signal) =>
          ask(
            extensionId,
            "provider.invoke",
            { providerId, kind, ...request },
            timeouts.provider,
            signal,
          ),
      });
      return null;
    },
    "languages.unregister"(one, params) {
      const providerId = stringParam(params, "providerId", 200);
      if (providerId.startsWith(`${one.entry.id}#`))
        options.providers.remove(providerId, options.generation);
      return null;
    },
    async "fs.readFile"(_one, params) {
      const path = stringParam(params, "path", 1000);
      const root = folderUri() ?? fail("Unavailable", "There is no workspace.");
      if (/^([a-z]:|[\\/]|[a-z]+:)/i.test(path))
        fail("OutsideWorkspace", "A path is relative to the workspace folder.");
      let target: ResourceUri;
      try {
        target = resolveWithin(root, path);
      } catch {
        return fail("OutsideWorkspace", `"${path}" is outside the workspace.`);
      }
      const text = await windowOf().readFile(fsPath(target));
      if (text.length > MAX_MESSAGE / 2)
        fail("TooLarge", "The file is too large to send to an extension.");
      return text;
    },
    async "fs.exists"(one, params) {
      try {
        await methods["fs.readFile"](one, params);
        return true;
      } catch (error) {
        if ((error as { code?: string }).code === "OutsideWorkspace") throw error;
        return false;
      }
    },
  };

  async function handle(message: Extract<HostMessage, { type: "request" }>) {
    const one = running.get(message.extensionId);
    // Only an extension of this host that is activating, active or deactivating (disposing its
    // registrations, saving its state) may ask anything.
    if (
      !one ||
      (one.status.state !== "active" &&
        one.status.state !== "activating" &&
        one.status.state !== "deactivating")
    ) {
      await respond(message, {
        ok: false,
        code: "NotActive",
        text: "The extension is not active.",
      });
      return;
    }
    // Its own methods only (never one an object inherits).
    const method = Object.hasOwn(methods, message.method) ? methods[message.method] : undefined;
    if (!method) {
      await respond(message, {
        ok: false,
        code: "UnknownMethod",
        text: `"${message.method}" is not part of the extension API.`,
      });
      return;
    }
    const params =
      message.params && typeof message.params === "object" && !Array.isArray(message.params)
        ? (message.params as Record<string, unknown>)
        : {};
    // The capability it needs, granted for this copy -- the native rule, applied here too.
    const need = needOfRequest(one.entry.id, message.method, params);
    if (need.kind === "capability" && !allowed(one, need.capability)) {
      const text = `"${need.capability}" is not allowed for ${one.entry.id} ${one.entry.manifest.version}.`;
      refuse(one.entry.id, {
        method: message.method,
        capability: need.capability,
        code: "PermissionDenied",
        message: text,
      });
      await respond(message, { ok: false, code: "PermissionDenied", text });
      return;
    }
    try {
      const value = await method(one, params);
      // Revoked while it ran (EXT-16): what it found is not delivered -- the native side
      // withholds such an answer too; this host applies the same rule.
      if (need.kind === "capability" && !allowed(one, need.capability)) {
        const text = `"${need.capability}" was revoked for ${one.entry.id} while ${message.method} ran; its answer is withheld.`;
        refuse(one.entry.id, {
          method: message.method,
          capability: need.capability,
          code: "PermissionDenied",
          message: text,
        });
        await respond(message, { ok: false, code: "PermissionDenied", text });
        return;
      }
      await respond(message, { ok: true, value });
    } catch (error) {
      const code = (error as { code?: string }).code ?? "Failed";
      log(one, "warn", `${message.method} refused: ${(error as Error).message}`);
      await respond(message, { ok: false, code, text: (error as Error).message });
    }
  }

  // --- Views -----------------------------------------------------------------------------------------

  /** `owner`'s rows, as the window shows them. */
  const rows = (owner: string, value: unknown, depth = 0, budget = { left: 1000 }): ViewRow[] =>
    (Array.isArray(value) ? value : []).flatMap((item) => {
      if (budget.left <= 0 || !item || typeof item.label !== "string") return [];
      budget.left--;
      const row: ViewRow = { label: item.label.slice(0, 200) };
      if (typeof item.description === "string") row.description = item.description.slice(0, 200);
      if (typeof item.tooltip === "string") row.tooltip = item.tooltip.slice(0, 500);
      // Its own commands only: a row may not make the user run another extension's (EXT-07).
      if (typeof item.command === "string" && options.registry.commandOwner(item.command) === owner)
        row.command = item.command;
      if (depth < 2 && Array.isArray(item.children))
        row.children = rows(owner, item.children, depth + 1, budget);
      return [row];
    });

  const loadView = async (view: string) => {
    const owner = viewProviders.get(view);
    if (!owner) return;
    const version = (viewVersions.get(view) ?? 0) + 1;
    viewVersions.set(view, version);
    try {
      const items = await ask(owner, "view.items", { id: view }, timeouts.view);
      if (finished || viewProviders.get(view) !== owner || viewVersions.get(view) !== version)
        return;
      views = { ...views, [view]: rows(owner, items) };
      publish();
    } catch (error) {
      const one = running.get(owner);
      if (one)
        log(one, "error", `The view "${view}" could not be filled: ${(error as Error).message}`);
    }
  };

  // --- Activation -------------------------------------------------------------------------------------

  const activateOne = (id: string): Promise<void> => {
    if (finished)
      return Promise.reject(
        new ExtensionError("HostDisposed", id, "This extension host has ended."),
      );
    const one = runningOf(id);
    if (!one.entry.enabled)
      return Promise.reject(
        new ExtensionError("Disabled", id, `${one.entry.manifest.displayName} is disabled.`),
      );
    if (one.status.state === "active") return Promise.resolve();
    if (one.activation) return one.activation;
    if (one.status.state === "failed")
      return Promise.reject(
        new ExtensionError("ActivationFailed", id, one.status.reason ?? "It failed to activate."),
      );
    // Declarative: nothing to run; its contributions are in place.
    if (!one.entry.manifest.main) return Promise.resolve();
    one.activation = (async () => {
      const unavailable = options.registry.getSnapshot().unavailable[id];
      if (unavailable) {
        one.status = { ...one.status, reason: unavailable };
        one.activation = null;
        publish();
        throw new ExtensionError("DependencyFailed", id, unavailable);
      }
      if (
        !one.entry.manifest.untrustedWorkspaces &&
        !(await options.trusted().catch(() => false))
      ) {
        one.status = {
          ...one.status,
          reason:
            "This folder is not trusted, so its extensions' code does not run. Trust it from File › Manage Workspace Trust.",
        };
        one.activation = null;
        publish();
        throw new ExtensionError("TrustRequired", id, one.status.reason!);
      }
      const started = performance.now();
      move(one, "activating", null);
      publish();
      // A load sent (answered or not): its code may be in the host, so a failure unloads it.
      let sent = one.loaded;
      try {
        await ensureHost();
        if (!one.loaded) {
          const loaded = wait(`load:${id}`, timeouts.load, `load ${id}`);
          sent = true;
          await send({ type: "load", extensionId: id });
          await loaded;
          one.loaded = true;
        }
        await ask(
          id,
          "activate",
          {
            globalState: stateOf(options.storage.global(id)),
            workspaceState: stateOf(
              options.workspace ? options.storage.workspace(options.workspace, id) : null,
            ),
            configuration: configurationOf(one),
          },
          timeouts.activate,
        );
      } catch (error) {
        const reason = `Activation failed: ${(error as Error)?.message ?? String(error)}`;
        log(one, "error", reason);
        // Recorded natively (EXT-14) -- the code only: the message is the extension's own text.
        options.report?.(
          (error as ExtensionError)?.code === "Timeout" ? "ActivationTimeout" : "ActivationFailed",
          id,
        );
        // Failed first: from now on nothing it asks is served (not a late registration).
        if (one.status.state === "activating") move(one, "failed", reason);
        clearContributions(id);
        // Its code is unloaded too -- also after a load that timed out, which the host may yet
        // finish -- and the failure is reported only once the host let go of it (EXT-05,
        // EXT-08): a failed extension keeps nothing in the host, not a pending promise.
        if (sent) await release(one, "its activation failed");
        clearContributions(id);
        one.activation = null;
        publish();
        // A refusal to run any code (trust, no sandbox) stays what it is: not this extension's.
        const code = (error as ExtensionError).code;
        throw new ExtensionError(
          code === "TrustRequired" || code === "SandboxUnavailable" ? code : "ActivationFailed",
          id,
          reason,
        );
      }
      if (finished || one.status.state !== "activating") {
        throw new ExtensionError(
          "HostDisposed",
          id,
          "The extension host ended while it activated.",
        );
      }
      one.status = {
        state: "active",
        reason: null,
        activationMs: Math.round(performance.now() - started),
      };
      log(
        one,
        "info",
        `Activated in ${one.status.activationMs} ms (host generation ${options.generation}).`,
      );
      one.activation = null;
      // Its settings' changes reach it from now on, followed or not (EXT-18).
      startWindowListeners();
      publish();
      // A view it contributes that is already shown is filled now.
      for (const view of one.entry.manifest.contributes.views)
        if (shownViews.has(view.id)) void loadView(view.id);
    })();
    return one.activation;
  };

  /** Dependencies first, in a deterministic order, then the extension itself. */
  const activate = async (id: string): Promise<void> => {
    // A missing, disabled or circular dependency is the registry's finding: said as such, before
    // anything of the chain runs.
    const unavailable = options.registry.getSnapshot().unavailable[id];
    if (unavailable) throw new ExtensionError("DependencyFailed", id, unavailable);
    for (const each of options.registry.activationOrder(id)) {
      // A version being retired (disabled, uninstalled, updated) is gone from the host first:
      // its late unload must never hit the version that replaces it.
      await retirements.get(each);
      await activateOne(each);
    }
  };

  const matches = (entry: RegisteredExtension, event: ActivationEvent) =>
    entry.manifest.activationEvents.some(
      (wanted) =>
        wanted.kind === event.kind &&
        (!("id" in wanted) || ("id" in event && wanted.id === event.id)),
    ) ||
    (event.kind === "command" &&
      entry.manifest.contributes.commands.some((c) => c.command === event.id)) ||
    (event.kind === "view" && entry.manifest.contributes.views.some((v) => v.id === event.id));

  /**
   * `one`'s code out of the host (EXT-08): an `unload`, and its answer. The host handles
   * messages in order, so the answer comes after any load or call still running; a host that
   * does not answer in time is ended -- it is not used again -- rather than trusted to have let
   * go. Resolves only once one of the two holds.
   */
  const release = async (one: Running, why: string) => {
    one.loaded = false;
    if (!channel || finished) return;
    const id = one.entry.id;
    const unloaded = wait(`unload:${id}`, timeouts.deactivate, `let go of ${id}`);
    try {
      await send({ type: "unload", extensionId: id });
      await unloaded;
    } catch {
      unloaded.catch(() => undefined);
      if (!finished)
        await crash(
          `The extension host did not let go of ${id} (${why}) in time; it was ended.`,
          false,
        );
    }
  };

  const deactivate = async (one: Running) => {
    if (one.status.state === "active" || one.status.state === "activating") {
      move(one, "deactivating");
      publish();
      if (channel && !finished) {
        try {
          const result = (await ask(one.entry.id, "deactivate", {}, timeouts.deactivate)) as {
            disposeErrors?: string[];
          } | null;
          for (const failure of result?.disposeErrors ?? [])
            log(one, "error", `A subscription failed to dispose: ${failure}`);
        } catch (error) {
          log(one, "error", `Deactivation failed: ${(error as Error).message}`);
        }
        await release(one, "it was deactivated");
      }
      clearContributions(one.entry.id);
    }
    move(one, "disposed");
  };

  /**
   * Reconciliation (EXT-05): what runs here is made to agree with the registry -- itself the
   * native inventory's choice (EXT-02). An extension stops -- deactivated, its code unloaded from
   * the host, its contributions (handlers, views' rows, providers, decorations) removed -- when it
   * is uninstalled, disabled, replaced by another version (a new registry entry), or can no
   * longer run because of its dependencies. Used again, it starts fresh from what the registry
   * now has. Run on every registry change; running it again changes nothing (an extension being
   * retired is retired once), so it converges.
   */
  const retirements = new Map<string, Promise<void>>();
  const reconcile = (): Promise<void> => {
    if (finished) return Promise.resolve();
    const unavailable = options.registry.getSnapshot().unavailable;
    for (const [id, one] of [...running]) {
      const entry = options.registry.get(id);
      if (entry && entry.enabled && entry === one.entry && !unavailable[id]) continue;
      if (retirements.has(id)) continue;
      const retirement = (async () => {
        try {
          if (one.status.state === "active" || one.status.state === "activating") {
            await deactivate(one);
            log(
              one,
              "info",
              !entry
                ? "Uninstalled: stopped."
                : !entry.enabled
                  ? "Disabled: stopped."
                  : entry !== one.entry
                    ? "Replaced: it will start again from its new version."
                    : `Stopped: ${unavailable[id]}`,
            );
          } else {
            if (one.loaded && channel && !finished)
              await send({ type: "unload", extensionId: id }).catch(() => undefined);
            clearContributions(id);
          }
        } finally {
          if (running.get(id) === one) running.delete(id);
          retirements.delete(id);
          publish();
        }
      })();
      retirements.set(id, retirement);
    }
    return Promise.all(retirements.values()).then(() => undefined);
  };
  const stopFollowing = options.registry.subscribe(() => {
    forgetAllowed();
    void reconcile();
  });

  const api = {
    getSnapshot: () => snapshot,
    /** Makes what runs agree with the registry now; resolves when every retirement is done. */
    reconcile,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    activate,
    async fire(event: ActivationEvent): Promise<void> {
      if (finished) return;
      const key = JSON.stringify(event);
      if ((event.kind === "startup" || event.kind === "workspace") && fired.has(key)) return;
      fired.add(key);
      const waiting = options.registry
        .getSnapshot()
        .extensions.filter((entry) => entry.enabled && entry.manifest.main && matches(entry, event))
        .sort((a, b) => a.id.localeCompare(b.id));
      await Promise.all(waiting.map((entry) => activate(entry.id).catch(() => undefined)));
    },
    async executeCommand(command: string, ...args: unknown[]): Promise<unknown> {
      const owner = options.registry.commandOwner(command);
      if (!owner)
        throw new ExtensionError(
          "UnknownCommand",
          null,
          `There is no extension command "${command}".`,
        );
      await activate(owner);
      if (handlers.get(command) !== owner)
        throw new ExtensionError(
          "CommandFailed",
          owner,
          `${options.registry.get(owner)?.manifest.displayName ?? owner} did not register "${command}".`,
        );
      try {
        return await ask(owner, "command.run", { id: command, args }, timeouts.command);
      } catch (error) {
        const one = running.get(owner);
        const message = `"${command}" failed: ${(error as Error)?.message ?? String(error)}`;
        if (one) log(one, "error", message);
        throw new ExtensionError(
          (error as ExtensionError).code === "Timeout" ? "Timeout" : "CommandFailed",
          owner,
          message,
        );
      }
    },
    /** A contributed view is shown: its extension is activated (once) and its rows asked for. */
    async showView(view: string): Promise<void> {
      shownViews.add(view);
      await api.fire({ kind: "view", id: view });
      if (viewProviders.has(view)) await loadView(view);
    },
    hideView(view: string) {
      shownViews.delete(view);
    },
    /** Command ids with a registered handler (the command registry's runtime view). */
    hasHandler: (command: string) => handlers.has(command),
    /** Ends every extension of this host, then the process. */
    async dispose(): Promise<void> {
      if (finished) return;
      stopFollowing();
      for (const one of [...running.values()].reverse()) await deactivate(one);
      finished = true;
      hostState = "stopped";
      for (const [, waiting] of pending) {
        clearTimeout(waiting.timer);
        waiting.reject(
          new ExtensionError(
            "HostDisposed",
            waiting.extensionId,
            "The extension host was stopped.",
          ),
        );
      }
      pending.clear();
      if (channel) {
        await channel.send(writeHostMessage({ type: "shutdown" })).catch(() => undefined);
        for (const stop of stops.splice(0)) stop();
        await channel.stop().catch(() => undefined);
        channel = null;
      }
      endWindowListeners();
      views = {};
      publish();
      listeners.clear();
    },
    get finished() {
      return finished;
    },
    /** Test and diagnostics only: pending requests now. */
    pendingCount: () => pending.size,
  };
  return api;
}

export type ExtensionHost = ReturnType<typeof createExtensionHost>;
export type { DocumentInfo };
