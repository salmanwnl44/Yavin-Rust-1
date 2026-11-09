import assert from "node:assert/strict";
import test from "node:test";
import { LineIndex } from "./positions.ts";
import {
  applySemanticDelta,
  isValidTokenData,
  SemanticDeltaError,
  toUtf16Tokens,
} from "./semanticTokens.ts";

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

test("isValidTokenData accepts only whole, non-negative, integer token arrays (WS16)", () => {
  assert.equal(isValidTokenData([]), true, "empty is valid (no tokens)");
  assert.equal(isValidTokenData([0, 0, 3, 1, 0]), true, "one well-formed token");
  assert.equal(isValidTokenData([0, 0, 3, 1, 0, 1, 0, 2, 3, 0]), true, "two tokens");
  assert.equal(isValidTokenData([0, 0, 3, 1]), false, "ragged length (not a multiple of 5)");
  assert.equal(isValidTokenData([0, 0, -3, 1, 0]), false, "a negative value");
  assert.equal(isValidTokenData([0, 0, 1.5, 1, 0]), false, "a fractional value");
  assert.equal(isValidTokenData([0, 0, Number.NaN, 1, 0]), false, "NaN");
  assert.equal(isValidTokenData([0, 0, 0x1_0000_0000, 1, 0]), false, "larger than a uint32");
  assert.equal(isValidTokenData("not an array"), false);
  assert.equal(isValidTokenData(null), false);
});

test("applySemanticDelta rejects inconsistent deltas so the caller can recover (WS16)", () => {
  const previous = [0, 0, 3, 1, 0, 1, 0, 2, 3, 0]; // 2 tokens, 10 values
  const bad = (edits: Parameters<typeof applySemanticDelta>[1]) =>
    assert.throws(() => applySemanticDelta(previous, edits), SemanticDeltaError);
  bad([{ start: 60, deleteCount: 0, data: [0, 0, 1, 0, 0] }]); // start past the end
  bad([{ start: 5, deleteCount: 10 }]); // deletes past the end
  bad([{ start: -1, deleteCount: 0, data: [] }]); // negative start
  bad([{ start: 0, deleteCount: -1 }]); // negative deleteCount
  bad([
    { start: 0, deleteCount: 6 },
    { start: 5, deleteCount: 0, data: [] },
  ]); // overlapping edits (second starts before the first's end)
  bad([{ start: 0, deleteCount: 0, data: [0, 0, -1, 0, 0] }]); // inserts an invalid value
  bad([{ start: 0, deleteCount: 1 }]); // result length 9 — not a whole number of tokens
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
