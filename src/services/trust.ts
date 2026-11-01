import { native } from "./native.ts";

/**
 * Workspace Trust on the UI side. The decision itself is owned and enforced by the native
 * side -- this only reflects it, because a check that lived here could be bypassed by the
 * thing it is meant to protect against.
 */
export interface TrustState {
  /** Whether the project's own toolchain may be run. */
  trusted: boolean;
  /** False when this folder has never been decided, which is what raises the prompt. */
  decided: boolean;
  root: string | null;
  /** The folder that could be trusted in one step to cover sibling projects too. */
  parent: string | null;
}

/** Before the first answer arrives, assume the least: restricted, and do not prompt yet. */
export const UNKNOWN_TRUST: TrustState = {
  trusted: false,
  decided: true,
  root: null,
  parent: null,
};

/**
 * The native answer, or a rejection when there is no answer to read.
 *
 * A backend that does not know the command at all answers with nothing, and a caller that
 * stored that would render from `null` -- which took the whole window down when the open
 * folder changed. Rejecting instead lets callers fall back deliberately.
 */
export function asTrustState(value: unknown): TrustState {
  const state = value as Partial<TrustState> | null;
  if (!state || typeof state.trusted !== "boolean" || typeof state.decided !== "boolean") {
    throw new Error("Workspace Trust is not available.");
  }
  return {
    trusted: state.trusted,
    decided: state.decided,
    root: state.root ?? null,
    parent: state.parent ?? null,
  };
}

export const readTrust = async (): Promise<TrustState> =>
  asTrustState(await native("workspace_trust"));

export const decideTrust = async (trusted: boolean, parent = false): Promise<TrustState> =>
  asTrustState(await native("set_workspace_trust", { trusted, parent }));

export const listTrustedFolders = async (): Promise<string[]> =>
  ((await native("trusted_folders")) ?? []).filter((folder) => typeof folder === "string");

export const forgetTrustedFolder = async (folder: string): Promise<TrustState> =>
  asTrustState(await native("forget_trusted_folder", { folder }));

/**
 * What Restricted Mode actually stops, in the user's terms. Shown in the prompt and the
 * manage dialog so the choice is informed rather than a reflex -- and kept short and true,
 * because a list that overstates what is blocked teaches people to click Trust without
 * reading.
 */
export const RESTRICTED_SUMMARY = [
  "Running your project's compiler or linter, so the Problems view stays empty.",
] as const;

export const STILL_WORKS_SUMMARY = [
  "Reading, editing, saving and searching files.",
  "Source Control, and the integrated terminal.",
] as const;
