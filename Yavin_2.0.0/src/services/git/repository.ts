import { cancelRepoOperations, closeRepo, gitExec, openRepo, repoState } from "./backend.ts";
import type { GitOperation, RepoInfo } from "./backend.ts";
import { describeGitError } from "./parsers/errors.ts";
import { buildPatch, parseUnifiedDiff } from "./diffHunks.ts";
import { relativePath } from "../resource.ts";

/**
 * Rust's `git_exec` no longer knows about the workspace tree, so pathspecs have to be
 * relative to the repository root by the time they reach it -- this recovers that from
 * an absolute path built by `parseGitEntries`/the file explorer.
 */
/** Mirrors the boundary's own rule, so a bad hash fails here with a readable message rather
 * than as an opaque validation refusal from Rust. */
function requireHash(hash: string): string {
  const trimmed = hash.trim();
  if (!/^[0-9a-fA-F]{7,64}$/.test(trimmed))
    throw new Error("A full commit hash is required for this operation.");
  return trimmed;
}

function relativeToRoot(root: string, absolutePath: string): string {
  const relative = relativePath(root, absolutePath);
  if (relative === undefined) throw new Error(`Path is outside the repository: ${absolutePath}`);
  return relative;
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

  /**
   * A probe whose *exit code* is the answer -- "does HEAD exist", "does HEAD~1 exist".
   *
   * Deliberately does NOT swallow a failure to run Git at all. It used to, and the two
   * outcomes are not interchangeable: `unstage` reads this as "the repository has no
   * commits yet" and falls back to `git rm --cached`, which in a repository that *does*
   * have commits does not just unstage the file, it untracks it. So a cancelled call, a
   * lock contention, or any transient IPC rejection during the probe silently turned a
   * routine unstage into an untrack. Letting the rejection through means the caller
   * reports a real error instead of quietly taking the destructive branch.
   */
  private async ok(args: string[]): Promise<boolean> {
    const output = await gitExec(this.repoId, args, crypto.randomUUID());
    return output.code === 0;
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

  /**
   * Raw `git worktree list --porcelain` output; see `parsers/worktree.ts` for parsing.
   * Asks for `-z` (Git 2.36+) so a path or lock reason containing a newline survives;
   * an older Git rejects the flag, and the plain form is used instead.
   */
  async listWorktrees(): Promise<string> {
    try {
      return await this.run(["worktree", "list", "--porcelain", "-z"]);
    } catch {
      return this.run(["worktree", "list", "--porcelain"]);
    }
  }

  /**
   * Every branch this repository has: local heads and remote-tracking refs, in one process.
   *
   * `%(refname)` rather than the short form because the short form cannot tell a local
   * branch literally named `origin/main` from the remote-tracking ref of the same name --
   * and because one `for-each-ref` is one Git process, where asking twice doubled what the
   * five-second poll costs for every open worktree.
   */
  async refs(): Promise<{ local: string[]; remote: string[] }> {
    const out = await this.run([
      "for-each-ref",
      "--format=%(refname)",
      "refs/heads/",
      "refs/remotes/",
    ]);
    const local: string[] = [];
    const remote: string[] = [];
    for (const line of out.split(/\r?\n/)) {
      if (line.startsWith("refs/heads/")) local.push(line.slice("refs/heads/".length));
      else if (line.startsWith("refs/remotes/")) {
        const name = line.slice("refs/remotes/".length);
        // `origin/HEAD` is a pointer at the remote's default branch, not a branch anyone
        // means to pick: listing it would show the same history twice under two names.
        if (!name.endsWith("/HEAD")) remote.push(name);
      }
    }
    return { local, remote };
  }

  async remotes(): Promise<string[]> {
    const out = await this.run(["remote"]);
    return out.trim().split("\n").filter(Boolean);
  }

  addRemote(name: string, url: string): Promise<string> {
    return this.run(["remote", "add", name, url]);
  }
  removeRemote(name: string): Promise<string> {
    return this.run(["remote", "remove", name]);
  }
  /** The commit hover card's "Open on GitHub"/etc reads this to turn a remote name into a
   * web link (`remoteUrl.ts`'s `remoteUrlToWeb`). */
  async remoteUrl(name: string): Promise<string> {
    const out = await this.run(["remote", "get-url", name]);
    return out.trim();
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

  /**
   * One side of a conflicted file, for "Accept Ours"/"Accept Theirs": stage 2 is the current
   * branch's version, stage 3 is the incoming one.
   *
   * Reading the blob and letting the caller write it through the app's own apply path is
   * deliberate. `git restore --ours/--theirs` would do this in one step, but on a path with
   * no merge stages Git silently restores from the index and exits 0 instead of refusing --
   * an unrecoverable working-tree discard, which is exactly what the allow-list refuses the
   * bare `restore -- <path>` shape for. Going through `apply` also makes the result undoable,
   * like every other change this panel writes.
   */
  conflictSide(absolutePath: string, side: "ours" | "theirs"): Promise<string> {
    const stage = side === "ours" ? 2 : 3;
    return this.run([
      "cat-file",
      "--filters",
      `:${stage}:${relativeToRoot(this.root, absolutePath)}`,
    ]);
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

  /**
   * `all` stages every tracked modification first (`-a`, matching "Commit All"), `amend`
   * replaces HEAD instead of adding a new commit, `signoff` appends a Signed-off-by trailer.
   * All three are ordinary Git commit modes; none of them can touch history beyond HEAD itself.
   */
  async commit(
    message: string,
    options: { all?: boolean; amend?: boolean; signoff?: boolean } = {},
  ): Promise<string> {
    if (!message.trim()) throw new Error("Enter a commit message");
    const conflicted = await this.run(["diff", "--name-only", "--diff-filter=U"]);
    if (conflicted.trim()) throw new Error("Resolve and stage conflicts before committing");
    const args = ["commit", "-m", message];
    if (options.all) args.push("-a");
    if (options.amend) args.push("--amend");
    if (options.signoff) args.push("-s");
    return this.run(args);
  }

  /**
   * "Undo Last Commit": a soft reset one commit back, so the undone commit's changes land
   * back in the index exactly as they were about to be committed, never discarded. Refuses
   * with a plain explanation instead of running a reset with nothing to land on when the
   * branch has no earlier commit.
   */
  async undoLastCommit(): Promise<string> {
    const hasParent = await this.ok(["rev-parse", "--verify", "HEAD~1"]);
    if (!hasParent) throw new Error("There is no earlier commit on this branch to undo into.");
    return this.run(["reset", "--soft", "HEAD~1"]);
  }

  switchBranch(name: string): Promise<string> {
    return this.run(["switch", "--", name]);
  }

  async createBranch(name: string): Promise<string> {
    await this.run(["check-ref-format", "--branch", name]);
    return this.run(["switch", "-c", name]);
  }
  /** "Create Branch From…": like `createBranch`, but starting from `startPoint` (an existing
   * branch) instead of HEAD. */
  async createBranchFrom(name: string, startPoint: string): Promise<string> {
    await this.run(["check-ref-format", "--branch", name]);
    return this.run(["switch", "-c", name, startPoint]);
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

  /** Renames `oldName` to `newName` -- a local metadata change; the branch's history and
   * (if it was checked out here) current-branch status are unaffected. */
  async renameBranch(oldName: string, newName: string): Promise<string> {
    await this.run(["check-ref-format", "--branch", newName]);
    return this.run(["branch", "-m", oldName, newName]);
  }

  /**
   * `prune` defaults to on: a remote branch deleted upstream would otherwise leave its
   * refs/remotes/<remote>/* entry (and any graph decoration badge on it) around
   * indefinitely -- --prune only ever removes local records of refs the remote no
   * longer has, it can never delete anything from the remote itself. `allRemotes` is
   * "Fetch From All Remotes" (`--all`); plain "Fetch" passes `{ prune: false }`.
   */
  fetch(options: { prune?: boolean; allRemotes?: boolean } = {}): Promise<string> {
    const args = ["fetch"];
    if (options.prune ?? true) args.push("--prune");
    if (options.allRemotes) args.push("--all");
    return this.run(args);
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
  /** "Pull from…": an explicit remote and branch, once, instead of the branch's own
   * configured upstream. Still a plain, non-force, fast-forward-or-fail pull. */
  async pullFrom(remote: string, branch: string): Promise<string> {
    await this.knownRemote(remote);
    return this.run(["pull", remote, branch]);
  }
  push(): Promise<string> {
    return this.run(["push"]);
  }
  /** "Push to…": an explicit remote and branch, once, instead of the current branch's
   * configured upstream (if any). Never sets upstream -- that is `publish`'s job. */
  async pushTo(remote: string, branch: string): Promise<string> {
    await this.knownRemote(remote);
    return this.run(["push", remote, branch]);
  }
  /** "Push Tags": every local tag the remote doesn't already have. */
  pushTags(): Promise<string> {
    return this.run(["push", "--tags"]);
  }
  /** "Delete Remote Branch…" / "Delete Remote Tag…": the same `push --delete` for both --
   * Git resolves `name` against whichever of refs/heads or refs/tags it unambiguously is. */
  async deleteRemoteRef(remote: string, name: string): Promise<string> {
    await this.knownRemote(remote);
    return this.run(["push", remote, "--delete", name]);
  }

  private async knownRemote(remote: string): Promise<void> {
    // Only a remote Git itself reports can be a target, so the name can never be read as
    // an option, a URL, or a refspec.
    const remotes = await this.remotes();
    if (!remotes.includes(remote))
      throw new Error("Unknown remote. Add one with git remote add first.");
  }

  async publish(remote: string): Promise<string> {
    await this.knownRemote(remote);
    let head;
    try {
      head = await gitExec(this.repoId, ["symbolic-ref", "--short", "HEAD"], crypto.randomUUID());
    } catch (error) {
      throw new Error(describeGitError(error));
    }
    if (head.code !== 0) throw new Error("Detached HEAD: switch to a branch before publishing.");
    return this.run(["push", "--set-upstream", remote, head.stdout.trim()]);
  }

  /** "Merge…": merges `branch` into the current branch (a normal, non-fast-forward-forced
   * merge commit unless Git fast-forwards on its own). "Rebase Branch…" replays the current
   * branch's commits onto `branch` instead. Both are ordinary Git operations Yavin's existing
   * conflict/abort/continue/skip machinery already handles once one leaves a conflict. */
  mergeBranch(branch: string): Promise<string> {
    return this.run(["merge", branch]);
  }

  /**
   * Applies one commit onto the current branch, or undoes one with a new commit.
   *
   * Both take a full hash, never a revision expression: the IPC boundary refuses anything
   * else, because `a..b` would quietly mean a whole range rather than the single commit the
   * UI offers. Either can stop on a conflict, which the panel's existing in-progress banner
   * already handles -- `cherry-pick` and `revert` were already among the operations it knows
   * how to continue, skip or abort; only *starting* one was missing.
   */
  // `async` so a rejected hash surfaces as a rejected promise like every other failure here,
  // rather than throwing synchronously past a caller's `.catch()`.
  async cherryPick(hash: string): Promise<string> {
    return this.run(["cherry-pick", requireHash(hash)]);
  }

  async revertCommit(hash: string): Promise<string> {
    return this.run(["revert", requireHash(hash)]);
  }
  rebaseOnto(branch: string): Promise<string> {
    return this.run(["rebase", branch]);
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
    if (op === "merge")
      throw new Error("Merge has no commits to skip -- abort or continue instead.");
    return this.run([op, "--skip"]);
  }
  private async abortOrContinue(flag: "--abort" | "--continue"): Promise<string> {
    const op = await this.state();
    if (!op) throw new Error("No merge, rebase, cherry-pick or revert is in progress.");
    return this.run([op, flag]);
  }

  /** One page of commit-graph history, oldest-first-within-page, for `graph/incremental.ts`. */
  /**
   * `scope` widens the graph past its default (whatever HEAD reaches): `"all"` for every
   * ref (`--all`), or a branch name to show that branch's history instead of HEAD's.
   */
  graphLog(skip: number, limit: number, scope?: "all" | string): Promise<string> {
    // `--decorate=full` so `%D` spells out refs/heads vs refs/remotes: the short form cannot
    // tell a local `feature/login` from a remote branch (see `parseRefLabels`).
    const args = [
      "log",
      "--topo-order",
      "--decorate=full",
      "--skip",
      String(skip),
      "-n",
      String(limit),
    ];
    if (scope === "all") args.push("--all");
    args.push(
      "--pretty=format:%H\x1f%h\x1f%P\x1f%an\x1f%ae\x1f%ad\x1f%cr\x1f%s\x1f%D",
      "--date=format:%B %d, %Y at %I:%M %p",
    );
    if (scope && scope !== "all") args.push(scope);
    return this.run(args);
  }

  /** The commit's full message, subject and body together -- `graphLog`'s own `%s` is the
   * subject alone. For the commit detail panel's body text (bullet lists included). */
  commitBody(hash: string): Promise<string> {
    if (!hash.trim()) throw new Error("Commit hash required");
    return this.run(["log", "-n", "1", "--pretty=format:%B", hash]);
  }

  commitDetails(hash: string): Promise<string> {
    if (!hash.trim()) throw new Error("Commit hash required");
    return this.run(["show", "--numstat", "-z", "-M", "--pretty=format:%H\x1f%s", hash]);
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
  commitFileDiff(hash: string, path: string, oldPath?: string): Promise<string> {
    if (!hash.trim()) throw new Error("Commit hash required");
    // A rename needs both sides as pathspecs, or Git sees only the new name and shows
    // the whole file as added.
    const paths = oldPath && oldPath !== path ? [oldPath, path] : [path];
    return this.run([
      "show",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "-M",
      "--pretty=format:",
      hash,
      "--",
      ...paths,
    ]);
  }

  /**
   * `untracked` is "Stash (Include Untracked)" (`-u`); `staged` is "Stash Staged" (`--staged`,
   * only what's already in the index -- everything else stays in the working tree). Plain
   * "Stash" passes neither, matching Git's own plain `stash push` (tracked changes only).
   */
  stash(
    options: { message?: string; untracked?: boolean; staged?: boolean } = {},
  ): Promise<string> {
    const args = ["stash", "push"];
    if (options.staged) args.push("--staged");
    else if (options.untracked) args.push("-u");
    if (options.message?.trim()) args.push("-m", options.message.trim());
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
  /** "Drop All Stashes": clears the entire stash list at once. */
  stashClear(): Promise<string> {
    return this.run(["stash", "clear"]);
  }
  /** "View Stash…": the stash's own unified diff against the commit it was taken from --
   * the same format `diff()`/`commitFileDiff()` already produce, so it reuses their viewer. */
  stashShow(index: number): Promise<string> {
    return this.run(["stash", "show", "--no-color", "-p", `stash@{${index}}`]);
  }
  stashList(): Promise<string> {
    return this.run(["stash", "list"]);
  }

  async tags(): Promise<string[]> {
    const out = await this.run(["tag", "-l"]);
    return out.trim().split("\n").filter(Boolean);
  }

  /**
   * A lightweight tag at HEAD. `check-ref-format --branch` is reused to validate the name --
   * Git has no `--tag` mode for that command, and tag and branch short names follow the same
   * basic ref-component rules (no annotated tags/messages: not something the UI offers yet).
   */
  async createTag(name: string): Promise<string> {
    await this.run(["check-ref-format", "--branch", name]);
    return this.run(["tag", name]);
  }
  deleteTag(name: string): Promise<string> {
    return this.run(["tag", "-d", name]);
  }
}
