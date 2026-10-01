import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * Local History (LG-08) against a scripted native side: the panel shows what the `localgit_*`
 * commands answer, asks before anything that changes the disk, and shows every refusal the
 * backend gives -- it computes nothing of its own.
 */
type Options = {
  commits?: number;
  operation?: boolean;
  refuseRestore?: boolean;
  undoRefused?: boolean;
  detached?: boolean;
};

async function open(page: Page, options: Options = {}) {
  await page.addInitScript((opts: Options) => {
    const hex = (n: number) => n.toString(16).padStart(64, "0");
    const total = opts.commits ?? 3;
    const kindOf = (n: number) =>
      n === 0 ? "ai" : n === 1 ? "merge" : n === 2 ? "recovery" : "human";
    const info = (n: number) => ({
      id: hex(n),
      shortId: hex(n).slice(0, 12),
      message: n === 0 ? "AI: refactor parser\n\nBody of the AI commit." : `Commit number ${n}`,
      summary: n === 0 ? "AI: refactor parser" : `Commit number ${n}`,
      timeMs: Date.now() - n * 60_000,
      tzOffsetMin: 0,
      authorName: n === 0 ? "Yavin AI" : "Ada",
      authorId: "a",
      parents: kindOf(n) === "merge" ? [hex(n + 1), hex(9999)] : n + 1 < total ? [hex(n + 1)] : [],
      source: kindOf(n) === "merge" ? "human" : kindOf(n),
      root: hex(5000 + n),
      diskRoot: null,
      overlays: null,
    });
    const side = {
      class: "file",
      id: "b".repeat(64),
      executable: false,
      stored: true,
      size: null,
      link: null,
    };
    const entries = (lineDiffs: boolean) => [
      {
        folderId: "f-1",
        path: "src/parser.ts",
        oldPath: null,
        kind: "modified",
        old: side,
        new: side,
        contentAvailable: true,
        unavailable: null,
        binary: false,
        lineDiff: lineDiffs
          ? {
              additions: 1,
              deletions: 1,
              hunks: [
                {
                  oldStart: 1,
                  oldLines: 1,
                  newStart: 1,
                  newLines: 1,
                  lines: [
                    {
                      kind: "deletion",
                      text: "const old = 1;",
                      oldLine: 1,
                      newLine: null,
                      noNewline: false,
                    },
                    {
                      kind: "addition",
                      text: "const parsed = 2;",
                      oldLine: null,
                      newLine: 1,
                      noNewline: false,
                    },
                  ],
                },
              ],
            }
          : null,
        lineDiffSkipped: lineDiffs ? null : "notRequested",
      },
      {
        folderId: "f-1",
        path: "assets/big.bin",
        oldPath: null,
        kind: "added",
        old: null,
        new: { ...side, stored: false, size: 50_000_000 },
        contentAvailable: false,
        unavailable: "notStored",
        binary: false,
        lineDiff: null,
        lineDiffSkipped: "unavailable",
      },
      {
        folderId: "f-1",
        path: "src/new-name.ts",
        oldPath: "src/old-name.ts",
        kind: "renamed",
        old: side,
        new: side,
        contentAvailable: true,
        unavailable: null,
        binary: false,
        lineDiff: null,
        lineDiffSkipped: "notRequested",
      },
      {
        folderId: "f-1",
        path: "src/gone.ts",
        oldPath: null,
        kind: "deleted",
        old: side,
        new: null,
        contentAvailable: true,
        unavailable: null,
        binary: false,
        lineDiff: null,
        lineDiffSkipped: "notRequested",
      },
    ];
    const plan = (conflicts: unknown[]) => ({
      commit: hex(1),
      targetRoot: hex(5001),
      scope: null,
      scopeFolder: null,
      policy: "refuseIfDirty",
      operations: [
        {
          kind: "writeFile",
          folderId: "f-1",
          path: "src/parser.ts",
          expected: { kind: "file", id: "x", stored: true },
          blob: "y",
          size: 3,
          executable: false,
          link: null,
        },
        {
          kind: "removeFile",
          folderId: "f-1",
          path: "src/extra.ts",
          expected: { kind: "file", id: "x", stored: true },
          blob: null,
          size: null,
          executable: false,
          link: null,
        },
      ],
      conflicts,
      documents: [],
      unchanged: false,
      snapshotSequence: 1,
      diskRoot: hex(7),
    });
    const run = (id: string, status: string, interrupted: boolean, undo: boolean) => ({
      version: 1,
      agentRunId: id,
      taskId: "task:7/x",
      changeSetId: "cs-1",
      changeSetRevision: "r2",
      workspace: "ws-0123",
      checkpoint: hex(4242),
      head: hex(1),
      branch: "main",
      index: null,
      reason: `Run ${id}`,
      model: null,
      startedMs: Date.now() - 1000,
      finishedMs: null,
      status,
      validation: { passed: true, reference: "ci-9" },
      note: null,
      changes: [{ folderId: "f-1", path: "src/parser.ts", before: null, after: null }],
      unattributed: ["f-1:notes.txt"],
      commit: status === "committed" ? hex(0) : null,
      undo: null,
      undoneMs: null,
      interrupted,
      undoAvailable: undo,
    });
    const calls: { command: string; args: Record<string, unknown> }[] = [];
    Object.assign(window, {
      __calls: calls,
      isTauri: true,
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        transformCallback: () => 1,
        unregisterCallback: () => {},
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          calls.push({ command, args });
          if (command === "get_default_workspace") return "/work";
          if (command === "list_workspace_files")
            return { path: "/work", name: "work", is_dir: true, children: [] };
          if (command === "git_open_repo") return null;
          if (command === "localgit_open")
            return {
              handle: "lg-1",
              workspace: "ws-0123",
              mode: "writer",
              readOnlyReason: null,
              format: 1,
              revision: 1,
              head: { symbolic: "refs/heads/main", detached: null },
              headCommit: hex(0),
              refCount: 2,
              objectCount: 10,
              segmentCount: 1,
              storageBytes: 100,
              folders: [{ folderId: "f-1", path: "/work" }],
              findings: [],
            };
          if (command === "localgit_head")
            return {
              state: opts.detached
                ? { kind: "detached", commit: hex(0) }
                : { kind: "branch", name: "main", refName: "refs/heads/main", commit: hex(0) },
              symbolic: opts.detached ? null : "refs/heads/main",
              unborn: false,
              commit: total ? info(0) : null,
              revision: 1,
            };
          if (command === "localgit_history") {
            const start = args.cursor ? parseInt(String(args.cursor), 16) : 0;
            const limit = Number(args.limit);
            const items = [];
            for (let n = start; n < Math.min(total, start + limit); n++) items.push(info(n));
            const next = start + limit < total ? hex(start + limit) : null;
            return { items, next, broken: null };
          }
          if (command === "localgit_branches")
            return [
              {
                name: "main",
                refName: "refs/heads/main",
                commit: hex(0),
                current: true,
                merged: true,
                upstream: null,
              },
            ];
          if (command === "localgit_tags")
            return [{ name: "v1", refName: "refs/tags/v1", commit: hex(1) }];
          if (command === "localgit_operation")
            return opts.operation
              ? {
                  version: 1,
                  kind: "merge",
                  phase: "conflicts",
                  branch: "main",
                  head: hex(0),
                  theirs: hex(3),
                  base: hex(4),
                  label: "branch 'feature'",
                  fastForward: false,
                  indexBefore: null,
                  diskBefore: hex(6),
                  resultIndex: hex(7),
                  resultWork: hex(8),
                  commit: null,
                  message: "Merge branch 'feature'",
                  touched: [],
                  conflicts: [
                    {
                      folderId: "f-1",
                      path: "src/parser.ts",
                      kind: "modifyModify",
                      base: null,
                      ours: null,
                      theirs: null,
                      markers: true,
                      binary: false,
                      unavailable: null,
                      resolution: "unresolved",
                      resolved: null,
                    },
                  ],
                }
              : null;
          if (command === "localgit_read_commit") {
            const n = parseInt(String(args.id), 16);
            const base = info(n);
            return {
              id: base.id,
              root: base.root,
              diskRoot: null,
              parents: base.parents,
              workspace: "ws-0123",
              authorName: base.authorName,
              authorId: "a",
              timeMs: base.timeMs,
              tzOffsetMin: 0,
              source: base.source,
              meta:
                n === 0
                  ? {
                      "ai.run": "run:A/1",
                      "ai.task": "task:7/x",
                      "ai.changeset": "cs-1",
                      "ai.changeset-revision": "r2",
                      "ai.checkpoint": hex(4242),
                      "ai.validation": "passed",
                    }
                  : {},
              metaObjects: {},
              message: base.message,
            };
          }
          if (command === "localgit_diff_commits")
            return {
              from: { kind: "commit", commit: args.from, root: null },
              to: { kind: "commit", commit: args.to, root: null },
              identical: false,
              entries: entries(Boolean(args.lineDiffs)),
              counts: { added: 1, modified: 1, deleted: 1, typeChanged: 0, renamed: 1 },
            };
          if (command === "localgit_restore") {
            const refused = opts.refuseRestore
              ? [
                  {
                    kind: "dirtyDocumentWouldBeOverwritten",
                    folderId: "f-1",
                    path: "src/parser.ts",
                  },
                ]
              : [];
            return {
              status: args.dryRun ? (refused.length ? "refused" : "planned") : "completed",
              plan: plan(refused),
              conflicts: refused,
              checkpoint: null,
              operation: args.dryRun ? null : 1,
              applied: args.dryRun ? 0 : 2,
              error: null,
              verification: null,
            };
          }
          if (command === "localgit_ai_runs")
            return {
              items: [
                run("run:A/1", "committed", false, true),
                run("run:B/2", "running", true, false),
              ],
              total: 2,
            };
          if (command === "localgit_ai_undo") {
            const refusals = opts.undoRefused
              ? [{ kind: "humanChangedAiPath", folderId: "f-1", path: "src/parser.ts" }]
              : [];
            return {
              status: refusals.length ? "refused" : args.dryRun ? "planned" : "completed",
              plan: {
                agentRunId: args.agentRunId,
                refusals,
                merged: [],
                restore: plan([]),
                movesHead: true,
              },
              refusals,
              conflicts: [],
              operation: null,
              applied: args.dryRun ? 0 : 2,
              error: null,
              verification: null,
              run: null,
              head: { kind: "branch", name: "main", refName: "refs/heads/main", commit: hex(1) },
            };
          }
          if (command === "localgit_stash_list")
            return {
              items: [
                {
                  id: "s0001-000",
                  refName: "refs/yavin/stash/s0001-000",
                  commit: hex(77),
                  shortId: hex(77).slice(0, 12),
                  message: "WIP on main: parser",
                  timeMs: Date.now(),
                  base: hex(1),
                  branch: "main",
                  hasUntracked: false,
                  counts: { staged: 1, unstaged: 2, untracked: 0 },
                },
              ],
              total: 1,
            };
          return null;
        },
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
    });
  }, options);
  await page.goto("/");
  await page.getByTitle("Local History").click();
  const panel = page.getByRole("complementary", { name: "Local History" });
  await expect(panel).toBeVisible();
  return panel;
}

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

test("an empty Local History says so", async ({ page }) => {
  const panel = await open(page, { commits: 0 });
  await expect(panel.getByText("No Local History yet.")).toBeVisible();
});

test("history loads with HEAD, the branch, tags and each entry's kind", async ({ page }) => {
  const panel = await open(page);
  await expect(panel.getByLabel("Local HEAD")).toContainText("main");
  const list = panel.getByRole("listbox", { name: "Local History entries" });
  const head = list.getByRole("option").first();
  await expect(head).toContainText("AI");
  await expect(head).toContainText("HEAD");
  await expect(head).toContainText("main");
  await expect(list.getByRole("option").nth(1)).toContainText("Merge");
  await expect(list.getByRole("option").nth(1)).toContainText("tag: v1");
  await expect(list.getByRole("option").nth(2)).toContainText("Recovery");
});

test("a detached HEAD is shown as such", async ({ page }) => {
  const panel = await open(page, { detached: true });
  await expect(panel.getByLabel("Local HEAD")).toContainText("detached at");
});

test("long histories page in and render only the rows in view", async ({ page }) => {
  const panel = await open(page, { commits: 1000 });
  const list = panel.getByRole("listbox", { name: "Local History entries" });
  await expect(list.getByRole("option").first()).toBeVisible();
  expect(await list.getByRole("option").count()).toBeLessThan(60);
  await panel.getByRole("button", { name: "Load older entries" }).click();
  await expect.poll(async () => (await calls(page, "localgit_history")).length).toBeGreaterThan(1);
  const second = (await calls(page, "localgit_history")).find((args) => args.cursor);
  expect(second?.cursor).toBe((100).toString(16).padStart(64, "0"));
  // Scrolled to the end, the rows there are rendered -- still not all of them.
  await list.evaluate((el) => (el.scrollTop = el.scrollHeight));
  // (Reaching the end also asks for the next page by itself.)
  await expect
    .poll(async () => {
      const label = (await list.getByRole("option").last().getAttribute("aria-label")) ?? "";
      return Number(/Commit number (\d+)/.exec(label)?.[1] ?? 0);
    })
    .toBeGreaterThan(150);
  expect(await list.getByRole("option").count()).toBeLessThan(60);
});

test("an entry's details show its AI provenance as recorded, and its changed files", async ({
  page,
}) => {
  const panel = await open(page);
  await panel.getByRole("option").first().click();
  const details = panel.getByRole("region", { name: "Entry details" });
  await expect(details).toContainText("AI: refactor parser");
  await expect(details).toContainText("run:A/1");
  await expect(details).toContainText("task:7/x");
  await expect(details).toContainText("cs-1 @ r2");
  await expect(details).toContainText("passed");
  await expect(details).not.toContainText("Model");
  const files = details.getByRole("list", { name: "Changed files" });
  await expect(files.getByRole("listitem")).toHaveCount(4);
  await expect(files).toContainText("src/old-name.ts → src/new-name.ts");
  await expect(files.getByLabel("Deleted")).toBeVisible();
  await expect(files.getByLabel("Renamed")).toBeVisible();
  await expect(files).toContainText("unavailable");
});

test("a file's diff opens read-only in the diff view; unavailable content says why", async ({
  page,
}) => {
  const panel = await open(page);
  await panel.getByRole("option").first().click();
  const details = panel.getByRole("region", { name: "Entry details" });
  await details.getByRole("button", { name: "src/parser.ts", exact: true }).click();
  await expect(page.getByText("const parsed = 2;").first()).toBeVisible();
  await expect(page.getByText(/Local History, read-only/).first()).toBeVisible();
  await details.getByRole("button", { name: "assets/big.bin", exact: true }).click();
  await expect(page.getByText(/over Local Git's storage limit/).first()).toBeVisible();
  // Comparing with the workspace asks the backend for that diff instead.
  await details.getByLabel("Compare with").selectOption("workspace");
  await expect
    .poll(async () => (await calls(page, "localgit_diff_workspace")).length)
    .toBeGreaterThan(0);
});

test("restore shows the plan first, and only a confirmed restore changes anything", async ({
  page,
}) => {
  const panel = await open(page);
  await panel.getByRole("option").nth(1).click();
  const details = panel.getByRole("region", { name: "Entry details" });
  await details.getByRole("button", { name: "Restore…" }).click();
  const sheet = page.getByRole("dialog", { name: /Restore/ });
  await expect(sheet).toContainText("src/parser.ts");
  await expect(sheet.getByRole("list", { name: "Deleted" })).toContainText("src/extra.ts");
  let restores = await calls(page, "localgit_restore");
  expect(restores.every((args) => args.dryRun === true)).toBe(true);
  await sheet.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(details.getByRole("status")).toContainText("Restored");
  restores = await calls(page, "localgit_restore");
  expect(restores.at(-1)?.dryRun).toBe(false);
  expect(restores.at(-1)?.policy).toBe("refuseIfDirty");
  // A single file is restored by its path.
  await details.getByRole("button", { name: "Restore src/gone.ts" }).click();
  await expect(page.getByRole("dialog", { name: "Restore src/gone.ts" })).toBeVisible();
  restores = await calls(page, "localgit_restore");
  expect(restores.at(-1)?.path).toBe("src/gone.ts");
});

test("a refused restore shows the backend's own reason and cannot be confirmed", async ({
  page,
}) => {
  const panel = await open(page, { refuseRestore: true });
  await panel.getByRole("option").nth(1).click();
  await panel.getByRole("button", { name: "Restore…" }).click();
  const sheet = page.getByRole("dialog", { name: /Restore/ });
  await expect(sheet.getByRole("list", { name: "Reasons" })).toContainText(
    "src/parser.ts: has unsaved changes that would be overwritten",
  );
  await expect(sheet.getByRole("button", { name: "Restore", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  const restores = await calls(page, "localgit_restore");
  expect(restores.every((args) => args.dryRun === true)).toBe(true);
});

test("AI runs show their recorded status; an interrupted run never looks finished", async ({
  page,
}) => {
  const panel = await open(page);
  await panel.getByRole("tab", { name: "AI Runs" }).click();
  const runs = panel.getByRole("listbox", { name: "AI runs" });
  await expect(runs.getByRole("option").first()).toContainText("Committed");
  await expect(runs.getByRole("option").nth(1)).toContainText("Interrupted");
  await runs.getByRole("option").nth(1).click();
  const details = panel.getByRole("region", { name: "AI run details" });
  await expect(details).toContainText("run:B/2");
  await expect(details.getByRole("button", { name: "Undo AI Run…" })).toHaveCount(0);
  await runs.getByRole("option").first().click();
  await expect(details).toContainText("task:7/x");
  await expect(details).toContainText("cs-1 @ r2");
  await expect(details.getByRole("list", { name: "Changes not by the AI" })).toContainText(
    "notes.txt",
  );
  await expect(details).toContainText("Checkpoint");
  await expect(details).toContainText("AI commit");
});

test("Undo AI Run shows what it will do, and runs only when confirmed", async ({ page }) => {
  const panel = await open(page);
  await panel.getByRole("tab", { name: "AI Runs" }).click();
  await panel.getByRole("option").first().click();
  await panel.getByRole("button", { name: "Undo AI Run…" }).click();
  const sheet = page.getByRole("dialog", { name: /Undo AI run/ });
  await expect(sheet).toContainText("Only the AI's changes are taken out");
  await expect(sheet).toContainText("HEAD moves back");
  let undos = await calls(page, "localgit_ai_undo");
  expect(undos.every((args) => args.dryRun === true)).toBe(true);
  await sheet.getByRole("button", { name: "Undo AI Run" }).click();
  await expect(
    panel.getByRole("region", { name: "AI run details" }).getByRole("status"),
  ).toContainText("undone");
  undos = await calls(page, "localgit_ai_undo");
  expect(undos.at(-1)?.dryRun).toBe(false);
});

test("a refused undo shows the exact reason and cannot be confirmed", async ({ page }) => {
  const panel = await open(page, { undoRefused: true });
  await panel.getByRole("tab", { name: "AI Runs" }).click();
  await panel.getByRole("option").first().click();
  await panel.getByRole("button", { name: "Undo AI Run…" }).click();
  const sheet = page.getByRole("dialog", { name: /Undo AI run/ });
  await expect(sheet.getByRole("list", { name: "Reasons" })).toContainText(
    "src/parser.ts: changed by a person since the AI",
  );
  await expect(sheet.getByRole("button", { name: "Undo AI Run" })).toBeDisabled();
});

test("stashes are listed with their counts and base", async ({ page }) => {
  const panel = await open(page);
  await panel.getByRole("tab", { name: "Stashes" }).click();
  await panel.getByRole("option", { name: /WIP on main/ }).click();
  const details = panel.getByRole("region", { name: "Stash details" });
  await expect(details).toContainText("main");
  await expect(details).toContainText("Staged");
});

test("a merge in progress is shown with its conflicts; continue waits for them", async ({
  page,
}) => {
  const panel = await open(page, { operation: true });
  const banner = panel.getByRole("region", { name: "Operation in progress" });
  await expect(banner).toContainText("Merge of branch 'feature' in progress");
  await expect(banner.getByRole("list", { name: "Conflicts" })).toContainText("src/parser.ts");
  await expect(banner.getByRole("button", { name: "Continue" })).toBeDisabled();
  await expect(banner.getByRole("button", { name: "Abort" })).toBeEnabled();
});

test("entries are navigated with the keyboard", async ({ page }) => {
  const panel = await open(page);
  const list = panel.getByRole("listbox", { name: "Local History entries" });
  await list.focus();
  await page.keyboard.press("ArrowDown");
  await expect(list.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  await expect(list.getByRole("option").nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(panel.getByRole("region", { name: "Entry details" })).toContainText(
    "Commit number 1",
  );
});

test("performance: a 10,000-entry history stays bounded in the DOM (timings logged)", async ({
  page,
}) => {
  const panel = await open(page, { commits: 10_000 });
  // From the panel being shown (the app's own start is not Local History's).
  await panel.getByRole("button", { name: "Refresh Local History" }).click();
  const started = Date.now();
  const list = panel.getByRole("listbox", { name: "Local History entries" });
  await expect(list.getByRole("option").first()).toBeVisible();
  const firstRow = Date.now() - started;
  let at = Date.now();
  for (let page_ = 0; page_ < 9; page_++) {
    await list.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect
      .poll(async () => (await calls(page, "localgit_history")).filter((a) => a.cursor).length)
      .toBeGreaterThan(page_);
  }
  const pages = Date.now() - at;
  const rendered = await list.getByRole("option").count();
  expect(rendered).toBeLessThan(60);
  at = Date.now();
  await list.getByRole("option").last().click();
  await expect(panel.getByRole("region", { name: "Entry details" })).toContainText(
    "Changed files (4)",
  );
  const detail = Date.now() - at;
  at = Date.now();
  await panel
    .getByRole("region", { name: "Entry details" })
    .getByRole("button", { name: "src/parser.ts", exact: true })
    .click();
  await expect(page.getByText("const parsed = 2;").first()).toBeVisible();
  const diff = Date.now() - at;
  console.log(
    `LG08-PERF first rows after a refresh ${firstRow} ms; 9 more pages ${pages} ms; ` +
      `rows in the DOM ${rendered}; detail ${detail} ms; diff ${diff} ms`,
  );
});
