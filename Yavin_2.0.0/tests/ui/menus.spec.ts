import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

async function menu(page: Page, name: string, action: string) {
  await page.getByRole("menubar").getByRole("menuitem", { name, exact: true }).click();
  await page
    .getByRole("menu", { name, exact: true })
    .getByRole("menuitem", { name: action, exact: true })
    .click();
}
async function newEditor(page: Page) {
  await menu(page, "File", "New File…");
  await expect(page.getByRole("textbox", { name: "Untitled.ts", exact: true })).toBeFocused();
  return page.getByRole("textbox", { name: "Untitled.ts", exact: true });
}
test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("all seven dropdowns open; Escape restores their trigger", async ({ page }) => {
  for (const name of ["File", "Edit", "Selection", "View", "Go", "Terminal", "Help"]) {
    const trigger = page.getByRole("menubar").getByRole("menuitem", { name, exact: true });
    await trigger.click();
    await expect(page.getByRole("menu", { name, exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
  }
});

test("keyboard navigation crosses menus and disabled commands cannot run", async ({ page }) => {
  const file = page.getByRole("menubar").getByRole("menuitem", { name: "File", exact: true });
  await file.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "New File…", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Open File…", exact: true })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu", { name: "File", exact: true })).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("menu", { name: "Edit", exact: true })).toBeVisible();
  await page.keyboard.press("End");
  await expect(page.getByRole("menuitem", { name: "Replace…", exact: true })).toBeFocused();
});

test("selection, duplication, undo and redo change the document", async ({ page }) => {
  const editor = await newEditor(page);
  await editor.fill("alpha\nbeta");
  await menu(page, "Selection", "Select All");
  await expect(editor).toBeFocused();
  await menu(page, "Selection", "Duplicate Selection or Line");
  await expect(editor).toHaveValue("alpha\nbetaalpha\nbeta");
  await menu(page, "Edit", "Undo");
  await expect(editor).toHaveValue("alpha\nbeta");
  await menu(page, "Edit", "Redo");
  await expect(editor).toHaveValue("alpha\nbetaalpha\nbeta");
});

test("history survives switching editors", async ({ page }) => {
  const first = await newEditor(page);
  await first.fill("first");
  const second = await newEditor(page);
  await second.fill("second");
  await menu(page, "Go", "Previous Editor");
  await expect(page.getByRole("textbox", { name: "Untitled.ts" })).toHaveValue("first");
  await menu(page, "Edit", "Undo");
  await expect(page.getByRole("textbox", { name: "Untitled.ts" })).toHaveValue("");
});

test("find/replace supports no matches and literal replacement", async ({ page }) => {
  const editor = await newEditor(page);
  await editor.fill("alpha alpha");
  await menu(page, "Edit", "Replace…");
  await page.getByRole("textbox", { name: "Find text", exact: true }).fill("missing");
  await page.getByRole("button", { name: "Find next", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "No matches" })).toBeVisible();
  await page.getByRole("textbox", { name: "Find text", exact: true }).fill("alpha");
  await page.getByRole("textbox", { name: "Replacement text", exact: true }).fill("$&");
  await page.getByRole("button", { name: "Replace all", exact: true }).click();
  await expect(editor).toHaveValue("$& $&");
});

test("command search executes shared commands and closes its dialog", async ({ page }) => {
  const search = page.getByRole("combobox", { name: "Search files or commands" });
  // The shortcut listener is attached after React's first commit, which can follow the load event.
  await expect(async () => {
    await page.keyboard.press("Control+Shift+P");
    await expect(search).toBeVisible({ timeout: 1000 });
  }).toPass();
  await search.fill(">new file");
  await search.press("Enter");
  await expect(page.getByRole("textbox", { name: "Untitled.ts" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Quick open and commands" })).not.toBeVisible();
});

test("go to line validates input and selects the requested line", async ({ page }) => {
  const editor = await newEditor(page);
  await editor.fill("one\ntwo\nthree");
  await menu(page, "Go", "Go to Line…");
  const input = page.getByRole("textbox", { name: "Go to line", exact: true });
  await input.fill("100");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("alert")).toContainText("3 lines");
  await input.fill("2");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(editor).toBeFocused();
  expect(await editor.evaluate((element: HTMLTextAreaElement) => element.selectionStart)).toBe(4);
});

test("closing a dirty file can be cancelled", async ({ page }) => {
  const editor = await newEditor(page);
  await editor.fill("keep this");
  page.once("dialog", (dialog) => dialog.dismiss());
  await menu(page, "File", "Close Editor");
  await expect(editor).toHaveValue("keep this");
  page.once("dialog", (dialog) => dialog.accept());
  await menu(page, "File", "Close Editor");
  await expect(editor).not.toBeVisible();
});

test("menus fit narrow viewports and dismiss on outside click", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.getByRole("menubar").getByRole("menuitem", { name: "Help", exact: true }).click();
  const bounds = await page.getByRole("menu", { name: "Help", exact: true }).boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(800);
  await page.getByRole("heading", { name: "Yavin IDE", exact: true }).click();
  await expect(page.getByRole("menu", { name: "Help", exact: true })).not.toBeVisible();
});

test("clipboard selection is preserved when menus take focus", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const editor = await newEditor(page);
  await editor.fill("copy me");
  await menu(page, "Selection", "Select All");
  await menu(page, "Edit", "Copy");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("copy me");
  await menu(page, "Edit", "Cut");
  await expect(editor).toHaveValue("");
  await menu(page, "Edit", "Paste");
  await expect(editor).toHaveValue("copy me");
});

test("checkbox menu commands reflect state and Tab exits the menu", async ({ page }) => {
  const editor = await newEditor(page);
  await page.getByRole("menubar").getByRole("menuitem", { name: "View", exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: "Word Wrap", exact: true }).click();
  await expect(editor).toHaveAttribute("wrap", "soft");
  await page.getByRole("menubar").getByRole("menuitem", { name: "View", exact: true }).click();
  await expect(
    page.getByRole("menuitemcheckbox", { name: "Word Wrap", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("menu", { name: "View", exact: true })).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Search workspace files... Ctrl P" }),
  ).toBeFocused();
});

async function desktopFixture(page: Page) {
  await page.addInitScript(() => {
    const files: Record<string, string> = { "/work/file.ts": "original" };
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        transformCallback: () => 1,
        unregisterCallback: () => {},
        invoke: async (command: string, args: { path?: string; content?: string } = {}) => {
          if (command === "get_default_workspace") return "/work";
          if (command === "list_workspace_files")
            return {
              path: "/work",
              name: "work",
              is_dir: true,
              children: Object.keys(files).map((path) => ({
                path,
                name: path.split("/").pop(),
                is_dir: false,
              })),
            };
          if (command === "get_git_status") return { root: "/work", output: "" };
          if (command === "read_file_content") return files[args.path!];
          if (command === "open_file_dialog") return "/work/file.ts";
          if (command === "create_file") {
            if (args.path! in files) throw new Error("File already exists");
            files[args.path!] = "";
            return null;
          }
          if (command === "write_file_guarded") {
            if (args.content === "fail") throw new Error("Disk write denied");
            files[args.path!] = args.content!;
            return null;
          }
          return null;
        },
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
    });
  });
  await page.reload();
  await expect(page.getByText("work", { exact: true }).first()).toBeVisible();
}

test("desktop File menu reports save failure and only clears dirty state after success", async ({
  page,
}) => {
  await desktopFixture(page);
  await menu(page, "File", "Open File…");
  const editor = page.getByRole("textbox", { name: "file.ts", exact: true });
  await expect(editor).toHaveValue("original");
  await editor.fill("fail");
  await menu(page, "File", "Save");
  await expect(page.getByRole("alert")).toContainText("Disk write denied");
  await expect(editor).toHaveValue("fail");
  await page.getByRole("button", { name: "Dismiss" }).click();
  await menu(page, "File", "Save All");
  await expect(page.getByRole("alert")).toContainText("Disk write denied");
  await editor.fill("saved");
  await menu(page, "File", "Save");
  await page.getByRole("menubar").getByRole("menuitem", { name: "File", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Save", exact: true })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
});

test("desktop New File validates paths and refuses overwrite", async ({ page }) => {
  await desktopFixture(page);
  await menu(page, "File", "New File…");
  const input = page.getByRole("textbox", { name: "New file", exact: true });
  await input.fill("../escape.ts");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("alert")).toContainText("not a valid name");
  await input.fill("file.ts");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("alert")).toContainText("already exists");
  await input.fill("new.ts");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("textbox", { name: "new.ts", exact: true })).toBeVisible();
});

test("Explorer context menu opens with Shift+F10 and is keyboard operable", async ({ page }) => {
  await desktopFixture(page);
  await page.getByLabel("file.ts", { exact: true }).focus();
  await page.keyboard.press("Shift+F10");
  await expect(page.getByRole("menu", { name: "Actions" })).toBeVisible();
  await page.keyboard.press("End");
  await expect(page.getByRole("menuitem", { name: "Delete File...", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("file.ts", { exact: true })).toBeFocused();
});
