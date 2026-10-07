import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createSettingsRegistry } from "../../settings/settings.ts";
import type { WorkspaceId } from "../../terminalProtocol.ts";
import { ExtensionError } from "../errors.ts";
import { createInProcessTransport } from "../inProcessHost.ts";
import { createExtensionHostManager } from "../manager.ts";
import { createExtensionRegistry } from "../registry.ts";
import { createExtensionStorage, globalStorageKey, workspaceStorageKey } from "../storage.ts";
import { createDecorationStore, createProviderRegistry, type ExtensionWindow } from "../window.ts";
import { FIXTURE_PACKAGES, fixtureIndex } from "./fixtures.ts";
import { readIndex } from "./indexProvider.ts";
import { createExtensionInstaller, type InstallerNative } from "./installer.ts";
import { createLocalMarketplaceProvider } from "./localProvider.ts";
import { createSearchController } from "./search.ts";
import { createMarketplaceService } from "./service.ts";
import {
  MarketplaceError,
  marketplaceErrorOf,
  type SearchRequest,
  type SearchResult,
} from "./types.ts";
import { compareVersions, compatibilityOf, latestCompatible } from "./versions.ts";

const BOOTSTRAP = readFileSync(
  new URL("../../../../src-tauri/crates/ide-plugin-host/src/bootstrap.js", import.meta.url),
  "utf8",
);
const REAL_INDEX = readFileSync(
  new URL("../../../../registry/index.json", import.meta.url),
  "utf8",
);
const A = "file://c:/work" as WorkspaceId;
const B = "file://c:/other" as WorkspaceId;
const ROOT = "C:/data/extensions";

function memoryStorage(seed: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(seed));
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, String(value)),
  };
}
const settle = async (times = 10) => {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
async function until(check: () => boolean, what = "condition") {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(`timed out waiting for ${what}`);
}
const window: ExtensionWindow = {
  documents: { all: () => [], get: () => null, text: () => null, subscribe: () => () => {} },
  editor: {
    active: () => null,
    onActive: () => () => {},
    openLocation: async () => {},
    setSelection: () => false,
    revealRange: () => false,
  },
  readFile: async () => {
    throw new Error("no files");
  },
};

/** The whole chain, with only the native side (download, unpack, folders) faked. */
function setup(options: { trusted?: boolean; failMarketplace?: () => string | null } = {}) {
  const storage = memoryStorage();
  const settings = createSettingsRegistry([], storage);
  const registry = createExtensionRegistry({ settings, storage });
  const extensionStorage = createExtensionStorage(storage);
  const providers = createProviderRegistry();
  const codes: Record<string, string> = {};
  const host = createInProcessTransport({ bootstrap: BOOTSTRAP, code: (id) => codes[id] ?? null });
  const provider = createLocalMarketplaceProvider({ fail: options.failMarketplace });
  const service = createMarketplaceService(provider, { platform: "win32" });
  /** What is "on disk": id → folder and code; staged packages by token. */
  const disk = new Map<string, { manifest: Record<string, unknown>; code?: string }>();
  const staged = new Map<
    string,
    { id: string; manifest: Record<string, unknown>; code?: string }
  >();
  const aside = new Map<string, { manifest: Record<string, unknown>; code?: string }>();
  const calls: string[] = [];
  let failCommit = false;
  let token = 0;
  const io: InstallerNative = {
    async stage(source, id, version) {
      calls.push(`stage ${id} ${version}`);
      if (source.kind !== "file" || !source.path.startsWith("fixture:"))
        throw new Error("InvalidRequest: test packages only");
      const pkg = FIXTURE_PACKAGES[source.path.slice("fixture:".length)];
      if (!pkg || pkg.broken === "missing")
        throw new Error(`PackageMissing: ${source.path} does not exist.`);
      if (pkg.broken === "unsafe")
        throw new Error('UnsafePackage: "../escape.txt" leaves the extension ("..")');
      const t = `t${++token}`;
      staged.set(t, { id, manifest: pkg.manifest, code: pkg.code });
      return { token: t, manifest: JSON.stringify(pkg.manifest) };
    },
    async commit(t, id) {
      calls.push(`commit ${id}`);
      if (failCommit)
        throw new Error(
          "InstallFailed: the installed version could not be moved aside; is it in use?",
        );
      const one = staged.get(t)!;
      staged.delete(t);
      const previous = disk.get(id);
      if (previous) aside.set(t, previous);
      disk.set(id, one);
      if (one.code) codes[id] = one.code;
      else delete codes[id];
      return { folder: `${ROOT}/${id}`, replaced: !!previous };
    },
    async finish(t, id, keep) {
      calls.push(`finish ${id} ${keep}`);
      const previous = aside.get(t);
      aside.delete(t);
      if (!keep) {
        if (previous) {
          disk.set(id, previous);
          if (previous.code) codes[id] = previous.code;
        } else disk.delete(id);
      }
    },
    async discard(t) {
      calls.push(`discard ${t}`);
      staged.delete(t);
    },
    async uninstall(id) {
      calls.push(`uninstall ${id}`);
      if (!disk.delete(id))
        throw new Error(`UnknownExtension: ${id} is not installed in Yavin's extensions folder.`);
      delete codes[id];
      return `${ROOT}/${id}`;
    },
  };
  let rediscovers = 0;
  const rediscover = async () => {
    rediscovers++;
    for (const one of registry.getSnapshot().extensions) registry.remove(one.id);
    for (const [id, one] of disk)
      registry.add(one.manifest, { kind: "folder", path: `${ROOT}/${id}` }, `${ROOT}/${id}`);
  };
  const installer = createExtensionInstaller({
    service,
    registry,
    storage: extensionStorage,
    root: () => ROOT,
    rediscover,
    native: io,
  });
  const notes: string[] = [];
  let trusted = options.trusted ?? true;
  const manager = (workspace: WorkspaceId = A, generation = 1) =>
    createExtensionHostManager({
      registry,
      settings,
      storage: extensionStorage,
      workspace,
      folder: workspace === A ? "C:/work" : "C:/other",
      workspaceGeneration: generation,
      transport: host.transport,
      trusted: async () => trusted,
      window,
      decorations: createDecorationStore(),
      providers,
      notify: (_level, _id, message) => notes.push(message),
      channel: () => ({ appendLine: () => {} }),
      timeouts: { command: 2000, activate: 2000 },
    });
  return {
    storage,
    registry,
    extensionStorage,
    service,
    provider,
    installer,
    host,
    disk,
    calls,
    notes,
    manager,
    providers,
    failCommit: (value: boolean) => (failCommit = value),
    setTrusted: (value: boolean) => (trusted = value),
    rediscovers: () => rediscovers,
  };
}

// --- The registry index ------------------------------------------------------------------------

test("Yavin's published registry index reads cleanly: every extension, version and checksum", () => {
  const index = readIndex(REAL_INDEX);
  assert.deepEqual(index.dropped, []);
  assert.deepEqual([...index.entries.keys()].sort(), [
    "yavin-samples.hello-world",
    "yavin.todo-highlighter",
    "yavin.word-count",
  ]);
  const hello = index.entries.get("yavin-samples.hello-world")!;
  assert.deepEqual(
    hello.extension.versions.map((v) => v.version),
    ["2.1.0", "2.0.0"],
    "newest first",
  );
  assert.equal(hello.extension.version, "2.1.0");
  assert.equal(hello.extension.extensionKind, "code");
  assert.ok(hello.extension.hasIcon && hello.extension.hasReadme && hello.extension.hasChangelog);
  assert.ok(
    hello.extension.contributes!.commands.some((c) => c.title === "Hello World: Say Hello"),
  );
  assert.equal(hello.extension.downloads, undefined, "no invented metadata");
  assert.equal(hello.extension.rating, undefined);
  assert.deepEqual(index.recommended, ["yavin.todo-highlighter", "yavin.word-count"]);
});

test("an index is read strictly: bad entries are dropped with why; another schema is refused whole", () => {
  const good = fixtureIndex();
  const bad = {
    ...good,
    extensions: [
      ...good.extensions,
      { ...good.extensions[1], id: "Not An Id" },
      { ...good.extensions[1], id: "acme.mismatch" },
      { ...good.extensions[1], versions: [{ ...good.extensions[1].versions[0], sha256: "abc" }] },
      {
        ...good.extensions[1],
        id: "acme.escape",
        name: "escape",
        versions: [{ ...good.extensions[1].versions[0], package: "../../etc/passwd" }],
      },
      { ...good.extensions[1], id: "acme.python-tools" },
    ],
  };
  const read = readIndex(JSON.stringify(bad));
  assert.equal(read.entries.size, good.extensions.length);
  // Five entries; the one with a bad checksum is reported twice (its version, then the entry
  // left with no installable version).
  assert.equal(read.dropped.length, 6);
  assert.ok(read.dropped.some((d) => /publisher\.name/.test(d)));
  assert.ok(read.dropped.some((d) => /twice/.test(d)));
  assert.throws(
    () => readIndex(JSON.stringify({ ...good, schema: 2 })),
    (e: MarketplaceError) => e.code === "InvalidResponse" && /cannot read/.test(e.message),
  );
  assert.throws(
    () => readIndex("<html>"),
    (e: MarketplaceError) => e.code === "InvalidResponse",
  );
});

// --- Provider: search, filters, pagination, recommendations, updates, caching ---------------------

test("search: words, category, compatible-only, ranking, pagination", async () => {
  const provider = createLocalMarketplaceProvider();
  const page = (request: Partial<SearchRequest>) =>
    provider.search({ query: "", page: 0, pageSize: 50, ...request });
  assert.deepEqual(
    (await page({ query: "docker" })).items.map((e) => e.id),
    ["acme.docker-tools"],
  );
  assert.deepEqual(
    (await page({ query: "python env" })).items.map((e) => e.id),
    ["acme.python-tools"],
  );
  assert.equal((await page({ query: "nothing-like-this" })).total, 0);
  assert.deepEqual(
    (await page({ category: "themes" })).items.map((e) => e.id),
    ["acme.midnight-theme"],
  );
  const all = await page({ query: "" });
  const compatible = await page({ query: "", compatibleWith: "2.0.0" });
  assert.ok(all.items.some((e) => e.id === "acme.future-tools"));
  assert.ok(!compatible.items.some((e) => e.id === "acme.future-tools"));
  const first = await provider.search({ query: "", page: 0, pageSize: 4 });
  const second = await provider.search({ query: "", page: 1, pageSize: 4 });
  assert.equal(first.items.length, 4);
  assert.equal(first.total, all.total);
  assert.equal(
    new Set([...first.items, ...second.items].map((e) => e.id)).size,
    8,
    "pages do not overlap",
  );
});

test("recommendations skip what is installed; updates compare versions; documents and icons", async () => {
  const provider = createLocalMarketplaceProvider();
  assert.deepEqual(
    (await provider.getRecommendations({ installed: [] })).map((e) => e.id),
    ["acme.docker-tools", "acme.python-tools"],
  );
  assert.deepEqual(
    (await provider.getRecommendations({ installed: ["acme.docker-tools"] })).map((e) => e.id),
    ["acme.python-tools"],
  );
  assert.deepEqual(
    await provider.checkForUpdates([
      { id: "acme.updater", version: "1.0.0" },
      { id: "acme.quiet", version: "1.0.0" },
      { id: "acme.unknown", version: "1.0.0" },
    ]),
    [{ id: "acme.updater", installed: "1.0.0", available: "1.1.0" }],
  );
  assert.match((await provider.getDocument("acme.verbose", "readme"))!, /Paragraph 60/);
  assert.match((await provider.getIcon("acme.python-tools"))!, /^data:image\/png;base64,/);
  assert.equal(await provider.getIcon("acme.no-icon"), null);
  await assert.rejects(
    provider.getExtension("acme.nope"),
    (e: MarketplaceError) => e.code === "NotFound",
  );
  await assert.rejects(
    provider.download("acme.future-tools", "3.0.0"),
    (e: MarketplaceError) =>
      e.code === "Incompatible" && /requires Yavin API 3\.0\.0/.test(e.message),
  );
});

test("the index is cached with a TTL, by provider, location and schema; refresh drops it", async () => {
  let now = 1000;
  let loads = 0;
  const storage = memoryStorage();
  const make = () =>
    createLocalMarketplaceProvider({
      cache: storage,
      ttlMs: 60_000,
      now: () => now,
      fail: () => (loads++, null),
    });
  const one = make();
  await one.getCategories();
  await one.search({ query: "x", page: 0, pageSize: 5 });
  assert.equal(loads, 1, "one fetch for both");
  // Another provider object (a new window) uses the stored copy within the TTL.
  await make().getCategories();
  assert.equal(loads, 1);
  now += 61_000;
  await one.getCategories();
  assert.equal(loads, 2, "expired");
  one.refresh();
  await one.getCategories();
  assert.equal(loads, 3, "refreshed");
  const key = [...Array(storage.length).keys()]
    .map((i) => storage.key(i)!)
    .find((k) => k.startsWith("yavin.marketplace.index:"))!;
  storage.setItem(key, JSON.stringify({ version: 1, schema: 99, at: now, text: "{}" }));
  await make().getCategories();
  assert.equal(loads, 4, "a cache of another schema is not used");
});

test("offline: provider failures become one typed error the UI can show and retry", async () => {
  let offline = true;
  const service = createMarketplaceService(
    createLocalMarketplaceProvider({
      fail: () =>
        offline
          ? "MarketplaceUnavailable: the marketplace could not be reached (dns error)."
          : null,
    }),
  );
  await assert.rejects(
    service.search({ query: "x", page: 0, pageSize: 5 }),
    (e: MarketplaceError) =>
      e.code === "Unavailable" &&
      e.message === "The extension marketplace is unavailable." &&
      /dns error/.test(e.detail!),
  );
  await assert.rejects(service.checkForUpdates([{ id: "acme.updater", version: "1.0.0" }]));
  assert.equal(service.getSnapshot().updateError, "The extension marketplace is unavailable.");
  offline = false;
  assert.equal(
    (await service.checkForUpdates([{ id: "acme.updater", version: "1.0.0" }])).length,
    1,
  );
  assert.equal(service.getSnapshot().updates["acme.updater"].available, "1.1.0");
});

test("native errors map to user messages; the technical detail is kept apart", () => {
  const cases: [string, string, RegExp][] = [
    [
      "IntegrityFailed: the package's SHA-256 is 00, but the registry says 11.",
      "IntegrityFailed",
      /did not match its published checksum/,
    ],
    ['UnsafePackage: "../x" leaves the extension', "UnsafePackage", /unsafe files/],
    ["UnexpectedRedirect: redirected to another host (evil.com)", "InvalidResponse", /untrusted/],
    ["InsecureTransport: not HTTPS", "Unavailable", /securely/],
    ["ManifestMismatch: the package is acme.x", "ManifestMismatch", /not the extension it claims/],
    ["something odd", "InstallFailed", /something went wrong/],
  ];
  for (const [native, code, message] of cases) {
    const error = marketplaceErrorOf(new Error(native), "InstallFailed", "Python Tools");
    assert.equal(error.code, code, native);
    assert.match(error.message, message, native);
    assert.ok(!/at .*\.ts:\d+/.test(error.message), "no stack in the message");
  }
});

test("versions and compatibility: ordering, engine ranges, platforms, the newest compatible", () => {
  assert.ok(compareVersions("1.10.0", "1.9.9") > 0);
  assert.ok(compareVersions("2.0.0-beta.1", "2.0.0") < 0);
  assert.equal(compareVersions("1.0.0+build", "1.0.0"), 0);
  assert.deepEqual(
    compatibilityOf({ version: "1.0.0", engines: { yavin: "^2.0.0" } }, { api: "2.0.0" }),
    { compatible: true, reasons: [] },
  );
  assert.match(
    compatibilityOf({ version: "1.0.0", engines: { yavin: "^3.0.0" } }, { api: "2.0.0" })
      .reasons[0],
    /requires Yavin API 3\.0\.0; this Yavin provides 2\.0\.0/,
  );
  assert.match(compatibilityOf({ version: "1.0.0", engines: {} }).reasons[0], /does not say/);
  assert.match(
    compatibilityOf(
      { version: "1.0.0", engines: { yavin: "^2.0.0" }, platforms: ["darwin"] },
      { platform: "win32" },
    ).reasons[0],
    /not available for this platform/,
  );
  const extension = {
    versions: [
      { version: "3.0.0", engines: { yavin: "^3.0.0" } },
      { version: "2.5.0", engines: { yavin: "^2.0.0" } },
      { version: "2.4.0", engines: { yavin: "^2.0.0" } },
    ],
  };
  assert.equal(latestCompatible(extension, { api: "2.0.0", platform: "win32" })?.version, "2.5.0");
});

// --- Search controller ----------------------------------------------------------------------------

test("search is debounced, cancels stale requests, and never shows an older answer", async () => {
  const asked: string[] = [];
  const aborted: string[] = [];
  const run = (request: SearchRequest, signal: AbortSignal) =>
    new Promise<SearchResult>((resolve) => {
      asked.push(request.query);
      signal.addEventListener("abort", () => aborted.push(request.query));
      // "python" answers late, after "python debugger".
      setTimeout(
        () => resolve({ items: [{ id: request.query } as never], total: 1, page: 0, pageSize: 20 }),
        request.query === "python" ? 60 : 5,
      );
    });
  const search = createSearchController(run, { debounceMs: 20 });
  for (const text of ["p", "py", "pyt", "python"]) search.setText(text);
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(asked, ["python"], "one request after typing stops");
  assert.equal(search.getSnapshot().status, "loading");
  search.setText("python debugger");
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(asked, ["python", "python debugger"]);
  assert.deepEqual(aborted, ["python"], "the stale request is aborted");
  assert.deepEqual(
    search.getSnapshot().items.map((i) => i.id),
    ["python debugger"],
    "the stale answer never shows",
  );
  search.clear();
  assert.equal(search.getSnapshot().status, "idle");
  search.dispose();
});

test("search: empty results, errors with retry, pagination, filters run at once", async () => {
  let fail = true;
  const run = async (request: SearchRequest): Promise<SearchResult> => {
    if (fail)
      throw new MarketplaceError("Unavailable", "The extension marketplace is unavailable.");
    const all = Array.from({ length: 45 }, (_, i) => ({ id: `e${i}` }) as never);
    const items =
      request.query === "none"
        ? []
        : all.slice(request.page * request.pageSize, (request.page + 1) * request.pageSize);
    return {
      items,
      total: request.query === "none" ? 0 : 45,
      page: request.page,
      pageSize: request.pageSize,
    };
  };
  const search = createSearchController(run, { debounceMs: 1, pageSize: 20 });
  search.setText("x");
  await until(() => search.getSnapshot().status === "error", "error");
  assert.equal(search.getSnapshot().error!.message, "The extension marketplace is unavailable.");
  fail = false;
  search.retry();
  await until(() => search.getSnapshot().status === "loaded", "retried");
  assert.equal(search.getSnapshot().items.length, 20);
  search.loadMore();
  await until(() => search.getSnapshot().items.length === 40, "page 2");
  search.loadMore();
  await until(() => search.getSnapshot().items.length === 45, "page 3");
  search.loadMore(); // nothing more
  assert.equal(search.getSnapshot().pages, 3);
  search.setText("none");
  await until(
    () => search.getSnapshot().status === "loaded" && search.getSnapshot().total === 0,
    "empty",
  );
  search.setFilters({ category: "themes" });
  assert.equal(search.getSnapshot().status, "loading", "filters do not wait for the debounce");
  search.dispose();
});

// --- Installer: install, update, rollback, uninstall, with the real host ----------------------------

test("install: package → validation → folder → registry → the extension runs in the host, lazily", async () => {
  const t = setup();
  const m = t.manager();
  const installed = await t.installer.install("acme.python-tools");
  assert.ok("manifest" in installed);
  assert.equal(t.registry.get("acme.python-tools")?.manifest.version, "1.2.0");
  assert.deepEqual(t.calls, [
    "stage acme.python-tools 1.2.0",
    "commit acme.python-tools",
    "finish acme.python-tools true",
  ]);
  assert.equal(t.host.started(), 0, "installing runs no extension code");
  assert.equal(await m.executeCommand("acme.python-tools.check"), "Python Tools: environment OK");
  assert.equal(t.host.started(), 1);
  assert.deepEqual(t.installer.getSnapshot().operations, {});
  await m.dispose();
});

test("an incompatible, broken or missing package is refused and nothing changes", async () => {
  const t = setup();
  await assert.rejects(
    t.installer.install("acme.future-tools"),
    (e: MarketplaceError) =>
      e.code === "Incompatible" && /requires Yavin API 3\.0\.0/.test(e.message),
  );
  assert.ok(
    !t.calls.some((c) => c.includes("future-tools")),
    "an incompatible package is never downloaded",
  );
  await assert.rejects(
    t.installer.install("acme.broken-package"),
    (e: MarketplaceError) =>
      e.code === "UnsafePackage" &&
      e.message === "Broken Package contains unsafe files; it was not installed.",
  );
  await assert.rejects(
    t.installer.install("acme.missing-package"),
    (e: MarketplaceError) => e.code === "PackageMissing",
  );
  await assert.rejects(
    t.installer.install("acme.nope"),
    (e: MarketplaceError) => e.code === "NotFound",
  );
  assert.equal(t.registry.getSnapshot().extensions.length, 0);
  assert.equal(t.disk.size, 0);
  assert.equal(t.installer.getSnapshot().failures["acme.broken-package"].code, "UnsafePackage");
});

test("a package whose manifest is not the extension or version asked for is discarded", async () => {
  const t = setup();
  const original = FIXTURE_PACKAGES["packages/acme.quiet-1.0.0.yvx"].manifest;
  FIXTURE_PACKAGES["packages/acme.quiet-1.0.0.yvx"].manifest = { ...original, version: "9.9.9" };
  try {
    await assert.rejects(
      t.installer.install("acme.quiet"),
      (e: MarketplaceError) =>
        e.code === "ManifestMismatch" && /version 9\.9\.9, not 1\.0\.0/.test(e.detail!),
    );
    assert.ok(t.calls.some((c) => c.startsWith("discard")));
    assert.ok(!t.calls.some((c) => c.startsWith("commit")));
  } finally {
    FIXTURE_PACKAGES["packages/acme.quiet-1.0.0.yvx"].manifest = original;
  }
});

test("update: the active old version is stopped, the new one runs; the update is no longer pending", async () => {
  const t = setup();
  const m = t.manager();
  await t.installer.install("acme.updater", "1.0.0");
  assert.equal(await m.executeCommand("acme.updater.which"), "Updater 1.0.0");
  await t.service.checkForUpdates([{ id: "acme.updater", version: "1.0.0" }]);
  assert.ok(t.service.getSnapshot().updates["acme.updater"]);
  await t.installer.update("acme.updater");
  assert.equal(t.registry.get("acme.updater")?.manifest.version, "1.1.0");
  await until(
    () => m.getSnapshot().statuses["acme.updater"]?.state !== "active",
    "old version stopped",
  );
  assert.equal(await m.executeCommand("acme.updater.which"), "Updater 1.1.0");
  assert.equal(t.service.getSnapshot().updates["acme.updater"], undefined);
  assert.ok(t.calls.includes("finish acme.updater true"));
  await m.dispose();
});

test("a failed update rolls back: the previous version is back in the registry and runs", async () => {
  const t = setup();
  const m = t.manager();
  await t.installer.install("acme.updater", "1.0.0");
  t.failCommit(true);
  let removed = false;
  const stop = t.registry.subscribe(() => (removed ||= !t.registry.get("acme.updater")));
  await assert.rejects(
    t.installer.update("acme.updater"),
    (e: MarketplaceError) => e.code === "InstallFailed" && /in use/.test(e.detail!),
  );
  stop();
  assert.equal(removed, false, "the working version never left the registry");
  assert.equal(t.rediscovers(), 0, "nothing to re-read: the registry never changed");
  assert.equal(t.registry.get("acme.updater")?.manifest.version, "1.0.0");
  assert.equal(await m.executeCommand("acme.updater.which"), "Updater 1.0.0");
  await m.dispose();
});

test("a second operation on the same extension at once is refused", async () => {
  const t = setup();
  const first = t.installer.install("acme.docker-tools");
  await assert.rejects(
    t.installer.install("acme.docker-tools"),
    (e: MarketplaceError) => e.code === "Busy",
  );
  await first;
});

test("disable stops the running extension and removes its contributions; enable brings it back lazily", async () => {
  const t = setup();
  const m = t.manager();
  await t.installer.install("acme.quiet");
  assert.equal(await m.executeCommand("acme.quiet.toggle"), "Quiet Mode toggled");
  t.registry.setEnabled("acme.quiet", false);
  await until(() => !m.getSnapshot().statuses["acme.quiet"], "stopped");
  assert.equal(
    t.registry.getSnapshot().commands.some((c) => c.command === "acme.quiet.toggle"),
    false,
    "command gone",
  );
  await assert.rejects(
    m.executeCommand("acme.quiet.toggle"),
    (e: ExtensionError) => e.code === "UnknownCommand" || e.code === "Disabled",
  );
  assert.ok(t.registry.get("acme.quiet"), "still installed");
  t.registry.setEnabled("acme.quiet", true);
  assert.equal(m.getSnapshot().statuses["acme.quiet"], undefined, "not activated until used");
  assert.equal(await m.executeCommand("acme.quiet.toggle"), "Quiet Mode toggled");
  await m.dispose();
});

test("uninstall: out of the registry and the host, folder deleted, data kept or removed as chosen", async () => {
  const t = setup();
  const m = t.manager();
  await t.installer.install("acme.docker-tools");
  await m.executeCommand("acme.docker-tools.status");
  await t.extensionStorage.global("acme.docker-tools").update("seen", 1);
  await t.extensionStorage.workspace(A, "acme.docker-tools").update("open", true);
  await t.installer.uninstall("acme.docker-tools", false);
  assert.equal(t.registry.get("acme.docker-tools"), undefined);
  assert.equal(t.disk.has("acme.docker-tools"), false);
  await until(() => !m.getSnapshot().statuses["acme.docker-tools"], "stopped");
  assert.ok(t.storage.getItem(globalStorageKey("acme.docker-tools")), "data kept");
  await t.installer.install("acme.docker-tools");
  const { removedRecords } = await t.installer.uninstall("acme.docker-tools", true);
  assert.equal(removedRecords, 2);
  assert.equal(t.storage.getItem(globalStorageKey("acme.docker-tools")), null);
  assert.equal(t.storage.getItem(workspaceStorageKey(A, "acme.docker-tools")), null);
  await m.dispose();
});

test("only extensions in Yavin's own folder can be uninstalled", async () => {
  const t = setup();
  t.registry.add(
    FIXTURE_PACKAGES["packages/acme.quiet-1.0.0.yvx"].manifest,
    { kind: "folder", path: "C:/repo/extensions/samples/quiet" },
    "samples",
  );
  await assert.rejects(t.installer.uninstall("acme.quiet", false), (e: MarketplaceError) =>
    /cannot be uninstalled here/.test(e.message),
  );
  assert.ok(t.registry.get("acme.quiet"));
  // A folder merely starting with the root's name is not inside it.
  t.registry.add(
    { ...FIXTURE_PACKAGES["packages/acme.verbose-2.0.0.yvx"].manifest },
    { kind: "folder", path: `${ROOT}-other/acme.verbose` },
    "x",
  );
  assert.equal(t.installer.removable(t.registry.get("acme.verbose")!), false);
});

test("trust: installing in an untrusted folder runs nothing; running needs trust", async () => {
  const t = setup({ trusted: false });
  const m = t.manager();
  await t.installer.install("acme.python-tools");
  assert.ok(t.registry.get("acme.python-tools"));
  await assert.rejects(
    m.executeCommand("acme.python-tools.check"),
    (e: ExtensionError) => e.code === "TrustRequired",
  );
  assert.equal(t.host.started(), 0);
  await m.dispose();
});

test("workspaces: what is installed is the window's; each workspace's host and state are its own", async () => {
  const t = setup();
  await t.installer.install("acme.docker-tools");
  const a = t.manager(A, 1);
  assert.equal(await a.executeCommand("acme.docker-tools.status"), "Docker Tools: no containers");
  await a.dispose();
  const b = t.manager(B, 2);
  assert.equal(
    b.getSnapshot().statuses["acme.docker-tools"],
    undefined,
    "nothing of A's activation in B",
  );
  assert.equal(await b.executeCommand("acme.docker-tools.status"), "Docker Tools: no containers");
  await b.dispose();
  await settle();
});

test("statuses: one actionable status per extension, never runtime internals", async () => {
  const { displayStatus } = await import("./status.ts");
  const t = setup();
  await t.installer.install("acme.python-tools");
  const entry = t.registry.get("acme.python-tools")!;
  const base = { entry, trusted: true };
  assert.deepEqual(displayStatus(base), { label: "Enabled", tone: "neutral", detail: null });
  assert.equal(
    displayStatus({ ...base, runtime: { state: "active", reason: null, activationMs: 3 } }).label,
    "Active",
  );
  assert.equal(
    displayStatus({ ...base, runtime: { state: "activating", reason: null, activationMs: null } })
      .label,
    "Activating",
  );
  assert.equal(displayStatus({ ...base, trusted: false }).label, "Untrusted");
  assert.equal(
    displayStatus({
      ...base,
      runtime: { state: "failed", reason: "Activation failed: kaboom", activationMs: null },
    }).detail,
    "kaboom",
  );
  assert.equal(
    displayStatus({
      ...base,
      runtime: {
        state: "failed",
        reason:
          "Activation failed: HostUnavailable: The extension host (yavin-extension-host.exe) is missing",
        activationMs: null,
      },
    }).label,
    "Host Unavailable",
  );
  assert.equal(
    displayStatus({ ...base, update: { id: entry.id, installed: "1.2.0", available: "1.3.0" } })
      .label,
    "Update Available",
  );
  assert.equal(
    displayStatus({ ...base, unavailable: "It needs acme.base, which is not installed." }).label,
    "Unavailable",
  );
  assert.equal(
    displayStatus({ ...base, operation: { kind: "update", phase: "verifying", version: "1.3.0" } })
      .detail,
    "Verifying the package…",
  );
  assert.equal(
    displayStatus({
      entry: undefined,
      trusted: true,
      incompatible: "This extension requires Yavin API 3.0.0.",
    }).label,
    "Incompatible",
  );
  assert.equal(displayStatus({ entry: undefined, trusted: true }).label, "Not installed");
  t.registry.setEnabled(entry.id, false);
  assert.equal(displayStatus({ entry: t.registry.get(entry.id), trusted: true }).label, "Disabled");
  for (const status of [
    displayStatus(base),
    displayStatus({ ...base, runtime: { state: "active", reason: null, activationMs: 3 } }),
  ])
    assert.ok(!/generation|request|session|pid/i.test(JSON.stringify(status)));
});

test("every package source Yavin's registry publishes passes the installer's manifest validation", async () => {
  const { readManifest } = await import("../manifest.ts");
  const catalog = JSON.parse(
    readFileSync(new URL("../../../../registry/catalog.json", import.meta.url), "utf8"),
  );
  let checked = 0;
  for (const extension of catalog.extensions)
    for (const version of extension.versions) {
      const raw = JSON.parse(
        readFileSync(
          new URL(`../../../../${version.source}/yavin-extension.json`, import.meta.url),
          "utf8",
        ),
      );
      const read = readManifest(raw);
      assert.ok(read.ok, `${version.source}: ${JSON.stringify(!read.ok && read.problems)}`);
      assert.equal(read.manifest.id, extension.id);
      assert.deepEqual(read.warnings, [], version.source);
      checked++;
    }
  assert.ok(checked >= 4);
});

test("a registry with no index (404) is an unavailable marketplace, not a missing extension", async () => {
  const service = createMarketplaceService(
    createLocalMarketplaceProvider({
      fail: () => "NotFound: index.json is not in the marketplace.",
    }),
  );
  await assert.rejects(
    service.getRecommendations([]),
    (e: MarketplaceError) =>
      e.code === "Unavailable" &&
      e.message === "The extension marketplace is unavailable." &&
      /index\.json/.test(e.detail ?? ""),
  );
});

test("performance budgets: a 2,000-extension index read, searched and paged", async () => {
  const one = fixtureIndex().extensions[1];
  const big = {
    ...fixtureIndex(),
    extensions: Array.from({ length: 2000 }, (_, n) => ({
      ...one,
      id: `acme.e${n}`,
      name: `e${n}`,
      displayName: `Extension ${n}`,
      description: `Test extension number ${n} for ${n % 2 ? "python" : "docker"} work.`,
      tags: [`tag${n % 50}`],
    })),
  };
  const text = JSON.stringify(big);
  let started = performance.now();
  const read = readIndex(text);
  const parse = performance.now() - started;
  assert.equal(read.entries.size, 2000);
  const provider = createLocalMarketplaceProvider({ index: big });
  await provider.getCategories();
  const samples: number[] = [];
  for (const query of ["python", "docker work", "extension 1999", "tag7", "", "nothing-at-all"]) {
    for (let i = 0; i < 5; i++) {
      started = performance.now();
      await provider.search({ query, page: 0, pageSize: 20 });
      samples.push(performance.now() - started);
    }
  }
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.floor(samples.length * 0.95)];
  started = performance.now();
  const last = await provider.search({ query: "", page: 99, pageSize: 20 });
  const page = performance.now() - started;
  assert.equal(last.items.length, 20);
  console.log(
    `marketplace: index of 2000 read in ${parse.toFixed(1)} ms; search p95 ${p95.toFixed(1)} ms; page 100 ${page.toFixed(1)} ms`,
  );
  assert.ok(parse < 500, `read ${parse} ms (budget 500)`);
  assert.ok(p95 < 50, `search p95 ${p95} ms (budget 50)`);
});

test("an extension whose dependency is not installed is refused before it is put in place", async () => {
  const t = setup();
  await assert.rejects(
    t.installer.install("acme.quiet-addon"),
    (e: MarketplaceError) =>
      e.code === "Incompatible" &&
      e.message === "Quiet Addon needs acme.quiet, which is not installed. Install it first.",
  );
  assert.ok(
    t.calls.some((c) => c.startsWith("discard")),
    "the staged package is discarded",
  );
  assert.ok(!t.calls.some((c) => c.startsWith("commit")), "nothing is put in place");
  assert.equal(t.registry.get("acme.quiet-addon"), undefined);
  // With its dependency installed, it installs and runs; dependencies activate first.
  await t.installer.install("acme.quiet");
  await t.installer.install("acme.quiet-addon");
  const m = t.manager();
  assert.equal(await m.executeCommand("acme.quiet-addon.go"), "Quiet Addon went");
  assert.equal(m.getSnapshot().statuses["acme.quiet"]?.state, "active");
  await m.dispose();
});
