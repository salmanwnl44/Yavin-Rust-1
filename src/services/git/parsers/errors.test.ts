import assert from "node:assert/strict";
import test from "node:test";
import { describeGitError, categorizeGitError } from "./errors.ts";
import type { GitErrorCategory } from "./errors.ts";

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
  assert.match(describeGitError("error: a.ts: patch does not apply"), /no longer matches the file/);
  assert.match(describeGitError("error: patch failed: a.ts:10"), /no longer matches the file/);
});

test("deleting a branch checked out elsewhere is explained instead of showing raw stderr", () => {
  assert.match(
    describeGitError("Git: error: cannot delete branch 'feature' used by worktree at '/repo/wt'"),
    /checked out in another worktree/,
  );
});

test("deleting an unmerged branch without force is explained with a clear escalation path", () => {
  assert.match(
    describeGitError("Git: error: the branch 'other' is not fully merged"),
    /commits not on any other branch/,
  );
});

test("rebase's continue-before-resolving refusal is already covered by the existing CONFLICT pattern", () => {
  // Verified against a real repository (Module 7's plan, Section D.5): rebase's
  // apply-backend refusal text happens to contain "conflicts", so it was already
  // matched by the pre-existing /CONFLICT/i pattern before this phase -- no new
  // pattern was actually needed for this specific message, only for the
  // commit-backend one below (a correction made while writing this test, not
  // assumed from the plan's own text).
  assert.match(
    describeGitError(
      "f.txt: needs merge\nYou must edit all merge conflicts and then\nmark them as resolved using git add",
    ),
    /Conflicts need resolving/,
  );
});

test("merge/revert/cherry-pick's continue-before-resolving refusal is explained instead of raw stderr", () => {
  // The one message family genuinely unclassified before this phase (verified,
  // Section D.5/D.6): identical text for merge, revert, and cherry-pick.
  assert.match(
    describeGitError("error: Committing is not possible because you have unmerged files."),
    /still unresolved/,
  );
});

test("starting a new operation while one is already active is explained instead of showing raw stderr", () => {
  assert.match(
    describeGitError("Git: error: you need to resolve your current index first"),
    /already in progress/,
  );
  assert.match(
    describeGitError("Git: error: cherry-pick is already in progress"),
    /already in progress/,
  );
});

test("categorizeGitError maps real Git failure text to a machine-checkable category", () => {
  const cases: [string, GitErrorCategory][] = [
    ["Cancelled", "cancelled"],
    ["Error: Another Git operation is already running for this worktree.", "busy"],
    ["Save or close unsaved editors before changing the working tree.", "dirty"],
    ["Git: fatal: Authentication failed for 'https://x'", "auth"],
    ["Git: git@github.com: Permission denied (publickey).", "auth"],
    ["Git: fatal: Could not resolve host: github.com", "network"],
    ["Git: fatal: The current branch x has no upstream branch.", "no-upstream"],
    ["Git: ! [rejected] main -> main (non-fast-forward)", "non-fast-forward"],
    ["Git: fatal: Not possible to fast-forward, aborting.", "diverged"],
    ["error: Committing is not possible because you have unmerged files.", "conflict"],
    ["CONFLICT (content): Merge conflict in f.txt", "conflict"],
    ["fatal: 'feature' is already used by worktree at '/x'", "worktree-conflict"],
    ["error: the branch 'other' is not fully merged", "unmerged-branch"],
    ["nothing to commit, working tree clean", "nothing-to-commit"],
    ["error: you need to resolve your current index first", "operation-in-progress"],
    ["something entirely unexpected", "unclassified"],
  ];
  for (const [text, category] of cases) assert.equal(categorizeGitError(text), category, text);
});

test("pulling a branch that is not on the remote yet says so plainly", () => {
  // Real git output from pulling right after cloning an empty repository.
  const raw =
    "Your configuration specifies to merge with the ref 'refs/heads/main'\nfrom the remote, but no such ref was fetched.";
  assert.match(describeGitError(raw), /does not have this branch yet/);
  assert.equal(categorizeGitError(raw), "no-upstream");
  assert.match(
    describeGitError("fatal: couldn't find remote ref main"),
    /does not have this branch/,
  );
});
