import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

interface RawLine {
  hash: string;
  parents?: string[];
  subject?: string;
  refs?: string;
}

interface Scenario {
  /** All commits, newest first -- sliced by `--skip`/`-n` like real `git log`. */
  commits: RawLine[];
  /** hash -> numstat records (tab-separated; the mock NUL-terminates them) for commit-detail lookups. */
  numstat?: Record<string, string[]>;
  /** hash -> unified-diff text for commitFileDiff() lookups, keyed loosely by hash only. */
  fileDiffs?: Record<string, string>;
  /** Simulates `git rev-parse --is-shallow-repository`'s report. */
  shallow?: boolean;
  /** hash -> full commit message (subject + body) for the "commitBody" lookup. */
  bodies?: Record<string, string>;
  /** The configured "origin" remote's URL, or omitted for no remote. */
  originUrl?: string;
}

async function panel(page: Page, scenario: Scenario, options: { inline?: boolean } = {}) {
  await page.addInitScript((s) => {
    const calls: { command: string; args: Record<string, unknown> }[] = [];
    const ok = (stdout: string) => ({ stdout, stderr: "", code: 0, truncated: false });
    const line = (c: RawLine) =>
      [
        c.hash,
        c.hash.slice(0, 7),
        (c.parents ?? []).join(" "),
        "Author",
        "a@x.test",
        "Jan 1",
        "1 day ago",
        c.subject ?? c.hash,
        c.refs ?? "",
      ].join("\x1f");
    Object.assign(window, {
      __calls: calls,
      __scenario: s,
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
          if (command === "read_file_content") return "contents";
          if (command === "git_open_repo") return { repoId: "/work", root: "/work" };
          if (command === "git_repo_state") return "";
          if (command === "git_exec") {
            const argv = (args.args as string[] | undefined) ?? [];
            if (argv[0] === "status") return ok("");
            if (argv[0] === "for-each-ref") return ok("");
            if (argv[0] === "remote" && argv[1] === "get-url") return ok(s.originUrl ?? "");
            if (argv[0] === "remote") return ok(s.originUrl ? "origin\n" : "");
            if (argv[0] === "log" && argv.includes("-n") && argv[1] === "-n" && argv[2] === "1") {
              // commitBody(): `log -n 1 --pretty=format:%B <hash>`
              const hash = argv[argv.length - 1];
              return ok(s.bodies?.[hash] ?? "");
            }
            if (argv[0] === "rev-parse" && argv.includes("--is-shallow-repository"))
              return ok(s.shallow ? "true" : "false");
            if (argv[0] === "log" && argv.includes("--topo-order")) {
              const skipIndex = argv.indexOf("--skip");
              const nIndex = argv.indexOf("-n");
              const skip = skipIndex === -1 ? 0 : Number(argv[skipIndex + 1]);
              const limit = nIndex === -1 ? s.commits.length : Number(argv[nIndex + 1]);
              return ok(
                s.commits
                  .slice(skip, skip + limit)
                  .map(line)
                  .join("\n"),
              );
            }
            if (argv[0] === "show" && argv.includes("--numstat")) {
              const hash = argv[argv.length - 1];
              const lines = s.numstat?.[hash] ?? [];
              // `git show --numstat -z`: a header line, then NUL-terminated records.
              return ok(`${hash}\x1fSubject for ${hash}\n${lines.map((l) => l + "\0").join("")}`);
            }
            if (argv[0] === "show" && argv.includes("-M")) {
              // commitFileDiff()'s exact call shape: show --no-ext-diff --no-textconv
              // --no-color -M --pretty=format: <hash> -- <path>
              const dashDash = argv.indexOf("--");
              const hash = argv[dashDash - 1];
              return ok(s.fileDiffs?.[hash] ?? "");
            }
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
  if (options.inline) return region;
  await region.getByText("Open in full view").click();
  const graph = page.getByRole("grid", { name: "Commit history" });
  await expect(graph).toBeVisible();
  return graph;
}

const logCallCount = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          __calls: { command: string; args: { args?: string[] } }[];
        }
      ).__calls.filter((c) => c.command === "git_exec" && c.args.args?.[0] === "log").length,
  );

test("opening the graph shows commit subjects and their authors", async ({ page }) => {
  const graph = await panel(page, {
    commits: [
      { hash: "c3", parents: ["c2"], subject: "Third commit" },
      { hash: "c2", parents: ["c1"], subject: "Second commit" },
      { hash: "c1", parents: [], subject: "First commit" },
    ],
  });
  await expect(graph.getByText("Third commit")).toBeVisible();
  await expect(graph.getByText("Second commit")).toBeVisible();
  await expect(graph.getByText("First commit")).toBeVisible();
  await expect(graph.getByText("Load older commits")).toHaveCount(0);
});

test("a branch/tag decoration is shown as a badge next to its commit", async ({ page }) => {
  const graph = await panel(page, {
    commits: [{ hash: "c1", subject: "Tagged", refs: "HEAD -> main, tag: v1.0" }],
  });
  await expect(graph.getByText("main", { exact: true })).toBeVisible();
  await expect(graph.getByText("v1.0", { exact: true })).toBeVisible();
});

test("selecting a commit shows its file changes", async ({ page }) => {
  const graph = await panel(page, {
    commits: [{ hash: "c1", subject: "Add a file" }],
    numstat: { c1: ["5\t2\tsrc/a.ts", "-\t-\timage.png"] },
  });
  await graph.getByText("Add a file").click();
  const detail = page.getByRole("complementary").filter({ hasText: "Commit" });
  const fileRow = detail.getByRole("listitem").filter({ hasText: "src/a.ts" });
  await expect(fileRow).toBeVisible();
  await expect(detail.getByText("image.png")).toBeVisible();
  await expect(fileRow.getByText("+5")).toBeVisible();
});

test("clicking a changed file opens its diff and closes the graph view", async ({ page }) => {
  const diffText = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index abc..def 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +1,2 @@",
    " one",
    "-two",
    "+TWO",
  ].join("\n");
  const graph = await panel(page, {
    commits: [{ hash: "c1", subject: "Add a file" }],
    numstat: { c1: ["5\t2\tsrc/a.ts"] },
    fileDiffs: { c1: diffText },
  });
  await graph.getByText("Add a file").click();
  const detail = page.getByRole("complementary").filter({ hasText: "Commit" });
  await detail.getByText("src/a.ts").click();

  const diffView = page.locator("section[aria-label='Git diff editor']");
  await expect(diffView).toBeVisible();
  await expect(diffView.getByText("TWO", { exact: true })).toBeVisible();
  await expect(graph).toHaveCount(0);
});

test("a repository with more history than one page offers to load older commits", async ({
  page,
}) => {
  const commits: RawLine[] = Array.from({ length: 305 }, (_, i) => ({
    hash: `c${305 - i}`,
    parents: i < 304 ? [`c${304 - i}`] : [],
    subject: `Commit ${305 - i}`,
  }));
  const graph = await panel(page, { commits });
  await expect(graph.getByText("Load older commits")).toBeVisible();

  const before = await logCallCount(page);
  await graph.getByText("Load older commits").click();
  await expect.poll(() => logCallCount(page)).toBeGreaterThan(before);
  await expect(graph.getByText("Load older commits")).toHaveCount(0);
});

test("a shallow clone's exhausted history says so instead of looking complete", async ({
  page,
}) => {
  const graph = await panel(page, {
    commits: [{ hash: "c1", subject: "Only commit this clone has" }],
    shallow: true,
  });
  await expect(graph.getByText(/History may be incomplete/)).toBeVisible();
  await expect(graph.getByText("Load older commits")).toHaveCount(0);
});

test("the sidebar's own graph says a shallow clone's history may be incomplete", async ({
  page,
}) => {
  const region = await panel(
    page,
    { commits: [{ hash: "c1", subject: "Only commit this clone has" }], shallow: true },
    { inline: true },
  );
  await expect(region.getByText(/History may be incomplete/)).toBeVisible();
});

test("the sidebar's graph shows no incomplete-history notice for a full clone", async ({
  page,
}) => {
  const region = await panel(
    page,
    { commits: [{ hash: "c1", subject: "Only commit" }], shallow: false },
    { inline: true },
  );
  await expect(region.getByText("Only commit")).toBeVisible();
  await expect(region.getByText(/History may be incomplete/)).toHaveCount(0);
});

test("a normal (non-shallow) repository's exhausted history shows no incomplete-history notice", async ({
  page,
}) => {
  const graph = await panel(page, {
    commits: [{ hash: "c1", subject: "Only commit" }],
    shallow: false,
  });
  await expect(graph.getByText(/History may be incomplete/)).toHaveCount(0);
});

test("closing the graph returns to the editor", async ({ page }) => {
  const graph = await panel(page, { commits: [{ hash: "c1", subject: "Only commit" }] });
  await page.getByTitle("Close graph").click();
  await expect(graph).toHaveCount(0);
});

test("a graph reset that removes the selected commit clears its detail panel", async ({ page }) => {
  const graph = await panel(page, {
    commits: [
      { hash: "c2", parents: ["c1"], subject: "Second commit" },
      { hash: "c1", parents: [], subject: "First commit" },
    ],
  });
  await graph.getByText("Second commit").click();
  const detail = page
    .getByRole("complementary")
    .filter({ has: page.getByTitle("Close commit details") });
  await expect(detail).toBeVisible();

  // Simulate a same-repository history rewrite (an amend, a rebase, or an
  // external rewrite the .git watcher picked up): the previously-selected
  // commit no longer exists once the graph reloads.
  await page.evaluate(() => {
    (window as unknown as { __scenario: { commits: unknown[] } }).__scenario.commits = [
      { hash: "c3", parents: [], subject: "Rewritten commit" },
    ];
  });
  await page.getByTitle("Refresh Graph").click();

  await expect(graph.getByText("Rewritten commit")).toBeVisible();
  await expect(graph.getByText("Second commit")).toHaveCount(0);
  await expect(detail).toHaveCount(0);
});
test("the commit detail shows the message body beyond the subject, and the commit's absolute date", async ({
  page,
}) => {
  const graph = await panel(page, {
    commits: [{ hash: "c1", subject: "Fix the thing" }],
    bodies: { c1: "Fix the thing\n\nA longer explanation of why." },
  });
  await graph.getByText("Fix the thing").click();
  const detail = page.getByRole("complementary").filter({ hasText: "Commit" });
  await expect(detail.getByText("A longer explanation of why.")).toBeVisible();
  await expect(detail.getByText("Jan 1")).toBeVisible();
});

test("copying the hash shows a confirmation, and the button copies the FULL hash, not the short one", async ({
  page,
}) => {
  const graph = await panel(page, {
    commits: [{ hash: "c1-full-hash", subject: "Add a file" }],
  });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await graph.getByText("Add a file").click();
  const detail = page.getByRole("complementary").filter({ hasText: "Commit" });
  await detail.getByRole("button", { name: "Copy commit hash" }).click();
  await expect(detail.getByText("Copied")).toBeVisible();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toBe("c1-full-hash");
});

test("with a recognized remote configured, the detail offers to open the commit on it", async ({
  page,
}) => {
  const graph = await panel(page, {
    commits: [{ hash: "c1", subject: "Add a file" }],
    originUrl: "https://github.com/owner/repo.git",
  });
  await graph.getByText("Add a file").click();
  const detail = page.getByRole("complementary").filter({ hasText: "Commit" });
  await expect(detail.getByRole("button", { name: /Open on GitHub/ })).toBeVisible();
});

test("with no remote configured, the detail offers no open-on-remote link", async ({ page }) => {
  const graph = await panel(page, { commits: [{ hash: "c1", subject: "Add a file" }] });
  await graph.getByText("Add a file").click();
  const detail = page.getByRole("complementary").filter({ hasText: "Commit" });
  await expect(detail.getByRole("button", { name: /Open on/ })).toHaveCount(0);
});

test("the commit detail's file list can be viewed as a tree", async ({ page }) => {
  const graph = await panel(page, {
    commits: [{ hash: "c1", subject: "Refactor" }],
    numstat: { c1: ["1\t0\tsrc/a.ts", "1\t0\tsrc/b.ts", "1\t0\tREADME.md"] },
  });
  await graph.getByText("Refactor").click();
  const detail = page.getByRole("complementary").filter({ hasText: "Commit" });
  await expect(detail.getByText("src/a.ts")).toBeVisible();

  await detail.getByRole("button", { name: "Tree" }).click();
  // Folders start expanded, like a freshly opened Explorer tree.
  await expect(detail.getByText("src/a.ts")).toHaveCount(0);
  await expect(detail.getByRole("button", { name: "Collapse src" })).toBeVisible();
  await expect(detail.getByText("a.ts")).toBeVisible();
  await expect(detail.getByText("b.ts")).toBeVisible();
  await expect(detail.getByText("README.md")).toBeVisible();

  await detail.getByRole("button", { name: "Collapse src" }).click();
  await expect(detail.getByText("a.ts")).toHaveCount(0);
  await expect(detail.getByRole("button", { name: "Expand src" })).toBeVisible();

  await detail.getByRole("button", { name: "List" }).click();
  await expect(detail.getByText("src/a.ts")).toBeVisible();
});
