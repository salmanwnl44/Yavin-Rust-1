/**
 * What the Extensions view says about an extension (IDE-09): one status a user can act on --
 * Installed, Enabled, Disabled, Activating, Active, Failed, Incompatible, Update Available,
 * Untrusted, Host Unavailable, Permission Needed -- and why. Runtime internals (host generations, request ids,
 * process state) are not part of it; they are in the view's diagnostics.
 */
import type { RegisteredExtension } from "../registry.ts";
import type { ExtensionStatus } from "../host.ts";
import type { HoldKind } from "../manager.ts";
import { describeCapability } from "../permissions.ts";
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
    | "Permission Needed"
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
  /** What holds them off (`ManagerSnapshot.heldBy`): the label never depends on `held`'s text. */
  heldBy?: HoldKind | null;
  /** Its last refused request (EXT-07, `HostSnapshot.denied`), while that still holds. */
  denied?: { method: string; capability: string | null } | null;
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
    // EXT-10: no sandbox, no code -- said as such, never as a broken extension.
    if (/SandboxUnavailable|sandbox/i.test(reason))
      return {
        label: "Host Unavailable",
        tone: "error",
        detail: `Extension code runs only in Yavin's sandbox, which is not available: ${reason.replace(/^[A-Za-z ]+: /, "")}`,
      };
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
      label: input.heldBy === "trust" ? "Untrusted" : "Host Unavailable",
      tone: "warning",
      detail: input.held,
    };
  if (runs && input.denied)
    return {
      label: "Permission Needed",
      tone: "warning",
      detail: input.denied.capability
        ? `It asked to ${describeCapability(input.denied.capability).title.toLowerCase()} (${input.denied.method}), which you have not allowed.`
        : `Yavin refused its request ${input.denied.method}.`,
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
