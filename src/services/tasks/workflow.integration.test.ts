/**
 * WS22: the developer workflow across its seams — discover/run a task, watch its output reach
 * the terminal and the matchers, navigate from that output to a file, then rerun. The pieces
 * each have their own tests; this file pins the invariants that only hold *between* them:
 *
 * 1. Diagnostic ownership is isolated: a task rerun replaces only its own owner's diagnostics
 *    and never disturbs another producer's (a language server's), and a cancelled rerun
 *    publishes nothing, so it never wipes the last good set.
 * 2. Build/test output navigation: the exact bytes a task writes to its terminal, read back as
 *    the terminal shows them, become workspace-bounded navigations — a relative path resolves
 *    against the task's own terminal folder, and anything outside the workspace is refused.
 *
 * It runs the real `TaskService` over the real `TerminalService` and the fake native side, and
 * uses the one navigation pipeline (`findPathLinks` + `resolvePathLink`), never a second one.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createTaskService, taskOwner } from "./service.ts";
import { TASK_DEFINITIONS, readTasks } from "./model.ts";
import { createSettingsRegistry } from "../settings/settings.ts";
import { createTerminalService } from "../terminalService.ts";
import { createTerminalUi } from "../terminalUi.ts";
import { createProfileRegistry } from "../terminalProfiles.ts";
import { FakeNative } from "../terminalNative.fake.ts";
import { allProblems, groupByFile, publishProblems, resetProblems } from "../panel/problems.ts";
import { findPathLinks, resolvePathLink } from "../terminalIde.ts";
import type { TerminalId, WorkspaceId } from "../terminalProtocol.ts";

const A = "file://c:/a" as WorkspaceId;
const BASH = "C:/Program Files/Git/bin/bash.exe";
const SHELLS = [{ name: "Git Bash", path: BASH, kind: "bash", isDefault: true }];
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const task = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  command: `echo ${id}`,
  ...extra,
});

async function setup(configured: unknown[], folders = ["C:/work"]) {
  resetProblems();
  const fake = new FakeNative();
  const settings = createSettingsRegistry([TASK_DEFINITIONS], null);
  settings.set(TASK_DEFINITIONS, "workspace", readTasks(configured) as never, A);
  const terminals = createTerminalService(A, fake);
  const registry = createProfileRegistry(async () => SHELLS);
  await registry.load();
  const profiles = registry.forWorkspace(A);
  const ui = createTerminalUi(terminals, profiles);
  const service = createTaskService({
    workspace: A,
    folders,
    settings,
    terminals,
    ui: { activate: (id) => ui.activate(id), restart: (id) => ui.restart(id) },
    profiles,
    trusted: async () => true,
    publish: publishProblems,
    killAfterMs: 20,
    drainTimeoutMs: 20,
  });
  const opens = () =>
    fake.calls
      .filter((c) => c.command === "open")
      .map((c) => c.args as { sessionId: TerminalId; generation: number; cwd: string });
  const finish = async (index: number, code: number, output = "") => {
    await settle();
    const open = opens()[index];
    if (output) fake.output(open.sessionId, open.generation, output);
    fake.end(open.sessionId, open.generation, code);
    await settle();
  };
  return { fake, terminals, service, opens, finish };
}

const owners = () =>
  allProblems()
    .map((o) => o.owner)
    .sort();
const taskFiles = () =>
  groupByFile(allProblems().filter((o) => o.owner.startsWith("task:"))).map((f) => [
    f.file,
    f.problems.length,
  ]);

test("a task rerun replaces its own diagnostics but never a language server's (ownership)", async () => {
  const t = await setup([
    task("check", { command: "npx tsc --noEmit --pretty false", problemMatcher: ["tsc"] }),
  ]);
  // A language server already published a diagnostic for a file of this workspace.
  publishProblems("lsp:ts", "TypeScript", [
    { file: "C:/work/src/live.ts", line: 5, column: 2, severity: "error", message: "from LSP" },
  ]);

  // The task runs and finds two problems of its own.
  const first = t.service.run("check");
  await t.finish(
    0,
    2,
    "src/app.ts(3,7): error TS2322: Bad.\r\nsrc/lib.ts(1,1): error TS1005: ';' expected.\r\n",
  );
  await first;
  assert.deepEqual(owners(), ["lsp:ts", taskOwner("check")]);
  assert.deepEqual(taskFiles(), [
    ["C:/work/src/app.ts", 1],
    ["C:/work/src/lib.ts", 1],
  ]);

  // Rerun: its output alone decides. The task owner is replaced; the LSP owner is untouched.
  const second = t.service.run("check");
  await t.finish(1, 2, "src/app.ts(9,1): error TS2304: Other.\r\n");
  await second;
  assert.deepEqual(owners(), ["lsp:ts", taskOwner("check")]);
  assert.deepEqual(taskFiles(), [["C:/work/src/app.ts", 1]]);
  // The language server's diagnostic survived both runs, unchanged.
  const lsp = allProblems().find((o) => o.owner === "lsp:ts")!;
  assert.deepEqual(
    [lsp.diagnostics[0].file, lsp.diagnostics[0].line, lsp.diagnostics[0].message],
    ["C:/work/src/live.ts", 5, "from LSP"],
  );
});

test("a cancelled rerun publishes nothing, so the last good diagnostics stay", async () => {
  const t = await setup([
    task("check", { command: "npx tsc --noEmit --pretty false", problemMatcher: ["tsc"] }),
  ]);
  const first = t.service.run("check");
  await t.finish(0, 2, "src/app.ts(3,7): error TS2322: Bad.\r\n");
  await first;
  assert.deepEqual(taskFiles(), [["C:/work/src/app.ts", 1]]);

  // Rerun, then stop it before it finishes: a stopped run proves nothing, so what it printed
  // changes nothing — the previous run's diagnostics are left in place.
  const again = t.service.run("check");
  await settle();
  const root = t.service.getSnapshot().runs.find((r) => r.taskId === "check")!.executionId;
  t.service.cancel(root);
  await new Promise((resolve) => setTimeout(resolve, 40)); // past killAfter
  assert.equal((await again).state, "cancelled");
  assert.deepEqual(taskFiles(), [["C:/work/src/app.ts", 1]]);
});

test("output a task wrote to its terminal becomes workspace-bounded navigations", async () => {
  // The task runs in a sub-folder of the workspace; relative paths it prints are relative to
  // there, which is the folder its terminal was started in.
  const t = await setup([task("build", { command: "make", cwd: "app" })]);
  const captured: string[] = [];
  const done = t.service.run("build");
  await settle();
  const sessionId = t.service.getSnapshot().runs[0].sessionId!;
  // Attach a view, exactly as the terminal panel does, to read what the user sees.
  t.terminals.attach(sessionId, {
    output: (chunk, accepted) => {
      captured.push(Buffer.from(chunk.bytes).toString("utf8"));
      accepted();
    },
    ended: () => {},
  });
  await settle();
  const open = t.opens()[0];
  assert.equal(open.cwd, "C:/work/app");
  // A compiler error (relative), a node-style stack frame (absolute, in workspace), and a path
  // outside the workspace — all in the same output.
  t.fake.output(
    open.sessionId,
    open.generation,
    "src/main.ts:4:2: error: boom\r\n" +
      "    at run (C:\\work\\app\\lib\\x.ts:11:9)\r\n" +
      "D:\\secret\\escape.ts:1:1: leaked\r\n",
  );
  t.fake.end(open.sessionId, open.generation, 1);
  await done;

  // The navigation pipeline reads the terminal's own folder as the base for relative paths —
  // the same wiring the panel uses (base = the session's cwd).
  const base = t.terminals.get(sessionId)!.cwd;
  const navigate = (line: string) =>
    findPathLinks(line).flatMap((link) => {
      const target = resolvePathLink(link, { base, folders: ["C:/work"] });
      return target ? [target] : [];
    });
  const lines = captured.join("").split(/\r?\n/);

  // The relative compiler path resolves against the task's folder, with its line and column.
  assert.deepEqual(navigate(lines.find((l) => l.startsWith("src/main.ts"))!), [
    { path: "C:/work/app/src/main.ts", line: 4, column: 2 },
  ]);
  // The absolute in-workspace stack frame resolves to itself.
  assert.deepEqual(navigate(lines.find((l) => l.includes("lib\\x.ts"))!), [
    { path: "C:/work/app/lib/x.ts", line: 11, column: 9 },
  ]);
  // The path outside every workspace folder is refused — output never escapes the boundary.
  assert.deepEqual(navigate(lines.find((l) => l.includes("secret"))!), []);
});
