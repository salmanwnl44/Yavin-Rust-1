import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

const deep = "/work/a/b/c/d/e/f/g";

async function explorer(page: Page, status = "") {
  await page.addInitScript((gitStatus) => {
    const entries: Record<string, { dir: boolean; content?: string; locked?: boolean }> = {
      "/work": { dir: true },
      "/work/locked": { dir: true, locked: true },
      "/work/conflict.ts": { dir: false, content: "conflict" },
      "/work/file.ts": { dir: false, content: "original" },
      "/work/new.ts": { dir: false, content: "renamed" },
    };
    for (const [index, path] of [
      "/work/a",
      "/work/a/b",
      "/work/a/b/c",
      "/work/a/b/c/d",
      "/work/a/b/c/d/e",
      "/work/a/b/c/d/e/f",
      "/work/a/b/c/d/e/f/g",
    ].entries())
      entries[path] = { dir: true, content: String(index) };
    entries["/work/a/b/c/d/e/f/g/deep.ts"] = { dir: false, content: "deep" };

    const calls: { command: string; args: Record<string, string> }[] = [];
    const node = (path: string) => ({
      path,
      name: path.slice(path.lastIndexOf("/") + 1),
      is_dir: entries[path].dir,
      children: null as unknown,
    });
    Object.assign(window, {
      __calls: calls,
      isTauri: true,
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        transformCallback: () => 1,
        unregisterCallback: () => {},
        invoke: async (command: string, args: Record<string, string> = {}) => {
          calls.push({ command, args });
          if (command === "get_default_workspace") return "/work";
          if (command === "list_workspace_files") {
            const entry = entries[args.path];
            if (!entry?.dir) throw `Cannot read ${args.path}`;
            if (entry.locked) throw `Cannot read ${args.path}: permission denied`;
            const children = Object.keys(entries)
              .filter(
                (path) => path !== args.path && path.slice(0, path.lastIndexOf("/")) === args.path,
              )
              .sort((a, b) => Number(entries[b].dir) - Number(entries[a].dir) || a.localeCompare(b))
              .map(node);
            return { ...node(args.path), children };
          }
          if (command === "read_file_content") return entries[args.path]?.content ?? "";
          if (command === "create_file") {
            entries[args.path] = { dir: false, content: "" };
            return null;
          }
          if (command === "create_directory") {
            entries[args.path] = { dir: true };
            return null;
          }
          if (command === "delete_path") {
            for (const path of Object.keys(entries))
              if (path === args.path || path.startsWith(args.path + "/")) delete entries[path];
            return null;
          }
          if (command === "rename_path") {
            for (const path of Object.keys(entries))
              if (path === args.oldPath || path.startsWith(args.oldPath + "/")) {
                entries[args.newPath + path.slice(args.oldPath.length)] = entries[path];
                delete entries[path];
              }
            return null;
          }
          if (command === "copy_path") {
            entries[args.dest] = { ...entries[args.src] };
            return null;
          }
          if (command === "git_open_repo") return { repoId: "/work", root: "/work" };
          if (command === "git_repo_state") return "";
          if (command === "git_exec") {
            const gitArgs = (args as unknown as { args: string[] }).args;
            const isStatus = gitArgs[0] === "status";
            const stdout = isStatus && !gitArgs.includes("--porcelain=v2") ? gitStatus : "";
            return { stdout, stderr: "", code: 0, truncated: false };
          }
          if (command === "search_project")
            return {
              stdout: Object.keys(entries)
                .filter((path) => !entries[path].dir)
                .map((path) => path.slice("/work/".length))
                .join("\0"),
              stderr: "",
              code: 0,
              truncated: false,
            };
          return null;
        },
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
    });
  }, status);
  await page.goto("/");
  await expect(page.getByLabel("file.ts", { exact: true })).toBeVisible();
}

const calls = (page: Page, command: string) =>
  page.evaluate(
    (name) =>
      (
        window as unknown as { __calls: { command: string; args: Record<string, string> }[] }
      ).__calls.filter((call) => call.command === name),
    command,
  );

test("folders load on expand, including files deeper than six levels", async ({ page }) => {
  await explorer(page);
  for (const name of ["a", "b", "c", "d", "e", "f", "g"])
    await page.getByLabel(name, { exact: true }).click();
  await expect(page.getByLabel("deep.ts", { exact: true })).toBeVisible();
  const listed = await calls(page, "list_workspace_files");
  expect(listed.every((call) => String(call.args.maxDepth) === "1")).toBe(true);
  expect(listed.map((call) => call.args.path)).toContain(deep);
});

test("expanded folders survive switching to Search and back", async ({ page }) => {
  await explorer(page);
  await page.getByLabel("a", { exact: true }).click();
  await expect(page.getByLabel("b", { exact: true })).toBeVisible();
  await page.getByTitle("Search (Ctrl+Shift+F)").click();
  await expect(page.getByLabel("b", { exact: true })).toBeHidden();
  await page.getByTitle("Explorer (Ctrl+Shift+E)").click();
  await expect(page.getByLabel("b", { exact: true })).toBeVisible();
});

test("a folder that cannot be read reports the error and can be retried", async ({ page }) => {
  await explorer(page);
  await page.getByLabel("locked", { exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("permission denied");
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
});

test("deleting asks once; Escape cancels and Enter confirms", async ({ page }) => {
  await explorer(page);
  const remove = async () => {
    await page.getByLabel("file.ts", { exact: true }).focus();
    await page.keyboard.press("Shift+F10");
    await page.getByRole("menuitem", { name: "Delete File...", exact: true }).click();
  };
  await remove();
  const dialog = page.getByRole("dialog", { name: "Delete file" });
  await expect(dialog).toContainText("Permanently delete");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(await calls(page, "delete_path")).toHaveLength(0);

  await remove();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("file.ts", { exact: true })).toBeHidden();
  expect(await calls(page, "delete_path")).toHaveLength(1);
});

test("inline names are validated before a file is created", async ({ page }) => {
  await explorer(page);
  await page.getByTitle("New File", { exact: true }).click();
  const input = page.getByPlaceholder("new file...");
  await input.fill("bad:name.ts");
  await expect(page.getByRole("alert")).toContainText("cannot contain");
  await input.press("Enter");
  expect(await calls(page, "create_file")).toHaveLength(0);
  await input.fill("good.ts");
  await input.press("Enter");
  await expect(page.getByRole("textbox", { name: "good.ts", exact: true })).toBeVisible();
  expect((await calls(page, "create_file")).map((call) => call.args.path)).toEqual([
    "/work/good.ts",
  ]);
});

test("Git badges cover modified, renamed and conflicted files", async ({ page }) => {
  await explorer(page, " M file.ts\0R  new.ts\0old.ts\0UU conflict.ts\0");
  await expect(page.getByLabel("Git: Modified")).toBeVisible();
  await expect(page.getByLabel("Git: Renamed")).toBeVisible();
  await expect(page.getByLabel("Git: Conflict")).toBeVisible();
});

test("without a workspace the Explorer offers to open a folder", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("No workspace opened")).toBeVisible();
  await expect(page.getByTitle("New Folder", { exact: true })).toHaveCount(0);
});

test("arrow keys walk the tree and type-to-find jumps by name", async ({ page }) => {
  await explorer(page);
  await page.getByLabel("a", { exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByLabel("b", { exact: true })).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByLabel("b", { exact: true })).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByLabel("a", { exact: true })).toBeFocused();
  await page.keyboard.press("f");
  await expect(page.getByLabel("file.ts", { exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", { name: "file.ts", exact: true })).toBeVisible();
});

test("F2 renames the focused entry", async ({ page }) => {
  await explorer(page);
  await page.getByLabel("file.ts", { exact: true }).focus();
  await page.keyboard.press("F2");
  const input = page.getByRole("textbox", { name: "Rename file.ts" });
  await expect(input).toBeFocused();
  await input.fill("moved.ts");
  await input.press("Enter");
  await expect(page.getByLabel("moved.ts", { exact: true })).toBeVisible();
  expect((await calls(page, "rename_path")).map((call) => call.args.newPath)).toEqual([
    "/work/moved.ts",
  ]);
});

test("Delete removes the focused entry after one confirmation", async ({ page }) => {
  await explorer(page);
  await page.getByLabel("new.ts", { exact: true }).focus();
  await page.keyboard.press("Delete");
  await expect(page.getByRole("dialog", { name: "Delete file" })).toContainText("new.ts");
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("new.ts", { exact: true })).toBeHidden();
  expect(await calls(page, "delete_path")).toHaveLength(1);
});

test("Ctrl+C and Ctrl+V copy into the focused folder, not the editor", async ({ page }) => {
  await explorer(page);
  await page.getByLabel("file.ts", { exact: true }).focus();
  await page.keyboard.press("Control+c");
  await page.getByLabel("a", { exact: true }).click();
  await expect(page.getByLabel("b", { exact: true })).toBeVisible();
  await page.keyboard.press("Control+v");
  expect((await calls(page, "copy_path")).map((call) => call.args.dest)).toEqual([
    "/work/a/file.ts",
  ]);
});

test("Ctrl+N creates in the focused folder", async ({ page }) => {
  await explorer(page);
  await page.getByLabel("a", { exact: true }).focus();
  await page.keyboard.press("Control+n");
  const input = page.getByPlaceholder("new file...");
  await input.fill("inside.ts");
  await input.press("Enter");
  expect((await calls(page, "create_file")).map((call) => call.args.path)).toEqual([
    "/work/a/inside.ts",
  ]);
});

test("Ctrl+click selects several entries and deletes them together", async ({ page }) => {
  await explorer(page);
  await page.getByLabel("file.ts", { exact: true }).click();
  await page.getByLabel("new.ts", { exact: true }).click({ modifiers: ["Control"] });
  await page.getByLabel("conflict.ts", { exact: true }).click({ modifiers: ["Control"] });
  await page.keyboard.press("Delete");
  await expect(page.getByRole("dialog", { name: "Delete items" })).toContainText("these 3 items");
  await page.keyboard.press("Enter");
  for (const name of ["file.ts", "new.ts", "conflict.ts"])
    await expect(page.getByLabel(name, { exact: true })).toBeHidden();
  expect(await calls(page, "delete_path")).toHaveLength(3);
});

test("Shift+click selects the range between two entries", async ({ page }) => {
  await explorer(page);
  await page.getByLabel("conflict.ts", { exact: true }).click();
  await page.getByLabel("new.ts", { exact: true }).click({ modifiers: ["Shift"] });
  await expect(page.getByLabel("file.ts", { exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("Delete");
  await expect(page.getByRole("dialog", { name: "Delete items" })).toContainText("these 3 items");
});

test("opening a file from Quick Open reveals it in the collapsed tree", async ({ page }) => {
  await explorer(page);
  const search = page.getByRole("combobox", { name: "Search files or commands" });
  await expect(async () => {
    await page.keyboard.press("Control+p");
    await expect(search).toBeVisible({ timeout: 1000 });
  }).toPass();
  await search.fill("deep.ts");
  await search.press("Enter");
  // Seven ancestors were collapsed; revealing the file expands every one of them.
  const row = page.getByRole("treeitem", { name: "deep.ts", exact: true });
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("aria-selected", "true");
  // Revealing scrolls the row into view but must not pull focus into the tree.
  await expect(row).not.toBeFocused();
});
