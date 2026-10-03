import assert from "node:assert/strict";
import test from "node:test";
import { createTerminalService } from "./terminalService.ts";
import { createTerminalUi, statusOf } from "./terminalUi.ts";
import type { TerminalUi, TerminalUiState, TerminalViewHandle } from "./terminalUi.ts";
import { FakeNative } from "./terminalNative.fake.ts";
import { createProfileRegistry } from "./terminalProfiles.ts";
import type { TerminalId, WorkspaceId } from "./terminalProtocol.ts";

const A = "file://c:/a" as WorkspaceId;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const SHELLS = [
  { name: "Command Prompt", path: "C:/Windows/System32/cmd.exe", kind: "cmd", isDefault: true },
  { name: "Git Bash", path: "C:/Program Files/Git/bin/bash.exe", kind: "bash" },
];

async function setup() {
  const fake = new FakeNative();
  const service = createTerminalService(A, fake);
  const ui = createTerminalUi(service, createProfileRegistry(async () => SHELLS).forWorkspace(A));
  ui.loadProfiles();
  await settle();
  return { fake, service, ui };
}

/** Every pane names an existing session, and the two panes never the same one. */
function assertConsistent(ui: TerminalUi) {
  const state: TerminalUiState = ui.getSnapshot();
  const ids = ui.service.list().map((s) => s.sessionId);
  if (state.primary !== null) assert.ok(ids.includes(state.primary), "primary names nothing");
  if (state.secondary !== null) {
    assert.ok(ids.includes(state.secondary), "secondary names nothing");
    assert.notEqual(state.secondary, state.primary, "both panes show one session");
  }
  if (state.secondary === null) assert.equal(state.focused, "primary");
  if (ids.length) assert.notEqual(state.primary, null, "terminals but no pane");
}

test("new terminals are titled by their shell and shown in the focused pane", async () => {
  const { ui, service } = await setup();
  const one = ui.newTerminal();
  const two = ui.newTerminal();
  const bash = ui.newTerminal({ profileId: "builtin.bash" });
  assert.deepEqual(
    service.list().map((s) => s.title),
    ["Command Prompt", "Command Prompt (2)", "Git Bash"],
  );
  assert.equal(ui.getSnapshot().primary, bash);
  ui.activate(one);
  assert.equal(ui.focusedId(), one);
  assert.notEqual(two, one);
  assertConsistent(ui);
});

test("single pane, split, close the left, the right remains, collapse: always valid", async () => {
  const { ui, service } = await setup();
  const left = ui.newTerminal();
  ui.toggleSplit();
  const { primary, secondary } = ui.getSnapshot();
  assert.equal(primary, left);
  assert.notEqual(secondary, null);
  assert.equal(service.list().length, 2, "splitting a lone terminal starts a second");
  assertConsistent(ui);

  // Closing the left pane's terminal leaves the right one, now alone.
  ui.close(left);
  await settle();
  assert.equal(ui.getSnapshot().primary, secondary);
  assert.equal(ui.getSnapshot().secondary, null);
  assert.equal(service.get(secondary!)!.state, "Running", "closing one pane ended the other");
  assertConsistent(ui);

  // Split again and collapse: the active terminal stays.
  ui.toggleSplit();
  const right = ui.getSnapshot().secondary;
  ui.toggleSplit();
  assert.equal(ui.getSnapshot().secondary, null);
  assert.equal(ui.getSnapshot().primary, secondary);
  assert.ok(service.get(right!), "collapsing killed the other terminal");
  assertConsistent(ui);
});

test("splitting with no terminal at all fills both panes", async () => {
  const { ui, service } = await setup();
  ui.toggleSplit();
  assert.equal(service.list().length, 2);
  assert.notEqual(ui.getSnapshot().primary, null);
  assert.notEqual(ui.getSnapshot().secondary, null);
  assertConsistent(ui);
});

test("choosing a tab or stepping never puts one session in both panes", async () => {
  const { ui } = await setup();
  const a = ui.newTerminal();
  const b = ui.newTerminal();
  const c = ui.newTerminal();
  ui.activate(a);
  ui.toggleSplit(); // a | c (the newest other)
  const right = ui.getSnapshot().secondary!;
  // The other pane's tab focuses that pane rather than collapsing the split.
  ui.activate(right);
  assert.deepEqual([ui.getSnapshot().primary, ui.getSnapshot().secondary], [a, right]);
  assert.equal(ui.getSnapshot().focused, "secondary");
  // Stepping through the focused pane skips the session in the other one.
  for (let i = 0; i < 6; i++) {
    ui.stepTerminal(1);
    assertConsistent(ui);
  }
  ui.stepPane();
  ui.stepTerminal(-1);
  assertConsistent(ui);
  assert.ok([a, b, c].includes(ui.focusedId()!));
});

test("a terminal that exits or is closed elsewhere leaves the panes valid", async () => {
  const { ui, service } = await setup();
  const a = ui.newTerminal();
  ui.toggleSplit();
  const b = ui.getSnapshot().secondary!;
  await service.kill(b);
  assertConsistent(ui);
  assert.equal(ui.getSnapshot().primary, a);
  await service.close(a);
  assert.equal(ui.getSnapshot().primary, null);
  assertConsistent(ui);
});

test("actions name their terminal: closing, renaming or restarting one never touches another", async () => {
  const { ui, service, fake } = await setup();
  const a = ui.newTerminal();
  ui.toggleSplit();
  const b = ui.getSnapshot().secondary!;
  await settle();
  ui.rename(b, "Builds");
  assert.equal(service.get(b)!.title, "Builds");
  assert.equal(service.get(a)!.title, "Command Prompt");
  const aGeneration = service.get(a)!.generation;
  ui.restart(b);
  assert.equal(service.get(a)!.generation, aGeneration, "restarting b restarted a");
  await settle();
  ui.close(b);
  await settle();
  assert.ok(service.get(a));
  assert.equal(
    fake.calls
      .filter((c) => c.command === "close")
      .map((c) => (c.args as { sessionId: string }).sessionId)
      .join(),
    b,
  );
});

test("bells, notices and search results belong to one terminal each", async () => {
  const { ui, service } = await setup();
  const a = ui.newTerminal();
  const b = ui.newTerminal();
  await settle();
  ui.activate(a);
  ui.ring(b);
  ui.ring(a); // in front: not marked
  assert.deepEqual([...ui.getSnapshot().bells], [b]);
  ui.notice(b, "The clipboard is not available.");
  ui.setMatches(b, { index: 0, count: 3 });
  const snapshot = ui.getSnapshot();
  // The status line is the focused terminal's: a's, which has no notice.
  assert.equal(statusOf(snapshot, service.get(a)), "Running");
  assert.equal(statusOf(snapshot, service.get(b)), "The clipboard is not available.");
  assert.equal(snapshot.matches.get(a), undefined);
  // Showing b clears its bell.
  ui.activate(b);
  assert.deepEqual([...ui.getSnapshot().bells], []);
  // Closing b drops everything that was b's.
  ui.close(b);
  await settle();
  assert.equal(ui.getSnapshot().notices.has(b), false);
  assert.equal(ui.getSnapshot().matches.has(b), false);
});

test("views register by terminal, and a late unregister never removes a newer view", async () => {
  const { ui } = await setup();
  const a = ui.newTerminal();
  const handle = (): TerminalViewHandle => ({
    focus() {},
    clear() {},
    search() {},
    endSearch() {},
    copySelection() {},
    paste() {},
    selectAll() {},
    hasSelection: () => false,
  });
  const first = handle();
  const second = handle();
  const unregisterFirst = ui.registerView(a, first);
  ui.registerView(a, second); // a remount
  unregisterFirst(); // the old view's cleanup, late
  assert.equal(ui.viewOf(a), second);
});

test("the layout outlives the panel: a remount finds the same panes, zoom and split", async () => {
  const { ui } = await setup();
  ui.newTerminal();
  ui.toggleSplit();
  ui.setSplitRatio(0.7);
  ui.zoom("zoom-in");
  const before = ui.getSnapshot();
  // A panel remount reads the same UI; nothing about the panes is reset or recreated.
  const after = ui.getSnapshot();
  assert.equal(after, before);
  assert.equal(after.splitRatio, 0.7);
  assert.ok(after.fontSize > 12);
  assert.ok(after.secondary !== null);
});

test("no session is started by reading or subscribing", async () => {
  const { ui, service, fake } = await setup();
  const opens = fake.count("open");
  ui.subscribe(() => {});
  ui.getSnapshot();
  ui.focusedId();
  assert.equal(fake.count("open"), opens);
  assert.deepEqual(service.list(), []);
  assert.equal(ui.getSnapshot().primary, null as TerminalId | null);
});
