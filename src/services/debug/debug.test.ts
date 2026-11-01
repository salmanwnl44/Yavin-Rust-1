import assert from "node:assert/strict";
import test from "node:test";
import { fileUri, resourceId } from "../resource.ts";
import { createSettingsRegistry } from "../settings/settings.ts";
import type { WorkspaceId } from "../terminalProtocol.ts";
import { createBreakpointRegistry, createBreakpoints } from "./breakpoints.ts";
import { DEBUG_CONFIGURATIONS, DEBUG_SETTING_LIST, readConfigurations } from "./config.ts";
import { DapConnection, type AdapterChannel, type ConnectionEnd } from "./connection.ts";
import { DebugError, nativeDebugError } from "./errors.ts";
import { FakeAdapter, type FakeAdapterOptions } from "./fakeAdapter.ts";
import {
  canMove,
  createDebugService,
  isFinal,
  type DebugService,
  type DebugState,
} from "./service.ts";

const A = "file://c:/work" as WorkspaceId;
const B = "file://c:/other" as WorkspaceId;
const MAIN = "C:\\work\\main.py";
const settle = async (times = 5) => {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
/** Until `check` holds (the fake answers in microtasks, the service in promise chains). */
async function until(check: () => boolean, what = "condition") {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail(`timed out waiting for ${what}`);
}

// --- The connection: DAP messages over a channel of whole bodies -----------------------------

function manualChannel() {
  const sent: Record<string, unknown>[] = [];
  let deliver: (message: string) => void = () => {};
  let close: (end: ConnectionEnd) => void = () => {};
  let stopped = 0;
  const channel: AdapterChannel = {
    program: "manual",
    send: (message) => void sent.push(JSON.parse(message) as Record<string, unknown>),
    onMessage: (listener) => ((deliver = listener), () => {}),
    onClose: (listener) => ((close = listener), () => {}),
    stop: async () => void stopped++,
  };
  return {
    channel,
    sent,
    deliver: (message: unknown) =>
      deliver(typeof message === "string" ? message : JSON.stringify(message)),
    close: (end: ConnectionEnd) => close(end),
    stopped: () => stopped,
  };
}

test("responses are matched to their requests by request_seq, in any order", async () => {
  const m = manualChannel();
  const connection = new DapConnection(m.channel);
  const first = connection.request<{ a: number }>("threads");
  const second = connection.request<{ b: number }>("scopes", { frameId: 1 });
  assert.deepEqual(
    m.sent.map((message) => [message.seq, message.type, message.command]),
    [
      [1, "request", "threads"],
      [2, "request", "scopes"],
    ],
  );
  m.deliver({
    seq: 1,
    type: "response",
    request_seq: 2,
    success: true,
    command: "scopes",
    body: { b: 2 },
  });
  m.deliver({
    seq: 2,
    type: "response",
    request_seq: 1,
    success: true,
    command: "threads",
    body: { a: 1 },
  });
  assert.deepEqual(await first, { a: 1 });
  assert.deepEqual(await second, { b: 2 });
  // An answer to nothing pending (late, or cancelled) is ignored.
  m.deliver({ seq: 3, type: "response", request_seq: 99, success: true, command: "x" });
  assert.equal(connection.isClosed, false);
});

test("a failed response is a typed error with the adapter's formatted message", async () => {
  const m = manualChannel();
  const connection = new DapConnection(m.channel);
  const asked = connection.request("evaluate", { expression: "x" });
  m.deliver({
    seq: 1,
    type: "response",
    request_seq: 1,
    success: false,
    command: "evaluate",
    message: "evaluate failed",
    body: { error: { id: 7, format: "name '{name}' is not defined", variables: { name: "x" } } },
  });
  await assert.rejects(asked, (error: DebugError) => {
    assert.equal(error.code, "RequestFailed");
    assert.equal(error.message, "name 'x' is not defined");
    return true;
  });
});

test("events reach listeners in order; the adapter's own requests are answered", async () => {
  const m = manualChannel();
  const connection = new DapConnection(m.channel);
  const seen: string[] = [];
  connection.onEvent((event) => seen.push(event.event));
  m.deliver({ seq: 1, type: "event", event: "initialized" });
  m.deliver({ seq: 2, type: "event", event: "output", body: { output: "x" } });
  assert.deepEqual(seen, ["initialized", "output"]);
  // Yavin offers no runInTerminal: the adapter is told so, rather than left waiting.
  m.deliver({ seq: 3, type: "request", command: "runInTerminal", arguments: {} });
  await settle();
  const answer = m.sent.at(-1)!;
  assert.equal(answer.type, "response");
  assert.equal(answer.request_seq, 3);
  assert.equal(answer.success, false);
});

test("a malformed message ends the connection: pending requests fail, the adapter is stopped", async () => {
  for (const bad of [
    "{not json",
    JSON.stringify({ type: "response" }),
    JSON.stringify({ seq: 1, type: "nonsense" }),
  ]) {
    const m = manualChannel();
    const connection = new DapConnection(m.channel);
    const ends: ConnectionEnd[] = [];
    connection.onClose((end) => ends.push(end));
    const pending = connection.request("threads");
    m.deliver(bad);
    await assert.rejects(pending, (error: DebugError) => error.code === "SessionTerminated");
    assert.equal(ends.length, 1);
    assert.equal(ends[0].malformed, true);
    assert.equal(m.stopped(), 1);
    await assert.rejects(
      connection.request("threads"),
      (error: DebugError) => error.code === "SessionTerminated",
    );
  }
});

test("the adapter's exit (EOF or a crash) fails what is pending, once", async () => {
  const m = manualChannel();
  const connection = new DapConnection(m.channel);
  const ends: ConnectionEnd[] = [];
  connection.onClose((end) => ends.push(end));
  const pending = connection.request("stackTrace", { threadId: 1 });
  m.close({ reason: "The debug adapter exited with code 3.", error: true });
  m.close({ reason: "again", error: true });
  await assert.rejects(pending, (error: DebugError) => {
    assert.equal(error.code, "SessionTerminated");
    assert.match(error.message, /code 3/);
    return true;
  });
  assert.equal(ends.length, 1);
  // A listener attached afterwards still hears how it ended.
  connection.onClose((end) => ends.push(end));
  assert.equal(ends.length, 2);
});

test("a request times out, and a cancelled one tells an adapter that supports cancel", async () => {
  const m = manualChannel();
  const connection = new DapConnection(m.channel);
  await assert.rejects(
    connection.request("threads", undefined, { timeoutMs: 5 }),
    (error: DebugError) => error.code === "Timeout",
  );

  connection.supportsCancel = true;
  const abort = new AbortController();
  const asked = connection.request(
    "variables",
    { variablesReference: 4 },
    { signal: abort.signal },
  );
  abort.abort();
  await assert.rejects(asked, (error: DebugError) => error.code === "Cancelled");
  const cancel = m.sent.find((message) => message.command === "cancel");
  assert.deepEqual(cancel?.arguments, {
    requestId: m.sent.find((x) => x.command === "variables")!.seq,
  });
});

test("native errors keep their code; anything else takes the fallback", () => {
  assert.equal(
    nativeDebugError("AdapterUnavailable: no python", "AdapterFailedToStart").code,
    "AdapterUnavailable",
  );
  assert.equal(nativeDebugError("TrustDenied: no", "AdapterFailedToStart").code, "TrustDenied");
  assert.equal(
    nativeDebugError("spawn failed", "AdapterFailedToStart").code,
    "AdapterFailedToStart",
  );
});

// --- Configurations ---------------------------------------------------------------------------

test("debug configurations are validated, with the reason for an invalid one", () => {
  const ok = readConfigurations([
    { id: "main", adapter: "debugpy", program: "main.py" },
    { id: "server", name: "Attach", adapter: "debugpy", request: "attach", port: 5678 },
  ]);
  assert.ok(Array.isArray(ok));
  assert.equal(ok[0].name, "main");
  assert.equal(ok[0].request, "launch");
  assert.deepEqual(ok[0].args, []);
  for (const [value, reason] of [
    [{}, /must be a list/],
    [[{ id: "a b", adapter: "debugpy", program: "x" }], /"id"/],
    [[{ id: "a", adapter: "gdb", program: "x" }], /"adapter"/],
    [[{ id: "a", adapter: "debugpy" }], /needs a "program"/],
    [[{ id: "a", adapter: "debugpy", request: "attach" }], /"port"/],
    [[{ id: "a", adapter: "debugpy", program: "x", env: { "A B": "1" } }], /"env"/],
    [[{ id: "a", adapter: "debugpy", program: "x", host: "10.0.0.1" }], /"host"/],
    [
      [
        { id: "a", adapter: "debugpy", program: "x" },
        { id: "a", adapter: "debugpy", program: "y" },
      ],
      /Two/,
    ],
  ] as const)
    assert.match(String(readConfigurations(value)), reason);
});

// --- Breakpoints -------------------------------------------------------------------------------

test("breakpoints are kept by canonical resource: one file however it is spelled", () => {
  const set = createBreakpoints(A);
  const added = set.add(fileUri("C:\\work\\main.py"), 3);
  // The same line of the same file, spelled differently: the same breakpoint.
  assert.equal(set.add(fileUri("c:/WORK/main.py"), 3).id, added.id);
  assert.equal(added.resource, resourceId(fileUri("c:/work/main.py")));
  assert.equal(set.toggle(fileUri("C:/work/main.py"), 5), "added");
  assert.deepEqual(
    set.forResource(added.resource).map((bp) => bp.line),
    [3, 5],
  );
  assert.equal(set.toggle(fileUri("C:/work/main.py"), 5), "removed");

  set.setEnabled(added.id, false);
  assert.equal(set.getSnapshot()[0].enabled, false);
  set.verify(added.id, { verified: true, adapterId: 7 });
  assert.equal(set.byAdapterId(7)?.id, added.id);
  set.forgetVerification();
  assert.equal(set.getSnapshot()[0].verified, null);
  set.clear();
  assert.equal(set.getSnapshot().length, 0);
  assert.throws(() => set.add(fileUri("C:/work/main.py"), 0), RangeError);
});

test("each workspace has its own breakpoints, kept across switches", () => {
  const registry = createBreakpointRegistry();
  registry.forWorkspace(A).add(fileUri(MAIN), 2);
  assert.equal(registry.forWorkspace(B).getSnapshot().length, 0);
  assert.equal(registry.forWorkspace(A).getSnapshot().length, 1);
  assert.equal(registry.forWorkspace(A), registry.forWorkspace(A));
});

// --- The service ------------------------------------------------------------------------------

function setup(
  fake: FakeAdapterOptions & {
    configs?: unknown[];
    trusted?: boolean;
    workspace?: WorkspaceId | null;
  } = {},
) {
  const settings = createSettingsRegistry([...DEBUG_SETTING_LIST], null);
  const workspace = fake.workspace === undefined ? A : fake.workspace;
  if (workspace)
    settings.set(
      DEBUG_CONFIGURATIONS,
      "workspace",
      fake.configs ?? [{ id: "main", name: "Main", adapter: "debugpy", program: "main.py" }],
      workspace,
    );
  const adapter = new FakeAdapter(fake);
  const breakpoints = workspace ? createBreakpoints(workspace) : null;
  let trusted = fake.trusted ?? true;
  const tasks: string[] = [];
  let taskResult = { state: "succeeded", error: null as string | null };
  const states: DebugState[] = [];
  const service = createDebugService({
    workspace,
    folders: workspace ? ["C:/work"] : [],
    settings,
    breakpoints,
    transport: adapter,
    trusted: async () => trusted,
    runTask: async (id) => {
      tasks.push(id);
      return taskResult;
    },
    stopTimeoutMs: 50,
  });
  service.subscribe(() => {
    const state = service.getSnapshot().session?.state;
    if (state && states.at(-1) !== state) states.push(state);
  });
  return {
    adapter,
    service,
    breakpoints: breakpoints!,
    settings,
    states,
    tasks,
    setTrusted: (value: boolean) => (trusted = value),
    setTask: (state: string, error: string | null = null) => (taskResult = { state, error }),
    snap: () => service.getSnapshot(),
  };
}

const stoppedAt = (service: DebugService) => service.getSnapshot().frames[0]?.line;
/** Stopped, with the stack, the selected frame's scopes and its locals fetched. */
const settledStop = (t: ReturnType<typeof setup>) => {
  const s = t.snap();
  return (
    s.session?.state === "stopped" &&
    s.scopes.length > 0 &&
    s.variables.has(s.scopes[0].variablesReference)
  );
};

test("the DAP lifecycle: initialize, initialized, launch, breakpoints, configurationDone, run, stop, step, end", async () => {
  const t = setup();
  t.breakpoints.add(fileUri(MAIN), 4);
  await t.service.start("main");
  assert.deepEqual(t.adapter.starts, [{ adapter: "debugpy", root: "C:/work", python: null }]);
  // The protocol's order, with debugpy's launch answered after configurationDone.
  assert.deepEqual(t.adapter.sent.map((request) => request.command).slice(0, 5), [
    "initialize",
    "launch",
    "setBreakpoints",
    "setExceptionBreakpoints",
    "configurationDone",
  ]);
  const launch = t.adapter.requests("launch")[0].arguments as Record<string, unknown>;
  assert.match(String(launch.program), /^c:[\\/]work[\\/]main\.py$/i);
  assert.equal(launch.console, "internalConsole");
  assert.equal(t.breakpoints.getSnapshot()[0].verified, true);

  // It stops at the breakpoint: the thread, its stack, the frame shown, its scopes, its locals.
  await until(() => settledStop(t), "the stop");
  let s = t.snap();
  assert.equal(s.session?.stoppedReason, "breakpoint");
  assert.deepEqual(s.threads, [{ id: 1, name: "MainThread", state: "stopped" }]);
  assert.equal(s.selectedThreadId, 1);
  assert.deepEqual(
    s.frames.map((frame) => [frame.name, frame.line, frame.path !== null]),
    [
      ["work", 4, true],
      ["<module>", 1, true],
      ["runner", 0, false],
    ],
  );
  assert.equal(s.selectedFrameId, s.frames[0].id);
  assert.deepEqual([s.focus?.path, s.focus?.line], [MAIN, 4]);
  assert.equal(s.frames[0].resource, resourceId(fileUri(MAIN)));
  const c = t.service.controls();
  assert.ok(c.continue && c.stepOver && c.stepInto && c.stepOut && c.evaluate && c.stop);
  assert.ok(!c.pause && !c.start && !c.restart);

  // The locals are one level; a child list only when expanded, and only once per stop.
  const locals = s.variables.get(s.scopes[0].variablesReference)!;
  assert.deepEqual(
    locals.map((v) => [v.name, v.value]),
    [
      ["line", "4"],
      ["items", "[1, 2]"],
    ],
  );
  assert.equal(t.adapter.requests("variables").length, 1);
  const items = await t.service.expand(locals[1].variablesReference);
  assert.deepEqual(
    items?.map((v) => v.value),
    ["1", "2"],
  );
  await t.service.expand(locals[1].variablesReference);
  assert.equal(t.adapter.requests("variables").length, 2, "not fetched twice in one stop");

  // Step over: stopped on the next line with a fresh stack.
  await t.service.stepOver();
  assert.deepEqual(t.adapter.requests("next")[0].arguments, { threadId: 1 });
  await until(() => stoppedAt(t.service) === 5 && settledStop(t), "the step");

  // Continue: nothing more to stop at; the program ends and the session with it.
  await t.service.continue();
  await until(() => isFinal(t.snap().session!.state), "the end");
  s = t.snap();
  assert.equal(s.session?.state, "terminated");
  assert.equal(s.session?.exitCode, 0);
  assert.equal(s.session?.terminationReason, "The program exited with code 0.");
  assert.equal(t.adapter.requests("terminate").length, 0, "a program that ended is not terminated");
  assert.equal(t.adapter.requests("disconnect").length, 1);
  assert.ok(t.adapter.closed);
  assert.deepEqual(s.frames, []);
  assert.equal(s.focus, null);
  assert.equal(t.breakpoints.getSnapshot()[0].verified, null, "no session: nothing verified");
  assert.ok(s.console.some((entry) => entry.kind === "stdout" && entry.text === "done"));
  // A step whose stop arrives with its answer never shows as running in between.
  assert.deepEqual(t.states.slice(0, 4), ["created", "starting", "initializing", "stopped"]);
  assert.deepEqual(t.states.slice(-2), ["terminating", "terminated"]);
});

test("an adapter that says initialized before launch is configured the same way", async () => {
  const t = setup({ initializedEarly: true });
  t.breakpoints.add(fileUri(MAIN), 2);
  await t.service.start("main");
  assert.deepEqual(t.adapter.sent.map((request) => request.command).slice(0, 5), [
    "initialize",
    "launch",
    "setBreakpoints",
    "setExceptionBreakpoints",
    "configurationDone",
  ]);
  await until(() => t.snap().session?.state === "stopped");
});

test("only the lifecycle's own moves are allowed", () => {
  assert.ok(canMove("created", "starting"));
  assert.ok(canMove("initializing", "stopped"));
  assert.ok(canMove("stopped", "running"));
  for (const [from, to] of [
    ["created", "running"],
    ["running", "initializing"],
    ["terminated", "running"],
    ["failed", "starting"],
    ["terminating", "running"],
  ] as const)
    assert.equal(canMove(from, to), false, `${from} -> ${to}`);
});

test("initialize and launch failures fail the session and end the adapter", async () => {
  let t = setup({ failInitialize: "not today" });
  await assert.rejects(
    t.service.start("main"),
    (error: DebugError) => error.code === "InitializeFailed",
  );
  assert.equal(t.snap().session?.state, "failed");
  assert.equal(t.snap().session?.error?.code, "InitializeFailed");
  assert.equal(t.adapter.stopped, 1);

  t = setup({ failLaunch: "No such file: main.py" });
  await assert.rejects(t.service.start("main"), (error: DebugError) => {
    assert.equal(error.code, "LaunchFailed");
    assert.match(error.message, /No such file/);
    return true;
  });
  assert.equal(t.snap().session?.error?.code, "LaunchFailed");
  assert.ok(t.service.controls().start, "another can be started");

  t = setup({ failStart: "AdapterUnavailable: The Python (debugpy) debug adapter needs python" });
  await assert.rejects(
    t.service.start("main"),
    (error: DebugError) => error.code === "AdapterUnavailable",
  );
  assert.equal(t.snap().session?.error?.code, "AdapterUnavailable");
});

test("an adapter that crashes, or breaks the protocol, fails the session", async () => {
  let t = setup({ runsForever: true });
  await t.service.start("main");
  assert.equal(t.snap().session?.state, "running");
  t.adapter.crash();
  assert.equal(t.snap().session?.state, "failed");
  assert.equal(t.snap().session?.error?.code, "SessionTerminated");
  assert.match(t.snap().session!.error!.message, /code 3/);

  t = setup({ runsForever: true });
  await t.service.start("main");
  t.adapter.raw("{garbage");
  assert.equal(t.snap().session?.state, "failed");
  assert.equal(t.snap().session?.error?.code, "MalformedMessage");
  assert.equal(t.adapter.stopped, 1);
});

test("Stop asks the program to terminate, then disconnects and ends the adapter", async () => {
  const t = setup({ runsForever: true });
  await t.service.start("main");
  await t.service.stop();
  assert.equal(t.adapter.requests("terminate").length, 1);
  assert.equal(t.adapter.requests("disconnect").length, 1);
  assert.deepEqual(t.adapter.requests("disconnect")[0].arguments, {
    restart: false,
    terminateDebuggee: true,
  });
  await until(() => isFinal(t.snap().session!.state));
  assert.equal(t.snap().session?.state, "terminated");
  assert.equal(t.snap().session?.terminationReason, "Stopped.");
  assert.ok(t.adapter.closed);
  // Events of the ended session change nothing.
  t.adapter.event("stopped", { reason: "breakpoint", threadId: 1 });
  await settle();
  assert.equal(t.snap().session?.state, "terminated");
});

test("closing the workspace ends its session and its adapter; nothing more starts", async () => {
  const t = setup({ runsForever: true });
  await t.service.start("main");
  t.service.dispose();
  assert.equal(t.snap().session?.state, "terminated");
  assert.equal(t.snap().session?.terminationReason, "The workspace was closed.");
  await until(() => t.adapter.closed, "the adapter's end");
  assert.equal(t.adapter.requests("disconnect").length, 1);
  assert.equal(t.service.controls().start, false);
  await assert.rejects(
    t.service.start("main"),
    (error: DebugError) => error.code === "NoWorkspace",
  );
});

test("answers for a stop that is over are not shown: stale variables and stack traces", async () => {
  const t = setup();
  t.breakpoints.add(fileUri(MAIN), 2);
  t.breakpoints.add(fileUri(MAIN), 6);
  await t.service.start("main");
  await until(() => settledStop(t));
  const items = t.snap().variables.get(t.snap().scopes[0].variablesReference)![1];

  // A child list asked for in this stop, answered after the program moved on.
  t.adapter.hold("variables");
  const late = t.service.expand(items.variablesReference);
  await settle();
  await t.service.continue();
  t.adapter.release("variables");
  assert.equal(await late, null, "a stale answer is dropped");

  // A stack asked for in a stop that ended before it was answered.
  await until(() => stoppedAt(t.service) === 6 && settledStop(t));
  t.adapter.hold("stackTrace");
  await t.service.selectThread(1).catch(() => {});
  assert.deepEqual(t.snap().frames, []);
  await t.service.continue();
  t.adapter.release("stackTrace");
  await settle();
  assert.deepEqual(t.snap().frames, [], "no frames from a stop that is over");
  assert.equal(t.snap().focus, null);
});

test("frames are selected and shown; a frame without a file is not navigated to", async () => {
  const t = setup();
  t.breakpoints.add(fileUri(MAIN), 7);
  await t.service.start("main");
  await until(() => settledStop(t));
  const [, module, runner] = t.snap().frames;
  const before = t.snap().focus!.nonce;
  await t.service.selectFrame(module.id);
  assert.equal(t.snap().selectedFrameId, module.id);
  assert.deepEqual([t.snap().focus?.line, t.snap().focus!.nonce > before], [1, true]);
  assert.deepEqual(t.adapter.requests("scopes").at(-1)?.arguments, { frameId: module.id });
  const shown = t.snap().focus;
  await t.service.selectFrame(runner.id);
  assert.equal(t.snap().selectedFrameId, runner.id);
  assert.equal(t.snap().focus, shown, "no file: the editor is not moved");
});

test("Pause stops a running program; a step needs it stopped", async () => {
  const t = setup({ runsForever: true });
  await t.service.start("main");
  t.adapter.event("thread", { reason: "started", threadId: 1 });
  await settle();
  assert.ok(t.service.controls().pause);
  await assert.rejects(t.service.stepOver(), (error: DebugError) => error.code === "NotStopped");
  await t.service.pause();
  assert.deepEqual(t.adapter.requests("pause")[0].arguments, { threadId: 1 });
  await until(() => settledStop(t));
  assert.equal(t.snap().session?.stoppedReason, "pause");
  await t.service.stepInto();
  await until(() => t.adapter.requests("stepIn").length === 1 && settledStop(t));
  await t.service.stepOut();
  await until(() => t.adapter.requests("stepOut").length === 1 && settledStop(t));
  assert.equal(stoppedAt(t.service), 4);
});

test("only what the adapter supports is offered: Restart", async () => {
  let t = setup({ runsForever: true });
  await t.service.start("main");
  assert.equal(t.service.controls().restart, false);
  await assert.rejects(
    t.service.restart(),
    (error: DebugError) => error.code === "UnsupportedCapability",
  );
  assert.equal(t.adapter.requests("restart").length, 0);

  t = setup({ runsForever: true, capabilities: { supportsRestartRequest: true } });
  await t.service.start("main");
  assert.equal(t.service.controls().restart, true);
  await t.service.restart();
  assert.equal(t.adapter.requests("restart").length, 1);
});

test("the Debug Console evaluates in the selected frame, and reports what fails", async () => {
  const t = setup();
  t.breakpoints.add(fileUri(MAIN), 3);
  await t.service.start("main");
  await until(() => settledStop(t));
  await t.service.evaluate("x + 1");
  assert.deepEqual(t.adapter.requests("evaluate")[0].arguments, {
    expression: "x + 1",
    frameId: t.snap().selectedFrameId,
    context: "repl",
  });
  await assert.rejects(
    t.service.evaluate("boom"),
    (error: DebugError) => error.code === "EvaluateFailed",
  );
  assert.deepEqual(
    t
      .snap()
      .console.slice(-4)
      .map((entry) => [entry.kind, entry.text]),
    [
      ["input", "x + 1"],
      ["result", "x + 1 = 3"],
      ["input", "boom"],
      ["error", "NameError: name 'boom' is not defined"],
    ],
  );
  await t.service.continue();
  await until(() => isFinal(t.snap().session!.state));
  await assert.rejects(
    t.service.evaluate("x"),
    (error: DebugError) => error.code === "SessionTerminated",
  );
});

test("breakpoints changed during a session are sent for their file; refused ones are unverified", async () => {
  const t = setup({ unverifiable: [9] });
  t.breakpoints.add(fileUri(MAIN), 2);
  await t.service.start("main");
  await until(() => settledStop(t));
  const before = t.adapter.requests("setBreakpoints").length;
  // Another spelling of the same file: the same file's breakpoints.
  t.breakpoints.toggle(fileUri("c:/work/MAIN.py"), 9);
  await until(() => t.adapter.requests("setBreakpoints").length === before + 1);
  const sent = t.adapter.requests("setBreakpoints").at(-1)!.arguments as {
    breakpoints: { line: number }[];
  };
  assert.deepEqual(sent.breakpoints, [{ line: 2 }, { line: 9 }]);
  await until(() => t.breakpoints.getSnapshot()[1].verified === false);
  assert.equal(t.breakpoints.getSnapshot()[1].message, "No code on this line.");
  assert.equal(t.breakpoints.getSnapshot()[0].verified, true);

  // Disabled: no longer sent. Removing the last of a file still tells the adapter.
  t.breakpoints.setEnabled(t.breakpoints.getSnapshot()[0].id, false);
  await until(() => t.adapter.requests("setBreakpoints").length === before + 2);
  const last = () =>
    (t.adapter.requests("setBreakpoints").at(-1)!.arguments as { breakpoints: unknown[] })
      .breakpoints;
  assert.deepEqual(last(), [{ line: 9 }]);
  t.breakpoints.clear();
  await until(() => t.adapter.requests("setBreakpoints").length === before + 3);
  assert.deepEqual(last(), []);
  // The adapter's later word on a breakpoint is shown.
  t.breakpoints.add(fileUri(MAIN), 2);
  await until(() => t.breakpoints.getSnapshot()[0]?.adapterId !== null);
  t.adapter.event("breakpoint", {
    reason: "changed",
    breakpoint: { id: t.breakpoints.getSnapshot()[0].adapterId, verified: false, message: "moved" },
  });
  assert.equal(t.breakpoints.getSnapshot()[0].verified, false);
});

test("an untrusted folder starts no adapter; trusted, it does", async () => {
  const t = setup({ trusted: false });
  await assert.rejects(t.service.start("main"), (error: DebugError) => {
    assert.equal(error.code, "TrustDenied");
    assert.match(error.message, /Manage Workspace Trust/);
    return true;
  });
  assert.equal(t.adapter.starts.length, 0);
  assert.equal(t.snap().session, null);
  t.setTrusted(true);
  await t.service.start("main");
  assert.equal(t.adapter.starts.length, 1);
});

test("a preLaunchTask runs first through the task service; if it fails nothing starts", async () => {
  const configs = [{ id: "main", adapter: "debugpy", program: "main.py", preLaunchTask: "build" }];
  const t = setup({ configs, runsForever: true });
  t.setTask("failed", "exit code 2");
  await assert.rejects(t.service.start("main"), (error: DebugError) => {
    assert.equal(error.code, "PreLaunchTaskFailed");
    assert.match(error.message, /"build" did not succeed/);
    return true;
  });
  assert.deepEqual(t.tasks, ["build"]);
  assert.equal(t.adapter.starts.length, 0);
  t.setTask("succeeded");
  await t.service.start("main");
  assert.equal(t.adapter.starts.length, 1);
});

test("invalid configurations, no workspace and a second session are refused", async () => {
  let t = setup({ configs: [{ id: "out", adapter: "debugpy", program: "../elsewhere/x.py" }] });
  await assert.rejects(t.service.start("out"), (error: DebugError) => {
    assert.equal(error.code, "InvalidConfiguration");
    assert.match(error.message, /not inside this workspace/);
    return true;
  });
  await assert.rejects(
    t.service.start("missing"),
    (error: DebugError) => error.code === "InvalidConfiguration",
  );

  t = setup({ workspace: null });
  assert.equal(t.service.controls().start, false);
  await assert.rejects(
    t.service.start("main"),
    (error: DebugError) => error.code === "NoWorkspace",
  );

  t = setup({ runsForever: true });
  await t.service.start("main");
  await assert.rejects(
    t.service.start("main"),
    (error: DebugError) => error.code === "AlreadyRunning",
  );
});

test("a debug session is not Problems state: nothing is published as diagnostics", async () => {
  const { allProblems, resetProblems } = await import("../panel/problems.ts");
  resetProblems();
  const t = setup();
  t.breakpoints.add(fileUri(MAIN), 2);
  await t.service.start("main");
  await until(() => settledStop(t));
  assert.deepEqual(allProblems(), []);
});

test("program output is a stream: pieces of a line are one line, an event may hold several", async () => {
  const t = setup({ runsForever: true });
  await t.service.start("main");
  for (const output of ["result", " 3\n", "a\r\nb\n", "partial"])
    t.adapter.event("output", { category: "stdout", output });
  t.adapter.event("output", { category: "stderr", output: "oops\n" });
  t.adapter.event("output", { category: "telemetry", output: "ignored\n" });
  assert.deepEqual(
    t
      .snap()
      .console.slice(1)
      .map((entry) => [entry.kind, entry.text]),
    [
      ["stdout", "result 3"],
      ["stdout", "a"],
      ["stdout", "b"],
      ["stdout", "partial"],
      ["stderr", "oops"],
    ],
  );
});

test("over a pipe -- each message in a task of its own -- a step still shows its new stop", async () => {
  const t = setup({ separateTasks: true });
  t.breakpoints.add(fileUri(MAIN), 3);
  await t.service.start("main");
  await until(() => settledStop(t), "the breakpoint");
  await t.service.evaluate("x");
  await t.service.stepOver();
  await until(() => stoppedAt(t.service) === 4 && settledStop(t), "the step's stop");
  assert.equal(t.snap().selectedFrameId, t.snap().frames[0].id);
  await t.service.continue();
  await until(() => isFinal(t.snap().session!.state), "the end");
});
