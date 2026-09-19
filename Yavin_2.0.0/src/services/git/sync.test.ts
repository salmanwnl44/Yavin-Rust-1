import assert from "node:assert/strict";
import test from "node:test";
import { applyGitChangeEvent, GRAPH_RESETS, SIBLING_INVALIDATES, WATCHER_INVALIDATES } from "./sync.ts";
import type { RepoEntry, RepositoryEntry } from "./registry.ts";
import type { GitChangeEvent } from "../native.ts";

// Every `kind` string Module 2's own INVALIDATES table and the various guarded()
// call sites actually use -- kept as a flat list here (rather than importing
// Module 2's private INVALIDATES) so this test is an independent check against
// real usage, not a tautological re-assertion of the same table's own keys.
const ALL_KINDS = [
  "stage",
  "unstage",
  "discard",
  "stage-hunk",
  "unstage-hunk",
  "discard-hunk",
  "switch",
  "branch",
  "deleteBranch",
  "commit",
  "abort",
  "continue",
  "skip",
  "stash",
  "stashApply",
  "stashPop",
  "stashDrop",
  "fetch",
  "pull",
  "pullRebase",
  "pullMerge",
  "push",
  "publish",
];

test("SIBLING_INVALIDATES only lists kinds that actually touch repository-shared refs", () => {
  const expected: Record<string, readonly string[]> = {
    branch: ["branches"],
    deleteBranch: ["branches"],
    stash: ["stashes"],
    stashApply: ["stashes"],
    stashPop: ["stashes"],
    stashDrop: ["stashes"],
    fetch: ["branch"],
    pull: ["branch"],
    pullRebase: ["branch"],
    pullMerge: ["branch"],
  };
  for (const kind of ALL_KINDS) {
    assert.deepEqual(
      SIBLING_INVALIDATES[kind] ?? [],
      expected[kind] ?? [],
      `unexpected sibling-invalidation fields for "${kind}"`,
    );
  }
});

test("fetch/pull invalidate a sibling's ahead/behind (branch), never its local branch-name list", () => {
  // A fetch only ever writes refs/remotes/**, never refs/heads/** -- so the
  // local-branch-NAME list (`branches`, from for-each-ref refs/heads/) can never
  // go stale from it. What changes is ahead/behind, which lives in `branch`
  // (branchInfo's status --porcelain=v2 --branch). Mixing these up was a real
  // error caught while implementing this table (Section E's own draft matrix
  // mismatched the plan's own, correct Section H watcher-path table).
  for (const kind of ["fetch", "pull", "pullRebase", "pullMerge"]) {
    assert.deepEqual(SIBLING_INVALIDATES[kind], ["branch"]);
  }
});

test("only branch creation or deletion invalidates a sibling's local branch-name list", () => {
  for (const kind of ALL_KINDS) {
    if (kind === "branch" || kind === "deleteBranch")
      assert.deepEqual(SIBLING_INVALIDATES[kind], ["branches"]);
    else assert.ok(!(SIBLING_INVALIDATES[kind] ?? []).includes("branches"), `"${kind}" must not`);
  }
});

test("stash-family mutations invalidate only a sibling's shared stash list, never its own working-tree entries", () => {
  // A stash push/apply/pop's working-tree effect never reaches a DIFFERENT
  // worktree -- only the repository-shared refs/stash list does.
  for (const kind of ["stash", "stashApply", "stashPop", "stashDrop"]) {
    assert.deepEqual(SIBLING_INVALIDATES[kind], ["stashes"]);
  }
  assert.equal(SIBLING_INVALIDATES.push, undefined);
  assert.equal(SIBLING_INVALIDATES.publish, undefined);
});

test("switch/commit/abort/continue/skip never invalidate a sibling's RepoSnapshot fields", () => {
  // Git's own worktree-exclusivity guarantee (see the Git Operation Engine plan's
  // empirical verification) means no sibling can ever be on the branch these
  // mutations move -- so nothing about them can go stale on a *different* worktree.
  for (const kind of ["switch", "commit", "abort", "continue", "skip"]) {
    assert.equal(SIBLING_INVALIDATES[kind], undefined, `"${kind}" must have no sibling entry`);
  }
});

test("GRAPH_RESETS is exactly fetch/pull/pullRebase/pullMerge/commit -- narrower than the pre-Module-3 behavior", () => {
  // The pre-existing InlineGraphSection code reset unconditionally on Fetch, Pull,
  // AND Push -- but push never adds a commit (it only moves a remote ref to match
  // what's already local), so it is correctly excluded here. `commit` was added
  // in Phase 6 (it grows this worktree's own branch's history by one).
  assert.deepEqual(
    [...GRAPH_RESETS].sort(),
    ["commit", "fetch", "pull", "pullMerge", "pullRebase"].sort(),
  );
  assert.ok(!GRAPH_RESETS.has("push"));
  assert.ok(!GRAPH_RESETS.has("publish"));
});

test("GRAPH_RESETS never statically covers switch/branch/abort/stash/deleteBranch -- none of them can add a commit", () => {
  for (const kind of [
    "switch",
    "branch",
    "deleteBranch",
    "abort",
    "stash",
    "stashApply",
    "stashPop",
    "stashDrop",
  ]) {
    assert.ok(!GRAPH_RESETS.has(kind), `"${kind}" must not be in GRAPH_RESETS`);
  }
});

test("GRAPH_RESETS never lists 'continue' or 'skip' -- their reset is conditional, decided at runtime by guardedAffecting", () => {
  assert.ok(!GRAPH_RESETS.has("continue"));
  assert.ok(!GRAPH_RESETS.has("skip"));
});

function fakeWorktree(root: string): { entry: RepoEntry; refreshCalls: unknown[][] } {
  const refreshCalls: unknown[][] = [];
  const entry = {
    repoId: root,
    root,
    store: {
      refresh: (...args: unknown[]) => {
        refreshCalls.push(args);
        return Promise.resolve();
      },
    },
  } as unknown as RepoEntry;
  return { entry, refreshCalls };
}

test("WATCHER_INVALIDATES maps every event kind to the fields Section H's watcher-path table specifies", () => {
  const expected: Record<GitChangeEvent["kind"], { fields: readonly string[]; graphReset: boolean }> = {
    head: { fields: ["entries", "branch"], graphReset: false },
    "operation-state": { fields: ["entries", "branch", "operationInProgress"], graphReset: false },
    refs: { fields: ["branches"], graphReset: true },
    remotes: { fields: ["branch"], graphReset: true },
    stash: { fields: ["entries", "stashes"], graphReset: false },
  };
  for (const kind of Object.keys(expected) as GitChangeEvent["kind"][]) {
    assert.deepEqual(WATCHER_INVALIDATES[kind], expected[kind], `mismatch for "${kind}"`);
  }
});

test("a 'head'/'operation-state' event refreshes only the worktree it names, never a sibling", () => {
  const a = fakeWorktree("/work/a");
  const b = fakeWorktree("/work/b");
  const repository: RepositoryEntry = {
    repositoryId: "/work/.git",
    worktrees: [a.entry, b.entry],
    knownWorktrees: [],
  };

  applyGitChangeEvent(repository, { repositoryId: "/work/.git", kind: "head", worktreeRoot: "/work/a" });

  assert.deepEqual(a.refreshCalls, [[["entries", "branch"]]]);
  assert.deepEqual(b.refreshCalls, [], "the sibling must not be refreshed by a per-worktree event");
});

test("an unresolvable worktreeRoot on a per-worktree event is a silent no-op, not a throw", () => {
  const a = fakeWorktree("/work/a");
  const repository: RepositoryEntry = {
    repositoryId: "/work/.git",
    worktrees: [a.entry],
    knownWorktrees: [],
  };
  assert.doesNotThrow(() =>
    applyGitChangeEvent(repository, {
      repositoryId: "/work/.git",
      kind: "head",
      worktreeRoot: "/work/removed-worktree",
    }),
  );
  assert.deepEqual(a.refreshCalls, []);
});

test("'refs'/'remotes'/'stash' events refresh every worktree of the repository", () => {
  for (const kind of ["refs", "remotes", "stash"] as const) {
    const a = fakeWorktree("/work/a");
    const b = fakeWorktree("/work/b");
    const repository: RepositoryEntry = {
      repositoryId: "/work/.git",
      worktrees: [a.entry, b.entry],
      knownWorktrees: [],
    };
    applyGitChangeEvent(repository, { repositoryId: "/work/.git", kind });
    assert.equal(a.refreshCalls.length, 1, `worktree A must refresh for "${kind}"`);
    assert.equal(b.refreshCalls.length, 1, `worktree B must refresh for "${kind}"`);
    assert.deepEqual(a.refreshCalls[0], b.refreshCalls[0], `both worktrees get the same fields for "${kind}"`);
  }
});
