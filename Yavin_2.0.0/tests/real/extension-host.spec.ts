/**
 * The packaged Yavin with its real extension host (IDE-08) -- no mocks anywhere.
 *
 * `scripts/e2e-real-host.mjs` builds the release installer (MSI) with a test identifier
 * (`com.yavin.ide.e2e`: its own settings, session, trust and extensions folders, never the
 * user's), extracts it the way an installation lays it out, and runs this against the
 * extracted application: the real window (driven through WebView2's DevTools protocol), the
 * real native layer, the `yavin-extension-host` process shipped as a bundle resource, and the
 * Hello World sample installed in the profile's extensions folder.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect, test, type Browser, type Page } from "@playwright/test";

const INSTALL = process.env.YAVIN_E2E_INSTALL ?? "";
const IDENTIFIER = "com.yavin.ide.e2e";
const PORT = 9339;
const CONFIG = join(process.env.APPDATA ?? "", IDENTIFIER);
const DATA = join(process.env.LOCALAPPDATA ?? "", IDENTIFIER);
const ROOT = join(tmpdir(), `yavin-e2e-workspaces-${process.pid}`);
const A = join(ROOT, "alpha");
const B = join(ROOT, "beta");
const SAMPLE = new URL("../../extensions/samples/hello-world/", import.meta.url);

test.describe.configure({ mode: "serial" });
test.skip(
  !INSTALL,
  "Run through scripts/e2e-real-host.mjs, which builds and extracts the installer.",
);

function find(folder: string, name: string): string | null {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return path;
    if (entry.isDirectory()) {
      const found = find(path, name);
      if (found) return found;
    }
  }
  return null;
}

const host = () => find(INSTALL, "yavin-extension-host.exe");
const application = () => {
  for (const name of ["Yavin IDE.exe", "yavin-ide.exe"]) {
    const found = find(INSTALL, name);
    if (found) return found;
  }
  throw new Error(`No Yavin executable under ${INSTALL}`);
};

/** The child processes of `pid`: id and executable path. */
function children(pid: number): { id: number; path: string }[] {
  const out = execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | ForEach-Object { "$($_.ProcessId)|$($_.ExecutablePath)" }`,
    ],
    { encoding: "utf8" },
  );
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [id, path] = line.split("|");
      return { id: Number(id), path: path ?? "" };
    });
}
const hostProcesses = (pid: number) =>
  children(pid).filter((child) => /yavin-extension-host\.exe$/i.test(child.path));
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A fresh test profile: two recent folders (A in front), the sample and a broken extension installed. */
function prepareProfile() {
  for (const folder of [CONFIG, DATA, ROOT]) {
    if (!folder.includes(IDENTIFIER) && folder !== ROOT)
      throw new Error(`refusing to clear ${folder}`);
    rmSync(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
  }
  for (const folder of [A, B]) {
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "readme.md"), `# ${folder}\nhello\n`);
  }
  mkdirSync(CONFIG, { recursive: true });
  writeFileSync(
    join(CONFIG, "session.json"),
    JSON.stringify({ version: 1, folders: [A, B], workspaces: [] }),
  );
  const extensions = join(DATA, "extensions");
  cpSync(SAMPLE, join(extensions, "hello-world"), { recursive: true });
  mkdirSync(join(extensions, "acme.broken"), { recursive: true });
  writeFileSync(
    join(extensions, "acme.broken", "yavin-extension.json"),
    JSON.stringify({
      publisher: "acme",
      name: "broken",
      displayName: "Broken",
      version: "1.0.0",
      engines: { yavin: "^2.0.0" },
      main: "extension.js",
      activationEvents: ["onCommand:acme.broken.go"],
      contributes: { commands: [{ command: "acme.broken.go", title: "Go", category: "Broken" }] },
    }),
  );
  writeFileSync(
    join(extensions, "acme.broken", "extension.js"),
    'module.exports.activate = function () { throw new Error("kaboom"); };',
  );
}

/** WebView2 processes of the test profile: they outlive Yavin by a moment. */
function webviews(): number {
  const out = execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `@(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -like '*${IDENTIFIER}*' }).Count`,
    ],
    { encoding: "utf8" },
  );
  return Number(out.trim());
}
async function profileReleased() {
  await expect.poll(webviews, { timeout: 30_000 }).toBe(0);
}

interface Running {
  app: ChildProcess;
  browser: Browser;
  page: Page;
}

async function launch(): Promise<Running> {
  const app = spawn(application(), [], {
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    },
    stdio: "ignore",
  });
  let browser: Browser | null = null;
  const until = Date.now() + 60_000;
  while (!browser) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    } catch (error) {
      if (Date.now() > until) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  const pageOf = () => browser!.contexts().flatMap((context) => context.pages())[0];
  await expect.poll(() => !!pageOf(), { timeout: 30_000 }).toBe(true);
  const page = pageOf();
  await page.waitForLoadState("domcontentloaded");
  return { app, browser, page };
}

async function close({ app, browser, page }: Running) {
  if (app.exitCode === null) {
    await page.getByRole("menubar").getByRole("menuitem", { name: "File", exact: true }).click();
    await page
      .getByRole("menu", { name: "File", exact: true })
      .getByRole("menuitem", { name: "Exit" })
      .click();
  }
  await expect
    .poll(() => app.exitCode !== null || app.signalCode !== null, { timeout: 30_000 })
    .toBe(true);
  await browser.close().catch(() => undefined);
  await profileReleased();
}

/**
 * The real Workspace Trust flow: a folder never decided in this (fresh) profile is asked about
 * before anything runs, and is trusted; one already trusted opens without asking.
 */
async function trust(page: Page, asked: boolean) {
  if (asked) {
    await page.getByRole("button", { name: "Yes, I trust the authors" }).click({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Yes, I trust the authors" })).toBeHidden();
  }
  await expect(page.getByRole("tree", { name: "Files" })).toBeVisible({ timeout: 30_000 });
}

async function palette(page: Page, command: string) {
  const search = page.getByRole("combobox", { name: "Search files or commands" });
  await expect(async () => {
    await page.keyboard.press("Control+Shift+P");
    await expect(search).toBeVisible({ timeout: 1000 });
  }).toPass();
  await search.fill(`>${command}`);
  await page.getByRole("option").filter({ hasText: command }).first().click();
}

async function extensionsView(page: Page) {
  await page.getByTitle("Extensions & Plugins (Ctrl+Shift+X)", { exact: true }).click();
  return page.getByRole("complementary", { name: "Extensions" });
}
const message = (page: Page) => page.getByRole("status", { name: "Extension message" });
const alert = (page: Page) => page.getByRole("alert").and(page.locator(":not(.monaco-alert)"));

test.beforeEach(() => prepareProfile());
test.afterAll(async () => {
  await profileReleased();
  // WebView2 lets go of the profile a moment after Yavin exits.
  for (const folder of [ROOT, CONFIG, DATA])
    rmSync(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
});

test("the installed host is packaged where Yavin looks for it", () => {
  const packaged = host();
  expect(packaged, "yavin-extension-host.exe in the installation").not.toBeNull();
  expect(packaged!.replaceAll("\\", "/")).toMatch(
    /\/resources\/extension-host\/yavin-extension-host\.exe$/i,
  );
});

test("installed Yavin runs Hello World in the real host, end to end, and ends the host on exit", async () => {
  const running = await launch();
  const { app, page } = running;
  try {
    await trust(page, true);
    expect(hostProcesses(app.pid!)).toEqual([]); // lazy: nothing runs yet
    await palette(page, "Hello World: Say Hello");
    await expect(message(page)).toContainText("Hello, world!");
    // The real process, from the installation, a child of Yavin.
    await expect.poll(() => hostProcesses(app.pid!).length).toBe(1);
    const [child] = hostProcesses(app.pid!);
    expect(child.path.toLowerCase()).toBe(host()!.toLowerCase());
    const view = await extensionsView(page);
    await expect(
      view.getByRole("group", { name: "Hello World (sample)" }).getByTestId("extension-state"),
    ).toHaveText(/^Active/);
    await expect(view.getByTestId("extension-host")).toContainText("Host running");
    await expect(view.getByRole("region", { name: "Greetings" })).toContainText("Hello, world!");
    // A failing extension is reported and breaks nothing.
    await palette(page, "Broken: Go");
    await expect(alert(page)).toContainText("kaboom");
    await palette(page, "Hello World: Say Hello");
    await expect(
      view
        .getByRole("region", { name: "Greetings" })
        .getByRole("treeitem", { name: "Hello, world!" }),
    ).toHaveCount(2);
    expect(hostProcesses(app.pid!).map((c) => c.id)).toEqual([child.id]);
    // Exit: Yavin ends, and so does its host.
    await close(running);
    await expect.poll(() => alive(child.id), { timeout: 15_000 }).toBe(false);
  } finally {
    if (app.exitCode === null) app.kill();
  }
});

test("a crashed host is reported; Restart starts a new real host and the extension works again", async () => {
  const running = await launch();
  const { app, page } = running;
  try {
    await trust(page, true);
    await palette(page, "Hello World: Say Hello");
    await expect(message(page)).toContainText("Hello, world!");
    await expect.poll(() => hostProcesses(app.pid!).length).toBe(1);
    const [first] = hostProcesses(app.pid!);
    const view = await extensionsView(page);
    process.kill(first.id); // the host dies
    await expect(view.getByTestId("extension-host")).toContainText("1 crash");
    await expect(
      view.getByRole("group", { name: "Hello World (sample)" }).getByTestId("extension-state"),
    ).not.toHaveText(/^Active/);
    await view.getByRole("button", { name: "Restart", exact: true }).click();
    await palette(page, "Hello World: Say Hello");
    await expect(
      view.getByRole("group", { name: "Hello World (sample)" }).getByTestId("extension-state"),
    ).toHaveText(/^Active/);
    await expect.poll(() => hostProcesses(app.pid!).length).toBe(1);
    const [second] = hostProcesses(app.pid!);
    expect(second.id).not.toBe(first.id);
    await close(running);
    await expect.poll(() => alive(second.id), { timeout: 15_000 }).toBe(false);
  } finally {
    if (app.exitCode === null) app.kill();
  }
});

test("switching workspace ends A's host; B starts from nothing; A's state comes back with A", async () => {
  const running = await launch();
  const { app, page } = running;
  try {
    await trust(page, true);
    await palette(page, "Hello World: Say Hello");
    await expect(message(page)).toContainText("Hello, world!");
    await expect.poll(() => hostProcesses(app.pid!).length).toBe(1);
    const [ofA] = hostProcesses(app.pid!);

    await palette(page, "Welcome");
    await page.getByTitle(B, { exact: true }).click();
    await trust(page, true);
    await expect.poll(() => alive(ofA.id), { timeout: 15_000 }).toBe(false);
    const view = await extensionsView(page);
    await expect(view.getByRole("region", { name: "Greetings" })).toContainText("No greetings yet");
    await expect(view.getByRole("region", { name: "Greetings" })).not.toContainText(
      "Hello, world!",
    );
    const inB = hostProcesses(app.pid!);
    expect(inB.map((c) => c.id)).not.toContain(ofA.id);

    await palette(page, "Welcome");
    await page.getByTitle(A, { exact: true }).click();
    await trust(page, false);
    const again = await extensionsView(page);
    await expect(again.getByRole("region", { name: "Greetings" })).toContainText("Hello, world!");
    await close(running);
  } finally {
    if (app.exitCode === null) app.kill();
  }
});

test("without its host, installed Yavin says so and everything else works", async () => {
  const packaged = host()!;
  const aside = `${packaged}.aside`;
  renameSync(packaged, aside);
  const running = await launch();
  const { app, page } = running;
  try {
    await trust(page, true);
    await palette(page, "Hello World: Say Hello");
    await expect(alert(page)).toContainText("extension host");
    await expect(alert(page)).toContainText("missing");
    expect(hostProcesses(app.pid!)).toEqual([]);
    // The IDE itself is unaffected.
    await expect(page.getByText("readme.md", { exact: true })).toBeVisible();
    await close(running);
  } finally {
    if (app.exitCode === null) app.kill();
    if (existsSync(aside)) renameSync(aside, packaged);
  }
});
