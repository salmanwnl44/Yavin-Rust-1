import assert from "node:assert/strict";
import test from "node:test";
import { LineIndex } from "./positions.ts";
import { applySemanticDelta, toUtf16Tokens } from "./semanticTokens.ts";

test("a delta edits the previous tokens where it says", () => {
  const previous = [0, 0, 3, 1, 0, 0, 4, 5, 2, 0, 1, 0, 2, 3, 0];
  // Replace the second token, drop the third, and add one at the end.
  const next = applySemanticDelta(previous, [
    { start: 10, deleteCount: 5 },
    { start: 5, deleteCount: 5, data: [0, 4, 6, 2, 1] },
    { start: 15, deleteCount: 0, data: [2, 0, 1, 0, 0] },
  ]);
  assert.deepEqual(next, [0, 0, 3, 1, 0, 0, 4, 6, 2, 1, 2, 0, 1, 0, 0]);
  assert.deepEqual(applySemanticDelta(previous, []), previous);
});

test("UTF-8 and UTF-32 columns become the editor's UTF-16 columns", () => {
  // "é" is 2 UTF-8 bytes; "😀" is 4 bytes, 1 code point, 2 UTF-16 units.
  const text = "é x😀 yy\nzz";
  const index = new LineIndex(text);
  // Tokens: `x` at UTF-8 3, `yy` at UTF-8 9 (after "😀 "), `zz` on line 1.
  const utf8 = [0, 3, 1, 1, 0, 0, 6, 2, 2, 0, 1, 0, 2, 3, 0];
  assert.deepEqual(
    toUtf16Tokens(utf8, index, "utf-8"),
    [0, 2, 1, 1, 0, 0, 4, 2, 2, 0, 1, 0, 2, 3, 0],
  );
  const utf32 = [0, 2, 1, 1, 0, 0, 3, 2, 2, 0, 1, 0, 2, 3, 0];
  assert.deepEqual(
    toUtf16Tokens(utf32, index, "utf-32"),
    [0, 2, 1, 1, 0, 0, 4, 2, 2, 0, 1, 0, 2, 3, 0],
  );
  // A token over the emoji keeps both of its UTF-16 units.
  assert.deepEqual(toUtf16Tokens([0, 4, 4, 0, 0], index, "utf-8"), [0, 3, 2, 0, 0]);
  assert.deepEqual(toUtf16Tokens(utf8, index, "utf-16"), utf8);
});
