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
