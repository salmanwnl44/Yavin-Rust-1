import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

interface Call {
  command: string;
  args: Record<string, unknown>;
}

interface StoredWorkspace {
  folder: string;
  files?: string[];
  active?: string | null;
  expanded?: string[];
  scroll?: number;
}

/**
 * A desktop window whose session file already holds `session`, over a fixed little tree.
 *
 * `missing` names paths the session mentions but the filesystem no longer has, which is the
 * ordinary case after someone deletes a file between two runs.
 */
async function desktop(
  page: Page,
  options: {
    session?: { folders?: string[]; workspaces?: StoredWorkspace[] };
    /** What a development build would open when there is no session. */
    defaultWorkspace?: string | null;
    missing?: string[];
    /** Folders `open_workspace` refuses, as a moved or deleted folder would be. */
    unopenable?: string[];
    /** Milliseconds each file read takes, for watching what happens during a restore. */
    slowReads?: number;
  } = {},
) {
  await page.addInitScript((setup) => {
    const calls: Call[] = [];
    let session = {
      folders: setup.session?.folders ?? [],
      workspaces: setup.session?.workspaces ?? [],
    };
    const missing = new Set(setup.missing ?? []);
    const unopenable = new Set(setup.unopenable ?? []);

    const directories = new Set(["/work", "/work/src", "/work/src/deep", "/other"]);
    const files: Record<string, string> = {
      "/work/a.ts": "the contents of a",
      "/work/b.ts": "the contents of b",
      "/work/src/inner.ts": "inner",
      "/other/only.ts": "only",
    };

    const node = (path: string) => ({
      path,
      name: path.slice(path.lastIndexOf("/") + 1),
      is_dir: directories.has(path),
      children: null as unknown,
    });

    Object.assign(window, {
      __calls: calls,
      isTauri: true,
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        transformCallback: () => 1,
        unregisterCallback: () => {},
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          calls.push({ command, args });
          if (command === "read_session") return session;
          if (command === "save_workspace_session") {
            const state = args.state as StoredWorkspace;
            session = {
              folders: [
                state.folder,
                ...session.folders.filter((folder) => folder !== state.folder),
              ],
              workspaces: [
                ...session.workspaces.filter((one) => one.folder !== state.folder),
                state,
              ],
            };
            return null;
          }
          if (command === "forget_workspace") {
            session = {
              folders: session.folders.filter((folder) => folder !== args.folder),
              workspaces: session.workspaces.filter((one) => one.folder !== args.folder),
            };
            return session;
          }
          if (command === "open_workspace") {
            const path = args.path as string;
            if (unopenable.has(path) || !directories.has(path)) throw `${path} does not exist`;
            return path;
          }
          if (command === "get_default_workspace") return setup.defaultWorkspace ?? null;
          if (command === "open_folder_dialog") return "/other";
          if (command === "list_workspace_files") {
            const path = args.path as string;
            if (!directories.has(path)) throw `Cannot read ${path}`;
            const children = [...directories, ...Object.keys(files)]
              .filter((one) => one !== path && one.slice(0, one.lastIndexOf("/")) === path)
              .sort(
                (a, b) =>
                  Number(directories.has(b)) - Number(directories.has(a)) || a.localeCompare(b),
              )
              .map(node);
            return { ...node(path), children };
          }
          if (command === "read_file_content") {
            const path = args.path as string;
            if (missing.has(path) || files[path] === undefined) throw `Cannot read ${path}`;
            if (setup.slowReads)
              await new Promise((resolve) => setTimeout(resolve, setup.slowReads));
            return files[path];
          }
          if (command === "git_open_repo") return { repoId: "/work", root: "/work" };
          if (command === "git_repo_state") return "";
          if (command === "git_exec") return { stdout: "", stderr: "", code: 0, truncated: false };
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

const welcome = (page: Page) => page.getByRole("region", { name: "Welcome" });
const tree = (page: Page) => page.getByRole("tree", { name: "Files" });
const entry = (page: Page, name: string) => tree(page).getByRole("treeitem", { name, exact: true });

test("a first run offers the ways to start, and says the explorer has nothing yet", async ({
  page,
}) => {
  await desktop(page);
  await expect(welcome(page).getByRole("button", { name: "Open Folder" })).toBeVisible();
  await expect(welcome(page).getByRole("button", { name: "Clone Repository" })).toBeVisible();
  await expect(welcome(page)).toContainText("Folders you open are listed here");
  await expect(page.getByText("No workspace opened")).toBeVisible();
});

test("the folder from last time is reopened, with the tabs it had", async ({ page }) => {
  await desktop(page, {
    session: {
      folders: ["/work"],
      workspaces: [{ folder: "/work", files: ["/work/a.ts", "/work/b.ts"], active: "/work/b.ts" }],
    },
  });

  await expect.poll(async () => (await calls(page, "open_workspace")).length).toBeGreaterThan(0);
  const [opened] = await calls(page, "open_workspace");
  expect(opened.args.path).toBe("/work");

  await expect(page.getByRole("tab", { name: /a\.ts/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: /b\.ts/ })).toBeVisible();
  // The tab that was in front is in front again, with its contents.
  await expect(page.getByRole("textbox")).toContainText("the contents of b");
});

test("a file that has been deleted since is skipped, not reported", async ({ page }) => {
  await desktop(page, {
    session: {
      folders: ["/work"],
      workspaces: [{ folder: "/work", files: ["/work/a.ts", "/work/gone.ts"] }],
    },
    missing: ["/work/gone.ts"],
  });

  await expect(page.getByRole("tab", { name: /a\.ts/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: /gone\.ts/ })).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a folder that has been moved since leaves a usable window", async ({ page }) => {
  await desktop(page, {
    session: { folders: ["/gone"], workspaces: [{ folder: "/gone", files: [] }] },
    unopenable: ["/gone"],
  });

  // Not a crash and not an error wall: the window a first run would have.
  await expect(welcome(page).getByRole("button", { name: "Open Folder" })).toBeVisible();
  await expect(page.getByText("No workspace opened")).toBeVisible();
});

test("the explorer is unfolded where it was left", async ({ page }) => {
  await desktop(page, {
    session: {
      folders: ["/work"],
      workspaces: [{ folder: "/work", files: [], expanded: ["/work", "/work/src"] }],
    },
  });

  // The saved folder is open, so what is inside it is listed without being clicked.
  await expect(entry(page, "inner.ts")).toBeVisible();
});

test("a recent folder is listed and opens with one click", async ({ page }) => {
  await desktop(page, {
    session: {
      folders: ["/other", "/work"],
      workspaces: [{ folder: "/other", files: ["/other/only.ts"] }],
    },
  });

  // `/other` is the folder from last time; `/work` is offered as the one before it.
  await expect(page.getByRole("tab", { name: /only\.ts/ })).toBeVisible();
  await page.getByRole("tab", { name: "Welcome" }).click();
  await welcome(page).getByRole("button", { name: /^work/ }).click();

  await expect
    .poll(async () => (await calls(page, "open_workspace")).map((call) => call.args.path))
    .toContain("/work");
  await expect(entry(page, "a.ts")).toBeVisible();
});

test("a recent folder can be removed from the list", async ({ page }) => {
  await desktop(page, { session: { folders: ["/work", "/other"] }, unopenable: ["/work"] });

  const entry = welcome(page).getByRole("button", { name: /^other/ });
  await expect(entry).toBeVisible();
  await welcome(page).getByRole("button", { name: "Remove other from the recent list" }).click();

  await expect
    .poll(async () => (await calls(page, "forget_workspace")).map((call) => call.args.folder))
    .toContain("/other");
  await expect(entry).toHaveCount(0);
});

test("opening a file records it in the session", async ({ page }) => {
  await desktop(page, { session: { folders: ["/work"], workspaces: [{ folder: "/work" }] } });

  await entry(page, "a.ts").dblclick();
  await expect(page.getByRole("tab", { name: /a\.ts/ })).toBeVisible();

  await expect
    .poll(async () => {
      const saved = await calls(page, "save_workspace_session");
      return (saved[saved.length - 1]?.args.state as StoredWorkspace | undefined)?.files ?? [];
    })
    .toContain("/work/a.ts");
});

test("unfolding a directory records it in the session", async ({ page }) => {
  await desktop(page, { session: { folders: ["/work"], workspaces: [{ folder: "/work" }] } });

  await entry(page, "src").click();

  await expect
    .poll(async () => {
      const saved = await calls(page, "save_workspace_session");
      return (saved[saved.length - 1]?.args.state as StoredWorkspace | undefined)?.expanded ?? [];
    })
    .toContain("/work/src");
});

test("a folder opened through the dialog comes back the way it was left too", async ({ page }) => {
  // How the folder was chosen should not change what is restored.
  await desktop(page, {
    session: {
      folders: ["/work"],
      workspaces: [
        { folder: "/work", files: [] },
        { folder: "/other", files: ["/other/only.ts"], active: "/other/only.ts" },
      ],
    },
  });
  await expect(entry(page, "a.ts")).toBeVisible();

  // The dialog in this window picks /other.
  await page.getByRole("menubar").getByRole("menuitem", { name: "File", exact: true }).click();
  await page.getByRole("menuitem", { name: "Open Folder…", exact: true }).click();

  await expect(page.getByRole("tab", { name: /only\.ts/ })).toBeVisible();
});

test("a folder reopened later in the run comes back as it was, not as it was at startup", async ({
  page,
}) => {
  // The UI restored from the session it read at startup, so everything done to a folder
  // after that -- the whole reason to leave and come back -- was silently discarded.
  await desktop(page, {
    session: {
      folders: ["/work", "/other"],
      workspaces: [{ folder: "/work", files: [] }],
    },
  });
  await expect(entry(page, "a.ts")).toBeVisible();

  // Open a file in /work, leave for /other, then come back to /work.
  await entry(page, "a.ts").dblclick();
  await expect(page.getByRole("tab", { name: /a\.ts/ })).toBeVisible();
  await page.getByRole("tab", { name: "Welcome" }).click();
  await welcome(page)
    .getByRole("button", { name: /^other/ })
    .click();
  await expect(entry(page, "only.ts")).toBeVisible();

  await page.getByRole("tab", { name: "Welcome" }).click();
  await welcome(page).getByRole("button", { name: /^work/ }).click();
  await expect(page.getByRole("tab", { name: /a\.ts/ })).toBeVisible();
});

test("a folder that cannot be opened stays in the recent list", async ({ page }) => {
  // A folder can fail to open because a drive is not mounted or a VPN is down; deleting
  // someone's project from the list over that is not a trade worth making.
  await desktop(page, { session: { folders: ["/work", "/gone"] }, unopenable: ["/gone"] });
  await page.getByRole("tab", { name: "Welcome" }).click();
  await welcome(page).getByRole("button", { name: /^gone/ }).click();

  await expect(page.getByRole("alert")).toContainText("Cannot open /gone");
  await expect(welcome(page).getByRole("button", { name: /^gone/ })).toBeVisible();
  expect(await calls(page, "forget_workspace")).toEqual([]);
});

test("a folder whose tabs are still being restored is not saved as empty", async ({ page }) => {
  // The window passes through "this folder has no tabs" on the way to reopening them, and
  // saving that erased the folder's tabs on disk for the length of the restore.
  await desktop(page, {
    session: {
      folders: ["/work"],
      workspaces: [{ folder: "/work", files: ["/work/a.ts"], active: "/work/a.ts" }],
    },
    slowReads: 400,
  });

  await expect(page.getByRole("tab", { name: /a\.ts/ })).toBeVisible();
  const saved = (await calls(page, "save_workspace_session")).map(
    (call) => (call.args.state as StoredWorkspace).files,
  );
  expect(saved.every((files) => files?.length)).toBe(true);
});

test("the tab strip is one tab stop, with the arrows moving between tabs", async ({ page }) => {
  await desktop(page, {
    session: {
      folders: ["/work"],
      workspaces: [{ folder: "/work", files: ["/work/a.ts", "/work/b.ts"], active: "/work/a.ts" }],
    },
  });
  const strip = page.getByRole("tablist", { name: "Open editors" });
  await expect(strip.getByRole("tab", { name: /a\.ts/ })).toHaveAttribute("aria-selected", "true");

  // The arrows move focus along the strip, and Enter opens what they land on: selecting as
  // focus moved would hand focus straight to the opened editor, ending the walk at one press.
  // (The editor takes focus when a tab opens, so wait for the restore to settle first.)
  await expect(page.getByRole("textbox")).toContainText("the contents of a");
  await strip.getByRole("tab", { name: /a\.ts/ }).focus();
  await expect(strip.getByRole("tab", { name: /a\.ts/ })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(strip.getByRole("tab", { name: /b\.ts/ })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(strip.getByRole("tab", { name: /b\.ts/ })).toHaveAttribute("aria-selected", "true");

  await expect(page.getByRole("textbox")).toContainText("the contents of b");
  await strip.getByRole("tab", { name: /b\.ts/ }).focus();
  await page.keyboard.press("Home");
  await expect(strip.getByRole("tab", { name: "Welcome" })).toBeFocused();
});

test("the welcome page can be reopened after its tab is closed", async ({ page }) => {
  await desktop(page, { session: { folders: ["/work"], workspaces: [{ folder: "/work" }] } });
  await expect(welcome(page)).toBeVisible();

  await page.getByRole("menubar").getByRole("menuitem", { name: "Help", exact: true }).click();
  await page.getByRole("menuitem", { name: "Welcome", exact: true }).click();
  await expect(welcome(page)).toBeVisible();
  // And its tab is back, selected: a strip whose selected tab does not exist has no tab stop.
  await expect(
    page.getByRole("tablist", { name: "Open editors" }).getByRole("tab", { name: "Welcome" }),
  ).toHaveAttribute("aria-selected", "true");
});
