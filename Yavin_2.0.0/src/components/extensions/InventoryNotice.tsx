import { useState, useSyncExternalStore } from "react";
import { native } from "../../services/native";
import {
  describeInventory,
  inventoryState,
  START_OVER_WARNING,
} from "../../services/extensions/inventoryState";
import { CardButton } from "./ExtensionCard";

const TONE = {
  warning: "border-amber-900/60 bg-amber-950/30 text-amber-200/90",
  error: "border-red-900/60 bg-red-950/30 text-red-300",
} as const;

/** The native recovery commands (EXT-21), replaceable in tests. */
export interface InventoryRecovery {
  restore(file: string): Promise<unknown>;
  keep(file: string): Promise<unknown>;
  startOver(): Promise<unknown>;
}

const nativeRecovery: InventoryRecovery = {
  restore: (file) => native("extensions_restore_set_aside", { file }),
  keep: (file) => native("extensions_dismiss_set_aside", { file }),
  startOver: () => native("extensions_start_over", {}),
};

/**
 * Whether Yavin can use its extension inventory (EXT-21), at the top of the Extensions view:
 * nothing while it can; otherwise why, what was left untouched and what to do -- install the
 * Yavin that wrote it, retry, or (only when asked, after a warning) start over; or, when an
 * older Yavin set an inventory aside, restore it or keep the one in use. Every action is the
 * native side's; `onChanged` discovers the extensions again after one.
 */
export function InventoryNotice({
  onChanged,
  store = inventoryState,
  recovery = nativeRecovery,
}: {
  onChanged: () => Promise<unknown> | void;
  store?: typeof inventoryState;
  recovery?: InventoryRecovery;
}) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const said = describeInventory(state);
  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setFailure(null);
    try {
      await action();
      setConfirming(false);
      setDone(success);
      await onChanged();
    } catch (error) {
      setFailure(String((error as Error)?.message ?? error));
    } finally {
      setBusy(false);
    }
  };
  if (!said)
    return done ? (
      <div
        role="status"
        data-testid="inventory-recovered"
        className="mx-3 mb-2 text-[10.5px] text-emerald-400/90"
      >
        {done}
      </div>
    ) : null;
  const file = state.kind === "ok" ? state.setAside?.file : undefined;
  return (
    <div
      role="alert"
      aria-label="Extension inventory"
      data-testid="inventory-notice"
      data-state={state.kind}
      className={`mx-3 mb-2 rounded border px-2 py-1.5 text-[11px] ${TONE[said.tone]}`}
    >
      <p className="font-medium">{said.title}</p>
      <p className="mt-0.5">{said.detail}</p>
      {said.reason && (
        <details className="mt-1 text-[10.5px] opacity-75">
          <summary className="cursor-pointer select-none">Details</summary>
          <span data-testid="inventory-reason" className="break-words">
            {said.reason}
          </span>
        </details>
      )}
      {confirming && (
        <p data-testid="inventory-start-over-warning" className="mt-1">
          {START_OVER_WARNING}
        </p>
      )}
      {failure && (
        <p data-testid="inventory-failure" className="mt-1 font-medium">
          {failure}
        </p>
      )}
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {said.actions.includes("restore") && file && (
          <CardButton
            primary
            label="Restore set-aside extensions"
            disabled={busy}
            onClick={() =>
              void run(
                () => recovery.restore(file),
                "Extensions restored from the set-aside inventory.",
              )
            }
          >
            Restore
          </CardButton>
        )}
        {said.actions.includes("keep") && file && (
          <CardButton
            label="Keep current extensions"
            disabled={busy}
            onClick={() =>
              void run(() => recovery.keep(file), "Kept the extension inventory in use.")
            }
          >
            Keep current
          </CardButton>
        )}
        {said.actions.includes("retry") && (
          <CardButton
            label="Retry loading extensions"
            disabled={busy}
            onClick={() => void run(async () => undefined, "")}
          >
            Retry
          </CardButton>
        )}
        {said.actions.includes("startOver") &&
          (confirming ? (
            <>
              <CardButton
                label="Set aside and start over"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => recovery.startOver(),
                    "Started over: your previous extension inventory was kept.",
                  )
                }
              >
                Set aside and start over
              </CardButton>
              <CardButton
                label="Cancel starting over"
                disabled={busy}
                onClick={() => setConfirming(false)}
              >
                Cancel
              </CardButton>
            </>
          ) : (
            <CardButton
              label="Start over with this Yavin"
              disabled={busy}
              onClick={() => setConfirming(true)}
            >
              Start over…
            </CardButton>
          ))}
      </div>
    </div>
  );
}
