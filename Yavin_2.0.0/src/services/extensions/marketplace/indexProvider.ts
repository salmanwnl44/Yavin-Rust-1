/**
 * A marketplace served as a static registry index (IDE-09) -- the format of Yavin's own
 * registry (`registry/index.json`, built by `scripts/build-registry.mjs`): one JSON document
 * listing every extension, its versions (each with its package's path, size and SHA-256),
 * categories and recommendations. Search, pagination and filtering run over the index here.
 *
 * The index is read strictly: an entry that does not hold up (an id that is not its
 * publisher.name, a version without a valid checksum...) is left out rather than trusted, and an
 * index of a schema this Yavin does not know is refused whole.
 *
 * Caching: the index is kept for `ttlMs` (in memory, and in `cache` -- the browser's storage --
 * keyed by schema, provider and registry), and dropped by `refresh()`. Packages are never
 * cached: the installer downloads them each time.
 */
import { compatibilityOf, compareVersions, latestCompatible } from "./versions.ts";
import {
  MarketplaceError,
  marketplaceErrorOf,
  type ExtensionCategory,
  type ExtensionMarketplaceProvider,
  type ExtensionPackage,
  type MarketplaceExtension,
  type MarketplaceVersion,
  type PackageSource,
  type SearchRequest,
} from "./types.ts";

export const INDEX_SCHEMA = 1;
const CACHE_VERSION = 1;

interface IndexVersion extends MarketplaceVersion {
  package: string;
  sha256: string;
  size: number;
}
interface IndexEntry {
  extension: MarketplaceExtension;
  versions: IndexVersion[];
  icon?: string;
  readme?: string;
  changelog?: string;
}
export interface RegistryIndex {
  name: string;
  categories: ExtensionCategory[];
  recommended: string[];
  entries: Map<string, IndexEntry>;
  /** Entries left out, with why. */
  dropped: string[];
}

const ID = /^[a-z0-9][a-z0-9-]{0,63}\.[a-z0-9][a-z0-9-]{0,63}$/;
const PATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const text = (value: unknown, max: number) =>
  typeof value === "string" && value.length <= max ? value : undefined;
const url = (value: unknown) =>
  typeof value === "string" && /^https:\/\/[^\s]{1,500}$/.test(value) ? value : undefined;
const path = (value: unknown) =>
  typeof value === "string" && PATH.test(value) && !value.split("/").includes("..")
    ? value
    : undefined;
const strings = (value: unknown, max: number) =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v.length <= max).slice(0, 50)
    : [];

/** The index's JSON text, read strictly. */
export function readIndex(json: string): RegistryIndex {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new MarketplaceError(
      "InvalidResponse",
      "The extension marketplace sent something unexpected.",
      "The index is not JSON.",
    );
  }
  if (!raw || typeof raw !== "object")
    throw new MarketplaceError(
      "InvalidResponse",
      "The extension marketplace sent something unexpected.",
      "The index is not an object.",
    );
  if (raw.schema !== INDEX_SCHEMA)
    throw new MarketplaceError(
      "InvalidResponse",
      "This version of Yavin cannot read this extension marketplace.",
      `Index schema ${String(raw.schema)}; this Yavin reads schema ${INDEX_SCHEMA}.`,
    );
  const dropped: string[] = [];
  const entries = new Map<string, IndexEntry>();
  for (const item of Array.isArray(raw.extensions)
    ? (raw.extensions as Record<string, unknown>[])
    : []) {
    const id = text(item?.id, 130);
    const drop = (why: string) => dropped.push(`${id ?? "(no id)"}: ${why}`);
    if (!id || !ID.test(id)) {
      drop("not a valid extension id");
      continue;
    }
    const publisher = text(item.publisher, 64);
    const name = text(item.name, 64);
    if (!publisher || !name || `${publisher}.${name}`.toLowerCase() !== id) {
      drop("its id is not its publisher.name");
      continue;
    }
    if (entries.has(id)) {
      drop("listed twice");
      continue;
    }
    const versions: IndexVersion[] = [];
    for (const v of Array.isArray(item.versions)
      ? (item.versions as Record<string, unknown>[])
      : []) {
      const version = text(v?.version, 64);
      const pkg = path(v?.package);
      const sha256 = text(v?.sha256, 64);
      const size = v?.size;
      if (
        !version ||
        !SEMVER.test(version) ||
        !pkg ||
        !sha256 ||
        !/^[0-9a-f]{64}$/.test(sha256) ||
        typeof size !== "number" ||
        !Number.isInteger(size) ||
        size <= 0
      ) {
        drop(`version ${String(v?.version)} is incomplete (package, sha256, size)`);
        continue;
      }
      const engines = (v.engines ?? {}) as Record<string, unknown>;
      versions.push({
        version,
        publishedAt: text(v.publishedAt, 40),
        engines: { yavin: text(engines.yavin, 40) },
        platforms: Array.isArray(v.platforms) ? strings(v.platforms, 20) : undefined,
        package: pkg,
        sha256,
        size,
      });
    }
    if (!versions.length) {
      drop("no installable version");
      continue;
    }
    versions.sort((a, b) => compareVersions(b.version, a.version));
    const contributes = (item.contributes ?? {}) as Record<string, unknown>;
    const icon = path(item.icon);
    const readme = path(item.readme);
    const changelog = path(item.changelog);
    const extension: MarketplaceExtension = {
      id,
      publisher,
      name,
      displayName: text(item.displayName, 100) || name,
      version: versions[0].version,
      description: text(item.description, 500) ?? "",
      publisherDisplayName: text(item.publisherDisplayName, 100),
      categories: strings(item.categories, 40),
      tags: strings(item.tags, 40),
      hasIcon: !!icon,
      hasReadme: !!readme,
      hasChangelog: !!changelog,
      repository: url(item.repository),
      homepage: url(item.homepage),
      license: text(item.license, 100),
      engines: versions[0].engines,
      extensionKind:
        item.extensionKind === "code" || item.extensionKind === "declarative"
          ? item.extensionKind
          : undefined,
      activationEvents: strings(item.activationEvents, 200),
      contributes: {
        commands: (Array.isArray(contributes.commands)
          ? (contributes.commands as Record<string, unknown>[])
          : []
        )
          .filter((c) => text(c?.command, 200) && text(c?.title, 200))
          .slice(0, 200)
          .map((c) => ({ command: c.command as string, title: c.title as string })),
        settings: (Array.isArray(contributes.settings)
          ? (contributes.settings as Record<string, unknown>[])
          : []
        )
          .filter((c) => text(c?.id, 200))
          .slice(0, 200)
          .map((c) => ({ id: c.id as string, description: text(c.description, 500) ?? "" })),
      },
      publishedAt: versions[versions.length - 1].publishedAt,
      updatedAt: versions[0].publishedAt,
      versions: versions.map(({ version, publishedAt, engines, platforms }) => ({
        version,
        publishedAt,
        engines,
        ...(platforms ? { platforms } : {}),
      })),
    };
    entries.set(id, { extension, versions, icon, readme, changelog });
  }
  const categories = (
    Array.isArray(raw.categories) ? (raw.categories as Record<string, unknown>[]) : []
  )
    .filter((c) => text(c?.id, 40) && text(c?.label, 60))
    .map((c) => ({ id: c.id as string, label: c.label as string }));
  return {
    name: text(raw.name, 100) ?? "Extensions",
    categories,
    recommended: strings(raw.recommended, 130).filter((id) => entries.has(id)),
    entries,
    dropped,
  };
}

/** How well `extension` matches the query's words (0: not at all). */
function score(extension: MarketplaceExtension, words: string[]): number {
  if (!words.length) return 1;
  const name = extension.displayName.toLowerCase();
  let total = 0;
  for (const word of words) {
    if (extension.id === word || name === word) total += 100;
    else if (name.startsWith(word) || extension.name.startsWith(word)) total += 30;
    else if (name.includes(word) || extension.id.includes(word)) total += 20;
    else if (extension.tags.some((tag) => tag.toLowerCase().includes(word))) total += 10;
    else if (extension.categories.some((c) => c.toLowerCase().includes(word))) total += 8;
    else if ((extension.publisherDisplayName ?? extension.publisher).toLowerCase().includes(word))
      total += 6;
    else if (extension.description.toLowerCase().includes(word)) total += 4;
    else return 0;
  }
  return total;
}

export interface IndexSource {
  id: string;
  label: string;
  /** The index's JSON text. */
  loadIndex(signal?: AbortSignal): Promise<string>;
  /** A document (readme, changelog) by its registry path. */
  loadDocument(path: string): Promise<string>;
  /** An icon by its registry path, as a `data:` URL. */
  loadIcon(path: string): Promise<string>;
  /** Where a version's package comes from. */
  packageSource(version: { package: string; sha256: string; size: number }): PackageSource;
  /** The cache key's registry part (its URL). */
  location: string;
}

export function createIndexProvider(
  source: IndexSource,
  options: {
    cache?: Storage | null;
    ttlMs?: number;
    now?: () => number;
    api?: string;
    platform?: string;
  } = {},
): ExtensionMarketplaceProvider & { index(signal?: AbortSignal): Promise<RegistryIndex> } {
  const ttl = options.ttlMs ?? 60 * 60 * 1000;
  const now = options.now ?? (() => Date.now());
  const cacheKey = `yavin.marketplace.index:${source.id}:${source.location}`;
  let memory: { at: number; index: RegistryIndex } | null = null;
  let loading: Promise<RegistryIndex> | null = null;
  const icons = new Map<string, Promise<string | null>>();
  const documents = new Map<string, Promise<string | null>>();

  const fromCache = (): { at: number; text: string } | null => {
    try {
      const raw = JSON.parse(options.cache?.getItem(cacheKey) ?? "null");
      if (
        raw &&
        raw.version === CACHE_VERSION &&
        raw.schema === INDEX_SCHEMA &&
        typeof raw.text === "string" &&
        typeof raw.at === "number" &&
        now() - raw.at < ttl
      )
        return raw;
    } catch {
      /* Unreadable: fetched again. */
    }
    return null;
  };

  const index = async (signal?: AbortSignal): Promise<RegistryIndex> => {
    if (memory && now() - memory.at < ttl) return memory.index;
    const cached = fromCache();
    if (cached) {
      try {
        memory = { at: cached.at, index: readIndex(cached.text) };
        return memory.index;
      } catch {
        /* A bad cached copy: fetched again. */
      }
    }
    loading ??= (async () => {
      try {
        const text = await source.loadIndex();
        const read = readIndex(text);
        const at = now();
        memory = { at, index: read };
        try {
          options.cache?.setItem(
            cacheKey,
            JSON.stringify({ version: CACHE_VERSION, schema: INDEX_SCHEMA, at, text }),
          );
        } catch {
          /* Full or blocked: kept in memory only. */
        }
        return read;
      } catch (error) {
        const failure = marketplaceErrorOf(error, "Unavailable", "The extension index");
        // No index at all is no marketplace there, not a missing extension.
        throw failure.code === "NotFound"
          ? new MarketplaceError(
              "Unavailable",
              "The extension marketplace is unavailable.",
              failure.detail,
            )
          : failure;
      } finally {
        loading = null;
      }
    })();
    const result = await (signal
      ? Promise.race([
          loading,
          new Promise<never>((_, reject) => {
            if (signal.aborted) reject(new MarketplaceError("Cancelled", "Cancelled."));
            signal.addEventListener(
              "abort",
              () => reject(new MarketplaceError("Cancelled", "Cancelled.")),
              { once: true },
            );
          }),
        ])
      : loading);
    return result;
  };

  const entry = async (id: string, signal?: AbortSignal) => {
    const found = (await index(signal)).entries.get(id);
    if (!found) throw new MarketplaceError("NotFound", `${id} is not in the marketplace.`);
    return found;
  };
  const compat = { api: options.api, platform: options.platform };

  return {
    id: source.id,
    label: source.label,
    index,
    async search(request: SearchRequest, signal?: AbortSignal) {
      const all = [...(await index(signal)).entries.values()].map((e) => e.extension);
      const words = request.query.toLowerCase().split(/\s+/).filter(Boolean);
      const matched = all
        .filter((e) => !request.category || e.categories.includes(request.category))
        .filter(
          (e) =>
            !request.compatibleWith ||
            latestCompatible(e, { ...compat, api: request.compatibleWith }) !== null,
        )
        .map((e) => ({ e, s: score(e, words) }))
        .filter(({ s }) => s > 0)
        .sort((a, b) => b.s - a.s || a.e.displayName.localeCompare(b.e.displayName))
        .map(({ e }) => e);
      const start = request.page * request.pageSize;
      return {
        items: matched.slice(start, start + request.pageSize),
        total: matched.length,
        page: request.page,
        pageSize: request.pageSize,
      };
    },
    getExtension: async (id, signal) => (await entry(id, signal)).extension,
    getVersions: async (id) => (await entry(id)).extension.versions,
    getCategories: async (signal) => (await index(signal)).categories,
    async getRecommendations(context, signal) {
      const read = await index(signal);
      return read.recommended
        .filter((id) => !context.installed.includes(id))
        .map((id) => read.entries.get(id)!.extension);
    },
    async download(id, version): Promise<ExtensionPackage> {
      const found = await entry(id);
      const published = found.versions.find((v) => v.version === version);
      if (!published)
        throw new MarketplaceError("NotFound", `${id} ${version} is not in the marketplace.`);
      const compatibility = compatibilityOf(published, compat);
      if (!compatibility.compatible)
        throw new MarketplaceError(
          "Incompatible",
          compatibility.reasons[0],
          compatibility.reasons.join(" "),
        );
      return { id, version, source: source.packageSource(published) };
    },
    async checkForUpdates(installed) {
      const read = await index();
      return installed.flatMap(({ id, version }) => {
        const found = read.entries.get(id);
        const latest = found ? latestCompatible(found.extension, compat) : null;
        return latest && compareVersions(latest.version, version) > 0
          ? [{ id, installed: version, available: latest.version }]
          : [];
      });
    },
    getDocument(id, kind) {
      const key = `${id}:${kind}`;
      let found = documents.get(key);
      if (!found) {
        found = entry(id).then((e) => {
          const at = kind === "readme" ? e.readme : e.changelog;
          return at ? source.loadDocument(at) : null;
        });
        found.catch(() => documents.delete(key));
        documents.set(key, found);
      }
      return found;
    },
    getIcon(id) {
      let found = icons.get(id);
      if (!found) {
        found = entry(id)
          .then((e) => (e.icon ? source.loadIcon(e.icon) : null))
          .catch(() => null);
        icons.set(id, found);
      }
      return found;
    },
    refresh() {
      memory = null;
      icons.clear();
      documents.clear();
      try {
        options.cache?.removeItem(cacheKey);
      } catch {
        /* Nothing to forget. */
      }
    },
  };
}
