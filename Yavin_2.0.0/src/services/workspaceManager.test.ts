import assert from "node:assert/strict";
import test from "node:test";
import { EMPTY_WORKSPACE, createWorkspaceManager, workspaceIdOf } from "./workspaceManager.ts";

/** A fake service per workspace that records its life, and whose disposal can be held open. */
function recorder() {
  const log: string[] = [];
  let hold: Promise<void> | null = null;
  const manager = createWorkspaceManager(
    {
      create(id, folders) {
        log.push(`create ${folders.join(",") || "(none)"}`);
        return { id, folders, disposed: false };
      },
      async dispose(services) {
        log.push(`dispose ${services.folders.join(",") || "(none)"}`);
        if (hold) await hold;
        services.disposed = true;
      },
    },
    { log: (message) => log.push(message) },
  );
  return {
    manager,
    log,
    holdDisposal() {
      let release!: () => void;
      hold = new Promise((resolve) => (release = resolve));
      return () => {
        hold = null;
        release();
      };
    },
  };
}

test("a workspace's identity is its folders, however they are spelled", () => {
  assert.equal(workspaceIdOf([]), EMPTY_WORKSPACE);
  assert.equal(workspaceIdOf(["C:/Work/A"]), workspaceIdOf(["c:/work/a"]));
  assert.notEqual(workspaceIdOf(["/work/a"]), workspaceIdOf(["/work/A"]));
  assert.equal(workspaceIdOf(["/b", "/a"]), workspaceIdOf(["/a", "/b"]));
  assert.notEqual(workspaceIdOf(["/a"]), workspaceIdOf(["/a", "/b"]));
});

test("opening another folder disposes everything of the one left before creating the next", async () => {
  const { manager, log } = recorder();
  assert.equal(manager.current().id, EMPTY_WORKSPACE);
  let changes = 0;
  manager.subscribe(() => changes++);

  const a = await manager.open(["/a"]);
  const cleaned: string[] = [];
  a.own(() => void cleaned.push("a's timer"));
  a.own(async () => void cleaned.push("a's subscription"));
  const b = await manager.open(["/b"]);

  assert.deepEqual(log, [
    "create (none)",
    "dispose (none)",
    "create /a",
    "dispose /a",
    "create /b",
  ]);
  // Owned cleanups run after the services, newest first.
  assert.deepEqual(cleaned, ["a's subscription", "a's timer"]);
  assert.equal(a.state, "disposed");
  assert.ok(a.signal.aborted);
  assert.ok(a.services.disposed);
  assert.equal(manager.current(), b);
  assert.equal(b.state, "active");
  assert.equal(changes, 2);

  // The same folder again changes nothing.
  assert.equal(await manager.open(["/B/../b"]), b);
  assert.equal(changes, 2);

  // Something owned after its workspace went is undone at once, not kept.
  let late = false;
  a.own(() => void (late = true));
  await Promise.resolve();
  assert.ok(late);

  await manager.close();
  assert.equal(manager.current().id, EMPTY_WORKSPACE);
  assert.ok(b.services.disposed);
});

test("A → B → C quickly: the last folder wins, and nothing overlaps", async () => {
  const { manager, log, holdDisposal } = recorder();
  const a = await manager.open(["/a"]);
  const release = holdDisposal();
  const toB = manager.open(["/b"]);
  const toC = manager.open(["/c"]);
  // While A is still being disposed, neither B nor C exists.
  await Promise.resolve();
  assert.equal(a.state, "disposing");
  assert.ok(!log.includes("create /b") && !log.includes("create /c"));
  release();
  const [b, c] = await Promise.all([toB, toC]);
  assert.equal(b, c, "the superseded open reports the workspace that won");
  assert.deepEqual(c.folders, ["/c"]);
  assert.ok(!log.includes("create /b"), "B was never created");
  assert.equal(log.filter((line) => line === "dispose /a").length, 1);
  assert.equal(manager.current(), c);
});

test("a service that fails to dispose does not keep the rest from going", async () => {
  const log: string[] = [];
  const manager = createWorkspaceManager(
    {
      create: () => ({}),
      dispose() {
        throw new Error("watcher already gone");
      },
    },
    { log: (message) => log.push(message) },
  );
  const a = await manager.open(["/a"]);
  let cleaned = false;
  a.own(() => void (cleaned = true));
  await manager.open(["/b"]);
  assert.equal(a.state, "disposed");
  assert.ok(cleaned);
  assert.match(log[0], /watcher already gone/);
});

test("disposing the manager ends the workspace and replaces it with nothing", async () => {
  const { manager } = recorder();
  const a = await manager.open(["/a"]);
  await manager.dispose();
  assert.equal(a.state, "disposed");
});
