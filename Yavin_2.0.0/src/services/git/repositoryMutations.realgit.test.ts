import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { realRepo } from "./testing/realGit.ts";

/** Real Git, real `Repository`: the new commit variants, undo-last-commit, remote add/remove,
 * tag create/delete and branch rename added for Antigravity parity. */

test("commit(all) stages every tracked modification before committing", async () => {
  const r = realRepo();
  try {
    writeFileSync(join(r.root, "a.txt"), "one\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "base");
    writeFileSync(join(r.root, "a.txt"), "two\n");

    await r.repository.commit("commit all", { all: true });

    assert.equal(r.git("status", "--porcelain").trim(), "");
    assert.equal(r.git("log", "-1", "--format=%s").trim(), "commit all");
  } finally {
    r.dispose();
  }
});

test("commit(amend) replaces HEAD instead of adding a new commit", async () => {
  const r = realRepo();
  try {
    writeFileSync(join(r.root, "a.txt"), "one\n");
    r.git("add", "-A");
    await r.repository.commit("first message");
    const before = r.git("rev-list", "--count", "HEAD").trim();

    writeFileSync(join(r.root, "b.txt"), "two\n");
    r.git("add", "-A");
    await r.repository.commit("amended message", { amend: true });

    assert.equal(r.git("rev-list", "--count", "HEAD").trim(), before, "still one commit");
    assert.equal(r.git("log", "-1", "--format=%s").trim(), "amended message");
    assert.deepEqual(r.git("show", "--name-only", "--format=", "HEAD").trim().split("\n").sort(), [
      "a.txt",
      "b.txt",
    ]);
  } finally {
    r.dispose();
  }
});

test("commit(signoff) appends a Signed-off-by trailer", async () => {
  const r = realRepo();
  try {
    writeFileSync(join(r.root, "a.txt"), "one\n");
    r.git("add", "-A");
    await r.repository.commit("signed", { signoff: true });
    assert.match(r.git("log", "-1", "--format=%B"), /Signed-off-by: Tester <t@example\.com>/);
  } finally {
    r.dispose();
  }
});

test("undoLastCommit moves HEAD back one commit and keeps its changes staged", async () => {
  const r = realRepo();
  try {
    writeFileSync(join(r.root, "a.txt"), "one\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "base");
    writeFileSync(join(r.root, "b.txt"), "two\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "to be undone");

    await r.repository.undoLastCommit();

    assert.equal(r.git("log", "-1", "--format=%s").trim(), "base");
    assert.equal(r.git("diff", "--cached", "--name-only").trim(), "b.txt", "kept in the index");
  } finally {
    r.dispose();
  }
});

test("undoLastCommit refuses with a plain explanation when there is no earlier commit", async () => {
  const r = realRepo();
  try {
    r.git("commit", "--allow-empty", "-qm", "the only commit");
    await assert.rejects(r.repository.undoLastCommit(), /no earlier commit/);
    assert.equal(r.git("log", "--oneline").trim().split("\n").length, 1, "nothing was reset");
  } finally {
    r.dispose();
  }
});

test("addRemote and removeRemote round-trip through git remote -v", async () => {
  const r = realRepo();
  try {
    await r.repository.addRemote("origin", "https://example.com/repo.git");
    assert.match(r.git("remote", "-v"), /origin\s+https:\/\/example\.com\/repo\.git/);
    assert.deepEqual(await r.repository.remotes(), ["origin"]);

    await r.repository.removeRemote("origin");
    assert.equal(r.git("remote").trim(), "");
    assert.deepEqual(await r.repository.remotes(), []);
  } finally {
    r.dispose();
  }
});

test("createTag and deleteTag round-trip through git tag -l", async () => {
  const r = realRepo();
  try {
    r.git("commit", "--allow-empty", "-qm", "base");
    await r.repository.createTag("v1.0.0");
    assert.deepEqual(await r.repository.tags(), ["v1.0.0"]);
    assert.equal(r.git("rev-parse", "v1.0.0").trim(), r.git("rev-parse", "HEAD").trim());

    await r.repository.deleteTag("v1.0.0");
    assert.deepEqual(await r.repository.tags(), []);
  } finally {
    r.dispose();
  }
});

test("createTag refuses a name Git itself would reject, before ever calling tag", async () => {
  const r = realRepo();
  try {
    r.git("commit", "--allow-empty", "-qm", "base");
    await assert.rejects(r.repository.createTag("bad..name"));
    assert.deepEqual(await r.repository.tags(), []);
  } finally {
    r.dispose();
  }
});

test("renameBranch renames the branch, including the one currently checked out", async () => {
  const r = realRepo();
  try {
    r.git("commit", "--allow-empty", "-qm", "base");
    r.git("branch", "feature-old");

    // Renaming a branch that is NOT checked out here.
    await r.repository.renameBranch("feature-old", "feature-new");
    assert.deepEqual((await r.repository.refs()).local, ["feature-new", "main"]);

    // Renaming the branch that IS checked out here moves HEAD's own name along with it.
    await r.repository.renameBranch("main", "trunk");
    assert.equal(r.git("branch", "--show-current").trim(), "trunk");
    assert.deepEqual((await r.repository.refs()).local.sort(), ["feature-new", "trunk"]);
  } finally {
    r.dispose();
  }
});
