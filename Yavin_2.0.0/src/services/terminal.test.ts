import assert from "node:assert/strict";
import test from "node:test";
import {
  createTerminalId,
  describeExit,
  nextTerminalName,
  terminalKeyAction,
  openArgsFor,
  onOutputFor,
  deliverForTest,
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
  assert.equal(terminalKeyAction(key("ArrowRight", { alt: true }), false), "pane-next");
  assert.equal(terminalKeyAction(key("ArrowLeft", { alt: true }), false), "pane-previous");
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

test("a plain session sends no profile extras, so the native side keeps its defaults", () => {
  const args = openArgsFor({ id: "t1", name: "Shell", shell: "/bin/bash" }, { cols: 80, rows: 24 });
  assert.deepEqual(args, { id: "t1", shell: "/bin/bash", cols: 80, rows: 24 });
  assert.equal("args" in args, false);
  assert.equal("env" in args, false);
  assert.equal("cwd" in args, false);
});

test("a profile's arguments, environment and folder all reach the native call", () => {
  const args = openArgsFor(
    {
      id: "t2",
      name: "PowerShell",
      shell: "pwsh.exe",
      args: ["-NoLogo"],
      env: { YAVIN: "1", TERM_PROGRAM: "Yavin" },
      cwd: "C:/work/sub",
    },
    { cols: 100, rows: 30 },
  );
  assert.deepEqual(args, {
    id: "t2",
    shell: "pwsh.exe",
    cols: 100,
    rows: 30,
    args: ["-NoLogo"],
    // Pairs, not an object: the native side keeps the author's ordering, which matters when
    // one variable is written in terms of another.
    env: [
      ["YAVIN", "1"],
      ["TERM_PROGRAM", "Yavin"],
    ],
    cwd: "C:/work/sub",
  });
});

test("empty profile extras are omitted rather than sent as empty", () => {
  const args = openArgsFor(
    { id: "t3", name: "Shell", shell: "/bin/sh", args: [], env: {}, cwd: "" },
    { cols: 80, rows: 24 },
  );
  assert.deepEqual(args, { id: "t3", shell: "/bin/sh", cols: 80, rows: 24 });
});

test("unsubscribing twice does not tear down a later subscription for the same terminal", () => {
  // The unsubscribe captured its own handler set; calling it again deleted whatever set a
  // newer subscription had since installed, silently stopping that terminal's output.
  const first: string[] = [];
  const second: string[] = [];
  const stopFirst = onOutputFor("t1", (data) => first.push(data));
  stopFirst();
  const stopSecond = onOutputFor("t1", (data) => second.push(data));
  stopFirst(); // the stale unsubscribe must be a no-op

  deliverForTest("terminal-output", { id: "t1", data: "hello" });
  assert.deepEqual(second, ["hello"]);
  assert.deepEqual(first, []);
  stopSecond();
});

test("one terminal's failing handler does not stop another from receiving output", () => {
  const seen: string[] = [];
  const stopBad = onOutputFor("t1", () => {
    throw new Error("handler blew up");
  });
  const stopGood = onOutputFor("t1", (data) => seen.push(data));

  assert.doesNotThrow(() => deliverForTest("terminal-output", { id: "t1", data: "still here" }));
  assert.deepEqual(seen, ["still here"]);
  stopBad();
  stopGood();
});
