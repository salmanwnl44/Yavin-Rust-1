import assert from "node:assert/strict";
import test from "node:test";
import { matchesShortcut } from "./commands.ts";

test("shortcuts distinguish modifier combinations", () => {
  const key = { key: "P", ctrlKey: true, metaKey: false, altKey: false, shiftKey: true };
  assert.equal(matchesShortcut(key, "Mod+Shift+p"), true);
  assert.equal(matchesShortcut(key, "Mod+p"), false);
  assert.equal(matchesShortcut({ ...key, ctrlKey: false, metaKey: true }, "Mod+Shift+p"), true);
});

test("a punctuation shortcut matches under Shift, when the key reports the shifted character", () => {
  // Ctrl+Shift+` on a US layout: the key is "~", the physical key is Backquote.
  const event = {
    key: "~",
    code: "Backquote",
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: true,
  };
  assert.equal(matchesShortcut(event, "Mod+Shift+`"), true);
  // Typing the character alone, or another combination, does not.
  assert.equal(matchesShortcut({ ...event, ctrlKey: false }, "Mod+Shift+`"), false);
  assert.equal(matchesShortcut({ ...event, shiftKey: false }, "Mod+Shift+`"), false);
  assert.equal(matchesShortcut({ ...event, code: "Digit1", key: "!" }, "Mod+Shift+`"), false);
});
