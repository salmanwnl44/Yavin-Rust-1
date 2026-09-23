import assert from "node:assert/strict";
import test from "node:test";
import { realRepo } from "./testing/realGit.ts";
import { parseGraphLog } from "./parsers/log.ts";

/** Real Git, real `Repository`: graphLog's ref-scope parameter and remoteUrl(), added for the
 * graph's ref-scope picker and the commit hover card's "Open on GitHub" link. */

test("graphLog with no scope shows only HEAD's own history", async () => {
  const r = realRepo();
  try {
    r.git("commit", "--allow-empty", "-qm", "on main");
    r.git("switch", "-qc", "other");
    r.git("commit", "--allow-empty", "-qm", "on other");
    r.git("switch", "-q", "main");

    const commits = parseGraphLog(await r.repository.graphLog(0, 50));
    assert.deepEqual(
      commits.map((c) => c.subject),
      ["on main"],
    );
  } finally {
    r.dispose();
  }
});

test('graphLog({scope: "all"}) shows every branch\'s history', async () => {
  const r = realRepo();
  try {
    r.git("commit", "--allow-empty", "-qm", "on main");
    r.git("switch", "-qc", "other");
    r.git("commit", "--allow-empty", "-qm", "on other");
    r.git("switch", "-q", "main");

    const commits = parseGraphLog(await r.repository.graphLog(0, 50, "all"));
    assert.deepEqual(commits.map((c) => c.subject).sort(), ["on main", "on other"].sort());
  } finally {
    r.dispose();
  }
});

test("graphLog(scope: <branch>) shows that branch's history instead of HEAD's", async () => {
  const r = realRepo();
  try {
    r.git("commit", "--allow-empty", "-qm", "on main");
    r.git("switch", "-qc", "other");
    r.git("commit", "--allow-empty", "-qm", "on other");
    r.git("switch", "-q", "main");

    const commits = parseGraphLog(await r.repository.graphLog(0, 50, "other"));
    assert.deepEqual(
      commits.map((c) => c.subject),
      ["on other", "on main"],
    );
  } finally {
    r.dispose();
  }
});

test("remoteUrl reads back exactly what addRemote configured", async () => {
  const r = realRepo();
  try {
    await r.repository.addRemote("origin", "https://example.com/owner/repo.git");
    assert.equal(await r.repository.remoteUrl("origin"), "https://example.com/owner/repo.git");
  } finally {
    r.dispose();
  }
});

test("refs lists local heads and remote-tracking refs, and leaves origin/HEAD out", async () => {
  // The scope picker asks a different question from everything else that wants a branch
  // list: "whose history do I want to see", for which `origin/main` is a real answer.
  const r = realRepo();
  try {
    r.git("commit", "--allow-empty", "-qm", "first");
    // A remote with real refs, without needing a network: clone this repo into another and
    // fetch back from it, so refs/remotes/origin/* genuinely exists.
    const other = realRepo();
    try {
      other.git("commit", "--allow-empty", "-qm", "theirs");
      other.git("switch", "-qc", "feature");
      other.git("commit", "--allow-empty", "-qm", "their feature");
      r.git("remote", "add", "origin", other.root);
      r.git("fetch", "-q", "origin");
      r.git("remote", "set-head", "origin", "-a");

      const { local, remote } = await r.repository.refs();
      assert.ok(remote.includes("origin/feature"), `expected origin/feature in ${remote}`);
      assert.ok(
        !remote.some((name: string) => name.endsWith("/HEAD")),
        `origin/HEAD is a pointer, not a branch to pick: ${remote}`,
      );
      // The local list is unaffected: the two are not interchangeable.
      assert.deepEqual(local, ["main"]);
    } finally {
      other.dispose();
    }
  } finally {
    r.dispose();
  }
});

test("graphLog can be scoped to a remote-tracking branch", async () => {
  const r = realRepo();
  try {
    r.git("commit", "--allow-empty", "-qm", "mine");
    const other = realRepo();
    try {
      other.git("commit", "--allow-empty", "-qm", "theirs");
      r.git("remote", "add", "origin", other.root);
      r.git("fetch", "-q", "origin");

      const commits = parseGraphLog(await r.repository.graphLog(0, 50, "origin/main"));
      assert.deepEqual(
        commits.map((c) => c.subject),
        ["theirs"],
        "the remote branch's history, not this worktree's",
      );
    } finally {
      other.dispose();
    }
  } finally {
    r.dispose();
  }
});
