import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import {
  atLeast,
  channelLines,
  createOutputChannel,
  outputChannels,
  outputVersion,
  resetOutputChannels,
  subscribeOutput,
} from "./output.ts";

beforeEach(() => resetOutputChannels());

test("a channel keeps what is written to it, in order", () => {
  const channel = createOutputChannel("Git");
  channel.appendLine("first");
  channel.appendLine("second");
  assert.deepEqual(
    channel.lines().map((line) => line.text),
    ["first", "second"],
  );
});

test("one call carrying several lines becomes several lines", () => {
  // So filtering and scrolling work per line, however the writer batched it.
  const channel = createOutputChannel("Git");
  channel.appendLine("one\ntwo\nthree");
  assert.equal(channel.lines().length, 3);
});

test("channels are separate: clearing one leaves the others untouched", () => {
  // The whole reason output is keyed by channel rather than being one log.
  const git = createOutputChannel("Git");
  const tasks = createOutputChannel("Tasks");
  git.appendLine("a git line");
  tasks.appendLine("a task line");

  git.clear();
  assert.equal(git.lines().length, 0);
  assert.deepEqual(
    tasks.lines().map((line) => line.text),
    ["a task line"],
  );
});

test("asking for the same channel twice returns the same one, not a second copy", () => {
  // Subsystems ask for their channel wherever they first need it, with no ordering rules.
  const first = createOutputChannel("Git");
  first.appendLine("written through the first handle");
  const second = createOutputChannel("Git");
  assert.equal(second.lines().length, 1);
  assert.equal(outputChannels().length, 1);
});

test("channels are listed by name for the picker", () => {
  createOutputChannel("Tasks");
  createOutputChannel("Git");
  assert.deepEqual(
    outputChannels().map((channel) => channel.name),
    ["Git", "Tasks"],
  );
});

test("lines carry a level so failures can be told from ordinary output", () => {
  const channel = createOutputChannel("Git");
  channel.appendLine("ran fine");
  channel.appendLine("could not read from remote", "error");
  assert.deepEqual(
    channel.lines().map((line) => line.level),
    ["info", "error"],
  );
});

test("a level filter includes everything at or above it", () => {
  assert.equal(atLeast("error", "warn"), true);
  assert.equal(atLeast("warn", "warn"), true);
  assert.equal(atLeast("info", "warn"), false);
  assert.equal(atLeast("trace", "trace"), true);
});

test("a channel is capped, dropping the oldest rather than growing without bound", () => {
  const channel = createOutputChannel("Git");
  for (let i = 0; i < 5200; i++) channel.appendLine(`line ${i}`);
  const lines = channel.lines();
  assert.equal(lines.length, 5000);
  assert.equal(lines[0].text, "line 200");
  assert.equal(lines[lines.length - 1].text, "line 5199");
});

test("line ids stay unique as old lines are dropped, so list keys never collide", () => {
  const channel = createOutputChannel("Git");
  for (let i = 0; i < 5200; i++) channel.appendLine(`line ${i}`);
  const ids = new Set(channel.lines().map((line) => line.id));
  assert.equal(ids.size, channel.lines().length);
});

test("writing stays cheap when a build floods a channel", () => {
  // The snapshot is materialised only when something reads it, so a noisy build does not
  // pay to copy the whole buffer on every line.
  const channel = createOutputChannel("Tasks");
  const started = Date.now();
  for (let i = 0; i < 40_000; i++) channel.appendLine(`compiling module ${i}`);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `40,000 writes took ${elapsed}ms, which suggests O(n) per write`);
});

test("the snapshot is stable between changes and fresh after one", () => {
  const channel = createOutputChannel("Git");
  channel.appendLine("a");
  const before = channelLines(channel.id);
  assert.equal(before, channelLines(channel.id), "stable so useSyncExternalStore does not loop");
  channel.appendLine("b");
  assert.notEqual(before, channelLines(channel.id), "fresh so a render is triggered");
});

test("subscribers hear about writes, clears and new channels", () => {
  let calls = 0;
  const stop = subscribeOutput(() => calls++);
  const channel = createOutputChannel("Git");
  assert.equal(calls, 1, "creating a channel is a change");
  channel.appendLine("x");
  assert.equal(calls, 2);
  channel.clear();
  assert.equal(calls, 3);
  stop();
  channel.appendLine("y");
  assert.equal(calls, 3, "no longer notified");
});

test("the version advances with every change, for useSyncExternalStore", () => {
  const before = outputVersion();
  createOutputChannel("Git").appendLine("x");
  assert.ok(outputVersion() > before);
});

test("a handle keeps working after the registry is reset", () => {
  // `outputLog.ts` memoizes its handle for the life of the process, so a handle that stopped
  // writing after a reset silently black-holed every Git command from then on.
  const channel = createOutputChannel("Git");
  resetOutputChannels();
  channel.appendLine("after the reset");
  assert.deepEqual(
    channel.lines().map((line) => line.text),
    ["after the reset"],
  );
  assert.deepEqual(
    outputChannels().map((one) => one.name),
    ["Git"],
  );
});

test("a carriage return from a Windows pipe is not stored invisibly", () => {
  // It does not show on screen but does come back when the output is copied out.
  const channel = createOutputChannel("Git");
  channel.appendLine("one\r\ntwo");
  assert.deepEqual(
    channel.lines().map((line) => line.text),
    ["one", "two"],
  );
});
