import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

const TWO_HUNK_DIFF = [
  "diff --git a/a.ts b/a.ts",
  "index abc..def 100644",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1,2 +1,2 @@",
  " one",
  "-two",
  "+TWO",
  "@@ -10,2 +10,3 @@",
  " ten",
  "+eleven",
  " twelve",
].join("\n");

const SECOND_HUNK_ONLY = [
  "diff --git a/a.ts b/a.ts",
  "index abc..def 100644",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -10,2 +10,3 @@",
  " ten",
  "+eleven",
  " twelve",
].join("\n");

const FIRST_HUNK_ONLY = [
  "diff --git a/a.ts b/a.ts",
  "index abc..def 100644",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1,2 +1,2 @@",
  " one",
  "-two",
  "+TWO",
].join("\n");

async function panel(page: Page) {
  await page.addInitScript(
    (diffs) => {
      const calls: { command: string; args: Record<string, unknown> }[] = [];
      const ok = (stdout: string) => ({ stdout, stderr: "", code: 0, truncated: false });
      let applied = false;
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
              return {
                path: "/work",
                name: "work",
                is_dir: true,
                children: [{ path: "/work/a.ts", name: "a.ts", is_dir: false, children: null }],
              };
            if (command === "read_file_content") return "contents";
            if (command === "git_open_repo") return { repoId: "/work", root: "/work" };
            if (command === "git_repo_state") return "";
            if (command === "git_exec") {
              const argv = (args.args as string[] | undefined) ?? [];
              if (argv[0] === "status" && argv.includes("--porcelain=v2"))
                return ok("# branch.head main\n");
              if (argv[0] === "status") return ok(applied ? " M a.ts\0" : " M a.ts\0");
              if (argv[0] === "for-each-ref" || argv[0] === "remote") return ok("");
              if (argv[0] === "diff") {
                if (argv.includes("--cached")) return ok(applied ? diffs.first : "");
                return ok(applied ? diffs.second : diffs.both);
              }
              if (argv[0] === "apply" && argv.includes("--cached")) {
                applied = true;
                return ok("");
              }
              return ok("");
            }
            return null;
          },
        },
        __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      });
    },
    { both: TWO_HUNK_DIFF, first: FIRST_HUNK_ONLY, second: SECOND_HUNK_ONLY },
  );
  await page.goto("/");
  await page.getByTitle("Source Control (Ctrl+Shift+G)").click();
  const region = page.getByRole("complementary", { name: "Source control" });
  await expect(region).toBeVisible();
  return region;
}

const applyCalls = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { __calls: { command: string; args: { args?: string[] } }[] }
    ).__calls.filter((c) => c.command === "git_exec" && c.args.args?.[0] === "apply"),
  );

test("staging one hunk sends only that hunk's patch and leaves the other unstaged", async ({
  page,
}) => {
  const region = await panel(page);
  await region.getByText("a.ts").click();

  const diffView = page.locator("section[aria-label='Git diff editor']");
  await expect(diffView).toBeVisible();
  await expect(diffView.getByText("TWO", { exact: true })).toBeVisible();
  await expect(diffView.getByText("eleven")).toBeVisible();

  await diffView.getByRole("button", { name: "Stage Hunk" }).first().click();

  const calls = await applyCalls(page);
  assertPatchContainsOnlyFirstHunk(calls);

  // After staging, the (now unstaged-only) diff refreshes to show just the second hunk.
  await expect(diffView.getByText("eleven")).toBeVisible();
  await expect(diffView.getByText("TWO", { exact: true })).toHaveCount(0);
});

test("split view shows the old and new lines side by side and still stages hunks", async ({
  page,
}) => {
  const region = await panel(page);
  await region.getByText("a.ts").click();

  const diffView = page.locator("section[aria-label='Git diff editor']");
  await diffView.getByRole("button", { name: "Toggle split view" }).click();

  const split = diffView.locator("[aria-label='Split diff view']");
  await expect(split).toBeVisible();
  await expect(split.getByText("two", { exact: true })).toBeVisible();
  await expect(split.getByText("TWO", { exact: true })).toBeVisible();
  await expect(split.getByText("eleven")).toBeVisible();

  await split.getByRole("button", { name: "Stage Hunk" }).first().click();
  const calls = await applyCalls(page);
  assertPatchContainsOnlyFirstHunk(calls);
});

test("a staged file's diff offers Unstage Hunk, not Stage or Discard", async ({ page }) => {
  await page.addInitScript((diff) => {
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
            return {
              path: "/work",
              name: "work",
              is_dir: true,
              children: [{ path: "/work/a.ts", name: "a.ts", is_dir: false, children: null }],
            };
          if (command === "git_open_repo") return { repoId: "/work", root: "/work" };
          if (command === "git_repo_state") return "";
          if (command === "git_exec") {
            const argv = (args.args as string[] | undefined) ?? [];
            if (argv[0] === "status" && argv.includes("--porcelain=v2"))
              return ok("# branch.head main\n");
            if (argv[0] === "status") return ok("M  a.ts\0");
            if (argv[0] === "for-each-ref" || argv[0] === "remote") return ok("");
            if (argv[0] === "diff") return ok(diff);
            return ok("");
          }
          return null;
        },
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
    });
  }, FIRST_HUNK_ONLY);
  await page.goto("/");
  await page.getByTitle("Source Control (Ctrl+Shift+G)").click();
  const region = page.getByRole("complementary", { name: "Source control" });
  await region.getByText("a.ts").click();

  const diffView = page.locator("section[aria-label='Git diff editor']");
  await expect(diffView.getByRole("button", { name: "Unstage This Hunk" })).toBeVisible();
  await expect(diffView.getByRole("button", { name: "Stage Hunk" })).toHaveCount(0);
  await expect(diffView.getByRole("button", { name: "Discard Hunk" })).toHaveCount(0);
});

function assertPatchContainsOnlyFirstHunk(calls: { args: { args?: string[]; input?: string } }[]) {
  expect(calls.length).toBe(1);
  const patch = calls[0].args.input ?? "";
  expect(patch).toContain("@@ -1,2 +1,2 @@");
  expect(patch).not.toContain("@@ -10,2 +10,3 @@");
  expect(patch).not.toContain("eleven");
}
