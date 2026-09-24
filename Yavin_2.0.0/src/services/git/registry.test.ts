import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chooseActiveWorktree, GitRegistry, gitRegistry } from "./registry.ts";
import type { RepoEntry, RepositoryEntry } from "./registry.ts";
import type { WorktreeStatus } from "./backend.ts";
import { nativeCalls, overrideNative, realRepo, resetNativeOverrides } from "./testing/realGit.ts";

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

// ---- worktree lifecycle ------------------------------------------------------------------

const fakeWorktree = (root: string, status: WorktreeStatus = "ready") =>
  ({ repoId: root, root, status, store: {} }) as unknown as RepoEntry;
const fakeRepository = (id: string, worktrees: RepoEntry[], main?: string) =>
  ({
    repositoryId: id,
    worktrees,
    knownWorktrees: main ? [{ path: main, isMain: true }] : [],
  }) as unknown as RepositoryEntry;

test("chooseActiveWorktree keeps the remembered worktree while it is usable", () => {
  const main = fakeWorktree("/w/main");
  const linked = fakeWorktree("/w/linked");
  const chosen = chooseActiveWorktree([fakeRepository("r", [main, linked], "/w/main")], {
    repositoryId: "r",
    worktreePath: "/w/linked",
  });
  assert.equal(chosen?.worktree, linked);
});

test("chooseActiveWorktree falls back to the main worktree, not merely the first one", () => {
  // The linked worktree was opened first, so it is first in the list -- but main is preferred.
  const linked = fakeWorktree("/w/linked", "missing");
  const other = fakeWorktree("/w/other");
  const main = fakeWorktree("/w/main");
  const chosen = chooseActiveWorktree([fakeRepository("r", [linked, other, main], "/w/main")], {
    repositoryId: "r",
    worktreePath: "/w/linked",
  });
  assert.equal(chosen?.worktree, main);
});

test("chooseActiveWorktree takes the first usable remaining worktree when main is unusable", () => {
  const main = fakeWorktree("/w/main", "invalid");
  const gone = fakeWorktree("/w/gone", "missing");
  const a = fakeWorktree("/w/a");
  const b = fakeWorktree("/w/b");
  const chosen = chooseActiveWorktree([fakeRepository("r", [main, gone, a, b], "/w/main")], {
    repositoryId: "r",
    worktreePath: "/w/gone",
  });
  assert.equal(chosen?.worktree, a);
});

test("chooseActiveWorktree stays inside the remembered repository before trying another", () => {
  const first = fakeRepository("first", [fakeWorktree("/first/main")], "/first/main");
  const linked = fakeWorktree("/second/linked");
  const second = fakeRepository("second", [fakeWorktree("/second/main", "missing"), linked]);
  const chosen = chooseActiveWorktree([first, second], {
    repositoryId: "second",
    worktreePath: "/second/main",
  });
  assert.equal(chosen?.worktree, linked);
  assert.equal(chosen?.repository, second);
});

test("chooseActiveWorktree moves to another repository only when the remembered one has nothing usable", () => {
  const other = fakeWorktree("/other/main");
  const chosen = chooseActiveWorktree(
    [
      fakeRepository("dead", [fakeWorktree("/dead/main", "missing")]),
      fakeRepository("other", [other]),
    ],
    { repositoryId: "dead", worktreePath: "/dead/main" },
  );
  assert.equal(chosen?.worktree, other);
});

test("chooseActiveWorktree returns null when every worktree is missing or invalid", () => {
  const chosen = chooseActiveWorktree(
    [fakeRepository("r", [fakeWorktree("/w/a", "missing"), fakeWorktree("/w/b", "invalid")])],
    { repositoryId: "r", worktreePath: "/w/a" },
  );
  assert.equal(chosen, null);
});

test("chooseActiveWorktree matches paths regardless of drive-letter case and separators", () => {
  const main = fakeWorktree("C:/Work/Main");
  const chosen = chooseActiveWorktree([fakeRepository("r", [main])], {
    repositoryId: "r",
    worktreePath: "c:\\work\\main",
  });
  assert.equal(chosen?.worktree, main);
});

/** A `localStorage` that lives for one test, so persisted state can be inspected and reused. */
function withStorage() {
  const data = new Map<string, string>();
  const g = globalThis as unknown as { localStorage?: unknown };
  const previous = Object.getOwnPropertyDescriptor(g, "localStorage");
  Object.defineProperty(g, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    },
  });
  return {
    data,
    restore: () => {
      if (previous) Object.defineProperty(g, "localStorage", previous);
      else delete g.localStorage;
    },
  };
}

const persistedWorktrees = (storage: Map<string, string>) =>
  (JSON.parse(storage.get("yavin.git.repos") ?? "{}").repositories ?? []).flatMap(
    (r: { worktrees: string[] }) => r.worktrees,
  ) as string[];

/** A main worktree plus one linked worktree, both opened in a fresh registry. */
async function twoWorktrees() {
  const r = realRepo();
  r.git("commit", "--allow-empty", "-qm", "base");
  const linked = `${r.root}-linked-lc`;
  r.git("worktree", "add", "-q", "-b", "lc", linked);
  const registry = new GitRegistry();
  const main = await registry.open(r.root, { makeActive: true });
  const second = await registry.open(linked, { makeActive: true });
  assert.ok(main && second);
  return { r, registry, main, second, linked };
}

test("restore: a remembered worktree that still exists is active again", async () => {
  const storage = withStorage();
  const { r, registry, main, second, linked } = await twoWorktrees();
  try {
    assert.equal(registry.getSnapshot().activeWorktreePath, second.root);
    const restored = new GitRegistry();
    await restored.restore();
    assert.equal(restored.getSnapshot().activeWorktreePath, second.root);
    assert.deepEqual(persistedWorktrees(storage.data).sort(), [main.root, second.root].sort());
    void linked;
  } finally {
    storage.restore();
    rmSync(linked, { recursive: true, force: true });
    r.dispose();
  }
});

test("restore: a remembered worktree that was deleted falls back to the main worktree and is pruned", async () => {
  const storage = withStorage();
  const { r, main, second, linked } = await twoWorktrees();
  try {
    rmSync(linked, { recursive: true, force: true });
    const restored = new GitRegistry();
    await restored.restore();
    const snapshot = restored.getSnapshot();
    assert.equal(snapshot.activeWorktreePath, main.root, "main worktree is selected");
    assert.deepEqual(
      snapshot.repos.map((w) => w.root),
      [main.root],
    );
    // Storage was rewritten: the deleted worktree is gone and main is the remembered one.
    assert.deepEqual(persistedWorktrees(storage.data), [main.root]);
    assert.equal(
      JSON.parse(storage.data.get("yavin.git.repos")!).repositories[0].activeWorktree,
      main.root,
    );
    void second;
  } finally {
    storage.restore();
    r.dispose();
  }
});

test("restore: when every remembered worktree is gone nothing is active and storage is emptied", async () => {
  const storage = withStorage();
  const { r, linked } = await twoWorktrees();
  try {
    const paths = persistedWorktrees(storage.data);
    for (const p of paths) rmSync(p, { recursive: true, force: true });
    const restored = new GitRegistry();
    await restored.restore();
    assert.equal(restored.getSnapshot().repos.length, 0);
    assert.equal(restored.getSnapshot().activeWorktreePath, null);
    assert.deepEqual(persistedWorktrees(storage.data), []);
  } finally {
    storage.restore();
    rmSync(linked, { recursive: true, force: true });
    r.dispose();
  }
});

test("restore: a damaged persisted record is dropped instead of breaking startup", async () => {
  const storage = withStorage();
  const r = realRepo();
  try {
    storage.data.set(
      "yavin.git.repos",
      JSON.stringify({
        schemaVersion: 1,
        repositories: [
          null,
          { commonDirHint: 5, worktrees: [r.root] },
          { commonDirHint: r.root, worktrees: "nope" },
          { commonDirHint: r.root, worktrees: [7, r.root] },
        ],
      }),
    );
    const restored = new GitRegistry();
    await restored.restore();
    assert.deepEqual(
      restored.getSnapshot().repos.map((w) => w.root),
      [r.root.replace(/\\/g, "/")], // the registry keeps Git's forward-slash form
    );
  } finally {
    storage.restore();
    r.dispose();
  }
});

test("a worktree deleted while open is marked missing and the main worktree becomes active", async () => {
  const storage = withStorage();
  const { r, registry, main, second, linked } = await twoWorktrees();
  try {
    assert.equal(second.status, "ready");
    rmSync(linked, { recursive: true, force: true });
    await second.store.refresh(); // what the poll does; the failure triggers the probe
    await settle();

    assert.equal(second.status, "missing");
    assert.equal(main.status, "ready", "the sibling is unaffected");
    assert.equal(registry.getSnapshot().activeWorktreePath, main.root);
    assert.equal(second.store.getSnapshot().stale, true, "its last-known data is flagged");
  } finally {
    storage.restore();
    r.dispose();
  }
});

test("a lone worktree that disappears stays selected as missing so the panel can say so", async () => {
  const storage = withStorage();
  const r = realRepo();
  try {
    const registry = new GitRegistry();
    const only = await registry.open(r.root, { makeActive: true });
    assert.ok(only);
    const before = registry.getSnapshot().activeWorktreePath;
    const moved = `${r.root}-moved`;
    renameSync(r.root, moved);
    await only.store.refresh();
    await settle();
    assert.equal(only.status, "missing");
    assert.equal(registry.getSnapshot().activeWorktreePath, before, "nothing else to select");
    renameSync(moved, r.root);
  } finally {
    storage.restore();
    r.dispose();
  }
});

test("reopening a worktree by another spelling of its path reuses the open entry", async () => {
  const storage = withStorage();
  const r = realRepo();
  try {
    const registry = new GitRegistry();
    const first = await registry.open(r.root, { makeActive: true });
    assert.ok(first);
    // Backslashes and a trailing separator, as a dialog or a typed path hands them over. The
    // lookup used to fold case but not separators, so this spelling missed the open entry.
    // A miss was not visible in the result -- the native open found the same worktree again --
    // but it cost a second `git_open_repo` for a repository already open.
    const respelled = `${r.root.replace(/\//g, "\\")}\\`;
    const opensBefore = nativeCalls.filter((call) => call.command === "git_open_repo").length;
    assert.equal(await registry.open(respelled), first);
    const opensAfter = nativeCalls.filter((call) => call.command === "git_open_repo").length;
    assert.equal(opensAfter, opensBefore, "found without asking native again");
    assert.equal(registry.getSnapshot().repos.length, 1);
  } finally {
    storage.restore();
    r.dispose();
  }
});

test("a worktree whose .git link is removed is invalid, and ready again once it is back", async () => {
  const storage = withStorage();
  const { r, registry, main, second, linked } = await twoWorktrees();
  try {
    const link = join(linked, ".git");
    const original = readFileSync(link);
    rmSync(link);
    await second.store.refresh();
    await settle();
    assert.equal(second.status, "invalid");
    assert.equal(registry.getSnapshot().activeWorktreePath, main.root);

    writeFileSync(link, original);
    await second.store.refresh();
    await settle();
    assert.equal(second.status, "ready", "a successful refresh clears the state");
  } finally {
    storage.restore();
    rmSync(linked, { recursive: true, force: true });
    r.dispose();
  }
});
