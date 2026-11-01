/**
 * One connection to a debug adapter (IDE-05): DAP messages over a channel that carries whole
 * message bodies. The framing (`Content-Length`, partial reads, several messages per read) is
 * the native side's -- `src-tauri/src/dap.rs` on the shared `lsp_framing` -- so this starts at
 * the JSON: numbering requests, matching each response to its request by `request_seq`,
 * delivering events, answering the adapter's own requests, timing out, cancelling, and ending
 * everything once when the adapter goes away or speaks something that is not DAP.
 */
import { DebugError } from "./errors.ts";
import type { Event, Message, ProtocolMessage, Request, Response } from "./protocol.ts";

/** An adapter process, as the transport hands it over: whole message bodies both ways. */
export interface AdapterChannel {
  /** The program that runs the adapter. */
  program: string;
  send(message: string): void | Promise<void>;
  onMessage(listener: (message: string) => void): () => void;
  /** The process ended; `error` when the session did not end cleanly (a broken stream). */
  onClose(listener: (end: ConnectionEnd) => void): () => void;
  /** Ends the process and everything it started. */
  stop(): Promise<void>;
}

/** Starts adapters by id (the native allow-list) in a folder of the workspace. */
export interface AdapterTransport {
  start(adapter: string, root: string, python: string | null): Promise<AdapterChannel>;
}

/** How a connection ended: cleanly, or not (`error`) -- and if not, whether by bad framing/JSON. */
export interface ConnectionEnd {
  reason: string;
  error: boolean;
  malformed?: boolean;
}

export interface RequestOptions {
  /** How long to wait for the response (default `DEFAULT_TIMEOUT_MS`). */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export const DEFAULT_TIMEOUT_MS = 10_000;

interface Pending {
  command: string;
  resolve(body: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  stopAbort?: () => void;
}

/** A response's failure, as a sentence: the adapter's formatted message when it has one. */
function failureOf(response: Response): string {
  const detail = (response.body as { error?: Message } | undefined)?.error;
  if (detail?.format)
    return detail.format.replace(/\{(\w+)\}/g, (all, name: string) =>
      detail.variables?.[name] !== undefined ? detail.variables[name] : all,
    );
  return response.message || `${response.command} failed.`;
}

export class DapConnection {
  private seq = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly eventListeners = new Set<(event: Event) => void>();
  private readonly closeListeners = new Set<(end: ConnectionEnd) => void>();
  private reverse: (request: Request) => Promise<unknown> = async (request) => {
    throw new Error(`Yavin does not support the "${request.command}" request.`);
  };
  private closed: ConnectionEnd | null = null;
  private readonly stops: (() => void)[] = [];
  /** Whether the adapter takes `cancel` (`supportsCancelRequest`); set after initialize. */
  supportsCancel = false;

  private readonly channel: AdapterChannel;

  constructor(channel: AdapterChannel) {
    this.channel = channel;
    this.stops.push(channel.onMessage((message) => this.receive(message)));
    this.stops.push(channel.onClose((end) => this.end(end)));
  }

  get isClosed(): boolean {
    return this.closed !== null;
  }

  /** Sends `command` and resolves to its response body; rejects with a `DebugError`. */
  request<T = unknown>(command: string, args?: unknown, options: RequestOptions = {}): Promise<T> {
    if (this.closed) return Promise.reject(new DebugError("SessionTerminated", this.closed.reason));
    if (options.signal?.aborted)
      return Promise.reject(new DebugError("Cancelled", `${command} was cancelled.`));
    const seq = this.seq++;
    const message: Request = { seq, type: "request", command, arguments: args };
    return new Promise<T>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const entry: Pending = {
        command,
        resolve: resolve as (body: unknown) => void,
        reject,
        timer: setTimeout(() => {
          this.settle(seq)?.reject(
            new DebugError(
              "Timeout",
              `The debug adapter did not answer "${command}" within ${timeoutMs / 1000} s.`,
            ),
          );
        }, timeoutMs),
      };
      if (options.signal) {
        const onAbort = () => {
          const settled = this.settle(seq);
          if (!settled) return;
          // The adapter is told, when it can be; the caller is answered either way.
          if (this.supportsCancel)
            void this.request("cancel", { requestId: seq }, { timeoutMs: 2_000 }).catch(() => {});
          settled.reject(new DebugError("Cancelled", `${command} was cancelled.`));
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        entry.stopAbort = () => options.signal?.removeEventListener("abort", onAbort);
      }
      this.pending.set(seq, entry);
      Promise.resolve(this.channel.send(JSON.stringify(message))).catch((error: unknown) => {
        this.settle(seq)?.reject(
          new DebugError(
            "SessionTerminated",
            error instanceof Error ? error.message : String(error),
          ),
        );
      });
    });
  }

  /** Every event, in the order the adapter sent them. */
  onEvent(listener: (event: Event) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** Once, when the connection ends: the adapter exited, broke the protocol, or was stopped. */
  onClose(listener: (end: ConnectionEnd) => void): () => void {
    if (this.closed) {
      listener(this.closed);
      return () => {};
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /** Answers the adapter's own requests (`runInTerminal`, `startDebugging`...). */
  onReverseRequest(handler: (request: Request) => Promise<unknown>): void {
    this.reverse = handler;
  }

  /** Ends the adapter's process; the close is reported as not an error. */
  async stop(reason = "The debug session ended."): Promise<void> {
    this.end({ reason, error: false });
    await this.channel.stop().catch(() => {});
  }

  private settle(seq: number): Pending | undefined {
    const entry = this.pending.get(seq);
    if (!entry) return undefined;
    this.pending.delete(seq);
    clearTimeout(entry.timer);
    entry.stopAbort?.();
    return entry;
  }

  private receive(text: string) {
    if (this.closed) return;
    let message: ProtocolMessage;
    try {
      message = JSON.parse(text) as ProtocolMessage;
    } catch {
      this.malformed("a message that is not JSON");
      return;
    }
    if (!message || typeof message !== "object" || typeof message.seq !== "number") {
      this.malformed("a message without a sequence number");
      return;
    }
    switch (message.type) {
      case "response": {
        const response = message as Response;
        const entry = this.settle(response.request_seq);
        // A response to nothing pending: timed out or cancelled already. Not an error.
        if (!entry) return;
        if (response.success) entry.resolve(response.body);
        else
          entry.reject(
            response.message === "cancelled"
              ? new DebugError("Cancelled", `${entry.command} was cancelled.`)
              : new DebugError("RequestFailed", failureOf(response)),
          );
        return;
      }
      case "event":
        for (const listener of [...this.eventListeners]) {
          try {
            listener(message as Event);
          } catch {
            /* One listener's failure is not the connection's. */
          }
        }
        return;
      case "request":
        void this.answer(message as Request);
        return;
      default:
        this.malformed(`a message of type "${String(message.type)}"`);
    }
  }

  private async answer(request: Request) {
    let response: Omit<Response, "seq">;
    try {
      const body = await this.reverse(request);
      response = {
        type: "response",
        request_seq: request.seq,
        success: true,
        command: request.command,
        body,
      };
    } catch (error) {
      response = {
        type: "response",
        request_seq: request.seq,
        success: false,
        command: request.command,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    if (this.closed) return;
    await Promise.resolve(
      this.channel.send(JSON.stringify({ seq: this.seq++, ...response })),
    ).catch(() => {});
  }

  private malformed(what: string) {
    this.end({
      reason: `The debug adapter sent ${what}; the session cannot continue.`,
      error: true,
      malformed: true,
    });
    void this.channel.stop().catch(() => {});
  }

  private end(end: ConnectionEnd) {
    if (this.closed) return;
    this.closed = end;
    for (const stop of this.stops.splice(0)) stop();
    for (const seq of [...this.pending.keys()])
      this.settle(seq)?.reject(new DebugError("SessionTerminated", end.reason));
    for (const listener of [...this.closeListeners]) listener(end);
    this.closeListeners.clear();
    this.eventListeners.clear();
  }
}
