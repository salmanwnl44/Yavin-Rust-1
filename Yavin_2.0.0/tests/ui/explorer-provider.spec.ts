import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * The Explorer on the provider platform: the tree it shows is the provider's projection,
 * watcher changes reach it through the provider, and its UI state follows the provider's
 * renames. The native side is a fake filesystem that counts listings.
 */

async function fixture(page: Page, paths: string[], big: Record<string, number> = {}) {
  await page.addInitScript(
    ({ initial, sizes }) => {
      const dirs = new Set<string>(["/work"]);
      const files = new Set<string>();
      const add = (path: string) => {
        const parts = path.split("/");
        for (let index = 2; index < parts.length; index++)
          dirs.add(parts.slice(0, index).join("/"));
        if (path.endsWith("/")) dirs.add(path.slice(0, -1));
        else files.add(path);
      };
      initial.forEach(add);
      for (const [dir, count] of Object.entries(sizes)) {
        dirs.add(dir);
        for (let n = 0; n < count; n++) files.add(`${dir}/file${String(n).padStart(5, "0")}.ts`);
      }
      const callbacks: Record<number, (event: unknown) => void> = {};
      const listeners: Record<string, number[]> = {};
      let nextId = 1;
      const listed: string[] = [];
      const node = (path: string) => ({
        path,
        name: path.split("/").pop(),
        is_dir: dirs.has(path),
        children: null,
      });
      Object.assign(window, {
        __fs: {
          listed,
          add,
          rename(from: string, to: string) {
            for (const dir of [...dirs])
              if (dir === from || dir.startsWith(from + "/")) {
                dirs.delete(dir);
                dirs.add(to + dir.slice(from.length));
              }
            for (const file of [...files])
              if (file === from || file.startsWith(from + "/")) {
                files.delete(file);
                files.add(to + file.slice(from.length));
              }
          },
        },
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
            if (command === "plugin:event|listen") {
              (listeners[args.event as string] ??= []).push(args.handler as number);
              return nextId++;
            }
            if (command === "get_default_workspace") return "/work";
            if (command === "list_workspace_files") {
              const path = args.path as string;
              listed.push(path);
              if (!dirs.has(path)) throw `Cannot read ${path}: not found`;
              const prefix = path + "/";
              const children = [...dirs, ...files]
                .filter(
                  (entry) => entry.startsWith(prefix) && !entry.slice(prefix.length).includes("/"),
                )
                .sort((a, b) => Number(dirs.has(b)) - Number(dirs.has(a)) || a.localeCompare(b))
                .map(node);
              return { ...node(path), children };
            }
            if (command === "read_file_content") return "";
            if (command === "rename_path") {
              (window as unknown as { __fs: { rename(a: string, b: string): void } }).__fs.rename(
                args.oldPath as string,
                args.newPath as string,
              );
              return null;
            }
            return null;
          },
        },
        __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      });
    },
    { initial: paths, sizes: big },
  );
  await page.goto("/");
  await expect(page.getByRole("tree", { name: "Files" })).toBeVisible();
}

const tree = (page: Page) => page.getByRole("tree", { name: "Files" });
const row = (page: Page, name: string) => tree(page).getByRole("treeitem", { name, exact: true });
const listings = (page: Page) =>
  page.evaluate(() => [...(window as unknown as { __fs: { listed: string[] } }).__fs.listed]);
const report = (page: Page, changes: unknown[], rescan: string[] = []) =>
  page.evaluate(
    ([items, scopes]) =>
      (window as unknown as { __emit: (e: string, p: unknown) => void }).__emit(
        "resource-changes",
        { generation: 1, root: "/work", changes: items, rescan: scopes },
      ),
    [changes, rescan] as const,
  );

test("a folder renamed outside Yavin stays expanded, and its selected file stays selected", async ({
  page,
}) => {
  await fixture(page, ["/work/src/deep/x.ts", "/work/src/a.ts", "/work/b.ts"]);
  await row(page, "src").click();
  await row(page, "deep").click();
  await row(page, "x.ts").click();
  await expect(row(page, "x.ts")).toHaveAttribute("aria-selected", "true");

  await page.evaluate(() =>
    (window as unknown as { __fs: { rename(a: string, b: string): void } }).__fs.rename(
      "/work/src",
      "/work/lib",
    ),
  );
  await report(page, [{ kind: "renamed", from: "/work/src", path: "/work/lib" }]);

  await expect(row(page, "lib")).toBeVisible();
  await expect(row(page, "src")).toHaveCount(0);
  // Its contents still showing: expanded under its new identity, not collapsed and re-listed.
  await expect(row(page, "deep")).toBeVisible();
  await expect(row(page, "x.ts")).toHaveAttribute("aria-selected", "true");
});

test("a rename in Yavin keeps the renamed folder expanded", async ({ page }) => {
  await fixture(page, ["/work/src/a.ts"]);
  await row(page, "src").click();
  await expect(row(page, "a.ts")).toBeVisible();
  await row(page, "src").focus();
  await page.keyboard.press("F2");
  const input = tree(page).getByRole("textbox");
  await input.fill("lib");
  await input.press("Enter");
  await expect(row(page, "lib")).toBeVisible();
  await expect(row(page, "a.ts")).toBeVisible();
});

test("a burst of changes in one folder re-lists that folder once, and nothing else", async ({
  page,
}) => {
  await fixture(page, ["/work/src/a.ts", "/work/lib/b.ts", "/work/c.ts"]);
  await row(page, "src").click();
  await row(page, "lib").click();
  await expect(row(page, "b.ts")).toBeVisible();
  const before = (await listings(page)).length;
  await page.evaluate(() => {
    const fs = (window as unknown as { __fs: { add(path: string): void } }).__fs;
    for (let n = 0; n < 5; n++) fs.add(`/work/src/new${n}.ts`);
  });
  await report(
    page,
    Array.from({ length: 5 }, (_, n) => ({ kind: "created", path: `/work/src/new${n}.ts` })).concat(
      [
        { kind: "modified", path: "/work/src/a.ts" },
        { kind: "modified", path: "/work/src/a.ts" },
      ],
    ),
  );
  await expect(row(page, "new4.ts")).toBeVisible();
  expect((await listings(page)).slice(before)).toEqual(["/work/src"]);
});

test("changes inside a collapsed folder cost no listing at all", async ({ page }) => {
  await fixture(page, ["/work/node_modules/x/index.js", "/work/a.ts"]);
  await expect(row(page, "node_modules")).toBeVisible();
  const before = (await listings(page)).length;
  await report(page, [
    { kind: "created", path: "/work/node_modules/x/new.js" },
    { kind: "modified", path: "/work/node_modules/x/index.js" },
  ]);
  // A later change that is visible proves the batch above was handled, not merely pending.
  await page.evaluate(() =>
    (window as unknown as { __fs: { add(path: string): void } }).__fs.add("/work/z.ts"),
  );
  await report(page, [{ kind: "created", path: "/work/z.ts" }]);
  await expect(row(page, "z.ts")).toBeVisible();
  expect((await listings(page)).slice(before)).toEqual(["/work"]);
});

test("a folder of 20,000 files expands, renders a window of rows, and scrolls", async ({
  page,
}) => {
  await fixture(page, ["/work/a.ts"], { "/work/big": 20_000 });
  const started = Date.now();
  await row(page, "big").click();
  await expect(row(page, "file00000.ts")).toBeVisible();
  const expanded = Date.now() - started;
  const rendered = await tree(page).getByRole("treeitem").count();
  expect(rendered).toBeLessThan(200);
  await tree(page).evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(row(page, "file19999.ts")).toBeVisible();
  console.log(`20,000 files: expanded and shown in ${expanded} ms, ${rendered} rows rendered`);
  expect(expanded).toBeLessThan(5000);
});

test("a long tree is drawn in full, where it was, after another view was shown", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await fixture(page, [], { "/work/big": 300 });
  await row(page, "big").click();
  await expect(row(page, "file00000.ts")).toBeVisible();
  await tree(page).evaluate((element) => (element.scrollTop = 3000));
  await expect(row(page, "file00150.ts")).toBeVisible();
  const drawn = await tree(page).getByRole("treeitem").count();

  // The Search view, and one of the views that are not built yet, each hide the Explorer.
  for (const view of ["Search (Ctrl+Shift+F)", "Run & Debug (Ctrl+Shift+D)"]) {
    await page.getByTitle(view).click();
    await expect(tree(page)).toBeHidden();
    await page.getByTitle("Explorer (Ctrl+Shift+E)").click();
    // Every row of the window is drawn again, not the few drawn before it was measured...
    await expect(tree(page).getByRole("treeitem")).toHaveCount(drawn);
    // ...at the same place in the tree.
    await expect(row(page, "file00150.ts")).toBeVisible();
  }
});
