import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { PANEL_VIEWS, readActiveView, saveActiveView, stepView } from "./views.ts";

/** The module reads `localStorage` lazily, so a stub installed here is picked up. */
function withStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
  return store;
}

beforeEach(() => withStorage());

test("the views are the five VS Code shows, in that order", () => {
  assert.deepEqual(
    PANEL_VIEWS.map((view) => view.id),
    ["problems", "output", "debug", "terminal", "ports"],
  );
});

test("only the terminal stays mounted when another view is showing", () => {
  // Unmounting the terminal would kill the user's running shells; every other view is cheap
  // to rebuild and should not hold timers or listeners while unseen.
  assert.deepEqual(
    PANEL_VIEWS.filter((view) => view.keepMounted).map((view) => view.id),
    ["terminal"],
  );
});

test("the terminal is the default view until a choice is remembered", () => {
  assert.equal(readActiveView(), "terminal");
});

test("the chosen view is remembered", () => {
  saveActiveView("problems");
  assert.equal(readActiveView(), "problems");
});

test("a stored value that is no longer a view falls back instead of showing nothing", () => {
  // A renamed or removed view must not leave the panel blank on the next launch.
  withStorage({ "yavin.panel.view": "ai" });
  assert.equal(readActiveView(), "terminal");
});

test("storage being unavailable is not fatal", () => {
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  };
  assert.equal(readActiveView(), "terminal");
  assert.doesNotThrow(() => saveActiveView("ports"));
});

test("next and previous step through every view and wrap around", () => {
  assert.equal(stepView("problems", 1), "output");
  assert.equal(stepView("ports", 1), "problems", "wraps forward");
  assert.equal(stepView("problems", -1), "ports", "wraps backward");
  assert.equal(stepView("terminal", -1), "debug");

  // Stepping forward through the whole list returns to where it started, so no view is
  // unreachable by keyboard.
  let id = PANEL_VIEWS[0].id;
  const seen = new Set([id]);
  for (let i = 0; i < PANEL_VIEWS.length - 1; i++) {
    id = stepView(id, 1);
    seen.add(id);
  }
  assert.equal(seen.size, PANEL_VIEWS.length);
  assert.equal(stepView(id, 1), PANEL_VIEWS[0].id);
});
