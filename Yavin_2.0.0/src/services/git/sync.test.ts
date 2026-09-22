import assert from "node:assert/strict";
import test from "node:test";
import {
  applyGitChangeEvent,
  GRAPH_RESETS,
  PARTIAL_ON_FAILURE,
  propagationFor,
  SIBLING_INVALIDATES,
  WATCHER_INVALIDATES,
} from "./sync.ts";
import { DIRTY_BLOCKED } from "./store.ts";
import type { RepoEntry, RepositoryEntry } from "./registry.ts";
import type { GitChangeEvent } from "../native.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

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
  "renameBranch",
  "commit",
  "undoLastCommit",
  "mergeBranch",
  "rebaseOnto",
  "abort",
  "continue",
  "skip",
  "stash",
  "stashApply",
  "stashPop",
  "stashDrop",
  "stashClear",
  "fetch",
  "pull",
  "pullFrom",
  "pullRebase",
  "pullMerge",
  "push",
  "pushTo",
  "pushTags",
  "publish",
  "addRemote",
  "removeRemote",
  "createTag",
  "deleteTag",
  "deleteRemoteRef",
];

/**
 * `DIRTY_BLOCKED` had no test at all, which is exactly how the stash family and
 * `discard-hunk` came to be missing from it: each of those rewrites tracked files on disk
 * while an unsaved editor buffer holds the old content, so the next Ctrl+S silently undoes
 * the operation. This is the table's completeness check -- every kind is classified here by
 * hand, and a new one added to `ALL_KINDS` without a decision recorded fails the test rather
 * than defaulting to "not blocked", which is the dangerous direction.
 */
test("DIRTY_BLOCKED lists exactly the mutations that rewrite tracked files on disk", () => {
  const rewritesWorkingTree = new Set([
    // Move HEAD and rewrite the tree to match it.
    "switch",
    "branch",
    // Bring in commits and write their content into the tree.
    "pull",
    "pullRebase",
    "pullMerge",
    "pullFrom",
    "mergeBranch",
    "rebaseOnto",
    // Wind an in-progress operation forward or back, rewriting the tree either way.
    "abort",
    "continue",
    "skip",
    // Takes changes off the tree / puts them back onto it.
    "stash",
    "stashApply",
    "stashPop",
    // `git apply -R` against the working-tree file.
    "discard-hunk",
    // `reset --soft` only moves HEAD, but it is blocked deliberately: the app treats
    // moving HEAD under unsaved editors as something to refuse regardless.
    "undoLastCommit",
  ]);
  for (const kind of ALL_KINDS) {
    assert.equal(
      DIRTY_BLOCKED.has(kind),
      rewritesWorkingTree.has(kind),
      rewritesWorkingTree.has(kind)
        ? `"${kind}" rewrites the working tree and must be refused while an editor is dirty`
        : `"${kind}" does not rewrite the working tree and must not be blocked`,
    );
  }
  // Nothing may be listed that is not a real mutation kind -- a typo in the set would
  // otherwise silently block nothing at all.
  for (const kind of DIRTY_BLOCKED) {
    assert.ok(ALL_KINDS.includes(kind), `DIRTY_BLOCKED lists unknown kind "${kind}"`);
  }
});

test("index-only hunk actions are never dirty-blocked, unlike discarding one", () => {
  // Staging and unstaging a hunk touch only the index, so they stay usable with unsaved
  // editors open; discarding writes the file, so it must not.
  assert.equal(DIRTY_BLOCKED.has("stage-hunk"), false);
  assert.equal(DIRTY_BLOCKED.has("unstage-hunk"), false);
  assert.equal(DIRTY_BLOCKED.has("discard-hunk"), true);
});

test("dropping a stash never rewrites the tree, so it stays available with unsaved edits", () => {
  // `stash drop`/`clear` only delete stash refs -- blocking them would be a pointless
  // refusal, and the distinction from apply/pop is the whole reason this is a table.
  assert.equal(DIRTY_BLOCKED.has("stashDrop"), false);
  assert.equal(DIRTY_BLOCKED.has("stashClear"), false);
});

test("SIBLING_INVALIDATES only lists kinds that actually touch repository-shared refs", () => {
  const expected: Record<string, readonly string[]> = {
    branch: ["branches"],
    deleteBranch: ["branches"],
    renameBranch: ["branches"],
    stash: ["stashes"],
    stashApply: ["stashes"],
    stashPop: ["stashes"],
    stashDrop: ["stashes"],
    stashClear: ["stashes"],
    fetch: ["branch"],
    pull: ["branch"],
    pullFrom: ["branch"],
    pullRebase: ["branch"],
    pullMerge: ["branch"],
    addRemote: ["remotes"],
    removeRemote: ["remotes"],
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

test("only branch creation, deletion or rename invalidates a sibling's local branch-name list", () => {
  for (const kind of ALL_KINDS) {
    if (kind === "branch" || kind === "deleteBranch" || kind === "renameBranch")
      assert.deepEqual(SIBLING_INVALIDATES[kind], ["branches"]);
    else assert.ok(!(SIBLING_INVALIDATES[kind] ?? []).includes("branches"), `"${kind}" must not`);
  }
});

test("stash-family mutations invalidate only a sibling's shared stash list, never its own working-tree entries", () => {
  // A stash push/apply/pop's working-tree effect never reaches a DIFFERENT
  // worktree -- only the repository-shared refs/stash list does.
  for (const kind of ["stash", "stashApply", "stashPop", "stashDrop", "stashClear"]) {
    assert.deepEqual(SIBLING_INVALIDATES[kind], ["stashes"]);
  }
  assert.equal(SIBLING_INVALIDATES.push, undefined);
  assert.equal(SIBLING_INVALIDATES.publish, undefined);
});

test("only adding or removing a remote invalidates a sibling's remote list", () => {
  for (const kind of ["addRemote", "removeRemote"]) {
    assert.deepEqual(SIBLING_INVALIDATES[kind], ["remotes"]);
  }
});

test("switch/commit/abort/continue/skip and the new worktree-exclusive kinds never invalidate a sibling's RepoSnapshot fields", () => {
  // Git's own worktree-exclusivity guarantee (see the Git Operation Engine plan's
  // empirical verification) means no sibling can ever be on the branch these
  // mutations move -- so nothing about them can go stale on a *different* worktree.
  for (const kind of [
    "switch",
    "commit",
    "undoLastCommit",
    "mergeBranch",
    "rebaseOnto",
    "abort",
    "continue",
    "skip",
    "push",
    "pushTo",
    "pushTags",
    "deleteRemoteRef",
    "createTag",
    "deleteTag",
  ]) {
    assert.equal(SIBLING_INVALIDATES[kind], undefined, `"${kind}" must have no sibling entry`);
  }
});

test("GRAPH_RESETS is every kind that changes the commits or the ref labels the graph shows", () => {
  // The graph is `git log` from HEAD plus each commit's `%D` labels. History changes:
  // fetch/pull*/commit add commits, switch/abort move HEAD. Label changes: push and
  // publish move origin/<branch>, branch and deleteBranch add and remove a label, and
  // deleteRemoteRef removes the local refs/remotes/<remote>/<branch> that `origin/foo`
  // pill is drawn from -- `git push --delete` deletes the remote-tracking ref too, not
  // just the branch on the server.
  assert.deepEqual(
    [...GRAPH_RESETS].sort(),
    [
      "abort",
      "branch",
      "commit",
      "createTag",
      "deleteBranch",
      "deleteRemoteRef",
      "deleteTag",
      "fetch",
      "mergeBranch",
      "publish",
      "pull",
      "pullFrom",
      "pullMerge",
      "pullRebase",
      "push",
      "pushTo",
      "rebaseOnto",
      "renameBranch",
      "switch",
      "undoLastCommit",
    ].sort(),
  );
});

test("GRAPH_RESETS never covers what cannot change a commit or a ref label", () => {
  for (const kind of [
    "stage",
    "unstage",
    "discard",
    "stage-hunk",
    "unstage-hunk",
    "discard-hunk",
    "stash",
    "stashApply",
    "stashPop",
    "stashDrop",
    "stashClear",
    // `pushTags` only uploads tags that already exist locally, so no local label changes.
    "pushTags",
    "addRemote",
    "removeRemote",
  ]) {
    assert.ok(!GRAPH_RESETS.has(kind), `"${kind}" must not be in GRAPH_RESETS`);
  }
});

test("deleting a remote branch really removes the local remote-tracking label the graph draws", async () => {
  // Ground truth for `deleteRemoteRef`'s place in GRAPH_RESETS: `git push --delete` is not
  // only a server-side change, it drops refs/remotes/<remote>/<branch> here too.
  const { realRepo, git } = await import("./testing/realGit.ts");
  const remote = realRepo();
  const r = realRepo();
  try {
    git(remote.root, "config", "receive.denyCurrentBranch", "ignore");
    writeFileSync(join(r.root, "a.txt"), "a\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "one");
    r.git("remote", "add", "origin", remote.root);
    r.git("push", "-q", "origin", "main:feature");
    r.git("fetch", "-q", "origin");

    const labelsBefore = (await r.repository.graphLog(0, 10)).split("\x1f").pop() ?? "";
    assert.match(labelsBefore, /origin\/feature/, "the remote-tracking label must exist first");

    await r.repository.deleteRemoteRef("origin", "feature");

    const labelsAfter = (await r.repository.graphLog(0, 10)).split("\x1f").pop() ?? "";
    assert.doesNotMatch(
      labelsAfter,
      /origin\/feature/,
      "deleting the remote branch removes the local remote-tracking ref, so the graph must reset",
    );
  } finally {
    r.dispose();
    remote.dispose();
  }
});

test("push, branch create and branch delete really change what the graph's log shows", async () => {
  // Ground truth for the table above: the `%D` labels on the commits the graph draws.
  const { realRepo, git } = await import("./testing/realGit.ts");
  const remote = realRepo();
  const r = realRepo();
  try {
    git(remote.root, "config", "receive.denyCurrentBranch", "ignore");
    writeFileSync(join(r.root, "a.txt"), "a\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "one");
    r.git("remote", "add", "origin", remote.root);
    const labels = async () => (await r.repository.graphLog(0, 10)).split("\x1f").pop();
    const before = await labels();
    r.git("branch", "feature");
    assert.notEqual(await labels(), before, "branch create must change the labels");
    const created = await labels();
    r.git("push", "-q", "origin", "main");
    r.git("fetch", "-q", "origin");
    assert.notEqual(await labels(), created, "a push must move origin/main");
    const pushed = await labels();
    r.git("branch", "-D", "feature");
    assert.notEqual(await labels(), pushed, "branch delete must change the labels");
  } finally {
    r.dispose();
    remote.dispose();
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
  const expected: Record<
    GitChangeEvent["kind"],
    { fields: readonly string[]; graphReset: boolean }
  > = {
    head: { fields: ["entries", "branch"], graphReset: true },
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

  applyGitChangeEvent(repository, {
    repositoryId: "/work/.git",
    kind: "head",
    worktreeRoot: "/work/a",
  });

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
    assert.deepEqual(
      a.refreshCalls[0],
      b.refreshCalls[0],
      `both worktrees get the same fields for "${kind}"`,
    );
  }
});

test("a failed operation that can have changed refs or HEAD still propagates, atomic ones do not", () => {
  // Git does part of the work and then exits non-zero for these.
  for (const kind of ["fetch", "pull", "pullFrom", "pullRebase", "pullMerge"]) {
    const effect = propagationFor(kind, false, true, "", "");
    assert.deepEqual(effect.siblingFields, ["branch"], `${kind}: siblings`);
    assert.equal(effect.graphReset, true, `${kind}: graph`);
  }
  assert.equal(propagationFor("publish", false, true, "", "").graphReset, true);
  // mergeBranch/rebaseOnto: the same conflict-after-partial-progress shape as
  // pullMerge/pullRebase, just against an explicit branch. No sibling can be on this
  // worktree's branch, so only the graph resets, not a sibling field.
  for (const kind of ["mergeBranch", "rebaseOnto"]) {
    const effect = propagationFor(kind, false, true, "", "");
    assert.equal(effect.siblingFields, undefined, `${kind}: siblings`);
    assert.equal(effect.graphReset, true, `${kind}: graph`);
  }
  // A failed continue/skip may have created commits before stopping on the next conflict.
  for (const kind of ["continue", "skip"]) {
    assert.equal(propagationFor(kind, false, true, "rebase", "rebase").graphReset, true);
  }
  // Atomic, or nothing moves when they fail.
  for (const kind of [
    "push",
    "pushTo",
    "pushTags",
    "deleteRemoteRef",
    "switch",
    "branch",
    "deleteBranch",
    "renameBranch",
    "commit",
    "undoLastCommit",
    "createTag",
    "deleteTag",
    "addRemote",
    "removeRemote",
    "stage",
    "unstage",
    "discard",
    "abort",
    "stashPop",
    "stashApply",
    "stashClear",
  ]) {
    const effect = propagationFor(kind, false, true, "", "");
    assert.deepEqual(effect, { siblingFields: undefined, graphReset: false }, `${kind} failed`);
  }
});

test("a refused start (busy, dirty) propagates nothing, even for a partial-failure kind", () => {
  for (const kind of PARTIAL_ON_FAILURE) {
    assert.deepEqual(propagationFor(kind, false, false, "", ""), {
      siblingFields: undefined,
      graphReset: false,
    });
  }
});

test("a successful continue/skip resets the graph only when it completes the operation", () => {
  for (const kind of ["continue", "skip"]) {
    assert.equal(propagationFor(kind, true, true, "rebase", "").graphReset, true);
    assert.equal(propagationFor(kind, true, true, "rebase", "rebase").graphReset, false);
  }
});

test("a successful mutation propagates exactly its table entries", () => {
  assert.deepEqual(propagationFor("fetch", true, true, "", ""), {
    siblingFields: ["branch"],
    graphReset: true,
  });
  assert.deepEqual(propagationFor("stage", true, true, "", ""), {
    siblingFields: undefined,
    graphReset: false,
  });
  assert.deepEqual(propagationFor("branch", true, true, "", ""), {
    siblingFields: ["branches"],
    graphReset: true,
  });
});
