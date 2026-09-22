import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { RepoStore } from "../git/store.ts";
import type { Repository } from "../git/repository.ts";
import type { RepoEntry } from "../git/registry.ts";
import { getGitContext } from "./gitContext.ts";
import { createGitReadTools } from "./gitTools.ts";
import { createGitMutatingTools, TOOL_TIERS } from "./gitToolsMutating.ts";
import { resolveInRoot } from "./toolTypes.ts";

interface Fixture {
  status?: string;
  branchInfo?: string;
  branches?: string[];
  remotes?: string[];
  state?: string;
  stash?: string;
  fail?: Record<string, string>;
}

async function fixture(f: Fixture = {}) {
  const calls: string[] = [];
  const mutate =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push(`${name}(${args.map(String).join(",")})`);
      if (f.fail?.[name]) throw new Error(f.fail[name]);
      return `${name} ok`;
    };
  const repository = {
    root: "/work",
    status: async () => f.status ?? "",
    branchInfo: async () =>
      f.branchInfo ?? "# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -0\n",
    branches: async () => f.branches ?? ["main", "feature"],
    remotes: async () => f.remotes ?? ["origin"],
    stashList: async () => f.stash ?? "",
    state: async () => f.state ?? "",
    diff: async (path: string, staged: boolean) => `diff ${path} ${staged}`,
    graphLog: async () => "aaa\x1faaa1\x1f\x1fA\x1fa@x\x1fJan\x1f1d\x1fFirst\x1f",
    commitDetails: async (h: string) => `${h}\x1fSubject`,
    commitFileDiff: async (h: string, p: string) => `show ${h} ${p}`,
    stage: mutate("stage"),
    unstage: mutate("unstage"),
    commit: mutate("commit"),
    switchBranch: mutate("switchBranch"),
    createBranch: mutate("createBranch"),
    deleteBranch: mutate("deleteBranch"),
    fetch: mutate("fetch"),
    pull: mutate("pull"),
    push: mutate("push"),
    publish: mutate("publish"),
    stash: mutate("stash"),
    stashApply: mutate("stashApply"),
    stashPop: mutate("stashPop"),
    stashDrop: mutate("stashDrop"),
    continueOperation: mutate("continueOperation"),
    abort: mutate("abort"),
    skip: mutate("skip"),
  } as unknown as Repository;
  const store = new RepoStore(repository);
  await store.refresh();
  const entry: RepoEntry = { repoId: "/work", root: "/work", status: "ready", store };
  const registry = { getSnapshot: () => ({ repos: [entry] }) };
  const dirty = { value: false };
  const tools = createGitMutatingTools({ isDirty: () => dirty.value, registry });
  return { calls, entry, store, registry, tools, dirty, reads: createGitReadTools(registry) };
}

const ref = { repoId: "/work" };

test("baseline context summarizes state from the snapshot without touching Git", async () => {
  const { entry, calls } = await fixture({ status: "M  a.ts\0 M b.ts\0?? c.ts\0UU d.ts\0" });
  const before = calls.length;
  const ctx = getGitContext(entry);
  assert.deepEqual(ctx.changeSummary, { staged: 1, unstaged: 1, conflicts: 1, untracked: 1 });
  assert.equal(ctx.branch.name, "main");
  assert.equal(calls.length, before);
});

test("every tool refuses a worktree that is not currently open", async () => {
  const { reads, tools } = await fixture();
  const missing = { repoId: "/elsewhere" };
  for (const result of [
    await reads.getContext(missing),
    await tools.fetch(missing),
    await tools.commit(missing, { message: "x" }),
  ]) {
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.category, "not-found");
  }
});

test("read tools bound output and reject paths and hashes that could escape", async () => {
  const { reads } = await fixture();
  const diff = await reads.getDiff(ref, { path: "a.ts", staged: true });
  assert.ok(diff.ok && diff.data.text === "diff /work/a.ts true");
  const escaping = await reads.getDiff(ref, { path: "../etc/passwd", staged: false });
  assert.equal(escaping.ok, false);
  assert.equal((await reads.getCommitDetails(ref, { hash: "abc; rm -rf" })).ok, false);
  assert.ok((await reads.getRecentCommits(ref, { limit: 5 })).ok);
});

test("stage only touches files that actually have that change, resolved inside the worktree", async () => {
  const { tools, calls } = await fixture({ status: " M a.ts\0M  b.ts\0" });
  assert.equal((await tools.stage(ref, { paths: ["b.ts"] })).ok, false, "already staged");
  assert.equal((await tools.stage(ref, { paths: ["nope.ts"] })).ok, false);
  assert.equal((await tools.stage(ref, { paths: ["../x"] })).ok, false);
  assert.deepEqual(calls, []);
  const ok = await tools.stage(ref, { paths: ["a.ts"] });
  assert.ok(ok.ok);
  assert.deepEqual(calls, ["stage(/work/a.ts)"]);
});

test("commit needs staged changes, no conflicts and a message", async () => {
  const none = await fixture({ status: " M a.ts\0" });
  assert.equal((await none.tools.commit(ref, { message: "m" })).ok, false);
  const conflicted = await fixture({ status: "M  a.ts\0UU b.ts\0" });
  assert.equal((await conflicted.tools.commit(ref, { message: "m" })).ok, false);
  const good = await fixture({ status: "M  a.ts\0" });
  assert.equal((await good.tools.commit(ref, { message: " " })).ok, false);
  const result = await good.tools.commit(ref, { message: "msg" });
  assert.ok(result.ok);
  assert.deepEqual(good.calls, ["commit(msg)"]);
  assert.equal(result.ok && result.data.context.repoId, "/work");
});

test("while an operation is in progress only continue/abort/skip are allowed", async () => {
  const f = await fixture({ state: "rebase", status: "M  a.ts\0" });
  const refused = await f.tools.commit(ref, { message: "m" });
  assert.equal(!refused.ok && refused.category, "precondition");
  assert.equal((await f.tools.switchBranch(ref, { name: "feature" })).ok, false);
  assert.ok((await f.tools.skipOperation(ref)).ok);
  assert.ok((await f.tools.abortOperation(ref)).ok);
});

test("continue is refused while a conflict remains, regardless of any edits", async () => {
  const conflicted = await fixture({ state: "merge", status: "UU a.ts\0" });
  assert.equal((await conflicted.tools.continueOperation(ref)).ok, false);
  assert.deepEqual(conflicted.calls, []);
  const resolved = await fixture({ state: "merge", status: "M  a.ts\0" });
  assert.ok((await resolved.tools.continueOperation(ref)).ok);
  const merge = await fixture({ state: "merge" });
  assert.equal((await merge.tools.skipOperation(ref)).ok, false, "merge has no skip");
});

test("push/pull/publish read the real upstream instead of assuming origin", async () => {
  const unpublished = await fixture({ branchInfo: "# branch.head feature\n", remotes: ["fork"] });
  assert.equal((await unpublished.tools.push(ref)).ok, false);
  assert.equal((await unpublished.tools.pull(ref)).ok, false);
  assert.equal((await unpublished.tools.publish(ref, { remote: "origin" })).ok, false);
  assert.ok((await unpublished.tools.publish(ref, { remote: "fork" })).ok);
  const diverged = await fixture({
    branchInfo: "# branch.head main\n# branch.upstream origin/main\n# branch.ab +1 -1\n",
  });
  assert.equal((await diverged.tools.pull(ref)).ok, false, "diverged needs a human choice");
  const detached = await fixture({ branchInfo: "# branch.head (detached)\n" });
  assert.equal((await detached.tools.push(ref)).ok, false);
});

test("branch deletion never targets the current or a missing branch and is never forced", async () => {
  const { tools, calls } = await fixture();
  assert.equal((await tools.deleteBranch(ref, { name: "main" })).ok, false);
  assert.equal((await tools.deleteBranch(ref, { name: "ghost" })).ok, false);
  assert.ok((await tools.deleteBranch(ref, { name: "feature" })).ok);
  assert.deepEqual(calls, ["deleteBranch(feature,false)"]);
});

test("a failed operation returns a categorized diagnostic and is never retried", async () => {
  const { tools, calls } = await fixture({
    status: "M  a.ts\0",
    fail: { commit: "Git: fatal: Authentication failed" },
  });
  const result = await tools.commit(ref, { message: "m" });
  assert.equal(!result.ok && result.category, "auth");
  assert.equal(calls.length, 1);
});

test("unsaved editors block operations that rewrite the working tree", async () => {
  const { tools, dirty, calls } = await fixture();
  dirty.value = true;
  const result = await tools.switchBranch(ref, { name: "feature" });
  assert.equal(!result.ok && result.category, "dirty");
  assert.deepEqual(calls, []);
});

test("a second call while one is in flight is refused as busy, not queued", async () => {
  const { tools, entry } = await fixture({ status: " M a.ts\0" });
  let release!: () => void;
  const held = entry.store.guarded(
    "fetch",
    false,
    () => new Promise<string>((r) => (release = () => r("done"))),
  );
  const result = await tools.fetch(ref);
  assert.equal(!result.ok && result.category, "busy");
  release();
  await held;
});

test("a worktree whose last refresh failed is refused as stale", async () => {
  const f = await fixture();
  (f.entry.store.repository as unknown as { status: () => Promise<string> }).status = async () => {
    throw new Error("boom");
  };
  await f.entry.store.refresh();
  const result = await f.tools.fetch(ref);
  assert.equal(!result.ok && result.category, "stale");
});

test("path resolution stays inside the worktree", () => {
  assert.equal(resolveInRoot("/work", "a/b.ts"), "/work/a/b.ts");
  assert.equal(resolveInRoot("/work", "/work/a.ts"), "/work/a.ts");
  assert.equal(resolveInRoot("/work", "../a"), null);
  assert.equal(resolveInRoot("/work", "a/../../b"), null);
  assert.equal(resolveInRoot("/work", ""), null);
});

test("every mutating tool has an explicit risk tier and none exposes force or history rewriting", () => {
  for (const name of ["reset", "forcePush", "forceDeleteBranch", "rebase", "merge", "discard"]) {
    assert.equal(name in TOOL_TIERS, false, name);
  }
  assert.equal(TOOL_TIERS.commit, "confirm");
  assert.equal(TOOL_TIERS.stage, "reversible");
});

test("the AI's stash leaves untracked files alone unless it is explicitly asked not to", async () => {
  // `stash -u` takes never-tracked files off disk, and a later stashDrop destroys them with
  // no reflog to recover from -- so "stash" plus "tidy up stashes", two individually
  // unremarkable steps, used to be a complete data-loss chain. It is opt-in now.
  const stashOptions: Array<{ message?: string; untracked?: boolean }> = [];
  const f = await fixture({ status: " M a.ts\0" });
  (f.entry.store.repository as unknown as { stash: (o: object) => Promise<string> }).stash = async (
    options,
  ) => {
    stashOptions.push(options);
    return "stashed";
  };

  await f.tools.stash({ repoId: "/work" }, { message: "wip" });
  assert.deepEqual(stashOptions.at(-1), { message: "wip", untracked: false });

  await f.tools.stash({ repoId: "/work" }, { message: "wip", includeUntracked: true });
  assert.deepEqual(stashOptions.at(-1), { message: "wip", untracked: true });
});

test("stashing is a confirm-tier tool, not a reversible one", () => {
  // It removes changes from the working tree; undoing it means finding the right stash
  // afterwards. "reversible" is the tier that means "just do it".
  assert.equal(TOOL_TIERS.stash, "confirm");
});

test("the AI tool layer never imports the native Git bridge or spawns processes", () => {
  const dir = new URL(".", import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
    const source = readFileSync(new URL(file, dir), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(source, /from\s+["'][^"']*(native|backend)(\.ts)?["']/, file);
    assert.doesNotMatch(source, /child_process|gitExec|git_exec|@tauri-apps/, file);
  }
});
