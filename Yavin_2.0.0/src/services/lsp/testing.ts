import { NOT_INSTALLED } from "./client.ts";
import type { ServerChannel, ServerTransport } from "./client.ts";
import { createFakeServer } from "./fakeServer.ts";
import type { FakeServer, FakeServerOptions } from "./fakeServer.ts";

/**
 * A transport whose servers are in-memory fakes: what the unit tests start instead of processes.
 * Messages cross asynchronously, as they do over a pipe.
 */
export function createFakeTransport(
  init: {
    /** Server ids that are "installed"; the rest fail as not installed. */
    installed?: string[];
    /** Options for each new server, by server id (read at start, so a test can change them). */
    options?: Record<string, FakeServerOptions>;
    /** A start that fails outright, as a missing permission would. */
    failStart?: string;
  } = {},
) {
  const started: { serverId: string; root: string; server: FakeServer }[] = [];
  const transport: ServerTransport = {
    async start(serverId, root) {
      if (init.failStart === serverId)
        throw new Error(`${serverId} could not be run: permission denied.`);
      if (init.installed && !init.installed.includes(serverId))
        throw new Error(`${NOT_INSTALLED} The ${serverId} language server is not installed.`);
      const messages = new Set<(message: string) => void>();
      const closes = new Set<(reason: string) => void>();
      let ended = false;
      const end = (reason: string) => {
        if (ended) return;
        ended = true;
        queueMicrotask(() => closes.forEach((listener) => listener(reason)));
      };
      const server = createFakeServer(init.options?.[serverId] ?? {}, {
        send: (message) =>
          queueMicrotask(() => !ended && messages.forEach((listener) => listener(message))),
        exit: (code) => end(`The language server exited with code ${code}`),
      });
      started.push({ serverId, root, server });
      const channel: ServerChannel = {
        program: `fake-${serverId}`,
        send(message) {
          if (ended) throw new Error("The language server has stopped.");
          queueMicrotask(() => server.receive(message));
        },
        onMessage(listener) {
          messages.add(listener);
          return () => messages.delete(listener);
        },
        onClose(listener) {
          closes.add(listener);
          return () => closes.delete(listener);
        },
        stop() {
          end("stopped");
        },
      };
      return channel;
    },
  };
  return {
    transport,
    started,
    /** The most recently started server for `serverId`. */
    server(serverId: string): FakeServer {
      const found = [...started].reverse().find((one) => one.serverId === serverId);
      if (!found) throw new Error(`No ${serverId} server was started`);
      return found.server;
    },
  };
}

/** Resolves once `check` holds, polling; rejects after `ms`. */
export async function until(check: () => boolean, ms = 2000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error("Timed out waiting for a condition");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
