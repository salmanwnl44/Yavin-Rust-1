import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

type Call = { command: string; args: Record<string, unknown> };

/**
 * `stash@{N}` indices shift down whenever an earlier stash is removed, so the mock
 * always re-derives them from the live list's order rather than trusting a caller's
 * stale index -- exactly the invariant the real `git stash` CLI provides.
 */
async function panel(page: Page, initial: string[] = []) {
  await page.addInitScript((entries) => {
    const stash: string[] = [...entries];
    const ok = (stdout: string) => ({ stdout, stderr: "", code: 0, truncated: false });
    const list = () => stash.map((message, i) => `stash@{${i}}: ${message}`).join("\n");
    const calls: Call[] = [];
    Object.assign(window, {
      __calls: calls,
      isTauri: true,
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        transformCallback: () => 1,
        unregisterCallback: () => {},
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          calls.push({ command, args });
          if (command === "get_default_workspace") return "/work";
          if (command === "list_workspace_files")
            return { path: "/work", name: "work", is_dir: true, children: [] };
          if (command === "git_open_repo") return { repoId: "/work", root: "/work" };
          if (command === "git_repo_state") return "";
          if (command === "git_exec") {
            const argv = (args.args as string[] | undefined) ?? [];
            if (argv[0] === "status" && argv.includes("--porcelain=v2"))
              return ok("# branch.head main\n");
            if (argv[0] === "status" || argv[0] === "for-each-ref" || argv[0] === "remote")
              return ok("");
            if (argv[0] === "stash") {
              if (argv[1] === "list") return ok(stash.length ? `${list()}\n` : "");
              const index = Number(argv[2]?.match(/^stash@\{(\d+)\}$/)?.[1]);
              if (argv[1] === "pop" || argv[1] === "drop") {
                if (!Number.isNaN(index)) stash.splice(index, 1);
                return ok("");
              }
              // "apply" leaves the list untouched -- the stash still exists afterward.
              return ok("");
            }
            return ok("");
          }
          return null;
        },
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
    });
  }, initial);
  await page.goto("/");
  await page.getByTitle("Source Control (Ctrl+Shift+G)").click();
  const region = page.getByRole("complementary", { name: "Source control" });
  await expect(region).toBeVisible();
  return region;
}

const stashCalls = (page: Page, action: string) =>
  page.evaluate(
    (name) =>
      (window as unknown as { __calls: Call[] }).__calls.filter(
        (call) =>
          call.command === "git_exec" &&
          (call.args.args as string[] | undefined)?.[0] === "stash" &&
          (call.args.args as string[] | undefined)?.[1] === name,
      ).length,
    action,
  );

test("stashed changes are listed with their message and source branch", async ({ page }) => {
  const region = await panel(page, ["WIP on main: 1a2b3c4 fix the bug", "On main: wip refactor"]);
  const section = region.locator("section[aria-label='Stashes']");
  await expect(section.getByText("1a2b3c4 fix the bug")).toBeVisible();
  await expect(section.getByText("wip refactor")).toBeVisible();
  await expect(section.getByText("2", { exact: true })).toBeVisible();
});

test("an empty stash list says so instead of showing an empty section", async ({ page }) => {
  const region = await panel(page);
  const section = region.locator("section[aria-label='Stashes']");
  await expect(section.getByText("No stashed changes.")).toBeVisible();
});

test("applying a stash keeps it in the list", async ({ page }) => {
  const region = await panel(page, ["WIP on main: 1a2b3c4 fix the bug"]);
  const section = region.locator("section[aria-label='Stashes']");
  await section.getByLabel("Apply stash 1a2b3c4 fix the bug").click();
  await expect.poll(async () => stashCalls(page, "apply")).toBe(1);
  await expect(section.getByText("1a2b3c4 fix the bug")).toBeVisible();
});

test("popping a stash applies it and removes it from the list", async ({ page }) => {
  const region = await panel(page, ["WIP on main: 1a2b3c4 fix the bug", "On main: wip refactor"]);
  const section = region.locator("section[aria-label='Stashes']");
  await section.getByLabel("Pop stash 1a2b3c4 fix the bug").click();
  await expect.poll(async () => stashCalls(page, "pop")).toBe(1);
  await expect(section.getByText("1a2b3c4 fix the bug")).toHaveCount(0);
  await expect(section.getByText("wip refactor")).toBeVisible();
});

test("dropping a stash asks for confirmation before removing it", async ({ page }) => {
  const region = await panel(page, ["WIP on main: 1a2b3c4 fix the bug"]);
  const section = region.locator("section[aria-label='Stashes']");

  page.once("dialog", (dialog) => void dialog.dismiss());
  await section.getByLabel("Drop stash 1a2b3c4 fix the bug").click();
  await expect.poll(async () => stashCalls(page, "drop")).toBe(0);
  await expect(section.getByText("1a2b3c4 fix the bug")).toBeVisible();

  page.once("dialog", (dialog) => void dialog.accept());
  await section.getByLabel("Drop stash 1a2b3c4 fix the bug").click();
  await expect.poll(async () => stashCalls(page, "drop")).toBe(1);
  await expect(section.getByText("No stashed changes.")).toBeVisible();
});
