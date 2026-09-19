import assert from "node:assert/strict";
import test from "node:test";
import { GraphLoader, GRAPH_PAGE_SIZE } from "./incremental.ts";
import type { Repository } from "../repository.ts";

/** A line in the graph log format: hash, no parents, minimal other fields. */
function line(hash: string, parents: string[] = []): string {
  return [
    hash,
    hash.slice(0, 7),
    parents.join(" "),
    "Author",
    "a@x.test",
    "d",
    "ago",
    hash,
    "",
  ].join("\x1f");
}

function fakeRepository(pages: string[][]): Repository {
  let call = 0;
  return {
    graphLog: async (_skip: number, _limit: number) => {
      const page = pages[call] ?? [];
      call++;
      return page.join("\n");
    },
    isShallow: async () => false,
  } as unknown as Repository;
}

test("loadMore accumulates pages and stops once a short page is returned", async () => {
  const fullPage = Array.from({ length: GRAPH_PAGE_SIZE }, (_, i) => line(`full-${i}`));
  const shortPage = [line("last")];
  const loader = new GraphLoader(fakeRepository([fullPage, shortPage]));

  await loader.loadMore();
  assert.equal(loader.getSnapshot().commits.length, GRAPH_PAGE_SIZE);
  assert.equal(loader.getSnapshot().hasMore, true);

  await loader.loadMore();
  assert.equal(loader.getSnapshot().commits.length, GRAPH_PAGE_SIZE + 1);
  assert.equal(loader.getSnapshot().hasMore, false);

  // hasMore is false; a further call must not fetch again.
  await loader.loadMore();
  assert.equal(loader.getSnapshot().commits.length, GRAPH_PAGE_SIZE + 1);
});

test("the layout is rebuilt after each page and notifies subscribers", async () => {
  // Pad the first page to a full GRAPH_PAGE_SIZE so `hasMore` stays true and a
  // second page is actually fetched (a short page is correctly treated as the end).
  const filler = Array.from({ length: GRAPH_PAGE_SIZE - 1 }, (_, i) => line(`filler-${i}`));
  const page1 = [...filler, line("a", ["b"])];
  const page2 = [line("b", [])];
  const loader = new GraphLoader(fakeRepository([page1, page2]));
  let notifications = 0;
  loader.subscribe(() => notifications++);

  await loader.loadMore();
  const edgeFromA = () =>
    loader.getSnapshot().layout.edges.find((e) => e.fromRow === GRAPH_PAGE_SIZE - 1);
  assert.equal(edgeFromA()?.toRow, null);
  assert.ok(notifications >= 1);

  await loader.loadMore();
  assert.equal(edgeFromA()?.toRow, GRAPH_PAGE_SIZE);
});

test("a failed page surfaces its error without crashing the loader", async () => {
  const loader = new GraphLoader({
    graphLog: async () => {
      throw new Error("Git: fatal: bad revision");
    },
    isShallow: async () => false,
  } as unknown as Repository);
  await loader.loadMore();
  assert.match(loader.getSnapshot().notice, /bad revision/);
  assert.equal(loader.getSnapshot().loading, false);
});

test("reset reloads from the top, replacing what was previously loaded", async () => {
  const loader = new GraphLoader(fakeRepository([[line("old")], [line("new-head", ["old"])]]));
  await loader.loadMore();
  assert.deepEqual(
    loader.getSnapshot().commits.map((c) => c.fullHash),
    ["old"],
  );

  await loader.reset();
  assert.deepEqual(
    loader.getSnapshot().commits.map((c) => c.fullHash),
    ["new-head"],
  );
});

test("reset racing an in-flight loadMore discards the stale page instead of corrupting the list", async () => {
  const firstPage = Array.from({ length: GRAPH_PAGE_SIZE }, (_, i) => line(`stale-${i}`));
  let resolveFirstFetch!: () => void;
  let call = 0;
  const repository = {
    graphLog: async (_skip: number, _limit: number) => {
      call++;
      if (call === 1) {
        // Block the first loadMore() mid-flight, exactly where reset() can interleave.
        await new Promise<void>((resolve) => (resolveFirstFetch = resolve));
        return firstPage.join("\n");
      }
      return [line("fresh-head")].join("\n");
    },
    isShallow: async () => false,
  } as unknown as Repository;
  const loader = new GraphLoader(repository);

  const stalePending = loader.loadMore();
  const resetPending = loader.reset();
  resolveFirstFetch();
  await Promise.all([stalePending, resetPending]);

  // The stale page (fetched with a since-invalidated skip=0) must not have been
  // appended onto the snapshot reset() already cleared.
  assert.deepEqual(
    loader.getSnapshot().commits.map((c) => c.fullHash),
    ["fresh-head"],
  );
});

test("isShallow is checked once, on the first page, and never re-queried on later pages or resets", async () => {
  const fullPage = Array.from({ length: GRAPH_PAGE_SIZE }, (_, i) => line(`full-${i}`));
  const shortPage = [line("last")];
  let shallowCalls = 0;
  let call = 0;
  const repository = {
    graphLog: async () => {
      const page = [fullPage, shortPage, shortPage][call] ?? [];
      call++;
      return page.join("\n");
    },
    isShallow: async () => {
      shallowCalls++;
      return true;
    },
  } as unknown as Repository;
  const loader = new GraphLoader(repository);

  await loader.loadMore();
  assert.equal(loader.getSnapshot().shallow, true);
  assert.equal(shallowCalls, 1);

  await loader.loadMore();
  assert.equal(shallowCalls, 1, "a later page must not re-check shallow-ness");

  await loader.reset();
  assert.equal(
    loader.getSnapshot().shallow,
    true,
    "shallow-ness must survive a reset, not revert to the default",
  );
  assert.equal(shallowCalls, 1, "a reset must not re-check shallow-ness either");
});

test("dispose stops further notifications", async () => {
  const loader = new GraphLoader(fakeRepository([[line("a")]]));
  let notifications = 0;
  loader.subscribe(() => notifications++);
  loader.dispose();
  await loader.loadMore();
  assert.equal(notifications, 0);
});
