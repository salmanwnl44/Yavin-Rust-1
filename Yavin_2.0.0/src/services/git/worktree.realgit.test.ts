import assert from "node:assert/strict";
import test from "node:test";
import { platform } from "node:os";
import { parseWorktreeList } from "./parsers/worktree.ts";
import { realRepo } from "./testing/realGit.ts";

test("real Git: worktree discovery returns exact paths for spaces and non-ASCII names", async () => {
  const r = realRepo();
  const linked = [`${r.root}-with space`, `${r.root}-wt-é-日本`];
  // A newline in a directory name is only possible off Windows.
  if (platform() !== "win32") linked.push(`${r.root}-new\nline`);
  try {
    r.git("commit", "--allow-empty", "-qm", "base");
    linked.forEach((path, i) => r.git("worktree", "add", "-q", "-b", `wt${i}`, path));

    const found = parseWorktreeList(await r.repository.listWorktrees());
    // Git reports forward slashes; compare on that form.
    const normalise = (p: string) => p.replace(/\\/g, "/");
    assert.equal(found.length, linked.length + 1);
    assert.equal(found[0].isMain, true);
    assert.deepEqual(
      found
        .slice(1)
        .map((w) => normalise(w.path))
        .sort(),
      linked.map(normalise).sort(),
    );
    assert.deepEqual(
      found
        .slice(1)
        .map((w) => w.branch)
        .sort(),
      linked.map((_, i) => `wt${i}`),
    );
  } finally {
    r.dispose();
  }
});
