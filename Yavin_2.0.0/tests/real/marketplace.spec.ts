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
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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

/** The registry server: the real files; `/tampered/` with a wrong checksum; offline on demand. */
const server = { offline: false, requests: [] as string[] };
let http: Server;
let base = "";
const TYPES: Record<string, string> = {
  ".json": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".png": "image/png",
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
    path = path.replace(/^\/(tampered\/)?/, "");
    const file = normalize(join(root, path));
    if (!file.startsWith(root) || !existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    let body = readFileSync(file);
    if (tampered && path === "index.json") {
      const index = JSON.parse(body.toString("utf8"));
      for (const extension of index.extensions)
        for (const version of extension.versions) version.sha256 = "0".repeat(64);
      body = Buffer.from(JSON.stringify(index));
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
  const running = await launch({ YAVIN_TEST_REGISTRY: registry });
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

const installedFolder = (id: string) => join(EXTENSIONS, id);
const leftovers = () =>
  existsSync(EXTENSIONS)
    ? readdirSync(EXTENSIONS).filter(
        (name) => name.startsWith(".") && readdirSync(join(EXTENSIONS, name)).length,
      )
    : [];

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
    await timed("install (click to registered)", async () => {
      await wordCount.getByRole("button", { name: "Install Word Count" }).click();
      await expect(installed.getByTestId("extension-state")).toHaveText("Enabled");
    });
    // On disk: unpacked into Yavin's extensions folder, nothing left in staging.
    expect(existsSync(join(installedFolder("yavin.word-count"), "extension.js"))).toBe(true);
    expect(
      JSON.parse(
        readFileSync(join(installedFolder("yavin.word-count"), "yavin-extension.json"), "utf8"),
      ).version,
    ).toBe("1.0.0");
    expect(leftovers()).toEqual([]);
    expect(server.requests).toContain("/packages/yavin.word-count-1.0.0.yvx");
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

test("an update: Hello World 2.0.0 installed, 2.1.0 found and installed; the new code runs", async () => {
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
    await details.getByRole("button", { name: "Install version 2.0.0" }).click();
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
      await expect(updates).toContainText("All installed extensions are up to date.");
    });
    expect(
      JSON.parse(
        readFileSync(
          join(installedFolder("yavin-samples.hello-world"), "yavin-extension.json"),
          "utf8",
        ),
      ).version,
    ).toBe("2.1.0");
    expect(leftovers()).toEqual([]); // the previous version was cleaned up
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
    const installed = view.getByRole("region", { name: "Installed extensions" });
    await card(installed, "TODO Highlighter")
      .getByRole("button", { name: "Manage TODO Highlighter" })
      .click();
    await page.getByRole("menuitem", { name: "Uninstall" }).click();
    await page
      .getByRole("dialog")
      .getByRole("option", { name: /^Uninstall Keep/ })
      .click();
    await expect(installed.getByRole("group", { name: "TODO Highlighter" })).toHaveCount(0);
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
