/**
 * The extension marketplace in the installed Yavin (IDE-09) -- no mocks anywhere: Yavin's real
 * registry files (`registry/`, as `scripts/build-registry.mjs` builds them) served by a local
 * server, read by the real YavinRegistryProvider through the native fetcher; packages downloaded,
 * size- and SHA-256-checked, validated and unpacked natively into the profile's extensions folder;
 * registered; run by the real extension host process.
 *
 * Only a `test-registry` build (the one `scripts/e2e-real-host.mjs` makes) accepts this plain
 * loopback HTTP registry and its address from `YAVIN_TEST_REGISTRY`; every other build uses
 * HTTPS and Yavin's own registry.
 */
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { expect, test } from "@playwright/test";
import {
  alert,
  clearProfile,
  close,
  CONFIG,
  EXTENSIONS,
  extensionsView,
  hostProcesses,
  INSTALL,
  launch,
  message,
  palette,
  registryEnv,
  signedIndex,
  trust,
  type Running,
} from "./harness";

const REGISTRY = new URL("../../registry/", import.meta.url);
const ROOT = join(tmpdir(), `yavin-e2e-market-${process.pid}`);
const WORK = join(ROOT, "work");

test.describe.configure({ mode: "serial" });
test.skip(
  !INSTALL,
  "Run through scripts/e2e-real-host.mjs, which builds and extracts the installer.",
);

/** The registry server: the real files, its index signed under the run's test key (EXT-20);
 *  `/tampered/` an index that lists wrong checksums (signed: the registry published them);
 *  `/altered/` an index changed after it was signed; offline on demand. */
const server = { offline: false, requests: [] as string[] };
let http: Server;
let base = "";
const TYPES: Record<string, string> = {
  ".json": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".sig": "text/plain; charset=utf-8",
  ".yvx": "application/octet-stream",
};

test.beforeAll(async () => {
  const root = normalize(REGISTRY.pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  http = createServer((request, response) => {
    server.requests.push(request.url ?? "");
    if (server.offline) {
      request.socket.destroy();
      return;
    }
    let path = decodeURIComponent((request.url ?? "/").split("?")[0]);
    const tampered = path.startsWith("/tampered/");
    const altered = path.startsWith("/altered/");
    path = path.replace(/^\/(tampered\/|altered\/)?/, "");
    const file = normalize(join(root, path));
    if (!file.startsWith(root) || !existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    let body = readFileSync(file);
    if (path === "index.json" || path === "index.json.sig") {
      const index = JSON.parse(readFileSync(join(root, "index.json"), "utf8"));
      const zeroed = () => {
        const copy = structuredClone(index);
        for (const extension of copy.extensions)
          for (const version of extension.versions) version.sha256 = "0".repeat(64);
        return copy;
      };
      const signed = signedIndex(tampered ? zeroed() : index);
      // Altered: the index changed after it was signed -- served beside the genuine signature.
      const text = altered ? signedIndex(zeroed()).text : signed.text;
      body = Buffer.from(path === "index.json" ? text : signed.signature);
    }
    response.writeHead(200, {
      "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
      "Content-Length": body.length,
    });
    response.end(body);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`;
});
test.afterAll(async () => {
  await new Promise((resolve) => http.close(resolve));
  await clearProfile(ROOT);
});

test.beforeEach(async () => {
  server.offline = false;
  await clearProfile(ROOT);
  mkdirSync(WORK, { recursive: true });
  writeFileSync(join(WORK, "notes.md"), "# Notes\n\nTODO write more words here\n");
  mkdirSync(CONFIG, { recursive: true });
  writeFileSync(
    join(CONFIG, "session.json"),
    JSON.stringify({ version: 1, folders: [WORK], workspaces: [] }),
  );
});

const card = (scope: ReturnType<Running["page"]["getByRole"]>, name: string) =>
  scope.getByRole("group", { name, exact: true }).first();

async function start(registry = base) {
  const running = await launch(registryEnv(registry));
  await trust(running.page, true);
  return running;
}

/** Times one user-visible step in the installed application (printed for the report). */
async function timed<T>(what: string, step: () => Promise<T>): Promise<T> {
  const started = Date.now();
  const result = await step();
  console.log(`marketplace timing: ${what} ${Date.now() - started} ms`);
  return result;
}

/** The inventory's record of `id` (EXT-02: `extensions/inventory.json`), if any. */
const recordOf = (id: string) => {
  const file = join(EXTENSIONS, "inventory.json");
  if (!existsSync(file)) return undefined;
  return (
    JSON.parse(readFileSync(file, "utf8")) as {
      extensions: Record<
        string,
        { active: { folder: string }; previous: { version: string } | null }
      >;
    }
  ).extensions[id];
};
/** What the inventory allows `id` (EXT-07: its grant, bound to one copy), if anything. */
const grantOf = (id: string) => {
  const file = join(EXTENSIONS, "inventory.json");
  if (!existsSync(file)) return undefined;
  return (
    JSON.parse(readFileSync(file, "utf8")) as {
      grants?: Record<
        string,
        { folder: string; version: string; sha256: string | null; capabilities: string[] }
      >;
    }
  ).grants?.[id];
};
/** The sha256 the inventory records for `id`'s copy in use. */
const shaOf = (id: string) =>
  (recordOf(id) as { active: { sha256?: string | null } } | undefined)?.active.sha256;

/** A package that declares permissions is reviewed before it installs (EXT-07). */
async function review(
  page: Running["page"],
  choice: "Install and allow" | "Install without allowing",
) {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("asks to:");
  await dialog.getByRole("option", { name: new RegExp(`^${choice}`) }).click();
  await expect(dialog).toHaveCount(0);
}

/** The folder the inventory uses for `id` (its store copy), or where none would be. */
const installedFolder = (id: string) =>
  join(EXTENSIONS, ...(recordOf(id)?.active.folder.split("/") ?? [".store", id]));
/** Install operations' leftovers: staging, and IDE-09's set-aside folder. */
const leftovers = () =>
  [".staging", ".previous"].filter(
    (name) => existsSync(join(EXTENSIONS, name)) && readdirSync(join(EXTENSIONS, name)).length,
  );

test("a real package from Yavin's registry: installed through the installer, run by the real host", async () => {
  const running = await start();
  const { app, page } = running;
  try {
    const view = await timed("open the Extensions view (to its installed section)", async () => {
      const opened = await extensionsView(page);
      await expect(opened.getByRole("region", { name: "Installed extensions" })).toBeVisible();
      return opened;
    });
    const recommended = view.getByRole("region", { name: "Recommended extensions" });
    await timed("recommendations from the registry", () =>
      expect(card(recommended, "TODO Highlighter")).toBeVisible(),
    );
    const results = view.getByRole("region", { name: "Marketplace results" });
    await timed("search to results", async () => {
      await view.getByRole("searchbox", { name: "Search extensions" }).fill("todo");
      await expect(card(results, "TODO Highlighter")).toBeVisible();
    });
    await timed("details page", async () => {
      await card(results, "TODO Highlighter").click();
      await expect(page.getByRole("region", { name: "Extension: TODO Highlighter" })).toContainText(
        "Highlights",
      );
    });
    await page.getByRole("button", { name: "Back to Extensions" }).click();
    await view.getByRole("button", { name: "Clear search" }).click();
    const wordCount = card(recommended, "Word Count");
    await expect(wordCount).toContainText("Counts the words");
    const installed = card(
      view.getByRole("region", { name: "Installed extensions" }),
      "Word Count",
    );
    await timed("install (click to registered, with the review)", async () => {
      await wordCount.getByRole("button", { name: "Install Word Count" }).click();
      await review(page, "Install and allow");
      await expect(installed.getByTestId("extension-state")).toHaveText("Enabled");
    });
    // What was allowed is granted natively, bound to the very copy installed (EXT-07).
    await expect.poll(() => grantOf("yavin.word-count")?.capabilities).toEqual(["documents.read"]);
    expect(grantOf("yavin.word-count")?.version).toBe("1.0.1");
    expect(grantOf("yavin.word-count")?.sha256).toBe(shaOf("yavin.word-count"));
    // On disk: unpacked into Yavin's extensions folder, nothing left in staging.
    expect(existsSync(join(installedFolder("yavin.word-count"), "extension.js"))).toBe(true);
    expect(
      JSON.parse(
        readFileSync(join(installedFolder("yavin.word-count"), "yavin-extension.json"), "utf8"),
      ).version,
    ).toBe("1.0.1");
    expect(leftovers()).toEqual([]);
    expect(server.requests).toContain("/packages/yavin.word-count-1.0.1.yvx");
    expect(hostProcesses(app.pid!)).toEqual([]); // installing runs nothing
    // It runs, in the real host, on the open file.
    await page.getByTitle("Explorer (Ctrl+Shift+E)", { exact: true }).click();
    await page.getByRole("tree", { name: "Files" }).getByText("notes.md", { exact: true }).click();
    await palette(page, "Word Count: Count Words in Active File");
    await expect(message(page)).toContainText("notes.md:");
    await expect(message(page)).toContainText("words");
    await expect.poll(() => hostProcesses(app.pid!).length).toBe(1);
    await extensionsView(page);
    await expect(installed.getByTestId("extension-state")).toHaveText("Active");
    await close(running);
  } finally {
    if (app.exitCode === null) app.kill();
  }
});

test("an update: Hello World 2.0.1 installed, 2.1.1 found and installed; the new code runs", async () => {
  const running = await start();
  const { app, page } = running;
  try {
    const view = await extensionsView(page);
    await view.getByRole("searchbox", { name: "Search extensions" }).fill("hello");
    await card(
      view.getByRole("region", { name: "Marketplace results" }),
      "Hello World (sample)",
    ).click();
    const details = page.getByRole("region", { name: "Extension: Hello World (sample)" });
    await details.getByRole("tab", { name: "Information" }).click();
    await details.getByRole("button", { name: "Install version 2.0.1" }).click();
    await review(page, "Install and allow");
    await expect(details.getByRole("region", { name: "Versions" })).toContainText("Installed");
    await details.getByRole("button", { name: "Back to Extensions" }).click();
    await palette(page, "Hello World: Say Hello");
    await expect(message(page)).toContainText("Hello, world!");
    await expect(message(page)).not.toContainText("(greeting");

    await palette(page, "Extensions: Check for Updates");
    const updates = view.getByRole("region", { name: "Updates" });
    await timed("update (click to up to date)", async () => {
      await card(updates, "Hello World (sample)")
        .getByRole("button", { name: "Update Hello World (sample)" })
        .click();
      // The new version is granted nothing of the old one's: it is reviewed again.
      await expect(page.getByRole("dialog")).toContainText("Version 2.0.1 was allowed");
      await review(page, "Install and allow");
      await expect(updates).toContainText("All installed extensions are up to date.");
    });
    expect(
      JSON.parse(
        readFileSync(
          join(installedFolder("yavin-samples.hello-world"), "yavin-extension.json"),
          "utf8",
        ),
      ).version,
    ).toBe("2.1.1");
    expect(leftovers()).toEqual([]);
    // The version it replaced is kept as the fallback (EXT-02).
    expect(recordOf("yavin-samples.hello-world")?.previous?.version).toBe("2.0.1");
    expect(grantOf("yavin-samples.hello-world")?.version).toBe("2.1.1");
    await palette(page, "Hello World: Say Hello");
    await expect(message(page)).toContainText("Hello, world! (greeting 2)"); // its state carried over
    await close(running);
  } finally {
    if (app.exitCode === null) app.kill();
  }
});

test("uninstall: the folder is deleted, the command is gone", async () => {
  const running = await start();
  const { app, page } = running;
  try {
    const view = await extensionsView(page);
    await card(view.getByRole("region", { name: "Recommended extensions" }), "TODO Highlighter")
      .getByRole("button", { name: "Install TODO Highlighter" })
      .click();
    await review(page, "Install and allow");
    const installed = view.getByRole("region", { name: "Installed extensions" });
    await expect
      .poll(() => grantOf("yavin.todo-highlighter")?.capabilities)
      .toEqual(["documents.read"]);
    await card(installed, "TODO Highlighter")
      .getByRole("button", { name: "Manage TODO Highlighter" })
      .click();
    await page.getByRole("menuitem", { name: "Uninstall" }).click();
    await page
      .getByRole("dialog")
      .getByRole("option", { name: /^Uninstall Keep/ })
      .click();
    await expect(installed.getByRole("group", { name: "TODO Highlighter" })).toHaveCount(0);
    expect(recordOf("yavin.todo-highlighter")).toBeUndefined();
    expect(grantOf("yavin.todo-highlighter")).toBeUndefined(); // uninstalling forgets the grant
    expect(existsSync(installedFolder("yavin.todo-highlighter"))).toBe(false);
    await page.keyboard.press("Control+Shift+P");
    await page
      .getByRole("combobox", { name: "Search files or commands" })
      .fill(">TODO Highlighter: Count");
    await expect(
      page.getByRole("option").filter({ hasText: "TODO Highlighter: Count" }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await close(running);
  } finally {
    if (app.exitCode === null) app.kill();
  }
});

test("a package that does not match its published checksum is refused; nothing is installed", async () => {
  const running = await start(`${base}tampered/`);
  const { app, page } = running;
  try {
    const view = await extensionsView(page);
    const wordCount = card(
      view.getByRole("region", { name: "Recommended extensions" }),
      "Word Count",
    );
    await wordCount.getByRole("button", { name: "Install Word Count" }).click();
    await expect(wordCount.getByRole("alert")).toContainText(
      "did not match its published checksum",
    );
    expect(existsSync(installedFolder("yavin.word-count"))).toBe(false);
    expect(leftovers()).toEqual([]);
    await close(running);
  } finally {
    if (app.exitCode === null) app.kill();
  }
});

test("marketplace offline: installed extensions keep working; the marketplace says so", async () => {
  const running = await start();
  const { app, page } = running;
  try {
    const view = await extensionsView(page);
    await card(view.getByRole("region", { name: "Recommended extensions" }), "Word Count")
      .getByRole("button", { name: "Install Word Count" })
      .click();
    await review(page, "Install and allow");
    await expect(
      card(view.getByRole("region", { name: "Installed extensions" }), "Word Count").getByTestId(
        "extension-state",
      ),
    ).toHaveText("Enabled");
    server.offline = true;
    await view.getByRole("button", { name: "Refresh marketplace" }).click();
    await expect(
      view.getByRole("region", { name: "Recommended extensions" }).getByRole("alert"),
    ).toContainText("The extension marketplace is unavailable.");
    await page.getByTitle("Explorer (Ctrl+Shift+E)", { exact: true }).click();
    await page.getByRole("tree", { name: "Files" }).getByText("notes.md", { exact: true }).click();
    await palette(page, "Word Count: Count Words in Active File");
    await expect(message(page)).toContainText("notes.md:");
    await expect(alert(page)).toHaveCount(0);
    await close(running);
  } finally {
    if (app.exitCode === null) app.kill();
  }
});

test("permissions, natively: refused without a grant, allowed on its page, refused again once revoked", async () => {
  const running = await start();
  const { app, page } = running;
  try {
    const view = await extensionsView(page);
    await card(view.getByRole("region", { name: "Recommended extensions" }), "Word Count")
      .getByRole("button", { name: "Install Word Count" })
      .click();
    await review(page, "Install without allowing");
    const installed = card(
      view.getByRole("region", { name: "Installed extensions" }),
      "Word Count",
    );
    await expect(installed.getByTestId("extension-state")).toHaveText("Enabled");
    expect(grantOf("yavin.word-count")).toBeUndefined();
    // Its request for the document's text is refused by the native side, in the real host.
    await page.getByTitle("Explorer (Ctrl+Shift+E)", { exact: true }).click();
    await page.getByRole("tree", { name: "Files" }).getByText("notes.md", { exact: true }).click();
    await palette(page, "Word Count: Count Words in Active File");
    await expect(alert(page)).toContainText("is not allowed for yavin.word-count 1.0.1");
    await extensionsView(page);
    // It runs (its command did): Active, the blocked request said beside it (EXT-16).
    await expect(installed.getByTestId("extension-state")).toHaveText("Active");
    await expect(installed.getByTestId("extension-notice")).toHaveText(/^Permission Needed/);
    // Allowed on its page: granted natively, and it works at once, in the same host.
    await installed.click();
    const permissions = page
      .getByRole("region", { name: "Extension: Word Count" })
      .getByRole("region", { name: "Permissions" });
    await permissions.getByRole("button", { name: "Allow: Read your open documents" }).click();
    await expect(permissions.getByTestId("permission-state")).toHaveText("Allowed");
    expect(grantOf("yavin.word-count")?.capabilities).toEqual(["documents.read"]);
    const hosts = hostProcesses(app.pid!).map((one) => one.id);
    // Back to the editor, where notes.md is the active file.
    await page.getByRole("button", { name: "Back to Extensions" }).click();
    await palette(page, "Word Count: Count Words in Active File");
    await expect(message(page)).toContainText("notes.md:");
    expect(hostProcesses(app.pid!).map((one) => one.id)).toEqual(hosts);
    // Revoked: the next request is refused again.
    await installed.click();
    await permissions.getByRole("button", { name: "Revoke: Read your open documents" }).click();
    // Confirmed once the native inventory has it (EXT-16).
    await expect(permissions.getByRole("status")).toContainText(
      "Revoked: Read your open documents.",
    );
    await expect(permissions.getByTestId("permission-state")).toHaveText("Not allowed");
    expect(grantOf("yavin.word-count")).toBeUndefined();
    await page.getByRole("button", { name: "Back to Extensions" }).click();
    await palette(page, "Word Count: Count Words in Active File");
    await expect(alert(page)).toContainText("is not allowed for yavin.word-count 1.0.1");
    // The same host, still running: Active, the block said beside it and marked on its page.
    expect(hostProcesses(app.pid!).map((one) => one.id)).toEqual(hosts);
    await extensionsView(page);
    await expect(installed.getByTestId("extension-state")).toHaveText("Active");
    await expect(installed.getByTestId("extension-notice")).toContainText(
      "Permission Needed — Yavin blocked its request to read your open documents",
    );
    await installed.click();
    await expect(permissions.getByTestId("permission-blocked")).toContainText("Blocked:");
    await close(running);
  } finally {
    if (app.exitCode === null) app.kill();
  }
});

/** The inventory as a Yavin before EXT-15 wrote it (version 1: no files digests). */
function asVersion1() {
  for (const name of ["inventory.json", "inventory.last-good.json"]) {
    const file = join(EXTENSIONS, name);
    const value = JSON.parse(readFileSync(file, "utf8"));
    value.version = 1;
    for (const record of Object.values(value.extensions) as Record<string, unknown>[]) {
      for (const key of ["active", "previous"]) {
        const copy = record[key] as Record<string, unknown> | null;
        if (copy) {
          delete copy.filesSha256;
          delete copy.unchecked;
          delete copy.trust;
        }
      }
      delete record.replaced;
    }
    writeFileSync(file, JSON.stringify(value, null, 2));
  }
}

/** Yavin started again over the same profile: its folder is already trusted (not asked), and
 *  it reopens what it had open (a sidebar, an editor), so only the window itself is waited for. */
async function restart() {
  const running = await launch(registryEnv(base));
  await expect(
    running.page.getByTitle("Extensions & Plugins (Ctrl+Shift+X)", { exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(running.page.getByRole("button", { name: "Yes, I trust the authors" })).toHaveCount(
    0,
  );
  return running;
}

test("EXT-17/EXT-19 an older inventory: upgraded, its copy not checked and its code refused; reinstalled, checked and run; recovered, refused until reinstalled", async () => {
  let running = await start();
  try {
    const { page } = running;
    const view = await extensionsView(page);
    await card(view.getByRole("region", { name: "Recommended extensions" }), "Word Count")
      .getByRole("button", { name: "Install Word Count" })
      .click();
    await review(page, "Install and allow");
    await close(running);
    asVersion1();

    // Upgraded at start: the copy is not checked -- EXT-19: its code does not run, and it says
    // so with the way out; no signature shown.
    running = await restart();
    let installed = card(
      (await extensionsView(running.page)).getByRole("region", { name: "Installed extensions" }),
      "Word Count",
    );
    await expect(installed.getByTestId("extension-state")).toHaveText(/^Reinstall Required/);
    const inventory = JSON.parse(readFileSync(join(EXTENSIONS, "inventory.json"), "utf8"));
    expect(inventory.version).toBe(3);
    expect(inventory.extensions["yavin.word-count"].active.unchecked).toBe("legacy");
    expect(readdirSync(EXTENSIONS).some((n) => n.startsWith("inventory.json.v1-migrated-"))).toBe(
      true,
    );
    await installed.click();
    const details = running.page.getByRole("region", { name: "Extension: Word Count" });
    await expect(details.getByTestId("extension-integrity-runs")).toHaveText(
      "Its code does not run.",
    );
    await details.getByRole("tab", { name: "Requirements" }).click();
    await expect(details.getByTestId("extension-signature")).toContainText("Not shown");
    await running.page.getByRole("button", { name: "Back to Extensions" }).click();
    await running.page.getByTitle("Explorer (Ctrl+Shift+E)", { exact: true }).click();
    await running.page
      .getByRole("tree", { name: "Files" })
      .getByText("notes.md", { exact: true })
      .click();
    // Run before it is checked: refused natively, saying why.
    await palette(running.page, "Word Count: Count Words in Active File");
    await expect(alert(running.page)).toContainText(
      "IntegrityUnverified: yavin.word-count's installed files have never been checked",
    );

    // Reinstalled from its registry: its files are checked and bound.
    await extensionsView(running.page);
    await installed.click();
    await details
      .getByTestId("extension-integrity")
      .getByRole("button", { name: "Reinstall Word Count 1.0.1" })
      .click();
    await review(running.page, "Install and allow");
    await expect(details.getByTestId("extension-integrity")).toHaveCount(0);
    await details.getByRole("tab", { name: "Requirements" }).click();
    await expect(details.getByTestId("extension-files")).toContainText("Verified Files");
    // EXT-20: reinstalled from a registry whose index verifies -- its record says so.
    await expect(details.getByTestId("extension-signature")).toContainText(
      "Verified registry metadata",
    );
    const bound = JSON.parse(readFileSync(join(EXTENSIONS, "inventory.json"), "utf8"));
    expect(bound.extensions["yavin.word-count"].active.filesSha256).toMatch(/^[0-9a-f]{64}$/);
    // EXT-19: vouched for -- an authenticated record -- and now it runs.
    expect(bound.extensions["yavin.word-count"].active.trust.mac).toMatch(/^[0-9a-f]{64}$/);
    await running.page.getByRole("button", { name: "Back to Extensions" }).click();
    await palette(running.page, "Word Count: Count Words in Active File");
    await expect(message(running.page)).toContainText("notes.md:");
    await close(running);

    // The inventory and its last good copy lost: rebuilt from the folders -- disabled, and its
    // code refused even when enabled, until it is reinstalled.
    for (const name of ["inventory.json", "inventory.last-good.json"])
      writeFileSync(join(EXTENSIONS, name), "{ not json");
    running = await restart();
    installed = card(
      (await extensionsView(running.page)).getByRole("region", { name: "Installed extensions" }),
      "Word Count",
    );
    await expect(installed.getByTestId("extension-state")).toHaveText("Disabled");
    await expect(installed.getByTestId("extension-notice")).toContainText("Not Checked");
    await installed.getByRole("button", { name: "Enable Word Count" }).click();
    await expect(installed.getByTestId("extension-state")).toHaveText(/^Reinstall Required/);
    await running.page.getByTitle("Explorer (Ctrl+Shift+E)", { exact: true }).click();
    await running.page
      .getByRole("tree", { name: "Files" })
      .getByText("notes.md", { exact: true })
      .click();
    await palette(running.page, "Word Count: Count Words in Active File");
    await expect(alert(running.page)).toContainText("its code does not run");
    expect(hostProcesses(running.app.pid!).length).toBeLessThanOrEqual(1);
    await extensionsView(running.page);
    await installed.click();
    await running.page
      .getByRole("region", { name: "Extension: Word Count" })
      .getByTestId("extension-integrity")
      .getByRole("button", { name: "Reinstall Word Count 1.0.1" })
      .click();
    await review(running.page, "Install and allow");
    await running.page.getByRole("button", { name: "Back to Extensions" }).click();
    await palette(running.page, "Word Count: Count Words in Active File");
    await expect(message(running.page)).toContainText("notes.md:");
    await close(running);
  } finally {
    if (running.app.exitCode === null) running.app.kill();
  }
});

test("EXT-18 profile settings in the installed app: saved natively, used by the running extension, kept per profile across restarts", async () => {
  let running = await start();
  const count = async (words: number) => {
    // The Explorer's icon toggles it: open it only if it is not (a restart reopens it).
    const files = running.page.getByRole("tree", { name: "Files" });
    if (!(await files.isVisible()))
      await running.page.getByTitle("Explorer (Ctrl+Shift+E)", { exact: true }).click();
    await files.getByText("notes.md", { exact: true }).click();
    await palette(running.page, "Word Count: Count Words in Active File");
    await expect(message(running.page)).toContainText(`notes.md: ${words} words`);
  };
  const settingsPage = async () => {
    const view = await extensionsView(running.page);
    await card(view.getByRole("region", { name: "Installed extensions" }), "Word Count").click();
    const details = running.page.getByRole("region", { name: "Extension: Word Count" });
    await details.getByRole("tab", { name: "Settings" }).click();
    return { view, details, markup: details.getByRole("checkbox", { name: "ignore-markup" }) };
  };
  const stored = () =>
    JSON.parse(readFileSync(join(EXTENSIONS, "inventory.json"), "utf8")).profiles as {
      active: string;
      list: Record<string, { settings: Record<string, Record<string, unknown>> }>;
    };
  try {
    const view = await extensionsView(running.page);
    await card(view.getByRole("region", { name: "Recommended extensions" }), "Word Count")
      .getByRole("button", { name: "Install Word Count" })
      .click();
    await review(running.page, "Install and allow");
    // Its default: markup left out.
    await count(6);

    // Off in this profile: saved natively, and the running extension counts the markup at once.
    let page = await settingsPage();
    await expect(page.markup).toBeChecked();
    await page.markup.uncheck();
    await page.details.getByRole("button", { name: "Save settings of Word Count" }).click();
    await expect(page.details.getByTestId("settings-saved")).toHaveText(
      'Saved in the profile "Default".',
    );
    expect(stored().list.default.settings["yavin.word-count"]).toEqual({
      "yavin.word-count.ignore-markup": false,
    });
    const hosts = hostProcesses(running.app.pid!).map((one) => one.id);
    await count(7);
    expect(hostProcesses(running.app.pid!).map((one) => one.id)).toEqual(hosts);

    // A profile of its own, on again there.
    page = await settingsPage();
    await page.details.getByRole("button", { name: "Manage profiles" }).click();
    const profiles = page.view.getByRole("region", { name: "Extension profiles" });
    await profiles.getByRole("textbox", { name: "New profile name" }).fill("Work");
    await profiles.getByRole("button", { name: "Create", exact: true }).click();
    await page.details.getByRole("combobox", { name: "Extension profile" }).selectOption("work");
    await expect(page.markup).not.toBeChecked();
    await page.markup.check();
    await page.details.getByRole("button", { name: "Save settings of Word Count" }).click();
    await expect(page.details.getByTestId("settings-saved")).toHaveText(
      'Saved in the profile "Work".',
    );
    await count(6);
    await close(running);

    // Restarted: the active profile, and each profile's own value.
    running = await restart();
    expect(stored().active).toBe("work");
    await count(6);
    await (
      await extensionsView(running.page)
    )
      .getByRole("combobox", { name: "Active extension profile" })
      .selectOption("default");
    await count(7);
    page = await settingsPage();
    await expect(page.markup).not.toBeChecked();
    await expect(
      page.details.getByRole("group", { name: "ignore-markup" }).getByTestId("setting-source"),
    ).toHaveText("Now off, from this profile.");
    await close(running);
  } finally {
    if (running.app.exitCode === null) running.app.kill();
  }
});

test("EXT-19 a forged trust record, a lost trust key and changed files: each refused natively, said, and fixed by a reinstall", async () => {
  let running = await start();
  const files = () => running.page.getByRole("tree", { name: "Files" });
  const count = async () => {
    if (!(await files().isVisible()))
      await running.page.getByTitle("Explorer (Ctrl+Shift+E)", { exact: true }).click();
    await files().getByText("notes.md", { exact: true }).click();
    await palette(running.page, "Word Count: Count Words in Active File");
  };
  const edit = (change: (inventory: Record<string, any>) => void) => {
    for (const name of ["inventory.json", "inventory.last-good.json"]) {
      const file = join(EXTENSIONS, name);
      const inventory = JSON.parse(readFileSync(file, "utf8"));
      change(inventory);
      writeFileSync(file, JSON.stringify(inventory, null, 2));
    }
  };
  const reinstall = async () => {
    const view = await extensionsView(running.page);
    await card(view.getByRole("region", { name: "Installed extensions" }), "Word Count").click();
    await running.page
      .getByRole("region", { name: "Extension: Word Count" })
      .getByTestId("extension-integrity")
      .getByRole("button", { name: "Reinstall Word Count 1.0.1" })
      .click();
    await review(running.page, "Install and allow");
    await running.page.getByRole("button", { name: "Back to Extensions" }).click();
  };
  try {
    const view = await extensionsView(running.page);
    await card(view.getByRole("region", { name: "Recommended extensions" }), "Word Count")
      .getByRole("button", { name: "Install Word Count" })
      .click();
    await review(running.page, "Install and allow");
    await count();
    await expect(message(running.page)).toContainText("notes.md:");
    await close(running);

    // A trust fact rewritten in the inventory (and its last good copy) without the key.
    edit((inventory) => {
      inventory.extensions["yavin.word-count"].active.source = "openvsx https://open-vsx.org";
    });
    running = await restart();
    let installed = card(
      (await extensionsView(running.page)).getByRole("region", { name: "Installed extensions" }),
      "Word Count",
    );
    await expect(installed.getByTestId("extension-state")).toHaveText(
      /^Reinstall Required — Yavin's record of its verified files does not match it/,
    );
    await count();
    await expect(alert(running.page)).toContainText("TrustStateInvalid");
    await reinstall();
    await count();
    await expect(message(running.page)).toContainText("notes.md:");
    await close(running);

    // The trust key lost: every record made with it fails, closed; a reinstall vouches anew.
    rmSync(join(EXTENSIONS, "trust-key.dpapi"));
    running = await restart();
    installed = card(
      (await extensionsView(running.page)).getByRole("region", { name: "Installed extensions" }),
      "Word Count",
    );
    await expect(installed.getByTestId("extension-state")).toHaveText(
      /^Reinstall Required — Yavin's record of its verified files was made with a trust key/,
    );
    await reinstall();
    await count();
    await expect(message(running.page)).toContainText("notes.md:");
    await close(running);

    // Its files changed: not loaded -- said, with the reason -- and installed again from its card.
    const folder = join(
      EXTENSIONS,
      ...JSON.parse(readFileSync(join(EXTENSIONS, "inventory.json"), "utf8")).extensions[
        "yavin.word-count"
      ].active.folder.split("/"),
    );
    writeFileSync(join(folder, "extension.js"), "module.exports.activate = function () {};");
    running = await restart();
    const changed = await extensionsView(running.page);
    await expect(
      changed
        .getByRole("region", { name: "Not loaded" })
        .getByRole("group", { name: "Not loaded: yavin.word-count" }),
    ).toContainText("its files changed since it was installed");
    await card(changed.getByRole("region", { name: "Recommended extensions" }), "Word Count")
      .getByRole("button", { name: "Install Word Count" })
      .click();
    await review(running.page, "Install and allow");
    await count();
    await expect(message(running.page)).toContainText("notes.md:");
    await close(running);
  } finally {
    if (running.app.exitCode === null) running.app.kill();
  }
});

test("EXT-20 the registry's index: verified, it installs; altered after signing, it is said and its update refused, the installed version kept", async () => {
  let running = await start();
  try {
    let view = await extensionsView(running.page);
    await expect(view.getByTestId("registry-trust")).toHaveText("Registry index verified");
    await view.getByRole("searchbox", { name: "Search extensions" }).fill("hello");
    await card(
      view.getByRole("region", { name: "Marketplace results" }),
      "Hello World (sample)",
    ).click();
    const details = running.page.getByRole("region", { name: "Extension: Hello World (sample)" });
    await details.getByRole("tab", { name: "Information" }).click();
    await details.getByRole("button", { name: "Install version 2.0.1" }).click();
    await review(running.page, "Install and allow");
    await expect(details.getByRole("region", { name: "Versions" })).toContainText("Installed");
    // Recorded as from the signed index -- never as a publisher's signature.
    await details.getByRole("tab", { name: "Requirements" }).click();
    await expect(details.getByTestId("extension-signature")).toContainText(
      "Verified registry metadata",
    );
    await expect(details.getByTestId("extension-signature")).toContainText(
      "does not verify who wrote it",
    );
    await close(running);
    const before = readFileSync(join(EXTENSIONS, "inventory.json"), "utf8");

    // The same registry, its index changed after it was signed (checksums replaced).
    running = await launch(registryEnv(`${base}altered/`));
    await expect(
      running.page.getByTitle("Extensions & Plugins (Ctrl+Shift+X)", { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    view = await extensionsView(running.page);
    const notice = view.getByTestId("registry-trust");
    await expect(notice).toHaveAttribute("data-tone", "error");
    await expect(notice).toContainText("Registry index altered");
    await palette(running.page, "Extensions: Check for Updates");
    const updates = view.getByRole("region", { name: "Updates" });
    await card(updates, "Hello World (sample)")
      .getByRole("button", { name: "Update Hello World (sample)" })
      .click();
    // Refused before anything is staged (so before any review is asked).
    await expect(card(updates, "Hello World (sample)").getByRole("alert")).toContainText(
      "changed after it was signed",
    );
    // Refused natively: the installed version, its grant and records exactly as they were.
    expect(readFileSync(join(EXTENSIONS, "inventory.json"), "utf8")).toBe(before);
    expect(leftovers()).toEqual([]);
    await palette(running.page, "Hello World: Say Hello");
    await expect(message(running.page)).toContainText("Hello, world!");
    await close(running);
  } finally {
    if (running.app.exitCode === null) running.app.kill();
  }
});
