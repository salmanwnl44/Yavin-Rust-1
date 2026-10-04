import { expect, test, type Page } from "@playwright/test";
import { appAlert } from "./editor-harness";

/**
 * Settings (IDE-03) in the window: the view, its effect on the editor, persistence across a
 * reload, user and workspace scopes, and the terminal's settings shown through their owner.
 * The desktop is stood in for with files in memory; webview storage is the browser's own, so a
 * reload is a restart.
 */
async function desktop(page: Page) {
  await page.addInitScript(() => {
    const disk: Record<string, string> = {
      "/work/a.ts": "const a = 1;\n\tindented();\n",
      "/other/b.ts": "const b = 2;\n",
    };
    const callbacks: Record<number, (event: unknown) => void> = {};
    const listeners: Record<string, number[]> = {};
    let nextId = 1;
    const w = window as unknown as { __openFolder?: string };
    Object.assign(window, {
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
          if (command === "plugin:event|listen") {
            (listeners[args.event as string] ??= []).push(args.handler as number);
            return nextId++;
          }
          if (command === "get_default_workspace") return "/work";
          if (command === "open_folder_dialog") return w.__openFolder ?? null;
          if (command === "list_workspace_files") {
            const root = args.path as string;
            return {
              path: root,
              name: root.split("/").pop(),
              is_dir: true,
              children: Object.keys(disk)
                .filter((file) => file.startsWith(`${root}/`))
                .map((file) => ({ path: file, name: file.split("/").pop(), is_dir: false })),
            };
          }
          if (command === "read_file_content") {
            const path = args.path as string;
            if (!(path in disk)) throw "The system cannot find the file specified.";
            return disk[path];
          }
          return null;
        },
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
    });
  });
  await page.goto("/");
  await expect(page.getByText("work", { exact: true }).first()).toBeVisible();
}

const view = (page: Page) => page.getByRole("region", { name: "Settings" });
const row = (page: Page, title: string) =>
  view(page).getByRole("group", { name: title, exact: true });
/** The editor's rendered font size, in pixels; `null` until it has drawn. */
const editorFontSize = (page: Page) =>
  page.evaluate(() => {
    const lines = document.querySelector("[data-editor=monaco] .view-lines");
    return lines ? parseFloat(getComputedStyle(lines).fontSize) : null;
  });
/** Whether the editor is drawn in a light theme (`vs` base, not `vs-dark`); `null` before. */
const isLight = (page: Page) =>
  page.evaluate(() => {
    const host = document.querySelector("[data-editor=monaco]");
    const editor = host?.matches(".monaco-editor") ? host : host?.querySelector(".monaco-editor");
    if (!editor) return null;
    return editor.classList.contains("vs") && !editor.classList.contains("vs-dark");
  });

async function openFile(page: Page, name: string) {
  await page.getByRole("treeitem", { name }).click();
  await expect(page.getByRole("tab", { selected: true })).toContainText(name);
}

async function openFolder(page: Page, folder: string) {
  await page.evaluate((path) => {
    (window as unknown as { __openFolder?: string }).__openFolder = path;
  }, folder);
  await page.getByRole("menubar").getByRole("menuitem", { name: "File", exact: true }).click();
  await page
    .getByRole("menu", { name: "File", exact: true })
    .getByRole("menuitem", { name: "Open Folder…", exact: true })
    .click();
}

async function setNumber(page: Page, title: string, value: string) {
  const input = row(page, title).getByRole("spinbutton", { name: title });
  await input.fill(value);
  await input.press("Enter");
}

test("the gear and Ctrl+, open the Settings view, in the editor's place", async ({ page }) => {
  await desktop(page);
  await page.getByTitle("Settings (Ctrl+,)").click();
  await expect(view(page)).toBeVisible();
  await expect(row(page, "Font size")).toBeVisible();
  await view(page).getByRole("button", { name: "Close settings" }).click();
  await expect(view(page)).toHaveCount(0);
  await page.keyboard.press("Control+,");
  await expect(view(page)).toBeVisible();
  // Not the command palette.
  await expect(page.getByRole("combobox", { name: "Search files or commands" })).toHaveCount(0);
});

test("a setting applies to the editor at once, survives a restart, and resets", async ({
  page,
}) => {
  await desktop(page);
  await openFile(page, "a.ts");
  await expect.poll(() => editorFontSize(page)).toBe(13);
  await page.keyboard.press("Control+,");
  await setNumber(page, "Font size", "18");
  await expect(row(page, "Font size").getByTestId("setting-source")).toHaveText(
    "Set in your user settings.",
  );
  await openFile(page, "a.ts"); // opening a file shows the editor again
  await expect.poll(() => editorFontSize(page)).toBe(18);

  await page.reload();
  await expect(page.getByText("work", { exact: true }).first()).toBeVisible();
  await openFile(page, "a.ts");
  await expect.poll(() => editorFontSize(page)).toBe(18);

  await page.keyboard.press("Control+,");
  await row(page, "Font size").getByRole("button", { name: "Reset Font size" }).click();
  await expect(row(page, "Font size").getByRole("spinbutton")).toHaveValue("13");
  await expect(row(page, "Font size").getByTestId("setting-source")).toHaveText("Default.");
});

test("an invalid value is refused with a reason and changes nothing", async ({ page }) => {
  await desktop(page);
  await page.keyboard.press("Control+,");
  await setNumber(page, "Font size", "200");
  await expect(row(page, "Font size").getByRole("alert")).toContainText("not a valid value");
  await expect(row(page, "Font size").getByRole("spinbutton")).toHaveValue("13");
  const kept = await page.evaluate(() => localStorage.getItem("yavin.settings.user"));
  expect(kept).toBeNull();
});

test("the theme switches the editor between Yavin's dark and light themes", async ({ page }) => {
  await desktop(page);
  await openFile(page, "a.ts");
  await expect.poll(() => isLight(page)).toBe(false);
  await page.keyboard.press("Control+,");
  await row(page, "Theme").getByRole("combobox", { name: "Theme" }).selectOption("yavin-light");
  await openFile(page, "a.ts");
  await expect.poll(() => isLight(page)).toBe(true);
});

test("Word Wrap and Zoom from the View menu are the settings, and are remembered", async ({
  page,
}) => {
  await desktop(page);
  await openFile(page, "a.ts");
  await page.keyboard.press("Alt+z");
  await page.keyboard.press("Control+=");
  await expect.poll(() => editorFontSize(page)).toBe(Math.round(13 * 1.1));
  await page.reload();
  await expect(page.getByText("work", { exact: true }).first()).toBeVisible();
  await page.keyboard.press("Control+,");
  await expect(row(page, "Word wrap").getByRole("checkbox", { name: "Word wrap" })).toBeChecked();
  await expect(row(page, "Zoom").getByRole("spinbutton")).toHaveValue("1.1");
});

test("a workspace setting overrides the user's in that workspace only, and comes back with it", async ({
  page,
}) => {
  await desktop(page);
  await page.keyboard.press("Control+,");
  await setNumber(page, "Font size", "15"); // the user's
  await view(page).getByRole("tab", { name: "Workspace" }).click();
  await setNumber(page, "Font size", "21"); // this workspace's
  await expect(row(page, "Font size").getByTestId("setting-source")).toHaveText(
    "Set for this workspace.",
  );
  await openFile(page, "a.ts");
  await expect.poll(() => editorFontSize(page)).toBe(21);

  await openFolder(page, "/other");
  await expect(page.getByText(/Working in other/)).toBeVisible();
  await openFile(page, "b.ts");
  await expect.poll(() => editorFontSize(page)).toBe(15);

  await openFolder(page, "/work");
  // Back in the first folder (its tab comes back with it).
  await expect(page.getByRole("treeitem", { name: "a.ts" })).toBeVisible();
  await openFile(page, "a.ts");
  await expect.poll(() => editorFontSize(page)).toBe(21);

  // Resetting the workspace's value gives back the user's, not the default.
  await page.keyboard.press("Control+,");
  await view(page).getByRole("tab", { name: "Workspace" }).click();
  await row(page, "Font size").getByRole("button", { name: "Reset Font size" }).click();
  await expect(row(page, "Font size").getByRole("spinbutton")).toHaveValue("15");
  await expect(row(page, "Font size").getByTestId("setting-source")).toHaveText(
    "From your user settings.",
  );
});

test("unreadable settings are said once, and the editor works with its defaults", async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("seeded")) {
      localStorage.setItem("yavin.settings.user", '{"version":1,"values":{"editor.fontSi');
      sessionStorage.setItem("seeded", "1");
    }
  });
  await desktop(page);
  await expect(appAlert(page)).toContainText("could not be read; defaults apply");
  await openFile(page, "a.ts");
  await expect.poll(() => editorFontSize(page)).toBe(13);
  expect(await page.evaluate(() => localStorage.getItem("yavin.settings.user.corrupt"))).toContain(
    "editor.fontSi",
  );
});

test("the terminal's settings are shown and changed through the terminal's own store", async ({
  page,
}) => {
  await desktop(page);
  await page.keyboard.press("Control+,");
  const integration = view(page).getByRole("checkbox", { name: "Shell integration" });
  await expect(integration).toBeChecked();
  await integration.uncheck();
  const kept = await page.evaluate(() => JSON.parse(localStorage.getItem("yavin.terminal.user")!));
  expect(kept.shellIntegration).toBe(false);
  // Not copied into the general settings.
  expect(await page.evaluate(() => localStorage.getItem("yavin.settings.user"))).toBeNull();
  await view(page).getByLabel("Search settings").fill("shell");
  await expect(row(page, "Font size")).toHaveCount(0);
  await expect(integration).toBeVisible();
});
