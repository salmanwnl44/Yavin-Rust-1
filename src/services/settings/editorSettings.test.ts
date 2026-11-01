import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_EDITOR_SETTINGS,
  EDITOR_SETTINGS,
  EDITOR_SETTING_LIST,
  editorOptions,
  resolveEditorSettings,
} from "../../editor/editorSettings.ts";
import { createSettingsRegistry, USER_SETTINGS_KEY } from "./settings.ts";
import type { WorkspaceId } from "../terminalProtocol.ts";

const A = "file://c:/a" as WorkspaceId;
const B = "file://c:/b" as WorkspaceId;

class MemoryStorage {
  readonly items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
}

test("with nothing set, the editor looks exactly as it did before settings existed", () => {
  const registry = createSettingsRegistry(EDITOR_SETTING_LIST, new MemoryStorage());
  const resolved = resolveEditorSettings(registry, A);
  assert.deepEqual(resolved.settings, DEFAULT_EDITOR_SETTINGS);
  assert.equal(resolved.wordWrap, false);
  assert.equal(resolved.zoom, 1);
});

test("font, size, tabs, line numbers, wrap, theme and zoom reach the editor's options", () => {
  const registry = createSettingsRegistry(EDITOR_SETTING_LIST, new MemoryStorage());
  registry.set(EDITOR_SETTINGS.fontFamily, "user", "Fira Code, monospace");
  registry.set(EDITOR_SETTINGS.fontSize, "user", 16);
  registry.set(EDITOR_SETTINGS.tabSize, "user", 4);
  registry.set(EDITOR_SETTINGS.insertSpaces, "user", false);
  registry.set(EDITOR_SETTINGS.lineNumbers, "user", "relative");
  registry.set(EDITOR_SETTINGS.wordWrap, "user", true);
  registry.set(EDITOR_SETTINGS.theme, "user", "yavin-light");
  registry.set(EDITOR_SETTINGS.zoom, "user", 1.5);
  const { settings, wordWrap, zoom } = resolveEditorSettings(registry, A);
  const options = editorOptions(settings, { wordWrap, zoom, readOnly: false, ariaLabel: "x" });
  assert.equal(options.fontFamily, "Fira Code, monospace");
  assert.equal(options.fontSize, 24); // 16 at 150%
  assert.equal(options.lineHeight, Math.round(Math.round(16 * (22 / 13)) * 1.5)); // grows with it
  assert.equal(options.tabSize, 4);
  assert.equal(options.insertSpaces, false);
  assert.equal(options.lineNumbers, "relative");
  assert.equal(options.wordWrap, "on");
  assert.equal(options.theme, "yavin-light");
});

test("each setting refuses what the editor cannot use", () => {
  const registry = createSettingsRegistry(EDITOR_SETTING_LIST, new MemoryStorage());
  for (const [definition, value] of [
    [EDITOR_SETTINGS.fontSize, 3],
    [EDITOR_SETTINGS.fontSize, 12.5],
    [EDITOR_SETTINGS.tabSize, 0],
    [EDITOR_SETTINGS.lineNumbers, "interval"],
    [EDITOR_SETTINGS.theme, "yavin-purple"], // only the two themes Yavin has
    [EDITOR_SETTINGS.zoom, 5],
    [EDITOR_SETTINGS.fontFamily, ""],
  ] as const)
    assert.throws(() => registry.set(definition as never, "user", value as never), /not a valid/);
  // Zoom is the window's: a user setting only.
  assert.throws(() => registry.set(EDITOR_SETTINGS.zoom, "workspace", 1.2, A), /cannot be set/);
});

test("a workspace's editor settings are its own; the user's apply elsewhere", () => {
  const registry = createSettingsRegistry(EDITOR_SETTING_LIST, new MemoryStorage());
  registry.set(EDITOR_SETTINGS.tabSize, "user", 4);
  registry.set(EDITOR_SETTINGS.tabSize, "workspace", 8, A);
  assert.equal(resolveEditorSettings(registry, A).settings.tabSize, 8);
  assert.equal(resolveEditorSettings(registry, B).settings.tabSize, 4);
  assert.equal(resolveEditorSettings(registry, null).settings.tabSize, 4);
});

test("editor settings survive a restart", () => {
  const storage = new MemoryStorage();
  const before = createSettingsRegistry(EDITOR_SETTING_LIST, storage);
  before.set(EDITOR_SETTINGS.theme, "user", "yavin-light");
  before.set(EDITOR_SETTINGS.zoom, "user", 1.3);
  before.set(EDITOR_SETTINGS.wordWrap, "workspace", true, A);
  assert.ok(storage.items.has(USER_SETTINGS_KEY));
  const after = createSettingsRegistry(EDITOR_SETTING_LIST, storage);
  const inA = resolveEditorSettings(after, A);
  assert.equal(inA.settings.theme, "yavin-light");
  assert.equal(inA.zoom, 1.3);
  assert.equal(inA.wordWrap, true);
  assert.equal(resolveEditorSettings(after, B).wordWrap, false);
});
