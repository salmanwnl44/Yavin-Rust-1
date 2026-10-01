import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileUri, resourceId } from "../resource.ts";
import { LocalGitClosedError, asLocalGitError, createLocalGitService } from "./service.ts";
import type { LocalGitInvoke } from "./service.ts";
import type { LocalGitInfo } from "./types.ts";

const info = (handle: string): LocalGitInfo => ({
  handle,
  workspace: "ws-0123456789abcdef0123",
  mode: "writer",
  readOnlyReason: null,
  format: 1,
  revision: 0,
  head: { symbolic: "refs/heads/main", detached: null },
  headCommit: null,
  refCount: 0,
  objectCount: 0,
  segmentCount: 0,
  storageBytes: 0,
  folders: [{ folderId: "f-1", path: "C:/Work/Project" }],
  findings: [],
});

/** A native side whose answers the test releases when it chooses. */
function fakeNative() {
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  const pending: {
    command: string;
    resolve: (value: unknown) => void;
    reject: (e: unknown) => void;
  }[] = [];
  let next = 0;
  const invoke: LocalGitInvoke = (command, args) => {
    calls.push({ command, args });
    if (command === "localgit_close") return Promise.resolve(null);
    return new Promise((resolve, reject) => pending.push({ command, resolve, reject }));
  };
  const answer = async (command: string, value?: unknown) => {
    const at = pending.findIndex((one) => one.command === command);
    assert.ok(at >= 0, `nothing pending for ${command}`);
    const [one] = pending.splice(at, 1);
    one.resolve(value ?? (command === "localgit_open" ? info(`lg-${++next}`) : {}));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const fail = async (command: string, error: string) => {
    const at = pending.findIndex((one) => one.command === command);
    const [one] = pending.splice(at, 1);
    one.reject(error);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { invoke, calls, answer, fail };
}

test("the service opens the workspace's store and asks through its handle", async () => {
  const native = fakeNative();
  const service = createLocalGitService(
    ["C:/Work/Project"],
    { isActive: () => true },
    native.invoke,
  );
  await native.answer("localgit_open");
  const opened = await service.ready;
  assert.equal(opened.handle, "lg-1");
  assert.deepEqual(native.calls[0], {
    command: "localgit_open",
    args: { folders: ["C:/Work/Project"] },
  });
  const refs = service.refs();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await native.answer("localgit_refs", { revision: 3, head: {}, refs: {} });
  assert.equal((await refs).revision, 3);
  assert.deepEqual(native.calls[1], { command: "localgit_refs", args: { handle: "lg-1" } });
  await service.close();
  assert.deepEqual(native.calls.at(-1), { command: "localgit_close", args: { handle: "lg-1" } });
});

test("an answer that arrives after the workspace was left is dropped, not delivered", async () => {
  const native = fakeNative();
  let active = true;
  const service = createLocalGitService(["/a"], { isActive: () => active }, native.invoke);
  await native.answer("localgit_open");
  await service.ready;
  // Its outcome is taken now: it settles while the test is still busy elsewhere.
  const late = service.info().then(
    () => "delivered",
    (error: unknown) => error,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Workspace A is left while its request is in flight.
  active = false;
  await native.answer("localgit_info", info("lg-1"));
  assert.ok((await late) instanceof LocalGitClosedError);
  // And nothing more is asked.
  const before = native.calls.length;
  await assert.rejects(service.verify(true), LocalGitClosedError);
  assert.equal(native.calls.length, before);
});

test("a store that opens after its workspace went is handed straight back", async () => {
  const native = fakeNative();
  let active = true;
  const service = createLocalGitService(["/a"], { isActive: () => active }, native.invoke);
  active = false;
  await native.answer("localgit_open");
  await assert.rejects(service.ready, LocalGitClosedError);
  assert.deepEqual(native.calls.at(-1), { command: "localgit_close", args: { handle: "lg-1" } });
});

test("A → B → A: the second A is another service; the first A's late work never reaches it", async () => {
  const native = fakeNative();
  const contexts = [{ active: true }, { active: false }, { active: false }];
  const first = createLocalGitService(
    ["/a"],
    { isActive: () => contexts[0].active },
    native.invoke,
  );
  await native.answer("localgit_open");
  await first.ready;
  const lateFromFirst = first.readCommit("c".repeat(64)).then(
    () => "delivered",
    (error: unknown) => error,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  // A → B.
  contexts[0].active = false;
  await first.close();
  contexts[1].active = true;
  const b = createLocalGitService(["/b"], { isActive: () => contexts[1].active }, native.invoke);
  await native.answer("localgit_open");
  // B → A again: a new context.
  contexts[1].active = false;
  await b.close();
  contexts[2].active = true;
  const second = createLocalGitService(
    ["/a"],
    { isActive: () => contexts[2].active },
    native.invoke,
  );
  await native.answer("localgit_open");
  assert.equal((await second.ready).handle, "lg-3");
  // The first A's answer finally comes: it goes nowhere.
  await native.answer("localgit_read_commit", { id: "c".repeat(64) });
  assert.ok((await lateFromFirst) instanceof LocalGitClosedError);
  assert.equal(second.isClosed(), false);
});

test("native failures keep their code", async () => {
  assert.deepEqual(
    { ...asLocalGitError("ReadOnly: Another Yavin window is writing") },
    { code: "ReadOnly", name: "LocalGitError" },
  );
  assert.equal(asLocalGitError("ReadOnly: x").message, "x");
  assert.equal(asLocalGitError("something odd").code, "Unknown");
  const native = fakeNative();
  const service = createLocalGitService(["/a"], { isActive: () => true }, native.invoke);
  await native.fail("localgit_open", "WorkspaceMismatch: This Local Git store belongs to x");
  await assert.rejects(service.ready, (error: Error & { code?: string }) => {
    assert.equal(error.code, "WorkspaceMismatch");
    return true;
  });
});

test("workspace identities match the native side's (shared fixture)", () => {
  const cases = JSON.parse(
    readFileSync(new URL("./workspaceIds.fixtures.json", import.meta.url), "utf8"),
  ) as { input: string; id: string | null }[];
  for (const { input, id } of cases) {
    if (id === null) assert.throws(() => resourceId(fileUri(input)), input);
    else assert.equal(resourceId(fileUri(input)), id, input);
  }
});

// --- Snapshots and status (LG-02) ----------------------------------------------------------

/** A native side that answers at once, from handlers; every call is recorded. */
function scriptedNative(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  const invoke: LocalGitInvoke = async (command, args) => {
    calls.push({ command, args });
    if (command === "localgit_open") return info("lg-7");
    const handler = handlers[command];
    return handler ? handler(args) : null;
  };
  return { invoke, calls };
}

function overlaySource(docs: { key: string; version: number; text: string }[]) {
  let encodes = 0;
  return {
    get encodes() {
      return encodes;
    },
    docs,
    source: {
      overlays: () =>
        docs.map((doc) => ({
          key: doc.key,
          path: `/work/${doc.key}`,
          version: doc.version,
          encoding: "utf8",
          lineEnding: "lf",
          text: () => {
            encodes++;
            return doc.text;
          },
        })),
      untitled: () => [
        {
          id: "untitled:1",
          version: 2,
          encoding: "utf8",
          lineEnding: "lf",
          text: () => "scratch",
        },
      ],
    },
  };
}

test("each document version is sent once; snapshots name the versions they use", async () => {
  const native = scriptedNative({ localgit_snapshot: () => ({ sequence: 1 }) });
  const service = createLocalGitService(["/work"], { isActive: () => true }, native.invoke);
  const docs = overlaySource([
    { key: "a.ts", version: 3, text: "A" },
    { key: "b.ts", version: 1, text: "B" },
  ]);
  service.attachOverlays(docs.source);
  await service.snapshot();
  await service.snapshot({ persist: true });
  docs.docs[0].version = 4;
  docs.docs[0].text = "A2";
  await service.snapshot();

  const puts = native.calls.filter((c) => c.command === "localgit_put_overlays");
  assert.equal(puts.length, 2);
  assert.deepEqual(
    (puts[0].args.overlays as { key: string; version: number; text: string }[]).map((o) => [
      o.key,
      o.version,
      o.text,
    ]),
    [
      ["a.ts", 3, "A"],
      ["b.ts", 1, "B"],
    ],
  );
  // The second put has only the new version.
  assert.deepEqual(
    (puts[1].args.overlays as { key: string; version: number }[]).map((o) => [o.key, o.version]),
    [["a.ts", 4]],
  );
  assert.equal(docs.encodes, 3);
  const snaps = native.calls.filter((c) => c.command === "localgit_snapshot");
  assert.equal(snaps.length, 3);
  assert.deepEqual(snaps[1].args.overlays, [
    { key: "a.ts", version: 3 },
    { key: "b.ts", version: 1 },
  ]);
  assert.equal(snaps[1].args.persist, true);
  assert.deepEqual(snaps[1].args.untitled, []);
  assert.deepEqual(snaps[2].args.overlays, [
    { key: "a.ts", version: 4 },
    { key: "b.ts", version: 1 },
  ]);
  // Every job has its own id, and the handle is always the service's.
  assert.equal(new Set(snaps.map((s) => s.args.jobId)).size, 3);
  assert.ok(snaps.every((s) => s.args.handle === "lg-7"));
});

test("untitled documents are sent only for a snapshot that asks for them", async () => {
  const native = scriptedNative({ localgit_snapshot: () => ({}) });
  const service = createLocalGitService(["/work"], { isActive: () => true }, native.invoke);
  service.attachOverlays(overlaySource([]).source);
  await service.snapshot();
  assert.equal(native.calls.filter((c) => c.command === "localgit_put_overlays").length, 0);
  await service.snapshot({ includeUntitled: true, persist: true });
  const put = native.calls.find((c) => c.command === "localgit_put_overlays")!;
  assert.deepEqual(put.args.untitled, [
    { id: "untitled:1", text: "scratch", encoding: "utf8", lineEnding: "lf", version: 2 },
  ]);
  assert.deepEqual(native.calls.at(-1)!.args.untitled, [{ key: "untitled:1", version: 2 }]);
});

test("a pool that lost a version is sent everything again, once", async () => {
  let first = true;
  const native = scriptedNative({
    localgit_status: () => {
      if (first) {
        first = false;
        throw "OverlayMissing: version 3 of a.ts was not sent";
      }
      return { snapshot: {}, status: { total: 0 } };
    },
  });
  const service = createLocalGitService(["/work"], { isActive: () => true }, native.invoke);
  service.attachOverlays(overlaySource([{ key: "a.ts", version: 3, text: "A" }]).source);
  await service.status();
  const puts = native.calls.filter((c) => c.command === "localgit_put_overlays");
  assert.equal(puts.length, 2);
  const statuses = native.calls.filter((c) => c.command === "localgit_status");
  assert.equal(statuses.length, 2);
  assert.equal(statuses[1].args.limit, 5000);
  assert.equal(statuses[1].args.mode, "auto");
});

test("a superseded or cancelled job keeps its code", async () => {
  const native = scriptedNative({
    localgit_status: () => {
      throw "Cancelled: The operation was cancelled";
    },
  });
  const service = createLocalGitService(["/work"], { isActive: () => true }, native.invoke);
  await assert.rejects(service.status(), (error: Error & { code?: string }) => {
    assert.equal(error.code, "Cancelled");
    return true;
  });
  await service.cancel("job-9");
  assert.deepEqual(native.calls.at(-1), {
    command: "localgit_cancel",
    args: { handle: "lg-7", jobId: "job-9" },
  });
});

test("progress reaches only this service's listeners, while its workspace is active", async () => {
  let emit: (p: unknown) => void = () => {};
  const events = {
    onProgress(handler: (p: never) => void) {
      emit = handler as (p: unknown) => void;
      return () => (emit = () => {});
    },
  };
  let active = true;
  const native = scriptedNative({});
  const service = createLocalGitService(
    ["/work"],
    { isActive: () => active },
    native.invoke,
    events,
  );
  await service.ready;
  const seen: unknown[] = [];
  const stop = service.onProgress((p) => seen.push(p));
  emit({ handle: "lg-7", jobId: "job-1", phase: "scanning", files: 10 });
  emit({ handle: "lg-other", jobId: "job-1", phase: "scanning", files: 99 });
  active = false;
  emit({ handle: "lg-7", jobId: "job-2", phase: "scanning", files: 20 });
  assert.equal(seen.length, 1);
  stop();
});

test("a snapshot or status answering after the workspace was left is dropped", async () => {
  const native = fakeNative();
  let active = true;
  const service = createLocalGitService(["/a"], { isActive: () => active }, native.invoke);
  await native.answer("localgit_open");
  await service.ready;
  const snap = service.snapshot().then(
    () => "delivered",
    (error: unknown) => error,
  );
  const status = service.status().then(
    () => "delivered",
    (error: unknown) => error,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  // A → B while both are in flight.
  active = false;
  await native.answer("localgit_snapshot", { sequence: 1 });
  await native.answer("localgit_status", { snapshot: {}, status: {} });
  assert.ok((await snap) instanceof LocalGitClosedError);
  assert.ok((await status) instanceof LocalGitClosedError);
  // Nothing more goes out for the workspace left.
  const before = native.calls.length;
  await assert.rejects(service.snapshot({ persist: true }), LocalGitClosedError);
  assert.equal(native.calls.length, before);
});

// --- Checkpoints, commits, history, diff and restore (LG-03) -------------------------------

test("a commit and a checkpoint carry who and when, with the offset east of UTC", async () => {
  const native = scriptedNative({
    localgit_commit: () => ({ commit: { id: "c" }, revision: 1 }),
    localgit_checkpoint: () => ({ commit: { id: "k" }, revision: 2 }),
  });
  const service = createLocalGitService(
    ["/work"],
    { isActive: () => true },
    native.invoke,
    undefined,
    () => ({ name: "Ada", id: "ada@yavin" }),
  );
  service.attachOverlays(overlaySource([{ key: "a.ts", version: 3, text: "A" }]).source);
  await service.commit("message", { fromCheckpoint: "k1" });
  await service.checkpoint({ includeUntitled: true });
  const commit = native.calls.find((c) => c.command === "localgit_commit")!;
  assert.equal(commit.args.message, "message");
  assert.equal(commit.args.fromCheckpoint, "k1");
  // A commit takes exactly what is staged (the Local Index): no unsaved documents are sent.
  assert.equal(commit.args.overlays, undefined);
  const by = commit.args.by as { name: string; id: string; timeMs: number; tzOffsetMin: number };
  assert.equal(by.name, "Ada");
  assert.equal(by.tzOffsetMin, -new Date().getTimezoneOffset());
  assert.ok(Math.abs(by.timeMs - Date.now()) < 60_000);
  const checkpoint = native.calls.find((c) => c.command === "localgit_checkpoint")!;
  assert.deepEqual(checkpoint.args.untitled, [{ key: "untitled:1", version: 2 }]);
  assert.equal(checkpoint.args.message, null);
});

test("history, trees and diffs are asked for by id, with the defaults stated", async () => {
  const native = scriptedNative({});
  const service = createLocalGitService(["/work"], { isActive: () => true }, native.invoke);
  await service.history();
  await service.history({ cursor: "abc", limit: 5 });
  await service.tree("c1", "src");
  await service.diffCommits(null, "c2", { lineDiffs: false });
  await service.diffWorkspace();
  const args = (command: string) =>
    native.calls.filter((c) => c.command === command).map((c) => c.args);
  assert.deepEqual(args("localgit_history"), [
    { handle: "lg-7", cursor: null, limit: 100 },
    { handle: "lg-7", cursor: "abc", limit: 5 },
  ]);
  assert.deepEqual(args("localgit_tree"), [
    { handle: "lg-7", commit: "c1", folderId: null, path: "src" },
  ]);
  assert.deepEqual(args("localgit_diff_commits"), [
    { handle: "lg-7", from: null, to: "c2", lineDiffs: false },
  ]);
  const workspace = args("localgit_diff_workspace")[0];
  assert.equal(workspace.from, null);
  assert.equal(workspace.lineDiffs, true);
});

function restoreResult(status: string, operations: unknown[], applied = operations.length) {
  return {
    status,
    plan: {
      commit: "c",
      targetRoot: "r",
      scope: null,
      scopeFolder: null,
      policy: "refuseIfDirty",
      operations,
      conflicts: [],
      documents: [{ folderId: "f-1", path: "doc.txt", action: "overwrite", version: 4 }],
      unchanged: false,
      snapshotSequence: 1,
      diskRoot: "d",
    },
    conflicts: [],
    checkpoint: null,
    operation: 9,
    applied,
    error: null,
    verification: null,
  };
}

const op = (kind: string, path: string, expected = "file") => ({
  kind,
  folderId: "f-1",
  path,
  expected: { kind: expected },
  blob: null,
  size: null,
  executable: false,
  link: null,
});

test("a completed restore has its documents reconciled, by absolute path", async () => {
  const reconciled: unknown[] = [];
  const native = scriptedNative({
    localgit_restore: () =>
      restoreResult("completed", [
        op("removeFile", "old.txt"),
        op("createDirectory", "dir", "absent"),
        op("writeFile", "dir/new.txt", "absent"),
        op("writeFile", "doc.txt"),
      ]),
  });
  const service = createLocalGitService(
    ["C:/Work/Project"],
    { isActive: () => true },
    native.invoke,
  );
  service.attachOverlays({
    ...overlaySource([]).source,
    reconcileRestore: async (restored) => {
      reconciled.push(restored);
      return { ok: true, reloaded: [], closed: [], failed: [] };
    },
  });
  const outcome = await service.restore("c", { policy: "replaceDocument" });
  assert.equal(outcome.succeeded, true);
  const call = native.calls.find((c) => c.command === "localgit_restore")!;
  assert.equal(call.args.policy, "replaceDocument");
  assert.equal(call.args.dryRun, false);
  assert.deepEqual(reconciled, [
    {
      changes: [
        { kind: "deleted", path: "C:/Work/Project/old.txt" },
        { kind: "created", path: "C:/Work/Project/dir/new.txt" },
        { kind: "modified", path: "C:/Work/Project/doc.txt" },
      ],
      replace: [{ path: "C:/Work/Project/doc.txt", action: "overwrite" }],
    },
  ]);
});

test("a failed restore reconciles only what was done and never reports success", async () => {
  let restored: { changes: unknown[] } | null = null;
  const native = scriptedNative({
    localgit_restore: () =>
      restoreResult("failed", [op("writeFile", "a.txt"), op("writeFile", "b.txt")], 1),
  });
  const service = createLocalGitService(["/work"], { isActive: () => true }, native.invoke);
  service.attachOverlays({
    ...overlaySource([]).source,
    reconcileRestore: async (paths) => {
      restored = paths;
      return { ok: true, reloaded: [], closed: [], failed: [] };
    },
  });
  const outcome = await service.restore("c");
  assert.equal(outcome.succeeded, false);
  assert.equal(outcome.status, "failed");
  assert.deepEqual(restored!.changes, [{ kind: "modified", path: "C:/Work/Project/a.txt" }]);
});

test("a restore whose documents could not be reconciled is not a success", async () => {
  const native = scriptedNative({
    localgit_restore: () => restoreResult("completed", [op("writeFile", "a.txt")]),
  });
  const service = createLocalGitService(["/work"], { isActive: () => true }, native.invoke);
  service.attachOverlays({
    ...overlaySource([]).source,
    reconcileRestore: async () => ({
      ok: false,
      reloaded: [],
      closed: [],
      failed: [{ path: "a.txt", error: "locked" }],
    }),
  });
  const outcome = await service.restore("c");
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.succeeded, false);
});

test("a refused or dry-run restore touches no document", async () => {
  let reconciles = 0;
  for (const status of ["refused", "planned", "unchanged"]) {
    const native = scriptedNative({ localgit_restore: () => restoreResult(status, []) });
    const service = createLocalGitService(["/work"], { isActive: () => true }, native.invoke);
    service.attachOverlays({
      ...overlaySource([]).source,
      reconcileRestore: async () => {
        reconciles++;
        return { ok: true, reloaded: [], closed: [], failed: [] };
      },
    });
    const outcome = await service.restore("c", { dryRun: status === "planned" });
    assert.equal(outcome.succeeded, false);
    assert.equal(outcome.documents, null);
  }
  assert.equal(reconciles, 0);
});

test("a restore answering after its workspace was left is dropped; no document is touched", async () => {
  const native = fakeNative();
  let active = true;
  let reconciles = 0;
  const service = createLocalGitService(["/a"], { isActive: () => active }, native.invoke);
  service.attachOverlays({
    ...overlaySource([]).source,
    reconcileRestore: async () => {
      reconciles++;
      return { ok: true, reloaded: [], closed: [], failed: [] };
    },
  });
  await native.answer("localgit_open");
  const late = service.restore("c").then(
    () => "delivered",
    (error: unknown) => error,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  // A -> B while A's restore is in flight.
  active = false;
  await native.answer("localgit_restore", restoreResult("completed", [op("writeFile", "a.txt")]));
  assert.ok((await late) instanceof LocalGitClosedError);
  assert.equal(reconciles, 0);
});

// --- The Local Index, branches, tags and switching (LG-04) ---------------------------------

test("staging sends the paths and the unsaved documents; unstaging sends only paths", async () => {
  const native = scriptedNative({
    localgit_stage: () => ({ index: {}, changed: [], unchanged: [], unstored: [], snapshot: null }),
    localgit_unstage: () => ({
      index: {},
      changed: [],
      unchanged: [],
      unstored: [],
      snapshot: null,
    }),
    localgit_stage_hunks: () => ({
      index: {},
      changed: [],
      unchanged: [],
      unstored: [],
      snapshot: null,
    }),
  });
  const service = createLocalGitService(["/work"], { isActive: () => true }, native.invoke);
  service.attachOverlays(overlaySource([{ key: "a.ts", version: 3, text: "A" }]).source);
  await service.stage([{ path: "src/a.ts" }, { folderId: "f-1", path: "b.ts" }]);
  await service.stageAll();
  await service.unstage([{ path: "src/a.ts" }]);
  await service.unstageAll();
  await service.stageHunks({ path: "f.txt" }, [0, 2], { index: "i1", working: "w1" });
  const args = (command: string) =>
    native.calls.filter((c) => c.command === command).map((c) => c.args);
  const staged = args("localgit_stage");
  assert.deepEqual(staged[0].paths, [
    { folderId: null, path: "src/a.ts" },
    { folderId: "f-1", path: "b.ts" },
  ]);
  assert.equal(staged[0].all, false);
  assert.deepEqual(staged[0].overlays, [{ key: "a.ts", version: 3 }]);
  assert.equal(staged[1].all, true);
  assert.deepEqual(args("localgit_unstage"), [
    { handle: "lg-7", paths: [{ folderId: null, path: "src/a.ts" }], all: false },
    { handle: "lg-7", paths: [], all: true },
  ]);
  const hunks = args("localgit_stage_hunks")[0];
  assert.deepEqual(hunks.hunks, [0, 2]);
  assert.equal(hunks.expectedIndex, "i1");
  assert.equal(hunks.expectedWorking, "w1");
  assert.deepEqual(hunks.overlays, [{ key: "a.ts", version: 3 }]);
});

test("branches and tags are asked for by name, with HEAD's commit by default", async () => {
  const native = scriptedNative({});
  const service = createLocalGitService(["/work"], { isActive: () => true }, native.invoke);
  await service.createBranch("feature/x");
  await service.createBranch("from-there", "c1");
  await service.deleteBranch("feature/x");
  await service.createTag("v1");
  await service.tag("v1");
  await service.deleteTag("v1");
  const got = native.calls
    .filter((c) => c.command !== "localgit_open")
    .map((c) => [c.command, c.args]);
  assert.deepEqual(got, [
    ["localgit_create_branch", { handle: "lg-7", name: "feature/x", start: null }],
    ["localgit_create_branch", { handle: "lg-7", name: "from-there", start: "c1" }],
    ["localgit_delete_branch", { handle: "lg-7", name: "feature/x" }],
    ["localgit_create_tag", { handle: "lg-7", name: "v1", target: null }],
    ["localgit_get_tag", { handle: "lg-7", name: "v1" }],
    ["localgit_delete_tag", { handle: "lg-7", name: "v1" }],
  ]);
});

function switchResult(status: string, operations: unknown[]) {
  const restored = restoreResult(status, operations);
  return {
    status,
    plan: {
      branch: "feature",
      commit: "c2",
      from: "c1",
      revision: 4,
      sameCommit: false,
      restore: { ...restored.plan, documents: [] },
    },
    conflicts: [],
    operation: 3,
    applied: operations.length,
    error: null,
    verification: null,
    head: { kind: "branch", name: "feature", refName: "refs/heads/feature", commit: "c2" },
  };
}

test("a completed switch reconciles the documents it changed; a refused one touches none", async () => {
  const reconciled: unknown[] = [];
  const native = scriptedNative({
    localgit_switch: (args) =>
      args.dryRun
        ? switchResult("planned", [op("writeFile", "a.txt")])
        : args.branch === "blocked"
          ? switchResult("refused", [])
          : switchResult("completed", [op("writeFile", "a.txt"), op("removeFile", "b.txt")]),
  });
  const service = createLocalGitService(["/work"], { isActive: () => true }, native.invoke);
  service.attachOverlays({
    ...overlaySource([]).source,
    reconcileRestore: async (paths) => {
      reconciled.push(paths);
      return { ok: true, reloaded: [], closed: [], failed: [] };
    },
  });
  const done = await service.switchTo({ branch: "feature" });
  assert.equal(done.succeeded, true);
  assert.deepEqual(reconciled, [
    {
      changes: [
        { kind: "modified", path: "C:/Work/Project/a.txt" },
        { kind: "deleted", path: "C:/Work/Project/b.txt" },
      ],
      replace: [],
    },
  ]);
  const planned = await service.switchTo({ commit: "c9" }, { dryRun: true });
  assert.equal(planned.succeeded, false);
  const refused = await service.switchTo({ branch: "blocked" });
  assert.equal(refused.succeeded, false);
  assert.equal(reconciled.length, 1);
  const calls = native.calls.filter((c) => c.command === "localgit_switch").map((c) => c.args);
  assert.equal(calls[1].commit, "c9");
  assert.equal(calls[1].branch, null);
});

test("a switch answering after its workspace was left is dropped before any document", async () => {
  const native = fakeNative();
  let active = true;
  let reconciles = 0;
  const service = createLocalGitService(["/a"], { isActive: () => active }, native.invoke);
  service.attachOverlays({
    ...overlaySource([]).source,
    reconcileRestore: async () => {
      reconciles++;
      return { ok: true, reloaded: [], closed: [], failed: [] };
    },
  });
  await native.answer("localgit_open");
  const late = service.switchTo({ branch: "feature" }).then(
    () => "delivered",
    (error: unknown) => error,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  active = false;
  await native.answer("localgit_switch", switchResult("completed", [op("writeFile", "a.txt")]));
  assert.ok((await late) instanceof LocalGitClosedError);
  assert.equal(reconciles, 0);
});

// --- Reset, revert and stash (LG-05) -------------------------------------------------------

function diskResult(status: string, operations: unknown[]) {
  return restoreResult(status, operations).plan;
}

test("reset sends a typed target and policy; only a hard reset that changed the disk reconciles", async () => {
  const reconciled: unknown[] = [];
  const native = scriptedNative({
    localgit_reset: (args) =>
      args.mode === "hard"
        ? {
            status: "completed",
            mode: "hard",
            done: null,
            plan: { restore: diskResult("completed", [op("writeFile", "a.txt")]) },
            conflicts: [],
            operation: 1,
            applied: 1,
            error: null,
            verification: null,
            head: { kind: "detached", commit: "c1" },
          }
        : { status: "completed", mode: args.mode, done: {}, plan: null, applied: 0, head: {} },
  });
  const service = createLocalGitService(["/work"], { isActive: () => true }, native.invoke);
  service.attachOverlays({
    ...overlaySource([]).source,
    reconcileRestore: async (paths) => {
      reconciled.push(paths);
      return { ok: true, reloaded: [], closed: [], failed: [] };
    },
  });
  const soft = await service.reset({ commit: "c1" }, "soft");
  await service.reset({ tag: "v1" }, "mixed");
  const hard = await service.reset({ branch: "main" }, "hard", { policy: "allowDestructive" });
  assert.equal(soft.succeeded, true);
  assert.equal(soft.documents, null);
  assert.equal(hard.succeeded, true);
  assert.equal(reconciled.length, 1, "only the hard reset changed the disk");
  const calls = native.calls.filter((c) => c.command === "localgit_reset").map((c) => c.args);
  assert.deepEqual(calls[0].target, { kind: "commit", value: "c1" });
  assert.equal(calls[0].policy, "refuseIfDirty", "never destructive by default");
  assert.deepEqual(calls[1].target, { kind: "tag", value: "v1" });
  assert.deepEqual(calls[2].target, { kind: "branch", value: "main" });
  assert.equal(calls[2].policy, "allowDestructive");
});

test("revert and the stash commands send what they are given", async () => {
  const native = scriptedNative({
    localgit_revert: () => ({
      commit: null,
      reverted: "c2",
      conflicts: [],
      paths: [],
      revision: null,
    }),
    localgit_stash_push: () => ({
      status: "completed",
      stash: { id: "s1" },
      plan: { restore: diskResult("completed", [op("writeFile", "a.txt")]) },
      conflicts: [],
      operation: 1,
      applied: 1,
      error: null,
      verification: null,
    }),
    localgit_stash_apply: (args) => ({
      status: args.pop ? "failed" : "completed",
      plan: { restore: diskResult("completed", [op("writeFile", "a.txt")]) },
      conflicts: [],
      operation: 2,
      applied: 0,
      error: args.pop ? "disk full" : null,
      verification: null,
      kept: true,
    }),
  });
  const service = createLocalGitService(["/work"], { isActive: () => true }, native.invoke);
  service.attachOverlays({
    ...overlaySource([{ key: "a.ts", version: 1, text: "A" }]).source,
    reconcileRestore: async () => ({ ok: true, reloaded: [], closed: [], failed: [] }),
  });
  await service.revert("c2", { message: "Undo it" });
  const pushed = await service.stashPush({ includeUntracked: true });
  await service.stashList(5);
  const applied = await service.stashApply("s1");
  const popped = await service.stashPop("s1");
  await service.stashDrop("s1");
  assert.equal(pushed.succeeded, true);
  assert.equal(applied.succeeded, true);
  assert.equal(popped.succeeded, false, "a failed pop is never a success");
  assert.equal(popped.kept, true);
  const args = (command: string) =>
    native.calls.filter((c) => c.command === command).map((c) => c.args);
  assert.equal(args("localgit_revert")[0].message, "Undo it");
  assert.deepEqual(args("localgit_revert")[0].overlays, [{ key: "a.ts", version: 1 }]);
  assert.equal(args("localgit_stash_push")[0].includeUntracked, true);
  assert.deepEqual(args("localgit_stash_list"), [{ handle: "lg-7", limit: 5 }]);
  assert.deepEqual(
    args("localgit_stash_apply").map((a) => a.pop),
    [false, true],
  );
  assert.deepEqual(args("localgit_stash_drop"), [{ handle: "lg-7", id: "s1" }]);
});

test("a stash answering after its workspace was left is dropped before any document", async () => {
  const native = fakeNative();
  let active = true;
  let reconciles = 0;
  const service = createLocalGitService(["/a"], { isActive: () => active }, native.invoke);
  service.attachOverlays({
    ...overlaySource([]).source,
    reconcileRestore: async () => {
      reconciles++;
      return { ok: true, reloaded: [], closed: [], failed: [] };
    },
  });
  await native.answer("localgit_open");
  const late = service.stashPush().then(
    () => "delivered",
    (error: unknown) => error,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  active = false;
  await native.answer("localgit_stash_push", {
    status: "completed",
    stash: { id: "s1" },
    plan: { restore: diskResult("completed", [op("writeFile", "a.txt")]) },
    conflicts: [],
    operation: 1,
    applied: 1,
    error: null,
    verification: null,
  });
  assert.ok((await late) instanceof LocalGitClosedError);
  assert.equal(reconciles, 0);
});

// --- Merge and cherry-pick (LG-06) -------------------------------------------------------

function operationResult(status: string, outcome: string | null, operations: unknown[]) {
  return {
    status,
    outcome,
    plan: null,
    resolve: null,
    restore: operations.length ? diskResult("completed", operations) : null,
    conflicts: [],
    operation: operations.length ? 1 : null,
    applied: operations.length,
    error: null,
    verification: null,
    commit: null,
    state: null,
    head: { kind: "branch", name: "main", refName: "refs/heads/main", commit: "c1" },
  };
}

test("merge and cherry-pick send a typed target; a disk change, conflicted or not, reconciles", async () => {
  const reconciled: unknown[] = [];
  const native = scriptedNative({
    localgit_merge: (args) =>
      args.dryRun
        ? operationResult("planned", "merged", [op("writeFile", "a.txt")])
        : operationResult("completed", "conflicted", [op("writeFile", "a.txt")]),
    localgit_cherry_pick: () => operationResult("refused", "merged", []),
  });
  const service = createLocalGitService(["/work"], { isActive: () => true }, native.invoke);
  service.attachOverlays({
    ...overlaySource([]).source,
    reconcileRestore: async (paths) => {
      reconciled.push(paths);
      return { ok: true, reloaded: [], closed: [], failed: [] };
    },
  });
  const merged = await service.merge({ branch: "feature" });
  assert.equal(merged.outcome, "conflicted");
  assert.equal(merged.succeeded, true, "the step completed; its conflicts wait");
  assert.equal(reconciled.length, 1, "the conflict files written are reconciled");
  const planned = await service.merge({ tag: "v1" }, { dryRun: true, message: "Merge v1" });
  assert.equal(planned.documents, null);
  const refused = await service.cherryPick("c9");
  assert.equal(refused.succeeded, false);
  assert.equal(reconciled.length, 1, "nothing planned or refused touches a document");
  const calls = native.calls.filter((c) => c.command === "localgit_merge").map((c) => c.args);
  assert.deepEqual(calls[0].target, { kind: "branch", value: "feature" });
  assert.equal(calls[0].message, null);
  assert.deepEqual(calls[1].target, { kind: "tag", value: "v1" });
  assert.equal(calls[1].message, "Merge v1");
  assert.equal(calls[1].dryRun, true);
  const pick = native.calls.find((c) => c.command === "localgit_cherry_pick")!.args;
  assert.equal(pick.commit, "c9");
  assert.equal(pick.dryRun, false);
});

test("resolve, continue and abort are never destructive unless asked", async () => {
  const native = scriptedNative({
    localgit_operation: () => null,
    localgit_resolve: () => operationResult("completed", "resolved", []),
    localgit_continue: () => operationResult("completed", "continued", []),
    localgit_abort: () => operationResult("refused", null, []),
  });
  const service = createLocalGitService(["/work"], { isActive: () => true }, native.invoke);
  assert.equal(await service.operation(), null);
  await service.resolve({ path: "a.txt" }, "takeTheirs");
  await service.resolve({ folderId: "f-1", path: "b.txt" }, "delete", {
    policy: "allowDestructive",
  });
  const continued = await service.continueOperation({ message: "Merged by hand" });
  assert.equal(continued.outcome, "continued");
  const aborted = await service.abortOperation();
  assert.equal(aborted.succeeded, false);
  const args = (command: string) =>
    native.calls.filter((c) => c.command === command).map((c) => c.args);
  const [first, second] = args("localgit_resolve");
  assert.equal(first.folderId, null);
  assert.equal(first.path, "a.txt");
  assert.equal(first.resolution, "takeTheirs");
  assert.equal(first.policy, "refuseIfDirty");
  assert.equal(second.folderId, "f-1");
  assert.equal(second.policy, "allowDestructive");
  assert.equal(args("localgit_continue")[0].message, "Merged by hand");
  assert.equal(args("localgit_abort")[0].policy, "refuseIfDirty");
});

test("a merge answering after its workspace was left is dropped before any document", async () => {
  const native = fakeNative();
  let active = true;
  let reconciles = 0;
  const service = createLocalGitService(["/a"], { isActive: () => active }, native.invoke);
  service.attachOverlays({
    ...overlaySource([]).source,
    reconcileRestore: async () => {
      reconciles++;
      return { ok: true, reloaded: [], closed: [], failed: [] };
    },
  });
  await native.answer("localgit_open");
  const late = service.merge({ branch: "feature" }).then(
    () => "delivered",
    (error: unknown) => error,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  active = false;
  await native.answer(
    "localgit_merge",
    operationResult("completed", "merged", [op("writeFile", "a.txt")]),
  );
  assert.ok((await late) instanceof LocalGitClosedError);
  assert.equal(reconciles, 0);
});
