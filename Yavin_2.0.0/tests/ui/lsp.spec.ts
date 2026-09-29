import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { installFakeLsp, withLsp } from "./lsp-harness";
import { appAlert, editorInput, editorSelections, expectText } from "./editor-harness";

async function menu(page: Page, name: string, action: string) {
  await page.getByRole("menubar").getByRole("menuitem", { name, exact: true }).click();
  await page
    .getByRole("menu", { name, exact: true })
    .getByRole("menuitem", { name: action, exact: true })
    .click();
}

/** `files`, plus `big`: files generated in the page, `size` characters of numbered lines. */
async function fixture(
  page: Page,
  files: Record<string, string>,
  big: Record<string, number> = {},
  dialog: string | null = null,
) {
  await page.addInitScript(
    ({ initial, sizes, openDialog }) => {
      const disk: Record<string, string> = { ...initial };
      for (const [path, size] of Object.entries(sizes)) {
        const line = "const value = 'the quick brown fox jumps over the lazy dog'; // ";
        const parts: string[] = [];
        let length = 0;
        for (let n = 1; length < size; n++) {
          const next = `${line}${n}\n`;
          parts.push(next);
          length += next.length;
        }
        disk[path] = parts.join("").slice(0, size);
      }
      const callbacks: Record<number, (event: unknown) => void> = {};
      const listeners: Record<string, number[]> = {};
      let nextId = 1;
      let operation = 0;
      const calls: string[] = [];
      Object.assign(window, {
        __disk: disk,
        __calls: calls,
        __failWrite: false,
        __saveTarget: null as string | null,
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
            calls.push(command);
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
            if (command === "write_file_guarded") {
              if ((window as unknown as { __failWrite: boolean }).__failWrite)
                throw "Disk write denied.";
              if (disk[path] !== args.expected)
                throw "File changed on disk. Reopen or review its current contents before saving.";
              disk[path] = args.content as string;
              return ++operation;
            }
            if (command === "create_file_with_content") {
              if (path in disk) throw `File already exists: ${path}`;
              disk[path] = args.content as string;
              return ++operation;
            }
            if (command === "rename_path") {
              const [from, to] = [args.oldPath as string, args.newPath as string];
              if (to in disk) throw `Destination already exists: ${to}`;
              disk[to] = disk[from];
              delete disk[from];
              return ++operation;
            }
            if (command === "open_file_dialog") return openDialog;
            if (command === "save_file_dialog")
              return (window as unknown as { __saveTarget: string | null }).__saveTarget;
            return null;
          },
        },
        __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      });
    },
    { initial: files, sizes: big, openDialog: dialog },
  );
  await page.goto("/");
  await expect(page.getByText("work", { exact: true }).first()).toBeVisible();
}

const disk = (page: Page, path: string) =>
  page.evaluate(
    (file) => (window as unknown as { __disk: Record<string, string> }).__disk[file],
    path,
  );

/**
 * Language servers in the editor, end to end but for the process: the real manager, client,
 * JSON-RPC and Monaco adapter, talking to the deterministic fake server (`fakeServer.ts`)
 * where a native process would be. The file system is the fixture's.
 */

const status = (page: Page) => page.getByRole("button", { name: /^Language server:/ });

/** Opens `name` and waits for its language server to be ready. */
async function openServed(page: Page, name: string) {
  await page.getByRole("treeitem", { name, exact: true }).click();
  await expect(editorInput(page, name)).toBeFocused();
  await expect(status(page)).toHaveAccessibleName("Language server: TypeScript");
}

/** The screen position of the first occurrence of `word` in the editor. */
async function wordBox(page: Page, word: string) {
  const token = page
    .locator("[data-editor=monaco] .view-line span span", { hasText: new RegExp(`^${word}$`) })
    .first();
  await expect(token).toBeVisible();
  return token;
}

test("completion: the server's items appear as you type, and a snippet is inserted", async ({
  page,
}) => {
  await installFakeLsp(page);
  await fixture(page, { "/work/a.ts": "let value = 1;\n" });
  await openServed(page, "a.ts");
  await page.keyboard.press("Control+End");
  await page.keyboard.type("fake");
  const suggest = page.locator(".suggest-widget");
  await expect(suggest).toBeVisible();
  await expect(suggest).toContainText("fakeFunction");
  await expect(suggest).toContainText("fakeText");
  await page.keyboard.press("Enter");
  await expectText(page, "let value = 1;\nfakeFunction(a, b)");
});

test("hover: the server's hover appears over a word, as text", async ({ page }) => {
  await installFakeLsp(page);
  await fixture(page, { "/work/a.ts": "let value = 1;\n" });
  await openServed(page, "a.ts");
  await (await wordBox(page, "value")).hover();
  const hover = page.locator(".monaco-hover").filter({ hasText: "A fake hover for" });
  await expect(hover).toBeVisible();
  await expect(hover).toContainText("value");
});

test("diagnostics: squiggles in the editor and the problem in the Problems view", async ({
  page,
}) => {
  await installFakeLsp(page);
  await fixture(page, { "/work/a.ts": "// TODO later\nlet x = error;\n" });
  await openServed(page, "a.ts");
  await expect(page.locator("[data-editor=monaco] .squiggly-warning")).toHaveCount(1);
  await expect(page.locator("[data-editor=monaco] .squiggly-error")).toHaveCount(1);
  await page.getByTitle("1 error, 1 warning").click();
  const problems = page.getByRole("region", { name: "Problems" });
  await expect(problems).toContainText("TODO left in code");
  await expect(problems).toContainText("Something is wrong");
  // Fixed in the editor: the problem goes, from both.
  await page.locator("[data-editor=monaco] .view-lines").click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Shift+End");
  await page.keyboard.type("// done");
  await expect(page.locator("[data-editor=monaco] .squiggly-warning")).toHaveCount(0);
  await expect(problems).not.toContainText("TODO left in code");
});

test("definition: F12 opens the file it is in, with the name selected", async ({ page }) => {
  await installFakeLsp(page);
  await fixture(page, { "/work/a.ts": "function helper() {}\n", "/work/b.ts": "helper();\n" });
  await openServed(page, "a.ts");
  await openServed(page, "b.ts");
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("F12");
  await expect(page.getByRole("tab", { selected: true })).toContainText("a.ts");
  // The cursor at the start of the definition, as VS Code puts it.
  await expect.poll(() => editorSelections(page)).toEqual([{ start: 9, end: 9 }]);
});

test("references: Shift+F12 lists every use, and choosing one goes there", async ({ page }) => {
  await installFakeLsp(page);
  await fixture(page, {
    "/work/a.ts": "function helper() {}\nhelper();\n",
    "/work/b.ts": "let x = 1;\nhelper();\n",
  });
  await openServed(page, "b.ts");
  await openServed(page, "a.ts");
  // Onto "helper": past "function", then to the end of the name.
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+ArrowRight");
  await page.keyboard.press("Control+ArrowRight");
  await page.keyboard.press("Shift+F12");
  const list = page.getByRole("dialog", { name: /References to helper \(3\)/ });
  await expect(list).toBeVisible();
  await list.getByRole("option", { name: /b\.ts:2:1/ }).click();
  await expect(page.getByRole("tab", { selected: true })).toContainText("b.ts");
  await expect.poll(() => editorSelections(page)).toEqual([{ start: 11, end: 17 }]);
});

test("rename: F2 renames the symbol in every file, through the Document Model", async ({
  page,
}) => {
  await installFakeLsp(page);
  await fixture(page, {
    "/work/a.ts": "function helper() {}\n",
    "/work/b.ts": "helper();\nhelper();\n",
  });
  await openServed(page, "b.ts");
  await openServed(page, "a.ts");
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+ArrowRight");
  await page.keyboard.press("Control+ArrowRight");
  await page.keyboard.press("F2");
  const input = page.locator(".rename-box input, .rename-input").first();
  await expect(input).toBeFocused();
  await page.keyboard.press("Control+a");
  await page.keyboard.type("assist");
  await page.keyboard.press("Enter");
  await expectText(page, "function assist() {}\n");
  await page.getByRole("tab", { name: /b\.ts/ }).click();
  await expectText(page, "assist();\nassist();\n");
  // Edited, not written: both are unsaved until the user saves.
  await expect(page.getByTitle("Unsaved changes (Ctrl+S to save)")).toHaveCount(2);
  expect(await disk(page, "/work/b.ts")).toBe("helper();\nhelper();\n");
});

test("formatting: Format Document applies the server's edits", async ({ page }) => {
  await installFakeLsp(page);
  await fixture(page, { "/work/a.ts": "let a = 1;   \n\tlet b = 2;\n" });
  await openServed(page, "a.ts");
  await menu(page, "Edit", "Format Document");
  await expectText(page, "let a = 1;\n  let b = 2;\n");
});

test("code actions: Ctrl+. offers the server's quick fix, and applying it edits the file", async ({
  page,
}) => {
  await installFakeLsp(page);
  await fixture(page, { "/work/a.ts": "// TODO later\n" });
  await openServed(page, "a.ts");
  await expect(page.locator("[data-editor=monaco] .squiggly-warning")).toHaveCount(1);
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+ArrowRight");
  await page.keyboard.press("Control+.");
  const fix = page.getByText("Replace TODO with DONE");
  await expect(fix).toBeVisible();
  await fix.click();
  await expectText(page, "// DONE later\n");
});

test("signature help: the parameters appear inside a call", async ({ page }) => {
  await installFakeLsp(page);
  await fixture(page, { "/work/a.ts": "" });
  await openServed(page, "a.ts");
  await page.keyboard.type("fakeFunction(1, ");
  const hints = page.locator(".parameter-hints-widget");
  await expect(hints).toBeVisible();
  await expect(hints).toContainText("fakeFunction(a: number, b: string): void");
});

test("a crashed server restarts and its diagnostics come back", async ({ page }) => {
  await installFakeLsp(page);
  await fixture(page, { "/work/a.ts": "let x = error;\n" });
  await openServed(page, "a.ts");
  await expect(page.locator("[data-editor=monaco] .squiggly-error")).toHaveCount(1);
  await withLsp(page, "(lsp) => lsp.server('typescript').crash(1)");
  await expect(status(page)).toHaveAccessibleName(/restarting|crashed/);
  await expect(status(page)).toHaveAccessibleName("Language server: TypeScript");
  await expect.poll(() => withLsp<number>(page, "(lsp) => lsp.started().length")).toBe(2);
  await expect(page.locator("[data-editor=monaco] .squiggly-error")).toHaveCount(1);
});

test("a stale answer is ignored: a definition that arrives after an edit goes nowhere", async ({
  page,
}) => {
  await installFakeLsp(page, {
    options: { typescript: { delays: { "textDocument/definition": 600 } } },
  });
  await fixture(page, { "/work/a.ts": "function helper() {}\n", "/work/b.ts": "helper();\n" });
  await openServed(page, "a.ts");
  await openServed(page, "b.ts");
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("F12");
  // Typed while the server works: its answer is about text that no longer exists.
  await page.keyboard.press("End");
  await page.keyboard.type(" // moved on");
  await page.waitForTimeout(1_200);
  await expect(page.getByRole("tab", { selected: true })).toContainText("b.ts");
});

test("a read-only file is analysed, but a rename that would change it is refused", async ({
  page,
}) => {
  await installFakeLsp(page, { readOnly: ["locked.ts"] });
  await fixture(page, {
    "/work/locked.ts": "function helper() {}\nlet x = error;\n",
    "/work/b.ts": "helper();\n",
  });
  await openServed(page, "locked.ts");
  // Analysed: its diagnostics show.
  await expect(page.locator("[data-editor=monaco] .squiggly-error")).toHaveCount(1);
  await openServed(page, "b.ts");
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("F2");
  const input = page.locator(".rename-box input, .rename-input").first();
  await expect(input).toBeFocused();
  await page.keyboard.press("Control+a");
  await page.keyboard.type("assist");
  await page.keyboard.press("Enter");
  await expect(appAlert(page)).toContainText("locked.ts is read-only");
  await expectText(page, "helper();\n");
  await page.getByRole("tab", { name: /locked\.ts/ }).click();
  await expectText(page, "function helper() {}\nlet x = error;\n");
});

test("with no server installed, or in Restricted Mode, the status bar says so plainly", async ({
  page,
  browser,
}) => {
  await installFakeLsp(page, { installed: [] });
  await fixture(page, { "/work/a.ts": "let x = 1;\n" });
  await page.getByRole("treeitem", { name: "a.ts" }).click();
  await expect(status(page)).toHaveAccessibleName("Language server: TypeScript: not installed");
  // Nothing pretends: no completion without a server.
  await page.keyboard.press("Control+End");
  await page.keyboard.type("fak");
  await page.waitForTimeout(400);
  await expect(page.locator(".suggest-widget.visible")).toHaveCount(0);

  const restricted = await browser.newPage();
  await installFakeLsp(restricted, { trusted: false });
  await fixture(restricted, { "/work/a.ts": "let x = 1;\n" });
  await restricted.getByRole("treeitem", { name: "a.ts" }).click();
  await expect(status(restricted)).toHaveAccessibleName(
    "Language server: TypeScript: Restricted Mode",
  );
  expect(await withLsp<number>(restricted, "(lsp) => lsp.started().length")).toBe(0);
  await restricted.close();
});

test("symbols: @ lists the file's symbols and # the workspace's; choosing one goes there", async ({
  page,
}) => {
  await installFakeLsp(page);
  await fixture(page, {
    "/work/a.ts": "class Shape {\n  function area() {}\n}\nfunction helper() {}\n",
    "/work/b.ts": "function other() {}\n",
  });
  await openServed(page, "b.ts");
  await openServed(page, "a.ts");
  await page.keyboard.press("Control+p");
  await page.keyboard.type("@");
  const results = page.getByRole("listbox", { name: "Results" });
  await expect(results.getByRole("option")).toHaveCount(3);
  await expect(results).toContainText("method · Shape".replace("method", "function"));
  await page.keyboard.type("hel");
  await page.keyboard.press("Enter");
  await expect.poll(() => editorSelections(page)).toEqual([{ start: 46, end: 52 }]);

  await page.keyboard.press("Control+t");
  await page.keyboard.type("oth");
  await expect(results.getByRole("option", { name: /other/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tab", { selected: true })).toContainText("b.ts");
});

test("semantic tokens, inlay hints, CodeLens and document links come from the server", async ({
  page,
}) => {
  await installFakeLsp(page);
  await fixture(page, {
    "/work/a.ts": 'import x from "./b.ts";\nfunction helper() {}\nlet count = 1;\nhelper();\n',
    "/work/b.ts": "export {};\n",
  });
  await openServed(page, "a.ts");
  const lines = page.locator("[data-editor=monaco] .view-lines");
  // Inlay hint: the type after `count`.
  await expect(lines).toContainText(": number");
  // CodeLens above the function, resolved to a reference count.
  await expect(page.locator("[data-editor=monaco] .codelens-decoration")).toContainText(
    "1 reference",
  );
  // A link on the import, drawn as one.
  // (Drawn in as many pieces as the path has tokens.)
  await expect
    .poll(async () =>
      (await page.locator("[data-editor=monaco] .detected-link").allTextContents()).join(""),
    )
    .toBe("./b.ts");
  // Semantic tokens: the full set first, then deltas as the text changes.
  const methods = () =>
    withLsp<string[]>(page, "(lsp) => lsp.server('typescript').received.map((m) => m.method)");
  await expect
    .poll(async () => (await methods()).includes("textDocument/semanticTokens/full"))
    .toBe(true);
  await page.keyboard.press("Control+End");
  await page.keyboard.type("let more = 2;");
  await expect
    .poll(async () => (await methods()).includes("textDocument/semanticTokens/full/delta"))
    .toBe(true);
  await expect(lines).toContainText("let more: number = 2;");
});

test("outline and breadcrumbs: the file's symbols, the one the cursor is in, and going there", async ({
  page,
}) => {
  await installFakeLsp(page);
  await fixture(page, {
    "/work/a.ts":
      "class Shape {\n  function area() {\n    return 1;\n  }\n}\nfunction helper() {}\n",
  });
  await openServed(page, "a.ts");
  const outline = page.getByRole("region", { name: "Outline" });
  // Collapsed until opened, as VS Code's is.
  await expect(outline.getByRole("button", { name: "Outline" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await outline.getByRole("button", { name: "Outline" }).click();
  const symbols = outline.getByRole("treeitem");
  await expect(symbols).toHaveText(["CShape", "Farea", "Fhelper"]);

  // Choosing a symbol puts the cursor on its name; the breadcrumbs follow the cursor.
  await outline.getByRole("treeitem", { name: /^area/ }).click();
  await expect.poll(() => editorSelections(page)).toEqual([{ start: 25, end: 25 }]);
  const crumbs = page.getByRole("navigation", { name: "Symbol breadcrumbs" });
  await expect(crumbs.getByRole("button")).toHaveText(["CShape", "Farea"]);
  await expect(outline.getByRole("treeitem", { selected: true })).toHaveText("Farea");
  await crumbs.getByRole("button", { name: /^Shape/ }).click();
  await expect.poll(() => editorSelections(page)).toEqual([{ start: 6, end: 6 }]);
  await expect(crumbs.getByRole("button")).toHaveText(["CShape"]);

  // An edit is reflected a moment later.
  await page.keyboard.press("Control+End");
  await page.keyboard.type("function added");
  await expect(symbols).toHaveText(["CShape", "Farea", "Fhelper", "Fadded"]);
  await expect(crumbs.getByRole("button")).toHaveText(["Fadded"]);

  // A symbol with children folds; the section itself folds too.
  await outline
    .getByRole("treeitem", { name: /^Shape/ })
    .locator("span")
    .first()
    .click();
  await expect(symbols).toHaveText(["CShape", "Fhelper", "Fadded"]);
  await outline.getByRole("button", { name: "Outline" }).click();
  await expect(symbols).toHaveCount(0);
  await outline.getByRole("button", { name: "Outline" }).click();
  await expect(symbols).toHaveCount(3);
});
