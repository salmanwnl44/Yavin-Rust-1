import assert from "node:assert/strict";
import test from "node:test";
import {
  CancelledError,
  ConnectionClosedError,
  ErrorCodes,
  ResponseError,
  TimeoutError,
  createConnection,
} from "./jsonrpc.ts";
import type { MessageChannel } from "./jsonrpc.ts";

/** Two ends of a pipe, delivering asynchronously as a real one does. */
function pipe() {
  const make = () => {
    const messages = new Set<(message: string) => void>();
    const closes = new Set<(reason: string) => void>();
    return { messages, closes };
  };
  const a = make();
  const b = make();
  const sent: string[] = [];
  const end = (mine: typeof a, theirs: typeof a): MessageChannel => ({
    send(message) {
      sent.push(message);
      queueMicrotask(() => theirs.messages.forEach((listener) => listener(message)));
    },
    onMessage(listener) {
      mine.messages.add(listener);
      return () => mine.messages.delete(listener);
    },
    onClose(listener) {
      mine.closes.add(listener);
      return () => mine.closes.delete(listener);
    },
  });
  return {
    client: end(a, b),
    server: end(b, a),
    sent,
    /** Raw text into the client, as a broken server would send it. */
    inject: (text: string) => a.messages.forEach((listener) => listener(text)),
    closeClient: (reason: string) => a.closes.forEach((listener) => listener(reason)),
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("requests are answered by id, in whatever order the answers come", async () => {
  const wire = pipe();
  const client = createConnection(wire.client);
  const server = createConnection(wire.server);
  server.onRequest("slow", async (params) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { echo: params };
  });
  server.onRequest("fast", (params) => ({ echo: params }));
  const slow = client.sendRequest("slow", 1);
  const fast = client.sendRequest("fast", 2);
  assert.deepEqual(await fast, { echo: 2 });
  assert.deepEqual(await slow, { echo: 1 });
  const ids = wire.sent
    .map((text) => JSON.parse(text))
    .filter((message) => message.method)
    .map((message) => message.id);
  assert.deepEqual(ids, [1, 2]);
  assert.equal(client.pendingCount(), 0);
});

test("notifications both ways, and errors and unknown methods come back as errors", async () => {
  const wire = pipe();
  const client = createConnection(wire.client);
  const server = createConnection(wire.server);
  const heard: unknown[] = [];
  server.onNotification("hello", (params) => heard.push(params));
  client.onNotification("back", (params) => heard.push(params));
  server.onRequest("fail", () => {
    throw new ResponseError(ErrorCodes.InvalidParams, "bad params", { field: "x" });
  });
  server.onRequest("crash", () => {
    throw new Error("boom");
  });
  client.sendNotification("hello", { a: 1 });
  server.sendNotification("back", "hi");
  await tick();
  assert.deepEqual(heard, [{ a: 1 }, "hi"]);
  await assert.rejects(client.sendRequest("fail"), (error: ResponseError) => {
    assert.equal(error.code, ErrorCodes.InvalidParams);
    assert.deepEqual(error.data, { field: "x" });
    return true;
  });
  await assert.rejects(client.sendRequest("crash"), (error: ResponseError) => {
    assert.equal(error.code, ErrorCodes.InternalError);
    return true;
  });
  await assert.rejects(client.sendRequest("nope"), (error: ResponseError) => {
    assert.equal(error.code, ErrorCodes.MethodNotFound);
    return true;
  });
});

test("a cancelled request sends $/cancelRequest, rejects at once, and its late answer is ignored", async () => {
  const wire = pipe();
  const client = createConnection(wire.client);
  const server = createConnection(wire.server);
  let serverSawAbort = false;
  server.onRequest(
    "wait",
    (_params, signal) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          serverSawAbort = true;
          resolve("too late");
        });
      }),
  );
  const controller = new AbortController();
  const request = client.sendRequest("wait", undefined, { signal: controller.signal });
  await tick();
  controller.abort();
  await assert.rejects(request, CancelledError);
  await tick();
  await tick();
  assert.ok(serverSawAbort, "the server was told");
  assert.ok(
    wire.sent.some((text) => text.includes('"$/cancelRequest"') && text.includes('"id":1')),
  );
  // The server answered with RequestCancelled; nothing was waiting for it any more.
  assert.equal(client.pendingCount(), 0);
  // Already aborted: never sent.
  const before = wire.sent.length;
  await assert.rejects(
    client.sendRequest("wait", undefined, { signal: controller.signal }),
    CancelledError,
  );
  assert.equal(wire.sent.length, before);
});

test("a request with no answer times out and is cancelled on the server", async () => {
  const wire = pipe();
  const client = createConnection(wire.client, { timeout: 30 });
  createConnection(wire.server).onRequest("never", () => new Promise(() => {}));
  await assert.rejects(client.sendRequest("never"), TimeoutError);
  assert.ok(wire.sent.some((text) => text.includes("$/cancelRequest")));
  assert.equal(client.pendingCount(), 0);
});

test("malformed messages are reported and dropped; the connection carries on", async () => {
  const wire = pipe();
  const bad: string[] = [];
  const client = createConnection(wire.client, { onMalformed: (_, reason) => bad.push(reason) });
  const server = createConnection(wire.server);
  server.onRequest("ok", () => "fine");
  wire.inject("{not json");
  wire.inject(JSON.stringify({ id: 1, result: 2 })); // no jsonrpc
  wire.inject(JSON.stringify({ jsonrpc: "2.0", id: { x: 1 }, method: "m" }));
  wire.inject(JSON.stringify({ jsonrpc: "2.0", foo: 1 }));
  wire.inject(JSON.stringify({ jsonrpc: "2.0", id: 999, result: "unknown id" })); // ignored silently
  assert.deepEqual(bad, [
    "not JSON",
    "not a JSON-RPC 2.0 message",
    "request id is not a number or string",
    "neither a request nor a response",
  ]);
  assert.equal(await client.sendRequest("ok"), "fine");
});

test("closing rejects everything pending, and nothing can be sent afterwards", async () => {
  const wire = pipe();
  const client = createConnection(wire.client);
  createConnection(wire.server).onRequest("never", () => new Promise(() => {}));
  const waiting = client.sendRequest("never");
  await tick();
  wire.closeClient("The language server exited with code 1");
  await assert.rejects(waiting, ConnectionClosedError);
  assert.ok(client.isClosed());
  await assert.rejects(client.sendRequest("never"), ConnectionClosedError);
});
