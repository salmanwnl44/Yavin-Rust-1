import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPatch, parseUnifiedDiff } from "./diffHunks.ts";

const SAMPLE_DIFF = [
  "diff --git a/a.txt b/a.txt",
  "index abc123..def456 100644",
  "--- a/a.txt",
  "+++ b/a.txt",
  "@@ -1,2 +1,2 @@",
  " one",
  "-two",
  "+TWO",
  "@@ -10,2 +10,3 @@",
  " ten",
  "+eleven",
  " twelve",
  "",
].join("\n");

test("parseUnifiedDiff separates the header block from each hunk", () => {
  const parsed = parseUnifiedDiff(SAMPLE_DIFF);
  assert.deepEqual(parsed.headerLines, [
    "diff --git a/a.txt b/a.txt",
    "index abc123..def456 100644",
    "--- a/a.txt",
    "+++ b/a.txt",
  ]);
  assert.equal(parsed.hunks.length, 2);
  assert.equal(parsed.hunks[0].header, "@@ -1,2 +1,2 @@");
  assert.equal(parsed.hunks[0].additions, 1);
  assert.equal(parsed.hunks[0].deletions, 1);
  assert.equal(parsed.hunks[1].header, "@@ -10,2 +10,3 @@");
  assert.equal(parsed.hunks[1].additions, 1);
  assert.equal(parsed.hunks[1].deletions, 0);
});

test("buildPatch with every hunk selected reproduces the original text", () => {
  const parsed = parseUnifiedDiff(SAMPLE_DIFF);
  const rebuilt = buildPatch(parsed, new Set([0, 1]));
  assert.equal(rebuilt, SAMPLE_DIFF);
});

test("buildPatch with a subset keeps the header but drops the other hunk", () => {
  const parsed = parseUnifiedDiff(SAMPLE_DIFF);
  const onlyFirst = buildPatch(parsed, new Set([0]));
  assert.ok(onlyFirst.includes("@@ -1,2 +1,2 @@"));
  assert.ok(!onlyFirst.includes("@@ -10,2 +10,3 @@"));
  assert.ok(!onlyFirst.includes("eleven"));
});

test("buildPatch with nothing selected returns an empty string", () => {
  const parsed = parseUnifiedDiff(SAMPLE_DIFF);
  assert.equal(buildPatch(parsed, new Set()), "");
});

// --- Integration: the reconstructed patch must actually apply with real Git. ---
// This is the property that matters -- a sub-patch that merely "looks right" but
// that Git rejects (or applies wrong) would be a silent staging bug in production.

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", args, { cwd, input, encoding: "utf8" });
}

test("staging only the selected hunk leaves the other hunk's change unstaged", () => {
  const dir = mkdtempSync(join(tmpdir(), "yavin-diffhunks-"));
  try {
    git(dir, ["init", "-q"]);
    git(dir, ["config", "user.email", "test@example.invalid"]);
    git(dir, ["config", "user.name", "Yavin Test"]);
    git(dir, ["config", "commit.gpgsign", "false"]);
    git(dir, ["config", "core.autocrlf", "false"]);

    // Two well-separated regions so Git produces two distinct hunks.
    const original = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n") + "\n";
    writeFileSync(join(dir, "a.txt"), original);
    git(dir, ["add", "a.txt"]);
    git(dir, ["commit", "-qm", "base"]);

    const lines = original.split("\n");
    lines[0] = "CHANGED FIRST";
    lines[18] = "CHANGED NEAR END";
    writeFileSync(join(dir, "a.txt"), lines.join("\n"));

    const diffText = git(dir, ["diff", "--", "a.txt"]);
    const parsed = parseUnifiedDiff(diffText);
    assert.equal(parsed.hunks.length, 2, "the two edits should form separate hunks");

    const patch = buildPatch(parsed, new Set([0]));
    git(dir, ["apply", "--cached"], patch);

    const staged = git(dir, ["diff", "--cached", "--", "a.txt"]);
    const stillUnstaged = git(dir, ["diff", "--", "a.txt"]);

    assert.ok(staged.includes("CHANGED FIRST"), "the selected hunk was staged");
    assert.ok(!staged.includes("CHANGED NEAR END"), "the other hunk was not staged");
    assert.ok(
      stillUnstaged.includes("CHANGED NEAR END"),
      "the unselected hunk's change remains in the working tree, unstaged",
    );
    assert.ok(
      !stillUnstaged.includes("CHANGED FIRST"),
      "the staged hunk no longer shows as an unstaged change",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function freshRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "yavin-diffhunks-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.invalid"]);
  git(dir, ["config", "user.name", "Yavin Test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  git(dir, ["config", "core.autocrlf", "false"]);
  return dir;
}

test("a renamed file's diff header survives buildPatch's reconstruction unmodified", () => {
  const dir = freshRepo();
  try {
    writeFileSync(join(dir, "old.txt"), "line1\nline2\nline3\n");
    git(dir, ["add", "old.txt"]);
    git(dir, ["commit", "-qm", "base"]);
    git(dir, ["mv", "old.txt", "new.txt"]);
    writeFileSync(join(dir, "new.txt"), "line1\nCHANGED\nline3\n");
    git(dir, ["add", "new.txt"]);

    const diffText = git(dir, ["diff", "--cached", "-M", "--", "new.txt", "old.txt"]);
    const parsed = parseUnifiedDiff(diffText);
    const rebuilt = buildPatch(parsed, new Set(parsed.hunks.map((_, i) => i)));
    assert.equal(rebuilt, diffText, "reconstruction with every hunk selected must be lossless");
    assert.ok(rebuilt.includes("rename from old.txt"));
    assert.ok(rebuilt.includes("rename to new.txt"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a deleted file's diff parses as a single all-deletion hunk", () => {
  const dir = freshRepo();
  try {
    writeFileSync(join(dir, "gone.txt"), "line1\nline2\n");
    git(dir, ["add", "gone.txt"]);
    git(dir, ["commit", "-qm", "base"]);
    git(dir, ["rm", "-q", "gone.txt"]);

    const diffText = git(dir, ["diff", "--cached", "--", "gone.txt"]);
    const parsed = parseUnifiedDiff(diffText);
    assert.equal(parsed.hunks.length, 1);
    assert.equal(parsed.hunks[0].additions, 0);
    assert.equal(parsed.hunks[0].deletions, 2);
    assert.ok(parsed.headerLines.some((line) => line.includes("deleted file mode")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file with no trailing newline preserves Git's own marker in the hunk", () => {
  const dir = freshRepo();
  try {
    writeFileSync(join(dir, "a.txt"), "one\ntwo");
    git(dir, ["add", "a.txt"]);
    git(dir, ["commit", "-qm", "base"]);
    writeFileSync(join(dir, "a.txt"), "one\nTWO");

    const diffText = git(dir, ["diff", "--", "a.txt"]);
    const parsed = parseUnifiedDiff(diffText);
    assert.equal(parsed.hunks.length, 1);
    assert.ok(parsed.hunks[0].lines.some((line) => line.includes("No newline at end of file")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a binary file's diff is safely non-hunked, never throws", () => {
  const dir = freshRepo();
  try {
    writeFileSync(join(dir, "img.bin"), Buffer.from([0, 1, 2, 0, 255, 254]));
    git(dir, ["add", "img.bin"]);
    git(dir, ["commit", "-qm", "base"]);
    writeFileSync(join(dir, "img.bin"), Buffer.from([9, 9, 9, 0, 0, 0]));

    const diffText = git(dir, ["diff", "--", "img.bin"]);
    assert.ok(diffText.includes("Binary files"));
    const parsed = parseUnifiedDiff(diffText);
    assert.equal(parsed.hunks.length, 0);
    assert.ok(parsed.headerLines.some((line) => line.includes("Binary files")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
