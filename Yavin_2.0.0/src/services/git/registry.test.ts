import assert from "node:assert/strict";
import test from "node:test";
import { gitRegistry } from "./registry.ts";
import { overrideNative, realRepo, resetNativeOverrides } from "./testing/realGit.ts";

/** Lets any rejection that was left unhandled reach `process`'s `unhandledRejection`. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

function watchForUnhandledRejections() {
  const seen: unknown[] = [];
  const listener = (reason: unknown) => seen.push(reason);
  process.on("unhandledRejection", listener);
  return {
    seen,
    stop: () => process.off("unhandledRejection", listener),
  };
}

test("a watcher that fails to start, restart or stop never becomes an unhandled rejection", async () => {
  const guard = watchForUnhandledRejections();
  const r = realRepo();
  try {
    overrideNative("git_watch_repo", () => Promise.reject(new Error("notify init failed")));
    overrideNative("git_unwatch_repo", () => Promise.reject(new Error("stop failed")));

    // Start fails: the repository still opens and is usable, the failure is recorded.
    const entry = await gitRegistry.open(r.root, { makeActive: true });
    assert.ok(entry, "the repository opened despite the watcher failing");
    await settle();
    assert.equal(gitRegistry.isWatcherDown(entry.repoId), true, "failure is recorded for the poll");

    // A second worktree makes the registry restart the watcher; that fails too.
    r.git("commit", "--allow-empty", "-qm", "base");
    const linked = `${r.root}-linked`;
    r.git("worktree", "add", "-q", "-b", "other", linked);
    const second = await gitRegistry.open(linked);
    assert.ok(second);
    await settle();
    assert.equal(gitRegistry.isWatcherDown(second.repoId), true);

    // Closing a worktree restarts it again (fails); closing the last one stops it (fails).
    await gitRegistry.close(second.repoId);
    await gitRegistry.close(entry.repoId);
    await settle();

    assert.deepEqual(guard.seen, [], "no rejection was left unhandled");
  } finally {
    guard.stop();
    resetNativeOverrides();
    r.dispose();
  }
});

test("a later successful watcher start clears the recorded failure", async () => {
  const r = realRepo();
  try {
    overrideNative("git_watch_repo", () => Promise.reject(new Error("first start fails")));
    const entry = await gitRegistry.open(r.root, { makeActive: true });
    assert.ok(entry);
    await settle();
    assert.equal(gitRegistry.isWatcherDown(entry.repoId), true);

    resetNativeOverrides();
    r.git("commit", "--allow-empty", "-qm", "base");
    const linked = `${r.root}-linked2`;
    r.git("worktree", "add", "-q", "-b", "other2", linked);
    const second = await gitRegistry.open(linked);
    assert.ok(second);
    await settle();
    assert.equal(gitRegistry.isWatcherDown(entry.repoId), false, "the restart succeeded");

    await gitRegistry.close(second.repoId);
    await gitRegistry.close(entry.repoId);
  } finally {
    resetNativeOverrides();
    r.dispose();
  }
});
