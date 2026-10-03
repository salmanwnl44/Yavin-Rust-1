import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { appAlert, editorSelections, withEditor } from "./editor-harness";

interface Call {
  command: string;
  args: Record<string, unknown>;
}

const CMD = "C:\\Windows\\System32\\cmd.exe";
const BASH = "C:\\Program Files\\Git\\bin\\bash.exe";

/** Opens the bottom panel through the Terminal menu. */
async function openPanel(page: Page) {
  await page.getByRole("menubar").getByRole("menuitem", { name: "Terminal", exact: true }).click();
  await page
    .getByRole("menu", { name: "Terminal", exact: true })
    .getByRole("menuitemcheckbox", { name: "Show / Hide Panel", exact: true })
    .click();
}

async function terminalMenu(page: Page, item: string) {
  await page.getByRole("menubar").getByRole("menuitem", { name: "Terminal", exact: true }).click();
  await page
    .getByRole("menu", { name: "Terminal", exact: true })
    .getByRole("menuitem", { name: item, exact: true })
    .click();
}

/**
 * Installs a Tauri mock that can deliver events, so shells can be driven from the test.
 * `failOpen` makes a spawn fail the way a missing workspace would.
 */
async function desktop(
  page: Page,
  options: {
    failOpen?: string;
    failGit?: string;
    ports?: unknown[];
    checkers?: { id: string; label: string }[];
    checkerOutput?: string;
    /** What the checker exits with. Nonzero and no diagnostics means it did not run. */
    checkerCode?: number;
    trust?: { trusted: boolean; decided: boolean; root: string | null; parent: string | null };
    /** Discovery finds one Unix bash, the default: its folders are this POSIX workspace's. */
    unixShell?: boolean;
  } = {},
) {
  await page.addInitScript((setup) => {
    const calls: Call[] = [];
    // Trust is stateful, like the native side: a decision made in the dialog must change
    // what later calls see, or the test can never observe the effect of trusting.
    let trust = setup.trust ?? {
      trusted: true,
      decided: true,
      root: "/work",
      parent: "/",
    };
    const callbacks: Record<number, (event: unknown) => void> = {};
    const listeners: Record<string, number[]> = {};
    const sequences: Record<string, number> = {};
    type Channel = { onmessage: (message: unknown) => void };
    /**
     * Each launch, by `sessionId:generation`, as the native side keeps it: the service's
     * lifecycle channel, each attached view's channel, and what a view attaching later is
     * replayed (its `Running`, its output, its end).
     */
    const launches: Record<
      string,
      { lifecycle: Channel; views: Record<string, Channel>; replay: unknown[] }
    > = {};
    let nextId = 1;

    Object.assign(window, {
      __calls: calls,
      // Delivers a native event to every listener registered for it.
      __emit: (event: string, payload: unknown) => {
        for (const id of listeners[event] ?? []) callbacks[id]?.({ event, id, payload });
      },
      // A terminal's output and exit as the native side sends them -- output to each view
      // attached to that launch, its end (Exiting, then the exit) to the service and the views,
      // never broadcast: for its latest launch unless one is named, bytes in base64, numbered
      // from 0 within the launch.
      // A shell-integration signal (TERMINAL-05A) goes to the service and the views, live,
      // and is never replayed.
      __terminal: (
        kind: "output" | "exit" | "shell",
        sessionId: string,
        value: string | number | Record<string, unknown>,
        launch?: number,
      ) => {
        const generation =
          launch ??
          (calls.filter((c) => c.command === "terminal_open" && c.args.id === sessionId).at(-1)
            ?.args.generation as number);
        const key = `${sessionId}:${generation}`;
        const next = sequences[key] ?? 0;
        const launch_ = launches[key];
        if (!launch_) return;
        const toViews = (message: unknown) => {
          launch_.replay.push(message);
          for (const view of Object.values(launch_.views)) view.onmessage(message);
        };
        const toAll = (message: unknown) => {
          toViews(message);
          launch_.lifecycle.onmessage(message);
        };
        if (kind === "shell") {
          const message = { kind, sessionId, generation, ...(value as object) };
          for (const view of Object.values(launch_.views)) view.onmessage(message);
          launch_.lifecycle.onmessage(message);
        } else if (kind === "output") {
          sequences[key] = next + 1;
          const bytes = btoa(String.fromCharCode(...new TextEncoder().encode(value as string)));
          toViews({ kind: "output", sessionId, generation, seq: next, bytes });
        } else {
          const lastSeq = next === 0 ? null : next - 1;
          toAll({ kind: "state", sessionId, generation, state: "Exiting" });
          toAll({ kind: "exit", sessionId, generation, exitCode: value, lastSeq });
          launch_.views = {};
        }
      },
      isTauri: true,
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        transformCallback: (callback: (event: unknown) => void) => {
          const id = nextId++;
          callbacks[id] = callback;
          return id;
        },
        unregisterCallback: (id: number) => delete callbacks[id],
        invoke: async (command: string, raw: Record<string, unknown> = {}) => {
          // Terminal commands take one contract request; it is recorded flat, with the
          // session id as `id`, the shell as `shell` and the size as `cols`/`rows`.
          const request = raw.request as
            | {
                sessionId: string;
                profile?: { executable: string; cwd: string | null } | null;
                cwd?: string | null;
                dimensions?: { cols: number; rows: number };
              }
            | undefined;
          const args: Record<string, unknown> = request
            ? {
                ...request,
                id: request.sessionId,
                shell: request.profile?.executable ?? "",
                cwd: request.cwd ?? request.profile?.cwd ?? undefined,
                cols: request.dimensions?.cols,
                rows: request.dimensions?.rows,
                ...(raw.subscriptionId ? { subscriptionId: raw.subscriptionId } : {}),
              }
            : raw;
          calls.push({ command, args });
          if (command === "plugin:event|listen") {
            const event = args.event as string;
            (listeners[event] ??= []).push(args.handler as number);
            return nextId++;
          }
          if (command === "get_default_workspace") return "/work";
          // One folder, for a reveal to show, and one file.
          if (command === "list_workspace_files" && args.path === "/work/src")
            return { path: "/work/src", name: "src", is_dir: true, children: [] };
          if (command === "list_workspace_files")
            return {
              path: "/work",
              name: "work",
              is_dir: true,
              children: [
                { path: "/work/src", name: "src", is_dir: true, children: null },
                { path: "/work/file.ts", name: "file.ts", is_dir: false, children: null },
              ],
            };
          // Any file reads as 30 numbered lines, so a jump to a line can be checked.
          if (command === "read_file_content")
            return Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
          if (command === "list_listening_ports") return setup.ports ?? [];
          if (command === "workspace_trust") return trust;
          if (command === "set_workspace_trust") {
            trust = { ...trust, trusted: (args as { trusted: boolean }).trusted, decided: true };
            return trust;
          }
          if (command === "trusted_folders") return trust.trusted ? [trust.root] : [];
          if (command === "forget_trusted_folder") {
            trust = { ...trust, trusted: false, decided: false };
            return trust;
          }
          // A restricted folder is offered no checkers, matching the native side.
          if (command === "available_checkers") return trust.trusted ? (setup.checkers ?? []) : [];
          // Open Folder… answers with whatever the test put in `__openFolder`.
          if (command === "open_folder_dialog")
            return (window as unknown as { __openFolder?: string }).__openFolder ?? null;
          if (command === "run_checker") {
            const scenario = window as unknown as {
              __scenarioCheckerOutput?: string;
              __scenarioCheckerCode?: number;
              __checkerDelay?: number;
            };
            // A slow checker (a cold `cargo check`), for what happens while it runs.
            if (scenario.__checkerDelay)
              await new Promise((resolve) => setTimeout(resolve, scenario.__checkerDelay));
            const output = scenario.__scenarioCheckerOutput ?? setup.checkerOutput ?? "";
            // A checker exits nonzero when it finds problems, so the tests say which.
            return { output, code: scenario.__scenarioCheckerCode ?? setup.checkerCode ?? 0 };
          }
          if (command === "stop_listening_process") return null;
          // Discovery (TERMINAL-05): every shell looked for, one of them not installed.
          if (command === "terminal_shells" && setup.unixShell)
            return [
              {
                name: "Bash",
                path: "/bin/bash",
                kind: "bash",
                platform: "unix",
                available: true,
                reason: null,
                isDefault: true,
              },
            ];
          if (command === "terminal_shells")
            return [
              {
                name: "Command Prompt",
                path: "C:\\Windows\\System32\\cmd.exe",
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
                path: "C:\\Program Files\\Git\\bin\\bash.exe",
                kind: "bash",
                platform: "windows",
                available: true,
                reason: null,
                isDefault: false,
              },
            ];
          if (command === "terminal_open") {
            if (setup.failOpen) throw setup.failOpen;
            const running = {
              kind: "state",
              sessionId: request!.sessionId,
              generation: args.generation,
              state: "Running",
              pid: 4242,
            };
            launches[`${request!.sessionId}:${args.generation}`] = {
              lifecycle: raw.events as Channel,
              views: {},
              replay: [running],
            };
            // A slow start, for tests of what happens meanwhile; its end is recorded too.
            const delay = (window as unknown as { __openDelay?: number }).__openDelay;
            if (delay) {
              await new Promise((resolve) => setTimeout(resolve, delay));
              calls.push({ command: "terminal_open:done", args });
            }
            // The session as the native side answers it: already running.
            return {
              ...request,
              generation: args.generation,
              state: "Running",
              pid: 4242,
              startedAt: 0,
              exitCode: null,
            };
          }
          // A view attaches: replayed what its launch has said so far, then sent it live.
          if (command === "terminal_subscribe") {
            const subscribed = raw.request as {
              subscriptionId: string;
              sessionId: string;
              generation: number;
            };
            const launch_ = launches[`${subscribed.sessionId}:${subscribed.generation}`];
            if (!launch_) throw "InvalidSession: That terminal is no longer running.";
            const view = raw.events as Channel;
            for (const message of launch_.replay) view.onmessage(message);
            launch_.views[subscribed.subscriptionId] = view;
            return null;
          }
          if (command === "terminal_unsubscribe") {
            const { subscriptionId } = raw.request as { subscriptionId: string };
            for (const launch_ of Object.values(launches)) delete launch_.views[subscriptionId];
            return null;
          }
          if (command === "git_open_repo") return { repoId: "/work", root: "/work" };
          if (command === "git_repo_state") return "";
          if (command === "git_exec")
            return setup.failGit
              ? { stdout: "", stderr: setup.failGit, code: 128, truncated: false }
              : { stdout: "", stderr: "", code: 0, truncated: false };
          return null;
        },
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
    });
  }, options);
  await page.goto("/");
}

const calls = (page: Page, command: string) =>
  page.evaluate(
    (name) =>
      (window as unknown as { __calls: Call[] }).__calls.filter((call) => call.command === name),
    command,
  );

const countCalls = async (page: Page, command: string) => (await calls(page, command)).length;

type TerminalEvent = (
  kind: "output" | "exit" | "shell",
  id: string,
  value: string | number | Record<string, unknown>,
  launch?: number,
) => void;

/** A shell-integration signal from a terminal's shell (TERMINAL-05A), as the native side found it. */
const signal = (page: Page, id: string, fields: Record<string, unknown>, launch?: number) =>
  page.evaluate(
    ([sessionId, value, generation]) =>
      (window as unknown as { __terminal: TerminalEvent }).__terminal(
        "shell",
        sessionId as string,
        value as Record<string, unknown>,
        generation as number | undefined,
      ),
    [id, fields, launch] as const,
  );

/** Output from a terminal's shell (its latest launch unless `launch` names another). */
const output = (page: Page, id: string, text: string, launch?: number) =>
  page.evaluate(
    ([sessionId, value, generation]) =>
      (window as unknown as { __terminal: TerminalEvent }).__terminal(
        "output",
        sessionId as string,
        value as string,
        generation as number | undefined,
      ),
    [id, text, launch] as const,
  );

/** A terminal's shell exiting with `code` (its latest launch unless `launch` names another). */
const exit = (page: Page, id: string, code: number, launch?: number) =>
  page.evaluate(
    ([sessionId, value, generation]) =>
      (window as unknown as { __terminal: TerminalEvent }).__terminal(
        "exit",
        sessionId as string,
        value as number,
        generation as number | undefined,
      ),
    [id, code, launch] as const,
  );

const uniqueIds = async (page: Page) => {
  const opened = await calls(page, "terminal_open");
  return [...new Set(opened.map((call) => call.args.id as string))];
};

/**
 * The distinct terminals opened so far, once at least `expected` exist. Ids are
 * de-duplicated because React's development StrictMode mounts effects twice, which
 * opens the same terminal again.
 */
async function terminalIds(page: Page, expected = 1): Promise<string[]> {
  await expect.poll(async () => (await uniqueIds(page)).length).toBeGreaterThanOrEqual(expected);
  return uniqueIds(page);
}

const view = (page: Page, id: string) => page.getByLabel(`Terminal ${id}`);

test("a shell starts with the panel and its output is displayed", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  const [id] = await terminalIds(page);

  await expect(page.getByRole("tab", { name: "Command Prompt", exact: true })).toBeVisible();
  const [open] = await calls(page, "terminal_open");
  // The size sent to the shell is a real measurement, not a placeholder.
  expect(open.args.cols).toBeGreaterThan(0);
  expect(open.args.rows).toBeGreaterThan(0);

  await output(page, id, "hello from the shell\r\n");
  await expect(view(page, id)).toContainText("hello from the shell");
});

test("typing reaches the shell as bytes", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  const [id] = await terminalIds(page);
  await view(page, id).click();

  await page.keyboard.type("ls");
  await page.keyboard.press("Enter");

  await expect
    .poll(async () => (await calls(page, "terminal_write")).map((c) => c.args.data).join(""))
    .toBe("ls\r");
});

test("output is delivered only to the terminal that produced it", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);

  await page.getByLabel("New Terminal").click();
  const [first, second] = await terminalIds(page, 2);

  await output(page, first, "belongs to one");
  await output(page, second, "belongs to two");

  await expect(view(page, second)).toContainText("belongs to two");
  await expect(view(page, second)).not.toContainText("belongs to one");
  // Switching back shows the first terminal with only its own output.
  await page.getByRole("tab", { name: "Command Prompt", exact: true }).click();
  await expect(view(page, first)).toContainText("belongs to one");
  await expect(view(page, first)).not.toContainText("belongs to two");
});

test("terminals are named for their shell and numbered when repeated", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);
  await page.getByLabel("New Terminal").click();

  await expect(page.getByRole("tab", { name: "Command Prompt", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Command Prompt (2)", exact: true })).toBeVisible();
});

test("a different shell can be chosen for a new terminal", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);

  await page.getByLabel("Choose a shell").click();
  await page.getByRole("menuitem", { name: "Git Bash", exact: true }).click();
  await terminalIds(page, 2);

  const opened = await calls(page, "terminal_open");
  expect(opened.some((call) => call.args.shell === BASH)).toBe(true);
  expect(opened.some((call) => call.args.shell === CMD)).toBe(true);
  await expect(page.getByRole("tab", { name: "Git Bash", exact: true })).toBeVisible();
});

test("splitting shows two terminals at once and unsplitting keeps both", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);

  await page.getByLabel("Split Terminal").click();
  const [first, second] = await terminalIds(page, 2);
  await expect(view(page, first)).toBeVisible();
  await expect(view(page, second)).toBeVisible();

  // Unsplitting hides the second pane but does not end its shell.
  const closed = await countCalls(page, "terminal_close");
  await page.getByLabel("Unsplit Terminal").click();
  await expect(view(page, second)).toBeHidden();
  expect(await countCalls(page, "terminal_close")).toBe(closed);
});

test("closing one terminal leaves the others running", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);
  await page.getByLabel("New Terminal").click();
  const [first, second] = await terminalIds(page, 2);

  const closed = await countCalls(page, "terminal_close");
  await page.getByLabel("Close Command Prompt (2)").click();

  await expect.poll(async () => countCalls(page, "terminal_close")).toBe(closed + 1);
  const closes = await calls(page, "terminal_close");
  expect(closes[closes.length - 1].args.id).toBe(second);
  await expect(view(page, first)).toBeVisible();
});

test("closing the last terminal leaves the panel open with a way to start another", async ({
  page,
}) => {
  // The panel holds Problems, Output and Ports as well, so it must not be torn down because
  // a terminal exited -- and it must not silently respawn the shell that was just killed.
  await desktop(page);
  await openPanel(page);
  const [first] = await terminalIds(page);
  await expect(page.getByRole("tab", { name: "Command Prompt", exact: true })).toBeVisible();

  await terminalMenu(page, "Close Terminal");
  await expect(page.getByRole("tablist", { name: "Panel views" })).toBeVisible();
  const empty = page.getByRole("region", { name: "No terminals" });
  await expect(empty).toBeVisible();
  expect(await terminalIds(page)).toHaveLength(1); // no new shell was started

  await empty.getByRole("button", { name: "New Terminal" }).click();
  const ids = await terminalIds(page, 2);
  expect(ids[1]).not.toBe(first);
  await expect(view(page, ids[1])).toBeVisible();
});

test("reopening the panel after closing every terminal starts a fresh one", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  const [first] = await terminalIds(page);

  await terminalMenu(page, "Close Terminal");
  await page.getByLabel("Close Panel").click();

  await openPanel(page);
  const ids = await terminalIds(page, 2);
  expect(ids[1]).not.toBe(first);
  await expect(view(page, ids[1])).toBeVisible();
});

test("hiding the panel keeps shells running", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  const [id] = await terminalIds(page);
  await output(page, id, "long running build");

  const closed = await countCalls(page, "terminal_close");
  await page.getByLabel("Close Panel").click();
  await expect(view(page, id)).toBeHidden();
  // Nothing was killed: the shell is still there, with its scrollback.
  expect(await countCalls(page, "terminal_close")).toBe(closed);

  await openPanel(page);
  await expect(view(page, id)).toContainText("long running build");
  expect(await uniqueIds(page)).toHaveLength(1);
});

test("a shell that will not start says why instead of looking idle", async ({ page }) => {
  await desktop(page, { failOpen: "InvalidWorkspace: Open a workspace first" });
  await openPanel(page);
  const [id] = await terminalIds(page);

  await expect(page.getByRole("status")).toContainText("Open a workspace first");
  await expect(view(page, id)).toContainText("Open a workspace first");
  // Nothing is sent to a shell that never started.
  await view(page, id).click();
  await page.keyboard.type("x");
  await expect.poll(async () => countCalls(page, "terminal_write")).toBe(0);
});

test("an exited shell reports its code and can be restarted", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  const [id] = await terminalIds(page);

  await exit(page, id, 130);
  await expect(view(page, id)).toContainText("exited with code 130");

  // Typing into a dead shell is not sent anywhere.
  await view(page, id).click();
  await page.keyboard.type("x");
  expect(await countCalls(page, "terminal_write")).toBe(0);

  const opens = await countCalls(page, "terminal_open");
  await page.getByRole("button", { name: "Restart", exact: true }).click();
  await expect.poll(async () => countCalls(page, "terminal_open")).toBe(opens + 1);
  // The restarted shell keeps the same identity, so its tab does not change.
  expect(await uniqueIds(page)).toEqual([id]);
});

test("a shell with integration shows where it is and how its last command ended", async ({
  page,
}) => {
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);
  await page.getByLabel("Choose a shell").click();
  await page.getByRole("menuitem", { name: "Git Bash", exact: true }).click();
  const [, bash] = await terminalIds(page, 2);
  const status = page.getByRole("status").filter({ hasText: "Running" });
  await expect(status).toHaveText("Running");

  // Git Bash reports its MSYS folder; the status line shows the Windows path it names.
  await signal(page, bash, { signal: "cwd", uri: "file://BOX/c/Users/me/my project", local: true });
  await expect(page.getByTestId("terminal-folder")).toHaveText("C:/Users/me/my project");
  await signal(page, bash, { signal: "prompt" });
  await signal(page, bash, { signal: "input" });
  await signal(page, bash, { signal: "executing" });
  await expect(status).toContainText("Running a command");
  await signal(page, bash, { signal: "finished", exitCode: 1 });
  await expect(status).toContainText("Last command exited with 1");
  // A command's failure is not the terminal's: it still runs and takes input.
  await view(page, bash).click();
  await page.keyboard.type("x");
  await expect.poll(async () => countCalls(page, "terminal_write")).toBeGreaterThan(0);

  // A folder on another machine is never shown as a local one.
  await signal(page, bash, { signal: "cwd", uri: "file://build-server/home/ci", local: false });
  await expect(page.getByTestId("terminal-folder")).toHaveText("build-server (remote)");
});

test("shell integration is per terminal and starts again on restart", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  const [cmd] = await terminalIds(page);
  await page.getByLabel("Choose a shell").click();
  await page.getByRole("menuitem", { name: "Git Bash", exact: true }).click();
  const [, bash] = await terminalIds(page, 2);

  // The Command Prompt has no integration: the focused Git Bash's line is not its business.
  await signal(page, bash, { signal: "cwd", uri: "file:///c/work", local: true });
  await expect(page.getByTestId("terminal-folder")).toHaveText("C:/work");
  await page.getByRole("tab", { name: "Command Prompt", exact: true }).click();
  await expect(page.getByTestId("terminal-folder")).toHaveCount(0);
  // Signals of a terminal that is not shown change only that terminal.
  await signal(page, cmd, { signal: "invalid" });
  await expect(page.getByRole("status").filter({ hasText: "Running" })).toContainText(
    "unreadable sequences",
  );

  await page.getByRole("tab", { name: "Git Bash", exact: true }).click();
  await expect(page.getByTestId("terminal-folder")).toHaveText("C:/work");
  const before = (await calls(page, "terminal_open")).filter((c) => c.args.id === bash).length;
  await exit(page, bash, 0);
  await page.getByRole("button", { name: "Restart", exact: true }).click();
  await expect
    .poll(async () => (await calls(page, "terminal_open")).filter((c) => c.args.id === bash).length)
    .toBe(before + 1);
  // A new shell: nothing the old one reported is true of it.
  await expect(page.getByRole("status").filter({ hasText: "Running" })).toHaveText("Running");
  await expect(page.getByTestId("terminal-folder")).toHaveCount(0);
});

// --- IDE integration (TERMINAL-06) ------------------------------------------------------------

/** Runs a command from the palette, as a user would. */
async function palette(page: Page, command: string) {
  const search = page.getByRole("combobox", { name: "Search files or commands" });
  await expect(async () => {
    await page.keyboard.press("Control+Shift+P");
    await expect(search).toBeVisible({ timeout: 1000 });
  }).toPass();
  await search.fill(`>${command}`);
  return page.getByRole("option").filter({ hasText: command }).first();
}

test("the Explorer's root opens a terminal in the workspace root", async ({ page }) => {
  await desktop(page);
  // The tree's background is the workspace root's.
  await page
    .getByRole("tree", { name: "Files" })
    .click({ button: "right", position: { x: 40, y: 120 } });
  await page.getByRole("menuitem", { name: "Open in Integrated Terminal" }).click();
  await expect
    .poll(async () => (await calls(page, "terminal_open")).map((call) => call.args.cwd))
    .toContain("/work");
});

test("Open Integrated Terminal Here starts in the folder of the file in the editor", async ({
  page,
}) => {
  await desktop(page);
  // Nothing in the editor: offered, but not available.
  await expect(await palette(page, "Open Integrated Terminal Here")).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await page.keyboard.press("Escape");
  await page.getByText("file.ts", { exact: true }).dblclick();
  await expect(page.getByRole("tab", { name: /file\.ts/ })).toBeVisible();
  await (await palette(page, "Open Integrated Terminal Here")).click();
  await expect
    .poll(async () => (await calls(page, "terminal_open")).map((call) => call.args.cwd))
    .toContain("/work");
});

test("an untitled document opens its terminal in the workspace root", async ({ page }) => {
  await desktop(page);
  await (await palette(page, "New Text File")).click();
  await (await palette(page, "Open Integrated Terminal Here")).click();
  await expect
    .poll(async () => (await calls(page, "terminal_open")).map((call) => call.args.cwd))
    .toContain("/work");
});

test("Reveal Current Folder shows the folder the shell reported, and only a local one", async ({
  page,
}) => {
  await desktop(page, { unixShell: true });
  await openPanel(page);
  const [id] = await terminalIds(page);
  // It has not said where it is: nothing is guessed.
  await terminalMenu(page, "Reveal Current Folder in Explorer");
  await expect(page.getByRole("alert")).toContainText("does not report its folder");

  await signal(page, id, { signal: "cwd", uri: "file://far/home/ci", local: false });
  await terminalMenu(page, "Reveal Current Folder in Explorer");
  await expect(page.getByRole("alert")).toContainText("on another machine (far)");

  await signal(page, id, { signal: "cwd", uri: "file:///work/src", local: true });
  await expect(page.getByTestId("terminal-folder")).toHaveText("/work/src");
  await terminalMenu(page, "Reveal Current Folder in Explorer");
  await expect(page.getByRole("treeitem", { name: "src" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("terminal commands are in the palette, enabled only when they have a terminal", async ({
  page,
}) => {
  await desktop(page);
  // No terminal yet.
  for (const command of ["Kill Terminal", "Restart Terminal", "Rename Terminal…"]) {
    await expect(await palette(page, command)).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Escape");
  }
  await openPanel(page);
  const [id] = await terminalIds(page);
  await expect(await palette(page, "Restart Terminal")).not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await page.keyboard.press("Escape");
  // Working in the Explorer, with the terminal still shown.
  await page.getByText("file.ts", { exact: true }).click();
  // Shown but not typed into: the commands that need the keyboard's terminal are not offered.
  await expect(await palette(page, "Paste into Terminal")).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");

  // In the terminal, the palette's own key reaches the IDE, not the shell.
  await view(page, id).click();
  const writes = await countCalls(page, "terminal_write");
  const option = await palette(page, "Select All in Terminal");
  expect(await countCalls(page, "terminal_write")).toBe(writes);
  await expect(option).not.toHaveAttribute("aria-disabled", "true");
  await option.click();

  // Kill ends the shell and its children now; Close would end it gently.
  await (await palette(page, "Kill Terminal")).click();
  await expect.poll(async () => countCalls(page, "terminal_kill")).toBe(1);
  expect(await countCalls(page, "terminal_close")).toBe(0);
});

test("Ctrl+` in a terminal hides the panel instead of reaching the shell", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  const [id] = await terminalIds(page);
  await view(page, id).click();
  const writes = await countCalls(page, "terminal_write");
  await page.keyboard.press("Control+Backquote");
  await expect(view(page, id)).toBeHidden();
  expect(await countCalls(page, "terminal_write")).toBe(writes);
});

test("Focus Terminal gives the terminal the keyboard, from anywhere", async ({ page }) => {
  await desktop(page);
  await (await palette(page, "Focus Terminal")).click();
  const [id] = await terminalIds(page);
  await expect(view(page, id).locator("textarea")).toBeFocused();
  // Typing now reaches the shell.
  await page.keyboard.type("x");
  await expect.poll(async () => countCalls(page, "terminal_write")).toBeGreaterThan(0);
});

test("a file path printed in a terminal opens in the editor on a click, at its line", async ({
  page,
}) => {
  await desktop(page, { unixShell: true });
  await openPanel(page);
  const [id] = await terminalIds(page);
  await output(page, id, "/work/file.ts:12 and /etc/passwd.txt\r\n");
  const screen = view(page, id).locator(".xterm-screen");
  await expect(view(page, id)).toContainText("/work/file.ts:12");
  const box = (await screen.boundingBox())!;
  const rows = await view(page, id).locator(".xterm-rows > div").count();
  const cell = { width: 0, height: box.height / rows };
  // xterm measures a run of characters; one cell is that width over their number.
  cell.width = await view(page, id).evaluate((element) => {
    const measure = element.querySelector(".xterm-char-measure-element") as HTMLElement;
    return measure.getBoundingClientRect().width / (measure.textContent?.length || 1);
  });
  const at = (column: number) => ({
    x: box.x + cell.width * (column + 0.5),
    y: box.y + cell.height * 0.5,
  });
  // Hovering only offers it; nothing opens.
  await page.mouse.move(at(3).x, at(3).y);
  await expect(page.getByRole("tab", { name: /file\.ts/ })).toHaveCount(0);
  await page.mouse.click(at(3).x, at(3).y);
  await expect(page.getByRole("tab", { name: /file\.ts/ })).toBeVisible();
  await expect(page.getByText(/Ln 12, Col 1/)).toBeVisible();
  // Outside the workspace: not a link, so a click opens nothing.
  const tabs = await page.getByRole("tab").count();
  await page.mouse.click(at(24).x, at(24).y);
  await page.waitForTimeout(300);
  expect(await page.getByRole("tab").count()).toBe(tabs);
  expect((await calls(page, "read_file_content")).map((c) => c.args.path)).not.toContain(
    "/etc/passwd.txt",
  );
});

test("a command finishing in a terminal asks Git to refresh; its output does not", async ({
  page,
}) => {
  await desktop(page, { unixShell: true });
  await openPanel(page);
  const [id] = await terminalIds(page);
  await signal(page, id, { signal: "prompt" });
  // Let Git settle after opening, then count what it is asked.
  await page.waitForTimeout(1500);
  const before = await countCalls(page, "git_exec");
  for (let i = 0; i < 20; i++)
    await output(
      page,
      id,
      `building ${i}
`,
    );
  await page.waitForTimeout(1000);
  expect(await countCalls(page, "git_exec")).toBe(before);
  await signal(page, id, { signal: "executing" });
  await signal(page, id, { signal: "finished", exitCode: 1 });
  // Git's own refresh, through its own commands; the terminal changes nothing in Git.
  await expect.poll(async () => countCalls(page, "git_exec")).toBeGreaterThan(before);
});

test("after a switch, terminal commands act on the new workspace's terminals only", async ({
  page,
}) => {
  await desktop(page);
  await openPanel(page);
  const [a] = await terminalIds(page);
  await openFolder(page, "/other");
  await expect(view(page, a)).toHaveCount(0);
  // B's panel has its own terminal; Kill Terminal ends that one, never A's.
  const [, b] = await terminalIds(page, 2);
  await expect(view(page, b)).toBeVisible();
  await (await palette(page, "Kill Terminal")).click();
  await expect
    .poll(async () => (await calls(page, "terminal_kill")).map((call) => call.args.id))
    .toEqual([b]);
  await openFolder(page, "/work");
  await expect(view(page, a)).toBeVisible();
  expect(await countCalls(page, "terminal_close")).toBe(0);
});

test("the end of a shell that was replaced is never taken for the one replacing it", async ({
  page,
}) => {
  // What showed "[The shell exited with code 1.]" twice under a live prompt: React mounts the
  // view twice in development, and the first launch's close -- a killed cmd.exe exits 1 --
  // arrived under the same terminal id as the second launch.
  await desktop(page);
  await openPanel(page);
  const [id] = await terminalIds(page);
  const launches = async () =>
    (await calls(page, "terminal_open"))
      .filter((call) => call.args.id === id)
      .map((call) => call.args.generation as number);
  await expect.poll(async () => (await launches()).length).toBeGreaterThan(0);
  const first = (await launches()).at(-1)!;

  // Restarted: a new launch of the same terminal.
  await exit(page, id, 130, first);
  await expect(view(page, id)).toContainText("exited with code 130");
  await page.getByRole("button", { name: "Restart", exact: true }).click();
  await expect.poll(async () => (await launches()).at(-1)).toBeGreaterThan(first);
  const second = (await launches()).at(-1)!;

  // The old shell's late output and exit are ignored; the new one's are shown.
  await output(page, id, "from the old shell", first);
  await exit(page, id, 1, first);
  await output(page, id, "from the new shell", second);
  await expect(view(page, id)).toContainText("from the new shell");
  await expect(view(page, id)).not.toContainText("from the old shell");
  await expect(view(page, id)).not.toContainText("exited with code 1.");
  await expect(page.getByRole("button", { name: "Restart", exact: true })).toHaveCount(0);

  // Every close names the launch it is for, so a late one cannot end its successor.
  for (const close of await calls(page, "terminal_close"))
    expect(typeof close.args.generation).toBe("number");
});

test("a shell that ends cleanly is not reported as a failure", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  const [id] = await terminalIds(page);

  await exit(page, id, 0);
  await expect(view(page, id)).toContainText("The shell exited.");
  await expect(view(page, id)).not.toContainText("code");
});

test("find locates output and reports when there is no match", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  const [id] = await terminalIds(page);
  // Wait for the shell to be attached so the search runs against a settled terminal.
  await expect(page.getByRole("status")).toContainText("Running");
  await output(page, id, "compiling widget.rs\r\n");

  // xterm writes asynchronously; search only sees what has reached its buffer.
  await expect(view(page, id)).toContainText("widget.rs");

  await page.getByLabel("Find in Terminal", { exact: true }).click();
  const bar = page.getByRole("search", { name: "Terminal search" });
  const box = bar.getByLabel("Find in terminal", { exact: true });
  await box.fill("widget");
  await expect(bar.getByRole("status")).toContainText("1 of 1");

  await box.fill("nothing-here");
  await expect(bar.getByRole("status")).toContainText("No results");

  await box.press("Escape");
  await expect(box).toBeHidden();
});

test("find counts every match and can be made case sensitive", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  const [id] = await terminalIds(page);
  await output(page, id, "Widget widget WIDGET\r\n");
  await expect(view(page, id)).toContainText("WIDGET");

  await page.getByLabel("Find in Terminal", { exact: true }).click();
  const bar = page.getByRole("search", { name: "Terminal search" });
  await bar.getByLabel("Find in terminal", { exact: true }).fill("widget");
  await expect(bar.getByRole("status")).toContainText("of 3");

  // Matching case narrows it to the one spelled exactly that way.
  await bar.getByLabel("Match case").click();
  await expect(bar.getByRole("status")).toContainText("of 1");
});

test("right clicking offers the terminal actions, with copy disabled until there is a selection", async ({
  page,
}) => {
  await desktop(page);
  await openPanel(page);
  const [id] = await terminalIds(page);
  await output(page, id, "some output to clear\r\n");
  await expect(view(page, id)).toContainText("some output");

  await view(page, id).click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Terminal actions" });
  await expect(menu).toBeVisible();
  // Nothing is selected, so there is nothing to copy.
  await expect(menu.getByRole("menuitem", { name: "Copy", exact: true })).toBeDisabled();
  await expect(menu.getByRole("menuitem", { name: "Paste", exact: true })).toBeEnabled();

  await menu.getByRole("menuitem", { name: "Clear", exact: true }).click();
  await expect(menu).toBeHidden();
  await expect(view(page, id)).not.toContainText("some output");
});

test("a terminal can be renamed and keeps the name", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);

  await page.getByRole("tab", { name: "Command Prompt", exact: true }).dblclick();
  const box = page.getByLabel("Rename terminal");
  await box.fill("build watch");
  await box.press("Enter");

  await expect(page.getByRole("tab", { name: "build watch", exact: true })).toBeVisible();
  // A second terminal is numbered from its shell, not from the renamed one.
  await page.getByLabel("New Terminal").click();
  await expect(page.getByRole("tab", { name: "Command Prompt", exact: true })).toBeVisible();
});

test("the font size zooms with the keyboard and resets", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  const [id] = await terminalIds(page);
  const size = () =>
    page.evaluate(
      (label) =>
        parseFloat(
          getComputedStyle(document.querySelector(`[aria-label="${label}"] .xterm-rows`) as Element)
            .fontSize,
        ),
      `Terminal ${id}`,
    );

  const original = await size();
  await view(page, id).click();
  await page.keyboard.press("Control+=");
  await expect.poll(size).toBeGreaterThan(original);

  await page.keyboard.press("Control+0");
  await expect.poll(size).toBe(original);
});

test("a terminal that rings while hidden is marked", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  const [first] = await terminalIds(page);
  await page.getByLabel("New Terminal").click();
  await terminalIds(page, 2);

  // The first terminal is no longer on screen when it rings.
  await output(page, first, "\u0007");
  const tab = page.getByRole("tab", { name: "Command Prompt", exact: true }).locator("..");
  await expect(tab.getByTitle("This terminal rang")).toBeVisible();

  // Looking at it clears the mark.
  await page.getByRole("tab", { name: "Command Prompt", exact: true }).click();
  await expect(tab.getByTitle("This terminal rang")).toHaveCount(0);
});

test("the panel and the split can be resized", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);

  const panel = page.getByRole("separator", { name: "Resize panel" });
  await expect(panel).toBeVisible();
  const before = (await page.getByLabel("Terminal actions").count()) === 0;
  expect(before).toBe(true);

  await page.getByLabel("Split Terminal").click();
  await terminalIds(page, 2);
  await expect(page.getByRole("separator", { name: "Resize split" })).toBeVisible();
});

test("the terminal menu drives the panel", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);

  await terminalMenu(page, "New Terminal");
  await terminalIds(page, 2);

  await terminalMenu(page, "Find in Terminal");
  await expect(page.getByLabel("Find in terminal", { exact: true })).toBeVisible();
});

test("New Terminal from the menu opens the panel when it is hidden", async ({ page }) => {
  await desktop(page);
  await terminalMenu(page, "New Terminal");

  await expect(page.getByLabel("New Terminal")).toBeVisible();
  await terminalIds(page);
});

test("the panel is not built until a terminal is first opened", async ({ page }) => {
  await desktop(page);
  // Nothing terminal-related runs on startup.
  expect(await countCalls(page, "terminal_shells")).toBe(0);

  await openPanel(page);
  await expect.poll(async () => countCalls(page, "terminal_shells")).toBeGreaterThan(0);
});

test("copy and paste use the terminal conventions", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await desktop(page);
  await openPanel(page);
  const [id] = await terminalIds(page);

  await page.evaluate(() => navigator.clipboard.writeText("pasted text"));
  await view(page, id).click();
  await page.keyboard.press("Control+Shift+V");
  await expect
    .poll(async () => (await calls(page, "terminal_write")).map((c) => c.args.data).join(""))
    .toBe("pasted text");

  // Ctrl+C with no selection must reach the shell so a program can be interrupted.
  await page.keyboard.press("Control+c");
  await expect
    .poll(async () => (await calls(page, "terminal_write")).map((c) => c.args.data).join(""))
    .toBe("pasted text\x03");
});

test("the browser preview says a shell needs the desktop application", async ({ page }) => {
  // No Tauri at all, which is what a browser gets.
  await page.goto("/");
  await openPanel(page);

  await expect(page.getByText("Open the desktop application to run a shell.")).toBeVisible();
  // Controls that cannot work are disabled rather than failing when pressed.
  await expect(page.getByLabel("New Terminal")).toBeDisabled();
  await expect(page.getByLabel("Split Terminal")).toBeDisabled();
});

test("the panel offers the five views, with Terminal showing by default", async ({ page }) => {
  await desktop(page);
  await openPanel(page);

  const tabs = page.getByRole("tablist", { name: "Panel views" });
  await expect(tabs.getByRole("tab")).toHaveText([
    "PROBLEMS",
    "OUTPUT",
    "DEBUG CONSOLE",
    "TERMINAL",
    "PORTS",
  ]);
  await expect(tabs.getByRole("tab", { name: "TERMINAL" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("each view says what it will hold rather than claiming a broken connection", async ({
  page,
}) => {
  await desktop(page);
  await openPanel(page);
  const tabs = page.getByRole("tablist", { name: "Panel views" });

  for (const [tab, region] of [
    ["PROBLEMS", "Problems"],
    ["OUTPUT", "Output"],
    ["DEBUG CONSOLE", "Debug Console"],
    ["PORTS", "Ports"],
  ] as const) {
    await tabs.getByRole("tab", { name: tab }).click();
    await expect(page.getByRole("region", { name: region })).toBeVisible();
  }
});

test("switching away from the terminal and back keeps the same shell running", async ({ page }) => {
  // The terminal is hidden rather than unmounted when another view shows; unmounting would
  // kill the user's running processes.
  await desktop(page);
  await openPanel(page);
  const [id] = await terminalIds(page);
  await output(page, id, "before switching\r\n");
  await expect(view(page, id)).toContainText("before switching");

  const tabs = page.getByRole("tablist", { name: "Panel views" });
  await tabs.getByRole("tab", { name: "PORTS" }).click();
  await expect(page.getByRole("region", { name: "Ports" })).toBeVisible();
  await tabs.getByRole("tab", { name: "TERMINAL" }).click();

  // Same session, same scrollback: no new terminal_open, and the earlier output survives.
  expect(await terminalIds(page)).toEqual([id]);
  await expect(view(page, id)).toContainText("before switching");
});

test("the chosen view is remembered across a reload", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  await page
    .getByRole("tablist", { name: "Panel views" })
    .getByRole("tab", { name: "PORTS" })
    .click();

  await page.reload();
  await openPanel(page);
  await expect(
    page.getByRole("tablist", { name: "Panel views" }).getByRole("tab", { name: "PORTS" }),
  ).toHaveAttribute("aria-selected", "true");
});

test("arrow keys move between panel views", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  const tabs = page.getByRole("tablist", { name: "Panel views" });

  await tabs.getByRole("tab", { name: "TERMINAL" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(tabs.getByRole("tab", { name: "PORTS" })).toHaveAttribute("aria-selected", "true");
  // Wraps rather than dead-ending at the last view.
  await tabs.getByRole("tab", { name: "PORTS" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(tabs.getByRole("tab", { name: "PROBLEMS" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("Ctrl+PageDown and Ctrl+PageUp move between terminals", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);
  await page.getByLabel("New Terminal").click();
  const [first, second] = await terminalIds(page, 2);
  await view(page, second).click();

  await page.keyboard.press("Control+PageUp");
  await expect(view(page, first)).toBeVisible();
  await expect(page.getByRole("tab", { name: "Command Prompt", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await view(page, first).click();
  await page.keyboard.press("Control+PageDown");
  await expect(view(page, second)).toBeVisible();
});

test("Shift+PageUp scrolls the buffer instead of reaching the shell", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  const [id] = await terminalIds(page);
  await view(page, id).click();
  const before = await countCalls(page, "terminal_write");

  await page.keyboard.press("Shift+PageUp");
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+End");

  // Scrolling is local to the buffer: none of it is sent to the shell.
  expect(await countCalls(page, "terminal_write")).toBe(before);
});

test("a plain arrow key still reaches the shell", async ({ page }) => {
  // Alt+Arrow moves between split panes, so the unmodified arrows must stay untouched or
  // shell history and line editing would stop working.
  await desktop(page);
  await openPanel(page);
  const [id] = await terminalIds(page);
  await view(page, id).click();

  await page.keyboard.press("ArrowUp");
  await expect
    .poll(async () => (await calls(page, "terminal_write")).map((c) => c.args.data).join(""))
    .toBe("\x1b[A");
});

test("a shell that finishes starting after its terminal was closed is ended, not orphaned", async ({
  page,
}) => {
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);
  await page.evaluate(() => {
    (window as unknown as { __openDelay?: number }).__openDelay = 400;
  });
  await page.getByLabel("New Terminal").click();
  const ids = await terminalIds(page, 2);
  // Closed while its shell is still starting.
  await view(page, ids[1]).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Kill All Terminals" }).click();

  // Every launch of it that finished starting was closed afterwards, by its generation.
  const order = () =>
    page.evaluate(
      (id) =>
        (
          window as unknown as {
            __calls: { command: string; args: { id?: string; generation?: number } }[];
          }
        ).__calls
          .filter((call) => call.args?.id === id)
          .map((call) => `${call.command}:${call.args.generation}`),
      ids[1],
    );
  await expect
    .poll(async () => {
      const seen = await order();
      const started = seen.filter((one) => one.startsWith("terminal_open:done:"));
      return (
        started.length > 0 &&
        started.every((done) => {
          const generation = done.split(":").pop();
          const after = seen.slice(seen.indexOf(done) + 1);
          return (
            after.includes(`terminal_close:${generation}`) ||
            after.includes(`terminal_kill:${generation}`)
          );
        })
      );
    })
    .toBe(true);
});

test("a page closes the shells an earlier page left running before it opens its first", async ({
  page,
}) => {
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);
  const order = await page.evaluate(() =>
    (window as unknown as { __calls: { command: string }[] }).__calls
      .map((call) => call.command)
      .filter((command) => command === "terminal_close_all" || command === "terminal_open"),
  );
  // Closed first; the workspace's own disposal (when the folder opens) may close them too.
  expect(order[0]).toBe("terminal_close_all");
  expect(order).toContain("terminal_open");
});

test("Kill All Terminals closes every terminal at once", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);
  await page.getByLabel("New Terminal").click();
  const ids = await terminalIds(page, 2);

  // The second terminal is the visible one after creating it.
  await view(page, ids[1]).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Kill All Terminals" }).click();

  await expect(page.getByRole("region", { name: "No terminals" })).toBeVisible();
  // Every shell is closed natively, not just removed from the UI. Containment rather than
  // equality: React's development StrictMode mounts and unmounts each view once before the
  // real mount, which legitimately closes the same id earlier too.
  await expect
    .poll(async () => {
      const closed = new Set((await calls(page, "terminal_close")).map((c) => c.args.id));
      return ids.every((id) => closed.has(id));
    })
    .toBe(true);
});

test("output reaches only the terminal it belongs to, on its own channel", async ({ page }) => {
  // Each launch is opened with a channel of its own; nothing listens to a broadcast.
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);
  await page.getByLabel("New Terminal").click();
  const [first, second] = await terminalIds(page, 2);

  await output(page, second, "only for the second");
  await expect(view(page, second)).toContainText("only for the second");
  await expect(view(page, first)).not.toContainText("only for the second");

  const terminalListens = (await calls(page, "plugin:event|listen")).filter((call) =>
    String(call.args.event).startsWith("terminal-"),
  );
  expect(terminalListens).toEqual([]);
  // Every launch names the subscription its channel belongs to, and no two share one.
  const subscriptions = (await calls(page, "terminal_open")).map((c) => c.args.subscriptionId);
  expect(subscriptions.every((id) => typeof id === "string")).toBe(true);
  expect(new Set(subscriptions).size).toBe(subscriptions.length);
});

test("output is acknowledged once the terminal has taken it in", async ({ page }) => {
  // The acknowledgement is what lets the native side send more: it comes from the view, after
  // xterm has parsed the bytes, naming the launch and the chunk.
  await desktop(page);
  await openPanel(page);
  const [id] = await terminalIds(page);
  await output(page, id, "first\r\n");
  await output(page, id, "second\r\n");
  await expect(view(page, id)).toContainText("second");
  await expect
    .poll(async () => (await calls(page, "terminal_ack")).map((c) => c.args.seq))
    .toEqual([0, 1]);
  const [ack] = await calls(page, "terminal_ack");
  const [open] = (await calls(page, "terminal_open")).slice(-1);
  const views = await calls(page, "terminal_subscribe");
  expect(ack.args.sessionId).toBe(id);
  expect(ack.args.generation).toBe(open.args.generation);
  // The view's own subscription, not the service's lifecycle one.
  expect(views.map((v) => v.args.subscriptionId)).toContain(ack.args.subscriptionId);
  expect(ack.args.subscriptionId).not.toBe(open.args.subscriptionId);
});

test("Open in Integrated Terminal starts a shell in the chosen folder", async ({ page }) => {
  await desktop(page);
  // The explorer's own context menu; the panel need not be open beforehand.
  await page.getByText("file.ts", { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Open in Integrated Terminal" }).click();

  await expect.poll(async () => (await calls(page, "terminal_open")).length).toBeGreaterThan(0);
  const opened = await calls(page, "terminal_open");
  // A file opens a terminal in the folder holding it, not in the file.
  expect(opened.some((call) => call.args.cwd === "/work")).toBe(true);
});

test("Show Git Output opens the Output view with the Git channel", async ({ page }) => {
  // VS Code shows this in the Output view rather than a second Git-only log view.
  await desktop(page);
  await page.getByTitle("Source Control (Ctrl+Shift+G)").click();
  await page
    .getByRole("complementary", { name: "Source control" })
    .getByLabel("Changes actions")
    .click();
  await page.getByRole("menuitem", { name: "Show Git Output" }).click();

  const output = page.getByRole("region", { name: "Output" });
  await expect(output).toBeVisible();
  await expect(output.getByLabel("Output channel")).toHaveValue("git");
  // Real content: the Git commands the panel already ran on startup.
  await expect(output.getByRole("listitem").first()).toContainText("git");
});

test("the Output view filters by level, so ordinary output can be hidden", async ({ page }) => {
  // Every mocked Git command succeeds here, so every line is info: raising the minimum level
  // to error must empty the view, and lowering it must bring the lines back.
  await desktop(page);
  await page.getByTitle("Source Control (Ctrl+Shift+G)").click();
  await page
    .getByRole("complementary", { name: "Source control" })
    .getByLabel("Changes actions")
    .click();
  await page.getByRole("menuitem", { name: "Show Git Output" }).click();

  const output = page.getByRole("region", { name: "Output" });
  await expect(output.getByRole("listitem").first()).toBeVisible();

  await output.getByLabel("Minimum log level").selectOption("error");
  await expect(output.getByText("Nothing at this level.")).toBeVisible();

  await output.getByLabel("Minimum log level").selectOption("info");
  await expect(output.getByRole("listitem").first()).toBeVisible();
});

test("a failed Git command is recorded at error level, so it survives the filter", async ({
  page,
}) => {
  await desktop(page, { failGit: "fatal: could not read from remote" });
  await page.getByTitle("Source Control (Ctrl+Shift+G)").click();
  await page
    .getByRole("complementary", { name: "Source control" })
    .getByLabel("Changes actions")
    .click();
  await page.getByRole("menuitem", { name: "Show Git Output" }).click();

  const output = page.getByRole("region", { name: "Output" });
  await output.getByLabel("Minimum log level").selectOption("error");
  await expect(output.getByRole("listitem").first()).toBeVisible();
  await expect(output.getByText(/could not read from remote/).first()).toBeVisible();
});

test("clearing one output channel does not touch another", async ({ page }) => {
  await desktop(page);
  await page.getByTitle("Source Control (Ctrl+Shift+G)").click();
  await page
    .getByRole("complementary", { name: "Source control" })
    .getByLabel("Changes actions")
    .click();
  await page.getByRole("menuitem", { name: "Show Git Output" }).click();

  const output = page.getByRole("region", { name: "Output" });
  await expect(output.getByRole("listitem").first()).toBeVisible();
  await output.getByRole("button", { name: "Clear" }).click();
  await expect(output.getByText("This channel has produced no output yet.")).toBeVisible();
});

/** Selects a panel view by its tab label. */
async function showView(page: Page, label: string) {
  await openPanel(page);
  await page
    .getByRole("tablist", { name: "Panel views" })
    .getByRole("tab", { name: label })
    .click();
}

test("Ports lists what is listening, with the process holding each one", async ({ page }) => {
  await desktop(page, {
    ports: [
      { port: 5173, address: "127.0.0.1", pid: 23188, process: "node.exe" },
      { port: 8080, address: "0.0.0.0", pid: 9012, process: "" },
    ],
  });
  await showView(page, "PORTS");

  const ports = page.getByRole("region", { name: "Ports" });
  await expect(ports.getByRole("row")).toHaveCount(3); // header plus two services
  await expect(ports.getByRole("cell", { name: "5173", exact: true })).toBeVisible();
  await expect(ports.getByText("http://localhost:5173")).toBeVisible();
  await expect(ports.getByText("node.exe")).toBeVisible();
  // A port whose owner could not be named still lists, rather than being hidden.
  await expect(ports.getByText("Unknown")).toBeVisible();
});

test("Ports says what it is for when nothing is listening", async ({ page }) => {
  await desktop(page, { ports: [] });
  await showView(page, "PORTS");
  await expect(page.getByRole("region", { name: "Ports" })).toContainText("Start a dev server");
});

test("a port opens over http on loopback, which is how a dev server is served", async ({
  page,
}) => {
  await desktop(page, { ports: [{ port: 5173, address: "127.0.0.1", pid: 1, process: "node" }] });
  await showView(page, "PORTS");

  await page.getByRole("button", { name: "Open port 5173 in your browser" }).click();
  await expect
    .poll(async () => (await calls(page, "open_external_url")).map((c) => c.args.url))
    .toContain("http://localhost:5173");
});

test("stopping a process asks first and names what it will end", async ({ page }) => {
  await desktop(page, { ports: [{ port: 5173, address: "127.0.0.1", pid: 1, process: "node" }] });
  await showView(page, "PORTS");

  let asked = "";
  page.on("dialog", (dialog) => {
    asked = dialog.message();
    void dialog.dismiss();
  });
  await page.getByRole("button", { name: "Stop the process on port 5173" }).click();
  expect(asked).toContain("node");
  expect(asked).toContain("5173");
  // Dismissed, so nothing was stopped.
  expect(await countCalls(page, "stop_listening_process")).toBe(0);
});

test("confirming the stop ends the process holding that port", async ({ page }) => {
  await desktop(page, { ports: [{ port: 5173, address: "127.0.0.1", pid: 1, process: "node" }] });
  await showView(page, "PORTS");

  page.on("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Stop the process on port 5173" }).click();
  await expect
    .poll(async () => (await calls(page, "stop_listening_process")).map((c) => c.args.port))
    .toContain(5173);
});

const TSC_OUTPUT = [
  "src/app.ts(12,7): error TS2345: Argument of type 'string' is not assignable.",
  "src/app.ts(20,1): warning TS6133: 'unused' is declared but never read.",
  "src/other.ts(3,2): error TS1005: ';' expected.",
  "Found 3 errors.",
].join("\n");

test("Problems explains how diagnostics are collected when no checker applies", async ({
  page,
}) => {
  await desktop(page, { checkers: [] });
  await showView(page, "PROBLEMS");
  await expect(page.getByRole("region", { name: "Problems" })).toContainText(
    "running your project's own compiler or linter",
  );
});

test("running a checker lists its diagnostics grouped by file", async ({ page }) => {
  await desktop(page, {
    checkers: [{ id: "tsc", label: "TypeScript" }],
    checkerOutput: TSC_OUTPUT,
  });
  await showView(page, "PROBLEMS");

  const problems = page.getByRole("region", { name: "Problems" });
  await problems.getByRole("button", { name: "TypeScript", exact: true }).click();

  await expect(problems.getByRole("button", { name: /src\/app\.ts/ })).toBeVisible();
  await expect(problems.getByRole("button", { name: /src\/other\.ts/ })).toBeVisible();
  await expect(problems.getByText(/not assignable/)).toBeVisible();
  await expect(problems.getByText(/Ln 12, Col 7/)).toBeVisible();
});

test("a checker that answers after another folder was opened reports nothing into it", async ({
  page,
}) => {
  await desktop(page, {
    checkers: [{ id: "tsc", label: "TypeScript" }],
    checkerOutput: TSC_OUTPUT,
  });
  await showView(page, "PROBLEMS");
  let problems = page.getByRole("region", { name: "Problems" });
  await page.evaluate(() => {
    const scenario = window as unknown as { __checkerDelay?: number; __openFolder?: string };
    scenario.__checkerDelay = 800;
    scenario.__openFolder = "/other";
  });
  await problems.getByRole("button", { name: "TypeScript", exact: true }).click();

  // Another folder, while the check of the first is still running.
  await page.getByRole("menubar").getByRole("menuitem", { name: "File", exact: true }).click();
  await page
    .getByRole("menu", { name: "File", exact: true })
    .getByRole("menuitem", { name: "Open Folder…", exact: true })
    .click();
  await expect.poll(async () => countCalls(page, "cancel_checker")).toBeGreaterThan(0);
  await page.waitForTimeout(1200);
  // The panel is still shown (it is the new workspace's now): straight to its Problems.
  await page
    .getByRole("tablist", { name: "Panel views" })
    .getByRole("tab", { name: "PROBLEMS" })
    .click();
  problems = page.getByRole("region", { name: "Problems" });
  await expect(problems.getByText(/not assignable/)).toHaveCount(0);

  // The store itself still works: a check of this folder shows what it finds.
  await page.evaluate(() => {
    (window as unknown as { __checkerDelay?: number }).__checkerDelay = 0;
  });
  await problems.getByRole("button", { name: "TypeScript", exact: true }).click();
  await expect(problems.getByText(/not assignable/).first()).toBeVisible();
});

test("a problem opens its file at its line, even while another file is shown", async ({ page }) => {
  await desktop(page, {
    checkers: [{ id: "tsc", label: "TypeScript" }],
    checkerOutput: TSC_OUTPUT,
  });
  await page.getByRole("treeitem", { name: "file.ts" }).click();
  await expect(page.getByRole("textbox", { name: "file.ts", exact: true })).toBeFocused();
  await showView(page, "PROBLEMS");
  const problems = page.getByRole("region", { name: "Problems" });
  await problems.getByRole("button", { name: "TypeScript", exact: true }).click();
  await problems.getByText(/not assignable/).click();

  // The jump lands in the problem's file, not in the one that was shown before it opened.
  await expect.poll(() => withEditor<string>(page, "(editor) => editor.label()")).toBe("app.ts");
  const lineStart = Array.from({ length: 11 }, (_, i) => `line ${i + 1}\n`).join("").length;
  await expect.poll(async () => (await editorSelections(page))?.[0]?.start).toBe(lineStart);
});

test("a checker that could not run says so instead of reporting a clean project", async ({
  page,
}) => {
  // `npx --no-install tsc` in a project with no local TypeScript exits 1 and explains itself
  // on stderr. Nothing in that text is a diagnostic, so the view had nothing to show and said
  // "No problems found" -- the most misleading thing it could say.
  await desktop(page, {
    checkers: [{ id: "tsc", label: "TypeScript" }],
    checkerOutput: "npm error could not determine executable to run",
    checkerCode: 1,
  });
  await showView(page, "PROBLEMS");
  await page
    .getByRole("region", { name: "Problems" })
    .getByRole("button", { name: "TypeScript", exact: true })
    .click();

  await expect(appAlert(page)).toContainText("could not determine executable");
  await expect(page.getByRole("region", { name: "Problems" })).not.toContainText(
    "No problems found",
  );
});

test("a checker that exits nonzero because it found problems still lists them", async ({
  page,
}) => {
  // The other half of the rule: a nonzero exit is a checker's normal way of reporting work.
  await desktop(page, {
    checkers: [{ id: "tsc", label: "TypeScript" }],
    checkerOutput: "src/a.ts(3,10): error TS2304: Cannot find name 'x'.",
    checkerCode: 2,
  });
  await showView(page, "PROBLEMS");
  await page
    .getByRole("region", { name: "Problems" })
    .getByRole("button", { name: "TypeScript", exact: true })
    .click();

  await expect(page.getByRole("region", { name: "Problems" })).toContainText("Cannot find name");
  await expect(appAlert(page)).toHaveCount(0);
});

test("the Problems tab is badged with the error and warning count", async ({ page }) => {
  await desktop(page, {
    checkers: [{ id: "tsc", label: "TypeScript" }],
    checkerOutput: TSC_OUTPUT,
  });
  await showView(page, "PROBLEMS");
  await page
    .getByRole("region", { name: "Problems" })
    .getByRole("button", { name: "TypeScript", exact: true })
    .click();

  // Two errors and one warning.
  await expect(page.getByRole("tab", { name: /PROBLEMS/ })).toContainText("3");
});

test("severity toggles narrow the list", async ({ page }) => {
  await desktop(page, {
    checkers: [{ id: "tsc", label: "TypeScript" }],
    checkerOutput: TSC_OUTPUT,
  });
  await showView(page, "PROBLEMS");
  const problems = page.getByRole("region", { name: "Problems" });
  await problems.getByRole("button", { name: "TypeScript", exact: true }).click();
  await expect(problems.getByText(/never read/)).toBeVisible();

  await problems.getByRole("button", { name: "warnings" }).click();
  await expect(problems.getByText(/never read/)).toHaveCount(0);
  await expect(problems.getByText(/not assignable/)).toBeVisible();
});

test("the filter accepts text and a negated glob", async ({ page }) => {
  await desktop(page, {
    checkers: [{ id: "tsc", label: "TypeScript" }],
    checkerOutput: TSC_OUTPUT,
  });
  await showView(page, "PROBLEMS");
  const problems = page.getByRole("region", { name: "Problems" });
  await problems.getByRole("button", { name: "TypeScript", exact: true }).click();

  await problems.getByLabel("Filter problems").fill("other");
  await expect(problems.getByRole("button", { name: /src\/other\.ts/ })).toBeVisible();
  await expect(problems.getByRole("button", { name: /src\/app\.ts/ })).toHaveCount(0);

  await problems.getByLabel("Filter problems").fill("!*other*");
  await expect(problems.getByRole("button", { name: /src\/app\.ts/ })).toBeVisible();
  await expect(problems.getByRole("button", { name: /src\/other\.ts/ })).toHaveCount(0);
});

test("a second run replaces that checker's earlier findings", async ({ page }) => {
  await desktop(page, {
    checkers: [{ id: "tsc", label: "TypeScript" }],
    checkerOutput: TSC_OUTPUT,
  });
  await showView(page, "PROBLEMS");
  const problems = page.getByRole("region", { name: "Problems" });
  await problems.getByRole("button", { name: "TypeScript", exact: true }).click();
  await expect(problems.getByText(/not assignable/)).toBeVisible();

  // The tool now reports nothing, which must clear what it said before rather than
  // leaving stale diagnostics behind.
  await page.evaluate(() => {
    (window as unknown as { __scenarioCheckerOutput: string }).__scenarioCheckerOutput = "";
  });
  await problems.getByRole("button", { name: "TypeScript", exact: true }).click();
  // "No problems found." rather than blaming filters that were never set.
  await expect(problems.getByText("No problems found.")).toBeVisible();
});

test("right-clicking the second pane of a split does not collapse the layout", async ({ page }) => {
  // Right-click used to make the pane "active", which in a split set activeId === splitId:
  // both halves then rendered the same terminal, one at half width with dead space beside it.
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);
  await page.getByLabel("Split Terminal").click();
  const ids = await terminalIds(page, 2);

  await view(page, ids[1]).click({ button: "right" });
  await page.keyboard.press("Escape");

  // Both panes still show their own terminal.
  await expect(view(page, ids[0])).toBeVisible();
  await expect(view(page, ids[1])).toBeVisible();
});

test("closing the first pane of a split leaves one working terminal", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);
  await page.getByLabel("Split Terminal").click();
  const ids = await terminalIds(page, 2);

  // Close the left pane from its tab.
  await page.getByRole("tab", { name: "Command Prompt", exact: true }).hover();
  await page.getByLabel("Close Command Prompt", { exact: true }).click();

  await expect(view(page, ids[1])).toBeVisible();
  await output(page, ids[1], "still alive");
  await expect(view(page, ids[1])).toContainText("still alive");
});

test("Show Git Output works again after switching away from it", async ({ page }) => {
  // Requesting the same view twice set identical state, React bailed out, and the panel's
  // effect never re-ran -- so this worked exactly once per session.
  await desktop(page);
  await page.getByTitle("Source Control (Ctrl+Shift+G)").click();
  const showGitOutput = async () => {
    await page
      .getByRole("complementary", { name: "Source control" })
      .getByLabel("Changes actions")
      .click();
    await page.getByRole("menuitem", { name: "Show Git Output" }).click();
  };

  await showGitOutput();
  await expect(page.getByRole("region", { name: "Output" })).toBeVisible();

  await page
    .getByRole("tablist", { name: "Panel views" })
    .getByRole("tab", { name: "PORTS" })
    .click();
  await expect(page.getByRole("region", { name: "Ports" })).toBeVisible();

  await showGitOutput();
  await expect(page.getByRole("region", { name: "Output" })).toBeVisible();
});

test("the panel's tabs are one tab stop, with arrows moving between them", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  const tabs = page.getByRole("tablist", { name: "Panel views" });

  // Roving tabindex: only the selected tab is reachable by Tab.
  await expect(tabs.getByRole("tab", { name: "TERMINAL" })).toHaveAttribute("tabindex", "0");
  await expect(tabs.getByRole("tab", { name: "PORTS" })).toHaveAttribute("tabindex", "-1");

  await tabs.getByRole("tab", { name: "TERMINAL" }).focus();
  await page.keyboard.press("ArrowRight");
  // Focus follows selection, so the next arrow press moves from the right place.
  await expect(tabs.getByRole("tab", { name: "PORTS" })).toBeFocused();
});

const UNDECIDED = { trusted: false, decided: false, root: "/work", parent: "/projects" };
const RESTRICTED = { trusted: false, decided: true, root: "/work", parent: "/projects" };

test("an undecided folder asks about trust before anything runs its tools", async ({ page }) => {
  await desktop(page, { trust: UNDECIDED });
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Do you trust the authors");
  // Says what it does and does not block, so the choice is informed.
  await expect(dialog).toContainText("compiler or linter");
  await expect(dialog).toContainText("integrated terminal");
});

test("a decided folder is not asked again", async ({ page }) => {
  await desktop(page, { trust: RESTRICTED });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Restricted Mode/ })).toBeVisible();
});

test("choosing Restricted Mode leaves the terminal and editing working", async ({ page }) => {
  await desktop(page, { trust: UNDECIDED });
  await page.getByRole("button", { name: "No, browse in Restricted Mode" }).click();

  await expect(page.getByRole("button", { name: /Restricted Mode/ })).toBeVisible();
  // The terminal is an explicit user action and stays available.
  await openPanel(page);
  const [id] = await terminalIds(page);
  await expect(view(page, id)).toBeVisible();
});

test("Restricted Mode explains why Problems is empty and offers a way out", async ({ page }) => {
  await desktop(page, { trust: RESTRICTED, checkers: [{ id: "tsc", label: "TypeScript" }] });
  await showView(page, "PROBLEMS");

  const problems = page.getByRole("region", { name: "Problems" });
  await expect(problems).toContainText("Restricted Mode");
  // No checker is offered to press, rather than one that fails when pressed.
  await expect(problems.getByRole("button", { name: "TypeScript", exact: true })).toHaveCount(0);
  await problems.getByRole("button", { name: "Manage Workspace Trust" }).click();
  await expect(page.getByRole("dialog")).toContainText("Workspace Trust");
});

test("trusting the folder enables the checkers", async ({ page }) => {
  await desktop(page, { trust: UNDECIDED, checkers: [{ id: "tsc", label: "TypeScript" }] });
  await page.getByRole("button", { name: "Yes, I trust the authors" }).click();
  await expect(page.getByRole("button", { name: /Restricted Mode/ })).toHaveCount(0);

  await showView(page, "PROBLEMS");
  await expect(
    page.getByRole("region", { name: "Problems" }).getByRole("button", {
      name: "TypeScript",
      exact: true,
    }),
  ).toBeVisible();
});

test("the parent-folder option is offered and passed through", async ({ page }) => {
  await desktop(page, { trust: UNDECIDED });
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("projects");
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Yes, I trust the authors" }).click();

  await expect
    .poll(async () =>
      (await calls(page, "set_workspace_trust")).map((c) => [c.args.trusted, c.args.parent]),
    )
    .toContainEqual([true, true]);
});

test("the status bar opens the manage view, which is dismissible", async ({ page }) => {
  await desktop(page, { trust: RESTRICTED });
  await page.getByRole("button", { name: /Restricted Mode/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Workspace Trust");
  // Dismissible, unlike the first decision.
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("a trusted window can still reach trust, and take it back", async ({ page }) => {
  // A trusted window shows no Restricted Mode badge, so without the menu entry there would be
  // no way back to the decision and trust could never be revoked.
  await desktop(page, {
    trust: { trusted: true, decided: true, root: "/work", parent: "/projects" },
  });
  await page.getByRole("menubar").getByRole("menuitem", { name: "File", exact: true }).click();
  await page.getByRole("menuitem", { name: "Manage Workspace Trust", exact: true }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("region", { name: "Trusted folders" })).toContainText("/work");
  await dialog.getByRole("button", { name: "Stop trusting /work" }).click();

  await expect(page.getByRole("button", { name: /Restricted Mode/ })).toBeVisible();
});

test("leaving a workspace detaches its terminals; coming back finds them running, replayed", async ({
  page,
}) => {
  // TERMINAL-03: switching folders is not closing their terminals.
  await desktop(page);
  await openPanel(page);
  const [id] = await terminalIds(page);
  await output(page, id, "before leaving\r\n");
  await expect(view(page, id)).toContainText("before leaving");
  const openFolder = async (folder: string) => {
    await page.evaluate((path) => {
      (window as unknown as { __openFolder?: string }).__openFolder = path;
    }, folder);
    await page.getByRole("menubar").getByRole("menuitem", { name: "File", exact: true }).click();
    await page
      .getByRole("menu", { name: "File", exact: true })
      .getByRole("menuitem", { name: "Open Folder…", exact: true })
      .click();
  };

  await openFolder("/other");
  await expect(view(page, id)).toHaveCount(0);
  // Output while away is kept for the return.
  await output(page, id, "while away\r\n");
  await openFolder("/work");
  await expect(view(page, id)).toContainText("before leaving");
  await expect(view(page, id)).toContainText("while away");

  // The same shell: never closed, never started again.
  const forThisOne = async (command: string) =>
    (await calls(page, command)).filter((call) => call.args.id === id).length;
  expect(await forThisOne("terminal_close")).toBe(0);
  expect(await forThisOne("terminal_kill")).toBe(0);
  expect(await forThisOne("terminal_open")).toBe(1);
  expect(await countCalls(page, "terminal_close_all")).toBe(1);
  // Its views were detached and attached again (a view's subscription is named after it).
  const detached = (await calls(page, "terminal_unsubscribe")).filter((call) =>
    String(call.args.subscriptionId).startsWith(`${id}-view-`),
  );
  expect(detached.length).toBeGreaterThan(0);
});

// --- TERMINAL-04: the renderer as a view of the workspace's terminals ----------------------------

/** Opens a folder through File › Open Folder… (the mock answers with `folder`). */
async function openFolder(page: Page, folder: string) {
  await page.evaluate((path) => {
    (window as unknown as { __openFolder?: string }).__openFolder = path;
  }, folder);
  await page.getByRole("menubar").getByRole("menuitem", { name: "File", exact: true }).click();
  await page
    .getByRole("menu", { name: "File", exact: true })
    .getByRole("menuitem", { name: "Open Folder…", exact: true })
    .click();
}

test("a split survives leaving the workspace: both terminals come back, attached, never restarted", async ({
  page,
}) => {
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);
  await page.getByLabel("Split Terminal").click();
  const [left, right] = await terminalIds(page, 2);
  await expect(view(page, left)).toBeVisible();
  await expect(view(page, right)).toBeVisible();

  await openFolder(page, "/other");
  await expect(view(page, left)).toHaveCount(0);
  await output(page, right, "right while away\r\n");
  await openFolder(page, "/work");

  // The same two sessions, side by side again, the right one replayed.
  await expect(view(page, left)).toBeVisible();
  await expect(view(page, right)).toBeVisible();
  await expect(view(page, right)).toContainText("right while away");
  await expect(page.getByLabel("Unsplit Terminal")).toBeVisible();
  const opens = (await calls(page, "terminal_open")).filter(
    (call) => call.args.id === left || call.args.id === right,
  );
  expect(new Set(opens.map((call) => `${call.args.id}:${call.args.generation}`)).size).toBe(2);
  expect(await countCalls(page, "terminal_close")).toBe(0);
});

test("a rename is the session's: it survives leaving the workspace and coming back", async ({
  page,
}) => {
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);
  const tabs = page.getByRole("tablist", { name: "Terminals" });
  await tabs.getByRole("tab").first().dblclick();
  await page.getByLabel("Rename terminal").fill("Builds");
  await page.getByLabel("Rename terminal").press("Enter");
  await expect(tabs.getByRole("tab", { name: "Builds" })).toBeVisible();

  await openFolder(page, "/other");
  await openFolder(page, "/work");
  await expect(
    page.getByRole("tablist", { name: "Terminals" }).getByRole("tab", { name: "Builds" }),
  ).toBeVisible();
});

test("the context menu acts on the pane it was opened on, not the one in front", async ({
  page,
}) => {
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);
  await page.getByLabel("Split Terminal").click();
  const [left, right] = await terminalIds(page, 2);
  // Working in the left pane; the menu is opened on the right one.
  await view(page, left).click();
  await view(page, right).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Close Terminal" }).click();

  await expect
    .poll(async () => (await calls(page, "terminal_close")).map((c) => c.args.id))
    .toEqual([right]);
  await expect(view(page, left)).toBeVisible();
  await expect(page.getByLabel("Split Terminal")).toBeVisible();
});

test("a paste goes through the terminal, bracketed when the program asked for it", async ({
  page,
}) => {
  await desktop(page);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await openPanel(page);
  const [id] = await terminalIds(page);
  // The program turns bracketed paste on.
  await output(page, id, "\x1b[?2004h");
  await page.evaluate(() => navigator.clipboard.writeText("echo one\necho two"));
  await view(page, id).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Paste" }).click();
  await expect
    .poll(async () => (await calls(page, "terminal_write")).map((c) => c.args.data).join(""))
    .toBe("\x1b[200~echo one\recho two\x1b[201~");
});

test("a large paste reaches the shell whole, in pieces the contract allows", async ({ page }) => {
  await desktop(page);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await openPanel(page);
  const [id] = await terminalIds(page);
  const text = "x".repeat(150_000);
  await page.evaluate((value) => navigator.clipboard.writeText(value), text);
  await view(page, id).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Paste" }).click();
  await expect
    .poll(async () => (await calls(page, "terminal_write")).map((c) => c.args.data).join(""))
    .toBe(text);
  const sizes = (await calls(page, "terminal_write")).map((c) => (c.args.data as string).length);
  expect(sizes.length).toBeGreaterThan(1);
  expect(Math.max(...sizes)).toBeLessThanOrEqual(64 * 1024);
});

test("the status line is the focused terminal's own", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);
  await page.getByLabel("Split Terminal").click();
  const [left, right] = await terminalIds(page, 2);
  // The right one exits; the left one, in front, still runs.
  await view(page, left).click();
  await exit(page, right, 2);
  await expect(view(page, right)).toContainText("exited with code 2");
  await expect(page.getByRole("status").filter({ hasText: "Running" })).toBeVisible();
  // Its own failure shows once the right pane is the one in front.
  await view(page, right).click();
  await expect(page.getByRole("status").filter({ hasText: "Running" })).toHaveCount(0);
});

test("Ctrl+Shift+` starts a terminal from anywhere in the window", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);
  // Outside the terminal, where the app's own shortcut handling applies.
  await page.getByTitle("Explorer (Ctrl+Shift+E)").click();
  await page.keyboard.press("Control+Shift+Backquote");
  await terminalIds(page, 2);
});

test("leaving the workspace or unmounting a view never closes a terminal", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);
  await page.getByLabel("New Terminal").click();
  await terminalIds(page, 2);
  // Hiding the panel, switching tabs and leaving the workspace unmount or hide views.
  await page
    .getByRole("tablist", { name: "Panel views" })
    .getByRole("tab", { name: "OUTPUT" })
    .click();
  await page
    .getByRole("tablist", { name: "Panel views" })
    .getByRole("tab", { name: "TERMINAL" })
    .click();
  await openFolder(page, "/other");
  await openFolder(page, "/work");
  expect(await countCalls(page, "terminal_close")).toBe(0);
  expect(await countCalls(page, "terminal_kill")).toBe(0);
  expect(await countCalls(page, "terminal_close_all")).toBe(1);
  // This workspace still has exactly its two; the other folder got its own first terminal.
  const opened = await calls(page, "terminal_open");
  const byWorkspace = (folder: string) =>
    new Set(
      opened
        .filter((call) => String(call.args.workspaceId).endsWith(folder))
        .map((call) => call.args.id),
    ).size;
  expect(byWorkspace("/work")).toBe(2);
  expect(byWorkspace("/other")).toBe(1);
});

// --- TERMINAL-05: profiles -----------------------------------------------------------------------

test("the shell menu lists every profile; one that cannot start says why and starts nothing", async ({
  page,
}) => {
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);
  await page.getByLabel("Choose a shell").click();
  const menu = page.getByRole("menu", { name: "Shells" });
  const pwsh = menu.getByRole("menuitem", { name: "PowerShell", exact: true });
  await expect(pwsh).toBeDisabled();
  await expect(pwsh).toHaveAttribute("title", "PowerShell 7 (pwsh.exe) is not installed.");
  await expect(menu.getByRole("menuitem", { name: "Manage Profiles…" })).toBeVisible();
  const opens = await countCalls(page, "terminal_open");
  await pwsh.click({ force: true });
  expect(await countCalls(page, "terminal_open")).toBe(opens);
});

test("a profile made in the dialog launches with its arguments, environment, folder and login", async ({
  page,
}) => {
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);
  await page.getByLabel("Choose a shell").click();
  await page.getByRole("menuitem", { name: "Manage Profiles…" }).click();
  const dialog = page.getByRole("dialog", { name: "Terminal profiles" });
  await dialog.getByRole("button", { name: "New Profile" }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("Builds");
  await dialog.getByLabel("Shell", { exact: true }).selectOption({ label: "Git Bash" });
  await dialog.getByLabel("Arguments").fill('--rcfile\na file & "quotes"');
  await dialog.getByLabel("Folder").fill("tools");
  await dialog.getByLabel("Environment").fill("BASE=/opt\nTOOLS=$BASE/tools");
  await dialog.getByLabel("Login shell").check();
  await dialog.getByRole("button", { name: "Save Profile" }).click();
  await expect(dialog.getByRole("listitem", { name: "Builds" })).toBeVisible();
  await dialog
    .getByRole("listitem", { name: "Builds" })
    .getByRole("button", { name: "Open" })
    .click();

  const [id] = (await terminalIds(page, 2)).slice(-1);
  const open = (await calls(page, "terminal_open")).filter((c) => c.args.id === id)[0];
  const profile = open.args.profile as Record<string, unknown>;
  expect(profile).toMatchObject({
    name: "Builds",
    executable: BASH,
    args: ["--rcfile", 'a file & "quotes"'],
    cwd: "tools",
    env: [
      ["BASE", "/opt"],
      ["TOOLS", "$BASE/tools"],
    ],
    login: true,
  });
  await expect(page.getByRole("tab", { name: "Builds", exact: true })).toHaveAttribute(
    "title",
    "Profile: Builds",
  );
});

test("an invalid profile is refused with a reason, and a login shell is only offered where it exists", async ({
  page,
}) => {
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);
  await page.getByLabel("Choose a shell").click();
  await page.getByRole("menuitem", { name: "Manage Profiles…" }).click();
  const dialog = page.getByRole("dialog", { name: "Terminal profiles" });
  await dialog.getByRole("button", { name: "New Profile" }).click();
  // The Command Prompt has no login mode.
  await dialog.getByLabel("Shell", { exact: true }).selectOption({ label: "Command Prompt" });
  await expect(dialog.getByLabel("Login shell")).toBeDisabled();
  await dialog.getByLabel("Environment").fill("A=B=C\n=nameless");
  await dialog.getByLabel("Name", { exact: true }).fill("Broken");
  await dialog.getByRole("button", { name: "Save Profile" }).click();
  await expect(dialog.getByRole("alert")).toContainText("not a valid environment variable name");
  await expect(dialog.getByRole("listitem", { name: "Broken" })).toHaveCount(0);
  // Built-in profiles can be used and made default, never edited or deleted.
  const builtin = dialog.getByRole("listitem", { name: "Git Bash" });
  await expect(builtin.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await expect(builtin.getByRole("button", { name: "Delete" })).toHaveCount(0);
});

test("the default profile is what New Terminal starts", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);
  await page.getByLabel("Choose a shell").click();
  await page.getByRole("menuitem", { name: "Manage Profiles…" }).click();
  const dialog = page.getByRole("dialog", { name: "Terminal profiles" });
  await dialog
    .getByRole("listitem", { name: "Git Bash" })
    .getByRole("button", { name: "Make default" })
    .click();
  await expect(dialog.getByRole("listitem", { name: "Git Bash" })).toContainText("Default");
  await dialog.getByLabel("Close profiles").click();
  await page.getByLabel("New Terminal").click();
  const [id] = (await terminalIds(page, 2)).slice(-1);
  const open = (await calls(page, "terminal_open")).filter((c) => c.args.id === id)[0];
  expect(open.args.shell).toBe(BASH);
});
