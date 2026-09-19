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
                if (argv.includes("--abort")) return "abort";
                return argv.includes("--skip") ? "skip" : "continue";
              case "add":
                return "stage";
              case "restore":
              case "rm":
                return "unstage";
              case "commit":
                return "commit";
              case "switch":
                return argv.includes("-c") ? "branch" : "switch";
              case "branch":
                return "deleteBranch";
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
            const argvForFailure = (args.args as string[] | undefined) ?? [];
            // A force delete (-D) always succeeds in this mock even if a plain -d
            // was set up to fail (Git's own two-tier safety, not something this
            // scenario needs a second, separate failure map to express).
            const forcedBranchDelete = action === "deleteBranch" && argvForFailure.includes("-D");
            const failure = action && !forcedBranchDelete ? state.fail[action] : undefined;
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
            // Simulates skip having been the sequence's last remaining commit -- the
            // operation completes as a side effect of the skip call itself, exactly
            // like a completing continue (same reasoning as above).
            if (action === "skip") {
              state.state = "";
              state.status = "";
            }
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

async function showRepositories(page: Page, region: ReturnType<Page["getByRole"]>) {
  await region.getByLabel("Source Control view options").click();
  await page.getByRole("menuitem", { name: "Repositories" }).click();
  await expect(region.locator("section[aria-label='Repositories']")).toBeVisible();
}

test("the sync pill asks on a divergence rather than choosing a side", async ({ page }) => {
  const region = await panel(page, { branchInfo: diverged });
  await showRepositories(page, region);
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
  await showRepositories(page, region);
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

  await region.getByLabel("Remote", { exact: true }).selectOption("upstream");
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

test("deleting a branch only re-fetches the branch list, not every sub-fetch a full refresh would run", async ({
  page,
}) => {
  const region = await panel(page);
  await drawer(page);
  const before = {
    status: await gitCalls(page, "status"),
    branchInfo: await gitCalls(page, "branchInfo"),
    branches: await gitCalls(page, "branches"),
    remotes: await gitCalls(page, "remotes"),
    state: await gitCalls(page, "state"),
  };

  await region.getByLabel("Delete feature").click();
  await expect.poll(() => gitCalls(page, "deleteBranch")).toBe(1);

  await expect.poll(() => gitCalls(page, "branches")).toBe(before.branches + 1);
  expect(await gitCalls(page, "status")).toBe(before.status);
  expect(await gitCalls(page, "branchInfo")).toBe(before.branchInfo);
  expect(await gitCalls(page, "remotes")).toBe(before.remotes);
  expect(await gitCalls(page, "state")).toBe(before.state);
});

test("deleting a branch checked out elsewhere shows a classified message, never raw stderr", async ({
  page,
}) => {
  const region = await panel(page, {
    fail: {
      deleteBranch: "Git: error: cannot delete branch 'feature' used by worktree at '/wt'",
    },
  });
  await drawer(page);

  await region.getByLabel("Delete feature").click();
  await expect(region.getByText(/checked out in another worktree/)).toBeVisible();
});

test("an unmerged branch offers a confirmed force-delete escalation, not a silent failure", async ({
  page,
}) => {
  const region = await panel(page, {
    fail: { deleteBranch: "Git: error: the branch 'feature' is not fully merged" },
  });
  await drawer(page);
  page.once("dialog", (dialog) => void dialog.accept());

  await region.getByLabel("Delete feature").click();
  // The classified refusal is shown only transiently -- confirm() fires
  // synchronously right after it, and the force call's own success notice
  // immediately supersedes it -- so the durable proof is the actual argv of
  // both calls below, not a race-prone intermediate visibility check.
  await expect.poll(() => gitCalls(page, "deleteBranch")).toBe(2);
  const calls = await page.evaluate(() =>
    (
      window as unknown as {
        __calls: { action: string | null; args: { args?: string[] } }[];
      }
    ).__calls.filter((c) => c.action === "deleteBranch"),
  );
  expect(calls[0].args.args).toContain("-d");
  expect(calls[1].args.args).toContain("-D");
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

test("an interrupted rebase must be resolved or aborted before it can continue, exactly like a merge", async ({
  page,
}) => {
  const region = await panel(page, { state: "rebase", status: "UU conflict.ts\0" });

  const banner = region.getByRole("alert").filter({ hasText: "in progress" });
  await expect(banner).toContainText(/rebase in progress/i);
  await expect(banner).toContainText("Resolve 1 conflicted file, stage each one, then continue.");
  await expect(banner.getByRole("button", { name: "Continue" })).toBeDisabled();
  await expect(banner.getByRole("button", { name: "Abort" })).toBeEnabled();
  await expect(banner.getByRole("button", { name: "Skip" })).toBeEnabled();

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

test("an interrupted rebase shows its own label and offers Skip, unlike a merge", async ({
  page,
}) => {
  const region = await panel(page, { state: "rebase", status: "UU conflict.ts\0" });

  const banner = region.getByRole("alert").filter({ hasText: "in progress" });
  await expect(banner).toContainText(/rebase in progress/i);
  await expect(banner.getByRole("button", { name: "Skip" })).toBeEnabled();
  await expect(banner.getByRole("button", { name: "Continue" })).toBeDisabled();
  await expect(banner.getByRole("button", { name: "Abort" })).toBeEnabled();
});

test("a merge in progress never offers Skip -- Git itself has no merge --skip", async ({
  page,
}) => {
  const region = await panel(page, { state: "merge", status: "UU conflict.ts\0" });
  const banner = region.getByRole("alert").filter({ hasText: "in progress" });
  await expect(banner.getByRole("button", { name: "Skip" })).toHaveCount(0);
});

test("skipping the last commit of a rebase completes it and resets the commit graph", async ({
  page,
}) => {
  const region = await panel(page, { state: "rebase", status: "UU conflict.ts\0" });
  const logCalls = () =>
    page.evaluate(
      () =>
        (
          window as unknown as { __calls: { command: string; args: { args?: string[] } }[] }
        ).__calls.filter((c) => c.command === "git_exec" && c.args.args?.[0] === "log").length,
    );
  const before = await logCalls();

  const banner = region.getByRole("alert").filter({ hasText: "in progress" });
  await banner.getByRole("button", { name: "Skip" }).click();
  await expect.poll(() => gitCalls(page, "skip")).toBe(1);

  await expect.poll(logCalls).toBeGreaterThan(before);
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

test("Save All bumps the active repository's revision, not just individual saves", async ({
  page,
}) => {
  const region = await panel(page, { status: "" });

  // Make the workspace dirty through a real editor buffer, matching the
  // "unsaved editors block..." test's own convention for editing file.ts.
  await page.getByTitle("Explorer (Ctrl+Shift+E)").click();
  await page.getByLabel("file.ts", { exact: true }).click();
  const editor = page.getByRole("textbox", { name: "file.ts", exact: true });
  await editor.click();
  await editor.fill("edited content");

  await page.getByTitle("Source Control (Ctrl+Shift+G)").click();
  await expect(region.getByLabel("Commit message")).toBeVisible();
  const before = await gitCalls(page, "status");

  await page.keyboard.press("Control+Shift+S");

  // Save All's write_file_guarded call resolving is what the revision bump
  // depends on; poll for it rather than asserting synchronously.
  await expect.poll(() => gitCalls(page, "status")).toBeGreaterThan(before);
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
  await region.getByRole("button", { name: /^Commit( \d+)?$/ }).click();
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
  await region.getByRole("button", { name: /^Commit( \d+)?$/ }).click();
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

test("a changed file's diff can be opened with the keyboard alone", async ({ page }) => {
  const region = await panel(page, { status: " M a.ts\0" });
  const row = region.getByRole("button", { name: "Open diff for /work/a.ts" });
  await row.focus();
  await row.press("Enter");

  const diffView = page.locator("section[aria-label='Git diff editor']");
  await expect(diffView).toBeVisible();
});

test("a huge change set draws a page of rows at a time but still counts and acts on every file", async ({
  page,
}) => {
  let status = "";
  for (let i = 0; i < 1200; i++) status += ` M file${i}.ts\0`;
  const region = await panel(page, { status });

  const rows = region.getByRole("button", { name: /^Open diff for / });
  await expect(rows).toHaveCount(500);
  const changes = region.getByRole("region", { name: "Changes" });
  await expect(changes.getByText("1200", { exact: true })).toBeVisible();

  await region.getByRole("button", { name: /Show 500 more of 700 remaining/ }).click();
  await expect(rows).toHaveCount(1000);
  await region.getByRole("button", { name: /Show 200 more of 200 remaining/ }).click();
  await expect(rows).toHaveCount(1200);
  await expect(region.getByRole("button", { name: /more of .* remaining/ })).toHaveCount(0);

  // Stage All covers the whole group, not just the rows that were drawn.
  await region.getByLabel("Stage All Changes").click();
  await expect.poll(() => gitCalls(page, "stage")).toBe(1200);
});

test("typing a commit message does not lose the draft or the Commit button state", async ({
  page,
}) => {
  const region = await panel(page, { status: "M  a.ts\0" });
  const box = region.getByLabel("Commit message");
  const commit = region.getByRole("button", { name: /^Commit( \d+)?$/ });
  await expect(commit).toBeDisabled();
  await box.fill("first line");
  await expect(commit).toBeEnabled();
  await box.fill("   ");
  await expect(commit).toBeDisabled();
  await box.fill("draft survives reload");
  await page.reload();
  await page.getByTitle("Source Control (Ctrl+Shift+G)").click();
  await expect(
    page.getByRole("complementary", { name: "Source control" }).getByLabel("Commit message"),
  ).toHaveValue("draft survives reload");
});

test("every changed file appears once in one list, with a checkbox for its staging state", async ({
  page,
}) => {
  // a: staged then edited again; b: only edited; c: untracked; d: fully staged; e: deleted.
  const region = await panel(page, {
    status: "MM a.ts\0 M b.ts\0?? c.ts\0M  d.ts\0 D e.ts\0",
  });
  const list = region.getByRole("list", { name: "Changed files" });
  await expect(list.getByRole("button", { name: /^Open diff for/ })).toHaveCount(5);
  // The old Staged Changes / Changes sections are gone.
  await expect(region.locator("section[aria-label='Staged Changes']")).toHaveCount(0);
  await expect(region.locator("section[aria-label='Changes']")).toHaveCount(0);

  const box = (name: string) => list.getByRole("checkbox", { name: `Stage /work/${name}` });
  await expect(box("a.ts")).toHaveAttribute("aria-checked", "mixed");
  await expect(box("b.ts")).toHaveAttribute("aria-checked", "false");
  await expect(box("c.ts")).toHaveAttribute("aria-checked", "false");
  await expect(box("d.ts")).toHaveAttribute("aria-checked", "true");
  await expect(box("e.ts")).toHaveAttribute("aria-checked", "false");

  // One status letter per file, from the working tree when anything is left unstaged.
  const letter = (name: string) =>
    list.getByRole("button", { name: `Open diff for /work/${name}` }).getByTitle(/^Status: /);
  await expect(letter("a.ts")).toHaveText("M");
  await expect(letter("c.ts")).toHaveText("U");
  await expect(letter("d.ts")).toHaveText("M");
  await expect(letter("e.ts")).toHaveText("D");

  // The header count is the number of files, and the Commit button counts only staged ones.
  await expect(region.getByLabel("5 changed files")).toBeVisible();
  await region.getByLabel("Commit message").fill("msg");
  await expect(region.getByRole("button", { name: "Commit 2" })).toBeEnabled();
});

test("the row checkbox stages an unstaged or partly staged file and unstages a fully staged one", async ({
  page,
}) => {
  const region = await panel(page, { status: " M b.ts\0M  d.ts\0MM a.ts\0" });
  const box = (name: string) =>
    region.getByRole("list", { name: "Changed files" }).getByRole("checkbox", {
      name: `Stage /work/${name}`,
    });

  await box("b.ts").click();
  await expect.poll(() => gitCalls(page, "stage")).toBe(1);
  await box("d.ts").click();
  await expect.poll(() => gitCalls(page, "unstage")).toBe(1);
  // Partly staged: ticking it stages what is left rather than unstaging.
  await box("a.ts").click();
  await expect.poll(() => gitCalls(page, "stage")).toBe(2);
  expect(await gitCalls(page, "unstage")).toBe(1);
});

test("Repositories and Stashes are hidden by default and the choice is remembered", async ({
  page,
}) => {
  const region = await panel(page, { status: " M a.ts\0" });
  await expect(region.locator("section[aria-label='Repositories']")).toHaveCount(0);
  await expect(region.locator("section[aria-label='Stashes']")).toHaveCount(0);
  await expect(region.locator("section[aria-label='Changes panel']")).toBeVisible();
  await expect(region.locator("section[aria-label='Graph']")).toBeVisible();

  await showRepositories(page, region);
  await page.reload();
  await page.getByTitle("Source Control (Ctrl+Shift+G)").click();
  await expect(
    page
      .getByRole("complementary", { name: "Source control" })
      .locator("section[aria-label='Repositories']"),
  ).toBeVisible();
});
