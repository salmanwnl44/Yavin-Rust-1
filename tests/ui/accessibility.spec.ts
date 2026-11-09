import { test, expect } from "@playwright/test";

/**
 * WS28 — accessibility of the window chrome that is not an editor, a menu or a dialog.
 *
 * The menus, dialogs, context menus and the file tree are already exercised for roles and
 * keyboard behaviour elsewhere (menus.spec, explorer*.spec). These tests cover the two surfaces
 * WS28 changed: the Activity Bar view-switcher (now a real vertical tablist with correct
 * accessible names) and the landmark that names the editor region.
 */

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("the Activity Bar is a labelled vertical tablist", async ({ page }) => {
  const tablist = page.getByRole("tablist", { name: "Views" });
  await expect(tablist).toBeVisible();
  await expect(tablist).toHaveAttribute("aria-orientation", "vertical");
  // Each container reads as its view, never as its icon or its badge count.
  for (const name of ["Explorer", "Search", "Source Control", "Run and Debug"]) {
    await expect(tablist.getByRole("tab", { name, exact: true })).toBeVisible();
  }
});

test("selecting a view moves aria-selected to it", async ({ page }) => {
  const search = page.getByRole("tab", { name: "Search", exact: true });
  const explorer = page.getByRole("tab", { name: "Explorer", exact: true });
  await search.click();
  await expect(search).toHaveAttribute("aria-selected", "true");
  await expect(explorer).toHaveAttribute("aria-selected", "false");
});

test("arrow keys rove focus between Activity Bar tabs without a mouse", async ({ page }) => {
  const explorer = page.getByRole("tab", { name: "Explorer", exact: true });
  const search = page.getByRole("tab", { name: "Search", exact: true });
  const git = page.getByRole("tab", { name: "Source Control", exact: true });
  await explorer.focus();
  await expect(explorer).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(search).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(git).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(search).toBeFocused();
  await page.keyboard.press("Home");
  await expect(explorer).toBeFocused();
});

test("the bottom buttons are named, not announced as their avatar glyph or icon", async ({
  page,
}) => {
  // The account button contains the text "S"; without an explicit name it announced as "S".
  await expect(page.getByRole("button", { name: "Accounts", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
});

test("the editor region is a named main landmark", async ({ page }) => {
  await expect(page.getByRole("main", { name: "Editor" })).toBeVisible();
});
