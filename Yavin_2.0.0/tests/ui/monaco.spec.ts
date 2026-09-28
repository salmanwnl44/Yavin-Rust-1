import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  editorInput,
  editorLanguage,
  editorOptions,
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
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("favicon"))
      errors.push(message.text());
  });
  const names = ["a.ts", "b.json", "c.py", "d.rs", "e.md", "f.css", "g.html", "h.yaml", "i.sh"];
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
