/**
 * Versions and compatibility (IDE-09): which published versions Yavin's runtime can execute,
 * and why not. An incompatible version is never installed.
 */
import { EXTENSION_API, isSemver, satisfies } from "../manifest.ts";
import type { MarketplaceExtension, MarketplaceVersion } from "./types.ts";

/** -1, 0 or 1; a pre-release sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const [coreA, preA = ""] = a.split("+")[0].split(/-(.*)/s);
  const [coreB, preB = ""] = b.split("+")[0].split(/-(.*)/s);
  const x = coreA.split(".").map(Number);
  const y = coreB.split(".").map(Number);
  for (let i = 0; i < 3; i++)
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1;
  if (preA === preB) return 0;
  if (!preA) return 1;
  if (!preB) return -1;
  return preA < preB ? -1 : 1;
}

/** The platform this window runs on, as registries name it. */
export function currentPlatform(): string {
  const agent = (globalThis.navigator?.userAgent ?? "").toLowerCase();
  if (agent.includes("windows")) return "win32";
  if (agent.includes("mac os")) return "darwin";
  if (agent.includes("linux")) return "linux";
  return "unknown";
}

export interface Compatibility {
  compatible: boolean;
  /** Why not, for the user. */
  reasons: string[];
}

/** Whether this Yavin can run `version`. */
export function compatibilityOf(
  version: MarketplaceVersion,
  options: { api?: string; platform?: string } = {},
): Compatibility {
  const api = options.api ?? EXTENSION_API;
  const platform = options.platform ?? currentPlatform();
  const reasons: string[] = [];
  if (!isSemver(version.version)) reasons.push(`Its version "${version.version}" is not valid.`);
  const range = version.engines.yavin;
  if (!range) reasons.push("It does not say which Yavin extension API it needs.");
  else {
    const fits = satisfies(api, range);
    if (fits === null) reasons.push(`Its required Yavin API ("${range}") cannot be read.`);
    else if (!fits)
      reasons.push(
        `This extension requires Yavin API ${range.replace(/^[\^~]|^>=/, "")}; this Yavin provides ${api}.`,
      );
  }
  if (version.platforms && version.platforms.length && !version.platforms.includes(platform))
    reasons.push(
      `It is not available for this platform (${platform}); it supports ${version.platforms.join(", ")}.`,
    );
  return { compatible: reasons.length === 0, reasons };
}

/** The newest version this Yavin can run, if any. */
export function latestCompatible(
  extension: Pick<MarketplaceExtension, "versions">,
  options: { api?: string; platform?: string } = {},
): MarketplaceVersion | null {
  return (
    [...extension.versions]
      .sort((a, b) => compareVersions(b.version, a.version))
      .find((v) => compatibilityOf(v, options).compatible) ?? null
  );
}
