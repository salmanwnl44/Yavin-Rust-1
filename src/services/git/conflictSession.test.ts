/**
 * The dedicated conflict editor's view-model (WS10): loading sides, per-region choice (revisable),
 * progress/readiness, unavailable-side gating, the stale-resolution refusal, and the complete flow
 * (write → stage). Deterministic fakes; the real index transition is covered in the realgit test.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createConflictSession, type ConflictSessionDeps } from "./conflictSession.ts";

const settle = () => new Promise((r) => setTimeout(r, 0));
const RESULT = "a\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> f\nb\n";

function deps(over: Partial<ConflictSessionDeps> = {}): ConflictSessionDeps {
  return {
    path: "/w/a.txt",
    code: "UU",
    loadResult: async () => RESULT,
    loadSide: async (side) =>
      ({ current: "a\nours\nb\n", incoming: "a\ntheirs\nb\n", base: "a\nshared\nb\n" })[side]!,
    liveResult: async () => RESULT,
    apply: async () => {},
    stageResolved: async () => {},
    ...over,
  };
}

test("loads the three sides and the regions; starts unresolved", async () => {
  const s = createConflictSession(deps());
  await settle();
  const state = s.getState();
  assert.equal(state.status, "ready");
  assert.equal(state.classification?.type, "both-modified");
  assert.deepEqual(
    [state.sides.current, state.sides.incoming, state.sides.base],
    ["a\nours\nb\n", "a\ntheirs\nb\n", "a\nshared\nb\n"],
  );
  assert.equal(state.regions.length, 1);
  assert.deepEqual(state.progress, { total: 1, resolved: 0, unresolved: 1 });
  assert.equal(state.ready, false);
  s.dispose();
});

test("choosing a side resolves a region; choices are revisable", async () => {
  const s = createConflictSession(deps());
  await settle();
  s.choose(0, "incoming");
  assert.equal(s.getState().resultText, "a\ntheirs\nb\n");
  assert.equal(s.getState().ready, true);
  // Revise the decision.
  s.choose(0, "both");
  assert.equal(s.getState().resultText, "a\nours\ntheirs\nb\n");
  s.dispose();
});

test("canAccept gates actions by which sides exist", async () => {
  const uu = createConflictSession(deps());
  await settle();
  assert.equal(uu.canAccept("base"), true, "both-modified has a base");
  uu.dispose();
  // Added-by-us (AU): only the current side exists.
  const au = createConflictSession(
    deps({
      code: "AU",
      loadSide: async (side) =>
        side === "current" ? "ours\n" : Promise.reject(new Error("no side")),
    }),
  );
  await settle();
  assert.equal(au.canAccept("current"), true);
  assert.equal(au.canAccept("incoming"), false);
  assert.equal(au.canAccept("base"), false);
  assert.equal(au.canAccept("both"), false);
  au.dispose();
});

test("complete refuses while a region is unresolved, and does not write", async () => {
  let applied = false;
  const s = createConflictSession(deps({ apply: async () => void (applied = true) }));
  await settle();
  const ok = await s.complete();
  assert.equal(ok, false);
  assert.equal(applied, false, "nothing written while unresolved");
  assert.match(s.getState().error ?? "", /Resolve every/);
  s.dispose();
});

test("complete writes the resolved Result then stages it, in order", async () => {
  const calls: string[] = [];
  let written = "";
  const s = createConflictSession(
    deps({
      apply: async (text) => {
        written = text;
        calls.push("apply");
      },
      stageResolved: async () => void calls.push("stage"),
    }),
  );
  await settle();
  s.choose(0, "current");
  const ok = await s.complete();
  assert.equal(ok, true);
  assert.equal(written, "a\nours\nb\n", "the resolved text is written");
  assert.deepEqual(calls, ["apply", "stage"], "write before stage");
  assert.equal(s.getState().status, "done");
  s.dispose();
});

test("a stale file (changed since it opened) refuses the resolution and writes nothing", async () => {
  let applied = false;
  const s = createConflictSession(
    deps({
      liveResult: async () => RESULT + "edited\n", // changed under us
      apply: async () => void (applied = true),
    }),
  );
  await settle();
  s.choose(0, "incoming");
  const ok = await s.complete();
  assert.equal(ok, false);
  assert.equal(applied, false);
  assert.match(s.getState().error ?? "", /changed since/);
  s.dispose();
});

test("a failed stage surfaces the error and does not claim success", async () => {
  const s = createConflictSession(
    deps({ stageResolved: async () => Promise.reject(new Error("Still conflicted: stage 3")) }),
  );
  await settle();
  s.choose(0, "both");
  const ok = await s.complete();
  assert.equal(ok, false);
  assert.match(s.getState().error ?? "", /Still conflicted/);
  assert.notEqual(s.getState().status, "done");
  s.dispose();
});
