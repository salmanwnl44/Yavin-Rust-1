import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { realRepo } from "./testing/realGit.ts";
import { parseUnifiedDiff } from "./diffHunks.ts";
import { parseGitEntries } from "./parsers/status.ts";

/**
 * Real-Git integration coverage for hunk-level staging (WS24, scope item 3).
 *
 * The patch builder is unit-tested on synthetic diffs in `diffHunks.test.ts`; this proves the
 * whole production path -- `Repository.diff()` -> `parseUnifiedDiff`/`buildPatch` ->
 * `git apply --cached` -- against the real `git` binary: selecting one hunk stages exactly that
 * hunk and leaves every other change of the same file untouched, and a patch that no longer
 * matches the file is refused rather than silently misapplied.
 */

/** A 20-line file; returns the absolute path. */
function seedFile(root: string, name: string): string {
  const abs = join(root, name);
  writeFileSync(
    abs,
    Array.from({ length: 20 }, (_, i) => `L${String(i + 1).padStart(2, "0")}`).join("\n") + "\n",
  );
  return abs;
}

/** Change the first and last line, leaving the middle untouched -> two separate hunks. */
function editTopAndBottom(abs: string): void {
  const lines = Array.from({ length: 20 }, (_, i) => `L${String(i + 1).padStart(2, "0")}`);
  lines[0] = "L01-top-changed";
  lines[19] = "L20-bottom-changed";
  writeFileSync(abs, lines.join("\n") + "\n");
}

function entryFor(output: string, root: string, name: string) {
  const abs = join(root, name).replace(/\\/g, "/");
  return parseGitEntries(output, root).find((e) => e.path.replace(/\\/g, "/") === abs);
}

test("staging one hunk stages exactly that change and leaves the file's other hunk unstaged", async () => {
  const r = realRepo();
  try {
    const abs = seedFile(r.root, "f.txt");
    r.git("add", "f.txt");
    r.git("commit", "-qm", "seed");
    editTopAndBottom(abs);

    const diff = await r.repository.diff(abs, false);
    const parsed = parseUnifiedDiff(diff);
    assert.equal(parsed.hunks.length, 2, "top and bottom edits should be two separate hunks");

    // Stage only the first hunk (the top-of-file change).
    await r.repository.stageHunks(diff, [0]);

    // The file is now partially staged: index modified AND worktree modified.
    const entry = entryFor(await r.repository.status(), r.root, "f.txt");
    assert.ok(entry, "f.txt should appear in status");
    assert.equal(entry!.index, "M");
    assert.equal(entry!.worktree, "M");

    // The staged diff holds only the top change; the bottom change stays unstaged.
    const staged = await r.repository.diff(abs, true);
    assert.match(staged, /L01-top-changed/);
    assert.doesNotMatch(staged, /L20-bottom-changed/);
    const unstaged = await r.repository.diff(abs, false);
    assert.match(unstaged, /L20-bottom-changed/);
    assert.doesNotMatch(unstaged, /L01-top-changed/);
  } finally {
    r.dispose();
  }
});

test("unstaging one hunk returns exactly that change to the working tree, keeping the rest staged", async () => {
  const r = realRepo();
  try {
    const abs = seedFile(r.root, "f.txt");
    r.git("add", "f.txt");
    r.git("commit", "-qm", "seed");
    editTopAndBottom(abs);
    // Stage everything first.
    r.git("add", "f.txt");

    const staged = await r.repository.diff(abs, true);
    const parsed = parseUnifiedDiff(staged);
    assert.equal(parsed.hunks.length, 2);

    // Unstage only the bottom hunk.
    await r.repository.unstageHunks(staged, [1]);

    const entry = entryFor(await r.repository.status(), r.root, "f.txt");
    assert.equal(entry!.index, "M");
    assert.equal(entry!.worktree, "M");
    const stillStaged = await r.repository.diff(abs, true);
    assert.match(stillStaged, /L01-top-changed/);
    assert.doesNotMatch(stillStaged, /L20-bottom-changed/);
  } finally {
    r.dispose();
  }
});

test("discarding one hunk reverts only that region in the working tree", async () => {
  const r = realRepo();
  try {
    const abs = seedFile(r.root, "f.txt");
    r.git("add", "f.txt");
    r.git("commit", "-qm", "seed");
    editTopAndBottom(abs);

    const diff = await r.repository.diff(abs, false);
    // Discard the bottom hunk only; the top change must survive.
    await r.repository.discardHunks(diff, [1]);

    const after = await r.repository.diff(abs, false);
    assert.match(after, /L01-top-changed/, "the kept hunk must remain");
    assert.doesNotMatch(after, /L20-bottom-changed/, "the discarded hunk must be gone");
  } finally {
    r.dispose();
  }
});

test("a hunk patch that no longer matches the file is refused, not silently misapplied", async () => {
  const r = realRepo();
  try {
    const abs = seedFile(r.root, "f.txt");
    r.git("add", "f.txt");
    r.git("commit", "-qm", "seed");
    editTopAndBottom(abs);

    // Capture the diff, then change the working file underneath so the reverse patch's
    // context no longer matches.
    const stale = await r.repository.diff(abs, false);
    writeFileSync(abs, "completely different content\n");

    await assert.rejects(
      r.repository.discardHunks(stale, [0]),
      /no longer matches the file|patch does not apply/i,
    );
  } finally {
    r.dispose();
  }
});
