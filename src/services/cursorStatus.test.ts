import assert from "node:assert/strict";
import test from "node:test";
import { createCursorStatus, describeCursor } from "./cursorStatus.ts";

const at = { line: 3, column: 7, selected: 0, cursors: 1, insertSpaces: true, tabSize: 2 };

test("the status bar is told only when what it shows changes", () => {
  const store = createCursorStatus();
  let told = 0;
  store.subscribe(() => told++);
  store.set(at);
  store.set({ ...at });
  assert.equal(told, 1);
  store.set({ ...at, column: 8 });
  store.set(null);
  store.set(null);
  assert.equal(told, 3);
  assert.equal(store.get(), null);
});

test("the cursor is described as VS Code describes it", () => {
  assert.deepEqual(describeCursor(at), {
    position: "Ln 3, Col 7",
    selection: "",
    indentation: "Spaces: 2",
  });
  assert.equal(describeCursor({ ...at, selected: 5 }).selection, "(5 selected)");
  assert.equal(
    describeCursor({ ...at, cursors: 3, selected: 6 }).selection,
    "3 selections (6 characters selected)",
  );
  assert.equal(describeCursor({ ...at, cursors: 2 }).selection, "2 selections");
  assert.equal(
    describeCursor({ ...at, insertSpaces: false, tabSize: 4 }).indentation,
    "Tab Size: 4",
  );
});
