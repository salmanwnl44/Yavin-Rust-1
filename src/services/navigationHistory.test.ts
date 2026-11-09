import { test } from "node:test";
import assert from "node:assert/strict";
import { createNavigationHistory, type NavLocation } from "./navigationHistory.ts";

const at = (key: string, line = 1): NavLocation => ({
  key,
  range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
});
const keys = (history: ReturnType<typeof createNavigationHistory>) =>
  history.entries().map((entry) => entry.key);

test("an empty history goes nowhere", () => {
  const history = createNavigationHistory();
  assert.equal(history.canGoBack(), false);
  assert.equal(history.canGoForward(), false);
  assert.equal(history.back(), null);
  assert.equal(history.forward(), null);
  assert.equal(history.current(), null);
  assert.equal(history.position(), -1);
});

test("a first navigation seeds the origin so Back returns to it", () => {
  const history = createNavigationHistory();
  history.record(at("b.ts", 10), at("a.ts", 3));
  assert.deepEqual(keys(history), ["a.ts", "b.ts"]);
  assert.equal(history.canGoBack(), true);
  assert.equal(history.canGoForward(), false);
  const back = history.back();
  assert.equal(back?.key, "a.ts");
  assert.equal(back?.range?.startLineNumber, 3);
});

test("back then forward walks the same trail", () => {
  const history = createNavigationHistory();
  history.record(at("b.ts"), at("a.ts"));
  history.record(at("c.ts"), at("b.ts"));
  assert.deepEqual(keys(history), ["a.ts", "b.ts", "c.ts"]);
  assert.equal(history.back()?.key, "b.ts");
  assert.equal(history.back()?.key, "a.ts");
  assert.equal(history.back(), null, "cannot pass the oldest");
  assert.equal(history.forward()?.key, "b.ts");
  assert.equal(history.forward()?.key, "c.ts");
  assert.equal(history.forward(), null, "cannot pass the newest");
});

test("navigating after going back drops the abandoned forward branch", () => {
  const history = createNavigationHistory();
  history.record(at("b.ts"), at("a.ts"));
  history.record(at("c.ts"), at("b.ts"));
  history.back(); // now at b.ts, c.ts is ahead
  history.record(at("d.ts"), at("b.ts"));
  assert.deepEqual(keys(history), ["a.ts", "b.ts", "d.ts"], "c.ts was abandoned");
  assert.equal(history.canGoForward(), false);
  assert.equal(history.back()?.key, "b.ts");
  assert.equal(history.back()?.key, "a.ts");
});

test("a jump to the same line coalesces instead of stacking", () => {
  const history = createNavigationHistory();
  history.record(at("b.ts", 10), at("a.ts", 1));
  // Re-running Go to Definition from b.ts lands on the same spot; `from` is where we are now.
  history.record(at("b.ts", 10), at("b.ts", 10));
  assert.deepEqual(keys(history), ["a.ts", "b.ts"]);
  // The newer, more precise range wins on coalesce.
  history.record({
    key: "b.ts",
    range: { startLineNumber: 10, startColumn: 5, endLineNumber: 10, endColumn: 9 },
  });
  assert.equal(history.current()?.range?.startColumn, 5);
  assert.equal(history.entries().length, 2);
});

test("moving within the current document before jumping updates the return spot", () => {
  const history = createNavigationHistory();
  history.record(at("b.ts", 10), at("a.ts", 1));
  // User scrolled/clicked to b.ts line 80, then jumps to c.ts.
  history.record(at("c.ts", 2), at("b.ts", 80));
  assert.deepEqual(keys(history), ["a.ts", "b.ts", "c.ts"]);
  const back = history.back();
  assert.equal(back?.key, "b.ts");
  assert.equal(back?.range?.startLineNumber, 80, "returns to where the user actually was");
});

test("record without a from only appends the target", () => {
  const history = createNavigationHistory();
  history.record(at("a.ts"));
  history.record(at("b.ts"));
  assert.deepEqual(keys(history), ["a.ts", "b.ts"]);
  assert.equal(history.back()?.key, "a.ts");
});

test("the oldest entries fall off at the limit and the cursor stays valid", () => {
  const history = createNavigationHistory({ limit: 3 });
  history.record(at("a.ts"));
  history.record(at("b.ts"));
  history.record(at("c.ts"));
  history.record(at("d.ts"));
  assert.deepEqual(keys(history), ["b.ts", "c.ts", "d.ts"], "a.ts fell off");
  assert.equal(history.position(), 2);
  assert.equal(history.back()?.key, "c.ts");
});

test("rename follows a document through Save As", () => {
  const history = createNavigationHistory();
  history.record(at("untitled:1", 5), at("a.ts", 2));
  history.record(at("b.ts"), at("untitled:1", 5));
  history.rename("untitled:1", "/work/new.ts");
  assert.deepEqual(keys(history), ["a.ts", "/work/new.ts", "b.ts"]);
  history.back();
  assert.equal(history.current()?.key, "/work/new.ts");
});

test("forget drops a gone document and keeps the cursor on the same place", () => {
  const history = createNavigationHistory();
  history.record(at("b.ts"), at("a.ts"));
  history.record(at("c.ts"), at("b.ts")); // cursor at c.ts (index 2)
  history.forget("a.ts");
  assert.deepEqual(keys(history), ["b.ts", "c.ts"]);
  assert.equal(history.current()?.key, "c.ts", "still on c.ts after an earlier entry left");
  assert.equal(history.back()?.key, "b.ts");
});

test("forgetting the current entry lands the cursor on a neighbour, never out of range", () => {
  const history = createNavigationHistory();
  history.record(at("b.ts"), at("a.ts"));
  history.record(at("c.ts"), at("b.ts")); // index 2 -> c.ts
  history.forget("c.ts");
  assert.deepEqual(keys(history), ["a.ts", "b.ts"]);
  assert.equal(history.position(), 1);
  assert.equal(history.current()?.key, "b.ts");
});

test("forgetting every entry empties the history", () => {
  const history = createNavigationHistory();
  history.record(at("b.ts"), at("a.ts"));
  history.forget("a.ts");
  history.forget("b.ts");
  assert.deepEqual(keys(history), []);
  assert.equal(history.position(), -1);
  assert.equal(history.canGoBack(), false);
  assert.equal(history.current(), null);
});

test("clear empties the history for a change of workspace", () => {
  const history = createNavigationHistory();
  history.record(at("b.ts"), at("a.ts"));
  history.clear();
  assert.deepEqual(keys(history), []);
  assert.equal(history.canGoBack(), false);
  assert.equal(history.canGoForward(), false);
  assert.equal(history.current(), null);
});

test("subscribers hear real changes and nothing else", () => {
  const history = createNavigationHistory();
  let count = 0;
  const off = history.subscribe(() => count++);
  history.record(at("b.ts"), at("a.ts")); // a change
  const after = count;
  assert.ok(after >= 1);
  history.forward(); // no-op: nothing ahead
  assert.equal(count, after, "a no-op forward notifies no one");
  history.back(); // a change
  assert.equal(count, after + 1);
  off();
  history.record(at("c.ts"));
  assert.equal(count, after + 1, "unsubscribed hears nothing more");
});
