import assert from "node:assert/strict";
import test from "node:test";
import { parseStashList } from "./stash.ts";

test("parseStashList reads the auto-generated WIP message and its branch", () => {
  const entries = parseStashList("stash@{0}: WIP on main: 1a2b3c4 fix the thing\n");
  assert.deepEqual(entries, [{ index: 0, branch: "main", message: "1a2b3c4 fix the thing" }]);
});

test("parseStashList reads a custom message from `git stash push -m`", () => {
  const entries = parseStashList("stash@{0}: On feature/x: before the risky refactor\n");
  assert.deepEqual(entries, [
    { index: 0, branch: "feature/x", message: "before the risky refactor" },
  ]);
});

test("parseStashList keeps every entry in order, oldest last", () => {
  const output = [
    "stash@{0}: WIP on main: 1a2b3c4 newest",
    "stash@{1}: WIP on main: 9f8e7d6 oldest",
    "",
  ].join("\n");
  const entries = parseStashList(output);
  assert.deepEqual(
    entries.map((e) => e.index),
    [0, 1],
  );
  assert.equal(entries[1].message, "9f8e7d6 oldest");
});

test("parseStashList returns nothing for an empty stash", () => {
  assert.deepEqual(parseStashList(""), []);
});
