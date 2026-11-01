/**
 * EXT-27: a VS Code extension in the installed application, end to end. A loopback Open VSX
 * mirror serves a VS Code package, signed under a key this run makes; the test build pins the
 * mirror and the key from its environment (`YAVIN_TEST_OPENVSX`, `YAVIN_TEST_OPENVSX_KEY`, read
 * only by `test-registry` builds, as `YAVIN_TEST_REGISTRY` is). From there everything is real:
 * Open VSX search and record, the download, its SHA-256, the Ed25519 signature, unpacking, the
 * VS Code adapter, the inventory, consent, the sandboxed host, the compatibility layer -- and the
 * window: its status bar, its edit path, the grammar worker under the application's CSP, and the
 * window's real focus, changed through the OS (another application's window, minimize, restore).
 */
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  CONFIG,
  clearProfile,
  close,
  emptyRegistry,
  extensionsView,
  foreground,
  hostProcesses,
  INSTALL,
  launch,
  otherApplication,
  palette,
  registryEnv,
  storedZip,
  trust,
} from "./harness";

const ROOT = join(tmpdir(), `yavin-e2e-vscode-${process.pid}`);
const WORK = join(ROOT, "work");
test.describe.configure({ mode: "serial" });
test.skip(
  !INSTALL,
  "Run through scripts/e2e-real-host.mjs, which builds and extracts the installer.",
);

const NS = "acme";
const NAME = "packaged-probe";
const VERSION = "1.0.0";
const MAIN = `
const vscode = require("vscode");
exports.activate = (context) => {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  const show = () => { item.text = "Probe " + (vscode.window.state.focused ? "focused" : "unfocused"); };
  show();
  item.show();
  // EXT-28: the runtime's globals, in the installed host (URL, Intl.Collator, crypto).
  const runtime = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  const sorted = ["x10", "x9"].sort(new Intl.Collator(undefined, { numeric: true }).compare);
  runtime.text = "Runtime " + new URL("../b?x=1", "https://e.com/a/c").href + " " + sorted.join(",") + " " + crypto.getRandomValues(new Uint8Array(4)).length;
  runtime.show();
  context.subscriptions.push(
    item,
    vscode.window.onDidChangeWindowState(show),
    vscode.commands.registerTextEditorCommand("pkprobe.upper", (editor, edit) => {
      const line = editor.document.lineAt(0);
      edit.replace(line.range, line.text.toUpperCase());
    }),
  );
};
`;
const PACKAGE_JSON = {
  publisher: NS,
  name: NAME,
  displayName: "Packaged Probe",
  description: "A VS Code extension for Yavin's packaged tests",
  version: VERSION,
  engines: { vscode: "^1.80.0" },
  main: "./out/main.js",
  activationEvents: ["onStartupFinished"],
  categories: ["Other"],
  contributes: {
    commands: [
      { command: "pkprobe.upper", title: "Upper-case the first line", category: "Packaged Probe" },
    ],
    languages: [
      {
        id: "probelang",
        extensions: [".probe"],
        aliases: ["Probe Lang"],
        configuration: "./probe.configuration.json",
      },
    ],
    grammars: [
      { language: "probelang", scopeName: "source.probe", path: "./probe.tmLanguage.json" },
    ],
  },
};
const GRAMMAR = {
  scopeName: "source.probe",
  patterns: [
    { match: "#.*$", name: "comment.line.number-sign.probe" },
    { match: "\\bline\\b", name: "keyword.control.probe" },
  ],
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
      ["extension/probe.tmLanguage.json", JSON.stringify(GRAMMAR)],
      ["extension/probe.configuration.json", JSON.stringify({ comments: { lineComment: "#" } })],
    ]),
  );
}

/** The mirror: Open VSX's API, as far as Yavin uses it, for one package signed under `key`. */
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
      displayName: "Packaged Probe",
      description: "A VS Code extension for Yavin's packaged tests",
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
    // As open-vsx.org's file host serves many: an octet stream (EXT-25 D1).
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
  writeFileSync(join(WORK, "demo.probe"), "line one # note\nplain words\n");
  mkdirSync(CONFIG, { recursive: true });
  writeFileSync(
    join(CONFIG, "session.json"),
    JSON.stringify({ version: 1, folders: [WORK], workspaces: [] }),
  );
});

test("a signed VS Code package from an Open VSX mirror: installed through the real path, run in the sandbox, its status bar, edit, grammar and the window's focus", async () => {
  const env = {
    ...registryEnv(registryUrl),
    YAVIN_TEST_OPENVSX: base,
    YAVIN_TEST_OPENVSX_KEY: publicKey,
  };
  const running = await launch(env);
  const { app, page } = running;
  try {
    await trust(running.page, true);
    // Browse the mirror (the user's settings), then reload into them.
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
    await view.getByRole("searchbox", { name: "Search extensions" }).fill("probe");
    const results = view.getByRole("region", { name: "Marketplace results" });
    const card = results.getByRole("group", { name: "Packaged Probe", exact: true }).first();
    await expect(card).toBeVisible();
    await expect(card.getByRole("button", { name: "Install Packaged Probe" })).toHaveAttribute(
      "title",
      /^Not verified: a VS Code extension\./,
    );
    await card.getByRole("button", { name: "Install Packaged Probe" }).click();
    // It asks for what the layer can use; the user allows it (EXT-07).
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("asks to:");
    await dialog.getByRole("option", { name: /^Install and allow/ }).click();
    await expect(dialog).toHaveCount(0);
    const installed = view
      .getByRole("region", { name: "Installed extensions" })
      .getByRole("group", { name: "Packaged Probe", exact: true })
      .first();
    await expect(installed.getByTestId("extension-state")).toHaveText(/Enabled|Active/, {
      timeout: 30_000,
    });
    expect(mirror.requests).toContain(
      `/api/${NS}/${NAME}/${VERSION}/file/${NS}.${NAME}-${VERSION}.sigzip`,
    );
    // Activated at startup in the real host: its status bar item says the window's real focus.
    await expect.poll(() => hostProcesses(app.pid!).length, { timeout: 30_000 }).toBe(1);
    // Its focus item (it has a second one, for the runtime).
    const item = page.locator(`[data-extension-status^="${NS}.${NAME}#status#"]`, {
      hasText: /^Probe /,
    });
    await expect(item).toHaveText(/^Probe (focused|unfocused)$/, { timeout: 30_000 });
    // The EXT-28 runtime in the installed host: a URL resolved, a numeric sort, random bytes.
    await expect(
      page.locator(`[data-extension-status^="${NS}.${NAME}#status#"]`, { hasText: "Runtime" }),
    ).toHaveText("Runtime https://e.com/b?x=1 x9,x10 4");
    // As the OS says (the foreground window: EXT-27's `window_focused`).
    const nativeFocus = () =>
      page.evaluate(() =>
        (
          window as unknown as {
            __TAURI_INTERNALS__: { invoke(cmd: string, args: unknown): Promise<boolean> };
          }
        ).__TAURI_INTERNALS__.invoke("window_focused", {}),
      );
    await expect(item).toHaveText((await nativeFocus()) ? "Probe focused" : "Probe unfocused");
    // Its language and grammar, in the packaged window (the worker under its CSP).
    await page.getByTitle("Explorer (Ctrl+Shift+E)", { exact: true }).click();
    await page
      .getByRole("tree", { name: "Files" })
      .getByText("demo.probe", { exact: true })
      .click();
    await expect(page.locator("footer")).toContainText("Probe Lang");
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const first = document.querySelector(".view-line");
            const spans = first ? [...first.querySelectorAll(":scope > span > span")] : [];
            const of = (text: string) =>
              spans.find((s) => (s.textContent ?? "").replace(/ /g, " ").includes(text))?.className;
            const keyword = of("line");
            const comment = of("# note");
            return !!keyword && !!comment && keyword !== comment;
          }),
        { timeout: 30_000 },
      )
      .toBe(true);
    // Its command edits the document through the application's own window.
    await palette(page, "Packaged Probe: Upper-case the first line");
    await expect(page.locator(".view-lines")).toContainText("LINE ONE # NOTE");
    // An ordinary unsaved change: saved, it is the file's.
    await page.locator(".monaco-editor textarea").first().focus();
    await page.keyboard.press("Control+s");
    await expect
      .poll(() => readFileSync(join(WORK, "demo.probe"), "utf8"))
      .toBe("LINE ONE # NOTE\nplain words\n");
    // The window's real focus, changed through the OS as a user changes it: another
    // application takes the foreground, Yavin gets it back, is minimized, and restored.
    // Launched behind the test's runner, the window is not in front: its first activation counts.
    await expect.poll(() => foreground(app.pid!), { timeout: 15_000 }).toBe(true);
    const other = otherApplication();
    try {
      await expect(item).toHaveText("Probe focused");
      await expect.poll(nativeFocus).toBe(true);
      await expect.poll(() => foreground(other.pid!), { timeout: 15_000 }).toBe(true);
      await expect(item).toHaveText("Probe unfocused");
      await expect.poll(() => foreground(app.pid!), { timeout: 15_000 }).toBe(true);
      await expect(item).toHaveText("Probe focused");
      await expect.poll(nativeFocus).toBe(true);
      await page.getByTitle("Minimize", { exact: true }).click();
      await expect(item).toHaveText("Probe unfocused");
      await expect.poll(nativeFocus).toBe(false);
      await expect.poll(() => foreground(app.pid!, true), { timeout: 15_000 }).toBe(true);
      await expect(item).toHaveText("Probe focused");
    } finally {
      other.kill();
    }
    await close(running);
  } finally {
    if (app.exitCode === null) app.kill();
  }
});
