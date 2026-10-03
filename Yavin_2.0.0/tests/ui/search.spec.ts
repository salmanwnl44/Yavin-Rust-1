import { expect, test, type Page } from "@playwright/test";
import { appAlert, editorSelections, editorText } from "./editor-harness";
import { fakeRipgrep } from "../../src/services/search.fake";

/**
 * Search (IDE-02) against a desktop stand-in whose files are held in memory and searched by
 * `fakeRipgrep` -- ripgrep's own output formats -- so the window's search, overlay,
 * navigation and replacement run as they do in the app.
 *
 * The workspace is spelled the Windows way (`C:\work`), as the native side reports it: a
 * document opened from the Explorer is keyed `C:\work\a.ts`, while a search result is
 * ripgrep's path joined onto the folder, `C:\work/a.ts`. The same file, two spellings.
 */
async function desktop(
  page: Page,
  files: Record<string, string>,
  other: Record<string, string> = {},
) {
  await page.addInitScript(
    ({ initial, others, ripgrep }) => {
      const search = new Function(`return (${ripgrep})`)() as (
        disk: Record<string, string>,
        options: Record<string, unknown>,
      ) => unknown;
      const disk: Record<string, string> = { ...initial, ...others };
      /** One spelling per file: `/` separators, lower case (Windows). */
      const norm = (path: string) => path.replace(/\\/g, "/").toLowerCase();
      const find = (path: string) => Object.keys(disk).find((key) => norm(key) === norm(path));
      const callbacks: Record<number, (event: unknown) => void> = {};
      const listeners: Record<string, number[]> = {};
      let nextId = 1;
      let operation = 0;
      const calls: { command: string; args: Record<string, unknown> }[] = [];
      const page = window as unknown as {
        __searchDelay?: number;
        __searchAnswer?: unknown;
        __openFolder?: string;
      };
      Object.assign(window, {
        __disk: disk,
        __calls: calls,
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
            calls.push({ command, args });
            const path = args.path as string;
            if (command === "plugin:event|listen") {
              (listeners[args.event as string] ??= []).push(args.handler as number);
              return nextId++;
            }
            if (command === "get_default_workspace") return "C:\\work";
            if (command === "open_folder_dialog") return page.__openFolder ?? null;
            if (command === "list_workspace_files") {
              const root = path.replace(/\\$/, "");
              return {
                path: root,
                name: root.split("\\").pop(),
                is_dir: true,
                children: Object.keys(disk)
                  .filter((file) => norm(file).startsWith(`${norm(root)}/`))
                  .map((file) => ({ path: file, name: file.split("\\").pop(), is_dir: false })),
              };
            }
            if (command === "read_file_content") {
              const key = find(path);
              if (!key) throw "The system cannot find the file specified.";
              return disk[key];
            }
            if (command === "write_file_guarded") {
              const key = find(path) ?? path;
              if (disk[key] !== args.expected)
                throw "File changed on disk. Reopen or review its current contents before saving.";
              disk[key] = args.content as string;
              return ++operation;
            }
            if (command === "search_project") {
              if (page.__searchDelay) await new Promise((r) => setTimeout(r, page.__searchDelay));
              if (page.__searchAnswer) return page.__searchAnswer;
              const options = args.options as { folder: string };
              // ripgrep's view: the files under the folder searched, `/`-separated.
              const view: Record<string, string> = {};
              for (const [file, text] of Object.entries(disk))
                view[file.replace(/\\/g, "/")] = text;
              return search(view, { ...options, folder: options.folder.replace(/\\/g, "/") });
            }
            return null;
          },
        },
        __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      });
    },
    { initial: files, others: other, ripgrep: fakeRipgrep.toString() },
  );
  await page.goto("/");
  await expect(page.getByText("work", { exact: true }).first()).toBeVisible();
}

const disk = (page: Page) =>
  page.evaluate(() => (window as unknown as { __disk: Record<string, string> }).__disk);
const calls = (page: Page, command: string) =>
  page.evaluate(
    (name) =>
      (
        window as unknown as { __calls: { command: string; args: Record<string, unknown> }[] }
      ).__calls.filter((call) => call.command === name).length,
    command,
  );

async function searchFor(page: Page, query: string) {
  await page.keyboard.press("Control+Shift+f");
  const box = page.getByRole("textbox", { name: "Search workspace" });
  await expect(box).toBeVisible();
  await box.fill(query);
}
const status = (page: Page) => page.locator("[aria-label='Workspace search'] [role=status]");
const results = (page: Page) => page.locator("[aria-label='Search results']");

const FILES = {
  "C:\\work\\a.ts": "const a = 1;\nlet needle = 2;\n",
  "C:\\work\\b.ts": "one\r\ntwo needle\r\n",
};

test("a result in a file already open under another spelling lands on the exact match", async ({
  page,
}) => {
  // The Explorer lists a.ts as `c:\WORK\a.ts`, so its document is keyed by that spelling; the
  // search result is `C:\work` joined with ripgrep's `a.ts`. The same file (Windows ignores
  // case), two spellings -- as when a file was opened from a language server's location or a
  // restored session.
  await desktop(page, {
    "c:\\WORK\\a.ts": FILES["C:\\work\\a.ts"],
    "C:\\work\\b.ts": FILES["C:\\work\\b.ts"],
  });
  await page.getByLabel("a.ts", { exact: true }).click();
  await expect(page.getByRole("tab", { selected: true })).toContainText("a.ts");
  await searchFor(page, "needle");
  await expect(status(page)).toHaveText("2 matches in 2 files");
  await results(page)
    .getByTitle(/a\.ts:2/)
    .click();
  // "const a = 1;\n" is 13 characters, "let " 4 more: the match is 17 to 23.
  await expect.poll(() => editorSelections(page)).toEqual([{ start: 17, end: 23 }]);
  await expect(appAlert(page)).toHaveCount(0);
});

test("a result in a closed CRLF file opens it at the match", async ({ page }) => {
  await desktop(page, FILES);
  await searchFor(page, "needle");
  await results(page)
    .getByTitle(/b\.ts:2/)
    .click();
  await expect(page.getByRole("tab", { selected: true })).toContainText("b.ts");
  // The editor holds "one\ntwo needle\n": the match is 8 to 14.
  await expect.poll(() => editorSelections(page)).toEqual([{ start: 8, end: 14 }]);
});

test("a result whose line changed since says so, and moves nothing", async ({ page }) => {
  await desktop(page, FILES);
  await searchFor(page, "needle");
  await expect(status(page)).toHaveText("2 matches in 2 files");
  await page.evaluate(() => {
    (window as unknown as { __disk: Record<string, string> }).__disk["C:\\work\\b.ts"] =
      "one\r\nchanged\r\n";
  });
  await results(page)
    .getByTitle(/b\.ts:2/)
    .click();
  await expect(appAlert(page)).toContainText("This search result changed");
});

test("Replace with preview rewrites a closed CRLF file in its own line endings, and Undo restores it", async ({
  page,
}) => {
  await desktop(page, FILES);
  await page.keyboard.press("Control+Shift+h");
  await searchFor(page, "needle");
  await expect(status(page)).toHaveText("2 matches in 2 files");
  await page.getByRole("textbox", { name: "Workspace replacement" }).fill("pin");
  // Only b.ts: a.ts's match is left out.
  await page.getByRole("checkbox", { name: /a\.ts:2/ }).uncheck();
  await page.getByTitle("Preview Replacements").click();
  await page.getByRole("button", { name: "Apply 1 reviewed files" }).click();
  await expect(status(page)).toContainText("1 files updated");
  expect((await disk(page))["C:\\work\\b.ts"]).toBe("one\r\ntwo pin\r\n");
  expect((await disk(page))["C:\\work\\a.ts"]).toBe(FILES["C:\\work\\a.ts"]);
  await page.getByRole("button", { name: /Undo last replacement/ }).click();
  await expect(status(page)).toContainText("1 files restored");
  expect((await disk(page))["C:\\work\\b.ts"]).toBe(FILES["C:\\work\\b.ts"]);
});

test("Replace All in an open CRLF document edits the editor's text, not a stale error", async ({
  page,
}) => {
  await desktop(page, FILES);
  await page.getByLabel("b.ts", { exact: true }).click();
  await expect(page.getByRole("tab", { selected: true })).toContainText("b.ts");
  await page.keyboard.press("Control+Shift+h");
  await searchFor(page, "needle");
  await page.getByRole("textbox", { name: "Workspace replacement" }).fill("pin");
  await page.getByRole("checkbox", { name: /a\.ts:2/ }).uncheck();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByTitle("Replace All in Selection").click();
  await expect(status(page)).toContainText("1 files updated");
  await expect(status(page)).not.toContainText("stale");
  // An undoable edit in the open document; the file on disk is not written behind its back.
  await expect.poll(() => editorText(page)).toBe("one\ntwo pin\n");
  expect((await disk(page))["C:\\work\\b.ts"]).toBe(FILES["C:\\work\\b.ts"]);
  await page.getByRole("button", { name: /Undo last replacement/ }).click();
  await expect.poll(() => editorText(page)).toBe("one\ntwo needle\n");
});

test("a running search can be cancelled, and says so", async ({ page }) => {
  await desktop(page, FILES);
  await page.evaluate(() => {
    (window as unknown as { __searchDelay: number }).__searchDelay = 3000;
  });
  await searchFor(page, "needle");
  // Running natively (past the panel's typing delay), then cancelled.
  await expect.poll(() => calls(page, "search_project")).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(status(page)).toHaveText("Search cancelled");
  await expect.poll(() => calls(page, "cancel_search")).toBeGreaterThan(0);
  // Its late answer shows nothing.
  await page.waitForTimeout(3200);
  await expect(results(page).getByTitle(/needle/)).toHaveCount(0);
  await expect(status(page)).toHaveText("Search cancelled");
});

test("'Open Files Only' searches just the open documents, with their unsaved edits", async ({
  page,
}) => {
  await desktop(page, FILES);
  await page.getByLabel("a.ts", { exact: true }).click();
  await page.locator("[data-editor=monaco] .view-lines").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("// another needle");
  await searchFor(page, "needle");
  await expect(status(page)).toHaveText("3 matches in 2 files");
  await page.getByRole("button", { name: /Files to include \/ exclude & scope/ }).click();
  await page.getByRole("combobox", { name: "Search scope" }).selectOption("open");
  await expect(status(page)).toHaveText("2 matches in 1 files");
  await expect(results(page).getByTitle(/b\.ts/)).toHaveCount(0);
});

test("the status line says why results are missing, not a blanket cap", async ({ page }) => {
  await desktop(page, FILES);
  const one = JSON.stringify({
    type: "match",
    data: {
      path: { text: "a.ts" },
      lines: { text: "let needle = 2;\n" },
      line_number: 2,
      submatches: [{ start: 4, end: 10 }],
    },
  });
  await page.evaluate((record) => {
    (window as unknown as { __searchAnswer: unknown }).__searchAnswer = {
      stdout: `${record}\n{"type":"ma`,
      stderr: "",
      code: 0,
      truncated: true,
    };
  }, one);
  await searchFor(page, "needle");
  await expect(status(page)).toHaveText(
    "1 matches in 1 files (output limit reached; results incomplete)",
  );
  await expect(status(page)).not.toContainText("10,000");
});

test("a search of a workspace left behind shows nothing in the next one", async ({ page }) => {
  await desktop(page, FILES, { "C:\\other\\c.ts": "nothing here\n" });
  await page.evaluate(() => {
    const w = window as unknown as { __searchDelay: number; __openFolder: string };
    w.__searchDelay = 1500;
    w.__openFolder = "C:\\other";
  });
  await searchFor(page, "needle");
  await page.getByRole("menubar").getByRole("menuitem", { name: "File", exact: true }).click();
  await page
    .getByRole("menu", { name: "File", exact: true })
    .getByRole("menuitem", { name: "Open Folder…", exact: true })
    .click();
  await expect(page.getByText(/Working in other/)).toBeVisible();
  await page.waitForTimeout(1800);
  await page.keyboard.press("Control+Shift+f");
  // The new workspace's panel starts empty: nothing of the old search arrives in it.
  await expect(results(page).getByTitle(/needle/)).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Search workspace" })).toHaveValue("");
});
