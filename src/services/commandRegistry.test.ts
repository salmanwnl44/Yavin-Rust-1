import assert from "node:assert/strict";
import test from "node:test";
import { createCommandRegistry } from "./commandRegistry.ts";
import type { AppCommand } from "./commands.ts";
import type { ContributedCommand } from "./extensions/registry.ts";

const core = (id: string, extra: Partial<AppCommand> = {}): AppCommand => ({
  id,
  menu: "File",
  label: id,
  run: () => {},
  ...extra,
});

const ext = (
  command: string,
  extensionId: string,
  key: string | null = null,
): ContributedCommand => ({
  command,
  title: command,
  category: null,
  extensionId,
  palette: true,
  key,
});

test("core commands are listed in order", () => {
  const r = createCommandRegistry();
  r.setCore([core("a"), core("b")]);
  assert.deepEqual(
    r.list().map((c) => c.id),
    ["a", "b"],
  );
});

test("extension commands are appended after core and namespaced", () => {
  const r = createCommandRegistry();
  r.setCore([core("file.save")]);
  r.setExtensions(
    [ext("pub.z.hello", "pub.z")],
    () => {},
    (id) => id,
  );
  assert.deepEqual(
    r.list().map((c) => c.id),
    ["file.save", "pub.z.hello"],
  );
});

test("an extension cannot replace a core command of the same id (core wins)", () => {
  const r = createCommandRegistry();
  r.setCore([core("file.save", { label: "Save" })]);
  r.setExtensions(
    [ext("file.save", "pub.evil")],
    () => {},
    (id) => id,
  );
  const matches = r.list().filter((c) => c.id === "file.save");
  assert.equal(matches.length, 1, "only one file.save");
  assert.equal(matches[0]!.label, "Save", "the core command survived, not the extension's");
});

test("extension commands are sorted by extension id then command", () => {
  const r = createCommandRegistry();
  r.setCore([]);
  r.setExtensions(
    [ext("b.two", "pub.b"), ext("a.one", "pub.a"), ext("a.zero", "pub.a")],
    () => {},
    (id) => id,
  );
  assert.deepEqual(
    r.list().map((c) => c.id),
    ["a.one", "a.zero", "b.two"], // pub.a before pub.b; within pub.a, "a.one" < "a.zero" (o < z)
  );
});

test("execute runs a command and reports whether it did", () => {
  const r = createCommandRegistry();
  let ran = "";
  r.setCore([
    core("file.save", {
      run: () => {
        ran = "save";
      },
    }),
    core("file.off", { disabled: true }),
  ]);
  assert.equal(r.execute("file.save"), true);
  assert.equal(ran, "save");
  assert.equal(r.execute("file.off"), false, "a disabled command does not run");
  assert.equal(r.execute("does.not.exist"), false, "an unknown command does not run");
});

test("execute routes an extension command through its runner", () => {
  const r = createCommandRegistry();
  const calls: string[] = [];
  r.setCore([]);
  r.setExtensions(
    [ext("pub.x.go", "pub.x")],
    (c) => calls.push(c),
    (id) => id,
  );
  assert.equal(r.execute("pub.x.go"), true);
  assert.deepEqual(calls, ["pub.x.go"]);
});

test("get finds a command by id", () => {
  const r = createCommandRegistry();
  r.setCore([core("a"), core("b")]);
  assert.equal(r.get("b")?.id, "b");
  assert.equal(r.get("missing"), undefined);
});

test("subscribers fire when the contributed set changes, not on an identical set", () => {
  const r = createCommandRegistry();
  let fired = 0;
  const off = r.subscribe(() => fired++);
  const set = [ext("pub.x.a", "pub.x")];
  r.setExtensions(
    set,
    () => {},
    (id) => id,
  );
  assert.equal(fired, 1);
  r.setExtensions(
    set,
    () => {},
    (id) => id,
  ); // same array reference: no change
  assert.equal(fired, 1);
  r.setExtensions(
    [ext("pub.x.b", "pub.x")],
    () => {},
    (id) => id,
  );
  assert.equal(fired, 2);
  off();
  r.setExtensions(
    [ext("pub.x.c", "pub.x")],
    () => {},
    (id) => id,
  );
  assert.equal(fired, 2, "unsubscribed listener no longer fires");
});

test("a contributed shortcut that collides with a core one is refused, not taken", () => {
  const r = createCommandRegistry();
  r.setCore([core("file.save", { shortcut: "Ctrl+S" })]);
  r.setExtensions(
    [ext("pub.e.clash", "pub.e", "Ctrl+S"), ext("pub.e.free", "pub.e", "Ctrl+Alt+Z")],
    () => {},
    (id) => id,
  );
  assert.ok(r.conflicts().length >= 1, "the collision is reported");
  assert.equal(r.get("pub.e.clash")?.shortcut, undefined, "the colliding key is not taken");
  assert.equal(r.get("pub.e.free")?.shortcut, "Ctrl+Alt+Z", "a free key is assigned");
});
