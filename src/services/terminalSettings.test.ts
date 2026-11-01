import assert from "node:assert/strict";
import test from "node:test";
import {
  TERMINAL_SETTINGS_VERSION,
  USER_KEY,
  createTerminalSettings,
  decodeUserSettings,
  decodeWorkspaceSettings,
  encodeSettings,
  workspaceKey,
  type StoredProfile,
} from "./terminalSettings.ts";
import { createProfileRegistry } from "./terminalProfiles.ts";
import { createTerminalService } from "./terminalService.ts";
import { createTerminalUi } from "./terminalUi.ts";
import { FakeNative } from "./terminalNative.fake.ts";
import type { WorkspaceId } from "./terminalProtocol.ts";

const A = "file://c:/a" as WorkspaceId;
const B = "file://c:/b" as WorkspaceId;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const BASH = "C:/Program Files/Git/bin/bash.exe";
const SHELLS = [
  { name: "Command Prompt", path: "C:/Windows/System32/cmd.exe", kind: "cmd", isDefault: true },
  { name: "Git Bash", path: BASH, kind: "bash" },
];

/** The webview's storage, in memory: what a restart finds is what the last window left. */
class MemoryStorage {
  readonly items = new Map<string, string>();
  failReads = false;
  failWrites = false;
  writes = 0;
  getItem(key: string) {
    if (this.failReads) throw new Error("blocked");
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.failWrites) throw new Error("full");
    this.writes++;
    this.items.set(key, value);
  }
}

const profile = (id: string, extra: Partial<StoredProfile> = {}): StoredProfile => ({
  id,
  name: `Profile ${id}`,
  executable: BASH,
  args: ["--norc"],
  cwd: null,
  env: [["A", "1"]],
  kind: "bash",
  ...extra,
});

// --- The format ---------------------------------------------------------------------------------

test("settings read back as written, under a version", () => {
  const user = {
    profiles: [profile("user-1", { login: true })],
    defaultProfile: "user-1",
    shellIntegration: false,
    layout: { fontSize: 15, splitRatio: 0.3, panelHeight: 400 },
  };
  const text = encodeSettings(user);
  assert.equal(JSON.parse(text).version, TERMINAL_SETTINGS_VERSION);
  assert.deepEqual(decodeUserSettings(text), { value: user, status: "ok", problems: [] });
  const workspace = { profiles: [], defaultProfile: null, shellIntegration: null, layout: null };
  assert.deepEqual(decodeWorkspaceSettings(encodeSettings(workspace)).value, workspace);
});

test("nothing stored is the defaults: integration on, no profiles, no layout", () => {
  const empty = decodeUserSettings(null);
  assert.equal(empty.status, "empty");
  assert.deepEqual(empty.value, {
    profiles: [],
    defaultProfile: null,
    shellIntegration: true,
    layout: null,
  });
});

test("unreadable settings are the defaults; partly unreadable keep what can be read", () => {
  for (const text of ["{not json", "[]", "null", '{"version":"one"}', '{"profiles":[]}'])
    assert.equal(decodeUserSettings(text).status, "corrupt", text);
  const partly = decodeUserSettings(
    JSON.stringify({
      version: 1,
      profiles: [
        profile("good"),
        { ...profile("bad-env"), env: [["A=B", "x"]] },
        { ...profile("builtin.bash") },
        profile("good"),
        "nonsense",
      ],
      defaultProfile: 42,
      shellIntegration: "yes",
      layout: { fontSize: 500, splitRatio: 0.4, panelHeight: "tall" },
    }),
  );
  assert.equal(partly.status, "repaired");
  assert.deepEqual(
    partly.value.profiles.map((p) => p.id),
    ["good"],
  );
  assert.equal(partly.value.defaultProfile, null);
  assert.equal(partly.value.shellIntegration, true);
  // Field by field: the good ratio is kept, the others fall back.
  assert.deepEqual(partly.value.layout, { fontSize: 12, splitRatio: 0.4, panelHeight: 260 });
  assert.equal(partly.problems.length, 8);
});

test("settings from a newer Yavin are not read", () => {
  const newer = decodeUserSettings(JSON.stringify({ version: 99, profiles: [profile("x")] }));
  assert.equal(newer.status, "newer");
  assert.deepEqual(newer.value.profiles, []);
});

// --- The store: recovery ----------------------------------------------------------------------

test("a corrupt record is kept aside before anything is written over it", () => {
  const storage = new MemoryStorage();
  storage.items.set(USER_KEY, "{not json");
  const settings = createTerminalSettings(storage);
  assert.deepEqual(settings.user().profiles, []);
  assert.equal(storage.items.get(`${USER_KEY}.corrupt`), "{not json");
  const problems = settings.takeProblems();
  assert.ok(problems.some((p) => /not valid JSON/.test(p)));
  assert.ok(problems.some((p) => /\.corrupt/.test(p)));
  assert.deepEqual(settings.takeProblems(), []); // said once
  settings.updateUser({ shellIntegration: false });
  assert.equal(JSON.parse(storage.items.get(USER_KEY)!).shellIntegration, false);
  assert.equal(storage.items.get(`${USER_KEY}.corrupt`), "{not json");
});

test("settings written by a newer Yavin are never overwritten", () => {
  const storage = new MemoryStorage();
  const theirs = JSON.stringify({ version: 2, somethingNew: true });
  storage.items.set(USER_KEY, theirs);
  const settings = createTerminalSettings(storage);
  settings.updateUser({ shellIntegration: false });
  settings.updateUser({ layout: { fontSize: 20, splitRatio: 0.5, panelHeight: 300 } });
  settings.flush();
  assert.equal(storage.items.get(USER_KEY), theirs);
  // The change still applies, for this window.
  assert.equal(settings.user().shellIntegration, false);
  assert.ok(settings.takeProblems().some((p) => /newer version/.test(p)));
});

test("storage that cannot be read or written: the settings still apply, and it is said", () => {
  const storage = new MemoryStorage();
  storage.failReads = true;
  storage.failWrites = true;
  const settings = createTerminalSettings(storage);
  assert.equal(settings.user().shellIntegration, true);
  settings.updateUser({ shellIntegration: false });
  assert.equal(settings.user().shellIntegration, false);
  const problems = settings.takeProblems();
  assert.ok(problems.some((p) => /could not be read from storage/.test(p)));
  assert.ok(problems.some((p) => /could not be saved/.test(p)));
  // No storage at all (the browser preview with storage blocked).
  const none = createTerminalSettings(null);
  none.updateUser({ shellIntegration: false });
  assert.equal(none.user().shellIntegration, false);
});

test("configuration is written at once; a layout once it settles", async () => {
  const storage = new MemoryStorage();
  const settings = createTerminalSettings(storage, { delay: 20 });
  settings.updateUser({ defaultProfile: "builtin.cmd" });
  assert.equal(storage.writes, 1);
  // A drag: many changes, one write.
  for (let height = 200; height < 300; height += 5)
    settings.updateUser({ layout: { fontSize: 12, splitRatio: 0.5, panelHeight: height } });
  assert.equal(storage.writes, 1);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(storage.writes, 2);
  assert.equal(JSON.parse(storage.items.get(USER_KEY)!).layout.panelHeight, 295);
  // Leaving the page writes what is waiting.
  settings.updateUser({ layout: { fontSize: 13, splitRatio: 0.5, panelHeight: 295 } });
  settings.flush();
  assert.equal(JSON.parse(storage.items.get(USER_KEY)!).layout.fontSize, 13);
});

test("integration: the workspace's override, else the user's setting, else on", () => {
  const settings = createTerminalSettings(new MemoryStorage());
  assert.equal(settings.shellIntegration(A), true);
  settings.updateUser({ shellIntegration: false });
  assert.equal(settings.shellIntegration(A), false);
  settings.updateWorkspace(A, { shellIntegration: true });
  assert.equal(settings.shellIntegration(A), true);
  assert.equal(settings.shellIntegration(B), false);
  settings.updateWorkspace(A, { shellIntegration: null });
  assert.equal(settings.shellIntegration(A), false);
});

// --- Profiles across a restart ----------------------------------------------------------------

/** One window's registry over `storage`: a new one is a restart. */
async function window_(storage: MemoryStorage, shells: unknown[] = SHELLS) {
  const settings = createTerminalSettings(storage);
  const registry = createProfileRegistry(async () => shells, settings);
  return { settings, registry };
}

test("user and workspace profiles and defaults survive a restart", async () => {
  const storage = new MemoryStorage();
  {
    const { registry } = await window_(storage);
    await registry.load();
    const mine = registry.addUser({ name: "Login bash", executable: BASH, login: true });
    registry.setUserDefault(mine.profile.id);
    const a = registry.forWorkspace(A);
    const project = a.addWorkspace({ name: "Project", executable: BASH, cwd: "tools" });
    a.setWorkspaceDefault(project.profile.id);
  }
  const { registry } = await window_(storage);
  const a = registry.forWorkspace(A);
  // Before discovery answers, what was kept is known but cannot launch yet.
  const early = a.getSnapshot().profiles.filter((entry) => entry.scope !== "builtin");
  assert.deepEqual(
    early.map((entry) => [entry.profile.name, entry.available]),
    [
      ["Login bash", false],
      ["Project", false],
    ],
  );
  await registry.load();
  const snapshot = a.getSnapshot();
  const user = snapshot.profiles.find((entry) => entry.scope === "user")!;
  const project = snapshot.profiles.find((entry) => entry.scope === "workspace")!;
  assert.equal(user.available, true);
  assert.equal(user.profile.login, true);
  assert.equal(project.profile.cwd, "tools");
  assert.equal(snapshot.userDefault, user.profile.id);
  assert.equal(snapshot.workspaceDefault, project.profile.id);
  assert.equal(a.resolve().profile.id, project.profile.id);
  // Another workspace has none of A's own profiles, and A's default does not apply there.
  const b = registry.forWorkspace(B);
  assert.equal(
    b.getSnapshot().profiles.some((entry) => entry.scope === "workspace"),
    false,
  );
  assert.equal(b.resolve().profile.id, user.profile.id);
  // New ids never clash with the kept ones.
  const another = registry.addUser({ name: "Another", executable: BASH });
  assert.notEqual(another.profile.id, user.profile.id);
});

test("a kept profile whose shell is gone is offered, but unavailable; the default passes it by", async () => {
  const storage = new MemoryStorage();
  {
    const { registry } = await window_(storage);
    await registry.load();
    registry.setUserDefault(registry.addUser({ name: "Bash", executable: BASH }).profile.id);
  }
  // Git Bash was uninstalled.
  const { registry } = await window_(storage, [SHELLS[0]]);
  await registry.load();
  const a = registry.forWorkspace(A);
  const kept = a.getSnapshot().profiles.find((entry) => entry.scope === "user")!;
  assert.equal(kept.available, false);
  assert.match(kept.reason!, /not one of the shells found/);
  // Never launched under its name, never silently swapped -- but the default chain goes on.
  assert.throws(() => a.resolve(kept.profile.id), /not one of the shells found/);
  assert.equal(a.resolve().profile.executable, SHELLS[0].path);
});

test("deleting a profile, or its default, is kept too", async () => {
  const storage = new MemoryStorage();
  {
    const { registry } = await window_(storage);
    await registry.load();
    const one = registry.addUser({ name: "One", executable: BASH });
    registry.setUserDefault(one.profile.id);
    registry.removeUser(one.profile.id);
  }
  const { registry } = await window_(storage);
  await registry.load();
  assert.deepEqual(registry.getSnapshot().users, []);
  assert.equal(registry.getSnapshot().userDefault, null);
});

test("changing or deleting a profile never changes a terminal already running", async () => {
  const storage = new MemoryStorage();
  const { settings, registry } = await window_(storage);
  await registry.load();
  const fake = new FakeNative();
  const service = createTerminalService(A, fake);
  const ui = createTerminalUi(service, registry.forWorkspace(A), {
    layout: null,
    saveLayout: () => {},
    shellIntegration: () => settings.shellIntegration(A),
  });
  const mine = registry.addUser({ name: "Mine", executable: BASH, args: ["-i"] });
  const id = ui.newTerminal({ profileId: mine.profile.id });
  await settle();
  registry.updateUser(mine.profile.id, { name: "Renamed", executable: BASH, args: ["-x"] });
  assert.deepEqual(service.get(id)!.profile!.args, ["-i"]);
  assert.equal(service.get(id)!.profileName, "Mine");
  registry.removeUser(mine.profile.id);
  // A restart launches the copy it started with (T05), not the changed or deleted one.
  service.restart(id);
  await settle();
  const opens = fake.calls.filter((call) => call.command === "open");
  const last = opens.at(-1)!.args as { profile: { args: string[] } };
  assert.equal(opens.length, 2);
  assert.deepEqual(last.profile.args, ["-i"]);
});

// --- Layout and integration through the TerminalUi --------------------------------------------

test("the layout starts as kept and is saved as it changes, within limits", async () => {
  const storage = new MemoryStorage();
  const settings = createTerminalSettings(storage);
  const registry = createProfileRegistry(async () => SHELLS, settings);
  const saved: unknown[] = [];
  const ui = createTerminalUi(
    createTerminalService(A, new FakeNative()),
    registry.forWorkspace(A),
    {
      layout: { fontSize: 16, splitRatio: 0.35, panelHeight: 420 },
      saveLayout: (layout) => saved.push(layout),
      shellIntegration: () => true,
    },
  );
  const state = ui.getSnapshot();
  assert.deepEqual([state.fontSize, state.splitRatio, state.panelHeight], [16, 0.35, 420]);
  ui.zoom("zoom-in");
  ui.setPanelHeight(50);
  ui.setSplitRatio(0.95);
  assert.deepEqual(saved.at(-1), { fontSize: 17, splitRatio: 0.8, panelHeight: 120 });
  // Anything else -- focus, find, a notice -- is not layout, and is not saved.
  const count = saved.length;
  ui.openFind();
  ui.requestFocus();
  assert.equal(saved.length, count);
});

test("integration turned off: terminals started from then on do not read their shell", async () => {
  const storage = new MemoryStorage();
  const settings = createTerminalSettings(storage);
  const registry = createProfileRegistry(async () => SHELLS, settings);
  await registry.load();
  const fake = new FakeNative();
  const service = createTerminalService(A, fake);
  const ui = createTerminalUi(service, registry.forWorkspace(A), {
    layout: null,
    saveLayout: () => {},
    shellIntegration: () => settings.shellIntegration(A),
  });
  const bash = registry.getSnapshot().builtins.find((entry) => entry.kind === "bash")!;
  const before = ui.newTerminal({ profileId: bash.profile.id });
  settings.updateWorkspace(A, { shellIntegration: false });
  const after = ui.newTerminal({ profileId: bash.profile.id });
  await settle();
  // The running one keeps how it started.
  assert.equal(service.get(before)!.shell.integration, "available");
  assert.equal(service.get(after)!.shell.integration, "disabled");
  fake.shell(after, service.get(after)!.generation, { signal: "prompt" });
  assert.equal(service.get(after)!.shell.commandState, "idle");
});

test("nothing about sessions is ever kept", async () => {
  const storage = new MemoryStorage();
  const settings = createTerminalSettings(storage);
  const registry = createProfileRegistry(async () => SHELLS, settings);
  await registry.load();
  const fake = new FakeNative();
  const service = createTerminalService(A, fake);
  const ui = createTerminalUi(service, registry.forWorkspace(A), {
    layout: null,
    saveLayout: (layout) => {
      settings.updateWorkspace(A, { layout });
      settings.updateUser({ layout });
    },
    shellIntegration: () => settings.shellIntegration(A),
  });
  registry.addUser({ name: "Mine", executable: BASH });
  const id = ui.newTerminal();
  await settle();
  const generation = service.get(id)!.generation;
  fake.output(id, generation, "secret output\r\n");
  fake.shell(id, generation, { signal: "cwd", uri: "file:///c/somewhere", local: true });
  fake.shell(id, generation, { signal: "executing" });
  fake.shell(id, generation, { signal: "finished", exitCode: 7 });
  ui.zoom("zoom-in");
  settings.flush();
  const kept = [...storage.items.values()].join("\n");
  for (const forbidden of [
    id,
    "secret output",
    "somewhere",
    "4242",
    "exitCode",
    "generation",
    "pid",
  ])
    assert.equal(kept.includes(forbidden), false, forbidden);
  // What is kept: configuration and layout, nothing more.
  for (const text of storage.items.values())
    assert.deepEqual(Object.keys(JSON.parse(text)).sort(), [
      "defaultProfile",
      "layout",
      "profiles",
      "shellIntegration",
      "version",
    ]);
  assert.ok(storage.items.has(workspaceKey(A)));
});
