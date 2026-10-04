import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileUri } from "../resource.ts";
import { createSettingsRegistry } from "../settings/settings.ts";
import type { WorkspaceId } from "../terminalProtocol.ts";
import { createBreakpoints } from "./breakpoints.ts";
import { DEBUG_CONFIGURATIONS, DEBUG_SETTING_LIST } from "./config.ts";
import type { AdapterChannel, AdapterTransport, ConnectionEnd } from "./connection.ts";
import { createDebugService, isFinal, type DebugService } from "./service.ts";

/**
 * The golden end-to-end test (IDE-05): Yavin's DebugService against a real debug adapter,
 * debugpy, debugging a real Python program -- initialize, initialized, launch, setBreakpoints,
 * configurationDone, stopped, threads, stackTrace, scopes, variables, next, evaluate, stepOut,
 * continue, terminated. The adapter runs as a process with the Content-Length framing the
 * native side uses (`dap.rs` on `lsp_framing`). debugpy is found as `dap.rs`'s own test finds
 * it: a Python that imports it, or the copy bundled with the VS Code Python debugger
 * extension. Skipped where there is none.
 */

function findDebugpy(): { python: string; prefix: string[]; prelude: string } | null {
  const candidates: [string, string[]][] = [];
  if (process.env.YAVIN_TEST_PYTHON) candidates.push([process.env.YAVIN_TEST_PYTHON, []]);
  candidates.push(["py", ["-3"]], ["python3", []], ["python", []]);
  let libs = process.env.YAVIN_TEST_DEBUGPY ?? null;
  if (!libs) {
    const extensions = join(homedir(), ".vscode", "extensions");
    if (existsSync(extensions))
      for (const name of readdirSync(extensions).filter((n) =>
        n.startsWith("ms-python.debugpy-"),
      )) {
        const candidate = join(extensions, name, "bundled", "libs");
        if (existsSync(join(candidate, "debugpy"))) libs = candidate;
      }
  }
  const prelude = libs ? `import sys; sys.path.insert(0, ${JSON.stringify(libs)}); ` : "";
  for (const [python, prefix] of candidates) {
    const probe = spawnSync(python, [...prefix, "-c", `${prelude}import debugpy`], {
      encoding: "utf8",
      timeout: 20_000,
    });
    if (probe.status === 0) return { python, prefix, prelude };
  }
  return null;
}

const debugpy = findDebugpy();

/** debugpy's adapter over stdio, framed as the native side frames it. */
function processTransport(found: NonNullable<typeof debugpy>): AdapterTransport {
  return {
    async start(_adapter, root) {
      const child = spawn(
        found.python,
        [
          ...found.prefix,
          "-c",
          `${found.prelude}import runpy; runpy.run_module('debugpy.adapter', run_name='__main__')`,
        ],
        { cwd: root, stdio: ["pipe", "pipe", "pipe"] },
      );
      let onMessage: (message: string) => void = () => {};
      const closers = new Set<(end: ConnectionEnd) => void>();
      let buffer = Buffer.alloc(0);
      child.stdout.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
          const end = buffer.indexOf("\r\n\r\n");
          if (end < 0) return;
          const length = Number(
            /Content-Length: *(\d+)/i.exec(buffer.subarray(0, end).toString())?.[1],
          );
          if (buffer.length < end + 4 + length) return;
          const message = buffer.subarray(end + 4, end + 4 + length).toString("utf8");
          buffer = buffer.subarray(end + 4 + length);
          onMessage(message);
        }
      });
      child.stderr.resume();
      child.on("exit", (code) => {
        for (const close of closers)
          close({ reason: `The debug adapter exited with code ${code}.`, error: false });
      });
      const channel: AdapterChannel = {
        program: found.python,
        send(message) {
          const body = Buffer.from(message, "utf8");
          child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
          child.stdin.write(body);
        },
        onMessage(listener) {
          onMessage = listener;
          return () => (onMessage = () => {});
        },
        onClose(listener) {
          closers.add(listener);
          return () => closers.delete(listener);
        },
        async stop() {
          if (child.exitCode === null) child.kill();
        },
      };
      return channel;
    },
  };
}

async function until(check: () => boolean, what: string, ms = 30_000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const PROGRAM = [
  "def add(a, b):", //            1
  "    total = a + b", //         2
  "    return total", //          3
  "", //                          4
  "items = [1, 2, 3]", //         5
  "result = add(items[0], items[1])", // 6
  'print("result", result)', //   7
  "",
].join("\n");

test(
  "debugpy: a real session from initialize to terminated, through DebugService",
  { skip: !debugpy && "debugpy is not available" },
  async () => {
    const folder = await mkdtemp(join(tmpdir(), "yavin-debugpy-"));
    let service: DebugService | null = null;
    try {
      await writeFile(join(folder, "app.py"), PROGRAM);
      const workspace = fileUri(folder).path as unknown as WorkspaceId;
      const settings = createSettingsRegistry([...DEBUG_SETTING_LIST], null);
      settings.set(
        DEBUG_CONFIGURATIONS,
        "workspace",
        [{ id: "app", name: "app.py", adapter: "debugpy", program: "app.py" }] as never,
        workspace,
      );
      const breakpoints = createBreakpoints(workspace);
      breakpoints.add(fileUri(join(folder, "app.py")), 2);
      service = createDebugService({
        workspace,
        folders: [folder],
        settings,
        breakpoints,
        transport: processTransport(debugpy!),
        trusted: async () => true,
      });
      const snap = () => service!.getSnapshot();

      await service.start("app");
      assert.equal(breakpoints.getSnapshot()[0].verified, true, "debugpy verified the breakpoint");

      // Stopped at the breakpoint, inside add(): the stack, the frame, the locals.
      await until(
        () => snap().session?.state === "stopped" && snap().scopes.length > 0,
        "the breakpoint",
      );
      assert.equal(snap().session?.stoppedReason, "breakpoint");
      assert.ok(snap().threads.length >= 1);
      const top = snap().frames[0];
      assert.equal(top.name, "add");
      assert.equal(top.line, 2);
      assert.equal(
        top.resource,
        breakpoints.getSnapshot()[0].resource,
        "the frame's file, by resource identity",
      );
      assert.equal(snap().focus?.line, 2);
      const locals = snap().scopes.find((scope) => /local/i.test(scope.name))!;
      const values = await service.expand(locals.variablesReference);
      const byName = new Map(values?.map((v) => [v.name, v.value]));
      assert.equal(byName.get("a"), "1");
      assert.equal(byName.get("b"), "2");

      // Step over: line 3, where total exists.
      await service.stepOver();
      await until(
        () =>
          snap().session?.state === "stopped" &&
          snap().frames[0]?.line === 3 &&
          snap().scopes.length > 0,
        "the step",
      );
      const after = await service.expand(
        snap().scopes.find((scope) => /local/i.test(scope.name))!.variablesReference,
      );
      assert.equal(after?.find((v) => v.name === "total")?.value, "3");

      // The Debug Console evaluates in the selected frame.
      await service.evaluate("a + b * 10");
      assert.equal(
        snap()
          .console.filter((e) => e.kind === "result")
          .at(-1)?.text,
        "21",
      );

      // A list is expandable, one level at a time.
      await service.stepOut();
      await until(
        () =>
          snap().session?.state === "stopped" &&
          snap().frames[0]?.name === "<module>" &&
          snap().scopes.length > 0,
        "the step out",
      );
      const globals = snap().scopes.find((scope) => /global/i.test(scope.name)) ?? snap().scopes[0];
      const module = await service.expand(globals.variablesReference);
      const items = module?.find((v) => v.name === "items");
      assert.ok(items && items.variablesReference > 0, "items can be expanded");
      const children = await service.expand(items.variablesReference);
      assert.ok(children?.some((v) => v.value === "3"));

      // Continue: the program prints and ends; the session ends with it.
      await service.continue();
      await until(() => isFinal(snap().session!.state), "the end");
      assert.equal(snap().session?.state, "terminated");
      assert.ok(
        snap().console.some((entry) => entry.kind === "stdout" && entry.text === "result 3"),
        "the program's output arrived as output events, one line",
      );
      assert.equal(breakpoints.getSnapshot()[0].verified, null);
    } finally {
      service?.dispose();
      await rm(folder, { recursive: true, force: true }).catch(() => {});
    }
  },
);
