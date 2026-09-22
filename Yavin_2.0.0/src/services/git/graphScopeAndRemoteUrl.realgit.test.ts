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
