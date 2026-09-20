import { Repository } from "./repository.ts";
import { RepoStore } from "./store.ts";
import { attachWorktree, normalizeCommonDir } from "./identity.ts";
import { parsePersistedState } from "./persistence.ts";
import type { PersistedGitState } from "./persistence.ts";
import { parseWorktreeList } from "./parsers/worktree.ts";
import type { WorktreeInfo } from "./parsers/worktree.ts";
import { probeWorktree, unwatchRepo, watchRepo } from "./backend.ts";
import type { WorktreeStatus } from "./backend.ts";

/**
 * One open worktree. Kept under this name (rather than `WorktreeEntry`) so every
 * existing consumer -- `RepositoriesSection`, `gitCommandMenu`, `syncAction`,
 * `StashesSection`, `InlineGraphSection`, `CommitGraphPanel` -- keeps working
 * unchanged: none of them care which repository a worktree belongs to, only that it
 * has a `repoId`/`root`/`store`. Phase 6 of the Repository & Worktree Architecture
 * plan introduces per-repository grouping in the UI and can rename call sites then.
 */
export interface RepoEntry {
  repoId: string;
  root: string;
  store: RepoStore;
  /**
   * Whether the folder can still be used as this worktree. Anything but `ready` means the
   * store's data is the last state seen before the folder went away (`missing`: deleted,
   * moved or its drive is gone; `invalid`: still there, but no longer this work tree), so the
   * UI must not present it as current. Set from a probe after a refresh fails and cleared by
   * the next successful refresh.
   */
  status: WorktreeStatus;
}

/**
 * The worktrees Git considers one repository (identical `git rev-parse
 * --git-common-dir`), grouped so a linked worktree is never mistaken for an
 * independent repository. `repos` below remains the flat, one-row-per-*tracked*-
 * worktree list most views render -- opening two different worktree paths of the
 * same repository attaches the second as a sibling here instead of creating an
 * unrelated entry.
 */
export interface RepositoryEntry {
  repositoryId: string;
  /** Worktrees the user has actually opened/tracked -- each has a live `RepoStore`. */
  worktrees: RepoEntry[];
  /**
   * Every worktree `git worktree list --porcelain` reports for this repository,
   * whether or not it's been opened -- inert metadata only (no `RepoStore` is
   * created for one until it's actually opened, so browsing this list never starts
   * eager status polling for worktrees nobody asked to track). Refreshed each time a
   * worktree of this repository is opened; `[]` until the first successful refresh.
   */
  knownWorktrees: WorktreeInfo[];
}

interface RegistrySnapshot {
  /** Every open worktree, flattened across every repository -- unchanged shape. */
  repos: RepoEntry[];
  /** The same worktrees, grouped by owning repository. */
  repositories: RepositoryEntry[];
  /** The active worktree's own native id -- unchanged meaning, kept for `RepositoriesSection`'s row highlighting. */
  activeRepoId: string | null;
  /** The active worktree's owning repository's identity. */
  activeRepositoryId: string | null;
  /** The active worktree's root -- `activeRepoId` restated explicitly as a path, for code that means "worktree" and shouldn't reach for the ambiguous native id. */
  activeWorktreePath: string | null;
}

const STORAGE_KEY = "yavin.git.repos";

function readPersisted(): PersistedGitState {
  try {
    return parsePersistedState(localStorage.getItem(STORAGE_KEY));
  } catch {
    return { schemaVersion: 1, repositories: [] };
  }
}

function flatten(repositories: RepositoryEntry[]): RepoEntry[] {
  return repositories.flatMap((repository) => repository.worktrees);
}

const samePath = (a: string, b: string) =>
  a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();

/** A repository's preferred worktree: its main worktree if usable, else its first usable one. */
function preferredWorktree(repository: RepositoryEntry): RepoEntry | undefined {
  const usable = repository.worktrees.filter((w) => w.status === "ready");
  const main = repository.knownWorktrees.find((k) => k.isMain);
  return (main && usable.find((w) => samePath(w.root, main.path))) ?? usable[0];
}

/**
 * Which worktree should be active, given what was remembered as active (from storage, or the
 * one that just stopped being usable). In order:
 * 1. the remembered worktree itself, if it is still usable;
 * 2. otherwise its repository's main worktree, if open and usable;
 * 3. otherwise that repository's first other usable worktree, in the order they were opened;
 * 4. otherwise the same rule (main, else first) applied to the other repositories in order;
 * 5. otherwise `null` -- nothing usable is open.
 * Never an arbitrary "first entry": a missing or invalid worktree is skipped explicitly.
 */
export function chooseActiveWorktree(
  repositories: RepositoryEntry[],
  remembered: { repositoryId: string | null; worktreePath: string | null },
): { repository: RepositoryEntry; worktree: RepoEntry } | null {
  const rememberedPath = remembered.worktreePath;
  const owner =
    repositories.find((r) => r.repositoryId === remembered.repositoryId) ??
    (rememberedPath
      ? repositories.find((r) => r.worktrees.some((w) => samePath(w.root, rememberedPath)))
      : undefined);

  if (rememberedPath) {
    for (const repository of repositories) {
      const exact = repository.worktrees.find(
        (w) => w.status === "ready" && samePath(w.root, rememberedPath),
      );
      if (exact) return { repository, worktree: exact };
    }
  }
  const ordered = owner ? [owner, ...repositories.filter((r) => r !== owner)] : repositories;
  for (const repository of ordered) {
    const worktree = preferredWorktree(repository);
    if (worktree) return { repository, worktree };
  }
  return null;
}

/**
 * The set of repositories (grouped by their real Git identity) Source Control tracks
 * in this window -- independent of whichever single folder the file explorer has
 * open. A module-level singleton so it survives component remounts (e.g. switching
 * the main workspace folder) and is reachable from the repo switcher, the status
 * bar, and the activity bar badge alike.
 */
export class GitRegistry {
  private snapshot: RegistrySnapshot = {
    repos: [],
    repositories: [],
    activeRepoId: null,
    activeRepositoryId: null,
    activeWorktreePath: null,
  };
  private listeners = new Set<() => void>();
  private opening = new Map<string, Promise<RepoEntry | null>>();
  private restorePromise: Promise<void> | null = null;
  /** Repositories whose `.git` watcher could not be (re)started: only polling covers them. */
  private watcherDown = new Set<string>();
  /** Worktrees a status probe is already running for, so a failing poll does not stack probes. */
  private probing = new Set<string>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): RegistrySnapshot => this.snapshot;

  private set(
    repositories: RepositoryEntry[],
    active: { repositoryId: string | null; worktreePath: string | null },
  ) {
    const repos = flatten(repositories);
    const activeWorktree = repos.find((r) => r.root === active.worktreePath) ?? null;
    this.snapshot = {
      repos,
      repositories,
      activeRepoId: activeWorktree?.repoId ?? null,
      activeRepositoryId: active.repositoryId,
      activeWorktreePath: active.worktreePath,
    };
    this.persist();
    for (const listener of this.listeners) listener();
  }

  /**
   * Forces a new snapshot reference so `useSyncExternalStore` subscribers notice a
   * change even when only a child repo's live status changed, not the repo list or
   * active selection themselves.
   */
  private notifyChange(): void {
    this.snapshot = { ...this.snapshot };
    for (const listener of this.listeners) listener();
  }

  private persist() {
    try {
      const state: PersistedGitState = {
        schemaVersion: 1,
        repositories: this.snapshot.repositories.map((repository) => {
          const activeWorktree = repository.worktrees.some(
            (w) => w.root === this.snapshot.activeWorktreePath,
          )
            ? this.snapshot.activeWorktreePath!
            : undefined;
          return {
            commonDirHint: repository.repositoryId,
            worktrees: repository.worktrees.map((w) => w.root),
            ...(activeWorktree ? { activeWorktree } : {}),
          };
        }),
        ...(this.snapshot.activeRepositoryId
          ? { activeRepository: this.snapshot.activeRepositoryId }
          : {}),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* Repo list stays session-only when storage is unavailable. */
    }
  }

  /**
   * Reopens every persisted worktree once (a path that no longer resolves is
   * dropped) and restores the previously-active repository/worktree if it's among
   * them, migrating a pre-worktree persisted value transparently on read.
   */
  restore(): Promise<void> {
    if (!this.restorePromise) {
      this.restorePromise = (async () => {
        const persisted = readPersisted();
        for (const repository of persisted.repositories)
          for (const path of repository.worktrees) await this.open(path, { silent: true });

        const rememberedRepository = persisted.repositories.find(
          (r) => r.commonDirHint === persisted.activeRepository,
        );
        // Explicit, not "whichever opened first": the remembered worktree if it still opens,
        // else its repository's main worktree, else another usable one (`chooseActiveWorktree`).
        const choice = chooseActiveWorktree(this.snapshot.repositories, {
          repositoryId: persisted.activeRepository ?? null,
          worktreePath: rememberedRepository?.activeWorktree ?? null,
        });
        // Always written back, so a worktree that no longer opens is pruned from storage even
        // when none of them opened at all.
        this.set(
          this.snapshot.repositories,
          choice
            ? { repositoryId: choice.repository.repositoryId, worktreePath: choice.worktree.root }
            : { repositoryId: null, worktreePath: null },
        );
      })();
    }
    return this.restorePromise;
  }

  /**
   * Starts, restarts or stops the repository's `.git` watcher without ever leaving a
   * rejected promise behind. Losing the watcher is not fatal -- the poll and focus
   * refresh still run -- but it is recorded so the poll can stop assuming the watcher
   * reports branch/ref/stash changes (see `isWatcherDown`).
   */
  private syncWatcher(repositoryId: string, worktreeRepoIds: string[] | null): void {
    const request =
      worktreeRepoIds === null
        ? unwatchRepo(repositoryId)
        : watchRepo(repositoryId, worktreeRepoIds);
    request.then(
      () => {
        this.watcherDown.delete(repositoryId);
      },
      (error) => {
        // Stopping a watcher that failed is harmless; only a failed start/restart leaves
        // a repository unwatched.
        if (worktreeRepoIds !== null) this.watcherDown.add(repositoryId);
        console.debug(`Git watcher ${worktreeRepoIds === null ? "stop" : "start"} failed`, error);
      },
    );
  }

  /**
   * Called after each of a worktree's refreshes. A failure is the moment to ask whether the
   * folder itself is gone (a Git error and a missing folder look the same to the store); a
   * success means whatever was wrong is over.
   */
  private async refreshOutcome(repoId: string, ok: boolean): Promise<void> {
    const found = this.findWorktree(repoId);
    if (!found) return;
    if (ok) {
      this.setStatus(found.worktree, "ready");
      return;
    }
    if (this.probing.has(repoId)) return;
    this.probing.add(repoId);
    try {
      const status = await probeWorktree(repoId).catch(() => null);
      // Closed while probing, or the probe itself failed: leave the status as it was.
      if (status && this.findWorktree(repoId)) this.setStatus(found.worktree, status);
    } finally {
      this.probing.delete(repoId);
    }
  }

  private setStatus(worktree: RepoEntry, status: WorktreeStatus): void {
    if (worktree.status === status) return;
    worktree.status = status;
    let active = {
      repositoryId: this.snapshot.activeRepositoryId,
      worktreePath: this.snapshot.activeWorktreePath,
    };
    if (status !== "ready" && active.worktreePath === worktree.root) {
      const next = chooseActiveWorktree(this.snapshot.repositories, active);
      // With nothing else usable the unusable worktree stays selected, so the panel can
      // explain what happened instead of showing an empty state.
      if (next)
        active = { repositoryId: next.repository.repositoryId, worktreePath: next.worktree.root };
    }
    this.set(this.snapshot.repositories, active);
  }

  /** Whether `repoId`'s repository has no working `.git` watcher, so polling must cover it. */
  isWatcherDown(repoId: string): boolean {
    const repositoryId = this.findWorktree(repoId)?.repository.repositoryId;
    return repositoryId !== undefined && this.watcherDown.has(repositoryId);
  }

  private findWorktree(
    repoId: string,
  ): { repository: RepositoryEntry; worktree: RepoEntry } | null {
    for (const repository of this.snapshot.repositories) {
      const worktree = repository.worktrees.find((w) => w.repoId === repoId);
      if (worktree) return { repository, worktree };
    }
    return null;
  }

  private findByRoot(path: string): RepoEntry | undefined {
    const lower = path.toLowerCase();
    return this.snapshot.repos.find((r) => r.root.toLowerCase() === lower);
  }

  /**
   * Opens (or reuses) the repository containing `path`. `silent` swallows a
   * "not a repository" or unreachable-path failure instead of throwing, for
   * background restoration where a stale persisted entry should just be dropped.
   */
  async open(
    path: string,
    options: { silent?: boolean; makeActive?: boolean } = {},
  ): Promise<RepoEntry | null> {
    if (!path) return null;
    const existing = this.findByRoot(path);
    if (existing) {
      if (options.makeActive) this.makeActive(existing);
      return existing;
    }
    const pending = this.opening.get(path);
    if (pending) return pending;
    const task = this.openNew(path, options).finally(() => this.opening.delete(path));
    this.opening.set(path, task);
    return task;
  }

  private makeActive(worktree: RepoEntry) {
    const owner = this.findWorktree(worktree.repoId)?.repository;
    if (!owner) return;
    this.set(this.snapshot.repositories, {
      repositoryId: owner.repositoryId,
      worktreePath: worktree.root,
    });
  }

  private async openNew(
    path: string,
    options: { silent?: boolean; makeActive?: boolean },
  ): Promise<RepoEntry | null> {
    try {
      const repository = await Repository.open(path);
      // Repository.open() normalizes to the true top-level, which may already be
      // tracked under a different path that pointed at one of its subfolders.
      const already = this.findWorktree(repository.repoId);
      if (already) {
        void repository.close();
        if (options.makeActive) this.makeActive(already.worktree);
        return already.worktree;
      }

      const rawCommonDir = await repository.commonGitDir().catch(() => "");
      const repositoryId = normalizeCommonDir(repository.root, rawCommonDir);

      const worktree: RepoEntry = {
        repoId: repository.repoId,
        root: repository.root,
        status: "ready",
        store: new RepoStore(
          repository,
          () => this.notifyChange(),
          (ok) => void this.refreshOutcome(repository.repoId, ok),
        ),
      };
      void worktree.store.refresh();

      // A second worktree of an already-tracked repository is attached as a sibling
      // rather than registered as an unrelated top-level entry -- this is the actual
      // fix this phase makes: a linked worktree is never mistaken for its own
      // independent repository.
      const attached = attachWorktree(this.snapshot.repositories, repositoryId, worktree);
      // Inert metadata only -- discovering a worktree here never creates a RepoStore
      // for it, so browsing this list doesn't start status polling for worktrees
      // nobody has actually opened. See the plan's Phase 5/6 notes.
      const knownWorktrees = await repository
        .listWorktrees()
        .then(parseWorktreeList)
        .catch(() => []);
      const repositories = attached.map((r) =>
        r.repositoryId === repositoryId ? { ...r, knownWorktrees } : r,
      );

      // Re-registers with the now-expanded worktree list every time, rather than
      // tracking "is this the first worktree of this repository" specially --
      // `git_watch_repo` (Rust) already replaces (stopping and restarting) any
      // existing watcher for this repositoryId. Not awaited: losing live
      // external-change detection is not fatal, the existing poll/focus refresh
      // remains the permanent fallback (see the Git State & Synchronization plan);
      // `syncWatcher` records a failure instead of leaving an unhandled rejection.
      const owner = repositories.find((r) => r.repositoryId === repositoryId);
      if (owner)
        this.syncWatcher(
          repositoryId,
          owner.worktrees.map((w) => w.repoId),
        );

      const shouldActivate = options.makeActive || !this.snapshot.activeWorktreePath;
      this.set(repositories, {
        repositoryId: shouldActivate ? repositoryId : this.snapshot.activeRepositoryId,
        worktreePath: shouldActivate ? worktree.root : this.snapshot.activeWorktreePath,
      });
      return worktree;
    } catch (error) {
      if (options.silent) return null;
      throw error;
    }
  }

  async close(repoId: string): Promise<void> {
    const found = this.findWorktree(repoId);
    if (!found) return;
    const { repository, worktree } = found;
    worktree.store.dispose();
    void worktree.store.repository.close();

    const remainingWorktrees = repository.worktrees.filter((w) => w !== worktree);
    const repositories = remainingWorktrees.length
      ? this.snapshot.repositories.map((r) =>
          r === repository ? { ...r, worktrees: remainingWorktrees } : r,
        )
      : this.snapshot.repositories.filter((r) => r !== repository);

    // Stop watching entirely once the last worktree of this repository closes;
    // otherwise re-register with the narrower, still-open worktree list.
    if (remainingWorktrees.length) {
      this.syncWatcher(
        repository.repositoryId,
        remainingWorktrees.map((w) => w.repoId),
      );
    } else {
      this.syncWatcher(repository.repositoryId, null);
      this.watcherDown.delete(repository.repositoryId);
    }

    const activeRemoved = this.snapshot.activeWorktreePath === worktree.root;
    const fallback = flatten(repositories)[0] ?? null;
    const fallbackOwner = fallback ? this.findOwnerAfter(repositories, fallback) : null;
    this.set(repositories, {
      repositoryId: activeRemoved
        ? (fallbackOwner?.repositoryId ?? null)
        : this.snapshot.activeRepositoryId,
      worktreePath: activeRemoved ? (fallback?.root ?? null) : this.snapshot.activeWorktreePath,
    });
  }

  private findOwnerAfter(
    repositories: RepositoryEntry[],
    worktree: RepoEntry,
  ): RepositoryEntry | undefined {
    return repositories.find((r) => r.worktrees.includes(worktree));
  }

  setActive(repoId: string): void {
    const found = this.findWorktree(repoId);
    if (found) this.makeActive(found.worktree);
  }

  /** The repository a worktree belongs to, or `undefined` if `repoId` isn't tracked. */
  repositoryFor(repoId: string): RepositoryEntry | undefined {
    return this.findWorktree(repoId)?.repository;
  }

  /** Looks up a tracked repository by its own identity (the value `git_watch_repo`'s
   * events carry), as opposed to `repositoryFor`, which looks one up by a worktree's
   * native id. `undefined` once every worktree of it has been closed. */
  repositoryById(repositoryId: string): RepositoryEntry | undefined {
    return this.snapshot.repositories.find((r) => r.repositoryId === repositoryId);
  }

  /**
   * Re-fetches `repositoryId`'s `knownWorktrees` (`git worktree list --porcelain`,
   * unchanged from what `openNew` already runs once at open time) -- addressing
   * the gap that list is otherwise never refreshed again, so a worktree added or
   * removed externally after that point stays silently stale. Piggybacks on
   * whichever call site already has a reason to check in (the active repository's
   * own focus-regain event, see `SourceControlPanel.tsx`) rather than adding a new
   * watch target of its own -- full live external worktree add/remove detection
   * remains Module 1's Open Question #4, unchanged and out of scope here. A
   * repository that's no longer tracked, or whose `listWorktrees()` call fails
   * (e.g. it's mid-close), is a silent no-op.
   */
  async refreshKnownWorktrees(repositoryId: string): Promise<void> {
    const repository = this.repositoryById(repositoryId);
    const anyWorktree = repository?.worktrees[0];
    if (!anyWorktree) return;
    const knownWorktrees = await anyWorktree.store.repository
      .listWorktrees()
      .then(parseWorktreeList)
      .catch(() => null);
    if (!knownWorktrees) return;
    // Re-check after the await: the repository could have closed meanwhile.
    if (!this.repositoryById(repositoryId)) return;
    this.set(
      this.snapshot.repositories.map((r) =>
        r.repositoryId === repositoryId ? { ...r, knownWorktrees } : r,
      ),
      {
        repositoryId: this.snapshot.activeRepositoryId,
        worktreePath: this.snapshot.activeWorktreePath,
      },
    );
  }
}

export const gitRegistry = new GitRegistry();
