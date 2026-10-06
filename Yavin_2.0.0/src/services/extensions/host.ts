/**
 * The extension host (IDE-07): where extension code runs for one workspace, and the only thing
 * that hands it an API. One per workspace (`WorkspaceServices.extensions`), like the task and
 * debug services: an extension activated in workspace A is deactivated when A is closed, and
 * nothing it does afterwards -- a late registration, a message, a view refresh -- reaches B.
 *
 * ```text
 * ExtensionRegistry (window)            manifests, enabled state, contributions
 *        ▼
 * ExtensionHost (workspace)             lifecycle, activation events, trust, API, contexts
 *        ▼  runtime: bundled code only (see below)
 * extension activate(context, yavin)    ── yavin.* API ──► the IDE's own services
 * ```
 *
 * Per extension: registered → activating → active, or → failed; active → deactivating →
 * disposed. An extension is activated at most once per host, lazily -- by an activation event
 * (startup, the workspace opening, one of its commands, one of its views, a file of a
 * language) -- and never in a folder the user has not trusted unless its manifest declares it
 * safe there. A failure stays with its extension: it is logged to its output channel and its
 * state says why; the others are unaffected.
 *
 * Execution boundary: the runtime runs only code bundled with Yavin (`source.kind:
 * "bundled"`), in the window's own JavaScript context. That code is Yavin's own and is not
 * sandboxed; what isolates the rest of the IDE from it is the API it is handed, not a process
 * boundary. Code of installed extensions (`folder` sources) is not run: the window's content
 * security policy allows no code from outside Yavin's bundle, and running it safely needs a
 * separate host (a WASM runtime -- `ide-plugin-host` -- or a worker under an explicit policy),
 * which is future work.
 */
import { createOutputChannel, type OutputChannel } from "../panel/output.ts";
import type { SettingsRegistry } from "../settings/settings.ts";
import type { WorkspaceId } from "../terminalProtocol.ts";
import type {
  Disposable,
  ExtensionContext,
  ExtensionModule,
  ViewItem,
  ViewProvider,
  YavinApi,
} from "./api.ts";
import { ExtensionError } from "./errors.ts";
import { EXTENSION_API, type ActivationEvent } from "./manifest.ts";
import type { ExtensionRegistry, RegisteredExtension } from "./registry.ts";
import type { ExtensionStorage } from "./storage.ts";

export type ExtensionState =
  "registered" | "activating" | "active" | "failed" | "deactivating" | "disposed";

const NEXT: Record<ExtensionState, readonly ExtensionState[]> = {
  registered: ["activating", "disposed"],
  activating: ["active", "failed", "deactivating"],
  active: ["deactivating"],
  failed: ["disposed"],
  deactivating: ["disposed"],
  disposed: [],
};
export const canMoveExtension = (from: ExtensionState, to: ExtensionState) =>
  NEXT[from].includes(to);

export interface ExtensionStatus {
  state: ExtensionState;
  /** Why it failed, or why it is waiting (trust, an unsupported runtime). */
  reason: string | null;
  /** How long its activation took, in ms. */
  activationMs: number | null;
}

export interface HostSnapshot {
  workspace: WorkspaceId | null;
  generation: number;
  statuses: Readonly<Record<string, ExtensionStatus>>;
  /** Contributed views' rows, by view id, once supplied. */
  views: Readonly<Record<string, readonly ViewItem[]>>;
}

export interface ExtensionHostOptions {
  registry: ExtensionRegistry;
  settings: SettingsRegistry;
  storage: ExtensionStorage;
  workspace: WorkspaceId | null;
  folder: string | null;
  /** This host's activation generation (the workspace context's). */
  generation: number;
  /** Workspace Trust, asked before any extension code runs. */
  trusted(): Promise<boolean>;
  /** Shows an extension's message (`window.show*Message`). */
  notify(level: "info" | "warning" | "error", extensionId: string, message: string): void;
  /** The output channel for an extension (default: one per extension, by name). */
  channel?(extensionId: string, name: string): Pick<OutputChannel, "appendLine">;
}

/** Messages an extension may show per host before it is muted (one broken loop must not flood). */
const MESSAGE_LIMIT = 20;
/** Lines an extension may log per host before its log is cut short. */
const LOG_LIMIT = 500;

interface Running {
  entry: RegisteredExtension;
  status: ExtensionStatus;
  activation: Promise<void> | null;
  module: ExtensionModule | null;
  context: ExtensionContext | null;
  /** Live while the extension may act; false once it is deactivating or the host is gone. */
  alive: boolean;
  messages: number;
  logged: number;
  log: Pick<OutputChannel, "appendLine"> | null;
}

export function createExtensionHost(options: ExtensionHostOptions) {
  const listeners = new Set<() => void>();
  const running = new Map<string, Running>();
  /** Command id → its handler, while its extension is active. */
  const handlers = new Map<
    string,
    { extensionId: string; handler: (...args: unknown[]) => unknown }
  >();
  /** View id → its provider, while its extension is active. */
  const providers = new Map<
    string,
    { extensionId: string; provider: ViewProvider; version: number }
  >();
  let views: Record<string, readonly ViewItem[]> = {};
  let disposed = false;
  const fired = new Set<string>();

  let snapshot: HostSnapshot = build();
  function build(): HostSnapshot {
    const statuses: Record<string, ExtensionStatus> = {};
    for (const [id, one] of running) statuses[id] = { ...one.status };
    return { workspace: options.workspace, generation: options.generation, statuses, views };
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

  const channelFor = (one: Running) => {
    one.log ??= options.channel
      ? options.channel(one.entry.id, one.entry.manifest.displayName)
      : createOutputChannel(`Extension: ${one.entry.manifest.displayName}`);
    return one.log;
  };
  const log = (one: Running, level: "info" | "warn" | "error", message: string) => {
    if (one.logged > LOG_LIMIT) return;
    one.logged++;
    const text =
      one.logged > LOG_LIMIT
        ? `(more than ${LOG_LIMIT} lines from this extension in this workspace; the rest are not shown)`
        : `[${level}] ${message}`;
    try {
      channelFor(one).appendLine(text);
    } catch {
      /* Logging never breaks the IDE. */
    }
  };

  const entryOf = (id: string): Running => {
    let one = running.get(id);
    const entry = options.registry.get(id);
    if (!entry) throw new ExtensionError("UnknownExtension", id, `There is no extension "${id}".`);
    if (!one) {
      one = {
        entry,
        status: { state: "registered", reason: null, activationMs: null },
        activation: null,
        module: null,
        context: null,
        alive: false,
        messages: 0,
        logged: 0,
        log: null,
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

  // --- The API one extension is given ----------------------------------------------------------

  const apiFor = (one: Running): YavinApi => {
    const id = one.entry.id;
    const owns = (name: string) => name.startsWith(`${id}.`);
    const live = () => one.alive && !disposed;
    const inert: Disposable = { dispose() {} };
    const track = (disposable: Disposable) => {
      one.context?.subscriptions.push(disposable);
      return disposable;
    };
    const say = (level: "info" | "warning" | "error", message: unknown) => {
      if (!live()) return;
      one.messages++;
      if (one.messages > MESSAGE_LIMIT) {
        if (one.messages === MESSAGE_LIMIT + 1)
          log(one, "warn", "Too many messages; the rest are only logged.");
        log(one, level === "warning" ? "warn" : level, String(message));
        return;
      }
      options.notify(level, id, String(message).slice(0, 500));
    };
    return {
      version: EXTENSION_API,
      commands: {
        registerCommand(command, handler) {
          if (!live()) return inert;
          if (!one.entry.manifest.contributes.commands.some((c) => c.command === command))
            throw new ExtensionError(
              "NotOwned",
              id,
              `"${command}" is not one of the commands ${id} contributes in its manifest.`,
            );
          if (handlers.has(command))
            throw new ExtensionError("DuplicateCommand", id, `"${command}" already has a handler.`);
          if (typeof handler !== "function")
            throw new ExtensionError(
              "CommandFailed",
              id,
              `The handler of "${command}" is not a function.`,
            );
          handlers.set(command, { extensionId: id, handler });
          return track({
            dispose() {
              if (handlers.get(command)?.handler === handler) handlers.delete(command);
            },
          });
        },
        executeCommand: (command, ...args) => {
          if (!live())
            return Promise.reject(
              new ExtensionError("HostDisposed", id, "The extension is not active."),
            );
          return api.executeCommand(command, ...args);
        },
      },
      window: {
        showInformationMessage: (message) => say("info", message),
        showWarningMessage: (message) => say("warning", message),
        showErrorMessage: (message) => say("error", message),
      },
      workspace: {
        getWorkspaceFolder: () => options.folder,
        getConfiguration(section) {
          if (section !== id)
            throw new ExtensionError(
              "NotOwned",
              id,
              `An extension reads its own settings ("${id}"), not "${section}".`,
            );
          return {
            get<T>(key: string) {
              const definition = options.registry.settingDefinition(`${id}.${key}`);
              return definition
                ? (options.settings.get(definition, options.workspace) as T)
                : undefined;
            },
          };
        },
        onDidChangeConfiguration(listener) {
          if (!live()) return inert;
          const stop = options.settings.subscribe(options.workspace, (change) => {
            if (!live() || !owns(change.id)) return;
            try {
              listener(change.id.slice(id.length + 1));
            } catch (error) {
              log(
                one,
                "error",
                `A configuration listener threw: ${(error as Error)?.message ?? error}`,
              );
            }
          });
          return track({ dispose: stop });
        },
      },
      views: {
        registerView(view, provider) {
          if (!live()) return inert;
          if (!one.entry.manifest.contributes.views.some((v) => v.id === view))
            throw new ExtensionError(
              "NotOwned",
              id,
              `"${view}" is not one of the views ${id} contributes.`,
            );
          if (providers.has(view))
            throw new ExtensionError("DuplicateView", id, `"${view}" already has a provider.`);
          const record = { extensionId: id, provider, version: 0 };
          providers.set(view, record);
          const refresh = () => void loadView(one, view, record);
          const changes = provider.onDidChange?.(refresh);
          refresh();
          return track({
            dispose() {
              changes?.dispose();
              if (providers.get(view) === record) {
                providers.delete(view);
                const { [view]: _gone, ...rest } = views;
                views = rest;
                if (!disposed) publish();
              }
            },
          });
        },
      },
    };
  };

  /** A view's rows, from its provider; an answer overtaken by a newer one is dropped. */
  const loadView = async (
    one: Running,
    view: string,
    record: { provider: ViewProvider; version: number },
  ) => {
    const version = ++record.version;
    try {
      const items = await record.provider.getItems();
      if (disposed || !one.alive || providers.get(view) !== record || record.version !== version)
        return;
      const rows = (Array.isArray(items) ? items : []).slice(0, 1000).flatMap((item) =>
        item && typeof item.label === "string"
          ? [
              {
                label: item.label.slice(0, 200),
                ...(typeof item.description === "string"
                  ? { description: item.description.slice(0, 200) }
                  : {}),
                ...(typeof item.command === "string" ? { command: item.command } : {}),
              },
            ]
          : [],
      );
      views = { ...views, [view]: rows };
      publish();
    } catch (error) {
      log(
        one,
        "error",
        `The view "${view}" could not be filled: ${(error as Error)?.message ?? error}`,
      );
    }
  };

  // --- Activation --------------------------------------------------------------------------------

  const loadModule = (entry: RegisteredExtension): ExtensionModule => {
    if (entry.source.kind === "bundled") return entry.source.module;
    throw new ExtensionError(
      "UnsupportedRuntime",
      entry.id,
      "Yavin does not run code from installed extensions yet; only its declarative contributions apply.",
    );
  };

  const activate = (id: string): Promise<void> => {
    if (disposed)
      return Promise.reject(new ExtensionError("HostDisposed", id, "The workspace was closed."));
    const one = entryOf(id);
    if (!one.entry.enabled)
      return Promise.reject(
        new ExtensionError("Disabled", id, `${one.entry.manifest.displayName} is disabled.`),
      );
    if (one.status.state === "active") return Promise.resolve();
    // Never twice: a second request joins the first.
    if (one.activation) return one.activation;
    if (one.status.state === "failed")
      return Promise.reject(
        new ExtensionError("ActivationFailed", id, one.status.reason ?? "It failed to activate."),
      );
    if (!one.entry.manifest.main && one.entry.source.kind === "folder")
      // Declarative: nothing to run; its contributions are already in place.
      return Promise.resolve();
    one.activation = (async () => {
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
      if (disposed) throw new ExtensionError("HostDisposed", id, "The workspace was closed.");
      let module: ExtensionModule;
      try {
        module = loadModule(one.entry);
      } catch (error) {
        one.status = { ...one.status, reason: (error as Error).message };
        one.activation = null;
        publish();
        throw error;
      }
      move(one, "activating", null);
      publish();
      const started = performance.now();
      one.alive = true;
      one.module = module;
      const subscriptions: Disposable[] = [];
      one.context = {
        extensionId: id,
        extensionPath: one.entry.source.kind === "folder" ? one.entry.source.path : null,
        workspaceFolder: options.folder,
        globalState: options.storage.global(id),
        workspaceState: options.workspace ? options.storage.workspace(options.workspace, id) : null,
        subscriptions,
        log: {
          info: (message) => log(one, "info", String(message)),
          warn: (message) => log(one, "warn", String(message)),
          error: (message) => log(one, "error", String(message)),
        },
      };
      try {
        await module.activate(one.context, apiFor(one));
      } catch (error) {
        const reason = `Activation failed: ${(error as Error)?.message ?? String(error)}`;
        log(one, "error", reason);
        one.alive = false;
        disposeAll(one);
        move(one, "failed", reason);
        one.activation = null;
        publish();
        throw new ExtensionError("ActivationFailed", id, reason);
      }
      // The workspace closed while it activated: it is ended at once.
      if (disposed || one.status.state !== "activating") {
        one.alive = false;
        disposeAll(one);
        throw new ExtensionError("HostDisposed", id, "The workspace was closed.");
      }
      one.status = {
        state: "active",
        reason: null,
        activationMs: Math.round(performance.now() - started),
      };
      log(one, "info", `Activated in ${one.status.activationMs} ms.`);
      publish();
    })();
    return one.activation;
  };

  /** Disposes an extension's subscriptions, newest first; one failure does not stop the rest. */
  const disposeAll = (one: Running) => {
    const subscriptions = one.context?.subscriptions ?? [];
    while (subscriptions.length) {
      const next = subscriptions.pop()!;
      try {
        next.dispose();
      } catch (error) {
        log(
          one,
          "error",
          `A subscription failed to dispose: ${(error as Error)?.message ?? error}`,
        );
      }
    }
    for (const [command, record] of handlers)
      if (record.extensionId === one.entry.id) handlers.delete(command);
    for (const [view, record] of providers)
      if (record.extensionId === one.entry.id) {
        providers.delete(view);
        const { [view]: _gone, ...rest } = views;
        views = rest;
      }
  };

  const deactivate = async (one: Running) => {
    if (one.status.state === "active" || one.status.state === "activating") {
      move(one, "deactivating");
      one.alive = false;
      publish();
      try {
        await one.module?.deactivate?.();
      } catch (error) {
        log(one, "error", `Deactivation failed: ${(error as Error)?.message ?? error}`);
      }
      disposeAll(one);
    }
    move(one, "disposed");
  };

  /** Whether `event` activates extension `entry`. */
  const matches = (entry: RegisteredExtension, event: ActivationEvent) =>
    entry.manifest.activationEvents.some(
      (wanted) =>
        wanted.kind === event.kind &&
        (!("id" in wanted) || ("id" in event && wanted.id === event.id)),
    ) ||
    // A command or view of its own always activates it, declared or not.
    (event.kind === "command" &&
      entry.manifest.contributes.commands.some((c) => c.command === event.id)) ||
    (event.kind === "view" && entry.manifest.contributes.views.some((v) => v.id === event.id));

  const api = {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Activates `id` (once); rejects with a typed reason, never throws into the IDE. */
    activate,
    /**
     * An activation event: every enabled extension that waits for it is activated. Failures
     * stay with their extensions (logged, in their status); one never stops another.
     */
    async fire(event: ActivationEvent): Promise<void> {
      if (disposed) return;
      const key = JSON.stringify(event);
      // Startup and the workspace happen once per host.
      if ((event.kind === "startup" || event.kind === "workspace") && fired.has(key)) return;
      fired.add(key);
      const waiting = options.registry
        .getSnapshot()
        .extensions.filter(
          (entry) => entry.enabled && entry.manifest.main && matches(entry, event),
        );
      await Promise.all(waiting.map((entry) => activate(entry.id).catch(() => undefined)));
    },
    /**
     * Runs an extension command: its extension is activated first if it is not (lazily), then
     * its handler. Every failure is an `ExtensionError` naming the extension.
     */
    async executeCommand(command: string, ...args: unknown[]): Promise<unknown> {
      const owner = options.registry.commandOwner(command);
      if (!owner)
        throw new ExtensionError("UnknownCommand", null, `There is no command "${command}".`);
      await activate(owner);
      const record = handlers.get(command);
      if (!record)
        throw new ExtensionError(
          "CommandFailed",
          owner,
          `${options.registry.get(owner)?.manifest.displayName ?? owner} did not register "${command}".`,
        );
      try {
        return await record.handler(...args);
      } catch (error) {
        const one = running.get(owner);
        const message = `"${command}" failed: ${(error as Error)?.message ?? String(error)}`;
        if (one) log(one, "error", message);
        throw new ExtensionError("CommandFailed", owner, message);
      }
    },
    /** A contributed view is about to be shown: its extension is activated (once). */
    async showView(view: string): Promise<void> {
      await api.fire({ kind: "view", id: view });
    },
    /** Ends every extension of this workspace: deactivated, subscriptions disposed, newest first. */
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      for (const one of [...running.values()].reverse()) await deactivate(one);
      handlers.clear();
      providers.clear();
      views = {};
      publish();
      listeners.clear();
    },
    get disposed() {
      return disposed;
    },
  };
  return api;
}

export type ExtensionHost = ReturnType<typeof createExtensionHost>;
