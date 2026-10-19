import { useState, useSyncExternalStore } from "react";
import { CardButton } from "./ExtensionCard";
import {
  describeRegistryTrust,
  registryTrust,
} from "../../services/extensions/marketplace/registryTrust";

const TONE = {
  good: "text-emerald-400/90",
  warning: "border-amber-900/60 bg-amber-950/30 text-amber-200/90",
  error: "border-red-900/60 bg-red-950/30 text-red-300",
} as const;

/**
 * Whether the registry's index was authenticated (EXT-20), at the top of the Extensions view:
 * one quiet line when it was, a note saying why and what to do when it was not. The native
 * side refuses installs on its own; this only says so. An unreadable replay record (EXT-21)
 * is reset only from here, at the user's request: `onReset` (kept aside natively), then the
 * index is loaded again.
 */
export function RegistryTrustNotice({
  store = registryTrust,
  onReset,
}: {
  store?: typeof registryTrust;
  onReset?: () => Promise<unknown>;
}) {
  useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [failure, setFailure] = useState<string | null>(null);
  const latest = store.latest();
  const said = describeRegistryTrust(latest);
  if (!said) return null;
  const resettable =
    !!onReset && latest?.kind === "checked" && latest.verification.status === "stateInvalid";
  const quiet = said.tone === "good";
  return (
    <div
      role={quiet ? "status" : "alert"}
      aria-label="Registry verification"
      data-testid="registry-trust"
      data-tone={said.tone}
      title={said.detail}
      className={`mx-3 mb-2 text-[10.5px] ${quiet ? TONE.good : `rounded border px-2 py-1 ${TONE[said.tone]}`}`}
    >
      <span className="font-medium">{said.title}</span>
      {quiet ? "" : <span className="block">{said.detail}</span>}
      {failure && <span className="block font-medium">{failure}</span>}
      {resettable && (
        <span className="mt-1 block">
          <CardButton
            label="Reset registry replay record"
            onClick={() =>
              void onReset().then(
                () => setFailure(null),
                (error) => setFailure(String((error as Error)?.message ?? error)),
              )
            }
          >
            Reset
          </CardButton>
        </span>
      )}
    </div>
  );
}
