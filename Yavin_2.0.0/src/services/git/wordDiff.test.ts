import assert from "node:assert/strict";
import test from "node:test";
import { diffWords, wordDiffCells, WORD_DIFF_MAX_CELLS } from "./wordDiff.ts";

function text(segments: { text: string }[]): string {
  return segments.map((segment) => segment.text).join("");
}

test("diffWords marks only the changed word, keeping the rest as context", () => {
  const { old, new: next } = diffWords("const two = 2;", "const TWO = 2;");
  assert.equal(text(old), "const two = 2;");
  assert.equal(text(next), "const TWO = 2;");
  assert.deepEqual(
    old.filter((segment) => segment.type !== "same").map((segment) => segment.text),
    ["two"],
  );
  assert.deepEqual(
    next.filter((segment) => segment.type !== "same").map((segment) => segment.text),
    ["TWO"],
  );
});

test("diffWords reports a wholly different line as entirely changed", () => {
  const { old, new: next } = diffWords("alpha", "zzz");
  assert.ok(old.every((segment) => segment.type === "del"));
  assert.ok(next.every((segment) => segment.type === "add"));
});

test("diffWords treats two identical lines as entirely unchanged", () => {
  const { old, new: next } = diffWords("same line", "same line");
  assert.ok(old.every((segment) => segment.type === "same"));
  assert.ok(next.every((segment) => segment.type === "same"));
});

test("diffWords handles an appended suffix without touching the shared prefix", () => {
  const { old, new: next } = diffWords("foo", "foo bar");
  assert.deepEqual(old, [{ type: "same", text: "foo" }]);
  assert.equal(text(next), "foo bar");
  assert.equal(next.find((segment) => segment.type === "add")?.text, " ");
});

test("diffWords treats non-ASCII scripts as whole word runs, not one segment per character", () => {
  const { old, new: next } = diffWords("café 日本語 test", "café 中文 test");
  // Word-granularity (the fix): each script run is one changed token, not
  // several single-character segments the old ASCII-only \w regex would
  // have produced for non-Latin text.
  assert.deepEqual(
    old.filter((s) => s.type !== "same").map((s) => s.text),
    ["日本語"],
  );
  assert.deepEqual(
    next.filter((s) => s.type !== "same").map((s) => s.text),
    ["中文"],
  );
  assert.equal(text(old), "café 日本語 test");
  assert.equal(text(next), "café 中文 test");
});

test("a pair too large for the LCS budget is reported as a wholly changed line, never truncated", () => {
  const long = "x ".repeat(2000);
  const changed = long.replace("x x", "y y");
  const started = Date.now();
  const { old, new: next } = diffWords(long, changed);
  assert.ok(Date.now() - started < 200, "over-budget pairs must not run the quadratic LCS");
  assert.equal(text(old), long);
  assert.equal(text(next), changed);
  assert.ok(old.every((s) => s.type === "del") && next.every((s) => s.type === "add"));
});

test("a pair inside the budget still gets fine-grained segments", () => {
  const { old } = diffWords("a b c", "a X c");
  assert.ok(old.some((s) => s.type === "same"));
  assert.ok(wordDiffCells("a b c", "a X c") < WORD_DIFF_MAX_CELLS);
});
