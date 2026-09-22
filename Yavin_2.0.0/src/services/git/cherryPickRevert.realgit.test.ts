import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { realRepo } from "./testing/realGit.ts";

/**
 * Real Git, real `Repository`: applying one commit onto the current branch and undoing one
 * with a new commit. Both were previously reachable only as `--abort`/`--continue`/`--skip`
 * on an operation started somewhere else.
 */

test("cherryPick applies just that commit's change onto the current branch", async () => {
  const r = realRepo();
  try {
    writeFileSync(`${r.root}/a.txt`, "base\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "base");

    r.git("switch", "-qc", "feature");
    writeFileSync(`${r.root}/picked.txt`, "from feature\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "the one to pick");
    const wanted = r.git("rev-parse", "HEAD").trim();
    // A second commit that must NOT come along.
    writeFileSync(`${r.root}/not-picked.txt`, "later\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "later work");

    r.git("switch", "-q", "main");
    await r.repository.cherryPick(wanted);

    assert.equal(readFileSync(`${r.root}/picked.txt`, "utf8"), "from feature\n");
    assert.ok(!existsSync(`${r.root}/not-picked.txt`), "only the named commit is applied");
    assert.match(r.git("log", "-1", "--pretty=%s"), /the one to pick/);
  } finally {
    r.dispose();
  }
});

test("revertCommit adds a new commit undoing the change, keeping the original in history", async () => {
  const r = realRepo();
  try {
    writeFileSync(`${r.root}/a.txt`, "first\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "add a.txt");

    writeFileSync(`${r.root}/a.txt`, "second\n");
    r.git("commit", "-qam", "change a.txt");
    const toUndo = r.git("rev-parse", "HEAD").trim();

    await r.repository.revertCommit(toUndo);

    assert.equal(readFileSync(`${r.root}/a.txt`, "utf8"), "first\n", "content is back");
    // History gains a commit rather than losing one -- that is what makes revert safe.
    assert.equal(r.git("rev-list", "--count", "HEAD").trim(), "3");
    assert.match(r.git("log", "-1", "--pretty=%s"), /Revert/);
  } finally {
    r.dispose();
  }
});

test("a conflicting cherry-pick stops and leaves the operation resolvable, not silently failed", async () => {
  const r = realRepo();
  try {
    writeFileSync(`${r.root}/a.txt`, "base\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "base");

    r.git("switch", "-qc", "feature");
    writeFileSync(`${r.root}/a.txt`, "feature version\n");
    r.git("commit", "-qam", "feature edit");
    const wanted = r.git("rev-parse", "HEAD").trim();

    r.git("switch", "-q", "main");
    writeFileSync(`${r.root}/a.txt`, "main version\n");
    r.git("commit", "-qam", "main edit");

    await assert.rejects(() => r.repository.cherryPick(wanted), "the conflict is reported");
    // CHERRY_PICK_HEAD is what the panel's in-progress banner keys off (via the native
    // `git_repo_state`, which this harness does not run), and it already knows how to
    // continue, skip or abort a cherry-pick.
    assert.ok(existsSync(`${r.root}/.git/CHERRY_PICK_HEAD`), "left resolvable, not rolled back");
    assert.match(readFileSync(`${r.root}/a.txt`, "utf8"), /<<<<<<</, "markers to resolve");
  } finally {
    r.dispose();
  }
});

test("a revision expression is refused before it can apply a whole range", async () => {
  // `a..b` would apply every commit between two points -- a very different operation from
  // the single commit the UI offers.
  const r = realRepo();
  try {
    r.git("commit", "--allow-empty", "-qm", "one");
    r.git("commit", "--allow-empty", "-qm", "two");
    for (const bad of ["HEAD~1", "HEAD", "main..feature", "v1.0", "abc"]) {
      await assert.rejects(() => r.repository.cherryPick(bad), `must refuse: ${bad}`);
      await assert.rejects(() => r.repository.revertCommit(bad), `must refuse: ${bad}`);
    }
  } finally {
    r.dispose();
  }
});
