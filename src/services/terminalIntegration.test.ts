/**
 * TERMINAL-08: the terminal's parts together -- the service, its views, shell integration, the
 * UI state and the settings -- over the fake native side. Real shells are tested natively
 * (`terminal_tests.rs`); here the interleavings that are hard to force with a real process.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createTerminalService, createTerminalServices } from "./terminalService.ts";
import type { TerminalViewHandlers } from "./terminalService.ts";
import { createTerminalUi } from "./terminalUi.ts";
import { createProfileRegistry } from "./terminalProfiles.ts";
import { createTerminalSettings } from "./terminalSettings.ts";
import { terminalFolder } from "./terminalShell.ts";
import { FakeNative } from "./terminalNative.fake.ts";
import type { TerminalId, WorkspaceId } from "./terminalProtocol.ts";

const A = "file://c:/a" as WorkspaceId;
const B = "file://c:/b" as WorkspaceId;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const BASH = "C:/Program Files/Git/bin/bash.exe";
const SHELLS = [{ name: "Git Bash", path: BASH, kind: "bash", isDefault: true }];
const INTEGRATED = { integration: "available", pathStyle: "msys" } as const;

function view() {
  const text: string[] = [];
  const ends: string[] = [];
  const handlers: TerminalViewHandlers = {
    output: (chunk, accepted) => {
      text.push(Buffer.from(chunk.bytes).toString("utf8"));
      accepted();
    },
    ended: (message) => ends.push(message),
  };
  return { handlers, ends, shown: () => text.join("") };
}

test("eight terminals: output, folder, commands, size and ending are each their own", async () => {
  const fake = new FakeNative();
  const service = createTerminalService(A, fake);
  const ids: TerminalId[] = [];
  for (let i = 0; i < 8; i++)
    ids.push(service.open({ title: `T${i}`, profile: null, integration: INTEGRATED }));
  await settle();
  const views = ids.map((id) => {
    const v = view();
    service.attach(id, v.handlers);
    return v;
  });
  await settle();
  ids.forEach((id, i) => {
    const generation = service.get(id)!.generation;
    fake.output(id, generation, `only-${i};`);
    fake.shell(id, generation, { signal: "cwd", uri: `file:///c/t${i}`, local: true });
    if (i % 2) {
      fake.shell(id, generation, { signal: "executing" });
      fake.shell(id, generation, { signal: "finished", exitCode: i });
    }
  });
  ids.forEach((id, i) => {
    assert.equal(views[i].shown(), `only-${i};`);
    const session = service.get(id)!;
    assert.equal(terminalFolder(session), `C:/t${i}`);
    assert.equal(session.shell.last?.exitCode ?? null, i % 2 ? i : null);
    assert.equal(session.state, "Running");
  });
  // Generations are each session's own.
  assert.equal(new Set(ids.map((id) => service.get(id)!.generation)).size, 8);
  // One resized, one killed: the others are not touched.
  await service.resize(ids[3], { cols: 120, rows: 40 });
  const resizes = fake.calls.filter((call) => call.command === "resize");
  assert.deepEqual(
    resizes.map((call) => (call.args as { sessionId: string }).sessionId),
    [ids[3]],
  );
  await service.kill(ids[5]);
  assert.equal(service.get(ids[5]), undefined);
  assert.equal(service.list().length, 7);
  assert.ok(ids.filter((_, i) => i !== 5).every((id) => service.get(id)!.state === "Running"));
});

test("several views of one terminal: each sees the output, the shell state is shared", async () => {
  const fake = new FakeNative();
  const service = createTerminalService(A, fake);
  const id = service.open({ title: "T", profile: null, integration: INTEGRATED });
  await settle();
  const generation = service.get(id)!.generation;
  const one = view();
  const two = view();
  const first = service.attach(id, one.handlers);
  service.attach(id, two.handlers);
  await settle();
  fake.output(id, generation, "both;");
  fake.shell(id, generation, { signal: "cwd", uri: "file:///c/shared", local: true });
  assert.equal(one.shown(), "both;");
  assert.equal(two.shown(), "both;");
  // One view goes (its pane closed): the session and the other view go on.
  first.detach();
  first.detach(); // a late, second unregister is harmless
  fake.output(id, generation, "after;");
  assert.equal(one.shown(), "both;");
  assert.equal(two.shown(), "both;after;");
  assert.equal(service.get(id)!.attached, 1);
  // A view attaching again is replayed the output, and reads the shell state from the service.
  const three = view();
  service.attach(id, three.handlers);
  await settle();
  assert.equal(three.shown(), "both;after;");
  assert.equal(terminalFolder(service.get(id)!), "C:/shared");
});

test("open then restart at once: one live generation, the first never reaches a view", async () => {
  const fake = new FakeNative();
  fake.hold = true;
  const service = createTerminalService(A, fake);
  const id = service.open({ title: "T", profile: null });
  service.restart(id);
  // Both opens are on their way before either answers.
  await settle();
  fake.hold = false;
  fake.release();
  await settle();
  await settle();
  const opens = fake.calls.filter((call) => call.command === "open");
  assert.equal(opens.length, 2);
  const [first, second] = opens.map((call) => (call.args as { generation: number }).generation);
  assert.ok(second > first);
  assert.equal(service.get(id)!.generation, second);
  assert.equal(service.get(id)!.state, "Running");
  // The first generation was started after it was replaced: it is ended, not left running.
  assert.ok(
    fake.calls.some(
      (call) =>
        call.command === "kill" && (call.args as { generation: number }).generation === first,
    ),
  );
  const v = view();
  service.attach(id, v.handlers);
  await settle();
  assert.equal(
    service.applyEvent({ kind: "shell", sessionId: id, generation: first, signal: "prompt" }),
    false,
  );
  assert.equal(service.get(id)!.shell.commandState, "idle");
});

test("late native events after a workspace's terminals are disposed change nothing", async () => {
  const fake = new FakeNative();
  const services = createTerminalServices(fake);
  const a = services.forWorkspace(A);
  const b = services.forWorkspace(B);
  const inA = a.open({ title: "A", profile: null });
  const inB = b.open({ title: "B", profile: null });
  await settle();
  const generation = a.get(inA)!.generation;
  await services.dispose(A);
  for (const message of [
    { kind: "state", sessionId: inA, generation, state: "Exiting" },
    { kind: "shell", sessionId: inA, generation, signal: "prompt" },
    { kind: "exit", sessionId: inA, generation, exitCode: 0, lastSeq: null },
  ])
    assert.equal(a.applyEvent(message), false);
  // B's terminal is untouched, and A's id is not B's to act on.
  assert.equal(b.get(inB)!.state, "Running");
  assert.equal(
    b.applyEvent({ kind: "shell", sessionId: inA, generation, signal: "prompt" }),
    false,
  );
  assert.throws(() => a.open({ title: "again", profile: null }), /closed/);
});

test("settings read again (a restart) then a terminal opened: the kept default starts", async () => {
  const storage = new Map<string, string>();
  const backing = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
  };
  {
    const registry = createProfileRegistry(async () => SHELLS, createTerminalSettings(backing));
    await registry.load();
    const mine = registry.addUser({ name: "Mine", executable: BASH, args: ["--login-ish"] });
    registry.setUserDefault(mine.profile.id);
  }
  const settings = createTerminalSettings(backing);
  const registry = createProfileRegistry(async () => SHELLS, settings);
  const fake = new FakeNative();
  const service = createTerminalService(A, fake);
  const ui = createTerminalUi(service, registry.forWorkspace(A), {
    layout: null,
    saveLayout: () => {},
    shellIntegration: () => settings.shellIntegration(A),
  });
  // Opened before discovery has answered: no profile can be resolved yet, so the native
  // default starts -- never a guess at the kept one.
  const early = ui.newTerminal();
  await registry.load();
  const late = ui.newTerminal();
  await settle();
  assert.equal(service.get(early)!.profileName, null);
  assert.equal(service.get(late)!.profileName, "Mine");
  assert.deepEqual(service.get(late)!.profile!.args, ["--login-ish"]);
});
