/**
 * Open VSX (EXT-03), browse-only: an Open VSX registry -- open-vsx.org, or a private mirror at
 * the address Settings name -- as an ExtensionMarketplaceProvider. Every request is native
 * (`src-tauri/src/openvsx.rs`: the URL built and encoded there, HTTPS, bounded, redirects only
 * to the registry or its known file host); this side validates every answer before anything
 * is shown: an entry whose id is not a Yavin id, or whose fields are not what Open VSX
 * documents, is dropped or left out -- nothing is invented.
 *
 * Open VSX serves VS Code extensions (`.vsix`, the `vscode` API, Node.js). Yavin installs what it
 * supports of them -- themes, snippets, languages, grammars, and code run in its sandbox through
 * the VS Code compatibility layer (EXT-04, EXT-25, `src-tauri/src/vsix.rs`). Every version is
 * marked `packageFormat: "vsix"` and is "Not verified" until installed; `declarative` (its
 * categories name Themes or Snippets) is informational. The package decides: the native adapter
 * refuses one with nothing Yavin can use (`UnsupportedPackage`).
 */
import { native } from "../../native.ts";
import { canonicalId } from "../identity.ts";
import { compatibilityOf, compareVersions } from "./versions.ts";
import {
  MarketplaceError,
  type ExtensionMarketplaceProvider,
  type MarketplaceExtension,
  type MarketplaceVersion,
  type SearchResult,
} from "./types.ts";

export const OPEN_VSX_PROVIDER = "openvsx";
export const OPEN_VSX_URL = "https://open-vsx.org/";
/** Open VSX's search answers at most this many per request here (the native bound). */
const MAX_PAGE = 50;
/** Versions shown for one extension (Open VSX lists every one it has). */
const MAX_VERSIONS = 100;

/** The native Open VSX requests (a test supplies its own). */
export interface OpenVsxNative {
  request(registryUrl: string, request: OpenVsxRequest): Promise<string>;
  icon(registryUrl: string, namespace: string, name: string, version: string): Promise<string>;
}

export type OpenVsxRequest =
  | { kind: "search"; query: string; category: string | null; offset: number; size: number }
  | { kind: "extension"; namespace: string; name: string; version: string | null }
  | { kind: "versions"; namespace: string; name: string; offset: number; size: number }
  | {
      kind: "document";
      namespace: string;
      name: string;
      version: string;
      document: "readme" | "changelog";
    };

export const nativeOpenVsx: OpenVsxNative = {
  request: (registryUrl, request) => native("marketplace_openvsx", { registryUrl, request }),
  icon: (registryUrl, namespace, name, version) =>
    native("marketplace_openvsx_icon", { registryUrl, namespace, name, version }),
};

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/** One line of at most `max` characters, or undefined. */
const line = (value: unknown, max: number) =>
  typeof value === "string" && value.length <= max && !/[\r\n\0]/.test(value) ? value : undefined;
const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
/** An https link from the registry's metadata (repository, homepage); anything else is left out. */
const link = (value: unknown) => {
  const text = line(value, 500);
  return text && /^https:\/\/[^\s]+$/i.test(text) ? text : undefined;
};
/** Strings, at most `max` of them; Open VSX's internal `__…` tags are not the publisher's. */
const words = (value: unknown, max = 30) =>
  Array.isArray(value)
    ? value
        .map((one) => line(one, 100))
        .filter((one): one is string => !!one && !one.startsWith("__"))
        .slice(0, max)
    : [];

function invalid(what: string): never {
  throw new MarketplaceError(
    "InvalidResponse",
    "The extension marketplace sent something unexpected.",
    what,
  );
}

function parse(text: string, what: string): Json {
  try {
    const value: unknown = JSON.parse(text);
    if (isObject(value)) return value;
  } catch {
    /* Below. */
  }
  return invalid(`${what} is not a JSON object.`);
}

/** An Open VSX extension record (a search entry, or an extension's own), or null if not usable. */
function extensionOf(raw: unknown, versions?: MarketplaceVersion[]): MarketplaceExtension | null {
  if (!isObject(raw)) return null;
  const namespace = line(raw.namespace, 128);
  const name = line(raw.name, 128);
  const version = line(raw.version, 128);
  if (!namespace || !name || !version) return null;
  const id = canonicalId(`${namespace}.${name}`);
  if (!id) return null;
  const engines = isObject(raw.engines) ? raw.engines : {};
  const latest: MarketplaceVersion = {
    version,
    publishedAt: line(raw.timestamp, 40),
    engines: { yavin: line(engines.yavin, 100), vscode: line(engines.vscode, 100) },
    packageFormat: "vsix",
    preRelease: raw.preRelease === true || undefined,
    // A record lists its categories; a search entry does not.
    declarative: Array.isArray(raw.categories) ? declarativeIn(raw.categories) : undefined,
  };
  const files = isObject(raw.files) ? raw.files : {};
  const rating = count(raw.averageRating);
  return {
    id,
    publisher: namespace,
    name,
    displayName: line(raw.displayName, 200) || name,
    version,
    description: line(raw.description, 2000) ?? "",
    publisherDisplayName: line(raw.namespaceDisplayName, 200),
    categories: words(raw.categories, 10),
    tags: words(raw.tags),
    hasIcon: typeof files.icon === "string",
    // A search entry does not list documents; an extension's own record does.
    hasReadme: versions ? typeof files.readme === "string" : true,
    hasChangelog: versions ? typeof files.changelog === "string" : true,
    downloads: count(raw.downloadCount),
    rating: rating !== undefined && rating <= 5 ? rating : undefined,
    verifiedPublisher: typeof raw.verified === "boolean" ? raw.verified : undefined,
    repository: link(raw.repository),
    homepage: link(raw.homepage),
    license: line(raw.license, 100),
    engines: latest.engines,
    deprecated: raw.deprecated === true || undefined,
    publishedAt: latest.publishedAt,
    updatedAt: latest.publishedAt,
    versions: versions ?? [latest],
  };
}

/** Whether a VS Code extension's categories name what Yavin can use of it. */
const declarativeIn = (categories: unknown[]) =>
  categories.some((one) => typeof one === "string" && /^(themes|snippets)$/i.test(one));

/** An extension's versions from its own record (`allVersions`), newest first. */
function versionsOf(raw: Json, latest: MarketplaceVersion): MarketplaceVersion[] {
  const all = isObject(raw.allVersions) ? Object.keys(raw.allVersions) : [];
  const others = all
    // `latest`, `pre-release`: aliases, not versions.
    .filter((one) => /^\d/.test(one) && one !== latest.version && one.length <= 128)
    .sort((a, b) => compareVersions(b, a))
    .slice(0, MAX_VERSIONS - 1)
    // Open VSX lists other versions without their requirements: only that they are packages.
    .map((version): MarketplaceVersion => ({
      version,
      engines: {},
      packageFormat: "vsix",
      declarative: latest.declarative,
    }));
  return [latest, ...others].sort((a, b) => compareVersions(b.version, a.version));
}

export function createOpenVsxProvider(
  registryUrl: string,
  options: { native?: OpenVsxNative; api?: string; label?: string } = {},
): ExtensionMarketplaceProvider & { readonly location: string } {
  const io = options.native ?? nativeOpenVsx;
  const known = new Map<string, MarketplaceExtension>();
  const split = (id: string) => {
    const entry = known.get(id);
    if (entry) return { namespace: entry.publisher, name: entry.name };
    const dot = id.indexOf(".");
    return { namespace: id.slice(0, dot), name: id.slice(dot + 1) };
  };
  const notFound = (error: unknown) =>
    String((error as Error)?.message ?? error).startsWith("NotFound:");

  async function getExtension(id: string): Promise<MarketplaceExtension> {
    const canonical = canonicalId(id);
    if (!canonical) throw new MarketplaceError("NotFound", `${id} is not an extension id.`);
    const { namespace, name } = split(canonical);
    const raw = parse(
      await io.request(registryUrl, { kind: "extension", namespace, name, version: null }),
      `${canonical}'s record`,
    );
    const summary = extensionOf(raw);
    if (!summary || summary.id !== canonical)
      invalid(`The registry answered for ${summary?.id ?? "another extension"}, not ${canonical}.`);
    const extension = extensionOf(raw, versionsOf(raw, summary.versions[0]))!;
    known.set(canonical, extension);
    return extension;
  }

  return {
    id: OPEN_VSX_PROVIDER,
    label: options.label ?? "Open VSX",
    location: registryUrl,
    async search(request): Promise<SearchResult> {
      const pageSize = Math.max(1, Math.min(request.pageSize, MAX_PAGE));
      const offset = request.page * pageSize;
      const raw = parse(
        await io.request(registryUrl, {
          kind: "search",
          query: request.query.trim(),
          category: request.category ?? null,
          offset,
          size: pageSize,
        }),
        "The search",
      );
      if (!Array.isArray(raw.extensions)) invalid("The search has no extensions list.");
      const total = count(raw.totalSize) ?? invalid("The search has no total.");
      const seen = new Set<string>();
      let items: MarketplaceExtension[] = [];
      for (const one of raw.extensions as unknown[]) {
        const extension = extensionOf(one);
        if (!extension || seen.has(extension.id)) continue;
        seen.add(extension.id);
        if (!known.has(extension.id)) known.set(extension.id, extension);
        items.push(extension);
      }
      // Open VSX cannot filter by the Yavin API: a page is filtered here, and the total is
      // then only what was seen (there is nothing compatible to page through).
      if (request.compatibleWith) {
        const api = request.compatibleWith;
        items = items.filter((one) => compatibilityOf(one.versions[0], { api }).compatible);
        return { items, total: offset + items.length, page: request.page, pageSize };
      }
      return { items, total, page: request.page, pageSize };
    },
    getExtension,
    getVersions: async (id) => (await getExtension(id)).versions,
    // Open VSX's categories are VS Code's, served with no list endpoint; none are invented.
    getCategories: async () => [],
    getRecommendations: async () => [],
    async download(id, version) {
      const extension = known.get(id) ?? (await getExtension(id));
      if (!extension.versions.some((one) => one.version === version))
        throw new MarketplaceError("NotFound", `Version ${version} of ${id} is not published.`);
      return {
        id,
        version,
        source: {
          kind: "openVsx",
          registryUrl,
          namespace: extension.publisher,
          name: extension.name,
        },
      };
    },
    // An installed extension is a Yavin one: Open VSX has no update a Yavin can run.
    checkForUpdates: async () => [],
    async getDocument(id, kind) {
      const extension = known.get(id) ?? (await getExtension(id));
      try {
        return await io.request(registryUrl, {
          kind: "document",
          namespace: extension.publisher,
          name: extension.name,
          version: extension.version,
          document: kind,
        });
      } catch (error) {
        if (notFound(error)) return null;
        throw error;
      }
    },
    async getIcon(id) {
      const extension = known.get(id);
      if (!extension?.hasIcon) return null;
      return io
        .icon(registryUrl, extension.publisher, extension.name, extension.version)
        .catch(() => null);
    },
    refresh: () => known.clear(),
  };
}
