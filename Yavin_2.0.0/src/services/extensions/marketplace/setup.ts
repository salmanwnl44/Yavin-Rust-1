/**
 * The marketplace as the window configures it (IDE-09): its settings (in the SettingsRegistry,
 * user scope only -- a project's workspace settings must not be able to point Yavin at another
 * marketplace), and the provider they choose.
 */
import { native } from "../../native.ts";
import {
  booleanSetting,
  enumSetting,
  stringSetting,
  type SettingsRegistry,
} from "../../settings/settings.ts";
import { createOpenVsxProvider, OPEN_VSX_URL } from "./openVsxProvider.ts";
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

/** Which marketplace the Extensions view browses (EXT-03). */
export const MARKETPLACE_SOURCE = enumSetting<"yavin" | "openvsx">({
  id: "extensions.marketplace.source",
  title: "Marketplace",
  description:
    "Which marketplace the Extensions view browses. Open VSX lists VS Code extensions: they can be browsed, but Yavin cannot install or run them yet.",
  section: SECTION,
  default: "yavin",
  options: [
    { value: "yavin", label: "Yavin Extensions" },
    { value: "openvsx", label: "Open VSX (browse only)" },
  ],
  scopes: USER_ONLY,
});

export const MARKETPLACE_OPEN_VSX = stringSetting({
  id: "extensions.marketplace.openVsxUrl",
  title: "Open VSX registry",
  description:
    "The address (https://…/) of the Open VSX registry to browse: open-vsx.org, or a private mirror you trust.",
  section: SECTION,
  default: OPEN_VSX_URL,
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
  MARKETPLACE_SOURCE,
  MARKETPLACE_REGISTRY,
  MARKETPLACE_OPEN_VSX,
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

/** The settings that choose the provider: a change to any of them chooses again. */
export const MARKETPLACE_PROVIDER_SETTINGS: readonly string[] = [
  MARKETPLACE_SOURCE.id,
  MARKETPLACE_REGISTRY.id,
  MARKETPLACE_OPEN_VSX.id,
];

/** The label of an Open VSX registry: open-vsx.org's own, or a mirror's host. */
export function openVsxLabel(url: string): string {
  const host = /^https?:\/\/([^/:]+)/i.exec(url)?.[1]?.toLowerCase();
  return !host || host === "open-vsx.org" ? "Open VSX" : `Open VSX (${host})`;
}

/** The provider Settings choose now: Open VSX, the registry they name, or Yavin's own. */
export function configuredProvider(settings: SettingsRegistry): ExtensionMarketplaceProvider {
  if (settings.get(MARKETPLACE_SOURCE, null) === "openvsx") {
    const url = settings.get(MARKETPLACE_OPEN_VSX, null).trim() || OPEN_VSX_URL;
    return createOpenVsxProvider(url, { label: openVsxLabel(url) });
  }
  const named = settings.get(MARKETPLACE_REGISTRY, null).trim();
  return lazyProvider(
    async () => {
      const url = named || (await native("marketplace_default_registry", {}));
      return createYavinRegistryProvider(url, { cache: browserStorage() });
    },
    { id: YAVIN_REGISTRY_PROVIDER, label: named ? "Custom registry" : "Yavin Extensions" },
  );
}
