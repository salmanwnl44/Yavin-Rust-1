import assert from "node:assert/strict";
import test from "node:test";
import { buildChangeMenu, gitignoreLine, withIgnored } from "./changeMenu.ts";
import type { ChangeMenuActions } from "./changeMenu.ts";
import type { GitEntry } from "./parsers/status.ts";

const entry = (index: string, worktree: string, extra: Partial<GitEntry> = {}): GitEntry => ({
  path: "/r/src/a.ts",
  index,
  worktree,
  untracked: false,
  conflict: false,
  ...extra,
});
const calls: string[] = [];
const actions: ChangeMenuActions = {
  openChanges: (staged) => void calls.push(`open:${staged}`),
  openFile: () => void calls.push("file"),
  stage: () => void calls.push("stage"),
  unstage: () => void calls.push("unstage"),
  discard: () => void calls.push("discard"),
  acceptSide: (side) => void calls.push(side),
  ignore: () => void calls.push("ignore"),
  reveal: () => void calls.push("reveal"),
  copyPath: () => void calls.push("copy"),
  copyRelativePath: () => void calls.push("copyRelative"),
};
const labels = (items: ReturnType<typeof buildChangeMenu>) =>
  items.filter((item) => !item.divider).map((item) => item.label);

test("each group's rows offer what applies there", () => {
  const partly = entry("M", "M");
  assert.deepEqual(labels(buildChangeMenu(partly, "staged", actions, false)), [
    "Open Staged Changes",
    "Open File",
    "Unstage",
    "Reveal in File Explorer",
    "Copy Path",
    "Copy Relative Path",
  ]);
  assert.deepEqual(labels(buildChangeMenu(partly, "unstaged", actions, false)), [
    "Open Changes",
    "Open File",
    "Stage",
    "Discard Changes",
    "Reveal in File Explorer",
    "Copy Path",
    "Copy Relative Path",
  ]);
  // The single list: a partly staged file offers both diffs and both directions.
  const flat = labels(buildChangeMenu(partly, "all", actions, false));
  assert.ok(flat.includes("Open Staged Changes") && flat.includes("Stage"));
  assert.ok(flat.includes("Unstage"));
});

test("a conflict offers its sides; an untracked file offers .gitignore, not Discard", () => {
  const conflict = labels(
    buildChangeMenu(entry("U", "U", { conflict: true }), "conflicts", actions, false),
  );
  assert.ok(conflict.includes("Accept Current (Ours)") && conflict.includes("Stage as Resolved"));
  assert.ok(!conflict.includes("Discard Changes"));

  const untracked = buildChangeMenu(
    entry("?", "?", { untracked: true }),
    "unstaged",
    actions,
    false,
  );
  const discard = untracked.find((item) => item.label === "Discard Changes")!;
  assert.equal(discard.disabled, true);
  assert.match(discard.reason!, /untracked/);
  assert.ok(labels(untracked).includes("Add to .gitignore"));

  // Without a way to open or reveal files, those items are simply not there.
  const bare = buildChangeMenu(
    entry(" ", "M"),
    "unstaged",
    { ...actions, openFile: undefined, reveal: undefined },
    false,
  );
  assert.ok(
    !labels(bare).includes("Open File") && !labels(bare).includes("Reveal in File Explorer"),
  );
});

test("while Git is busy the actions that change something are off", () => {
  const items = buildChangeMenu(entry(" ", "M"), "unstaged", actions, true);
  assert.equal(items.find((item) => item.label === "Stage")!.disabled, true);
  assert.notEqual(items.find((item) => item.label === "Open Changes")!.disabled, true);
});

test(".gitignore gains the file once, anchored, keeping the file's line endings", () => {
  assert.equal(gitignoreLine("src\\build\\out.log"), "/src/build/out.log");
  assert.equal(withIgnored("", "/a.log"), "/a.log\n");
  assert.equal(withIgnored("node_modules", "/a.log"), "node_modules\n/a.log\n");
  assert.equal(withIgnored("dist\r\n", "/a.log"), "dist\r\n/a.log\r\n");
  assert.equal(withIgnored("/a.log\n", "/a.log"), "/a.log\n", "already there: unchanged");
});
