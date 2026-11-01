import assert from "node:assert/strict";
import test from "node:test";
import {
  cwdFromOsc7,
  describeShell,
  initialShellState,
  reduceShell,
  shellIntegrationHint,
  terminalFolder,
  type TerminalShellState,
} from "./terminalShell.ts";
import { createTerminalService } from "./terminalService.ts";
import type { TerminalViewHandlers } from "./terminalService.ts";
import { FakeNative } from "./terminalNative.fake.ts";
import type { ShellSignal, WorkspaceId } from "./terminalProtocol.ts";

const A = "file://c:/a" as WorkspaceId;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const BASH = { integration: "available", pathStyle: "posix" } as const;

/** A clock moving on with every signal, across calls. */
let now = 1000;

/** Applies signals in order, as a session's shell would send them. */
function run(
  signals: (ShellSignal | [ShellSignal, Record<string, unknown>])[],
  state: TerminalShellState = initialShellState(BASH),
) {
  for (const one of signals) {
    const [signal, fields] = Array.isArray(one) ? one : [one, {}];
    state = reduceShell(state, { signal, ...fields }, (now += 10));
  }
  return state;
}

// --- OSC 7 ------------------------------------------------------------------------------------

test("OSC 7: a local URL becomes a path by the workspace's resource rules", () => {
  assert.deepEqual(cwdFromOsc7("file:///home/me/a%20b", true, "posix"), {
    kind: "local",
    uri: "file:///home/me/a%20b",
    path: "/home/me/a b",
  });
  // The host was this machine (the native side said so): its name is not a share.
  assert.equal(
    (cwdFromOsc7("file://MYBOX/C:/Work/./src/../x", true, "windows") as { path: string }).path,
    "C:/Work/x",
  );
  // Shells that do not percent-encode: a literal space is still read.
  assert.equal(
    (cwdFromOsc7("file://localhost/home/me/my dir", true, "posix") as { path: string }).path,
    "/home/me/my dir",
  );
});

test("OSC 7: Git Bash's MSYS paths map to their drive; others have no Windows path", () => {
  const msys = (uri: string) => cwdFromOsc7(uri, true, "msys");
  assert.deepEqual(msys("file://box/c/Users/me/yavin osc"), {
    kind: "local",
    uri: "file://box/c/Users/me/yavin osc",
    path: "C:/Users/me/yavin osc",
  });
  assert.equal((msys("file:///cygdrive/d/x") as { path: string }).path, "D:/x");
  assert.equal((msys("file:///c") as { path: string }).path, "C:/");
  assert.deepEqual(msys("file://box/tmp"), { kind: "unmapped", uri: "file://box/tmp" });
  assert.deepEqual(msys("file:///usr/bin"), { kind: "unmapped", uri: "file:///usr/bin" });
  // A native Windows shell reporting a bare POSIX path names nothing here either.
  assert.equal(cwdFromOsc7("file:///tmp", true, "windows")?.kind, "unmapped");
});

test("OSC 7: a remote host is never made a local path", () => {
  assert.deepEqual(cwdFromOsc7("file://build-server/home/ci", false, "posix"), {
    kind: "remote",
    uri: "file://build-server/home/ci",
    host: "build-server",
  });
  // Not even one that looks like a drive.
  assert.equal(cwdFromOsc7("file://elsewhere/C:/Work", false, "windows")?.kind, "remote");
});

test("OSC 7: unreadable URLs are refused", () => {
  for (const [uri, local] of [
    ["http://example.com/", true],
    ["file:/no-authority", true],
    ["file:///bad%zzescape", true],
    ["file:///a/../..", true],
    // `local: false` needs a host to name.
    ["file:///x", false],
  ] as const)
    assert.equal(cwdFromOsc7(uri, local, "posix"), null, uri);
});

test("an unreadable folder keeps the previous one", () => {
  const state = run([
    ["cwd", { uri: "file:///home/me", local: true }],
    ["cwd", { uri: "file:///bad%zz", local: true }],
  ]);
  assert.equal(terminalFolder({ cwd: "/start", shell: state }), "/home/me");
  assert.equal(state.invalid, 1);
  // Integration stays active: one bad sequence does not undo the good ones.
  assert.equal(state.integration, "active");
});

test("the folder: the shell's local report, else where it started; remote is no local folder", () => {
  const start = initialShellState(BASH);
  assert.equal(terminalFolder({ cwd: "/start", shell: start }), "/start");
  const remote = run([["cwd", { uri: "file://far/home", local: false }]]);
  assert.equal(terminalFolder({ cwd: "/start", shell: remote }), null);
});

// --- OSC 133 and the command state machine ------------------------------------------------------

test("A, B, C, D: one command from prompt to completion, with its status", () => {
  let state = run(["prompt"]);
  assert.equal(state.commandState, "prompt");
  state = run(["input"], state);
  assert.equal(state.commandState, "input");
  state = run(["executing"], state);
  assert.equal(state.commandState, "executing");
  assert.equal(state.current?.id, 1);
  assert.equal(state.current?.exitCode, null);
  state = run([["finished", { exitCode: 2 }]], state);
  assert.equal(state.commandState, "completed");
  assert.equal(state.current, null);
  assert.equal(state.last?.id, 1);
  assert.equal(state.last?.exitCode, 2);
  assert.ok(state.last!.finishedAt! > state.last!.startedAt);
  assert.equal(describeShell(state), "Last command exited with 2");
});

test("a D before any command (a shell's first prompt) ends nothing", () => {
  const state = run([["finished", { exitCode: 0 }], "prompt"]);
  assert.equal(state.last, null);
  assert.equal(state.commandState, "prompt");
  assert.equal(state.integration, "active");
});

test("repeated, missing and out-of-order markers are tolerated", () => {
  // A repeated C is one command; a repeated D ends nothing more.
  let state = run(["prompt", "input", "executing", "executing", ["finished", { exitCode: 0 }]]);
  assert.equal(state.last?.id, 1);
  state = run([["finished", { exitCode: 5 }]], state);
  assert.equal(state.last?.exitCode, 0);
  // A missing D: the next prompt ends the command, with no status.
  state = run(["executing", "prompt"], state);
  assert.equal(state.last?.id, 2);
  assert.equal(state.last?.exitCode, null);
  assert.equal(state.commandState, "prompt");
  // Missing A and B: C still starts a command.
  state = run(["executing", ["finished", {}]], state);
  assert.equal(state.last?.id, 3);
  assert.equal(state.last?.exitCode, null);
  assert.equal(describeShell(state), "Last command finished");
  // Input while running (no D, no A): the command ended.
  state = run(["executing", "input"], state);
  assert.equal(state.last?.id, 4);
  assert.equal(state.commandState, "input");
});

test("integration states: available, active, error, unsupported, disabled", () => {
  assert.equal(initialShellState(BASH).integration, "available");
  assert.equal(run(["prompt"]).integration, "active");
  // Only unreadable sequences: an error, until a good one arrives.
  const bad = run(["invalid", "invalid"]);
  assert.equal(bad.integration, "error");
  assert.equal(bad.invalid, 2);
  assert.equal(describeShell(bad), "Shell integration: unreadable sequences");
  assert.equal(run(["prompt"], bad).integration, "active");
  assert.equal(run(["prompt", "invalid"]).integration, "active");
  // A shell with no integration that reports anyway has integration after all.
  const plain = initialShellState({ integration: "unsupported", pathStyle: "posix" });
  assert.equal(describeShell(plain), "");
  assert.equal(run(["prompt"], plain).integration, "active");
  // Disabled: every signal is ignored.
  const off = initialShellState({ integration: "disabled", pathStyle: "posix" });
  assert.equal(run(["prompt", "executing", ["cwd", { uri: "file:///x", local: true }]], off), off);
});

test("a signal that changes nothing answers the same state", () => {
  const state = run(["prompt", "executing"]);
  assert.equal(reduceShell(state, { signal: "executing" }), state);
  const idle = run(["prompt"]);
  assert.equal(reduceShell(idle, { signal: "finished", exitCode: 1 }), idle);
});

test("the hint: which shells can report, and which write MSYS paths", () => {
  assert.deepEqual(shellIntegrationHint("bash", "C:/Program Files/Git/bin/bash.exe"), {
    integration: "available",
    pathStyle: "msys",
  });
  assert.deepEqual(shellIntegrationHint("bash", "/bin/bash"), BASH);
  assert.deepEqual(shellIntegrationHint("pwsh", "C:\\Program Files\\PowerShell\\7\\pwsh.exe"), {
    integration: "available",
    pathStyle: "windows",
  });
  assert.equal(
    shellIntegrationHint("cmd", "C:/Windows/System32/cmd.exe").integration,
    "unsupported",
  );
  assert.equal(shellIntegrationHint("sh", "/bin/sh").integration, "unsupported");
  assert.equal(shellIntegrationHint(null, null).integration, "unsupported");
});

// --- The service: one interpretation, per session and generation ------------------------------

const bash = {
  id: "builtin.bash",
  name: "Bash",
  executable: "/bin/bash",
  args: [],
  cwd: null,
  env: [],
};

async function started(service: ReturnType<typeof createTerminalService>, title = "Shell") {
  const id = service.open({ title, profile: bash, cwd: "/start", integration: BASH });
  await settle();
  return { id, generation: service.get(id)!.generation as number };
}

const quiet: TerminalViewHandlers = { output: (_c, accepted) => accepted(), ended: () => {} };

test("the service keeps each session's shell state, separate from its own state", async () => {
  const fake = new FakeNative();
  const service = createTerminalService(A, fake);
  const one = await started(service, "One");
  const two = await started(service, "Two");
  assert.equal(service.get(one.id)!.shell.integration, "available");

  fake.shell(one.id, one.generation, { signal: "cwd", uri: "file:///home/one", local: true });
  fake.shell(one.id, one.generation, { signal: "executing" });
  fake.shell(one.id, one.generation, { signal: "finished", exitCode: 1 });
  fake.shell(two.id, two.generation, { signal: "prompt" });

  const first = service.get(one.id)!;
  assert.equal(terminalFolder(first), "/home/one");
  assert.equal(first.shell.last?.exitCode, 1);
  // A command's status is not the session's.
  assert.equal(first.state, "Running");
  assert.equal(first.exitCode, null);
  const second = service.get(two.id)!;
  assert.equal(second.shell.commandState, "prompt");
  assert.equal(terminalFolder(second), "/start");
});

test("signals of a stale generation, another session or another workspace change nothing", async () => {
  const fake = new FakeNative();
  const service = createTerminalService(A, fake);
  const other = createTerminalService("file://c:/b" as WorkspaceId, fake);
  const { id, generation } = await started(service);
  const before = service.get(id)!.shell;
  const signal = { kind: "shell", sessionId: id, signal: "prompt" };
  assert.equal(service.applyEvent({ ...signal, generation: generation - 1 }), false);
  assert.equal(service.applyEvent({ ...signal, generation: generation + 1 }), false);
  assert.equal(other.applyEvent({ ...signal, generation }), false);
  assert.equal(service.applyEvent({ ...signal, sessionId: "terminal-nope", generation }), false);
  // Malformed: refused by the contract before it means anything.
  assert.equal(service.applyEvent({ ...signal, generation, signal: "rm -rf" }), false);
  assert.equal(service.applyEvent({ ...signal, generation, signal: "cwd" }), false);
  assert.equal(service.get(id)!.shell, before);
  assert.equal(service.applyEvent({ ...signal, generation }), true);
  assert.equal(service.get(id)!.shell.commandState, "prompt");
});

test("a restart starts the shell state again; the old generation's signals are stale", async () => {
  const fake = new FakeNative();
  const service = createTerminalService(A, fake);
  const { id, generation: first } = await started(service);
  fake.shell(id, first, { signal: "cwd", uri: "file:///elsewhere", local: true });
  fake.shell(id, first, { signal: "executing" });
  fake.shell(id, first, { signal: "finished", exitCode: 3 });
  service.restart(id);
  await settle();
  const view = service.get(id)!;
  assert.equal(view.shell.integration, "available");
  assert.equal(view.shell.reported, null);
  assert.equal(view.shell.last, null);
  assert.equal(view.shell.commandState, "idle");
  // It starts where it started before, not where the old shell had gone.
  assert.equal(terminalFolder(view), "/start");
  assert.equal(
    service.applyEvent({ kind: "shell", sessionId: id, generation: first, signal: "prompt" }),
    false,
  );
  // Command ids go on counting across generations.
  fake.shell(id, view.generation, { signal: "executing" });
  assert.equal(service.get(id)!.shell.current?.id, 2);
});

test("a detached view leaves the state with the service; reattaching reads it, nothing replayed", async () => {
  const fake = new FakeNative();
  const service = createTerminalService(A, fake);
  const { id, generation } = await started(service);
  const attachment = service.attach(id, quiet);
  await settle();
  attachment.detach();
  fake.shell(id, generation, { signal: "cwd", uri: "file:///while/away", local: true });
  fake.output(id, generation, "text");
  fake.shell(id, generation, { signal: "executing" });
  assert.equal(terminalFolder(service.get(id)!), "/while/away");

  let changes = 0;
  const unsubscribe = service.subscribe(() => changes++);
  service.attach(id, quiet);
  await settle();
  // Attaching replays output, not signals: the state is as it was.
  assert.equal(service.get(id)!.shell.current?.id, 1);
  assert.equal(service.get(id)!.shell.commandState, "executing");
  assert.equal(changes, 1); // the attach count, nothing else
  unsubscribe();
});

test("a session ended changes no shell state", async () => {
  const fake = new FakeNative();
  const service = createTerminalService(A, fake);
  const { id, generation } = await started(service);
  fake.end(id, generation, 0);
  assert.equal(
    service.applyEvent({ kind: "shell", sessionId: id, generation, signal: "prompt" }),
    false,
  );
  assert.equal(service.get(id)!.shell.commandState, "idle");
});
