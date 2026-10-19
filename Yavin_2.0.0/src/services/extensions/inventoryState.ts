/**
 * Whether Yavin can use its extension inventory (EXT-21), as the Extensions view says it. The
 * native side decides (`extension_service.rs`): an inventory a newer Yavin wrote, or one this
 * Yavin cannot read, is left exactly where it is and no extension runs; one an older Yavin set
 * aside is offered back, never applied unasked. What is shown here only informs and asks.
 */

/** An inventory an older Yavin set aside that this Yavin can read (native `SetAside`). */
export interface SetAside {
  file: string;
  /** When it was set aside, ms since the Unix epoch. */
  at: number;
  version: number;
  extensions: number;
  grants: number;
  profiles: number;
}

export type InventoryState =
  | { kind: "unknown" }
  | { kind: "ok"; root: string; setAside: SetAside | null }
  /** Left as it is: a newer Yavin's, or holding what this Yavin cannot read. */
  | { kind: "unsupported"; message: string }
  /** Could not be read right now, or recovering it failed: nothing was changed. */
  | { kind: "failed"; message: string };

/** The state a listing's failure means. */
export function inventoryStateOf(error: unknown): InventoryState {
  const message = String((error as Error)?.message ?? error);
  return message.startsWith("InventoryUnsupported")
    ? { kind: "unsupported", message }
    : { kind: "failed", message };
}

export type InventoryAction = "retry" | "startOver" | "restore" | "keep";

export interface InventoryDescription {
  tone: "warning" | "error";
  title: string;
  detail: string;
  /** The native message, with its code, when there is one. */
  reason: string | null;
  actions: InventoryAction[];
}

/** `YYYY-MM-DD`, UTC: the day an inventory was set aside. */
const day = (at: number) => new Date(at).toISOString().slice(0, 10);

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** What the view says of `state`; nothing while all is well. */
export function describeInventory(state: InventoryState): InventoryDescription | null {
  switch (state.kind) {
    case "unknown":
      return null;
    case "ok": {
      const kept = state.setAside;
      if (!kept) return null;
      return {
        tone: "warning",
        title: "An older Yavin set your extensions aside",
        detail: `On ${day(kept.at)}, a Yavin that could not read your extension inventory set it aside and started again without it. It holds ${plural(kept.extensions, "extension")}, ${plural(kept.grants, "permission grant")} and ${plural(kept.profiles, "profile")}. Restore it to bring them back -- the inventory in use now is kept -- or keep the one in use. Restoring verifies every extension again; none runs that would not have.`,
        reason: null,
        actions: ["restore", "keep"],
      };
    }
    case "unsupported": {
      const newer = state.message.includes("newer Yavin (inventory version");
      return {
        tone: "error",
        title: newer
          ? "Extensions paused: their inventory is from a newer Yavin"
          : "Extensions paused: their inventory cannot be read by this Yavin",
        detail: newer
          ? "This Yavin is older than the one that last used your extensions. Their inventory was left exactly as it is, and no extension runs here. Install the Yavin you used before (or a newer one): your extensions, permissions, profiles and settings come back as they were. Nothing needs to be deleted."
          : "Your extension inventory holds data this Yavin cannot read -- most likely written by a newer Yavin. It was left exactly as it is, and no extension runs here. Install the Yavin you used before (or a newer one). Nothing needs to be deleted.",
        reason: state.message,
        actions: ["retry", "startOver"],
      };
    }
    case "failed":
      return {
        tone: "error",
        title: "Extensions could not be loaded",
        detail:
          "Yavin could not read or recover its extension inventory; nothing was changed. Close other Yavin windows or programs that may be using the extensions folder, then retry.",
        reason: state.message,
        actions: ["retry"],
      };
  }
}

/** What starting over does, said before the user confirms it. */
export const START_OVER_WARNING =
  "Your inventory is kept -- renamed, byte for byte, in the extensions folder, where the Yavin that wrote it finds it again. This Yavin then starts over from the installed copies: every extension disabled, no permissions, and no extension's code running until it is reinstalled. Profiles and settings start empty.";

export function createInventoryStateStore() {
  let state: InventoryState = { kind: "unknown" };
  const listeners = new Set<() => void>();
  return {
    set(next: InventoryState) {
      state = next;
      for (const listener of [...listeners]) listener();
    },
    get: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    getSnapshot: () => state,
  };
}

export const inventoryState = createInventoryStateStore();
