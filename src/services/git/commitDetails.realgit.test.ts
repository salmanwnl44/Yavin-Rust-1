import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseCommitDetails } from "./parsers/log.ts";
import { realRepo } from "./testing/realGit.ts";

const body = (n: number) =>
  Array.from({ length: 20 }, (_, i) => `line ${i} of ${n}`).join("\n") + "\n";

/**
 * Real Git, real `Repository`: the paths `commitDetails` reports must be usable as-is by
 * `commitFileDiff`. With plain `--numstat` Git quoted non-ASCII names and printed renames
 * as `old => new`, so the second call silently returned an empty diff.
 */
test("commit detail paths round-trip through commitFileDiff for plain, spaced, non-ASCII and renamed files", async () => {
  const r = realRepo();
  try {
    mkdirSync(join(r.root, "src"));
    mkdirSync(join(r.root, "日本語"));
    writeFileSync(join(r.root, "plain.txt"), body(1));
    writeFileSync(join(r.root, "old name.txt"), body(2));
    writeFileSync(join(r.root, "src", "from.ts"), body(3));
    r.git("add", "-A");
    r.git("commit", "-qm", "base");

    writeFileSync(join(r.root, "plain.txt"), body(1) + "added\n");
    writeFileSync(join(r.root, "café.txt"), body(4));
    writeFileSync(join(r.root, "日本語", "ファイル.md"), body(5));
    writeFileSync(join(r.root, "with space.txt"), body(6));
    r.git("mv", "old name.txt", "new name (v2).txt");
    r.git("mv", "src/from.ts", "日本語/to.ts");
    r.git("add", "-A");
    r.git("commit", "-qm", "the change under test");

    const hash = r.git("rev-parse", "HEAD").trim();
    const details = parseCommitDetails(await r.repository.commitDetails(hash));
    assert.equal(details.summary, "the change under test");

    const byPath = new Map(details.files.map((f) => [f.path, f]));
    assert.deepEqual(
      [...byPath.keys()].sort(),
      [
        "café.txt",
        "plain.txt",
        "with space.txt",
        "new name (v2).txt",
        "日本語/to.ts",
        "日本語/ファイル.md",
      ].sort(),
    );
    assert.equal(byPath.get("new name (v2).txt")?.oldPath, "old name.txt");
    assert.equal(byPath.get("new name (v2).txt")?.status, "R");
    assert.equal(byPath.get("日本語/to.ts")?.oldPath, "src/from.ts");
    assert.equal(byPath.get("plain.txt")?.oldPath, undefined);

    for (const file of details.files) {
      const diff = await r.repository.commitFileDiff(hash, file.path, file.oldPath);
      assert.notEqual(diff.trim(), "", `${file.path}: commitFileDiff returned nothing`);
      if (file.oldPath) {
        // A rename is shown as a rename, not as a whole new file.
        assert.match(diff, /rename from /, `${file.path}: not shown as a rename`);
        assert.doesNotMatch(diff, /new file mode/);
      }
    }
  } finally {
    r.dispose();
  }
});
