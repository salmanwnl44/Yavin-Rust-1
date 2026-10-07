/**
 * Marketplace search as the Extensions view drives it (IDE-09), without React: input is
 * debounced (300 ms), the request in flight is aborted when a newer one starts, and an answer
 * that arrives for anything but the latest request is dropped -- searching "python" and then
 * "python debugger" can never show the results of "python". Pages load on demand; a failure
 * keeps the query and can be retried.
 */
import { EXTENSION_API } from "../manifest.ts";
import {
  MarketplaceError,
  type MarketplaceExtension,
  type SearchRequest,
  type SearchResult,
} from "./types.ts";

export const SEARCH_DEBOUNCE_MS = 300;
export const PAGE_SIZE = 20;

export interface SearchQuery {
  query: string;
  category: string | null;
  compatibleOnly: boolean;
}

export interface SearchSnapshot {
  query: SearchQuery;
  status: "idle" | "loading" | "loaded" | "error";
  items: readonly MarketplaceExtension[];
  total: number;
  /** Pages loaded. */
  pages: number;
  /** Loading another page (the items stay). */
  loadingMore: boolean;
  error: MarketplaceError | null;
}

export function createSearchController(
  run: (request: SearchRequest, signal: AbortSignal) => Promise<SearchResult>,
  options: { debounceMs?: number; pageSize?: number; api?: string } = {},
) {
  const debounce = options.debounceMs ?? SEARCH_DEBOUNCE_MS;
  const pageSize = options.pageSize ?? PAGE_SIZE;
  const listeners = new Set<() => void>();
  let snapshot: SearchSnapshot = {
    query: { query: "", category: null, compatibleOnly: false },
    status: "idle",
    items: [],
    total: 0,
    pages: 0,
    loadingMore: false,
    error: null,
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: AbortController | null = null;
  /** The latest request's number: any other answer is stale. */
  let sequence = 0;
  let disposed = false;

  const publish = (next: Partial<SearchSnapshot>) => {
    snapshot = { ...snapshot, ...next };
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        /* One listener's failure is not the others'. */
      }
    }
  };
  const active = (query: SearchQuery) => !!query.query.trim() || query.category !== null;

  const fetchPage = (page: number) => {
    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;
    const mine = ++sequence;
    const query = snapshot.query;
    if (page === 0) publish({ status: "loading", error: null, loadingMore: false });
    else publish({ loadingMore: true, error: null });
    run(
      {
        query: query.query.trim(),
        category: query.category,
        compatibleWith: query.compatibleOnly ? (options.api ?? EXTENSION_API) : null,
        page,
        pageSize,
      },
      controller.signal,
    ).then(
      (result) => {
        if (disposed || mine !== sequence) return; // stale
        publish({
          status: "loaded",
          items: page === 0 ? result.items : [...snapshot.items, ...result.items],
          total: result.total,
          pages: page + 1,
          loadingMore: false,
        });
      },
      (error: unknown) => {
        if (disposed || mine !== sequence) return;
        if (error instanceof MarketplaceError && error.code === "Cancelled") return;
        publish({
          status: "error",
          loadingMore: false,
          error:
            error instanceof MarketplaceError
              ? error
              : new MarketplaceError(
                  "Unavailable",
                  "The extension marketplace is unavailable.",
                  String(error),
                ),
        });
      },
    );
  };

  const schedule = (immediate = false) => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!active(snapshot.query)) {
      inFlight?.abort();
      sequence++;
      publish({ status: "idle", items: [], total: 0, pages: 0, error: null, loadingMore: false });
      return;
    }
    if (immediate) fetchPage(0);
    else timer = setTimeout(() => fetchPage(0), debounce);
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** New text, debounced. */
    setText(query: string) {
      if (query === snapshot.query.query) return;
      publish({ query: { ...snapshot.query, query } });
      schedule();
    },
    /** Filters apply at once. */
    setFilters(filters: Partial<Omit<SearchQuery, "query">>) {
      publish({ query: { ...snapshot.query, ...filters } });
      schedule(true);
    },
    clear() {
      publish({ query: { ...snapshot.query, query: "", category: null } });
      schedule(true);
    },
    retry() {
      if (snapshot.status === "error" && snapshot.pages > 0) fetchPage(snapshot.pages);
      else schedule(true);
    },
    loadMore() {
      if (
        snapshot.status !== "loaded" ||
        snapshot.loadingMore ||
        snapshot.items.length >= snapshot.total
      )
        return;
      fetchPage(snapshot.pages);
    },
    /** Search again now (after a provider change or refresh). */
    rerun: () => schedule(true),
    get active() {
      return active(snapshot.query);
    },
    /**
     * Stops what is pending (a debounced search, a request in flight, its answer). The controller
     * stays usable: a component that unmounts and mounts again (React's development double
     * mount) keeps it.
     */
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      inFlight?.abort();
      sequence++;
      if (snapshot.status === "loading" || snapshot.loadingMore)
        publish({ status: snapshot.items.length ? "loaded" : "idle", loadingMore: false });
    },
    /** Done with for good (tests). */
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      inFlight?.abort();
      listeners.clear();
    },
  };
}

export type SearchController = ReturnType<typeof createSearchController>;
