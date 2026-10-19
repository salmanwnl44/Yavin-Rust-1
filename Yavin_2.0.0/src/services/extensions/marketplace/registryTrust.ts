/**
 * Whether Yavin's registry index was authenticated (EXT-20), as the Extensions view says it.
 * The native side decides it (`registry_trust.rs`: the index's signature under a key Yavin pins
 * for that very registry, its freshness, no replay) each time it fetches the index -- and again,
 * on its own, before any install: what is shown here only informs. A signed index proves the
 * listed packages are the ones the registry's key holder published; it says nothing about who
 * wrote an extension.
 */
export interface IndexVerification {
  status:
    | "verified"
    | "unanchored"
    | "missing"
    | "invalid"
    | "unknownKey"
    | "keyRevoked"
    | "keyExpired"
    | "wrongRegistry"
    | "expired"
    | "replay"
    | "malformed"
    | "unavailable";
  registryId: string | null;
  keyId: string | null;
  sequence: number | null;
  issuedAt: string | null;
  expiresAt: string | null;
  sha256: string;
  anchorsRevision: number;
}

/** What the window knows of a registry's index: authenticated (or not), or unreachable. */
export type RegistryTrust =
  { kind: "checked"; verification: IndexVerification } | { kind: "unreachable"; error: string };

export interface RegistryTrustDescription {
  tone: "good" | "warning" | "error";
  title: string;
  detail: string;
  /** Whether extensions with code can be installed from it. */
  installsCode: boolean;
}

export function describeRegistryTrust(
  trust: RegistryTrust | null,
): RegistryTrustDescription | null {
  if (!trust) return null;
  if (trust.kind === "unreachable")
    return {
      tone: "warning",
      title: "Registry unavailable",
      detail:
        "Yavin could not reach the registry, so its index could not be checked. What is shown may be a copy kept from before; nothing is installed until the registry answers and its index verifies. Check your connection and refresh.",
      installsCode: false,
    };
  const v = trust.verification;
  const key = v.keyId ? ` (key ${v.keyId})` : "";
  const refused = (title: string, why: string, next: string): RegistryTrustDescription => ({
    tone: "error",
    title,
    detail: `${why} Nothing is installed or updated from it. ${next}`,
    installsCode: false,
  });
  switch (v.status) {
    case "verified":
      return {
        tone: "good",
        title: "Registry index verified",
        detail: `The list of extensions and their checksums is signed with the key this Yavin pins for this registry${key}${v.issuedAt ? `, published ${v.issuedAt}` : ""}${v.expiresAt ? ` (valid until ${v.expiresAt})` : ""}. That proves the packages are the ones the registry published -- not who wrote them.`,
        installsCode: true,
      };
    case "unanchored":
      return {
        tone: "warning",
        title: "Registry not verified",
        detail:
          "This registry has no key that Yavin trusts, so its index cannot be authenticated. Themes and snippets can be installed from it; extensions with code cannot.",
        installsCode: false,
      };
    case "missing":
      return refused(
        "Registry index not signed",
        "This registry's index has no signature.",
        "Try again later; if it persists, the registry may have been tampered with.",
      );
    case "invalid":
      return refused(
        "Registry index altered",
        "This registry's index does not match its signature: it was changed after it was signed.",
        "Do not install from it; try again later.",
      );
    case "unknownKey":
      return refused(
        "Registry key not trusted",
        `This registry's index is signed with a key this Yavin does not trust${key}.`,
        "If the registry changed its key, update Yavin to get the new one.",
      );
    case "keyRevoked":
      return refused(
        "Registry key revoked",
        `This registry's index is signed with a key Yavin no longer trusts (revoked)${key}.`,
        "Update Yavin; do not install from it meanwhile.",
      );
    case "keyExpired":
      return refused(
        "Registry key expired",
        `This registry's index is signed with a key whose trust has ended${key}.`,
        "Update Yavin to get its current key.",
      );
    case "wrongRegistry":
      return refused(
        "Wrong registry",
        "The index served here is signed for another registry.",
        "Check the registry address in Settings.",
      );
    case "expired":
      return refused(
        "Registry index expired",
        `This registry's index is past its expiry date${v.expiresAt ? ` (${v.expiresAt})` : ""}.`,
        "Try again later, when it has been published again.",
      );
    case "replay":
      return refused(
        "Older registry index",
        "This registry served an older index than one Yavin already accepted from it -- a downgrade.",
        "Try again later; if it persists, the registry or your connection may be tampered with.",
      );
    case "malformed":
      return refused(
        "Registry index unreadable",
        "This registry's index or its signature cannot be read unambiguously.",
        "Try again later.",
      );
    default:
      return refused(
        "Registry not checked",
        "Yavin could not check this registry's index (its trust anchors cannot be read).",
        "Reinstall or update Yavin.",
      );
  }
}

/** The last trust state of each registry (by URL) the window loaded an index from. */
export function createRegistryTrustStore() {
  const states = new Map<string, RegistryTrust>();
  let last: RegistryTrust | null = null;
  const listeners = new Set<() => void>();
  let version = 0;
  return {
    set(registryUrl: string, trust: RegistryTrust) {
      states.set(registryUrl, trust);
      last = trust;
      version++;
      for (const listener of [...listeners]) listener();
    },
    get: (registryUrl: string) => states.get(registryUrl) ?? null,
    /** The registry loaded last (the one the view shows). */
    latest: () => last,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    getSnapshot: () => version,
  };
}

export const registryTrust = createRegistryTrustStore();
