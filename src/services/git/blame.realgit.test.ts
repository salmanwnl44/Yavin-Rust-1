/**
 * Inline Git blame (WS9) against **real Git**: `Repository.blame` runs the real `git blame
 * --porcelain` in a throwaway repository, and `parseBlamePorcelain` must map every working-tree
 * line to the commit that last touched it — including a line added but not yet committed.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseBlamePorcelain } from "./blame.ts";
import { realRepo } from "./testing/realGit.ts";

test("blame maps working-tree lines to their commits, with an uncommitted line last (real git)", async () => {
  const r = realRepo();
  try {
    const file = join(r.root, "a.txt");
    writeFileSync(file, "one\ntwo\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "first");
    writeFileSync(file, "one\ntwo\nthree\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "second");
    // A fourth line added to the working tree but not committed.
    writeFileSync(file, "one\ntwo\nthree\nfour\n");

    const lines = parseBlamePorcelain(await r.repository.blame(file));
    assert.equal(lines.length, 4);
    assert.deepEqual(
      lines.slice(0, 3).map((l) => [l.line, l.summary, l.author]),
      [
        [1, "first", "Tester"],
        [2, "first", "Tester"],
        [3, "second", "Tester"],
      ],
      "committed lines carry their commit's summary and author",
    );
    // Committed lines carry a real 40-hex sha and a positive author time.
    assert.match(lines[0]!.sha, /^[0-9a-f]{40}$/);
    assert.notEqual(lines[0]!.sha, "0".repeat(40));
    assert.ok(lines[0]!.authorTime > 0);
    // The working-tree-only line is reported uncommitted (Git's all-zero sha).
    assert.equal(lines[3]!.line, 4);
    assert.equal(lines[3]!.uncommitted, true);
    assert.equal(lines[3]!.author, "Not Committed Yet");
    assert.equal(lines[3]!.sha, "0".repeat(40));
  } finally {
    r.dispose();
  }
});

test("blame resolves a repo-relative path and refuses a path outside the repository (real git)", async () => {
  const r = realRepo();
  try {
    writeFileSync(join(r.root, "a.txt"), "x\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "base");
    assert.match(await r.repository.blame(join(r.root, "a.txt")), /^[0-9a-f]{40} /);
    // A path outside the worktree is rejected before Git runs (relativeToRoot throws).
    await assert.rejects(
      async () => r.repository.blame("C:/elsewhere/secret.txt"),
      /outside the repository/,
    );
  } finally {
    r.dispose();
  }
});
