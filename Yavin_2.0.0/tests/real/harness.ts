/**
 * Driving the installed Yavin (IDE-08/09): the application extracted from its MSI by
 * `scripts/e2e-real-host.mjs`, launched with WebView2's DevTools port open, under the test
 * identifier `com.yavin.ide.e2e` -- its own settings, session, trust and extensions folders, never
 * the user's.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chromium, expect, type Browser, type Locator, type Page } from "@playwright/test";

export const INSTALL = process.env.YAVIN_E2E_INSTALL ?? "";
export const IDENTIFIER = "com.yavin.ide.e2e";
const PORT = 9339;
export const CONFIG = join(process.env.APPDATA ?? "", IDENTIFIER);
export const DATA = join(process.env.LOCALAPPDATA ?? "", IDENTIFIER);
export const EXTENSIONS = join(DATA, "extensions");

export function find(folder: string, name: string): string | null {
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

export const host = () => find(INSTALL, "yavin-extension-host.exe");
export const application = () => {
  for (const name of ["Yavin IDE.exe", "yavin-ide.exe"]) {
    const found = find(INSTALL, name);
    if (found) return found;
  }
  throw new Error(`No Yavin executable under ${INSTALL}`);
};

/** The child processes of `pid`: id and executable path. */
export function children(pid: number): { id: number; path: string }[] {
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
export const hostProcesses = (pid: number) =>
  children(pid).filter((child) => /yavin-extension-host\.exe$/i.test(child.path));
export function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
export async function profileReleased() {
  await expect.poll(webviews, { timeout: 30_000 }).toBe(0);
}

/**
 * Removes the test profile (and `others`); only folders of the test identifier or listed. Waits
 * for WebView2 to let go of it first (a test that failed may have left its window closing).
 */
export async function clearProfile(...others: string[]) {
  await profileReleased();
  for (const folder of [CONFIG, DATA, ...others]) {
    if (!folder.includes(IDENTIFIER) && !others.includes(folder))
      throw new Error(`refusing to clear ${folder}`);
    rmSync(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
  }
}

export interface Running {
  app: ChildProcess;
  browser: Browser;
  page: Page;
}

export async function launch(env: Record<string, string> = {}): Promise<Running> {
  const app = spawn(application(), [], {
    env: {
      ...process.env,
      ...env,
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

export async function close({ app, browser, page }: Running) {
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
export async function trust(page: Page, asked: boolean) {
  if (asked) {
    await page.getByRole("button", { name: "Yes, I trust the authors" }).click({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Yes, I trust the authors" })).toBeHidden();
  }
  await expect(page.getByRole("tree", { name: "Files" })).toBeVisible({ timeout: 30_000 });
}

export async function palette(page: Page, command: string) {
  const search = page.getByRole("combobox", { name: "Search files or commands" });
  await expect(async () => {
    await page.keyboard.press("Control+Shift+P");
    await expect(search).toBeVisible({ timeout: 1000 });
  }).toPass();
  await search.fill(`>${command}`);
  await page.getByRole("option").filter({ hasText: command }).first().click();
}

export async function extensionsView(page: Page) {
  await page.getByTitle("Extensions & Plugins (Ctrl+Shift+X)", { exact: true }).click();
  return page.getByRole("complementary", { name: "Extensions" });
}

/** The Extensions view's runtime diagnostics (the host line, Restart, Reload). */
export async function showDiagnostics(page: Page, view: Locator) {
  await view.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Show Runtime Diagnostics" }).click();
  await expect(view.getByTestId("extension-host")).toBeVisible();
}

export const message = (page: Page) => page.getByRole("status", { name: "Extension message" });
/** The window's error bar (not an alert inside a view, like the Extensions view's). */
export const alert = (page: Page) =>
  page.locator("[role=alert]:not(.monaco-alert):not(aside [role=alert])");
