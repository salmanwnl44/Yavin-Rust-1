/**
 * Type hierarchy model (WS15): the thin wrapper that maps `typeHierarchy/supertypes` and
 * `subtypes` onto the shared, generic hierarchy model. Verifies the two directions, their labels,
 * lazy loading, cycle-safe expansion, direction reset and null (no-children) results. The tree
 * mechanics themselves (stale protection, snapshot caching) are covered by the shared model through
 * the call-hierarchy tests; this asserts the type-specific mapping. Deterministic fakes; no LSP.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createTypeHierarchy, type TypeDirection } from "./typeHierarchy.ts";
import type { TypeHierarchyItem } from "./protocol.ts";

// A distinct selectionRange position per name, so two items are the "same type" only when their
// name matches — which is what makes the cycle test meaningful.
const item = (name: string, uri = "file:///a.ts"): TypeHierarchyItem => {
  const line = name.charCodeAt(0);
  return {
    name,
    kind: 5,
    uri,
    range: { start: { line, character: 0 }, end: { line, character: 10 } },
    selectionRange: { start: { line, character: 0 }, end: { line, character: name.length } },
  };
};

const names = (h: ReturnType<typeof createTypeHierarchy>) =>
  h.getRows().map((r) => r.node.item.name);

function hierarchy(
  root: TypeHierarchyItem,
  edges: { supertypes?: Record<string, string[]>; subtypes?: Record<string, string[]> },
  direction: TypeDirection = "supertypes",
) {
  return createTypeHierarchy({
    direction,
    root,
    supertypes: async (it) => (edges.supertypes?.[it.name] ?? []).map((n) => item(n)),
    subtypes: async (it) => (edges.subtypes?.[it.name] ?? []).map((n) => item(n)),
  });
}

test("the model exposes the two type directions, supertypes first", () => {
  const h = hierarchy(item("Animal"), {});
  assert.deepEqual(h.directions(), ["supertypes", "subtypes"]);
  assert.equal(h.direction(), "supertypes");
  h.dispose();
});

test("supertypes load lazily on expand (Go to Supertypes)", async () => {
  const h = hierarchy(item("Dog"), { supertypes: { Dog: ["Animal", "Pet"] } });
  assert.deepEqual(names(h), ["Dog"], "only the root before expanding");
  const root = h.getRows()[0]!.node;
  assert.equal(root.children, null, "not loaded yet");
  await h.toggle(root);
  assert.deepEqual(names(h), ["Dog", "Animal", "Pet"], "supertypes loaded and shown");
  await h.toggle(root); // collapse hides without re-fetching
  assert.deepEqual(names(h), ["Dog"]);
  h.dispose();
});

test("subtypes direction lists subtypes (Go to Subtypes)", async () => {
  const h = hierarchy(item("Animal"), { subtypes: { Animal: ["Dog", "Cat"] } }, "subtypes");
  await h.toggle(h.getRows()[0]!.node);
  assert.deepEqual(names(h), ["Animal", "Dog", "Cat"]);
  h.dispose();
});

test("an inheritance cycle is detected and not expanded again (Animal → LivingThing → Animal)", async () => {
  const h = hierarchy(item("Animal"), {
    supertypes: { Animal: ["LivingThing"], LivingThing: ["Animal"] },
  });
  await h.toggle(h.getRows()[0]!.node); // Animal → [LivingThing]
  const living = h.getRows().find((r) => r.node.item.name === "LivingThing")!.node;
  await h.toggle(living); // LivingThing → [Animal'] (a cycle)
  const animalAgain = h
    .getRows()
    .find((r) => r.node.item.name === "Animal" && r.node.depth === 2)!.node;
  assert.equal(animalAgain.cyclic, true, "the repeat of Animal is marked cyclic");
  assert.deepEqual(animalAgain.children, [], "a cyclic node has nothing further to load");
  h.dispose();
});

test("switching direction rebuilds from the root", async () => {
  const h = hierarchy(item("Animal"), {
    supertypes: { Animal: ["LivingThing"] },
    subtypes: { Animal: ["Dog"] },
  });
  await h.toggle(h.getRows()[0]!.node);
  assert.deepEqual(names(h), ["Animal", "LivingThing"]);
  h.setDirection("subtypes");
  assert.deepEqual(names(h), ["Animal"], "reset to the root");
  await h.toggle(h.getRows()[0]!.node);
  assert.deepEqual(names(h), ["Animal", "Dog"]);
  h.dispose();
});

test("a null (no supertypes) result is treated as empty, not an error", async () => {
  const h = createTypeHierarchy({
    direction: "supertypes",
    root: item("Object"),
    supertypes: async () => null,
    subtypes: async () => null,
  });
  await h.toggle(h.getRows()[0]!.node);
  assert.deepEqual(h.getRows()[0]!.node.children, [], "no supertypes → empty children");
  assert.equal(h.getRows()[0]!.node.error, null);
  h.dispose();
});
