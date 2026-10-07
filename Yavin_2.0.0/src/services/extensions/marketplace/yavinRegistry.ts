/**
 * Yavin's extension registry (IDE-09), the production marketplace: static files over HTTPS --
 * by default Yavin's public repository (`registry/`, served by raw.githubusercontent.com), or a
 * self-hosted registry the user names in Settings. Everything is fetched natively
 * (`marketplace.rs`: HTTPS, same-host redirects, bounded, content-checked); the window itself
 * has no network access (its content security policy).
 *
 * Trust: transport security (HTTPS) and a SHA-256 per package, published in the index and
 * verified natively before anything is unpacked. Packages are NOT signed: the checksum proves
 * the package is the one the index lists, not who wrote it. See ARCHITECTURE.md.
 */
import { native } from "../../native.ts";
import { createIndexProvider } from "./indexProvider.ts";

export const YAVIN_REGISTRY_PROVIDER = "yavin";

export function createYavinRegistryProvider(
  registryUrl: string,
  options: { cache?: Storage | null; ttlMs?: number; api?: string; platform?: string } = {},
) {
  return createIndexProvider(
    {
      id: YAVIN_REGISTRY_PROVIDER,
      label: "Yavin Extensions",
      location: registryUrl,
      loadIndex: () => native("marketplace_get_text", { registryUrl, path: "index.json" }),
      loadDocument: (path) => native("marketplace_get_text", { registryUrl, path }),
      loadIcon: (path) => native("marketplace_get_icon", { registryUrl, path }),
      packageSource: (version) => ({
        kind: "registry",
        registryUrl,
        path: version.package,
        sha256: version.sha256,
        size: version.size,
      }),
    },
    options,
  );
}
