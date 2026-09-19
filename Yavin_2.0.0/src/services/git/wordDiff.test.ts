import assert from "node:assert/strict";
import test from "node:test";
import { diffWords } from "./wordDiff.ts";

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
