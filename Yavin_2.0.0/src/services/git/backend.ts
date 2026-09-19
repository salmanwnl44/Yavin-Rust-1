import { native } from "../native.ts";
import type { ToolOutput } from "../native.ts";

export interface RepoInfo {
  repoId: string;
  root: string;
}

/** An operation Git is halfway through, as reported by `git_repo_state`. */
export type GitOperation = "" | "merge" | "rebase" | "cherry-pick" | "revert";

/** Resolves any path inside a repository to that repository's real, canonical root. */
export function openRepo(path: string): Promise<RepoInfo> {
  return native("git_open_repo", { path });
}

export function closeRepo(repoId: string): Promise<void> {
  return native("git_close_repo", { repoId });
}

/**
 * Runs one Git subcommand in an already-open repository. `args[0]` is the
 * subcommand; `input` is piped to Git's stdin (used by `apply` for patch content).
 * `id` addresses this specific call for `cancelGitOperation` -- Rust registers it
 * (and cleans it up when the call finishes) regardless of whether anything ever
 * cancels it, the same as `search.ts` already does for every `search_project` call.
 * `Repository` generates a fresh one per call; nothing above it needs to track ids
 * individually, because `cancelRepoOperations` below cancels by repository instead.
 */
export function gitExec(
  repoId: string,
  args: string[],
  id: string,
  input?: string,
): Promise<ToolOutput> {
  return native("git_exec", { repoId, args, id, input });
}

/**
 * Cancels every operation currently running or lock-queued for `repoId` -- the whole
 * repository, not one specific call. Correct because `RepoStore` only ever has one
 * mutation in flight at a time, so "cancel this repository's operations" and "cancel
 * the current operation" are the same thing, without needing to plumb an id from
 * `RepoStore.guarded()` through whatever `Repository` method(s) its caller's closure
 * happens to invoke.
 */
export function cancelRepoOperations(repoId: string): Promise<void> {
  return native("git_cancel_repo", { repoId });
}

export async function repoState(repoId: string): Promise<GitOperation> {
  return (await native("git_repo_state", { repoId })) as GitOperation;
}
