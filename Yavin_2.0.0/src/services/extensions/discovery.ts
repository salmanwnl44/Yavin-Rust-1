/**
 * Installed extensions (IDE-07): the manifests the native side found in Yavin's own
 * `extensions` folder (`src-tauri/src/extensions.rs`), registered. Only manifests: an installed
 * extension's code is not run (see `host.ts`), so what it can do is what its manifest declares.
 */
import { native } from "../native.ts";
import type { ExtensionRegistry } from "./registry.ts";

export interface DiscoveryReport {
  root: string | null;
  registered: number;
  rejected: number;
  timeMs: number;
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

export async function discoverExtensions(
  registry: ExtensionRegistry,
  list: () => Promise<{
    root: string;
    extensions: { folder: string; manifest: string | null; error: string | null }[];
    skipped: number;
  }> = () => native("extensions_list", {}),
): Promise<DiscoveryReport> {
  const started = performance.now();
  const found = await list();
  let registered = 0;
  let rejected = 0;
  for (const one of found.extensions) {
    let parsed: unknown = undefined;
    if (one.manifest !== null)
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
    const result = registry.add(parsed, { kind: "folder", path: one.folder }, one.folder);
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
