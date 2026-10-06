/**
 * A test double of the extension host process (IDE-08), for unit and UI tests: it runs the real
 * host's `bootstrap.js` (the API extensions see) and the extension's code in this JavaScript
 * realm, speaks the same protocol, and stamps every outgoing message with the extension's real
 * identity as the native host does. It is NOT an isolation boundary -- the real host
 * (`ide-plugin-host`, QuickJS in its own process) is, and is tested natively. Never used by the
 * application.
 */
import type { HostChannel, HostTransport } from "./transport.ts";

export interface InProcessHostOptions {
  /** The text of `src-tauri/crates/ide-plugin-host/src/bootstrap.js`. */
  bootstrap: string;
  /** An extension's code by id, as the native side would read it; null when it has none. */
  code(extensionId: string): string | null;
  /** Fails `start`, as the native side does (`Code: message`). */
  failStart?: string;
}

export function createInProcessTransport(options: InProcessHostOptions) {
  let started = 0;
  let live: { exit(crashed: boolean, reason: string): void; deliver(text: string): void } | null =
    null;
  const transport: HostTransport = {
    async start(): Promise<HostChannel> {
      if (options.failStart) throw new Error(options.failStart);
      started++;
      const messageListeners = new Set<(text: string) => void>();
      const exitListeners = new Set<(end: { reason: string; crashed: boolean }) => void>();
      let identity: {
        workspaceId: string;
        hostGeneration: number;
        workspaceFolder: string | null;
        apiVersion: string;
      } | null = null;
      const extensions = new Map<string, { receive(text: string): void }>();
      let ended = false;
      const out = (message: Record<string, unknown>) => {
        const text = JSON.stringify(message);
        queueMicrotask(() => {
          if (!ended) for (const listener of [...messageListeners]) listener(text);
        });
      };
      const stamped = (extensionId: string) => (text: string) => {
        if (!identity) return;
        const message = JSON.parse(text);
        out({
          ...message,
          extensionId,
          workspaceId: identity.workspaceId,
          hostGeneration: identity.hostGeneration,
        });
      };
      const handle = (text: string) => {
        const message = JSON.parse(text);
        if (message.type === "init") {
          identity = message;
          out({ type: "ready" });
          return;
        }
        if (message.type === "shutdown") return;
        if (
          !identity ||
          message.workspaceId !== identity.workspaceId ||
          message.hostGeneration !== identity.hostGeneration
        ) {
          out({ type: "error", error: { code: "StaleGeneration", message: "stale" } });
          return;
        }
        const id = message.extensionId as string;
        if (message.type === "load") {
          const code = options.code(id);
          if (code === null) {
            out({
              type: "error",
              extensionId: id,
              workspaceId: identity.workspaceId,
              hostGeneration: identity.hostGeneration,
              error: { code: "LoadFailed", message: `${id} has no code.` },
            });
            return;
          }
          const fakeGlobal: Record<string, unknown> = { __yavin_send: stamped(id) };
          const init = JSON.stringify({
            extensionId: id,
            workspaceId: identity.workspaceId,
            hostGeneration: identity.hostGeneration,
            workspaceFolder: identity.workspaceFolder,
            extensionPath: `/extensions/${id}`,
            apiVersion: identity.apiVersion,
          });
          try {
            new Function("globalThis", options.bootstrap.replaceAll("__YAVIN_INIT__", init))(
              fakeGlobal,
            );
            const receive = fakeGlobal.__yavin_receive as (text: string) => void;
            (fakeGlobal.__yavin_load as (source: string) => void)(code);
            extensions.set(id, { receive });
            out({
              type: "loaded",
              extensionId: id,
              workspaceId: identity.workspaceId,
              hostGeneration: identity.hostGeneration,
            });
          } catch (error) {
            out({
              type: "error",
              extensionId: id,
              workspaceId: identity.workspaceId,
              hostGeneration: identity.hostGeneration,
              error: { code: "LoadFailed", message: String((error as Error).message) },
            });
          }
          return;
        }
        if (message.type === "unload") {
          extensions.delete(id);
          out({
            type: "unloaded",
            extensionId: id,
            workspaceId: identity.workspaceId,
            hostGeneration: identity.hostGeneration,
          });
          return;
        }
        const extension = extensions.get(id);
        if (!extension) {
          out({
            type: "response",
            requestId: message.requestId,
            ok: false,
            error: { code: "NotLoaded", message: "not loaded" },
            extensionId: id,
            workspaceId: identity.workspaceId,
            hostGeneration: identity.hostGeneration,
          });
          return;
        }
        try {
          extension.receive(text);
        } catch (error) {
          if (message.type === "request")
            out({
              type: "response",
              requestId: message.requestId,
              ok: false,
              error: { code: "ExtensionFailed", message: String((error as Error).message) },
              extensionId: id,
              workspaceId: identity.workspaceId,
              hostGeneration: identity.hostGeneration,
            });
        }
      };
      live = {
        exit(crashed, reason) {
          if (ended) return;
          ended = true;
          for (const listener of [...exitListeners]) listener({ reason, crashed });
        },
        deliver(text) {
          for (const listener of [...messageListeners]) listener(text);
        },
      };
      const self = live;
      return {
        async send(text) {
          if (ended) throw new Error("HostStopped: The extension host has stopped.");
          queueMicrotask(() => {
            if (!ended) handle(text);
          });
        },
        onMessage(listener) {
          messageListeners.add(listener);
          return () => messageListeners.delete(listener);
        },
        onExit(listener) {
          exitListeners.add(listener);
          return () => exitListeners.delete(listener);
        },
        async stop() {
          self.exit(false, "The extension host ended.");
        },
      };
    },
  };
  return {
    transport,
    /** How many host processes were started. */
    started: () => started,
    /** The current host process dies. */
    crash: (reason = "The extension host exited with code 3.") => live?.exit(true, reason),
    /** A raw message from the host, as if it had sent it (malformed, stale, spoofed...). */
    deliverRaw: (text: string) => live?.deliver(text),
  };
}
