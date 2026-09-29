import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  appAlert,
  editorInput,
  editorLanguage,
  editorOptions,
  editorSelections,
  editorText,
  editorTokenTypes,
  expectText,
  fillEditor,
  setEditorSelections,
  withEditor,
} from "./editor-harness";

/**
 * Monaco as Yavin's editor: syntax colouring, its native editing features, one model per
 * document for as long as the document is open, and the extension points later modules build
 * on (decorations, the diff editor, read-only views). The native side is a fake filesystem.
 */

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

const open = async (page: Page, name: string) => {
  await page.getByLabel(name, { exact: true }).click();
  const input = editorInput(page, name);
  await expect(input).toBeFocused();
  return input;
};
const modelCount = () =>
  (window as unknown as { __yavinMonaco: { modelCount(): number } }).__yavinMonaco.modelCount();

test("each language is coloured by Monaco's tokenizer for it", async ({ page }) => {
  const files: Record<string, [string, string]> = {
    "a.ts": ["const answer: number = 42;", "typescript"],
    "b.js": ["function hello() { return 'hi'; }", "javascript"],
    "c.py": ["def hello():\n    return 'hi'", "python"],
    "d.rs": ["fn main() { let x = 1; }", "rust"],
    // JSON keeps its own language id; the JavaScript tokenizer colours it.
    "e.json": ['{ "name": "yavin", "version": 1 }', "json"],
    "f.md": ["# Title\n\nSome *text*.", "markdown"],
    "g.toml": ['[package]\nname = "yavin"', "ini"],
    ".env.local": ["API_URL=https://example.test", "ini"],
    "h.cmd": ["@echo off\nset NAME=yavin", "bat"],
    "i.mdx": ["# Title\n\n<Note>text</Note>", "mdx"],
  };
  await fixture(
    page,
    Object.fromEntries(Object.entries(files).map(([name, [text]]) => [`/work/${name}`, text])),
  );
  for (const [name, [text, language]] of Object.entries(files)) {
    await open(page, name);
    await expectText(page, text);
    expect(await editorLanguage(page), name).toBe(language);
    await expect
      .poll(async () => ((await editorTokenTypes(page, 1)) ?? []).some((type) => type !== ""), {
        message: `${name} has coloured tokens`,
      })
      .toBe(true);
  }
});

test("the editor loads and colours every language without an error", async ({ page }) => {
  // Fourteen files, each loading its language's tokenizer for the first time.
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("favicon"))
      errors.push(message.text());
  });
  const names = [
    ...["a.ts", "b.json", "c.py", "d.rs", "e.md", "f.css", "g.html", "h.yaml", "i.sh"],
    ...["j.mdx", "k.cmd", "l.cfg", "m.cxx", ".env"],
  ];
  await fixture(page, Object.fromEntries(names.map((name) => [`/work/${name}`, "x = [1, 2]\n"])));
  for (const name of names) {
    await open(page, name);
    await expect
      .poll(async () => ((await editorTokenTypes(page, 1)) ?? []).length)
      .toBeGreaterThan(0);
  }
  // Monaco's own diff computation runs in its worker.
  await withEditor(page, "(editor, t) => editor.diff(t)", "y = 1\n");
  expect(errors.filter((error) => !error.includes("Failed to load resource"))).toEqual([]);
});

test("brackets close themselves and match; two cursors type at once", async ({ page }) => {
  await fixture(page, { "/work/a.ts": "f" });
  await open(page, "a.ts");
  // A language's bracket rules come with its tokenizer, loaded when a document first needs it.
  await expect
    .poll(async () => ((await editorTokenTypes(page, 1)) ?? []).some((type) => type !== ""))
    .toBe(true);
  await page.keyboard.press("End");
  await page.keyboard.type("(");
  await expectText(page, "f()");
  // The matching pair is highlighted (side by side, "()" is drawn as one highlight).
  await expect(page.locator("[data-editor=monaco] .bracket-match").first()).toBeAttached();
  await fillEditor(page, "a\nb\n");
  await setEditorSelections(page, [
    { start: 0, end: 0 },
    { start: 2, end: 2 },
  ]);
  await page.keyboard.type("x");
  await expectText(page, "xa\nxb\n");
});

test("folding hides a block and shows it again", async ({ page }) => {
  await fixture(page, { "/work/a.ts": "function f() {\n  one();\n  two();\n}\n" });
  await open(page, "a.ts");
  const lines = () => withEditor<[number, number]>(page, "(editor) => editor.lines()");
  await expect.poll(async () => (await lines())?.[0]).toBe(5);
  await withEditor(page, "(editor) => editor.run('editor.foldAll')");
  await expect.poll(async () => (await lines())?.[0]).toBe(3);
  await withEditor(page, "(editor) => editor.run('editor.unfoldAll')");
  await expect.poll(async () => (await lines())?.[0]).toBe(5);
});

test("one model per open document: reused across tabs, disposed when it closes", async ({
  page,
}) => {
  await fixture(page, { "/work/a.ts": "a", "/work/b.ts": "b" });
  await open(page, "a.ts");
  await open(page, "b.ts");
  await expect.poll(() => page.evaluate(modelCount)).toBe(2);
  await page.getByRole("tab", { name: /a\.ts/ }).click();
  await page.getByRole("tab", { name: /b\.ts/ }).click();
  await page.getByRole("tab", { name: /a\.ts/ }).click();
  await expect.poll(() => page.evaluate(modelCount)).toBe(2);
  await page.getByRole("button", { name: "Close b.ts" }).click();
  await expect.poll(() => page.evaluate(modelCount)).toBe(1);
  await menu(page, "File", "Close All Editors");
  await expect.poll(() => page.evaluate(modelCount)).toBe(0);
});

test("a rename keeps the document's model, and Undo still takes back what was typed", async ({
  page,
}) => {
  await fixture(page, { "/work/a.ts": "one" });
  await open(page, "a.ts");
  await page.keyboard.press("End");
  await page.keyboard.type(" two");
  await expectText(page, "one two");
  await page.getByRole("treeitem", { name: "a.ts", exact: true }).focus();
  await page.keyboard.press("F2");
  const rename = page.getByRole("tree", { name: "Files" }).getByRole("textbox");
  await rename.fill("z.ts");
  await rename.press("Enter");
  await expect(editorInput(page, "z.ts")).toBeAttached();
  await expect.poll(() => page.evaluate(modelCount)).toBe(1);
  await menu(page, "Edit", "Undo");
  await expectText(page, "one");
});

test("Save As keeps the model: the new file's editor still undoes the typing", async ({ page }) => {
  await fixture(page, {});
  await menu(page, "File", "New Text File");
  await expect(editorInput(page, "Untitled-1")).toBeFocused();
  await page.keyboard.type("hello");
  await page.evaluate(() => {
    (window as unknown as { __saveTarget: string }).__saveTarget = "/work/hello.txt";
  });
  await page.keyboard.press("Control+s");
  await expect(editorInput(page, "hello.txt")).toBeAttached();
  await expect.poll(() => page.evaluate(modelCount)).toBe(1);
  await menu(page, "Edit", "Undo");
  await expectText(page, "");
});

test("decorations are set and cleared per owner", async ({ page }) => {
  await fixture(page, { "/work/a.ts": "one two three" });
  await open(page, "a.ts");
  const decorate = (owner: string, decorations: unknown[]) =>
    withEditor(page, "(editor, [o, d]) => editor.decorate(o, d)", [owner, decorations]);
  await decorate("search", [{ start: 0, end: 3, className: "test-search-match" }]);
  await decorate("git", [{ start: 4, end: 7, className: "test-git-change" }]);
  await expect(page.locator(".test-search-match")).toHaveCount(1);
  await expect(page.locator(".test-git-change")).toHaveCount(1);
  await decorate("search", []);
  await expect(page.locator(".test-search-match")).toHaveCount(0);
  await expect(page.locator(".test-git-change")).toHaveCount(1);
});

test("the diff editor compares an original with the document, the original read-only", async ({
  page,
}) => {
  await fixture(page, { "/work/a.ts": "one\ntwo\nthree\n" });
  await open(page, "a.ts");
  const result = await withEditor<{ changes: number; originalReadOnly: boolean }>(
    page,
    "(editor, text) => editor.diff(text)",
    "one\nTWO\nthree\n",
  );
  expect(result).toEqual({ changes: 1, originalReadOnly: true });
  // The original was the view's and went with it; the document's model stays.
  await expect.poll(() => page.evaluate(modelCount)).toBe(1);
});

test("a read-only editor does not change its document", async ({ page }) => {
  await fixture(page, { "/work/a.ts": "fixed" });
  await open(page, "a.ts");
  await withEditor(page, "(editor) => editor.setReadOnly(true)");
  expect((await editorOptions(page))?.readOnly).toBe(true);
  await page.keyboard.type("typed");
  await expectText(page, "fixed");
  await expect(page.getByTitle("Unsaved changes (Ctrl+S to save)")).toHaveCount(0);
});

test("a document's text is shown as text, never run as markup", async ({ page }) => {
  const text = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>';
  await fixture(page, { "/work/page.html": text });
  await open(page, "page.html");
  await expectText(page, text);
  await expect(page.locator("[data-editor=monaco] .view-lines")).toContainText("<img src=x");
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBe(
    undefined,
  );
  await expect(page.locator("[data-editor=monaco] img, [data-editor=monaco] script")).toHaveCount(
    0,
  );
  expect(await editorText(page)).toBe(text);
});

test("copy and cut with nothing selected take the whole line, as Monaco does", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await fixture(page, { "/work/a.ts": "one\ntwo\n" });
  await open(page, "a.ts");
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+c");
  // The system clipboard may turn the line's ending into CRLF.
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
  await expect.poll(async () => (await clipboard()).replace(/\r\n/g, "\n")).toBe("one\n");
  await page.keyboard.press("Control+x");
  await expectText(page, "two\n");
  await page.keyboard.press("Control+v");
  await expectText(page, "one\ntwo\n");
});

test("editing keys in the Explorer never reach into the editor", async ({ page }) => {
  await fixture(page, { "/work/a.ts": "one", "/work/b.ts": "two" });
  await open(page, "a.ts");
  await page.keyboard.press("End");
  await page.keyboard.type("!");
  await expectText(page, "one!");
  const row = page.getByRole("treeitem", { name: "b.ts" });
  await row.focus();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Control+z");
  await expect(row).toBeFocused();
  await expectText(page, "one!");
  expect(await editorSelections(page)).toEqual([{ start: 4, end: 4 }]);
});

test("Escape from Go to Line gives the keyboard back to the editor", async ({ page }) => {
  await fixture(page, { "/work/a.ts": "one\ntwo" });
  const input = await open(page, "a.ts");
  await page.keyboard.press("Control+g");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(input).toBeFocused();
  await page.keyboard.type("x");
  await expectText(page, "xone\ntwo");
});

test("closing the tab in front brings the tab beside it forward, not Welcome", async ({ page }) => {
  await fixture(page, { "/work/a.ts": "a", "/work/b.ts": "b", "/work/c.ts": "c" });
  await open(page, "a.ts");
  await open(page, "b.ts");
  await open(page, "c.ts");
  const selected = page.getByRole("tab", { selected: true });
  await page.getByRole("tab", { name: /b\.ts/ }).click();
  await page.keyboard.press("Control+w");
  // The one to the right comes forward...
  await expect(selected).toContainText("c.ts");
  await page.keyboard.press("Control+w");
  // ...and with none to the right, the one to the left.
  await expect(selected).toContainText("a.ts");
});

test("an editor whose code fails to load says so in its own area, and how to recover", async ({
  page,
}) => {
  // The editor's code does not arrive, as with a damaged install.
  await page.route(/\/CodeEditor\.tsx/, (route) => route.abort());
  await fixture(page, { "/work/a.ts": "kept" });
  await page.getByRole("treeitem", { name: "a.ts" }).click();
  const failure = page.getByRole("alert").filter({ hasText: "could not be loaded" });
  await expect(failure).toBeVisible();
  // A retry cannot load code the browser has already failed, so the way out is a reload,
  // after saving -- which works without the editor.
  await expect(failure).toContainText("Save All");
  await expect(failure.getByRole("button", { name: "Reload Window" })).toBeVisible();
  // Only the editor area failed: the tab, the menus and the Explorer are all still there.
  await expect(page.getByRole("tab", { name: /a\.ts/ })).toBeVisible();
  await expect(page.getByRole("menubar")).toBeVisible();
  await expect(page.getByRole("tree", { name: "Files" })).toBeVisible();
});

test("an editor that fails to start is contained, and Retry starts it again", async ({ page }) => {
  // Monaco fails the first time it starts: marking its own element as a keybinding context,
  // which it does while creating the editor, throws once.
  await page.addInitScript(() => {
    const setAttribute = Element.prototype.setAttribute;
    let failed = false;
    Element.prototype.setAttribute = function (name: string, value: string) {
      if (!failed && name === "data-keybinding-context" && this.closest("[data-editor=monaco]")) {
        failed = true;
        throw new Error("simulated start failure");
      }
      return setAttribute.call(this, name, value);
    };
  });
  await fixture(page, { "/work/a.ts": "kept" });
  await page.getByRole("treeitem", { name: "a.ts" }).click();
  const failure = page.getByRole("alert").filter({ hasText: "The editor could not start" });
  await expect(failure).toContainText("simulated start failure");
  await expect(page.getByRole("tree", { name: "Files" })).toBeVisible();

  await failure.getByRole("button", { name: "Retry" }).click();
  await expect(failure).toHaveCount(0);
  await expectText(page, "kept");
});

test("the status bar shows the cursor, the selection and the file's indentation", async ({
  page,
}) => {
  await fixture(page, { "/work/a.py": "def f():\n    return 1\n" });
  await open(page, "a.py");
  const bar = page.getByRole("contentinfo");
  await expect(bar).toContainText("Ln 1, Col 1");
  // Monaco detects the file's own indentation: four spaces here.
  await expect(bar).toContainText("Spaces: 4");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  await expect(bar).toContainText("Ln 2, Col 13");
  await page.keyboard.press("Shift+Home");
  await expect(bar).toContainText("(8 selected)");
  // The position opens Go to Line.
  await bar.getByRole("button", { name: /Ln 2/ }).click();
  await expect(page.getByRole("dialog")).toContainText("Go to line");
  await page.keyboard.press("Escape");
  // No document, no cursor.
  await menu(page, "File", "Close All Editors");
  await expect(bar).not.toContainText("Ln ");
});

test("a tab's menu closes the others, those to its right, or the saved ones", async ({ page }) => {
  await fixture(page, {
    "/work/a.ts": "a",
    "/work/b.ts": "b",
    "/work/c.ts": "c",
    "/work/d.ts": "d",
  });
  for (const name of ["a.ts", "b.ts", "c.ts", "d.ts"]) await open(page, name);
  const strip = page.getByRole("tablist", { name: "Open editors" });
  const tabNames = async () =>
    (await strip.getByRole("tab").allTextContents()).map((text) => text.replace(/[^\w.]/g, ""));
  const menuOn = async (name: string, item: string) => {
    await strip.getByRole("tab", { name: new RegExp(name) }).click({ button: "right" });
    await page
      .getByRole("menu", { name: "Tab actions" })
      .getByRole("menuitem", { name: item })
      .click();
  };

  await menuOn("c\.ts", "Close to the Right");
  await expect.poll(tabNames).toEqual(["Welcome", "a.ts", "b.ts", "c.ts"]);

  // b has unsaved edits: Close Saved leaves it, and Close Others asks before losing them.
  await strip.getByRole("tab", { name: /b\.ts/ }).click();
  await page.keyboard.type("!");
  await menuOn("b\.ts", "Close Saved");
  await expect.poll(tabNames).toEqual(["b.ts"]);
  await open(page, "a.ts");
  const asked: string[] = [];
  page.once("dialog", (dialog) => {
    asked.push(dialog.message());
    void dialog.dismiss();
  });
  await menuOn("a\.ts", "Close Others");
  expect(asked).toEqual(["Discard unsaved changes in b.ts?"]);
  await expect.poll(tabNames).toEqual(["b.ts", "a.ts"]);
});

test("closed editors reopen, latest first, and the last tab can be closed too", async ({
  page,
}) => {
  await fixture(page, { "/work/a.ts": "a", "/work/b.ts": "b" });
  await open(page, "a.ts");
  await open(page, "b.ts");
  await page.keyboard.press("Control+w");
  await page.keyboard.press("Control+w");
  // Welcome was the last tab: it closes like the others, and the window shows Welcome anyway.
  await page.getByRole("button", { name: "Close Welcome" }).click();
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Welcome" })).toBeVisible();

  await page.keyboard.press("Control+Shift+t");
  await expect(page.getByRole("tab", { selected: true })).toContainText("a.ts");
  await page.keyboard.press("Control+Shift+t");
  await expect(page.getByRole("tab", { selected: true })).toContainText("b.ts");
  await expectText(page, "b");
});

test("the line commands are in the menus and act on the editor", async ({ page }) => {
  await fixture(page, { "/work/a.ts": "one\ntwo\n" });
  await open(page, "a.ts");
  await menu(page, "Selection", "Move Line Down");
  await expectText(page, "two\none\n");
  await menu(page, "Selection", "Copy Line Up");
  await expectText(page, "two\none\none\n");
  await menu(page, "Edit", "Delete Line");
  await expectText(page, "two\none\n");
  await menu(page, "Edit", "Toggle Line Comment");
  await expectText(page, "two\n// one\n");
  await menu(page, "Edit", "Indent Line");
  await expectText(page, "two\n  // one\n");
  // From the Explorer the same keys stay the Explorer's.
  await page.getByRole("treeitem", { name: "a.ts" }).focus();
  await page.keyboard.press("Alt+ArrowUp");
  await page.keyboard.press("Control+Shift+k");
  await expectText(page, "two\n  // one\n");
  // The shortcut help lists them.
  await menu(page, "Help", "Keyboard Shortcuts");
  await expect(page.getByRole("dialog")).toContainText("Move Line Up — Alt+ArrowUp");
});

test("Replace in Files opens the search with its replace field, and zoom has keys", async ({
  page,
}) => {
  await fixture(page, { "/work/a.ts": "a" });
  await open(page, "a.ts");
  await page.keyboard.press("Control+Shift+h");
  await expect(page.getByPlaceholder("Replace with (literal)…")).toBeVisible();

  await page.locator("[data-editor=monaco] .view-lines").click();
  await expect(editorInput(page, "a.ts")).toBeFocused();
  const fontSize = () =>
    page
      .locator("[data-editor=monaco] .view-lines")
      .evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
  const normal = await fontSize();
  await page.keyboard.press("Control+=");
  await expect.poll(fontSize).toBeGreaterThan(normal);
  await page.keyboard.press("Control+0");
  await expect.poll(fontSize).toBe(normal);
  await page.keyboard.press("Control+-");
  await expect.poll(fontSize).toBeLessThan(normal);
});

test("a file read-only on disk opens read-only, and can be edited anyway", async ({ page }) => {
  // The native side reports locked.ts as read-only: wrap the fixture's IPC as it installs it.
  await page.addInitScript(() => {
    let internals: { invoke: (command: string, args?: Record<string, unknown>) => unknown };
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      get: () => internals,
      set(value) {
        const invoke = value.invoke;
        internals = {
          ...value,
          invoke: (command: string, args: Record<string, unknown> = {}) =>
            command === "is_read_only"
              ? Promise.resolve(String(args.path).endsWith("locked.ts"))
              : invoke(command, args),
        };
      },
    });
  });
  await fixture(page, { "/work/locked.ts": "fixed", "/work/free.ts": "free" });
  await open(page, "locked.ts");
  const note = page.getByRole("note", { name: "Document state" });
  await expect(note).toContainText("read-only on disk");
  expect((await editorOptions(page))?.readOnly).toBe(true);
  await page.keyboard.type("x");
  await expectText(page, "fixed");

  // Other files are not affected.
  await open(page, "free.ts");
  expect((await editorOptions(page))?.readOnly).toBe(false);
  await expect(note).toHaveCount(0);

  await page.getByRole("tab", { name: /locked\.ts/ }).click();
  await note.getByRole("button", { name: "Edit Anyway" }).click();
  await expect(note).toHaveCount(0);
  await page.locator("[data-editor=monaco] .view-lines").click();
  await page.keyboard.press("End");
  await page.keyboard.type("!");
  await expectText(page, "fixed!");
});

test("a search result opens its file with the match selected, in a CRLF file too", async ({
  page,
}) => {
  // ripgrep's report of one match, as the native search returns it: the line keeps its CRLF.
  await page.addInitScript(() => {
    const match = JSON.stringify({
      type: "match",
      data: {
        path: { text: "a.ts" },
        lines: { text: "two words\r\n" },
        line_number: 2,
        submatches: [{ match: { text: "words" }, start: 4, end: 9 }],
      },
    });
    let internals: { invoke: (command: string, args?: Record<string, unknown>) => unknown };
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      get: () => internals,
      set(value) {
        const invoke = value.invoke;
        internals = {
          ...value,
          invoke: (command: string, args: Record<string, unknown> = {}) =>
            command === "search_project"
              ? Promise.resolve({
                  stdout: `${match}\n${JSON.stringify({ type: "summary", data: {} })}\n`,
                  stderr: "",
                  code: 0,
                  truncated: false,
                })
              : invoke(command, args),
        };
      },
    });
  });
  await fixture(page, { "/work/a.ts": "one\r\ntwo words\r\n" });
  await page.keyboard.press("Control+Shift+f");
  await page.getByRole("textbox", { name: "Search workspace" }).fill("words");
  const results = page
    .getByRole("region", { name: "Search results" })
    .or(page.locator("[aria-label='Search results']"));
  await results.getByText("words").first().click();

  await expect(page.getByRole("tab", { selected: true })).toContainText("a.ts");
  await expect(appAlert(page)).toHaveCount(0);
  // "one\n" is 4 characters, "two " 4 more: the match is characters 8 to 13.
  await expect.poll(() => editorSelections(page)).toEqual([{ start: 8, end: 13 }]);
});

test("a file that cannot be read says why and opens nothing", async ({ page }) => {
  await page.addInitScript(() => {
    let internals: { invoke: (command: string, args?: Record<string, unknown>) => unknown };
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      get: () => internals,
      set(value) {
        const invoke = value.invoke;
        internals = {
          ...value,
          invoke: (command: string, args: Record<string, unknown> = {}) =>
            command === "read_file_content" && String(args.path).endsWith("secret.ts")
              ? Promise.reject("Access is denied. (os error 5)")
              : invoke(command, args),
        };
      },
    });
  });
  await fixture(page, { "/work/secret.ts": "x" });
  await page.getByRole("treeitem", { name: "secret.ts" }).click();
  await expect(appAlert(page)).toContainText("Access is denied");
  await expect(page.getByRole("tab", { name: /secret\.ts/ })).toHaveCount(0);
});

test("closing the window asks before losing unsaved changes, and only then", async ({ page }) => {
  await fixture(page, { "/work/a.ts": "a" });
  await open(page, "a.ts");
  const destroyed = () =>
    page.evaluate(() =>
      (window as unknown as { __calls: string[] }).__calls.includes("plugin:window|destroy"),
    );
  const closeWindow = () =>
    page.evaluate(() =>
      (window as unknown as { __emit: (e: string, p: unknown) => void }).__emit(
        "tauri://close-requested",
        {},
      ),
    );

  await page.keyboard.type("x");
  const asked: string[] = [];
  page.once("dialog", (dialog) => {
    asked.push(dialog.message());
    void dialog.dismiss();
  });
  await closeWindow();
  await expect.poll(() => asked).toEqual(["Discard unsaved changes and close Yavin?"]);
  // Cancelled: the window stays, with the edit.
  expect(await destroyed()).toBe(false);
  await expectText(page, "xa");

  page.once("dialog", (dialog) => void dialog.accept());
  await closeWindow();
  await expect.poll(destroyed).toBe(true);
});

test("many tabs scroll without a scrollbar: by the wheel, and to the tab in front", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  const names = Array.from({ length: 14 }, (_, i) => `a_rather_long_file_name_${i}.ts`);
  await fixture(page, Object.fromEntries(names.map((name) => [`/work/${name}`, name])));
  for (const name of names) await open(page, name);
  const strip = page.getByRole("tablist", { name: "Open editors" }).locator("..");
  const box = () =>
    strip.evaluate((element: HTMLElement) => ({
      // What is left of the height after its content and borders: a scrollbar, if any.
      scrollbar:
        element.offsetHeight -
        element.clientHeight -
        parseFloat(getComputedStyle(element).borderTopWidth) -
        parseFloat(getComputedStyle(element).borderBottomWidth),
      overflows: element.scrollWidth > element.clientWidth,
      left: element.scrollLeft,
    }));
  const start = await box();
  expect(start.overflows).toBe(true);
  expect(start.scrollbar).toBe(0);
  // The last tab opened is the one in front, scrolled into view.
  await expect(page.getByRole("tab", { selected: true })).toBeInViewport();
  // The actions to the right are not part of what scrolls: fully shown, and fixed in place.
  const newFile = page.getByTitle("New File (Ctrl+N)");
  await expect(newFile).toBeInViewport({ ratio: 1 });
  const before = await newFile.boundingBox();
  await strip.hover();
  await page.mouse.wheel(0, -400);
  await expect.poll(async () => (await box()).left).toBeLessThan(start.left);
  expect(await newFile.boundingBox()).toEqual(before);
  const tabsEnd = await strip.evaluate((element) => element.getBoundingClientRect().right);
  expect(tabsEnd).toBeLessThanOrEqual(before!.x);
});

test("the editor's right-click menu ends with the Command Palette", async ({ page }) => {
  await fixture(page, { "/work/a.ts": "const a = 1;" });
  await open(page, "a.ts");
  await page.locator("[data-editor=monaco] .view-lines").click({ button: "right" });
  const items = page.locator(".monaco-menu .action-label");
  await expect(items.filter({ hasText: "Command Palette…" })).toBeVisible();
  const labels = (await items.allTextContents()).filter(Boolean);
  expect(labels.slice(0, 4)).toEqual(["Change All Occurrences", "Cut", "Copy", "Paste"]);
  expect(labels.at(-1)).toBe("Command Palette…");
  await items.filter({ hasText: "Command Palette…" }).click();
  await expect(page.getByRole("combobox", { name: "Search files or commands" })).toBeFocused();
});

test("the minimap's right-click menu changes it, and the choice is remembered", async ({
  page,
}) => {
  const lines = Array.from({ length: 200 }, (_, i) => `const line${i} = ${i};`).join("\n");
  await fixture(page, { "/work/a.ts": lines });
  await open(page, "a.ts");
  const minimap = page.locator("[data-editor=monaco] .minimap");
  await expect(minimap).toBeVisible();
  await minimap.click({ button: "right" });
  const menuOf = page.getByRole("menu", { name: "Minimap" });
  await expect(menuOf.getByRole("menuitemcheckbox", { name: "Minimap" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  // The editing menu does not open over it.
  await expect(page.locator(".monaco-menu")).toHaveCount(0);
  await menuOf.getByRole("menuitemcheckbox", { name: "Vertical Size: Fit" }).click();
  await minimap.click({ button: "right" });
  await expect(
    menuOf.getByRole("menuitemcheckbox", { name: "Vertical Size: Fit" }),
  ).toHaveAttribute("aria-checked", "true");
  await menuOf.getByRole("menuitemcheckbox", { name: "Minimap" }).click();
  await expect(minimap).toBeHidden();

  // Remembered: after a restart the minimap is still off, and View › Minimap brings it back.
  await page.reload();
  await open(page, "a.ts");
  await expect(minimap).toBeHidden();
  await page.getByRole("menubar").getByRole("menuitem", { name: "View", exact: true }).click();
  const viewMinimap = page
    .getByRole("menu", { name: "View", exact: true })
    .getByRole("menuitemcheckbox", { name: "Minimap", exact: true });
  await expect(viewMinimap).toHaveAttribute("aria-checked", "false");
  await viewMinimap.click();
  await expect(minimap).toBeVisible();
  await minimap.click({ button: "right" });
  await expect(
    menuOf.getByRole("menuitemcheckbox", { name: "Vertical Size: Fit" }),
  ).toHaveAttribute("aria-checked", "true");
});

const README = [
  "# Project",
  "",
  "See [the guide](GUIDE.md), [install](#install) or [the site](https://example.com/docs).",
  "",
  "- [x] done",
  "- [ ] to do",
  "",
  "| Name | Value |",
  "| ---- | ----- |",
  "| a    | 1     |",
  "",
  "```ts",
  "const answer: number = 42;",
  "```",
  "",
  '<img src="x" alt="logo" onerror="window.__pwned=1"><script>window.__pwned=2</script>',
  "",
  ...Array.from({ length: 60 }, (_, i) => `Filler paragraph ${i}.\n`),
  "## Install",
  "",
  "Run it.",
].join("\n");

test("a Markdown file has a preview: rendered, safe, following its links", async ({ page }) => {
  await fixture(page, {
    "/work/README.md": README,
    "/work/GUIDE.md": "# Guide",
    "/work/a.ts": "a",
  });
  // Code files have no Edit | Preview | Split.
  await open(page, "a.ts");
  const view = page.getByRole("group", { name: "Markdown view" });
  await expect(view).toHaveCount(0);

  await open(page, "README.md");
  await expect(view.getByRole("button", { name: "Edit" })).toHaveAttribute("aria-pressed", "true");
  await view.getByRole("button", { name: "Preview" }).click();
  const preview = page.getByRole("document", { name: "Preview README.md" });
  await expect(preview.getByRole("heading", { name: "Project", level: 1 })).toBeVisible();
  await expect(preview.getByRole("table")).toContainText("Value");
  await expect(preview.getByRole("checkbox")).toHaveCount(2);
  // Its markup is text to show, never code to run. The image cannot be read: it says so.
  await expect(preview.locator("script, img, [onerror]")).toHaveCount(0);
  await expect(preview.locator(".markdown-image")).toContainText("Image not shown: x");
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBe(
    undefined,
  );
  // Code blocks are coloured by the editor's own tokenizer.
  await expect(preview.locator("pre code span[class^='mtk']").first()).toBeAttached();
  // The editor is out of the way, not gone.
  await expect(page.locator("[data-editor=monaco]")).toBeHidden();

  // A heading link scrolls the preview; a web link goes to the system browser.
  await preview.getByRole("link", { name: "install" }).click();
  await expect(preview.getByRole("heading", { name: "Install" })).toBeInViewport();
  await preview.getByRole("link", { name: "the site" }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { __calls: string[] }).__calls.includes("open_external_url"),
      ),
    )
    .toBe(true);

  // Side by side, the preview follows the editor as it is typed in.
  await view.getByRole("button", { name: "Split" }).click();
  await expect(page.locator("[data-editor=monaco]")).toBeVisible();
  await expect(editorInput(page, "README.md")).toBeFocused();
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("End");
  await page.keyboard.type(" Renamed");
  await expect(preview.getByRole("heading", { level: 1 })).toHaveText("Project Renamed");

  // A link to another file opens it in the editor.
  await preview.getByRole("link", { name: "the guide" }).click();
  await expect(page.getByRole("tab", { selected: true })).toContainText("GUIDE.md");

  // Ctrl+Shift+V toggles the preview of the file in front.
  await expect(page.locator("[data-editor=monaco]")).toBeVisible();
  await page.keyboard.press("Control+Shift+v");
  await expect(page.getByRole("document", { name: "Preview GUIDE.md" })).toBeVisible();
  await expect(page.locator("[data-editor=monaco]")).toBeHidden();
  await page.keyboard.press("Control+Shift+v");
  await expect(page.locator("[data-editor=monaco]")).toBeVisible();
});

test("the preview's code blocks, outline, find, images and footnotes", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  // The native side has one image, logo.svg; any other is not found.
  await page.addInitScript(() => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#6366f1"/></svg>';
    let internals: { invoke: (command: string, args?: Record<string, unknown>) => unknown };
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      get: () => internals,
      set(value) {
        const invoke = value.invoke;
        internals = {
          ...value,
          invoke: (command: string, args: Record<string, unknown> = {}) => {
            if (command !== "read_image_file") return invoke(command, args);
            if (args.path === "/work/docs/img/logo.svg")
              return Promise.resolve(new TextEncoder().encode(svg).buffer);
            return Promise.reject("The system cannot find the file specified.");
          },
        };
      },
    });
  });
  const doc = [
    "# Guide",
    "",
    "Intro with a note[^n].",
    "",
    "![Logo](img/logo.svg) ![Gone](img/missing.png) ![Web](https://example.com/a.png)",
    "",
    "## Setup",
    "",
    "```python",
    "def hello():",
    "    return 'hi'",
    "```",
    "",
    ...Array.from({ length: 50 }, (_, i) => `Setup detail ${i}.\n`),
    "## Usage",
    "",
    "Use it. Use it again.",
    "",
    "### Advanced",
    "",
    "More.",
    "",
    "[^n]: The note itself.",
  ].join("\n");
  await fixture(page, { "/work/docs/GUIDE.md": doc });
  await open(page, "GUIDE.md");
  await page
    .getByRole("group", { name: "Markdown view" })
    .getByRole("button", { name: "Preview" })
    .click();
  const preview = page.getByRole("document", { name: "Preview GUIDE.md" });

  // Images: the workspace one shown from its bytes, a missing one said so, a web one not loaded.
  await expect(preview.getByRole("img", { name: "Logo" })).toBeVisible();
  await expect(preview.locator(".markdown-image[data-state=broken]")).toContainText(
    "img/missing.png",
  );
  await expect(preview.locator(".markdown-image[data-state=remote]")).toContainText("not loaded");
  // Clicking an image enlarges it; Escape closes it.
  await preview.getByRole("img", { name: "Logo" }).click();
  await expect(page.getByRole("dialog", { name: "Logo" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Logo" })).toHaveCount(0);

  // Footnotes: a numbered reference, and the note at the end.
  await expect(preview.locator("sup.footnote-ref")).toHaveText("1");
  await expect(preview.getByRole("region", { name: "Footnotes" })).toContainText(
    "The note itself.",
  );

  // Code blocks: language, numbered lines, Copy with feedback, Open in Editor.
  const block = preview.locator(".code-block");
  await expect(block.locator(".code-block-language")).toHaveText("python");
  await expect(block.locator(".code-line")).toHaveCount(2);
  await block.getByRole("button", { name: "Copy" }).click();
  await expect(block.getByRole("button", { name: "Copied" })).toBeVisible();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard.replace(/\r\n/g, "\n")).toBe("def hello():\n    return 'hi'");

  // The outline: every heading, the one in view marked, a click scrolls, a level collapses.
  // The preview's own Outline toggle (the Explorer has an Outline section too).
  await page.getByRole("tabpanel").getByRole("button", { name: "Outline" }).click();
  const outline = page.getByRole("navigation", { name: "Outline" });
  await expect(outline.getByRole("button", { name: "Advanced" })).toBeVisible();
  await expect(outline.getByRole("button", { name: "Guide", exact: true })).toHaveAttribute(
    "aria-current",
    "location",
  );
  await outline.getByRole("button", { name: "Usage", exact: true }).click();
  await expect(preview.getByRole("heading", { name: "Usage" })).toBeInViewport();
  await expect(outline.getByRole("button", { name: "Usage", exact: true })).toHaveAttribute(
    "aria-current",
    "location",
  );
  await outline.getByRole("button", { name: "Collapse Usage" }).click();
  await expect(outline.getByRole("button", { name: "Advanced" })).toHaveCount(0);

  // Find: Ctrl+F in the preview, a count, next, and Escape.
  await preview.focus();
  await page.keyboard.press("Control+f");
  const find = page.getByRole("textbox", { name: "Find in preview" });
  await expect(find).toBeFocused();
  await find.fill("use it");
  await expect(page.getByRole("search", { name: "Find in preview" })).toContainText("1 of 2");
  await find.press("Enter");
  await expect(page.getByRole("search", { name: "Find in preview" })).toContainText("2 of 2");
  await page.getByRole("button", { name: "Match Case" }).click();
  await expect(page.getByRole("search", { name: "Find in preview" })).toContainText("No results");
  await find.press("Escape");
  await expect(find).toHaveCount(0);

  // Open in Editor: the code in a new document, coloured as Python.
  await block.getByRole("button", { name: "Open in Editor" }).click();
  await expect(page.getByRole("tab", { selected: true })).toContainText("Untitled");
  await expectText(page, "def hello():\n    return 'hi'");
  expect(await editorLanguage(page)).toBe("python");
});
