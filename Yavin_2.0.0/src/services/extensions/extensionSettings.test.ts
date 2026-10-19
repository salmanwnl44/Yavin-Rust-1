import assert from "node:assert/strict";
import test from "node:test";
import {
  inheritedAt,
  overriddenAt,
  problemOf,
  profileChanges,
  readDraft,
  rowsOf,
  shownAt,
} from "./extensionSettings.ts";
import type { SettingContribution } from "./manifest.ts";

const setting = (over: Partial<SettingContribution>): SettingContribution => ({
  id: "acme.one.size",
  title: "Size",
  description: "Size.",
  type: "number",
  default: 4,
  values: [],
  minimum: 1,
  maximum: 10,
  scope: "both",
  ...over,
});
const SIZE = setting({});
const MODE = setting({
  id: "acme.one.mode",
  type: "enum",
  default: "fast",
  values: ["fast", "slow"],
  minimum: null,
  maximum: null,
});
const LABEL = setting({
  id: "acme.one.label",
  type: "string",
  default: "x",
  minimum: null,
  maximum: null,
});
const ON = setting({
  id: "acme.one.on",
  type: "boolean",
  default: true,
  minimum: null,
  maximum: null,
});

/** A settings registry's `inspect`, as given: user and workspace values per setting. */
const registryOf = (user: Record<string, unknown>, workspace: Record<string, unknown> = {}) => ({
  inspect: (definition: { id: string; default?: unknown }) => {
    const def = [SIZE, MODE, LABEL, ON].find((s) => s.id === definition.id)!.default;
    const w = workspace[definition.id];
    const u = user[definition.id];
    return {
      value: w ?? u ?? def,
      source: w !== undefined ? "workspace" : u !== undefined ? "user" : "default",
      default: def,
      user: u,
      workspace: w,
    } as never;
  },
});
const defined = (id: string) => ({ id }) as never;

test("EXT-18 a setting resolves workspace > profile > user > default, and says where from", () => {
  const rows = rowsOf(
    [SIZE, MODE, LABEL, ON],
    registryOf(
      { "acme.one.size": 3, "acme.one.mode": "slow", "acme.one.on": false },
      { "acme.one.on": true },
    ),
    defined,
    "w" as never,
    { "acme.one.size": 7, "acme.one.label": "profile" },
  );
  const by = Object.fromEntries(rows.map((row) => [row.setting.id, row]));
  assert.deepEqual([by["acme.one.size"].value, by["acme.one.size"].source], [7, "profile"]);
  assert.deepEqual([by["acme.one.mode"].value, by["acme.one.mode"].source], ["slow", "user"]);
  assert.deepEqual(
    [by["acme.one.label"].value, by["acme.one.label"].source],
    ["profile", "profile"],
  );
  assert.deepEqual([by["acme.one.on"].value, by["acme.one.on"].source], [true, "workspace"]);
  // What each level inherits, and what an editor starts from.
  assert.deepEqual(inheritedAt(by["acme.one.size"], "profile"), { value: 3, from: "user" });
  assert.deepEqual(inheritedAt(by["acme.one.size"], "user"), { value: 4, from: "default" });
  assert.equal(shownAt(by["acme.one.size"], "profile"), 7);
  assert.equal(shownAt(by["acme.one.size"], "user"), 3);
  assert.equal(overriddenAt(by["acme.one.label"], "profile"), true);
  assert.equal(overriddenAt(by["acme.one.label"], "user"), false);
});

test("EXT-18 a profile value no longer valid is kept but not applied", () => {
  const [row] = rowsOf([MODE], registryOf({}), defined, null, { "acme.one.mode": "medium" });
  assert.deepEqual(row.profile, { set: true, value: "medium", valid: false });
  assert.deepEqual([row.value, row.source], ["fast", "default"]);
  // Disabled (its settings not registered): the user level is not known, the rest is.
  const [off] = rowsOf([MODE], registryOf({}), () => undefined, null, {});
  assert.equal(off.user.known, false);
  assert.deepEqual([off.value, off.source], ["fast", "default"]);
});

test("EXT-18 values are checked with the native rules", () => {
  assert.equal(problemOf(SIZE, 10), null);
  assert.equal(problemOf(SIZE, 1.5), null);
  assert.match(problemOf(SIZE, 11) ?? "", /from 1 to 10/);
  assert.match(problemOf(SIZE, "5") ?? "", /number/);
  assert.equal(problemOf(LABEL, "é".repeat(1000)), null);
  assert.ok(problemOf(LABEL, "😀".repeat(501)), "UTF-16 units, as natively");
  assert.ok(problemOf(LABEL, "   "));
  assert.ok(problemOf(LABEL, "two\nlines"));
  assert.ok(problemOf(LABEL, "tab\there"));
  assert.match(problemOf(MODE, "medium") ?? "", /one of: fast, slow/);
  assert.ok(problemOf(ON, "true"));
  // A number field's text.
  assert.deepEqual(readDraft(SIZE, "6"), { ok: true, value: 6 });
  assert.deepEqual(readDraft(SIZE, ""), { ok: false, error: "Enter a number." });
  assert.deepEqual(readDraft(SIZE, "abc"), { ok: false, error: "Enter a number." });
  assert.equal(readDraft(SIZE, "0").ok, false);
});

test("EXT-18 a save is the drafts as changes against what they replace -- or the problems, and nothing", () => {
  const rows = rowsOf([SIZE, MODE, LABEL], registryOf({}), defined, null, {
    "acme.one.size": 7,
    "acme.one.mode": "slow",
  });
  const ok = profileChanges(rows, {
    "acme.one.size": { kind: "set", raw: "8" },
    "acme.one.mode": { kind: "reset" },
    "acme.one.label": { kind: "set", raw: "new" },
  });
  assert.deepEqual(ok.problems, {});
  assert.deepEqual(ok.changes, [
    { key: "acme.one.size", value: 8, expected: 7 },
    { key: "acme.one.mode", value: null, expected: "slow" },
    { key: "acme.one.label", value: "new", expected: null },
  ]);
  const bad = profileChanges(rows, {
    "acme.one.size": { kind: "set", raw: "99" },
    "acme.one.label": { kind: "set", raw: "fine" },
  });
  assert.deepEqual(Object.keys(bad.problems), ["acme.one.size"]);
  // A reset of what the profile does not set changes nothing.
  assert.deepEqual(profileChanges(rows, { "acme.one.label": { kind: "reset" } }).changes, []);
});
