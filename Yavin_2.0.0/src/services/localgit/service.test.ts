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
