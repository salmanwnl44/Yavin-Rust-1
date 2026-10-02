import assert from "node:assert/strict";
import test from "node:test";
import {
  createTerminalId,
  describeExit,
  nextTerminalName,
  terminalKeyAction,
  openRequestFor,
  usableSize,
  streamReceiver,
  createSubscriptionId,
  type TerminalStreamHandlers,
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

test("a plain session is a profile of its shell alone, in the workspace that opens it", () => {
  const request = openRequestFor(
    { id: "t1", name: "Shell", shell: "/bin/bash" },
    size,
    3 as Generation,
    workspace,
  );
  assert.deepEqual(request, {
    sessionId: "t1",
    workspaceId: workspace,
    generation: 3,
    profile: {
      id: "/bin/bash",
      name: "Shell",
      executable: "/bin/bash",
      args: [],
      cwd: null,
      env: [],
    },
    cwd: null,
    dimensions: size,
  });
  assert.equal(validateProfile(request.profile!), null);
});

test("a profile's arguments, environment and folder all reach the open request", () => {
  const request = openRequestFor(
    {
      id: "t2",
      name: "PowerShell",
      shell: "pwsh.exe",
      args: ["-NoLogo"],
      env: { YAVIN: "1", TERM_PROGRAM: "Yavin" },
      cwd: "C:/work/sub",
    },
    { cols: 100, rows: 30 },
    1 as Generation,
    workspace,
  );
  assert.deepEqual(request.profile, {
    id: "pwsh.exe",
    name: "PowerShell",
    executable: "pwsh.exe",
    args: ["-NoLogo"],
    // Pairs, not an object: the native side keeps the author's ordering, which matters when
    // one variable is written in terms of another.
    env: [
      ["YAVIN", "1"],
      ["TERM_PROGRAM", "Yavin"],
    ],
    cwd: null,
  });
  assert.equal(request.cwd, "C:/work/sub");
  assert.deepEqual(request.dimensions, { cols: 100, rows: 30 });
});

test("with no shell picked the native default shell starts, and an empty folder means the root", () => {
  const request = openRequestFor(
    { id: "t3", name: "Terminal", shell: "", cwd: "" },
    size,
    1 as Generation,
    workspace,
  );
  assert.equal(request.profile, null);
  assert.equal(request.cwd, null);
});

const message = (kind: string, fields: Record<string, unknown>) => ({
  kind,
  sessionId: "t1",
  generation: 1,
  ...fields,
});
const output = (text: string, seq = 0, extra: Record<string, unknown> = {}) =>
  message("output", { seq, bytes: Buffer.from(text, "utf8").toString("base64"), ...extra });
const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("utf8");

/** A receiver for launch 1 of `t1`, recording what reaches each handler and every ack. */
function receiver(handlers: Partial<TerminalStreamHandlers> = {}) {
  const seen: string[] = [];
  const acks: number[] = [];
  const pendingAccepts: (() => void)[] = [];
  const receive = streamReceiver({ sessionId: "t1", generation: 1 }, (seq) => acks.push(seq), {
    output: (chunk, accepted) => {
      seen.push(`output ${chunk.seq} ${text(chunk.bytes)}`);
      pendingAccepts.push(accepted);
    },
    exit: (exit) => seen.push(`exit ${exit.exitCode}`),
    error: (event) => seen.push(`error ${event.error.code}`),
    detached: (event) => seen.push(`detached ${event.error.code}`),
    ...handlers,
  });
  return { receive, seen, acks, pendingAccepts };
}

test("a launch's channel delivers its own messages and drops everything else", () => {
  const { receive, seen } = receiver();
  receive(output("other session", 0, { sessionId: "t2" }));
  receive(output("other launch", 0, { generation: 2 }));
  // The old text event, and a chunk whose bytes are not base64: neither is the protocol.
  receive({ id: "t1", data: "old shape" });
  receive({ ...output(""), bytes: "not base64!" });
  receive(output("mine"));
  receive(message("exit", { exitCode: 0, lastSeq: 0 }));
  assert.deepEqual(seen, ["output 0 mine", "exit 0"]);
});

test("each chunk is acknowledged once, when the terminal says it has consumed it", () => {
  const { receive, acks, pendingAccepts } = receiver();
  receive(output("a", 0));
  receive(output("b", 1));
  // Nothing is acknowledged before the terminal has parsed it.
  assert.deepEqual(acks, []);
  pendingAccepts[1]();
  pendingAccepts[0]();
  pendingAccepts[0](); // a second call for the same chunk changes nothing
  assert.deepEqual(acks, [1, 0]);
});

test("errors and detachment reach the view, and a throwing handler stops nothing", () => {
  const { receive, seen } = receiver({
    exit: () => {
      throw new Error("handler blew up");
    },
  });
  assert.doesNotThrow(() => receive(message("exit", { exitCode: 1, lastSeq: null })));
  receive(
    message("error", {
      error: { code: "ProcessFailed", message: "Lost track of the shell." },
      lastSeq: null,
    }),
  );
  receive(
    message("detached", {
      error: { code: "OutputOverflow", message: "Fell behind." },
      lastSeq: 3,
    }),
  );
  assert.deepEqual(seen, ["error ProcessFailed", "detached OutputOverflow"]);
});

test("every launch gets its own subscription id", () => {
  const ids = new Set(Array.from({ length: 20 }, () => createSubscriptionId("terminal-x-1")));
  assert.equal(ids.size, 20);
  for (const id of ids) assert.ok(isSubscriptionId(id), id);
});
