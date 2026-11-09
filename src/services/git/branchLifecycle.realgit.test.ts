import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { realRepo } from "./testing/realGit.ts";
import { parseBranch } from "./parsers/branch.ts";

/**
 * Real-Git integration coverage for the everyday branch lifecycle (WS24, scope item 6):
 * create, switch, delete, and the detached-HEAD state surfaced through `branchInfo()` ->
 * `parseBranch`. (Rename and create-from-point are covered in `repositoryMutations*`.)
 */

/** One commit so HEAD exists and branches can be created. */
function withHead(r: ReturnType<typeof realRepo>): string {
  writeFileSync(join(r.root, "a.txt"), "one\n");
  r.git("add", "a.txt");
  r.git("commit", "-qm", "first");
  return r.git("rev-parse", "HEAD").trim();
}

test("createBranch then switchBranch report the current branch through porcelain v2", async () => {
  const r = realRepo();
  try {
    withHead(r);
    await r.repository.createBranch("feature/login");
    let branch = parseBranch(await r.repository.branchInfo());
    assert.equal(branch.name, "feature/login");
    assert.equal(branch.detached, false);

    await r.repository.switchBranch("main");
    branch = parseBranch(await r.repository.branchInfo());
    assert.equal(branch.name, "main");
  } finally {
    r.dispose();
  }
});

test("createBranch refuses a name Git itself would reject, before switching", async () => {
  const r = realRepo();
  try {
    withHead(r);
    await assert.rejects(r.repository.createBranch("bad..name"));
    // Still on main; no stray branch was created.
    assert.equal(parseBranch(await r.repository.branchInfo()).name, "main");
    assert.doesNotMatch(r.git("branch", "--list"), /bad\.\.name/);
  } finally {
    r.dispose();
  }
});

test("deleteBranch honours Git's merged/unmerged safety and force override", async () => {
  const r = realRepo();
  try {
    withHead(r);
    // An unmerged branch with a unique commit.
    await r.repository.createBranch("wip");
    writeFileSync(join(r.root, "b.txt"), "wip\n");
    r.git("add", "b.txt");
    r.git("commit", "-qm", "wip commit");
    await r.repository.switchBranch("main");

    // Non-force delete of an unmerged branch is refused with the explained escalation.
    await assert.rejects(
      r.repository.deleteBranch("wip", false),
      /commits not on any other branch/,
    );
    assert.match(r.git("branch", "--list"), /wip/);

    // Force delete removes it.
    await r.repository.deleteBranch("wip", true);
    assert.doesNotMatch(r.git("branch", "--list"), /wip/);
  } finally {
    r.dispose();
  }
});

test("a detached HEAD is reported as detached, with no branch name", async () => {
  const r = realRepo();
  try {
    const first = withHead(r);
    writeFileSync(join(r.root, "a.txt"), "two\n");
    r.git("commit", "-aqm", "second");

    // Detach onto the first commit.
    r.git("checkout", "-q", first);
    const branch = parseBranch(await r.repository.branchInfo());
    assert.equal(branch.detached, true);
    assert.equal(branch.name, "");
  } finally {
    r.dispose();
  }
});
