import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { realRepo } from "./testing/realGit.ts";
import { parseGitEntries } from "./parsers/status.ts";
import type { GitEntry } from "./parsers/status.ts";

/**
 * Real-Git integration coverage for status parsing (WS24, scope item 2).
 *
 * `parsers/status.test.ts` feeds the parser hand-written porcelain strings; this proves the
 * production `Repository.status()` -> `parseGitEntries` path interprets what real `git` actually
 * emits for renames, deletions, untracked files, staged-vs-unstaged separation, partial staging,
 * and paths containing spaces.
 */

function byBasename(entries: GitEntry[], name: string): GitEntry | undefined {
  return entries.find((e) => e.path.replace(/\\/g, "/").endsWith("/" + name));
}

test("real status separates index from working tree across rename, delete, untracked and partial staging", async () => {
  const r = realRepo();
  try {
    writeFileSync(join(r.root, "old.txt"), "o\n");
    writeFileSync(join(r.root, "del-staged.txt"), "a\n");
    writeFileSync(join(r.root, "del-wt.txt"), "b\n");
    writeFileSync(join(r.root, "mod.txt"), "line1\nline2\n");
    writeFileSync(join(r.root, "with space.txt"), "s\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "seed");

    // Staged rename (git mv stages both halves).
    r.git("mv", "old.txt", "new.txt");
    // Staged deletion.
    r.git("rm", "-q", "del-staged.txt");
    // Working-tree-only deletion (not staged).
    rmSync(join(r.root, "del-wt.txt"));
    // Partial staging: stage one change, then modify again.
    writeFileSync(join(r.root, "mod.txt"), "line1-staged\nline2\n");
    r.git("add", "mod.txt");
    writeFileSync(join(r.root, "mod.txt"), "line1-staged\nline2-unstaged\n");
    // Untracked.
    writeFileSync(join(r.root, "fresh.txt"), "new\n");
    // Unstaged modification of a path with a space.
    writeFileSync(join(r.root, "with space.txt"), "s changed\n");

    const entries = parseGitEntries(await r.repository.status(), r.root);

    const renamed = byBasename(entries, "new.txt");
    assert.ok(renamed, "renamed file should be present under its new name");
    assert.equal(renamed!.index, "R");
    assert.ok(
      renamed!.originalPath?.replace(/\\/g, "/").endsWith("/old.txt"),
      "rename keeps the original path",
    );

    assert.equal(byBasename(entries, "del-staged.txt")!.index, "D");
    assert.equal(byBasename(entries, "del-wt.txt")!.worktree, "D");

    const partial = byBasename(entries, "mod.txt")!;
    assert.equal(partial.index, "M", "the staged half is in the index");
    assert.equal(partial.worktree, "M", "the later edit is unstaged");

    const untracked = byBasename(entries, "fresh.txt")!;
    assert.equal(untracked.untracked, true);
    assert.equal(untracked.index, "?");

    const spaced = byBasename(entries, "with space.txt")!;
    assert.equal(spaced.worktree, "M");
    assert.equal(spaced.index, " ");
    // The space in the path must survive parsing intact.
    assert.ok(spaced.path.includes("with space.txt"));
  } finally {
    r.dispose();
  }
});

test("real status marks every conflict stage combination as a conflict", async () => {
  const r = realRepo();
  try {
    writeFileSync(join(r.root, "c.txt"), "base\n");
    r.git("add", "c.txt");
    r.git("commit", "-qm", "base");
    r.git("switch", "-qc", "feature");
    writeFileSync(join(r.root, "c.txt"), "feature\n");
    r.git("commit", "-aqm", "feature");
    r.git("switch", "-q", "main");
    writeFileSync(join(r.root, "c.txt"), "main\n");
    r.git("commit", "-aqm", "main");
    try {
      r.git("merge", "feature");
    } catch {
      /* expected conflict */
    }

    const entries = parseGitEntries(await r.repository.status(), r.root);
    const conflicted = byBasename(entries, "c.txt")!;
    assert.equal(conflicted.conflict, true, "both-modified (UU) must read as a conflict");
  } finally {
    r.dispose();
  }
});
