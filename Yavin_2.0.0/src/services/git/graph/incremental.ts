import type { Repository } from "../repository.ts";
import { parseGraphLog } from "../parsers/log.ts";
import type { RawCommit } from "../parsers/log.ts";
import { buildCommitGraph } from "./model.ts";
import type { GraphLayout } from "./model.ts";

export const GRAPH_PAGE_SIZE = 300;

export interface GraphSnapshot {
  commits: RawCommit[];
  layout: GraphLayout;
  loading: boolean;
  hasMore: boolean;
  notice: string;
  /** Whether this repository's history has been truncated by a shallow clone --
   * checked once, on the first page load, since a repository's shallow-ness cannot
   * change without an explicit deepen operation Yavin doesn't currently expose. */
  shallow: boolean;
}

const EMPTY_LAYOUT: GraphLayout = { nodes: [], edges: [], laneCount: 0 };

/** Git's message for `git log` on a branch that has no commits yet. */
export const isUnbornHistory = (error: unknown): boolean =>
  /does not have any commits yet|bad default revision 'HEAD'/i.test(String(error));

/**
 * Loads one repository's commit history a page at a time and rebuilds the graph
 * layout over the full accumulated list each time. Recomputing from scratch (rather
 * than threading lane state between pages) is deliberate: `buildCommitGraph` is a
 * pure, purely-forward function of the ordered commit list, so already-rendered rows
 * come out byte-identical every time -- no lane jitter -- without the complexity of
 * carrying lane state across page boundaries. This is a straightforward place to
 * revisit if profiling ever shows full recomputation is too slow for very deep history.
 */
export class GraphLoader {
  private snapshot: GraphSnapshot = {
    commits: [],
    layout: EMPTY_LAYOUT,
    loading: false,
    hasMore: true,
    notice: "",
    shallow: false,
  };
  private listeners = new Set<() => void>();
  private loadingMore = false;
  private disposed = false;
  private shallowChecked = false;
  // Bumped by reset() so a loadMore() that was already in flight -- and whose
  // `skip`/accumulated commits are now stale -- discards its result on resolution
  // instead of appending onto the freshly-cleared snapshot.
  private generation = 0;
  private readonly repository: Repository;

  // Not a parameter-property shorthand -- see the matching note in repository.ts.
  constructor(repository: Repository) {
    this.repository = repository;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): GraphSnapshot => this.snapshot;

  private patch(next: Partial<GraphSnapshot>) {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...next };
    for (const listener of this.listeners) listener();
  }

  /** Reloads from the top -- used after Fetch/Pull/Push, when HEAD may have moved. */
  async reset(): Promise<void> {
    if (this.disposed) return;
    // Invalidate any load already in flight and free the in-flight lock immediately,
    // rather than leaving it held by a request whose result is about to be discarded.
    this.generation++;
    this.loadingMore = false;
    // shallow/shallowChecked deliberately survive a reset -- a repository's
    // shallow-ness doesn't change just because its history is being reloaded, and
    // there is no deepen operation Yavin exposes that would invalidate it.
    this.snapshot = {
      commits: [],
      layout: EMPTY_LAYOUT,
      loading: false,
      hasMore: true,
      notice: "",
      shallow: this.snapshot.shallow,
    };
    for (const listener of this.listeners) listener();
    await this.loadMore();
  }

  async loadMore(): Promise<void> {
    if (this.loadingMore || this.disposed || !this.snapshot.hasMore) return;
    const generation = this.generation;
    this.loadingMore = true;
    this.patch({ loading: true, notice: "" });
    try {
      const skip = this.snapshot.commits.length;
      const checkShallow = !this.shallowChecked;
      if (checkShallow) this.shallowChecked = true;
      const [raw, shallow] = await Promise.all([
        this.repository.graphLog(skip, GRAPH_PAGE_SIZE),
        checkShallow ? this.repository.isShallow() : Promise.resolve(this.snapshot.shallow),
      ]);
      if (generation !== this.generation) return;
      const page = parseGraphLog(raw);
      const commits = [...this.snapshot.commits, ...page];
      this.patch({
        commits,
        layout: buildCommitGraph(commits),
        hasMore: page.length === GRAPH_PAGE_SIZE,
        loading: false,
        shallow,
      });
    } catch (error) {
      if (generation !== this.generation) return;
      // A repository with no commits yet (a freshly created one) makes `git log` exit
      // non-zero -- that is an empty history, not a failure worth showing the user.
      if (isUnbornHistory(error)) {
        this.patch({ hasMore: false, loading: false });
        return;
      }
      this.patch({ notice: String(error), loading: false });
    } finally {
      if (generation === this.generation) this.loadingMore = false;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}
