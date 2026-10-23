/**
 * Driving the installed Yavin (IDE-08/09): the application extracted from its MSI by
 * `scripts/e2e-real-host.mjs`, launched with WebView2's DevTools port open, under the test
 * identifier `com.yavin.ide.e2e` -- its own settings, session, trust and extensions folders, never
 * the user's.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { readdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chromium, expect, type Browser, type Locator, type Page } from "@playwright/test";

// Its real, long form (EXT-24): a temporary folder can be named in 8.3 form (C:UsersSALMAN~1...),
// while Windows reports a running process by its long path -- the same file, spelled two ways.
export const INSTALL = process.env.YAVIN_E2E_INSTALL
  ? realpathSync.native(process.env.YAVIN_E2E_INSTALL)
  : "";
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
/**
 * EXT-27: the OS foreground, as a user changes it. Gives the foreground to `pid`'s first visible
 * titled window (restored first if asked), the way Windows lets a background process do so (an
 * Alt press first); returns whether that window is now the foreground one.
 */
export function foreground(pid: number, restore = false): boolean {
  const script = `
Add-Type -Namespace Y -Name W -MemberDefinition @"
[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();
[DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr h, int c);
[DllImport(\"user32.dll\")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport(\"user32.dll\")] public static extern int GetWindowTextLength(IntPtr h);
[DllImport(\"user32.dll\")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
[DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
public delegate bool EnumProc(IntPtr h, IntPtr l);
[DllImport(\"user32.dll\")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
"@
$found = New-Object System.Collections.ArrayList
[Y.W]::EnumWindows({ param($h, $l) $p = 0; [Y.W]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null
  if ($p -eq ${pid} -and [Y.W]::IsWindowVisible($h) -and [Y.W]::GetWindowTextLength($h) -gt 0) { [void]$found.Add($h) }; $true }, [IntPtr]::Zero) | Out-Null
if (-not $found.Count) { "False"; exit }
$h = $found[0]
if (${restore ? "$true" : "$false"}) { [Y.W]::ShowWindow($h, 9) | Out-Null }
[Y.W]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [Y.W]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
[Y.W]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 200
[Y.W]::GetForegroundWindow() -eq $h`;
  const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
  });
  return out.trim().endsWith("True");
}

/** Another application's window (a form of this test's own), to take the foreground from Yavin. */
export function otherApplication(): ChildProcess {
  return spawn(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-Command",
      "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object Windows.Forms.Form; $f.Text = 'Yavin e2e: another application'; [void]$f.ShowDialog()",
    ],
    { stdio: "ignore" },
  );
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

/** The Extensions view, opened if it is not the one showing (its icon on an open view hides it). */
export async function extensionsView(page: Page) {
  const view = page.getByRole("complementary", { name: "Extensions" });
  // A window that restores the Extensions view may show it a moment after starting: clicking
  // its icon then would hide it. Given that moment first, then opened if still not showing.
  await view.waitFor({ state: "visible", timeout: 3000 }).catch(() => undefined);
  if (!(await view.isVisible()))
    await page.getByTitle("Extensions & Plugins (Ctrl+Shift+X)", { exact: true }).click();
  await expect(view).toBeVisible();
  return view;
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

/**
 * A local registry that publishes nothing, for tests that are not about the marketplace: what
 * they see must not depend on the network or on what Yavin's registry publishes (a newer
 * version there would show an extension as "Update Available" instead of its running state).
 */
export async function emptyRegistry(): Promise<{ url: string; close(): Promise<void> }> {
  const { createServer } = await import("node:http");
  const index = JSON.stringify({
    schema: 1,
    name: "Empty test registry",
    categories: [],
    recommended: [],
    extensions: [],
  });
  const server = createServer((request, response) => {
    if ((request.url ?? "").split("?")[0] === "/index.json") {
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(index),
      });
      response.end(index);
    } else response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`;
  return { url, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

// --- EXT-19: extensions installed as a user installs them ------------------------------------

/** A stored ZIP of `files` (no compression, no timestamps): an extension package. */
// Exported for the VS Code package test (EXT-27).
export function storedZip(files: { name: string; data: Buffer }[]): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (bytes: Buffer) => {
    let c = 0xffffffff;
    for (const b of bytes) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const header = (signature: number, entry: boolean) => {
      const b = Buffer.alloc(entry ? 46 : 30);
      let i = 0;
      const u32 = (v: number) => void (i = b.writeUInt32LE(v >>> 0, i));
      const u16 = (v: number) => void (i = b.writeUInt16LE(v, i));
      u32(signature);
      if (entry) u16(20);
      u16(20);
      u16(0x0800);
      u16(0);
      u16(0);
      u16(0x21);
      u32(crc);
      u32(data.length);
      u32(data.length);
      u16(nameBytes.length);
      u16(0);
      if (entry) {
        u16(0);
        u16(0);
        u16(0);
        u32(0);
        u32(offset);
      }
      return b;
    };
    const local = Buffer.concat([header(0x04034b50, false), nameBytes, data]);
    central.push(Buffer.concat([header(0x02014b50, true), nameBytes]));
    locals.push(local);
    offset += local.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/**
 * A loopback registry publishing exactly what `extension-host.spec.ts` needs, so that it can
 * install it as a user does (EXT-19: a folder put in Yavin's extensions folder by hand is
 * adopted, never checked, and does not run): the Hello World sample at the version in the
 * repository (its published package -- so no update is ever found), and an extension that
 * fails when it activates, packaged here.
 */
export async function sampleRegistry(): Promise<{ url: string; close(): Promise<void> }> {
  const { createServer } = await import("node:http");
  const { readFileSync, existsSync } = await import("node:fs");
  const { createHash } = await import("node:crypto");
  const { fileURLToPath } = await import("node:url");
  const root = fileURLToPath(new URL("../../registry/", import.meta.url));
  const index = JSON.parse(readFileSync(join(root, "index.json"), "utf8"));
  const sampleVersion = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL("../../extensions/samples/hello-world/yavin-extension.json", import.meta.url),
      ),
      "utf8",
    ),
  ).version;
  const hello = index.extensions.find(
    (one: { id: string }) => one.id === "yavin-samples.hello-world",
  );
  hello.versions = hello.versions.filter(
    (one: { version: string }) => one.version === sampleVersion,
  );
  const manifest = {
    publisher: "acme",
    name: "broken",
    displayName: "Broken",
    description: "Throws when it activates.",
    version: "1.0.0",
    engines: { yavin: "^2.0.0" },
    main: "extension.js",
    activationEvents: ["onCommand:acme.broken.go"],
    contributes: { commands: [{ command: "acme.broken.go", title: "Go", category: "Broken" }] },
  };
  const brokenPackage = storedZip([
    { name: "yavin-extension.json", data: Buffer.from(JSON.stringify(manifest)) },
    {
      name: "extension.js",
      data: Buffer.from('module.exports.activate = function () { throw new Error("kaboom"); };'),
    },
  ]);
  const broken = {
    id: "acme.broken",
    publisher: "acme",
    name: "broken",
    displayName: "Broken",
    publisherDisplayName: "Acme",
    description: "Throws when it activates.",
    categories: ["samples"],
    tags: [],
    contributes: { commands: [{ command: "acme.broken.go", title: "Broken: Go" }], settings: [] },
    extensionKind: "code",
    activationEvents: ["onCommand:acme.broken.go"],
    versions: [
      {
        version: "1.0.0",
        publishedAt: "2026-10-19",
        engines: { yavin: "^2.0.0" },
        package: "packages/acme.broken-1.0.0.yvx",
        sha256: createHash("sha256").update(brokenPackage).digest("hex"),
        size: brokenPackage.length,
      },
    ],
  };
  // Signed (EXT-20): the test build pins this registry under the run's test key.
  const { text: served, signature: servedSignature } = signedIndex({
    name: "Sample test registry",
    categories: index.categories,
    recommended: [hello.id, broken.id],
    extensions: [hello, broken],
  });
  const types: Record<string, string> = {
    ".json": "text/plain; charset=utf-8",
    ".md": "text/plain; charset=utf-8",
    ".png": "image/png",
    ".yvx": "application/octet-stream",
  };
  const server = createServer((request, response) => {
    const path = decodeURIComponent((request.url ?? "/").split("?")[0]).replace(/^\//, "");
    const send = (type: string, body: Buffer | string) => {
      response.writeHead(200, { "Content-Type": type, "Content-Length": Buffer.byteLength(body) });
      response.end(body);
    };
    if (path === "index.json") return send("application/json", served);
    if (path === "index.json.sig") return send("text/plain", servedSignature);
    if (path === "packages/acme.broken-1.0.0.yvx") return send(types[".yvx"], brokenPackage);
    const file = join(root, path);
    if (!path.includes("..") && file.startsWith(root) && existsSync(file))
      return send(
        types[path.slice(path.lastIndexOf("."))] ?? "application/octet-stream",
        readFileSync(file),
      );
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`;
  return { url, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** Installs the sample registry's extensions from the Extensions view, as a user does. */
export async function installSamples(page: Page) {
  const view = await extensionsView(page);
  const recommended = view.getByRole("region", { name: "Recommended extensions" });
  const installed = view.getByRole("region", { name: "Installed extensions" });
  for (const name of ["Hello World (sample)", "Broken"]) {
    await recommended
      .getByRole("group", { name, exact: true })
      .getByRole("button", { name: `Install ${name}` })
      .click();
    // The sample asks to read documents (EXT-07): installed without allowing it.
    if (name.startsWith("Hello")) {
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("option", { name: /^Install without allowing/ }).click();
      await expect(dialog).toHaveCount(0);
    }
    await expect(installed.getByRole("group", { name, exact: true })).toBeVisible();
  }
  // Back to the Explorer, as the window was.
  await page.getByTitle("Explorer (Ctrl+Shift+E)", { exact: true }).click();
  await expect(page.getByRole("tree", { name: "Files" })).toBeVisible();
}

// --- EXT-20: a test registry's signed index ---------------------------------------------------

/** This run's test registry key: its public half reaches the test build only through
 *  `YAVIN_TEST_REGISTRY_KEY`, bound to `YAVIN_TEST_REGISTRY` (no other build reads either). */
const testKey = (() => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
  return { privateKey, raw };
})();

/** What Yavin is started with to use the loopback registry at `url`, under the test key. */
export const registryEnv = (url: string) => ({
  YAVIN_TEST_REGISTRY: url,
  YAVIN_TEST_REGISTRY_KEY: testKey.raw,
});

/** `index` as the test registry publishes it, signed (EXT-20): its text and signature file. */
export function signedIndex(index: Record<string, unknown>, sequence = 1) {
  const {
    schema: _schema,
    registryId: _id,
    sequence: _seq,
    issuedAt: _at,
    expiresAt: _until,
    ...rest
  } = index;
  const text = JSON.stringify({
    schema: 1,
    registryId: "yavin-test",
    sequence,
    issuedAt: "2026-01-01",
    expiresAt: "2099-12-31",
    ...rest,
  });
  const signature = sign(
    null,
    Buffer.concat([Buffer.from("Yavin.RegistryIndex.v1\0", "utf8"), Buffer.from(text, "utf8")]),
    testKey.privateKey,
  ).toString("base64");
  return {
    text,
    signature: JSON.stringify({
      schema: 1,
      registryId: "yavin-test",
      keyId: "test",
      algorithm: "ed25519",
      signature,
    }),
  };
}
