import { test, expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

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

/**
 * The commit graph in the Source Control sidebar -- the only graph there is: the full-page
 * graph view was removed, and what it offered that is still offered lives here or in the
 * commit hover card.
 */
async function graph(page: Page, scenario: Scenario) {
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
  const section = region.locator("section[aria-label='Graph']");
  await expect(section).toBeVisible();
  return section;
}

const row = (section: Locator, subject: string) =>
  section.getByRole("button").filter({ hasText: subject }).first();

/**
 * Expands a commit's details under its row. Clicking a row also rests the pointer and the
 * focus on it, which opens the hover card with buttons of the same names, so the card is
 * dismissed first: what is left is the expanded detail.
 */
async function expand(page: Page, section: Locator, subject: string) {
  await row(section, subject).click();
  await expect(section.getByRole("button", { name: "Close commit details" })).toBeVisible();
  await page.mouse.move(0, 0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: /^Commit / })).toHaveCount(0);
  await expect(section.getByText(/\d+ files? changed/)).toBeVisible();
}

test("the graph shows each commit's subject", async ({ page }) => {
  const section = await graph(page, {
    commits: [
      { hash: "c3", parents: ["c2"], subject: "Third commit" },
      { hash: "c2", parents: ["c1"], subject: "Second commit" },
      { hash: "c1", parents: [], subject: "First commit" },
    ],
  });
  await expect(row(section, "Third commit")).toBeVisible();
  await expect(row(section, "Second commit")).toBeVisible();
  await expect(row(section, "First commit")).toBeVisible();
  await expect(section.getByText("Show more commits")).toHaveCount(0);
});

test("a branch is a badge on its commit's row, and its tags are in the commit's card", async ({
  page,
}) => {
  const section = await graph(page, {
    commits: [{ hash: "c1", subject: "Tagged", refs: "HEAD -> main, tag: v1.0" }],
  });
  await expect(row(section, "Tagged").getByText("main", { exact: true })).toBeVisible();
  await row(section, "Tagged").hover();
  const card = page.getByRole("dialog", { name: /^Commit / });
  await expect(card.getByText("v1.0", { exact: true })).toBeVisible();
});

test("expanding a commit shows its changed files and their totals", async ({ page }) => {
  const section = await graph(page, {
    commits: [{ hash: "c1", subject: "Add a file" }],
    numstat: { c1: ["5\t2\tsrc/a.ts", "-\t-\timage.png"] },
  });
  await expand(page, section, "Add a file");
  await expect(section.getByRole("button", { name: /src\/a\.ts/ })).toBeVisible();
  await expect(section.getByRole("button", { name: /image\.png/ })).toBeVisible();
  await expect(section.getByText("2 files changed")).toBeVisible();
  await expect(section.getByText("+5", { exact: true })).toBeVisible();
});

test("clicking a commit's changed file opens its diff", async ({ page }) => {
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
  const section = await graph(page, {
    commits: [{ hash: "c1", subject: "Add a file" }],
    numstat: { c1: ["5\t2\tsrc/a.ts"] },
    fileDiffs: { c1: diffText },
  });
  await expand(page, section, "Add a file");
  await section.getByRole("button", { name: /src\/a\.ts/ }).click();

  const diffView = page.locator("section[aria-label='Git diff editor']");
  await expect(diffView).toBeVisible();
  await expect(diffView.getByText("TWO", { exact: true })).toBeVisible();
});

test("the graph says a shallow clone's history may be incomplete", async ({ page }) => {
  const section = await graph(page, {
    commits: [{ hash: "c1", subject: "Only commit this clone has" }],
    shallow: true,
  });
  await expect(section.getByText(/History may be incomplete/)).toBeVisible();
});

test("the graph shows no incomplete-history notice for a full clone", async ({ page }) => {
  const section = await graph(page, {
    commits: [{ hash: "c1", subject: "Only commit" }],
    shallow: false,
  });
  await expect(row(section, "Only commit")).toBeVisible();
  await expect(section.getByText(/History may be incomplete/)).toHaveCount(0);
});

test("a graph reset that removes the expanded commit closes its details", async ({ page }) => {
  const section = await graph(page, {
    commits: [
      { hash: "c2", parents: ["c1"], subject: "Second commit" },
      { hash: "c1", parents: [], subject: "First commit" },
    ],
  });
  await expand(page, section, "Second commit");

  // Simulate a same-repository history rewrite (an amend, a rebase, or an
  // external rewrite the .git watcher picked up): the previously-expanded
  // commit no longer exists once the graph reloads.
  await page.evaluate(() => {
    (window as unknown as { __scenario: { commits: unknown[] } }).__scenario.commits = [
      { hash: "c3", parents: [], subject: "Rewritten commit" },
    ];
  });
  await section.getByTitle("Refresh Graph").click();

  await expect(row(section, "Rewritten commit")).toBeVisible();
  await expect(section.getByText("Second commit")).toHaveCount(0);
  await expect(section.getByRole("button", { name: "Close commit details" })).toHaveCount(0);
});

test("a commit's card shows the message body beyond the subject, and the commit's absolute date", async ({
  page,
}) => {
  const section = await graph(page, {
    commits: [{ hash: "c1", subject: "Fix the thing" }],
    bodies: { c1: "Fix the thing\n\nA longer explanation of why." },
  });
  await row(section, "Fix the thing").hover();
  const card = page.getByRole("dialog", { name: /^Commit / });
  await expect(card.getByText("A longer explanation of why.")).toBeVisible();
  await expect(card).toContainText("Jan 1");
});

test("copying the hash shows a confirmation, and the button copies the FULL hash, not the short one", async ({
  page,
}) => {
  const section = await graph(page, {
    commits: [{ hash: "c1-full-hash", subject: "Add a file" }],
  });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await expand(page, section, "Add a file");
  await section.getByRole("button", { name: "Copy commit hash" }).click();
  await expect(section.getByText("Copied")).toBeVisible();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toBe("c1-full-hash");
});

test("with a recognized remote configured, the details offer to open the commit on it", async ({
  page,
}) => {
  const section = await graph(page, {
    commits: [{ hash: "c1", subject: "Add a file" }],
    originUrl: "https://github.com/owner/repo.git",
  });
  await expand(page, section, "Add a file");
  await expect(section.getByRole("button", { name: /Open on GitHub/ })).toBeVisible();
});

test("with no remote configured, the details offer no open-on-remote link", async ({ page }) => {
  const section = await graph(page, { commits: [{ hash: "c1", subject: "Add a file" }] });
  await expand(page, section, "Add a file");
  await expect(section.getByRole("button", { name: /Open on/ })).toHaveCount(0);
});

test("a commit's changed files can be viewed as a tree", async ({ page }) => {
  const section = await graph(page, {
    commits: [{ hash: "c1", subject: "Refactor" }],
    numstat: { c1: ["1\t0\tsrc/a.ts", "1\t0\tsrc/b.ts", "1\t0\tREADME.md"] },
  });
  await expand(page, section, "Refactor");
  await expect(section.getByRole("button", { name: /src\/a\.ts/ })).toBeVisible();

  await section.getByRole("button", { name: "View as Tree" }).click();
  // Folders start expanded, like a freshly opened Explorer tree.
  await expect(section.getByRole("button", { name: /src\/a\.ts/ })).toHaveCount(0);
  await expect(section.getByRole("button", { name: "Collapse src" })).toBeVisible();
  await expect(section.getByRole("button", { name: /a\.ts/ })).toBeVisible();
  await expect(section.getByRole("button", { name: /b\.ts/ })).toBeVisible();
  await expect(section.getByRole("button", { name: /README\.md/ })).toBeVisible();

  await section.getByRole("button", { name: "Collapse src" }).click();
  await expect(section.getByRole("button", { name: /a\.ts/ })).toHaveCount(0);
  await expect(section.getByRole("button", { name: "Expand src" })).toBeVisible();

  await section.getByRole("button", { name: "View as List" }).click();
  await expect(section.getByRole("button", { name: /src\/a\.ts/ })).toBeVisible();
});

const history = (count: number): RawLine[] =>
  Array.from({ length: count }, (_, i) => ({
    hash: `c${count - i}`,
    parents: i < count - 1 ? [`c${count - i - 1}`] : [],
    subject: `Commit ${count - i}`,
  }));

const logCallCount = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          __calls: { command: string; args: { args?: string[] } }[];
        }
      ).__calls.filter((c) => c.command === "git_exec" && c.args.args?.[0] === "log").length,
  );

test("Show more commits draws thirty more each time, until there are no more", async ({ page }) => {
  const section = await graph(page, { commits: history(75) });
  await expect(row(section, "Commit 46")).toBeVisible();
  await expect(section.getByText("Commit 45", { exact: true })).toHaveCount(0);

  const more = section.getByRole("button", { name: "Show more commits" });
  await more.click();
  await expect(row(section, "Commit 16")).toBeVisible();
  await expect(section.getByText("Commit 15", { exact: true })).toHaveCount(0);

  await more.click();
  await expect(row(section, "Commit 1")).toBeVisible();
  await expect(more).toHaveCount(0);
});

test("Show more commits fetches older history once the drawn rows reach its end", async ({
  page,
}) => {
  test.setTimeout(60_000);
  // More than one page of `git log` (300 commits): the last rows need a second fetch.
  const section = await graph(page, { commits: history(305) });
  const more = section.getByRole("button", { name: "Show more commits" });
  const before = await logCallCount(page);
  // 30 rows, then 60, ... 300 are all from the first fetch.
  for (let i = 0; i < 9; i++) await more.click();
  await expect(row(section, "Commit 6")).toBeVisible();
  expect(await logCallCount(page)).toBe(before);

  await more.click();
  await expect.poll(() => logCallCount(page)).toBeGreaterThan(before);
  await expect(row(section, "Commit 1")).toBeVisible();
  await expect(more).toHaveCount(0);
});

const A = "a".repeat(40);
const B = "b".repeat(40);

const gitArgs = (page: Page, first: string) =>
  page.evaluate(
    (name) =>
      (window as unknown as { __calls: { command: string; args: { args?: string[] } }[] }).__calls
        .filter((call) => call.command === "git_exec" && call.args.args?.[0] === name)
        .map((call) => call.args.args!),
    first,
  );

async function commitMenu(page: Page, section: Locator, subject: string) {
  await row(section, subject).click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Commit actions" });
  await expect(menu).toBeVisible();
  return menu;
}

test("a commit's menu reverts it, after asking", async ({ page }) => {
  const section = await graph(page, {
    commits: [
      { hash: B, parents: [A], subject: "Newer", refs: "HEAD -> main" },
      { hash: A, subject: "Older" },
    ],
  });
  const menu = await commitMenu(page, section, "Older");
  await menu.getByRole("menuitem", { name: "Revert Commit…" }).click();
  const dialog = page.getByRole("dialog", { name: "Revert commit" });
  await expect(dialog).toContainText('undoing "Older"');
  expect(await gitArgs(page, "revert")).toEqual([]);

  await dialog.getByRole("button", { name: "Revert" }).click();
  await expect.poll(() => gitArgs(page, "revert")).toEqual([["revert", A]]);
});

test("a commit's menu cherry-picks it, after asking", async ({ page }) => {
  const section = await graph(page, { commits: [{ hash: A, subject: "Elsewhere" }] });
  const menu = await commitMenu(page, section, "Elsewhere");
  await menu.getByRole("menuitem", { name: "Cherry-pick Commit…" }).click();
  const dialog = page.getByRole("dialog", { name: "Cherry-pick commit" });
  await dialog.getByRole("button", { name: "Cherry-pick" }).click();
  await expect.poll(() => gitArgs(page, "cherry-pick")).toEqual([["cherry-pick", A]]);
});

test("Undo Last Commit is in the checked-out commit's menu only", async ({ page }) => {
  const section = await graph(page, {
    commits: [
      { hash: B, parents: [A], subject: "Newer", refs: "HEAD -> main" },
      { hash: A, subject: "Older" },
    ],
  });
  let menu = await commitMenu(page, section, "Older");
  await expect(menu.getByRole("menuitem", { name: "Undo Last Commit" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  menu = await commitMenu(page, section, "Newer");
  await menu.getByRole("menuitem", { name: "Undo Last Commit" }).click();
  await expect.poll(() => gitArgs(page, "reset")).toEqual([["reset", "--soft", "HEAD~1"]]);
});

test("a commit's menu copies its full hash, opens it, and links to its remote page", async ({
  page,
}) => {
  const section = await graph(page, {
    commits: [{ hash: A, subject: "Add a file" }],
    numstat: { [A]: ["1\t0\tsrc/a.ts"] },
    originUrl: "https://github.com/owner/repo.git",
  });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  let menu = await commitMenu(page, section, "Add a file");
  await expect(menu.getByRole("menuitem", { name: "Open on GitHub" })).toBeVisible();
  await menu.getByRole("menuitem", { name: "Copy Commit Hash" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(A);

  menu = await commitMenu(page, section, "Add a file");
  await menu.getByRole("menuitem", { name: "Open", exact: true }).click();
  await expect(section.getByRole("button", { name: "Close commit details" })).toBeVisible();
  await expect(section.getByRole("button", { name: /src\/a\.ts/ })).toBeVisible();
});

test("the keyboard's menu key opens a commit's menu too", async ({ page }) => {
  const section = await graph(page, { commits: [{ hash: A, subject: "Only commit" }] });
  await row(section, "Only commit").focus();
  await page.keyboard.press("Shift+F10");
  await expect(page.getByRole("menu", { name: "Commit actions" })).toBeVisible();
});
