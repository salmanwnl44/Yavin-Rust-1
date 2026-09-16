import { Repository } from "./repository.ts";
import { RepoStore } from "./store.ts";

export interface RepoEntry {
  repoId: string;
  root: string;
  store: RepoStore;
}

interface RegistrySnapshot {
  repos: RepoEntry[];
  activeRepoId: string | null;
}

const STORAGE_KEY = "yavin.git.repos";

function readPersistedRoots(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The set of repositories Source Control tracks in this window -- independent of
 * whichever single folder the file explorer has open. A module-level singleton so it
 * survives component remounts (e.g. switching the main workspace folder) and is
 * reachable from the repo switcher, the status bar, and the activity bar badge alike.
 */
class GitRegistry {
  private snapshot: RegistrySnapshot = { repos: [], activeRepoId: null };
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

  private set(next: Partial<RegistrySnapshot>) {
    this.snapshot = { ...this.snapshot, ...next };
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
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.snapshot.repos.map((r) => r.root)));
    } catch {
      /* Repo list stays session-only when storage is unavailable. */
    }
  }

  /** Reopens every persisted repository once; a path that no longer resolves is dropped. */
  restore(): Promise<void> {
    if (!this.restorePromise) {
      this.restorePromise = (async () => {
        for (const path of readPersistedRoots()) await this.open(path, { silent: true });
      })();
    }
    return this.restorePromise;
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
      if (options.makeActive) this.set({ activeRepoId: existing.repoId });
      return existing;
    }
    const pending = this.opening.get(path);
    if (pending) return pending;
    const task = this.openNew(path, options).finally(() => this.opening.delete(path));
    this.opening.set(path, task);
    return task;
  }

  private async openNew(
    path: string,
    options: { silent?: boolean; makeActive?: boolean },
  ): Promise<RepoEntry | null> {
    try {
      const repository = await Repository.open(path);
      // Repository.open() normalizes to the true top-level, which may already be
      // tracked under a different path that pointed at one of its subfolders.
      const already = this.snapshot.repos.find((r) => r.repoId === repository.repoId);
      if (already) {
        void repository.close();
        if (options.makeActive) this.set({ activeRepoId: already.repoId });
        return already;
      }
      const entry: RepoEntry = {
        repoId: repository.repoId,
        root: repository.root,
        store: new RepoStore(repository, () => this.notifyChange()),
      };
      void entry.store.refresh();
      this.set({
        repos: [...this.snapshot.repos, entry],
        activeRepoId:
          options.makeActive || !this.snapshot.activeRepoId
            ? entry.repoId
            : this.snapshot.activeRepoId,
      });
      return entry;
    } catch (error) {
      if (options.silent) return null;
      throw error;
    }
  }

  async close(repoId: string): Promise<void> {
    const entry = this.snapshot.repos.find((r) => r.repoId === repoId);
    if (!entry) return;
    entry.store.dispose();
    void entry.store.repository.close();
    const repos = this.snapshot.repos.filter((r) => r.repoId !== repoId);
    this.set({
      repos,
      activeRepoId:
        this.snapshot.activeRepoId === repoId
          ? (repos[0]?.repoId ?? null)
          : this.snapshot.activeRepoId,
    });
  }

  setActive(repoId: string): void {
    if (this.snapshot.repos.some((r) => r.repoId === repoId)) this.set({ activeRepoId: repoId });
  }
}

export const gitRegistry = new GitRegistry();
