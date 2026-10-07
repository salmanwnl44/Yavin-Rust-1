/**
 * The marketplace as the window configures it (IDE-09): its settings (in the SettingsRegistry,
 * user scope only -- a project's workspace settings must not be able to point Yavin at another
 * marketplace), and the provider they choose.
 */
import { native } from "../../native.ts";
import { booleanSetting, stringSetting, type SettingsRegistry } from "../../settings/settings.ts";
import { createYavinRegistryProvider, YAVIN_REGISTRY_PROVIDER } from "./yavinRegistry.ts";
import type { ExtensionMarketplaceProvider } from "./types.ts";

const SECTION = "Extensions";
const USER_ONLY = ["user"] as const;

export const MARKETPLACE_REGISTRY = stringSetting({
  id: "extensions.marketplace.registryUrl",
  title: "Marketplace registry",
  description:
    "The address (https://…/) of the extension registry to use. Empty: Yavin's own registry. Set it only to a registry you trust.",
  section: SECTION,
  default: "",
  maxLength: 500,
  scopes: USER_ONLY,
});

export const MARKETPLACE_AUTO_CHECK = booleanSetting({
  id: "extensions.autoCheckUpdates",
  title: "Check for extension updates",
  description:
    "Check the marketplace for updates of installed extensions when Yavin starts. Updates are never installed without you.",
  section: SECTION,
  default: true,
  scopes: USER_ONLY,
});

export const MARKETPLACE_RECOMMENDATIONS = booleanSetting({
  id: "extensions.showRecommendations",
  title: "Show recommended extensions",
  description: "Show the marketplace's recommended extensions in the Extensions view.",
  section: SECTION,
  default: true,
  scopes: USER_ONLY,
});

export const MARKETPLACE_SETTING_LIST = [
  MARKETPLACE_REGISTRY,
  MARKETPLACE_AUTO_CHECK,
  MARKETPLACE_RECOMMENDATIONS,
] as const;

/**
 * A provider whose registry is decided later (the native side names Yavin's registry; Settings
 * may name another). Every call waits for it.
 */
export function lazyProvider(
  resolve: () => Promise<ExtensionMarketplaceProvider>,
  identity: { id: string; label: string },
): ExtensionMarketplaceProvider {
  let pending: Promise<ExtensionMarketplaceProvider> | null = null;
  const get = () =>
    (pending ??= resolve().catch((error) => ((pending = null), Promise.reject(error))));
  return {
    ...identity,
    search: async (request, signal) => (await get()).search(request, signal),
    getExtension: async (id, signal) => (await get()).getExtension(id, signal),
    getVersions: async (id) => (await get()).getVersions(id),
    getCategories: async (signal) => (await get()).getCategories(signal),
    getRecommendations: async (context, signal) =>
      (await get()).getRecommendations(context, signal),
    download: async (id, version) => (await get()).download(id, version),
    checkForUpdates: async (installed) => (await get()).checkForUpdates(installed),
    getDocument: async (id, kind) => (await get()).getDocument(id, kind),
    getIcon: async (id) => (await get()).getIcon(id),
    refresh: () => void pending?.then((provider) => provider.refresh()),
  };
}

const browserStorage = () => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

/** The provider Settings choose now: the registry they name, or Yavin's own. */
export function configuredProvider(settings: SettingsRegistry): ExtensionMarketplaceProvider {
  const named = settings.get(MARKETPLACE_REGISTRY, null).trim();
  return lazyProvider(
    async () => {
      const url = named || (await native("marketplace_default_registry", {}));
      return createYavinRegistryProvider(url, { cache: browserStorage() });
    },
    { id: YAVIN_REGISTRY_PROVIDER, label: named ? "Custom registry" : "Yavin Extensions" },
  );
}
