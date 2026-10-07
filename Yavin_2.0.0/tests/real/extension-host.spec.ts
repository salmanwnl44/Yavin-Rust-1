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
import { cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  alert,
  alive,
  clearProfile,
  close,
  CONFIG,
  DATA,
  extensionsView,
  host,
  hostProcesses,
  INSTALL,
  launch,
  message,
  palette,
  profileReleased,
  showDiagnostics,
  trust,
} from "./harness";

const ROOT = join(tmpdir(), `yavin-e2e-workspaces-${process.pid}`);
const A = join(ROOT, "alpha");
const B = join(ROOT, "beta");
const SAMPLE = new URL("../../extensions/samples/hello-world/", import.meta.url);

test.describe.configure({ mode: "serial" });
test.skip(
  !INSTALL,
  "Run through scripts/e2e-real-host.mjs, which builds and extracts the installer.",
);

/** A fresh test profile: two recent folders (A in front), the sample and a broken extension installed. */
async function prepareProfile() {
  await clearProfile(ROOT);
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

test.beforeEach(async () => prepareProfile());
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
    await showDiagnostics(page, view);
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
    await showDiagnostics(page, view);
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
