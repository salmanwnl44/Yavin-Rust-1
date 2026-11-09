import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { realRepo } from "./testing/realGit.ts";

/**
 * Real-Git integration coverage for commit identity and the commit preflight (WS24).
 *
 * These exercise the production `Repository.commit()` path against the real `git` binary,
 * through the same `describeGitError` layer the UI shows -- the synthetic `errors.test.ts`
 * proves the pattern matches a captured string; this proves real Git still emits a string
 * that pattern catches, and that the preflight refusals fire before Git runs.
 */

test("commit without a configured identity fails with an actionable message, not raw Git text", async () => {
  const r = realRepo();
  try {
    // Force Git to refuse guessing an identity on any machine -- otherwise a developer's
    // global user.name/user.email (or an auto-detected username@host) would let the commit
    // through and this would pass only where no identity is configured.
    r.git("config", "user.useConfigOnly", "true");
    r.git("config", "--unset-all", "user.email");
    r.git("config", "--unset-all", "user.name");
    writeFileSync(join(r.root, "a.txt"), "hello\n");
    r.git("add", "a.txt");

    await assert.rejects(r.repository.commit("a message"), (error: Error) => {
      assert.match(error.message, /does not know who to record as the author/);
      assert.match(error.message, /git config user\.name/);
      // The real Git stderr is still carried through, nothing hidden.
      assert.match(error.message, /Git said:/);
      return true;
    });

    // The identity failure must not have produced a commit.
    assert.equal(r.git("rev-list", "--count", "--all").trim(), "0");
  } finally {
    r.dispose();
  }
});

test("commit refuses an empty or whitespace-only message before running Git", async () => {
  const r = realRepo();
  try {
    writeFileSync(join(r.root, "a.txt"), "hello\n");
    r.git("add", "a.txt");
    await assert.rejects(r.repository.commit("   \n\t"), /Enter a commit message/);
    // Nothing was committed by the refused attempt.
    assert.equal(r.git("rev-list", "--count", "--all").trim(), "0");
  } finally {
    r.dispose();
  }
});

test("commit records only what is staged, never unstaged working-tree changes", async () => {
  const r = realRepo();
  try {
    writeFileSync(join(r.root, "staged.txt"), "one\n");
    writeFileSync(join(r.root, "loose.txt"), "two\n");
    r.git("add", "staged.txt");
    await r.repository.commit("only the staged file");

    // The commit's tree holds staged.txt and not loose.txt.
    const tree = r.git("show", "--name-only", "--pretty=format:", "HEAD").trim();
    assert.equal(tree, "staged.txt");
    // loose.txt is still an untracked working-tree file.
    assert.match(r.git("status", "--porcelain"), /^\?\? loose\.txt$/m);
  } finally {
    r.dispose();
  }
});

test("commit refuses while a path is still conflicted in the index", async () => {
  const r = realRepo();
  try {
    // Build a real both-modified conflict.
    writeFileSync(join(r.root, "c.txt"), "base\n");
    r.git("add", "c.txt");
    r.git("commit", "-qm", "base");
    r.git("switch", "-qc", "feature");
    writeFileSync(join(r.root, "c.txt"), "feature\n");
    r.git("commit", "-aqm", "feature");
    r.git("switch", "-q", "main");
    writeFileSync(join(r.root, "c.txt"), "main\n");
    r.git("commit", "-aqm", "main");
    // merge is expected to exit non-zero (conflict); swallow it.
    try {
      r.git("merge", "feature");
    } catch {
      /* expected conflict */
    }

    await assert.rejects(
      r.repository.commit("try to commit mid-conflict"),
      /Resolve and stage conflicts before committing/,
    );
  } finally {
    r.dispose();
  }
});
