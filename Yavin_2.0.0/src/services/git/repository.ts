import { cancelRepoOperations, closeRepo, gitExec, openRepo, repoState } from "./backend.ts";
import type { GitOperation, RepoInfo } from "./backend.ts";
import { describeGitError } from "./parsers/errors.ts";
import { buildPatch, parseUnifiedDiff } from "./diffHunks.ts";

/**
 * Rust's `git_exec` no longer knows about the workspace tree, so pathspecs have to be
 * relative to the repository root by the time they reach it -- this recovers that from
 * an absolute path built by `parseGitEntries`/the file explorer.
 */
function relativeToRoot(root: string, absolutePath: string): string {
  const withSlash = root.endsWith("/") ? root : `${root}/`;
  const lower = absolutePath.toLowerCase();
  if (lower === root.toLowerCase()) return ".";
  if (lower.startsWith(withSlash.toLowerCase())) return absolutePath.slice(withSlash.length);
  throw new Error(`Path is outside the repository: ${absolutePath}`);
}

/**
 * One open repository. Every method builds a Git argv and runs it through the
 * generic, guarded `git_exec` native command -- all sequencing, pre-checks and error
 * interpretation live here, not in Rust.
 */
export class Repository {
  readonly repoId: string;
  readonly root: string;

  // Not a parameter-property shorthand: Node's `--experimental-strip-types` test
  // runner (see package.json's "test" script) only erases type annotations, it does
  // not transform `constructor(private x: T)` into a field assignment.
  constructor(repoId: string, root: string) {
    this.repoId = repoId;
    this.root = root;
  }

  static async open(path: string): Promise<Repository> {
    const info: RepoInfo = await openRepo(path).catch((error) => {
      throw new Error(describeGitError(error));
    });
    return new Repository(info.repoId, info.root);
  }

  close(): Promise<void> {
    return closeRepo(this.repoId);
  }

  /** Stops whatever Git operation is currently running or lock-queued for this
   * worktree -- one still-spawned `git` process is actually killed, not merely
   * ignored; one still-queued operation never acquires its lock or spawns at all. */
  cancel(): Promise<void> {
    return cancelRepoOperations(this.repoId);
  }

  private async run(args: string[]): Promise<string> {
    let output;
    try {
      output = await gitExec(this.repoId, args, crypto.randomUUID());
    } catch (error) {
      throw new Error(describeGitError(error));
    }
    if (output.code !== 0) throw new Error(describeGitError(`Git: ${output.stderr.trim()}`));
    return output.stdout;
  }

  private async ok(args: string[]): Promise<boolean> {
    try {
      return (await gitExec(this.repoId, args, crypto.randomUUID())).code === 0;
    } catch {
      return false;
    }
  }

  private async runWithInput(args: string[], input: string): Promise<string> {
    let output;
    try {
      output = await gitExec(this.repoId, args, crypto.randomUUID(), input);
    } catch (error) {
      throw new Error(describeGitError(error));
    }
    if (output.code !== 0) throw new Error(describeGitError(`Git: ${output.stderr.trim()}`));
    return output.stdout;
  }

  status(): Promise<string> {
    return this.run(["status", "--porcelain=v1", "-z", "-uall", "--", "."]);
  }

  branchInfo(): Promise<string> {
    return this.run(["status", "--porcelain=v2", "--branch", "--untracked-files=no", "--", "."]);
  }

  /**
   * The repository's shared Git directory (`rev-parse --git-common-dir`) -- unlike
   * `root`, this is identical from every worktree of the same repository, which is
   * what `GitRegistry` groups worktrees of one repository together by (see
   * `identity.ts`'s `attachWorktree`).
   */
  commonGitDir(): Promise<string> {
    return this.run(["rev-parse", "--git-common-dir"]);
  }

  /** Whether this repository's history has been truncated by a shallow clone --
   * so a full page load-more reaching the end doesn't get silently presented as
   * "this is really the first commit" when it's actually the shallow boundary. */
  async isShallow(): Promise<boolean> {
    const output = await this.run(["rev-parse", "--is-shallow-repository"]);
    return output.trim() === "true";
  }

  /** Raw `git worktree list --porcelain` output; see `parsers/worktree.ts` for parsing. */
  listWorktrees(): Promise<string> {
    return this.run(["worktree", "list", "--porcelain"]);
  }

  async branches(): Promise<string[]> {
    const out = await this.run(["for-each-ref", "--format=%(refname:short)", "refs/heads/"]);
    return out.trim().split("\n").filter(Boolean);
  }

  async remotes(): Promise<string[]> {
    const out = await this.run(["remote"]);
    return out.trim().split("\n").filter(Boolean);
  }

  state(): Promise<GitOperation> {
    return repoState(this.repoId).catch((error) => {
      throw new Error(describeGitError(error));
    });
  }

  indexContent(absolutePath: string): Promise<string> {
    // --filters applies checkout conversions (line endings, LFS smudge) like `git restore`.
    return this.run(["cat-file", "--filters", `:${relativeToRoot(this.root, absolutePath)}`]);
  }

  diff(absolutePath: string, staged: boolean, oldAbsolutePath?: string): Promise<string> {
    const args = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "-M"];
    if (staged) args.push("--cached");
    args.push("--", relativeToRoot(this.root, absolutePath));
    if (oldAbsolutePath) args.push(relativeToRoot(this.root, oldAbsolutePath));
    return this.run(args);
  }

  private async applyPatch(
    patch: string,
    options: { cached: boolean; reverse: boolean },
  ): Promise<string> {
    if (!patch) return "";
    const args = ["apply"];
    if (options.cached) args.push("--cached");
    if (options.reverse) args.push("-R");
    return this.runWithInput(args, patch);
  }

  /** Stages only the given hunks (indexes into `diffText`'s hunks) into the index. */
  stageHunks(diffText: string, hunkIndexes: number[]): Promise<string> {
    const patch = buildPatch(parseUnifiedDiff(diffText), new Set(hunkIndexes));
    return this.applyPatch(patch, { cached: true, reverse: false });
  }

  /** Unstages only the given hunks, indexed into an already-*staged* diff. */
  unstageHunks(stagedDiffText: string, hunkIndexes: number[]): Promise<string> {
    const patch = buildPatch(parseUnifiedDiff(stagedDiffText), new Set(hunkIndexes));
    return this.applyPatch(patch, { cached: true, reverse: true });
  }

  /** Reverts only the given hunks, indexed into an *unstaged* diff, in the working tree. */
  discardHunks(diffText: string, hunkIndexes: number[]): Promise<string> {
    const patch = buildPatch(parseUnifiedDiff(diffText), new Set(hunkIndexes));
    return this.applyPatch(patch, { cached: false, reverse: true });
  }

  stage(absolutePath: string): Promise<string> {
    return this.run(["add", "--", relativeToRoot(this.root, absolutePath)]);
  }

  async unstage(absolutePath: string): Promise<string> {
    const path = relativeToRoot(this.root, absolutePath);
    const hasHead = await this.ok(["rev-parse", "--verify", "HEAD"]);
    return hasHead
      ? this.run(["restore", "--staged", "--", path])
      : this.run(["rm", "--cached", "--", path]);
  }

  async commit(message: string): Promise<string> {
    if (!message.trim()) throw new Error("Enter a commit message");
    const conflicted = await this.run(["diff", "--name-only", "--diff-filter=U"]);
    if (conflicted.trim()) throw new Error("Resolve and stage conflicts before committing");
    return this.run(["commit", "-m", message]);
  }

  switchBranch(name: string): Promise<string> {
    return this.run(["switch", "--", name]);
  }

  async createBranch(name: string): Promise<string> {
    await this.run(["check-ref-format", "--branch", name]);
    return this.run(["switch", "-c", name]);
  }

  /**
   * `force` selects Git's own two-tier safety: `-d` refuses an unmerged branch,
   * `-D` overrides that but never overrides Git's separate, unconditional refusal to
   * delete a branch checked out in any worktree (including this one) -- no client-side
   * pre-check is needed or added; Git's own refusal is authoritative (verified).
   */
  deleteBranch(name: string, force: boolean): Promise<string> {
    return this.run(["branch", force ? "-D" : "-d", name]);
  }

  // Always prunes: a remote branch deleted upstream would otherwise leave its
  // refs/remotes/<remote>/* entry (and any graph decoration badge on it) around
  // indefinitely -- --prune only ever removes local records of refs the remote no
  // longer has, it can never delete anything from the remote itself.
  fetch(): Promise<string> {
    return this.run(["fetch", "--prune"]);
  }

  /**
   * The remote's own recorded default branch (its `HEAD` symbolic ref), or null when
   * none is known -- a local, network-free read (set at clone time, or by an explicit
   * `git remote set-head`; a plain fetch never updates it). Not yet consumed by any
   * store/UI -- added as a capability, like Module 1's `commonGitDir` before it had a
   * caller.
   */
  async defaultBranch(remote: string): Promise<string | null> {
    let output;
    try {
      output = await gitExec(
        this.repoId,
        ["symbolic-ref", `refs/remotes/${remote}/HEAD`],
        crypto.randomUUID(),
      );
    } catch {
      return null;
    }
    if (output.code !== 0) return null;
    const ref = output.stdout.trim();
    const prefix = `refs/remotes/${remote}/`;
    return ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
  }

  // Reconciling a divergence is always the user's explicit choice, and never
  // stashes their work: --no-autostash overrides any rebase.autoStash config.
  pull(): Promise<string> {
    return this.run(["pull", "--ff-only"]);
  }
  pullRebase(): Promise<string> {
    return this.run(["pull", "--rebase", "--no-autostash"]);
  }
  pullMerge(): Promise<string> {
    return this.run(["pull", "--no-rebase", "--no-autostash", "--no-edit"]);
  }
  push(): Promise<string> {
    return this.run(["push"]);
  }

  async publish(remote: string): Promise<string> {
    // Only a remote Git itself reports can be pushed to, so the name can never be
    // read as an option or a URL.
    const remotes = await this.remotes();
    if (!remotes.includes(remote))
      throw new Error("Unknown remote. Add one with git remote add first.");
    let head;
    try {
      head = await gitExec(this.repoId, ["symbolic-ref", "--short", "HEAD"], crypto.randomUUID());
    } catch (error) {
      throw new Error(describeGitError(error));
    }
    if (head.code !== 0) throw new Error("Detached HEAD: switch to a branch before publishing.");
    return this.run(["push", "--set-upstream", remote, head.stdout.trim()]);
  }

  async abort(): Promise<string> {
    return this.abortOrContinue("--abort");
  }
  async continueOperation(): Promise<string> {
    return this.abortOrContinue("--continue");
  }
  /**
   * Advances past the current commit without applying it -- real, Git-supported for
   * rebase/cherry-pick/revert (each processes a sequence of commits). Merge has no
   * such sequence, so Git itself has no `merge --skip`; refused here with a specific
   * message rather than letting Git's own generic argument-error text through, since
   * (unlike every other refusal this codebase exposes as-is) that text wouldn't be
   * semantically clear about why.
   */
  async skip(): Promise<string> {
    const op = await this.state();
    if (!op) throw new Error("No merge, rebase, cherry-pick or revert is in progress.");
    if (op === "merge") throw new Error("Merge has no commits to skip -- abort or continue instead.");
    return this.run([op, "--skip"]);
  }
  private async abortOrContinue(flag: "--abort" | "--continue"): Promise<string> {
    const op = await this.state();
    if (!op) throw new Error("No merge, rebase, cherry-pick or revert is in progress.");
    return this.run([op, flag]);
  }

  /** One page of commit-graph history, oldest-first-within-page, for `graph/incremental.ts`. */
  graphLog(skip: number, limit: number): Promise<string> {
    return this.run([
      "log",
      "--topo-order",
      "--skip",
      String(skip),
      "-n",
      String(limit),
      "--pretty=format:%H\x1f%h\x1f%P\x1f%an\x1f%ae\x1f%ad\x1f%cr\x1f%s\x1f%D",
      "--date=format:%B %d, %Y at %I:%M %p",
    ]);
  }

  commitDetails(hash: string): Promise<string> {
    if (!hash.trim()) throw new Error("Commit hash required");
    return this.run(["show", "--numstat", "--pretty=format:%H\x1f%s", hash]);
  }

  /**
   * The diff a single file underwent in one commit, against that commit's own
   * (first) parent -- the same "what changed here" question `diff()` answers for the
   * working tree/index, asked instead about a historical commit. `path` is already
   * repo-relative, exactly as `parseCommitDetails`'s own `CommitFileChange.path`
   * reports it (no `relativeToRoot` conversion needed, unlike `diff()`'s absolute-path
   * callers). Reuses the identical unified-diff format `diff()` produces -- the
   * output is parsed by the same `parseUnifiedDiff`/`DiffEditor` pipeline, no new
   * parser is introduced. Merge commits produce Git's own combined-diff format,
   * which this method does not special-case (see the plan's own deferred-scope note).
   */
  commitFileDiff(hash: string, path: string): Promise<string> {
    if (!hash.trim()) throw new Error("Commit hash required");
    return this.run([
      "show",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "-M",
      "--pretty=format:",
      hash,
      "--",
      path,
    ]);
  }

  stash(message?: string): Promise<string> {
    const args = ["stash", "push", "-u"];
    if (message?.trim()) args.push("-m", message.trim());
    return this.run(args);
  }
  stashPop(index?: number): Promise<string> {
    return this.run(index === undefined ? ["stash", "pop"] : ["stash", "pop", `stash@{${index}}`]);
  }
  stashApply(index: number): Promise<string> {
    return this.run(["stash", "apply", `stash@{${index}}`]);
  }
  stashDrop(index: number): Promise<string> {
    return this.run(["stash", "drop", `stash@{${index}}`]);
  }
  stashList(): Promise<string> {
    return this.run(["stash", "list"]);
  }

  async tags(): Promise<string[]> {
    const out = await this.run(["tag", "-l"]);
    return out.trim().split("\n").filter(Boolean);
  }
}
