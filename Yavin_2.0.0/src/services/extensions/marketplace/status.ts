/**
 * What the Extensions view says about an extension (IDE-09): one status a user can act on --
 * Installed, Enabled, Disabled, Activating, Active, Failed, Incompatible, Update Available,
 * Untrusted, Host Unavailable -- and why. Runtime internals (host generations, request ids,
 * process state) are not part of it; they are in the view's diagnostics.
 */
import type { RegisteredExtension } from "../registry.ts";
import type { ExtensionStatus } from "../host.ts";
import type { Operation } from "./installer.ts";
import type { ExtensionUpdate } from "./types.ts";

export type StatusTone = "neutral" | "good" | "busy" | "warning" | "error";

export interface DisplayStatus {
  label:
    | "Not installed"
    | "Installed"
    | "Enabled"
    | "Disabled"
    | "Activating"
    | "Active"
    | "Failed"
    | "Incompatible"
    | "Update Available"
    | "Untrusted"
    | "Host Unavailable"
    | "Unavailable"
    | "Installing"
    | "Updating"
    | "Uninstalling";
  tone: StatusTone;
  /** Why, when there is something to say. */
  detail: string | null;
}

const PHASE: Record<Operation["phase"], string> = {
  downloading: "Downloading…",
  verifying: "Verifying the package…",
  installing: "Installing…",
  removing: "Removing…",
};

export function displayStatus(input: {
  entry: RegisteredExtension | undefined;
  runtime?: ExtensionStatus;
  /** A dependency problem (`RegistrySnapshot.unavailable`). */
  unavailable?: string;
  /** Why the workspace's host holds extensions off (not trusted, crashed repeatedly). */
  held?: string | null;
  trusted: boolean;
  update?: ExtensionUpdate;
  operation?: Operation;
  incompatible?: string | null;
}): DisplayStatus {
  const { entry, runtime, operation } = input;
  if (operation)
    return {
      label:
        operation.kind === "uninstall"
          ? "Uninstalling"
          : operation.kind === "update"
            ? "Updating"
            : "Installing",
      tone: "busy",
      detail: PHASE[operation.phase],
    };
  if (!entry)
    return input.incompatible
      ? { label: "Incompatible", tone: "warning", detail: input.incompatible }
      : { label: "Not installed", tone: "neutral", detail: null };
  if (!entry.enabled) return { label: "Disabled", tone: "neutral", detail: null };
  if (input.unavailable)
    return { label: "Unavailable", tone: "warning", detail: input.unavailable };
  const runs = !!entry.manifest.main;
  // No extension code runs in an untrusted folder: the native side refuses to start a host there.
  if (runs && !input.trusted)
    return {
      label: "Untrusted",
      tone: "warning",
      detail: "This folder is not trusted, so the extension's code does not run here.",
    };
  if (runtime?.state === "failed") {
    const reason = runtime.reason ?? "It failed to activate.";
    if (/HostUnavailable|extension host .*(missing|not installed)/i.test(reason))
      return {
        label: "Host Unavailable",
        tone: "error",
        detail: "This extension needs Yavin's extension host, which is not available.",
      };
    return { label: "Failed", tone: "error", detail: reason.replace(/^Activation failed: /, "") };
  }
  if (runs && input.held && runtime?.state !== "active")
    return {
      label: /trust/i.test(input.held) ? "Untrusted" : "Host Unavailable",
      tone: "warning",
      detail: input.held,
    };
  if (input.update)
    return {
      label: "Update Available",
      tone: "warning",
      detail: `Version ${input.update.available} is available.`,
    };
  if (runtime?.state === "activating") return { label: "Activating", tone: "busy", detail: null };
  if (runtime?.state === "active") return { label: "Active", tone: "good", detail: null };
  return {
    label: runs ? "Enabled" : "Installed",
    tone: "neutral",
    detail: runs ? null : "Declarative: nothing to run.",
  };
}
