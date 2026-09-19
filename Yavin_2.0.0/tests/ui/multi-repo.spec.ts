import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

interface RepoScenario {
  status: string;
  branchInfo: string;
  branches: string;
  remotes: string;
  /** `rev-parse --git-common-dir` response, for grouping worktrees of one repository. */
  commonDir?: string;
  /** `worktree list --porcelain` response. */
  worktreeList?: string;
}

interface Scenario {
  workspace: string;
  repos: Record<string, Partial<RepoScenario>>;
  /** Path `pick_folder_dialog` returns the next time it is invoked. */
  pick?: string;
  /** Pre-seeds `localStorage["yavin.git.repos"]` before the app loads, for testing restore/migration. */
  seedStorage?: unknown;
}

function repo(branchName: string, status = ""): RepoScenario {
  return {
    status,
    branchInfo: `# branch.head ${branchName}\n`,
    branches: `${branchName}\n`,
    remotes: "",
  };
}

async function panel(page: Page, scenario: Scenario) {
  await page.addInitScript((s) => {
    if (s.seedStorage !== undefined)
      localStorage.setItem("yavin.git.repos", JSON.stringify(s.seedStorage));
    const calls: { command: string; args: Record<string, unknown> }[] = [];
    const ok = (stdout: string) => ({ stdout, stderr: "", code: 0, truncated: false });
    Object.assign(window, {
      __calls: calls,
      __pick: s.pick ?? null,
      isTauri: true,
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        transformCallback: () => 1,
        unregisterCallback: () => {},
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          calls.push({ command, args });
          if (command === "get_default_workspace") return s.workspace;
          if (command === "list_workspace_files")
            return {
              path: args.path as string,
              name: "work",
              is_dir: true,
              children: [],
            };
          if (command === "read_file_content") return "contents";
          if (command === "pick_folder_dialog") {
            const next = (window as unknown as { __pick: string | null }).__pick;
            (window as unknown as { __pick: string | null }).__pick = null;
            return next;
          }
          if (command === "open_folder_dialog")
            return (window as unknown as { __openFolder?: string }).__openFolder ?? null;
          if (command === "git_open_repo") {
            const path = args.path as string;
            const found = s.repos[path];
            if (!found) throw "This folder is not a Git repository.";
            return { repoId: path, root: path };
          }
          if (command === "git_repo_state") return "";
          if (command === "git_exec") {
            const repoId = args.repoId as string;
            const found = s.repos[repoId] ?? {};
            const argv = (args.args as string[] | undefined) ?? [];
            if (argv[0] === "status")
              return ok(
                argv.includes("--porcelain=v2") ? (found.branchInfo ?? "") : (found.status ?? ""),
              );
            if (argv[0] === "for-each-ref") return ok(found.branches ?? "");
            if (argv[0] === "remote") return ok(found.remotes ?? "");
            if (argv[0] === "rev-parse" && argv.includes("--git-common-dir"))
              return ok(found.commonDir ?? "");
            if (argv[0] === "worktree" && argv[1] === "list") return ok(found.worktreeList ?? "");
            return ok("");
          }
          return null;
        },
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
    });
  }, scenario);
  await page.goto("/");
  await page.getByTitle("Source Control (Ctrl+Shift+G)").click();
  const region = page.getByRole("complementary", { name: "Source control" });
  await expect(region).toBeVisible();
  return region;
}

test("the workspace repository is tracked and shown without adding anything", async ({ page }) => {
  const region = await panel(page, {
    workspace: "/work",
    repos: { "/work": repo("main", " M a.ts\0") },
  });
  await expect(region.getByText("main")).toBeVisible();
  // The Repositories section always lists tracked repos, even just the one.
  await expect(region.getByRole("group", { name: "work" })).toBeVisible();
});

test("adding a repository folder tracks it, switches to it, and shows both in the switcher", async ({
  page,
}) => {
  const region = await panel(page, {
    workspace: "/work",
    repos: {
      "/work": repo("main", " M a.ts\0"),
      "/other": repo("feature", " M b.ts\0 M c.ts\0"),
    },
    pick: "/other",
  });

  await region.getByTitle("Add Repository Folder").click();

  const workRow = region.getByRole("group", { name: "work" });
  const otherRow = region.getByRole("group", { name: "other" });
  await expect(workRow).toBeVisible();
  await expect(otherRow).toBeVisible();

  // Adding a repository makes it the active one.
  await expect(region.getByLabel("Commit message")).toBeVisible();
  await expect(region.getByText("feature").first()).toBeVisible();

  // Switching back to the workspace repo shows its own branch again.
  await workRow.getByRole("button").first().click();
  await expect(region.getByRole("group", { name: "work" })).toContainText("main");
});

test("a repository that fails to open surfaces the error instead of silently doing nothing", async ({
  page,
}) => {
  const region = await panel(page, {
    workspace: "/work",
    repos: { "/work": repo("main") },
    pick: "/not-a-repo",
  });
  await region.getByTitle("Add Repository Folder").click();
  await expect(region.getByText(/not a Git repository/)).toBeVisible();
});

test("removing a repository from the switcher stops tracking it", async ({ page }) => {
  const region = await panel(page, {
    workspace: "/work",
    repos: {
      "/work": repo("main"),
      "/other": repo("feature"),
    },
    pick: "/other",
  });
  await region.getByTitle("Add Repository Folder").click();
  await expect(region.getByRole("group", { name: "other" })).toBeVisible();

  await region
    .getByRole("group", { name: "other" })
    .getByRole("button", { name: /Remove other/ })
    .click();
  await expect(region.getByRole("group", { name: "other" })).toHaveCount(0);
});

test("opening a different workspace folder does not steal the active repository", async ({
  page,
}) => {
  const region = await panel(page, {
    workspace: "/work",
    repos: {
      "/work": repo("main", " M a.ts\0"),
      "/other": repo("feature", " M b.ts\0"),
    },
  });
  // Nothing had been selected yet, so the workspace's own repository became active
  // on load.
  await expect(region.getByRole("group", { name: "work" })).toContainText("main");

  await page.evaluate(() => {
    (window as unknown as { __openFolder?: string }).__openFolder = "/other";
  });
  await page.getByRole("menubar").getByRole("menuitem", { name: "File", exact: true }).click();
  await page
    .getByRole("menu", { name: "File", exact: true })
    .getByRole("menuitem", { name: "Open Folder…", exact: true })
    .click();

  // The new workspace's repository is registered and shown in the switcher...
  await expect(region.getByRole("group", { name: "other" })).toBeVisible();
  // ...but the previously active repository is left alone: its own row still shows
  // its branch, and the active repo's branch drawer still lists only its branch,
  // not the newly-opened repository's.
  await expect(region.getByRole("group", { name: "work" })).toContainText("main");
  await region.getByTitle("Branches and remotes").click();
  const branchSelect = region.getByLabel("Switch branch");
  await expect(branchSelect.getByRole("option", { name: "main" })).toHaveCount(1);
  await expect(branchSelect.getByRole("option", { name: "feature" })).toHaveCount(0);
});

test("a pre-worktree persisted repository list is restored and migrated on read", async ({
  page,
}) => {
  const region = await panel(page, {
    workspace: "/work",
    repos: {
      "/work": repo("main"),
      "/other": repo("feature"),
    },
    // The schema this test seeds predates GitRegistry knowing about worktrees: a
    // plain array of repository root paths (see persistence.ts's migration).
    seedStorage: ["/work", "/other"],
  });

  // Both persisted repositories are restored -- /other was never opened through the
  // workspace or "Add Repository Folder" in this session, only found in storage.
  await expect(region.getByRole("group", { name: "work" })).toBeVisible();
  await expect(region.getByRole("group", { name: "other" })).toBeVisible();

  // Restoring rewrote the persisted value under the versioned schema.
  const persisted = await page.evaluate(() => localStorage.getItem("yavin.git.repos"));
  const parsed = JSON.parse(persisted ?? "null");
  expect(parsed.schemaVersion).toBe(1);
  expect(parsed.repositories).toHaveLength(2);
  expect(parsed.repositories.map((r: { worktrees: string[] }) => r.worktrees)).toEqual([
    ["/work"],
    ["/other"],
  ]);
});

test("a known-but-unopened worktree of the active repository can be opened from the switcher", async ({
  page,
}) => {
  const worktreeList = [
    "worktree /work",
    "HEAD abc123",
    "branch refs/heads/main",
    "",
    "worktree /work-feature",
    "HEAD abc123",
    "branch refs/heads/feature",
    "",
  ].join("\n");
  const region = await panel(page, {
    workspace: "/work",
    repos: {
      "/work": { ...repo("main"), commonDir: "/work/.git", worktreeList },
      "/work-feature": { ...repo("feature"), commonDir: "/work/.git" },
    },
  });

  const workRow = region.getByRole("group", { name: "work" });
  await expect(workRow).toBeVisible();
  // Only /work has been opened; /work-feature is known (from worktree list) but not
  // tracked yet, so it shows as a collapsed "more worktrees" affordance, not its own row.
  await expect(region.getByRole("group", { name: "work-feature" })).toHaveCount(0);

  await region.getByText("1 more worktree").click();
  await region.getByRole("button", { name: "Open worktree /work-feature" }).click();

  // Opening it tracks it as its own row, grouped under the same repository (not
  // duplicated as an unrelated one), and it becomes the active worktree.
  await expect(region.getByRole("group", { name: "work-feature" })).toBeVisible();
  await expect(region.getByLabel("Commit message")).toBeVisible();
  await region.getByTitle("Branches and remotes").click();
  await expect(
    region.getByLabel("Switch branch").getByRole("option", { name: "feature" }),
  ).toHaveCount(1);
});

test("the activity bar badge aggregates changes across every open repository", async ({ page }) => {
  await panel(page, {
    workspace: "/work",
    repos: {
      "/work": repo("main", " M a.ts\0"),
      "/other": repo("feature", " M b.ts\0 M c.ts\0"),
    },
    pick: "/other",
  });
  const gitTab = page.getByTitle("Source Control (Ctrl+Shift+G)");
  await expect(gitTab).toContainText("1");

  await page
    .getByRole("complementary", { name: "Source control" })
    .getByTitle("Add Repository Folder")
    .click();
  await expect(gitTab).toContainText("3");
});

test("fetching in one worktree refreshes the shared branch list in a sibling worktree of the same repository", async ({
  page,
}) => {
  const worktreeList = [
    "worktree /work",
    "HEAD abc123",
    "branch refs/heads/main",
    "",
    "worktree /work-feature",
    "HEAD abc123",
    "branch refs/heads/feature",
    "",
  ].join("\n");
  const region = await panel(page, {
    workspace: "/work",
    repos: {
      "/work": { ...repo("main"), commonDir: "/work/.git", worktreeList },
      "/work-feature": { ...repo("feature"), commonDir: "/work/.git" },
    },
  });

  // Open the sibling worktree too -- opening it via the switcher makes it active,
  // so the fetch below runs against /work-feature while /work sits in the
  // background, unopened-tab-wise but still tracked (this is the sibling case
  // the Git State & Synchronization plan's Section E/L targets).
  await region.getByText("1 more worktree").click();
  await region.getByRole("button", { name: "Open worktree /work-feature" }).click();
  await expect(region.getByLabel("Commit message")).toBeVisible();

  // "branchInfo" (status --porcelain=v2 --branch) is what carries ahead/behind --
  // the field a fetch's remote-tracking-ref update actually affects (fetch never
  // writes refs/heads/, so the separate local-branch-NAME-list call, for-each-ref,
  // is correctly NOT expected to increase here).
  const branchInfoCallsFor = (repoId: string) =>
    page.evaluate(
      (id) =>
        (
          window as unknown as {
            __calls: { command: string; args: { repoId?: string; args?: string[] } }[];
          }
        ).__calls.filter(
          (c) =>
            c.command === "git_exec" &&
            c.args.repoId === id &&
            c.args.args?.[0] === "status" &&
            c.args.args?.includes("--porcelain=v2"),
        ).length,
      repoId,
    );
  const before = await branchInfoCallsFor("/work");

  await region.getByTitle("Branches and remotes").click();
  await region.getByRole("button", { name: "Fetch" }).click();

  // /work-feature (the worktree that actually fetched) refreshing its own branch
  // field is Module 2's existing, unchanged behavior -- the new assertion is that
  // /work (a sibling of the same repository, never touched directly) also
  // re-fetches its branch info, because remote-tracking refs are repository-shared
  // and `sync.ts`'s SIBLING_INVALIDATES maps "fetch" to ["branch"] for siblings.
  await expect.poll(() => branchInfoCallsFor("/work")).toBeGreaterThan(before);
});

test("switching rapidly back and forth between two just-refreshed worktrees does not re-issue a full refresh for either", async ({
  page,
}) => {
  const worktreeList = [
    "worktree /work",
    "HEAD abc123",
    "branch refs/heads/main",
    "",
    "worktree /work-feature",
    "HEAD abc123",
    "branch refs/heads/feature",
    "",
  ].join("\n");
  const region = await panel(page, {
    workspace: "/work",
    repos: {
      "/work": { ...repo("main"), commonDir: "/work/.git", worktreeList },
      "/work-feature": { ...repo("feature"), commonDir: "/work/.git" },
    },
  });

  const statusCallsFor = (repoId: string) =>
    page.evaluate(
      (id) =>
        (
          window as unknown as {
            __calls: { command: string; args: { repoId?: string; args?: string[] } }[];
          }
        ).__calls.filter(
          (c) => c.command === "git_exec" && c.args.repoId === id && c.args.args?.[0] === "status",
        ).length,
      repoId,
    );

  // /work is active and refreshed on open; open /work-feature too (becomes active).
  await region.getByText("1 more worktree").click();
  await region.getByRole("button", { name: "Open worktree /work-feature" }).click();
  await expect(region.getByLabel("Commit message")).toBeVisible();

  const workBefore = await statusCallsFor("/work");
  const featureBefore = await statusCallsFor("/work-feature");

  // Both worktrees were refreshed moments ago (well under the 5s freshness
  // window) -- switching back and forth should show their already-fresh cached
  // state immediately, not issue a redundant full refresh for either. Clicking
  // the row itself (not its Sync button, which stops propagation) fires the
  // row's onSelect -> gitRegistry.setActive.
  await region.getByRole("group", { name: "work", exact: true }).click({ position: { x: 5, y: 5 } });
  await region.getByTitle("Branches and remotes").click();
  await expect(region.getByLabel("Switch branch")).toHaveValue("main"); // confirms the switch actually landed
  await region.getByRole("group", { name: "work-feature" }).click({ position: { x: 5, y: 5 } });
  await expect(region.getByLabel("Switch branch")).toHaveValue("feature");

  const workAfter = await statusCallsFor("/work");
  const featureAfter = await statusCallsFor("/work-feature");
  expect(workAfter).toBe(workBefore);
  expect(featureAfter).toBe(featureBefore);
});
