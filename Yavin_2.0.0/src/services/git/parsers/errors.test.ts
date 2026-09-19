import assert from "node:assert/strict";
import test from "node:test";
import { describeGitError } from "./errors.ts";

test("Git failures are explained without hiding what Git said", () => {
  const auth = describeGitError(
    new Error(
      "Git: fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    ),
  );
  assert.match(auth, /never prompts for passwords/);
  assert.match(auth, /Git said: fatal: could not read Username/);

  assert.match(
    describeGitError("Git: ! [rejected] main -> main (non-fast-forward)"),
    /does not force push/,
  );
  assert.match(
    describeGitError("fatal: Not possible to fast-forward, aborting."),
    /Choose Rebase or Merge/,
  );
  assert.match(
    describeGitError("error: Your local changes to the following files would be overwritten"),
    /never stashes your work/,
  );
  assert.match(describeGitError("CONFLICT (content): Merge conflict in a.ts"), /stage each one/);
  assert.match(
    describeGitError("fatal: The current branch x has no upstream branch"),
    /Publish it to a remote/,
  );
  assert.match(describeGitError("Permission denied (publickey)."), /SSH key/);

  // A rejection by a hook must never read as if Yavin could retry past it.
  assert.match(describeGitError("pre-push hook declined"), /never bypasses hooks/);

  // Anything unrecognized survives verbatim rather than being flattened.
  assert.equal(describeGitError("Git: some unmapped failure"), "some unmapped failure");
  assert.equal(describeGitError(""), "The Git operation failed.");
});

test("cancellation is reported as-is, never run through Git's own error phrasing", () => {
  assert.equal(describeGitError("Cancelled"), "Cancelled");
  assert.equal(describeGitError(new Error("Cancelled")), "Cancelled");
});

test("a missing Git executable is explained instead of showing a raw OS error", () => {
  assert.match(
    describeGitError("Cannot start tool: The system cannot find the file specified. (os error 2)"),
    /Git was not found/,
  );
});

test("a stale hunk's apply failure is explained instead of showing raw patch stderr", () => {
  assert.match(
    describeGitError("error: a.ts: patch does not apply"),
    /no longer matches the file/,
  );
  assert.match(describeGitError("error: patch failed: a.ts:10"), /no longer matches the file/);
});

test("deleting a branch checked out elsewhere is explained instead of showing raw stderr", () => {
  assert.match(
    describeGitError(
      "Git: error: cannot delete branch 'feature' used by worktree at '/repo/wt'",
    ),
    /checked out in another worktree/,
  );
});

test("deleting an unmerged branch without force is explained with a clear escalation path", () => {
  assert.match(
    describeGitError("Git: error: the branch 'other' is not fully merged"),
    /commits not on any other branch/,
  );
});
