import assert from "node:assert/strict";
import test from "node:test";
import {
  editorTerminalCwd,
  findPathLinks,
  resolvePathLink,
  revealableFolder,
  terminalCwdFor,
  watchFinishedCommands,
} from "./terminalIde.ts";
import { initialShellState, reduceShell, type TerminalShellState } from "./terminalShell.ts";
import { createTerminalService, createTerminalServices } from "./terminalService.ts";
import { createTerminalUi } from "./terminalUi.ts";
import { createProfileRegistry } from "./terminalProfiles.ts";
import { FakeNative } from "./terminalNative.fake.ts";
import type { WorkspaceId } from "./terminalProtocol.ts";

const A = "file://c:/a" as WorkspaceId;
const B = "file://c:/b" as WorkspaceId;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const BASH = { integration: "available", pathStyle: "msys" } as const;
const WORK = ["C:/work"];

const reported = (
  uri: string,
  local = true,
  hint: Parameters<typeof initialShellState>[0] = BASH,
): TerminalShellState => reduceShell(initialShellState(hint), { signal: "cwd", uri, local });

// --- Explorer / editor -> terminal ------------------------------------------------------------

test("Explorer: a folder opens in itself, a file in its folder, the root in the root", () => {
  assert.equal(terminalCwdFor({ path: "C:/work/src", isDir: true }), "C:/work/src");
  assert.equal(terminalCwdFor({ path: "C:\\work\\src\\main.ts", isDir: false }), "C:/work/src");
  assert.equal(terminalCwdFor({ path: "C:/work", isDir: true }), "C:/work");
  assert.equal(terminalCwdFor({ path: "/home/me/a.ts", isDir: false }), "/home/me");
  // A file at a drive's root is in the root, not above it.
  assert.equal(terminalCwdFor({ path: "C:/a.ts", isDir: false }), "C:/");
  // Not a resource: nothing to start in.
  assert.equal(terminalCwdFor({ path: "relative/x", isDir: true }), null);
});

test("editor: a file on disk opens in its folder; untitled and proposed in the workspace root", () => {
  const disk = { source: { kind: "disk" }, path: "C:/work/src/main.ts" };
  assert.equal(editorTerminalCwd(disk, "C:/work"), "C:/work/src");
  assert.equal(
    editorTerminalCwd({ source: { kind: "untitled" }, path: null }, "C:/work"),
    "C:/work",
  );
  // A proposal names where a file would go; that folder may not exist yet.
  const proposed = { source: { kind: "proposed" }, path: "C:/work/new/dir/a.ts" };
  assert.equal(editorTerminalCwd(proposed, "C:/work"), "C:/work");
  assert.equal(editorTerminalCwd(undefined, null), null);
});

// --- Terminal -> Explorer ---------------------------------------------------------------------

test("reveal: only a local folder the shell reported, inside the workspace", () => {
  assert.deepEqual(revealableFolder(reported("file://BOX/c/work/src"), WORK), {
    ok: true,
    path: "C:/work/src",
  });
  const remote = revealableFolder(reported("file://far/home/ci", false), WORK);
  assert.equal(remote.ok, false);
  assert.match((remote as { reason: string }).reason, /another machine \(far\)/);
  const unmapped = revealableFolder(reported("file:///tmp"), WORK);
  assert.match((unmapped as { reason: string }).reason, /no Windows path/);
  const outside = revealableFolder(reported("file:///d/elsewhere"), WORK);
  assert.match((outside as { reason: string }).reason, /outside the workspace/);
  // Never reported (or unreadable): not where it started -- unknown.
  const unknown = revealableFolder(initialShellState(BASH), WORK);
  assert.match((unknown as { reason: string }).reason, /does not report its folder/);
  const invalid = reduceShell(initialShellState(BASH), {
    signal: "cwd",
    uri: "file:///bad%zz",
    local: true,
  });
  assert.equal(revealableFolder(invalid, WORK).ok, false);
  const active = reduceShell(initialShellState(BASH), { signal: "prompt" });
  assert.match(
    (revealableFolder(active, WORK) as { reason: string }).reason,
    /has not reported its folder yet/,
  );
});

// --- Terminal output -> editor ----------------------------------------------------------------

const texts = (line: string) => findPathLinks(line).map((link) => link.text);

test("links: absolute and separated relative file paths, with an optional line and column", () => {
  const [one] = findPathLinks("error in src/main.ts:12:5 here");
  assert.deepEqual(one, {
    start: 9,
    end: 25,
    text: "src/main.ts:12:5",
    path: "src/main.ts",
    line: 12,
    column: 5,
  });
  assert.deepEqual(texts("./src/main.ts and ../lib/a.rs:3"), ["./src/main.ts", "../lib/a.rs:3"]);
  const [drive] = findPathLinks("at C:\\project\\src\\main.ts:7.");
  assert.equal(drive.path, "C:\\project\\src\\main.ts");
  assert.equal(drive.line, 7);
  assert.deepEqual(texts("'/home/me/a.py' (x)"), ["/home/me/a.py"]);
});

test("links: ambiguous or unsafe text is left alone", () => {
  assert.deepEqual(texts("main.ts and a.b and 1.5 and v2.0.1"), []); // no separator: anything
  assert.deepEqual(texts("src/components and ./bin"), []); // no file named
  assert.deepEqual(texts("see https://example.com/a/b.ts"), []); // a URL: the web-link addon's
  assert.deepEqual(texts("\\\\server\\share\\a.ts //server/share/a.ts"), []); // UNC: remote
  assert.deepEqual(texts("src/a.ts:x"), []); // not `:line[:column]`
  // Another compiler's position form is not read: the path alone, with no line.
  const [other] = findPathLinks("src/b.ts(3,4)");
  assert.deepEqual([other.text, other.line], ["src/b.ts", undefined]);
  assert.deepEqual(texts("100/200.5"), []); // numbers, not a file
});

test("links resolve against the terminal's folder, inside the workspace only", () => {
  const link = (text: string) => findPathLinks(text)[0];
  const options = { base: "C:/work/app", folders: WORK };
  assert.deepEqual(resolvePathLink(link("src/main.ts:4:2"), options), {
    path: "C:/work/app/src/main.ts",
    line: 4,
    column: 2,
  });
  assert.deepEqual(resolvePathLink(link("../lib/a.rs"), options), { path: "C:/work/lib/a.rs" });
  assert.deepEqual(resolvePathLink(link("C:\\work\\x.ts"), options), { path: "C:/work/x.ts" });
  // Climbing out, or another drive: not this workspace's to open.
  assert.equal(resolvePathLink(link("../../etc/passwd.txt"), options), null);
  assert.equal(resolvePathLink(link("D:\\secret\\a.txt"), options), null);
  // No folder to be relative to: not offered.
  assert.equal(resolvePathLink(link("src/main.ts"), { base: null, folders: WORK }), null);
  // Git Bash prints MSYS paths.
  assert.deepEqual(resolvePathLink(link("/c/work/a.ts"), { ...options, msys: true }), {
    path: "C:/work/a.ts",
  });
  assert.equal(resolvePathLink(link("/tmp/a.ts"), { ...options, msys: true }), null);
  // Line 0 is no line.
  assert.equal(resolvePathLink(link("src/a.ts:0"), options), null);
});

// --- Terminal -> Git --------------------------------------------------------------------------

test("Git is asked to refresh once per finished command, never per output", async () => {
  const fake = new FakeNative();
  const service = createTerminalService(A, fake);
  const id = service.open({
    title: "Bash",
    profile: null,
    integration: { integration: "available", pathStyle: "posix" },
  });
  await settle();
  const generation = service.get(id)!.generation;
  let refreshes = 0;
  const stop = watchFinishedCommands(service, () => refreshes++);
  for (let i = 0; i < 50; i++) fake.output(id, generation, `line ${i}\n`);
  fake.shell(id, generation, { signal: "prompt" });
  fake.shell(id, generation, { signal: "executing" });
  assert.equal(refreshes, 0);
  fake.shell(id, generation, { signal: "finished", exitCode: 1 });
  assert.equal(refreshes, 1);
  // A D with nothing running finishes nothing.
  fake.shell(id, generation, { signal: "finished", exitCode: 0 });
  assert.equal(refreshes, 1);
  // After a restart, the next command still counts.
  service.restart(id);
  await settle();
  const next = service.get(id)!.generation;
  fake.shell(id, next, { signal: "executing" });
  fake.shell(id, next, { signal: "finished", exitCode: 0 });
  assert.equal(refreshes, 2);
  stop();
  fake.shell(id, next, { signal: "executing" });
  fake.shell(id, next, { signal: "finished", exitCode: 0 });
  assert.equal(refreshes, 2);
});

// --- Terminal reuse, focus and workspaces -----------------------------------------------------

const SHELLS = [
  { name: "Git Bash", path: "C:/Program Files/Git/bin/bash.exe", kind: "bash", isDefault: true },
];

async function uiFor(service: ReturnType<typeof createTerminalService>, workspace = A) {
  const ui = createTerminalUi(
    service,
    createProfileRegistry(async () => SHELLS).forWorkspace(workspace),
  );
  ui.loadProfiles();
  await settle();
  return ui;
}

test("an IDE action reuses a terminal only when its shell reported being in that folder", async () => {
  const fake = new FakeNative();
  const service = createTerminalService(A, fake);
  const ui = await uiFor(service);
  // Nothing there: a new terminal, started in the folder.
  const first = ui.openIn("C:/work/src");
  await settle();
  assert.equal(service.get(first)!.cwd, "C:/work/src");
  // It has not said where it is: never assumed, so asking again starts another.
  const second = ui.openIn("C:/work/src");
  await settle();
  assert.notEqual(second, first);
  // Once a shell reports the folder, it is the one shown again.
  fake.shell(second, service.get(second)!.generation, {
    signal: "cwd",
    uri: "file:///c/work/src",
    local: true,
  });
  assert.equal(ui.openIn("C:\\work\\src"), second);
  assert.equal(ui.focusedId(), second);
  // Busy with a command: not interrupted, another starts.
  fake.shell(second, service.get(second)!.generation, { signal: "executing" });
  const third = ui.openIn("C:/work/src");
  assert.notEqual(third, second);
  assert.equal(service.list().length, 3);
});

test("keyboard focus is the TerminalUi's, separate from the pane in front", async () => {
  const fake = new FakeNative();
  const service = createTerminalService(A, fake);
  const ui = await uiFor(service);
  const one = ui.newTerminal();
  await settle();
  assert.equal(ui.focusedId(), one);
  assert.equal(ui.getSnapshot().keyboard, null); // shown, not typed into
  ui.setKeyboard(one, true);
  assert.equal(ui.getSnapshot().keyboard, one);
  const two = ui.newTerminal();
  await settle();
  // Another terminal's blur does not take the keyboard from the one that has it.
  ui.setKeyboard(two, false);
  assert.equal(ui.getSnapshot().keyboard, one);
  ui.setKeyboard(one, false);
  assert.equal(ui.getSnapshot().keyboard, null);
  ui.setKeyboard(two, true);
  // A terminal that goes away no longer has the keyboard.
  ui.close(two);
  await settle();
  assert.equal(ui.getSnapshot().keyboard, null);
  const before = ui.getSnapshot().focusRequest;
  ui.requestFocus();
  assert.equal(ui.getSnapshot().focusRequest, before + 1);
});

test("Kill ends the process natively; Close ends it gently", async () => {
  const fake = new FakeNative();
  const service = createTerminalService(A, fake);
  const ui = await uiFor(service);
  const one = ui.newTerminal();
  const two = ui.newTerminal();
  await settle();
  ui.kill(one);
  ui.close(two);
  await settle();
  assert.equal(fake.count("kill"), 1);
  assert.equal(fake.count("close"), 1);
  assert.equal(service.list().length, 0);
});

test("one workspace's IDE actions never reach another's terminals", async () => {
  const fake = new FakeNative();
  const services = createTerminalServices(fake);
  const a = await uiFor(services.forWorkspace(A), A);
  const b = await uiFor(services.forWorkspace(B), B);
  const inA = a.openIn("C:/a");
  await settle();
  fake.shell(inA, services.forWorkspace(A).get(inA)!.generation, {
    signal: "cwd",
    uri: "file:///c/shared",
    local: true,
  });
  // B asks for the same folder: A's terminal there is not B's to reuse.
  const inB = b.openIn("C:/shared");
  assert.notEqual(inB, inA);
  assert.equal(services.forWorkspace(B).get(inA), undefined);
  assert.throws(() => b.restart(inA), /another workspace/);
  // Disposing A ends A's terminals only.
  await services.dispose(A);
  assert.equal(fake.count("kill"), 1);
  assert.equal(services.forWorkspace(B).list().length, 1);
});
