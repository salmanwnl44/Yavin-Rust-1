import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * The Explorer migrated onto the provider and store: node identity instead of paths, several
 * roots, capabilities, loading and error rows, reveal through the store, and every mutation
 * through the native operations. The native side is a fake filesystem with Module 03's
 * refusals (a copy or rename onto something that exists fails), failing and slow folders, and
 * a session to restore.
 */

interface Options {
  paths: string[];
  failing?: Record<string, string>;
  slow?: string[];
  session?: unknown;
  /** No folder open at startup. */
  noWorkspace?: boolean;
  /**
   * The folders that are Git repositories, and what is modified in each (paths relative to
   * it). A modified file that has since been renamed reports as a rename, as Git would.
   */
  git?: Record<string, string[]>;
}

async function fixture(page: Page, options: Options) {
  await page.addInitScript((opts) => {
    const dirs = new Set<string>(["/work"]);
    const files = new Set<string>();
    const add = (path: string) => {
      const parts = path.split("/");
      for (let index = 2; index < parts.length; index++) dirs.add(parts.slice(0, index).join("/"));
      if (path.endsWith("/")) dirs.add(path.slice(0, -1));
      else files.add(path);
    };
    opts.paths.forEach(add);
    const failing: Record<string, string> = { ...(opts.failing ?? {}) };
    const gates = new Map<string, () => void>();
    const slow = new Set(opts.slow ?? []);
    const calls: { command: string; args: Record<string, unknown> }[] = [];
    const move = (from: string, to: string) => {
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
    };
    const exists = (path: string) => dirs.has(path) || files.has(path);
    Object.assign(window, {
      __calls: calls,
      __fs: {
        failing,
        release: (path: string) => gates.get(path)?.(),
        add,
      },
      isTauri: true,
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        transformCallback: () => 1,
        unregisterCallback: () => {},
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          calls.push({ command, args });
          if (command === "read_session") return opts.session ?? null;
          if (command === "open_workspace") return args.path;
          if (command === "get_default_workspace") return opts.noWorkspace ? null : "/work";
          if (command === "open_folder_dialog") return null;
          if (command === "git_open_repo") {
            const path = args.path as string;
            if (!opts.git?.[path]) throw `${path} is not a Git repository`;
            return { repoId: path, root: path };
          }
          if (command === "git_repo_state") return "";
          if (command === "git_exec") {
            const repo = args.repoId as string;
            const argv = args.args as string[];
            let stdout = "";
            if (argv[0] === "status" && !argv.includes("--porcelain=v2")) {
              for (const rel of opts.git?.[repo] ?? []) {
                const at = `${repo}/${rel}`;
                if (files.has(at)) stdout += ` M ${rel}\0`;
                else {
                  // Renamed since: whatever now sits in the same folder that Git would pair
                  // with it -- the fake's rule is "the only new file in that folder".
                  const folder = at.slice(0, at.lastIndexOf("/"));
                  const moved = [...files].find(
                    (file) =>
                      file.startsWith(folder + "/") &&
                      !file.slice(folder.length + 1).includes("/") &&
                      !opts.paths.includes(file),
                  );
                  if (moved) stdout += `RM ${moved.slice(repo.length + 1)}\0${rel}\0`;
                }
              }
            }
            return { stdout, stderr: "", code: 0, truncated: false };
          }
          if (command === "list_workspace_files") {
            const path = args.path as string;
            if (slow.has(path)) {
              slow.delete(path);
              await new Promise<void>((resolve) => gates.set(path, resolve));
            }
            if (failing[path]) throw failing[path];
            if (!dirs.has(path)) throw `Cannot read ${path}: not found`;
            const prefix = path + "/";
            const children = [...dirs, ...files]
              .filter(
                (entry) => entry.startsWith(prefix) && !entry.slice(prefix.length).includes("/"),
              )
              .sort((a, b) => Number(dirs.has(b)) - Number(dirs.has(a)) || a.localeCompare(b))
              .map((entry) => ({
                path: entry,
                name: entry.split("/").pop(),
                is_dir: dirs.has(entry),
                children: null,
              }));
            return { path, name: path.split("/").pop(), is_dir: true, children };
          }
          if (command === "read_file_content") return "";
          if (command === "rename_path") {
            const [from, to] = [args.oldPath as string, args.newPath as string];
            if (exists(to)) throw `Destination already exists: ${to}`;
            move(from, to);
            return null;
          }
          if (command === "copy_path") {
            const [src, dest] = [args.src as string, args.dest as string];
            if (exists(dest)) throw "Copy destination already exists";
            if (files.has(src)) files.add(dest);
            else dirs.add(dest);
            return null;
          }
          if (command === "delete_path") {
            const path = args.path as string;
            for (const dir of [...dirs])
              if (dir === path || dir.startsWith(path + "/")) dirs.delete(dir);
            for (const file of [...files])
              if (file === path || file.startsWith(path + "/")) files.delete(file);
            return null;
          }
          return null;
        },
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
    });
  }, options);
  await page.goto("/");
  await expect(page.getByRole("tree", { name: "Files" })).toBeVisible();
}

const tree = (page: Page) => page.getByRole("tree", { name: "Files" });
const row = (page: Page, name: string) => tree(page).getByRole("treeitem", { name, exact: true });
const calls = (page: Page, command: string) =>
  page.evaluate(
    (name) =>
      (
        window as unknown as { __calls: { command: string; args: Record<string, unknown> }[] }
      ).__calls
        .filter((call) => call.command === name)
        .map((call) => call.args),
    command,
  );
const setRoots = (page: Page, paths: string[]) =>
  page.evaluate(
    (roots) =>
      (
        window as unknown as { __yavinSetRoots: (paths: string[]) => Promise<void> }
      ).__yavinSetRoots(roots),
    paths,
  );
const menu = async (page: Page, name: string) => {
  await page.getByRole("menu").getByRole("menuitem", { name, exact: true }).click();
};
const openMenuOn = async (page: Page, name: string) => {
  await row(page, name).click({ button: "right" });
  await expect(page.getByRole("menu")).toBeVisible();
};
const menuItems = async (page: Page) =>
  (await page.getByRole("menu").getByRole("menuitem").allInnerTexts()).map((text) =>
    text.split("\n")[0].trim(),
  );

// ---------------------------------------------------------------------------------------
// Several roots
// ---------------------------------------------------------------------------------------

test("several roots are rows of their own, expanded and collapsed independently", async ({
  page,
}) => {
  await fixture(page, { paths: ["/work/a.ts", "/other/src/b.ts", "/other/Cargo.toml"] });
  await setRoots(page, ["/work", "/other"]);
  await expect(row(page, "work")).toHaveAttribute("aria-level", "1");
  await expect(row(page, "other")).toHaveAttribute("aria-expanded", "true");
  await expect(row(page, "a.ts")).toHaveAttribute("aria-level", "2");
  await expect(row(page, "Cargo.toml")).toBeVisible();
  // Collapsing one root leaves the other as it is.
  await row(page, "work").click();
  await expect(row(page, "a.ts")).toBeHidden();
  await expect(row(page, "Cargo.toml")).toBeVisible();
  await row(page, "work").click();
  await expect(row(page, "a.ts")).toBeVisible();
});

test("selection and keyboard navigation cross roots", async ({ page }) => {
  await fixture(page, { paths: ["/work/a.ts", "/other/b.ts"] });
  await setRoots(page, ["/work", "/other"]);
  await row(page, "a.ts").click();
  await row(page, "b.ts").click({ modifiers: ["Control"] });
  await expect(row(page, "a.ts")).toHaveAttribute("aria-selected", "true");
  await expect(row(page, "b.ts")).toHaveAttribute("aria-selected", "true");
  // From the last entry of the first root, down is the second root's row, then its entry.
  await row(page, "a.ts").click();
  await page.keyboard.press("ArrowDown");
  await expect(row(page, "other")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(row(page, "b.ts")).toBeFocused();
  await page.keyboard.press("Home");
  await expect(row(page, "work")).toBeFocused();
});

test("a root offers only what a root supports: no rename, delete, cut or drag", async ({
  page,
}) => {
  await fixture(page, { paths: ["/work/a.ts", "/other/b.ts"] });
  await setRoots(page, ["/work", "/other"]);
  await openMenuOn(page, "other");
  const items = await menuItems(page);
  expect(items).toContain("New File");
  expect(items).not.toContain("Rename...");
  expect(items.some((item) => item.startsWith("Delete"))).toBe(false);
  await page.keyboard.press("Escape");
  // The keyboard asks the same capabilities: F2 and Delete do nothing on a root.
  await row(page, "other").focus();
  await page.keyboard.press("F2");
  await expect(tree(page).getByRole("textbox")).toHaveCount(0);
  await page.keyboard.press("Delete");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(row(page, "other")).toHaveAttribute("draggable", "false");
  // An ordinary file still offers everything.
  await openMenuOn(page, "b.ts");
  expect(await menuItems(page)).toEqual(expect.arrayContaining(["Rename...", "Cut", "Copy"]));
});

test("a file dragged onto another root is moved there, through the rename operation", async ({
  page,
}) => {
  await fixture(page, { paths: ["/work/a.ts", "/other/dest/"] });
  await setRoots(page, ["/work", "/other"]);
  await row(page, "a.ts").dragTo(row(page, "dest"));
  await expect
    .poll(() => calls(page, "rename_path"))
    .toEqual([{ oldPath: "/work/a.ts", newPath: "/other/dest/a.ts" }]);
  await expect(row(page, "dest")).toHaveAttribute("aria-expanded", "true");
  await expect(row(page, "a.ts")).toHaveAttribute("aria-level", "3");
});

// ---------------------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------------------

test("a renamed entry is the same row: its element, its selection and its keyboard focus", async ({
  page,
}) => {
  await fixture(page, { paths: ["/work/src/a.ts", "/work/b.ts"] });
  await row(page, "src").click();
  await expect(row(page, "a.ts")).toBeVisible();
  await row(page, "src").focus();
  await row(page, "src").evaluate((element) => {
    (element as HTMLElement & { __marker?: boolean }).__marker = true;
  });
  await page.keyboard.press("F2");
  const input = tree(page).getByRole("textbox");
  await input.fill("lib");
  await input.press("Enter");
  await expect(row(page, "lib")).toBeVisible();
  expect(
    await row(page, "lib").evaluate(
      (element) => (element as HTMLElement & { __marker?: boolean }).__marker === true,
    ),
  ).toBe(true);
  await expect(row(page, "lib")).toBeFocused();
  await expect(row(page, "lib")).toHaveAttribute("aria-selected", "true");
  await expect(row(page, "a.ts")).toBeVisible();
});

// ---------------------------------------------------------------------------------------
// Loading and errors
// ---------------------------------------------------------------------------------------

test("a folder shows it is loading, then its children", async ({ page }) => {
  await fixture(page, { paths: ["/work/slow/a.ts"], slow: ["/work/slow"] });
  await row(page, "slow").click();
  await expect(tree(page).getByText("Loading…")).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as { __fs: { release(path: string): void } }).__fs.release("/work/slow"),
  );
  await expect(row(page, "a.ts")).toBeVisible();
  await expect(tree(page).getByText("Loading…")).toHaveCount(0);
});

test("a folder collapsed while loading is not left stuck when expanded again", async ({ page }) => {
  await fixture(page, { paths: ["/work/slow/a.ts"], slow: ["/work/slow"] });
  await row(page, "slow").click();
  await expect(tree(page).getByText("Loading…")).toBeVisible();
  await row(page, "slow").click(); // collapsed: this view gives up on the listing
  await row(page, "slow").click(); // expanded again: it wants the same listing again
  await expect(tree(page).getByText("Loading…")).toBeVisible();
  // The one listing in flight answers; someone still wants it, so it is applied.
  await page.evaluate(() =>
    (window as unknown as { __fs: { release(path: string): void } }).__fs.release("/work/slow"),
  );
  await expect(row(page, "a.ts")).toBeVisible();
  await expect(tree(page).getByText("Loading…")).toHaveCount(0);
  const listed = (await calls(page, "list_workspace_files")).filter(
    (call) => call.path === "/work/slow",
  );
  expect(listed).toHaveLength(1);
});

test("a failed folder says why, and Retry goes through the provider", async ({ page }) => {
  await fixture(page, {
    paths: ["/work/locked/a.ts", "/work/ok.ts"],
    failing: { "/work/locked": "permission denied" },
  });
  await row(page, "locked").click();
  const error = tree(page).getByRole("alert");
  await expect(error).toContainText("⚠ permission denied");
  await expect(row(page, "a.ts")).toHaveCount(0);
  await page.evaluate(() => {
    delete (window as unknown as { __fs: { failing: Record<string, string> } }).__fs.failing[
      "/work/locked"
    ];
  });
  await tree(page).getByRole("button", { name: "Retry" }).click();
  await expect(row(page, "a.ts")).toBeVisible();
  await expect(error).toHaveCount(0);
});

test("a refresh that fails on a loaded folder shows the error above what is still known", async ({
  page,
}) => {
  await fixture(page, { paths: ["/work/src/a.ts"] });
  await row(page, "src").click();
  await expect(row(page, "a.ts")).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { __fs: { failing: Record<string, string> } }).__fs.failing["/work/src"] =
      "drive disconnected";
  });
  await page.getByTitle("Refresh Explorer", { exact: true }).click();
  await expect(tree(page).getByRole("alert")).toContainText("drive disconnected");
  await expect(row(page, "a.ts")).toBeVisible();
});

// ---------------------------------------------------------------------------------------
// Reveal
// ---------------------------------------------------------------------------------------

test("Reveal Active File expands and lists every folder above it, in any root", async ({
  page,
}) => {
  // The file in front is in a second root, three folders down, none of them listed.
  await fixture(page, {
    paths: ["/work/a.ts", "/other/deep/er/x.ts", "/other/top.ts"],
    session: {
      folders: ["/work"],
      workspaces: [
        {
          folder: "/work",
          files: ["/other/deep/er/x.ts"],
          active: "/other/deep/er/x.ts",
          expanded: ["/work"],
          scroll: 0,
        },
      ],
    },
  });
  await expect(page.getByRole("tab", { name: /x\.ts/ })).toBeVisible();
  await setRoots(page, ["/work", "/other"]);
  await expect(row(page, "top.ts")).toBeVisible();
  await expect(row(page, "x.ts")).toHaveCount(0);

  await page.getByRole("menubar").getByRole("menuitem", { name: "View", exact: true }).click();
  await page.getByRole("menuitem", { name: "Reveal Active File in Explorer", exact: true }).click();

  await expect(row(page, "x.ts")).toBeVisible();
  await expect(row(page, "x.ts")).toHaveAttribute("aria-selected", "true");
  await expect(row(page, "deep")).toHaveAttribute("aria-expanded", "true");
  await expect(row(page, "er")).toHaveAttribute("aria-expanded", "true");
  const listed = (await calls(page, "list_workspace_files")).map((call) => call.path);
  expect(listed).toEqual(expect.arrayContaining(["/other/deep", "/other/deep/er"]));
});

// ---------------------------------------------------------------------------------------
// Clipboard and deletion
// ---------------------------------------------------------------------------------------

test("copy and paste goes through the copy operation; a name collision is refused", async ({
  page,
}) => {
  await fixture(page, { paths: ["/work/a.ts", "/work/dest/", "/work/taken/a.ts"] });
  // Focused, not clicked: a click opens the file, and the editor takes the keyboard.
  await row(page, "a.ts").focus();
  await page.keyboard.press("Control+c");
  await row(page, "dest").focus();
  await page.keyboard.press("Control+v");
  await expect
    .poll(() => calls(page, "copy_path"))
    .toEqual([{ src: "/work/a.ts", dest: "/work/dest/a.ts" }]);
  await expect(row(page, "dest")).toHaveAttribute("aria-expanded", "true");
  await expect(tree(page).getByRole("treeitem", { name: "a.ts" })).toHaveCount(2);
  // Into a folder already holding one: the operation refuses, and says so.
  await row(page, "taken").click();
  await row(page, "taken").focus();
  await page.keyboard.press("Control+v");
  await expect(page.getByRole("alert").first()).toContainText("already exists");
});

test("cut and paste moves several entries through the rename operation", async ({ page }) => {
  await fixture(page, { paths: ["/work/a.ts", "/work/b.ts", "/work/dest/"] });
  await row(page, "a.ts").click();
  await row(page, "b.ts").click({ modifiers: ["Control"] });
  await page.keyboard.press("Control+x");
  await row(page, "dest").focus();
  await page.keyboard.press("Control+v");
  await expect.poll(async () => (await calls(page, "rename_path")).length).toBe(2);
  expect((await calls(page, "rename_path")).map((call) => call.newPath).sort()).toEqual([
    "/work/dest/a.ts",
    "/work/dest/b.ts",
  ]);
});

test("a folder cannot be dropped into itself or its own subtree", async ({ page }) => {
  await fixture(page, { paths: ["/work/src/inner/x.ts"] });
  await row(page, "src").click();
  await row(page, "src").dragTo(row(page, "inner"));
  await row(page, "src").dragTo(row(page, "src"));
  expect(await calls(page, "rename_path")).toEqual([]);
});

test("deleting a selected entry drops it from the selection", async ({ page }) => {
  await fixture(page, { paths: ["/work/a.ts", "/work/b.ts"] });
  await row(page, "a.ts").click();
  await row(page, "b.ts").click({ modifiers: ["Control"] });
  await row(page, "a.ts").focus();
  await openMenuOn(page, "a.ts");
  await menu(page, "Delete 2 Items...");
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(row(page, "a.ts")).toHaveCount(0);
  await expect(row(page, "b.ts")).toHaveCount(0);
  await expect(tree(page).locator('[aria-selected="true"]')).toHaveCount(0);
});

// ---------------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------------

test("the session restores expansion, selection and focus", async ({ page }) => {
  await fixture(page, {
    paths: ["/work/src/deep/x.ts", "/work/src/y.ts", "/work/z.ts"],
    session: {
      folders: ["/work"],
      workspaces: [
        {
          folder: "/work",
          files: [],
          expanded: ["/work", "/work/src", "/work/src/deep"],
          selected: ["/work/src/y.ts"],
          focused: "/work/src/y.ts",
          scroll: 0,
        },
      ],
    },
  });
  await expect(row(page, "x.ts")).toBeVisible();
  await expect(row(page, "y.ts")).toHaveAttribute("aria-selected", "true");
  // The restored focus is the tree's one tab stop.
  await expect(row(page, "y.ts")).toHaveAttribute("tabindex", "0");
  // And what the explorer looks like now is written back, selection included.
  await row(page, "z.ts").click();
  await expect
    .poll(async () => {
      const saved = await calls(page, "save_workspace_session");
      const state = saved.at(-1)?.state as { selected?: string[]; focused?: string } | undefined;
      return [state?.selected, state?.focused];
    })
    .toEqual([["/work/z.ts"], "/work/z.ts"]);
});

// ---------------------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------------------

test("one new file in a folder of 20,000 re-renders a handful of rows, not the list", async ({
  page,
}) => {
  await page.addInitScript(() => {
    let rendered = 0;
    const find = (fiber: unknown) => {
      type Fiber = {
        type?: { type?: { name?: string } };
        child?: Fiber;
        sibling?: Fiber;
        flags: number;
      };
      let count = 0;
      const stack: Fiber[] = [fiber as Fiber];
      while (stack.length) {
        const next = stack.pop()!;
        // Memoized rows: `TreeRow` is the inner function of `React.memo`.
        if (next.type?.type?.name === "TreeRow" && (next.flags & 1) === 1) count++;
        if (next.sibling) stack.push(next.sibling);
        if (next.child) stack.push(next.child);
      }
      return count;
    };
    Object.assign(window, {
      __rowRenders: () => rendered,
      __REACT_DEVTOOLS_GLOBAL_HOOK__: {
        supportsFiber: true,
        renderers: new Map(),
        inject: () => 1,
        checkDCE: () => {},
        onScheduleFiberRoot: () => {},
        onCommitFiberUnmount: () => {},
        onPostCommitFiberRoot: () => {},
        onCommitFiberRoot: (_id: number, root: { current: unknown }) => {
          rendered += find(root.current);
        },
      },
    });
  });
  const paths = Array.from(
    { length: 20_000 },
    (_, n) => `/work/big/f${String(n).padStart(5, "0")}.ts`,
  );
  await fixture(page, { paths });
  await row(page, "big").click();
  await expect(row(page, "f00000.ts")).toBeVisible();
  const before = await page.evaluate(() =>
    (window as unknown as { __rowRenders: () => number }).__rowRenders(),
  );
  await page.evaluate(() =>
    (window as unknown as { __fs: { add(path: string): void } }).__fs.add("/work/big/aaa.ts"),
  );
  await page.getByTitle("Refresh Explorer", { exact: true }).click();
  await expect(row(page, "aaa.ts")).toBeVisible();
  const after = await page.evaluate(() =>
    (window as unknown as { __rowRenders: () => number }).__rowRenders(),
  );
  // The rows on screen shift by one; everything else keeps its element and props.
  expect(after - before).toBeLessThan(60);
});

test("a folder of 100,000 files expands, stays virtualized and scrolls to its end", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const paths = Array.from(
    { length: 100_000 },
    (_, n) => `/work/huge/f${String(n).padStart(6, "0")}.ts`,
  );
  await fixture(page, { paths });
  const started = Date.now();
  await row(page, "huge").click();
  await expect(row(page, "f000000.ts")).toBeVisible({ timeout: 60_000 });
  const expanded = Date.now() - started;
  expect(await tree(page).getByRole("treeitem").count()).toBeLessThan(200);
  await tree(page).evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(row(page, "f099999.ts")).toBeVisible();
  // A keystroke in the list: the flattening of 100,000 rows must not make it crawl.
  await row(page, "f099999.ts").focus();
  const moved = Date.now();
  await page.keyboard.press("ArrowUp");
  await expect(row(page, "f099998.ts")).toBeFocused();
  const step = Date.now() - moved;
  console.log(`100,000 files: expanded in ${expanded} ms; one arrow key in ${step} ms`);
  expect(step).toBeLessThan(1000);
});

// ---------------------------------------------------------------------------------------
// No folder
// ---------------------------------------------------------------------------------------

test("with no folder open, the Explorer says so and offers to open one", async ({ page }) => {
  await fixture(page, { paths: [], noWorkspace: true }).catch(() => undefined);
  const section = page.getByRole("region", { name: "No Folder Opened" });
  await expect(section).toBeVisible();
  await expect(section).toContainText("You have not yet opened a folder.");
  await expect(page.getByRole("tree", { name: "Files" })).toBeHidden();
  const open = section.getByRole("button", { name: "Open Folder", exact: true });
  await open.click();
  await expect.poll(async () => (await calls(page, "open_folder_dialog")).length).toBe(1);
  // The section folds like any other.
  const heading = section.getByRole("button", { name: "No Folder Opened" });
  await expect(heading).toHaveAttribute("aria-expanded", "true");
  await heading.click();
  await expect(heading).toHaveAttribute("aria-expanded", "false");
  await expect(open).toBeHidden();
});

// ---------------------------------------------------------------------------------------
// Git decorations across Explorer identity changes
// ---------------------------------------------------------------------------------------

test("a modified file renamed in the Explorer keeps its row, its selection and a fresh Git badge", async ({
  page,
}) => {
  await fixture(page, {
    paths: ["/work/src/app.ts", "/work/src/util.ts"],
    git: { "/work": ["src/app.ts"] },
  });
  await row(page, "src").click();
  await expect(row(page, "app.ts").getByLabel("Git: Modified")).toBeVisible();
  const statusBefore = (await calls(page, "git_exec")).filter(
    (call) => (call.args as string[])[0] === "status",
  ).length;

  // Selected (a click, which also opens it), then the row takes the keyboard back for F2.
  await row(page, "app.ts").click();
  await row(page, "app.ts").focus();
  await page.keyboard.press("F2");
  const input = tree(page).getByRole("textbox");
  await input.fill("main.ts");
  await input.press("Enter");

  // Focus stays in the Explorer, on the renamed row -- the open editor, following its
  // document to the new name, does not take it.
  await expect(row(page, "main.ts")).toBeFocused();
  await expect(row(page, "main.ts")).toHaveAttribute("aria-selected", "true");
  // Git was asked again, and its answer -- keyed by the resource's path -- lands on the new
  // name; nothing is left on the old one.
  await expect(row(page, "main.ts").getByLabel("Git: Renamed")).toBeVisible();
  await expect(row(page, "app.ts")).toHaveCount(0);
  expect(
    (await calls(page, "git_exec")).filter((call) => (call.args as string[])[0] === "status")
      .length,
  ).toBeGreaterThan(statusBefore);
  await expect(row(page, "util.ts").getByLabel(/^Git:/)).toHaveCount(0);
});

test("a file in one repository never shows another's status, even with the same name", async ({
  page,
}) => {
  await fixture(page, {
    paths: ["/work/a.ts", "/other/a.ts"],
    git: { "/work": ["a.ts"], "/other": [] },
  });
  await setRoots(page, ["/work", "/other"]);
  const both = tree(page).getByRole("treeitem", { name: "a.ts", exact: true });
  await expect(both).toHaveCount(2);
  // Roots in order: /work's a.ts first.
  await expect(both.nth(0).getByLabel("Git: Modified")).toBeVisible();
  await expect(both.nth(1).getByLabel(/^Git:/)).toHaveCount(0);
  // Selecting and expanding around the decorated row does not disturb it, nor Git's answer.
  await both.nth(1).focus();
  await page.keyboard.press("ArrowUp");
  await expect(both.nth(0).getByLabel("Git: Modified")).toBeVisible();
});
