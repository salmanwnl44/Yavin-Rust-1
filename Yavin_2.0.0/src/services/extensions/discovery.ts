/**
 * Installed extensions (IDE-07, EXT-02): what the native extension inventory lists
 * (`src-tauri/src/extension_service.rs`), registered. The inventory has already chosen one copy
 * per id -- an installed copy over a development sample -- so each id arrives once, with the
 * copies it shadows; the extension host loads code only from the folder listed here.
 */
import { native } from "../native.ts";
import { DISABLED_KEY, readStoredDisabled, type ExtensionRegistry } from "./registry.ts";

export interface DiscoveryReport {
  root: string | null;
  registered: number;
  rejected: number;
  timeMs: number;
}

export interface ListedExtension {
  folder: string;
  manifest: string | null;
  error: string | null;
  shadowed?: { folder: string; version: string | null; reason: string }[];
}

export interface Listing {
  root: string;
  extensions: ListedExtension[];
  skipped: number;
  /** The inventory's disabled ids (absent: this window's storage keeps them). */
  disabled?: string[];
}

/**
 * The window's first discovery, once however often it is asked for (a development build mounts
 * the window's effects twice): every later one is a Reload, `rediscoverExtensions`.
 */
let first: Promise<DiscoveryReport> | null = null;
export const discoverInstalledOnce = (registry: ExtensionRegistry) =>
  (first ??= discoverExtensions(registry));

/** Discovery again (Reload): the installed extensions found before are forgotten first. */
export async function rediscoverExtensions(
  registry: ExtensionRegistry,
  list?: Parameters<typeof discoverExtensions>[1],
): Promise<DiscoveryReport> {
  for (const one of registry.getSnapshot().extensions)
    if (one.source.kind === "folder") registry.remove(one.id);
  registry.clearRejected();
  return discoverExtensions(registry, list);
}

/**
 * Yavin's own extensions folder, as the last discovery reported it: what the marketplace
 * installs into and may uninstall from (IDE-09). Extensions found elsewhere (a development
 * build's repository samples) are not removable.
 */
let userRoot: string | null = null;
export const installedRoot = () => userRoot;

const windowStorage = () => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

/**
 * The native listing. The first one brings this window's IDE-07 disabled list into the
 * inventory (it is imported once); once that succeeded, the window's copy is removed.
 */
async function nativeList(): Promise<Listing> {
  const storage = windowStorage();
  const legacyDisabled = readStoredDisabled(storage);
  const listing = await native("extensions_list", { legacyDisabled });
  try {
    storage?.removeItem(DISABLED_KEY);
  } catch {
    /* Blocked: the inventory ignores it from now on anyway. */
  }
  return listing;
}

export async function discoverExtensions(
  registry: ExtensionRegistry,
  list: () => Promise<Listing> = nativeList,
): Promise<DiscoveryReport> {
  const started = performance.now();
  const found = await list();
  userRoot = found.root;
  if (found.disabled) registry.setDisabled(found.disabled);
  let registered = 0;
  let rejected = 0;
  for (const one of found.extensions) {
    let parsed: unknown = undefined;
    // The inventory's verdict comes first: a copy it cannot use is never registered.
    if (one.manifest !== null && one.error === null)
      try {
        parsed = JSON.parse(one.manifest);
      } catch (error) {
        parsed = undefined;
        one.error = `Its manifest is not JSON: ${(error as Error).message}`;
      }
    if (parsed === undefined) {
      registry.reject(one.folder, one.error ?? "Its manifest could not be read.");
      rejected++;
      continue;
    }
    const result = registry.add(
      parsed,
      { kind: "folder", path: one.folder },
      one.folder,
      one.shadowed ?? [],
    );
    if ("manifest" in result) registered++;
    else rejected++;
  }
  return {
    root: found.root,
    registered,
    rejected,
    timeMs: Math.round(performance.now() - started),
  };
}
