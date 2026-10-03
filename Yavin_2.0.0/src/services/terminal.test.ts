import assert from "node:assert/strict";
import test from "node:test";
import {
  createTerminalId,
  describeExit,
  nextTerminalName,
  terminalKeyAction,
  openRequestFor,
  usableSize,
  createSubscriptionId,
} from "./terminal.ts";
import { isSubscriptionId, validateProfile } from "./terminalProtocol.ts";
import type { Generation, WorkspaceId } from "./terminalProtocol.ts";

test("terminal sizes are whole cells and never zero", () => {
  assert.deepEqual(usableSize(120, 40), { cols: 120, rows: 40 });
  // xterm reports 0 before layout; the shell would take that literally.
  assert.deepEqual(usableSize(0, 0), { cols: 80, rows: 24 });
  assert.deepEqual(usableSize(-5, -1), { cols: 1, rows: 1 });
  assert.deepEqual(usableSize(80.9, 24.7), { cols: 80, rows: 24 });
  assert.deepEqual(usableSize(Number.NaN, Number.NaN), { cols: 80, rows: 24 });
  // Never more than the contract allows, however wide the panel.
  assert.deepEqual(usableSize(4000, 2000), { cols: 1000, rows: 1000 });
});

test("terminal names stay distinct as more of the same shell open", () => {
  assert.equal(nextTerminalName([], "Command Prompt"), "Command Prompt");
  assert.equal(nextTerminalName(["Command Prompt"], "Command Prompt"), "Command Prompt (2)");
  assert.equal(
    nextTerminalName(["Command Prompt", "Command Prompt (2)"], "Command Prompt"),
    "Command Prompt (3)",
  );
  // A gap left by a closed terminal is reused rather than skipped.
  assert.equal(
    nextTerminalName(["Command Prompt", "Command Prompt (3)"], "Command Prompt"),
    "Command Prompt (2)",
  );
  assert.equal(nextTerminalName(["Command Prompt"], "Git Bash"), "Git Bash");
});

test("terminal identifiers are never reused", () => {
  const ids = new Set(Array.from({ length: 50 }, createTerminalId));
  assert.equal(ids.size, 50);
});

test("a finished shell distinguishes a clean exit from a failure", () => {
  assert.match(describeExit(0), /exited\.$/);
  assert.match(describeExit(1), /code 1/);
  assert.match(describeExit(130), /code 130/);
  assert.match(describeExit(null), /unexpectedly/);
});

test("Ctrl+C interrupts the program unless there is something to copy", () => {
  const press = (
    key: string,
    modifiers: { ctrl?: boolean; shift?: boolean; meta?: boolean } = {},
  ) =>
    ({
      key,
      type: "keydown",
      ctrlKey: !!modifiers.ctrl,
      shiftKey: !!modifiers.shift,
      metaKey: !!modifiers.meta,
    }) as unknown as KeyboardEvent;

  // The important case: Ctrl+C must reach the shell so a running program can be stopped.
  assert.equal(terminalKeyAction(press("c", { ctrl: true }), false), null);
  assert.equal(terminalKeyAction(press("c", { ctrl: true }), true), "copy");

  assert.equal(terminalKeyAction(press("c", { ctrl: true, shift: true }), false), "copy");
  assert.equal(terminalKeyAction(press("v", { ctrl: true, shift: true }), false), "paste");
  assert.equal(terminalKeyAction(press("f", { ctrl: true, shift: true }), false), "find");

  // macOS uses Command, which no shell claims.
  assert.equal(terminalKeyAction(press("v", { meta: true }), false), "paste");
  assert.equal(terminalKeyAction(press("c", { meta: true }), true), "copy");
  assert.equal(terminalKeyAction(press("c", { meta: true }), false), null);

  // Everything else belongs to the shell, including Ctrl+V and plain letters.
  assert.equal(terminalKeyAction(press("v", { ctrl: true }), false), null);
  assert.equal(terminalKeyAction(press("d", { ctrl: true }), false), null);
  assert.equal(terminalKeyAction(press("a"), false), null);
  // Key releases never act twice.
  assert.equal(
    terminalKeyAction(
      { key: "c", type: "keyup", ctrlKey: true, shiftKey: true, metaKey: false } as KeyboardEvent,
      true,
    ),
    null,
  );
});

/** A key press, with every modifier explicit so each test reads unambiguously. */
const key = (
  name: string,
  modifiers: { ctrl?: boolean; shift?: boolean; meta?: boolean; alt?: boolean } = {},
) =>
  ({
    key: name,
    type: "keydown",
    ctrlKey: !!modifiers.ctrl,
    shiftKey: !!modifiers.shift,
    metaKey: !!modifiers.meta,
    altKey: !!modifiers.alt,
  }) as unknown as KeyboardEvent;

test("the buffer can be scrolled with the keys every terminal uses", () => {
  assert.equal(terminalKeyAction(key("PageUp", { shift: true }), false), "scroll-page-up");
  assert.equal(terminalKeyAction(key("PageDown", { shift: true }), false), "scroll-page-down");
  assert.equal(terminalKeyAction(key("Home", { ctrl: true }), false), "scroll-top");
  assert.equal(terminalKeyAction(key("End", { ctrl: true }), false), "scroll-bottom");
});

test("Ctrl+PageUp/PageDown move between terminals", () => {
  assert.equal(terminalKeyAction(key("PageDown", { ctrl: true }), false), "next");
  assert.equal(terminalKeyAction(key("PageUp", { ctrl: true }), false), "previous");
});

test("Alt+Arrow moves between the panes of a split", () => {
  assert.equal(terminalKeyAction(key("ArrowRight", { alt: true }), false, true), "pane-next");
  assert.equal(terminalKeyAction(key("ArrowLeft", { alt: true }), false, true), "pane-previous");
});

test("Alt+Arrow reaches the shell when there is no split to move between", () => {
  // Option+Arrow is readline's move-by-word and several shells bind Alt+Arrow to history, so
  // claiming it unconditionally broke line editing for everyone not using splits.
  assert.equal(terminalKeyAction(key("ArrowRight", { alt: true }), false, false), null);
  assert.equal(terminalKeyAction(key("ArrowLeft", { alt: true }), false, false), null);
});

test("a plain arrow key still reaches the shell, so history and editing keep working", () => {
  // Alt is the modifier that claims arrows; without it they must go through untouched.
  assert.equal(terminalKeyAction(key("ArrowRight"), false), null);
  assert.equal(terminalKeyAction(key("ArrowLeft"), false), null);
  assert.equal(terminalKeyAction(key("ArrowUp"), false), null);
});

test("a plain PageUp reaches the shell -- only Shift and Ctrl claim it", () => {
  assert.equal(terminalKeyAction(key("PageUp"), false), null);
  assert.equal(terminalKeyAction(key("PageDown"), false), null);
  assert.equal(terminalKeyAction(key("Home"), false), null);
});

test("the navigation keys do not collide with the existing copy and zoom bindings", () => {
  assert.equal(terminalKeyAction(key("c", { ctrl: true, shift: true }), false), "copy");
  assert.equal(terminalKeyAction(key("=", { ctrl: true }), false), "zoom-in");
  assert.equal(terminalKeyAction(key("`", { ctrl: true, shift: true }), false), "new");
  assert.equal(terminalKeyAction(key("5", { ctrl: true, shift: true }), false), "split");
});

const size = { cols: 80, rows: 24 };
const workspace = "file://c:/work" as WorkspaceId;

const bash = {
  id: "user-1",
  name: "Bash (login)",
  executable: "/bin/bash",
  args: ["-i"],
  cwd: "tools",
  env: [
    ["BASE", "/opt"],
    ["TOOLS", "$BASE/tools"],
  ] as [string, string][],
  login: true,
};

test("a launch carries its profile whole, in the workspace that opens it", () => {
  const request = openRequestFor("t1", bash, null, size, 3 as Generation, workspace);
  assert.deepEqual(request, {
    sessionId: "t1",
    workspaceId: workspace,
    generation: 3,
    profile: bash,
    cwd: null,
    dimensions: size,
  });
  // A copy: the request never shares the profile's arrays.
  assert.notEqual(request.profile!.args, bash.args);
  assert.equal(validateProfile(request.profile!), null);
});

test("a folder asked for overrides the profile's; an empty one means none", () => {
  assert.equal(
    openRequestFor("t2", bash, "C:/work/sub", size, 1 as Generation, workspace).cwd,
    "C:/work/sub",
  );
  assert.equal(openRequestFor("t2", bash, "", size, 1 as Generation, workspace).cwd, null);
});

test("with no profile the native default shell starts", () => {
  assert.equal(openRequestFor("t3", null, null, size, 1 as Generation, workspace).profile, null);
});

test("every launch gets its own subscription id", () => {
  const ids = new Set(Array.from({ length: 20 }, () => createSubscriptionId("terminal-x-1")));
  assert.equal(ids.size, 20);
  for (const id of ids) assert.ok(isSubscriptionId(id), id);
});
