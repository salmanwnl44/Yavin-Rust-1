import assert from "node:assert/strict";
import test from "node:test";
import { matchesShortcut } from "./commands.ts";

test("shortcuts distinguish modifier combinations", () => {
  const key = { key: "P", ctrlKey: true, metaKey: false, altKey: false, shiftKey: true };
  assert.equal(matchesShortcut(key, "Mod+Shift+p"), true);
  assert.equal(matchesShortcut(key, "Mod+p"), false);
  assert.equal(matchesShortcut({ ...key, ctrlKey: false, metaKey: true }, "Mod+Shift+p"), true);
});
