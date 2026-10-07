import { useSyncExternalStore } from "react";
import type { ExtensionHostManager } from "../../services/extensions/manager";
import type { ExtensionRegistry } from "../../services/extensions/registry";
import type { ExtensionInstaller } from "../../services/extensions/marketplace/installer";
import type { ExtensionMarketplaceService } from "../../services/extensions/marketplace/service";
import { displayStatus, type DisplayStatus } from "../../services/extensions/marketplace/status";
import type { MarketplaceExtension } from "../../services/extensions/marketplace/types";

export function useStore<T>(store: {
  subscribe(listener: () => void): () => void;
  getSnapshot(): T;
}): T {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/** Everything the Extensions view reads, subscribed: the registry (what is installed -- the
 *  source of truth), the workspace's host (what runs), the marketplace and the installer. */
export function useExtensionsState(services: {
  registry: ExtensionRegistry;
  manager: ExtensionHostManager;
  marketplace: ExtensionMarketplaceService;
  installer: ExtensionInstaller;
}) {
  const registry = useStore(services.registry);
  const runtime = useStore(services.manager);
  const market = useStore(services.marketplace);
  const operations = useStore(services.installer);
  return { registry, runtime, market, operations };
}

export type ExtensionsState = ReturnType<typeof useExtensionsState>;

/** The one status an extension shows, from all of the above. */
export function statusOf(
  id: string,
  state: ExtensionsState,
  trusted: boolean,
  marketplace: ExtensionMarketplaceService,
  listing?: MarketplaceExtension,
): DisplayStatus {
  const entry = state.registry.extensions.find((one) => one.id === id);
  const incompatible =
    !entry && listing && !marketplace.latestCompatible(listing)
      ? (marketplace.compatibility(listing).reasons[0] ?? "This Yavin cannot run it.")
      : null;
  return displayStatus({
    entry,
    runtime: state.runtime.statuses[id],
    unavailable: state.registry.unavailable[id],
    held: state.runtime.held,
    trusted,
    update: state.market.updates[id],
    operation: state.operations.operations[id],
    incompatible,
  });
}
