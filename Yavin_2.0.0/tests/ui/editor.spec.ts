import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

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
const caret = (page: Page, name: string) =>
  page
    .getByRole("textbox", { name, exact: true })
    .evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd]);
const setCaret = (page: Page, name: string, start: number, end = start) =>
  page.getByRole("textbox", { name, exact: true }).evaluate(
    (element: HTMLTextAreaElement, [a, b]) => {
      element.focus();
      element.setSelectionRange(a, b);
      element.dispatchEvent(new Event("select", { bubbles: true }));
    },
    [start, end] as const,
  );
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
  await expect(editor).toHaveValue("one two");
  await expect(unsaved(page)).toHaveCount(0);
  expect(await saveDisabled(page)).toBe(true);
  await menu(page, "Edit", "Redo");
  await expect(editor).toHaveValue("one two!");
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
  await expect(untitled).toHaveValue("hello world");
  await page.evaluate(() => {
    (window as unknown as { __saveTarget: string }).__saveTarget = "/work/hello.txt";
  });
  await page.keyboard.press("Control+s");
  const saved = page.getByRole("textbox", { name: "hello.txt", exact: true });
  await expect(saved).toHaveValue("hello world");
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
  await expect(editor).toHaveValue("zeroth\nfirst\nsecond\n");
  expect(await caret(page, "a.ts")).toEqual([15, 15]);
  await expect(editor).toBeFocused();
  await expect(unsaved(page)).toHaveCount(0);
});

test("each document's caret and scroll position survive switching tabs", async ({ page }) => {
  const long = Array.from({ length: 400 }, (_, n) => `line ${n}`).join("\n");
  await fixture(page, { "/work/a.ts": long, "/work/b.ts": "b" });
  const a = await open(page, "a.ts");
  await a.evaluate((element: HTMLTextAreaElement) => {
    element.scrollTop = 2000;
    element.dispatchEvent(new Event("scroll"));
  });
  await setCaret(page, "a.ts", 1200, 1210);
  await open(page, "b.ts");
  await page.getByRole("tab", { name: /a\.ts/ }).click();
  await expect(a).toBeFocused();
  expect(await caret(page, "a.ts")).toEqual([1200, 1210]);
  expect(await a.evaluate((element: HTMLTextAreaElement) => element.scrollTop)).toBe(2000);
});

test("a deleted file keeps its text; the same text back is in step, other text is a conflict", async ({
  page,
}) => {
  await fixture(page, { "/work/a.ts": "only copy" });
  const editor = await open(page, "a.ts");
  const note = page.getByRole("note", { name: "Document state" });
  await setDisk(page, "/work/a.ts", null);
  await report(page, "deleted", "/work/a.ts");
  await expect(note).toContainText("deleted on disk");
  await expect(editor).toHaveValue("only copy");
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
  await expect(editor).toHaveValue("only copy");
  expect(await disk(page, "/work/a.ts")).toBe("someone else's file");
});

test("the conflict notice's actions resolve it through the document", async ({ page }) => {
  await fixture(page, { "/work/a.ts": "base", "/work/b.ts": "base" });
  const note = page.getByRole("note", { name: "Document state" });
  // Keep My Version: the next save replaces the disk's text.
  const a = await open(page, "a.ts");
  await a.fill("mine");
  await setDisk(page, "/work/a.ts", "theirs");
  await report(page, "modified", "/work/a.ts");
  await expect(note).toContainText("changed on disk");
  await note.getByRole("button", { name: "Keep My Version" }).click();
  await expect(note).toHaveCount(0);
  await expect(a).toHaveValue("mine");
  await page.keyboard.press("Control+s");
  await expect.poll(() => disk(page, "/work/a.ts")).toBe("mine");
  // Revert File: the disk's text, after asking.
  const b = await open(page, "b.ts");
  await b.fill("mine");
  await setDisk(page, "/work/b.ts", "theirs");
  await report(page, "modified", "/work/b.ts");
  await expect(note).toContainText("changed on disk");
  page.once("dialog", (dialog) => void dialog.accept());
  await note.getByRole("button", { name: "Revert File" }).click();
  await expect(b).toHaveValue("theirs");
  await expect(note).toHaveCount(0);
  await expect(unsaved(page)).toHaveCount(0);
});

test("a failed save says so and keeps the edits", async ({ page }) => {
  await fixture(page, { "/work/a.ts": "a" });
  const editor = await open(page, "a.ts");
  await editor.fill("b");
  await page.evaluate(() => {
    (window as unknown as { __failWrite: boolean }).__failWrite = true;
  });
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("note", { name: "Document state" })).toContainText(
    "The last save failed",
  );
  await expect(editor).toHaveValue("b");
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
  await expect(editor).toHaveValue("proposed");
  await expect(page.getByRole("note", { name: "Document state" })).toContainText(
    "Proposed content",
  );
  await editor.press("End");
  await editor.pressSequentially(", edited");
  await expect(editor).toHaveValue("proposed, edited");
  expect(await saveDisabled(page)).toBe(true);
  await page.keyboard.press("Control+s");
  expect(await disk(page, "/work/a.ts")).toBe("base");
});

test("one file opened by two spellings is one document in one tab", async ({ page }) => {
  await fixture(page, { "/work/a.ts": "a" }, {}, "/work/src/../a.ts");
  const editor = await open(page, "a.ts");
  await editor.fill("edited");
  await menu(page, "File", "Open File…");
  await expect(page.getByRole("tab", { name: /a\.ts/ })).toHaveCount(1);
  await expect(editor).toHaveValue("edited");
});

test("closing a dirty editor asks; reopening reads the file afresh", async ({ page }) => {
  await fixture(page, { "/work/a.ts": "saved" });
  const editor = await open(page, "a.ts");
  await editor.fill("unsaved");
  page.once("dialog", (dialog) => void dialog.dismiss());
  await page.getByRole("button", { name: "Close a.ts" }).click();
  await expect(editor).toHaveValue("unsaved");
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Close a.ts" }).click();
  await expect(page.getByRole("tab", { name: /a\.ts/ })).toHaveCount(0);
  const reopened = await open(page, "a.ts");
  await expect(reopened).toHaveValue("saved");
  await expect(unsaved(page)).toHaveCount(0);
});

test("typing redraws the editor, not the window around it", async ({ page }) => {
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
          for (const name of ["App", "TextEditor"])
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
  await expect(editor).toHaveValue("abcdefghij");
  const after = await page.evaluate(() => ({
    ...(window as unknown as { __renders: Record<string, number> }).__renders,
  }));
  expect(after.TextEditor - before.TextEditor).toBeGreaterThanOrEqual(8);
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
    await fixture(page, {}, { "/work/big.ts": size });
    const editor = await open(page, "big.ts");
    await expect(editor).toHaveJSProperty("textLength", size);
    // Keystrokes timed inside the page: each one goes through the input event, the document
    // edit and the editor's render before the next starts. Compared with the same keystrokes
    // in a plain textarea holding the same text -- what the browser itself costs, which grows
    // with the text -- so what is measured is what the editor adds.
    const timing = await editor.evaluate((element: HTMLTextAreaElement) => {
      const median = (target: HTMLTextAreaElement) => {
        target.focus();
        target.setSelectionRange(0, 0);
        const spent: number[] = [];
        for (let key = 0; key < 20; key++) {
          const start = performance.now();
          document.execCommand("insertText", false, "x");
          spent.push(performance.now() - start);
        }
        return spent.sort((a, b) => a - b)[10];
      };
      const plain = document.createElement("textarea");
      plain.wrap = "off";
      plain.style.cssText = `position:fixed;left:0;top:0;width:${element.clientWidth}px;height:${element.clientHeight}px`;
      document.body.append(plain);
      plain.value = element.value;
      const browser = median(plain);
      plain.remove();
      return { editor: median(element), browser };
    });
    console.log(
      `${label}: median keystroke ${timing.editor.toFixed(1)} ms in the editor, ` +
        `${timing.browser.toFixed(1)} ms in a plain textarea`,
    );
    expect(timing.editor).toBeLessThan(timing.browser * 1.3 + 15);
    await expect(editor).toHaveJSProperty("textLength", size + 20);
    // Scrolling to the end.
    await editor.evaluate((element: HTMLTextAreaElement) => {
      element.scrollTop = element.scrollHeight;
    });
    expect(await editor.evaluate((element: HTMLTextAreaElement) => element.scrollTop > 0)).toBe(
      true,
    );
    await page.keyboard.press("Control+s");
    await expect
      .poll(async () => (await disk(page, "/work/big.ts"))?.length, { timeout: 30_000 })
      .toBe(size + 20);
    expect((await disk(page, "/work/big.ts"))!.startsWith("x".repeat(20) + "const value")).toBe(
      true,
    );
    // An external change to the clean file reloads it.
    await page.evaluate(() => {
      const store = (window as unknown as { __disk: Record<string, string> }).__disk;
      store["/work/big.ts"] = "// replaced\n" + store["/work/big.ts"];
    });
    await report(page, "modified", "/work/big.ts");
    await expect(editor).toHaveJSProperty("textLength", size + 20 + 12, { timeout: 30_000 });
    await expect(unsaved(page)).toHaveCount(0);
  });
}
