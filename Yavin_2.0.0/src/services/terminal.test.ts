import assert from "node:assert/strict";
import test from "node:test";
import {
  createTerminalId,
  describeExit,
  nextTerminalName,
  terminalKeyAction,
  usableSize,
} from "./terminal.ts";

test("terminal sizes are whole cells and never zero", () => {
  assert.deepEqual(usableSize(120, 40), { cols: 120, rows: 40 });
  // xterm reports 0 before layout; the shell would take that literally.
  assert.deepEqual(usableSize(0, 0), { cols: 80, rows: 24 });
  assert.deepEqual(usableSize(-5, -1), { cols: 1, rows: 1 });
  assert.deepEqual(usableSize(80.9, 24.7), { cols: 80, rows: 24 });
  assert.deepEqual(usableSize(Number.NaN, Number.NaN), { cols: 80, rows: 24 });
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
