/**
 * Run/Tasks Module 01: regression tests for defects found in the IDE-04 task layer, written
 * BEFORE their fixes. Each states the behaviour the task layer must have, and fails today.
 *
 * The PTY evidence comes from `fixtures/pty/`: bytes the real tools printed through Yavin's own
 * native terminal (portable-pty / ConPTY), captured by `capture_real_task_tool_output`
 * (`src-tauri/src/terminal_tests.rs`); `fixtures/pty/capture.json` records the versions. A test
 * marked AUTHORED uses a fixture written by hand from the tool's documented format because the
 * tool is not installed here.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { TASK_DEFINITIONS, readTasks } from "./model.ts";
import { createTaskService, type TaskService, type TaskServiceOptions } from "./service.ts";
import { TaskOutputMatcher } from "./matching.ts";
import { createSettingsRegistry } from "../settings/settings.ts";
import { createTerminalService } from "../terminalService.ts";
import { createTerminalUi } from "../terminalUi.ts";
import { createProfileRegistry } from "../terminalProfiles.ts";
import { FakeNative } from "../terminalNative.fake.ts";
import { allProblems, publishProblems, resetProblems } from "../panel/problems.ts";
import type { TerminalId, WorkspaceId } from "../terminalProtocol.ts";

const A = "file://c:/a" as WorkspaceId;
const CMD = "C:/Windows/System32/cmd.exe";
const SHELLS = [{ name: "Command Prompt", path: CMD, kind: "cmd", isDefault: true }];
const settle = async (times = 4) => {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/pty/${name}`, import.meta.url), "utf8");
const LONG_NAME = JSON.parse(fixture("capture.json")).longName as string;

const task = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  command: `echo ${id}`,
  ...extra,
});

/** A workspace's task layer over the real TerminalService and TerminalUi, on a fake native. */
async function harness(configured: unknown[]) {
  resetProblems();
  const fake = new FakeNative();
  const settings = createSettingsRegistry([TASK_DEFINITIONS], null);
  settings.set(TASK_DEFINITIONS, "workspace", readTasks(configured) as never, A);
  // One per workspace for the window's lifetime: it outlives each workspace context.
  const terminals = createTerminalService(A, fake);
  const registry = createProfileRegistry(async () => SHELLS);
  await registry.load();
  const profiles = registry.forWorkspace(A);
  const ui = createTerminalUi(terminals, profiles);
  let trusted = true;
  /** A TaskService as each workspace context makes one (`workspaces.ts`). */
  const taskService = (extra: Partial<TaskServiceOptions> = {}): TaskService =>
    createTaskService({
      workspace: A,
      folders: ["C:/work"],
      settings,
      terminals,
      // The workspace's TerminalUi itself, as `workspaces.ts` passes it.
      ui,
      profiles,
      trusted: async () => trusted,
      publish: publishProblems,
      killAfterMs: 20,
      ...extra,
    });
  const opens = () =>
    fake.calls
      .filter((call) => call.command === "open")
      .map(
        (call) =>
          call.args as {
            sessionId: string;
            generation: number;
            profile: { args: string[] };
          },
      );
  const end = async (index: number, code: number, output = "") => {
    await settle();
    const open = opens()[index];
    if (output) fake.output(open.sessionId, open.generation, output);
    fake.end(open.sessionId, open.generation, code);
    await settle();
  };
  const terminalsTitled = (title: string) =>
    terminals.list().filter((session) => session.title === title);
  return {
    fake,
    terminals,
    ui,
    taskService,
    opens,
    end,
    terminalsTitled,
    setTrusted: (value: boolean) => (trusted = value),
  };
}

/** Every diagnostic in the Problems store, whoever published it. */
const problems = () =>
  allProblems().flatMap((owned) =>
    owned.diagnostics.map((p) => ({ file: p.file, line: p.line, column: p.column, code: p.code })),
  );

// --- A. Problem matching on what tools really print in a terminal ---------------------------------

/** What the task layer's matchers find in a captured terminal output, fed in as it arrives. */
const matched = (ids: string[], output: string) => {
  const matcher = new TaskOutputMatcher(ids);
  matcher.push(new TextEncoder().encode(output));
  return matcher.finish();
};

for (const cols of [80, 200]) {
  test(`A1 (real PTY, ${cols} cols): tsc's terminal output -- its default, pretty format -- gives its error`, () => {
    // Captured: `tsc --noEmit -p .` through Yavin's terminal printed
    // `src/bad.ts:2:30 - error TS2304: Cannot find name '…'.`, coloured, its lines placed by
    // cursor moves rather than line breaks.
    const found = matched(["tsc"], fixture(`tsc-${cols}.pty`));
    assert.deepEqual(
      found.map((d) => [d.file, d.line, d.column, d.severity, d.code, d.message]),
      [["src/bad.ts", 2, 30, "error", "TS2304", `Cannot find name '${LONG_NAME}'.`]],
    );
  });

  test(`A2 (real PTY, ${cols} cols): one tsc --watch cycle gives its error`, () => {
    const found = matched(["tsc"], fixture(`tsc-watch-${cols}.pty`));
    assert.deepEqual(
      found.map((d) => [d.file, d.line, d.column, d.code]),
      [["src/bad.ts", 2, 30, "TS2304"]],
    );
  });

  test(`A3 (real PTY, ${cols} cols): cargo check's default human output gives its error`, () => {
    // Captured: `error[E0425]: cannot find value …` then ` --> src\\main.rs:2:26` on the next line.
    const found = matched(["cargo"], fixture(`cargo-${cols}.pty`));
    assert.deepEqual(
      found.map((d) => [d.file, d.line, d.column, d.severity, d.code]),
      [["src\\main.rs", 2, 26, "error", "E0425"]],
    );
  });

  test(`A4 (real PTY, ${cols} cols, control): cargo's short format -- the checker's -- still matches`, () => {
    // Not a defect: the format the checkers ask for, through the same terminal. It must keep
    // matching when the matchers change.
    const found = matched(["cargo"], fixture(`cargo-short-${cols}.pty`));
    assert.deepEqual(
      found.map((d) => [d.file, d.line, d.column, d.severity, d.code]),
      [["src\\main.rs", 2, 26, "error", "E0425"]],
    );
  });
}

test("A5 (real PTY, through TaskService): the documented example task's tsc error reaches Problems", async () => {
  // The setting's own example: `npm run build` with the "tsc" matcher.
  const t = await harness([task("build", { command: "npm run build", problemMatcher: ["tsc"] })]);
  const run = t.taskService().run("build");
  await t.end(0, 2, fixture("tsc-80.pty"));
  assert.equal((await run).state, "failed");
  assert.deepEqual(problems(), [
    { file: "C:/work/src/bad.ts", line: 2, column: 30, code: "TS2304" },
  ]);
});

test("A5-control: the same task and harness publish a tsc error in the --pretty false format", async () => {
  // Proves A5 fails on the output's format, not on the harness: this passes today.
  const t = await harness([task("build", { command: "npm run build", problemMatcher: ["tsc"] })]);
  const run = t.taskService().run("build");
  await t.end(0, 2, "src/bad.ts(2,30): error TS2304: Cannot find name 'x'.\r\n");
  await run;
  assert.deepEqual(problems(), [
    { file: "C:/work/src/bad.ts", line: 2, column: 30, code: "TS2304" },
  ]);
});

test("A6 (AUTHORED fixture -- eslint is not installed here): eslint's default stylish output gives its findings", () => {
  // eslint's default formatter ("stylish"): the file on a line of its own, then one indented
  // line per finding. Written from the documented format, not captured.
  const stylish = [
    "",
    "C:\\work\\src\\app.ts",
    "  4:1   error    'x' is assigned a value but never used  no-unused-vars",
    "  9:12  warning  Unexpected console statement            no-console",
    "",
    "✖ 2 problems (1 error, 1 warning)",
    "",
  ].join("\r\n");
  const found = matched(["eslint"], stylish);
  assert.deepEqual(
    found.map((d) => [d.file, d.line, d.column, d.severity, d.code]),
    [
      ["C:\\work\\src\\app.ts", 4, 1, "error", "no-unused-vars"],
      ["C:\\work\\src\\app.ts", 9, 12, "warning", "no-console"],
    ],
  );
});

test.todo(
  "A7 ruff's default output: NOT CAPTURED -- ruff is not installed here, and its default format differs between versions; a real capture is needed before the matcher is changed",
);

// --- B. One task, two executions at once ------------------------------------------------------------

test("B: a task already running is not started a second time as another task's dependency", async () => {
  const t = await harness([
    task("slow"),
    task("compile"),
    task("x", { dependsOn: ["slow", "compile"] }),
  ]);
  const service = t.taskService();
  const all = service.run("x");
  await settle();
  // x's plan: slow (running now), compile, x. While slow runs, compile is run on its own --
  // allowed: compile is not running yet.
  const alone = service.run("compile");
  await settle();
  assert.equal(t.opens().length, 2, "slow, then compile on its own");
  // slow succeeds: x's plan reaches compile, which is still running on its own.
  await t.end(0, 0);
  await settle();
  const compiling = () =>
    service.getSnapshot().runs.filter((run) => run.taskId === "compile" && run.state === "running");
  assert.ok(
    compiling().length <= 1,
    `compile is running ${compiling().length} times at once (${compiling()
      .map((run) => run.executionId)
      .join(", ")}): a second terminal was opened for it while the first still runs`,
  );
  // However it ends, one task has one dedicated terminal.
  for (let i = 1; i < t.opens().length; i++) await t.end(i, 0);
  await Promise.all([all, alone]);
  assert.equal(
    t.terminalsTitled("Task: compile").length,
    1,
    "compile's first dedicated terminal was let go of, and left open",
  );
});

// --- C. The exit and the last output travel on different channels ------------------------------------

test("C: a diagnostic printed just before the exit is not lost when the exit arrives first", async () => {
  const t = await harness([task("build", { problemMatcher: ["tsc"] })]);
  // As natively: the lifecycle channel (the exit) is never held back by output; the output
  // channel (where the matcher reads) is its own transport and can be behind it.
  t.fake.lagViews = true;
  const run = t.taskService().run("build");
  await settle();
  t.fake.flushViews(); // the output channel is subscribed and up to date
  const open = t.opens()[0];
  t.fake.output(open.sessionId, open.generation, "src/app.ts(3,7): error TS2322: Bad.\r\n");
  t.fake.end(open.sessionId, open.generation, 2); // the exit arrives at once...
  await settle();
  t.fake.flushViews(); // ...the output a moment later, still before its channel's end
  await settle();
  assert.equal((await run).state, "failed");
  assert.deepEqual(
    problems(),
    [{ file: "C:/work/src/app.ts", line: 3, column: 7, code: "TS2322" }],
    "the task finished on the exit and stopped reading before its last output arrived",
  );
});

test("C-control: with the channels in step, the same diagnostic reaches Problems", async () => {
  // Proves C fails on the order of the channels alone: this passes today.
  const t = await harness([task("build", { problemMatcher: ["tsc"] })]);
  const run = t.taskService().run("build");
  await t.end(0, 2, "src/app.ts(3,7): error TS2322: Bad.\r\n");
  await run;
  assert.deepEqual(problems(), [
    { file: "C:/work/src/app.ts", line: 3, column: 7, code: "TS2322" },
  ]);
});

// --- D. A workspace left and opened again --------------------------------------------------------

test("D: opening a workspace again reuses its tasks' dedicated terminals rather than adding more", async () => {
  const t = await harness([task("x")]);
  // Workspace A: run x; it ends, its dedicated terminal stays.
  const first = t.taskService();
  const one = first.run("x");
  await t.end(0, 0);
  await one;
  // Switch to B: A's context (and its TaskService) is disposed; A's terminals are not.
  first.dispose();
  // Back to A: a new context, a new TaskService, the same terminals.
  const second = t.taskService();
  const two = second.run("x");
  await t.end(1, 0);
  await two;
  assert.equal(
    t.terminalsTitled("Task: x").length,
    1,
    `"Task: x" is open ${t.terminalsTitled("Task: x").length} times after A → B → A`,
  );
});

// --- E. Restarting a task's terminal from the terminal UI ------------------------------------------

/** Runs `x` through TaskService to its end; the session its terminal is. */
async function ranOnce(configured: unknown[]) {
  const t = await harness(configured);
  const service = t.taskService();
  const run = service.run("x");
  await t.end(0, 0);
  const session = (await run).sessionId as TerminalId;
  return { ...t, service, session };
}

test("E1: Restart on a task's terminal does not run the task in a folder no longer trusted", async () => {
  const t = await ranOnce([task("x")]);
  t.setTrusted(false);
  // What the terminal panel's Restart (TerminalPanel.tsx) and the ended terminal's Restart
  // button (TerminalView.tsx) call.
  t.ui.restart(t.session);
  await settle();
  const relaunched = t.opens().slice(1);
  assert.deepEqual(
    relaunched.map((open) => open.profile.args),
    [],
    "the task's command line was started again with no trust check",
  );
});

test("E2: Restart on a task's terminal is a task execution, recorded like any other", async () => {
  const t = await ranOnce([task("x")]);
  const before = t.service.getSnapshot().runs.length;
  t.ui.restart(t.session);
  await settle();
  assert.equal(t.opens().length, 2, "precondition: the terminal restarted");
  assert.equal(
    t.service.getSnapshot().runs.length,
    before + 1,
    "the task ran again with no execution: no state, no exit code, nothing to stop",
  );
});

test("E3: Restart on a task's terminal still reads its output for problems", async () => {
  const t = await ranOnce([task("x", { problemMatcher: ["tsc"] })]);
  t.ui.restart(t.session);
  await t.end(1, 2, "src/app.ts(3,7): error TS2322: Bad.\r\n");
  assert.deepEqual(
    problems(),
    [{ file: "C:/work/src/app.ts", line: 3, column: 7, code: "TS2322" }],
    "the restarted run's output reached no matcher",
  );
});

test("E4: after a Restart from the terminal, running the task does not start it a second time", async () => {
  const t = await ranOnce([task("x")]);
  t.ui.restart(t.session); // x runs again, in its terminal, unknown to TaskService
  await settle();
  // Refused (correct), or a second x started (the defect) -- whose end nobody awaits here.
  void t.service.run("x").catch(() => {});
  await settle();
  const running = t.terminals
    .list()
    .filter((session) => session.title === "Task: x" && session.state === "Running");
  assert.equal(running.length, 1, `x is running in ${running.length} terminals at once`);
});

// --- The fixes' edges ----------------------------------------------------------------------------

test("B2: stopping a run that waits on a dependency running elsewhere stops the wait, not that run", async () => {
  const t = await harness([
    task("slow"),
    task("compile"),
    task("x", { dependsOn: ["slow", "compile"] }),
  ]);
  const service = t.taskService();
  const all = service.run("x");
  await settle();
  void service.run("compile");
  await t.end(0, 0); // slow done: x now waits on the running compile
  const x = service.getSnapshot().runs.find((run) => run.taskId === "x")!;
  service.cancel(x.executionId);
  assert.equal((await all).state, "cancelled");
  const compile = service.getSnapshot().runs.find((run) => run.taskId === "compile")!;
  assert.equal(compile.state, "running", "the compile x waited on is not x's to stop");
  assert.equal(t.fake.count("write"), 0, "no Ctrl+C was sent to it");
  // One record per execution: x's own compile step went when it joined the running one.
  assert.deepEqual(
    service
      .getSnapshot()
      .runs.map((run) => `${run.taskId}:${run.state}`)
      .sort(),
    ["compile:running", "slow:succeeded", "x:cancelled"],
  );
});

test("B3: a dependency that was running elsewhere and fails fails the run, which does not start", async () => {
  const t = await harness([
    task("slow"),
    task("compile"),
    task("x", { dependsOn: ["slow", "compile"] }),
  ]);
  const service = t.taskService();
  const all = service.run("x");
  await settle();
  const alone = service.run("compile");
  await t.end(0, 0);
  await t.end(1, 2); // the compile x waits on fails
  assert.equal((await alone).state, "failed");
  const x = await all;
  assert.equal(x.state, "failed");
  assert.match(x.error!, /"compile" before it did not succeed/);
  assert.equal(t.opens().length, 2, "x itself never started");
});

test("C2: output that never ends delays a run's end only so long, and says what it missed", async () => {
  const t = await harness([task("build", { problemMatcher: ["tsc"] })]);
  t.fake.lagViews = true; // the output channel never delivers
  const run = t.taskService({ drainTimeoutMs: 30 }).run("build");
  await settle();
  const open = t.opens()[0];
  t.fake.output(open.sessionId, open.generation, "src/app.ts(3,7): error TS2322: Bad.\r\n");
  t.fake.end(open.sessionId, open.generation, 2);
  const ended = await run;
  assert.equal(ended.state, "failed");
  assert.equal(ended.exitCode, 2);
  assert.equal(ended.outputComplete, false);
});

test("C3: a stopped run ends at its exit without waiting for its output", async () => {
  const t = await harness([task("build", { problemMatcher: ["tsc"] })]);
  t.fake.lagViews = true;
  const service = t.taskService({ drainTimeoutMs: 60_000 });
  const run = service.run("build");
  await settle();
  service.cancel(service.getSnapshot().runs[0].executionId);
  await settle();
  const open = t.opens()[0];
  t.fake.end(open.sessionId, open.generation, 1); // it stopped on Ctrl+C
  const ended = await run;
  assert.equal(ended.state, "cancelled");
  assert.equal(ended.outputComplete, null, "a stopped run's output is not read");
});

test("C4: a run whose output was read to its end says so", async () => {
  const t = await harness([task("build", { problemMatcher: ["tsc"] })]);
  const run = t.taskService().run("build");
  await t.end(0, 0, "nothing wrong\r\n");
  assert.equal((await run).outputComplete, true);
});

test("E5: a Restart refused is recorded with why, as the run it would have been", async () => {
  const t = await ranOnce([task("x")]);
  t.setTrusted(false);
  t.ui.restart(t.session);
  await settle();
  const [latest] = t.service.getSnapshot().runs;
  assert.equal(latest.taskId, "x");
  assert.equal(latest.state, "failed");
  assert.match(latest.error!, /not trusted/);
});

test("E6: Restart on a running task's terminal stops it, then runs it again", async () => {
  const t = await harness([task("x")]);
  // It stops on Ctrl+C here: the kill that follows a Ctrl+C ignored must not come first.
  const service = t.taskService({ killAfterMs: 60_000 });
  const first = service.run("x");
  await settle();
  const session = service.getSnapshot().runs[0].sessionId as TerminalId;
  t.ui.restart(session);
  await settle();
  assert.equal(t.fake.count("write"), 1, "Ctrl+C to the running one");
  await t.end(0, 1); // it stops
  assert.equal((await first).state, "cancelled");
  await settle();
  assert.equal(t.opens().length, 2, "then the task runs again, in the same terminal");
  assert.equal(t.opens()[1].sessionId, t.opens()[0].sessionId);
  assert.deepEqual(
    service.getSnapshot().runs.map((run) => `${run.taskId}:${run.state}`),
    ["x:running", "x:cancelled"],
  );
  service.dispose();
});

test("E7: Restart on a terminal that is not a task's still restarts its shell", async () => {
  const t = await harness([task("x")]);
  const service = t.taskService();
  const shell = t.ui.newTerminal();
  await settle();
  t.ui.restart(shell);
  await settle();
  assert.equal(t.opens().length, 2, "the shell restarted");
  assert.equal(service.getSnapshot().runs.length, 0, "and nothing was taken for a task");
});

test("E8: a workspace's old task layer claims no Restart once its context is gone", async () => {
  const t = await ranOnce([task("x")]);
  t.service.dispose();
  const next = t.taskService();
  t.ui.restart(t.session); // claimed by the current layer, not the disposed one
  await settle();
  assert.equal(next.getSnapshot().runs.length, 1);
  assert.equal(next.getSnapshot().runs[0].state, "running");
});
