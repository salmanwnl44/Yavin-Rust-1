import assert from "node:assert/strict";
import test from "node:test";
import { asSession, EMPTY_SESSION, lastFolder, workspaceIn } from "./session.ts";

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

test("views and the layout are read back, and damaged entries of them drop out", () => {
  const session = asSession({
    folders: ["/work"],
    workspaces: [
      {
        folder: "/work",
        workspaceId: "file:///work",
        files: ["/work/a.ts", "/work/b.ts"],
        active: "/work/a.ts",
        views: [
          { file: "/work/a.ts", line: 4, column: 2, topLine: 1, topDelta: 0, scrollLeft: 0 },
          // Not open, not a position, not even an object: each drops out alone.
          { file: "/work/closed.ts", line: 1, column: 1 },
          { file: "/work/b.ts", line: 0, column: 1 },
          "nonsense",
        ],
        layout: { sidebarView: "debug", sidebarOpen: true, panelOpen: true },
      },
      { folder: "/other", files: [], layout: { sidebarView: "<script>" } },
    ],
  });
  const [work, other] = session.workspaces;
  assert.equal(work.workspaceId, "file:///work");
  assert.deepEqual(
    work.views?.map((view) => [view.file, view.line, view.column]),
    [["/work/a.ts", 4, 2]],
  );
  assert.deepEqual(work.layout, { sidebarView: "debug", sidebarOpen: true, panelOpen: true });
  assert.equal(other.layout, null);
  assert.equal(other.workspaceId, undefined);
});
