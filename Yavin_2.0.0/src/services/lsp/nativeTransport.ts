import { listen } from "@tauri-apps/api/event";
import { native } from "../native";
import type { ServerChannel, ServerTransport } from "./client";

/**
 * Language servers as native processes (`src-tauri/src/lsp.rs`): started by server id, their
 * whole messages arriving as `lsp-message` events, their log as `lsp-log`, their end as
 * `lsp-exit`. The events are broadcast, so each is listened to once and routed by session.
 * A message that arrives before its session's listener is attached (the server can answer
 * before `lsp_start` has returned) is held until it is.
 */

interface Routed<T> {
  listeners: Map<number, Set<(payload: T) => void>>;
  early: Map<number, T[]>;
}

const route = <T extends { session: number }>(): Routed<T> => ({
  listeners: new Map(),
  early: new Map(),
});
const messages = route<{ session: number; message: string }>();
const exits = route<{ session: number; code: number | null; error: string | null }>();
const logs = route<{ session: number; line: string }>();
let listening: Promise<void> | null = null;

function deliver<T extends { session: number }>(routed: Routed<T>, payload: T) {
  const listeners = routed.listeners.get(payload.session);
  if (!listeners?.size) {
    const held = routed.early.get(payload.session) ?? [];
    // Bounded: a session nothing ever attaches to must not hold messages forever.
    if (held.length < 10_000) held.push(payload);
    routed.early.set(payload.session, held);
    return;
  }
  for (const listener of [...listeners]) listener(payload);
}

function attach<T extends { session: number }>(
  routed: Routed<T>,
  session: number,
  listener: (payload: T) => void,
) {
  const set = routed.listeners.get(session) ?? new Set();
  set.add(listener);
  routed.listeners.set(session, set);
  const held = routed.early.get(session);
  if (held) {
    routed.early.delete(session);
    for (const payload of held) listener(payload);
  }
  return () => {
    set.delete(listener);
    if (!set.size) routed.listeners.delete(session);
  };
}

function ensureListening(): Promise<void> {
  listening ??= Promise.all([
    listen<{ session: number; message: string }>("lsp-message", (event) =>
      deliver(messages, event.payload),
    ),
    listen<{ session: number; code: number | null; error: string | null }>("lsp-exit", (event) =>
      deliver(exits, event.payload),
    ),
    listen<{ session: number; line: string }>("lsp-log", (event) => deliver(logs, event.payload)),
  ]).then(() => undefined);
  return listening;
}

export function createNativeTransport(
  onLog?: (serverId: string, line: string) => void,
): ServerTransport {
  return {
    async start(serverId, root) {
      await ensureListening();
      const { session, program } = await native("lsp_start", { server: serverId, root });
      const stopLog = attach(logs, session, (payload) => onLog?.(serverId, payload.line));
      let ended = false;
      const channel: ServerChannel = {
        program,
        send: (message) => native("lsp_send", { session, message }),
        onMessage: (listener) => attach(messages, session, (payload) => listener(payload.message)),
        onClose: (listener) =>
          attach(exits, session, (payload) => {
            ended = true;
            stopLog();
            listener(
              payload.error ??
                (payload.code === null
                  ? "The language server was stopped."
                  : `The language server exited with code ${payload.code}.`),
            );
          }),
        stop: async () => {
          if (!ended) await native("lsp_stop", { session });
        },
      };
      return channel;
    },
  };
}

/** The servers this folder can use: whether it is trusted, and which are installed. */
export async function nativeAvailability() {
  const { trusted, servers } = await native("lsp_servers", {});
  return {
    trusted,
    installed: new Set(servers.filter((server) => server.program).map((server) => server.id)),
  };
}
