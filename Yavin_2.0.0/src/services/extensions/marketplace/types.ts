/**
 * The extension marketplace's model (IDE-09): what every provider's answers are normalized to,
 * the provider interface, and its errors. React sees only these -- never a provider's own
 * response format. Optional fields are absent when a provider does not supply them: nothing is
 * invented (no download counts or ratings that a registry does not publish).
 */

/** One published version of an extension. */
export interface MarketplaceVersion {
  version: string;
  publishedAt?: string;
  /** The Yavin extension API range it needs (`engines.yavin`). */
  engines: { yavin?: string };
  /** Platforms it is published for (`win32`, `darwin`, `linux`); absent: all. */
  platforms?: string[];
}

export interface ContributionSummary {
  commands: { command: string; title: string }[];
  settings: { id: string; description: string }[];
}

export interface MarketplaceExtension {
  /** `publisher.name`, lower case: the same identity the ExtensionRegistry uses. */
  id: string;
  publisher: string;
  name: string;
  displayName: string;
  /** The latest version. */
  version: string;
  description: string;
  publisherDisplayName?: string;
  categories: string[];
  tags: string[];
  /** Whether the provider has an icon, a readme (the long description) and a changelog. */
  hasIcon: boolean;
  hasReadme: boolean;
  hasChangelog: boolean;
  downloads?: number;
  rating?: number;
  verifiedPublisher?: boolean;
  repository?: string;
  homepage?: string;
  license?: string;
  /** The latest version's engine range. */
  engines: { yavin?: string };
  /** `code` runs in the extension host; `declarative` only contributes. */
  extensionKind?: "code" | "declarative";
  activationEvents?: string[];
  contributes?: ContributionSummary;
  publishedAt?: string;
  updatedAt?: string;
  /** Newest first. */
  versions: MarketplaceVersion[];
}

export interface ExtensionCategory {
  id: string;
  label: string;
}

export interface SearchRequest {
  query: string;
  category?: string | null;
  /** Only versions this extension API can run. */
  compatibleWith?: string | null;
  /** 0-based. */
  page: number;
  pageSize: number;
}

export interface SearchResult {
  items: MarketplaceExtension[];
  total: number;
  page: number;
  pageSize: number;
}

/** Where the installer gets a package from; the native side downloads and verifies it. */
export type PackageSource =
  | { kind: "registry"; registryUrl: string; path: string; sha256: string; size: number }
  | { kind: "file"; path: string };

export interface ExtensionPackage {
  id: string;
  version: string;
  source: PackageSource;
}

export interface ExtensionUpdate {
  id: string;
  installed: string;
  available: string;
}

export interface RecommendationContext {
  /** Installed extension ids: not recommended again. */
  installed: readonly string[];
}

/** A marketplace: Yavin's registry, a test catalog, a future self-hosted one. */
export interface ExtensionMarketplaceProvider {
  readonly id: string;
  /** Shown in the Extensions view ("Yavin Extensions"). */
  readonly label: string;
  search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResult>;
  getExtension(id: string, signal?: AbortSignal): Promise<MarketplaceExtension>;
  getVersions(id: string): Promise<MarketplaceVersion[]>;
  getCategories(signal?: AbortSignal): Promise<ExtensionCategory[]>;
  getRecommendations(
    context: RecommendationContext,
    signal?: AbortSignal,
  ): Promise<MarketplaceExtension[]>;
  download(id: string, version: string): Promise<ExtensionPackage>;
  checkForUpdates(
    installed: readonly { id: string; version: string }[],
  ): Promise<ExtensionUpdate[]>;
  /** The readme or changelog (Markdown), when the provider has it. */
  getDocument(id: string, kind: "readme" | "changelog"): Promise<string | null>;
  /** The icon as a `data:` URL, when the provider has one. */
  getIcon(id: string): Promise<string | null>;
  /** Forgets cached metadata (Refresh, after an install or update). */
  refresh(): void;
}

export type MarketplaceErrorCode =
  | "Unavailable"
  | "NotFound"
  | "InvalidResponse"
  | "Incompatible"
  | "Cancelled"
  | "IntegrityFailed"
  | "UnsafePackage"
  | "InvalidPackage"
  | "ManifestMismatch"
  | "PackageMissing"
  | "InstallFailed"
  | "UninstallFailed"
  | "Busy";

/** A marketplace failure, with a message for the user and the technical detail apart. */
export class MarketplaceError extends Error {
  readonly code: MarketplaceErrorCode;
  /** The technical detail (for a Details action), never the primary message. */
  readonly detail: string | null;
  constructor(code: MarketplaceErrorCode, message: string, detail: string | null = null) {
    super(message);
    this.name = "MarketplaceError";
    this.code = code;
    this.detail = detail;
  }
}

/** A native `Code: message` error, as a typed marketplace error. */
export function marketplaceErrorOf(error: unknown, fallback: MarketplaceErrorCode, what: string) {
  if (error instanceof MarketplaceError) return error;
  if ((error as { name?: string })?.name === "AbortError")
    return new MarketplaceError("Cancelled", "Cancelled.");
  const text = String((error as Error)?.message ?? error);
  const code = /^([A-Za-z]+):/.exec(text)?.[1];
  const detail = code ? text.slice(code.length + 1).trim() : text;
  const known: Record<string, [MarketplaceErrorCode, string]> = {
    MarketplaceUnavailable: ["Unavailable", "The extension marketplace is unavailable."],
    InsecureTransport: [
      "Unavailable",
      "The extension marketplace is not reachable securely (HTTPS).",
    ],
    InvalidRegistry: ["Unavailable", "The extension marketplace's address is not valid."],
    NotFound: ["NotFound", `${what} is not in the marketplace.`],
    UnexpectedContent: ["InvalidResponse", "The extension marketplace sent something unexpected."],
    UnexpectedRedirect: [
      "InvalidResponse",
      "The extension marketplace redirected somewhere untrusted.",
    ],
    OutsideRegistry: ["InvalidResponse", "The extension marketplace named a file outside itself."],
    TooLarge: ["UnsafePackage", `${what} is larger than Yavin accepts.`],
    IntegrityFailed: [
      "IntegrityFailed",
      `${what} did not match its published checksum; it was not installed.`,
    ],
    UnsafePackage: ["UnsafePackage", `${what} contains unsafe files; it was not installed.`],
    MalformedPackage: ["InvalidPackage", `${what} is not a valid extension package.`],
    InvalidPackage: ["InvalidPackage", `${what} is not a valid extension package.`],
    ManifestMismatch: [
      "ManifestMismatch",
      `${what}'s package is not the extension it claims to be.`,
    ],
    PackageMissing: ["PackageMissing", `${what}'s package could not be found.`],
    InstallFailed: ["InstallFailed", `Could not install ${what}.`],
    RollbackFailed: ["InstallFailed", `Could not restore the previous version of ${what}.`],
    UninstallFailed: ["UninstallFailed", `Could not uninstall ${what}.`],
    UnknownExtension: ["UninstallFailed", `${what} is not installed in Yavin's extensions folder.`],
  };
  const [mapped, message] = (code && known[code]) || [fallback, `${what}: something went wrong.`];
  return new MarketplaceError(mapped, message, detail);
}
