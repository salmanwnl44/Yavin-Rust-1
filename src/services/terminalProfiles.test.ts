import assert from "node:assert/strict";
import test from "node:test";
import { createProfileRegistry, parseShells, supportsLogin } from "./terminalProfiles.ts";
import type { ProfileInput } from "./terminalProfiles.ts";
import { TerminalError } from "./terminalProtocol.ts";
import type { WorkspaceId } from "./terminalProtocol.ts";

const A = "file://c:/a" as WorkspaceId;
const B = "file://c:/b" as WorkspaceId;
const CMD = "C:\\Windows\\System32\\cmd.exe";
const BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
const DISCOVERED = [
  {
    name: "Command Prompt",
    path: CMD,
    kind: "cmd",
    platform: "windows",
    available: true,
    reason: null,
    isDefault: true,
  },
  {
    name: "PowerShell",
    path: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    kind: "pwsh",
    platform: "windows",
    available: false,
    reason: "PowerShell 7 (pwsh.exe) is not installed.",
    isDefault: false,
  },
  {
    name: "Git Bash",
    path: BASH,
    kind: "bash",
    platform: "windows",
    available: true,
    reason: null,
    isDefault: false,
  },
];

async function loaded(shells: unknown = DISCOVERED) {
  const registry = createProfileRegistry(async () => shells);
  await registry.load();
  return registry;
}

const fails = (attempt: () => unknown, code: string) =>
  assert.throws(attempt, (error: unknown) => error instanceof TerminalError && error.code === code);

const input = (fields: Partial<ProfileInput> = {}): ProfileInput => ({
  name: "Builds",
  executable: BASH,
  ...fields,
});

// --- Discovery ---------------------------------------------------------------------------------

test("discovery is read defensively: missing fields get safe defaults, junk is dropped", () => {
  const shells = parseShells([{ name: "Command Prompt", path: CMD }, { path: 3 }, null, "x"]);
  assert.deepEqual(shells, [
    {
      name: "Command Prompt",
      path: CMD,
      kind: "other",
      platform: "windows",
      available: true,
      reason: null,
      isDefault: true,
    },
  ]);
  assert.deepEqual(parseShells("not a list"), []);
});

// --- Built-ins ---------------------------------------------------------------------------------

test("each discovered shell is a read-only built-in, unavailable ones marked with the reason", async () => {
  const registry = await loaded();
  const builtins = registry.getSnapshot().builtins;
  assert.deepEqual(
    builtins.map((entry) => [entry.profile.id, entry.available]),
    [
      ["builtin.cmd", true],
      ["builtin.pwsh", false],
      ["builtin.bash", true],
    ],
  );
  assert.equal(builtins[1].reason, "PowerShell 7 (pwsh.exe) is not installed.");
  assert.ok(Object.isFrozen(builtins[0].profile));
  fails(() => registry.updateUser("builtin.cmd", input()), "ProtocolError");
  fails(() => registry.removeUser("builtin.bash"), "ProtocolError");
});

// --- Validation --------------------------------------------------------------------------------

test("a profile's shell must be one discovery found: a profile is configuration, not permission", async () => {
  const registry = await loaded();
  fails(
    () => registry.addUser(input({ executable: "C:\\Windows\\notepad.exe" })),
    "ShellUnavailable",
  );
  // Found, but not installed.
  fails(
    () => registry.addUser(input({ executable: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" })),
    "ShellUnavailable",
  );
  // The same shell spelled another way is the same shell.
  const entry = registry.addUser(input({ executable: "c:/program files/git/bin/BASH.EXE" }));
  assert.equal(entry.profile.executable, BASH);
});

test("invalid names, arguments, environment, folders and login modes are refused, typed", async () => {
  const registry = await loaded();
  for (const bad of [
    input({ name: "  " }),
    input({ name: "x".repeat(65) }),
    input({ executable: "" }),
    input({ args: ["ok", "line\nbreak"] }),
    input({ env: [["A=B", "1"]] }),
    input({ env: [["", "1"]] }),
    input({ env: [["A", "x\r"]] }),
    input({ cwd: "a\u0000b" }),
    input({ executable: CMD, login: true }),
  ])
    fails(() => registry.addUser(bad), "ProtocolError");
  assert.equal(registry.getSnapshot().users.length, 0);
});

test("arguments keep their boundaries; a login profile is only for shells with a login mode", async () => {
  const registry = await loaded();
  const args = ["--rcfile", 'a file with spaces & "quotes"', "-i"];
  const entry = registry.addUser(
    input({
      args,
      login: true,
      env: [
        ["B", "1"],
        ["A", "$B"],
      ],
    }),
  );
  assert.deepEqual(entry.profile.args, args);
  assert.equal(entry.profile.login, true);
  assert.deepEqual(entry.profile.env, [
    ["B", "1"],
    ["A", "$B"],
  ]);
  assert.ok(supportsLogin("bash") && supportsLogin("zsh") && !supportsLogin("cmd"));
  assert.ok(!supportsLogin("pwsh") && !supportsLogin("powershell"));
});

// --- User and workspace profiles ---------------------------------------------------------------

test("user profiles are made, changed and removed; ids are unique across every scope", async () => {
  const registry = await loaded();
  const one = registry.addUser(input({ name: "One" }));
  const two = registry.addUser(input({ name: "Two" }));
  const own = registry.forWorkspace(A).addWorkspace(input({ name: "Mine" }));
  const ids = [one, two, own].map((entry) => entry.profile.id);
  assert.equal(new Set(ids).size, 3);
  const renamed = registry.updateUser(one.profile.id, input({ name: "Renamed" }));
  assert.equal(renamed.profile.id, one.profile.id);
  assert.equal(registry.getSnapshot().users[0].profile.name, "Renamed");
  registry.removeUser(two.profile.id);
  assert.deepEqual(
    registry.getSnapshot().users.map((entry) => entry.profile.name),
    ["Renamed"],
  );
  // A workspace profile is not a user profile: the user calls cannot touch it.
  fails(() => registry.removeUser(own.profile.id), "ProtocolError");
  fails(() => registry.forWorkspace(A).removeWorkspace(one.profile.id), "ProtocolError");
});

test("a workspace's profiles are its own: another workspace never sees them", async () => {
  const registry = await loaded();
  const own = registry.forWorkspace(A).addWorkspace(input({ name: "A only" }));
  const user = registry.addUser(input({ name: "Everyone" }));
  const inB = registry
    .forWorkspace(B)
    .getSnapshot()
    .profiles.map((e) => e.profile.id);
  assert.ok(!inB.includes(own.profile.id));
  assert.ok(inB.includes(user.profile.id));
  fails(() => registry.forWorkspace(B).resolve(own.profile.id), "ProtocolError");
  assert.equal(registry.forWorkspace(A).resolve(own.profile.id).profile.name, "A only");
  assert.equal(registry.forWorkspace(A), registry.forWorkspace(A), "one view per workspace");
});

// --- Default resolution ------------------------------------------------------------------------

test("the default is asked-for, then workspace, then user, then platform, then first available", async () => {
  const registry = await loaded();
  const a = registry.forWorkspace(A);
  // Platform default: discovery's.
  assert.equal(a.resolve().profile.id, "builtin.cmd");
  // User default.
  const user = registry.addUser(input({ name: "User bash" }));
  registry.setUserDefault(user.profile.id);
  assert.equal(a.resolve().profile.id, user.profile.id);
  // Workspace default over it.
  a.setWorkspaceDefault("builtin.bash");
  assert.equal(a.resolve().profile.id, "builtin.bash");
  assert.equal(a.getSnapshot().effectiveDefault, "builtin.bash");
  // Asked for over everything.
  assert.equal(a.resolve("builtin.cmd").profile.id, "builtin.cmd");
  // Another workspace keeps only the user default.
  assert.equal(registry.forWorkspace(B).resolve().profile.id, user.profile.id);
});

test("an unavailable profile is never launched, nor silently swapped when asked for", async () => {
  const registry = await loaded();
  const a = registry.forWorkspace(A);
  fails(() => a.resolve("builtin.pwsh"), "ShellUnavailable");
  // As a default it is skipped, falling through to the next that can start.
  a.setWorkspaceDefault("builtin.pwsh");
  assert.equal(a.resolve().profile.id, "builtin.cmd");
  fails(() => a.resolve("no-such-profile"), "ProtocolError");
});

test("with no shell at all, or no native side, resolving fails with a clear typed error", async () => {
  const none = await loaded([
    { ...DISCOVERED[1] }, // only an unavailable one
  ]);
  fails(() => none.forWorkspace(A).resolve(), "ShellUnavailable");
  assert.equal(none.forWorkspace(A).getSnapshot().effectiveDefault, null);

  const broken = createProfileRegistry(async () => {
    throw new Error("no native side");
  });
  await broken.load();
  assert.match(broken.getSnapshot().error!, /no native side/);
  fails(() => broken.forWorkspace(A).resolve(), "ShellUnavailable");
  // Not loaded yet: also a clear error, never a guess.
  fails(
    () =>
      createProfileRegistry(async () => DISCOVERED)
        .forWorkspace(A)
        .resolve(),
    "ShellUnavailable",
  );
});

test("listeners hear profile changes; discovery runs once", async () => {
  let asked = 0;
  const registry = createProfileRegistry(async () => {
    asked++;
    return DISCOVERED;
  });
  let heard = 0;
  registry.forWorkspace(A).subscribe(() => heard++);
  await Promise.all([registry.load(), registry.load()]);
  registry.addUser(input());
  assert.equal(asked, 1);
  assert.ok(heard >= 2);
});
