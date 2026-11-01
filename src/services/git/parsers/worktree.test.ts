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

/** `git worktree list --porcelain -z`: attributes end in NUL, each worktree in an extra NUL. */
const nul = (...blocks: string[][]) => blocks.map((b) => b.join("\0") + "\0\0").join("");

test("parseWorktreeList reads the -z form, including a path or reason containing a newline", () => {
  const output = nul(
    ["worktree /work/main", "HEAD abc", "branch refs/heads/main"],
    [
      "worktree /work/odd\nname",
      "HEAD abc",
      "branch refs/heads/feature",
      "locked two\nline reason",
    ],
    ["worktree /work/wt é", "HEAD abc", "detached", "prunable gitdir file points to nowhere"],
  );
  const [main, odd, unicode] = parseWorktreeList(output);
  assert.equal(main.path, "/work/main");
  assert.equal(main.isMain, true);
  assert.equal(odd.path, "/work/odd\nname");
  assert.equal(odd.branch, "feature");
  assert.equal(odd.lockedReason, "two\nline reason");
  assert.equal(odd.isMain, false);
  assert.equal(unicode.path, "/work/wt é");
  assert.equal(unicode.detached, true);
  assert.equal(unicode.prunable, true);
  assert.equal(parseWorktreeList(output).length, 3);
});

test("parseWorktreeList gives the same result for -z and the line form", () => {
  const blocks = [
    ["worktree /work/main", "HEAD abc", "branch refs/heads/main"],
    ["worktree /work/linked", "HEAD def", "detached", "locked reason"],
  ];
  const lines = blocks.map((b) => b.join("\n")).join("\n\n") + "\n";
  assert.deepEqual(parseWorktreeList(nul(...blocks)), parseWorktreeList(lines));
});
