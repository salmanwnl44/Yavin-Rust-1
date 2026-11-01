import assert from "node:assert/strict";
import test from "node:test";
import { asResourceChangeBatch, asWatcherStatus, createWatchTracker } from "./resourceEvents.ts";
import type { ResourceChangeBatch } from "./resourceEvents.ts";

const batch = (generation: number, root = "C:/Work"): ResourceChangeBatch => ({
  generation,
  root,
  changes: [],
  rescan: [],
});

test("a batch from the native watcher is read as the typed contract", () => {
  assert.deepEqual(
    asResourceChangeBatch({
      generation: 3,
      root: "C:/Work",
      changes: [
        { kind: "created", path: "C:/Work/a.ts" },
        { kind: "modified", path: "C:/Work/b.ts", operation: 7 },
        { kind: "deleted", path: "C:/Work/c.ts" },
        { kind: "renamed", path: "C:/Work/e.ts", from: "C:/Work/d.ts" },
      ],
      rescan: ["C:/Work/target"],
    }),
    {
      generation: 3,
      root: "C:/Work",
      changes: [
        { kind: "created", path: "C:/Work/a.ts" },
        { kind: "modified", path: "C:/Work/b.ts", operation: 7 },
        { kind: "deleted", path: "C:/Work/c.ts" },
        { kind: "renamed", path: "C:/Work/e.ts", from: "C:/Work/d.ts" },
      ],
      rescan: ["C:/Work/target"],
    },
  );
});

test("a malformed change is dropped and turns into a rescan, the rest of the batch stands", () => {
  const read = asResourceChangeBatch({
    generation: 1,
    root: "/w",
    changes: [
      { kind: "created", path: "/w/a" },
      { kind: "renamed", path: "/w/b" }, // no `from`
      { kind: "teleported", path: "/w/c" },
      { kind: "modified", path: "" },
      "nonsense",
      { kind: "modified", path: "/w/d", operation: -1 }, // an invalid id is simply not kept
    ],
    rescan: ["/w/x", 5, ""],
  });
  assert.deepEqual(read, {
    generation: 1,
    root: "/w",
    changes: [
      { kind: "created", path: "/w/a" },
      { kind: "modified", path: "/w/d" },
    ],
    rescan: ["/w/x", "/w"],
  });
});

test("payloads that are not batches or statuses are refused", () => {
  for (const value of [
    null,
    undefined,
    "x",
    {},
    { generation: -1, root: "/w", changes: [], rescan: [] },
    { generation: 1.5, root: "/w", changes: [], rescan: [] },
    { generation: 1, root: "", changes: [], rescan: [] },
    { generation: 1, root: "/w", changes: {}, rescan: [] },
  ])
    assert.equal(asResourceChangeBatch(value), null, JSON.stringify(value));
  assert.equal(asWatcherStatus({ generation: 1, root: "/w", state: "sleeping" }), null);
  assert.deepEqual(asWatcherStatus({ generation: 2, root: "/w", state: "failed", message: "x" }), {
    generation: 2,
    root: "/w",
    state: "failed",
    message: "x",
  });
});

test("only batches from the newest watch of the open folder are applied", () => {
  const tracker = createWatchTracker();
  tracker.status({ generation: 4, root: "C:/Work", state: "watching" });
  assert.equal(tracker.accept(batch(4), "C:/Work"), true);
  // From the watch this one replaced: stale, however late it arrives.
  assert.equal(tracker.accept(batch(3), "C:/Work"), false);
  // For another folder, even a current generation.
  assert.equal(tracker.accept(batch(4, "C:/Other"), "C:/Work"), false);
  assert.equal(tracker.accept(batch(4, "C:/Work2"), "C:/Work"), false);
  // Nothing open.
  assert.equal(tracker.accept(batch(4), ""), false);
  // The same folder, spelled as Windows would equally accept.
  assert.equal(tracker.accept(batch(4, "c:/work"), "C:/Work"), true);
  // A newer watch whose status has not arrived yet is the current one from now on.
  assert.equal(tracker.accept(batch(6), "C:/Work"), true);
  assert.equal(tracker.accept(batch(5), "C:/Work"), false);
  assert.equal(tracker.generation, 6);
});

test("a status from a replaced watch is ignored, a failure to start never is", () => {
  const tracker = createWatchTracker();
  assert.ok(tracker.status({ generation: 2, root: "/w", state: "watching" }));
  assert.equal(tracker.status({ generation: 1, root: "/w", state: "failed" }), null);
  assert.equal(tracker.current?.state, "watching");
  const failed = tracker.status({ generation: 0, root: "/w", state: "failed", message: "denied" });
  assert.equal(failed?.state, "failed");
  assert.equal(tracker.current?.message, "denied");
  // Generations only move forward.
  assert.equal(tracker.generation, 2);
});

test("property: an older generation is never accepted after a newer one", () => {
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
  for (let round = 0; round < 200; round++) {
    const tracker = createWatchTracker();
    let newest = 0;
    for (let step = 0; step < 50; step++) {
      const generation = next() % 20;
      const accepted = tracker.accept(batch(generation), "C:/Work");
      assert.equal(accepted, generation >= newest, `${generation} after ${newest}`);
      newest = Math.max(newest, generation);
    }
  }
});
