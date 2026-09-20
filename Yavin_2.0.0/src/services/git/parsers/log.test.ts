import assert from "node:assert/strict";
import test from "node:test";
import { parseCommitDetails, parseGraphLog, parseRefLabels } from "./log.ts";

/** Builds `git show --numstat -z` output: a header line, then NUL-terminated records. */
const numstatZ = (header: string, records: string[]) => `${header}\n${records.join("\0")}\0`;

test("parseCommitDetails reads numstat's per-file line counts", () => {
  const output = numstatZ("abc123\x1fFix the thing", [
    "12\t5\tsrc/a.ts",
    "3\t0\tsrc/b.ts",
    "0\t2\tsrc/c.ts",
    "-\t-\timage.png",
  ]);
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

test("parseCommitDetails returns real paths for renames, spaces, non-ASCII and tabs", () => {
  const details = parseCommitDetails(
    numstatZ("abc123\x1fMixed", [
      "1\t0\tcafé.txt",
      "0\t0\t\0old name.txt\0new {a => b}.txt",
      "2\t2\t\0dir/from.ts\0dir/to.ts",
      "3\t1\ta\tb.txt",
      "4\t0\t日本語/ファイル.md",
    ]),
  );
  assert.deepEqual(
    details.files.map((f) => [f.path, f.oldPath, f.status]),
    [
      ["café.txt", undefined, "A"],
      ["new {a => b}.txt", "old name.txt", "R"],
      ["dir/to.ts", "dir/from.ts", "R"],
      ["a\tb.txt", undefined, "M"],
      ["日本語/ファイル.md", undefined, "A"],
    ],
  );
  assert.equal(details.insertions, 10);
  assert.equal(details.deletions, 3);
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
