import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

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
    let nextId = 1;

    Object.assign(window, {
      __calls: calls,
      // Delivers a native event to every listener registered for it.
      __emit: (event: string, payload: unknown) => {
        for (const id of listeners[event] ?? []) callbacks[id]?.({ event, id, payload });
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
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          calls.push({ command, args });
          if (command === "plugin:event|listen") {
            const event = args.event as string;
            (listeners[event] ??= []).push(args.handler as number);
            return nextId++;
          }
          if (command === "get_default_workspace") return "/work";
          if (command === "list_workspace_files")
            return {
              path: "/work",
              name: "work",
              is_dir: true,
              children: [{ path: "/work/file.ts", name: "file.ts", is_dir: false, children: null }],
            };
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
          if (command === "run_checker") {
            const scenario = window as unknown as {
              __scenarioCheckerOutput?: string;
              __scenarioCheckerCode?: number;
            };
            const output = scenario.__scenarioCheckerOutput ?? setup.checkerOutput ?? "";
            // A checker exits nonzero when it finds problems, so the tests say which.
            return { output, code: scenario.__scenarioCheckerCode ?? setup.checkerCode ?? 0 };
          }
          if (command === "stop_listening_process") return null;
          if (command === "terminal_shells")
            return [
              { name: "Command Prompt", path: "C:\\Windows\\System32\\cmd.exe" },
              { name: "Git Bash", path: "C:\\Program Files\\Git\\bin\\bash.exe" },
            ];
          if (command === "terminal_open") {
            if (setup.failOpen) throw setup.failOpen;
            return args.shell || "C:\\Windows\\System32\\cmd.exe";
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

const emit = (page: Page, event: string, payload: unknown) =>
  page.evaluate(
    ([name, data]) =>
      (window as unknown as { __emit: (e: string, p: unknown) => void }).__emit(
        name as string,
        data,
      ),
    [event, payload] as const,
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

  await emit(page, "terminal-output", { id, data: "hello from the shell\r\n" });
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

  await emit(page, "terminal-output", { id: first, data: "belongs to one" });
  await emit(page, "terminal-output", { id: second, data: "belongs to two" });

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
  await emit(page, "terminal-output", { id, data: "long running build" });

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
  await desktop(page, { failOpen: "Open a workspace first" });
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

  await emit(page, "terminal-exit", { id, code: 130 });
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

test("a shell that ends cleanly is not reported as a failure", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  const [id] = await terminalIds(page);

  await emit(page, "terminal-exit", { id, code: 0 });
  await expect(view(page, id)).toContainText("The shell exited.");
  await expect(view(page, id)).not.toContainText("code");
});

test("find locates output and reports when there is no match", async ({ page }) => {
  await desktop(page);
  await openPanel(page);
  const [id] = await terminalIds(page);
  // Wait for the shell to be attached so the search runs against a settled terminal.
  await expect(page.getByRole("status")).toContainText("Running");
  await emit(page, "terminal-output", { id, data: "compiling widget.rs\r\n" });

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
  await emit(page, "terminal-output", { id, data: "Widget widget WIDGET\r\n" });
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
  await emit(page, "terminal-output", { id, data: "some output to clear\r\n" });
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
  await emit(page, "terminal-output", { id: first, data: "\u0007" });
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
  await emit(page, "terminal-output", { id, data: "before switching\r\n" });
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

test("output reaches only the terminal it belongs to, with one native subscription", async ({
  page,
}) => {
  // Routed by id rather than every terminal filtering a broadcast.
  await desktop(page);
  await openPanel(page);
  await terminalIds(page);
  await page.getByLabel("New Terminal").click();
  const [first, second] = await terminalIds(page, 2);

  await emit(page, "terminal-output", { id: second, data: "only for the second" });
  await expect(view(page, second)).toContainText("only for the second");
  await expect(view(page, first)).not.toContainText("only for the second");

  // The count must not grow with the number of terminals: one subscription routes to all of
  // them. (It is not exactly one overall, because React's development StrictMode mounts,
  // unmounts and remounts, which legitimately resubscribes.)
  const outputListens = async () =>
    (await calls(page, "plugin:event|listen")).filter(
      (call) => call.args.event === "terminal-output",
    ).length;
  const before = await outputListens();
  await page.getByLabel("New Terminal").click();
  await page.getByLabel("New Terminal").click();
  await terminalIds(page, 4);
  expect(await outputListens()).toBe(before);
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

  await expect(page.getByRole("alert")).toContainText("could not determine executable");
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
  await expect(page.getByRole("alert")).toHaveCount(0);
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
  await emit(page, "terminal-output", { id: ids[1], data: "still alive" });
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
