/**
 * EXT-32: a real Open VSX extension's language server in the installed application -- Red Hat's
 * YAML, whose web build runs its server (yaml-language-server) in a Web Worker, which Yavin's host
 * runs as a worker of the extension's own (`worker.rs`). The package is the one Open VSX serves,
 * downloaded by the benchmark (not in the repository): this test runs only when
 * `YAVIN_E2E_YAML_VSIX` names it. A loopback mirror serves it, signed under a key this run makes
 * (as `webview.spec.ts`). The workspace has a JSON schema and a YAML file that names it
 * (`# yaml-language-server: $schema=./schema.json`): the server asks for the schema, which the
 * extension reads through Yavin (`workspace.fs`, the workspace only). The test requires the
 * schema's problems in the editor and the Problems view, completion and hover from it, and a fix
 * that clears its problem.
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
  registryEnv,
  storedZip,
  trust,
} from "./harness";

const VSIX = process.env.YAVIN_E2E_YAML_VSIX ?? "";
const ROOT = join(tmpdir(), `yavin-e2e-yaml-${process.pid}`);
const WORK = join(ROOT, "work");

test.describe.configure({ mode: "serial" });
test.skip(
  !INSTALL,
  "Run through scripts/e2e-real-host.mjs, which builds and extracts the installer.",
);
test.skip(
  !VSIX || !existsSync(VSIX),
  "Set YAVIN_E2E_YAML_VSIX to redhat.vscode-yaml 2.1.2026102008's package, downloaded from Open VSX.",
);

const NS = "redhat";
const NAME = "vscode-yaml";
const VERSION = "2.1.2026102008";
const SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {
    name: { type: "string", description: "The probe's name." },
    replicas: { type: "integer", minimum: 1, description: "How many copies run." },
    mode: { enum: ["fast", "safe"], description: "How it runs." },
  },
  required: ["name"],
  additionalProperties: false,
};
const DOCUMENT =
  "# yaml-language-server: $schema=./schema.json\nname: probe\nreplicas: zero\nextra: 1\n\n";

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
      displayName: "YAML",
      description: "YAML Language Support by Red Hat",
      downloadCount: 1,
      verified: false,
      deprecated: false,
      timestamp: "2026-10-20T00:00:00.000000Z",
      files: {
        download: `${file}.vsix`,
        sha256: `${file}.sha256`,
        signature: `${file}.sigzip`,
        publicKey: `${base}api/-/public-key/yavin-test`,
      },
    };
    const record = {
      ...entry,
      namespaceDisplayName: "Red Hat",
      license: "MIT",
      engines: { vscode: "^1.82.0" },
      categories: ["Programming Languages", "Linters"],
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
  writeFileSync(join(WORK, "schema.json"), JSON.stringify(SCHEMA, null, 2));
  writeFileSync(join(WORK, "probe.yaml"), DOCUMENT);
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
  await output.getByLabel("Output channel").selectOption({ label: "Extension: YAML" });
  return output.getByRole("listitem").allTextContents();
}

/** The first occurrence of `word` in the editor, as a token. */
const word = (page: Page, text: string) =>
  page
    .locator("[data-editor=monaco] .view-line span span", { hasText: new RegExp(`^${text}$`) })
    .first();

test("EXT-32 YAML (Open VSX): its language server, in a worker, checks the file against its schema, completes and hovers from it, and a fix clears its problem", async () => {
  const env = {
    ...registryEnv(registryUrl),
    YAVIN_TEST_OPENVSX: base,
    YAVIN_TEST_OPENVSX_KEY: publicKey,
  };
  const running = await launch(env);
  const { page } = running;
  let passed = false;
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
    await view.getByRole("searchbox", { name: "Search extensions" }).fill("yaml");
    const results = view.getByRole("region", { name: "Marketplace results" });
    const card = results.getByRole("group", { name: "YAML", exact: true }).first();
    await card.getByRole("button", { name: "Install YAML" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("option", { name: /^Install and allow/ }).click();
    await expect(dialog).toHaveCount(0);
    const installed = (await extensionsView(page))
      .getByRole("region", { name: "Installed extensions" })
      .getByRole("group", { name: "YAML", exact: true })
      .first();
    await expect(installed.getByTestId("extension-state")).toHaveText(/Enabled|Active/, {
      timeout: 30_000,
    });

    // The file opened: the extension activates for YAML and starts its server in a worker.
    await page.getByTitle("Explorer (Ctrl+Shift+E)", { exact: true }).click();
    await page
      .getByRole("tree", { name: "Files" })
      .getByText("probe.yaml", { exact: true })
      .click();
    await expect(page.locator(".view-lines")).toContainText("replicas: zero");

    // The schema's two problems: underlined in the editor, and in the Problems view.
    const errors = page.locator("[data-editor=monaco] .squiggly-error");
    await expect(errors).toHaveCount(2, { timeout: 30_000 });
    await page.getByTitle("2 errors, 0 warnings", { exact: true }).click({ timeout: 15_000 });
    const problems = page.getByRole("region", { name: "Problems" });
    await expect(problems).toContainText('Incorrect type. Expected "integer".');
    await expect(problems).toContainText("Property extra is not allowed.");

    // Hover over a key: the schema's description of it.
    await word(page, "replicas").hover({ timeout: 15_000 });
    await expect(
      page.locator(".monaco-hover").filter({ hasText: "How many copies run." }),
    ).toBeVisible({
      timeout: 15_000,
    });

    // Completion on the empty last line: the one property the schema still allows.
    await page.locator("[data-editor=monaco] .view-lines").click({ timeout: 15_000 });
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Control+Space");
    const suggest = page.locator(".suggest-widget");
    await expect(suggest).toBeVisible({ timeout: 15_000 });
    await expect(suggest).toContainText("mode");
    await page.keyboard.press("Escape");

    // A fix: the type problem goes (the server hears the change); the other stays.
    await word(page, "zero").dblclick({ timeout: 15_000 });
    await page.keyboard.type("3");
    await expect(page.locator(".view-lines")).toContainText("replicas: 3");
    await expect(errors).toHaveCount(1, { timeout: 15_000 });
    await expect(problems).not.toContainText('Incorrect type. Expected "integer".');
    await expect(problems).toContainText("Property extra is not allowed.");
    // Saved (an ordinary save, the language server running): the file is the fixed one.
    await page.locator("[data-editor=monaco] textarea").first().focus();
    await page.keyboard.press("Control+s");
    await expect
      .poll(() => readFileSync(join(WORK, "probe.yaml"), "utf8"))
      .toContain("replicas: 3");
    passed = true;
  } finally {
    if (!passed) {
      const logs = await extensionLog(page).catch((error) => [`(no log: ${error})`]);
      console.log(`the extension's log:\n${logs.slice(-60).join("\n")}`);
    }
    await close(running);
  }
});
