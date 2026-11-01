import assert from "node:assert/strict";
import test from "node:test";
import { TASK_DEFINITIONS, configuredTasks, readTasks, type ResolvedTask } from "./model.ts";
import { planTask } from "./plan.ts";
import { taskShellArgs } from "./shell.ts";
import { TaskError } from "./errors.ts";
import { canMove, createTaskService, taskOwner, type TaskService } from "./service.ts";
import { createSettingsRegistry } from "../settings/settings.ts";
import { createTerminalService } from "../terminalService.ts";
import { createTerminalUi } from "../terminalUi.ts";
import { createProfileRegistry } from "../terminalProfiles.ts";
import { FakeNative } from "../terminalNative.fake.ts";
import { allProblems, groupByFile, publishProblems, resetProblems } from "../panel/problems.ts";
import type { TerminalId, WorkspaceId } from "../terminalProtocol.ts";

const A = "file://c:/a" as WorkspaceId;
const B = "file://c:/b" as WorkspaceId;
const BASH = "C:/Program Files/Git/bin/bash.exe";
const CMD = "C:/Windows/System32/cmd.exe";
const SHELLS = [
  { name: "Git Bash", path: BASH, kind: "bash", isDefault: true },
  { name: "Command Prompt", path: CMD, kind: "cmd" },
];
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const task = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  command: `echo ${id}`,
  ...extra,
});
const resolved = (id: string, dependsOn: string[] = []): ResolvedTask => ({
  ...(readTasks([task(id, { dependsOn })]) as ResolvedTask[])[0],
  scope: "user",
});

// --- The model ----------------------------------------------------------------------------------

test("a task list is read strictly, with defaults filled and reasons for what is wrong", () => {
  const [build] = readTasks([task("build")]) as ResolvedTask[];
  assert.deepEqual(build, {
    id: "build",
    label: "build",
    command: "echo build",
    args: [],
    cwd: null,
    env: {},
    profile: null,
    dependsOn: [],
    group: null,
    isDefault: false,
    problemMatcher: [],
    presentation: { reveal: "always", terminal: "dedicated", clear: true },
  });
  for (const [value, reason] of [
    [{}, /must be a list/],
    [[task("x y")], /needs an id/],
    [[{ id: "a" }], /needs a command/],
    [[task("a", { command: "one\ntwo" })], /one line/],
    [[task("a"), task("a")], /Two tasks have the id "a"/],
    [[task("a", { dependsOn: ["b", "b"] })], /names a task twice/],
    [[task("a", { dependsOn: ["a"] })], /cannot depend on itself/],
    [[task("a", { problemMatcher: ["gcc"] })], /no problem matcher "gcc"/],
    [[task("a", { group: "deploy" })], /"build" or "test"/],
    [[task("a", { isDefault: true })], /only a task with a group/],
    [[task("a", { env: { "A=B": "x" } })], /environment variable/],
    [[task("a", { presentation: { reveal: "sometimes" } })], /presentation.reveal/],
  ] as const)
    assert.match(readTasks(value) as string, reason, JSON.stringify(value));
});

test("tasks are settings: user and workspace, a workspace task replacing the user's of the same id", () => {
  const settings = createSettingsRegistry([TASK_DEFINITIONS], null);
  settings.set(TASK_DEFINITIONS, "user", readTasks([task("build"), task("lint")]) as never);
  settings.set(
    TASK_DEFINITIONS,
    "workspace",
    readTasks([task("build", { command: "make" })]) as never,
    A,
  );
  const inA = configuredTasks(settings, A);
  assert.deepEqual(
    inA.map((t) => [t.id, t.scope, t.command]),
    [
      ["build", "workspace", "make"],
      ["lint", "user", "echo lint"],
    ],
  );
  // B sees only the user's.
  assert.deepEqual(
    configuredTasks(settings, B).map((t) => [t.id, t.scope]),
    [
      ["build", "user"],
      ["lint", "user"],
    ],
  );
  // An invalid list is refused with its reason, and changes nothing.
  assert.throws(
    () => settings.set(TASK_DEFINITIONS, "user", [task("a"), task("a")] as never),
    /Two tasks have the id "a"/,
  );
  assert.equal(configuredTasks(settings, B).length, 2);
});

// --- Dependencies -------------------------------------------------------------------------------

test("dependencies run first, in order, each once", () => {
  const ids = (list: ResolvedTask[]) => list.map((t) => t.id);
  assert.deepEqual(ids(planTask([resolved("a")], "a")), ["a"]);
  assert.deepEqual(ids(planTask([resolved("gen"), resolved("build", ["gen"])], "build")), [
    "gen",
    "build",
  ]);
  const tasks = [
    resolved("gen"),
    resolved("compile", ["gen"]),
    resolved("lint", ["gen"]),
    resolved("build", ["compile", "lint"]),
  ];
  // `gen` is needed twice and runs once, before the first that needs it.
  assert.deepEqual(ids(planTask(tasks, "build")), ["gen", "compile", "lint", "build"]);
});

test("cycles and missing tasks are refused before anything runs", () => {
  const refused = (tasks: ResolvedTask[], id: string) => {
    try {
      planTask(tasks, id);
    } catch (error) {
      return error as TaskError;
    }
    assert.fail("planned");
  };
  const two = refused([resolved("a", ["b"]), resolved("b", ["a"])], "a");
  assert.equal(two.code, "DependencyCycle");
  assert.match(two.message, /a → b → a/);
  const three = refused([resolved("a", ["b"]), resolved("b", ["c"]), resolved("c", ["a"])], "a");
  assert.match(three.message, /a → b → c → a/);
  assert.equal(refused([resolved("a", ["ghost"])], "a").code, "InvalidDependency");
  assert.equal(refused([resolved("a")], "nope").code, "UnknownTask");
});

// --- The shell ----------------------------------------------------------------------------------

test("a task line is handed to each shell as one argument, its arguments quoted by that shell's rules", () => {
  assert.deepEqual(taskShellArgs("bash", "Bash", "printf '%s'", ["a b", "it's"]), [
    "-c",
    "printf '%s' 'a b' 'it'\\''s'",
  ]);
  assert.deepEqual(taskShellArgs("fish", "fish", "echo", ["a\\b'c"]), ["-c", "echo 'a\\\\b\\'c'"]);
  assert.deepEqual(taskShellArgs("powershell", "PowerShell", "Write-Output", ["it's"]), [
    "-NoLogo",
    "-Command",
    "Write-Output 'it''s'",
  ]);
  assert.deepEqual(
    taskShellArgs("cmd", "Command Prompt", "npm run build && echo done", ["--x=1"]),
    ["/d", "/s", "/c", "npm run build && echo done --x=1"],
  );
  // What cmd would read differently from how it was written is refused, not guessed at.
  for (const [command, args] of [
    ['echo "hi"', []],
    ["echo", ["a b"]],
    ["echo", ["x&y"]],
    ["echo", ["%PATH%"]],
  ] as const)
    assert.throws(
      () => taskShellArgs("cmd", "Command Prompt", command, [...args]),
      /Command Prompt cannot/,
    );
  assert.throws(() => taskShellArgs("other", "nu", "ls", []), /does not know how to run/);
});

test("an execution only moves forward, and never leaves a final state", () => {
  for (const [from, to] of [
    ["pending", "starting"],
    ["starting", "running"],
    ["running", "succeeded"],
    ["running", "failed"],
    ["running", "cancelled"],
    ["pending", "cancelled"],
  ] as const)
    assert.ok(canMove(from, to), `${from} -> ${to}`);
  for (const [from, to] of [
    ["succeeded", "running"],
    ["failed", "running"],
    ["cancelled", "starting"],
    ["running", "starting"],
    ["pending", "succeeded"],
  ] as const)
    assert.ok(!canMove(from, to), `${from} -> ${to}`);
});

// --- The service, over the real terminal service --------------------------------------------------

async function setup(
  configured: unknown[],
  options: {
    trusted?: boolean;
    workspace?: WorkspaceId;
    folders?: string[];
    /** `false`: the shells are not discovered yet (no terminal was ever opened). */
    discovered?: boolean;
  } = {},
) {
  resetProblems();
  const fake = new FakeNative();
  const workspace = options.workspace ?? A;
  const settings = createSettingsRegistry([TASK_DEFINITIONS], null);
  settings.set(TASK_DEFINITIONS, "workspace", readTasks(configured) as never, workspace);
  const terminals = createTerminalService(workspace, fake);
  const registry = createProfileRegistry(async () => SHELLS);
  if (options.discovered !== false) await registry.load();
  const profiles = registry.forWorkspace(workspace);
  const ui = createTerminalUi(terminals, profiles);
  const activated: TerminalId[] = [];
  let trusted = options.trusted ?? true;
  const service = createTaskService({
    workspace,
    folders: options.folders ?? ["C:/work"],
    settings,
    terminals,
    ui: {
      activate: (id) => {
        activated.push(id);
        ui.activate(id);
      },
      restart: (id) => ui.restart(id),
    },
    profiles,
    trusted: async () => trusted,
    publish: publishProblems,
    killAfterMs: 20,
  });
  const opens = () =>
    fake.calls
      .filter((call) => call.command === "open")
      .map(
        (call) =>
          call.args as {
            sessionId: string;
            generation: number;
            profile: { executable: string; args: string[] };
            cwd: string;
          },
      );
  /** The shell of the latest launch of `label` ends with `code`. */
  const finish = async (index: number, code: number, output = "") => {
    await settle();
    const open = opens()[index];
    if (output) fake.output(open.sessionId, open.generation, output);
    fake.end(open.sessionId, open.generation, code);
    await settle();
  };
  return {
    fake,
    settings,
    terminals,
    service,
    activated,
    opens,
    finish,
    setTrusted: (v: boolean) => (trusted = v),
  };
}

const states = (service: TaskService) =>
  service.getSnapshot().runs.map((run) => `${run.taskId}:${run.state}`);

test("a task runs in a terminal of its own, through the terminal service, and its exit decides", async () => {
  const t = await setup([task("build", { command: "npm run build", cwd: "app" })]);
  const done = t.service.run("build");
  await settle();
  const [open] = t.opens();
  // The default profile's shell, started to run the line; in the task's folder.
  assert.equal(open.profile.executable, BASH);
  assert.deepEqual(open.profile.args, ["-c", "npm run build"]);
  assert.equal(open.cwd, "C:/work/app");
  assert.deepEqual(states(t.service), ["build:running"]);
  assert.deepEqual(t.activated, [t.service.getSnapshot().runs[0].sessionId]);
  await t.finish(0, 0);
  const run = await done;
  assert.equal(run.state, "succeeded");
  assert.equal(run.exitCode, 0);
  // Its terminal stays, showing how it ended.
  assert.equal(t.terminals.get(run.sessionId!)?.state, "Exited");

  // Run again: the same (dedicated) terminal, restarted -- not a new one.
  const again = t.service.run("build");
  await settle();
  assert.equal(t.opens().length, 2);
  assert.equal(t.opens()[1].sessionId, open.sessionId);
  await t.finish(1, 2);
  const failed = await again;
  assert.equal(failed.state, "failed");
  assert.equal(failed.exitCode, 2);
  assert.match(failed.error!, /code 2/);
});

test("dependencies run one after another; one failing stops the rest", async () => {
  const t = await setup([
    task("gen"),
    task("compile", { dependsOn: ["gen"] }),
    task("build", { dependsOn: ["gen", "compile"] }),
  ]);
  const done = t.service.run("build");
  await settle();
  assert.equal(t.opens().length, 1); // only `gen` so far
  await t.finish(0, 0);
  assert.equal(t.opens().length, 2); // then `compile`
  assert.deepEqual(t.opens()[1].profile.args, ["-c", "echo compile"]);
  await t.finish(1, 1); // compile fails
  const run = await done;
  assert.equal(run.state, "failed");
  assert.match(run.error!, /Not run: "compile" before it did not succeed/);
  assert.equal(t.opens().length, 2); // build never started
  assert.deepEqual(states(t.service), ["build:failed", "compile:failed", "gen:succeeded"]);
});

test("a cycle, an unknown task or no workspace starts nothing", async () => {
  const t = await setup([task("a", { dependsOn: ["b"] }), task("b", { dependsOn: ["a"] })]);
  await assert.rejects(t.service.run("a"), (e: TaskError) => e.code === "DependencyCycle");
  await assert.rejects(t.service.run("zzz"), (e: TaskError) => e.code === "UnknownTask");
  assert.equal(t.opens().length, 0);
  const none = await setup([task("a")], { folders: [] });
  await assert.rejects(none.service.run("a"), (e: TaskError) => e.code === "NoWorkspace");
});

test("an untrusted folder runs no task, and says how to trust it", async () => {
  const t = await setup([task("build")], { trusted: false });
  await assert.rejects(
    t.service.run("build"),
    (e: TaskError) => e.code === "TrustDenied" && /Manage Workspace Trust/.test(e.message),
  );
  assert.equal(t.opens().length, 0);
  t.setTrusted(true); // trusted since
  const done = t.service.run("build");
  await t.finish(0, 0);
  assert.equal((await done).state, "succeeded");
});

test("a task the shell cannot be given, or a folder outside the workspace, is refused up front", async () => {
  const t = await setup([
    task("quoted", { command: 'echo "hi"', profile: "builtin.cmd" }),
    task("away", { cwd: "../elsewhere" }),
    task("ghost", { profile: "user-404" }),
  ]);
  await assert.rejects(t.service.run("quoted"), (e: TaskError) => e.code === "UnsupportedShell");
  await assert.rejects(t.service.run("away"), (e: TaskError) => e.code === "InvalidCwd");
  await assert.rejects(t.service.run("ghost"), (e: TaskError) => e.code === "ShellUnavailable");
  assert.equal(t.opens().length, 0);
});

test("Stop sends Ctrl+C, kills the terminal if it does not stop, and nothing after it starts", async () => {
  const t = await setup([task("gen"), task("build", { dependsOn: ["gen"] })]);
  const done = t.service.run("build");
  await settle();
  const root = t.service.getSnapshot().runs.find((run) => run.taskId === "build")!.executionId;
  t.service.cancel(root);
  await settle();
  const writes = t.fake.calls.filter((call) => call.command === "write");
  assert.deepEqual(
    writes.map((call) => (call.args as { data: string }).data),
    ["\u0003"],
  );
  // It ignored Ctrl+C: after a moment its tree is killed.
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(t.fake.count("kill"), 1);
  const run = await done;
  assert.equal(run.state, "cancelled");
  assert.deepEqual(states(t.service), ["build:cancelled", "gen:cancelled"]);
  assert.equal(t.opens().length, 1); // build never started
});

test("a terminal that cannot start fails the task with its reason", async () => {
  const t = await setup([task("build")]);
  t.fake.failOpen = "ShellUnavailable: That shell is not available on this system.";
  const run = await t.service.run("build");
  assert.equal(run.state, "failed");
  assert.match(run.error!, /not available/);
});

test("a running task is not started twice", async () => {
  const t = await setup([task("build")]);
  const first = t.service.run("build");
  await settle();
  await assert.rejects(t.service.run("build"), (e: TaskError) => e.code === "AlreadyRunning");
  await t.finish(0, 0);
  await first;
});

test("its output reaches the existing matchers and Problems, by canonical path; a new run replaces the last", async () => {
  const t = await setup([
    task("tsc", { command: "npx tsc --noEmit --pretty false", problemMatcher: ["tsc"] }),
  ]);
  const first = t.service.run("tsc");
  await t.finish(
    0,
    2,
    "\u001b[0msrc/app.ts(3,7): error TS2322: Bad.\r\nsrc/b.ts(1,1): error TS1005: ';' expected.\r\n",
  );
  await first;
  const files = () => groupByFile(allProblems()).map((file) => [file.file, file.problems.length]);
  assert.deepEqual(files(), [
    ["C:/work/src/app.ts", 1],
    ["C:/work/src/b.ts", 1],
  ]);
  assert.equal(allProblems()[0].owner, taskOwner("tsc"));
  // The next run's output alone decides: what the last one found is replaced.
  const second = t.service.run("tsc");
  await t.finish(1, 2, "src/app.ts(9,1): error TS2304: Other.\r\n");
  await second;
  assert.deepEqual(files(), [["C:/work/src/app.ts", 1]]);
  assert.equal(groupByFile(allProblems())[0].problems[0].line, 9);
});

test("a workspace's tasks are its own, and disposing it stops what they are running", async () => {
  const a = await setup([task("build")], { workspace: A });
  const b = await setup([task("test")], { workspace: B });
  assert.deepEqual(
    a.service.getSnapshot().tasks.map((t) => t.id),
    ["build"],
  );
  assert.deepEqual(
    b.service.getSnapshot().tasks.map((t) => t.id),
    ["test"],
  );
  await assert.rejects(a.service.run("test"), (e: TaskError) => e.code === "UnknownTask");
  const running = a.service.run("build");
  await settle();
  a.service.dispose();
  const run = await running;
  assert.equal(run.state, "cancelled");
  assert.equal(a.fake.count("kill"), 1);
  // A late event of its session changes nothing now.
  const [open] = a.opens();
  a.fake.end(open.sessionId, open.generation, 0);
  await settle();
  assert.equal(a.service.getSnapshot().runs.find((r) => r.taskId === "build")?.state, "cancelled");
});

test("default build and test tasks: the one marked, the only one, or a choice", async () => {
  const t = await setup([
    task("b1", { group: "build" }),
    task("b2", { group: "build", isDefault: true }),
    task("t1", { group: "test" }),
    task("t2", { group: "test" }),
  ]);
  assert.equal(t.service.defaultTask("build").task?.id, "b2");
  const test = t.service.defaultTask("test");
  assert.equal(test.task, null);
  assert.deepEqual(
    test.candidates.map((x) => x.id),
    ["t1", "t2"],
  );
});

test("a task run before any terminal was opened waits for the shells to be discovered", async () => {
  const t = await setup([task("build", { command: "npm run build" })], { discovered: false });
  const done = t.service.run("build");
  await t.finish(0, 0);
  assert.equal((await done).state, "succeeded");
  assert.equal(t.opens().length, 1);
});
