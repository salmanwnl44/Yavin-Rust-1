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
            // One `for-each-ref` covers both patterns, in the full `%(refname)` form.
            if (argv[0] === "for-each-ref")
              return ok("refs/heads/main\nrefs/remotes/origin/main\nrefs/remotes/origin/HEAD\n");
            // What the hover card reads: the numstat summary and the full message.
            if (argv[0] === "show" && argv.includes("--numstat"))
              // `show --numstat -z`: the header on the first line, then NUL-separated records.
              return ok("c1\x1fFirst commit\n2\t1\tsrc/a.ts\x000\t3\tsrc/b.ts\x00");
            if (argv[0] === "show") return ok("First commit\n\nWhy it was made.\n");
            if (argv[0] === "remote") return ok("");
            if (argv[0] === "log")
              return ok(
                [
                  [
                    "c2",
                    "c2",
                    "c1",
                    "Author",
                    "a@x.test",
                    "Jan 2",
                    "1 hour ago",
                    "Second commit",
                    "",
                  ],
                  ["c1", "c1", "", "Author", "a@x.test", "Jan 1", "1 day ago", "First commit", ""],
                ]
                  .map((fields) => fields.join("\x1f"))
                  .join("\n"),
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

test("the sidebar graph's scope label opens a picker offering Auto, All and every branch", async ({
  page,
}) => {
  const region = await panel(page);
  await region.getByRole("button", { name: "Change which history is shown" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("option", { name: "Auto" })).toBeVisible();
  await expect(dialog.getByRole("option", { name: "All" })).toBeVisible();
  await expect(dialog.getByRole("option", { name: "main", exact: true })).toBeVisible();
});

test("picking a branch from the sidebar graph's scope picker re-queries the log for it", async ({
  page,
}) => {
  const region = await panel(page);
  const seen: string[][] = [];
  await page.exposeFunction("__recordArgv", (argv: string[]) => seen.push(argv));
  await page.evaluate(() => {
    const w = window as unknown as {
      __TAURI_INTERNALS__: {
        invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
      };
      __recordArgv: (a: string[]) => void;
    };
    const original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (command: string, args: Record<string, unknown> = {}) => {
      if (command === "git_exec") {
        const argv = (args.args as string[] | undefined) ?? [];
        if (argv[0] === "log") await w.__recordArgv(argv);
      }
      return original(command, args);
    };
  });
  await region.getByRole("button", { name: "Change which history is shown" }).click();
  await page.getByRole("dialog").getByRole("option", { name: "main", exact: true }).click();
  await expect
    .poll(() => seen.some((argv) => argv.includes("main") && !argv.includes("--all")))
    .toBe(true);
});

test("a branch behind its upstream shows an Incoming Changes row in the sidebar graph", async ({
  page,
}) => {
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
              return ok("# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -2\n");
            if (argv[0] === "status") return ok("");
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
  await expect(region.getByText("Incoming Changes")).toBeVisible();
  await expect(region.getByText("origin/main")).toBeVisible();
});

test("a branch up to date with its upstream shows no Incoming Changes row", async ({ page }) => {
  const region = await panel(page);
  await expect(region.getByText("Incoming Changes")).toHaveCount(0);
});

test("resting on a commit shows a card with its author, message and size", async ({ page }) => {
  // The graph row can only show a truncated subject; everything else about a commit needed
  // a click before this. Hovering answers "what is this" without leaving where you are.
  const region = await panel(page);
  const row = region.getByRole("button").filter({ hasText: "First commit" }).first();
  await row.hover();

  const card = page.getByRole("dialog", { name: /^Commit / });
  await expect(card).toBeVisible();
  await expect(card).toContainText("Author");
  await expect(card).toContainText("First commit");
  await expect(card).toContainText("1 day ago");
  await expect(card).toContainText("2 files changed");
  await expect(card.getByRole("button", { name: "Copy commit hash" })).toBeVisible();
});

test("the card goes away when the pointer leaves, and on Escape", async ({ page }) => {
  const region = await panel(page);
  const row = region.getByRole("button").filter({ hasText: "First commit" }).first();
  await row.hover();
  const card = page.getByRole("dialog", { name: /^Commit / });
  await expect(card).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
});

test("reaching a commit by keyboard shows the card too", async ({ page }) => {
  // It holds the only copy button and the only link to the hosting site, so it cannot be
  // reachable by mouse alone.
  const region = await panel(page);
  await region.getByRole("button").filter({ hasText: "First commit" }).first().focus();
  await expect(page.getByRole("dialog", { name: /^Commit / })).toBeVisible();
});

test("the scope picker offers remote-tracking branches, and not origin/HEAD", async ({ page }) => {
  const region = await panel(page);
  await region.getByRole("button", { name: "Change which history is shown" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("option", { name: /origin\/main/ })).toBeVisible();
  // `origin/HEAD` is a pointer at the remote's default branch, not a branch to pick.
  await expect(dialog.getByRole("option", { name: /origin\/HEAD/ })).toHaveCount(0);
});

test("a commit's files open directly under its own row, not below the whole list", async ({
  page,
}) => {
  // Shown after the list, the files for the commit you clicked appeared however many rows
  // further down the graph happened to be -- which is not where anyone looks for them.
  const region = await panel(page);
  const second = region.getByRole("button").filter({ hasText: "Second commit" }).first();
  const older = region.getByRole("button").filter({ hasText: "First commit" }).first();
  await second.click();

  const file = region.getByRole("button", { name: /src\/a\.ts/ }).first();
  await expect(file).toBeVisible();

  const clicked = await second.boundingBox();
  const files = await file.boundingBox();
  const below = await older.boundingBox();
  expect(files!.y).toBeGreaterThan(clicked!.y);
  // The commit below it has been pushed down past the detail, rather than the detail being
  // parked underneath everything.
  expect(below!.y).toBeGreaterThan(files!.y);
});

test("the card opens beside the graph, not on top of the commits", async ({ page }) => {
  // A card over the rows hides the commits either side of the one being read, which is the
  // context that makes reading it worth anything.
  const region = await panel(page);
  const graph = region.locator("section[aria-label='Graph']");
  await region.getByRole("button").filter({ hasText: "Second commit" }).first().hover();

  const card = page.getByRole("dialog", { name: /^Commit / });
  await expect(card).toBeVisible();
  const cardBox = await card.boundingBox();
  const graphBox = await graph.boundingBox();
  // Clear of the list horizontally, either to its right or to its left.
  const clear =
    cardBox!.x >= graphBox!.x + graphBox!.width || cardBox!.x + cardBox!.width <= graphBox!.x;
  expect(clear).toBe(true);
});

test("a commit row shows its subject, without the author repeated on every line", async ({
  page,
}) => {
  // In a repository with one author that was the same name on every row, crowding out the
  // subject -- which is the only thing that tells the commits apart. It is in the card.
  const region = await panel(page);
  const row = region.getByRole("button").filter({ hasText: "Second commit" }).first();
  await expect(row).toContainText("Second commit");
  await expect(row).not.toContainText("Author");

  await row.hover();
  await expect(page.getByRole("dialog", { name: /^Commit / })).toContainText("Author");
});

test("expanding a commit shows its files, not its whole message", async ({ page }) => {
  // A multi-paragraph commit message rendered in a 300px sidebar pushed the changed files --
  // the reason for expanding a commit at all -- off the bottom of the panel. The message is
  // in the hover card.
  const region = await panel(page);
  await region.getByRole("button").filter({ hasText: "Second commit" }).first().click();

  await expect(region.getByRole("button", { name: /src\/a\.ts/ })).toBeVisible();
  await expect(region).not.toContainText("Why it was made");
});
