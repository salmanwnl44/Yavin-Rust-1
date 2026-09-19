import assert from "node:assert/strict";
import test from "node:test";
import { parseCommitDetails, parseGraphLog, parseRefLabels } from "./log.ts";

test("parseCommitDetails reads numstat's tab-separated per-file line counts", () => {
  const output = [
    "abc123\x1fFix the thing",
    "12\t5\tsrc/a.ts",
    "3\t0\tsrc/b.ts",
    "0\t2\tsrc/c.ts",
    "-\t-\timage.png",
  ].join("\n");
  const details = parseCommitDetails(output);
  assert.equal(details.hash, "abc123");
  assert.equal(details.summary, "Fix the thing");
  assert.equal(details.filesChanged, 4);
  assert.equal(details.insertions, 15);
  assert.equal(details.deletions, 7);
  assert.deepEqual(
    details.files.map((f) => [f.path, f.status, f.binary]),
    [
      ["src/a.ts", "M", false],
      ["src/b.ts", "A", false],
      ["src/c.ts", "D", false],
      ["image.png", "B", true],
    ],
  );
  // A binary file's line counts are genuinely unknown, not zero.
  assert.equal(details.files[3].insertions, undefined);
});

test("parseCommitDetails handles a commit with no changed files", () => {
  const details = parseCommitDetails("deadbeef\x1fEmpty commit");
  assert.equal(details.filesChanged, 0);
  assert.equal(details.summary, "Empty commit");
});

test("parseRefLabels splits HEAD pointers, branches, remotes and tags", () => {
  assert.deepEqual(parseRefLabels("HEAD -> main, origin/main, tag: v1.0, feature"), [
    { name: "HEAD", kind: "head" },
    { name: "main", kind: "branch" },
    { name: "origin/main", kind: "remote" },
    { name: "v1.0", kind: "tag" },
    { name: "feature", kind: "branch" },
  ]);
  assert.deepEqual(parseRefLabels(""), []);
  assert.deepEqual(parseRefLabels("  "), []);
});

test("parseGraphLog reads parent hashes and ref decorations per commit", () => {
  const output = [
    "aaa\x1faaa1\x1f\x1fJane\x1fjane@x.test\x1fJan 1\x1f2 days ago\x1fRoot\x1f",
    "bbb\x1fbbb1\x1faaa\x1fJane\x1fjane@x.test\x1fJan 2\x1f1 day ago\x1fSecond\x1fHEAD -> main",
    "ccc\x1fccc1\x1fbbb aaa\x1fJohn\x1fjohn@x.test\x1fJan 3\x1fnow\x1fMerge\x1f",
  ].join("\n");
  const commits = parseGraphLog(output);
  assert.equal(commits.length, 3);
  assert.deepEqual(commits[0].parents, []);
  assert.deepEqual(commits[1].parents, ["aaa"]);
  assert.deepEqual(commits[2].parents, ["bbb", "aaa"]);
  assert.deepEqual(commits[1].refs, [
    { name: "HEAD", kind: "head" },
    { name: "main", kind: "branch" },
  ]);
  assert.deepEqual(parseGraphLog(""), []);
});
