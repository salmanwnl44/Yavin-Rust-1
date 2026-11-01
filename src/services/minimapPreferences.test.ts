import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MINIMAP,
  loadMinimapPreferences,
  saveMinimapPreferences,
} from "./minimapPreferences.ts";

const memory = () => {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
};

test("minimap choices are remembered", () => {
  const store = memory();
  assert.deepEqual(loadMinimapPreferences(store), DEFAULT_MINIMAP);
  const chosen = {
    enabled: false,
    renderCharacters: false,
    size: "fit",
    showSlider: "always",
  } as const;
  saveMinimapPreferences(chosen, store);
  assert.deepEqual(loadMinimapPreferences(store), chosen);
});

test("whatever storage holds, the minimap gets valid preferences", () => {
  const store = memory();
  store.setItem("yavin.editor.minimap", "not json");
  assert.deepEqual(loadMinimapPreferences(store), DEFAULT_MINIMAP);
  // Field by field: a valid one is kept, an invalid one falls back.
  store.setItem("yavin.editor.minimap", JSON.stringify({ enabled: false, size: "huge" }));
  assert.deepEqual(loadMinimapPreferences(store), { ...DEFAULT_MINIMAP, enabled: false });
  // No storage at all, or storage that throws: defaults, and saving does not throw.
  assert.deepEqual(loadMinimapPreferences(null), DEFAULT_MINIMAP);
  const broken = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("full");
    },
  };
  assert.deepEqual(loadMinimapPreferences(broken), DEFAULT_MINIMAP);
  assert.doesNotThrow(() => saveMinimapPreferences(DEFAULT_MINIMAP, broken));
});
