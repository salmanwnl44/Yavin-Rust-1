/**
 * LocalMarketplaceProvider (IDE-09): the test catalog (`fixtures.ts`) behind the same provider
 * interface -- and the same index reader -- as Yavin's registry. FOR TESTS AND OFFLINE
 * DEVELOPMENT ONLY: deterministic, no network. Its packages are `file` sources named
 * `fixture:<path>`, which only a test's installer double understands.
 */
import { createIndexProvider } from "./indexProvider.ts";
import { FIXTURE_DOCUMENTS, FIXTURE_ICON, fixtureIndex } from "./fixtures.ts";

export const LOCAL_PROVIDER = "local-test";

export function createLocalMarketplaceProvider(
  options: {
    index?: unknown;
    /** Fails every request (offline, a broken marketplace). */
    fail?: () => string | null;
    cache?: Storage | null;
    ttlMs?: number;
    now?: () => number;
    platform?: string;
  } = {},
) {
  const text = () => JSON.stringify(options.index ?? fixtureIndex());
  const check = () => {
    const failure = options.fail?.();
    if (failure) throw new Error(failure);
  };
  return createIndexProvider(
    {
      id: LOCAL_PROVIDER,
      label: "Test Catalog",
      location: "memory",
      loadIndex: async () => {
        check();
        return text();
      },
      loadDocument: async (path) => {
        check();
        return FIXTURE_DOCUMENTS[path] ?? `# ${path}\n\nFixture document.`;
      },
      loadIcon: async () => FIXTURE_ICON,
      packageSource: (version) => ({ kind: "file", path: `fixture:${version.package}` }),
    },
    {
      cache: options.cache,
      ttlMs: options.ttlMs,
      now: options.now,
      platform: options.platform ?? "win32",
    },
  );
}
