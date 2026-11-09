import assert from "node:assert/strict";
import test from "node:test";
import {
  KEYBINDINGS_VERSION,
  KeybindingError,
  USER_KEYBINDINGS_KEY,
  canonicalShortcut,
  createKeybindingsStore,
  isValidShortcut,
  normalizeShortcut,
  shortcutConflicts,
  shortcutFromEvent,
  type ShortcutBinding,
} from "./keybindings.ts";

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
const stored = (storage: MemoryStorage) => JSON.parse(storage.items.get(USER_KEYBINDINGS_KEY)!);

// --- Grammar ------------------------------------------------------------------------------------

test("a valid shortcut needs Mod/Alt for a printable key, but not for a function key", () => {
  for (const ok of [
    "Mod+k",
    "Mod+Shift+p",
    "Alt+a",
    "Mod+,",
    "Mod+Shift+[",
    "F5",
    "Shift+F11",
    "Mod+ArrowUp",
  ])
    assert.equal(isValidShortcut(ok), true, ok);
  for (const bad of [
    "k", // a bare letter would fire while typing
    "Shift+k", // Shift+letter is a capital letter
    "Ctrl+k", // only Mod/Alt/Shift are modifiers
    "Mod+Mod+k", // a modifier twice
    "Mod+Shift+1", // Shift+digit cannot round-trip
    "Mod+", // no key
    "Mod+space", // not a key the matcher understands
    "",
  ])
    assert.equal(isValidShortcut(bad), false, bad);
});

test("canonicalShortcut orders modifiers and normalizes the key; normalize compares them", () => {
  assert.equal(canonicalShortcut("shift+mod+a"), "Mod+Shift+a");
  assert.equal(canonicalShortcut("alt+mod+pageup"), "Mod+Alt+PageUp");
  assert.equal(canonicalShortcut("mod+K"), "Mod+k");
  assert.equal(canonicalShortcut("nope"), undefined);
  assert.equal(normalizeShortcut("Mod+Shift+a"), normalizeShortcut("Shift+Mod+A"));
});

test("shortcutFromEvent builds a layout-independent shortcut from the physical key", () => {
  // A letter via its code, even when another layout would give a different character.
  assert.equal(
    shortcutFromEvent({
      key: "k",
      code: "KeyK",
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
    }),
    "Mod+k",
  );
  // Shift+slash gives "?" in event.key, but the code pins it to the "/" key.
  assert.equal(
    shortcutFromEvent({
      key: "?",
      code: "Slash",
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: true,
    }),
    "Mod+Shift+/",
  );
  assert.equal(
    shortcutFromEvent({
      key: "F5",
      code: "F5",
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
    }),
    "F5",
  );
  // Only modifiers held: nothing to bind.
  assert.equal(
    shortcutFromEvent({
      key: "Control",
      code: "ControlLeft",
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
    }),
    undefined,
  );
  // A bare printable key is refused (would capture typing).
  assert.equal(
    shortcutFromEvent({
      key: "a",
      code: "KeyA",
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
    }),
    undefined,
  );
});

// --- Conflicts ----------------------------------------------------------------------------------

const binding = (over: Partial<ShortcutBinding>): ShortcutBinding => ({
  id: over.id ?? "x",
  label: over.id ?? "x",
  menu: "View",
  defaultShortcut: over.shortcut,
  shortcut: over.shortcut,
  source: "default",
  domain: "window",
  ...over,
});

test("two window commands on the same key conflict; a window/terminal pair does not", () => {
  const conflicts = shortcutConflicts([
    binding({ id: "a", shortcut: "Mod+k" }),
    binding({ id: "b", shortcut: "Mod+k" }),
    binding({ id: "find", shortcut: "Mod+Shift+f", domain: "window" }),
    binding({ id: "terminal.find", shortcut: "Mod+Shift+f", domain: "terminal" }),
    binding({ id: "lonely", shortcut: "Mod+j" }),
  ]);
  assert.deepEqual([...conflicts.get("a")!], ["b"]);
  assert.deepEqual([...conflicts.get("b")!], ["a"]);
  assert.equal(conflicts.has("find"), false, "window/terminal pair is intentional, not a conflict");
  assert.equal(conflicts.has("terminal.find"), false);
  assert.equal(conflicts.has("lonely"), false);
});

// --- Store: assign / unbind / reset -------------------------------------------------------------

test("assign, unbind and reset change what a command resolves to", () => {
  const store = createKeybindingsStore(new MemoryStorage());
  assert.equal(store.resolve("view.find", "Mod+f"), "Mod+f"); // default while nothing is set
  store.assign("view.find", "shift+mod+f");
  assert.equal(store.resolve("view.find", "Mod+f"), "Mod+Shift+f"); // canonicalized
  assert.equal(store.override("view.find"), "Mod+Shift+f");
  store.unbind("view.find");
  assert.equal(store.resolve("view.find", "Mod+f"), undefined); // the default is removed
  assert.equal(store.override("view.find"), null);
  store.reset("view.find");
  assert.equal(store.resolve("view.find", "Mod+f"), "Mod+f"); // the default is back
  assert.equal(store.override("view.find"), undefined);
});

test("an invalid assignment is refused and changes nothing", () => {
  const storage = new MemoryStorage();
  const store = createKeybindingsStore(storage);
  store.assign("a", "Mod+k");
  const before = storage.items.get(USER_KEYBINDINGS_KEY);
  for (const bad of ["k", "Shift+k", "Mod+Shift+1", "nonsense"])
    assert.throws(() => store.assign("a", bad), KeybindingError, bad);
  assert.equal(store.override("a"), "Mod+k");
  assert.equal(storage.items.get(USER_KEYBINDINGS_KEY), before);
});

test("overrides are kept, versioned and read back after a restart", () => {
  const storage = new MemoryStorage();
  const first = createKeybindingsStore(storage);
  first.assign("a", "Mod+k");
  first.unbind("b");
  assert.deepEqual(stored(storage), {
    version: KEYBINDINGS_VERSION,
    bindings: { a: "Mod+k", b: null },
  });
  const second = createKeybindingsStore(storage);
  assert.equal(second.resolve("a", "Mod+x"), "Mod+k");
  assert.equal(second.resolve("b", "Mod+b"), undefined);
  assert.deepEqual(second.takeProblems(), []);
});

test("resetAll drops every override", () => {
  const store = createKeybindingsStore(new MemoryStorage());
  store.assign("a", "Mod+k");
  store.assign("c", "Mod+j");
  store.resetAll();
  assert.equal(store.override("a"), undefined);
  assert.equal(store.override("c"), undefined);
});

// --- Store: defensive loading -------------------------------------------------------------------

test("an invalid stored binding is dropped and reported; its valid siblings and unknown ids stand", () => {
  const storage = new MemoryStorage();
  storage.setItem(
    USER_KEYBINDINGS_KEY,
    JSON.stringify({
      version: 1,
      bindings: { good: "Mod+k", bad: "k", removed: null, future: "Mod+z" },
    }),
  );
  const store = createKeybindingsStore(storage);
  assert.equal(store.resolve("good", "Mod+x"), "Mod+k");
  assert.equal(store.override("bad"), undefined, "the invalid key was dropped");
  assert.equal(store.override("removed"), null);
  assert.equal(store.resolve("future", "Mod+y"), "Mod+z", "an unknown command's override is kept");
  const problems = store.takeProblems();
  assert.equal(problems.length, 1);
  assert.match(problems[0], /not valid/);
});

test("a corrupt record is kept aside and the defaults apply", () => {
  for (const text of [
    "not json",
    "[]",
    '{"version":1}',
    '{"bindings":{}}',
    '{"version":"1","bindings":{}}',
  ]) {
    const storage = new MemoryStorage();
    storage.setItem(USER_KEYBINDINGS_KEY, text);
    const store = createKeybindingsStore(storage);
    assert.equal(store.resolve("a", "Mod+a"), "Mod+a", text);
    assert.equal(storage.items.get(`${USER_KEYBINDINGS_KEY}.corrupt`), text, text);
    assert.match(store.takeProblems().join(" "), /could not be read; the defaults apply/);
    // Writing after recovery does not clobber the kept-aside copy.
    store.assign("a", "Mod+k");
    assert.equal(stored(storage).bindings.a, "Mod+k");
    assert.equal(storage.items.get(`${USER_KEYBINDINGS_KEY}.corrupt`), text);
  }
});

test("shortcuts saved by a newer Yavin are not read and never written over", () => {
  const storage = new MemoryStorage();
  const theirs = JSON.stringify({ version: 99, bindings: { a: "Mod+k" }, more: true });
  storage.setItem(USER_KEYBINDINGS_KEY, theirs);
  const store = createKeybindingsStore(storage);
  assert.equal(store.resolve("a", "Mod+x"), "Mod+x", "their override is not read");
  store.assign("a", "Mod+j"); // applies for this window
  assert.equal(store.resolve("a", "Mod+x"), "Mod+j");
  assert.equal(storage.items.get(USER_KEYBINDINGS_KEY), theirs, "their record is untouched");
  assert.match(store.takeProblems().join(" "), /newer version of Yavin/);
});

test("storage that cannot be read or written: shortcuts still apply, and it is said", () => {
  const storage = new MemoryStorage();
  storage.failReads = true;
  storage.failWrites = true;
  const store = createKeybindingsStore(storage);
  store.assign("a", "Mod+k");
  assert.equal(store.resolve("a", "Mod+x"), "Mod+k");
  const problems = store.takeProblems().join(" ");
  assert.match(problems, /could not be read from storage/);
  assert.match(problems, /could not be saved/);
  const none = createKeybindingsStore(null);
  none.assign("a", "Mod+k");
  assert.equal(none.resolve("a", "Mod+x"), "Mod+k");
});

test("subscribers hear assigns, unbinds and resets", () => {
  const store = createKeybindingsStore(new MemoryStorage());
  let fired = 0;
  const off = store.subscribe(() => fired++);
  store.assign("a", "Mod+k");
  store.assign("a", "Mod+k"); // no change
  store.unbind("a");
  store.reset("a");
  assert.equal(fired, 3);
  off();
  store.assign("b", "Mod+j");
  assert.equal(fired, 3);
});
