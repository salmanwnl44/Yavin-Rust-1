/**
 * Yavin's extension registry (IDE-09), the production marketplace: static files over HTTPS --
 * by default Yavin's public repository (`registry/`, served by raw.githubusercontent.com), or a
 * self-hosted registry the user names in Settings. Everything is fetched natively
 * (`marketplace.rs`: HTTPS, same-host redirects, bounded, content-checked); the window itself
 * has no network access (its content security policy).
 *
 * Trust (EXT-20): the index is signed with a key Yavin pins for the registry, and authenticated
 * natively whenever it is fetched -- here, for what the view shows (`registryTrust`), and again
 * before any install -- and each package's SHA-256, listed in that index, is verified natively
 * before anything is unpacked. That proves a package is the one the registry published, not who
 * wrote it. See ARCHITECTURE.md.
 */
import { native } from "../../native.ts";
import { createIndexProvider } from "./indexProvider.ts";
import { registryTrust } from "./registryTrust.ts";

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
      loadIndex: async () => {
        try {
          const index = await native("marketplace_index", { registryUrl });
          registryTrust.set(registryUrl, { kind: "checked", verification: index.verification });
          return index.text;
        } catch (error) {
          registryTrust.set(registryUrl, {
            kind: "unreachable",
            error: String((error as Error)?.message ?? error),
          });
          throw error;
        }
      },
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
