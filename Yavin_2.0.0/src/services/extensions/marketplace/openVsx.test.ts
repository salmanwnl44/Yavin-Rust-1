import assert from "node:assert/strict";
import test from "node:test";
import { createSettingsRegistry } from "../../settings/settings.ts";
import { createExtensionRegistry } from "../registry.ts";
import { createExtensionStorage } from "../storage.ts";
import { createExtensionInstaller, type InstallerNative } from "./installer.ts";
import {
  createOpenVsxProvider,
  type OpenVsxNative,
  type OpenVsxRequest,
} from "./openVsxProvider.ts";
import { createSearchController } from "./search.ts";
import { createMarketplaceService } from "./service.ts";
import {
  configuredProvider,
  MARKETPLACE_OPEN_VSX,
  MARKETPLACE_SETTING_LIST,
  MARKETPLACE_SOURCE,
} from "./setup.ts";
import { MarketplaceError } from "./types.ts";

function memoryStorage(): Storage {
  const data = new Map<string, string>();
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

/** One Open VSX search entry, as open-vsx.org serves them (checked 2026-10-18). */
const entry = (overrides: Record<string, unknown> = {}) => ({
  namespace: "redhat",
  name: "vscode-yaml",
  version: "1.15.0",
  displayName: "YAML",
  description: "YAML Language Support",
  downloadCount: 8613164,
  averageRating: 4.5,
  verified: true,
  deprecated: false,
  timestamp: "2026-10-17T08:13:21.098214Z",
  files: {
    download:
      "https://open-vsx.org/api/redhat/vscode-yaml/1.15.0/file/redhat.vscode-yaml-1.15.0.vsix",
    sha256:
      "https://open-vsx.org/api/redhat/vscode-yaml/1.15.0/file/redhat.vscode-yaml-1.15.0.sha256",
    icon: "https://open-vsx.org/api/redhat/vscode-yaml/1.15.0/file/icon.png",
  },
  ...overrides,
});

/** An extension's own record. */
const record = (overrides: Record<string, unknown> = {}) => ({
  ...entry(),
  namespaceDisplayName: "Red Hat",
  license: "MIT",
  repository: "https://github.com/redhat-developer/vscode-yaml",
  homepage: "http://example.com/not-https",
  engines: { vscode: "^1.91.0", npm: ">=7.0.0" },
  categories: ["Programming Languages", "Linters"],
  tags: ["__ext_yaml", "yaml", "kubernetes"],
  files: {
    ...entry().files,
    readme: "https://open-vsx.org/x/readme.md",
    changelog: "https://open-vsx.org/x/changelog.md",
  },
  allVersions: {
    latest: "https://open-vsx.org/api/redhat/vscode-yaml/latest",
    "pre-release": "https://open-vsx.org/api/redhat/vscode-yaml/pre-release",
    "1.15.0": "x",
    "1.9.0": "x",
    "1.14.2": "x",
  },
  ...overrides,
});

/** A fake of the native requests: answers by kind, records each request. */
function fakeNative(answer: (request: OpenVsxRequest) => unknown) {
  const requests: { registryUrl: string; request: OpenVsxRequest }[] = [];
  const native: OpenVsxNative = {
    async request(registryUrl, request) {
      requests.push({ registryUrl, request });
      const value = answer(request);
      if (value instanceof Error) throw value;
      return typeof value === "string" ? value : JSON.stringify(value);
    },
    async icon() {
      return "data:image/png;base64,AAAA";
    },
  };
  return { native, requests };
}

const URL_ = "https://open-vsx.org/";

test("Open VSX search: pages map to offset and size; the query and category pass through", async () => {
  const { native, requests } = fakeNative(() => ({
    offset: 40,
    totalSize: 41,
    extensions: [entry()],
  }));
  const provider = createOpenVsxProvider(URL_, { native });
  const result = await provider.search({
    query: "  yaml lint ",
    category: "Linters",
    page: 2,
    pageSize: 20,
  });
  assert.deepEqual(requests[0], {
    registryUrl: URL_,
    request: { kind: "search", query: "yaml lint", category: "Linters", offset: 40, size: 20 },
  });
  assert.deepEqual(
    [result.total, result.page, result.pageSize, result.items.length],
    [41, 2, 20, 1],
  );
  // A page is at most 50 (the native bound).
  await provider.search({ query: "x", page: 1, pageSize: 500 });
  assert.deepEqual(
    [
      requests[1].request.kind === "search" && requests[1].request.offset,
      requests[1].request.kind === "search" && requests[1].request.size,
    ],
    [50, 50],
  );
});

test("Open VSX answers are validated: malformed answers fail, bad entries are left out, nothing is invented", async () => {
  const bad = async (answer: unknown) =>
    createOpenVsxProvider(URL_, { native: fakeNative(() => answer).native })
      .search({ query: "x", page: 0, pageSize: 20 })
      .then(
        () => assert.fail("accepted"),
        (error: MarketplaceError) => assert.equal(error.code, "InvalidResponse"),
      );
  await bad("<html>not json</html>");
  await bad([]);
  await bad({ totalSize: 1 });
  await bad({ extensions: [] });
  await bad({ extensions: [], totalSize: -1 });

  const { native } = fakeNative(() => ({
    offset: 0,
    totalSize: 7,
    extensions: [
      entry(),
      entry(), // the same id twice: shown once
      entry({ namespace: undefined }),
      entry({ name: "has_underscore" }), // not a Yavin id
      entry({
        name: "two-lines",
        displayName: "A\nB",
        averageRating: 7,
        downloadCount: -3,
        verified: "yes",
      }),
      "not an object",
      entry({
        namespace: "PKief",
        name: "material-icon-theme",
        displayName: "Material Icon Theme",
      }),
    ],
  }));
  const { items } = await createOpenVsxProvider(URL_, { native }).search({
    query: "",
    page: 0,
    pageSize: 20,
  });
  assert.deepEqual(
    items.map((one) => one.id),
    ["redhat.vscode-yaml", "redhat.two-lines", "pkief.material-icon-theme"],
  );
  const odd = items[1];
  assert.equal(odd.displayName, "two-lines", "an invalid display name falls back to the name");
  assert.equal(odd.rating, undefined);
  assert.equal(odd.downloads, undefined);
  assert.equal(odd.verifiedPublisher, undefined);
  // The published spelling is kept for display and for the registry; the id is folded.
  assert.equal(items[2].publisher, "PKief");
  assert.equal(items[0].downloads, 8613164);
  assert.equal(items[0].rating, 4.5);
});

test("Open VSX extensions are VS Code extensions: only themes and snippets install, said plainly", async () => {
  const { native } = fakeNative((request) =>
    request.kind === "search"
      ? { offset: 0, totalSize: 1, extensions: [entry()] }
      : request.kind === "extension" && request.name === "theme-dracula"
        ? record({ name: "theme-dracula", categories: ["Themes"] })
        : record(),
  );
  const service = createMarketplaceService(createOpenVsxProvider(URL_, { native }), {
    api: "2.0.0",
    platform: "win32",
  });
  // A search entry does not say what it contributes: installable, with what that means.
  const found = await service.search({ query: "yaml", page: 0, pageSize: 20 });
  const fits = service.compatibility(found.items[0]);
  assert.equal(fits.compatible, true);
  assert.match(
    fits.notes?.[0] ?? "",
    /installs only its colour themes and snippets; its code never runs/,
  );
  // Its record does: YAML is a language extension, with no theme or snippets to install.
  const details = await service.getExtension("redhat.vscode-yaml");
  const why = service.compatibility(details);
  assert.equal(why.compatible, false);
  assert.match(why.reasons[0], /VS Code extension with no colour themes or snippets/);
  assert.equal(service.latestCompatible(details), null);
  // Versions: the aliases are not versions; newest first; each one a VS Code package.
  assert.deepEqual(
    details.versions.map((v) => v.version),
    ["1.15.0", "1.14.2", "1.9.0"],
  );
  assert.ok(details.versions.every((v) => v.packageFormat === "vsix" && v.declarative === false));
  assert.equal(service.compatibility(details, "1.9.0").compatible, false);
  // A theme extension is installable, any listed version.
  const theme = await service.getExtension("redhat.theme-dracula");
  assert.equal(service.compatibility(theme).compatible, true);
  assert.equal(service.compatibility(theme, "1.9.0").compatible, true);
  // Only what Open VSX publishes: an http homepage and internal tags are left out.
  assert.equal(details.homepage, undefined);
  assert.equal(details.repository, "https://github.com/redhat-developer/vscode-yaml");
  assert.deepEqual(details.tags, ["yaml", "kubernetes"]);
  assert.equal(details.publisherDisplayName, "Red Hat");
  assert.ok(details.hasReadme && details.hasChangelog);
});

test("Open VSX details: the record must be the extension asked for; versions and documents", async () => {
  const { native, requests } = fakeNative((request) => {
    if (request.kind === "document")
      return request.document === "readme" ? "# YAML" : new Error("NotFound: no changelog.");
    if (request.kind === "extension" && request.name === "liar") return record({ name: "other" });
    return record({ namespace: "RedHat" });
  });
  const provider = createOpenVsxProvider(URL_, { native });
  const extension = await provider.getExtension("RedHat.vscode-yaml");
  assert.equal(extension.id, "redhat.vscode-yaml");
  assert.equal(await provider.getDocument(extension.id, "readme"), "# YAML");
  assert.equal(await provider.getDocument(extension.id, "changelog"), null);
  assert.deepEqual(requests.at(-1)?.request, {
    kind: "document",
    namespace: "RedHat",
    name: "vscode-yaml",
    version: "1.15.0",
    document: "changelog",
  });
  await assert.rejects(
    provider.getExtension("redhat.liar"),
    (error: MarketplaceError) => error.code === "InvalidResponse",
  );
  await assert.rejects(
    provider.getExtension("not an id"),
    (error: MarketplaceError) => error.code === "NotFound",
  );
  // Version selection: a listed version names its Open VSX source; another is refused.
  const pkg = await provider.download("redhat.vscode-yaml", "1.9.0");
  assert.deepEqual(pkg.source, {
    kind: "openVsx",
    registryUrl: URL_,
    namespace: "RedHat",
    name: "vscode-yaml",
  });
  await assert.rejects(
    provider.download("redhat.vscode-yaml", "9.9.9"),
    (error: MarketplaceError) => error.code === "NotFound",
  );
});

test("Open VSX failures are typed: rate limits keep the registry's wait; offline is unavailable", async () => {
  const fail = (message: string) =>
    createMarketplaceService(
      createOpenVsxProvider(URL_, { native: fakeNative(() => new Error(message)).native }),
    ).search({ query: "x", page: 0, pageSize: 20 });
  await assert.rejects(
    fail("RateLimited: try again in 30 s."),
    (error: MarketplaceError) =>
      error.code === "RateLimited" && /try again in 30 s/.test(error.message),
  );
  await assert.rejects(
    fail("MarketplaceUnavailable: the marketplace could not be reached (offline)."),
    (error: MarketplaceError) => error.code === "Unavailable",
  );
  await assert.rejects(
    fail("TooLarge: The search is larger than 4194304 bytes."),
    (error: MarketplaceError) => ["UnsafePackage", "InvalidResponse"].includes(error.code),
  );
});

test("Open VSX is chosen in Settings, at any registry address (a private mirror)", async () => {
  const settings = createSettingsRegistry([...MARKETPLACE_SETTING_LIST], memoryStorage());
  assert.notEqual(configuredProvider(settings).id, "openvsx", "Yavin's registry by default");
  settings.set(MARKETPLACE_SOURCE, "user", "openvsx");
  assert.equal(configuredProvider(settings).label, "Open VSX");
  settings.set(MARKETPLACE_OPEN_VSX, "user", "https://mirror.example.com/openvsx/");
  const provider = configuredProvider(settings) as ReturnType<typeof createOpenVsxProvider>;
  assert.equal(provider.label, "Open VSX (mirror.example.com)");
  assert.equal(provider.location, "https://mirror.example.com/openvsx/");
  // A project cannot point Yavin at another marketplace: these are user settings only.
  assert.deepEqual([...MARKETPLACE_SOURCE.scopes], ["user"]);
  assert.deepEqual([...MARKETPLACE_OPEN_VSX.scopes], ["user"]);
});

test("installing from Open VSX is refused before anything is downloaded: nothing runs, nothing changes", async () => {
  const settings = createSettingsRegistry([], memoryStorage());
  const registry = createExtensionRegistry({ settings, storage: memoryStorage() });
  const { native } = fakeNative((request) =>
    request.kind === "search" ? { offset: 0, totalSize: 1, extensions: [entry()] } : record(),
  );
  const service = createMarketplaceService(createOpenVsxProvider(URL_, { native }));
  const calls: string[] = [];
  const io: InstallerNative = {
    stage: async () => (calls.push("stage"), { token: "t", manifest: "{}" }),
    commit: async () => (calls.push("commit"), { folder: "x", replaced: false }),
    finish: async () => void calls.push("finish"),
    discard: async () => void calls.push("discard"),
    uninstall: async () => (calls.push("uninstall"), "x"),
  };
  const installer = createExtensionInstaller({
    service,
    registry,
    storage: createExtensionStorage(memoryStorage()),
    root: () => "C:/data/extensions",
    rediscover: async () => undefined,
    native: io,
  });
  for (const version of [undefined, "1.9.0"])
    await assert.rejects(
      installer.install("redhat.vscode-yaml", version),
      (error: MarketplaceError) => {
        assert.equal(error.code, "Incompatible");
        assert.match(error.message, /VS Code extension/);
        return true;
      },
    );
  assert.deepEqual(calls, [], "no package was downloaded or staged");
  assert.equal(registry.get("redhat.vscode-yaml"), undefined);
  assert.match(installer.getSnapshot().failures["redhat.vscode-yaml"].message, /VS Code extension/);
});

test("search pages never show an extension twice when the registry's order shifts", async () => {
  let call = 0;
  const pages = [
    [entry({ name: "a" }), entry({ name: "b" })],
    [entry({ name: "b" }), entry({ name: "c" })],
  ];
  const { native } = fakeNative(() => ({ offset: 0, totalSize: 4, extensions: pages[call++] }));
  const provider = createOpenVsxProvider(URL_, { native });
  const search = createSearchController((request, signal) => provider.search(request, signal), {
    debounceMs: 0,
    pageSize: 2,
  });
  search.setText("x");
  await new Promise((resolve) => setTimeout(resolve, 20));
  search.loadMore();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(
    search.getSnapshot().items.map((one) => one.name),
    ["a", "b", "c"],
  );
  search.dispose();
});
