import test from "node:test";
import assert from "node:assert/strict";
import {
  duplicateSelection,
  selectLine,
  replaceSelection,
  recordEdit,
  stepHistory,
} from "./editor.ts";
import type { TextHistory } from "./editor.ts";
import { matchesShortcut } from "./commands.ts";

test("line selection and duplication handle final lines and selected text", () => {
  assert.deepEqual(selectLine({ text: "\nnext", start: 0, end: 0 }), {
    text: "\nnext",
    start: 0,
    end: 1,
  });
  assert.deepEqual(selectLine({ text: "one\ntwo", start: 0, end: 4 }), {
    text: "one\ntwo",
    start: 0,
    end: 4,
  });
  assert.deepEqual(selectLine({ text: "one\ntwo", start: 5, end: 5 }), {
    text: "one\ntwo",
    start: 4,
    end: 7,
  });
  assert.equal(duplicateSelection({ text: "one\ntwo", start: 5, end: 5 }).text, "one\ntwo\ntwo");
  assert.equal(duplicateSelection({ text: "one\ntwo", start: 0, end: 3 }).text, "oneone\ntwo");
  assert.equal(replaceSelection({ text: "abcd", start: 1, end: 3 }, "$&").text, "a$&d");
});
test("undo/redo restores snapshots and a new edit invalidates redo", () => {
  const history: TextHistory = { past: [], future: [] };
  const old = { text: "old", start: 1, end: 1 };
  const next = { text: "new", start: 3, end: 3 };
  recordEdit(history, old);
  assert.deepEqual(stepHistory(history, next, "undo"), old);
  assert.deepEqual(stepHistory(history, old, "redo"), next);
  stepHistory(history, next, "undo");
  recordEdit(history, old);
  assert.equal(stepHistory(history, next, "redo"), undefined);
});
test("history limits retained snapshots", () => {
  const history: TextHistory = { past: [], future: [] };
  for (let index = 0; index < 120; index++)
    recordEdit(history, { text: String(index), start: 0, end: 0 });
  assert.equal(history.past.length, 100);
});
test("shortcuts distinguish modifier combinations", () => {
  const key = { key: "P", ctrlKey: true, metaKey: false, altKey: false, shiftKey: true };
  assert.equal(matchesShortcut(key, "Mod+Shift+p"), true);
  assert.equal(matchesShortcut(key, "Mod+p"), false);
  assert.equal(matchesShortcut({ ...key, ctrlKey: false, metaKey: true }, "Mod+Shift+p"), true);
});
