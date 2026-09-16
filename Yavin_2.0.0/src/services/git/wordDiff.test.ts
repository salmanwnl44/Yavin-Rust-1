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
