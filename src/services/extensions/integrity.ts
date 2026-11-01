/**
 * What is known of an installed copy's files (EXT-17, EXT-19), in words. The native side
 * decides it (`Integrity` in `src-tauri/src/extension_service.rs`): whether the files are bound
 * to the package that was verified and Yavin's authenticated record of that verifies -- the only
 * case in which its code runs -- or whether it was never checked, its record does not verify, or
 * its files are no longer as installed. This only says what that means and what the user can
 * do. Nothing here calls a copy verified or signed before the native side has.
 */
import type { NativeIntegrity, NativeReplaced } from "../native.ts";

export interface IntegrityDescription {
  /** Short: a status or a notice's first words. */
  label: "Verified Files" | "Not Checked" | "Not Verified" | "Files Changed" | "Development Copy";
  /** What it means, whether it runs, and what to do. */
  detail: string;
  /** Whether its code may run (the native side's verdict). */
  runs: boolean;
  /** Whether a reinstall is the way out. */
  reinstall: boolean;
}

/** Why Yavin's record of a copy does not verify (EXT-19), in words. */
const UNTRUSTED: Record<string, string> = {
  missing:
    "Yavin has no authenticated record of its verified files (it was installed before Yavin kept one, or the record was removed).",
  mismatch:
    "Yavin's record of its verified files does not match it: the record or the copy was changed outside Yavin.",
  key: "Yavin's record of its verified files was made with a trust key this Yavin does not have (the key was lost or replaced, or the extensions folder came from another account or computer).",
  schema: "Yavin's record of its verified files is in a form this Yavin does not accept.",
};

export function describeIntegrity(
  integrity: NativeIntegrity | null | undefined,
): IntegrityDescription | null {
  if (!integrity) return null;
  switch (integrity.state) {
    case "verified":
      return {
        label: "Verified Files",
        detail:
          "Its files are exactly those of the package Yavin verified when it was installed, and Yavin's record of that is authenticated; Yavin checks both each time it is used.",
        runs: true,
        reinstall: false,
      };
    case "development":
      return {
        label: "Development Copy",
        detail: "A development copy: its files change as it is developed and are not checked.",
        runs: true,
        reinstall: false,
      };
    case "changed":
      return {
        label: "Files Changed",
        detail:
          "Its files changed after it was installed, so it is not the package Yavin verified: it is not used. Reinstall or uninstall it.",
        runs: false,
        reinstall: true,
      };
    case "untrusted":
      if (integrity.reason === "unavailable")
        return {
          label: "Not Verified",
          detail:
            "Yavin's trust key cannot be used on this computer right now, so no record of verified files can be checked and no extension code runs. Restart Yavin; if it persists, sign in again to Windows.",
          runs: false,
          reinstall: false,
        };
      return {
        label: "Not Verified",
        detail: `${UNTRUSTED[integrity.reason ?? "mismatch"] ?? UNTRUSTED.mismatch} Its code does not run. Reinstall it: Yavin then checks it again and keeps a new record.`,
        runs: false,
        reinstall: true,
      };
    default:
      if (integrity.reason === "rebuilt")
        return {
          label: "Not Checked",
          detail:
            "It was recovered from its folder after Yavin's extension list was lost, so its files cannot be checked and its code does not run. Reinstall it to use it again.",
          runs: false,
          reinstall: true,
        };
      return {
        label: "Not Checked",
        detail:
          integrity.reason === "adopted"
            ? "It came from an earlier version of Yavin with no package on record, so its files have never been checked and its code does not run. Reinstall it: Yavin checks it against its package first."
            : "It was installed before Yavin checked installed files, so its files have never been compared with its package and its code does not run. Reinstall it: Yavin checks it against its package first.",
        runs: false,
        reinstall: true,
      };
  }
}

/** The copy an intact previous one replaced (EXT-17), in words. */
export function describeReplaced(replaced: NativeReplaced, used: string): string {
  return `Version ${replaced.version} could not be used (${replaced.reason}), so version ${used} -- intact -- is used instead. Reinstall ${replaced.version} to use it again.`;
}
