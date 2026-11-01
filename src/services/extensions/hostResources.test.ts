import assert from "node:assert/strict";
import { test } from "node:test";
import { createSettingsRegistry } from "../settings/settings.ts";
import { HOST_RESOURCE_SETTING_LIST, hostResources } from "./hostResources.ts";

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, String(value)),
  };
}

test("EXT-10 the host's resources are the user's settings, defaults otherwise", () => {
  const settings = createSettingsRegistry([...HOST_RESOURCE_SETTING_LIST], memoryStorage());
  assert.deepEqual(hostResources(settings), {
    memoryMb: 1024,
    extensionMemoryMb: 64,
    cpuCores: 1,
    callMs: 2000,
    loadMs: 5000,
  });
  for (const definition of HOST_RESOURCE_SETTING_LIST)
    assert.deepEqual([...definition.scopes], ["user"], definition.id);
});

test("EXT-10 a value out of bounds is not used; the native side bounds it again", () => {
  for (const definition of HOST_RESOURCE_SETTING_LIST) {
    assert.equal(definition.parse(1e12), undefined, definition.id);
    assert.equal(definition.parse(-1), undefined, definition.id);
    assert.equal(definition.parse("4096"), undefined, definition.id);
  }
});
