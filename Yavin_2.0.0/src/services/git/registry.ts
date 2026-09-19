import { Repository } from "./repository.ts";
import { RepoStore } from "./store.ts";
import { attachWorktree, normalizeCommonDir } from "./identity.ts";
import { parsePersistedState } from "./persistence.ts";
import type { PersistedGitState } from "./persistence.ts";
import { parseWorktreeList } from "./parsers/worktree.ts";
import type { WorktreeInfo } from "./parsers/worktree.ts";

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

/**
 * The set of repositories (grouped by their real Git identity) Source Control tracks
 * in this window -- independent of whichever single folder the file explorer has
 * open. A module-level singleton so it survives component remounts (e.g. switching
 * the main workspace folder) and is reachable from the repo switcher, the status
 * bar, and the activity bar badge alike.
 */
class GitRegistry {
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
        const rememberedWorktree = rememberedRepository?.activeWorktree;
        if (rememberedWorktree) {
          const found = this.findByRoot(rememberedWorktree);
          if (found) this.makeActive(found);
        }
      })();
    }
    return this.restorePromise;
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
        store: new RepoStore(repository, () => this.notifyChange()),
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
}

export const gitRegistry = new GitRegistry();
