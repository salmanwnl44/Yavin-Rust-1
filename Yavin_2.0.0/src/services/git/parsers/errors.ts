// Ordered most specific first; the first pattern that matches a message wins.
const failures: [RegExp, string][] = [
  [
    /could not read (Username|Password)|Authentication failed|terminal prompts disabled|invalid credentials/i,
    "Git could not authenticate with the remote. Yavin never prompts for passwords — configure a credential helper or an SSH key, then try again.",
  ],
  [
    /Permission denied \(publickey|Please make sure you have the correct access rights/i,
    "The remote refused your SSH key. Check that the key is loaded in your agent and authorized for this repository.",
  ],
  [
    /Host key verification failed|authenticity of host/i,
    "The remote's host key is not trusted yet. Connect to it once outside Yavin to record the key, then try again.",
  ],
  [
    /does not appear to be a git repository|Could not read from remote repository|No such remote|remote .* already exists/i,
    "The remote is missing or unreadable. Check `git remote -v` and that you can reach the repository.",
  ],
  [
    /Could not resolve host|unable to access|Connection (timed out|refused)|Network is unreachable/i,
    "Could not reach the remote. Check your network connection and try again.",
  ],
  [
    /no upstream|has no upstream branch|set-upstream/i,
    "This branch has no upstream yet. Publish it to a remote to set one.",
  ],
  [
    /non-fast-forward|Updates were rejected|fetch first|behind its remote/i,
    "The remote has commits you do not have. Fetch and review them, then pull before pushing. Yavin does not force push.",
  ],
  [
    /Not possible to fast-forward|diverged|need to specify how to reconcile|divergent branches/i,
    "Your branch and its upstream have diverged. Choose Rebase or Merge to reconcile them.",
  ],
  [
    /local changes .* would be overwritten|Your local changes to the following files/i,
    "Local changes would be overwritten. Commit, stage or discard them first — Yavin never stashes your work for you.",
  ],
  [
    /CONFLICT|fix conflicts|Automatic merge failed|Resolve all conflicts/i,
    "Conflicts need resolving. Edit the conflicted files, stage each one, then continue the operation.",
  ],
  [
    /index\.lock|Another git process/i,
    "Another Git process is using this repository. Wait for it to finish, then refresh.",
  ],
  [
    /nothing to commit|no changes added to commit/i,
    "Nothing is staged. Stage the changes you want in the commit first.",
  ],
  [
    /gpg failed|failed to write commit object|signing/i,
    "Commit signing failed. Check your signing key configuration, then commit again.",
  ],
  [
    /hook .* (failed|declined)|pre-commit|pre-push/i,
    "A Git hook rejected the operation. Fix what the hook reported, then try again — Yavin never bypasses hooks.",
  ],
  [
    /Cannot start tool/i,
    "Git was not found. Check that it is installed and available on your PATH, then try again.",
  ],
  [
    /patch does not apply|patch failed/i,
    "This change no longer matches the file. Refresh the diff and try again.",
  ],
  [
    /used by worktree|already checked out at/i,
    "This branch is checked out in another worktree. Switch there, or choose a different branch.",
  ],
  [
    /is not fully merged/i,
    "This branch has commits not on any other branch. Force-delete only if you're sure you want to discard them.",
  ],
];

/**
 * Turns Git's stderr into something the user can act on, keeping the original text so
 * nothing is hidden. Unrecognized failures are passed through untouched.
 */
export function describeGitError(error: unknown): string {
  const raw = String(error instanceof Error ? error.message : error)
    .replace(/^Error:\s*/, "")
    .replace(/^Git:\s*/, "")
    .trim();
  if (!raw) return "The Git operation failed.";
  // Cancellation (see the Git Operation Engine plan) is reported as this exact,
  // un-prefixed string -- never Git's own stderr -- so it's recognized before the
  // regex table and returned completely unchanged, distinct from every real failure.
  if (raw === "Cancelled") return raw;
  const match = failures.find(([pattern]) => pattern.test(raw));
  return match ? `${match[1]}\n\nGit said: ${raw}` : raw;
}
