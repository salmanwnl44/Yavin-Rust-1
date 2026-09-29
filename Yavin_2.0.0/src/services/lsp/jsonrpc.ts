/**
 * JSON-RPC 2.0 over whole messages: requests with ids, responses, notifications, errors,
 * cancellation and timeouts, in both directions (a language server sends requests too).
 *
 * The framing (`Content-Length`) is the transport's: the native side reassembles a server's
 * output into whole message bodies (`lsp_framing.rs`), and a test's fake server hands them over
 * directly. This knows nothing about any particular server, or about LSP beyond `$/cancelRequest`.
 */

/** One side of a connection that carries whole message bodies. */
export interface MessageChannel {
  send(message: string): void | Promise<void>;
  /** Every message from the other side, in order. Returns a way to stop listening. */
  onMessage(listener: (message: string) => void): () => void;
  /** The other side went away (a process exit). */
  onClose(listener: (reason: string) => void): () => void;
}

export const ErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  ServerNotInitialized: -32002,
  RequestFailed: -32803,
  ServerCancelled: -32802,
  ContentModified: -32801,
  RequestCancelled: -32800,
} as const;

export class ResponseError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "ResponseError";
    this.code = code;
    this.data = data;
  }
}

/** The request was cancelled -- by the caller, or because the connection closed. */
export class CancelledError extends Error {
  constructor(message = "Cancelled") {
    super(message);
    this.name = "CancelledError";
  }
}

export class TimeoutError extends Error {
  constructor(method: string, ms: number) {
    super(`${method} did not answer within ${ms} ms`);
    this.name = "TimeoutError";
  }
}

export class ConnectionClosedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ConnectionClosedError";
  }
}

type Id = number | string;

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

export interface RequestOptions {
  /** Abandons the request: `$/cancelRequest` is sent and the promise rejects `CancelledError`. */
  signal?: AbortSignal;
  /** Milliseconds before the request is cancelled as timed out; 0 for none. */
  timeout?: number;
}

export interface ConnectionOptions {
  /** The default request timeout. */
  timeout?: number;
  /** A message that is not JSON-RPC: it is dropped, and reported here. */
  onMalformed?: (message: string, reason: string) => void;
}

export type RequestHandler = (params: unknown, signal: AbortSignal) => unknown;
export type NotificationHandler = (params: unknown) => void;

export type Connection = ReturnType<typeof createConnection>;

export function createConnection(channel: MessageChannel, options: ConnectionOptions = {}) {
  let nextId = 1;
  let closed: string | null = null;
  const pending = new Map<Id, Pending>();
  const requestHandlers = new Map<string, RequestHandler>();
  const notificationHandlers = new Map<string, NotificationHandler>();
  /** Requests from the other side still being answered, so they can be cancelled. */
  const incoming = new Map<Id, AbortController>();
  let unhandledNotification: ((method: string, params: unknown) => void) | undefined;

  const write = (message: object) => {
    if (closed) return;
    try {
      void Promise.resolve(channel.send(JSON.stringify(message))).catch((error: unknown) =>
        close(`Could not send to the server: ${String(error)}`),
      );
    } catch (error) {
      close(`Could not send to the server: ${String(error)}`);
    }
  };

  const malformed = (message: string, reason: string) => options.onMalformed?.(message, reason);

  const respond = (id: Id, result: unknown) => write({ jsonrpc: "2.0", id, result });
  const respondError = (id: Id | null, code: number, message: string, data?: unknown) =>
    write({
      jsonrpc: "2.0",
      id,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    });

  const handleRequest = (id: Id, method: string, params: unknown) => {
    const handler = requestHandlers.get(method);
    if (!handler) {
      respondError(id, ErrorCodes.MethodNotFound, `Unhandled method ${method}`);
      return;
    }
    const controller = new AbortController();
    incoming.set(id, controller);
    Promise.resolve()
      .then(() => handler(params, controller.signal))
      .then(
        (result) => {
          if (controller.signal.aborted)
            respondError(id, ErrorCodes.RequestCancelled, "Request cancelled");
          else respond(id, result ?? null);
        },
        (error: unknown) => {
          if (error instanceof ResponseError)
            respondError(id, error.code, error.message, error.data);
          else respondError(id, ErrorCodes.InternalError, String(error));
        },
      )
      .finally(() => incoming.delete(id));
  };

  const receive = (text: string) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(text);
    } catch {
      malformed(text, "not JSON");
      return;
    }
    if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") {
      malformed(text, "not a JSON-RPC 2.0 message");
      return;
    }
    const { id, method } = message;
    const validId = typeof id === "number" || typeof id === "string";
    if (typeof method === "string") {
      if (validId) handleRequest(id, method, message.params);
      else if (id === undefined) {
        if (method === "$/cancelRequest") {
          const target = (message.params as { id?: Id } | undefined)?.id;
          if (target !== undefined) incoming.get(target)?.abort();
          return;
        }
        const handler = notificationHandlers.get(method);
        if (handler) {
          try {
            handler(message.params);
          } catch (error) {
            malformed(text, `handler failed: ${String(error)}`);
          }
        } else unhandledNotification?.(method, message.params);
      } else malformed(text, "request id is not a number or string");
      return;
    }
    if (!validId) {
      // An error response to a request the server could not even parse has a null id.
      if (id === null && message.error) malformed(text, "error response without an id");
      else malformed(text, "neither a request nor a response");
      return;
    }
    const waiting = pending.get(id);
    // A response to something already given up on (cancelled, timed out): nothing waits for it.
    if (!waiting) return;
    pending.delete(id);
    waiting.cleanup();
    if (message.error && typeof message.error === "object") {
      const error = message.error as { code?: unknown; message?: unknown; data?: unknown };
      const code = typeof error.code === "number" ? error.code : ErrorCodes.InternalError;
      waiting.reject(
        code === ErrorCodes.RequestCancelled
          ? new CancelledError(String(error.message ?? "Cancelled"))
          : new ResponseError(code, String(error.message ?? "Request failed"), error.data),
      );
    } else if ("result" in message) waiting.resolve(message.result);
    else {
      malformed(text, "response has neither a result nor an error");
      waiting.reject(new ResponseError(ErrorCodes.InternalError, "Malformed response"));
    }
  };

  const close = (reason: string) => {
    if (closed) return;
    closed = reason;
    for (const waiting of pending.values()) {
      waiting.cleanup();
      waiting.reject(new ConnectionClosedError(reason));
    }
    pending.clear();
    for (const controller of incoming.values()) controller.abort();
    incoming.clear();
    stopMessages();
    stopClose();
  };

  const stopMessages = channel.onMessage(receive);
  const stopClose = channel.onClose((reason) => close(reason));

  return {
    /** Sends a request; resolves with its result, rejects with its error. */
    sendRequest<T = unknown>(method: string, params?: unknown, request: RequestOptions = {}) {
      if (closed) return Promise.reject<T>(new ConnectionClosedError(closed));
      if (request.signal?.aborted) return Promise.reject<T>(new CancelledError());
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        const timeout = request.timeout ?? options.timeout ?? 0;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cancel = (error: Error) => {
          if (!pending.has(id)) return;
          pending.delete(id);
          cleanup();
          write({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } });
          reject(error);
        };
        const onAbort = () => cancel(new CancelledError());
        const cleanup = () => {
          if (timer) clearTimeout(timer);
          request.signal?.removeEventListener("abort", onAbort);
        };
        pending.set(id, {
          method,
          resolve: resolve as (value: unknown) => void,
          reject,
          cleanup,
        });
        request.signal?.addEventListener("abort", onAbort, { once: true });
        if (timeout > 0)
          timer = setTimeout(() => cancel(new TimeoutError(method, timeout)), timeout);
        write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
      });
    },
    sendNotification(method: string, params?: unknown) {
      write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
    },
    /** Answers the other side's requests for `method`. A handler may be async. */
    onRequest(method: string, handler: RequestHandler) {
      requestHandlers.set(method, handler);
    },
    onNotification(method: string, handler: NotificationHandler) {
      notificationHandlers.set(method, handler);
    },
    onUnhandledNotification(handler: (method: string, params: unknown) => void) {
      unhandledNotification = handler;
    },
    /** Requests still waiting for an answer. */
    pendingCount: () => pending.size,
    isClosed: () => closed !== null,
    /** Ends the connection: every pending request rejects with `ConnectionClosedError`. */
    close,
  };
}
