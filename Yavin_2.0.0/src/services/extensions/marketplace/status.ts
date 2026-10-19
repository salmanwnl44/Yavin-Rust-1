/**
 * What the Extensions view says about an extension (IDE-09): one status a user can act on --
 * Installed, Enabled, Disabled, Activating, Active, Failed, Incompatible, Update Available,
 * Untrusted, Host Unavailable, Permission Needed -- and why. Runtime internals (host generations, request ids,
 * process state) are not part of it; they are in the view's diagnostics.
 *
 * A running extension's status is Active (EXT-16): what else holds -- a request Yavin refused for
 * a permission it does not have, an update -- is said beside it, as a notice, never in its place.
 * An extension that is not running shows Permission Needed as its status, the update as a notice.
 */
import type { RegisteredExtension } from "../registry.ts";
import type { ExtensionStatus } from "../host.ts";
import type { HoldKind } from "../manager.ts";
import { describeCapability } from "../permissions.ts";
import { describeIntegrity, describeReplaced } from "../integrity.ts";
import type { Operation } from "./installer.ts";
import type { ExtensionUpdate } from "./types.ts";

export type StatusTone = "neutral" | "good" | "busy" | "warning" | "error";

/** Said beside the status (EXT-16): it does not replace what the extension is doing. */
export interface StatusNotice {
  kind: "permission" | "update" | "integrity" | "fallback";
  label:
    | "Permission Needed"
    | "Update Available"
    | "Not Checked"
    | "Not Verified"
    | "Using Previous Version";
  tone: StatusTone;
  detail: string;
}

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
    | "Uninstalling"
    | "Not Verified";
  tone: StatusTone;
  /** Why, when there is something to say. */
  detail: string | null;
  /** What else holds, beside the status (EXT-16). */
  notices?: readonly StatusNotice[];
}

const PHASE: Record<Operation["phase"], string> = {
  downloading: "Downloading…",
  verifying: "Verifying the package…",
  installing: "Installing…",
  removing: "Removing…",
};

type StatusInput = {
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
};

/**
 * EXT-17: what is known of an installed copy's files is said too. A copy whose code may not
 * run (recovered, its files unverifiable) is **Not Verified** -- its status, unless it is busy,
 * disabled or has no code -- with what to do; one never checked (installed before Yavin checked
 * files, or adopted) runs and says so beside its status; an intact previous version used in
 * place of a copy that could not be used says which, and why. Nothing here is ever "verified"
 * or "signed" for files that were not checked.
 */
export function displayStatus(input: StatusInput): DisplayStatus {
  const status = coreStatus(input);
  const { entry, operation } = input;
  if (!entry || operation) return status;
  const notices: StatusNotice[] = [...(status.notices ?? [])];
  const integrity = describeIntegrity(entry.integrity);
  const runs = !!entry.manifest.main;
  if (integrity && !integrity.runs && runs && entry.enabled)
    return { label: "Not Verified", tone: "error", detail: integrity.detail, notices };
  if (integrity && (integrity.label === "Not Checked" || integrity.label === "Not Verified"))
    notices.push({
      kind: "integrity",
      label: integrity.label,
      tone: integrity.runs ? "warning" : "error",
      detail: integrity.detail,
    });
  if (entry.replaced)
    notices.push({
      kind: "fallback",
      label: "Using Previous Version",
      tone: "warning",
      detail: describeReplaced(entry.replaced, entry.manifest.version),
    });
  return notices.length ? { ...status, notices } : status;
}

function coreStatus(input: StatusInput): DisplayStatus {
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
  const permission: StatusNotice | null =
    runs && input.denied
      ? {
          kind: "permission",
          label: "Permission Needed",
          tone: "warning",
          detail: input.denied.capability
            ? `Yavin blocked its request to ${describeCapability(input.denied.capability).title.toLowerCase()} (${input.denied.method}): that permission is not allowed for it. Allow it under Permissions on its page.`
            : `Yavin refused its request ${input.denied.method}.`,
        }
      : null;
  const update: StatusNotice | null = input.update
    ? {
        kind: "update",
        label: "Update Available",
        tone: "warning",
        detail: `Version ${input.update.available} is available.`,
      }
    : null;
  if (runtime?.state === "active")
    return {
      label: "Active",
      tone: "good",
      detail: null,
      notices: [permission, update].filter((one): one is StatusNotice => one !== null),
    };
  if (permission)
    return {
      label: "Permission Needed",
      tone: permission.tone,
      detail: permission.detail,
      notices: update ? [update] : [],
    };
  if (update) return { label: "Update Available", tone: update.tone, detail: update.detail };
  if (runtime?.state === "activating") return { label: "Activating", tone: "busy", detail: null };
  return {
    label: runs ? "Enabled" : "Installed",
    tone: "neutral",
    detail: runs ? null : "Declarative: nothing to run.",
  };
}
