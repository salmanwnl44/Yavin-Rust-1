import assert from "node:assert/strict";
import test from "node:test";
import {
  SETTINGS_VERSION,
  SettingsError,
  USER_SETTINGS_KEY,
  booleanSetting,
  createSettingsRegistry,
  enumSetting,
  numberSetting,
  stringSetting,
  workspaceSettingsKey,
  type SettingChange,
} from "./settings.ts";
import type { WorkspaceId } from "../terminalProtocol.ts";

const A = "file://c:/a" as WorkspaceId;
const B = "file://c:/b" as WorkspaceId;

const size = numberSetting({
  id: "test.size",
  title: "Size",
  description: "",
  section: "Test",
  default: 14,
  min: 6,
  max: 48,
  integer: true,
});
const wrap = booleanSetting({
  id: "test.wrap",
  title: "",
  description: "",
  section: "Test",
  default: false,
});
const mode = enumSetting({
  id: "test.mode",
  title: "",
  description: "",
  section: "Test",
  default: "a",
  options: [
    { value: "a", label: "A" },
    { value: "b", label: "B" },
  ],
});
const font = stringSetting({
  id: "test.font",
  title: "",
  description: "",
  section: "Test",
  default: "mono",
  maxLength: 20,
});
const userOnly = numberSetting({
  id: "test.zoom",
  title: "",
  description: "",
  section: "Test",
  default: 1,
  min: 0.5,
  max: 2,
  scopes: ["user"],
});
const ALL = [size, wrap, mode, font, userOnly];

class MemoryStorage {
  readonly items = new Map<string, string>();
  failReads = false;
  failWrites = false;
  getItem(key: string) {
    if (this.failReads) throw new Error("blocked");
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.failWrites) throw new Error("full");
    this.items.set(key, value);
  }
}
const stored = (storage: MemoryStorage, key: string) => JSON.parse(storage.items.get(key)!);

test("default, then user, then workspace: each overrides the one before", () => {
  const settings = createSettingsRegistry(ALL, new MemoryStorage());
  assert.equal(settings.get(size, A), 14);
  settings.set(size, "user", 18);
  assert.equal(settings.get(size, A), 18);
  assert.equal(settings.get(size, null), 18);
  settings.set(size, "workspace", 20, A);
  assert.equal(settings.get(size, A), 20);
  assert.deepEqual(settings.inspect(size, A), {
    value: 20,
    source: "workspace",
    default: 14,
    user: 18,
    workspace: 20,
  });
});

test("reset gives back the next scope's value, not the default", () => {
  const settings = createSettingsRegistry(ALL, new MemoryStorage());
  settings.set(size, "user", 18);
  settings.set(size, "workspace", 20, A);
  settings.reset(size, "workspace", A);
  assert.equal(settings.get(size, A), 18);
  settings.reset(size, "user");
  assert.equal(settings.get(size, A), 14);
  assert.equal(settings.inspect(size, A).source, "default");
});

test("workspaces never see each other's values", () => {
  const settings = createSettingsRegistry(ALL, new MemoryStorage());
  settings.set(size, "workspace", 20, A);
  settings.set(size, "workspace", 9, B);
  assert.equal(settings.get(size, A), 20);
  assert.equal(settings.get(size, B), 9);
  settings.set(size, "workspace", 30, A);
  assert.equal(settings.get(size, B), 9);
  settings.reset(size, "workspace", A);
  assert.equal(settings.get(size, B), 9);
});

test("an invalid value is refused at runtime and changes nothing", () => {
  const storage = new MemoryStorage();
  const settings = createSettingsRegistry(ALL, storage);
  settings.set(size, "user", 18);
  const before = storage.items.get(USER_SETTINGS_KEY);
  for (const [definition, value] of [
    [size, 5],
    [size, 13.5],
    [size, "14"],
    [wrap, "yes"],
    [mode, "c"],
    [font, ""],
    [font, "a\nb"],
    [font, "x".repeat(21)],
  ] as const)
    assert.throws(
      () => settings.set(definition as typeof size, "user", value as never),
      SettingsError,
    );
  assert.equal(settings.get(size, null), 18);
  assert.equal(storage.items.get(USER_SETTINGS_KEY), before);
  // A scope it cannot have, a workspace setting with no workspace, an unknown setting.
  assert.throws(() => settings.set(userOnly, "workspace", 1.5, A), /cannot be set for a workspace/);
  assert.throws(() => settings.set(size, "workspace", 16), /needs a workspace/);
  const stranger = numberSetting({
    id: "test.unknown",
    title: "",
    description: "",
    section: "Test",
    default: 14,
    min: 6,
    max: 48,
  });
  assert.throws(() => settings.set(stranger, "user", 16), /no setting/);
});

test("settings are kept, versioned, and read back after a restart", () => {
  const storage = new MemoryStorage();
  const first = createSettingsRegistry(ALL, storage);
  first.set(size, "user", 18);
  first.set(mode, "workspace", "b", A);
  first.set(userOnly, "user", 1.2);
  assert.deepEqual(stored(storage, USER_SETTINGS_KEY), {
    version: SETTINGS_VERSION,
    values: { "test.size": 18, "test.zoom": 1.2 },
  });
  const second = createSettingsRegistry(ALL, storage);
  assert.equal(second.get(size, A), 18);
  assert.equal(second.get(mode, A), "b");
  assert.equal(second.get(mode, B), "a");
  assert.equal(second.get(userOnly, A), 1.2);
  assert.deepEqual(second.takeProblems(), []);
});

test("an invalid stored value is ignored, reported, and kept; its valid siblings stand", () => {
  const storage = new MemoryStorage();
  storage.setItem(
    USER_SETTINGS_KEY,
    JSON.stringify({
      version: 1,
      values: { "test.size": 999, "test.wrap": true, "test.mode": "nonsense", "future.setting": 3 },
    }),
  );
  const settings = createSettingsRegistry(ALL, storage);
  assert.equal(settings.get(size, null), 14); // invalid: the default applies
  assert.equal(settings.get(wrap, null), true); // its valid sibling stands
  assert.equal(settings.get(mode, null), "a");
  const problems = settings.takeProblems();
  assert.equal(problems.length, 2);
  assert.match(problems[0], /"test.size" has a value that is not valid \(999\)/);
  // Writing another setting keeps what it could not use, and what it does not know.
  settings.set(wrap, "user", false);
  assert.deepEqual(stored(storage, USER_SETTINGS_KEY).values, {
    "test.size": 999,
    "test.wrap": false,
    "test.mode": "nonsense",
    "future.setting": 3,
  });
  // Setting it validly replaces the invalid value.
  settings.set(size, "user", 16);
  assert.equal(stored(storage, USER_SETTINGS_KEY).values["test.size"], 16);
});

test("malformed or truncated settings are kept aside, and the defaults apply", () => {
  for (const text of [
    '{"version":1,"values":{"test.si',
    "not json",
    "[]",
    '{"version":"1"}',
    '{"values":{}}',
  ]) {
    const storage = new MemoryStorage();
    storage.setItem(USER_SETTINGS_KEY, text);
    const settings = createSettingsRegistry(ALL, storage);
    assert.equal(settings.get(size, null), 14, text);
    assert.equal(storage.items.get(`${USER_SETTINGS_KEY}.corrupt`), text);
    assert.match(
      settings.takeProblems().join(" "),
      /could not be read; defaults apply\. What was there was kept/,
    );
    // Said once.
    assert.deepEqual(settings.takeProblems(), []);
    settings.set(size, "user", 20);
    assert.equal(stored(storage, USER_SETTINGS_KEY).values["test.size"], 20);
    assert.equal(storage.items.get(`${USER_SETTINGS_KEY}.corrupt`), text);
  }
});

test("settings saved by a newer Yavin are not read and never written over", () => {
  const storage = new MemoryStorage();
  const theirs = JSON.stringify({ version: 99, values: { "test.size": 30 }, more: true });
  storage.setItem(workspaceSettingsKey(A), theirs);
  const settings = createSettingsRegistry(ALL, storage);
  assert.equal(settings.get(size, A), 14);
  settings.set(size, "workspace", 22, A);
  assert.equal(settings.get(size, A), 22); // for this window
  assert.equal(storage.items.get(workspaceSettingsKey(A)), theirs);
  assert.match(settings.takeProblems().join(" "), /newer version of Yavin/);
});

test("storage that cannot be read or written: settings still apply, and it is said", () => {
  const storage = new MemoryStorage();
  storage.failReads = true;
  storage.failWrites = true;
  const settings = createSettingsRegistry(ALL, storage);
  settings.set(size, "user", 18);
  assert.equal(settings.get(size, null), 18);
  const problems = settings.takeProblems().join(" ");
  assert.match(problems, /could not be read from storage/);
  assert.match(problems, /could not be saved/);
  const none = createSettingsRegistry(ALL, null);
  none.set(size, "user", 19);
  assert.equal(none.get(size, null), 19);
});

test("listeners hear their workspace's changes -- previous, value, source -- and only those", () => {
  const settings = createSettingsRegistry(ALL, new MemoryStorage());
  const inA: SettingChange[] = [];
  const inB: SettingChange[] = [];
  const stopA = settings.subscribe(A, (change) => inA.push(change));
  settings.subscribe(B, (change) => inB.push(change));
  settings.set(size, "user", 18); // both see it
  settings.set(size, "workspace", 20, A); // only A
  settings.set(size, "user", 16); // B sees it; A's override hides it from A
  settings.set(size, "user", 16); // no change at all: nobody
  assert.deepEqual(inA, [
    { id: "test.size", workspace: A, previous: 14, value: 18, source: "user" },
    { id: "test.size", workspace: A, previous: 18, value: 20, source: "workspace" },
  ]);
  assert.deepEqual(
    inB.map((change) => [change.previous, change.value]),
    [
      [14, 18],
      [18, 16],
    ],
  );
  settings.reset(size, "workspace", A);
  assert.deepEqual(inA.at(-1), {
    id: "test.size",
    workspace: A,
    previous: 20,
    value: 16,
    source: "user",
  });
  // Unsubscribed: hears nothing more.
  stopA();
  settings.set(size, "user", 12);
  assert.equal(inA.length, 3);
  // A listener that throws stops nobody.
  settings.subscribe(B, () => {
    throw new Error("boom");
  });
  settings.set(size, "user", 13);
  assert.equal(inB.at(-1)!.value, 13);
});
