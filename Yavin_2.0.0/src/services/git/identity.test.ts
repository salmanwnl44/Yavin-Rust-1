import assert from "node:assert/strict";
import test from "node:test";
import { attachWorktree, normalizeCommonDir } from "./identity.ts";
import type { RepoEntry, RepositoryEntry } from "./registry.ts";

test("normalizeCommonDir passes an already-absolute common dir through unchanged", () => {
  assert.equal(normalizeCommonDir("/work/feature", "/work/main/.git"), "/work/main/.git");
  assert.equal(normalizeCommonDir("C:/work/feature", "C:/work/main/.git"), "C:/work/main/.git");
});

test("normalizeCommonDir resolves a relative common dir against the worktree root", () => {
  assert.equal(normalizeCommonDir("/work/main", ".git"), "/work/main/.git");
  assert.equal(normalizeCommonDir("/work/main/", ".git"), "/work/main/.git");
});

test("normalizeCommonDir normalizes backslashes from a Windows Git", () => {
  assert.equal(normalizeCommonDir("C:/work/main", "C:\\work\\main\\.git"), "C:/work/main/.git");
});

test("normalizeCommonDir falls back to the worktree root when Git reports nothing", () => {
  assert.equal(normalizeCommonDir("/work/main", ""), "/work/main");
  assert.equal(normalizeCommonDir("/work/main", "   "), "/work/main");
});

function worktree(root: string): RepoEntry {
  return { repoId: root, root, store: {} as RepoEntry["store"] };
}

test("attachWorktree groups two worktrees that share a repository identity", () => {
  const main = worktree("/work/main");
  const feature = worktree("/work/feature");

  let repositories: RepositoryEntry[] = [];
  repositories = attachWorktree(repositories, "/work/main/.git", main);
  repositories = attachWorktree(repositories, "/work/main/.git", feature);

  assert.equal(repositories.length, 1, "one repository, not two");
  assert.deepEqual(repositories[0].worktrees, [main, feature]);
});

test("attachWorktree keeps two different repositories as separate entries", () => {
  const a = worktree("/work/a");
  const b = worktree("/work/b");

  let repositories: RepositoryEntry[] = [];
  repositories = attachWorktree(repositories, "/work/a/.git", a);
  repositories = attachWorktree(repositories, "/work/b/.git", b);

  assert.equal(repositories.length, 2);
  assert.deepEqual(
    repositories.map((r) => r.worktrees),
    [[a], [b]],
  );
});

test("attachWorktree does not mutate the repositories array it was given", () => {
  const original: RepositoryEntry[] = [
    { repositoryId: "/work/main/.git", worktrees: [worktree("/work/main")] },
  ];
  attachWorktree(original, "/work/main/.git", worktree("/work/feature"));
  assert.equal(original[0].worktrees.length, 1, "the input array is untouched");
});
