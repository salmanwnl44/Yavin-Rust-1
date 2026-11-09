/**
 * Call hierarchy model (WS14): lazy loading, incoming/outgoing direction, cycle-safe expansion,
 * direction reset, stale-result protection, empty and error results. Deterministic fakes; no LSP.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createCallHierarchy, type CallDirection } from "./callHierarchy.ts";
import type { CallHierarchyItem } from "./protocol.ts";

// A distinct selectionRange position per name (as a real server gives), so two items are the
// "same symbol" only when their name matches — which is what makes the cycle test meaningful.
const item = (name: string, uri = "file:///a.ts"): CallHierarchyItem => {
  const line = name.charCodeAt(0);
  return {
    name,
    kind: 12,
    uri,
    range: { start: { line, character: 0 }, end: { line, character: 10 } },
    selectionRange: { start: { line, character: 0 }, end: { line, character: name.length } },
  };
};

const names = (h: ReturnType<typeof createCallHierarchy>) =>
  h.getRows().map((r) => r.node.item.name);
const settle = () => new Promise((r) => setTimeout(r, 0));

function hierarchy(
  root: CallHierarchyItem,
  edges: { incoming?: Record<string, string[]>; outgoing?: Record<string, string[]> },
  direction: CallDirection = "incoming",
) {
  return createCallHierarchy({
    direction,
    root,
    incoming: async (it) =>
      (edges.incoming?.[it.name] ?? []).map((n) => ({ from: item(n), fromRanges: [] })),
    outgoing: async (it) =>
      (edges.outgoing?.[it.name] ?? []).map((n) => ({ to: item(n), fromRanges: [] })),
  });
}

test("children load lazily on expand (incoming = callers)", async () => {
  const h = hierarchy(item("A"), { incoming: { A: ["B", "C"] } });
  assert.deepEqual(names(h), ["A"], "only the root before expanding");
  const root = h.getRows()[0]!.node;
  assert.equal(root.children, null, "not loaded yet");
  await h.toggle(root);
  assert.deepEqual(names(h), ["A", "B", "C"], "callers loaded and shown");
  // Collapsing hides them without re-fetching.
  await h.toggle(root);
  assert.deepEqual(names(h), ["A"]);
  h.dispose();
});

test("outgoing direction lists callees", async () => {
  const h = hierarchy(item("A"), { outgoing: { A: ["X"] } }, "outgoing");
  await h.toggle(h.getRows()[0]!.node);
  assert.deepEqual(names(h), ["A", "X"]);
  h.dispose();
});

test("a cycle is detected and not expanded again (A → B → A)", async () => {
  const h = hierarchy(item("A"), { incoming: { A: ["B"], B: ["A"] } });
  await h.toggle(h.getRows()[0]!.node); // A → [B]
  const b = h.getRows().find((r) => r.node.item.name === "B")!.node;
  await h.toggle(b); // B → [A'] where A' is a cycle
  const aPrime = h.getRows().find((r) => r.node.item.name === "A" && r.node.depth === 2)!.node;
  assert.equal(aPrime.cyclic, true, "the repeat of A is marked cyclic");
  assert.deepEqual(aPrime.children, [], "a cyclic node has nothing further to load");
  await h.toggle(aPrime); // no-op
  assert.equal(aPrime.expanded, false, "a cyclic node does not expand");
  h.dispose();
});

test("switching direction rebuilds from the root", async () => {
  const h = hierarchy(item("A"), { incoming: { A: ["B"] }, outgoing: { A: ["X"] } });
  await h.toggle(h.getRows()[0]!.node);
  assert.deepEqual(names(h), ["A", "B"]);
  h.setDirection("outgoing");
  assert.deepEqual(names(h), ["A"], "reset to the root");
  await h.toggle(h.getRows()[0]!.node);
  assert.deepEqual(names(h), ["A", "X"]);
  h.dispose();
});

test("a stale load (direction switched mid-flight) never populates the old tree", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const h = createCallHierarchy({
    direction: "incoming",
    root: item("A"),
    incoming: async () => {
      await gate; // held open
      return [{ from: item("B"), fromRanges: [] }];
    },
    outgoing: async () => [{ to: item("X"), fromRanges: [] }],
  });
  const toggling = h.toggle(h.getRows()[0]!.node); // starts the gated incoming load
  h.setDirection("outgoing"); // supersede it
  release();
  await toggling;
  await settle();
  // The gated incoming result is dropped; the tree is the fresh outgoing root.
  assert.deepEqual(names(h), ["A"]);
  h.dispose();
});

test("empty and error results are handled", async () => {
  const empty = hierarchy(item("A"), { incoming: { A: [] } });
  await empty.toggle(empty.getRows()[0]!.node);
  assert.deepEqual(empty.getRows()[0]!.node.children, [], "no callers → empty children, no error");
  empty.dispose();

  const failing = createCallHierarchy({
    direction: "incoming",
    root: item("A"),
    incoming: async () => {
      throw new Error("server error");
    },
    outgoing: async () => [],
  });
  await failing.toggle(failing.getRows()[0]!.node);
  assert.match(failing.getRows()[0]!.node.error ?? "", /server error/);
  failing.dispose();
});
