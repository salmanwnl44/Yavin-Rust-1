import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

async function panel(page: Page) {
  await page.addInitScript(() => {
    const ok = (stdout: string) => ({ stdout, stderr: "", code: 0, truncated: false });
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        transformCallback: () => 1,
        unregisterCallback: () => {},
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          if (command === "get_default_workspace") return "/work";
          if (command === "list_workspace_files")
            return { path: "/work", name: "work", is_dir: true, children: [] };
          if (command === "read_file_content") return "contents";
          if (command === "git_open_repo") return { repoId: "/work", root: "/work" };
          if (command === "git_repo_state") return "";
          if (command === "git_exec") {
            const argv = (args.args as string[] | undefined) ?? [];
            if (argv[0] === "status" && argv.includes("--porcelain=v2"))
              return ok("# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -0\n");
            if (argv[0] === "status") return ok(" M a.ts\0");
            if (argv[0] === "for-each-ref") return ok("main\n");
            if (argv[0] === "remote") return ok("");
            if (argv[0] === "log")
              return ok(
                [
                  "c1",
                  "c1",
                  "",
                  "Author",
                  "a@x.test",
                  "Jan 1",
                  "1 day ago",
                  "First commit",
                  "",
                ].join("\x1f"),
              );
            return ok("");
          }
          return null;
        },
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
    });
  });
  await page.goto("/");
  await page.getByTitle("Source Control (Ctrl+Shift+G)").click();
  const region = page.getByRole("complementary", { name: "Source control" });
  await expect(region).toBeVisible();
  return region;
}

test("only Changes and Graph are visible by default; Repositories and Stashes are opt-in", async ({
  page,
}) => {
  const region = await panel(page);
  await expect(region.locator("section[aria-label='Changes panel']")).toBeVisible();
  await expect(region.locator("section[aria-label='Graph']")).toBeVisible();
  await expect(region.locator("section[aria-label='Repositories']")).toHaveCount(0);
  await expect(region.locator("section[aria-label='Stashes']")).toHaveCount(0);

  await region.getByLabel("Source Control view options").click();
  await page.getByRole("menuitem", { name: "Repositories" }).click();
  await expect(region.locator("section[aria-label='Repositories']")).toBeVisible();
  await region.getByLabel("Source Control view options").click();
  await page.getByRole("menuitem", { name: "Stashes" }).click();
  await expect(region.locator("section[aria-label='Stashes']")).toBeVisible();
});

test("the panel menu can hide and reshow the Graph section", async ({ page }) => {
  const region = await panel(page);
  const graph = region.locator("section[aria-label='Graph']");
  await expect(graph).toBeVisible();

  await region.getByLabel("Source Control view options").click();
  await page.getByRole("menuitem", { name: "Graph" }).click();
  await expect(graph).toHaveCount(0);

  await region.getByLabel("Source Control view options").click();
  await page.getByRole("menuitem", { name: "Graph" }).click();
  await expect(graph).toBeVisible();
});

test("a section's own chevron collapses just that section", async ({ page }) => {
  const region = await panel(page);
  const changesHeader = region.locator("section[aria-label='Changes panel'] > div").first();
  await expect(region.getByLabel("Commit message")).toBeVisible();
  await changesHeader.click();
  await expect(region.getByLabel("Commit message")).toHaveCount(0);
  // The other sections are unaffected.
  await expect(region.locator("section[aria-label='Graph']")).toBeVisible();
});

test("the repository row's menu offers the expected commands", async ({ page }) => {
  const region = await panel(page);
  await region.getByLabel("Source Control view options").click();
  await page.getByRole("menuitem", { name: "Repositories" }).click();
  await region.getByLabel("work actions").click();
  await expect(page.getByRole("menuitem", { name: "Fetch" })).toBeEnabled();
  await expect(page.getByRole("menuitem", { name: "Clone…" })).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: "Checkout to…" })).toBeDisabled();
});

test("modified and untracked files share one Changes list", async ({ page }) => {
  await page.addInitScript(() => {
    const ok = (stdout: string) => ({ stdout, stderr: "", code: 0, truncated: false });
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        transformCallback: () => 1,
        unregisterCallback: () => {},
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          if (command === "get_default_workspace") return "/work";
          if (command === "list_workspace_files")
            return { path: "/work", name: "work", is_dir: true, children: [] };
          if (command === "git_open_repo") return { repoId: "/work", root: "/work" };
          if (command === "git_repo_state") return "";
          if (command === "git_exec") {
            const argv = (args.args as string[] | undefined) ?? [];
            if (argv[0] === "status" && argv.includes("--porcelain=v2"))
              return ok("# branch.head main\n");
            if (argv[0] === "status") return ok(" M a.ts\0?? b.ts\0");
            if (argv[0] === "for-each-ref" || argv[0] === "remote" || argv[0] === "log")
              return ok("");
            return ok("");
          }
          return null;
        },
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
    });
  });
  await page.goto("/");
  await page.getByTitle("Source Control (Ctrl+Shift+G)").click();
  const region = page.getByRole("complementary", { name: "Source control" });
  const list = region.getByRole("list", { name: "Changed files" });
  await expect(list).toHaveCount(1);
  await expect(list.getByText("a.ts")).toBeVisible();
  await expect(list.getByText("b.ts")).toBeVisible();
  // No separate Staged / Changes sections any more.
  await expect(region.locator("section[aria-label='Staged Changes']")).toHaveCount(0);
  await expect(region.locator("section[aria-label='Changes']")).toHaveCount(0);
});

test("the inline graph lists commits without colliding with the branch drawer's buttons", async ({
  page,
}) => {
  const region = await panel(page);
  await expect(region.getByText("First commit")).toBeVisible();
  await region.getByTitle("Branches and remotes").click();
  // Both the drawer's "Fetch" and the graph's own (differently labeled) icon exist
  // without Playwright treating them as ambiguous.
  await expect(region.getByRole("button", { name: "Fetch", exact: true })).toBeVisible();
});

test("clicking a menu item that has a submenu keeps the submenu open", async ({ page }) => {
  const region = await panel(page);
  await region.getByLabel("Changes actions").click();
  const stash = page.getByRole("menuitem", { name: /^Stash ›$/ });
  // A mouse user hovers the item (which opens its flyout) and then clicks it.
  await stash.hover();
  await expect(page.getByRole("menuitem", { name: "Stash", exact: true })).toBeVisible();
  await stash.click();
  await expect(page.getByRole("menuitem", { name: "Stash", exact: true })).toBeVisible();
});
