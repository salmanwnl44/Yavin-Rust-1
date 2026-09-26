import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * The Document Model as the window uses it: formats kept through a save, external changes
 * followed or held as conflicts, untitled documents saved as files. The native side is a
 * fake whose guarded write refuses exactly as `write_file_guarded` does.
 */

async function menu(page: Page, name: string, action: string) {
  await page.getByRole("menubar").getByRole("menuitem", { name, exact: true }).click();
  await page
    .getByRole("menu", { name, exact: true })
    .getByRole("menuitem", { name: action, exact: true })
    .click();
}

async function fixture(page: Page, files: Record<string, string>) {
  await page.addInitScript((initial) => {
    const disk: Record<string, string> = { ...initial };
    const callbacks: Record<number, (event: unknown) => void> = {};
    const listeners: Record<string, number[]> = {};
    let nextId = 1;
    let operation = 0;
    Object.assign(window, {
      __disk: disk,
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
          if (command === "save_workspace_session") {
            const w = window as unknown as { __sessionWrites: number };
            w.__sessionWrites = (w.__sessionWrites ?? 0) + 1;
            return null;
          }
          if (command === "save_file_dialog")
            return (window as unknown as { __saveTarget: string | null }).__saveTarget;
          return null;
        },
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
    });
  }, files);
  await page.goto("/");
  await expect(page.getByText("work", { exact: true }).first()).toBeVisible();
}

const disk = (page: Page, path: string) =>
  page.evaluate(
    (file) => (window as unknown as { __disk: Record<string, string> }).__disk[file],
    path,
  );
const setDisk = (page: Page, path: string, text: string) =>
  page.evaluate(
    ([file, content]) => {
      (window as unknown as { __disk: Record<string, string> }).__disk[file] = content;
    },
    [path, text] as const,
  );
const changed = (page: Page, path: string) =>
  page.evaluate(
    (file) =>
      (window as unknown as { __emit: (e: string, p: unknown) => void }).__emit(
        "resource-changes",
        { generation: 1, root: "/work", changes: [{ kind: "modified", path: file }], rescan: [] },
      ),
    path,
  );
const open = async (page: Page, name: string) => {
  await page.getByLabel(name, { exact: true }).click();
  return page.getByRole("textbox", { name, exact: true });
};

test("a file keeps its byte order mark and CRLF line endings through an edit and save", async ({
  page,
}) => {
  await fixture(page, { "/work/crlf.ts": "﻿one\r\ntwo\r\n" });
  const editor = await open(page, "crlf.ts");
  await expect(editor).toHaveValue("one\ntwo\n");
  const status = page.getByRole("contentinfo");
  await expect(status).toContainText("UTF-8 with BOM");
  await expect(status).toContainText("CRLF");
  await expect(status).toContainText("TypeScript");
  await editor.fill("one\ntwo\nthree\n");
  await menu(page, "File", "Save");
  await expect.poll(() => disk(page, "/work/crlf.ts")).toBe("﻿one\r\ntwo\r\nthree\r\n");
});

test("an editor without unsaved changes follows the file when it changes on disk", async ({
  page,
}) => {
  await fixture(page, { "/work/a.ts": "before" });
  const editor = await open(page, "a.ts");
  await expect(editor).toHaveValue("before");
  await setDisk(page, "/work/a.ts", "after");
  await changed(page, "/work/a.ts");
  await expect(editor).toHaveValue("after");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("unsaved edits are never overwritten by a change on disk; keeping them is a choice", async ({
  page,
}) => {
  await fixture(page, { "/work/a.ts": "base" });
  const editor = await open(page, "a.ts");
  await editor.fill("mine");
  await setDisk(page, "/work/a.ts", "theirs");
  await changed(page, "/work/a.ts");
  await expect(page.getByRole("alert")).toContainText("changed on disk");
  await expect(editor).toHaveValue("mine");
  expect(await disk(page, "/work/a.ts")).toBe("theirs");
  await expect(page.getByTitle(/Changed on disk while it had unsaved changes/)).toBeVisible();

  // Saving is refused until the conflict is resolved.
  await page.getByRole("button", { name: "Dismiss" }).click();
  await menu(page, "File", "Save");
  await expect(page.getByRole("alert")).toContainText("Revert it, or keep your version");
  expect(await disk(page, "/work/a.ts")).toBe("theirs");

  await page.getByRole("button", { name: "Dismiss" }).click();
  await menu(page, "File", "Keep My Version");
  await menu(page, "File", "Save");
  await expect.poll(() => disk(page, "/work/a.ts")).toBe("mine");
});

test("Revert File takes the disk's version, after asking", async ({ page }) => {
  await fixture(page, { "/work/a.ts": "base" });
  const editor = await open(page, "a.ts");
  await editor.fill("mine");
  await setDisk(page, "/work/a.ts", "theirs");
  await changed(page, "/work/a.ts");
  await expect(page.getByRole("alert")).toContainText("changed on disk");
  page.once("dialog", (dialog) => void dialog.accept());
  await menu(page, "File", "Revert File");
  await expect(editor).toHaveValue("theirs");
  await page.getByRole("menubar").getByRole("menuitem", { name: "File", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Save", exact: true })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
});

test("an untitled file becomes a file on disk with Save As", async ({ page }) => {
  await fixture(page, { "/work/a.ts": "a" });
  await menu(page, "File", "New Text File");
  const untitled = page.getByRole("textbox", { name: "Untitled-1", exact: true });
  await expect(untitled).toBeFocused();
  await untitled.fill("# Notes\n");
  await page.evaluate(() => {
    (window as unknown as { __saveTarget: string }).__saveTarget = "/work/notes.md";
  });
  // Save on a document that has never been saved asks where it goes.
  await menu(page, "File", "Save");
  const saved = page.getByRole("textbox", { name: "notes.md", exact: true });
  await expect(saved).toHaveValue("# Notes\n");
  expect(await disk(page, "/work/notes.md")).toBe("# Notes\n");
  await expect(page.getByRole("tab", { name: /Untitled-1/ })).toHaveCount(0);
  await expect(page.getByRole("contentinfo")).toContainText("Markdown");
  // The undo history came with it: undoing the typing is an edit of the saved file.
  await menu(page, "Edit", "Undo");
  await expect(saved).toHaveValue("");
  await expect(page.getByTitle("Unsaved changes (Ctrl+S to save)")).toBeVisible();
  await menu(page, "Edit", "Redo");
  await expect(saved).toHaveValue("# Notes\n");
  await expect(page.getByTitle("Unsaved changes (Ctrl+S to save)")).toHaveCount(0);
});

test("typing does not rewrite the session", async ({ page }) => {
  await fixture(page, { "/work/a.ts": "a" });
  const editor = await open(page, "a.ts");
  const writes = () =>
    page.evaluate(() => (window as unknown as { __sessionWrites?: number }).__sessionWrites ?? 0);
  // Opening the file is a change to the session; let it be written.
  await expect.poll(writes).toBeGreaterThan(0);
  await page.waitForTimeout(600);
  const before = await writes();
  await editor.pressSequentially("typing");
  await page.waitForTimeout(600);
  expect(await writes()).toBe(before);
});
