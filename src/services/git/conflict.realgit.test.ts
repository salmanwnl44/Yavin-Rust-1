/**
 * Merge-conflict resolution against **real Git** (WS10): create a genuine content conflict, read
 * its three index stages, parse the working-tree markers, resolve, stage, and **verify the index no
 * longer holds unmerged stages**. This is the critical-correctness boundary — an in-memory parser
 * test cannot prove the index transition, so it is exercised here against a throwaway repository.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyResolutions, classifyConflict, parseConflicts } from "./conflict.ts";
import { parseGitEntries } from "./parsers/status.ts";
import { realRepo } from "./testing/realGit.ts";

/** Builds a both-modified conflict on `a.txt` (line 2 changed on each side) and returns its path. */
function conflictedRepo() {
  const r = realRepo();
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
    r.git("merge", "feature"); // exits non-zero on the conflict
  } catch {
    /* expected: a merge conflict */
  }
  return { r, file };
}

test("both-modified: stages read, markers parsed, resolved, staged, and the index verified clean", async () => {
  const { r, file } = conflictedRepo();
  try {
    // Git's own status says it is unmerged (UU); the model classifies it from that, not the text.
    const entry = parseGitEntries(r.git("status", "--porcelain", "-z"), r.root).find((e) =>
      e.path.endsWith("a.txt"),
    )!;
    assert.equal(entry.index + entry.worktree, "UU");
    assert.equal(classifyConflict("UU")!.type, "both-modified");

    // All three index stages are present and carry each side's content.
    assert.deepEqual(await r.repository.unmergedStages(file), [1, 2, 3]);
    assert.equal(await r.repository.conflictBase(file), "line 1\nshared\nline 3\n");
    assert.equal(await r.repository.conflictSide(file, "ours"), "line 1\nours\nline 3\n");
    assert.equal(await r.repository.conflictSide(file, "theirs"), "line 1\ntheirs\nline 3\n");

    // The working tree holds the markers; parse and resolve "Accept Both" (current then incoming).
    const parsed = parseConflicts(readFileSync(file, "utf8"));
    assert.equal(parsed.regions.length, 1);
    const resolved = applyResolutions(parsed, new Map([[0, "both"]]));
    assert.equal(resolved, "line 1\nours\ntheirs\nline 3\n");

    // Write the resolved content (in the app this goes through the guarded apply path), then
    // resolveFile stages it and verifies no unmerged stage remains.
    writeFileSync(file, resolved);
    await r.repository.resolveFile(file);
    assert.deepEqual(await r.repository.unmergedStages(file), [], "index has no conflict stages");

    // Status now shows a staged, non-conflicted change (not unmerged).
    const after = parseGitEntries(r.git("status", "--porcelain", "-z"), r.root).find((e) =>
      e.path.endsWith("a.txt"),
    )!;
    assert.equal(after.conflict, false);
    assert.equal(after.index, "M", "the resolved file is staged");
  } finally {
    r.dispose();
  }
});

test("add/add conflict: only stages 2 and 3 exist, and the base side is reported unavailable", async () => {
  const r = realRepo();
  try {
    const file = join(r.root, "n.txt");
    r.git("commit", "-qm", "empty", "--allow-empty");
    r.git("switch", "-qc", "feature");
    writeFileSync(file, "theirs\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "add theirs");
    r.git("switch", "-q", "main");
    writeFileSync(file, "ours\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "add ours");
    try {
      r.git("merge", "feature");
    } catch {
      /* expected AA conflict */
    }

    const entry = parseGitEntries(r.git("status", "--porcelain", "-z"), r.root).find((e) =>
      e.path.endsWith("n.txt"),
    )!;
    assert.equal(entry.index + entry.worktree, "AA");
    assert.equal(classifyConflict("AA")!.sides.base, false);
    // Both-added has no common ancestor: stages 2 and 3 only, and reading stage 1 fails.
    assert.deepEqual(await r.repository.unmergedStages(file), [2, 3]);
    await assert.rejects(async () => r.repository.conflictBase(file), "no base stage to read");
    // Resolving (keep ours) still stages a single blob and clears the unmerged stages.
    writeFileSync(file, "ours\n");
    await r.repository.resolveFile(file);
    assert.deepEqual(await r.repository.unmergedStages(file), []);
  } finally {
    r.dispose();
  }
});
