/**
 * What an installed copy's package signature was found to be (EXT-09), in words. The native
 * side checks it before installing (`src-tauri/src/package_trust.rs`) and keeps the result with
 * the copy, bound to its SHA-256; this only says what that result means -- and what it does not.
 * A checksum that matches is never called "verified": it shows the package arrived intact, not
 * who made it.
 */
import type { NativeIntegrity, NativeSignature } from "../native.ts";

export interface SignatureDescription {
  /** Short: for the row's first words. */
  label: string;
  /** What it shows, and what it does not. */
  detail: string;
  /** Checked under a key Yavin pins. */
  signed: boolean;
}

const hostOf = (origin: string) => {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
};

export function describeSignature(
  signature: NativeSignature | null | undefined,
  /** What is known of the copy's files (EXT-17): a record is shown only for checked files. */
  integrity?: NativeIntegrity | null,
): SignatureDescription {
  if (!signature && integrity?.state === "unchecked")
    return {
      label: "Not shown",
      detail:
        "Its installed files have not been checked against its package, so no signature is shown for it, whatever was found when it was installed. Reinstall it to check them.",
      signed: false,
    };
  if (!signature)
    return {
      label: "Not recorded",
      detail:
        "No signature check is on record for this copy: it was installed before Yavin checked signatures, recovered from its files, or is a development copy. Reinstall it to check it.",
      signed: false,
    };
  const host = hostOf(signature.registry);
  const key = signature.keyId ? ` (key ${signature.keyId})` : "";
  switch (signature.status) {
    case "registrySigned":
      return {
        label: `Signed by ${host}`,
        detail: `Exactly the package ${host} published: its signature verifies under the key Yavin pins for ${host}${key}. That does not verify the publisher's identity -- ${host} signs every package it hosts.`,
        signed: true,
      };
    case "publisherSigned":
      return {
        label: `Signed by the publisher "${signature.namespace}"`,
        detail: `Its signature verifies under the key Yavin pins for the publisher "${signature.namespace}"${key}.`,
        signed: true,
      };
    case "missing":
      return signature.registry === "file"
        ? {
            label: "Unsigned",
            detail:
              "Installed from a file: Yavin checked that it is a valid package, not who made it.",
            signed: false,
          }
        : {
            label: "Unsigned",
            detail: `${host} does not sign packages: Yavin checked its SHA-256 against ${host}'s index, which shows it arrived intact, not who made it.`,
            signed: false,
          };
    default:
      // Never installed so (the native side refuses it); said plainly if it ever is listed.
      return {
        label: "Not trusted",
        detail: `Its signature could not be verified (${signature.status}).`,
        signed: false,
      };
  }
}
