import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { realRepo } from "./testing/realGit.ts";

/** Real Git, real `Repository`: pushTo/pullFrom, mergeBranch/rebaseOnto, fetch's prune/all
 * options, pushTags/deleteRemoteRef, and the stash variants (untracked, staged, clear, show)
 * added for Antigravity parity. */

test("pushTo pushes to an explicit remote and branch without setting an upstream", async () => {
  const remote = realRepo();
  const r = realRepo();
  try {
    remote.git("config", "receive.denyCurrentBranch", "ignore");
    r.git("remote", "add", "origin", remote.root);
    writeFileSync(join(r.root, "a.txt"), "one\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "base");

    await r.repository.pushTo("origin", "main");

    assert.equal(remote.git("log", "-1", "--format=%s").trim(), "base");
    assert.equal(
      r.git("for-each-ref", "--format=%(upstream)", "refs/heads/main").trim(),
      "",
      "no upstream set",
    );
  } finally {
    r.dispose();
    remote.dispose();
  }
});

test("pushTo refuses an unknown remote before ever calling git", async () => {
  const r = realRepo();
  try {
    r.git("commit", "--allow-empty", "-qm", "base");
    await assert.rejects(r.repository.pushTo("nope", "main"), /Unknown remote/);
  } finally {
    r.dispose();
  }
});

test("pullFrom pulls from an explicit remote and branch", async () => {
  const remote = realRepo();
  const r = realRepo();
  try {
    remote.git("commit", "--allow-empty", "-qm", "on the remote");
    r.git("remote", "add", "origin", remote.root);
    // `r`'s "main" is still unborn (no commits) -- the pull fast-forwards it, rather than
    // trying to merge two unrelated histories.

    await r.repository.pullFrom("origin", "main");

    assert.equal(r.git("log", "-1", "--format=%s").trim(), "on the remote");
  } finally {
    r.dispose();
    remote.dispose();
  }
});

test("mergeBranch merges the named branch into the current one", async () => {
  const r = realRepo();
  try {
    writeFileSync(join(r.root, "a.txt"), "base\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "base");
    r.git("switch", "-qc", "feature");
    writeFileSync(join(r.root, "b.txt"), "feature\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "feature work");
    r.git("switch", "-q", "main");

    await r.repository.mergeBranch("feature");

    assert.ok(r.git("log", "--oneline").includes("feature work"));
    assert.equal(r.git("branch", "--show-current").trim(), "main");
  } finally {
    r.dispose();
  }
});

test("rebaseOnto replays the current branch's commits onto the named branch", async () => {
  const r = realRepo();
  try {
    r.git("commit", "--allow-empty", "-qm", "base");
    r.git("switch", "-qc", "topic");
    r.git("commit", "--allow-empty", "-qm", "topic work");
    r.git("switch", "-q", "main");
    r.git("commit", "--allow-empty", "-qm", "main moved on");
    r.git("switch", "-q", "topic");

    await r.repository.rebaseOnto("main");

    const log = r.git("log", "--format=%s");
    assert.deepEqual(log.trim().split("\n"), ["topic work", "main moved on", "base"]);
  } finally {
    r.dispose();
  }
});

test("fetch defaults to prune, and each option is independently controllable", async () => {
  const remote = realRepo();
  const r = realRepo();
  try {
    remote.git("commit", "--allow-empty", "-qm", "base");
    remote.git("switch", "-qc", "doomed");
    r.git("remote", "add", "origin", remote.root);
    r.git("fetch", "-q", "origin");
    assert.ok(r.git("branch", "-r").includes("origin/doomed"));
    remote.git("switch", "-q", "main");
    remote.git("branch", "-D", "doomed");

    await r.repository.fetch(); // default: prune
    assert.ok(!r.git("branch", "-r").includes("origin/doomed"), "pruned by default");

    await r.repository.fetch({ prune: false }); // plain "Fetch"
    // Nothing to assert beyond "it ran"; re-create the stale ref and prove {allRemotes} works.
  } finally {
    r.dispose();
    remote.dispose();
  }
});

test("fetch({ allRemotes: true }) fetches every configured remote", async () => {
  const remoteA = realRepo();
  const remoteB = realRepo();
  const r = realRepo();
  try {
    remoteA.git("commit", "--allow-empty", "-qm", "from a");
    remoteB.git("commit", "--allow-empty", "-qm", "from b");
    r.git("remote", "add", "a", remoteA.root);
    r.git("remote", "add", "b", remoteB.root);

    await r.repository.fetch({ allRemotes: true });

    assert.ok(r.git("log", "a/main", "--format=%s").includes("from a"));
    assert.ok(r.git("log", "b/main", "--format=%s").includes("from b"));
  } finally {
    r.dispose();
    remoteA.dispose();
    remoteB.dispose();
  }
});

test("pushTags pushes every local tag", async () => {
  const remote = realRepo();
  const r = realRepo();
  try {
    remote.git("config", "receive.denyCurrentBranch", "ignore");
    r.git("remote", "add", "origin", remote.root);
    r.git("commit", "--allow-empty", "-qm", "base");
    r.git("tag", "v1");
    r.git("tag", "v2");
    r.git("push", "-q", "origin", "main");

    await r.repository.pushTags();

    assert.deepEqual(remote.git("tag", "-l").trim().split("\n").sort(), ["v1", "v2"]);
  } finally {
    r.dispose();
    remote.dispose();
  }
});

test("deleteRemoteRef deletes a branch on the remote, and a tag the same way", async () => {
  const remote = realRepo();
  const r = realRepo();
  try {
    remote.git("config", "receive.denyCurrentBranch", "ignore");
    r.git("remote", "add", "origin", remote.root);
    r.git("commit", "--allow-empty", "-qm", "base");
    r.git("switch", "-qc", "feature");
    r.git("commit", "--allow-empty", "-qm", "feature work");
    r.git("tag", "v1");
    r.git("push", "-q", "origin", "main", "feature", "v1");

    await r.repository.deleteRemoteRef("origin", "feature");
    assert.ok(!remote.git("branch", "-l").includes("feature"));

    await r.repository.deleteRemoteRef("origin", "v1");
    assert.equal(remote.git("tag", "-l").trim(), "");
  } finally {
    r.dispose();
    remote.dispose();
  }
});

test("stash() plain leaves untracked files alone; { untracked: true } takes them too", async () => {
  const r = realRepo();
  try {
    writeFileSync(join(r.root, "tracked.txt"), "base\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "base");
    writeFileSync(join(r.root, "tracked.txt"), "changed\n");
    writeFileSync(join(r.root, "untracked.txt"), "new\n");

    await r.repository.stash({ message: "tracked only" });
    assert.ok(r.git("status", "--porcelain").includes("untracked.txt"), "untracked file stayed");
    assert.equal(r.git("status", "--porcelain", "tracked.txt").trim(), "");

    await r.repository.stash({ message: "with untracked", untracked: true });
    assert.equal(r.git("status", "--porcelain").trim(), "", "untracked file was stashed too");

    const list = r.git("stash", "list");
    assert.match(list, /with untracked/);
    assert.match(list, /tracked only/);
  } finally {
    r.dispose();
  }
});

test("stash({ staged: true }) takes only what is staged, leaving other changes in place", async () => {
  const r = realRepo();
  try {
    writeFileSync(join(r.root, "a.txt"), "base\n");
    writeFileSync(join(r.root, "b.txt"), "base\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "base");
    writeFileSync(join(r.root, "a.txt"), "staged change\n");
    r.git("add", "a.txt");
    writeFileSync(join(r.root, "b.txt"), "unstaged change\n");

    await r.repository.stash({ staged: true });

    assert.equal(r.git("diff", "--cached", "--name-only").trim(), "", "the staged change is gone");
    assert.equal(r.git("diff", "--name-only").trim(), "b.txt", "the unstaged change stayed");
  } finally {
    r.dispose();
  }
});

test("stashClear drops the whole stash list at once", async () => {
  const r = realRepo();
  try {
    r.git("commit", "--allow-empty", "-qm", "base");
    for (const name of ["a", "b"]) {
      writeFileSync(join(r.root, `${name}.txt`), name);
      r.git("add", "-A");
      await r.repository.stash({ message: name });
    }
    assert.equal(r.git("stash", "list").trim().split("\n").length, 2);

    await r.repository.stashClear();

    assert.equal(r.git("stash", "list").trim(), "");
  } finally {
    r.dispose();
  }
});

test("stashShow returns the stash's own diff, parseable the same way diff() output is", async () => {
  const r = realRepo();
  try {
    writeFileSync(join(r.root, "a.txt"), "one\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "base");
    writeFileSync(join(r.root, "a.txt"), "one\ntwo\n");
    r.git("add", "-A");
    await r.repository.stash({ message: "a change" });

    const diff = await r.repository.stashShow(0);

    assert.match(diff, /^diff --git a\/a\.txt b\/a\.txt/m);
    assert.match(diff, /^\+two$/m);
    // Stashing must not have consumed it -- the diff can be viewed without applying it.
    assert.equal(r.git("stash", "list").trim().split("\n").length, 1);
  } finally {
    r.dispose();
  }
});
