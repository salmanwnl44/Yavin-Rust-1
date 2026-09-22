import assert from "node:assert/strict";
import test from "node:test";
import { realRepo } from "./testing/realGit.ts";

/** Real Git, real `Repository`: createBranchFrom, added for the "Create Branch From…" menu
 * item -- like createBranch, but starting from an explicit point instead of HEAD. */

test("createBranchFrom starts the new branch from the given point, not from HEAD", async () => {
  const r = realRepo();
  try {
    r.git("commit", "--allow-empty", "-qm", "base");
    r.git("switch", "-qc", "old-point");
    r.git("commit", "--allow-empty", "-qm", "old point's own commit");
    r.git("switch", "-q", "main");
    r.git("commit", "--allow-empty", "-qm", "main moved on");

    await r.repository.createBranchFrom("new-branch", "old-point");

    assert.equal(r.git("branch", "--show-current").trim(), "new-branch", "switched to it");
    assert.equal(
      r.git("rev-parse", "new-branch").trim(),
      r.git("rev-parse", "old-point").trim(),
      "starts at old-point's commit, not main's",
    );
  } finally {
    r.dispose();
  }
});

test("createBranchFrom refuses a name Git itself would reject, before ever calling switch", async () => {
  const r = realRepo();
  try {
    r.git("commit", "--allow-empty", "-qm", "base");
    await assert.rejects(r.repository.createBranchFrom("bad..name", "main"));
    assert.equal(r.git("branch", "--show-current").trim(), "main", "still on main");
  } finally {
    r.dispose();
  }
});
