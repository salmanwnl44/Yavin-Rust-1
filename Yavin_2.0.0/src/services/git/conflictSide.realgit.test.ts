import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync, readFileSync } from "node:fs";
import { realRepo } from "./testing/realGit.ts";

/**
 * Real Git, real `Repository`: reading one side of a conflicted file, which is how
 * "Accept Ours"/"Accept Theirs" is implemented. Deliberately NOT `git restore --ours`:
 * see the Rust-side test `restore_ours_would_silently_discard_an_edit_which_is_why_it_stays_refused`.
 */

/** Leaves the repository mid-merge with `a.txt` conflicted. */
function conflicted() {
  const r = realRepo();
  const file = `${r.root}/a.txt`;
  writeFileSync(file, "base\n");
  r.git("add", "-A");
  r.git("commit", "-qm", "base");

  r.git("switch", "-qc", "incoming");
  writeFileSync(file, "from the other branch\n");
  r.git("commit", "-qam", "theirs");

  r.git("switch", "-q", "main");
  writeFileSync(file, "from my branch\n");
  r.git("commit", "-qam", "ours");

  // Expected to fail: that is the point.
  try {
    r.git("merge", "incoming");
  } catch {
    /* conflict */
  }
  return { r, file };
}

test("each side of a conflicted file can be read back exactly", async () => {
  const { r, file } = conflicted();
  try {
    // The working tree holds conflict markers at this point, not either side.
    assert.match(readFileSync(file, "utf8"), /<<<<<<</);

    assert.equal(await r.repository.conflictSide(file, "ours"), "from my branch\n");
    assert.equal(await r.repository.conflictSide(file, "theirs"), "from the other branch\n");
  } finally {
    r.dispose();
  }
});

test("reading a side of a file that is not conflicted fails loudly instead of returning the index copy", async () => {
  // The failure mode that ruled out `git restore --ours`: there, a non-conflicted path is
  // silently overwritten from the index. Reading stage 2 of a path with no stages must
  // instead be an error the caller sees, so nothing is ever written over a live edit.
  const r = realRepo();
  try {
    const file = `${r.root}/b.txt`;
    writeFileSync(file, "committed\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "b");
    writeFileSync(file, "uncommitted edit\n");

    await assert.rejects(() => r.repository.conflictSide(file, "ours"));
    assert.equal(readFileSync(file, "utf8"), "uncommitted edit\n", "the edit is untouched");
  } finally {
    r.dispose();
  }
});

test("a conflicted side keeps content that looks like conflict markers or is non-ASCII", async () => {
  const r = realRepo();
  const file = `${r.root}/tricky.md`;
  try {
    writeFileSync(file, "base\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "base");

    r.git("switch", "-qc", "incoming");
    writeFileSync(file, "documentation: <<<<<<< is how a conflict starts — café\n");
    r.git("commit", "-qam", "theirs");

    r.git("switch", "-q", "main");
    writeFileSync(file, "mine\n");
    r.git("commit", "-qam", "ours");
    try {
      r.git("merge", "incoming");
    } catch {
      /* conflict */
    }

    assert.equal(
      await r.repository.conflictSide(file, "theirs"),
      "documentation: <<<<<<< is how a conflict starts — café\n",
    );
  } finally {
    r.dispose();
  }
});
