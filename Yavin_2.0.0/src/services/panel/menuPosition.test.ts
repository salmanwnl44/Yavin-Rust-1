import assert from "node:assert/strict";
import test from "node:test";
import { clampToViewport } from "./menuPosition.ts";

/**
 * The panel sits at the bottom of the window, so a context menu drawn at the pointer runs
 * off the bottom edge and its last items become unclickable -- which is exactly what happened
 * when the menu gained one more entry.
 */

const viewport = { width: 1000, height: 800 };

test("a menu with room below is drawn where the pointer is", () => {
  assert.deepEqual(clampToViewport({ x: 100, y: 100 }, 8, viewport), { left: 100, top: 100 });
});

test("a menu opened near the bottom is pulled up so its last item stays on screen", () => {
  const { top } = clampToViewport({ x: 100, y: 780 }, 9, viewport);
  assert.ok(top < 780, "must move up");
  assert.ok(top + 9 * 24 <= viewport.height, "the whole menu fits");
});

test("a menu opened near the right edge is pulled left", () => {
  const { left } = clampToViewport({ x: 990, y: 100 }, 4, viewport);
  assert.ok(left + 170 <= viewport.width, "the whole menu fits");
});

test("a menu taller than the window still starts on screen rather than above it", () => {
  const { top } = clampToViewport({ x: 10, y: 700 }, 100, { width: 400, height: 300 });
  assert.ok(top >= 0, `top must not be negative, got ${top}`);
});
