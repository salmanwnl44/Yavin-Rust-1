import assert from "node:assert/strict";
import test from "node:test";
import { createExplorerStore, type StoreProvider } from "./explorerStore.ts";
import type {
  ExplorerNodeId,
  ExplorerProviderEvent,
  ExplorerResourceNode,
} from "./explorerProvider.ts";

const idOf = (path: string) => path as unknown as ExplorerNodeId;

/**
 * A minimal provider: ids are paths, every path is a known node, events are fed in by hand.
 * (The real provider is exercised in explorerProvider.test.ts; this isolates the store.)
 */
function fakeProvider() {
  let handler: ((e: ExplorerProviderEvent) => void) | null = null;
  const node = (path: string): ExplorerResourceNode =>
    ({
      kind: "file",
      id: idOf(path),
      path,
      resource: `file://${path}`,
    }) as unknown as ExplorerResourceNode;
  const provider: StoreProvider = {
    idFor: idOf,
    getNode: (id) => node(id as unknown as string),
    subscribe: (fn) => {
      handler = fn as (e: ExplorerProviderEvent) => void;
      return () => {
        handler = null;
      };
    },
    loadChildren: async () => {},
    ancestorsOf: (path) => {
      // Everything lives under root "/w"; the folders above `path` are its ancestor chain.
      const parts = path.split("/").slice(1); // ["w","src","a.ts"]
      const folders: string[] = [];
      for (let i = 2; i < parts.length; i++) folders.push("/" + parts.slice(0, i).join("/"));
      return { root: idOf("/w"), folders };
    },
  };
  return { provider, emit: (e: ExplorerProviderEvent) => handler?.(e) };
}

test("a set's view is reference-stable and independent of the other set", () => {
  const { provider } = fakeProvider();
  const store = createExplorerStore(provider, {
    expanded: ["/w", "/w/src"],
    selection: ["/w/src/a.ts"],
  });
  const expanded1 = store.ids("expanded");
  assert.equal(store.ids("expanded"), expanded1, "same object when nothing changed");
  // Changing the selection must NOT rebuild the expanded view (the memoization guarantee).
  store.setSelection(new Set([idOf("/w/src/b.ts")]));
  assert.equal(
    store.ids("expanded"),
    expanded1,
    "selection change leaves the expanded view intact",
  );
  assert.notEqual(store.ids("selection"), undefined);
  assert.ok(store.ids("selection").has(idOf("/w/src/b.ts")));
});

test("setExpanded/setSelection bump the revision and notify", () => {
  const { provider } = fakeProvider();
  const store = createExplorerStore(provider);
  let fired = 0;
  const off = store.subscribe(() => fired++);
  const r0 = store.revision();
  store.setExpanded(new Set([idOf("/w")]));
  assert.ok(store.revision() > r0);
  assert.equal(fired, 1);
  assert.ok(store.has("expanded", idOf("/w")));
  off();
});

test("a rename moves a folder's and its subtree's state to the new identity", () => {
  const { provider, emit } = fakeProvider();
  const store = createExplorerStore(provider, {
    expanded: ["/w", "/w/src"],
    selection: ["/w/src/a.ts"],
    focused: "/w/src/a.ts",
  });
  store.attach();
  emit({
    type: "renamed",
    from: idOf("/w/src"),
    to: idOf("/w/lib"),
    fromPath: "/w/src",
    toPath: "/w/lib",
  });
  assert.ok(store.has("expanded", idOf("/w/lib")), "the renamed folder stays expanded");
  assert.ok(!store.has("expanded", idOf("/w/src")), "its old identity is gone");
  assert.ok(store.has("selection", idOf("/w/lib/a.ts")), "the moved file stays selected");
  assert.equal(store.focused(), idOf("/w/lib/a.ts"), "focus follows the move");
  assert.ok(store.has("expanded", idOf("/w")), "an unaffected folder is untouched");
});

test("a delete drops the node's and its subtree's state", () => {
  const { provider, emit } = fakeProvider();
  const store = createExplorerStore(provider, {
    expanded: ["/w", "/w/src"],
    selection: ["/w/src/a.ts"],
    focused: "/w/src/a.ts",
  });
  store.attach();
  emit({ type: "deleted", id: idOf("/w/src"), path: "/w/src" });
  assert.ok(!store.has("expanded", idOf("/w/src")), "deleted folder un-expanded");
  assert.ok(!store.has("selection", idOf("/w/src/a.ts")), "selection under it dropped");
  assert.equal(store.focused(), null, "focus under it cleared");
  assert.ok(store.has("expanded", idOf("/w")), "the root is untouched");
});

test("reset clears selection and focus but keeps expansion", () => {
  const { provider, emit } = fakeProvider();
  const store = createExplorerStore(provider, {
    expanded: ["/w", "/w/src"],
    selection: ["/w/src/a.ts"],
    focused: "/w/src/a.ts",
  });
  store.attach();
  emit({ type: "reset" });
  assert.equal(store.ids("selection").size, 0, "selection cleared");
  assert.equal(store.focused(), null, "focus cleared");
  assert.equal(store.anchor(), null, "anchor cleared");
  assert.ok(store.has("expanded", idOf("/w/src")), "expansion is preserved");
});

test("reveal expands the ancestor chain, selects and focuses the target", async () => {
  const { provider } = fakeProvider();
  const store = createExplorerStore(provider);
  const shown = await store.reveal("/w/src/a.ts");
  assert.equal(shown, true);
  assert.ok(store.has("expanded", idOf("/w")), "root expanded");
  assert.ok(store.has("expanded", idOf("/w/src")), "intermediate folder expanded");
  assert.ok(store.has("selection", idOf("/w/src/a.ts")), "target selected");
  assert.equal(store.focused(), idOf("/w/src/a.ts"), "target focused");
});
