import { listen } from "@tauri-apps/api/event";
import { native } from "../native.ts";
import type { AdapterChannel, AdapterTransport } from "./connection.ts";

/**
 * Debug adapters as native processes (`src-tauri/src/dap.rs`): started by adapter id, their
 * whole DAP messages arriving as `dap-message` events and their end as `dap-exit`, routed by
 * session number -- numbers are never reused, so an event of an adapter that has ended can
 * never reach its successor. A message that arrives before its listener is attached (an
 * adapter can speak before `dap_start` returns) is held until it is.
 */

type Payload = { session: number };
interface Routed<T extends Payload> {
  listeners: Map<number, (payload: T) => void>;
  early: Map<number, T[]>;
}
const route = <T extends Payload>(): Routed<T> => ({ listeners: new Map(), early: new Map() });
const messages = route<{ session: number; message: string }>();
const exits = route<{ session: number; code: number | null; error: string | null }>();

function deliver<T extends Payload>(routed: Routed<T>, payload: T) {
  const listener = routed.listeners.get(payload.session);
  if (listener) {
    listener(payload);
    return;
  }
  const held = routed.early.get(payload.session) ?? [];
  if (held.length < 10_000) held.push(payload);
  routed.early.set(payload.session, held);
}

function attach<T extends Payload>(routed: Routed<T>, session: number, listener: (p: T) => void) {
  routed.listeners.set(session, listener);
  const held = routed.early.get(session);
  if (held) {
    routed.early.delete(session);
    for (const payload of held) listener(payload);
  }
  return () => {
    if (routed.listeners.get(session) === listener) routed.listeners.delete(session);
    routed.early.delete(session);
  };
}

let listening: Promise<void> | null = null;
const ensureListening = () =>
  (listening ??= Promise.all([
    listen<{ session: number; message: string }>("dap-message", (event) =>
      deliver(messages, event.payload),
    ),
    listen<{ session: number; code: number | null; error: string | null }>("dap-exit", (event) =>
      deliver(exits, event.payload),
    ),
  ]).then(() => undefined));

/**
 * Ends every adapter an earlier page left running, once, before this page starts its first:
 * a reload replaces the page without it getting to end its sessions.
 */
let leftoversStopped: Promise<void> | null = null;
const stopLeftovers = () =>
  (leftoversStopped ??= native("dap_stop_all", {}).then(
    () => undefined,
    () => undefined,
  ));

export function createNativeAdapterTransport(): AdapterTransport {
  return {
    async start(adapter, root, python) {
      await Promise.all([ensureListening(), stopLeftovers()]);
      const { session, program } = await native("dap_start", { adapter, root, python });
      let ended = false;
      const detach: (() => void)[] = [];
      const channel: AdapterChannel = {
        program,
        send: (message) => native("dap_send", { session, message }),
        onMessage(listener) {
          const stop = attach(messages, session, (payload) => listener(payload.message));
          detach.push(stop);
          return stop;
        },
        onClose(listener) {
          const stop = attach(exits, session, (payload) => {
            ended = true;
            for (const one of detach.splice(0)) one();
            listener({
              reason:
                payload.error ??
                (payload.code === null
                  ? "The debug adapter was stopped."
                  : `The debug adapter exited with code ${payload.code}.`),
              error: payload.error !== null,
              malformed: payload.error !== null && /header|too large|UTF-8/i.test(payload.error),
            });
          });
          detach.push(stop);
          return stop;
        },
        async stop() {
          if (!ended) await native("dap_stop", { session });
        },
      };
      return channel;
    },
  };
}
