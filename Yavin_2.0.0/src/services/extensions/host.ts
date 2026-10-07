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
import { MAX_MESSAGE, readHostMessage, writeHostMessage, type HostMessage } from "./protocol.ts";
import type { ExtensionRegistry, RegisteredExtension } from "./registry.ts";
import type { ExtensionStorage } from "./storage.ts";
import type { HostChannel, HostTransport } from "./transport.ts";
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
        throw new ExtensionError(
          /TrustRequired/.test(hostReason) ? "TrustRequired" : "HostUnavailable",
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

  function onExit(end: { reason: string; crashed: boolean }) {
    if (finished) return;
    void crash(end.crashed ? end.reason : "The extension host stopped.", end.crashed);
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
    options.providers.clearExtension(extensionId);
    options.decorations.clearExtension(extensionId);
    running.get(extensionId)?.events.clear();
  };

  // --- Capabilities: what an extension may ask of Yavin ------------------------------------------

  const owned = (one: Running, name: string) => name.startsWith(`${one.entry.id}.`);
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
  const configurationOf = (one: Running) => {
    const values: Record<string, unknown> = {};
    for (const setting of one.entry.manifest.contributes.settings) {
      const definition = options.registry.settingDefinition(setting.id);
      if (definition) values[setting.id] = options.settings.get(definition, options.workspace);
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
    for (const one of running.values()) {
      if (one.status.state !== "active" || !one.events.has(event)) continue;
      if (only && one.entry.id !== only) continue;
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
    windowStops.push(
      options.settings.subscribe(options.workspace, (change) => {
        for (const one of running.values())
          if (owned(one, change.id) && one.events.has("configuration.changed"))
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
      if (options.providers.getSnapshot().some((p) => p.providerId === providerId))
        fail("DuplicateProvider", `"${providerId}" is already registered.`);
      const extensionId = one.entry.id;
      options.providers.add({
        providerId,
        extensionId,
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
      if (providerId.startsWith(`${one.entry.id}#`)) options.providers.remove(providerId);
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
    const method = methods[message.method];
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
    try {
      const value = await method(one, params);
      await respond(message, { ok: true, value });
    } catch (error) {
      const code = (error as { code?: string }).code ?? "Failed";
      log(one, "warn", `${message.method} refused: ${(error as Error).message}`);
      await respond(message, { ok: false, code, text: (error as Error).message });
    }
  }

  // --- Views -----------------------------------------------------------------------------------------

  const rows = (value: unknown, depth = 0, budget = { left: 1000 }): ViewRow[] =>
    (Array.isArray(value) ? value : []).flatMap((item) => {
      if (budget.left <= 0 || !item || typeof item.label !== "string") return [];
      budget.left--;
      const row: ViewRow = { label: item.label.slice(0, 200) };
      if (typeof item.description === "string") row.description = item.description.slice(0, 200);
      if (typeof item.tooltip === "string") row.tooltip = item.tooltip.slice(0, 500);
      if (typeof item.command === "string" && options.registry.commandOwner(item.command))
        row.command = item.command;
      if (depth < 2 && Array.isArray(item.children))
        row.children = rows(item.children, depth + 1, budget);
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
      views = { ...views, [view]: rows(items) };
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
      try {
        await ensureHost();
        if (!one.loaded) {
          const loaded = wait(`load:${id}`, timeouts.load, `load ${id}`);
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
        clearContributions(id);
        if (one.status.state === "activating") move(one, "failed", reason);
        one.activation = null;
        publish();
        throw new ExtensionError(
          (error as ExtensionError).code === "TrustRequired" ? "TrustRequired" : "ActivationFailed",
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
        await send({ type: "unload", extensionId: one.entry.id }).catch(() => undefined);
      }
      clearContributions(one.entry.id);
    }
    move(one, "disposed");
  };

  /**
   * The registry is the source of truth (IDE-09): an extension disabled, uninstalled or
   * replaced (updated: a new registry entry) stops here -- deactivated, its code unloaded from
   * the host, its contributions (handlers, views' rows, providers, decorations) removed. Used
   * again, it starts fresh from what the registry now has.
   */
  const retirements = new Map<string, Promise<void>>();
  const followRegistry = () => {
    if (finished) return;
    for (const [id, one] of [...running]) {
      const entry = options.registry.get(id);
      if (entry && entry.enabled && entry === one.entry) continue;
      if (retirements.has(id)) continue;
      const retirement = (async () => {
        try {
          if (one.status.state === "active" || one.status.state === "activating") {
            await deactivate(one);
            log(
              one,
              "info",
              entry
                ? entry.enabled
                  ? "Replaced: it will start again from its new version."
                  : "Disabled: stopped."
                : "Uninstalled: stopped.",
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
  };
  const stopFollowing = options.registry.subscribe(followRegistry);

  const api = {
    getSnapshot: () => snapshot,
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
