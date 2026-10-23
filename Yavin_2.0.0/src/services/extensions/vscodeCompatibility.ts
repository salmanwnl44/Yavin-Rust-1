/**
 * How well an installed VS Code extension works in Yavin (EXT-25), said one way everywhere:
 * **Compatible**, **Compatible with limitations**, **Incompatible** or **Not verified** -- from
 * what is known, never guessed:
 *
 * - what the adapter installed of it, left out and refused (its manifest's `vsix` report);
 * - whether its code runs at all, and what happened when it last activated (the host);
 * - which VS Code APIs it used that Yavin does not provide (the compatibility layer's reports).
 *
 * Installing and activating are separate facts, and both are shown. Before it is installed, a
 * VS Code extension is "Not verified": the package decides (`compatibilityOf`, `versions.ts`).
 *
 * `engines.vscode` is shown, never enforced: Yavin implements no VS Code version as a whole --
 * it implements APIs, listed in `vscodeApi.json` -- so a range says nothing it can check. What an
 * extension uses that Yavin lacks fails with an error naming it, and is listed here.
 */
import type { ExtensionStatus } from "./host.ts";
import type { VsixOrigin } from "./manifest.ts";

export type VscodeVerdict =
  "Compatible" | "Compatible with limitations" | "Incompatible" | "Not verified";

export interface VscodeCompatibility {
  verdict: VscodeVerdict;
  /** Installed: what of it Yavin uses. */
  installed: string;
  /** Its code: "does not run", "not activated yet", "active", "failed: …". */
  activation: string;
  /** Why the verdict, in order of weight. */
  reasons: string[];
}

/** An installed VS Code extension's compatibility, from its report and what its code did. */
export function vscodeCompatibility(
  vsix: VsixOrigin,
  status: ExtensionStatus | null,
  unsupported: readonly string[] = [],
  /** What the editor could not apply of its themes, snippets, languages and grammars. */
  notApplied: readonly string[] = [],
): VscodeCompatibility {
  const reasons: string[] = [];
  // What is useful without its code: themes, snippets and grammars (vsix.rs's report). A
  // language's file association or configuration alone is not a feature.
  const declarative = vsix.supported.filter((line) =>
    /^(Colour theme|Snippets for|TextMate grammar)/.test(line),
  );
  const installed = vsix.supported.length ? vsix.supported.join("; ") : "nothing";
  const limitations = vsix.ignored.length + vsix.rejected.length + notApplied.length;
  let activation: string;
  let verdict: VscodeVerdict;
  if (!vsix.runtime) {
    activation = vsix.code ? "its code does not run" : "no code";
    if (vsix.code)
      reasons.push(
        vsix.ignored.find((line) => line.startsWith("Its code")) ?? "Its code does not run.",
      );
    verdict = !declarative.length
      ? "Incompatible"
      : limitations
        ? "Compatible with limitations"
        : "Compatible";
  } else if (!status || status.state === "registered" || status.state === "activating") {
    activation = status?.state === "activating" ? "activating" : "not activated yet";
    reasons.push(
      "Its code has not run yet in this window: whether it works is known once it activates.",
    );
    verdict = "Not verified";
  } else if (status.state === "failed") {
    activation = `failed: ${status.reason ?? "it did not activate"}`;
    reasons.push(`Its code failed to activate: ${status.reason ?? "no reason given"}.`);
    verdict = declarative.length ? "Compatible with limitations" : "Incompatible";
  } else {
    activation = status.state === "active" ? "active" : status.state;
    verdict = unsupported.length || limitations ? "Compatible with limitations" : "Compatible";
  }
  if (unsupported.length)
    reasons.push(
      `It used ${unsupported.length === 1 ? "an API" : "APIs"} Yavin does not provide: ${unsupported.slice(0, 6).join(", ")}${unsupported.length > 6 ? ", …" : ""}.`,
    );
  if (vsix.ignored.length)
    reasons.push(
      `Not supported: ${vsix.ignored.length} ${vsix.ignored.length === 1 ? "item" : "items"} (listed below).`,
    );
  if (vsix.rejected.length) reasons.push(`Refused: ${vsix.rejected.length} (listed below).`);
  if (notApplied.length)
    reasons.push(`Not applied in the editor: ${notApplied.length} (listed below).`);
  return { verdict, installed, activation, reasons };
}
