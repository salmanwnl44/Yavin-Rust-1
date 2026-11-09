/**
 * The dedicated conflict editor's view-model against **real Git** (WS10): wire a session to a real
 * conflicted repository (sides from the index stages, Result from the working tree, apply = write,
 * stage = the index-verifying `resolveFile`), resolve it, `complete()`, and confirm the **index has
 * no unmerged stages** afterward.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createConflictSession } from "./conflictSession.ts";
import { realRepo } from "./testing/realGit.ts";

const settle = () => new Promise((r) => setTimeout(r, 0));

test("a session resolves a real both-modified conflict and leaves the index clean (real git)", async () => {
  const r = realRepo();
  try {
    const file = join(r.root, "a.txt");
    writeFileSync(file, "line 1\nshared\nline 3\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "base");
    r.git("switch", "-qc", "feature");
    writeFileSync(file, "line 1\ntheirs\nline 3\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "theirs");
    r.git("switch", "-q", "main");
    writeFileSync(file, "line 1\nours\nline 3\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "ours");
    try {
      r.git("merge", "feature");
    } catch {
      /* expected conflict */
    }

    const session = createConflictSession({
      path: file,
      code: "UU",
      loadResult: async () => readFileSync(file, "utf8"),
      liveResult: async () => readFileSync(file, "utf8"),
      loadSide: async (side) =>
        side === "base"
          ? r.repository.conflictBase(file)
          : r.repository.conflictSide(file, side === "current" ? "ours" : "theirs"),
      apply: async (text) => writeFileSync(file, text),
      stageResolved: async () => r.repository.resolveFile(file),
    });
    await settle();

    const state = session.getState();
    assert.equal(state.classification?.type, "both-modified");
    assert.equal(state.sides.base, "line 1\nshared\nline 3\n");
    assert.equal(state.sides.current, "line 1\nours\nline 3\n");
    assert.equal(state.sides.incoming, "line 1\ntheirs\nline 3\n");
    assert.deepEqual(await r.repository.unmergedStages(file), [1, 2, 3]);

    session.choose(0, "both"); // current then incoming
    assert.equal(session.getState().ready, true);
    const ok = await session.complete();
    assert.equal(ok, true);
    assert.equal(session.getState().status, "done");

    // The working tree holds the resolved content and the index is no longer conflicted.
    assert.equal(readFileSync(file, "utf8"), "line 1\nours\ntheirs\nline 3\n");
    assert.deepEqual(await r.repository.unmergedStages(file), []);
    session.dispose();
  } finally {
    r.dispose();
  }
});
