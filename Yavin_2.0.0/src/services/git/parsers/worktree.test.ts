import assert from "node:assert/strict";
import test from "node:test";
import { parseWorktreeList } from "./worktree.ts";

// Captured from a real `git worktree list --porcelain` run, not guessed -- see
// `git-worktree(1)`'s porcelain format.
const MAIN_AND_LINKED = [
  "worktree /work/main",
  "HEAD 30b306f91cb51962edb5bbee9e18f014a0459121",
  "branch refs/heads/master",
  "",
  "worktree /work/main-feature",
  "HEAD 30b306f91cb51962edb5bbee9e18f014a0459121",
  "branch refs/heads/feature",
  "locked testing lock",
  "",
].join("\n");

const DETACHED_AND_PRUNABLE = [
  "worktree /work/main",
  "HEAD 30b306f91cb51962edb5bbee9e18f014a0459121",
  "branch refs/heads/master",
  "",
  "worktree /work/main-detached",
  "HEAD 30b306f91cb51962edb5bbee9e18f014a0459121",
  "detached",
  "prunable gitdir file points to non-existent location",
  "",
].join("\n");

test("parseWorktreeList reads the main worktree and marks only the first entry as main", () => {
  const [main, linked] = parseWorktreeList(MAIN_AND_LINKED);
  assert.equal(main.path, "/work/main");
  assert.equal(main.branch, "master");
  assert.equal(main.isMain, true);
  assert.equal(linked.isMain, false);
});

test("parseWorktreeList strips the refs/heads/ prefix from the branch", () => {
  const [, linked] = parseWorktreeList(MAIN_AND_LINKED);
  assert.equal(linked.branch, "feature");
});

test("parseWorktreeList reads a lock and its reason", () => {
  const [, linked] = parseWorktreeList(MAIN_AND_LINKED);
  assert.equal(linked.locked, true);
  assert.equal(linked.lockedReason, "testing lock");
});

test("parseWorktreeList reads a lock with no reason", () => {
  const [worktree] = parseWorktreeList(
    ["worktree /work/wt", "HEAD abc123", "branch refs/heads/x", "locked", ""].join("\n"),
  );
  assert.equal(worktree.locked, true);
  assert.equal(worktree.lockedReason, "");
});

test("parseWorktreeList reads a detached worktree with no branch", () => {
  const [, detached] = parseWorktreeList(DETACHED_AND_PRUNABLE);
  assert.equal(detached.detached, true);
  assert.equal(detached.branch, "");
});

test("parseWorktreeList reads a prunable worktree and its reason", () => {
  const [, detached] = parseWorktreeList(DETACHED_AND_PRUNABLE);
  assert.equal(detached.prunable, true);
  assert.equal(detached.prunableReason, "gitdir file points to non-existent location");
});

test("parseWorktreeList returns nothing for empty output", () => {
  assert.deepEqual(parseWorktreeList(""), []);
});

test("parseWorktreeList reads a single worktree with no trailing blank line", () => {
  const [main] = parseWorktreeList(
    ["worktree /work/main", "HEAD abc123", "branch refs/heads/main"].join("\n"),
  );
  assert.equal(main.path, "/work/main");
  assert.equal(main.headHash, "abc123");
});
