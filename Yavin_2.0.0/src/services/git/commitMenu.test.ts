import assert from "node:assert/strict";
import test from "node:test";
import { buildCommitMenu } from "./commitMenu.ts";
import type { CommitMenuActions } from "./commitMenu.ts";
import type { RawCommit } from "./parsers/log.ts";

const commit = (refs: RawCommit["refs"] = []): RawCommit => ({
  fullHash: "a".repeat(40),
  hash: "aaaaaaa",
  parents: [],
  authorName: "A",
  authorEmail: "a@x.test",
  date: "Jan 1",
  relativeTime: "1 day ago",
  subject: "Subject",
  refs,
});
const head = commit([{ kind: "head", name: "main" }]);
const idle = { busy: false, operationInProgress: "" };
const calls: string[] = [];
const actions: CommitMenuActions = {
  open: () => void calls.push("open"),
  copyHash: () => void calls.push("copy"),
  undoLastCommit: () => void calls.push("undo"),
  revert: () => void calls.push("revert"),
  cherryPick: () => void calls.push("cherryPick"),
  openOnRemote: { label: "GitHub", open: () => void calls.push("remote") },
};
const labels = (items: ReturnType<typeof buildCommitMenu>) =>
  items.filter((item) => !item.divider).map((item) => item.label);

test("a commit offers open, copy, revert, cherry-pick and its remote page", () => {
  assert.deepEqual(labels(buildCommitMenu(commit(), idle, actions)), [
    "Open",
    "Copy Commit Hash",
    "Revert Commit…",
    "Cherry-pick Commit…",
    "Open on GitHub",
  ]);
});

test("Undo Last Commit is offered on the checked-out commit only", () => {
  assert.ok(labels(buildCommitMenu(head, idle, actions)).includes("Undo Last Commit"));
  assert.ok(!labels(buildCommitMenu(commit(), idle, actions)).includes("Undo Last Commit"));
});

test("each item runs its own action", () => {
  calls.length = 0;
  for (const item of buildCommitMenu(head, idle, actions)) void item.onClick?.();
  assert.deepEqual(calls, ["open", "copy", "undo", "revert", "cherryPick", "remote"]);
});

test("history-changing items say why they cannot run while Git is busy or stopped half-way", () => {
  for (const state of [
    { busy: true, operationInProgress: "" },
    { busy: false, operationInProgress: "merge" },
  ]) {
    const items = buildCommitMenu(head, state, actions);
    for (const label of ["Undo Last Commit", "Revert Commit…", "Cherry-pick Commit…"]) {
      const item = items.find((i) => i.label === label)!;
      assert.equal(item.disabled, true, label);
      assert.ok(item.reason, label);
    }
    // Reading the commit is never blocked.
    assert.ok(!items.find((i) => i.label === "Copy Commit Hash")!.disabled);
  }
  const merge = buildCommitMenu(head, { busy: false, operationInProgress: "merge" }, actions);
  assert.match(merge.find((i) => i.label === "Revert Commit…")!.reason!, /merge in progress/);
});

test("items with nothing behind them are left out, not shown disabled", () => {
  const items = buildCommitMenu(commit(), idle, { copyHash: () => {}, undoLastCommit: () => {} });
  assert.deepEqual(labels(items), ["Copy Commit Hash"]);
  assert.ok(!items.some((item) => item.divider));
});
