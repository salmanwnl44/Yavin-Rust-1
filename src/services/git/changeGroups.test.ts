import assert from "node:assert/strict";
import test from "node:test";
import { groupChanges, hasUnstagedPart, matchesFilter, opensStagedDiff } from "./changeGroups.ts";
import type { GitEntry } from "./parsers/status.ts";

const entry = (path: string, index: string, worktree: string, extra: Partial<GitEntry> = {}) => ({
  path: `/r/${path}`,
  index,
  worktree,
  untracked: false,
  conflict: false,
  ...extra,
});

const staged = entry("src/app.ts", "M", " ");
const both = entry("src/main.ts", "M", "M");
const unstaged = entry("README.md", " ", "M");
const untracked = entry("notes.txt", "?", "?", { untracked: true });
const conflict = entry("src/api.ts", "U", "U", { conflict: true });
const all = [staged, both, unstaged, untracked, conflict];
const names = (list: GitEntry[]) => list.map((one) => one.path.replace("/r/", ""));

test("files fall into Conflicts, Staged and Unstaged; a partly staged file is in both", () => {
  const groups = groupChanges(all, "path");
  assert.deepEqual(names(groups.conflicts), ["src/api.ts"]);
  assert.deepEqual(names(groups.staged), ["src/app.ts", "src/main.ts"]);
  assert.deepEqual(names(groups.unstaged), ["notes.txt", "README.md", "src/main.ts"]);
  // The single list has each file once, conflicts first.
  assert.equal(groups.all[0], conflict);
  assert.equal(groups.all.length, 5);
  // A conflict is in neither Staged nor Unstaged: it is resolved on its own.
  assert.ok(!hasUnstagedPart(conflict));
});

test("the filter keeps files whose path has every word typed, in any case", () => {
  const relative = (path: string) => path.replace("/r/", "");
  assert.ok(matchesFilter("src/app.ts", ""));
  assert.ok(matchesFilter("src/app.ts", "APP"));
  assert.ok(matchesFilter("src/app.ts", "src app"));
  assert.ok(!matchesFilter("src/app.ts", "src readme"));
  const groups = groupChanges(all, "path", "src", relative);
  assert.deepEqual(names(groups.all), ["src/api.ts", "src/app.ts", "src/main.ts"]);
  assert.deepEqual(names(groups.unstaged), ["src/main.ts"]);
  // Filtering on the absolute part of the path matches nothing: it is the repo-relative path.
  assert.equal(groupChanges(all, "path", "/r", relative).all.length, 0);
});

test("a row opens the diff of its own group", () => {
  assert.equal(opensStagedDiff(both, "staged"), true);
  assert.equal(opensStagedDiff(both, "unstaged"), false);
  assert.equal(opensStagedDiff(both, "all"), false, "partly staged: what is left");
  assert.equal(opensStagedDiff(staged, "all"), true, "fully staged: its staged change");
  assert.equal(opensStagedDiff(conflict, "conflicts"), false);
});
