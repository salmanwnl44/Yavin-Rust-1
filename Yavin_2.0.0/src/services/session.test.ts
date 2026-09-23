import assert from "node:assert/strict";
import test from "node:test";
import {
  asSession,
  createSessionWriter,
  EMPTY_SESSION,
  lastFolder,
  workspaceIn,
} from "./session.ts";
import type { WorkspaceSession } from "./session.ts";

const state = (folder: string, files: string[] = []): WorkspaceSession => ({
  folder,
  files,
  active: files[0] ?? null,
  expanded: [],
  scroll: 0,
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a session file that is missing or empty reads as a first run", () => {
  assert.deepEqual(asSession(null), EMPTY_SESSION);
  assert.deepEqual(asSession(undefined), EMPTY_SESSION);
  assert.deepEqual(asSession({}), EMPTY_SESSION);
});

test("entries that are not the expected shape drop out rather than reaching the UI", () => {
  // The file lives in the user's config directory and is meant to be editable by hand.
  const session = asSession({
    folders: ["/work", 7, null, "/other"],
    workspaces: [
      { folder: "/work", files: ["/work/a.ts", 3], expanded: "everything", scroll: "far" },
      { files: ["/orphan.ts"] },
      null,
    ],
  });
  assert.deepEqual(session.folders, ["/work", "/other"]);
  assert.equal(session.workspaces.length, 1, "the entry with no folder is not a workspace");
  assert.deepEqual(session.workspaces[0].files, ["/work/a.ts"]);
  assert.deepEqual(session.workspaces[0].expanded, []);
  assert.equal(session.workspaces[0].scroll, 0);
});

test("an active tab that is not open is not restored", () => {
  const session = asSession({
    workspaces: [{ folder: "/work", files: ["/work/a.ts"], active: "/work/closed.ts" }],
  });
  assert.equal(session.workspaces[0].active, null);
});

test("the folder to reopen is the most recent one, and nothing on a first run", () => {
  assert.equal(lastFolder(asSession({ folders: ["/work", "/older"] })), "/work");
  assert.equal(lastFolder(EMPTY_SESSION), null);
});

test("a folder's state is found however the path is spelled", () => {
  // The dialog hands back backslashes; a path typed into the recent list may not.
  const session = asSession({
    workspaces: [{ folder: "C:\\Work\\Project", files: ["C:\\Work\\Project\\a.ts"] }],
  });
  assert.ok(workspaceIn(session, "c:/work/project"));
  assert.equal(workspaceIn(session, "c:/work/other"), undefined);
});

test("a burst of changes is written once, with the last state", async () => {
  // Opening a tab, switching to it and unfolding a directory are three changes in a moment;
  // each is a full snapshot, so only the last one is worth writing.
  const written: WorkspaceSession[] = [];
  const writer = createSessionWriter(async (next) => void written.push(next), 10);
  writer.save(state("/work", ["a.ts"]));
  writer.save(state("/work", ["a.ts", "b.ts"]));
  writer.save(state("/work", ["a.ts", "b.ts", "c.ts"]));
  assert.equal(written.length, 0, "nothing is written while the changes are still arriving");

  await wait(30);
  assert.equal(written.length, 1);
  assert.deepEqual(written[0].files, ["a.ts", "b.ts", "c.ts"]);
});

test("a later change is written too, rather than being swallowed by the first window", async () => {
  const written: WorkspaceSession[] = [];
  const writer = createSessionWriter(async (next) => void written.push(next), 10);
  writer.save(state("/work", ["a.ts"]));
  await wait(30);
  writer.save(state("/work", ["a.ts", "b.ts"]));
  await wait(30);
  assert.equal(written.length, 2);
});

test("closing the window writes what is pending immediately", async () => {
  const written: WorkspaceSession[] = [];
  const writer = createSessionWriter(async (next) => void written.push(next), 10_000);
  writer.save(state("/work", ["a.ts"]));
  await writer.flush();
  assert.equal(written.length, 1);
  // And the pending state is cleared, so the timer cannot write it a second time.
  await wait(20);
  assert.equal(written.length, 1);
});

test("flushing with nothing pending writes nothing", async () => {
  const written: WorkspaceSession[] = [];
  const writer = createSessionWriter(async (next) => void written.push(next), 10);
  await writer.flush();
  assert.equal(written.length, 0);
});

test("a save that fails does not reject into the caller", async () => {
  // Saves are fired from render effects; an unhandled rejection there is a crash report for
  // something whose worst outcome is reopening a folder by hand.
  const writer = createSessionWriter(async () => {
    throw new Error("no config directory");
  }, 5);
  writer.save(state("/work"));
  await writer.flush();
  await wait(20);
});
