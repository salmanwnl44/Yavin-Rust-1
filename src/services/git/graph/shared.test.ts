import assert from "node:assert/strict";
import test from "node:test";
import { acquireLoader, releaseLoader, resetLoader, dropLoader } from "./shared.ts";
import type { GraphLoader } from "./incremental.ts";

/** A GraphLoader stand-in that records dispose/reset calls. */
function fakeLoader() {
  const calls = { dispose: 0, reset: 0 };
  const loader = {
    dispose: () => calls.dispose++,
    reset: () => calls.reset++,
  } as unknown as GraphLoader;
  return { loader, calls };
}

// Each test uses a unique key, because the loader table is module-global (no reset seam).

test("a key is built once and shared (ref-counted) on re-acquire", () => {
  const f = fakeLoader();
  let built = 0;
  const first = acquireLoader("k-share", () => {
    built++;
    return f.loader;
  });
  const second = acquireLoader("k-share", () => {
    built++;
    return fakeLoader().loader;
  });
  assert.equal(built, 1, "the second acquire reuses, not rebuilds");
  assert.equal(first, second, "both callers get the same loader");
  // cleanup
  releaseLoader("k-share");
  releaseLoader("k-share");
});

test("a loader is disposed only when the last holder releases", () => {
  const f = fakeLoader();
  acquireLoader("k-ref", () => f.loader);
  acquireLoader("k-ref", () => fakeLoader().loader); // refCount 2
  releaseLoader("k-ref");
  assert.equal(f.calls.dispose, 0, "still held by one view");
  releaseLoader("k-ref");
  assert.equal(f.calls.dispose, 1, "disposed once the last holder leaves");
});

test("releasing a key that was never acquired is a harmless no-op", () => {
  assert.doesNotThrow(() => releaseLoader("k-never"));
});

test("releasing the WRONG key leaves the real loader alive (the documented leak-avoidance)", () => {
  const f = fakeLoader();
  let built = 0;
  acquireLoader("k-wrongkey", () => {
    built++;
    return f.loader;
  });
  releaseLoader("k-wrongkey-typo"); // a mismatched key must not touch the held loader
  assert.equal(f.calls.dispose, 0, "the real loader was not disposed");
  const again = acquireLoader("k-wrongkey", () => {
    built++;
    return fakeLoader().loader;
  });
  assert.equal(built, 1, "the loader is still in the table, not rebuilt");
  assert.equal(again, f.loader);
  releaseLoader("k-wrongkey");
  releaseLoader("k-wrongkey");
  assert.equal(f.calls.dispose, 1);
});

test("dropLoader disposes regardless of ref count and forces a fresh build next time", () => {
  const f1 = fakeLoader();
  acquireLoader("k-drop", () => f1.loader);
  acquireLoader("k-drop", () => fakeLoader().loader); // refCount 2
  dropLoader("k-drop");
  assert.equal(f1.calls.dispose, 1, "dropped and disposed despite being held");
  const f2 = fakeLoader();
  let built = 0;
  const fresh = acquireLoader("k-drop", () => {
    built++;
    return f2.loader;
  });
  assert.equal(built, 1, "a fresh loader is built after a drop");
  assert.equal(fresh, f2.loader);
  releaseLoader("k-drop");
});

test("resetLoader resets a live loader and is a no-op when absent", () => {
  const f = fakeLoader();
  acquireLoader("k-reset", () => f.loader);
  resetLoader("k-reset");
  assert.equal(f.calls.reset, 1);
  assert.doesNotThrow(() => resetLoader("k-reset-absent"));
  assert.equal(f.calls.reset, 1, "an absent key resets nothing");
  releaseLoader("k-reset");
});
