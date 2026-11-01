/**
 * EXT-31: a VS Code webview panel in the installed application -- WebView2, Tauri and the native
 * webview protocol as they really are. On Windows, WebView2 adds Tauri's IPC script to every frame
 * (wry's documentation), so this is where isolation must hold: from inside a real webview, the
 * page tries every way out it has -- Tauri's IPC, the IPC endpoint, the window's DOM, top and
 * self navigation, remote loads, popups, storage -- and reports; the test requires each to fail,
 * its own files to load, and messages to pass. A loopback Open VSX mirror serves the probe,
 * signed under a key this run makes (as `vscode.spec.ts`).
 */
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  CONFIG,
  clearProfile,
  close,
  emptyRegistry,
  extensionsView,
  INSTALL,
  launch,
  registryEnv,
  storedZip,
  trust,
} from "./harness";

const ROOT = join(tmpdir(), `yavin-e2e-webview-${process.pid}`);
const WORK = join(ROOT, "work");

test.describe.configure({ mode: "serial" });
test.skip(
  !INSTALL,
  "Run through scripts/e2e-real-host.mjs, which builds and extracts the installer.",
);

const NS = "acme";
const NAME = "webview-probe";
const VERSION = "1.0.0";

/** The page: each attempt's outcome, then whether it is still alive after trying to navigate. */
const PAGE_SCRIPT = `
const api = acquireVsCodeApi();
const results = {};
const settle = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve("timed out"), ms))]);
(async () => {
  // Shown again after leaving: its page is back, with the state it saved.
  const prior = api.getState();
  if (prior && prior.navigated) {
    api.postMessage({ kind: "restored", state: prior });
    return;
  }
  results.tauriScript = typeof window.__TAURI_INTERNALS__;
  results.ipc = await settle(
    (async () => {
      try {
        const answer = await window.__TAURI_INTERNALS__.invoke("extensions_list", {});
        return "ALLOWED " + JSON.stringify(answer).slice(0, 60);
      } catch (e) {
        return "refused";
      }
    })(),
    4000,
  );
  // A command with an effect anyone can see: disabling this very extension. If it ever ran, the
  // extension would stop -- its panel closed, its status items gone; the test checks they stay.
  results.ipcEffect = await settle(
    (async () => {
      try {
        await window.__TAURI_INTERNALS__.invoke("extensions_set_enabled", { id: "acme.webview-probe", enabled: false });
        return "ALLOWED";
      } catch (e) {
        return "refused";
      }
    })(),
    4000,
  );
  results.ipcFetch = await settle(fetch("http://ipc.localhost/extensions_list", { method: "POST", body: "{}" }).then(() => "ALLOWED", () => "refused"), 4000);
  try { results.parent = "READ " + window.parent.document.title; } catch (e) { results.parent = "refused"; }
  // Navigating the window: blocked by the sandbox (Chromium may not throw; the test checks the
  // window is still Yavin).
  try { window.top.location.href = "https://example.com/"; } catch (e) {}
  results.popup = window.open("https://example.com/") ? "OPENED" : "refused";
  try { localStorage.setItem("x", "1"); results.storage = "OPEN"; } catch (e) { results.storage = "refused"; }
  results.remoteImage = await settle(new Promise((resolve) => { const i = new Image(); i.onload = () => resolve("LOADED"); i.onerror = () => resolve("refused"); i.src = "https://example.com/favicon.ico"; }), 4000);
  results.remoteScript = await settle(new Promise((resolve) => { const s = document.createElement("script"); s.onload = () => resolve("LOADED"); s.onerror = () => resolve("refused"); s.src = "https://example.com/x.js"; document.head.appendChild(s); }), 4000);
  results.ownImage = await settle(new Promise((resolve) => { const i = document.getElementById("own"); if (i.complete && i.naturalWidth) resolve("loaded"); i.onload = () => resolve("loaded"); i.onerror = () => resolve("FAILED"); }), 4000);
  results.ownScript = window.__ownScript === true ? "loaded" : "FAILED";
  results.outside = await settle(new Promise((resolve) => { const i = new Image(); i.onload = () => resolve("LOADED"); i.onerror = () => resolve("refused"); i.src = document.body.dataset.outside; }), 4000);
  api.postMessage({ kind: "results", results });
  // Navigating itself away: Yavin cancels it (WebView2 shows its own page instead), and serves
  // the panel's page again -- with this state.
  api.setState({ navigated: true });
  location.href = "https://example.com/";
})();
`;

const MAIN = `
const vscode = require("vscode");
exports.activate = (context) => {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  item.text = "Open isolation probe";
  item.command = "wvprobe.open";
  item.show();
  const report = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  context.subscriptions.push(item, report, vscode.commands.registerCommand("wvprobe.open", () => {
    const media = vscode.Uri.joinPath(context.extensionUri, "media");
    const panel = vscode.window.createWebviewPanel("wvprobe.view", "Isolation Probe", vscode.ViewColumn.One, { enableScripts: true, localResourceRoots: [media] });
    const w = panel.webview;
    const own = w.asWebviewUri(vscode.Uri.joinPath(media, "pic.svg"));
    const script = w.asWebviewUri(vscode.Uri.joinPath(media, "own.js"));
    const outside = w.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "package.json"));
    w.html = '<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \\'none\\'; img-src ' + w.cspSource + ' https:; script-src ' + w.cspSource + ' \\'unsafe-inline\\' https:; connect-src *;"></head>'
      + '<body data-outside="' + outside + '"><h1>Isolation probe</h1><img id="own" src="' + own + '"><script src="' + script + '"></script><script>' + ${JSON.stringify(PAGE_SCRIPT)} + '</script></body></html>';
    w.onDidReceiveMessage((m) => {
      if (m.kind === "results") {
        // Each attempt's expected outcome; the report (100 characters at most) names any other.
        const notThrough = ["refused", "timed out"];
        const expected = { ipc: notThrough, ipcEffect: notThrough, ipcFetch: "refused", parent: "refused", popup: "refused", storage: "refused", remoteImage: "refused", remoteScript: "refused", ownImage: "loaded", ownScript: "loaded", outside: "refused" };
        const wrong = Object.entries(expected).filter(([k, v]) => !(Array.isArray(v) ? v.includes(m.results[k]) : m.results[k] === v)).map(([k]) => k + "=" + m.results[k]);
        report.text = wrong.length ? "Webview FAIL " + wrong.join(" ") : "Webview ok; Tauri script " + m.results.tauriScript + "; invoke " + m.results.ipc + "/" + m.results.ipcEffect;
      }
      if (m.kind === "restored") vscode.window.showInformationMessage("isolation probe restored after navigating, state " + JSON.stringify(m.state));
      report.show();
    });
    panel.onDidDispose(() => vscode.window.showInformationMessage("isolation probe closed"));
  }));
};
`;

const PACKAGE_JSON = {
  publisher: NS,
  name: NAME,
  displayName: "Webview Probe",
  description: "A VS Code extension for Yavin's packaged webview tests",
  version: VERSION,
  engines: { vscode: "^1.80.0" },
  main: "./out/main.js",
  activationEvents: ["onStartupFinished"],
  contributes: {},
};

function vsix(): Buffer {
  const files = (entries: [string, string][]) =>
    entries.map(([name, text]) => ({ name, data: Buffer.from(text) }));
  return storedZip(
    files([
      ["extension.vsixmanifest", "<PackageManifest/>"],
      ["[Content_Types].xml", "<Types/>"],
      ["extension/package.json", JSON.stringify(PACKAGE_JSON)],
      ["extension/out/main.js", MAIN],
      [
        "extension/media/pic.svg",
        '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>',
      ],
      ["extension/media/own.js", "window.__ownScript = true;"],
    ]),
  );
}

const mirror = { requests: [] as string[] };
let http: Server;
let base = "";
let publicKey = "";
let closeRegistry: () => Promise<void> = async () => {};
let registryUrl = "";

test.beforeAll(async () => {
  const keys = generateKeyPairSync("ed25519");
  publicKey = keys.publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("base64");
  const pkg = vsix();
  const sha = createHash("sha256").update(pkg).digest("hex");
  const sigzip = storedZip([{ name: ".signature.sig", data: sign(null, pkg, keys.privateKey) }]);
  http = createServer((request, response) => {
    const url = new URL(request.url ?? "/", base);
    mirror.requests.push(url.pathname);
    const file = `${base}api/${NS}/${NAME}/${VERSION}/file/${NS}.${NAME}-${VERSION}`;
    const entry = {
      namespace: NS,
      name: NAME,
      version: VERSION,
      displayName: "Webview Probe",
      description: "A VS Code extension for Yavin's packaged webview tests",
      downloadCount: 1,
      verified: false,
      deprecated: false,
      timestamp: "2026-10-01T00:00:00.000000Z",
      files: {
        download: `${file}.vsix`,
        sha256: `${file}.sha256`,
        signature: `${file}.sigzip`,
        publicKey: `${base}api/-/public-key/yavin-test`,
      },
    };
    const record = {
      ...entry,
      namespaceDisplayName: "Acme",
      license: "MIT",
      engines: { vscode: "^1.80.0" },
      categories: ["Other"],
      tags: [],
      allVersions: {
        latest: `${base}api/${NS}/${NAME}/latest`,
        [VERSION]: `${base}api/${NS}/${NAME}/${VERSION}`,
      },
    };
    const json = (value: unknown) => {
      const body = Buffer.from(JSON.stringify(value));
      response
        .writeHead(200, { "Content-Type": "application/json", "Content-Length": body.length })
        .end(body);
    };
    const bytes = (body: Buffer, type: string) =>
      response.writeHead(200, { "Content-Type": type, "Content-Length": body.length }).end(body);
    const path = url.pathname;
    if (path === "/api/-/search") return json({ offset: 0, totalSize: 1, extensions: [entry] });
    if (path === `/api/${NS}/${NAME}` || path === `/api/${NS}/${NAME}/latest`) return json(record);
    if (path === `/api/${NS}/${NAME}/${VERSION}`) return json(record);
    if (path === `/api/${NS}/${NAME}/versions`)
      return json({
        offset: 0,
        totalSize: 1,
        versions: { [VERSION]: `${base}api/${NS}/${NAME}/${VERSION}` },
      });
    if (path.endsWith(".vsix")) return bytes(pkg, "application/octet-stream");
    if (path.endsWith(".sha256"))
      return bytes(
        Buffer.from(`${sha}  ${NS}.${NAME}-${VERSION}.vsix`),
        "application/octet-stream",
      );
    if (path.endsWith(".sigzip")) return bytes(sigzip, "application/octet-stream");
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`;
  const registry = await emptyRegistry();
  registryUrl = registry.url;
  closeRegistry = registry.close;
});
test.afterAll(async () => {
  await new Promise((resolve) => http.close(resolve));
  await closeRegistry();
  await clearProfile(ROOT);
});
test.beforeEach(async () => {
  await clearProfile(ROOT);
  mkdirSync(WORK, { recursive: true });
  writeFileSync(join(WORK, "notes.txt"), "hello\n");
  mkdirSync(CONFIG, { recursive: true });
  writeFileSync(
    join(CONFIG, "session.json"),
    JSON.stringify({ version: 1, folders: [WORK], workspaces: [] }),
  );
});

test("EXT-31 a webview in the installed application: its own files load and messages pass; IPC, the window, navigation, remote loads, popups and storage are all refused", async () => {
  const env = {
    ...registryEnv(registryUrl),
    YAVIN_TEST_OPENVSX: base,
    YAVIN_TEST_OPENVSX_KEY: publicKey,
  };
  const running = await launch(env);
  const { page } = running;
  try {
    await trust(page, true);
    await page.evaluate((url) => {
      localStorage.setItem(
        "yavin.settings.user",
        JSON.stringify({
          version: 1,
          values: {
            "extensions.marketplace.source": "openvsx",
            "extensions.marketplace.openVsxUrl": url,
          },
        }),
      );
    }, base);
    await page.reload();
    await trust(page, false);
    const view = await extensionsView(page);
    await view.getByRole("searchbox", { name: "Search extensions" }).fill("webview probe");
    const results = view.getByRole("region", { name: "Marketplace results" });
    const card = results.getByRole("group", { name: "Webview Probe", exact: true }).first();
    await card.getByRole("button", { name: "Install Webview Probe" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("option", { name: /^Install and allow/ }).click();
    await expect(dialog).toHaveCount(0);
    const open = page.locator(`[data-extension-status^="${NS}.${NAME}#status#"]`, {
      hasText: "Open isolation probe",
    });
    await expect(open).toBeVisible({ timeout: 30_000 });
    await open.click();

    const tab = page.getByRole("tab", { name: /Isolation Probe/ });
    await expect(tab).toBeVisible();
    const iframe = page.locator("iframe[data-webview]");
    await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
    await expect(iframe).toHaveAttribute(
      "src",
      /^https:\/\/yavin-webview\.invalid\/[0-9a-f]{32}\/index\.html\?/,
    );
    await expect(page.frameLocator("iframe[data-webview]").locator("h1")).toHaveText(
      "Isolation probe",
    );

    // What the page found, as the extension heard it.
    const report = page.locator(`[data-extension-status^="${NS}.${NAME}#status#"]`, {
      hasText: /^Webview /,
    });
    await expect(report).toBeVisible({ timeout: 30_000 });
    // Every attempt as expected (the extension compares; a failure names each wrong outcome).
    // Whether Tauri's script is in the frame is recorded: WebView2 adds it to every frame, and it
    // must not be usable.
    const text = (await report.textContent()) ?? "";
    test.info().annotations.push({ type: "webview isolation", description: text });
    expect(text).toMatch(/^Webview ok; /);
    // The command the frame tried did not run: the extension is still enabled and running.
    await page.waitForTimeout(2000);
    await expect(report).toBeVisible();
    const installedCard = (await extensionsView(page))
      .getByRole("region", { name: "Installed extensions" })
      .getByRole("group", { name: "Webview Probe", exact: true })
      .first();
    await expect(installedCard.getByTestId("extension-state")).toHaveText(/Enabled|Active/);
    // The window is still Yavin: the frame could not navigate it.
    expect(page.url()).toMatch(/^http:\/\/tauri\.localhost\//);
    // Its own navigation away was cancelled, and its page served again with its saved state.
    await expect(page.getByRole("status", { name: "Extension message" })).toContainText(
      'isolation probe restored after navigating, state {"navigated":true}',
      { timeout: 15_000 },
    );
    await expect(page.frameLocator("iframe[data-webview]").locator("h1")).toHaveText(
      "Isolation probe",
    );

    // Closing its tab disposes the panel: the extension hears it.
    await tab.hover();
    await page.getByRole("button", { name: "Close Isolation Probe" }).click();
    await expect(page.getByRole("status", { name: "Extension message" })).toContainText(
      "isolation probe closed",
    );
    await expect(iframe).toHaveCount(0);
  } finally {
    await close(running);
  }
});
