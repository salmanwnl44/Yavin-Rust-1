import assert from "node:assert/strict";
import test from "node:test";
import { GRAPH_RESETS, SIBLING_INVALIDATES } from "./sync.ts";

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
  "commit",
  "abort",
  "continue",
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

test("only branch creation invalidates a sibling's local branch-name list", () => {
  for (const kind of ALL_KINDS) {
    if (kind === "branch") assert.deepEqual(SIBLING_INVALIDATES[kind], ["branches"]);
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

test("switch/commit/abort/continue never invalidate a sibling's RepoSnapshot fields", () => {
  // Git's own worktree-exclusivity guarantee (see the Git Operation Engine plan's
  // empirical verification) means no sibling can ever be on the branch these
  // mutations move -- so nothing about them can go stale on a *different* worktree.
  for (const kind of ["switch", "commit", "abort", "continue"]) {
    assert.equal(SIBLING_INVALIDATES[kind], undefined, `"${kind}" must have no sibling entry`);
  }
});

test("GRAPH_RESETS is exactly fetch/pull/pullRebase/pullMerge -- narrower than the pre-Module-3 behavior", () => {
  // The pre-existing InlineGraphSection code reset unconditionally on Fetch, Pull,
  // AND Push -- but push never adds a commit (it only moves a remote ref to match
  // what's already local), so it is correctly excluded here.
  assert.deepEqual(
    [...GRAPH_RESETS].sort(),
    ["fetch", "pull", "pullMerge", "pullRebase"].sort(),
  );
  assert.ok(!GRAPH_RESETS.has("push"));
  assert.ok(!GRAPH_RESETS.has("publish"));
});

test("GRAPH_RESETS does not yet cover commit/switch/branch/abort/continue/stash -- Phase 6's scope, not this phase's", () => {
  for (const kind of [
    "commit",
    "switch",
    "branch",
    "abort",
    "continue",
    "stash",
    "stashApply",
    "stashPop",
    "stashDrop",
  ]) {
    assert.ok(!GRAPH_RESETS.has(kind), `"${kind}" must not be in GRAPH_RESETS yet`);
  }
});
