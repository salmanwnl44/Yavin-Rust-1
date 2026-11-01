/**
 * ExtensionMarketplaceService (IDE-09): the window's one way to the extension marketplace.
 * It holds the current provider (chosen from Settings), normalizes its failures into typed
 * `MarketplaceError`s, answers compatibility, and keeps the list of available updates for the
 * Extensions view and the Activity Bar badge.
 *
 * It does NOT run extension code, own their lifecycle or settings, or touch React state: the
 * installer installs, the ExtensionRegistry knows what is installed, the extension host runs.
 */
import { compatibilityOf, latestCompatible, type Compatibility } from "./versions.ts";
import {
  marketplaceErrorOf,
  type ExtensionMarketplaceProvider,
  type ExtensionUpdate,
  type MarketplaceExtension,
  type SearchRequest,
} from "./types.ts";

export interface MarketplaceSnapshot {
  providerId: string;
  providerLabel: string;
  /** Updates available, by extension id. */
  updates: Readonly<Record<string, ExtensionUpdate>>;
  /** When updates were last checked (ms), or null. */
  checkedAt: number | null;
  /** Why the last update check failed, if it did. */
  updateError: string | null;
}

export function createMarketplaceService(
  initial: ExtensionMarketplaceProvider,
  options: { api?: string; platform?: string; now?: () => number } = {},
) {
  let provider = initial;
  const now = options.now ?? (() => Date.now());
  const listeners = new Set<() => void>();
  let snapshot: MarketplaceSnapshot = {
    providerId: provider.id,
    providerLabel: provider.label,
    updates: {},
    checkedAt: null,
    updateError: null,
  };
  const publish = (next: Partial<MarketplaceSnapshot>) => {
    snapshot = { ...snapshot, ...next };
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        /* One listener's failure is not the others'. */
      }
    }
  };
  const guard = async <T>(what: string, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      throw marketplaceErrorOf(error, "Unavailable", what);
    }
  };
  const compat = { api: options.api, platform: options.platform };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get provider() {
      return provider;
    },
    /** Another marketplace (Settings changed): nothing of the old one is kept. */
    setProvider(next: ExtensionMarketplaceProvider) {
      if (next === provider) return;
      provider = next;
      publish({
        providerId: next.id,
        providerLabel: next.label,
        updates: {},
        checkedAt: null,
        updateError: null,
      });
    },
    search: (request: SearchRequest, signal?: AbortSignal) =>
      guard("The search", () => provider.search(request, signal)),
    getExtension: (id: string, signal?: AbortSignal) =>
      guard(id, () => provider.getExtension(id, signal)),
    getCategories: (signal?: AbortSignal) =>
      guard("Categories", () => provider.getCategories(signal)),
    getRecommendations: (installed: readonly string[], signal?: AbortSignal) =>
      guard("Recommendations", () => provider.getRecommendations({ installed }, signal)),
    getDocument: (id: string, kind: "readme" | "changelog") =>
      guard(id, () => provider.getDocument(id, kind)),
    getIcon: (id: string) => provider.getIcon(id).catch(() => null),
    download: (id: string, version: string) => guard(id, () => provider.download(id, version)),
    /** Whether this Yavin can run the extension's latest version (or `version`). */
    compatibility(extension: MarketplaceExtension, version?: string): Compatibility {
      const chosen = version
        ? extension.versions.find((v) => v.version === version)
        : extension.versions[0];
      if (!chosen) return { compatible: false, reasons: [`Version ${version} is not published.`] };
      return compatibilityOf(chosen, compat);
    },
    latestCompatible: (extension: MarketplaceExtension) => latestCompatible(extension, compat),
    /** Asks the marketplace which installed extensions have a newer compatible version. */
    async checkForUpdates(installed: readonly { id: string; version: string }[]) {
      try {
        const found = await provider.checkForUpdates(installed);
        publish({
          updates: Object.fromEntries(found.map((u) => [u.id, u])),
          checkedAt: now(),
          updateError: null,
        });
        return found;
      } catch (error) {
        const failure = marketplaceErrorOf(error, "Unavailable", "The update check");
        publish({ checkedAt: now(), updateError: failure.message });
        throw failure;
      }
    },
    /** An extension was installed, updated or uninstalled: its update is no longer pending. */
    settled(id: string) {
      if (!(id in snapshot.updates)) return;
      const { [id]: _done, ...rest } = snapshot.updates;
      void _done;
      publish({ updates: rest });
    },
    /** Forgets cached metadata (Refresh). */
    refresh() {
      provider.refresh();
    },
  };
}

export type ExtensionMarketplaceService = ReturnType<typeof createMarketplaceService>;
