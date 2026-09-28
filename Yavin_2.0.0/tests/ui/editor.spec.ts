import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  editorInput,
  editorLength,
  editorScroll,
  editorSelections,
  editorText,
  expectText,
  fillEditor,
  setEditorScroll,
  setEditorSelections,
} from "./editor-harness";

/**
 * The editor as a view of the Document Model: it shows the document's text, puts the user's
 * edits into the document, follows changes the document makes (reloads, reverts), and keeps
 * only its own state -- caret, selection, scroll, undo. The native side is a fake whose
 * guarded write refuses exactly as `write_file_guarded` does.
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
    (file) => (window as unknown as { __disk: Record<string, string | undefined> }).__disk[file],
    path,
  );
const setDisk = (page: Page, path: string, text: string | null) =>
  page.evaluate(
    ([file, content]) => {
      const store = (window as unknown as { __disk: Record<string, string> }).__disk;
      if (content === null) delete store[file!];
      else store[file!] = content;
    },
    [path, text] as const,
  );
const report = (page: Page, kind: string, path: string) =>
  page.evaluate(
    ([change, file]) =>
      (window as unknown as { __emit: (e: string, p: unknown) => void }).__emit(
        "resource-changes",
        { generation: 1, root: "/work", changes: [{ kind: change, path: file }], rescan: [] },
      ),
    [kind, path] as const,
  );
const open = async (page: Page, name: string) => {
  await page.getByLabel(name, { exact: true }).click();
  return page.getByRole("textbox", { name, exact: true });
};
/** The editor's primary selection, as offsets into the document's text. */
const caret = async (page: Page) => {
  const [first] = (await editorSelections(page)) ?? [];
  return first ? [first.start, first.end] : null;
};
const setCaret = async (page: Page, name: string, start: number, end = start) => {
  await editorInput(page, name).focus();
  await setEditorSelections(page, [{ start, end }]);
};
const saveDisabled = async (page: Page) => {
  await page.getByRole("menubar").getByRole("menuitem", { name: "File", exact: true }).click();
  const disabled = await page
    .getByRole("menuitem", { name: "Save", exact: true })
    .getAttribute("aria-disabled");
  await page.keyboard.press("Escape");
  return disabled === "true";
};
const unsaved = (page: Page) => page.getByTitle("Unsaved changes (Ctrl+S to save)");

test("type, save, type, undo: the document is clean again at the saved text", async ({ page }) => {
  await fixture(page, { "/work/a.ts": "one" });
  const editor = await open(page, "a.ts");
  await editor.press("End");
  await editor.pressSequentially(" two");
  await expect(unsaved(page)).toBeVisible();
  await page.keyboard.press("Control+s");
  await expect.poll(() => disk(page, "/work/a.ts")).toBe("one two");
  await expect(unsaved(page)).toHaveCount(0);
  await editor.pressSequentially("!");
  await expect(unsaved(page)).toBeVisible();
  await menu(page, "Edit", "Undo");
  await expectText(page, "one two");
  await expect(unsaved(page)).toHaveCount(0);
  expect(await saveDisabled(page)).toBe(true);
  await menu(page, "Edit", "Redo");
  await expectText(page, "one two!");
  await expect(unsaved(page)).toBeVisible();
});

test("an untitled file: type, undo, redo, Save As, keep editing, save", async ({ page }) => {
  await fixture(page, { "/work/a.ts": "a" });
  await menu(page, "File", "New Text File");
  const untitled = page.getByRole("textbox", { name: "Untitled-1", exact: true });
  await untitled.pressSequentially("hello");
  await untitled.pressSequentially(" world");
  await menu(page, "Edit", "Undo");
  await menu(page, "Edit", "Redo");
  await expectText(page, "hello world");
  await page.evaluate(() => {
    (window as unknown as { __saveTarget: string }).__saveTarget = "/work/hello.txt";
  });
  await page.keyboard.press("Control+s");
  const saved = page.getByRole("textbox", { name: "hello.txt", exact: true });
  await expectText(page, "hello world");
  expect(await disk(page, "/work/hello.txt")).toBe("hello world");
  await saved.focus();
  await saved.press("End");
  await saved.pressSequentially("!");
  await page.keyboard.press("Control+s");
  // A guarded replace of what Save As wrote -- the file is a disk document now.
  await expect.poll(() => disk(page, "/work/hello.txt")).toBe("hello world!");
  await expect(unsaved(page)).toHaveCount(0);
  const calls = await page.evaluate(() => (window as unknown as { __calls: string[] }).__calls);
  expect(calls.filter((call) => call === "create_file_with_content")).toHaveLength(1);
  expect(calls.filter((call) => call === "write_file_guarded")).toHaveLength(1);
});

test("a reload from disk keeps the caret where it was in the text", async ({ page }) => {
  await fixture(page, { "/work/a.ts": "first\nsecond\n" });
  const editor = await open(page, "a.ts");
  await setCaret(page, "a.ts", 8); // in "second"
  await setDisk(page, "/work/a.ts", "zeroth\nfirst\nsecond\n");
  await report(page, "modified", "/work/a.ts");
  await expectText(page, "zeroth\nfirst\nsecond\n");
  expect(await caret(page)).toEqual([15, 15]);
  await expect(editor).toBeFocused();
  await expect(unsaved(page)).toHaveCount(0);
});

test("each document's caret and scroll position survive switching tabs", async ({ page }) => {
  const long = Array.from({ length: 400 }, (_, n) => `line ${n}`).join("\n");
  await fixture(page, { "/work/a.ts": long, "/work/b.ts": "b" });
  const a = await open(page, "a.ts");
  await setCaret(page, "a.ts", 1200, 1210);
  // A second cursor too, and the view scrolled both ways: all of it is the editor's state.
  await setEditorSelections(page, [
    { start: 1200, end: 1210 },
    { start: 2000, end: 2000 },
  ]);
  await setEditorScroll(page, 2000, 0);
  await expect.poll(async () => (await editorScroll(page))?.top).toBe(2000);
  await open(page, "b.ts");
  await expect.poll(() => editorText(page)).toBe("b");
  await page.getByRole("tab", { name: /a\.ts/ }).click();
  await expect(a).toBeFocused();
  expect(await editorSelections(page)).toEqual([
    { start: 1200, end: 1210 },
    { start: 2000, end: 2000 },
  ]);
  expect((await editorScroll(page))?.top).toBe(2000);
});

test("a deleted file keeps its text; the same text back is in step, other text is a conflict", async ({
  page,
}) => {
  await fixture(page, { "/work/a.ts": "only copy" });
  await open(page, "a.ts");
  const note = page.getByRole("note", { name: "Document state" });
  await setDisk(page, "/work/a.ts", null);
  await report(page, "deleted", "/work/a.ts");
  await expect(note).toContainText("deleted on disk");
  await expectText(page, "only copy");
  // The same content returning puts it back in step.
  await setDisk(page, "/work/a.ts", "only copy");
  await report(page, "created", "/work/a.ts");
  await expect(note).toHaveCount(0);
  // Deleted again, and something different appears: never reloaded over the text.
  await setDisk(page, "/work/a.ts", null);
  await report(page, "deleted", "/work/a.ts");
  await expect(note).toContainText("deleted on disk");
  await setDisk(page, "/work/a.ts", "someone else's file");
  await report(page, "created", "/work/a.ts");
  await expect(note).toContainText("changed on disk while it had unsaved changes");
  await expectText(page, "only copy");
  expect(await disk(page, "/work/a.ts")).toBe("someone else's file");
});

test("the conflict notice's actions resolve it through the document", async ({ page }) => {
  await fixture(page, { "/work/a.ts": "base", "/work/b.ts": "base" });
  const note = page.getByRole("note", { name: "Document state" });
  // Keep My Version: the next save replaces the disk's text.
  await open(page, "a.ts");
  await fillEditor(page, "mine");
  await setDisk(page, "/work/a.ts", "theirs");
  await report(page, "modified", "/work/a.ts");
  await expect(note).toContainText("changed on disk");
  await note.getByRole("button", { name: "Keep My Version" }).click();
  await expect(note).toHaveCount(0);
  await expectText(page, "mine");
  await page.keyboard.press("Control+s");
  await expect.poll(() => disk(page, "/work/a.ts")).toBe("mine");
  // Revert File: the disk's text, after asking.
  await open(page, "b.ts");
  await fillEditor(page, "mine");
  await setDisk(page, "/work/b.ts", "theirs");
  await report(page, "modified", "/work/b.ts");
  await expect(note).toContainText("changed on disk");
  page.once("dialog", (dialog) => void dialog.accept());
  await note.getByRole("button", { name: "Revert File" }).click();
  await expectText(page, "theirs");
  await expect(note).toHaveCount(0);
  await expect(unsaved(page)).toHaveCount(0);
});

test("a failed save says so and keeps the edits", async ({ page }) => {
  await fixture(page, { "/work/a.ts": "a" });
  await open(page, "a.ts");
  await fillEditor(page, "b");
  await page.evaluate(() => {
    (window as unknown as { __failWrite: boolean }).__failWrite = true;
  });
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("note", { name: "Document state" })).toContainText(
    "The last save failed",
  );
  await expectText(page, "b");
  expect(await disk(page, "/work/a.ts")).toBe("a");
});

test("a proposal opens in the same editor, can be edited, and is never saved", async ({ page }) => {
  await fixture(page, { "/work/a.ts": "base" });
  await page.evaluate(() =>
    (
      window as unknown as { __yavinPropose: (path: string, text: string) => Promise<void> }
    ).__yavinPropose("/work/a.ts", "proposed"),
  );
  const editor = page.getByRole("textbox", { name: "a.ts", exact: true });
  await expectText(page, "proposed");
  await expect(page.getByRole("note", { name: "Document state" })).toContainText(
    "Proposed content",
  );
  await editor.press("End");
  await editor.pressSequentially(", edited");
  await expectText(page, "proposed, edited");
  expect(await saveDisabled(page)).toBe(true);
  await page.keyboard.press("Control+s");
  expect(await disk(page, "/work/a.ts")).toBe("base");
});

test("one file opened by two spellings is one document in one tab", async ({ page }) => {
  await fixture(page, { "/work/a.ts": "a" }, {}, "/work/src/../a.ts");
  await open(page, "a.ts");
  await fillEditor(page, "edited");
  await menu(page, "File", "Open File…");
  await expect(page.getByRole("tab", { name: /a\.ts/ })).toHaveCount(1);
  await expectText(page, "edited");
});

test("closing a dirty editor asks; reopening reads the file afresh", async ({ page }) => {
  await fixture(page, { "/work/a.ts": "saved" });
  await open(page, "a.ts");
  await fillEditor(page, "unsaved");
  page.once("dialog", (dialog) => void dialog.dismiss());
  await page.getByRole("button", { name: "Close a.ts" }).click();
  await expectText(page, "unsaved");
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Close a.ts" }).click();
  await expect(page.getByRole("tab", { name: /a\.ts/ })).toHaveCount(0);
  await open(page, "a.ts");
  await expectText(page, "saved");
  await expect(unsaved(page)).toHaveCount(0);
});

test("typing renders nothing in React: not the window, not the editor component", async ({
  page,
}) => {
  // React reports every commit to the DevTools hook; a component function that ran in a
  // render carries the PerformedWork flag (1) on its fiber in that commit.
  await page.addInitScript(() => {
    const renders: Record<string, number> = {};
    const find = (fiber: unknown, name: string): { flags: number } | null => {
      type Fiber = { type?: { name?: string }; child?: Fiber; sibling?: Fiber; flags: number };
      const stack: Fiber[] = [fiber as Fiber];
      while (stack.length) {
        const next = stack.pop()!;
        if (next.type?.name === name) return next;
        if (next.sibling) stack.push(next.sibling);
        if (next.child) stack.push(next.child);
      }
      return null;
    };
    Object.assign(window, {
      __renders: renders,
      __REACT_DEVTOOLS_GLOBAL_HOOK__: {
        supportsFiber: true,
        renderers: new Map(),
        inject: () => 1,
        checkDCE: () => {},
        onScheduleFiberRoot: () => {},
        onCommitFiberUnmount: () => {},
        onPostCommitFiberRoot: () => {},
        onCommitFiberRoot: (_id: number, root: { current: unknown }) => {
          for (const name of ["App", "CodeEditor"])
            if (((find(root.current, name)?.flags ?? 0) & 1) === 1)
              renders[name] = (renders[name] ?? 0) + 1;
        },
      },
    });
  });
  await fixture(page, { "/work/a.ts": "a" });
  const editor = await open(page, "a.ts");
  await editor.press("End");
  await editor.pressSequentially("b"); // clean -> dirty: the tab's marker changes, so it redraws
  await expect(unsaved(page)).toBeVisible();
  const before = await page.evaluate(() => ({
    ...(window as unknown as { __renders: Record<string, number> }).__renders,
  }));
  await editor.pressSequentially("cdefghij");
  await expectText(page, "abcdefghij");
  const after = await page.evaluate(() => ({
    ...(window as unknown as { __renders: Record<string, number> }).__renders,
  }));
  // Monaco owns the keystroke: neither the window nor the editor's React component renders.
  expect(after.CodeEditor ?? 0).toBe(before.CodeEditor ?? 0);
  expect(after.App ?? 0).toBe(before.App ?? 0);
});

for (const [label, size] of [
  ["1 MB", 1_000_000],
  ["5 MB", 5_000_000],
  ["9.5 MB", 9_500_000],
] as const) {
  test(`a ${label} file opens, takes typing quickly, scrolls, saves and reloads`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await fixture(page, { "/work/small.ts": "small" }, { "/work/big.ts": size });
    // Opening: the click until the editor shows the whole document and has painted it (the
    // first open also loads the editor itself, so the small file goes first).
    await open(page, "small.ts");
    await expectText(page, "small");
    const opening = Date.now();
    await open(page, "big.ts");
    await expect.poll(() => editorLength(page), { timeout: 30_000, intervals: [10] }).toBe(size);
    await expect(page.locator("[data-editor=monaco] .view-line").first()).toBeVisible();
    const opened = Date.now() - opening;
    // Switching tabs: the model is kept, so coming back is a swap, not a reload.
    await page.getByRole("tab", { name: /small\.ts/ }).click();
    await expectText(page, "small");
    const switching = Date.now();
    await page.getByRole("tab", { name: /big\.ts/ }).click();
    await expect.poll(() => editorLength(page), { intervals: [10] }).toBe(size);
    const switched = Date.now() - switching;
    console.log(`${label}: opened and painted in ${opened} ms; tab switch back in ${switched} ms`);
    // Keystrokes timed inside the page, each from the input event until the next frame is
    // painted -- the latency someone typing sees -- and compared with the same keystrokes in a
    // plain textarea holding the same text (Module 06's measure).
    const timing = await page.evaluate(async () => {
      const frame = () =>
        new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve)));
      const median = async (key: () => void) => {
        const spent: number[] = [];
        for (let count = 0; count < 20; count++) {
          const start = performance.now();
          key();
          await frame();
          spent.push(performance.now() - start);
        }
        return spent.sort((a, b) => a - b)[10];
      };
      const hook = (
        window as unknown as { __yavinEditor: { value(): string; type(text: string): void } }
      ).__yavinEditor;
      const plain = document.createElement("textarea");
      plain.wrap = "off";
      plain.style.cssText = "position:fixed;left:0;top:0;width:800px;height:600px";
      document.body.append(plain);
      plain.value = hook.value();
      plain.focus();
      plain.setSelectionRange(0, 0);
      const browser = await median(() => document.execCommand("insertText", false, "x"));
      plain.remove();
      // In the editor: Monaco's `type` command -- what a keystroke becomes once the browser's
      // EditContext hands it over -- then the frame Monaco paints it in.
      return { editor: await median(() => hook.type("x")), browser };
    });
    console.log(
      `${label}: median keystroke to paint ${timing.editor.toFixed(1)} ms in the editor, ` +
        `${timing.browser.toFixed(1)} ms in a plain textarea`,
    );
    expect(timing.editor).toBeLessThan(timing.browser * 1.3 + 15);
    await expect.poll(() => editorLength(page)).toBe(size + 20);
    // Scrolling to the end.
    await setEditorScroll(page, 1e9, 0);
    await expect.poll(async () => (await editorScroll(page))?.top ?? 0).toBeGreaterThan(0);
    await page.keyboard.press("Control+s");
    await expect
      .poll(async () => (await disk(page, "/work/big.ts"))?.length, { timeout: 30_000 })
      .toBe(size + 20);
    // Typed where the cursor was: the start of the file.
    expect((await disk(page, "/work/big.ts"))!.startsWith("x".repeat(20) + "const value")).toBe(
      true,
    );
    // An external change to the clean file reloads it.
    await page.evaluate(() => {
      const store = (window as unknown as { __disk: Record<string, string> }).__disk;
      store["/work/big.ts"] = "// replaced\n" + store["/work/big.ts"];
    });
    await report(page, "modified", "/work/big.ts");
    await expect.poll(() => editorLength(page), { timeout: 30_000 }).toBe(size + 20 + 12);
    await expect(unsaved(page)).toHaveCount(0);
  });
}
