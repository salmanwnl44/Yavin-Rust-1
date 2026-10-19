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
  /**
   * The Yavin extension API range it needs (`engines.yavin`); a VS Code extension's VS Code
   * range (`engines.vscode`), when its registry says (EXT-03).
   */
  engines: { yavin?: string; vscode?: string };
  /** Platforms it is published for (`win32`, `darwin`, `linux`); absent: all. */
  platforms?: string[];
  /** `vsix`: a VS Code extension package (Open VSX): only its themes and snippets install (EXT-04). */
  packageFormat?: "vsix";
  /**
   * A VS Code extension whose publisher lists it under Themes or Snippets -- what Yavin can use
   * of one; false: neither; absent: not known yet (a search entry). The package decides.
   */
  declarative?: boolean;
  /** Published as a pre-release. */
  preRelease?: boolean;
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
  /** The latest version's engine ranges. */
  engines: { yavin?: string; vscode?: string };
  /** Its registry marks it deprecated. */
  deprecated?: boolean;
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
  | { kind: "file"; path: string }
  /** An Open VSX version (EXT-03): the native side reads its metadata, package and checksum. */
  | { kind: "openVsx"; registryUrl: string; namespace: string; name: string };

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
  /** Its signature did not verify under a key Yavin pins (EXT-09). */
  | "SignatureFailed"
  | "UnsafePackage"
  | "InvalidPackage"
  | "ManifestMismatch"
  | "PackageMissing"
  | "InstallFailed"
  | "UninstallFailed"
  | "Busy"
  | "RateLimited";

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
    RateLimited: ["RateLimited", "The extension marketplace is limiting requests."],
    UnsupportedPackage: [
      "Incompatible",
      `${what} is a VS Code extension; Yavin cannot install VS Code extensions yet.`,
    ],
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
    // EXT-09: refused before anything was installed or replaced.
    SignatureMissing: [
      "SignatureFailed",
      `${what} is not signed by its registry; it was not installed.`,
    ],
    SignatureInvalid: [
      "SignatureFailed",
      `${what}'s signature does not match the package; it was not installed.`,
    ],
    SignatureMalformed: [
      "SignatureFailed",
      `${what}'s signature could not be read; it was not installed.`,
    ],
    UntrustedKey: [
      "SignatureFailed",
      `${what} is signed with a key Yavin does not trust; it was not installed.`,
    ],
    KeyRevoked: [
      "SignatureFailed",
      `${what} is signed with a key Yavin no longer trusts; it was not installed.`,
    ],
    KeyExpired: [
      "SignatureFailed",
      `${what} is signed with a key Yavin no longer trusts; it was not installed.`,
    ],
    VerificationUnavailable: [
      "Unavailable",
      `${what}'s signature could not be checked; it was not installed. Try again later.`,
    ],
    // EXT-12: decided natively before anything is put in place; the detail says which.
    IncompatibleApi: [
      "Incompatible",
      `${what} needs another version of Yavin's extension API; it was not installed.`,
    ],
    InvalidManifest: ["InvalidPackage", `${what} is not a valid extension package.`],
    DependencyMissing: [
      "Incompatible",
      `${what} needs an extension that is not installed; it was not installed.`,
    ],
    DependencyConflict: [
      "Incompatible",
      `${what} needs versions of other extensions that are not installed; it was not installed.`,
    ],
    DependencyCycle: [
      "Incompatible",
      `${what}'s dependencies depend on each other in a cycle; it was not installed.`,
    ],
    WouldBreakDependents: [
      "Incompatible",
      `Updating ${what} would break an installed extension that needs it; nothing was changed.`,
    ],
    TooComplex: [
      "Incompatible",
      `${what}'s dependencies could not be resolved; it was not installed.`,
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
  // EXT-20: the registry's signed index, refused -- not the package's own signature (EXT-09),
  // which shares the codes. The native message says which.
  const index = /registry's index|index served here/.test(detail);
  const indexKnown: Record<string, [MarketplaceErrorCode, string]> = {
    SignatureMissing: [
      "SignatureFailed",
      `The registry's index is not signed; ${what} was not installed.`,
    ],
    SignatureInvalid: [
      "SignatureFailed",
      `The registry's index was changed after it was signed; ${what} was not installed.`,
    ],
    UntrustedKey: [
      "SignatureFailed",
      `The registry's index is signed with a key this Yavin does not trust; ${what} was not installed. A Yavin update may be needed.`,
    ],
    KeyRevoked: [
      "SignatureFailed",
      `The registry's index is signed with a revoked key; ${what} was not installed.`,
    ],
    KeyExpired: [
      "SignatureFailed",
      `The registry's index is signed with a key whose trust has ended; ${what} was not installed.`,
    ],
  };
  const registry: Record<string, [MarketplaceErrorCode, string]> = {
    RegistryUnverified: [
      "SignatureFailed",
      `${what} runs code, and this registry has no key Yavin trusts, so its index cannot be authenticated; it was not installed.`,
    ],
    WrongRegistry: [
      "SignatureFailed",
      `The index served here is signed for another registry; ${what} was not installed.`,
    ],
    RegistryMetadataExpired: [
      "SignatureFailed",
      `The registry's index has expired; ${what} was not installed. Try again later.`,
    ],
    RegistryReplay: [
      "SignatureFailed",
      `The registry served an older index than one Yavin already accepted from it; ${what} was not installed.`,
    ],
    RegistryMetadataMalformed: [
      "SignatureFailed",
      `The registry's index could not be read unambiguously; ${what} was not installed.`,
    ],
    RegistryStateInvalid: [
      "SignatureFailed",
      `Yavin's record of the registry indexes it accepted cannot be read; ${what} was not installed. Reset it from the note above the extensions list.`,
    ],
    // EXT-21: nothing is installed while the inventory cannot be used.
    InventoryUnsupported: [
      "InstallFailed",
      `${what} was not installed: this Yavin cannot use the extension inventory (see the note above the extensions list).`,
    ],
    InventoryUnavailable: [
      "InstallFailed",
      `${what}: Yavin's extension inventory cannot be read right now; nothing was changed.`,
    ],
    InventoryUnrecoverable: [
      "InstallFailed",
      `${what}: Yavin's extension inventory could not be recovered; nothing was changed.`,
    ],
  };
  const [mapped, message] = (code && index && indexKnown[code]) ||
    (code && (known[code] ?? registry[code])) || [fallback, `${what}: something went wrong.`];
  // The registry's own wait ("try again in 30 s.") is the useful part.
  if (mapped === "RateLimited")
    return new MarketplaceError(mapped, `${message.replace(/\.$/, "")}; ${detail}`, detail);
  return new MarketplaceError(mapped, message, detail);
}
