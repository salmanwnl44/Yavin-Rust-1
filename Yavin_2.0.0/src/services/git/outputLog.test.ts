import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import {
  clearGitLog,
  formatGitLogEntry,
  gitLogSnapshot,
  recordGitEnd,
  recordGitStart,
  redactUrlCredentials,
  subscribeGitLog,
} from "./outputLog.ts";

beforeEach(() => clearGitLog());

test("a started command is visible before it finishes, so a hung push can be seen", () => {
  recordGitStart("/repo", ["push", "origin", "main"]);
  const [entry] = gitLogSnapshot();
  assert.deepEqual(entry.args, ["push", "origin", "main"]);
  assert.equal(entry.code, undefined);
  assert.match(formatGitLogEntry(entry), /running…$/);
});

test("finishing records the exit code, duration and stderr", () => {
  const id = recordGitStart("/repo", ["status"]);
  recordGitEnd(id, { code: 1, stderr: "fatal: not a git repository" });
  const [entry] = gitLogSnapshot();
  assert.equal(entry.code, 1);
  assert.equal(entry.stderr, "fatal: not a git repository");
  assert.equal(typeof entry.durationMs, "number");
  assert.match(formatGitLogEntry(entry), /exit 1/);
});

test("an IPC-level failure is distinguished from Git exiting nonzero", () => {
  const id = recordGitStart("/repo", ["push"]);
  recordGitEnd(id, { error: "Error: refused by validation" });
  const [entry] = gitLogSnapshot();
  assert.equal(entry.code, -1);
  assert.match(entry.error ?? "", /refused by validation/);
  assert.match(formatGitLogEntry(entry), /failed:/);
});

test("credentials in a remote URL never reach the log", () => {
  recordGitStart("/repo", ["push", "https://x-access-token:ghp_secret123@github.com/o/r.git"]);
  const [entry] = gitLogSnapshot();
  assert.equal(entry.args[1], "https://***@github.com/o/r.git");
  assert.ok(!JSON.stringify(gitLogSnapshot()).includes("ghp_secret123"));
});

test("credentials are redacted out of stderr too, where Git tends to echo the URL back", () => {
  const id = recordGitStart("/repo", ["push"]);
  recordGitEnd(id, {
    code: 128,
    stderr: "fatal: could not read from 'https://user:hunter2@example.com/r.git'",
  });
  assert.ok(!JSON.stringify(gitLogSnapshot()).includes("hunter2"));
  assert.match(gitLogSnapshot()[0].stderr ?? "", /https:\/\/\*\*\*@example\.com/);
});

test("redaction leaves a credential-free URL exactly as it was", () => {
  assert.equal(
    redactUrlCredentials("https://github.com/owner/repo.git"),
    "https://github.com/owner/repo.git",
  );
  assert.equal(redactUrlCredentials("--set-upstream"), "--set-upstream");
});

test("stdin content is never stored, only its size -- it is the user's source code", () => {
  const patch = "diff --git a/secret.ts b/secret.ts\n+password";
  recordGitStart("/repo", ["apply", "--cached"], patch);
  const [entry] = gitLogSnapshot();
  assert.equal(entry.inputBytes, patch.length);
  assert.ok(!JSON.stringify(gitLogSnapshot()).includes("password"));
});

test("the log is capped, dropping the oldest entries rather than growing without bound", () => {
  for (let i = 0; i < 600; i++) recordGitStart("/repo", ["status", String(i)]);
  const snapshot = gitLogSnapshot();
  assert.equal(snapshot.length, 500);
  // The survivors are the newest 500: 100..599.
  assert.deepEqual(snapshot[0].args, ["status", "100"]);
  assert.deepEqual(snapshot[snapshot.length - 1].args, ["status", "599"]);
});

test("closing out an entry that the capacity trim already dropped is a no-op, not a throw", () => {
  const id = recordGitStart("/repo", ["status"]);
  for (let i = 0; i < 600; i++) recordGitStart("/repo", ["status", String(i)]);
  assert.doesNotThrow(() => recordGitEnd(id, { code: 0 }));
});

test("the snapshot identity changes on every write, so useSyncExternalStore re-renders", () => {
  const before = gitLogSnapshot();
  const id = recordGitStart("/repo", ["status"]);
  const afterStart = gitLogSnapshot();
  recordGitEnd(id, { code: 0 });
  const afterEnd = gitLogSnapshot();
  assert.notEqual(before, afterStart);
  assert.notEqual(afterStart, afterEnd);
});

test("the snapshot identity is stable between writes, so useSyncExternalStore does not loop", () => {
  recordGitStart("/repo", ["status"]);
  assert.equal(gitLogSnapshot(), gitLogSnapshot());
});

test("subscribers are notified on write and stop being notified once unsubscribed", () => {
  let calls = 0;
  const unsubscribe = subscribeGitLog(() => calls++);
  const id = recordGitStart("/repo", ["status"]);
  recordGitEnd(id, { code: 0 });
  assert.equal(calls, 2);
  unsubscribe();
  recordGitStart("/repo", ["status"]);
  assert.equal(calls, 2);
});
