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
 */
export function gitExec(repoId: string, args: string[], input?: string): Promise<ToolOutput> {
  return native("git_exec", { repoId, args, input });
}

export async function repoState(repoId: string): Promise<GitOperation> {
  return (await native("git_repo_state", { repoId })) as GitOperation;
}
