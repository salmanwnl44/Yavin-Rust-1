import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { installFakeLsp } from "./lsp-harness";
import { editorInput } from "./editor-harness";

/**
 * Back / Forward navigation history (WS25): a cross-file jump (Go to Definition) is remembered,
 * Go Back returns to where it left from, and Go Forward retraces it. The jump runs through the
 * real `openLocation` path -- the same one every navigation uses -- against the fake language
 * server, so this exercises the window's actual wiring, not the service in isolation.
 */

async function menu(page: Page, name: string, action: string) {
  await page.getByRole("menubar").getByRole("menuitem", { name, exact: true }).click();
  return page
    .getByRole("menu", { name, exact: true })
    .getByRole("menuitem", { name: action, exact: true })
    .first();
}

async function clickMenu(page: Page, name: string, action: string) {
  await (await menu(page, name, action)).click();
}

async function fixture(page: Page, files: Record<string, string>) {
  await page.addInitScript((initial) => {
    const disk: Record<string, string> = { ...initial };
    const callbacks: Record<number, (event: unknown) => void> = {};
    const listeners: Record<string, number[]> = {};
    let nextId = 1;
    Object.assign(window, {
      __disk: disk,
      __emit: (event: string, payload: unknown) => {
        for (const id of listeners[event] ?? []) callbacks[id]?.({ event, id, payload });
      },
      isTauri: true,
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        transformCallback: (callback: (event: unknown) => void) => {
          const id = nextId++;
          callbacks[id] = callback;
          return id;
        },
        unregisterCallback: (id: number) => delete callbacks[id],
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          const path = args.path as string;
          if (command === "plugin:event|listen") {
            (listeners[args.event as string] ??= []).push(args.handler as number);
            return nextId++;
          }
          if (command === "get_default_workspace") return "/work";
          if (command === "list_workspace_files")
            return {
              path: "/work",
              name: "work",
              is_dir: true,
              children: Object.keys(disk).map((file) => ({
                path: file,
                name: file.split("/").pop(),
                is_dir: false,
              })),
            };
          if (command === "read_file_content") {
            if (!(path in disk)) throw "The system cannot find the file specified.";
            return disk[path];
          }
          return null;
        },
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
    });
  }, files);
  await page.goto("/");
  await expect(page.getByText("work", { exact: true }).first()).toBeVisible();
}

const status = (page: Page) => page.getByRole("button", { name: /^Language server:/ });

async function openServed(page: Page, name: string) {
  await page.getByRole("treeitem", { name, exact: true }).click();
  await expect(editorInput(page, name)).toBeFocused();
  await expect(status(page)).toHaveAccessibleName("Language server: TypeScript");
}

// The editor tab strip only; the Activity Bar is also a tablist (WS28), so scope to the tabs
// that control the editor panel rather than every selected tab on the page.
const selectedTab = (page: Page) =>
  page.locator('[role="tab"][aria-controls="editor-panel"][aria-selected="true"]');

test("Go Back and Go Forward are disabled until there is somewhere to go", async ({ page }) => {
  await installFakeLsp(page);
  await fixture(page, { "/work/a.ts": "function helper() {}\n" });
  await openServed(page, "a.ts");
  // Open the Go menu once, then read both entries from it.
  await page.getByRole("menubar").getByRole("menuitem", { name: "Go", exact: true }).click();
  const go = page.getByRole("menu", { name: "Go", exact: true });
  await expect(go.getByRole("menuitem", { name: "Go Back", exact: true })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(go.getByRole("menuitem", { name: "Go Forward", exact: true })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await page.keyboard.press("Escape");
});

test("a cross-file jump is remembered; Back returns, Forward retraces", async ({ page }) => {
  await installFakeLsp(page);
  await fixture(page, {
    "/work/a.ts": "function helper() {}\n",
    "/work/b.ts": "helper();\n",
  });
  await openServed(page, "a.ts");
  await openServed(page, "b.ts");

  // Go to Definition from b.ts jumps to a.ts -- a real cross-file navigation, recorded.
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("F12");
  await expect(selectedTab(page)).toContainText("a.ts");

  // Go Back returns to where the jump left from: b.ts.
  await clickMenu(page, "Go", "Go Back");
  await expect(selectedTab(page)).toContainText("b.ts");

  // Go Forward retraces the jump to a.ts.
  await clickMenu(page, "Go", "Go Forward");
  await expect(selectedTab(page)).toContainText("a.ts");

  // At the newest entry again, Forward is spent.
  await expect(await menu(page, "Go", "Go Forward")).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");
});

test("the Back trail survives closing a tab and reopens the file", async ({ page }) => {
  await installFakeLsp(page);
  await fixture(page, {
    "/work/a.ts": "function helper() {}\n",
    "/work/b.ts": "helper();\n",
  });
  await openServed(page, "a.ts");
  await openServed(page, "b.ts");
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("F12"); // b.ts -> a.ts, now on a.ts
  await expect(selectedTab(page)).toContainText("a.ts");

  // Close b.ts (it is no longer in front). Back should still reopen it.
  const bTab = page.getByRole("tab", { name: /b\.ts/ });
  await bTab.hover();
  await bTab.getByRole("button", { name: /Close/ }).click();
  await expect(page.getByRole("tab", { name: /b\.ts/ })).toHaveCount(0);

  await clickMenu(page, "Go", "Go Back");
  await expect(selectedTab(page)).toContainText("b.ts");
});
