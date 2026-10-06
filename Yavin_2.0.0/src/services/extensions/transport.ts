/**
 * How Yavin reaches an extension host process (IDE-08): through the native side
 * (`src-tauri/src/extension_host.rs`), which starts it -- trust-gated -- and passes protocol
 * messages, filling in a `load`'s code itself. Messages arrive as `ext-host-message` events and
 * the end as `ext-host-exit`, routed by session number (never reused). Extension code never sees
 * this: it is Yavin's side of the boundary.
 */
import { listen } from "@tauri-apps/api/event";
import { native } from "../native.ts";

export interface HostChannel {
  send(text: string): Promise<void>;
  onMessage(listener: (text: string) => void): () => void;
  /** The process ended; `crashed` when Yavin did not stop it. */
  onExit(listener: (end: { reason: string; crashed: boolean }) => void): () => void;
  stop(): Promise<void>;
}

export interface HostTransport {
  start(): Promise<HostChannel>;
}

type Payload = { session: number };
const routes = {
  messages: new Map<number, (payload: { session: number; message: string }) => void>(),
  exits: new Map<
    number,
    (payload: { session: number; code: number | null; error: string | null }) => void
  >(),
};
const early = new Map<
  number,
  (
    | { kind: "message"; message: string }
    | { kind: "exit"; code: number | null; error: string | null }
  )[]
>();
let listening: Promise<void> | null = null;

function deliver(
  session: number,
  item:
    | { kind: "message"; message: string }
    | { kind: "exit"; code: number | null; error: string | null },
) {
  if (item.kind === "message") {
    const route = routes.messages.get(session);
    if (route) return route({ session, message: item.message });
  } else {
    const route = routes.exits.get(session);
    if (route) return route({ session, code: item.code, error: item.error });
  }
  const held = early.get(session) ?? [];
  if (held.length < 1000) held.push(item);
  early.set(session, held);
}

const ensureListening = () =>
  (listening ??= Promise.all([
    listen<Payload & { message: string }>("ext-host-message", (event) =>
      deliver(event.payload.session, { kind: "message", message: event.payload.message }),
    ),
    listen<Payload & { code: number | null; error: string | null }>("ext-host-exit", (event) =>
      deliver(event.payload.session, {
        kind: "exit",
        code: event.payload.code,
        error: event.payload.error,
      }),
    ),
  ]).then(() => undefined));

/** Hosts an earlier page left running are ended, once, before this page starts its first. */
let leftoversStopped: Promise<void> | null = null;
const stopLeftovers = () =>
  (leftoversStopped ??= native("ext_host_stop_all", {}).then(
    () => undefined,
    () => undefined,
  ));

export function createNativeHostTransport(): HostTransport {
  return {
    async start() {
      await Promise.all([ensureListening(), stopLeftovers()]);
      const session = await native("ext_host_start", {});
      let stopping = false;
      let ended = false;
      const messageListeners = new Set<(text: string) => void>();
      const exitListeners = new Set<(end: { reason: string; crashed: boolean }) => void>();
      routes.messages.set(session, (payload) => {
        for (const listener of messageListeners) listener(payload.message);
      });
      routes.exits.set(session, (payload) => {
        ended = true;
        routes.messages.delete(session);
        routes.exits.delete(session);
        const reason =
          payload.error ??
          (payload.code === 0
            ? "The extension host ended."
            : `The extension host exited with code ${payload.code}.`);
        for (const listener of exitListeners) listener({ reason, crashed: !stopping });
      });
      for (const item of early.get(session)?.splice(0) ?? []) deliver(session, item);
      return {
        send: (message) => native("ext_host_send", { session, message }),
        onMessage(listener) {
          messageListeners.add(listener);
          return () => messageListeners.delete(listener);
        },
        onExit(listener) {
          exitListeners.add(listener);
          return () => exitListeners.delete(listener);
        },
        async stop() {
          stopping = true;
          if (!ended) await native("ext_host_stop", { session }).catch(() => undefined);
        },
      };
    },
  };
}
