import { gitRegistry } from "../git/registry.ts";
import type { RepoEntry } from "../git/registry.ts";
import { parseCommitDetails, parseGraphLog } from "../git/parsers/log.ts";
import type { CommitDetailedInfo, RawCommit } from "../git/parsers/log.ts";
import type { GitEntry } from "../git/parsers/status.ts";
import type { StashEntry } from "../git/parsers/stash.ts";
import { categorizeGitError, describeGitError } from "../git/parsers/errors.ts";
import { getGitContext } from "./gitContext.ts";
import type { GitBaselineContext } from "./gitContext.ts";
import { fail, isFailure, resolveInRoot, resolveWorktree } from "./toolTypes.ts";
import type { ToolResult, WorktreeRef, WorktreeRegistry } from "./toolTypes.ts";

export const MAX_CHANGES = 200;
export const MAX_COMMITS = 100;
export const MAX_DIFF_CHARS = 100_000;

const HASH = /^[0-9a-f]{4,64}$/i;

function truncate(text: string): { text: string; truncated: boolean } {
  return text.length > MAX_DIFF_CHARS
    ? { text: text.slice(0, MAX_DIFF_CHARS), truncated: true }
    : { text, truncated: false };
}

/**
 * Read-tier Git tools. Every function names its worktree explicitly and calls only
 * existing `Repository`/`RepoStore` methods -- no Git process is spawned here and
 * nothing in this file imports the native `git_exec` bridge.
 */
export function createGitReadTools(registry: WorktreeRegistry = gitRegistry) {
  const withEntry = async <T>(
    ref: WorktreeRef,
    work: (entry: RepoEntry) => Promise<T> | T,
  ): Promise<ToolResult<T>> => {
    const entry = resolveWorktree(registry, ref);
    if (isFailure(entry)) return entry;
    try {
      return { ok: true, data: await work(entry) };
    } catch (error) {
      return fail(categorizeGitError(error), describeGitError(error));
    }
  };

  return {
    getContext: (ref: WorktreeRef): Promise<ToolResult<GitBaselineContext>> =>
      withEntry(ref, (entry) => getGitContext(entry)),

    getChanges: (ref: WorktreeRef) =>
      withEntry(ref, (entry) => {
        const all = entry.store.getSnapshot().entries;
        const entries: GitEntry[] = all.slice(0, MAX_CHANGES);
        return { entries, total: all.length, truncated: all.length > MAX_CHANGES };
      }),

    getBranches: (ref: WorktreeRef) =>
      withEntry(ref, (entry) => {
        const s = entry.store.getSnapshot();
        return { current: s.branch, branches: s.branches, remotes: s.remotes };
      }),

    getStashes: (ref: WorktreeRef) =>
      withEntry(ref, (entry): StashEntry[] => entry.store.getSnapshot().stashes),

    getDiff: (ref: WorktreeRef, args: { path: string; staged: boolean }) =>
      withEntry(ref, async (entry) => {
        const absolute = resolveInRoot(entry.root, args.path);
        if (!absolute) throw new Error("Path must stay inside the worktree.");
        const match = entry.store.getSnapshot().entries.find((e) => e.path === absolute);
        return truncate(
          await entry.store.repository.diff(absolute, args.staged, match?.originalPath),
        );
      }),

    getRecentCommits: (ref: WorktreeRef, args: { limit?: number } = {}) =>
      withEntry(ref, async (entry): Promise<RawCommit[]> => {
        const limit = Math.min(Math.max(1, args.limit ?? 20), MAX_COMMITS);
        return parseGraphLog(await entry.store.repository.graphLog(0, limit));
      }),

    getCommitDetails: (ref: WorktreeRef, args: { hash: string }) =>
      withEntry(ref, async (entry): Promise<CommitDetailedInfo> => {
        if (!HASH.test(args.hash)) throw new Error("Invalid commit hash.");
        return parseCommitDetails(await entry.store.repository.commitDetails(args.hash));
      }),

    getCommitFileDiff: (ref: WorktreeRef, args: { hash: string; path: string; oldPath?: string }) =>
      withEntry(ref, async (entry) => {
        if (!HASH.test(args.hash)) throw new Error("Invalid commit hash.");
        if (!args.path || args.path.split(/[\\/]/).includes("..")) throw new Error("Invalid path.");
        if (args.oldPath?.split(/[\\/]/).includes("..")) throw new Error("Invalid path.");
        return truncate(
          await entry.store.repository.commitFileDiff(args.hash, args.path, args.oldPath),
        );
      }),
  };
}

export type GitReadTools = ReturnType<typeof createGitReadTools>;
