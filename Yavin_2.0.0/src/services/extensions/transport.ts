/**
 * How Yavin reaches an extension host process (IDE-08): through the native side
 * (`src-tauri/src/extension_host.rs`), which starts it -- trust-gated -- and passes protocol
 * messages, filling in a `load`'s code itself. Messages arrive as `ext-host-message` events and
 * the end as `ext-host-exit`, routed by session number (never reused). Extension code never sees
 * this: it is Yavin's side of the boundary. The native side also checks every request an
 * extension makes (EXT-07): one it refuses never arrives as a message, only as
 * `ext-host-denied`, saying which extension, method and capability.
 */
import { listen } from "@tauri-apps/api/event";
import { native } from "../native.ts";

export interface HostChannel {
  send(text: string): Promise<void>;
  onMessage(listener: (text: string) => void): () => void;
  /** The process ended; `crashed` when Yavin did not stop it. */
  onExit(listener: (end: { reason: string; crashed: boolean }) => void): () => void;
  /** A line the process wrote to its stderr (bounded natively; EXT-05). */
  onLog?(listener: (line: string) => void): () => void;
  /** A request of an extension the native side refused (EXT-07); the extension was answered. */
  onDenied?(listener: (denied: HostDenial) => void): () => void;
  stop(): Promise<void>;
}

/** A refused request (EXT-07): never what it carried. */
export interface HostDenial {
  extensionId: string;
  method: string;
  capability: string | null;
  code: string;
  message: string;
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
  logs: new Map<number, (line: string) => void>(),
  denials: new Map<number, (denied: HostDenial) => void>(),
};
type Item =
  | { kind: "message"; message: string }
  | { kind: "exit"; code: number | null; error: string | null }
  | { kind: "log"; line: string }
  | { kind: "denied"; denied: HostDenial };
const early = new Map<number, Item[]>();
let listening: Promise<void> | null = null;

function deliver(session: number, item: Item) {
  if (item.kind === "denied") {
    const route = routes.denials.get(session);
    if (route) return route(item.denied);
  } else if (item.kind === "log") {
    const route = routes.logs.get(session);
    if (route) return route(item.line);
  } else if (item.kind === "message") {
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
    listen<Payload & { line: string }>("ext-host-log", (event) =>
      deliver(event.payload.session, { kind: "log", line: event.payload.line }),
    ),
    listen<Payload & HostDenial>("ext-host-denied", (event) => {
      const { session, ...denied } = event.payload;
      deliver(session, { kind: "denied", denied });
    }),
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
      const logListeners = new Set<(line: string) => void>();
      const deniedListeners = new Set<(denied: HostDenial) => void>();
      routes.logs.set(session, (line) => {
        for (const listener of logListeners) listener(line);
      });
      routes.denials.set(session, (denied) => {
        for (const listener of deniedListeners) listener(denied);
      });
      routes.messages.set(session, (payload) => {
        for (const listener of messageListeners) listener(payload.message);
      });
      routes.exits.set(session, (payload) => {
        ended = true;
        routes.messages.delete(session);
        routes.exits.delete(session);
        routes.logs.delete(session);
        routes.denials.delete(session);
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
        onLog(listener) {
          logListeners.add(listener);
          return () => logListeners.delete(listener);
        },
        onDenied(listener) {
          deniedListeners.add(listener);
          return () => deniedListeners.delete(listener);
        },
        async stop() {
          stopping = true;
          if (!ended) await native("ext_host_stop", { session }).catch(() => undefined);
        },
      };
    },
  };
}
