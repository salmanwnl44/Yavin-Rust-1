/**
 * EXT-31: a real Open VSX extension's webview feature in the installed application -- SVG Preview
 * (jock.svg), whose main feature is a webview panel showing the SVG being edited. The package is
 * the one Open VSX serves, downloaded by the benchmark (not in the repository): this test runs
 * only when `YAVIN_E2E_SVG_VSIX` names it. A loopback mirror serves it, signed under a key this
 * run makes (as `webview.spec.ts`). The test opens an `.svg` file and runs the extension's two
 * webview commands. "Preview All Svg" must open its page sandboxed, run its script, and deliver
 * its message to the extension (which then stops at `workspace.findFiles`, unsupported);
 * "Preview SVG" is recorded (it previews only documents whose language is `svg`).
 */
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  CONFIG,
  clearProfile,
  close,
  emptyRegistry,
  extensionsView,
  INSTALL,
  launch,
  palette,
  registryEnv,
  storedZip,
  trust,
} from "./harness";

const VSIX = process.env.YAVIN_E2E_SVG_VSIX ?? "";
const ROOT = join(tmpdir(), `yavin-e2e-svg-${process.pid}`);
const WORK = join(ROOT, "work");

test.describe.configure({ mode: "serial" });
test.skip(
  !INSTALL,
  "Run through scripts/e2e-real-host.mjs, which builds and extracts the installer.",
);
test.skip(
  !VSIX || !existsSync(VSIX),
  "Set YAVIN_E2E_SVG_VSIX to jock.svg 1.5.3's package, downloaded from Open VSX.",
);

const NS = "jock";
const NAME = "svg";
const VERSION = "1.5.3";
const DRAWING =
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="0 0 120 80">' +
  '<rect id="yavin-probe-rect" x="10" y="10" width="100" height="60" fill="#3a7"/></svg>\n';

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
  const pkg = readFileSync(VSIX);
  const sha = createHash("sha256").update(pkg).digest("hex");
  const sigzip = storedZip([{ name: ".signature.sig", data: sign(null, pkg, keys.privateKey) }]);
  http = createServer((request, response) => {
    const url = new URL(request.url ?? "/", base);
    const file = `${base}api/${NS}/${NAME}/${VERSION}/file/${NS}.${NAME}-${VERSION}`;
    const entry = {
      namespace: NS,
      name: NAME,
      version: VERSION,
      displayName: "SVG",
      description: "SVG Coding, Minify, Pretty, Preview All-In-One",
      downloadCount: 1,
      verified: false,
      deprecated: false,
      timestamp: "2023-07-02T00:00:00.000000Z",
      files: {
        download: `${file}.vsix`,
        sha256: `${file}.sha256`,
        signature: `${file}.sigzip`,
        publicKey: `${base}api/-/public-key/yavin-test`,
      },
    };
    const record = {
      ...entry,
      namespaceDisplayName: "jock",
      license: "MIT",
      engines: { vscode: "^1.50.0" },
      categories: ["Programming Languages"],
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
  await new Promise((resolve) => http?.close(resolve));
  await closeRegistry();
  await clearProfile(ROOT);
});
test.beforeEach(async () => {
  await clearProfile(ROOT);
  mkdirSync(WORK, { recursive: true });
  writeFileSync(join(WORK, "drawing.svg"), DRAWING);
  mkdirSync(CONFIG, { recursive: true });
  writeFileSync(
    join(CONFIG, "session.json"),
    JSON.stringify({ version: 1, folders: [WORK], workspaces: [] }),
  );
});

/** The extension's own log: its Output channel's lines. */
async function extensionLog(page: Page): Promise<string[]> {
  const output = page.getByRole("region", { name: "Output" });
  if (!(await output.count())) {
    const views = page.getByRole("tablist", { name: "Panel views" });
    if (!(await views.count()))
      await page.getByTitle("Toggle Terminal Panel (Ctrl+`)", { exact: true }).click();
    await views
      .getByRole("tab", { name: /output/i })
      .first()
      .click({ timeout: 5000 });
  }
  await output.getByLabel("Output channel").selectOption({ label: "Extension: SVG" });
  return output.getByRole("listitem").allTextContents();
}

test("EXT-31 SVG Preview (Open VSX): its Preview All webview loads sandboxed and its page's message reaches the extension, which stops at workspace.findFiles", async () => {
  const env = {
    ...registryEnv(registryUrl),
    YAVIN_TEST_OPENVSX: base,
    YAVIN_TEST_OPENVSX_KEY: publicKey,
  };
  const running = await launch(env);
  const { page } = running;
  // What the window logs (the frame's console among it), printed if the test fails.
  const logs: string[] = [];
  let passed = false;
  page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`.slice(0, 600)));
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
    await view.getByRole("searchbox", { name: "Search extensions" }).fill("svg");
    const results = view.getByRole("region", { name: "Marketplace results" });
    const card = results.getByRole("group", { name: "SVG", exact: true }).first();
    await card.getByRole("button", { name: "Install SVG" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("option", { name: /^Install and allow/ }).click();
    await expect(dialog).toHaveCount(0);
    // A refusal names its reason: shown in the failure rather than a bare timeout.
    const refused = card.getByRole("alert");
    await page.waitForTimeout(3000);
    if (await refused.count()) {
      await refused.getByRole("group").click();
      throw new Error(`The install was refused: ${await refused.textContent()}`);
    }
    const installed = (await extensionsView(page))
      .getByRole("region", { name: "Installed extensions" })
      .getByRole("group", { name: "SVG", exact: true })
      .first();
    await expect(installed.getByTestId("extension-state")).toHaveText(/Enabled|Active/, {
      timeout: 30_000,
    });

    await page.getByTitle("Explorer (Ctrl+Shift+E)", { exact: true }).click();
    await page
      .getByRole("tree", { name: "Files" })
      .getByText("drawing.svg", { exact: true })
      .click();
    await expect(page.locator(".view-lines")).toContainText("yavin-probe-rect");
    await page.locator(".monaco-editor textarea").first().focus();

    // Its preview of the file being edited ("Preview SVG"): the command runs, but the extension
    // previews only documents whose language is `svg`, and Yavin keeps `.svg` as its own XML
    // (EXT-25: an extension adds languages, never changes one of Yavin's). Recorded, not required.
    await expect(page.locator("footer")).toContainText("XML");
    await palette(page, "Preview SVG");
    await page.waitForTimeout(5000);
    const single = await page.getByRole("tab", { name: /Svg Preview/i }).count();
    test.info().annotations.push({
      type: "Preview SVG",
      description: single
        ? "a panel opened"
        : "no panel: the document's language is xml, and the extension previews svg only",
    });

    // Its webview of every SVG in the workspace ("Preview All Svg"): its page, under Yavin's
    // sandbox, runs its script and asks the extension for the files by message. The extension
    // hears it and looks for them with workspace.findFiles, which Yavin does not provide: that is
    // where the feature stops (EXT-31 records it; it is not a webview API).
    await palette(page, "Preview All Svg");
    const tab = page.getByRole("tab", { name: /Preview All SVG/ });
    await expect(tab).toBeVisible({ timeout: 30_000 });
    const iframe = page.locator("iframe[data-webview]");
    await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
    await expect(iframe).toHaveAttribute(
      "src",
      /^https:\/\/yavin-webview\.invalid\/[0-9a-f]{32}\/index\.html\?/,
    );
    const frame = page.frameLocator("iframe[data-webview]");
    await expect(frame.locator("#__listview")).toHaveCount(1);
    // Its script ran (it logs as it asks)...
    await expect.poll(() => logs.some((line) => line.endsWith(": init update"))).toBe(true);
    // ...and its message reached the extension, whose handler then reached findFiles.
    await expect
      .poll(async () => (await extensionLog(page)).join("\n"), { timeout: 15_000 })
      .toContain("UnsupportedApi: workspace.findFiles is not supported by Yavin.");
    test.info().annotations.push({
      type: "Preview All Svg",
      description:
        "its page loads sandboxed and its message reaches the extension; the list stays empty: workspace.findFiles is unsupported",
    });
    // Closing its tab disposes the panel; asked again, the extension makes a new one.
    await tab.hover();
    await page.getByRole("button", { name: "Close Preview All SVG" }).click();
    await expect(iframe).toHaveCount(0);
    await palette(page, "Preview All Svg");
    await expect(frame.locator("#__listview")).toHaveCount(1, { timeout: 30_000 });
    passed = true;
  } finally {
    // On a failure: what the frame holds, the window's frames, and the extension's own log.
    if (!passed) {
      const frameHtml = await page
        .frameLocator("iframe[data-webview]")
        .locator("body")
        .innerHTML({ timeout: 3000 })
        .catch((error) => String(error));
      logs.push(
        `frame body: ${frameHtml.slice(0, 600)}`,
        `frames: ${page
          .frames()
          .map((frame) => frame.url())
          .join(" | ")}`,
        ...(await extensionLog(page).catch((error) => [`(no log: ${error})`])),
      );
      console.log(`window console:\n${logs.slice(-60).join("\n")}`);
    }
    await close(running);
  }
});
