import assert from "node:assert/strict";
import test from "node:test";
import { divergence, parseBranch } from "./branch.ts";

test("branch state distinguishes unpublished, synced, ahead, behind and diverged", () => {
  const branch = (upstream: string, ahead: number, behind: number) =>
    divergence({ name: "main", detached: false, upstream, ahead, behind });
  assert.equal(branch("", 3, 0), "unpublished");
  assert.equal(branch("origin/main", 0, 0), "synced");
  assert.equal(branch("origin/main", 2, 0), "ahead");
  assert.equal(branch("origin/main", 0, 2), "behind");
  assert.equal(branch("origin/main", 2, 2), "diverged");
});

test("parseBranch reads upstream and both counts from porcelain v2", () => {
  const info = parseBranch(
    "# branch.oid abc123\n# branch.head feature/x\n# branch.upstream origin/feature/x\n# branch.ab +3 -4\n",
  );
  assert.deepEqual(info, {
    name: "feature/x",
    detached: false,
    upstream: "origin/feature/x",
    ahead: 3,
    behind: 4,
  });
  // An unborn or unpublished branch reports neither upstream nor counts.
  assert.deepEqual(parseBranch("# branch.head main\n"), {
    name: "main",
    detached: false,
    upstream: "",
    ahead: 0,
    behind: 0,
  });
});

test("parseBranch reports a detached HEAD explicitly, not as a literal branch name", () => {
  // Real `git status --porcelain=v2 --branch` output while detached: no upstream/ab
  // lines are ever emitted (verified against a real repository).
  const info = parseBranch("# branch.oid abc123\n# branch.head (detached)\n");
  assert.deepEqual(info, {
    name: "",
    detached: true,
    upstream: "",
    ahead: 0,
    behind: 0,
  });
});
