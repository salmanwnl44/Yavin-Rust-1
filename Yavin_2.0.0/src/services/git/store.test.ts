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
    refs: method("refs", { local: [] as string[], remote: [] as string[] }),
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

// Section 24's Race 1: "refresh A starts, switch to B, refresh B, A completes
// late" -- two different RepoStore instances (one per worktree) share no
// mutable state at all, so a late-resolving refresh on one can never touch the
// other's snapshot. Not a generation-guard scenario (that protects a store
// against ITS OWN stale results); this is a structural property of the class
// having no static/shared fields, verified directly rather than merely asserted.
test("two different RepoStore instances never share generation state -- a late refresh on one cannot affect the other", async () => {
  const callsA: string[] = [];
  let resolveA!: (value: string) => void;
  const storeA = new RepoStore(
    fakeRepository(callsA, {
      status: () => new Promise<string>((resolve) => (resolveA = resolve)),
    }),
  );
  const callsB: string[] = [];
  const storeB = new RepoStore(
    fakeRepository(callsB, { status: () => Promise.resolve(" M b.ts\0") }),
  );

  const pendingA = storeA.refresh(["entries"]); // "switch to B" happens conceptually here
  await storeB.refresh(["entries"]); // B's own refresh completes first
  assert.equal(storeB.getSnapshot().entries.length, 1);

  resolveA(" M a.ts\0"); // "A completes late"
  await pendingA;
  assert.equal(storeA.getSnapshot().entries.length, 1, "A's own result still applies to A");
  assert.equal(
    storeB.getSnapshot().entries.length,
    1,
    "B's snapshot is untouched by A's late completion",
  );
});

// Race 3: "operation completion + watcher event + focus refresh, all near-
// simultaneous" -- extends the two-caller dedup tests above to three
// simultaneous callers requesting the same (full) field set, proving the dedupe
// guard scales beyond the minimal two-caller case.
test("three simultaneous full-refresh calls (mutation completion, watcher, focus) dedupe into one Git process", async () => {
  const calls: string[] = [];
  let resolveStatus!: (value: string) => void;
  const repo = fakeRepository(calls, {
    status: () => new Promise<string>((resolve) => (resolveStatus = resolve)),
  });
  const store = new RepoStore(repo);

  const fromMutation = store.refresh();
  const fromWatcher = store.refresh();
  const fromFocus = store.refresh();
  assert.equal(
    calls.filter((c) => c === "status").length,
    1,
    "all three overlapping full refreshes must share the same single Git process",
  );

  resolveStatus(" M a.ts\0");
  await Promise.all([fromMutation, fromWatcher, fromFocus]);
  assert.equal(store.getSnapshot().entries.length, 1);
});

test("a refresh already running when a mutation starts is not adopted as the post-mutation refresh", async () => {
  const calls: string[] = [];
  const resolvers: Array<(value: string) => void> = [];
  const repo = fakeRepository(calls, {
    status: () => new Promise<string>((resolve) => resolvers.push(resolve)),
  });
  const store = new RepoStore(repo);

  const poll = store.refresh(["entries"]); // reads pre-mutation state
  const staged = store.guarded("stage", false, async () => "");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(resolvers.length, 2, "the post-mutation refresh must run its own status()");

  resolvers[0](" M a.ts\0"); // the older poll finishes late with pre-mutation data
  resolvers[1]("M  a.ts\0"); // the post-mutation read
  await Promise.all([poll, staged]);

  const [entry] = store.getSnapshot().entries;
  assert.equal(entry.index, "M", "the snapshot must reflect the state after the mutation");
  assert.equal(store.getSnapshot().loading, false);
});

test("a superseded refresh never leaves loading stuck", async () => {
  const calls: string[] = [];
  const resolvers: Array<(value: string) => void> = [];
  const repo = fakeRepository(calls, {
    status: () => new Promise<string>((resolve) => resolvers.push(resolve)),
  });
  const store = new RepoStore(repo);

  const poll = store.refresh(["entries"]);
  const staged = store.guarded("stage", false, async () => "");
  await new Promise((resolve) => setTimeout(resolve, 0));
  resolvers[1]("M  a.ts\0"); // the newer refresh settles first
  await staged;
  resolvers[0](" M a.ts\0"); // the superseded one settles last and is discarded
  await poll;

  assert.equal(store.getSnapshot().loading, false);
  assert.equal(store.getSnapshot().entries[0].index, "M");
});

test("a successful refresh clears the error text an earlier failed refresh left behind", async () => {
  const calls: string[] = [];
  let fail = true;
  const repo = fakeRepository(calls, {
    status: () => (fail ? Promise.reject(new Error("index.lock exists")) : Promise.resolve("")),
  });
  const store = new RepoStore(repo);

  await store.refresh(["entries"]);
  assert.match(store.getSnapshot().notice, /index\.lock/);
  assert.equal(store.getSnapshot().stale, true);

  fail = false;
  await store.refresh(["entries"]);
  assert.equal(store.getSnapshot().notice, "");
  assert.equal(store.getSnapshot().stale, false);
});

test("a refresh success does not erase an operation's own notice", async () => {
  const calls: string[] = [];
  const store = new RepoStore(fakeRepository(calls));
  await store.guarded("stage", false, async () => "Staged 1 file");
  await store.refresh(["entries"]);
  assert.equal(store.getSnapshot().notice, "Staged 1 file");
});

// The bug: a watcher's `refs` event (branch list) and `head` event (status + branch) start
// overlapping refreshes of DIFFERENT fields. A store-wide generation made the later one
// supersede the earlier and drop its result; the branch dropdown stayed stale until the
// next 5-second poll (measured in the real app: 3-5 s of lag).
for (const order of ["branches first", "status first"] as const) {
  test(`overlapping refreshes of different fields each apply (${order})`, async () => {
    const calls: string[] = [];
    let resolveBranches!: (v: { local: string[]; remote: string[] }) => void;
    let resolveStatus!: (v: string) => void;
    let resolveInfo!: (v: string) => void;
    const repo = fakeRepository(calls, {
      refs: () => new Promise<{ local: string[]; remote: string[] }>((r) => (resolveBranches = r)),
      status: () => new Promise<string>((r) => (resolveStatus = r)),
      branchInfo: () => new Promise<string>((r) => (resolveInfo = r)),
    });
    const store = new RepoStore(repo);

    const refs = store.refresh(["branches"]);
    const head = store.refresh(["entries", "branch"]); // starts while the first is in flight
    const settleBranches = () => resolveBranches({ local: ["main", "probe-br-1"], remote: [] });
    const settleHead = () => {
      resolveStatus(" M a.ts\0");
      resolveInfo("# branch.head probe-br-1\n");
    };
    if (order === "branches first") {
      settleBranches();
      settleHead();
    } else {
      settleHead();
      settleBranches();
    }
    await Promise.all([refs, head]);

    const snap = store.getSnapshot();
    assert.deepEqual(snap.branches, ["main", "probe-br-1"], "the branch list must not be dropped");
    assert.equal(snap.branch.name, "probe-br-1");
    assert.equal(snap.entries.length, 1);
    assert.equal(snap.loading, false);
  });
}

test("a newer refresh of the SAME field still wins over an older, slower one", async () => {
  const calls: string[] = [];
  const resolvers: Array<(v: { local: string[]; remote: string[] }) => void> = [];
  const repo = fakeRepository(calls, {
    refs: () => new Promise<{ local: string[]; remote: string[] }>((r) => resolvers.push(r)),
  });
  const store = new RepoStore(repo);

  const older = store.refresh(["branches"]);
  // Force a second, independent request for the same field (a full refresh is not a subset
  // match for a scoped one, so it runs its own fetch).
  const newer = store.refresh();
  resolvers[1]({ local: ["fresh"], remote: [] });
  await newer;
  resolvers[0]({ local: ["stale"], remote: [] }); // the older call finishes last with older data
  await older;

  assert.deepEqual(store.getSnapshot().branches, ["fresh"]);
});

test("a poll that finds the status unchanged keeps the entries it already had", async () => {
  // The array's identity is what the Source Control panel's effects and the explorer's
  // decorations key on. Re-parsing identical output made an equal array with a new identity,
  // so a poll that found nothing rebuilt the decoration maps and re-rendered the whole
  // window -- every five seconds, for every open repository.
  const repo = fakeRepository([], { status: () => Promise.resolve(" M a.ts\0") });
  const store = new RepoStore(repo);

  await store.refresh(["entries"]);
  const first = store.getSnapshot().entries;
  await store.refresh(["entries"]);
  assert.equal(store.getSnapshot().entries, first, "identical status must not rebuild the list");
});

test("a poll that finds the status changed produces a new list", async () => {
  let status = " M a.ts\0";
  const repo = fakeRepository([], { status: () => Promise.resolve(status) });
  const store = new RepoStore(repo);

  await store.refresh(["entries"]);
  const first = store.getSnapshot().entries;
  status = " M a.ts\0 M b.ts\0";
  await store.refresh(["entries"]);
  assert.notEqual(store.getSnapshot().entries, first);
  assert.equal(store.getSnapshot().entries.length, 2);
});

test("a refresh that changes nothing still clears a failure left by the one before it", async () => {
  // The early return for a fully superseded refresh used to be "nothing was applied", which
  // an unchanged status now also satisfies -- and that would have stranded the notice.
  let fail = true;
  const repo = fakeRepository([], {
    status: () => (fail ? Promise.reject(new Error("git exploded")) : Promise.resolve("")),
  });
  const store = new RepoStore(repo);

  await store.refresh(["entries"]);
  assert.match(store.getSnapshot().notice, /git exploded/);
  assert.equal(store.getSnapshot().stale, true);

  fail = false;
  await store.refresh(["entries"]);
  assert.equal(store.getSnapshot().notice, "");
  assert.equal(store.getSnapshot().stale, false);
});

test("a refresh nobody asked for does not announce itself", async () => {
  // `loading` spins the refresh icon, shows "Refreshing…" and disables every control in the
  // panel. The five-second poll setting it meant the whole view flickered and went dead for
  // the length of a `git status`, twelve times a minute, for ever.
  let resolveStatus!: (value: string) => void;
  const repo = fakeRepository([], {
    status: () => new Promise<string>((resolve) => (resolveStatus = resolve)),
  });
  const store = new RepoStore(repo);

  const polling = store.refresh(["entries"], { silent: true });
  assert.equal(store.getSnapshot().loading, false, "a background poll is invisible");
  resolveStatus(" M a.ts\0");
  await polling;
  assert.equal(store.getSnapshot().entries.length, 1, "and still applies its result");
});

test("a refresh the user asked for does announce itself", async () => {
  let resolveStatus!: (value: string) => void;
  const repo = fakeRepository([], {
    status: () => new Promise<string>((resolve) => (resolveStatus = resolve)),
  });
  const store = new RepoStore(repo);

  const asked = store.refresh(["entries"]);
  assert.equal(store.getSnapshot().loading, true);
  resolveStatus("");
  await asked;
  assert.equal(store.getSnapshot().loading, false);
});

test("a poll overlapping a refresh the user asked for does not hold the spinner on", async () => {
  const pending: ((value: string) => void)[] = [];
  const repo = fakeRepository([], {
    status: () => new Promise<string>((resolve) => pending.push(resolve)),
  });
  const store = new RepoStore(repo);

  const asked = store.refresh(["entries"]);
  const polling = store.refresh(["entries"], { silent: true });
  assert.equal(store.getSnapshot().loading, true);

  // The visible one finishes first; the silent one is still running.
  pending[0]?.("");
  await asked;
  assert.equal(store.getSnapshot().loading, false, "the spinner stops with the visible refresh");
  pending[1]?.("");
  await polling;
});
