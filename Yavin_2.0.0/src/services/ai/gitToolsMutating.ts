import { gitRegistry } from "../git/registry.ts";
import type { RepoEntry } from "../git/registry.ts";
import type { RepoSnapshot } from "../git/store.ts";
import { guardedAffecting } from "../git/sync.ts";
import { categorizeGitError } from "../git/parsers/errors.ts";
import { getGitContext } from "./gitContext.ts";
import type { GitBaselineContext } from "./gitContext.ts";
import { fail, isFailure, resolveInRoot, resolveWorktree } from "./toolTypes.ts";
import { samePathString } from "../resource.ts";
import type {
  ToolFailure,
  ToolResult,
  ToolTier,
  WorktreeRef,
  WorktreeRegistry,
} from "./toolTypes.ts";

export const MAX_PATHS = 500;

/**
 * Risk tier per mutating tool. Metadata for whichever agent runtime eventually calls
 * these -- it decides whether to ask the user first. The tool layer itself shows no
 * prompt (confirmation UI belongs to the UI layer), and tools with no entry here do
 * not exist: reset, force-push, force branch delete, pull --rebase/--merge, and
 * starting a merge/rebase/cherry-pick/revert are deliberately not exposed at all.
 */
export const TOOL_TIERS = {
  stage: "reversible",
  unstage: "reversible",
  // Not "reversible": stashing takes changes off the working tree, and undoing it means
  // finding and applying the right stash afterwards. Worth asking about first.
  stash: "confirm",
  createBranch: "reversible",
  commit: "confirm",
  switchBranch: "confirm",
  deleteBranch: "confirm",
  fetch: "confirm",
  pull: "confirm",
  push: "confirm",
  publish: "confirm",
  stashApply: "confirm",
  stashPop: "confirm",
  stashDrop: "confirm",
  continueOperation: "confirm",
  abortOperation: "confirm",
  skipOperation: "confirm",
} as const satisfies Record<string, ToolTier>;

export type MutatingToolName = keyof typeof TOOL_TIERS;

export interface MutationOutcome {
  message: string;
  /** Authoritative state re-read after the operation, never assumed. */
  context: GitBaselineContext;
}

type Guard = (
  entry: RepoEntry,
  kind: string,
  dirty: boolean,
  operation: () => Promise<string>,
) => Promise<boolean>;

const OPERATION_TOOLS = new Set<MutatingToolName>([
  "continueOperation",
  "abortOperation",
  "skipOperation",
]);

const pre = (message: string): ToolFailure => fail("precondition", message);

/**
 * Mutating Git tools. Every call: resolves an explicit worktree, re-reads its
 * current snapshot at call time (never a caller-held copy), validates that
 * operation's precondition against it, runs through `guardedAffecting` -- the same
 * entry point every Source Control button uses -- and returns the post-operation
 * state. Nothing here retries, and nothing here can pass a raw Git argument.
 */
export function createGitMutatingTools(options: {
  /** Whether any editor has unsaved changes -- only the host application knows. */
  isDirty: () => boolean;
  registry?: WorktreeRegistry;
  guard?: Guard;
}) {
  const registry = options.registry ?? gitRegistry;
  const guard: Guard = options.guard ?? guardedAffecting;

  async function run(
    ref: WorktreeRef,
    tool: MutatingToolName,
    kind: string,
    check: (snap: RepoSnapshot, entry: RepoEntry) => ToolFailure | null,
    operation: (entry: RepoEntry) => Promise<string>,
  ): Promise<ToolResult<MutationOutcome>> {
    const entry = resolveWorktree(registry, ref);
    if (isFailure(entry)) return entry;
    const snap = entry.store.getSnapshot();
    if (snap.busy)
      return fail("busy", "Another Git operation is already running for this worktree.");
    if (snap.stale) {
      return fail(
        "stale",
        "The last refresh failed, so this worktree's state is unconfirmed. Re-read it first.",
      );
    }
    if (snap.operationInProgress !== "" && !OPERATION_TOOLS.has(tool)) {
      return pre(`A ${snap.operationInProgress} is in progress. Continue, skip or abort it first.`);
    }
    const refused = check(snap, entry);
    if (refused) return refused;

    const ok = await guard(entry, kind, options.isDirty(), () => operation(entry));
    const after = entry.store.getSnapshot();
    if (!ok) {
      const message = after.notice.replace(/^Error:\s*/, "") || "The Git operation failed.";
      return fail(categorizeGitError(message), message);
    }
    return {
      ok: true,
      data: { message: after.notice, context: getGitContext(entry) },
    };
  }

  const absolutePaths = (entry: RepoEntry, paths: string[]): string[] | ToolFailure => {
    if (!paths.length || paths.length > MAX_PATHS) {
      return fail("invalid-argument", `Provide between 1 and ${MAX_PATHS} paths.`);
    }
    const resolved: string[] = [];
    for (const p of paths) {
      const absolute = resolveInRoot(entry.root, p);
      if (!absolute) return fail("invalid-argument", `Path "${p}" is not inside the worktree.`);
      resolved.push(absolute);
    }
    return resolved;
  };

  const stashIndex = (snap: RepoSnapshot, index: number): ToolFailure | null =>
    Number.isInteger(index) && index >= 0 && index < snap.stashes.length
      ? null
      : pre(`There is no stash at index ${index}.`);

  const staging = (tool: "stage" | "unstage") => (ref: WorktreeRef, args: { paths: string[] }) => {
    const entry = resolveWorktree(registry, ref);
    if (isFailure(entry)) return Promise.resolve(entry);
    const targets = absolutePaths(entry, args.paths);
    if (isFailure(targets)) return Promise.resolve(targets);
    return run(
      ref,
      tool,
      tool,
      (snap) => {
        for (const path of targets) {
          // Compared as resources: `resolveInRoot` keeps the caller's spelling (`c:/work/a.ts`)
          // and the entries carry the root's (`C:/work/a.ts`).
          const e = snap.entries.find((x) => samePathString(x.path, path));
          if (!e) return pre(`"${path}" has no changes to ${tool}.`);
          if (tool === "stage" && e.conflict === false && !e.untracked && e.worktree === " ") {
            return pre(`"${path}" has no unstaged changes to stage.`);
          }
          if (tool === "unstage" && (e.untracked || e.index === " ")) {
            return pre(`"${path}" is not staged.`);
          }
        }
        return null;
      },
      async (e) => {
        for (const path of targets) {
          if (tool === "stage") await e.store.repository.stage(path);
          else await e.store.repository.unstage(path);
        }
        return `${tool === "stage" ? "Staged" : "Unstaged"} ${targets.length} file(s).`;
      },
    );
  };

  return {
    stage: staging("stage"),
    unstage: staging("unstage"),

    /**
     * `includeUntracked` must be asked for explicitly, and defaults to off. It used to be
     * hardcoded on, which made this the one tool that could take never-tracked files off
     * disk: `stash -u` followed by `stashDrop` destroys them with no reflog to recover from,
     * so "stash the workspace, then tidy up old stashes" -- two individually unremarkable
     * steps -- was a complete data-loss chain. Tracked changes stay recoverable either way.
     */
    stash: (ref: WorktreeRef, args: { message?: string; includeUntracked?: boolean } = {}) =>
      run(
        ref,
        "stash",
        "stash",
        (snap) => (snap.entries.length ? null : pre("There are no changes to stash.")),
        (e) =>
          e.store.repository.stash({
            message: args.message,
            untracked: args.includeUntracked === true,
          }),
      ),

    createBranch: (ref: WorktreeRef, args: { name: string }) =>
      run(
        ref,
        "createBranch",
        "branch",
        (snap) => {
          if (!args.name.trim()) return fail("invalid-argument", "Enter a branch name.");
          return snap.branches.includes(args.name)
            ? pre(`Branch "${args.name}" already exists.`)
            : null;
        },
        (e) => e.store.repository.createBranch(args.name),
      ),

    commit: (ref: WorktreeRef, args: { message: string }) =>
      run(
        ref,
        "commit",
        "commit",
        (snap) => {
          if (!args.message.trim()) return fail("invalid-argument", "Enter a commit message.");
          const conflicts = snap.entries.filter((e) => e.conflict).length;
          if (conflicts) return pre(`Resolve and stage ${conflicts} conflicted file(s) first.`);
          const staged = snap.entries.filter((e) => !e.untracked && e.index !== " ").length;
          return staged ? null : pre("Nothing is staged.");
        },
        (e) => e.store.repository.commit(args.message),
      ),

    switchBranch: (ref: WorktreeRef, args: { name: string }) =>
      run(
        ref,
        "switchBranch",
        "switch",
        (snap) =>
          snap.branches.includes(args.name)
            ? null
            : pre(`There is no local branch "${args.name}".`),
        (e) => e.store.repository.switchBranch(args.name),
      ),

    /** Safe delete only (`-d`); force deletion is not exposed. */
    deleteBranch: (ref: WorktreeRef, args: { name: string }) =>
      run(
        ref,
        "deleteBranch",
        "deleteBranch",
        (snap) => {
          if (!snap.branches.includes(args.name))
            return pre(`There is no local branch "${args.name}".`);
          return snap.branch.name === args.name
            ? pre("The current branch cannot be deleted.")
            : null;
        },
        (e) => e.store.repository.deleteBranch(args.name, false),
      ),

    fetch: (ref: WorktreeRef) =>
      run(
        ref,
        "fetch",
        "fetch",
        () => null,
        (e) => e.store.repository.fetch(),
      ),

    /** Fast-forward only; a diverged branch needs a human choice between rebase and merge. */
    pull: (ref: WorktreeRef) =>
      run(
        ref,
        "pull",
        "pull",
        (snap) => {
          if (!snap.branch.upstream) return pre("This branch has no upstream to pull from.");
          return snap.branch.ahead > 0 && snap.branch.behind > 0
            ? pre(
                "The branch has diverged from its upstream; choosing rebase or merge is not exposed.",
              )
            : null;
        },
        (e) => e.store.repository.pull(),
      ),

    push: (ref: WorktreeRef) =>
      run(
        ref,
        "push",
        "push",
        (snap) => {
          if (snap.branch.detached) return pre("HEAD is detached; switch to a branch first.");
          return snap.branch.upstream
            ? null
            : pre("This branch has no upstream; publish it instead.");
        },
        (e) => e.store.repository.push(),
      ),

    publish: (ref: WorktreeRef, args: { remote: string }) =>
      run(
        ref,
        "publish",
        "publish",
        (snap) => {
          if (snap.branch.detached) return pre("HEAD is detached; switch to a branch first.");
          if (snap.branch.upstream) return pre("This branch already has an upstream; use push.");
          return snap.remotes.includes(args.remote)
            ? null
            : pre(`There is no remote named "${args.remote}".`);
        },
        (e) => e.store.repository.publish(args.remote),
      ),

    stashApply: (ref: WorktreeRef, args: { index: number }) =>
      run(
        ref,
        "stashApply",
        "stashApply",
        (s) => stashIndex(s, args.index),
        (e) => e.store.repository.stashApply(args.index),
      ),
    stashPop: (ref: WorktreeRef, args: { index: number }) =>
      run(
        ref,
        "stashPop",
        "stashPop",
        (s) => stashIndex(s, args.index),
        (e) => e.store.repository.stashPop(args.index),
      ),
    stashDrop: (ref: WorktreeRef, args: { index: number }) =>
      run(
        ref,
        "stashDrop",
        "stashDrop",
        (s) => stashIndex(s, args.index),
        (e) => e.store.repository.stashDrop(args.index),
      ),

    /** Refused while any conflict remains -- resolution is only ever Git's own state. */
    continueOperation: (ref: WorktreeRef) =>
      run(
        ref,
        "continueOperation",
        "continue",
        (snap) => {
          if (!snap.operationInProgress) return pre("No operation is in progress.");
          const conflicts = snap.entries.filter((e) => e.conflict).length;
          return conflicts
            ? pre(`${conflicts} file(s) are still conflicted; stage each once resolved.`)
            : null;
        },
        (e) => e.store.repository.continueOperation(),
      ),

    abortOperation: (ref: WorktreeRef) =>
      run(
        ref,
        "abortOperation",
        "abort",
        (snap) => (snap.operationInProgress ? null : pre("No operation is in progress.")),
        (e) => e.store.repository.abort(),
      ),

    skipOperation: (ref: WorktreeRef) =>
      run(
        ref,
        "skipOperation",
        "skip",
        (snap) => {
          if (!snap.operationInProgress) return pre("No operation is in progress.");
          return snap.operationInProgress === "merge"
            ? pre("A merge has no commits to skip.")
            : null;
        },
        (e) => e.store.repository.skip(),
      ),
  };
}

export type GitMutatingTools = ReturnType<typeof createGitMutatingTools>;
