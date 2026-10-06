import assert from "node:assert/strict";
import test from "node:test";
import { fileUri, resourceId } from "./resource.ts";
import type { Session, WorkspaceSession } from "./session.ts";
import { workspaceIdOf, type WorkspaceId } from "./workspaceManager.ts";
import {
  canMoveSession,
  createSessionCoordinator,
  fileViewOf,
  savedFor,
  SessionError,
  snapshotSession,
  viewStateOf,
  type SessionParts,
} from "./workspaceSession.ts";

const A = workspaceIdOf(["C:/work/a"]);
const B = workspaceIdOf(["C:/work/b"]);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** What the window holds, as plain values a test changes between snapshots. */
function window() {
  const now = {
    tabs: [] as { key: string; path: string; disk: boolean }[],
    active: null as string | null,
    expanded: [] as string[],
    views: new Map<string, unknown>(),
    layout: { sidebarView: "explorer", sidebarOpen: true, panelOpen: false },
  };
  const parts = (): SessionParts => ({
    tabs: now.tabs,
    active: now.active,
    explorer: { expanded: now.expanded, scroll: 0, selected: [], focused: null },
    viewState: (key) => now.views.get(key) ?? null,
    layout: now.layout,
  });
  return { now, parts };
}

function coordinator(delay = 5) {
  const ui = window();
  const written: WorkspaceSession[] = [];
  const records: WorkspaceSession[] = [];
  let failWrites = false;
  const sessions = createSessionCoordinator({
    write: async (state) => {
      if (failWrites) throw new Error("no config directory");
      written.push(state);
    },
    snapshot: (owner) => snapshotSession(owner, ui.parts()),
    written: (state) => records.push(state),
    delay,
  });
  return { sessions, ui, written, records, failWrites: () => (failWrites = true) };
}

const engineState = (line: number, column: number, top = line) => ({
  cursorState: [
    {
      inSelectionMode: false,
      selectionStart: { lineNumber: line, column },
      position: { lineNumber: line, column },
    },
  ],
  viewState: {
    scrollLeft: 0,
    firstPosition: { lineNumber: top, column: 1 },
    firstPositionDeltaTop: 3,
  },
  contributionsState: { "editor.contrib.folding": { collapsedRegions: [] } },
});

// --- Lifecycle ---------------------------------------------------------------------------------

test("a session moves created → restoring → active ⇄ saving → disposing → disposed, and no other way", () => {
  assert.ok(canMoveSession("created", "restoring"));
  assert.ok(canMoveSession("restoring", "active"));
  assert.ok(canMoveSession("active", "saving"));
  assert.ok(canMoveSession("saving", "active"));
  assert.ok(canMoveSession("restoring", "disposing"));
  assert.ok(canMoveSession("disposing", "disposed"));
  for (const [from, to] of [
    ["created", "active"],
    ["restoring", "saving"],
    ["disposed", "active"],
    ["disposing", "active"],
    ["active", "restoring"],
  ] as const)
    assert.equal(canMoveSession(from, to), false, `${from} -> ${to}`);
});

test("create, restore, active, save, dispose -- and a session is restored only once", async () => {
  const t = coordinator();
  const session = t.sessions.begin({ folder: "C:/work/a", workspaceId: A, saved: null });
  assert.equal(session.state(), "created");
  const states: string[] = [];
  const done = await session.restore(async () => {
    states.push(session.state());
  });
  assert.equal(done, true);
  assert.deepEqual(states, ["restoring"]);
  assert.equal(session.state(), "active");
  await assert.rejects(
    session.restore(async () => {}),
    SessionError,
  );

  t.ui.now.tabs = [{ key: "C:/work/a/x.py", path: "C:/work/a/x.py", disk: true }];
  session.markDirty();
  await wait(20);
  assert.equal(t.written.length, 1);
  assert.equal(session.state(), "active");

  await session.dispose();
  assert.equal(session.state(), "disposed");
  assert.equal(t.sessions.current(), null);
  // Nothing of a disposed session is saved.
  session.markDirty();
  await session.flush();
  assert.equal(t.written.length, 1);
});

test("nothing is saved while a session restores: the half-built window never replaces the record", async () => {
  const t = coordinator();
  const session = t.sessions.begin({ folder: "C:/work/a", workspaceId: A, saved: null });
  await session.restore(async () => {
    // The window passes through "no tabs" on its way to reopening them.
    session.markDirty();
    await wait(20);
  });
  assert.equal(t.written.length, 0);
  session.markDirty();
  await session.flush();
  assert.equal(t.written.length, 1);
});

test("a burst of changes is written once, with the last state; a later one is written too", async () => {
  const t = coordinator(10);
  const session = t.sessions.begin({ folder: "C:/work/a", workspaceId: A, saved: null });
  await session.restore(async () => {});
  for (const name of ["x", "y", "z"]) {
    t.ui.now.tabs = [...t.ui.now.tabs, { key: name, path: `C:/work/a/${name}.py`, disk: true }];
    session.markDirty();
  }
  assert.equal(t.written.length, 0, "nothing while the changes are still arriving");
  await wait(40);
  assert.equal(t.written.length, 1);
  assert.equal(t.written[0].files.length, 3);
  session.markDirty();
  await wait(40);
  assert.equal(t.written.length, 2);
});

test("flushing writes what is pending at once, nothing when nothing is; a failed save rejects nowhere", async () => {
  const t = coordinator(10_000);
  const session = t.sessions.begin({ folder: "C:/work/a", workspaceId: A, saved: null });
  await session.restore(async () => {});
  await session.flush();
  assert.equal(t.written.length, 0);
  session.markDirty();
  await session.flush();
  assert.equal(t.written.length, 1);
  t.failWrites();
  session.markDirty();
  await session.flush();
  assert.equal(session.state(), "active");
});

// --- Workspace isolation and stale restores -----------------------------------------------------

test("switching A → B saves A as it was and ends it; A's late restore result is not applied to B", async () => {
  const t = coordinator();
  const a = t.sessions.begin({ folder: "C:/work/a", workspaceId: A, saved: null });
  await a.restore(async () => {});
  t.ui.now.tabs = [{ key: "C:/work/a/x.py", path: "C:/work/a/x.py", disk: true }];
  t.ui.now.active = "C:/work/a/x.py";
  a.markDirty();

  const b = t.sessions.begin({ folder: "C:/work/b", workspaceId: B, saved: null });
  // A was snapshotted as the switch began -- before the window was cleared for B.
  assert.equal(t.records.at(-1)?.folder, "C:/work/a");
  assert.deepEqual(t.records.at(-1)?.files, ["C:/work/a/x.py"]);
  assert.equal(a.isCurrent(), false);
  assert.equal(b.isCurrent(), true);
  assert.equal(t.sessions.current(), b);
  await wait(10);
  assert.equal(a.state(), "disposed");
  assert.equal(t.written.filter((one) => one.folder === "C:/work/a").length, 1);
});

test("a restore overtaken by another workspace applies nothing and never becomes active", async () => {
  const t = coordinator();
  const a = t.sessions.begin({ folder: "C:/work/a", workspaceId: A, saved: null });
  let applied = false;
  let release!: () => void;
  const slow = a.restore(async (live) => {
    await new Promise<void>((resolve) => (release = resolve));
    // The delayed answer arrives after B was opened.
    if (live()) applied = true;
  });
  const b = t.sessions.begin({ folder: "C:/work/b", workspaceId: B, saved: null });
  release();
  assert.equal(await slow, false);
  assert.equal(applied, false);
  assert.equal(a.state(), "disposed");
  assert.equal(b.state(), "created");
  // A never finished restoring, so its half-built state was not written either.
  await wait(10);
  assert.equal(t.written.length, 0);
});

test("a session disposed during its restore applies nothing", async () => {
  const t = coordinator();
  const a = t.sessions.begin({ folder: "C:/work/a", workspaceId: A, saved: null });
  let release!: () => void;
  let applied = false;
  const restoring = a.restore(async (live) => {
    await new Promise<void>((resolve) => (release = resolve));
    if (live()) applied = true;
  });
  await a.dispose();
  release();
  assert.equal(await restoring, false);
  assert.equal(applied, false);
  assert.equal(a.state(), "disposed");
});

test("two quick switches: the first switch finishing cannot unlock saving while the second restores", async () => {
  // The race the old shared `restoring` flag had: B's restore ending cleared it while C was
  // still restoring, and a save in between wrote C with no tabs over C's real ones.
  const t = coordinator();
  const b = t.sessions.begin({ folder: "C:/work/b", workspaceId: B, saved: null });
  let releaseB!: () => void;
  const restoringB = b.restore(() => new Promise<void>((resolve) => (releaseB = resolve)));
  const C = workspaceIdOf(["C:/work/c"]);
  const c = t.sessions.begin({ folder: "C:/work/c", workspaceId: C, saved: null });
  let releaseC!: () => void;
  const restoringC = c.restore(() => new Promise<void>((resolve) => (releaseC = resolve)));
  releaseB();
  await restoringB;
  // C is still restoring: the window holds nothing of C yet, and nothing may be saved.
  c.markDirty();
  await wait(20);
  assert.equal(t.written.filter((one) => one.folder === "C:/work/c").length, 0);
  releaseC();
  assert.equal(await restoringC, true);
  assert.equal(c.state(), "active");
});

test("a saved record is restored only into its own workspace", () => {
  const session: Session = {
    folders: ["C:/work/a"],
    workspaces: [
      { folder: "C:/Work/A", workspaceId: A, files: [], active: null, expanded: [], scroll: 0 },
    ],
  };
  // However the folder is spelled.
  assert.ok(savedFor(session, "c:\\work\\a", A));
  // A record written for another workspace id (a hand-edited or moved file) is not this one's.
  assert.equal(savedFor(session, "C:/work/a", B), null);
  // Written before IDE-06: no id, matched by folder.
  const old: Session = {
    folders: ["C:/work/a"],
    workspaces: [{ folder: "C:/work/a", files: [], active: null, expanded: [], scroll: 0 }],
  };
  assert.ok(savedFor(old, "C:/work/a", A));
  const t = coordinator();
  const wrong = t.sessions.begin({
    folder: "C:/work/a",
    workspaceId: A,
    saved: { ...old.workspaces[0], workspaceId: B },
  });
  assert.equal(wrong.saved, null);
});

// --- Snapshots ---------------------------------------------------------------------------------

test("a snapshot holds serializable references only: files by resource, the active one, views, layout", () => {
  const ui = window();
  ui.now.tabs = [
    { key: "C:/work/a/x.py", path: "C:/work/a/x.py", disk: true },
    // The same file spelled another way: one entry.
    { key: "c:\\work\\A\\X.py", path: "c:\\work\\A\\X.py", disk: true },
    // Untitled and proposed documents have nothing on disk: DocumentService's alone.
    { key: "untitled:1", path: "untitled:1", disk: false },
    { key: "C:/work/a/y.py", path: "C:/work/a/y.py", disk: true },
  ];
  ui.now.active = "c:\\work\\A\\X.py";
  ui.now.views.set("C:/work/a/x.py", engineState(40, 7, 30));
  ui.now.views.set("untitled:1", engineState(2, 2));
  ui.now.layout = { sidebarView: "debug", sidebarOpen: false, panelOpen: true };
  const record = snapshotSession({ folder: "C:/work/a", workspaceId: A }, ui.parts());
  assert.deepEqual(record.files, ["C:/work/a/x.py", "C:/work/a/y.py"]);
  assert.equal(record.active, "C:/work/a/x.py", "the active tab, by resource identity");
  assert.equal(record.workspaceId, A);
  assert.deepEqual(record.views, [
    { file: "C:/work/a/x.py", line: 40, column: 7, topLine: 30, topDelta: 3, scrollLeft: 0 },
  ]);
  assert.deepEqual(record.layout, { sidebarView: "debug", sidebarOpen: false, panelOpen: true });
  // Plain data that survives JSON unchanged; nothing of a terminal, task, debug session,
  // document content or the engine's own object (its contributions) is in it.
  assert.deepEqual(JSON.parse(JSON.stringify(record)), record);
  const text = JSON.stringify(record);
  for (const forbidden of [
    "contributionsState",
    "cursorState",
    "pid",
    "terminal",
    "task",
    'debug":',
    "content",
  ])
    assert.ok(!text.includes(forbidden), forbidden);
  assert.ok(resourceId(fileUri(record.files[0])));
});

test("a view round-trips to the engine's shape; a selection keeps its anchor; junk is no view", () => {
  const selecting = {
    cursorState: [
      {
        inSelectionMode: true,
        selectionStart: { lineNumber: 3, column: 1 },
        position: { lineNumber: 5, column: 9 },
      },
    ],
    viewState: {
      scrollLeft: 12,
      firstPosition: { lineNumber: 2, column: 1 },
      firstPositionDeltaTop: -4,
    },
  };
  const view = fileViewOf("C:/work/a/x.py", selecting)!;
  assert.deepEqual(view, {
    file: "C:/work/a/x.py",
    line: 5,
    column: 9,
    topLine: 2,
    topDelta: -4,
    scrollLeft: 12,
    anchorLine: 3,
    anchorColumn: 1,
  });
  assert.deepEqual(fileViewOf("C:/work/a/x.py", viewStateOf(view)), view);
  for (const junk of [
    null,
    undefined,
    3,
    {},
    { cursorState: [{ position: { lineNumber: 0, column: 1 } }] },
  ])
    assert.equal(fileViewOf("f", junk), null);
});

test("large working sets are bounded: at most 50 files are remembered", () => {
  const ui = window();
  ui.now.tabs = Array.from({ length: 80 }, (_, i) => ({
    key: `k${i}`,
    path: `C:/work/a/f${i}.py`,
    disk: true,
  }));
  const record = snapshotSession(
    { folder: "C:/work/a", workspaceId: A as WorkspaceId },
    ui.parts(),
  );
  assert.equal(record.files.length, 50);
});
