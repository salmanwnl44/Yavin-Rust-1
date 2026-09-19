import assert from "node:assert/strict";
import test from "node:test";
import { RepoStore } from "./store.ts";
import type { Repository } from "./repository.ts";

/**
 * A minimal stand-in for `Repository`, exposing only the methods `RepoStore`
 * actually calls (`refresh()`'s six fetches). Type-erased via `as unknown as
 * Repository`, matching the same convention `identity.test.ts` already uses for a
 * duck-typed `RepoEntry["store"]` -- real `Repository` instances need Tauri's
 * native bridge, which these tests deliberately avoid needing.
 */
function fakeRepository(
  calls: string[],
  overrides: Partial<Record<string, () => Promise<unknown>>> = {},
): Repository {
  const method = (name: string, defaultValue: unknown) => () => {
    calls.push(name);
    return overrides[name] ? overrides[name]!() : Promise.resolve(defaultValue);
  };
  return {
    root: "/work",
    status: method("status", ""),
    branchInfo: method("branchInfo", "# branch.head main\n"),
    branches: method("branches", [] as string[]),
    remotes: method("remotes", [] as string[]),
    stashList: method("stashList", ""),
    state: method("state", ""),
  } as unknown as Repository;
}

test("two overlapping refresh() calls for the same field share one Git process instead of two", async () => {
  const calls: string[] = [];
  let resolveStatus!: (value: string) => void;
  const repo = fakeRepository(calls, {
    status: () => new Promise<string>((resolve) => (resolveStatus = resolve)),
  });
  const store = new RepoStore(repo);

  const first = store.refresh(["entries"]);
  const second = store.refresh(["entries"]);
  assert.equal(
    calls.filter((c) => c === "status").length,
    1,
    "the second, overlapping call must not spawn its own status() process",
  );

  resolveStatus(" M a.ts\0");
  await Promise.all([first, second]);
  assert.equal(store.getSnapshot().entries.length, 1, "the shared call's result must still apply");
});

test("a scoped refresh already covered by an in-flight full refresh dedupes against it", async () => {
  const calls: string[] = [];
  let resolveStatus!: (value: string) => void;
  const repo = fakeRepository(calls, {
    status: () => new Promise<string>((resolve) => (resolveStatus = resolve)),
  });
  const store = new RepoStore(repo);

  const full = store.refresh(); // all six fields, including "entries"
  const scoped = store.refresh(["entries"]); // a subset of what's already in flight
  assert.equal(calls.filter((c) => c === "status").length, 1);

  resolveStatus(" M a.ts\0");
  await Promise.all([full, scoped]);
});

test("a full refresh started while a scoped one is in flight is not deduped (not a subset)", async () => {
  const calls: string[] = [];
  // Each status() call gets its own resolver -- the scoped and the (independent,
  // not deduped) full refresh both call status(), and both must be settled.
  const resolveStatusCalls: ((value: string) => void)[] = [];
  const repo = fakeRepository(calls, {
    status: () => new Promise<string>((resolve) => resolveStatusCalls.push(resolve)),
  });
  const store = new RepoStore(repo);

  const scoped = store.refresh(["entries"]);
  const full = store.refresh(); // needs branchInfo/branches/etc too -- not a subset of ["entries"]
  assert.ok(
    calls.some((c) => c === "branchInfo"),
    "the full refresh must run independently, not be silently dropped",
  );
  assert.equal(
    calls.filter((c) => c === "status").length,
    2,
    "status() itself is not deduped when the requests aren't subset-compatible",
  );

  for (const resolve of resolveStatusCalls) resolve(" M a.ts\0");
  await Promise.all([scoped, full]);
});

test("a failed refresh preserves the last-known entries and marks the snapshot stale, never showing false-clean data", async () => {
  const calls: string[] = [];
  let fail = false;
  const repo = fakeRepository(calls, {
    status: () => (fail ? Promise.reject(new Error("Git failed")) : Promise.resolve(" M a.ts\0")),
  });
  const store = new RepoStore(repo);

  await store.refresh(["entries"]);
  assert.equal(store.getSnapshot().entries.length, 1);
  assert.equal(store.getSnapshot().stale, false);

  fail = true;
  await store.refresh(["entries"]);
  assert.equal(
    store.getSnapshot().entries.length,
    1,
    "a failed refresh must never clear previously-known-good entries",
  );
  assert.equal(store.getSnapshot().stale, true);
  assert.match(store.getSnapshot().notice, /Git failed/);
});

test("a successful refresh clears a previously-set stale flag", async () => {
  const calls: string[] = [];
  let fail = true;
  const repo = fakeRepository(calls, {
    status: () => (fail ? Promise.reject(new Error("Git failed")) : Promise.resolve("")),
  });
  const store = new RepoStore(repo);

  await store.refresh(["entries"]);
  assert.equal(store.getSnapshot().stale, true);

  fail = false;
  await store.refresh(["entries"]);
  assert.equal(store.getSnapshot().stale, false);
});

test("lastRefreshedAt only advances on a successful refresh", async () => {
  const calls: string[] = [];
  let fail = true;
  const repo = fakeRepository(calls, {
    status: () => (fail ? Promise.reject(new Error("Git failed")) : Promise.resolve("")),
  });
  const store = new RepoStore(repo);

  assert.equal(store.lastRefreshedAt, 0);
  await store.refresh(["entries"]);
  assert.equal(store.lastRefreshedAt, 0, "a failed refresh must not advance lastRefreshedAt");

  fail = false;
  await store.refresh(["entries"]);
  assert.ok(store.lastRefreshedAt > 0, "a successful refresh must advance lastRefreshedAt");
});
