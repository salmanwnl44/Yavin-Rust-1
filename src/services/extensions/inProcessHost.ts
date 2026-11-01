/**
 * A test double of the extension host process (IDE-08), for unit and UI tests: it runs the real
 * host's `bootstrap.js` (the API extensions see) and the extension's code in this JavaScript
 * realm, speaks the same protocol, and stamps every outgoing message with the extension's real
 * identity as the native host does. It is NOT an isolation boundary -- the real host
 * (`ide-plugin-host`, QuickJS in its own process) is, and is tested natively. Never used by the
 * application.
 */
import type { HostChannel, HostDenial, HostTransport } from "./transport.ts";

export interface InProcessHostOptions {
  /** The text of `src-tauri/crates/ide-plugin-host/src/bootstrap.js`. */
  bootstrap: string;
  /** An extension's code by id, as the native side would read it; null when it has none. */
  code(extensionId: string): string | null;
  /**
   * EXT-27: the VS Code compatibility layer (`vscode.js`), put where the bootstrap says, and what
   * a VS Code extension is loaded with -- its modules, its manifest's `vsix.runtime`, its entry
   * point -- as `extension_host.rs` sends them. Without these, VS Code extensions do not load.
   */
  vscodeLayer?: string;
  vscode?(
    extensionId: string,
  ): { modules: Record<string, string>; runtime: unknown; main: string } | null;
  /** Fails `start`, as the native side does (`Code: message`). */
  failStart?: string;
  /**
   * Holds a message back for this many milliseconds before it is handled (EXT-08 tests: a slow
   * load, an unload never answered). Messages are handled in order, as the real host does.
   */
  delay?(message: { type: string; extensionId?: string; method?: string }): number | undefined;
}

export function createInProcessTransport(options: InProcessHostOptions) {
  let started = 0;
  let live: {
    exit(crashed: boolean, reason: string): void;
    deliver(text: string): void;
    log(line: string): void;
    denied(denied: HostDenial): void;
    resident(): string[];
  } | null = null;
  const transport: HostTransport = {
    async start(): Promise<HostChannel> {
      if (options.failStart) throw new Error(options.failStart);
      started++;
      const messageListeners = new Set<(text: string) => void>();
      const exitListeners = new Set<(end: { reason: string; crashed: boolean }) => void>();
      const logListeners = new Set<(line: string) => void>();
      const deniedListeners = new Set<(denied: HostDenial) => void>();
      let identity: {
        workspaceId: string;
        hostGeneration: number;
        workspaceFolder: string | null;
        apiVersion: string;
      } | null = null;
      const extensions = new Map<string, { receive(text: string): void }>();
      const stops = new Map<string, () => void>();
      let ended = false;
      /** Messages are handled one after another, in the order sent (the real host reads one pipe). */
      let queue = Promise.resolve();
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
          // Timers as the host keeps them (runtime.rs): fired as messages of their own.
          const timers = new Map<number, ReturnType<typeof setTimeout>>();
          const vscode = options.vscode?.(id) ?? null;
          const fakeGlobal: Record<string, unknown> = {
            __yavin_send: stamped(id),
            __yavin_timer(timer: number, ms: number, repeat: boolean) {
              if (timers.size >= 1000 && !timers.has(timer)) return false;
              const fire = () =>
                (queue = queue.then(() => {
                  if (!repeat) timers.delete(timer);
                  if (!ended)
                    extensions.get(id)?.receive(JSON.stringify({ type: "timer", id: timer }));
                }));
              timers.set(
                timer,
                repeat ? setInterval(fire, Math.max(ms, 10)) : setTimeout(fire, ms),
              );
              return true;
            },
            // Random bytes as hex, as runtime.rs gives them (EXT-28; EXT-31's webview tokens).
            __yavin_random(n: number) {
              if (!Number.isInteger(n) || n < 0 || n > 65536) return null;
              const bytes = globalThis.crypto.getRandomValues(new Uint8Array(n));
              return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
            },
            __yavin_untimer(timer: number) {
              const handle = timers.get(timer);
              if (handle !== undefined) {
                clearTimeout(handle);
                clearInterval(handle);
              }
              timers.delete(timer);
            },
          };
          stops.set(id, () => {
            for (const handle of timers.values()) {
              clearTimeout(handle);
              clearInterval(handle);
            }
            timers.clear();
          });
          const init = JSON.stringify({
            extensionId: id,
            workspaceId: identity.workspaceId,
            hostGeneration: identity.hostGeneration,
            workspaceFolder: identity.workspaceFolder,
            extensionPath: `/extensions/${id}`,
            apiVersion: identity.apiVersion,
            runtime: vscode ? "vscode" : "yavin",
          });
          try {
            new Function(
              "globalThis",
              // Literally, as runtime.rs does (EXT-29): a replacement string would expand the
              // layer's own `$&` and `` $` `` (its escaping and its regular expressions).
              options.bootstrap
                .replace("/*__YAVIN_VSCODE__*/", () => options.vscodeLayer ?? "")
                .replaceAll("__YAVIN_INIT__", () => init),
            )(fakeGlobal);
            const receive = fakeGlobal.__yavin_receive as (text: string) => void;
            (fakeGlobal.__yavin_load as (...args: string[]) => void)(
              code,
              vscode ? JSON.stringify(vscode.modules) : "null",
              vscode ? JSON.stringify(vscode.runtime) : "null",
              vscode ? vscode.main : "",
            );
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
          stops.get(id)?.();
          stops.delete(id);
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
          for (const stop of stops.values()) stop();
          stops.clear();
          for (const listener of [...exitListeners]) listener({ reason, crashed });
        },
        deliver(text) {
          for (const listener of [...messageListeners]) listener(text);
        },
        log(line) {
          for (const listener of [...logListeners]) listener(line);
        },
        denied(denied) {
          for (const listener of [...deniedListeners]) listener(denied);
        },
        resident: () => [...extensions.keys()].sort(),
      };
      const self = live;
      return {
        async send(text) {
          if (ended) throw new Error("HostStopped: The extension host has stopped.");
          queue = queue.then(async () => {
            const ms = options.delay?.(JSON.parse(text));
            if (ms) await new Promise((resolve) => setTimeout(resolve, ms));
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
        onLog(listener) {
          logListeners.add(listener);
          return () => logListeners.delete(listener);
        },
        onDenied(listener) {
          deniedListeners.add(listener);
          return () => deniedListeners.delete(listener);
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
    /** A line on the current host's stderr. */
    stderr: (line: string) => live?.log(line),
    /** A request the native side refused, as it reports one (EXT-07). */
    denied: (denied: HostDenial) => live?.denied(denied),
    /** The extensions loaded in the current host process (EXT-05: what still holds code). */
    resident: () => live?.resident() ?? [],
  };
}
