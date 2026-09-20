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
    // A fresh clone of an empty repository already names origin/main as its upstream, but the
    // branch does not exist on the remote until the first push.
    /no such ref was fetched|couldn't find remote ref/i,
    "The remote does not have this branch yet. Push it first, then you can pull.",
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
  [
    // Two real, distinct message families (verified against a real repository):
    // rebase's apply-backend refusal usually also contains "conflict(s)" and is
    // already caught by the CONFLICT pattern above; this covers the
    // merge/revert/cherry-pick commit-backend refusal, plus rebase's own text on
    // the rare chance it appears without the word "conflict" nearby.
    /needs merge|unmerged files|Committing is not possible/i,
    "Conflicts are still unresolved. Stage each resolved file, then continue.",
  ],
  [
    /you need to resolve your current index first|is already in progress/i,
    "Another Git operation is already in progress. Resolve or abort it before starting a new one.",
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

export type GitErrorCategory =
  | "cancelled"
  | "busy"
  | "auth"
  | "network"
  | "remote-missing"
  | "no-upstream"
  | "non-fast-forward"
  | "diverged"
  | "dirty"
  | "conflict"
  | "operation-in-progress"
  | "worktree-conflict"
  | "unmerged-branch"
  | "nothing-to-commit"
  | "hook"
  | "stale"
  | "unclassified";

// Machine-checkable counterpart of `failures` above, for consumers (e.g. an AI tool
// layer) that must branch on the kind of failure instead of parsing display text.
// Same ordering rule: first match wins, most specific first.
const categories: [RegExp, GitErrorCategory][] = [
  [/^Cancelled$/, "cancelled"],
  [/Another Git operation is already running/i, "busy"],
  [/Save or close unsaved editors/i, "dirty"],
  [
    /could not read (Username|Password)|Authentication failed|terminal prompts disabled|invalid credentials|Permission denied \(publickey|Please make sure you have the correct access rights|Host key verification failed|authenticity of host/i,
    "auth",
  ],
  [
    /does not appear to be a git repository|Could not read from remote repository|No such remote/i,
    "remote-missing",
  ],
  [
    /Could not resolve host|unable to access|Connection (timed out|refused)|Network is unreachable/i,
    "network",
  ],
  [/no such ref was fetched|couldn't find remote ref/i, "no-upstream"],
  [/no upstream|has no upstream branch|set-upstream/i, "no-upstream"],
  [/non-fast-forward|Updates were rejected|fetch first|behind its remote/i, "non-fast-forward"],
  [
    /Not possible to fast-forward|diverged|need to specify how to reconcile|divergent branches/i,
    "diverged",
  ],
  [/local changes .* would be overwritten|Your local changes to the following files/i, "dirty"],
  [/you need to resolve your current index first|is already in progress/i, "operation-in-progress"],
  [
    /CONFLICT|fix conflicts|Automatic merge failed|Resolve all conflicts|needs merge|unmerged files|Committing is not possible/i,
    "conflict",
  ],
  [/used by worktree|already checked out at/i, "worktree-conflict"],
  [/is not fully merged/i, "unmerged-branch"],
  [/nothing to commit|no changes added to commit|Nothing is staged/i, "nothing-to-commit"],
  [/hook .* (failed|declined)|pre-commit|pre-push/i, "hook"],
];

export function categorizeGitError(error: unknown): GitErrorCategory {
  const raw = String(error instanceof Error ? error.message : error)
    .replace(/^Error:\s*/, "")
    .trim();
  return categories.find(([pattern]) => pattern.test(raw))?.[1] ?? "unclassified";
}
