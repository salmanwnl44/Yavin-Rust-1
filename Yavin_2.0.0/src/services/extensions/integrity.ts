/**
 * What is known of an installed copy's files (EXT-17), in words. The native side decides it
 * (`Integrity` in `src-tauri/src/extension_service.rs`): whether the files are bound to the
 * package that was verified, never checked, or no longer as installed -- and whether its code
 * may run. This only says what that means and what the user can do. Nothing here calls an
 * unchecked copy verified or signed.
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

export function describeIntegrity(
  integrity: NativeIntegrity | null | undefined,
): IntegrityDescription | null {
  if (!integrity) return null;
  switch (integrity.state) {
    case "verified":
      return {
        label: "Verified Files",
        detail:
          "Its files are exactly those of the package Yavin verified when it was installed; Yavin checks them each time it is used.",
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
    default:
      if (integrity.reason === "rebuilt")
        return {
          label: "Not Verified",
          detail:
            "It was recovered from its folder after Yavin's extension list was lost, so its files cannot be checked and its code does not run. Reinstall it to use it again.",
          runs: false,
          reinstall: true,
        };
      return {
        label: "Not Checked",
        detail:
          integrity.reason === "adopted"
            ? "It came from an earlier version of Yavin with no package on record, so its files have not been checked. It runs. Reinstall it to have them checked."
            : "It was installed before Yavin checked installed files, so its files have not been compared with its package. It runs. Reinstall it to have them checked.",
        runs: true,
        reinstall: true,
      };
  }
}

/** The copy an intact previous one replaced (EXT-17), in words. */
export function describeReplaced(replaced: NativeReplaced, used: string): string {
  return `Version ${replaced.version} could not be used (${replaced.reason}), so version ${used} -- intact -- is used instead. Reinstall ${replaced.version} to use it again.`;
}
