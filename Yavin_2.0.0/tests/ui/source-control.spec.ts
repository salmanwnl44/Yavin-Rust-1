import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

/** What the fake Git reports; tests mutate it and refresh to move the repository on. */
interface Scenario {
  status: string;
  branchInfo: string;
  branches: string;
  remotes: string;
  state: string;
  fail: Record<string, string>;
}

const diverged = "# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -3\n";
const behind = "# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -1\n";
const unpublished = "# branch.head feature\n";

async function panel(page: Page, scenario: Partial<Scenario> = {}) {
  await page.addInitScript((partial) => {
    const state: Scenario = {
      status: "",
      branchInfo: "# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -0\n",
      branches: "main\nfeature\n",
      remotes: "",
      state: "",
      fail: {},
      ...partial,
    };
    const calls: { command: string; args: Record<string, unknown>; action: string | null }[] = [];
    const entries: Record<string, boolean> = { "/work": true, "/work/file.ts": false };
    const node = (path: string) => ({
      path,
      name: path.slice(path.lastIndexOf("/") + 1),
      is_dir: entries[path],
      children: null as unknown,
    });
    const ok = (stdout: string) => ({ stdout, stderr: "", code: 0, truncated: false });
    // Real native-event plumbing (mirrors terminal.spec.ts's/multi-repo.spec.ts's
    // proven pattern) -- needed to simulate a "workspace-changed" event from the
    // general filesystem watcher.
    const callbacks: Record<number, (event: unknown) => void> = {};
    const listeners: Record<string, number[]> = {};
    let nextId = 1;
    Object.assign(window, {
      __calls: calls,
      __scenario: state,
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
            const event = args.event as string;
            (listeners[event] ??= []).push(args.handler as number);
            return nextId++;
          }
          const actionOfInline = (cmd: string, a: Record<string, unknown>): string | null => {
            if (cmd === "git_repo_state") return "state";
            if (cmd !== "git_exec") return null;
            const argv = (a.args as string[] | undefined) ?? [];
            switch (argv[0]) {
              case "status":
                return argv.includes("--porcelain=v2") ? "branchInfo" : "status";
              case "for-each-ref":
                return "branches";
              case "remote":
                return "remotes";
              case "fetch":
                return "fetch";
              case "pull":
                if (argv.includes("--ff-only")) return "pull";
                return argv.includes("--rebase") ? "pullRebase" : "pullMerge";
              case "push":
                return argv.includes("--set-upstream") ? "publish" : "push";
              case "rebase":
              case "merge":
              case "cherry-pick":
              case "revert":
                return argv.includes("--abort") ? "abort" : "continue";
              case "add":
                return "stage";
              case "restore":
              case "rm":
                return "unstage";
              case "commit":
                return "commit";
              case "switch":
                return argv.includes("-c") ? "branch" : "switch";
              default:
                return argv[0] ?? null;
            }
          };
          const action = actionOfInline(command, args);
          calls.push({ command, args, action });
          if (command === "get_default_workspace") return "/work";
          if (command === "list_workspace_files")
            return { ...node(args.path as string), children: [node("/work/file.ts")] };
          if (command === "read_file_content") return "contents";
          if (command === "git_open_repo") return { repoId: "/work", root: "/work" };
          if (command === "git_repo_state") return state.state;
          if (command === "git_exec") {
            const failure = action ? state.fail[action] : undefined;
            if (failure) throw failure;
            if (action === "status") return ok(state.status);
            if (action === "branchInfo") return ok(state.branchInfo);
            if (action === "branches") return ok(state.branches);
            if (action === "remotes") return ok(state.remotes);
            if (action === "symbolic-ref") return ok("main\n");
            // A successful continue really does end the interrupted operation --
            // mutating state here (as a side effect of the call itself, not
            // before it) means abortOrContinue's own state() lookup still sees
            // "merge" (deciding which op to continue) while guarded()'s later
            // post-op refresh sees the now-cleared state, exactly like real Git.
            if (action === "continue") state.state = "";
            // A "fetch" hangs until either the test resolves it or git_cancel_repo
            // is called, simulating the real Rust cancellation path rejecting an
            // in-flight/lock-queued call with the literal string "Cancelled".
            if (
              action === "fetch" &&
              (window as unknown as { __holdFetch?: boolean }).__holdFetch
            ) {
              return new Promise((_resolve, reject) => {
                (
                  window as unknown as { __pendingFetch?: (reason: unknown) => void }
                ).__pendingFetch = reject;
              });
            }
            return ok("");
          }
          if (command === "git_cancel_repo") {
            const pending = (window as unknown as { __pendingFetch?: (reason: unknown) => void })
              .__pendingFetch;
            if (pending) {
              pending("Cancelled");
              (window as unknown as { __pendingFetch?: unknown }).__pendingFetch = undefined;
            }
            return null;
          }
          return null;
        },
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
    });
  }, scenario);
  await page.goto("/");
  await page.getByTitle("Source Control (Ctrl+Shift+G)").click();
  const region = page.getByRole("complementary", { name: "Source control" });
  await expect(region).toBeVisible();
  return region;
}

/** Opens the Branches & remotes drawer, where the remote actions live. */
async function drawer(page: Page) {
  await page.getByTitle("Branches and remotes").click();
}

const emit = (page: Page, event: string, payload: unknown) =>
  page.evaluate(
    ([name, data]) =>
      (window as unknown as { __emit: (e: string, p: unknown) => void }).__emit(
        name as string,
        data,
      ),
    [event, payload] as const,
  );

const gitCalls = (page: Page, action: string) =>
  page.evaluate(
    (name) =>
      (
        window as unknown as {
          __calls: { command: string; args: Record<string, unknown>; action: string | null }[];
        }
      ).__calls.filter((call) => call.action === name).length,
    action,
  );

async function update(page: Page, changes: Partial<Scenario>) {
  await page.evaluate((next) => {
    Object.assign((window as unknown as { __scenario: Scenario }).__scenario, next);
  }, changes);
  await page.getByTitle("Refresh Status").click();
}

test("a diverged branch offers rebase and merge instead of a fast-forward pull", async ({
  page,
}) => {
  const region = await panel(page, { branchInfo: diverged });
  await drawer(page);

  await expect(region.getByText(/Diverged: 2 local and 3 remote commits/)).toBeVisible();
  await expect(region.getByText(/Neither choice stashes your work/)).toBeVisible();

  // The fast-forward pull stays visible but cannot run, so the state is explained rather than hidden.
  const pull = region.getByRole("button", { name: "Pull" });
  await expect(pull).toBeDisabled();
  await expect(pull).toHaveAttribute("title", /choose Rebase or Merge/);

  await region.getByRole("button", { name: "Rebase" }).click();
  await expect.poll(() => gitCalls(page, "pullRebase")).toBe(1);
  expect(await gitCalls(page, "pull")).toBe(0);
});

test("merge is an equal, separate choice from rebase", async ({ page }) => {
  const region = await panel(page, { branchInfo: diverged });
  await drawer(page);
  await region.getByRole("button", { name: "Merge" }).click();
  await expect.poll(() => gitCalls(page, "pullMerge")).toBe(1);
  expect(await gitCalls(page, "pullRebase")).toBe(0);
});

test("the sync pill asks on a divergence rather than choosing a side", async ({ page }) => {
  const region = await panel(page, { branchInfo: diverged });
  await region.getByTitle(/Sync changes/).click();

  await expect(region.getByRole("status")).toContainText(/diverged.*Choose Rebase or Merge/s);
  // Nothing was run on the user's behalf.
  expect(await gitCalls(page, "pull")).toBe(0);
  expect(await gitCalls(page, "pullRebase")).toBe(0);
  expect(await gitCalls(page, "push")).toBe(0);
  // The choices are revealed so they are one click away.
  await expect(region.getByRole("button", { name: "Rebase" })).toBeVisible();
});

test("a branch behind its upstream still fast-forwards on sync", async ({ page }) => {
  const region = await panel(page, { branchInfo: behind });
  await region.getByTitle(/Sync changes/).click();
  await expect.poll(() => gitCalls(page, "pull")).toBe(1);
});

test("an unpublished branch offers publication to a chosen remote", async ({ page }) => {
  const region = await panel(page, {
    branchInfo: unpublished,
    remotes: "origin\nupstream\n",
  });
  await drawer(page);

  // Pull and push are meaningless without an upstream, so they are not offered.
  await expect(region.getByRole("button", { name: "Pull" })).toBeHidden();
  await expect(region.getByRole("button", { name: "Push" })).toBeHidden();

  await region.getByLabel("Remote").selectOption("upstream");
  await region.getByRole("button", { name: "Publish branch" }).click();

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __calls: { action: string | null; args: { args?: string[] } }[];
            }
          ).__calls.filter((c) => c.action === "publish")[0]?.args.args?.[2],
      ),
    )
    .toBe("upstream");
});

test("a branch with no remote says so instead of offering a dead button", async ({ page }) => {
  const region = await panel(page, { branchInfo: unpublished });
  await drawer(page);
  await expect(region.getByText(/No remote is configured/)).toBeVisible();
  await expect(region.getByRole("button", { name: "Publish branch" })).toHaveCount(0);
});

test("authentication failures say what to do and quote Git verbatim", async ({ page }) => {
  const region = await panel(page, {
    fail: {
      fetch:
        "Git: fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    },
  });
  await drawer(page);
  await region.getByRole("button", { name: "Fetch" }).click();

  const notice = region.getByRole("status");
  await expect(notice).toContainText(/never prompts for passwords/);
  await expect(notice).toContainText(/credential helper/);
  await expect(notice).toContainText(/could not read Username/);
});

test("a rejected push explains the fix and never offers to force", async ({ page }) => {
  const region = await panel(page, {
    fail: { push: "Git: ! [rejected] main -> main (non-fast-forward)" },
  });
  await drawer(page);
  await region.getByRole("button", { name: "Push" }).click();

  await expect(region.getByRole("status")).toContainText(/Fetch and review them.*does not force/s);
  await expect(region.getByRole("button", { name: /force/i })).toHaveCount(0);
});

test("an interrupted merge must be resolved or aborted before it can continue", async ({
  page,
}) => {
  const region = await panel(page, { state: "merge", status: "UU conflict.ts\0" });

  const banner = region.getByRole("alert").filter({ hasText: "in progress" });
  await expect(banner).toContainText(/merge in progress/i);
  await expect(banner).toContainText("Resolve 1 conflicted file, stage each one, then continue.");

  // Continuing over an unresolved conflict is refused; abandoning the merge is always available.
  await expect(banner.getByRole("button", { name: "Continue" })).toBeDisabled();
  await expect(banner.getByRole("button", { name: "Abort" })).toBeEnabled();

  // Staging the resolution unblocks it.
  await update(page, { status: "M  conflict.ts\0" });
  await expect(banner.getByRole("button", { name: "Continue" })).toBeEnabled();
  await banner.getByRole("button", { name: "Continue" }).click();
  await expect.poll(() => gitCalls(page, "continue")).toBe(1);
});

test("a continue that actually completes the merge resets the commit graph", async ({ page }) => {
  const region = await panel(page, { state: "merge", status: "M  conflict.ts\0" });
  const logCalls = () =>
    page.evaluate(
      () =>
        (
          window as unknown as { __calls: { command: string; args: { args?: string[] } }[] }
        ).__calls.filter((c) => c.command === "git_exec" && c.args.args?.[0] === "log").length,
    );
  const before = await logCalls();

  const banner = region.getByRole("alert").filter({ hasText: "in progress" });
  await expect(banner.getByRole("button", { name: "Continue" })).toBeEnabled();
  await banner.getByRole("button", { name: "Continue" }).click();
  await expect.poll(() => gitCalls(page, "continue")).toBe(1);

  await expect.poll(logCalls).toBeGreaterThan(before);
});

test("an aborted merge clears the banner", async ({ page }) => {
  const region = await panel(page, { state: "merge", status: "UU conflict.ts\0" });
  const banner = region.getByRole("alert").filter({ hasText: "in progress" });
  await banner.getByRole("button", { name: "Abort" }).click();
  await expect.poll(() => gitCalls(page, "abort")).toBe(1);

  await update(page, { state: "", status: "" });
  await expect(region.getByRole("alert").filter({ hasText: "in progress" })).toHaveCount(0);
});

test("unsaved editors block every action that rewrites the working tree", async ({ page }) => {
  const region = await panel(page, { branchInfo: diverged, state: "merge" });

  // Make the workspace dirty through a real editor buffer.
  await page.getByTitle("Explorer (Ctrl+Shift+E)").click();
  await page.getByLabel("file.ts", { exact: true }).click();
  const editor = page.getByRole("textbox", { name: "file.ts", exact: true });
  await editor.click();
  await editor.fill("unsaved work");

  await page.getByTitle("Source Control (Ctrl+Shift+G)").click();
  const banner = region.getByRole("alert").filter({ hasText: "in progress" });
  await expect(banner.getByRole("button", { name: "Abort" })).toBeDisabled();

  await drawer(page);
  await expect(region.getByRole("button", { name: "Rebase" })).toBeDisabled();
  await expect(region.getByRole("button", { name: "Merge" })).toBeDisabled();
  await expect(region.getByLabel("Switch branch")).toBeDisabled();
});

test("staging a file only re-fetches status, not every sub-fetch a full refresh would run", async ({
  page,
}) => {
  const region = await panel(page, { status: " M a.ts\0" });
  const before = {
    status: await gitCalls(page, "status"),
    branchInfo: await gitCalls(page, "branchInfo"),
    branches: await gitCalls(page, "branches"),
    remotes: await gitCalls(page, "remotes"),
    state: await gitCalls(page, "state"),
  };

  await region.getByLabel("Stage /work/a.ts").click();
  await expect.poll(() => gitCalls(page, "stage")).toBe(1);

  await expect.poll(() => gitCalls(page, "status")).toBe(before.status + 1);
  expect(await gitCalls(page, "branchInfo")).toBe(before.branchInfo);
  expect(await gitCalls(page, "branches")).toBe(before.branches);
  expect(await gitCalls(page, "remotes")).toBe(before.remotes);
  expect(await gitCalls(page, "state")).toBe(before.state);
});

test("an external filesystem change only re-fetches status, not every sub-fetch a full refresh would run", async ({
  page,
}) => {
  const region = await panel(page, { status: " M a.ts\0" });
  await expect(region.getByLabel("Commit message")).toBeVisible();
  const before = {
    status: await gitCalls(page, "status"),
    branchInfo: await gitCalls(page, "branchInfo"),
    branches: await gitCalls(page, "branches"),
    remotes: await gitCalls(page, "remotes"),
    state: await gitCalls(page, "state"),
  };

  // Simulates the general workspace watcher noticing a save/create/delete/
  // rename it didn't itself trigger (an external edit, or the fallback path
  // for Yavin's own writes) -- a plain filesystem change can only ever affect
  // this worktree's own status entries, never branch/branches/remotes/
  // stashes/operation state.
  await emit(page, "workspace-changed", undefined);

  await expect.poll(() => gitCalls(page, "status")).toBe(before.status + 1);
  expect(await gitCalls(page, "branchInfo")).toBe(before.branchInfo);
  expect(await gitCalls(page, "branches")).toBe(before.branches);
  expect(await gitCalls(page, "remotes")).toBe(before.remotes);
  expect(await gitCalls(page, "state")).toBe(before.state);
});

test("committing re-fetches status, branch and operation state, still skipping branches/remotes", async ({
  page,
}) => {
  const region = await panel(page, { status: "M  a.ts\0" });
  const before = {
    status: await gitCalls(page, "status"),
    branchInfo: await gitCalls(page, "branchInfo"),
    branches: await gitCalls(page, "branches"),
    remotes: await gitCalls(page, "remotes"),
    state: await gitCalls(page, "state"),
  };

  await region.getByLabel("Commit message").fill("a commit");
  await region.getByRole("button", { name: /Commit Staged/ }).click();
  await expect.poll(() => gitCalls(page, "commit")).toBe(1);

  await expect.poll(() => gitCalls(page, "status")).toBe(before.status + 1);
  await expect.poll(() => gitCalls(page, "branchInfo")).toBe(before.branchInfo + 1);
  await expect.poll(() => gitCalls(page, "state")).toBe(before.state + 1);
  expect(await gitCalls(page, "branches")).toBe(before.branches);
  expect(await gitCalls(page, "remotes")).toBe(before.remotes);
});

test("committing resets the commit graph", async ({ page }) => {
  const region = await panel(page, { status: "M  a.ts\0" });
  const logCalls = () =>
    page.evaluate(
      () =>
        (
          window as unknown as { __calls: { command: string; args: { args?: string[] } }[] }
        ).__calls.filter((c) => c.command === "git_exec" && c.args.args?.[0] === "log").length,
    );
  // The sidebar's inline graph section mounts by default, loading page 1 once.
  await expect.poll(logCalls).toBeGreaterThan(0);
  const before = await logCalls();

  await region.getByLabel("Commit message").fill("a commit");
  await region.getByRole("button", { name: /Commit Staged/ }).click();
  await expect.poll(() => gitCalls(page, "commit")).toBe(1);

  await expect.poll(logCalls).toBeGreaterThan(before);
});

test("a Cancel button stops a running Git operation and reports it distinctly from a failure", async ({
  page,
}) => {
  const region = await panel(page);
  await page.evaluate(() => {
    (window as unknown as { __holdFetch: boolean }).__holdFetch = true;
  });
  await drawer(page);
  await region.getByRole("button", { name: "Fetch" }).click();

  const status = region.getByRole("status").filter({ hasText: /Running Git operation|Cancel/ });
  await expect(status).toContainText("Running Git operation");
  const cancel = region.getByRole("button", { name: "Cancel", exact: true });
  await expect(cancel).toBeVisible();
  await cancel.click();

  // Cancellation is reported plainly, not styled or worded like a real failure.
  await expect(status).toContainText("Cancelled");
  await expect(region.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);

  const cancelCalls = await page.evaluate(() =>
    (
      window as unknown as { __calls: { command: string; args: Record<string, unknown> }[] }
    ).__calls.filter((c) => c.command === "git_cancel_repo"),
  );
  expect(cancelCalls).toHaveLength(1);
  expect(cancelCalls[0].args.repoId).toBe("/work");
});
