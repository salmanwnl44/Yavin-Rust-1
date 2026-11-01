import assert from "node:assert/strict";
import test from "node:test";
import { createTerminalService, createTerminalServices } from "./terminalService.ts";
import type { TerminalService, TerminalViewHandlers } from "./terminalService.ts";
import { FakeNative } from "./terminalNative.fake.ts";

type Receive = (message: unknown) => void;
import { TerminalError } from "./terminalProtocol.ts";
import type { TerminalId, WorkspaceId } from "./terminalProtocol.ts";

const A = "file://c:/a" as WorkspaceId;
const B = "file://c:/b" as WorkspaceId;
/** A launch profile of one shell, as the workspace's profiles would resolve it. */
const profileOf = (executable: string) =>
  executable ? { id: "p", name: "P", executable, args: [], cwd: null, env: [] } : null;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A view that records what it is shown, accepting each chunk at once (or never). */
function view(options: { accept?: boolean } = {}) {
  const text: string[] = [];
  const ends: string[] = [];
  const pending: (() => void)[] = [];
  const handlers: TerminalViewHandlers = {
    output: (chunk, accepted) => {
      text.push(Buffer.from(chunk.bytes).toString("utf8"));
      if (options.accept === false) pending.push(accepted);
      else accepted();
    },
    ended: (message, failed) => ends.push(`${failed ? "failed" : "ended"}: ${message}`),
  };
  return { handlers, text, ends, pending, shown: () => text.join("") };
}

async function running(service: TerminalService, title = "Shell") {
  const id = service.open({ title, profile: profileOf("C:/Windows/System32/cmd.exe") });
  await settle();
  return { id, generation: service.get(id)!.generation as number };
}

// --- A. Workspace isolation -------------------------------------------------------------------

test("a workspace's service holds only its own sessions, and refuses another's by name", async () => {
  const fake = new FakeNative();
  const services = createTerminalServices(fake);
  const a = services.forWorkspace(A);
  const b = services.forWorkspace(B);
  const a1 = await running(a, "A1");
  const a2 = await running(a, "A2");
  const b1 = await running(b, "B1");

  assert.deepEqual(
    a.list().map((s) => s.title),
    ["A1", "A2"],
  );
  assert.deepEqual(
    b.list().map((s) => s.title),
    ["B1"],
  );
  assert.equal(b.get(a1.id), undefined);
  for (const attempt of [
    () => b.write(a1.id, "x"),
    () => b.close(a2.id),
    async () => b.attach(a1.id, view().handlers),
  ])
    await assert.rejects(
      async () => attempt(),
      (error: TerminalError) => error.code === "InvalidWorkspace",
    );
  // An id nobody has is simply unknown.
  await assert.rejects(
    async () => b.write("terminal-nope" as TerminalId, "x"),
    (error: TerminalError) => error.code === "InvalidSession",
  );
  // A's lifecycle messages are not B's to apply, whatever the id.
  assert.equal(
    b.applyEvent({ kind: "state", sessionId: a1.id, generation: a1.generation, state: "Exiting" }),
    false,
  );
  assert.equal(a.get(a1.id)!.state, "Running");
  assert.equal(b1.id !== a1.id, true);
});

test("output of one workspace's terminal reaches only views attached to it", async () => {
  const fake = new FakeNative();
  const services = createTerminalServices(fake);
  const a = services.forWorkspace(A);
  const b = services.forWorkspace(B);
  const a1 = await running(a);
  const b1 = await running(b);
  const inA = view();
  const inB = view();
  a.attach(a1.id, inA.handlers);
  b.attach(b1.id, inB.handlers);
  await settle();
  fake.output(a1.id, a1.generation, "for A");
  fake.output(b1.id, b1.generation, "for B");
  assert.equal(inA.shown(), "for A");
  assert.equal(inB.shown(), "for B");
});

test("disposing one workspace's terminals leaves another's alone", async () => {
  const fake = new FakeNative();
  const services = createTerminalServices(fake);
  const a = services.forWorkspace(A);
  const b = services.forWorkspace(B);
  await running(a);
  const b1 = await running(b);
  await services.dispose(A);
  assert.equal(b.get(b1.id)!.state, "Running");
  assert.deepEqual(services.workspaces(), [B]);
  // A fresh service for A starts empty: nothing of the disposed one survives.
  assert.deepEqual(services.forWorkspace(A).list(), []);
});

// --- B. Lifecycle -----------------------------------------------------------------------------

test("a session goes Spawning, Running, Exiting, Exited -- and its listeners hear state, not bytes", async () => {
  const fake = new FakeNative();
  const service = createTerminalService(A, fake);
  let notified = 0;
  service.subscribe(() => notified++);
  fake.hold = true;
  const id = service.open({ title: "Shell", profile: profileOf("cmd.exe") });
  await settle();
  assert.equal(service.get(id)!.state, "Spawning");
  fake.release();
  await settle();
  const session = service.get(id)!;
  assert.equal(session.state, "Running");
  assert.equal(session.pid, 42);
  const before = notified;
  // Output changes no state: no notification for it.
  for (let i = 0; i < 50; i++) fake.output(id, session.generation, "x");
  assert.equal(notified, before);
  fake.end(id, session.generation, 3);
  assert.equal(service.get(id)!.state, "Exited");
  assert.equal(service.get(id)!.exitCode, 3);
});

test("a launch that cannot start fails with its reason, and attaching shows it", async () => {
  const fake = new FakeNative();
  fake.failOpen = "ShellUnavailable: That shell is not available on this system.";
  const service = createTerminalService(A, fake);
  const id = service.open({ title: "Shell", profile: profileOf("nope.exe") });
  await settle();
  assert.equal(service.get(id)!.state, "Failed");
  assert.equal(service.get(id)!.error, "That shell is not available on this system.");
  const v = view();
  service.attach(id, v.handlers);
  assert.deepEqual(v.ends, ["failed: That shell is not available on this system."]);
});

test("close and kill end the session natively and forget it", async () => {
  const fake = new FakeNative();
  const service = createTerminalService(A, fake);
  const one = await running(service);
  const two = await running(service);
  await service.close(one.id);
  await service.kill(two.id);
  assert.deepEqual(service.list(), []);
  assert.deepEqual(
    fake.calls.filter((c) => c.command === "close" || c.command === "kill").map((c) => c.command),
    ["close", "kill"],
  );
});

test("a restart is a new generation; the old one's late messages change nothing", async () => {
  const fake = new FakeNative();
  const service = createTerminalService(A, fake);
  const { id, generation: first } = await running(service);
  fake.end(id, first, 1);
  service.restart(id);
  await settle();
  const second = service.get(id)!.generation;
  assert.ok(second > first);
  assert.equal(service.get(id)!.state, "Running");
  // The first generation's late exit is stale.
  assert.equal(
    service.applyEvent({
      kind: "exit",
      sessionId: id,
      generation: first,
      exitCode: 9,
      lastSeq: null,
    }),
    false,
  );
  assert.equal(service.get(id)!.state, "Running");
  assert.equal(service.get(id)!.exitCode, null);
});

test("the service applies only valid lifecycle steps", async () => {
  const fake = new FakeNative();
  const service = createTerminalService(A, fake);
  const { id, generation } = await running(service);
  const at = { sessionId: id, generation };
  // Output never belongs to the lifecycle path, nor does a malformed message.
  assert.equal(service.applyEvent({ kind: "output", ...at, seq: 0, bytes: "" }), false);
  assert.equal(service.applyEvent({ kind: "state", ...at, state: "Bogus" }), false);
  assert.equal(service.applyEvent({ ...at, state: "Exiting" }), false);
  // Exited cannot come before Exiting.
  assert.equal(service.applyEvent({ kind: "exit", ...at, exitCode: 0, lastSeq: null }), false);
  assert.equal(service.applyEvent({ kind: "state", ...at, state: "Exiting" }), true);
  assert.equal(service.applyEvent({ kind: "exit", ...at, exitCode: 0, lastSeq: 4 }), true);
  // Nothing after the end.
  assert.equal(service.applyEvent({ kind: "state", ...at, state: "Exiting" }), false);
});

// --- C/D/E. Attach, detach, replay, several views ---------------------------------------------

test("a view attaching later is replayed the output, then continues live, nothing twice", async () => {
  const fake = new FakeNative();
  const service = createTerminalService(A, fake);
  const { id, generation } = await running(service);
  fake.output(id, generation, "one ");
  fake.output(id, generation, "two ");
  const v = view();
  service.attach(id, v.handlers);
  await settle();
  fake.output(id, generation, "three");
  assert.equal(v.shown(), "one two three");
  // Each chunk acknowledged once, by its own subscription.
  assert.deepEqual(
    fake.calls.filter((c) => c.command === "ack").map((c) => (c.args as { seq: number }).seq),
    [0, 1, 2],
  );
});

test("detaching a view leaves the shell running, and attaching again replays it", async () => {
  const fake = new FakeNative();
  const service = createTerminalService(A, fake);
  const { id, generation } = await running(service);
  const first = view();
  const attachment = service.attach(id, first.handlers);
  await settle();
  fake.output(id, generation, "before ");
  attachment.detach();
  attachment.detach(); // harmless
  fake.output(id, generation, "while away ");
  assert.equal(first.shown(), "before ");
  assert.equal(service.get(id)!.state, "Running");
  assert.equal(fake.count("kill") + fake.count("close"), 0, "detaching ended the session");
  assert.equal(service.get(id)!.attached, 0);

  const again = view();
  service.attach(id, again.handlers);
  await settle();
  fake.output(id, generation, "after");
  assert.equal(again.shown(), "before while away after");
});

test("attaching to a session that exited shows its output and its end, and revives nothing", async () => {
  const fake = new FakeNative();
  const service = createTerminalService(A, fake);
  const { id, generation } = await running(service);
  fake.output(id, generation, "last words");
  fake.end(id, generation, 7);
  const opens = fake.count("open");
  const v = view();
  service.attach(id, v.handlers);
  await settle();
  assert.equal(v.shown(), "last words");
  assert.deepEqual(v.ends, ["ended: The shell exited with code 7."]);
  assert.equal(fake.count("open"), opens);
  assert.equal(service.get(id)!.state, "Exited");
});

test("two views each get the output; detaching one leaves the other", async () => {
  const fake = new FakeNative();
  const service = createTerminalService(A, fake);
  const { id, generation } = await running(service);
  const one = view();
  const two = view();
  const first = service.attach(id, one.handlers);
  service.attach(id, two.handlers);
  await settle();
  fake.output(id, generation, "both ");
  first.detach();
  fake.output(id, generation, "second only");
  assert.equal(one.shown(), "both ");
  assert.equal(two.shown(), "both second only");
  assert.equal(service.get(id)!.attached, 1);
});

test("duplicated, reordered or foreign output never reaches a view", async () => {
  const fake = new FakeNative();
  const service = createTerminalService(A, fake);
  const { id, generation } = await running(service);
  let receive: Receive | null = null;
  const realSubscribe = fake.subscribe.bind(fake);
  fake.subscribe = async (args) => {
    receive = (args.events as { receive: Receive }).receive;
    return realSubscribe(args);
  };
  const v = view();
  service.attach(id, v.handlers);
  await settle();
  const chunk = fake.output(id, generation, "a");
  receive!(chunk); // a duplicate
  receive!({ ...chunk, seq: 5 }); // a gap
  receive!({ ...chunk, sessionId: "terminal-other" }); // another session's
  receive!({ ...chunk, generation: generation + 99 }); // another generation's
  receive!({ id, data: "old shape" });
  fake.output(id, generation, "b");
  assert.equal(v.shown(), "ab");
});

test("a view that throws stops neither the stream nor the other views", async () => {
  const fake = new FakeNative();
  const service = createTerminalService(A, fake);
  const { id, generation } = await running(service);
  service.attach(id, {
    output: () => {
      throw new Error("view blew up");
    },
    ended: () => {
      throw new Error("view blew up");
    },
  });
  const healthy = view();
  service.attach(id, healthy.handlers);
  await settle();
  assert.doesNotThrow(() => fake.output(id, generation, "still here"));
  assert.equal(healthy.shown(), "still here");
});

// --- F. Generation ----------------------------------------------------------------------------

test("a restart lets go of the old generation's views; their late output and acks go nowhere", async () => {
  const fake = new FakeNative();
  const service = createTerminalService(A, fake);
  const { id, generation: first } = await running(service);
  const old = view({ accept: false });
  service.attach(id, old.handlers);
  await settle();
  fake.output(id, first, "old ");
  service.restart(id);
  await settle();
  const second = service.get(id)!.generation;
  // The old view's acknowledgement, after it was let go, is not sent.
  const acks = fake.count("ack");
  old.pending.forEach((accept) => accept());
  assert.equal(fake.count("ack"), acks);
  // A view of the new generation sees only it.
  const fresh = view();
  service.attach(id, fresh.handlers);
  await settle();
  fake.output(id, second, "new");
  assert.equal(fresh.shown(), "new");
  assert.equal(old.shown(), "old ");
});

// --- G. Workspace switching -------------------------------------------------------------------

test("A → B → A: A's terminals keep running while away, and its views attach again", async () => {
  const fake = new FakeNative();
  const services = createTerminalServices(fake);
  const a = services.forWorkspace(A);
  const a1 = await running(a, "A1");
  const a2 = await running(a, "A2");
  const panel = view();
  const attachment = a.attach(a1.id, panel.handlers);
  await settle();
  fake.output(a1.id, a1.generation, "A1 before ");

  // Switching to B detaches A's views; it disposes nothing of A's terminals.
  attachment.detach();
  const b = services.forWorkspace(B);
  const b1 = await running(b, "B1");
  fake.output(a1.id, a1.generation, "A1 meanwhile ");
  assert.equal(fake.count("kill") + fake.count("close"), 0, "switching ended a terminal");
  assert.equal(b.get(b1.id)!.workspaceId, B);

  // Back to A: the same service, the same sessions, replayed then live.
  const back = services.forWorkspace(A);
  assert.equal(back, a);
  assert.deepEqual(
    back.list().map((s) => [s.title, s.state]),
    [
      ["A1", "Running"],
      ["A2", "Running"],
    ],
  );
  const again = view();
  back.attach(a1.id, again.handlers);
  await settle();
  fake.output(a1.id, a1.generation, "A1 after");
  assert.equal(again.shown(), "A1 before A1 meanwhile A1 after");
  assert.equal(a2.id !== a1.id, true);
});

// --- H. Disposal ------------------------------------------------------------------------------

test("disposing a workspace's terminals ends them all and refuses everything after", async () => {
  const fake = new FakeNative();
  const service = createTerminalService(A, fake);
  const one = await running(service);
  const two = await running(service);
  const v = view();
  service.attach(one.id, v.handlers);
  await settle();
  await service.dispose();
  assert.equal(fake.count("kill"), 2);
  assert.deepEqual(service.list(), []);
  assert.equal(service.getSnapshot().disposed, true);
  for (const attempt of [
    () => service.open({ title: "x", profile: profileOf("") }),
    () => service.attach(one.id, view().handlers),
  ])
    assert.throws(attempt, (error: TerminalError) => error.code === "InvalidWorkspace");
  await assert.rejects(
    () => service.write(two.id, "x"),
    (error: TerminalError) => error.code === "InvalidWorkspace",
  );
  // Late native messages are ignored.
  assert.equal(
    service.applyEvent({
      kind: "state",
      sessionId: one.id,
      generation: one.generation,
      state: "Exiting",
    }),
    false,
  );
  fake.output(one.id, one.generation, "late");
  assert.equal(v.shown(), "");
  await service.dispose(); // twice is harmless
});

// --- I. Races ---------------------------------------------------------------------------------

test("attaching while spawning subscribes once, after the open", async () => {
  const fake = new FakeNative();
  const service = createTerminalService(A, fake);
  fake.hold = true;
  const id = service.open({ title: "Shell", profile: profileOf("cmd.exe") });
  await settle();
  const v = view();
  service.attach(id, v.handlers);
  await settle();
  assert.equal(fake.count("subscribe"), 0);
  fake.release();
  await settle();
  await settle();
  assert.equal(fake.count("subscribe"), 1);
  fake.output(id, service.get(id)!.generation, "hi");
  assert.equal(v.shown(), "hi");
});

test("detaching while spawning never subscribes", async () => {
  const fake = new FakeNative();
  const service = createTerminalService(A, fake);
  fake.hold = true;
  const id = service.open({ title: "Shell", profile: profileOf("cmd.exe") });
  await settle();
  service.attach(id, view().handlers).detach();
  fake.release();
  await settle();
  await settle();
  assert.equal(fake.count("subscribe"), 0);
  assert.equal(service.get(id)!.state, "Running");
});

for (const how of ["close", "kill"] as const)
  test(`a ${how} while spawning ends the shell as soon as it has started`, async () => {
    const fake = new FakeNative();
    const service = createTerminalService(A, fake);
    fake.hold = true;
    const id = service.open({ title: "Shell", profile: profileOf("cmd.exe") });
    await settle();
    await service[how](id);
    assert.equal(service.get(id), undefined);
    fake.release();
    await settle();
    await settle();
    // Started after it was let go: killed, never left running.
    assert.equal(fake.count("kill"), 1);
  });

test("a restart while the old generation is exiting keeps the new one", async () => {
  const fake = new FakeNative();
  const service = createTerminalService(A, fake);
  const { id, generation: first } = await running(service);
  fake.lifecycle(id, first, { kind: "state", state: "Exiting" });
  assert.equal(service.get(id)!.state, "Exiting");
  service.restart(id);
  await settle();
  // The old generation finishes exiting after the restart.
  fake.lifecycle(id, first, { kind: "exit", exitCode: 0, lastSeq: null });
  assert.equal(service.get(id)!.state, "Running");
  assert.ok(service.get(id)!.generation > first);
});

test("disposing during output, and a subscriber disconnecting, throw nothing and leak nothing", async () => {
  const fake = new FakeNative();
  const service = createTerminalService(A, fake);
  const { id, generation } = await running(service);
  const v = view();
  const attachment = service.attach(id, v.handlers);
  await settle();
  fake.output(id, generation, "a");
  attachment.detach();
  assert.doesNotThrow(() => fake.output(id, generation, "b"));
  const late = service.attach(id, view().handlers);
  await settle();
  await service.dispose();
  assert.doesNotThrow(() => fake.output(id, generation, "c"));
  assert.doesNotThrow(() => late.detach());
  assert.equal(v.shown(), "a");
});

test("writes and resizes reach the current generation, and are refused once it has ended", async () => {
  const fake = new FakeNative();
  const service = createTerminalService(A, fake);
  const { id, generation } = await running(service);
  await service.write(id, "ls\r");
  await service.resize(id, { cols: 100, rows: 30 });
  await service.resize(id, { cols: 100, rows: 30 }); // unchanged: not sent again
  assert.deepEqual(
    fake.calls.filter((c) => c.command === "write" || c.command === "resize").map((c) => c.args),
    [
      { sessionId: id, generation, data: "ls\r" },
      { sessionId: id, generation, dimensions: { cols: 100, rows: 30 } },
    ],
  );
  fake.end(id, generation, 0);
  await assert.rejects(
    () => service.write(id, "x"),
    (error: TerminalError) => error.code === "SessionEnded",
  );
});

test("a resize while the shell is starting reaches it once it runs", async () => {
  const fake = new FakeNative();
  const service = createTerminalService(A, fake);
  fake.hold = true;
  const id = service.open({ title: "Shell", profile: profileOf("cmd.exe") });
  await settle();
  // The view measured itself before the shell was up.
  await service.resize(id, { cols: 132, rows: 40 });
  assert.equal(fake.count("resize"), 0);
  fake.release();
  await settle();
  await settle();
  const sent = fake.calls.filter((c) => c.command === "resize").map((c) => c.args);
  assert.deepEqual(sent, [
    { sessionId: id, generation: service.get(id)!.generation, dimensions: { cols: 132, rows: 40 } },
  ]);
});
