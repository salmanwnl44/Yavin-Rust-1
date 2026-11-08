import assert from "node:assert/strict";
import test from "node:test";
import { createTaskDiscovery } from "./taskDiscovery.ts";
import type { ResolvedTask } from "./model.ts";
import type { ResourceChangeBatch, ResourceChange } from "../resourceEvents.ts";

const settle = () => new Promise((r) => setTimeout(r, 0));

/** Controllable timers so debouncing is deterministic (no real waiting). */
function fakeTimers() {
  let seq = 0;
  const pending = new Map<number, () => void>();
  return {
    setTimer: (fn: () => void) => {
      const handle = ++seq;
      pending.set(handle, fn);
      return handle;
    },
    clearTimer: (handle: unknown) => pending.delete(handle as number),
    /** Fire all pending debounce callbacks. */
    flush: () => {
      const fns = [...pending.values()];
      pending.clear();
      fns.forEach((fn) => fn());
    },
    count: () => pending.size,
  };
}

/** A fake of the existing `onResourceChanges` the test can emit into. */
function fakeWatch() {
  const handlers = new Set<(batch: ResourceChangeBatch) => void>();
  return {
    subscribe: (handler: (batch: ResourceChangeBatch) => void) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    emit: (batch: ResourceChangeBatch) => handlers.forEach((handler) => handler(batch)),
    subscribers: () => handlers.size,
  };
}

function batch(
  root: string,
  changes: ResourceChange[],
  rescan: string[] = [],
): ResourceChangeBatch {
  return { generation: 1, root, changes, rescan };
}

const changed = (path: string, kind: ResourceChange["kind"] = "modified"): ResourceChange =>
  kind === "renamed" ? { kind, path, from: path } : { kind, path };

test("discovers once on create, then re-discovers when a manifest changes (debounced)", async () => {
  const timers = fakeTimers();
  const watch = fakeWatch();
  const files: Record<string, string> = { "/w/package.json": '{"scripts":{"build":"tsc"}}' };
  const results: ResolvedTask[][] = [];
  const d = createTaskDiscovery({
    folders: ["/w"],
    read: async (p) => files[p] ?? null,
    subscribe: watch.subscribe,
    onTasks: (tasks) => results.push([...tasks]),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  await settle();
  assert.deepEqual(
    results.at(-1)?.map((t) => t.id),
    ["npm:build"],
    "initial discovery ran",
  );

  // A manifest changes: its new scripts are picked up after the debounce fires.
  files["/w/package.json"] = '{"scripts":{"build":"tsc","test":"vitest"}}';
  watch.emit(batch("/w", [changed("/w/package.json")]));
  assert.equal(timers.count(), 1, "one debounced re-discovery is scheduled");
  timers.flush();
  await settle();
  assert.deepEqual(
    results.at(-1)?.map((t) => t.id),
    ["npm:build", "npm:test"],
  );
  d.dispose();
});

test("a burst of events debounces into a single re-discovery", async () => {
  const timers = fakeTimers();
  const watch = fakeWatch();
  let reads = 0;
  const d = createTaskDiscovery({
    folders: ["/w"],
    read: async (p) => {
      if (p.endsWith("package.json")) reads++;
      return null;
    },
    subscribe: watch.subscribe,
    onTasks: () => {},
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  await settle();
  const readsAfterInitial = reads;
  // Five rapid events (an editor save writes several times).
  for (let i = 0; i < 5; i++) watch.emit(batch("/w", [changed("/w/package.json")]));
  assert.equal(timers.count(), 1, "the burst collapsed to one pending timer");
  timers.flush();
  await settle();
  assert.equal(reads - readsAfterInitial, 1, "only one re-discovery ran for the whole burst");
  d.dispose();
});

test("a stale (slower) run never overwrites a newer result", async () => {
  const watch = fakeWatch();
  // Each package.json read is gated so the test controls which run finishes first. Run 0 is the
  // initial (slow); run 1 is a later refresh (fast) — the newer one must win.
  const gates: Array<() => void> = [];
  let call = 0;
  const outputs = ['{"scripts":{"old":"x"}}', '{"scripts":{"new":"y"}}'];
  const read = (p: string): Promise<string | null> => {
    if (!p.endsWith("package.json")) return Promise.resolve(null);
    const i = call++;
    return new Promise((resolve) => (gates[i] = () => resolve(outputs[i] ?? null)));
  };
  const results: string[][] = [];
  const d = createTaskDiscovery({
    folders: ["/w"],
    read,
    subscribe: watch.subscribe,
    onTasks: (tasks) => results.push(tasks.map((t) => t.id)),
    debounceMs: 0,
  });
  // run 0 (initial) is in flight and gated. Start run 1 (newer) without awaiting it.
  const newer = d.refreshNow();
  gates[1]?.(); // the newer run resolves first
  await newer;
  gates[0]?.(); // the stale initial run resolves late
  await settle();
  assert.ok(results.length > 0, "the newer run applied");
  assert.ok(
    results.every((ids) => !ids.includes("old")),
    `the stale run never overwrote the newer one: ${JSON.stringify(results)}`,
  );
  assert.deepEqual(results.at(-1), ["npm:new"], "the newest file state wins");
  d.dispose();
});

test("a change in another workspace (different root) is ignored — workspace isolation", async () => {
  const timers = fakeTimers();
  const watch = fakeWatch();
  const d = createTaskDiscovery({
    folders: ["/w"],
    read: async () => null,
    subscribe: watch.subscribe,
    onTasks: () => {},
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  await settle();
  watch.emit(batch("/other", [changed("/other/package.json")]));
  assert.equal(timers.count(), 0, "another workspace's change schedules nothing here");
  d.dispose();
});

test("an unrelated file change schedules no re-discovery", async () => {
  const timers = fakeTimers();
  const watch = fakeWatch();
  const d = createTaskDiscovery({
    folders: ["/w"],
    read: async () => null,
    subscribe: watch.subscribe,
    onTasks: () => {},
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  await settle();
  watch.emit(batch("/w", [changed("/w/src/index.ts"), changed("/w/README.md")]));
  assert.equal(timers.count(), 0, "unrelated files do not trigger discovery");
  // But a rescan (lost events) does, to be safe.
  watch.emit(batch("/w", [], ["/w/src"]));
  assert.equal(timers.count(), 1, "a rescan re-discovers");
  d.dispose();
});

test("deletion and rename of a manifest trigger re-discovery; a removed source's tasks disappear", async () => {
  const timers = fakeTimers();
  const watch = fakeWatch();
  const files: Record<string, string> = {
    "/w/package.json": '{"scripts":{"build":"tsc"}}',
    "/w/Cargo.toml": "[package]",
  };
  const results: string[][] = [];
  const d = createTaskDiscovery({
    folders: ["/w"],
    read: async (p) => files[p] ?? null,
    subscribe: watch.subscribe,
    onTasks: (tasks) => results.push(tasks.map((t) => t.id)),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  await settle();
  assert.ok(results.at(-1)!.includes("npm:build") && results.at(-1)!.includes("cargo:build"));

  // Delete package.json: its tasks disappear from the next run; Cargo survives.
  delete files["/w/package.json"];
  watch.emit(batch("/w", [changed("/w/package.json", "deleted")]));
  timers.flush();
  await settle();
  assert.deepEqual(
    results.at(-1),
    ["cargo:build", "cargo:test", "cargo:check", "cargo:clippy", "cargo:run"],
    "the deleted source's tasks are gone; the other source remains",
  );

  // A rename to a manifest also triggers re-discovery.
  files["/w/Makefile"] = "all:\n\techo";
  watch.emit(batch("/w", [{ kind: "renamed", path: "/w/Makefile", from: "/w/mk.txt" }]));
  timers.flush();
  await settle();
  assert.ok(results.at(-1)!.includes("make:all"), "the renamed-in Makefile is discovered");
  d.dispose();
});

test("a read failure keeps the last valid list (does not wipe tasks)", async () => {
  const timers = fakeTimers();
  const watch = fakeWatch();
  let failing = false;
  const files: Record<string, string> = { "/w/package.json": '{"scripts":{"build":"tsc"}}' };
  const results: string[][] = [];
  const d = createTaskDiscovery({
    folders: ["/w"],
    read: async (p) => {
      if (failing) throw new Error("read error");
      return files[p] ?? null;
    },
    subscribe: watch.subscribe,
    onTasks: (tasks) => results.push(tasks.map((t) => t.id)),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  await settle();
  const count = results.length;
  failing = true;
  watch.emit(batch("/w", [changed("/w/package.json")]));
  timers.flush();
  await settle();
  assert.equal(results.length, count, "a failed read publishes nothing — the last list stands");
  d.dispose();
});

test("dispose unsubscribes from the watch and ignores later events (no leaks)", async () => {
  const timers = fakeTimers();
  const watch = fakeWatch();
  const d = createTaskDiscovery({
    folders: ["/w"],
    read: async () => null,
    subscribe: watch.subscribe,
    onTasks: () => {},
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  await settle();
  assert.equal(watch.subscribers(), 1, "subscribed while live");
  d.dispose();
  assert.equal(watch.subscribers(), 0, "unsubscribed on dispose");
  watch.emit(batch("/w", [changed("/w/package.json")]));
  assert.equal(timers.count(), 0, "events after dispose do nothing");
});

test("monorepo: sub-packages are discovered, and adding a package re-discovers it live", async () => {
  const timers = fakeTimers();
  const watch = fakeWatch();
  const files: Record<string, string> = {
    "/w/package.json": '{"workspaces":["packages/*"]}',
    "/w/packages/web/package.json": '{"name":"web","scripts":{"build":"vite"}}',
  };
  // A mutable directory tree the test grows between events.
  const dirs: Record<string, { name: string; isDir: boolean }[]> = {
    "/w": [{ name: "packages", isDir: true }],
    "/w/packages": [{ name: "web", isDir: true }],
  };
  const results: string[][] = [];
  const d = createTaskDiscovery({
    folders: ["/w"],
    read: async (p) => files[p] ?? null,
    listDir: async (p) => dirs[p] ?? null,
    subscribe: watch.subscribe,
    onTasks: (tasks) => results.push(tasks.map((t) => t.id)),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  await settle();
  assert.deepEqual(results.at(-1), ["npm:packages.web:build"], "the sub-package was discovered");

  // A new package is added: its manifest appears and the directory now lists it.
  files["/w/packages/api/package.json"] = '{"name":"api","scripts":{"build":"tsc"}}';
  dirs["/w/packages"] = [
    { name: "web", isDir: true },
    { name: "api", isDir: true },
  ];
  // The watch reports the created manifest (basename `package.json` is a discovery file).
  watch.emit(batch("/w", [changed("/w/packages/api/package.json", "created")]));
  assert.equal(timers.count(), 1, "the new manifest schedules a re-discovery");
  timers.flush();
  await settle();
  assert.deepEqual(
    results.at(-1),
    ["npm:packages.web:build", "npm:packages.api:build"],
    "the newly added package's task appears without a new watcher",
  );
  d.dispose();
});

test("monorepo dependency graph refreshes live: adding a workspace dep adds a build edge", async () => {
  const timers = fakeTimers();
  const watch = fakeWatch();
  const files: Record<string, string> = {
    "/w/package.json": '{"workspaces":["packages/*"]}',
    "/w/packages/app/package.json": '{"name":"app","scripts":{"build":"vite"}}',
    "/w/packages/ui/package.json": '{"name":"ui","scripts":{"build":"tsup"}}',
  };
  const dirs: Record<string, { name: string; isDir: boolean }[]> = {
    "/w": [{ name: "packages", isDir: true }],
    "/w/packages": [
      { name: "app", isDir: true },
      { name: "ui", isDir: true },
    ],
  };
  const results: ResolvedTask[][] = [];
  const d = createTaskDiscovery({
    folders: ["/w"],
    read: async (p) => files[p] ?? null,
    listDir: async (p) => dirs[p] ?? null,
    subscribe: watch.subscribe,
    onTasks: (tasks) => results.push([...tasks]),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  await settle();
  const appBuild = () => results.at(-1)?.find((t) => t.id === "npm:packages.app:build");
  assert.deepEqual(appBuild()?.dependsOn, [], "no dependency yet");

  // app declares a workspace dependency on ui; after re-discovery the build edge appears.
  files["/w/packages/app/package.json"] =
    '{"name":"app","dependencies":{"ui":"workspace:*"},"scripts":{"build":"vite"}}';
  watch.emit(batch("/w", [changed("/w/packages/app/package.json")]));
  timers.flush();
  await settle();
  assert.deepEqual(
    appBuild()?.dependsOn,
    ["npm:packages.ui:build"],
    "app's build now depends on ui's build, discovered live",
  );
  d.dispose();
});

test("multi-root: a change under either root re-discovers; folder-qualified ids stay distinct", async () => {
  const timers = fakeTimers();
  const watch = fakeWatch();
  const files: Record<string, string> = {
    "/w/web/package.json": '{"scripts":{"build":"tsc"}}',
    "/w/api/Cargo.toml": "[package]",
  };
  const results: string[][] = [];
  const d = createTaskDiscovery({
    folders: ["/w/web", "/w/api"],
    read: async (p) => files[p] ?? null,
    subscribe: watch.subscribe,
    onTasks: (tasks) => results.push(tasks.map((t) => t.id)),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  await settle();
  assert.ok(
    results.at(-1)!.includes("npm:web:build") && results.at(-1)!.includes("cargo:api:build"),
  );
  // A change watched at the second root re-discovers.
  watch.emit(batch("/w/api", [changed("/w/api/Cargo.toml")]));
  assert.equal(timers.count(), 1);
  // A change at an unrelated root does not.
  watch.emit(batch("/w/elsewhere", [changed("/w/elsewhere/package.json")]));
  assert.equal(timers.count(), 1, "still just the one scheduled");
  d.dispose();
});
